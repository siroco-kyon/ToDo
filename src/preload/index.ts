import { contextBridge, ipcRenderer } from 'electron'
import type {
  Category,
  Todo,
  SubTask,
  CreateTodoInput,
  UpdateTodoInput,
  WorkLog,
  RunningState,
  WorkLogSummaryRow
} from '../main/db'

export type { Category, Todo, SubTask, CreateTodoInput, UpdateTodoInput, WorkLog, RunningState, WorkLogSummaryRow }

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

  // SubTasks
  subtaskGetByTodo: (todoId: string): Promise<SubTask[]> => ipcRenderer.invoke('subtask:getByTodo', todoId),
  subtaskCreate: (todoId: string, title: string): Promise<SubTask> => ipcRenderer.invoke('subtask:create', todoId, title),
  subtaskUpdate: (id: string, data: { title?: string; done?: boolean }): Promise<SubTask> => ipcRenderer.invoke('subtask:update', id, data),
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

  // Markdown
  markdownExport: (mode: 'clipboard' | 'file'): Promise<ExportResult> =>
    ipcRenderer.invoke('markdown:export', mode),

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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
