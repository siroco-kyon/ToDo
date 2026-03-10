import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb } from './db'
import { runArchiveCleanup } from './archive'
import { registerIpcHandlers } from './ipc'
import { createTray, destroyTray, updateTrayIcon } from './tray'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { loadAppIcon } from './icon'
import { isFirstLaunch } from './config'
import { checkDueNotifications } from './notifications'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const icon = loadAppIcon()

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.todo.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  if (!isFirstLaunch()) {
    initDb()
    runArchiveCleanup()
    checkDueNotifications()
    // 1時間ごとに期限通知をチェック
    setInterval(() => { try { checkDueNotifications() } catch { /* ignore */ } }, 60 * 60 * 1000)
  }

  createWindow()

  if (mainWindow) {
    const icon = loadAppIcon()
    createTray(mainWindow, icon)
    registerIpcHandlers(mainWindow, updateTrayIcon)
    registerShortcuts(mainWindow)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('will-quit', () => {
  unregisterShortcuts()
  destroyTray()
})

app.on('window-all-closed', () => {
  // Windowsではトレイ常駐のため終了しない
})

declare global {
  namespace Electron {
    interface App {
      isQuitting: boolean
    }
  }
}
