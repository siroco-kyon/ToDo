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
let ganttWindow: BrowserWindow | null = null
const DEV_USER_DATA_DIR = join(app.getPath('appData'), 'ToDo-dev')

if (is.dev) {
  app.setPath('userData', DEV_USER_DATA_DIR)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

function loadRendererWindow(targetWindow: BrowserWindow, hash = ''): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.hash = hash
    void targetWindow.loadURL(rendererUrl.toString())
    return
  }

  if (hash) {
    void targetWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    return
  }

  void targetWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function attachExternalLinkGuard(targetWindow: BrowserWindow): void {
  targetWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

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

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting && !is.dev) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  attachExternalLinkGuard(mainWindow)
  loadRendererWindow(mainWindow)
}

function openGanttWindow(): void {
  if (ganttWindow && !ganttWindow.isDestroyed()) {
    if (is.dev) {
      loadRendererWindow(ganttWindow, 'gantt-only')
    }
    if (ganttWindow.isMinimized()) ganttWindow.restore()
    ganttWindow.show()
    ganttWindow.focus()
    return
  }

  const icon = loadAppIcon()

  ganttWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'ガントチャート',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  ganttWindow.on('ready-to-show', () => {
    ganttWindow?.show()
  })

  ganttWindow.on('closed', () => {
    ganttWindow = null
  })

  attachExternalLinkGuard(ganttWindow)
  loadRendererWindow(ganttWindow, 'gantt-only')
}

function openTodoInMainWindow(todoId: string): void {
  const revealMainWindow = (): void => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('navigation:openTodo', todoId)
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    if (!mainWindow) return
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(revealMainWindow, 50)
    })
    return
  }

  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(revealMainWindow, 50)
    })
    return
  }

  revealMainWindow()
}

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

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
      registerIpcHandlers(mainWindow, updateTrayIcon, openGanttWindow, openTodoInMainWindow)
      registerShortcuts(mainWindow)
    }

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
      } else {
        mainWindow?.show()
      }
    })
  })
}

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('will-quit', () => {
  unregisterShortcuts()
  destroyTray()
})

app.on('window-all-closed', () => {
  if (is.dev) {
    app.quit()
  }
})

declare global {
  namespace Electron {
    interface App {
      isQuitting: boolean
    }
  }
}
