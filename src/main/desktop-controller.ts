import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, screen, session, shell, Tray } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { generateDefaultIconBuffer } from './icon'
import { makeProfile, readDesktopConfig, validatePreferences, writeDesktopConfig } from './desktop-config'
import { applyWindowsTaskbarBranding } from './windows-branding'
import { MAX_TIMER_SIZE, normalizeTimerSize, timerGeometry } from './timer-sizing'
import type { DesktopCommand, DesktopContext, DesktopPreferences, DesktopState, LauncherState } from '../shared/desktop'

type WindowKind = 'main' | 'timer' | 'progress' | 'gantt' | 'report'
type ShortcutAction = 'globalShortcutFocus' | 'globalShortcutQuickAdd' | 'globalShortcutExport' | 'globalShortcutProgress'
interface RemoteShortcut { action: ShortcutAction; key: string; label: string; callback: () => void }
const REMOTE_LOAD_TIMEOUT_MS = 30000
const WINDOW_LABELS: Record<WindowKind, string> = { main: 'メイン画面', timer: 'タイマー', progress: '進捗入力画面', gantt: 'ガントチャート', report: 'タスク別レポート' }
const EMPTY_STATE: DesktopState = { userId: null, taskId: null, taskTitle: '', startTime: null, online: false }
const defaultIcon = (): Electron.NativeImage => nativeImage.createFromBuffer(generateDefaultIconBuffer())

/** Owns the remote shell. It never calls the local SQLite API. */
export class DesktopController {
  private config = readDesktopConfig()
  private launcher: BrowserWindow | null = null
  private windows = new Map<WindowKind, BrowserWindow>()
  private tray: Tray | null = null
  private state: DesktopState = { ...EMPTY_STATE }
  private serverVersion = 0
  private connecting = false
  private message = ''
  private openedLocal = false
  private shuttingDown = false
  private connectGeneration = 0
  private trayTick: NodeJS.Timeout | null = null
  private windowStatus = new WeakMap<BrowserWindow, 'loading' | 'ready' | 'failed'>()
  private loadTimeouts = new Map<BrowserWindow, NodeJS.Timeout>()
  private pendingProgressTargets = new WeakMap<BrowserWindow, string>()
  private activeShortcuts: RemoteShortcut[] = []
  private timerGeometrySaveTimeout: NodeJS.Timeout | null = null

  constructor(private readonly startLocal: () => void, private readonly revealLocal: () => void) {
    this.registerBridge()
  }

  start(): void {
    if (this.config.mode === 'local') {
      this.openedLocal = true
      this.startLocal()
    } else {
      this.showConnectionSettings()
      if (this.config.mode === 'server' && this.config.profile) void this.connect(this.config.profile)
    }
  }

  reveal(): void {
    if (this.openedLocal) this.revealLocal()
    else if (this.windows.has('main')) this.openMain()
    else this.showConnectionSettings()
  }

  showConnectionSettings(): void {
    if (this.launcher && !this.launcher.isDestroyed()) {
      this.launcher.show()
      this.launcher.focus()
      this.pushLauncherState()
      return
    }
    this.launcher = new BrowserWindow({
      width: 800, height: 710, minWidth: 540, minHeight: 560,
      show: false, autoHideMenuBar: true, title: 'HAKOBI — 接続設定', icon: defaultIcon(),
      backgroundColor: '#0f172a',
      webPreferences: { preload: join(__dirname, '../preload/launcher.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    applyWindowsTaskbarBranding(this.launcher)
    const target = this.launcher
    // The shared HTML title must not replace the native window's purpose.
    target.on('page-title-updated', (event) => event.preventDefault())
    target.once('ready-to-show', () => target.show())
    target.on('closed', () => {
      if (this.launcher === target) this.launcher = null
      if (!this.openedLocal && !this.windows.has('main') && !this.shuttingDown) app.quit()
    })
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    target.webContents.on('will-navigate', (event) => event.preventDefault())
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && rendererUrl) {
      const url = new URL(rendererUrl)
      url.hash = 'hakobi-launcher'
      void target.loadURL(url.toString())
    } else {
      void target.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'hakobi-launcher' })
    }
  }

  dispose(): void {
    this.flushTimerGeometry()
    this.shuttingDown = true
    this.connectGeneration++
    if (this.trayTick) clearInterval(this.trayTick)
    for (const timeout of this.loadTimeouts.values()) clearTimeout(timeout)
    this.loadTimeouts.clear()
    this.tray?.destroy()
    this.tray = null
    globalShortcut.unregisterAll()
  }

  private launcherState(): LauncherState {
    return { mode: this.config.mode, profile: this.config.profile, preferences: this.config.preferences,
      message: this.message, connecting: this.connecting, canCancel: this.openedLocal || this.windows.has('main') }
  }

  private pushLauncherState(): void {
    if (this.launcher && !this.launcher.isDestroyed()) this.launcher.webContents.send('hakobi-launcher:state-changed', this.launcherState())
  }

  private async connect(input: { name: string; url: string }): Promise<void> {
    if (this.connecting) return
    const generation = ++this.connectGeneration
    this.connecting = true
    this.message = 'サーバーに接続しています…'
    this.pushLauncherState()
    let loadingRemote = false
    try {
      const profile = makeProfile(input.name, input.url)
      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), 12000)
      let health: { ok?: boolean; desktopProtocol?: number; webReady?: boolean }
      try {
        const response = await net.fetch(`${profile.url}/api/health`, { signal: abort.signal, redirect: 'error', cache: 'no-store' })
        if (!response.ok) throw new Error(`サーバーからエラーが返されました（${response.status}）。`)
        health = await response.json() as typeof health
        if (health.ok !== true) throw new Error('HAKOBIのサーバーではありません。URLとポートを確認してください。')
        if (health.webReady === false) throw new Error('サーバーの画面が準備されていません。管理者に npm run build:web の実行を依頼してください。')
      } finally { clearTimeout(timeout) }
      if (generation !== this.connectGeneration || this.shuttingDown) return
      this.serverVersion = Number.isInteger(health.desktopProtocol) ? health.desktopProtocol! : 0
      const sameProfile = this.config.mode === 'server' && this.config.profile?.id === profile.id
      this.flushTimerGeometry()
      this.config = { ...this.config, mode: 'server', profile, timerPosition: sameProfile ? this.config.timerPosition : undefined }
      writeDesktopConfig(this.config)
      if (this.openedLocal) {
        this.restart()
        return
      }
      this.closeRemoteWindows(false)
      this.state = { ...EMPTY_STATE }
      loadingRemote = true
      this.createRemoteWindow('main')
      this.createRemoteTray()
      try { this.registerRemoteShortcuts(this.config.preferences, true) } catch { /* The native dialog explains the unavailable shortcut. */ }
      this.message = '画面を読み込んでいます…'
    } catch (error) {
      this.message = error instanceof Error && error.name !== 'AbortError'
        ? error.message : 'サーバーに接続できません。LAN接続、URL、サーバーの起動状態を確認してください。'
    } finally {
      if (generation === this.connectGeneration) {
        if (!loadingRemote) this.connecting = false
        this.pushLauncherState()
      }
    }
  }

  private restart(): void {
    app.relaunch()
    app.quit()
  }

  private closeRemoteWindows(persistTimer = true): void {
    if (persistTimer) this.flushTimerGeometry()
    else {
      if (this.timerGeometrySaveTimeout) clearTimeout(this.timerGeometrySaveTimeout)
      this.timerGeometrySaveTimeout = null
    }
    for (const window of this.windows.values()) window.destroy()
    this.windows.clear()
  }

  private createRemoteWindow(kind: WindowKind, todoId?: string): BrowserWindow {
    const existing = this.windows.get(kind)
    if (existing && !existing.isDestroyed() && this.windowStatus.get(existing) !== 'failed') {
      if (kind === 'progress' && todoId) {
        if (this.windowStatus.get(existing) === 'loading' || existing.webContents.isLoadingMainFrame()) {
          this.pendingProgressTargets.set(existing, todoId)
        } else existing.webContents.send('hakobi:command', { type: 'progress-target', todoId } satisfies DesktopCommand)
      }
      if (existing.isMinimized()) existing.restore()
      existing.show()
      if (kind !== 'timer') existing.focus()
      return existing
    }
    if (existing && !existing.isDestroyed()) existing.destroy()
    const profile = this.config.profile!
    const partition = `persist:hakobi-${profile.id}`
    const groupSession = session.fromPartition(partition)
    groupSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    groupSession.setPermissionCheckHandler(() => false)
    const timerPosition = this.config.timerPosition
    const timerArea = (timerPosition ? screen.getDisplayNearestPoint(timerPosition) : screen.getPrimaryDisplay()).workArea
    const timerLayout = timerGeometry(this.config.preferences.timerCompact,
      this.config.timerSizes?.[this.config.preferences.timerCompact ? 'compact' : 'normal'], timerArea, { position: timerPosition })
    const sizes: Record<WindowKind, { width: number; height: number; minWidth: number; minHeight: number }> = {
      main: { width: 1280, height: 860, minWidth: 800, minHeight: 600 },
      timer: { width: timerLayout.bounds.width, height: timerLayout.bounds.height,
        minWidth: timerLayout.minSize.width, minHeight: timerLayout.minSize.height },
      progress: { width: 520, height: 560, minWidth: 420, minHeight: 480 },
      gantt: { width: 1440, height: 920, minWidth: 980, minHeight: 640 },
      report: { width: 1000, height: 960, minWidth: 720, minHeight: 560 }
    }
    const window = new BrowserWindow({ ...sizes[kind], show: false, autoHideMenuBar: true,
      title: `HAKOBI — ${profile.name}`, icon: defaultIcon(), backgroundColor: '#0f172a',
      alwaysOnTop: kind === 'timer' && this.config.preferences.alwaysOnTop,
      resizable: true, maximizable: kind !== 'timer',
      webPreferences: { partition, preload: join(__dirname, '../preload/desktop.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false }
    })
    applyWindowsTaskbarBranding(window)
    // Keep the chosen group visible even when the server changes document.title.
    window.on('page-title-updated', (event) => event.preventDefault())
    this.windows.set(kind, window)
    this.windowStatus.set(window, 'loading')
    if (kind === 'timer') {
      window.setMaximumSize(MAX_TIMER_SIZE.width, MAX_TIMER_SIZE.height)
      window.setPosition(timerLayout.bounds.x, timerLayout.bounds.y)
    }
    window.on('close', (event) => {
      if (this.shuttingDown || app.isQuitting) return
      if (kind === 'main' || kind === 'timer' || kind === 'progress') {
        event.preventDefault()
        window.hide()
        if (kind === 'timer') this.updatePreferences({ showTimer: false })
      }
    })
    window.on('closed', () => {
      this.clearLoadTimeout(window)
      if (this.windows.get(kind) === window) this.windows.delete(kind)
    })
    if (kind === 'timer') {
      window.on('moved', () => this.queueTimerGeometrySave(window))
      window.on('resize', () => this.queueTimerGeometrySave(window))
    }
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternal(url)
      return { action: 'deny' }
    })
    const guard = (event: Electron.Event, url: string): void => {
      if (!this.isGroupUrl(url)) { event.preventDefault(); this.openExternal(url) }
    }
    window.webContents.on('will-navigate', guard)
    window.webContents.on('will-redirect', guard)
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.once('ready-to-show', () => {
      if (window.isDestroyed() || this.shuttingDown || this.windowStatus.get(window) === 'failed') return
      if (kind === 'timer') {
        if (this.config.preferences.showTimer) window.showInactive()
      }
      else window.show()
      if (kind === 'main') {
        this.connecting = false
        this.message = ''
        this.launcher?.destroy()
        this.launcher = null
      }
    })
    window.webContents.on('did-finish-load', () => {
      if (window.isDestroyed() || this.windowStatus.get(window) === 'failed') return
      this.clearLoadTimeout(window)
      this.windowStatus.set(window, 'ready')
      const target = this.pendingProgressTargets.get(window)
      if (target) {
        this.pendingProgressTargets.delete(window)
        window.webContents.send('hakobi:command', { type: 'progress-target', todoId: target } satisfies DesktopCommand)
      }
    })
    window.webContents.on('render-process-gone', () => {
      this.failRemoteWindow(kind, window, todoId, '画面の動作が停止しました。再接続してください。')
    })
    this.loadTimeouts.set(window, setTimeout(() => {
      this.failRemoteWindow(kind, window, todoId, '画面の読み込みに時間がかかっています。接続先とサーバーの状態を確認して再接続してください。')
    }, REMOTE_LOAD_TIMEOUT_MS))
    void window.loadURL(this.remoteUrl(kind, todoId)).catch(() => {
      this.failRemoteWindow(kind, window, todoId, 'サーバーの画面を読み込めません。Web版をビルド済みか確認して再接続してください。')
    })
    return window
  }

  private clearLoadTimeout(window: BrowserWindow): void {
    const timeout = this.loadTimeouts.get(window)
    if (timeout) clearTimeout(timeout)
    this.loadTimeouts.delete(window)
  }

  private failRemoteWindow(kind: WindowKind, window: BrowserWindow, todoId: string | undefined, message: string): void {
    if (this.shuttingDown || window.isDestroyed() || this.windows.get(kind) !== window || this.windowStatus.get(window) === 'failed') return
    this.clearLoadTimeout(window)
    this.windowStatus.set(window, 'failed')
    window.hide()
    if (kind === 'main') {
      this.connecting = false
      this.state = { ...EMPTY_STATE }
      this.message = message
      // Keep a recovery screen open before destroying the last remote window.
      this.showConnectionSettings()
      this.closeRemoteWindows()
      this.updateTray()
      this.pushLauncherState()
      return
    }
    const generation = this.connectGeneration
    const options: Electron.MessageBoxOptions = {
      type: 'error', title: 'HAKOBI', message: `${WINDOW_LABELS[kind]}を開けませんでした`,
      detail: `${message}\n下書きはこのPCに残っています。画面を開き直すことでも再試行できます。`,
      buttons: ['再試行', '閉じる'], defaultId: 0, cancelId: 1
    }
    const main = this.windows.get('main')
    const result = main && !main.isDestroyed() ? dialog.showMessageBox(main, options) : dialog.showMessageBox(options)
    void result.then(({ response }) => {
      if (response === 0 && !this.shuttingDown && generation === this.connectGeneration && this.windows.get(kind) === window && this.windowStatus.get(window) === 'failed') {
        this.createRemoteWindow(kind, this.pendingProgressTargets.get(window) ?? todoId)
      }
    }).catch((error) => console.error('[HAKOBI] 読み込みエラーの案内を表示できませんでした', error))
  }

  private remoteUrl(kind: WindowKind, todoId?: string): string {
    const url = new URL(this.config.profile!.url)
    const hashes: Record<WindowKind, string> = { main: '', timer: 'hakobi-timer', progress: 'hakobi-progress', gantt: 'gantt-only', report: 'task-report-only' }
    url.hash = hashes[kind] + (kind === 'progress' && todoId ? `?todo=${encodeURIComponent(todoId)}` : '')
    return url.toString()
  }

  private captureTimerGeometry(window = this.windows.get('timer')): void {
    if (!window || window.isDestroyed() || this.windows.get('timer') !== window) return
    const [width, height] = window.getSize()
    const compact = this.config.preferences.timerCompact
    const size = normalizeTimerSize(compact, { width, height })
    if (size) this.config.timerSizes = { ...this.config.timerSizes, [compact ? 'compact' : 'normal']: size }
    const [x, y] = window.getPosition()
    if (Number.isFinite(x) && Number.isFinite(y)) this.config.timerPosition = { x: Math.round(x), y: Math.round(y) }
  }

  private queueTimerGeometrySave(window: BrowserWindow): void {
    if (this.shuttingDown || this.windows.get('timer') !== window || window.isDestroyed()) return
    this.captureTimerGeometry(window)
    if (this.timerGeometrySaveTimeout) clearTimeout(this.timerGeometrySaveTimeout)
    this.timerGeometrySaveTimeout = setTimeout(() => this.flushTimerGeometry(), 250)
  }

  private flushTimerGeometry(persist = true): void {
    if (this.timerGeometrySaveTimeout) clearTimeout(this.timerGeometrySaveTimeout)
    this.timerGeometrySaveTimeout = null
    const timer = this.windows.get('timer')
    if (!timer || timer.isDestroyed()) return
    this.captureTimerGeometry(timer)
    if (persist) {
      try { writeDesktopConfig(this.config) }
      catch (error) { console.error('[HAKOBI] タイマーのサイズと位置を保存できませんでした', error) }
    }
  }

  private applyTimerGeometry(window: BrowserWindow): void {
    const [x, y] = window.getPosition()
    const [width, height] = window.getSize()
    const compact = this.config.preferences.timerCompact
    const layout = timerGeometry(compact, this.config.timerSizes?.[compact ? 'compact' : 'normal'],
      screen.getDisplayNearestPoint({ x, y }).workArea, { anchor: { x: x + width, y: y + height } })
    // Electron clamps setSize to the current minimum, so adjust it before changing modes.
    window.setMinimumSize(layout.minSize.width, layout.minSize.height)
    window.setMaximumSize(MAX_TIMER_SIZE.width, MAX_TIMER_SIZE.height)
    window.setBounds(layout.bounds)
  }

  private isGroupUrl(value: string): boolean {
    try { return new URL(value).origin === this.config.profile?.url } catch { return false }
  }

  private openExternal(url: string): void {
    try { if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url) } catch { /* Ignore unrecognized schemes. */ }
  }

  private openMain(todoId?: string): void {
    const window = this.createRemoteWindow('main')
    if (todoId) {
      const navigate = (): void => this.sendCommand({ type: 'navigate', todoId })
      if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', navigate)
      else navigate()
    }
  }

  private sendCommand(command: DesktopCommand): void {
    const main = this.windows.get('main')
    if (main && !main.isDestroyed()) main.webContents.send('hakobi:command', command)
  }

  private updatePreferences(patch: Partial<DesktopPreferences>): DesktopPreferences {
    const previous = this.config.preferences
    const next = { ...previous, ...validatePreferences(patch) }
    this.flushTimerGeometry(false)
    const shortcutsChanged = (['globalShortcutFocus', 'globalShortcutQuickAdd', 'globalShortcutExport', 'globalShortcutProgress'] as const).some((key) => previous[key] !== next[key])
    if (shortcutsChanged) this.registerRemoteShortcuts(next)
    try { writeDesktopConfig({ ...this.config, preferences: next }) }
    catch (error) {
      if (shortcutsChanged) this.registerRemoteShortcuts(previous)
      throw error
    }
    this.config.preferences = next
    const timer = this.windows.get('timer')
    if (timer && previous.timerCompact !== next.timerCompact) this.applyTimerGeometry(timer)
    timer?.setAlwaysOnTop(this.config.preferences.alwaysOnTop)
    if (!this.config.preferences.showTimer) timer?.hide()
    else if (this.state.userId && this.serverVersion >= 1) this.createRemoteWindow('timer')
    for (const window of this.windows.values()) window.webContents.send('hakobi:command', { type: 'preferences', preferences: this.config.preferences })
    this.updateTray()
    return this.config.preferences
  }

  private registerRemoteShortcuts(prefs = this.config.preferences, allowPartial = false): void {
    if (this.openedLocal || !this.config.profile) return
    const candidates: RemoteShortcut[] = [
      { action: 'globalShortcutFocus', key: prefs.globalShortcutFocus, label: 'メイン画面を開く', callback: () => this.openMain() },
      { action: 'globalShortcutQuickAdd', key: prefs.globalShortcutQuickAdd, label: 'タスクを追加', callback: () => { this.openMain(); this.sendCommand({ type: 'quick-add' }) } },
      { action: 'globalShortcutExport', key: prefs.globalShortcutExport, label: 'Markdownを書き出す', callback: () => { this.openMain(); this.sendCommand({ type: 'export' }) } },
      { action: 'globalShortcutProgress', key: prefs.globalShortcutProgress, label: '進捗をすぐ書く', callback: () => { if (this.state.userId && this.serverVersion >= 1) this.createRemoteWindow('progress', this.state.taskId ?? undefined) } }
    ]
    const entries = candidates.filter((entry) => entry.key)
    if (entries.length === this.activeShortcuts.length && entries.every((entry, index) => entry.action === this.activeShortcuts[index].action && entry.key === this.activeShortcuts[index].key)) return
    const previous = this.activeShortcuts
    globalShortcut.unregisterAll()
    let failed: RemoteShortcut | null = null
    const registered: RemoteShortcut[] = []
    const unavailable: RemoteShortcut[] = []
    try {
      for (const entry of entries) {
        failed = entry
        if (allowPartial) {
          try {
            if (globalShortcut.register(entry.key, entry.callback)) registered.push(entry)
            else unavailable.push(entry)
          } catch { unavailable.push(entry) }
        } else if (!globalShortcut.register(entry.key, entry.callback)) throw new Error('別のアプリで使われているか、他の操作と重複しています。')
      }
      this.activeShortcuts = allowPartial ? registered : entries
      if (unavailable.length) { failed = unavailable[0]; throw new Error('起動時に一部のキーを登録できませんでした。') }
    } catch {
      const unrestored: string[] = []
      if (allowPartial) this.activeShortcuts = registered
      else {
        globalShortcut.unregisterAll()
        this.activeShortcuts = []
        for (const entry of previous) {
          try {
            if (globalShortcut.register(entry.key, entry.callback)) this.activeShortcuts.push(entry)
            else unrestored.push(entry.key)
          } catch { unrestored.push(entry.key) }
        }
      }
      const message = allowPartial
        ? unavailable.map((entry) => `「${entry.label}」のショートカット（${entry.key}）を登録できませんでした。`).join('\n')
        : `「${failed?.label ?? '操作'}」のショートカット（${failed?.key ?? ''}）を登録できませんでした。`
      const detail = `別のアプリで使われているか、キーの形式が正しくないか、他の操作と重複しています。設定は変更していません。${allowPartial ? '登録できたほかのキーは使用できます。' : ''}別のキーを選んでください。${unrestored.length ? `\n以前のキー（${unrestored.join('、')}）も復元できませんでした。設定画面で変更してください。` : ''}`
      const options: Electron.MessageBoxOptions = { type: 'warning', title: 'HAKOBI — ショートカット設定', message, detail, buttons: ['閉じる'] }
      const main = this.windows.get('main')
      const result = main && !main.isDestroyed() ? dialog.showMessageBox(main, options) : dialog.showMessageBox(options)
      void result.catch((error) => console.error('[HAKOBI] ショートカットの案内を表示できませんでした', error))
      throw new Error(`${message} ${detail}`)
    }
  }

  private createRemoteTray(): void {
    if (!this.tray) {
      this.tray = new Tray(defaultIcon())
      this.tray.on('click', () => this.openMain())
      this.trayTick = setInterval(() => this.updateTrayTooltip(), 1000)
    }
    this.updateTray()
  }

  private taskLabel(): string {
    return this.state.taskId ? this.config.preferences.hideTaskTitle ? '作業中' : this.state.taskTitle || '作業中' : 'タイマー停止中'
  }

  private updateTrayTooltip(): void {
    if (!this.tray) return
    const elapsed = this.state.startTime ? Math.max(0, Math.floor((Date.now() + (this.state.clockOffsetMs ?? 0) - Date.parse(this.state.startTime)) / 1000)) : 0
    const clock = `${Math.floor(elapsed / 3600)}:${String(Math.floor(elapsed / 60) % 60).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
    this.tray.setToolTip(`HAKOBI | ${this.config.profile?.name}\n${this.taskLabel()}${this.state.taskId ? ` ${clock}` : ''}${this.state.online ? '' : '（接続確認中）'}`.slice(0, 120))
  }

  private updateTray(): void {
    if (!this.tray) return
    this.updateTrayTooltip()
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: `HAKOBI — ${this.config.profile?.name}`, enabled: false },
      { label: this.taskLabel().slice(0, 60), enabled: false },
      { type: 'separator' },
      { label: 'メイン画面を開く', click: () => this.openMain() },
      { label: '右下タイマーを表示', enabled: !!this.state.userId && this.serverVersion >= 1, click: () => this.updatePreferences({ showTimer: true }) },
      { label: '進捗をすぐ書く', enabled: !!this.state.userId && this.serverVersion >= 1, click: () => this.createRemoteWindow('progress', this.state.taskId ?? undefined) },
      { label: '接続先を変更', click: () => this.showConnectionSettings() },
      ...(this.serverVersion < 1 ? [{ label: '追加機能にはサーバーの更新が必要です', enabled: false }] : []),
      { type: 'separator' },
      { label: 'HAKOBIを終了', click: () => app.quit() }
    ]))
  }

  private assertRemote(event: IpcMainInvokeEvent): WindowKind {
    const entry = [...this.windows.entries()].find(([, window]) => window.webContents === event.sender)
    if (!entry || event.senderFrame !== event.sender.mainFrame || !this.isGroupUrl(event.senderFrame.url)) throw new Error('許可されていない画面です。')
    return entry[0]
  }

  private assertLauncher(event: IpcMainInvokeEvent): void {
    if (!this.launcher || this.launcher.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('許可されていない画面です。')
    const url = new URL(event.senderFrame.url)
    const dev = is.dev && process.env['ELECTRON_RENDERER_URL'] ? new URL(process.env['ELECTRON_RENDERER_URL']).origin : null
    if (!(url.protocol === 'file:' || url.origin === dev) || url.hash !== '#hakobi-launcher') throw new Error('許可されていない画面です。')
  }

  private validId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value)
  }

  private registerBridge(): void {
    const remote = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => { this.assertRemote(event); return handler(event, ...args) })
    }
    remote('hakobi:context', (): DesktopContext => ({ version: 1, serverVersion: this.serverVersion,
      groupName: this.config.profile!.name, serverUrl: this.config.profile!.url, preferences: this.config.preferences }))
    remote('hakobi:preferences', (_event, patch) => this.updatePreferences(patch))
    remote('hakobi:main', (_event, todoId) => { if (todoId !== undefined && !this.validId(todoId)) throw new Error('タスクが不正です。'); this.openMain(todoId) })
    remote('hakobi:timer', () => { if (this.serverVersion >= 1 && this.state.userId) this.updatePreferences({ showTimer: true }) })
    remote('hakobi:progress', (_event, todoId) => {
      if (todoId !== undefined && !this.validId(todoId)) throw new Error('タスクが不正です。')
      if (this.serverVersion >= 1 && this.state.userId) this.createRemoteWindow('progress', todoId ?? this.state.taskId ?? undefined)
    })
    remote('hakobi:gantt', () => { this.createRemoteWindow('gantt') })
    remote('hakobi:report', () => { this.createRemoteWindow('report') })
    remote('hakobi:connection', () => this.showConnectionSettings())
    remote('hakobi:hide', (event) => {
      const kind = this.assertRemote(event)
      this.windows.get(kind)?.hide()
      if (kind === 'timer') this.updatePreferences({ showTimer: false })
    })
    remote('hakobi:resize-timer', (event, compact) => {
      if (this.assertRemote(event) !== 'timer' || typeof compact !== 'boolean') throw new Error('操作が不正です。')
      this.updatePreferences({ timerCompact: compact })
    })
    remote('hakobi:state', (event, state: DesktopState) => {
      if (this.assertRemote(event) !== 'main') return
      if (!state || typeof state.online !== 'boolean' || typeof state.taskTitle !== 'string' || state.taskTitle.length > 1000 ||
          (state.userId !== null && !this.validId(state.userId)) || (state.taskId !== null && !this.validId(state.taskId)) ||
          (state.clockOffsetMs !== undefined && (typeof state.clockOffsetMs !== 'number' || !Number.isFinite(state.clockOffsetMs) || !Number.isFinite(new Date(Date.now() + state.clockOffsetMs).getTime()))) ||
          (state.startTime !== null && (typeof state.startTime !== 'string' || !Number.isFinite(Date.parse(state.startTime))))) throw new Error('状態が不正です。')
      const signedOut = this.state.userId && !state.userId
      const menuChanged = this.state.userId !== state.userId || this.state.taskId !== state.taskId || this.state.taskTitle !== state.taskTitle || this.state.startTime !== state.startTime || this.state.online !== state.online
      this.state = { ...state, clockOffsetMs: state.clockOffsetMs ?? 0 }
      if (signedOut) {
        this.flushTimerGeometry()
        for (const kind of ['timer', 'progress', 'gantt', 'report'] as const) this.windows.get(kind)?.destroy()
      } else if (state.userId && this.config.preferences.showTimer && this.serverVersion >= 1 && !this.windows.has('timer')) {
        this.createRemoteWindow('timer')
      }
      if (menuChanged) this.updateTray()
      else this.updateTrayTooltip()
    })
    const launcher = (channel: string, handler: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => { this.assertLauncher(event); return handler(...args) })
    }
    launcher('hakobi-launcher:state', () => this.launcherState())
    launcher('hakobi-launcher:connect', (profile) => this.connect(profile))
    launcher('hakobi-launcher:retry', () => this.config.profile ? this.connect(this.config.profile) : undefined)
    launcher('hakobi-launcher:cancel', () => { if (this.launcherState().canCancel && !this.connecting) this.launcher?.close() })
    launcher('hakobi-launcher:local', () => {
      if (this.connecting) return
      this.config.mode = 'local'
      writeDesktopConfig(this.config)
      if (this.windows.size || this.openedLocal) this.restart()
      else {
        this.openedLocal = true
        this.startLocal()
        this.launcher?.destroy()
        this.launcher = null
      }
    })
  }
}
