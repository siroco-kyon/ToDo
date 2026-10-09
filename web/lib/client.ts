import type {
  Api,
  ExportResult,
  IconPickResult,
  Category,
  Todo,
  TodoDependency,
  SubTask,
  CalendarSubTask,
  CreateTodoInput,
  CreateSubTaskInput,
  UpdateTodoInput,
  UpdateSubTaskInput,
  WorkLog,
  RunningState,
  WorkLogSummaryRow,
  OverviewQuery,
  OverviewData,
  DailyPlanItem,
  UpdateDailyPlanItemInput,
  PublicUser,
  UserDeletePreview,
  CreateUserInput,
  UpdateUserInput,
  UserNotification,
  TeamDashboard,
  TodoReportActivity,
  TodoChangeEntry,
  ProgressNote,
  ProgressDigest,
  ProgressDigestQuery,
  DesktopImportResult
} from '@preload'
import { TASK_REPORT_SNAPSHOT_KEY } from '@renderer/lib/taskReportSnapshot'
import { copyTextToClipboard } from '@renderer/lib/clipboard'
import type { DesktopPreferences } from '../../src/shared/desktop'

// ─── HTTP plumbing ────────────────────────────────────────────

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

type Query = Record<string, string | number | undefined>

function buildUrl(path: string, query?: Query): string {
  let url = `/api${path}`
  if (query) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    const qs = params.toString()
    if (qs) url += `?${qs}`
  }
  return url
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; query?: Query; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const hasBody = opts.body !== undefined
  const controller = opts.timeoutMs ? new AbortController() : null
  const timeout = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : null
  try {
    const res = await fetch(buildUrl(path, opts.query), {
      method,
      credentials: 'same-origin',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: controller?.signal ?? opts.signal
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : undefined
    if (!res.ok) {
      const message =
        (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : null) ?? `リクエストに失敗しました (${res.status})`
      throw new HttpError(res.status, message)
    }
    return data as T
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('サーバーからの応答を確認できませんでした。再試行してください')
    throw error
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

const get = <T>(path: string, query?: Query): Promise<T> => request<T>('GET', path, { query })
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, { body })
const put = <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, { body })
const del = <T>(path: string): Promise<T> => request<T>('DELETE', path)

// ─── Realtime + local event bus ───────────────────────────────

type DataScope = 'category' | 'todo' | 'subtask' | 'plan' | 'progress' | 'user'

const dataChangedListeners = new Set<(scope: DataScope) => void>()
const navigateTodoListeners = new Set<(todoId: string) => void>()
const quickAddListeners = new Set<() => void>()
const exportListeners = new Set<() => void>()
const presenceListeners = new Set<(online: string[]) => void>()
const notificationListeners = new Set<(unreadCount: number) => void>()
const connectionListeners = new Set<(connected: boolean) => void>()
let realtimeConnected = false

let onlineUserIds: string[] = []
let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let realtimeWanted = false
let pendingNavigation: string | null = null
let pendingQuickAdd = false
let pendingExport = false

function emit<T>(listeners: Set<(arg: T) => void>, arg: T): void {
  for (const cb of [...listeners]) {
    try {
      cb(arg)
    } catch (err) {
      console.error('listener error', err)
    }
  }
}

function openSocket(): void {
  if (!realtimeWanted) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)
  socket = ws

  // 切断中に保留されたタスクと、停止した計測も再接続時に取り直す。
  ws.onopen = () => {
    realtimeConnected = true
    emit(connectionListeners, true)
    emit(dataChangedListeners, 'todo')
  }

  ws.onmessage = (event) => {
    let msg: { type?: string; scope?: DataScope; online?: string[]; unreadCount?: number }
    try {
      msg = JSON.parse(event.data as string)
    } catch {
      return
    }
    if (msg.type === 'data:changed' && msg.scope) {
      emit(dataChangedListeners, msg.scope)
    } else if (msg.type === 'presence' && Array.isArray(msg.online)) {
      onlineUserIds = msg.online
      emit(presenceListeners, onlineUserIds)
    } else if (msg.type === 'notification:changed' && typeof msg.unreadCount === 'number') {
      emit(notificationListeners, msg.unreadCount)
    }
  }

  ws.onclose = (event) => {
    socket = null
    realtimeConnected = false
    emit(connectionListeners, false)
    onlineUserIds = []
    emit(presenceListeners, onlineUserIds)
    if (event.code === 4401) {
      realtimeWanted = false
      window.location.reload()
      return
    }
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws.close()
  }
}

function scheduleReconnect(): void {
  if (!realtimeWanted || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    openSocket()
  }, 2000)
}

/** Begin (or resume) the realtime connection. Called once the user is authenticated. */
export function connectRealtime(): void {
  realtimeWanted = true
  openSocket()
}

/** Tear down realtime on logout. */
export function disconnectRealtime(): void {
  realtimeWanted = false
  realtimeConnected = false
  emit(connectionListeners, false)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
  onlineUserIds = []
}

export function getOnlineUserIds(): string[] {
  return onlineUserIds
}

export function subscribePresence(cb: (online: string[]) => void): () => void {
  presenceListeners.add(cb)
  cb(onlineUserIds)
  return () => presenceListeners.delete(cb)
}

export function subscribeConnection(cb: (connected: boolean) => void): () => void {
  connectionListeners.add(cb)
  cb(realtimeConnected)
  return () => connectionListeners.delete(cb)
}

/** A caller-owned controller bounds the whole refresh and cancels stale responses. */
export async function fetchDesktopTaskSnapshot(signal: AbortSignal): Promise<{ user: PublicUser | null; todos: Todo[]; running: RunningState | null }> {
  let user: PublicUser | null
  try {
    user = (await request<{ user: PublicUser }>('GET', '/auth/me', { signal })).user
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return { user: null, todos: [], running: null }
    throw error
  }
  const [todos, running] = await Promise.all([
    request<Todo[]>('GET', '/todos', { signal }),
    request<RunningState | null>('GET', '/timer/running', { signal })
  ])
  return { user, todos, running }
}

export interface QuickProgressRequest {
  requestId: string
  expectedUserId: string
  todoId: string
  body: string
  stopTimer: boolean
  expectedStartTime?: string | null
}

export const postQuickProgress = (input: QuickProgressRequest): Promise<{ note: ProgressNote; workLog: WorkLog | null }> =>
  request('POST', '/desktop/quick-progress', { body: input, timeoutMs: 15000 })

export const stopDesktopTimer = (userId: string, running: RunningState): Promise<WorkLog> =>
  request('POST', '/desktop/timer/stop', { body: { expectedUserId: userId, todoId: running.todo_id, expectedStartTime: running.start_time }, timeoutMs: 15000 })

const NATIVE_SHORTCUT_KEYS = new Set<keyof DesktopPreferences>([
  'globalShortcutFocus', 'globalShortcutQuickAdd', 'globalShortcutExport', 'globalShortcutProgress'
])

// Browser-side stand-in for the desktop global shortcuts (Ctrl+Alt+N / Ctrl+Alt+E).
// These only fire while the tab is focused, which is the best a web app can do.
function installKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return
    const key = e.key.toLowerCase()
    if (key === 'n') {
      e.preventDefault()
      emit(quickAddListeners, undefined as void)
    } else if (key === 'e') {
      e.preventDefault()
      emit(exportListeners, undefined as void)
    }
  })
}

// ─── Clipboard / download helpers (markdown export) ───────────

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// A neutral default app icon, used in Settings where the desktop app would
// otherwise show a customizable tray icon.
const DEFAULT_ICON_DATA_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
      '<rect width="128" height="128" rx="28" fill="#102034"/>' +
      '<rect x="28" y="31" width="40" height="15" rx="4.5" fill="#5bddc4"/>' +
      '<rect x="43" y="54" width="52" height="15" rx="4.5" fill="#a4e9dc"/>' +
      '<rect x="56" y="78" width="35" height="15" rx="4.5" fill="#fbbf24"/>' +
      '</svg>'
  )

// ─── The Api implementation ───────────────────────────────────

export const api: Api = {
  // Categories
  categoryGetAll: () => get<Category[]>('/categories'),
  categoryCreate: (name, color, isPrivate) => post<Category>('/categories', { name, color, isPrivate }),
  categoryUpdate: (id, name, color, description, isPrivate) =>
    put<Category>(`/categories/${id}`, { name, color, description, isPrivate }),
  categoryDelete: (id) => del<void>(`/categories/${id}`),
  categoryReorder: (orderedIds) => post<void>('/categories/reorder', { orderedIds }),

  // Todos
  todoGetAll: () => get<Todo[]>('/todos'),
  todoCreate: (data: CreateTodoInput) => post<Todo>('/todos', data),
  todoUpdate: (id, data: UpdateTodoInput) => put<Todo>(`/todos/${id}`, data),
  todoArchive: (id) => post<void>(`/todos/${id}/archive`),
  todoUnarchive: (id, status) => post<void>(`/todos/${id}/unarchive`, status ? { status } : {}),
  todoDelete: (id) => del<void>(`/todos/${id}`),
  todoReorder: (orderedIds) => post<void>('/todos/reorder', { orderedIds }),
  todoDependencyGetAll: () => get<TodoDependency[]>('/dependencies'),
  todoDependencyCreate: (predecessorTodoId, successorTodoId, lagDays) =>
    post<TodoDependency>('/dependencies', { predecessorTodoId, successorTodoId, lagDays }),
  todoDependencyUpdate: (id, lagDays) => put<TodoDependency>(`/dependencies/${id}`, { lagDays }),
  todoDependencyDelete: (id) => del<void>(`/dependencies/${id}`),

  // SubTasks
  subtaskGetByTodo: (todoId) => get<SubTask[]>(`/todos/${todoId}/subtasks`),
  subtaskGetAll: () => get<SubTask[]>('/subtasks'),
  subtaskGetForCalendar: () => get<CalendarSubTask[]>('/subtasks/calendar'),
  subtaskReorder: (todoId, orderedIds) => post<void>(`/todos/${todoId}/subtasks/reorder`, { orderedIds }),
  subtaskCreate: (todoId, data: CreateSubTaskInput) =>
    post<SubTask>(`/todos/${todoId}/subtasks`, data),
  subtaskUpdate: (id, data: UpdateSubTaskInput) => put<SubTask>(`/subtasks/${id}`, data),
  subtaskDelete: (id) => del<void>(`/subtasks/${id}`),

  // Timer
  timerStart: (todoId) => post<RunningState>('/timer/start', { todoId }),
  timerStop: (note) => post<WorkLog>('/timer/stop', { note }),
  timerGetRunning: () => get<RunningState | null>('/timer/running'),

  // WorkLogs / overview
  worklogGetByTodo: (todoId) => get<WorkLog[]>(`/todos/${todoId}/worklogs`),
  worklogGetAll: () => get<WorkLogSummaryRow[]>('/worklogs/all'),
  worklogGetByDate: (dateStr) => get<WorkLogSummaryRow[]>('/worklogs/by-date', { date: dateStr }),
  worklogGetSummary: (days) => get<WorkLogSummaryRow[]>('/worklogs/summary', { days }),
  overviewGetData: (query: OverviewQuery = {}) => get<OverviewData>('/overview', {
    assigneeId: query.assigneeId === null ? undefined : query.assigneeId,
    includePrivate: query.includePrivate === false ? 'false' : undefined
  }),

  // Progress notes (shared) / digest (admin report)
  progressNoteGetByTodo: (todoId) => get<ProgressNote[]>(`/todos/${todoId}/progress-notes`),
  progressNoteGetByDate: (dateStr) => get<ProgressNote[]>('/progress-notes/timeline', { date: dateStr }),
  progressNoteGetByRange: (from, to) => get<ProgressNote[]>('/progress-notes/timeline', { from, to }),
  progressNoteGetTimeline: (from, to) => get<ProgressNote[]>('/progress-notes/activity-timeline', { from, to }),
  progressNoteGetLastActivity: () => get<TodoReportActivity[]>('/progress-notes/last-activity'),
  progressNoteGetOpenDiscussions: () => get<ProgressNote[]>('/progress-notes/discussions'),
  progressNoteSetNeedsDiscussion: (id, value) => put<ProgressNote>(`/progress-notes/${id}/discussion`, { value }),
  todoChangeGetByRange: (from, to) => get<TodoChangeEntry[]>('/todo-changes', { from, to }),
  progressNoteCreate: (todoId, body) => post<ProgressNote>(`/todos/${todoId}/progress-notes`, { body }),
  progressNoteUpdate: (id, body) => put<ProgressNote>(`/progress-notes/${id}`, { body }),
  progressNoteDelete: (id) => del<void>(`/progress-notes/${id}`),
  progressNoteCommentCreate: (noteId, body, parentCommentId) =>
    post<ProgressNote>(`/progress-notes/${noteId}/comments`, { body, parentCommentId }),
  progressNoteCommentUpdate: (id, body) => put<ProgressNote>(`/progress-note-comments/${id}`, { body }),
  progressNoteCommentDelete: (id) => del<ProgressNote>(`/progress-note-comments/${id}`),
  progressNoteReactionToggle: (noteId, emoji) => post<ProgressNote>(`/progress-notes/${noteId}/reactions`, { emoji }),
  progressNoteCommentReactionToggle: (commentId, emoji) => post<ProgressNote>(`/progress-note-comments/${commentId}/reactions`, { emoji }),
  progressDigestGet: (query: ProgressDigestQuery) =>
    get<ProgressDigest>('/progress-digest', {
      from: query.from,
      to: query.to,
      userIds: query.userIds && query.userIds.length > 0 ? query.userIds.join(',') : undefined,
      includePrivate: query.includePrivate === false ? 'false' : undefined
    }),

  // Daily plan
  dailyPlanGetByDate: (dateStr) => get<DailyPlanItem[]>('/plan', { date: dateStr }),
  dailyPlanAdd: (dateStr, todoId, options) => post<DailyPlanItem>('/plan', { date: dateStr, todoId, options }),
  dailyPlanUpdate: (id, data: UpdateDailyPlanItemInput) => put<DailyPlanItem>(`/plan/${id}`, data),
  dailyPlanShift: (id, deltaMinutes) => post<DailyPlanItem>(`/plan/${id}/shift`, { deltaMinutes }),
  dailyPlanDelete: (id) => del<void>(`/plan/${id}`),
  dailyPlanReorder: (dateStr, orderedIds) => post<void>('/plan/reorder', { date: dateStr, orderedIds }),

  // Markdown export — server generates the text; the browser handles I/O.
  markdownExport: async (mode): Promise<ExportResult> => {
    try {
      const { markdown } = await get<{ markdown: string }>('/markdown')
      if (mode === 'clipboard') {
        await copyTextToClipboard(markdown)
        return { success: true, message: 'クリップボードにコピーしました' }
      }
      downloadText(`worklog-${new Date().toISOString().slice(0, 10)}.md`, markdown)
      return { success: true, message: 'Markdownをダウンロードしました' }
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'エクスポートに失敗しました' }
    }
  },

  // Settings
  settingsGet: async (key) => {
    if (window.desktop && NATIVE_SHORTCUT_KEYS.has(key as keyof DesktopPreferences)) {
      const context = await window.desktop.getContext()
      return String(context.preferences[key as keyof DesktopPreferences])
    }
    const { value } = await get<{ value: string | null }>(`/settings/${encodeURIComponent(key)}`)
    return value
  },
  settingsSet: async (key, value) => {
    if (window.desktop && NATIVE_SHORTCUT_KEYS.has(key as keyof DesktopPreferences)) {
      await window.desktop.setPreferences({ [key]: value })
      return
    }
    await put<void>(`/settings/${encodeURIComponent(key)}`, { value })
  },

  // Users & team
  userList: () => get<PublicUser[]>('/users'),
  teamGetDashboard: (includePrivate) => get<TeamDashboard>('/team', { includePrivate: includePrivate === false ? 'false' : undefined }),
  authGetCurrentUser: async (): Promise<PublicUser | null> => {
    try {
      const data = await request<{ user?: PublicUser }>('GET', '/auth/me', { timeoutMs: 10000 })
      return data?.user ?? null
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return null
      throw error
    }
  },
  authLogout: async (): Promise<void> => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    disconnectRealtime()
    // 共有PCでの次ユーザーへのデータ漏えいを防ぐため、localStorageに残る
    // 別ウィンドウ用レポートスナップショットをログアウト時に消す
    window.localStorage.removeItem(TASK_REPORT_SNAPSHOT_KEY)
    if (window.desktop) await window.desktop.publishState({ userId: null, taskId: null, taskTitle: '', startTime: null, online: false })
    // AuthGate が /auth/me を取り直してログイン画面に戻す
    window.location.reload()
  },
  userCreate: (input: CreateUserInput) => post<PublicUser>('/users', input),
  userDeletePreview: (id: string) => get<UserDeletePreview>('/users/' + id + '/delete-preview'),
  userDelete: (id: string, confirmationUsername: string) => request<void>('DELETE', '/users/' + id, { body: { confirmationUsername } }),
  userUpdate: (id: string, input: UpdateUserInput) => put<PublicUser>(`/users/${id}`, input),
  userResetPassword: (id: string, password: string) =>
    post<void>(`/users/${id}/password`, { password }),
  adminImportDesktopDb: async (data: ArrayBuffer, targetUserId: string, dryRun: boolean) => {
    // JSONではなく todo.db のバイト列をそのまま送る
    const res = await fetch(
      buildUrl('/import/desktop-db', { userId: targetUserId, dryRun: dryRun ? '1' : undefined }),
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data
      }
    )
    const text = await res.text()
    const json = text ? JSON.parse(text) : undefined
    if (!res.ok) {
      const message =
        (json && typeof json === 'object' && typeof json.error === 'string' ? json.error : null) ??
        `リクエストに失敗しました (${res.status})`
      throw new HttpError(res.status, message)
    }
    return json as DesktopImportResult
  },

  notificationList: () => get<UserNotification[]>('/notifications'),
  notificationUnreadCount: async () => {
    const { unread } = await get<{ unread: number }>('/notifications/unread-count')
    return unread
  },
  notificationMarkRead: (id) => post<UserNotification | null>(`/notifications/${id}/read`),
  notificationMarkAllRead: () => post<void>('/notifications/read-all'),
  notificationPreferencesGet: () => get<Record<string, boolean>>('/notification-preferences'),
  notificationPreferenceSet: (type, enabled) => post<{ type: string; enabled: boolean }>('/notification-preferences', { type, enabled }),
  todoSubscriptionGet: (todoId) => get<{ subscribed: boolean }>(`/todos/${todoId}/subscription`),
  todoSubscriptionSet: (todoId, subscribed) => post<{ subscribed: boolean }>(`/todos/${todoId}/subscription`, { subscribed }),

  // ─── Desktop-only surface: stubbed for the web build ─────────
  iconGetDataUrl: async () => DEFAULT_ICON_DATA_URL,
  iconPick: async (): Promise<IconPickResult> => ({ success: false, dataUrl: null }),
  iconReset: async () => DEFAULT_ICON_DATA_URL,
  shortcutsReregister: async () => {},
  dataGetDir: async () => 'サーバー上で管理されています',
  dataPickDir: async () => null,
  dataChangeDir: async () => ({ moved: false }),
  appIsFirstLaunch: async () => false,
  appGetDefaultDataDir: async () => '',
  appCompleteSetup: async () => {},
  windowOpenGantt: async () => {
    if (window.desktop) return window.desktop.openGantt()
    window.open(`${location.pathname}#gantt-only`, '_blank', 'noopener')
  },
  windowOpenTodo: async (todoId) => {
    if (window.desktop) return window.desktop.openMain(todoId)
    emit(navigateTodoListeners, todoId)
  },
  windowOpenTaskReport: async () => {
    if (window.desktop) return window.desktop.openReport()
    window.open(`${location.pathname}#task-report-only`, '_blank', 'noopener')
  },

  // ─── Event listeners ─────────────────────────────────────────
  onShortcutQuickAdd: (cb) => {
    quickAddListeners.add(cb)
    if (pendingQuickAdd) { pendingQuickAdd = false; queueMicrotask(cb) }
    return () => quickAddListeners.delete(cb)
  },
  onShortcutExport: (cb) => {
    exportListeners.add(cb)
    if (pendingExport) { pendingExport = false; queueMicrotask(cb) }
    return () => exportListeners.delete(cb)
  },
  onNavigateTodo: (cb) => {
    navigateTodoListeners.add(cb)
    if (pendingNavigation) { const todoId = pendingNavigation; pendingNavigation = null; queueMicrotask(() => cb(todoId)) }
    return () => navigateTodoListeners.delete(cb)
  },
  onDataChanged: (cb) => {
    dataChangedListeners.add(cb)
    return () => dataChangedListeners.delete(cb)
  },
  onNotificationsChanged: (cb) => {
    notificationListeners.add(cb)
    return () => notificationListeners.delete(cb)
  }
}

if (window.desktop) {
  window.desktop.onCommand((command) => {
    if (command.type === 'quick-add') {
      if (quickAddListeners.size) emit(quickAddListeners, undefined as void)
      else pendingQuickAdd = true
    } else if (command.type === 'export') {
      if (exportListeners.size) emit(exportListeners, undefined as void)
      else pendingExport = true
    } else if (command.type === 'navigate') {
      if (navigateTodoListeners.size) emit(navigateTodoListeners, command.todoId)
      else pendingNavigation = command.todoId
    }
  })
} else {
  installKeyboardShortcuts()
}
