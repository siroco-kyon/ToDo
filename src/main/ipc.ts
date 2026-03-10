import { ipcMain, dialog } from 'electron'
import type { BrowserWindow, NativeImage } from 'electron'
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
  reorderTodos,
  startTimer,
  stopTimer,
  getRunningState,
  getWorkLogsByTodo,
  getWorkLogsByDate,
  getWorkLogsSummary,
  getSubTasksByTodo,
  createSubTask,
  updateSubTask,
  deleteSubTask,
  getSetting,
  setSetting,
  initDb
} from './db'
import { exportMarkdown } from './markdown'
import { pickAndSetIcon, resetIcon, getIconDataUrl } from './icon'
import { getDataDir, setDataDir, isFirstLaunch, getDefaultDataDir } from './config'
import { reregisterShortcuts } from './shortcuts'
import { runArchiveCleanup } from './archive'

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  updateTray: (img: NativeImage) => void
): void {
  // Categories
  ipcMain.handle('category:getAll', () => getAllCategories())
  ipcMain.handle('category:create', (_, name: string, color: string) =>
    createCategory(name, color)
  )
  ipcMain.handle('category:update', (_, id: string, name: string, color: string, description: string) =>
    updateCategory(id, name, color, description)
  )
  ipcMain.handle('category:delete', (_, id: string) => deleteCategory(id))
  ipcMain.handle('category:reorder', (_, orderedIds: string[]) => reorderCategories(orderedIds))

  // Todos
  ipcMain.handle('todo:getAll', () => getAllTodos())
  ipcMain.handle('todo:create', (_, data) => createTodo(data))
  ipcMain.handle('todo:update', (_, id: string, data) => updateTodo(id, data))
  ipcMain.handle('todo:archive', (_, id: string) => archiveTodo(id))
  ipcMain.handle('todo:unarchive', (_, id: string) => unarchiveTodo(id))
  ipcMain.handle('todo:delete', (_, id: string) => deleteTodo(id))
  ipcMain.handle('todo:reorder', (_, orderedIds: string[]) => reorderTodos(orderedIds))

  // SubTasks
  ipcMain.handle('subtask:getByTodo', (_, todoId: string) => getSubTasksByTodo(todoId))
  ipcMain.handle('subtask:create', (_, todoId: string, title: string) => createSubTask(todoId, title))
  ipcMain.handle('subtask:update', (_, id: string, data: { title?: string; done?: boolean }) => updateSubTask(id, data))
  ipcMain.handle('subtask:delete', (_, id: string) => deleteSubTask(id))

  // Timer
  ipcMain.handle('timer:start', (_, todoId: string) => startTimer(todoId))
  ipcMain.handle('timer:stop', (_, note?: string) => stopTimer(note))
  ipcMain.handle('timer:getRunning', () => getRunningState() ?? null)

  // WorkLogs
  ipcMain.handle('worklog:getByTodo', (_, todoId: string) => getWorkLogsByTodo(todoId))
  ipcMain.handle('worklog:getByDate', (_, dateStr: string) => getWorkLogsByDate(dateStr))
  ipcMain.handle('worklog:getSummary', (_, days: number) => getWorkLogsSummary(days))

  // Markdown export
  ipcMain.handle('markdown:export', (_, mode: 'clipboard' | 'file') => exportMarkdown(mode))

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
}
