import React, { lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AddDailyPlanItemOptions, Category, CreateSubTaskInput, CreateTodoInput, DailyPlanItem, PublicUser, SubTask, Todo, UpdateDailyPlanItemInput, UpdateSubTaskInput, UpdateTodoInput, UserNotification } from './types'
import { useTimer } from './hooks/useTimer'
import { useProgressUnseenCount } from './hooks/useProgressUnseenCount'
import { Toolbar } from './components/Toolbar'
import { CategoryList } from './components/CategoryList'
import { TodoList } from './components/TodoList'
import { TodoDetail } from './components/TodoDetail'
import { QuickAddModal } from './components/QuickAddModal'
import { Toast } from './components/Toast'
import type { ToastMessage } from './components/Toast'
import { FONT_FAMILY_DEFAULT, FONT_SCALE_DEFAULT } from './lib/fontSettings'
import './styles/theme.css'
import type { ProgressTimelineFocusTarget } from './components/ProgressTimeline'
import { TodayFlowRail } from './components/TodayFlowRail'
import { GanttView } from './components/GanttView'
import { NotificationPanel } from './components/NotificationPanel'
import { ViewBoundary } from './components/ViewBoundary'
import { ListFilterChips, type ListFilterChip } from './components/ListFilterChips'
import { buildChecklistSummaries, buildTodayGroups, countRemaining, groupListItems, isActiveList, isMyList } from './lib/todoList'
import { TodayTodoCard } from './components/TodayTodo'
import { mergeSubsetOrder } from './lib/reorder'
import { buildUrlSearch, parseUrlState } from './lib/urlState'
import { recurrenceDoneMessage, recurrenceReopenMessage } from './lib/recurrence'
import { elapsedSecondsSince } from './hooks/useElapsedSeconds'
import { formatShortDate, shiftDateKey } from './lib/dueDate'
import { FOCUS_PROGRESS_LOG_EVENT, FOCUS_TASK_DETAIL_EVENT } from './lib/appEvents'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'

// 最初に開くガント・タスク一覧・詳細以外の画面と、設定などの小窓は、開いたときに読み込む（起動を軽くする）
const SettingsModal = lazy(() => import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })))
const UserManagementModal = lazy(() => import('./components/UserManagementModal').then((module) => ({ default: module.UserManagementModal })))
const ProgressReportModal = lazy(() => import('./components/ProgressReportModal').then((module) => ({ default: module.ProgressReportModal })))
const TaskReportWindow = lazy(() => import('./components/TaskReportWindow').then((module) => ({ default: module.TaskReportWindow })))
const DesktopImportModal = lazy(() => import('./components/DesktopImportModal').then((module) => ({ default: module.DesktopImportModal })))
const GettingStartedModal = lazy(() => import('./components/GettingStartedModal').then((module) => ({ default: module.GettingStartedModal })))
const SetupWizardModal = lazy(() => import('./components/SetupWizardModal').then((module) => ({ default: module.SetupWizardModal })))
const WorkLogSummary = lazy(() => import('./components/WorkLogSummary').then((module) => ({ default: module.WorkLogSummary })))
const ProgressTimeline = lazy(() => import('./components/ProgressTimeline').then((module) => ({ default: module.ProgressTimeline })))
const PlanView = lazy(() => import('./components/PlanView').then((module) => ({ default: module.PlanView })))
const KanbanView = lazy(() => import('./components/KanbanView').then((module) => ({ default: module.KanbanView })))
const TeamDashboard = lazy(() => import('./components/TeamDashboard').then((module) => ({ default: module.TeamDashboard })))
const OverviewDashboard = lazy(() => import('./components/OverviewDashboard').then((module) => ({ default: module.OverviewDashboard })))
const ReportView = lazy(() => import('./components/ReportView').then((module) => ({ default: module.ReportView })))
const TodoListsView = lazy(() => import('./components/TodoListsView').then((module) => ({ default: module.TodoListsView })))

type SortField = 'created_at' | 'updated_at' | 'priority' | 'progress' | 'due_date' | 'title' | 'sort_order'

// 一覧の並べ替えは端末に覚える（毎朝並べ直さなくて済むように）
const LIST_SORT_STORAGE_KEY = 'task-list-sort'
const SORT_FIELD_KEYS: readonly SortField[] = ['created_at', 'updated_at', 'priority', 'progress', 'due_date', 'title', 'sort_order']

/** 並べ替えの最初の向き。期限とタイトルは近い順・あいうえお順、ほかは新しい順・大きい順 */
function defaultSortDir(field: SortField): 'asc' | 'desc' {
  return field === 'due_date' || field === 'title' ? 'asc' : 'desc'
}

/** 並べ替えのボタンのツールチップ（↑↓が何の順かを言葉で） */
function sortDirTitle(field: SortField, dir: 'asc' | 'desc', active: boolean): string {
  if (field === 'sort_order') return 'ドラッグで並べた順'
  const labels: Record<Exclude<SortField, 'sort_order'>, [string, string]> = {
    due_date: ['期限が近い順', '期限が遠い順'],
    title: ['タイトルの昇順', 'タイトルの降順'],
    created_at: ['作成が古い順', '作成が新しい順'],
    updated_at: ['更新が古い順', '更新が新しい順'],
    priority: ['優先度が低い順', '優先度が高い順'],
    progress: ['進捗が少ない順', '進捗が多い順']
  }
  const [asc, desc] = labels[field]
  if (!active) return `${dir === 'asc' ? asc : desc}に並べます`
  return `${dir === 'asc' ? asc : desc}（もう一度押すと${dir === 'asc' ? desc : asc}）`
}

function loadListSort(): { field: SortField; dir: 'asc' | 'desc' } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LIST_SORT_STORAGE_KEY) ?? 'null') as { field?: unknown; dir?: unknown } | null
    if (parsed && SORT_FIELD_KEYS.includes(parsed.field as SortField) && (parsed.dir === 'asc' || parsed.dir === 'desc')) {
      return { field: parsed.field as SortField, dir: parsed.dir }
    }
  } catch {
    // 読めなければ既定の並び
  }
  return { field: 'created_at', dir: 'desc' }
}
type CenterView = 'detail' | 'overview' | 'log' | 'progress' | 'report' | 'plan' | 'gantt' | 'team' | 'kanban' | 'todo'
type ScopeLens = 'personal' | 'team'
type GanttSidePanelMode = 'detail' | 'today'
type PaneKey = 'category' | 'list' | 'side'
type ThemeMode = 'dark' | 'light' | 'system'

interface PaneWidths {
  category: number
  list: number
  side: number
}

interface SavedTaskView {
  name: string
  searchQuery: string
  categoryId: string | null
  assigneeId: string | null
  showArchived: boolean
  sortField: SortField
  sortDir: 'asc' | 'desc'
}

const DEFAULT_PANE_WIDTHS: PaneWidths = {
  category: 168,
  list: 264,
  side: 360
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// 右のパネル（今日の予定・ガントの詳細）の最小幅。これより狭いと、詳細の計測の「停止」や日程の欄が切れる
const SIDE_PANE_MIN_WIDTH = 340

function loadPaneWidths(): PaneWidths {
  try {
    const raw = window.localStorage.getItem('app-pane-widths')
    if (!raw) return DEFAULT_PANE_WIDTHS
    const parsed = JSON.parse(raw) as Partial<PaneWidths>
    return {
      category: clamp(Number(parsed.category) || DEFAULT_PANE_WIDTHS.category, 132, 320),
      list: clamp(Number(parsed.list) || DEFAULT_PANE_WIDTHS.list, 220, 460),
      side: clamp(Number(parsed.side) || DEFAULT_PANE_WIDTHS.side, SIDE_PANE_MIN_WIDTH, 720)
    }
  } catch {
    return DEFAULT_PANE_WIDTHS
  }
}

/** 左の2つのパネルと右の「今日の予定」を出すかどうか */
interface PaneVisibility {
  category: boolean
  task: boolean
  side: boolean
}

const GANTT_PANES_STORAGE_KEY = 'gantt-pane-visibility'
/** この幅より狭い画面では、ガントを初めて開いたときにパネルを畳んで時間軸を広く見せる */
const GANTT_WIDE_SCREEN_MIN_WIDTH = 1600
// ガント以外の画面で、右の「今日の予定」・カテゴリ一覧を自動で隠す画面の幅（これより狭いとき）。
// カンバンは4列を並べるので、右のパネルはもっと広い画面まで隠す
const NARROW_SIDE_PANEL_WIDTH = 1280
const NARROW_CATEGORY_PANE_WIDTH = 1100
// カンバンの4列（1列 200px と間・余白）が収まる幅。収まらないときは、右の「今日の予定」→カテゴリ一覧→タスク一覧の順に隠す
const KANBAN_MIN_BOARD_WIDTH = 4 * 200 + 3 * 10 + 24 + 6
/** 日程の変更と、依存関係で後続が動いた知らせの key（元に戻したら「元に戻しました」で置き換える） */
const SCHEDULE_TOAST_KEY = 'schedule-change'
/** これより狭いと、ガントの日付が数日分しか見えない（左の表の幅を含む） */
const GANTT_COMFORT_WIDTH = 640
const SIDE_PANEL_VIEWS_WITHOUT_RAIL: readonly CenterView[] = ['plan', 'team', 'progress', 'report', 'todo']
// 中央の区分けの読み上げ名（上部のタブの名前と同じ）
const CENTER_VIEW_LABELS: Record<CenterView, string> = {
  detail: 'タスクの詳細', overview: '概要', log: '記録', progress: '進捗', report: '報告', plan: '計画', gantt: 'ガント', team: 'チーム', kanban: 'カンバン', todo: 'ToDo'
}

/** キーボードで最初に Tab を押したときだけ出る、区分けへ移るリンク（一覧や上部のボタンを1つずつ通らずに済む） */
function SkipLinks({ showTaskList, showSidePanel, sidePanelLabel }: { showTaskList: boolean; showSidePanel: boolean; sidePanelLabel: string }): React.JSX.Element {
  const focusRegion = (id: string): void => {
    const region = document.getElementById(id)
    if (!region) return
    // 本文は区分けそのものへ（最初の部品が絞り込みを外すチップのとき、続けて Enter を押して外してしまわないように）。
    // ほかは区分けの中の最初の操作できる部品へ。なければ区分けそのものへ
    const first = id === 'hakobi-main' ? null : region.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ;(first ?? region).focus()
  }
  return (
    <div className="hakobi-skip-links">
      <button type="button" onClick={() => focusRegion('hakobi-main')}>本文へ移動</button>
      {showTaskList && <button type="button" onClick={() => focusRegion('hakobi-task-list')}>タスク一覧へ移動</button>}
      {showSidePanel && <button type="button" onClick={() => focusRegion('hakobi-side-panel')}>{sidePanelLabel}へ移動</button>}
    </div>
  )
}
/** 日程の比較用（開始日と期限） */
function scheduleKeyOf(todo: Todo): string {
  return `${todo.start_date?.slice(0, 10) ?? ''}/${todo.due_date?.slice(0, 10) ?? ''}`
}

const KANBAN_STATUS_LABELS: Record<Todo['status'], string> = { not_started: '未着手', active: '進行中', on_hold: '保留中', done: '完了', archived: 'アーカイブ' }

// ガントの画面のパネルの開閉は、ほかの画面とは別に覚える（ガントは横に広いほど見やすいため）。
// まだ覚えていないときは、画面が狭ければすべて畳み、広ければほかの画面と同じにする
function loadGanttPanes(otherViews: PaneVisibility): { panes: PaneVisibility; collapsedForNarrowScreen: boolean } {
  try {
    const raw = window.localStorage.getItem(GANTT_PANES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PaneVisibility>
      return {
        panes: {
          category: typeof parsed.category === 'boolean' ? parsed.category : otherViews.category,
          task: typeof parsed.task === 'boolean' ? parsed.task : otherViews.task,
          side: typeof parsed.side === 'boolean' ? parsed.side : otherViews.side
        },
        collapsedForNarrowScreen: false
      }
    }
  } catch {
    // 読めなければ初めて開いたときと同じにする
  }
  const narrow = window.innerWidth < GANTT_WIDE_SCREEN_MIN_WIDTH
  const anyOpen = otherViews.category || otherViews.task || otherViews.side
  return narrow
    ? { panes: { category: false, task: false, side: false }, collapsedForNarrowScreen: anyOpen }
    : { panes: otherViews, collapsedForNarrowScreen: false }
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function getDateKeyFromIso(iso: string | null | undefined): string {
  if (!iso) return getTodayKey()
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return getTodayKey()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function App(): React.JSX.Element {
  const isStandaloneGanttWindow = window.location.hash === '#gantt-only'
  const isStandaloneTaskReportWindow = window.location.hash === '#task-report-only'
  // 画面と開いているタスクは URL（?view=…&task=…）にも出す。開いた URL の画面とタスクで始める（ほかの窓では使わない）
  const [initialUrlState] = useState(() => isStandaloneGanttWindow || isStandaloneTaskReportWindow
    ? { view: null, taskId: null }
    : parseUrlState(window.location.search))
  const [isFirstLaunch, setIsFirstLaunch] = useState<boolean | null>(null)
  const [todos, setTodos] = useState<Todo[]>([])
  const [allSubTasks, setAllSubTasks] = useState<SubTask[]>([])
  const [todayPlanItems, setTodayPlanItems] = useState<DailyPlanItem[]>([])
  const [planDate, setPlanDate] = useState(getTodayKey())
  const [selectedPlanItems, setSelectedPlanItems] = useState<DailyPlanItem[]>([])
  const [selectedPlanLoading, setSelectedPlanLoading] = useState(false)
  const [selectedPlanError, setSelectedPlanError] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [users, setUsers] = useState<PublicUser[]>([])
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null)
  const [showUserManagement, setShowUserManagement] = useState(false)
  const [showProgressReport, setShowProgressReport] = useState(false)
  const [showDesktopImport, setShowDesktopImport] = useState(false)
  const [showMySummary, setShowMySummary] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0)
  const [progressTimelineFocus, setProgressTimelineFocus] = useState<ProgressTimelineFocusTarget | null>(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null)
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(initialUrlState.taskId)
  const [detailDirty, setDetailDirty] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [initialListSort] = useState(loadListSort)
  const [sortField, setSortField] = useState<SortField>(initialListSort.field)
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>(initialListSort.dir)
  useEffect(() => {
    try { window.localStorage.setItem(LIST_SORT_STORAGE_KEY, JSON.stringify({ field: sortField, dir: sortDir })) } catch { /* 覚えられなくても並べ替えはできる */ }
  }, [sortDir, sortField])
  const [searchQuery, setSearchQuery] = useState('')
  const [savedTaskViews] = useState<SavedTaskView[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('saved-task-views') ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed as SavedTaskView[] : []
    } catch { return [] }
  })
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  // 追加画面の初期値（ガントの見出しの「＋」から開いたときなど）。null は左の選択状態から決める
  const [quickAddDefaults, setQuickAddDefaults] = useState<{ categoryId?: string | null; assigneeId?: string | null; listMode?: boolean } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showGettingStarted, setShowGettingStarted] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem('app-theme-mode')
    return saved === 'light' || saved === 'system' ? saved : 'dark'
  })
  const [fontFamily, setFontFamily] = useState<string>(() => (
    window.localStorage.getItem('app-font-family') ?? FONT_FAMILY_DEFAULT
  ))
  const [fontScale, setFontScale] = useState<string>(() => (
    window.localStorage.getItem('app-font-scale') ?? FONT_SCALE_DEFAULT
  ))
  const [activeView, setActiveView] = useState<CenterView>(() => initialUrlState.view ?? (initialUrlState.taskId ? 'detail' : 'gantt'))
  // 表示レンズ（個人=全部 / 全体=プライベート除外）。クライアント側のみで保持し、
  // 他ユーザーの画面には影響しない（サーバーに送らない）。
  const [scopeLens, setScopeLens] = useState<ScopeLens>(() => {
    return window.localStorage.getItem('app-scope-lens') === 'team' ? 'team' : 'personal'
  })
  const [ganttSidePanelMode, setGanttSidePanelMode] = useState<GanttSidePanelMode>(
    initialUrlState.view === 'gantt' && initialUrlState.taskId ? 'detail' : 'today'
  )
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showPlanRail, setShowPlanRail] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('show-plan-rail')
    return saved == null ? true : saved === 'true'
  })
  const [showCategoryPane, setShowCategoryPane] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('show-category-pane')
    return saved == null ? true : saved === 'true'
  })
  const [showTaskPane, setShowTaskPane] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('show-task-pane')
    return saved == null ? true : saved === 'true'
  })
  // ガントの画面のパネルは、ほかの画面とは別に覚える。初めてで画面が狭いときは畳んで始め、そのことを一度だけ知らせる
  const [initialGanttPanes] = useState(() => loadGanttPanes({ category: showCategoryPane, task: showTaskPane, side: showPlanRail }))
  const [ganttPanes, setGanttPanes] = useState<PaneVisibility>(initialGanttPanes.panes)
  const ganttPanesNoticePendingRef = useRef(initialGanttPanes.collapsedForNarrowScreen)
  const [assigneeDefaultApplied, setAssigneeDefaultApplied] = useState(false)
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths())
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null)
  const toastIdRef = useRef(0)
  const selectedPlanRequestRef = useRef(0)
  const resourceRequestsRef = useRef<Record<string, number>>({})
  const resourcesMountedRef = useRef(true)
  const selectedPlanDateRef = useRef(planDate)
  selectedPlanDateRef.current = planDate
  useEffect(() => {
    resourcesMountedRef.current = true
    return () => {
      resourcesMountedRef.current = false
      for (const resource of Object.keys(resourceRequestsRef.current)) resourceRequestsRef.current[resource]++
      selectedPlanRequestRef.current++
    }
  }, [])
  const resizeRef = useRef<{ key: PaneKey; startX: number; startWidth: number } | null>(null)

  // action.key が同じ知らせは、新しいもので置き換える（進捗を続けて変えたときに知らせが積み重ならないように）
  // ボタンのない知らせにも key を付けられる（「元に戻しました」で、前の知らせを置き換えるときなど）
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success', action?: { label?: string; run?: () => void; key?: string }) => {
    const id = ++toastIdRef.current
    setToasts((prev) => [
      ...(action?.key ? prev.filter((toast) => toast.key !== action.key) : prev),
      { id, message, type, actionLabel: action?.label && action.run ? action.label : undefined, onAction: action?.label ? action.run : undefined, key: action?.key }
    ])
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const loadResource = useCallback(async <T,>(resource: string, get: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
    const request = (resourceRequestsRef.current[resource] ?? 0) + 1
    resourceRequestsRef.current[resource] = request
    const current = (): boolean => resourcesMountedRef.current && resourceRequestsRef.current[resource] === request
    try { const result = await get(); if (current()) apply(result) }
    catch (error) { if (current()) throw error }
  }, [])

  const loadTodayPlan = useCallback(() => loadResource('todayPlan', () => window.api.dailyPlanGetByDate(getTodayKey()), setTodayPlanItems), [loadResource])
  const loadTodos = useCallback(async () => {
    await Promise.all([loadResource('todos', () => window.api.todoGetAll(), setTodos), loadTodayPlan()])
  }, [loadResource, loadTodayPlan])
  const loadAllSubTasks = useCallback(() => loadResource('allSubTasks', () => window.api.subtaskGetAll(), setAllSubTasks), [loadResource])

  // 同じ日の計画を読み直すとき（予定を入れた・動かしたあと）は、画面を「読み込んでいます」に替えずに中身だけ差し替える
  // （朝に何件も入れるたびに画面全体が消え、どこまで入れたか見失っていた）
  const selectedPlanLoadedDateRef = useRef<string | null>(null)
  const loadSelectedPlan = useCallback(async (date: string) => {
    const requestId = ++selectedPlanRequestRef.current
    const sameDate = selectedPlanLoadedDateRef.current === date
    if (!sameDate) {
      setSelectedPlanLoading(true)
      setSelectedPlanItems([])
    }
    setSelectedPlanError(null)
    try {
      const items = await window.api.dailyPlanGetByDate(date)
      if (resourcesMountedRef.current && requestId === selectedPlanRequestRef.current) {
        setSelectedPlanItems(items)
        selectedPlanLoadedDateRef.current = date
      }
    } catch (error) {
      if (resourcesMountedRef.current && requestId === selectedPlanRequestRef.current) {
        setSelectedPlanError(error instanceof Error ? error.message : '計画を読み込めませんでした')
        throw error
      }
    } finally {
      if (resourcesMountedRef.current && requestId === selectedPlanRequestRef.current) setSelectedPlanLoading(false)
    }
  }, [])

  const loadCategories = useCallback(() => loadResource('categories', () => window.api.categoryGetAll(), setCategories), [loadResource])

  const loadUsers = useCallback(() => loadResource('users', () => Promise.all([
      window.api.userList(),
      window.api.authGetCurrentUser()
    ]), ([allUsers, me]) => {
    setUsers(allUsers)
    setCurrentUser(me)
    setSelectedAssigneeId((previous) => previous && !allUsers.some((user) => user.id === previous) ? null : previous)
  }), [loadResource])

  const loadNotifications = useCallback(() => loadResource('notifications', () => Promise.all([
      window.api.notificationList(),
      window.api.notificationUnreadCount()
    ]), ([items, unread]) => {
    setNotifications(items)
    setNotificationUnreadCount(unread)
  }), [loadResource])

  const loadInitialData = useCallback(async () => {
    setInitialLoadError(null)
    await Promise.all([loadTodos(), loadCategories(), loadUsers(), loadAllSubTasks(), loadSelectedPlan(selectedPlanDateRef.current)])
  }, [loadAllSubTasks, loadCategories, loadSelectedPlan, loadTodos, loadUsers])

  useEffect(() => {
    if (isFirstLaunch !== false) return
    void loadSelectedPlan(planDate).catch((error) => showToast(error instanceof Error ? error.message : '計画を読み込めませんでした', 'error'))
  }, [isFirstLaunch, loadSelectedPlan, planDate, showToast])

  const { isRunning, runningTodoId, startTime: timerStartTime, start: startTimer, stop: stopTimer, sync: syncTimer } = useTimer(loadTodos)
  const runningTodo = useMemo(() => (runningTodoId ? todos.find((todo) => todo.id === runningTodoId) ?? null : null), [runningTodoId, todos])
  const todosRef = useRef(todos)
  todosRef.current = todos
  const scheduleWatchRef = useRef<{ editedId: string; before: Map<string, string> } | null>(null)

  const stop = useCallback(async (note?: string) => {
    try { await stopTimer(note) }
    catch (error) {
      showToast(error instanceof Error ? error.message : '計測を停止できませんでした', 'error')
      // The caller keeps the stop memo on failure. List/detail handlers consume this rejection.
      throw error
    }
  }, [showToast, stopTimer])

  // ヘッダーの■から止めたときは、記録した時間を知らせる
  const stopFromToolbar = useCallback(() => {
    const seconds = elapsedSecondsSince(timerStartTime)
    const recorded = seconds < 60 ? '1分未満' : `約${Math.round(seconds / 60)}分`
    void stop().then(() => showToast(`計測を止めました（${recorded}を記録）`), () => { /* 失敗は stop が知らせる */ })
  }, [showToast, stop, timerStartTime])

  const start = useCallback(async (todoId: string) => {
    if (todos.find((todo) => todo.id === todoId)?.status === 'on_hold') {
      if ((todoId !== selectedTodoId || activeView !== 'detail') && detailDirty && !window.confirm('未保存の変更があります。タスク詳細へ移動しますか？')) return
      setSelectedTodoId(todoId)
      setActiveView('detail')
      showToast('保留中のタスクは、進行中に戻してから計測を開始してください')
      return
    }
    const previousTitle = runningTodoId && runningTodoId !== todoId ? todos.find((todo) => todo.id === runningTodoId)?.title ?? null : null
    try {
      await startTimer(todoId)
      // 別のタスクを計測中だったときは、止めて切り替えたことを知らせる（黙って止まると記録が分かれたことに気付けない）
      if (previousTitle) showToast(`「${previousTitle}」の計測を止めて、「${todos.find((todo) => todo.id === todoId)?.title ?? 'このタスク'}」の計測を始めました`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '計測を開始できませんでした', 'error')
    }
  }, [activeView, detailDirty, runningTodoId, selectedTodoId, showToast, startTimer, todos])

  useEffect(() => {
    window.api.appIsFirstLaunch().then(setIsFirstLaunch)
  }, [])

  useEffect(() => {
    if (isFirstLaunch !== false) return

    let disposed = false
    window.api.settingsGet('themeMode').then((value) => {
      if (disposed) return
      if (value === 'dark' || value === 'light' || value === 'system') setThemeMode(value)
    })
    window.api.settingsGet('fontFamily').then((value) => {
      if (disposed) return
      if (value) setFontFamily(value)
    })
    window.api.settingsGet('fontScale').then((value) => {
      if (disposed) return
      if (value) setFontScale(value)
    })
    return () => {
      disposed = true
    }
  }, [isFirstLaunch])

  const navigationStateRef = useRef({ detailDirty, selectedTodoId, activeView })
  navigationStateRef.current = { detailDirty, selectedTodoId, activeView }
  useEffect(() => {
    const unsubscribe = window.api.onNavigateTodo((todoId) => {
      const state = navigationStateRef.current
      if ((todoId !== state.selectedTodoId || state.activeView !== 'detail') && state.detailDirty && !window.confirm('未保存の変更があります。タスク詳細へ移動しますか？')) return
      setSelectedTodoId(todoId)
      setActiveView('detail')
    })
    return () => unsubscribe()
  }, [])

  // 画面と開いているタスクを URL に書く。画面を変えるたびに履歴を積み、ブラウザの「戻る」「進む」で戻れるようにする。
  // 最初の1回と「戻る」で変わったときは履歴を積まない。個人用のデスクトップ版（file://）など履歴を変えられないときは何もしない
  const urlTaskId = activeView === 'detail' || (activeView === 'gantt' && ganttSidePanelMode === 'detail') ? selectedTodoId : null
  const replaceNextUrlRef = useRef(true)
  const lastUrlRef = useRef<string | null>(null)
  useEffect(() => {
    if (isStandaloneGanttWindow || isStandaloneTaskReportWindow) return
    const search = buildUrlSearch(window.location.search, { view: activeView, taskId: urlTaskId })
    const url = `${window.location.pathname}${search}${window.location.hash}`
    const replace = replaceNextUrlRef.current
    replaceNextUrlRef.current = false
    if (search !== window.location.search) {
      try {
        if (replace) window.history.replaceState(null, '', url)
        else window.history.pushState(null, '', url)
      } catch {
        // 履歴を変えられない環境では URL に出さない
      }
    }
    lastUrlRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  }, [activeView, isStandaloneGanttWindow, isStandaloneTaskReportWindow, urlTaskId])

  useEffect(() => {
    if (isStandaloneGanttWindow || isStandaloneTaskReportWindow) return
    const handlePopState = (): void => {
      const state = parseUrlState(window.location.search)
      if (navigationStateRef.current.detailDirty && !window.confirm('未保存の変更があります。移動しますか？')) {
        // 移動をやめたら URL を元に戻す
        if (lastUrlRef.current) {
          try { window.history.pushState(null, '', lastUrlRef.current) } catch { /* 何もしない */ }
        }
        return
      }
      replaceNextUrlRef.current = true
      const view = state.view ?? (state.taskId ? 'detail' : 'gantt')
      // 詳細の履歴にタスクがない（消したタスクを見ていたなど）ときは、別のタスクを出さずにタスクなしで戻す
      if (state.taskId || view === 'detail') setSelectedTodoId(state.taskId ?? null)
      setGanttSidePanelMode(view === 'gantt' && state.taskId ? 'detail' : 'today')
      setActiveView(view)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [isStandaloneGanttWindow, isStandaloneTaskReportWindow])

  // フォーカスしていた部品が消えた（小窓を閉じた・画面を切り替えた・返信を送ったなど）ときは、
  // ページの先頭（body）に落とさず、いた区分け（一覧・本文・右のパネル・小窓）へ戻す。次の Tab がそこから続く
  useEffect(() => {
    let lastFocused: HTMLElement | null = null
    let lastRegion: HTMLElement | null = null
    const handleFocusIn = (event: FocusEvent): void => {
      if (!(event.target instanceof HTMLElement) || event.target === document.body) return
      lastFocused = event.target
      lastRegion = event.target.closest<HTMLElement>('[role="dialog"], [data-focus-region]')
    }
    const rescue = (): void => {
      if (document.activeElement && document.activeElement !== document.body) return
      // 何もない所を押して外した（部品はまだある）ときは、そのままにする
      if (!lastFocused || lastFocused.isConnected) return
      lastFocused = null
      const target = lastRegion?.isConnected ? lastRegion : document.getElementById('hakobi-main')
      if (!target) return
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
    }
    const observer = new MutationObserver(rescue)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('focusin', handleFocusIn)
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', handleFocusIn)
    }
  }, [])

  // Ctrl+K（Mac は ⌘K）で移動・操作のパレットを開く
  useEffect(() => {
    if (isStandaloneGanttWindow || isStandaloneTaskReportWindow) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      // すぐに描いて入力欄へフォーカスを移す（Ctrl+K の直後に打った文字を取りこぼさない）
      flushSync(() => setShowCommandPalette((previous) => !previous))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isStandaloneGanttWindow, isStandaloneTaskReportWindow])

  useEffect(() => {
    if (isFirstLaunch !== false) return

    const unsubscribe = window.api.onDataChanged((scope) => {
      if (scope === 'user') {
        void Promise.all([loadUsers(), loadTodos(), loadAllSubTasks()])
          .catch((error) => showToast(error instanceof Error ? error.message : 'メンバー情報を再読み込みできませんでした', 'error'))
        return
      }
      if (scope === 'category') {
        void Promise.all([loadCategories(), loadTodos()])
          .catch((error) => showToast(error instanceof Error ? error.message : 'カテゴリを再読み込みできませんでした', 'error'))
        return
      }

      if (scope === 'todo') {
        void Promise.all([loadTodos(), loadSelectedPlan(planDate), syncTimer()]).catch((error) => {
          showToast(error instanceof Error ? error.message : 'タスクを再読み込みできませんでした', 'error')
        })
        return
      }

      if (scope === 'subtask') {
        void loadAllSubTasks().catch((error) => {
          showToast(error instanceof Error ? error.message : 'サブタスクを再読み込みできませんでした', 'error')
        })
        return
      }

      if (scope === 'plan') {
        void Promise.all([loadTodayPlan(), loadSelectedPlan(planDate)])
          .catch((error) => showToast(error instanceof Error ? error.message : '計画を再読み込みできませんでした', 'error'))
      }
    })
    return () => unsubscribe()
  }, [isFirstLaunch, loadAllSubTasks, loadCategories, loadSelectedPlan, loadTodayPlan, loadTodos, loadUsers, planDate, showToast, syncTimer])

  useEffect(() => {
    if (!currentUser) {
      setNotifications([])
      setNotificationUnreadCount(0)
      setShowNotifications(false)
      return
    }

    void loadNotifications().catch((error) => console.error('Failed to load notifications', error))
    const unsubscribe = window.api.onNotificationsChanged((unreadCount) => {
      resourceRequestsRef.current.notifications = (resourceRequestsRef.current.notifications ?? 0) + 1
      setNotificationUnreadCount(unreadCount)
      if (showNotifications) {
        void loadNotifications().catch((error) => console.error('Failed to load notifications', error))
      }
    })
    return () => unsubscribe()
  }, [currentUser, loadNotifications, showNotifications])

  useEffect(() => {
    window.localStorage.setItem('show-plan-rail', String(showPlanRail))
  }, [showPlanRail])

  useEffect(() => {
    window.localStorage.setItem('app-scope-lens', scopeLens)
  }, [scopeLens])

  useEffect(() => {
    window.localStorage.setItem('show-category-pane', String(showCategoryPane))
  }, [showCategoryPane])

  useEffect(() => {
    window.localStorage.setItem('show-task-pane', String(showTaskPane))
  }, [showTaskPane])

  useEffect(() => {
    window.localStorage.setItem(GANTT_PANES_STORAGE_KEY, JSON.stringify(ganttPanes))
  }, [ganttPanes])

  // 画面が狭いのでガントのパネルを畳んで始めたときは、一覧が消えたと思われないよう一度だけ知らせる
  useEffect(() => {
    if (isFirstLaunch !== false || activeView !== 'gantt' || !ganttPanesNoticePendingRef.current) return
    ganttPanesNoticePendingRef.current = false
    showToast('ガントを広く見せるため、左右のパネルを畳みました。上の「表示」から開けます', 'info', {
      label: 'パネルを開く',
      run: () => setGanttPanes({ category: true, task: true, side: true })
    })
  }, [activeView, isFirstLaunch, showToast])

  // 画面が狭いときは、ガント以外の画面で右の「今日の予定」とカテゴリ一覧を自動で隠す（中央が細くなりすぎないように）。
  // 狭いあいだに「表示」から開いたものは開いたままにし、広くなったら元の設定に戻る
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const update = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update)
    // resize が届かない環境（画面の拡大・埋め込みの表示など）でも幅の変化を拾う
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(document.documentElement)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [])
  // 文字を大きくしているときは、同じ幅でも入る量が減るので、文字の倍率で割った幅で決める
  const fontScaleFactor = Math.max(1, (Number.parseFloat(fontScale) || 100) / 100)
  const effectiveViewportWidth = viewportWidth / fontScaleFactor
  // カンバンは、表示する設定のパネルの幅を足して、4列が収まらなければ右から順に隠す
  const kanbanBoardWidth = (hide: { side: boolean; category: boolean }): number => viewportWidth
    - (showTaskPane ? paneWidths.list : 0)
    - (showCategoryPane && !hide.category ? paneWidths.category : 0)
    - (showPlanRail && !hide.side ? paneWidths.side : 0)
  const isKanban = activeView === 'kanban'
  const autoHideSidePanel = isKanban
    ? kanbanBoardWidth({ side: false, category: false }) < KANBAN_MIN_BOARD_WIDTH
    : effectiveViewportWidth < NARROW_SIDE_PANEL_WIDTH
  const autoHideCategoryPane = isKanban
    ? kanbanBoardWidth({ side: true, category: false }) < KANBAN_MIN_BOARD_WIDTH
    : effectiveViewportWidth < NARROW_CATEGORY_PANE_WIDTH
  const autoHideTaskPane = (isKanban && kanbanBoardWidth({ side: true, category: true }) < KANBAN_MIN_BOARD_WIDTH)
    || (activeView !== 'detail' && effectiveViewportWidth < 1000)
  const [openedWhileNarrow, setOpenedWhileNarrow] = useState({ category: false, side: false, task: false })
  useEffect(() => {
    setOpenedWhileNarrow((previous) => {
      const next = { category: previous.category && autoHideCategoryPane, side: previous.side && autoHideSidePanel, task: previous.task && autoHideTaskPane }
      return next.category === previous.category && next.side === previous.side && next.task === previous.task ? previous : next
    })
  }, [autoHideCategoryPane, autoHideSidePanel, autoHideTaskPane])
  // 自動で隠したことは、パネルが消えたと思われないよう知らせる。毎回出ると邪魔なので、この端末で種類ごとに一度だけ
  useEffect(() => {
    if (isFirstLaunch !== false || activeView === 'gantt') return
    const hidden: string[] = []
    if (autoHideCategoryPane && showCategoryPane && !openedWhileNarrow.category) hidden.push('カテゴリ一覧')
    if (autoHideSidePanel && showPlanRail && !openedWhileNarrow.side && !SIDE_PANEL_VIEWS_WITHOUT_RAIL.includes(activeView)) hidden.push('右の「今日の予定」')
    if (autoHideTaskPane && showTaskPane && !openedWhileNarrow.task) hidden.push('タスク一覧')
    if (hidden.length === 0) return
    // カンバンで隠すときは、4列を収めるためだと書く
    const forKanbanOnly = isKanban
    const noticeKey = `narrow-panes-notice:${forKanbanOnly ? 'kanban' : 'narrow'}`
    try {
      if (window.localStorage.getItem(noticeKey)) return
      window.localStorage.setItem(noticeKey, '1')
    } catch { /* 覚えられなくても知らせる */ }
    showToast(forKanbanOnly
      ? `カンバンの4列が収まるよう、${hidden.join('と')}を隠しました。上の「表示」から開けます`
      : `画面の幅に合わせて、${hidden.join('と')}を隠しました。上の「表示」から開けます`, 'info')
  }, [activeView, autoHideCategoryPane, autoHideSidePanel, autoHideTaskPane, isFirstLaunch, isKanban, openedWhileNarrow, showCategoryPane, showPlanRail, showTaskPane, showToast])

  // 一覧の担当の絞り込みは、見ている人ごとに端末へ覚える（読み込み直すたびに「自分」へ戻らないように）。
  // 覚えていなければ「自分」から始める
  const assigneeFilterStorageKey = currentUser ? `hakobi-list-assignee:${currentUser.id}` : null
  useEffect(() => {
    if (assigneeDefaultApplied || !currentUser || users.length === 0) return
    let stored: string | null = null
    try { stored = window.localStorage.getItem(`hakobi-list-assignee:${currentUser.id}`) } catch { /* 読めなければ「自分」 */ }
    setSelectedAssigneeId(stored === '__all__' ? null
      : stored === '__none__' ? ''
        : stored && users.some((user) => user.id === stored) ? stored
          : currentUser.id)
    setAssigneeDefaultApplied(true)
  }, [assigneeDefaultApplied, currentUser, users])
  useEffect(() => {
    if (!assigneeDefaultApplied || !assigneeFilterStorageKey) return
    try {
      window.localStorage.setItem(assigneeFilterStorageKey, selectedAssigneeId === null ? '__all__' : selectedAssigneeId === '' ? '__none__' : selectedAssigneeId)
    } catch { /* 覚えられなくても絞り込みは使える */ }
  }, [assigneeDefaultApplied, assigneeFilterStorageKey, selectedAssigneeId])

  // 「OS に合わせる」のときは、OS のライト・ダークの切り替えにもついていく
  const [systemPrefersLight, setSystemPrefersLight] = useState(() => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!query) return
    const update = (): void => setSystemPrefersLight(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const effectiveTheme: 'dark' | 'light' = themeMode === 'system' ? (systemPrefersLight ? 'light' : 'dark') : themeMode

  useEffect(() => {
    window.localStorage.setItem('app-theme-mode', themeMode)
    // 色は styles/theme.css のトークンを :root[data-theme] で切り替える（以前の画面全体の色反転はやめた）
    document.documentElement.setAttribute('data-theme', effectiveTheme)
  }, [effectiveTheme, themeMode])

  useEffect(() => {
    window.localStorage.setItem('app-font-family', fontFamily)
    document.documentElement.style.setProperty('--font-family', fontFamily)
  }, [fontFamily])

  useEffect(() => {
    window.localStorage.setItem('app-font-scale', fontScale)
    document.documentElement.style.fontSize = fontScale
  }, [fontScale])

  useEffect(() => {
    window.localStorage.setItem('app-pane-widths', JSON.stringify(paneWidths))
  }, [paneWidths])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const current = resizeRef.current
      if (!current) return

      const delta = event.clientX - current.startX
      setPaneWidths((previous) => {
        if (current.key === 'category') {
          return { ...previous, category: clamp(current.startWidth + delta, 132, 320) }
        }

        if (current.key === 'list') {
          return { ...previous, list: clamp(current.startWidth + delta, 220, 460) }
        }

        return { ...previous, side: clamp(current.startWidth - delta, SIDE_PANE_MIN_WIDTH, 720) }
      })
    }

    const stopResize = (): void => {
      resizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }
  }, [])

  // 最初のデータ（タスク・カテゴリなど）がそろったか。URL で開いたタスクの確認に使う
  const [initialDataLoaded, setInitialDataLoaded] = useState(false)

  const handleSetupComplete = useCallback(async () => {
    setIsFirstLaunch(false)
    await loadInitialData()
    setInitialDataLoaded(true)
    await syncTimer()
  }, [loadInitialData, syncTimer])

  useEffect(() => {
    if (isFirstLaunch !== false) return

    const init = async (): Promise<void> => {
      await loadInitialData()
      setInitialDataLoaded(true)
      await syncTimer()
    }

    init().catch((error) => {
      setInitialLoadError(error instanceof Error ? error.message : 'データを読み込めませんでした')
    })
  }, [isFirstLaunch, loadInitialData, syncTimer])

  const gettingStartedKey = `hakobi-getting-started:${currentUser?.id ?? 'local'}`
  useEffect(() => {
    if (!initialDataLoaded || isFirstLaunch !== false || isStandaloneGanttWindow || isStandaloneTaskReportWindow) return
    try {
      if (window.localStorage.getItem(gettingStartedKey)) return
      window.localStorage.setItem(gettingStartedKey, '1')
    } catch { return }
    const timer = window.setTimeout(() => {
      showToast('はじめての方へ: 毎日することを3つの手順にまとめました', 'info', { label: '使い方を見る', run: () => setShowGettingStarted(true) })
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [gettingStartedKey, initialDataLoaded, isFirstLaunch, isStandaloneGanttWindow, isStandaloneTaskReportWindow, showToast])

  const handleExportClipboard = useCallback(async () => {
    const result = await window.api.markdownExport('clipboard')
    showToast(result.message, result.success ? 'success' : 'error')
  }, [showToast])

  const handleThemeModeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode)
    await window.api.settingsSet('themeMode', mode)
  }, [])

  const handleFontFamilyChange = useCallback(async (value: string) => {
    setFontFamily(value)
    await window.api.settingsSet('fontFamily', value)
  }, [])

  const handleFontScaleChange = useCallback(async (value: string) => {
    setFontScale(value)
    await window.api.settingsSet('fontScale', value)
  }, [])

  useEffect(() => {
    const unsubQuickAdd = window.api.onShortcutQuickAdd(() => { setQuickAddDefaults(null); setShowQuickAdd(true) })
    const unsubExport = window.api.onShortcutExport(() => handleExportClipboard())
    return () => {
      unsubQuickAdd()
      unsubExport()
    }
  }, [handleExportClipboard])

  // 検索の絞り込みは入力より少し遅れて反映してよい。1文字ごとに全画面を描き直すと入力が重くなるため
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const q = deferredSearchQuery.trim().toLowerCase()
  const multiUser = users.length > 0
  const isAdmin = currentUser?.role === 'admin'

  // サーバーとのつながり（サーバー版だけ）。一度つながったあとに2秒以上切れていたら上に帯を出す。
  // 一瞬の切断や、起動直後のつながる前には出さない
  const [serverDisconnected, setServerDisconnected] = useState(false)
  useEffect(() => {
    if (!multiUser) return
    let everConnected = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.api.onConnectionChange((connected) => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (connected) {
        everConnected = true
        setServerDisconnected(false)
        return
      }
      if (everConnected) timer = setTimeout(() => setServerDisconnected(true), 2000)
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      setServerDisconnected(false)
    }
  }, [multiUser])
  const privateCategoryIds = useMemo(
    () => new Set(categories.filter((category) => category.is_private).map((category) => category.id)),
    [categories]
  )
  const hiddenPrivateTodoIds = useMemo(
    () => scopeLens === 'team'
      ? new Set(todos.filter((todo) => todo.category_id != null && privateCategoryIds.has(todo.category_id)).map((todo) => todo.id))
      : new Set<string>(),
    [privateCategoryIds, scopeLens, todos]
  )
  // 上部の「進捗」タブに出す新着の件数（サーバー版のみ。進捗タブを開いている間は 0）
  const progressUnseenCount = useProgressUnseenCount(users.length > 0 ? currentUser?.id ?? null : null, activeView === 'progress', hiddenPrivateTodoIds)
  // 共有されたリンクで開いたタスクが「集計外を隠す」で隠れていたら、隠すのをやめて開く（集計外はアクセス制限ではない）
  const deepLinkTaskIdRef = useRef(initialUrlState.taskId)
  useEffect(() => {
    const id = deepLinkTaskIdRef.current
    if (!id || !initialDataLoaded) return
    deepLinkTaskIdRef.current = null
    if (!hiddenPrivateTodoIds.has(id)) return
    setScopeLens('personal')
    showToast('リンクのタスクは集計外のカテゴリにあるので、集計外も表示しました')
  }, [hiddenPrivateTodoIds, initialDataLoaded, showToast])

  // レンズ以外の検索・担当・カテゴリ絞り込みとは分離し、詳細や依存候補にも同じ集合を使う。
  const lensTodos = useMemo(
    () => hiddenPrivateTodoIds.size === 0 ? todos : todos.filter((todo) => !hiddenPrivateTodoIds.has(todo.id)),
    [hiddenPrivateTodoIds, todos]
  )
  const lensPlanItems = useMemo(
    () => scopeLens === 'personal'
      ? todayPlanItems
      : todayPlanItems.filter((item) => item.category_id == null || !privateCategoryIds.has(item.category_id)),
    [privateCategoryIds, scopeLens, todayPlanItems]
  )
  const lensSelectedPlanItems = useMemo(
    () => scopeLens === 'personal'
      ? selectedPlanItems
      : selectedPlanItems.filter((item) => item.category_id == null || !privateCategoryIds.has(item.category_id)),
    [privateCategoryIds, scopeLens, selectedPlanItems]
  )

  // サブタスクの検索用の文字列（タスクごと）。検索のたびに全サブタスクを見直さないよう、先にまとめておく
  const subTaskSearchTextByTodo = useMemo(() => {
    const map = new Map<string, string>()
    for (const subTask of allSubTasks) {
      const text = `${subTask.title}\n${subTask.description}\n${subTask.assignee_name ?? ''}`.toLowerCase()
      map.set(subTask.todo_id, `${map.get(subTask.todo_id) ?? ''}\n${text}`)
    }
    return map
  }, [allSubTasks])

  // タスク一覧の絞り込み（アーカイブ・カテゴリ・担当・検索）。
  // 報告タブは独自の担当絞り込みを持つので、ignoreAssignee で一覧の担当絞り込みを外して使う。
  const matchesListFilters = useCallback((todo: Todo, ignoreAssignee = false): boolean => {
    if (!showArchived && todo.status === 'archived') return false
    if (selectedCategoryId && todo.category_id !== selectedCategoryId) return false
    if (!ignoreAssignee && selectedAssigneeId !== null) {
      if (selectedAssigneeId === '' && (todo.assignee_id !== null || (todo.co_assignees ?? []).length > 0)) return false
      // 主担当またはサブ担当のどちらかに入っていれば表示する
      if (
        selectedAssigneeId !== '' &&
        todo.assignee_id !== selectedAssigneeId &&
        !(todo.co_assignees ?? []).some((coAssignee) => coAssignee.user_id === selectedAssigneeId)
      ) return false
    }

    if (q) {
      const hit = todo.title.toLowerCase().includes(q)
        || todo.description.toLowerCase().includes(q)
        || todo.memo.toLowerCase().includes(q)
        || (todo.category_name?.toLowerCase().includes(q) ?? false)
        || (todo.assignee_name?.toLowerCase().includes(q) ?? false)
        || (todo.co_assignees ?? []).some((assignee) => assignee.display_name.toLowerCase().includes(q))
        || (subTaskSearchTextByTodo.get(todo.id)?.includes(q) ?? false)

      if (!hit) return false
    }

    return true
  }, [q, selectedAssigneeId, selectedCategoryId, showArchived, subTaskSearchTextByTodo])

  const compareTodos = useCallback((a: Todo, b: Todo): number => {
    if (a.status === 'archived' && b.status !== 'archived') return 1
    if (a.status !== 'archived' && b.status === 'archived') return -1

    if (sortField === 'sort_order') {
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    }
    // 並べ替えたときは、完了したタスクを後ろにまとめる（手動の並びはそのまま）
    if (a.status === 'done' && b.status !== 'done') return 1
    if (a.status !== 'done' && b.status === 'done') return -1

    let aVal: string | number
    let bVal: string | number

    if (sortField === 'title') {
      aVal = a.title.toLowerCase()
      bVal = b.title.toLowerCase()
    } else if (sortField === 'due_date') {
      aVal = a.due_date ?? (sortDir === 'asc' ? '\uffff' : '')
      bVal = b.due_date ?? (sortDir === 'asc' ? '\uffff' : '')
    } else {
      aVal = (a[sortField] as number) ?? 0
      bVal = (b[sortField] as number) ?? 0
    }

    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1
    return 0
  }, [sortDir, sortField])

  // 計測中は App が毎秒描き直されるので、絞り込みと並べ替えは元のデータが変わったときだけ計算し直す
  const filteredTodos = useMemo(
    () => lensTodos.filter((todo) => matchesListFilters(todo)).sort(compareTodos),
    [compareTodos, lensTodos, matchesListFilters]
  )
  const sortedLensTodos = useMemo(() => lensTodos.slice().sort(compareTodos), [compareTodos, lensTodos])
  // ToDoリスト（中の項目をチェックして使うタスク）の項目の進み具合。一覧・カンバンのバッジに使う
  const checklistSummaries = useMemo(() => buildChecklistSummaries(todos, allSubTasks), [allSubTasks, todos])
  // ToDoリストの項目（リストごと・並び順どおり）と、自分の「今日やること」。ToDoリストを使う人だけに ToDo タブ・右の「今日のToDo」を出す
  const listItemsByTodo = useMemo(
    () => groupListItems(new Set(todos.filter((todo) => todo.list_mode).map((todo) => todo.id)), allSubTasks),
    [allSubTasks, todos]
  )
  const listUserId = multiUser ? currentUser?.id ?? null : null
  const myListTodos = useMemo(
    () => lensTodos.filter((todo) => isActiveList(todo) && isMyList(todo, listItemsByTodo.get(todo.id) ?? [], listUserId)),
    [lensTodos, listItemsByTodo, listUserId]
  )
  const todayKeyForLists = getTodayKey()
  const myTodayGroups = useMemo(
    () => buildTodayGroups(myListTodos, listItemsByTodo, listUserId, todayKeyForLists),
    [listItemsByTodo, listUserId, myListTodos, todayKeyForLists]
  )
  const todoRemainingCount = countRemaining(myTodayGroups)
  const usesTodoLists = myListTodos.length > 0
  const reportTodos = useMemo(
    () => lensTodos.filter((todo) => matchesListFilters(todo, true)).sort(compareTodos),
    [compareTodos, lensTodos, matchesListFilters]
  )

  // タイマーの秒更新では変化せず、概要の集計元が実際に変わったときだけ更新されるキー。
  const overviewDataRevision = useMemo(() => JSON.stringify({
    todos: todos.map((todo) => [
      todo.id, todo.updated_at, todo.status, todo.progress, todo.priority, todo.due_date,
      todo.category_id, todo.assignee_id, (todo.co_assignees ?? []).map((item) => item.user_id)
    ]),
    subTasks: allSubTasks.map((subTask) => [
      subTask.id, subTask.todo_id, subTask.title, subTask.done, subTask.progress,
      subTask.completed_at, subTask.start_date, subTask.due_date, subTask.assignee_id
    ]),
    categories: categories.map((category) => [category.id, category.name, category.color, category.is_private]),
    users: users.map((user) => [user.id, user.display_name, user.color, user.is_active])
  }), [allSubTasks, categories, todos, users])

  const selectedTodo = lensTodos.find((todo) => todo.id === selectedTodoId) ?? null

  // ほかの画面（チーム・報告など）からタスクを開いたときは、詳細にその画面へ戻るボタンを出す。タブで画面を変えたら消す
  const [detailReturnView, setDetailReturnView] = useState<CenterView | null>(null)

  // 上部のタブで画面を切り替える。表示中のタブをもう一度押しても、ほかの画面には移らない
  const toggleCenterView = useCallback((view: CenterView) => {
    if (view === activeView) return
    if (detailDirty && !window.confirm('未保存の変更があります。別の画面へ移動しますか？')) return
    setDetailReturnView(null)
    setActiveView(view)
    if (view === 'gantt') setGanttSidePanelMode('today')
  }, [activeView, detailDirty])

  const openTodoDetail = useCallback((id: string) => {
    if (id !== selectedTodoId && detailDirty && !window.confirm('未保存の変更があります。別のタスクへ移動しますか？')) return
    setSelectedTodoId(id)
    if (activeView === 'gantt') {
      setGanttSidePanelMode('detail')
      return
    }
    if (activeView !== 'detail') setDetailReturnView(activeView)
    setActiveView('detail')
  }, [activeView, detailDirty, selectedTodoId])

  const openNotifications = useCallback(() => {
    setShowNotifications(true)
    void loadNotifications().catch((error) => {
      console.error('Failed to load notifications', error)
      showToast('通知を読み込めませんでした', 'error')
    })
  }, [loadNotifications, showToast])

  const handleSelectNotification = useCallback(async (notification: UserNotification): Promise<void> => {
    try {
      if (notification.read_at == null) {
        await window.api.notificationMarkRead(notification.id)
      }
      await loadNotifications()
      if ((notification.type === 'progress_reply' || notification.type === 'progress_reaction' || notification.type === 'mention') && notification.progress_note_id) {
        if (navigationStateRef.current.detailDirty && !window.confirm('未保存の変更があります。進捗画面へ移動しますか？')) return
        setProgressTimelineFocus({
          date: getDateKeyFromIso(notification.created_at),
          todoId: notification.todo_id,
          noteId: notification.progress_note_id,
          commentId: notification.progress_comment_id,
          nonce: Date.now()
        })
        setActiveView('progress')
      } else if (notification.type === 'report_reminder') {
        // 報告のリマインドは報告タブで、自分の未報告を確かめてもらう
        if (navigationStateRef.current.detailDirty && !window.confirm('未保存の変更があります。報告タブへ移動しますか？')) return
        setActiveView('report')
      } else if (notification.todo_id) {
        openTodoDetail(notification.todo_id)
      }
      setShowNotifications(false)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '通知を更新できませんでした', 'error')
    }
  }, [loadNotifications, openTodoDetail, showToast])

  const handleMarkAllNotificationsRead = useCallback(async (): Promise<void> => {
    try {
      await window.api.notificationMarkAllRead()
      await loadNotifications()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '通知を既読にできませんでした', 'error')
    }
  }, [loadNotifications, showToast])

  // デスクトップ版の OS 通知をクリックしたときも、通知一覧で選んだときと同じ画面を開く
  const notificationActionsRef = useRef({ openNotifications, handleSelectNotification })
  notificationActionsRef.current = { openNotifications, handleSelectNotification }
  useEffect(() => {
    if (!currentUser) return undefined
    return window.api.onOpenNotification((notificationId) => {
      if (!notificationId) {
        notificationActionsRef.current.openNotifications()
        return
      }
      void window.api.notificationList().then((items) => {
        const notification = items.find((item) => item.id === notificationId)
        if (notification) void notificationActionsRef.current.handleSelectNotification(notification)
        else notificationActionsRef.current.openNotifications()
      }).catch(() => notificationActionsRef.current.openNotifications())
    })
  }, [currentUser])

  const beginResize = useCallback((key: PaneKey, startWidth: number, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeRef.current = { key, startX: event.clientX, startWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const hideGanttSidePanel = useCallback(() => {
    if (detailDirty && !window.confirm('未保存の変更があります。詳細を閉じますか？')) return
    setGanttSidePanelMode('today')
    setGanttPanes((previous) => ({ ...previous, side: false }))
  }, [detailDirty])

  const handleAdd = useCallback(async (data: CreateTodoInput) => {
    const created = await window.api.todoCreate(data)
    await loadTodos()
    return created
  }, [loadTodos])

  // 追加したタスクが今の絞り込みで一覧に出ないと「消えた」と思われるので、そのときは理由と解除ボタンを出す
  const openTodoDetailRef = useRef(openTodoDetail)
  openTodoDetailRef.current = openTodoDetail
  // ガントに渡す「タスクを開く」。選択が変わっても同じ関数のままにして、ガントを描き直さない
  const selectTodoStable = useCallback((id: string) => openTodoDetailRef.current(id), [])
  const handleAdded = (created: Todo[]): void => {
    if (created.length === 0) return
    const first = created[0]
    const hiddenByLens = scopeLens === 'team' && first.category_id != null && privateCategoryIds.has(first.category_id)
    const hidden = hiddenByLens || !matchesListFilters(first)
    const label = created.length === 1 ? `「${first.title}」を追加しました` : `${created.length}件のタスクを追加しました`
    if (!hidden) {
      showToast(label, 'success', { label: '開く', run: () => openTodoDetailRef.current(first.id) })
      return
    }
    showToast(`${label}。今の絞り込みでは一覧に表示されません`, 'success', {
      label: '絞り込みを解除して開く',
      run: () => {
        setSearchQuery('')
        setShowArchived(false)
        setSelectedCategoryId((previous) => previous && previous !== first.category_id ? null : previous)
        setSelectedAssigneeId(null)
        if (hiddenByLens) setScopeLens('personal')
        openTodoDetailRef.current(first.id)
      }
    })
  }

  // 新しいタスクの担当の初期値: 一覧を特定の人で絞っていればその人、未割り当てで絞っていれば未割り当て、それ以外は自分。
  // 追加した直後に一覧から消えたように見えないようにする
  const defaultNewTaskAssigneeId = selectedAssigneeId === null ? currentUser?.id ?? null : selectedAssigneeId === '' ? null : selectedAssigneeId
  const openQuickAdd = useCallback((defaults?: { categoryId?: string | null; assigneeId?: string | null; listMode?: boolean }): void => {
    setQuickAddDefaults(defaults ?? null)
    setShowQuickAdd(true)
  }, [])

  // 一覧が空のときの「絞り込みを解除」。集計外を隠していてタスクが見えないこともあるので、それも戻す
  const clearListFilters = useCallback((): void => {
    setSearchQuery('')
    setSelectedCategoryId(null)
    setSelectedAssigneeId(null)
    setScopeLens('personal')
  }, [])

  const handleUpdate = useCallback(async (id: string, data: UpdateTodoInput) => {
    // 日程を変えたときは、依存関係でほかのタスクが動いたかを読み込み後に確かめて知らせる
    if (data.start_date !== undefined || data.due_date !== undefined) {
      scheduleWatchRef.current = { editedId: id, before: new Map(todosRef.current.map((todo) => [todo.id, scheduleKeyOf(todo)])) }
    }
    try {
      await window.api.todoUpdate(id, data)
    } catch (error) {
      scheduleWatchRef.current = null
      throw error
    }
    try { await Promise.all([loadTodos(), loadSelectedPlan(planDate), syncTimer()]) }
    catch (error) { showToast(`変更は保存しましたが、表示を更新できませんでした: ${error instanceof Error ? error.message : '再読み込みしてください'}`, 'error') }
  }, [loadTodos, loadSelectedPlan, planDate, showToast, syncTimer])

  // 依存関係の後続が自動で動いたことの知らせ（後続はほかの人のタスクのこともあり、気づかないと計画を読み違える）
  useEffect(() => {
    const watch = scheduleWatchRef.current
    if (!watch) return
    scheduleWatchRef.current = null
    const moved = todos.filter((todo) => todo.id !== watch.editedId && watch.before.has(todo.id) && watch.before.get(todo.id) !== scheduleKeyOf(todo))
    if (moved.length === 0) return
    const first = moved[0]
    const range = `${first.start_date ? formatShortDate(first.start_date) : '—'}〜${first.due_date ? formatShortDate(first.due_date) : '—'}`
    const owner = first.assignee_name ? `（${first.assignee_name}）` : ''
    showToast(moved.length === 1
      ? `依存関係で、後続の「${first.title}」${owner}も ${range} に動きました`
      : `依存関係で、後続の${moved.length}件（「${first.title}」${owner}ほか）の日程も動きました`, 'success', { key: SCHEDULE_TOAST_KEY })
  }, [todos, showToast])

  // ToDoリストの項目のチェック（右パネル・一覧の展開・ToDo タブ）。すぐ画面に反映し、失敗したら戻す
  const [pendingListItemIds, setPendingListItemIds] = useState<Set<string>>(() => new Set())
  const handleToggleListItem = useCallback((item: SubTask): void => {
    if (pendingListItemIds.has(item.id)) return
    const nextDone = item.done ? 0 : 1
    setPendingListItemIds((previous) => new Set(previous).add(item.id))
    setAllSubTasks((previous) => previous.map((subTask) => subTask.id === item.id
      ? { ...subTask, done: nextDone, progress: nextDone ? 100 : 0, completed_at: nextDone ? new Date().toISOString() : null }
      : subTask))
    void window.api.subtaskUpdate(item.id, { done: Boolean(nextDone), expected_values: { done: Boolean(item.done) } })
      .then((updated) => setAllSubTasks((previous) => previous.map((subTask) => subTask.id === updated.id ? updated : subTask)))
      .catch((error) => {
        setAllSubTasks((previous) => previous.map((subTask) => subTask.id === item.id ? item : subTask))
        showToast(error instanceof Error ? error.message : '項目を更新できませんでした', 'error')
      })
      .finally(() => setPendingListItemIds((previous) => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      }))
  }, [pendingListItemIds, showToast])

  // ToDo タブで名前だけで ToDoリストを作る。担当は自分、今日から使い始める
  const handleCreateList = useCallback(async (title: string): Promise<boolean> => {
    try {
      const created = await window.api.todoCreate({
        title,
        list_mode: 1,
        status: 'active',
        assignee_id: multiUser ? currentUser?.id ?? null : null,
        start_date: getTodayKey()
      })
      await loadTodos()
      showToast(`ToDoリスト「${created.title}」を作りました。項目を追加してください`)
      return true
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ToDoリストを作れませんでした', 'error')
      return false
    }
  }, [currentUser, loadTodos, multiUser, showToast])

  // ToDo タブのチェックリストからの変更を、全体のサブタスクに反映する
  const handleListItemsChange = useCallback((todoId: string, update: (previous: SubTask[]) => SubTask[]): void => {
    setAllSubTasks((previous) => {
      const mine = previous.filter((subTask) => subTask.todo_id === todoId).sort((a, b) => a.sort_order - b.sort_order)
      return [...previous.filter((subTask) => subTask.todo_id !== todoId), ...update(mine)]
    })
  }, [])

  // サブタスクの期限は親タスクの期限を延長することがあるので、タスクも取り直す
  const handleUpdateSubTask = useCallback(async (id: string, data: UpdateSubTaskInput) => {
    await window.api.subtaskUpdate(id, data)
    await Promise.all([loadAllSubTasks(), loadTodos()])
  }, [loadAllSubTasks, loadTodos])

  const handleCreateSubTask = useCallback(async (todoId: string, data: CreateSubTaskInput) => {
    await window.api.subtaskCreate(todoId, data)
    await Promise.all([loadAllSubTasks(), loadTodos()])
  }, [loadAllSubTasks, loadTodos])

  const handleOpenGanttWindow = useCallback(async () => {
    await window.api.windowOpenGantt()
  }, [])

  const handleArchive = useCallback(async (id: string) => {
    const previousStatus = todos.find((todo) => todo.id === id)?.status
    await window.api.todoArchive(id)
    await loadTodos()
    if (selectedTodoId === id) setSelectedTodoId(null)
    showToast('アーカイブしました', 'success', { label: '元に戻す', run: () => { void window.api.todoUnarchive(id, previousStatus === 'archived' ? 'active' : previousStatus).then(loadTodos).then(() => showToast('元の状態に戻しました')) } })
  }, [loadTodos, selectedTodoId, showToast, todos])

  const handleUnarchive = useCallback(async (id: string) => {
    await window.api.todoUnarchive(id)
    await loadTodos()
    showToast('復元しました')
  }, [loadTodos, showToast])

  const handleDelete = useCallback(async (id: string) => {
    await window.api.todoDelete(id)
    await loadTodos()
    if (selectedTodoId === id) setSelectedTodoId(null)
    showToast('削除しました')
  }, [loadTodos, selectedTodoId, showToast])

  const handleToggleDone = useCallback(async (todo: Todo) => {
    const newStatus: Todo['status'] = todo.status === 'done'
      ? (todo.progress > 0 ? 'active' : 'not_started')
      : 'done'
    // 繰り返しタスクの次回分はDB層が完了時に自動生成する
    try {
      await window.api.todoUpdate(todo.id, { status: newStatus })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '状態を変えられませんでした', 'error')
      return
    }

    // 一覧の丸は小さく押し間違えやすいので、完了にしたときは元に戻せるようにする
    const recurrenceMessage = newStatus === 'done' ? recurrenceDoneMessage(todo) : recurrenceReopenMessage(todo)
    if (newStatus === 'done') {
      const previousStatus = todo.status
      // サブタスクが残ったまま完了にしたときは、知らせに件数を書き添える（止めはしない。元に戻すで戻せる）
      let openSubTaskNote = ''
      if (!todo.list_mode) {
        try {
          const openCount = (await window.api.subtaskGetByTodo(todo.id)).filter((subTask) => subTask.progress < 100).length
          if (openCount > 0) openSubTaskNote = `（未完了のサブタスクが${openCount}件あります）`
        } catch { /* 数えられなくても完了の知らせは出す */ }
      }
      showToast(`「${todo.title}」を完了にしました${openSubTaskNote}${recurrenceMessage ? `。${recurrenceMessage}` : ''}`, 'success', {
        label: '元に戻す',
        run: () => {
          void window.api.todoUpdate(todo.id, { status: previousStatus }).then(
            () => { showToast(`「${todo.title}」の完了を取り消しました`); void loadTodos() },
            (error: unknown) => showToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
          )
        }
      })
    } else if (recurrenceMessage) {
      showToast(`完了を取り消しました。${recurrenceMessage}`)
    }

    await loadTodos()
  }, [loadTodos, showToast])

  // カンバンの列間ドラッグでステータスを変更。完了化したら handleToggleDone と同じく
  // 繰り返しタスクの次回分作成（DB層が自動生成）を通知する。
  const handleKanbanMove = useCallback(async (todo: Todo, status: Todo['status']) => {
    if (todo.status === status) return
    try {
      await window.api.todoUpdate(todo.id, { status })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '状態を変えられませんでした', 'error')
      return
    }
    // 列を移したことを知らせ、その場で戻せるようにする（キーボードで移したときの読み上げにもなる）
    const recurrenceMessage = status === 'done' ? recurrenceDoneMessage(todo) : null
    const previousStatus = todo.status
    showToast(`「${todo.title}」を${KANBAN_STATUS_LABELS[status]}にしました${recurrenceMessage ? `。${recurrenceMessage}` : ''}`, 'success', {
      label: '元に戻す',
      run: () => {
        void window.api.todoUpdate(todo.id, { status: previousStatus }).then(
          () => { showToast(`「${todo.title}」を${KANBAN_STATUS_LABELS[previousStatus]}に戻しました`); void loadTodos() },
          (error: unknown) => showToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
        )
      }
    })
    await loadTodos()
  }, [loadTodos, showToast])

  const handleKanbanCreate = useCallback(async (title: string, status: Todo['status']) => {
    const created = await window.api.todoCreate({
      title,
      status: status === 'archived' ? 'not_started' : status,
      category_id: selectedCategoryId,
      assignee_id: selectedAssigneeId === null ? currentUser?.id ?? null : selectedAssigneeId || null,
      start_date: getTodayKey()
    })
    await loadTodos()
    showToast(`「${created.title}」を追加しました`)
  }, [loadTodos, selectedCategoryId, selectedAssigneeId, currentUser, showToast])

  const handleCategoryAdd = useCallback(async (name: string, color: string, isPrivate: boolean) => {
    await window.api.categoryCreate(name, color, isPrivate)
    await loadCategories()
  }, [loadCategories])

  const handleCategoryUpdate = useCallback(async (id: string, name: string, color: string, description: string, isPrivate: boolean) => {
    await window.api.categoryUpdate(id, name, color, description, isPrivate)
    await loadCategories()
  }, [loadCategories])

  const handleCategoryDelete = useCallback(async (id: string) => {
    await window.api.categoryDelete(id)
    await loadCategories()
    if (selectedCategoryId === id) setSelectedCategoryId(null)
    await loadTodos()
  }, [selectedCategoryId, loadCategories, loadTodos])

  const handleCategoryReorder = useCallback(async (orderedIds: string[]) => {
    await window.api.categoryReorder(orderedIds)
    await loadCategories()
  }, [loadCategories])

  const handleExportFile = useCallback(async () => {
    const result = await window.api.markdownExport('file')
    showToast(result.message, result.success ? 'success' : 'error')
  }, [showToast])

  // 一覧・ガントの並べ替えは、見えているタスクだけの並びで呼ばれる（絞り込み中など）。DB は渡した順に番号を振り直すので、
  // 全タスクの並びの中で見えている分が占めていた位置に入れ直してから保存し、隠れているタスクと番号が重ならないようにする
  const handleReorder = useCallback(async (orderedIds: string[]) => {
    const allIds = todos.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((todo) => todo.id)
    await window.api.todoReorder(mergeSubsetOrder(allIds, orderedIds))
    await loadTodos()
  }, [loadTodos, todos])

  const handleAddToTodayPlan = useCallback(async (todoId: string) => {
    const planItem = await window.api.dailyPlanAdd(getTodayKey(), todoId)
    await loadTodos()
    showToast('今日の計画に追加しました')
    return planItem
  }, [loadTodos, showToast])

  const handleUpdateTodayPlanItem = useCallback(async (id: string, data: UpdateDailyPlanItemInput) => {
    await window.api.dailyPlanUpdate(id, data)
    await loadTodos()
  }, [loadTodos])

  const handleShiftTodayPlanItem = useCallback(async (id: string, deltaMinutes: number) => {
    await window.api.dailyPlanShift(id, deltaMinutes)
    await loadTodos()
  }, [loadTodos])

  const handleRemoveTodayPlanItem = useCallback(async (id: string) => {
    await window.api.dailyPlanDelete(id)
    await loadTodos()
    showToast('今日の計画から外しました')
  }, [loadTodos, showToast])

  const handleReorderTodayPlan = useCallback(async (orderedIds: string[]) => {
    await window.api.dailyPlanReorder(getTodayKey(), orderedIds)
    await loadTodos()
  }, [loadTodos])

  const applyTaskView = useCallback((view: SavedTaskView): void => {
    setSearchQuery(view.searchQuery)
    setSelectedCategoryId(view.categoryId)
    setSelectedAssigneeId(view.assigneeId)
    setShowArchived(view.showArchived)
    setSortField(view.sortField)
    setSortDir(view.sortDir)
  }, [])

  const refreshSelectedPlan = useCallback(async (): Promise<void> => {
    await loadSelectedPlan(planDate)
    if (planDate === getTodayKey()) await loadTodayPlan()
  }, [loadSelectedPlan, loadTodayPlan, planDate])

  // 計画タブからの追加は同じタスクを何度でも置けるようにする（詳細画面の「今日の計画に追加」は従来通り1件だけ）
  const handleSelectedPlanAdd = useCallback(async (todoId: string, options?: AddDailyPlanItemOptions): Promise<DailyPlanItem> => {
    const item = await window.api.dailyPlanAdd(planDate, todoId, { allowDuplicate: true, ...options })
    await refreshSelectedPlan()
    return item
  }, [planDate, refreshSelectedPlan])

  const handleSelectedPlanUpdate = useCallback(async (id: string, data: UpdateDailyPlanItemInput): Promise<void> => {
    await window.api.dailyPlanUpdate(id, data)
    await refreshSelectedPlan()
  }, [refreshSelectedPlan])

  const handleSelectedPlanShift = useCallback(async (id: string, deltaMinutes: number): Promise<void> => {
    await window.api.dailyPlanShift(id, deltaMinutes)
    await refreshSelectedPlan()
  }, [refreshSelectedPlan])

  const handleSelectedPlanShiftFollowing = useCallback(async (id: string, deltaMinutes: number): Promise<void> => {
    const anchor = selectedPlanItems.find((item) => item.id === id)
    if (!anchor?.scheduled_start) return

    const targets = selectedPlanItems.filter((item) => (
      item.scheduled_start != null && item.scheduled_start >= anchor.scheduled_start!
    ))
    await Promise.all(targets.map((item) => window.api.dailyPlanShift(item.id, deltaMinutes)))
    await refreshSelectedPlan()
    showToast(`${targets.length}件の予定を${Math.abs(deltaMinutes)}分${deltaMinutes < 0 ? '早めました' : '遅らせました'}`)
  }, [refreshSelectedPlan, selectedPlanItems, showToast])

  const handleSelectedPlanDelete = useCallback(async (id: string): Promise<void> => {
    await window.api.dailyPlanDelete(id)
    await refreshSelectedPlan()
  }, [refreshSelectedPlan])

  const handleSelectedPlanReorder = useCallback(async (orderedIds: string[]): Promise<void> => {
    await window.api.dailyPlanReorder(planDate, orderedIds)
    await refreshSelectedPlan()
  }, [planDate, refreshSelectedPlan])

  const handleCarryOverPlan = useCallback(async (): Promise<void> => {
    const previous = new Date(`${planDate}T00:00:00`)
    previous.setDate(previous.getDate() - 1)
    const previousKey = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`
    const previousItems = await window.api.dailyPlanGetByDate(previousKey)
    const visiblePreviousItems = scopeLens === 'personal'
      ? previousItems
      : previousItems.filter((item) => item.category_id == null || !privateCategoryIds.has(item.category_id))
    // 同じタスクの複数配置に対応するため、タスク単位ではなく「タスク×開始時刻」単位で重複を判定する
    const planKey = (item: DailyPlanItem): string => `${item.todo_id}|${item.scheduled_start ?? ''}`
    const existingKeys = new Set(lensSelectedPlanItems.map(planKey))
    const carry = visiblePreviousItems.filter((item) => item.status !== 'done' && item.status !== 'on_hold' && !existingKeys.has(planKey(item)))
    for (const item of carry) {
      await window.api.dailyPlanAdd(planDate, item.todo_id, {
        allowDuplicate: true,
        scheduled_start: item.scheduled_start,
        estimated_minutes: item.estimated_minutes,
        lane: item.lane
      })
    }
    await refreshSelectedPlan()
    showToast(carry.length > 0 ? `${carry.length}件を前日から繰り越しました` : '繰り越す未完了タスクはありません')
  }, [lensSelectedPlanItems, planDate, privateCategoryIds, refreshSelectedPlan, scopeLens, showToast])

  const standaloneSortOptions: { key: SortField; label: string }[] = [
    { key: 'sort_order', label: '手動' },
    { key: 'created_at', label: '作成日' },
    { key: 'updated_at', label: '更新日' },
    { key: 'priority', label: '優先度' },
    { key: 'progress', label: '進捗' },
    { key: 'due_date', label: '期限' },
    { key: 'title', label: 'タイトル' }
  ]

  // タスク一覧の絞り込みはガントやカンバンにも効くので、一覧を見ていなくても分かるよう各画面の見出しの横に出す。
  // 報告タブは自前の担当絞り込みを使うので、一覧の担当絞り込みは出さない（効いていない）。
  // 詳細・進捗・記録・チームの画面には一覧の絞り込みが効かないので出さない。
  // 絞り込みが変わったときだけ作り直す（毎回作るとガントなどが描き直される）
  const { listFilters, categoryAndSearchFilters } = useMemo(() => {
    const assigneeFilterLabel = selectedAssigneeId === null
      ? null
      : selectedAssigneeId === ''
        ? '未割り当て'
        : selectedAssigneeId === currentUser?.id
          ? '自分'
          : users.find((user) => user.id === selectedAssigneeId)?.display_name ?? '不明'
    const categoryAndSearchChips: ListFilterChip[] = [
      ...(selectedCategoryId ? [{ key: 'category', label: `カテゴリ: ${categories.find((item) => item.id === selectedCategoryId)?.name ?? '不明'}`, clear: () => setSelectedCategoryId(null) }] : []),
      ...(q ? [{ key: 'search', label: `検索: ${searchQuery.trim()}`, clear: () => setSearchQuery('') }] : [])
    ]
    const listFilterChips: ListFilterChip[] = [
      ...(assigneeFilterLabel ? [{ key: 'assignee', label: `担当: ${assigneeFilterLabel}`, clear: () => setSelectedAssigneeId(null) }] : []),
      ...categoryAndSearchChips
    ]
    return {
      // 絞り込みがないときは null（見出しの横に何も出さない）
      listFilters: listFilterChips.length > 0 ? <ListFilterChips chips={listFilterChips} /> : null,
      categoryAndSearchFilters: categoryAndSearchChips.length > 0 ? <ListFilterChips chips={categoryAndSearchChips} /> : null
    }
  }, [categories, currentUser?.id, q, searchQuery, selectedAssigneeId, selectedCategoryId, users])

  if (isFirstLaunch === null) {
    return <div style={{ height: '100vh', background: 'var(--c-0a0f1a)' }} />
  }

  if (isFirstLaunch) {
    return <ViewBoundary fallback={<div style={{ height: '100vh', background: 'var(--c-0a0f1a)' }} />}><SetupWizardModal onComplete={handleSetupComplete} /></ViewBoundary>
  }

  if (isStandaloneGanttWindow) {
    return (
      <div style={{ height: '100vh', overflow: 'hidden', background: 'var(--slate-900)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flexShrink: 0, padding: '10px 12px', borderBottom: '1px solid var(--slate-800)', background: 'var(--c-0b1220)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="タスク検索"
            style={{ minWidth: 200, flex: '1 1 220px', padding: '7px 9px', background: 'var(--slate-900)', border: `1px solid ${searchQuery ? 'var(--indigo-500)' : 'var(--slate-700)'}`, borderRadius: 7, color: 'var(--slate-200)', fontSize: '0.82rem', outline: 'none' }}
          />
          {multiUser && (
            <select
              value={selectedAssigneeId === null ? '__all__' : selectedAssigneeId === '' ? '__none__' : selectedAssigneeId}
              onChange={(e) => {
                const v = e.target.value
                setSelectedAssigneeId(v === '__all__' ? null : v === '__none__' ? '' : v)
              }}
              style={{ padding: '7px 9px', background: 'var(--slate-900)', border: `1px solid ${selectedAssigneeId !== null ? 'var(--indigo-500)' : 'var(--slate-700)'}`, borderRadius: 7, color: 'var(--slate-200)', fontSize: '0.82rem', outline: 'none' }}
            >
              <option value="__all__">全員</option>
              <option value="__none__">未割り当て</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name}{user.is_active ? '' : ' (無効)'}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {standaloneSortOptions.map(({ key, label }) => {
              const active = sortField === key
              return (
                <button
                  key={key}
                  onClick={() => {
                    if (key === 'sort_order') {
                      setSortField('sort_order')
                      return
                    }
                    if (active) setSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')
                    else {
                      setSortField(key)
                      setSortDir(defaultSortDir(key))
                    }
                  }}
                  title={sortDirTitle(key, active ? sortDir : defaultSortDir(key), active)}
                  aria-pressed={active}
                  style={{ padding: '6px 9px', borderRadius: 999, border: `1px solid ${active ? 'var(--blue-500)' : 'var(--slate-700)'}`, background: active ? 'var(--blue-950)' : 'var(--gray-900)', color: active ? 'var(--blue-100)' : 'var(--slate-400)', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 700 }}
                >
                  {label}{active && key !== 'sort_order' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              )
            })}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <GanttView
            categories={categories}
            users={users}
            todos={filteredTodos}
            onSelectTodo={(id) => {
              void window.api.windowOpenTodo(id)
            }}
            onUpdateTodo={handleUpdate}
            onReorderTodos={handleReorder}
            groupByCategory={selectedCategoryId === null}
            textScale={(Number.parseFloat(fontScale) || 100) / 100}
            onShowToast={showToast}
            standalone
          />
        </div>
        <Toast toasts={toasts} onRemove={removeToast} />
      </div>
    )
  }

  if (isStandaloneTaskReportWindow) {
    return <ViewBoundary><TaskReportWindow /></ViewBoundary>
  }


  const isManualSort = sortField === 'sort_order'
  // ガントの画面だけ、パネルの開閉をほかの画面とは別に持つ
  const isGanttView = activeView === 'gantt'
  const categoryPaneVisible = isGanttView ? ganttPanes.category : showCategoryPane && (!autoHideCategoryPane || openedWhileNarrow.category)
  const taskPaneVisible = isGanttView ? ganttPanes.task : showTaskPane && (!autoHideTaskPane || openedWhileNarrow.task)
  const planRailVisible = isGanttView ? ganttPanes.side : showPlanRail && (!autoHideSidePanel || openedWhileNarrow.side)
  const togglePane = (key: keyof PaneVisibility): void => {
    if (isGanttView) {
      const next = { ...ganttPanes, [key]: !ganttPanes[key] }
      setGanttPanes(next)
      // 開いた結果、ガントが狭くなりすぎたら知らせる（狭い窓では日付が数日分しか見えなくなり、気づきにくい）
      const chartWidth = viewportWidth
        - (next.category ? paneWidths.category : 0)
        - (next.task ? paneWidths.list : 0)
        - (next.side ? paneWidths.side : 0)
      if (next[key] && chartWidth < GANTT_COMFORT_WIDTH) {
        showToast('ガントの幅が狭くなり、日付が数日分しか見えません', 'info', {
          label: 'ほかのパネルを畳む',
          run: () => setGanttPanes({ category: false, task: false, side: false, [key]: true })
        })
      }
      return
    }
    // 狭くて自動で隠しているパネルは、設定を変えずにその幅のあいだだけ開け閉めする
    const visible = key === 'category' ? categoryPaneVisible : key === 'task' ? taskPaneVisible : planRailVisible
    const autoHidden = key === 'category' ? autoHideCategoryPane : key === 'task' ? autoHideTaskPane : autoHideSidePanel
    const setPreference = key === 'category' ? setShowCategoryPane : key === 'task' ? setShowTaskPane : setShowPlanRail
    if (visible) {
      if (autoHidden) setOpenedWhileNarrow((previous) => ({ ...previous, [key]: false }))
      else setPreference(false)
      return
    }
    setPreference(true)
    if (autoHidden) setOpenedWhileNarrow((previous) => ({ ...previous, [key]: true }))
  }
  const showRightPlanRail = planRailVisible && !SIDE_PANEL_VIEWS_WITHOUT_RAIL.includes(activeView)
  // Ctrl+K のパレットの項目（画面・操作）
  const paletteViews: { view: CenterView; label: string; keywords: string }[] = [
    { view: 'overview', label: '概要', keywords: 'overview ダッシュボード' },
    { view: 'gantt', label: 'ガント', keywords: 'gantt チャート 日程' },
    { view: 'kanban', label: 'カンバン', keywords: 'kanban ボード' },
    ...(multiUser ? [{ view: 'team' as const, label: 'チーム', keywords: 'team メンバー 計測中' }] : []),
    { view: 'progress', label: '進捗', keywords: 'progress タイムライン 進捗ログ' },
    { view: 'report', label: '報告', keywords: 'report 定例' },
    { view: 'plan', label: '計画', keywords: 'plan 予定 時間割' },
    { view: 'todo', label: 'ToDo', keywords: 'todo リスト チェック' },
    { view: 'log', label: '記録', keywords: 'log 作業時間' }
  ]
  // いちばん新しい「元に戻す」などの操作つきの知らせ（キーボードで知らせまで行かなくても、Ctrl+K から押せるように）
  const latestActionToast = [...toasts].reverse().find((toast) => toast.actionLabel && toast.onAction)
  const paletteCommands: PaletteCommand[] = [
    ...(latestActionToast ? [{
      key: `toast:${latestActionToast.id}`, group: '操作' as const,
      label: `${latestActionToast.actionLabel}（${latestActionToast.message}）`,
      keywords: '元に戻す 取り消し undo',
      run: () => { latestActionToast.onAction?.(); removeToast(latestActionToast.id) }
    }] : []),
    // 画面を開いたら、フォーカスもその画面（本文）へ移す（パレットを開く前の場所に戻ると、続けて Tab で新しい画面に入れない）
    ...paletteViews.map(({ view, label, keywords }) => ({
      key: `view:${view}`, group: '画面' as const, label: `${label}を開く`, keywords,
      run: () => {
        toggleCenterView(view)
        window.setTimeout(() => document.getElementById('hakobi-main')?.focus({ preventScroll: true }), 30)
      }
    })),
    { key: 'add', group: '操作', label: 'タスクを追加', keywords: 'new add 新規', run: () => openQuickAdd() },
    // 開いているタスクへの操作（キーボードだけで「開く→進捗ログ→完了」まで進められるように）
    ...(selectedTodo && selectedTodo.status !== 'archived' ? [
      {
        key: 'task-focus', group: '操作' as const, label: `「${selectedTodo.title}」の詳細へ移る`, keywords: '詳細 移動 フォーカス',
        run: () => {
          if (activeView !== 'detail' && !(activeView === 'gantt' && ganttSidePanelMode === 'detail')) setActiveView('detail')
          window.setTimeout(() => window.dispatchEvent(new CustomEvent(FOCUS_TASK_DETAIL_EVENT)), 30)
        }
      },
      {
        key: 'task-log', group: '操作' as const, label: `「${selectedTodo.title}」の進捗ログを書く`, keywords: '進捗 ログ 報告 書く',
        run: () => {
          if (activeView !== 'detail' && !(activeView === 'gantt' && ganttSidePanelMode === 'detail')) setActiveView('detail')
          window.setTimeout(() => window.dispatchEvent(new CustomEvent(FOCUS_PROGRESS_LOG_EVENT)), 0)
        }
      },
      {
        key: 'task-done', group: '操作' as const,
        label: selectedTodo.status === 'done' ? `「${selectedTodo.title}」の完了を取り消す` : `「${selectedTodo.title}」を完了にする`,
        keywords: '完了 done 終わり',
        run: () => void handleToggleDone(selectedTodo)
      },
      {
        key: 'task-timer', group: '操作' as const,
        label: runningTodoId === selectedTodo.id ? `「${selectedTodo.title}」の計測を止める` : `「${selectedTodo.title}」の計測を始める`,
        keywords: '計測 タイマー timer 開始 停止',
        run: () => { if (runningTodoId === selectedTodo.id) stopFromToolbar(); else void start(selectedTodo.id) }
      },
      ...(selectedTodo.due_date && selectedTodo.status !== 'done' ? [{
        key: 'task-due-1', group: '操作' as const, label: `「${selectedTodo.title}」の期限を1日延ばす（${formatShortDate(selectedTodo.due_date)} → ${formatShortDate(shiftDateKey(selectedTodo.due_date, 1))}）`,
        keywords: '期限 延期 延ばす due',
        run: () => {
          const id = selectedTodo.id
          const before = selectedTodo.due_date!.slice(0, 10)
          const next = shiftDateKey(before, 1)
          void handleUpdate(id, { due_date: next }).then(
            () => showToast(`期限を${formatShortDate(next)}にしました`, 'success', {
              label: '元に戻す',
              run: () => void handleUpdate(id, { due_date: before }).then(() => showToast('期限を元に戻しました'), (error) => showToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error'))
            }),
            (error) => showToast(error instanceof Error ? error.message : '期限を変えられませんでした', 'error')
          )
        }
      }] : [])
    ] : []),
    ...(currentUser ? [{ key: 'mine', group: '操作' as const, label: '自分の担当だけを表示', keywords: '担当 絞り込み 自分', run: () => setSelectedAssigneeId(currentUser.id) }] : []),
    { key: 'clear-filters', group: '操作', label: '一覧の絞り込みを解除', keywords: '絞り込み 解除 全員', run: clearListFilters },
    { key: 'pane-category', group: '操作', label: categoryPaneVisible ? 'カテゴリ一覧を隠す' : 'カテゴリ一覧を表示', keywords: 'パネル 表示', run: () => togglePane('category') },
    { key: 'pane-task', group: '操作', label: taskPaneVisible ? 'タスク一覧を隠す' : 'タスク一覧を表示', keywords: 'パネル 表示', run: () => togglePane('task') },
    { key: 'pane-today', group: '操作', label: planRailVisible ? '今日の予定を隠す' : '今日の予定を表示', keywords: 'パネル 表示', run: () => togglePane('side') },
    { key: 'archived', group: '操作', label: showArchived ? 'アーカイブしたタスクを隠す' : 'アーカイブしたタスクも表示', keywords: 'アーカイブ', run: () => setShowArchived((previous) => !previous) },
    ...(currentUser && multiUser ? [{ key: 'notifications', group: '操作' as const, label: '通知を開く', keywords: 'notification', run: () => openNotifications() }] : []),
    { key: 'report', group: '操作', label: '進捗レポートを開く', keywords: 'レポート 週報', run: () => { if (isAdmin && multiUser) setShowProgressReport(true); else setShowMySummary(true) } },
    { key: 'settings', group: '操作', label: '設定を開く', keywords: 'settings テーマ フォント', run: () => setShowSettings(true) },
    { key: 'getting-started', group: '操作', label: '使い方（はじめに）を開く', keywords: 'help ヘルプ 使い方 はじめに', run: () => setShowGettingStarted(true) }
  ]
  // 右の「今日の予定」の上に出す「今日のToDo」（ToDoリストを使う人だけ）
  const todayTodoCard = usesTodoLists ? (
    <TodayTodoCard
      groups={myTodayGroups}
      pendingIds={pendingListItemIds}
      storageKey={`todayTodo.collapsed:${listUserId ?? 'local'}`}
      onToggle={handleToggleListItem}
      onOpenList={openTodoDetail}
      onOpenTab={() => toggleCenterView('todo')}
    />
  ) : null
  const showGanttSidePanel = activeView === 'gantt' && (ganttSidePanelMode === 'detail' || ganttPanes.side)
  const showAuxiliaryPanel = activeView === 'gantt' ? showGanttSidePanel : showRightPlanRail
  const SORT_FIELDS: { key: SortField; label: string }[] = [
    { key: 'sort_order', label: '手動' },
    { key: 'created_at', label: '作成日' },
    { key: 'updated_at', label: '更新日' },
    { key: 'priority', label: '優先度' },
    { key: 'progress', label: '進捗' },
    { key: 'due_date', label: '期限' },
    { key: 'title', label: 'タイトル' }
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {serverDisconnected && (
        <div role="status" style={{ flexShrink: 0, padding: '6px 16px', background: 'var(--amber-900)', borderBottom: '1px solid var(--amber-700)', color: 'var(--amber-100)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden="true">⚠</span>
          サーバーに再接続しています… つながるまで、変更は保存できません。
        </div>
      )}
      <SkipLinks
        showTaskList={taskPaneVisible}
        showSidePanel={showAuxiliaryPanel}
        sidePanelLabel={activeView === 'gantt' && ganttSidePanelMode === 'detail' ? 'タスクの詳細' : '今日の予定'}
      />
      <Toolbar
        isTimerRunning={isRunning}
        runningTask={runningTodo ? { title: runningTodo.title, startTime: timerStartTime } : null}
        onOpenRunningTask={runningTodoId ? () => openTodoDetail(runningTodoId) : undefined}
        onStopTimer={stopFromToolbar}
        onOpenQuickAdd={() => openQuickAdd()}
        onOpenGettingStarted={() => setShowGettingStarted(true)}
        onOpenProgressReport={() => {
          if (isAdmin && multiUser) setShowProgressReport(true)
          else setShowMySummary(true)
        }}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((prev) => !prev)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenCommandPalette={() => setShowCommandPalette(true)}
        activeView={activeView}
        scopeLens={scopeLens}
        onSetScopeLens={setScopeLens}
        showScopeLens={privateCategoryIds.size > 0}
        showPlanRail={planRailVisible}
        showCategoryPane={categoryPaneVisible}
        showTaskPane={taskPaneVisible}
        showTeamButton={multiUser}
        progressUnseenCount={progressUnseenCount}
        todoRemainingCount={todoRemainingCount}
        onToggleTodoView={() => toggleCenterView('todo')}
        currentUser={currentUser}
        notificationUnreadCount={notificationUnreadCount}
        onOpenNotifications={multiUser ? openNotifications : undefined}
        onLogout={multiUser ? () => void window.api.authLogout() : undefined}
        onToggleLogView={() => toggleCenterView('log')}
        onToggleOverviewView={() => toggleCenterView('overview')}
        onToggleProgressView={() => toggleCenterView('progress')}
        onToggleReportView={() => toggleCenterView('report')}
        onTogglePlanView={() => toggleCenterView('plan')}
        onToggleGanttView={() => toggleCenterView('gantt')}
        onToggleKanbanView={() => toggleCenterView('kanban')}
        onToggleTeamView={() => toggleCenterView('team')}
        onTogglePlanRail={() => togglePane('side')}
        onToggleCategoryPane={() => togglePane('category')}
        onToggleTaskPane={() => togglePane('task')}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <nav aria-label="カテゴリ" style={{ width: paneWidths.category, flexShrink: 0, background: 'var(--c-0a0f1a)', borderRight: '1px solid var(--slate-800)', overflow: 'hidden', display: categoryPaneVisible ? 'block' : 'none' }}>
          <CategoryList
            categories={categories}
            selectedId={selectedCategoryId}
            onSelect={setSelectedCategoryId}
            onAdd={handleCategoryAdd}
            onUpdate={handleCategoryUpdate}
            onDelete={handleCategoryDelete}
            onReorder={handleCategoryReorder}
          />
        </nav>

        <div
          onPointerDown={(event) => beginResize('category', paneWidths.category, event)}
          style={{ ...resizeHandleStyle, display: categoryPaneVisible ? 'block' : 'none' }}
        />

        <section id="hakobi-task-list" data-focus-region tabIndex={-1} aria-label="タスク一覧" style={{ width: paneWidths.list, flexShrink: 0, background: 'var(--c-0d1525)', borderRight: '1px solid var(--slate-800)', overflow: 'hidden', display: taskPaneVisible ? 'flex' : 'none', flexDirection: 'column', outline: 'none' }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--slate-800)' }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="タスク名・メモ・カテゴリで検索..."
              style={{
                width: '100%',
                padding: '5px 8px',
                background: 'var(--slate-900)',
                border: `1px solid ${searchQuery ? 'var(--indigo-500)' : 'var(--slate-800)'}`,
                borderRadius: 6,
                color: 'var(--slate-200)',
                fontSize: '0.8rem',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
            {multiUser && (
              <select
                value={selectedAssigneeId === null ? '__all__' : selectedAssigneeId === '' ? '__none__' : selectedAssigneeId}
                onChange={(e) => {
                  const v = e.target.value
                  setSelectedAssigneeId(v === '__all__' ? null : v === '__none__' ? '' : v)
                }}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '5px 8px',
                  background: 'var(--slate-900)',
                  border: `1px solid ${selectedAssigneeId !== null ? 'var(--indigo-500)' : 'var(--slate-800)'}`,
                  borderRadius: 6,
                  color: selectedAssigneeId !== null ? 'var(--slate-200)' : 'var(--slate-400)',
                  fontSize: '0.8rem',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              >
                <option value="__all__">担当: 全員</option>
                {currentUser && <option value={currentUser.id}>担当: 自分（{currentUser.display_name}）</option>}
                <option value="__none__">担当: 未割り当て</option>
                {users.filter((user) => user.id !== currentUser?.id).map((user) => (
                  <option key={user.id} value={user.id}>
                    担当: {user.display_name}{user.is_active ? '' : '（無効）'}
                  </option>
                ))}
              </select>
            )}
            {savedTaskViews.length > 0 && <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
              <select defaultValue="" onChange={(event) => { const view = savedTaskViews.find((item) => item.name === event.target.value); if (view) applyTaskView(view); event.target.value = '' }} style={{ flex: 1, minWidth: 100, padding: '4px 6px', background: 'var(--slate-900)', color: 'var(--slate-400)', border: '1px solid var(--slate-700)', borderRadius: 6 }}><option value="">保存ビュー</option>{savedTaskViews.map((view) => <option key={view.name} value={view.name}>{view.name}</option>)}</select>
            </div>}
            {(searchQuery || selectedCategoryId || showArchived) && (
              <div aria-label="適用中の絞り込み" style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                {searchQuery && <button onClick={() => setSearchQuery('')} title="検索条件を解除" style={filterChipStyle}>検索: {searchQuery} ×</button>}
                {selectedCategoryId && <button onClick={() => setSelectedCategoryId(null)} title="カテゴリ条件を解除" style={filterChipStyle}>カテゴリ: {categories.find((item) => item.id === selectedCategoryId)?.name ?? '不明'} ×</button>}
                {showArchived && <button onClick={() => setShowArchived(false)} title="アーカイブ表示を解除" style={filterChipStyle}>アーカイブ ×</button>}
              </div>
            )}
          </div>

          <div style={{ padding: '5px 8px', borderBottom: '1px solid var(--slate-800)', display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            {SORT_FIELDS.map(({ key, label }) => {
              const active = sortField === key

              return (
                <button
                  key={key}
                  onClick={() => {
                    if (key === 'sort_order') {
                      setSortField('sort_order')
                      return
                    }

                    if (active) setSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')
                    else {
                      setSortField(key)
                      setSortDir(defaultSortDir(key))
                    }
                  }}
                  title={sortDirTitle(key, active ? sortDir : defaultSortDir(key), active)}
                  aria-pressed={active}
                  style={{
                    fontSize: '0.75rem',
                    padding: '2px 7px',
                    borderRadius: 99,
                    background: active ? 'color-mix(in srgb, var(--indigo-500) 12.5%, transparent)' : 'transparent',
                    border: `1px solid ${active ? 'var(--indigo-500)' : 'var(--slate-700)'}`,
                    color: active ? 'var(--indigo-300)' : 'var(--slate-400)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {label}
                  {active && key !== 'sort_order' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              )
            })}
          </div>

          <div style={{ flex: 1, overflow: 'hidden' }}>
            <TodoList
              todos={filteredTodos}
              selectedId={selectedTodoId}
              runningTodoId={runningTodoId}
              timerStartTime={timerStartTime}
              isManualSort={isManualSort}
              searchQuery={q}
              hasOtherFilters={selectedAssigneeId !== null || selectedCategoryId !== null || hiddenPrivateTodoIds.size > 0}
              // 「まだタスクがありません」は、集計外を隠しているだけのときには出さない（隠す前のタスクで判定する）
              hasAnyTodos={todos.length > 0}
              dataLoading={!initialDataLoaded}
              onClearSearch={() => setSearchQuery('')}
              onClearFilters={clearListFilters}
              onAddTodo={() => openQuickAdd()}
              onSelect={openTodoDetail}
              onToggleDone={handleToggleDone}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onDelete={handleDelete}
              onReorder={handleReorder}
              onStartTimer={start}
              onStopTimer={stop}
              checklistSummaries={checklistSummaries}
              listItemsByTodo={listItemsByTodo}
              pendingItemIds={pendingListItemIds}
              onToggleListItem={handleToggleListItem}
            />
          </div>
        </section>

        <div
          onPointerDown={(event) => beginResize('list', paneWidths.list, event)}
          style={{ ...resizeHandleStyle, display: taskPaneVisible ? 'block' : 'none' }}
        />

        <main id="hakobi-main" data-focus-region tabIndex={-1} aria-label={CENTER_VIEW_LABELS[activeView]} style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: 'var(--slate-900)', outline: 'none' }}>
          <ViewBoundary key={activeView}>
          {initialLoadError ? (
            <div role="alert" style={{ margin: 24, padding: 20, border: '1px solid var(--red-500)', borderRadius: 12, background: 'var(--red-950)', color: 'var(--red-200)' }}>
              <strong>データを読み込めませんでした</strong>
              <div style={{ marginTop: 6, fontSize: '0.82rem' }}>{initialLoadError}</div>
              <button onClick={() => void loadInitialData().catch((error) => setInitialLoadError(error instanceof Error ? error.message : '再読み込みできませんでした'))} style={{ marginTop: 12, padding: '7px 12px', borderRadius: 7, border: '1px solid var(--red-500)', background: 'var(--red-900)', color: 'var(--white)', cursor: 'pointer' }}>再試行</button>
            </div>
          ) : activeView === 'overview' ? (
            <OverviewDashboard
              todos={filteredTodos}
              users={users}
              dataRevision={overviewDataRevision}
              selectedAssigneeId={selectedAssigneeId}
              includePrivate={scopeLens === 'personal'}
              runningTodoId={runningTodoId}
              timerStartTime={timerStartTime}
              listFilters={listFilters}
              onSelectTodo={openTodoDetail}
            />
          ) : activeView === 'gantt' ? (
            <GanttView
              categories={categories}
              users={users}
              todos={filteredTodos}
              onSelectTodo={selectTodoStable}
              onUpdateTodo={handleUpdate}
              onReorderTodos={handleReorder}
              focusTodoId={showGanttSidePanel && ganttSidePanelMode === 'detail' ? selectedTodoId : null}
              onOpenSeparateWindow={handleOpenGanttWindow}
              onAddTodo={openQuickAdd}
              listFilters={listFilters}
              hasAnyTodos={todos.length > 0}
              dataLoading={!initialDataLoaded}
              groupByCategory={selectedCategoryId === null}
              textScale={(Number.parseFloat(fontScale) || 100) / 100}
              onShowToast={showToast}
            />
          ) : activeView === 'kanban' ? (
            <KanbanView
              todos={filteredTodos}
              categories={categories}
              runningTodoId={runningTodoId}
              listFilters={listFilters}
              onSelectTodo={openTodoDetail}
              onChangeStatus={handleKanbanMove}
              onCreateInColumn={handleKanbanCreate}
              checklistSummaries={checklistSummaries}
            />
          ) : activeView === 'plan' && selectedPlanLoading ? (
            <div role="status" style={{ padding: 24, color: 'var(--slate-400)' }}>計画を読み込んでいます…</div>
          ) : activeView === 'plan' && selectedPlanError ? (
            <div role="alert" style={{ margin: 24, padding: 20, border: '1px solid var(--red-500)', borderRadius: 12, background: 'var(--red-950)', color: 'var(--red-200)' }}>
              <strong>{planDate} の計画を読み込めませんでした</strong>
              <div style={{ marginTop: 6, fontSize: '0.82rem' }}>{selectedPlanError}</div>
              <button onClick={() => void loadSelectedPlan(planDate).catch(() => undefined)} style={{ marginTop: 12, padding: '7px 12px', borderRadius: 7, border: '1px solid var(--red-500)', background: 'var(--red-900)', color: 'var(--white)', cursor: 'pointer' }}>再試行</button>
            </div>
          ) : activeView === 'plan' ? (
            <PlanView
              date={planDate}
              planItems={lensSelectedPlanItems}
              todos={filteredTodos}
              runningTodoId={runningTodoId}
              onSelectTodo={openTodoDetail}
              onAddTodo={handleSelectedPlanAdd}
              onRemoveItem={handleSelectedPlanDelete}
              onUpdateItem={handleSelectedPlanUpdate}
              onShiftItem={handleSelectedPlanShift}
              onShiftFollowing={handleSelectedPlanShiftFollowing}
              onReorder={handleSelectedPlanReorder}
              onDateChange={setPlanDate}
              onCarryOver={handleCarryOverPlan}
              listFilters={listFilters}
              checklistSummaries={usesTodoLists ? checklistSummaries : undefined}
            />
          ) : activeView === 'log' ? (
            <WorkLogSummary hiddenTodoIds={hiddenPrivateTodoIds} />
          ) : activeView === 'progress' ? (
            <ProgressTimeline
              // 投稿先の選択肢。タイムライン自体はタスク一覧の絞り込みと関係ないので、絞り込み前のタスクから選べるようにする
              todos={sortedLensTodos}
              users={users}
              currentUser={currentUser}
              focusTarget={progressTimelineFocus}
              onSelectTodo={openTodoDetail}
              onShowToast={showToast}
              hiddenTodoIds={hiddenPrivateTodoIds}
            />
          ) : activeView === 'report' ? (
            <ReportView
              todos={reportTodos}
              listFilters={categoryAndSearchFilters}
              subTasks={allSubTasks}
              categories={categories}
              users={users}
              currentUser={currentUser}
              onSelectTodo={openTodoDetail}
              onUpdateTodo={handleUpdate}
              onUpdateSubTask={handleUpdateSubTask}
              onCreateSubTask={handleCreateSubTask}
              onShowToast={showToast}
              onCreateTodo={handleAdd}
            />
          ) : activeView === 'todo' ? (
            <TodoListsView
              todos={sortedLensTodos}
              itemsByTodo={listItemsByTodo}
              users={users}
              currentUser={currentUser}
              pendingIds={pendingListItemIds}
              onToggleItem={handleToggleListItem}
              onItemsChange={handleListItemsChange}
              onSelectTodo={openTodoDetail}
              onCreateList={handleCreateList}
              onCreateListWithDetails={() => openQuickAdd({ listMode: true })}
              onShowToast={showToast}
            />
          ) : activeView === 'team' ? (
            <TeamDashboard
              todos={lensTodos}
              onSelectTodo={openTodoDetail}
              onSelectMember={(userId) => {
                setSelectedAssigneeId(userId)
                toggleCenterView('gantt')
                showToast(`${users.find((user) => user.id === userId)?.display_name ?? 'メンバー'}さんのタスクに絞り込みました。見出しの横のチップで解除できます`)
              }}
              includePrivate={scopeLens === 'personal'}
            />
          ) : (
            <TodoDetail
              key={`${currentUser?.id ?? 'local'}:${selectedTodo?.id ?? 'none'}`}
              todo={selectedTodo}
              allTodos={lensTodos}
              categories={categories}
              users={users}
              currentUser={currentUser}
              todayPlanItems={lensPlanItems}
              runningTodoId={runningTodoId}
              timerStartTime={timerStartTime}
              onUpdate={handleUpdate}
              onStartTimer={start}
              onStopTimer={stop}
              onAddToTodayPlan={handleAddToTodayPlan}
              onShowToast={showToast}
              onDirtyChange={setDetailDirty}
              returnTo={detailReturnView ? { label: CENTER_VIEW_LABELS[detailReturnView], onReturn: () => toggleCenterView(detailReturnView) } : null}
            />
          )}
          </ViewBoundary>
        </main>

        {showAuxiliaryPanel && (
          <>
            <div
              onPointerDown={(event) => beginResize('side', paneWidths.side, event)}
              style={resizeHandleStyle}
            />

            <aside id="hakobi-side-panel" data-focus-region data-toast-avoid={activeView === 'gantt' && ganttSidePanelMode === 'detail' ? '' : undefined} tabIndex={-1} aria-label={activeView === 'gantt' && ganttSidePanelMode === 'detail' ? 'タスクの詳細' : '今日の予定'} style={{ width: paneWidths.side, flexShrink: 0, borderLeft: '1px solid var(--slate-800)', background: 'var(--c-0b1220)', overflow: 'hidden', display: 'flex', flexDirection: 'column', outline: 'none' }}>
              {activeView === 'gantt' ? (
                <>
                  <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--slate-800)', background: 'var(--c-0b1220)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setGanttSidePanelMode('detail')}
                        style={sideTabButtonStyle(ganttSidePanelMode === 'detail')}
                      >
                        詳細
                      </button>
                      <button
                        onClick={() => {
                          if (detailDirty && !window.confirm('未保存の変更があります。今日の予定へ移動しますか？')) return
                          setGanttSidePanelMode('today')
                          if (!ganttPanes.side) setGanttPanes((previous) => ({ ...previous, side: true }))
                        }}
                        style={sideTabButtonStyle(ganttSidePanelMode === 'today')}
                      >
                        今日
                      </button>
                    </div>

                    <button onClick={hideGanttSidePanel} style={auxButtonStyle(true)}>
                      隠す
                    </button>
                  </div>

                  <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    {ganttSidePanelMode === 'detail' ? (
                      <TodoDetail
                        key={`${currentUser?.id ?? 'local'}:${selectedTodo?.id ?? 'none'}`}
                        todo={selectedTodo}
                        allTodos={lensTodos}
                        categories={categories}
                        users={users}
                        currentUser={currentUser}
                        todayPlanItems={lensPlanItems}
                        runningTodoId={runningTodoId}
                        timerStartTime={timerStartTime}
                        onUpdate={handleUpdate}
                        onStartTimer={start}
                        onStopTimer={stop}
                        onAddToTodayPlan={handleAddToTodayPlan}
                        onShowToast={showToast}
                        onDirtyChange={setDetailDirty}
                      />
                    ) : (
                      <TodayFlowRail
                        date={getTodayKey()}
                        planItems={lensPlanItems}
                        runningTodoId={runningTodoId}
                        onSelectTodo={openTodoDetail}
                        onOpenPlan={() => toggleCenterView('plan')}
                        topSlot={todayTodoCard}
                      />
                    )}
                  </div>
                </>
              ) : (
                <TodayFlowRail
                  date={getTodayKey()}
                  planItems={lensPlanItems}
                  runningTodoId={runningTodoId}
                  onSelectTodo={openTodoDetail}
                  onOpenPlan={() => toggleCenterView('plan')}
                  topSlot={todayTodoCard}
                />
              )}
            </aside>
          </>
        )}
      </div>

      {showQuickAdd && (
        <QuickAddModal
          categories={categories}
          users={users}
          defaultCategoryId={quickAddDefaults?.categoryId !== undefined ? quickAddDefaults.categoryId : selectedCategoryId}
          defaultAssigneeId={quickAddDefaults?.assigneeId !== undefined ? quickAddDefaults.assigneeId : defaultNewTaskAssigneeId}
          defaultListMode={quickAddDefaults?.listMode ?? false}
          onAdd={handleAdd}
          onAdded={handleAdded}
          onClose={() => setShowQuickAdd(false)}
          onShowToast={showToast}
        />
      )}

      <Toast toasts={toasts} onRemove={removeToast} />

      {showCommandPalette && (
        <CommandPalette
          commands={paletteCommands}
          todos={lensTodos}
          onOpenTodo={(id) => {
            openTodoDetail(id)
            // パレットを閉じてフォーカスが元の場所に戻ったあとで、詳細の題名へ移す
            window.setTimeout(() => window.dispatchEvent(new CustomEvent(FOCUS_TASK_DETAIL_EVENT)), 30)
          }}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {showGettingStarted && (
        <ViewBoundary fallback={null} onDismiss={() => setShowGettingStarted(false)}>
          <GettingStartedModal
            multiUser={multiUser}
            onOpenReport={() => toggleCenterView('report')}
            onClose={() => setShowGettingStarted(false)}
          />
        </ViewBoundary>
      )}

      {showSettings && (
        <ViewBoundary fallback={null} onDismiss={() => setShowSettings(false)}>
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onShowToast={showToast}
          themeMode={themeMode}
          onThemeChange={handleThemeModeChange}
          fontFamily={fontFamily}
          onFontFamilyChange={handleFontFamilyChange}
          fontScale={fontScale}
          onFontScaleChange={handleFontScaleChange}
          canManageUsers={isAdmin}
          serverManaged={multiUser}
          onManageUsers={() => { setShowSettings(false); setShowUserManagement(true) }}
          onProgressReport={isAdmin ? () => { setShowSettings(false); setShowProgressReport(true) } : undefined}
          onDesktopImport={isAdmin && multiUser ? () => { setShowSettings(false); setShowDesktopImport(true) } : undefined}
          onMySummary={() => { setShowSettings(false); setShowMySummary(true) }}
          onExportClipboard={handleExportClipboard}
          onExportFile={handleExportFile}
        />
        </ViewBoundary>
      )}

      {showNotifications && currentUser && (
        <NotificationPanel
          notifications={notifications}
          unreadCount={notificationUnreadCount}
          onClose={() => setShowNotifications(false)}
          onSelect={(notification) => void handleSelectNotification(notification)}
          onMarkAllRead={() => void handleMarkAllNotificationsRead()}
          onShowToast={showToast}
        />
      )}

      {showUserManagement && currentUser && (
        <ViewBoundary fallback={null} onDismiss={() => setShowUserManagement(false)}>
        <UserManagementModal
          currentUserId={currentUser.id}
          onClose={() => setShowUserManagement(false)}
          onShowToast={showToast}
          onChanged={() => void loadUsers()}
        />
        </ViewBoundary>
      )}

      {showProgressReport && isAdmin && multiUser && (
        <ViewBoundary fallback={null} onDismiss={() => setShowProgressReport(false)}>
        <ProgressReportModal
          users={users}
          includePrivate={scopeLens === 'personal'}
          visibleTodos={filteredTodos}
          allTodos={lensTodos}
          onClose={() => setShowProgressReport(false)}
          onShowToast={showToast}
        />
        </ViewBoundary>
      )}

      {showDesktopImport && isAdmin && multiUser && (
        <ViewBoundary fallback={null} onDismiss={() => setShowDesktopImport(false)}>
        <DesktopImportModal
          users={users}
          onClose={() => setShowDesktopImport(false)}
          onShowToast={showToast}
        />
        </ViewBoundary>
      )}

      {showMySummary && (
        <ViewBoundary fallback={null} onDismiss={() => setShowMySummary(false)}>
        <ProgressReportModal
          users={users}
          selfOnly
          currentUser={currentUser}
          includePrivate={scopeLens === 'personal'}
          visibleTodos={filteredTodos}
          allTodos={lensTodos}
          onClose={() => setShowMySummary(false)}
          onShowToast={showToast}
        />
        </ViewBoundary>
      )}
    </div>
  )
}

const resizeHandleStyle: React.CSSProperties = {
  width: 6,
  flexShrink: 0,
  cursor: 'col-resize',
  background: 'linear-gradient(to right, transparent 0, transparent 2px, var(--c-162033) 2px, var(--c-162033) 4px, transparent 4px)',
  opacity: 0.8
}

const filterChipStyle: React.CSSProperties = {
  maxWidth: '100%', padding: '2px 6px', borderRadius: 999, border: '1px solid var(--indigo-600)',
  background: 'var(--indigo-950)', color: 'var(--indigo-200)', cursor: 'pointer', fontSize: '0.75rem',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
}


function sideTabButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? 'var(--blue-600)' : 'var(--slate-700)'}`,
    background: active ? 'var(--blue-700)' : 'var(--gray-900)',
    color: active ? 'var(--on-fill-blue-50)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}

function auxButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? 'var(--blue-600)' : 'var(--slate-700)'}`,
    background: active ? 'var(--blue-950)' : 'var(--gray-900)',
    color: active ? 'var(--blue-100)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.74rem',
    fontWeight: 700
  }
}
