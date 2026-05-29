import { contextBridge, ipcRenderer } from 'electron'
import type {
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
  OverviewData,
  DailyPlanItem,
  UpdateDailyPlanItemInput,
  PublicUser,
  UserRole,
  CreateUserInput,
  UpdateUserInput,
  TeamDashboard,
  TeamNowItem,
  TeamDeadlineItem,
  TeamMemberWorkload
} from '../main/db'

export type {
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
  OverviewData,
  DailyPlanItem,
  UpdateDailyPlanItemInput,
  PublicUser,
  UserRole,
  CreateUserInput,
  UpdateUserInput,
  TeamDashboard,
  TeamNowItem,
  TeamDeadlineItem,
  TeamMemberWorkload
}

export interface ExportResult {
  success: boolean
  message: string
}

export interface IconPickResult {
  success: boolean
  dataUrl: string | null
}

const api = {
  // Categories
  categoryGetAll: (): Promise<Category[]> => ipcRenderer.invoke('category:getAll'),
  categoryCreate: (name: string, color: string): Promise<Category> =>
    ipcRenderer.invoke('category:create', name, color),
  categoryUpdate: (id: string, name: string, color: string, description: string): Promise<Category> =>
    ipcRenderer.invoke('category:update', id, name, color, description),
  categoryDelete: (id: string): Promise<void> => ipcRenderer.invoke('category:delete', id),
  categoryReorder: (orderedIds: string[]): Promise<void> => ipcRenderer.invoke('category:reorder', orderedIds),

  // Todos
  todoGetAll: (): Promise<Todo[]> => ipcRenderer.invoke('todo:getAll'),
  todoCreate: (data: CreateTodoInput): Promise<Todo> => ipcRenderer.invoke('todo:create', data),
  todoUpdate: (id: string, data: UpdateTodoInput): Promise<Todo> =>
    ipcRenderer.invoke('todo:update', id, data),
  todoArchive: (id: string): Promise<void> => ipcRenderer.invoke('todo:archive', id),
  todoUnarchive: (id: string): Promise<void> => ipcRenderer.invoke('todo:unarchive', id),
  todoDelete: (id: string): Promise<void> => ipcRenderer.invoke('todo:delete', id),
  todoReorder: (orderedIds: string[]): Promise<void> => ipcRenderer.invoke('todo:reorder', orderedIds),
  todoDependencyGetAll: (): Promise<TodoDependency[]> => ipcRenderer.invoke('todoDependency:getAll'),
  todoDependencyCreate: (predecessorTodoId: string, successorTodoId: string, lagDays: number): Promise<TodoDependency> =>
    ipcRenderer.invoke('todoDependency:create', predecessorTodoId, successorTodoId, lagDays),
  todoDependencyUpdate: (id: string, lagDays: number): Promise<TodoDependency> =>
    ipcRenderer.invoke('todoDependency:update', id, lagDays),
  todoDependencyDelete: (id: string): Promise<void> => ipcRenderer.invoke('todoDependency:delete', id),

  // SubTasks
  subtaskGetByTodo: (todoId: string): Promise<SubTask[]> => ipcRenderer.invoke('subtask:getByTodo', todoId),
  subtaskGetAll: (): Promise<SubTask[]> => ipcRenderer.invoke('subtask:getAll'),
  subtaskGetForCalendar: (): Promise<CalendarSubTask[]> => ipcRenderer.invoke('subtask:getForCalendar'),
  subtaskCreate: (todoId: string, data: CreateSubTaskInput): Promise<SubTask> =>
    ipcRenderer.invoke('subtask:create', todoId, data),
  subtaskUpdate: (id: string, data: UpdateSubTaskInput): Promise<SubTask> =>
    ipcRenderer.invoke('subtask:update', id, data),
  subtaskDelete: (id: string): Promise<void> => ipcRenderer.invoke('subtask:delete', id),

  // Timer
  timerStart: (todoId: string): Promise<RunningState> =>
    ipcRenderer.invoke('timer:start', todoId),
  timerStop: (note?: string): Promise<WorkLog> => ipcRenderer.invoke('timer:stop', note),
  timerGetRunning: (): Promise<RunningState | null> => ipcRenderer.invoke('timer:getRunning'),

  // WorkLogs
  worklogGetByTodo: (todoId: string): Promise<WorkLog[]> =>
    ipcRenderer.invoke('worklog:getByTodo', todoId),
  worklogGetByDate: (dateStr: string): Promise<WorkLogSummaryRow[]> =>
    ipcRenderer.invoke('worklog:getByDate', dateStr),
  worklogGetSummary: (days: number): Promise<WorkLogSummaryRow[]> =>
    ipcRenderer.invoke('worklog:getSummary', days),
  overviewGetData: (): Promise<OverviewData> => ipcRenderer.invoke('overview:getData'),

  // Daily plan
  dailyPlanGetByDate: (dateStr: string): Promise<DailyPlanItem[]> =>
    ipcRenderer.invoke('dailyPlan:getByDate', dateStr),
  dailyPlanAdd: (dateStr: string, todoId: string): Promise<DailyPlanItem> =>
    ipcRenderer.invoke('dailyPlan:add', dateStr, todoId),
  dailyPlanUpdate: (id: string, data: UpdateDailyPlanItemInput): Promise<DailyPlanItem> =>
    ipcRenderer.invoke('dailyPlan:update', id, data),
  dailyPlanShift: (id: string, deltaMinutes: number): Promise<DailyPlanItem> =>
    ipcRenderer.invoke('dailyPlan:shift', id, deltaMinutes),
  dailyPlanDelete: (id: string): Promise<void> => ipcRenderer.invoke('dailyPlan:delete', id),
  dailyPlanReorder: (dateStr: string, orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke('dailyPlan:reorder', dateStr, orderedIds),

  // Markdown
  markdownExport: (mode: 'clipboard' | 'file'): Promise<ExportResult> =>
    ipcRenderer.invoke('markdown:export', mode),

  // Users & team (multi-user; the Electron build returns empty/no-op values)
  userList: (): Promise<PublicUser[]> => ipcRenderer.invoke('user:list'),
  teamGetDashboard: (): Promise<TeamDashboard> => ipcRenderer.invoke('team:getDashboard'),
  authGetCurrentUser: (): Promise<PublicUser | null> => ipcRenderer.invoke('auth:getCurrentUser'),
  userCreate: (input: CreateUserInput): Promise<PublicUser> => ipcRenderer.invoke('user:create', input),
  userUpdate: (id: string, input: UpdateUserInput): Promise<PublicUser> =>
    ipcRenderer.invoke('user:update', id, input),
  userResetPassword: (id: string, password: string): Promise<void> =>
    ipcRenderer.invoke('user:resetPassword', id, password),

  // Settings
  settingsGet: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
  settingsSet: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value),

  // Icon
  iconGetDataUrl: (): Promise<string> => ipcRenderer.invoke('icon:getDataUrl'),
  iconPick: (): Promise<IconPickResult> => ipcRenderer.invoke('icon:pick'),
  iconReset: (): Promise<string> => ipcRenderer.invoke('icon:reset'),

  // Shortcuts
  shortcutsReregister: (): Promise<void> => ipcRenderer.invoke('shortcuts:reregister'),

  // Data directory
  dataGetDir: (): Promise<string> => ipcRenderer.invoke('data:getDir'),
  dataPickDir: (): Promise<string | null> => ipcRenderer.invoke('data:pickDir'),
  dataChangeDir: (newDir: string): Promise<{ moved: boolean }> =>
    ipcRenderer.invoke('data:changeDir', newDir),

  // App setup
  appIsFirstLaunch: (): Promise<boolean> => ipcRenderer.invoke('app:isFirstLaunch'),
  appGetDefaultDataDir: (): Promise<string> => ipcRenderer.invoke('app:getDefaultDataDir'),
  appCompleteSetup: (newDir: string | null): Promise<void> =>
    ipcRenderer.invoke('app:completeSetup', newDir),
  windowOpenGantt: (): Promise<void> => ipcRenderer.invoke('window:openGantt'),
  windowOpenTodo: (todoId: string): Promise<void> => ipcRenderer.invoke('window:openTodo', todoId),

  // イベントリスナー
  onShortcutQuickAdd: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('shortcut:quickAdd', handler)
    return () => ipcRenderer.removeListener('shortcut:quickAdd', handler)
  },
  onShortcutExport: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('shortcut:export', handler)
    return () => ipcRenderer.removeListener('shortcut:export', handler)
  },
  onNavigateTodo: (cb: (todoId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, todoId: string): void => cb(todoId)
    ipcRenderer.on('navigation:openTodo', handler)
    return () => ipcRenderer.removeListener('navigation:openTodo', handler)
  },
  onDataChanged: (cb: (scope: 'category' | 'todo' | 'subtask' | 'plan') => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, scope: 'category' | 'todo' | 'subtask' | 'plan'): void => cb(scope)
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
