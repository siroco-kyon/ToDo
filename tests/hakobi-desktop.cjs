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
      contents: "export { DesktopController } from './desktop-controller'; export * from './desktop-config'",
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
    show() { this.visible = true }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    focus() { this.focused = true }
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
    destroy() { this.destroyed = true }
  }
  harness.electron = {
    app: {
      getPath: () => userData, isQuitting: false,
      quit: () => harness.quits++, relaunch: () => harness.relaunches++
    },
    BrowserWindow: Window, Tray: MockTray,
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
      createFromBuffer: (buffer) => { assert.ok(buffer.length > 0); return { isEmpty: () => false } }
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
    Buffer, URL, AbortController, console, process: { env: {} },
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
