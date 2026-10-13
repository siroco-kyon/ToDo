const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-desktop-test-'))
const instances = []

async function buildModules() {
  const result = await build({
    stdin: {
      contents: "export { DesktopController } from './desktop-controller'; export * from './desktop-config'; export { parseLaunchAction } from './windows-branding'; export { badgeLabel, badgePixels, glyphPixels } from './desktop-glyphs'",
      resolveDir: path.join(root, 'src/main'), loader: 'ts'
    }, platform: 'node', format: 'cjs', bundle: true, packages: 'external', write: false,
    plugins: [{
      name: 'native-test-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
        builder.onResolve({ filter: /^@electron-toolkit\/utils$/ }, () => ({ path: 'toolkit', namespace: 'mock' }))
        builder.onResolve({ filter: /^\.\/(db|config)$/ }, (args) => {
          if (args.importer.endsWith(`${path.sep}icon.ts`)) return { path: args.path, namespace: 'mock' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: args.path === 'electron'
            ? 'module.exports = globalThis.__hakobiHarness.electron'
            : args.path === 'toolkit'
              ? 'export const is = { dev: false }'
              : args.path === './db'
                ? 'export function getSetting() { globalThis.__hakobiHarness.localDbCalls++; throw new Error("Local DB is unavailable in team mode") }; export const setSetting = getSetting'
                : 'export function getDataDir() { globalThis.__hakobiHarness.localDbCalls++; throw new Error("Local data directory is unavailable in team mode") }',
          loader: 'js'
        }))
      }
    }]
  })
  return result.outputFiles[0].text
}

function makeHarness(code, options = {}) {
  const userData = options.userData ?? fs.mkdtempSync(path.join(temporary, 'profile-'))
  if (options.saved) fs.writeFileSync(path.join(userData, 'hakobi-desktop.json'), JSON.stringify(options.saved))
  if (options.legacy) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ dataDir: 'existing-personal-data' }))
  const harness = {
    userData, windows: [], sessions: new Map(), handlers: new Map(), requests: [], shortcuts: new Map(),
    external: [], trays: [], localDbCalls: 0, localStarts: 0, localReveals: 0, quits: 0, relaunches: 0,
    dialogs: [], dialogResponses: [], deferredLoads: new Map(), timers: new Map(), nextTimer: 1,
    blockedShortcuts: new Set(), invalidShortcuts: new Set(), shortcutRegistrations: 0,
    notifications: [], notificationsSupported: true, badgeCounts: [], userTasks: [],
    workArea: options.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 },
    response: options.health ?? { ok: true, desktopProtocol: 1, webReady: true }
  }

  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: 'about:blank' }; this.sent = []; this.loading = false }
    send(channel, value) { this.sent.push({ channel, value }) }
    setWindowOpenHandler(handler) { this.openHandler = handler }
    isLoadingMainFrame() { return this.loading }
  }
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.webContents = new Contents(); this.destroyed = false
      this.visible = false; this.position = [0, 0]; this.size = [settings.width, settings.height]; this.loads = []
      this.minimumSize = [settings.minWidth ?? 0, settings.minHeight ?? 0]
      this.maximumSize = [settings.maxWidth ?? Infinity, settings.maxHeight ?? Infinity]
      harness.windows.push(this)
    }
    loadURL(url) {
      this.loads.push(url)
      this.webContents.mainFrame.url = url
      this.webContents.loading = true
      const remote = url.startsWith('http')
      if (remote && (typeof harness.failLoad === 'function' ? harness.failLoad(url) : harness.failLoad)) {
        this.webContents.loading = false
        return Promise.reject(new Error('load failed'))
      }
      const finish = () => {
        if (this.destroyed) return
        this.webContents.loading = false
        this.webContents.emit('did-finish-load')
        this.emit('ready-to-show')
      }
      if (remote && harness.deferRemoteLoad) {
        return new Promise((resolve, reject) => harness.deferredLoads.set(this, {
          finish: () => { harness.deferredLoads.delete(this); finish(); resolve() }, reject
        }))
      }
      queueMicrotask(finish)
      return Promise.resolve()
    }
    loadFile(file, { hash }) { return this.loadURL(`${pathToFileURL(file)}#${hash}`) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    restore() { this.visible = true }
    show() { if (!this.visible) { this.visible = true; this.emit('show') } }
    showInactive() { this.show() }
    hide() { this.visible = false }
    focus() { this.focused = true }
    isVisible() { return this.visible }
    isFocused() { return !!this.focused }
    flashFrame(flag) { this.flashing = flag }
    setOverlayIcon(image, description) { this.overlay = { image, description } }
    setThumbarButtons(buttons) { this.thumbar = buttons; return true }
    setAppDetails(details) { this.appDetails = details }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true; this.visible = false; this.emit('closed')
        harness.deferredLoads.get(this)?.reject(new Error('load aborted'))
        harness.deferredLoads.delete(this)
      }
    }
    close() {
      let prevented = false
      this.emit('close', { preventDefault() { prevented = true } })
      if (!prevented) this.destroy()
    }
    getPosition() { return this.position }
    setPosition(x, y) { this.position = [x, y] }
    getSize() { return this.size }
    setSize(width, height) {
      const next = [Math.min(this.maximumSize[0], Math.max(this.minimumSize[0], width)),
        Math.min(this.maximumSize[1], Math.max(this.minimumSize[1], height))]
      if (next[0] !== this.size[0] || next[1] !== this.size[1]) {
        this.size = next
        this.emit('resize')
        this.emit('resized')
      }
    }
    setMinimumSize(width, height) { this.minimumSize = [width, height] }
    getMinimumSize() { return this.minimumSize }
    setMaximumSize(width, height) { this.maximumSize = [width, height] }
    getMaximumSize() { return this.maximumSize }
    isResizable() { return this.settings.resizable !== false }
    getBounds() { return { x: this.position[0], y: this.position[1], width: this.size[0], height: this.size[1] } }
    setBounds(bounds) {
      if (bounds.x !== undefined || bounds.y !== undefined) this.setPosition(bounds.x ?? this.position[0], bounds.y ?? this.position[1])
      if (bounds.width !== undefined || bounds.height !== undefined) this.setSize(bounds.width ?? this.size[0], bounds.height ?? this.size[1])
    }
    setAlwaysOnTop(value) { this.onTop = value }
  }
  class MockTray extends EventEmitter {
    constructor() { super(); harness.trays.push(this) }
    setToolTip(value) { this.tooltip = value }
    setContextMenu(value) { this.menu = value; this.menuUpdates = (this.menuUpdates ?? 0) + 1 }
    setImage(image) { this.image = image }
    destroy() { this.destroyed = true }
  }
  class MockNotification extends EventEmitter {
    static isSupported() { return harness.notificationsSupported }
    constructor(options) { super(); this.options = options; harness.notifications.push(this) }
    show() { this.shown = true }
  }
  harness.electron = {
    app: {
      getPath: () => userData, isQuitting: false, isPackaged: true, getAppPath: () => root,
      quit: () => harness.quits++, relaunch: () => harness.relaunches++,
      setBadgeCount: (count) => { harness.badgeCounts.push(count); return true },
      setUserTasks: (tasks) => { harness.userTasks.push(tasks); return true }
    },
    BrowserWindow: Window, Tray: MockTray, Notification: MockNotification,
    ipcMain: { handle: (channel, handler) => harness.handlers.set(channel, handler) },
    globalShortcut: {
      register: (key, callback) => {
        harness.shortcutRegistrations++
        if (harness.invalidShortcuts.has(key)) throw new Error('invalid accelerator')
        const normalize = (value) => value.toLowerCase().replaceAll('commandorcontrol', 'ctrl').replaceAll('control', 'ctrl').replaceAll(' ', '')
        if (harness.blockedShortcuts.has(key) || [...harness.shortcuts.keys()].some((registered) => normalize(registered) === normalize(key))) return false
        harness.shortcuts.set(key, callback)
        return true
      },
      unregisterAll: () => harness.shortcuts.clear()
    },
    nativeImage: {
      createFromBuffer: (buffer) => { assert.ok(buffer.length > 0); return { isEmpty: () => false, png: buffer } }
    },
    Menu: { buildFromTemplate: (template) => template },
    dialog: { showMessageBox: async (...args) => {
      harness.dialogs.push(args.at(-1))
      return { response: harness.dialogResponses.shift() ?? 1 }
    } },
    screen: {
      getPrimaryDisplay: () => ({ workArea: harness.workArea }),
      getDisplayNearestPoint: () => ({ workArea: harness.workArea }),
      getDisplayMatching: () => ({ workArea: harness.workArea })
    },
    shell: { openExternal: async (url) => harness.external.push(url) },
    session: { fromPartition: (partition) => {
      if (!harness.sessions.has(partition)) harness.sessions.set(partition, {
        setPermissionRequestHandler(callback) { this.permissionRequest = callback },
        setPermissionCheckHandler(callback) { this.permissionCheck = callback }
      })
      return harness.sessions.get(partition)
    } },
    net: { fetch: async (url, init) => {
      harness.requests.push({ url, init })
      const health = typeof harness.response === 'function' ? await harness.response() : harness.response
      if (health instanceof Error) throw health
      return { ok: true, status: 200, json: async () => health }
    } }
  }
  const module = { exports: {} }
  const context = vm.createContext({
    __hakobiHarness: harness, module, exports: module.exports, require, __dirname: path.join(root, 'out/main'),
    Buffer, URL, AbortController, console, Date,
    process: { env: {}, platform: options.platform, execPath: 'C:\\Program Files\\HAKOBI\\HAKOBI.exe' },
    setTimeout: (callback, ms) => { const id = harness.nextTimer++; harness.timers.set(id, { callback, ms }); return id },
    clearTimeout: (id) => harness.timers.delete(id),
    setInterval: () => 1, clearInterval: () => {}
  })
  vm.runInContext(code, context, { filename: 'hakobi-test-bundle.cjs' })
  harness.api = module.exports
  harness.controller = new harness.api.DesktopController(() => harness.localStarts++, () => harness.localReveals++)
  harness.live = (hash = '') => harness.windows.find((window) => !window.destroyed && new URL(window.webContents.mainFrame.url).hash === hash)
  harness.event = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
  harness.invoke = (channel, window, ...args) => harness.handlers.get(channel)(harness.event(window), ...args)
  harness.readSaved = () => JSON.parse(fs.readFileSync(path.join(userData, 'hakobi-desktop.json'), 'utf8'))
  harness.fireTimeout = (ms) => {
    for (const [id, timeout] of [...harness.timers]) {
      if (timeout.ms === ms) { harness.timers.delete(id); timeout.callback() }
    }
  }
  instances.push(harness)
  return harness
}

async function flush() { await new Promise((resolve) => setImmediate(resolve)) }

async function connect(harness, name = '開発チーム', url = 'http://team.local:4577') {
  harness.controller.start()
  const launcher = harness.live('#hakobi-launcher')
  await harness.invoke('hakobi-launcher:connect', launcher, { name, url })
  await flush()
  return harness.live()
}

async function testTimerSizing(code, profile) {
  const account = { userId: 'timer-size-user', taskId: null, taskTitle: '', startTime: null, online: true }
  async function open(harness) {
    harness.controller.start()
    await flush()
    const mainWindow = harness.live()
    await harness.invoke('hakobi:state', mainWindow, account)
    await flush()
    return { mainWindow, timer: harness.live('#hakobi-timer') }
  }
  const sizing = makeHarness(code, { saved: { mode: 'server', profile, preferences: { showTimer: true } } })
  let { mainWindow, timer } = await open(sizing)
  assert.equal(sizing.readSaved().preferences.timerCompact, false, 'legacy preferences must start with the normal timer')
  assert.equal(timer.isResizable(), true, 'timer borders must allow manual resizing')
  assert.deepEqual(timer.getSize(), [360, 250])
  assert.deepEqual(timer.getMinimumSize(), [320, 240])
  assert.throws(() => sizing.invoke('hakobi:resize-timer', mainWindow, true), /不正/)
  for (const invalid of [undefined, null, 1, 'true', {}]) {
    assert.throws(() => sizing.invoke('hakobi:resize-timer', timer, invalid), /不正/)
  }
  timer.setSize(30, 20)
  assert.deepEqual(timer.getSize(), [320, 240], 'the mock must enforce Electron native minimum dimensions')
  timer.setSize(430, 290)
  await sizing.invoke('hakobi:resize-timer', timer, true)
  assert.deepEqual(timer.getSize(), [320, 150], 'compact must shrink below the normal minimum height')
  assert.deepEqual(timer.getMinimumSize(), [300, 150])
  assert.equal(sizing.readSaved().preferences.timerCompact, true)
  timer.setSize(345, 170)
  await sizing.invoke('hakobi:resize-timer', timer, false)
  assert.deepEqual(timer.getSize(), [430, 290], 'switching modes must restore the last manually resized normal dimensions')
  assert.deepEqual(timer.getMinimumSize(), [320, 240])
  await sizing.invoke('hakobi:resize-timer', timer, true)
  assert.deepEqual(timer.getSize(), [345, 170], 'switching back must restore independent compact dimensions')
  assert.deepEqual(sizing.readSaved().timerSizes, { normal: { width: 430, height: 290 }, compact: { width: 345, height: 170 } })
  timer.destroy()
  await sizing.invoke('hakobi:timer', mainWindow)
  await flush()
  timer = sizing.live('#hakobi-timer')
  assert.deepEqual(timer.getSize(), [345, 170], 'recreating the timer must preserve the chosen compact mode and size')
  sizing.controller.dispose()
  for (const window of sizing.windows) window.destroy()
  const restarted = makeHarness(code, { userData: sizing.userData })
  const restartedWindows = await open(restarted)
  assert.deepEqual(restartedWindows.timer.getSize(), [345, 170], 'restart must read the compact mode and its custom dimensions from disk')
  await restarted.invoke('hakobi:resize-timer', restartedWindows.timer, false)
  assert.deepEqual(restartedWindows.timer.getSize(), [430, 290], 'restart must preserve the independent normal dimensions')

  const corrupt = makeHarness(code, { saved: { mode: 'server', profile,
    preferences: { showTimer: true, timerCompact: true },
    timerSizes: { normal: { width: 'invalid', height: 250 }, compact: { width: -10, height: 0 } },
    timerPosition: { x: 100000000, y: -100000000 } } })
  const corruptWindows = await open(corrupt)
  assert.deepEqual(corruptWindows.timer.getSize(), [320, 150], 'invalid saved dimensions must fall back to usable defaults')
  assert.equal(corrupt.readSaved().profile.id, profile.id, 'invalid timer dimensions must not discard the group connection')
  const workArea = { x: -450, y: 100, width: 280, height: 180 }
  const smallDisplay = makeHarness(code, { workArea, saved: { mode: 'server', profile,
    preferences: { showTimer: true }, timerPosition: { x: -100000, y: 100000 },
    timerSizes: { normal: { width: 100000, height: 100000 }, compact: { width: 100000, height: 100000 } } } })
  const smallWindows = await open(smallDisplay)
  const assertFits = () => {
    const [width, height] = smallWindows.timer.getSize()
    const [x, y] = smallWindows.timer.getPosition()
    assert.ok(width <= workArea.width && height <= workArea.height, 'timer dimensions must fit a work area smaller than the usual minimum')
    assert.ok(x >= workArea.x && y >= workArea.y && x + width <= workArea.x + workArea.width && y + height <= workArea.y + workArea.height,
      'invalid saved positions and oversized dimensions must remain inside the selected display')
  }
  assertFits()
  await smallDisplay.invoke('hakobi:resize-timer', smallWindows.timer, true)
  assertFits()
  console.log('PASS timer geometry: compact shrink, native minima, manual resizing, independent saved sizes, restart, invalid IPC/config and small display bounds')
}

const labels = (tray) => tray.menu.map((item) => item.label)
const menuItem = (tray, label) => tray.menu.find((item) => item.label === label)
// Objects created inside the VM have another realm's prototypes, so compare their JSON shape.
const plain = (value) => JSON.parse(JSON.stringify(value))
const commandsOf = (window) => plain(window.webContents.sent.filter((entry) => entry.channel === 'hakobi:command').map((entry) => entry.value))
const signedInState = { userId: 'user-1', taskId: null, taskTitle: '', startTime: null, online: true }

async function signIn(harness, state = {}) {
  harness.controller.start()
  await flush()
  const mainWindow = harness.live()
  await harness.invoke('hakobi:state', mainWindow, { ...signedInState, ...state })
  await flush()
  return mainWindow
}

async function testNativeIntegration(code, profile) {
  const saved = { mode: 'server', profile, preferences: { showTimer: false } }
  const recentTasks = [{ id: 'task-a', title: '設計 & レビュー' }, { id: 'task-b', title: '見積もり' }]

  const mac = makeHarness(code, { platform: 'darwin', saved })
  const macMain = await signIn(mac, { recentTasks, unreadCount: 2 })
  let tray = mac.trays[0]
  assert.ok(labels(tray).includes('計測を開始する'))
  assert.ok(labels(tray).includes('　設計 & レビュー'), 'only Windows menus need the mnemonic escape')
  assert.ok(!labels(tray).includes('計測を停止'))
  assert.ok(labels(tray).includes('通知を見る（未読 2件）'))
  assert.match(tray.tooltip, /未読の通知 2件/)
  const dot = tray.image
  assert.ok(dot, 'unread notifications must mark the tray icon')
  assert.deepEqual(mac.badgeCounts, [2])
  menuItem(tray, '　見積もり').click()
  assert.deepEqual(commandsOf(macMain).at(-1), { type: 'timer-start', todoId: 'task-b' })
  macMain.hide()
  menuItem(tray, '通知を見る（未読 2件）').click()
  await flush()
  assert.equal(macMain.visible, true)
  assert.deepEqual(commandsOf(macMain).at(-1), { type: 'open-notification' })
  const toggle = menuItem(tray, 'デスクトップに通知を表示')
  assert.equal(toggle.type, 'checkbox')
  assert.equal(toggle.checked, true)
  toggle.click()
  assert.equal(mac.readSaved().preferences.showNotifications, false)
  assert.equal(menuItem(mac.trays[0], 'デスクトップに通知を表示').checked, false)
  menuItem(mac.trays[0], 'デスクトップに通知を表示').click()

  await mac.invoke('hakobi:state', macMain, { ...signedInState, taskId: 'task-c', taskTitle: '実装', startTime: new Date().toISOString(), recentTasks, unreadCount: 0 })
  tray = mac.trays[0]
  assert.ok(labels(tray).includes('別のタスクに切り替える'))
  menuItem(tray, '計測を停止').click()
  assert.deepEqual(commandsOf(macMain).at(-1), { type: 'timer-stop' })
  assert.ok(labels(tray).includes('通知を見る'))
  assert.notEqual(tray.image, dot, 'reading every notification must restore the plain tray icon')
  assert.deepEqual(mac.badgeCounts, [2, 0])
  assert.doesNotMatch(tray.tooltip, /未読/)

  for (const invalid of [{ recentTasks: 'task-a' }, { recentTasks: [{ id: '', title: 'x' }] }, { recentTasks: [{ id: 'a\nb', title: 'x' }] },
    { recentTasks: [{ id: 'a', title: 1 }] }, { recentTasks: [null] }, { recentTasks: Array.from({ length: 21 }, (_, index) => ({ id: `t${index}`, title: 'x' })) },
    { unreadCount: -1 }, { unreadCount: 1.5 }, { unreadCount: '3' }]) {
    assert.throws(() => mac.invoke('hakobi:state', macMain, { ...signedInState, ...invalid }), /不正/)
  }
  await mac.invoke('hakobi:state', macMain, { ...signedInState, unreadCount: 0,
    recentTasks: Array.from({ length: 7 }, (_, index) => ({ id: `t${index}`, title: `タスク${index}`, extra: 'dropped' })) })
  assert.equal(mac.trays[0].menu.filter((item) => item.label?.startsWith('　')).length, 5, 'a newer Web UI sending more tasks is trimmed, not refused')
  await mac.invoke('hakobi:state', macMain, signedInState)
  assert.ok(['計測を開始する', '通知を見る', 'デスクトップに通知を表示'].every((label) => !labels(mac.trays[0]).includes(label)),
    'an older Web UI without these fields keeps the previous menu')

  const notifier = makeHarness(code, { saved })
  const notifierMain = await signIn(notifier, { recentTasks: [], unreadCount: 1 })
  const valid = { notificationId: 'note-1', title: '進捗に返信がありました', body: '「設計」の進捗に返信がありました（山田）' }
  await notifier.invoke('hakobi:notify', notifierMain, valid)
  assert.equal(notifier.notifications.length, 1)
  const toast = notifier.notifications[0]
  assert.equal(toast.shown, true)
  assert.equal(toast.options.title, valid.title)
  assert.equal(toast.options.body, valid.body)
  assert.equal(notifierMain.flashing, true, 'a visible but unfocused main window draws attention')
  notifierMain.emit('focus')
  assert.equal(notifierMain.flashing, false)
  notifierMain.hide()
  toast.emit('click')
  await flush()
  assert.equal(notifierMain.visible, true, 'clicking a notification opens the main window')
  assert.deepEqual(commandsOf(notifierMain).at(-1), { type: 'open-notification', notificationId: 'note-1' })
  notifierMain.focused = true
  await notifier.invoke('hakobi:notify', notifierMain, { ...valid, notificationId: 'note-2' })
  assert.equal(notifier.notifications.length, 1, 'the in-app bell is enough while the main window has focus')
  notifierMain.focused = false
  for (const invalid of [null, { title: '', body: '' }, { title: ' ', body: 'x' }, { title: 'x'.repeat(201), body: '' }, { title: 'x', body: 1 },
    { title: 'x', body: 'y'.repeat(1001) }, { title: 'x', body: 'y', notificationId: 'a\nb' }, { title: 'x', body: 'y', notificationId: '' }]) {
    assert.throws(() => notifier.invoke('hakobi:notify', notifierMain, invalid), /不正/)
  }
  await notifier.invoke('hakobi:timer', notifierMain)
  await flush()
  const notifierTimer = notifier.live('#hakobi-timer')
  await notifier.invoke('hakobi:notify', notifierTimer, valid)
  await notifier.invoke('hakobi:error', notifierTimer, '別の画面からのエラー')
  assert.equal(notifier.notifications.length, 1, 'only the main window publishes notifications')
  assert.equal(notifier.dialogs.length, 0)
  await notifier.invoke('hakobi:error', notifierMain, '計測を開始できませんでした。保留中のタスクです')
  assert.equal(notifier.dialogs.at(-1).message, '計測を開始できませんでした。保留中のタスクです')
  assert.throws(() => notifier.invoke('hakobi:error', notifierMain, ''), /不正/)
  assert.throws(() => notifier.invoke('hakobi:error', notifierMain, 'x'.repeat(501)), /不正/)
  await notifier.invoke('hakobi:preferences', notifierMain, { showNotifications: false })
  await notifier.invoke('hakobi:notify', notifierMain, { ...valid, notificationId: 'note-3' })
  assert.equal(notifier.notifications.length, 1, 'the PC setting turns OS notifications off')
  await notifier.invoke('hakobi:preferences', notifierMain, { showNotifications: true })
  notifier.notificationsSupported = false
  await notifier.invoke('hakobi:notify', notifierMain, { ...valid, notificationId: 'note-4' })
  assert.equal(notifier.notifications.length, 1)
  notifier.notificationsSupported = true
  notifier.controller.showConnectionSettings()
  await notifier.invoke('hakobi-launcher:connect', notifier.live('#hakobi-launcher'), { name: '営業チーム', url: 'http://team.local:4578' })
  await flush()
  const nextGroupMain = notifier.live()
  toast.emit('click')
  await flush()
  assert.ok(!commandsOf(nextGroupMain).some((command) => command.type === 'open-notification'), 'a previous group notification must not open an ID on the new server')
  await notifier.invoke('hakobi:notify', nextGroupMain, valid)
  assert.equal(notifier.notifications.length, 1, 'notifications wait for the new group sign-in')

  const burst = makeHarness(code, { saved })
  const burstMain = await signIn(burst, { unreadCount: 0 })
  for (let index = 0; index < 8; index++) await burst.invoke('hakobi:notify', burstMain, { ...valid, notificationId: `burst-${index}` })
  assert.equal(burst.notifications.length, 5, 'a misbehaving page cannot flood the desktop')

  const win = makeHarness(code, { platform: 'win32', saved })
  const winMain = await signIn(win, { recentTasks, unreadCount: 3 })
  assert.deepEqual(plain(win.userTasks.at(-1)).map((task) => task.arguments), ['--hakobi-action=quick-add', '--hakobi-action=progress', '--hakobi-action=timer'])
  assert.ok(win.userTasks.at(-1).every((task) => task.program === 'C:\\Program Files\\HAKOBI\\HAKOBI.exe' && task.title && task.description))
  assert.equal(winMain.overlay.description, '未読の通知 3件')
  assert.ok(winMain.overlay.image)
  assert.deepEqual(win.badgeCounts, [], 'Windows uses the taskbar overlay instead of a dock badge')
  assert.ok(labels(win.trays[0]).includes('　設計 && レビュー'), 'Windows menus must not turn & into a mnemonic')
  assert.deepEqual(plain(winMain.thumbar.map((button) => button.tooltip)), ['「設計 & レビュー」の計測を開始', '進捗をすぐ書く', 'タスクを追加'])
  winMain.thumbar[0].click()
  assert.deepEqual(commandsOf(winMain).at(-1), { type: 'timer-start', todoId: 'task-a' })
  winMain.thumbar[2].click()
  await flush()
  assert.deepEqual(commandsOf(winMain).at(-1), { type: 'quick-add' })
  winMain.thumbar[1].click()
  await flush()
  const winProgress = win.live('#hakobi-progress')
  assert.ok(winProgress)
  assert.equal(winProgress.overlay.description, '未読の通知 3件', 'a newly shown window gets the current badge')
  await win.invoke('hakobi:state', winMain, { ...signedInState, taskId: 'task-c', taskTitle: '実装', startTime: new Date().toISOString(), recentTasks, unreadCount: 12 })
  assert.equal(winMain.thumbar[0].tooltip, '計測を停止')
  winMain.thumbar[0].click()
  assert.deepEqual(commandsOf(winMain).at(-1), { type: 'timer-stop' })
  assert.equal(winProgress.overlay.description, '未読の通知 12件')
  await win.invoke('hakobi:preferences', winMain, { hideTaskTitle: true })
  await win.invoke('hakobi:state', winMain, { ...signedInState, recentTasks, unreadCount: 12 })
  assert.equal(winMain.thumbar[0].tooltip, '直前のタスクで計測を開始', 'the taskbar tooltip respects the hidden task title setting')
  await win.invoke('hakobi:state', winMain, { ...signedInState, recentTasks: [], unreadCount: 0 })
  assert.deepEqual(plain(winMain.thumbar[0].flags), ['disabled'])
  assert.deepEqual(plain(winMain.overlay), { image: null, description: '' })
  await win.invoke('hakobi:state', winMain, signedInState)
  assert.deepEqual(plain(winMain.thumbar), [], 'an older Web UI cannot run taskbar timer commands')

  const launching = makeHarness(code, { platform: 'win32', saved })
  launching.controller.start()
  launching.controller.runLaunchAction('progress')
  await flush()
  const launchMain = launching.live()
  assert.equal(launching.live('#hakobi-progress'), undefined, 'the action waits for sign-in')
  await launching.invoke('hakobi:state', launchMain, signedInState)
  await flush()
  assert.ok(launching.live('#hakobi-progress'), 'a jump list action that started the app runs after sign-in')
  launching.live('#hakobi-progress').destroy()
  await launching.invoke('hakobi:state', launchMain, { ...signedInState, online: false })
  assert.equal(launching.live('#hakobi-progress'), undefined, 'a launch action runs once')
  launching.controller.runLaunchAction('quick-add')
  await flush()
  assert.deepEqual(commandsOf(launchMain).at(-1), { type: 'quick-add' })
  launching.controller.runLaunchAction('timer')
  await flush()
  assert.ok(launching.live('#hakobi-timer'))
  assert.equal(launching.readSaved().preferences.showTimer, true)

  const personal = makeHarness(code, { platform: 'win32', legacy: true })
  personal.controller.start()
  assert.deepEqual(plain(personal.userTasks), [[]], 'personal mode clears the team jump list')
  personal.controller.runLaunchAction('quick-add')
  assert.equal(personal.localReveals, 1)

  const { parseLaunchAction, badgeLabel, badgePixels, glyphPixels } = win.api
  assert.equal(parseLaunchAction(['C:\\HAKOBI\\HAKOBI.exe', '--hakobi-action=quick-add']), 'quick-add')
  for (const argv of [['--hakobi-action=toString'], ['--hakobi-action=__proto__'], ['--hakobi-action=delete-all'], ['--hakobi-action'], []]) {
    assert.equal(parseLaunchAction(argv), null, `unexpected action accepted: ${argv}`)
  }
  assert.deepEqual([1, 9, 10, 250].map(badgeLabel), ['1', '9', '9+', '9+'])
  const pixel = (rgba, x, y) => Array.from(rgba.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4))
  assert.deepEqual(pixel(badgePixels(1), 16, 16), [255, 255, 255, 255], 'the digit is drawn in white')
  assert.deepEqual(pixel(badgePixels(1), 11, 16), [220, 38, 38, 255], 'around the digit is the red badge')
  assert.equal(pixel(badgePixels(1), 0, 0)[3], 0)
  assert.notDeepEqual(badgePixels(3), badgePixels(4))
  for (const glyph of ['start', 'stop', 'progress', 'add']) assert.equal(pixel(glyphPixels(glyph), 0, 0)[3], 0, `${glyph} needs transparent corners`)
  assert.deepEqual(pixel(glyphPixels('stop'), 16, 16), [255, 255, 255, 255])
  console.log('PASS native integration: tray timer switching, unread badge, OS notifications, taskbar buttons, jump list and launch actions')
}

async function main() {
  const code = await buildModules()
  const config = makeHarness(code).api
  assert.equal(config.normalizeServerUrl('  HTTP://Team.Example:80/  '), 'http://team.example')
  assert.equal(config.normalizeServerUrl('https://[::1]:8443/'), 'https://[::1]:8443')
  for (const value of ['team.local:4577', 'file:///C:/data', 'ftp://host', 'javascript:alert(1)',
    'http://user:password@host', 'http://host/app', 'http://host?group=a', 'http://host#group', '']) {
    assert.throws(() => config.normalizeServerUrl(value), `unsafe address accepted: ${value}`)
  }
  const profile = config.makeProfile(' チームA ', 'http://team.local:4577/')
  assert.equal(profile.name, 'チームA')
  assert.equal(profile.id, config.makeProfile('別の表示名', 'http://TEAM.local:4577').id)
  assert.notEqual(profile.id, config.makeProfile('チームB', 'http://team.local:4578').id)
  assert.throws(() => config.makeProfile('', 'http://host'))
  assert.throws(() => config.validatePreferences({ alwaysOnTop: 'true' }))
  assert.throws(() => config.validatePreferences({ timerCompact: 'true' }))
  assert.throws(() => config.validatePreferences({ globalShortcutFocus: 'Ctrl+$()' }))

  const personal = makeHarness(code, { legacy: true })
  personal.controller.start()
  assert.equal(personal.localStarts, 1, 'an existing personal installation should open its original mode')
  assert.equal(personal.windows.length, 0)
  assert.equal(personal.requests.length, 0)

  await testTimerSizing(code, profile)
  await testNativeIntegration(code, profile)

  const saved = makeHarness(code, { saved: { mode: 'server', profile, preferences: { showTimer: true } } })
  saved.controller.start()
  await flush()
  const mainWindow = saved.live()
  assert.ok(mainWindow, 'a saved group should auto-connect')
  assert.equal(saved.requests[0].url, 'http://team.local:4577/api/health')
  assert.equal(saved.requests[0].init.redirect, 'error')
  assert.equal(saved.localStarts, 0)
  assert.equal(saved.localDbCalls, 0, 'team mode must not read or initialize the local SQLite database')
  assert.equal(mainWindow.settings.webPreferences.nodeIntegration, false)
  assert.equal(mainWindow.settings.webPreferences.contextIsolation, true)
  assert.equal(mainWindow.settings.webPreferences.sandbox, true)
  assert.equal(mainWindow.settings.webPreferences.webSecurity, true)
  assert.ok(mainWindow.settings.webPreferences.preload.endsWith('desktop.js'))
  assert.ok(!mainWindow.settings.webPreferences.preload.endsWith('index.js'))

  const event = saved.event(mainWindow)
  const contextHandler = saved.handlers.get('hakobi:context')
  assert.equal(contextHandler(event).serverVersion, 1)
  assert.throws(() => contextHandler({ ...event, senderFrame: { url: event.senderFrame.url } }), /許可/)
  assert.throws(() => contextHandler({ sender: {}, senderFrame: {} }), /許可/)
  const goodUrl = event.senderFrame.url
  event.senderFrame.url = 'http://untrusted.local/'
  assert.throws(() => contextHandler(event), /許可/)
  event.senderFrame.url = goodUrl
  assert.throws(() => saved.invoke('hakobi-launcher:local', mainWindow), /許可/)

  let externalBlocked = false
  mainWindow.webContents.emit('will-navigate', { preventDefault() { externalBlocked = true } }, 'https://external.example/')
  assert.equal(externalBlocked, true)
  assert.deepEqual(saved.external, ['https://external.example/'])
  mainWindow.webContents.openHandler({ url: 'javascript:alert(1)' })
  assert.equal(saved.external.length, 1)
  let internalBlocked = false
  mainWindow.webContents.emit('will-navigate', { preventDefault() { internalBlocked = true } }, `${profile.url}/`)
  assert.equal(internalBlocked, false)

  await saved.invoke('hakobi:state', mainWindow, {
    userId: 'user-1', taskId: 'task-1', taskTitle: '設計をまとめる', startTime: new Date().toISOString(), online: true
  })
  const timer = saved.live('#hakobi-timer')
  assert.ok(timer)
  assert.equal(timer.settings.webPreferences.partition, mainWindow.settings.webPreferences.partition)
  assert.equal(saved.sessions.get(timer.settings.webPreferences.partition).permissionCheck(), false)
  let permissionGranted = true
  saved.sessions.get(timer.settings.webPreferences.partition).permissionRequest(null, 'camera', (value) => { permissionGranted = value })
  assert.equal(permissionGranted, false)
  await saved.invoke('hakobi:progress', mainWindow, 'task-1')
  const progressWindow = saved.live('#hakobi-progress?todo=task-1')
  assert.ok(progressWindow)
  await saved.invoke('hakobi:progress', mainWindow, 'task-2')
  assert.equal(progressWindow.loads.length, 1, 'reopening progress must preserve the document and its in-flight submission')
  assert.equal(progressWindow.webContents.sent.at(-1).value.type, 'progress-target')
  assert.equal(progressWindow.webContents.sent.at(-1).value.todoId, 'task-2')
  assert.throws(() => saved.invoke('hakobi:resize-timer', mainWindow, true), /不正/)
  await saved.invoke('hakobi:resize-timer', timer, true)
  assert.deepEqual(timer.size, [320, 150])
  assert.throws(() => saved.invoke('hakobi:state', mainWindow, { online: true }), /不正/)
  const clockState = { userId: 'user-1', taskId: 'task-1', taskTitle: '設計をまとめる', startTime: new Date(Date.now() + 3540000).toISOString(), online: true, clockOffsetMs: 3600000 }
  await saved.invoke('hakobi:state', mainWindow, clockState)
  assert.match(saved.trays[0].tooltip, /0:01:0[01]/, 'tray time must use the same server clock correction as the mini window')
  const menuUpdates = saved.trays[0].menuUpdates
  await saved.invoke('hakobi:state', mainWindow, { ...clockState, clockOffsetMs: 3600500 })
  assert.equal(saved.trays[0].menuUpdates, menuUpdates, 'clock correction should update the tooltip without rebuilding the menu')
  for (const invalidOffset of [Infinity, NaN, '1000', Number.MAX_VALUE]) {
    assert.throws(() => saved.invoke('hakobi:state', mainWindow, { ...clockState, clockOffsetMs: invalidOffset }), /不正/)
  }
  await saved.invoke('hakobi:state', mainWindow, { ...clockState, startTime: new Date(Date.now() - 10000).toISOString(), clockOffsetMs: undefined })
  assert.match(saved.trays[0].tooltip, /0:00:1[01]/, 'clients without a clock correction remain supported')

  const legacyFile = path.join(saved.userData, 'config.json')
  fs.writeFileSync(legacyFile, '{"dataDir":"personal-data"}')
  await saved.invoke('hakobi:preferences', mainWindow, { hideTaskTitle: true, alwaysOnTop: false, serverTheme: 'ignore' })
  assert.equal(saved.readSaved().preferences.hideTaskTitle, true)
  assert.equal(saved.readSaved().preferences.alwaysOnTop, false)
  assert.equal(saved.readSaved().preferences.serverTheme, undefined)
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), '{"dataDir":"personal-data"}')
  assert.equal(saved.requests.length, 1, 'native preferences must not be written to the server')
  assert.throws(() => saved.invoke('hakobi:preferences', mainWindow, { showTimer: 1 }))

  const originalPreferences = saved.readSaved().preferences
  const originalShortcuts = new Map(saved.shortcuts)
  const registrationsBeforeTheme = saved.shortcutRegistrations
  await saved.invoke('hakobi:preferences', mainWindow, { hideTaskTitle: false })
  assert.equal(saved.shortcutRegistrations, registrationsBeforeTheme, 'unrelated native settings must not unregister working shortcuts')
  await saved.invoke('hakobi:preferences', mainWindow, { hideTaskTitle: originalPreferences.hideTaskTitle })
  saved.blockedShortcuts.add('Ctrl+Alt+Q')
  assert.throws(() => saved.invoke('hakobi:preferences', mainWindow, { globalShortcutProgress: 'Ctrl+Alt+Q', hideTaskTitle: false }), /進捗をすぐ書く.*登録できません/)
  assert.equal(saved.readSaved().preferences.globalShortcutProgress, originalPreferences.globalShortcutProgress)
  assert.equal(saved.readSaved().preferences.hideTaskTitle, originalPreferences.hideTaskTitle, 'a failed key change rolls back the whole settings patch')
  assert.deepEqual([...saved.shortcuts.keys()], [...originalShortcuts.keys()])
  for (const [key, callback] of originalShortcuts) assert.equal(saved.shortcuts.get(key), callback, 'old shortcut callbacks must be restored')
  assert.match(saved.dialogs.at(-1).message, /登録できません/)
  assert.match(saved.dialogs.at(-1).detail, /設定は変更していません/)
  saved.invalidShortcuts.add('Bogus')
  assert.throws(() => saved.invoke('hakobi:preferences', mainWindow, { globalShortcutFocus: 'Bogus' }), /登録できません/)
  assert.deepEqual([...saved.shortcuts.keys()], [...originalShortcuts.keys()])
  assert.throws(() => saved.invoke('hakobi:preferences', mainWindow, { globalShortcutProgress: 'Ctrl+Alt+T' }), /重複/)
  assert.deepEqual([...saved.shortcuts.keys()], [...originalShortcuts.keys()])
  saved.blockedShortcuts.clear()
  await saved.invoke('hakobi:preferences', mainWindow, { globalShortcutProgress: 'Ctrl+Alt+Q' })
  assert.equal(saved.readSaved().preferences.globalShortcutProgress, 'Ctrl+Alt+Q')
  assert.ok(saved.shortcuts.has('Ctrl+Alt+Q'))
  assert.ok(!saved.shortcuts.has(originalPreferences.globalShortcutProgress))
  await saved.invoke('hakobi:preferences', mainWindow, { globalShortcutProgress: '' })
  assert.ok(!saved.shortcuts.has('Ctrl+Alt+Q'), 'empty keys intentionally disable a shortcut')
  await saved.invoke('hakobi:preferences', mainWindow, { globalShortcutProgress: originalPreferences.globalShortcutProgress })

  saved.controller.showConnectionSettings()
  const launcher = saved.live('#hakobi-launcher')
  const previous = saved.windows.filter((window) => !window.destroyed && window !== launcher)
  saved.response = new Error('another group is offline')
  await saved.invoke('hakobi-launcher:connect', launcher, { name: '営業チーム', url: 'http://team.local:4578' })
  assert.ok(previous.every((window) => !window.destroyed), 'a failed connection change must preserve the current group windows')
  assert.equal(saved.readSaved().profile.id, profile.id)
  saved.response = { ok: true, desktopProtocol: 1, webReady: true }
  await saved.invoke('hakobi-launcher:connect', launcher, { name: '営業チーム', url: 'http://team.local:4578' })
  await flush()
  const nextMain = saved.live()
  assert.ok(previous.every((window) => window.destroyed), 'changing groups must destroy every previous group window')
  assert.notEqual(nextMain.settings.webPreferences.partition, mainWindow.settings.webPreferences.partition)
  assert.throws(() => saved.invoke('hakobi:context', mainWindow), /許可/)
  assert.equal(saved.live('#hakobi-timer'), undefined, 'the new group must wait for its own authenticated user')
  assert.equal(saved.readSaved().preferences.hideTaskTitle, true, 'PC preferences should survive a group change')
  assert.equal(saved.localDbCalls, 0)

  const oldServer = makeHarness(code, { health: { ok: true } })
  const oldMain = await connect(oldServer)
  assert.ok(oldMain, 'the existing Web UI should remain usable against an older server')
  assert.equal(oldServer.invoke('hakobi:context', oldMain).serverVersion, 0)
  await oldServer.invoke('hakobi:state', oldMain, { userId: 'user-1', taskId: null, taskTitle: '', startTime: null, online: true })
  await oldServer.invoke('hakobi:timer', oldMain)
  await oldServer.invoke('hakobi:progress', oldMain)
  assert.equal(oldServer.live('#hakobi-timer'), undefined)
  assert.ok(oldServer.trays[0].menu.some((item) => item.label === '追加機能にはサーバーの更新が必要です'))

  const unbuilt = makeHarness(code, { health: { ok: true, desktopProtocol: 1, webReady: false } })
  assert.equal(await connect(unbuilt), undefined)
  assert.match(unbuilt.invoke('hakobi-launcher:state', unbuilt.live('#hakobi-launcher')).message, /build:web/)
  assert.equal(fs.existsSync(path.join(unbuilt.userData, 'hakobi-desktop.json')), false)

  const unavailable = makeHarness(code, { health: new Error('LAN unavailable') })
  assert.equal(await connect(unavailable), undefined)
  const failedState = unavailable.invoke('hakobi-launcher:state', unavailable.live('#hakobi-launcher'))
  assert.equal(failedState.connecting, false)
  assert.match(failedState.message, /LAN|接続できません/)
  assert.equal(unavailable.localStarts, 0)

  const missingPage = makeHarness(code)
  missingPage.failLoad = true
  assert.equal(await connect(missingPage), undefined)
  assert.match(missingPage.invoke('hakobi-launcher:state', missingPage.live('#hakobi-launcher')).message, /画面|ビルド/)

  const loadingProgress = makeHarness(code, { saved: { mode: 'server', profile, preferences: { showTimer: false } } })
  const loadingProgressMain = await connect(loadingProgress)
  await loadingProgress.invoke('hakobi:state', loadingProgressMain, { userId: 'user-1', taskId: null, taskTitle: '', startTime: null, online: true })
  loadingProgress.deferRemoteLoad = true
  await loadingProgress.invoke('hakobi:progress', loadingProgressMain, 'task-a')
  const pendingProgress = loadingProgress.live('#hakobi-progress?todo=task-a')
  await loadingProgress.invoke('hakobi:progress', loadingProgressMain, 'task-b')
  await loadingProgress.invoke('hakobi:progress', loadingProgressMain, 'task-c')
  assert.equal(pendingProgress.webContents.sent.length, 0, 'a target must wait until the bridge listener can exist')
  loadingProgress.deferredLoads.get(pendingProgress).finish()
  await flush()
  const targetCommands = pendingProgress.webContents.sent.filter((entry) => entry.value.type === 'progress-target')
  assert.equal(targetCommands.length, 1)
  assert.equal(targetCommands[0].value.todoId, 'task-c', 'only the latest target requested during startup should be delivered')

  const auxiliary = makeHarness(code, { saved: { mode: 'server', profile, preferences: { showTimer: false } } })
  const auxiliaryMain = await connect(auxiliary)
  await auxiliary.invoke('hakobi:state', auxiliaryMain, { userId: 'user-1', taskId: null, taskTitle: '', startTime: null, online: true })
  for (const [channel, hash, todoId] of [['hakobi:timer', '#hakobi-timer'], ['hakobi:gantt', '#gantt-only'], ['hakobi:report', '#task-report-only'], ['hakobi:progress', '#hakobi-progress', 'retry-task']]) {
    auxiliary.failLoad = (url) => new URL(url).hash.split('?')[0] === hash
    await auxiliary.invoke(channel, auxiliaryMain, ...(todoId ? [todoId] : []))
    await flush()
    const failed = auxiliary.live(hash + (todoId ? `?todo=${todoId}` : ''))
    assert.ok(failed)
    assert.equal(failed.visible, false, 'a failed auxiliary page must not remain visible as a blank window')
    assert.match(auxiliary.dialogs.at(-1).message, /開けません/)
    auxiliary.failLoad = false
    await auxiliary.invoke(channel, auxiliaryMain, ...(todoId ? [todoId] : []))
    await flush()
    const recovered = auxiliary.live(hash + (todoId ? `?todo=${todoId}` : ''))
    assert.ok(failed.destroyed)
    assert.notEqual(recovered, failed)
    assert.equal(recovered.visible, true, 'reopening an auxiliary page must perform a new successful load')
  }
  const recoveredTimer = auxiliary.live('#hakobi-timer')
  recoveredTimer.webContents.emit('render-process-gone')
  assert.equal(recoveredTimer.visible, false)
  await auxiliary.invoke('hakobi:timer', auxiliaryMain)
  await flush()
  assert.ok(recoveredTimer.destroyed, 'a crashed auxiliary renderer must also be replaceable')

  const initialCrash = makeHarness(code)
  initialCrash.deferRemoteLoad = true
  const crashingMain = await connect(initialCrash)
  assert.equal(initialCrash.invoke('hakobi-launcher:state', initialCrash.live('#hakobi-launcher')).connecting, true)
  crashingMain.webContents.emit('render-process-gone')
  const crashState = initialCrash.invoke('hakobi-launcher:state', initialCrash.live('#hakobi-launcher'))
  assert.equal(crashState.connecting, false, 'a renderer crash before ready-to-show must unlock the connection form')
  assert.equal(crashState.canCancel, false)
  assert.match(crashState.message, /停止|再接続/)
  assert.ok(crashingMain.destroyed)
  initialCrash.deferRemoteLoad = false
  await initialCrash.invoke('hakobi-launcher:retry', initialCrash.live('#hakobi-launcher'))
  await flush()
  assert.ok(initialCrash.live(), 'retry after the initial crash must create a fresh main window')

  const stalledPage = makeHarness(code)
  stalledPage.deferRemoteLoad = true
  const stalledMain = await connect(stalledPage)
  stalledPage.fireTimeout(30000)
  const stalledState = stalledPage.invoke('hakobi-launcher:state', stalledPage.live('#hakobi-launcher'))
  assert.equal(stalledState.connecting, false, 'health success must not permit an indefinitely stalled page')
  assert.match(stalledState.message, /時間がかかっています/)
  assert.ok(stalledMain.destroyed)
  stalledPage.deferRemoteLoad = false
  await stalledPage.invoke('hakobi-launcher:retry', stalledPage.live('#hakobi-launcher'))
  await flush()
  assert.ok(stalledPage.live())

  const startupConflict = makeHarness(code, { saved: { mode: 'server', profile, preferences: { showTimer: false } } })
  startupConflict.blockedShortcuts.add('CommandOrControl+Alt+P')
  const startupConflictMain = await connect(startupConflict)
  assert.ok(startupConflictMain, 'an unavailable shortcut must not prevent the main UI from connecting')
  assert.match(startupConflict.dialogs.at(-1).message, /ショートカット.*登録できません/)
  assert.equal(startupConflict.shortcuts.size, 3, 'one occupied startup key must not disable other available shortcuts')
  assert.ok(startupConflict.shortcuts.has('CommandOrControl+Alt+T'))
  await startupConflict.invoke('hakobi:preferences', startupConflictMain, { alwaysOnTop: false })
  assert.equal(startupConflict.readSaved().preferences.alwaysOnTop, false, 'unrelated settings should remain usable after a startup conflict')
  await startupConflict.invoke('hakobi:preferences', startupConflictMain, { globalShortcutProgress: 'Ctrl+Alt+Q' })
  assert.equal(startupConflict.shortcuts.size, 4)

  await saved.invoke('hakobi:state', nextMain, {
    userId: 'user-2', taskId: null, taskTitle: '', startTime: null, online: true
  })
  await saved.invoke('hakobi:gantt', nextMain)
  await saved.invoke('hakobi:report', nextMain)
  await saved.invoke('hakobi:progress', nextMain)
  const authenticatedWindows = saved.windows.filter((window) => !window.destroyed && window !== nextMain)
  assert.ok(authenticatedWindows.length >= 4)
  await saved.invoke('hakobi:state', nextMain, { userId: null, taskId: null, taskTitle: '', startTime: null, online: true })
  assert.ok(authenticatedWindows.every((window) => window.destroyed), 'logout must close native windows containing the previous account data')

  const interrupted = makeHarness(code)
  let completeHealth
  interrupted.response = () => new Promise((resolve) => { completeHealth = resolve })
  interrupted.controller.start()
  const interruptedLauncher = interrupted.live('#hakobi-launcher')
  const pending = interrupted.invoke('hakobi-launcher:connect', interruptedLauncher, { name: 'チーム', url: 'http://team.local:4577' })
  await flush()
  interrupted.controller.dispose()
  completeHealth({ ok: true, desktopProtocol: 1 })
  await pending
  assert.equal(interrupted.live(), undefined, 'quitting during health check must not open a stale remote window')
  assert.equal(fs.existsSync(path.join(interrupted.userData, 'hakobi-desktop.json')), false)

  console.log('HAKOBI desktop checks passed: profiles, origin isolation, native preferences, auto-connect, fallback, and lifecycle')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const instance of instances) instance.controller.dispose()
  // Only remove the unique directory created by this test.
  if (temporary.startsWith(`${os.tmpdir()}${path.sep}hakobi-desktop-test-`)) fs.rmSync(temporary, { recursive: true, force: true })
})
