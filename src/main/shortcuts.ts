import { globalShortcut, BrowserWindow } from 'electron'
import { getSetting } from './db'

let _mainWindow: BrowserWindow | null = null

function doRegister(mainWindow: BrowserWindow): void {
  let quickAddShortcut = 'CommandOrControl+Alt+N'
  let exportShortcut = 'CommandOrControl+Alt+E'
  let focusShortcut = 'CommandOrControl+Alt+T'
  try {
    quickAddShortcut = getSetting('globalShortcutQuickAdd') ?? quickAddShortcut
    exportShortcut = getSetting('globalShortcutExport') ?? exportShortcut
    focusShortcut = getSetting('globalShortcutFocus') ?? focusShortcut
  } catch { /* DB未初期化時はデフォルト値を使用 */ }

  globalShortcut.register(quickAddShortcut, () => {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('shortcut:quickAdd')
  })

  globalShortcut.register(exportShortcut, () => {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('shortcut:export')
  })

  globalShortcut.register(focusShortcut, () => {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

export function registerShortcuts(mainWindow: BrowserWindow): void {
  _mainWindow = mainWindow
  doRegister(mainWindow)
}

export function reregisterShortcuts(): void {
  if (!_mainWindow) return
  globalShortcut.unregisterAll()
  doRegister(_mainWindow)
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
