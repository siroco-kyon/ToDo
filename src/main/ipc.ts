import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { NativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  getAllTodos,
  createTodo,
  updateTodo,
  archiveTodo,
  unarchiveTodo,
  deleteTodo,
  getAllTodoDependencies,
  createTodoDependency,
  updateTodoDependency,
  deleteTodoDependency,
  reorderTodos,
  startTimer,
  stopTimer,
  getRunningState,
  getWorkLogsByTodo,
  getAllWorkLogRows,
  getWorkLogsByDate,
  getWorkLogsSummary,
  getOverviewData,
  getDailyPlanItems,
  addDailyPlanItem,
  updateDailyPlanItem,
  shiftDailyPlanItem,
  deleteDailyPlanItem,
  reorderDailyPlanItems,
  getSubTasksByTodo,
  getAllSubTasks,
  getSubTasksForCalendar,
  reorderSubTasks,
  createSubTask,
  updateSubTask,
  deleteSubTask,
  getProgressNotesByTodo,
  getProgressNotesByDate,
  getProgressNotesByRange,
  createProgressNote,
  updateProgressNote,
  deleteProgressNote,
  createProgressNoteComment,
  updateProgressNoteComment,
  deleteProgressNoteComment,
  toggleProgressNoteReaction,
  toggleProgressNoteCommentReaction,
  getProgressDigest,
  getSetting,
  setSetting,
  initDb
} from './db'
import type {
  CreateSubTaskInput,
  UpdateDailyPlanItemInput,
  UpdateSubTaskInput,
  ProgressDigestQuery
} from './db'
import { exportMarkdown } from './markdown'
import { pickAndSetIcon, resetIcon, getIconDataUrl } from './icon'
import { getDataDir, setDataDir, isFirstLaunch, getDefaultDataDir } from './config'
import { reregisterShortcuts } from './shortcuts'
import { runArchiveCleanup } from './archive'

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  updateTray: (img: NativeImage) => void,
  openGanttWindow: () => void,
  openTodoInMainWindow: (todoId: string) => void,
  openTaskReportWindow: () => void
): void {
  const broadcastDataChange = (scope: 'category' | 'todo' | 'subtask' | 'plan' | 'progress'): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('data:changed', scope)
    }
  }

  const handleMutation = <TArgs extends unknown[], TResult>(
    scope: 'category' | 'todo' | 'subtask' | 'plan' | 'progress' | Array<'category' | 'todo' | 'subtask' | 'plan' | 'progress'>,
    action: (...args: TArgs) => TResult
  ) => (_event: Electron.IpcMainInvokeEvent, ...args: TArgs): TResult => {
    const result = action(...args)
    const scopes = Array.isArray(scope) ? scope : [scope]
    scopes.forEach(broadcastDataChange)
    return result
  }

  // Categories
  ipcMain.handle('category:getAll', () => getAllCategories())
  ipcMain.handle('category:create', handleMutation('category', (name: string, color: string, isPrivate: boolean) => createCategory(name, color, isPrivate)))
  ipcMain.handle('category:update', handleMutation('category', (id: string, name: string, color: string, description: string, isPrivate: boolean) => updateCategory(id, name, color, description, isPrivate)))
  ipcMain.handle('category:delete', handleMutation('category', (id: string) => deleteCategory(id)))
  ipcMain.handle('category:reorder', handleMutation('category', (orderedIds: string[]) => reorderCategories(orderedIds)))

  // Todos
  ipcMain.handle('todo:getAll', () => getAllTodos())
  ipcMain.handle('todo:create', handleMutation('todo', (data) => createTodo(data)))
  ipcMain.handle('todo:update', handleMutation('todo', (id: string, data) => updateTodo(id, data)))
  ipcMain.handle('todo:archive', handleMutation('todo', (id: string) => archiveTodo(id)))
  ipcMain.handle('todo:unarchive', handleMutation('todo', (id: string, status?: 'not_started' | 'active' | 'done') => unarchiveTodo(id, status)))
  ipcMain.handle('todo:delete', handleMutation('todo', (id: string) => deleteTodo(id)))
  ipcMain.handle('todo:reorder', handleMutation('todo', (orderedIds: string[]) => reorderTodos(orderedIds)))
  ipcMain.handle('todoDependency:getAll', () => getAllTodoDependencies())
  ipcMain.handle('todoDependency:create', handleMutation('todo', (predecessorTodoId: string, successorTodoId: string, lagDays: number) => createTodoDependency(predecessorTodoId, successorTodoId, lagDays)))
  ipcMain.handle('todoDependency:update', handleMutation('todo', (id: string, lagDays: number) => updateTodoDependency(id, lagDays)))
  ipcMain.handle('todoDependency:delete', handleMutation('todo', (id: string) => deleteTodoDependency(id)))

  // SubTasks
  ipcMain.handle('subtask:getByTodo', (_, todoId: string) => getSubTasksByTodo(todoId))
  ipcMain.handle('subtask:getAll', () => getAllSubTasks())
  ipcMain.handle('subtask:getForCalendar', () => getSubTasksForCalendar())
  ipcMain.handle('subtask:reorder', handleMutation('subtask', (todoId: string, orderedIds: string[]) => reorderSubTasks(todoId, orderedIds)))
  ipcMain.handle('subtask:create', handleMutation(['subtask', 'todo'], (todoId: string, data: CreateSubTaskInput) => createSubTask(todoId, data)))
  ipcMain.handle('subtask:update', handleMutation(['subtask', 'todo'], (id: string, data: UpdateSubTaskInput) => updateSubTask(id, data)))
  ipcMain.handle('subtask:delete', handleMutation('subtask', (id: string) => deleteSubTask(id)))

  // Timer
  ipcMain.handle('timer:start', (_, todoId: string) => startTimer(todoId))
  ipcMain.handle('timer:stop', (_, note?: string) => stopTimer(note))
  ipcMain.handle('timer:getRunning', () => getRunningState() ?? null)

  // WorkLogs
  ipcMain.handle('worklog:getByTodo', (_, todoId: string) => getWorkLogsByTodo(todoId))
  ipcMain.handle('worklog:getAll', () => getAllWorkLogRows())
  ipcMain.handle('worklog:getByDate', (_, dateStr: string) => getWorkLogsByDate(dateStr))
  ipcMain.handle('worklog:getSummary', (_, days: number) => getWorkLogsSummary(days))
  ipcMain.handle('overview:getData', () => getOverviewData())

  // Daily plan
  ipcMain.handle('dailyPlan:getByDate', (_, dateStr: string) => getDailyPlanItems(dateStr))
  ipcMain.handle('dailyPlan:add', handleMutation('plan', (dateStr: string, todoId: string) => addDailyPlanItem(dateStr, todoId)))
  ipcMain.handle('dailyPlan:update', handleMutation('plan', (id: string, data: UpdateDailyPlanItemInput) => updateDailyPlanItem(id, data)))
  ipcMain.handle('dailyPlan:shift', handleMutation('plan', (id: string, deltaMinutes: number) => shiftDailyPlanItem(id, deltaMinutes)))
  ipcMain.handle('dailyPlan:delete', handleMutation('plan', (id: string) => deleteDailyPlanItem(id)))
  ipcMain.handle('dailyPlan:reorder', handleMutation('plan', (dateStr: string, orderedIds: string[]) => reorderDailyPlanItems(dateStr, orderedIds)))

  // Markdown export
  ipcMain.handle('markdown:export', (_, mode: 'clipboard' | 'file') => exportMarkdown(mode))

  // Users & team — single-user desktop build has no team, so report none.
  // (The web server provides the real multi-user implementations.)
  ipcMain.handle('user:list', () => [])
  ipcMain.handle('team:getDashboard', () => ({ now: [], overdue: [], dueSoon: [], workloads: [] }))
  ipcMain.handle('auth:getCurrentUser', () => null)
  ipcMain.handle('auth:logout', () => undefined)
  const userManagementUnavailable = (): never => {
    throw new Error('ユーザー管理はサーバー版でのみ利用できます')
  }
  ipcMain.handle('user:create', userManagementUnavailable)
  ipcMain.handle('user:update', userManagementUnavailable)
  ipcMain.handle('user:resetPassword', userManagementUnavailable)
  ipcMain.handle('admin:importDesktopDb', (): never => {
    throw new Error('デスクトップDBの取り込みはサーバー版でのみ利用できます')
  })

  // Progress notes (shared) / digest (desktop = single bucket)
  ipcMain.handle('progressNote:getByTodo', (_, todoId: string) => getProgressNotesByTodo(todoId))
  ipcMain.handle('progressNote:getByDate', (_, dateStr: string) => getProgressNotesByDate(dateStr))
  ipcMain.handle('progressNote:getByRange', (_, from: string, to: string) => getProgressNotesByRange(from, to))
  ipcMain.handle('progressNote:create', handleMutation('progress', (todoId: string, body: string) => createProgressNote(todoId, body)))
  ipcMain.handle('progressNote:update', handleMutation('progress', (id: string, body: string) => updateProgressNote(id, body)))
  ipcMain.handle('progressNote:delete', handleMutation('progress', (id: string) => deleteProgressNote(id)))
  ipcMain.handle('progressNoteComment:create', handleMutation('progress', (noteId: string, body: string, parentCommentId?: string | null) => createProgressNoteComment(noteId, body, parentCommentId)))
  ipcMain.handle('progressNoteComment:update', handleMutation('progress', (id: string, body: string) => updateProgressNoteComment(id, body)))
  ipcMain.handle('progressNoteComment:delete', handleMutation('progress', (id: string) => deleteProgressNoteComment(id)))
  ipcMain.handle('progressNoteReaction:toggle', handleMutation('progress', (noteId: string, emoji: string) => toggleProgressNoteReaction(noteId, emoji)))
  ipcMain.handle('progressNoteCommentReaction:toggle', handleMutation('progress', (commentId: string, emoji: string) => toggleProgressNoteCommentReaction(commentId, emoji)))
  ipcMain.handle('progressDigest:get', (_, query: ProgressDigestQuery) => getProgressDigest(query))

  // Settings
  ipcMain.handle('settings:get', (_, key: string) => getSetting(key) ?? null)
  ipcMain.handle('settings:set', (_, key: string, value: string) => setSetting(key, value))

  // Icon
  ipcMain.handle('icon:getDataUrl', () => getIconDataUrl())
  ipcMain.handle('icon:pick', () => pickAndSetIcon(mainWindow, updateTray))
  ipcMain.handle('icon:reset', () => resetIcon(mainWindow, updateTray))

  // Shortcuts
  ipcMain.handle('shortcuts:reregister', () => reregisterShortcuts())

  // Data directory
  ipcMain.handle('data:getDir', () => getDataDir())

  ipcMain.handle('data:pickDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'データ保存フォルダを選択',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // App setup (first launch)
  ipcMain.handle('app:isFirstLaunch', () => isFirstLaunch())
  ipcMain.handle('app:getDefaultDataDir', () => getDefaultDataDir())
  ipcMain.handle('app:completeSetup', async (_, newDir: string | null) => {
    if (newDir) {
      setDataDir(newDir)
    } else {
      // デフォルト保存場所を確定してconfig.jsonを生成
      const dir = getDefaultDataDir()
      setDataDir(dir)
    }
    initDb()
    runArchiveCleanup()
  })

  ipcMain.handle('data:changeDir', (_, newDir: string) => {
    const oldDir = getDataDir()
    if (oldDir === newDir) return { moved: false }

    // 新しいフォルダ作成
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true })

    // DBコピー前にカスタムアイコンパスを更新（コピー後のパスを先にDBへ書き込む）
    const oldIconsDir = path.join(oldDir, 'icons')
    const newIconsDir = path.join(newDir, 'icons')
    const customIconPath = getSetting('customIconPath')
    if (customIconPath && customIconPath.startsWith(oldIconsDir)) {
      setSetting('customIconPath', customIconPath.replace(oldIconsDir, newIconsDir))
    }

    // DB コピー
    const oldDb = path.join(oldDir, 'todo.db')
    const newDb = path.join(newDir, 'todo.db')
    if (fs.existsSync(oldDb)) fs.copyFileSync(oldDb, newDb)

    // iconsフォルダコピー
    if (fs.existsSync(oldIconsDir)) {
      if (!fs.existsSync(newIconsDir)) fs.mkdirSync(newIconsDir, { recursive: true })
      for (const file of fs.readdirSync(oldIconsDir)) {
        fs.copyFileSync(path.join(oldIconsDir, file), path.join(newIconsDir, file))
      }
    }

    setDataDir(newDir)
    return { moved: true }
  })

  // Window navigation
  ipcMain.handle('window:openGantt', () => {
    openGanttWindow()
  })
  ipcMain.handle('window:openTodo', (_, todoId: string) => {
    openTodoInMainWindow(todoId)
  })
  ipcMain.handle('window:openTaskReport', () => {
    openTaskReportWindow()
  })
}
