import { app, BrowserWindow, shell } from 'electron'
import fs from 'fs'
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
const DEV_RENDERER_RETRY_LIMIT = 20
const DEV_RENDERER_RETRY_DELAY_MS = 500
const windowRetryState = new WeakMap<BrowserWindow, { hash: string; attempts: number; timer: NodeJS.Timeout | null }>()
const DEV_LOG_PATH = join(process.cwd(), 'dev-main.log')

function debugLog(...args: unknown[]): void {
  if (is.dev) {
    console.log('[main]', ...args)
    try {
      fs.appendFileSync(DEV_LOG_PATH, `[${new Date().toISOString()}] ${args.map((arg) => {
        if (typeof arg === 'string') return arg
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }).join(' ')}\n`)
    } catch {
      // ignore logging failures in dev diagnostics
    }
  }
}

if (is.dev) {
  app.setPath('userData', DEV_USER_DATA_DIR)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

function loadRendererWindow(targetWindow: BrowserWindow, hash = ''): void {
  debugLog('loadRendererWindow', { hash, rendererUrl: process.env['ELECTRON_RENDERER_URL'] ?? null })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.hash = hash
    void targetWindow.loadURL(rendererUrl.toString()).catch((error) => {
      console.error(`[window:${hash || 'main'}] loadURL failed:`, error)
      scheduleRendererRetry(targetWindow)
    })
    return
  }

  if (hash) {
    void targetWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash }).catch((error) => {
      console.error(`[window:${hash}] loadFile failed:`, error)
    })
    return
  }

  void targetWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((error) => {
    console.error('[window:main] loadFile failed:', error)
  })
}

function scheduleRendererRetry(targetWindow: BrowserWindow): void {
  if (!is.dev || !process.env['ELECTRON_RENDERER_URL'] || targetWindow.isDestroyed()) return

  const retryState = windowRetryState.get(targetWindow)
  if (!retryState || retryState.timer || retryState.attempts >= DEV_RENDERER_RETRY_LIMIT) return

  retryState.attempts += 1
  retryState.timer = setTimeout(() => {
    retryState.timer = null
    if (targetWindow.isDestroyed()) return
    loadRendererWindow(targetWindow, retryState.hash)
  }, DEV_RENDERER_RETRY_DELAY_MS)
}

function attachWindowDiagnostics(targetWindow: BrowserWindow, hash = ''): void {
  const retryState = { hash, attempts: 0, timer: null as NodeJS.Timeout | null }
  windowRetryState.set(targetWindow, retryState)

  targetWindow.webContents.on('did-finish-load', () => {
    debugLog('did-finish-load', { hash: hash || 'main' })
    retryState.attempts = 0
    if (retryState.timer) {
      clearTimeout(retryState.timer)
      retryState.timer = null
    }
  })

  targetWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[window:${hash || 'main'}] did-fail-load`, { errorCode, errorDescription, validatedURL })
    scheduleRendererRetry(targetWindow)
  })

  targetWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[window:${hash || 'main'}] render-process-gone`, details)
  })

  targetWindow.webContents.on('unresponsive', () => {
    console.error(`[window:${hash || 'main'}] renderer became unresponsive`)
  })

  targetWindow.webContents.on('did-start-loading', () => {
    debugLog('did-start-loading', { hash: hash || 'main' })
  })

  targetWindow.on('closed', () => {
    debugLog('window closed', { hash: hash || 'main' })
    if (retryState.timer) clearTimeout(retryState.timer)
    windowRetryState.delete(targetWindow)
  })
}

function attachExternalLinkGuard(targetWindow: BrowserWindow): void {
  targetWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

function createWindow(): void {
  debugLog('createWindow')
  const icon = loadAppIcon()

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: is.dev,
    autoHideMenuBar: true,
    icon,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    debugLog('main ready-to-show')
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    debugLog('main closed')
    mainWindow = null
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting && !is.dev) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  attachExternalLinkGuard(mainWindow)
  attachWindowDiagnostics(mainWindow)
  loadRendererWindow(mainWindow)
}

function openGanttWindow(): void {
  debugLog('openGanttWindow')
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
    show: is.dev,
    autoHideMenuBar: true,
    title: 'ガントチャート',
    icon,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  ganttWindow.on('ready-to-show', () => {
    debugLog('gantt ready-to-show')
    ganttWindow?.show()
  })

  ganttWindow.on('closed', () => {
    debugLog('gantt closed')
    ganttWindow = null
  })

  attachExternalLinkGuard(ganttWindow)
  attachWindowDiagnostics(ganttWindow, 'gantt-only')
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
    debugLog('second-instance')
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    try {
      fs.writeFileSync(DEV_LOG_PATH, '')
    } catch {
      // ignore logging failures in dev diagnostics
    }
    debugLog('app.whenReady')
    electronApp.setAppUserModelId('com.todo.app')

    app.on('browser-window-created', (_, window) => {
      debugLog('browser-window-created', { id: window.id })
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
  debugLog('before-quit')
  app.isQuitting = true
})

app.on('will-quit', () => {
  debugLog('will-quit')
  unregisterShortcuts()
  destroyTray()
})

app.on('window-all-closed', () => {
  debugLog('window-all-closed')
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
