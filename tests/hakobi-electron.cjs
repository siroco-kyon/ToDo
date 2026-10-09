// Real Electron smoke test: isolated server, userData, sandboxed preloads and rendered UI.
// Run after npm run build and npm run build:web. No live DB or Windows service is touched.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const webDist = path.resolve(process.env.HAKOBI_TEST_WEB_DIST || process.argv[2] || path.join(root, 'dist-web'))
const modulesDir = path.join(root, 'node_modules')
const temporaryDir = fs.mkdtempSync(path.join(modulesDir, '.hakobi-electron-test-'))
const imageDir = path.join(modulesDir, '.hakobi-qa')
let server
let electron

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([ended, delay(5000)])
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The isolated test child did not exit')
}

async function main() {
  for (const builtFile of ['out/preload/desktop.js', 'out/preload/launcher.js', 'out/renderer/index.html']) {
    assert.ok(fs.existsSync(path.join(root, builtFile)), `Build first: missing ${builtFile}`)
  }
  assert.ok(fs.existsSync(path.join(webDist, 'index.html')), `Build the Web UI first: ${webDist}`)
  fs.mkdirSync(imageDir, { recursive: true })
  const envFile = path.join(temporaryDir, 'empty.env')
  fs.writeFileSync(envFile, '')
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const fixture = {
    root, temporaryDir, imageDir, origin,
    username: 'hakobi_smoke_admin', password: 'hakobi-smoke-only-test-password',
    taskTitle: 'HAKOBI動作確認のタスク', groupName: '動作確認チーム'
  }
  const fixturePath = path.join(temporaryDir, 'fixture.json')
  fs.writeFileSync(fixturePath, JSON.stringify(fixture))
  let serverOutput = ''
  server = spawn(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'server/node_modules/tsx/dist/loader.mjs')).href,
    path.join(root, 'server/src/index.ts')
  ], {
    cwd: path.join(root, 'server'), windowsHide: true,
    env: { ...process.env, TODO_ENV_FILE: envFile, PORT: String(port),
      TODO_DATA_DIR: path.join(temporaryDir, 'server-data'), TODO_WEB_DIST: webDist,
      ADMIN_USERNAME: fixture.username, ADMIN_PASSWORD: fixture.password, SESSION_COOKIE: 'hakobi_smoke_session' }
  })
  server.stdout.on('data', (chunk) => { serverOutput += chunk })
  server.stderr.on('data', (chunk) => { serverOutput += chunk })
  const deadline = Date.now() + 20000
  let healthy = false
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })
      const health = await response.json()
      if (response.ok && health.ok && health.webReady) { healthy = true; break }
    } catch { /* Wait for the isolated server to listen. */ }
    await delay(150)
  }
  assert.ok(healthy, `Isolated server did not start: ${serverOutput.replaceAll(fixture.password, '[test password]')}`)

  const runner = path.join(temporaryDir, 'run.cjs')
  fs.writeFileSync(runner, `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session, clipboard } = require('electron')
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', path.join(fixture.temporaryDir, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})
const windows = []
const rendererErrors = []
const paintedFrames = new Map()
const states = []
const commands = []
let preferences = { showTimer: true, alwaysOnTop: true, hideTaskTitle: false,
  timerCompact: false,
  globalShortcutFocus: 'CommandOrControl+Alt+T', globalShortcutQuickAdd: 'CommandOrControl+Alt+N',
  globalShortcutExport: 'CommandOrControl+Alt+E', globalShortcutProgress: 'CommandOrControl+Alt+P' }
const context = () => ({ version: 1, serverVersion: 1, groupName: fixture.groupName, serverUrl: fixture.origin, preferences })
ipcMain.handle('hakobi:context', context)
ipcMain.handle('hakobi:preferences', (_event, patch) => {
  preferences = { ...preferences, ...patch }
  windows.forEach((window) => { if (!window.isDestroyed()) window.webContents.send('hakobi:command', { type: 'preferences', preferences }) })
  return preferences
})
ipcMain.handle('hakobi:state', (_event, state) => { states.push(state) })
for (const action of ['main', 'timer', 'progress', 'gantt', 'report', 'connection', 'hide']) {
  ipcMain.handle('hakobi:' + action, (_event, value) => { commands.push({ action, value }) })
}
let failNextResize = false
ipcMain.handle('hakobi:resize-timer', (event, compact) => {
  commands.push({ action: 'resize-timer', value: compact })
  if (failNextResize) { failNextResize = false; throw new Error('Owned resize failure') }
  const target = BrowserWindow.fromWebContents(event.sender)
  resizeTimerViewport(target, compact ? 320 : 360, compact ? 150 : 250)
  preferences = { ...preferences, timerCompact: compact }
  windows.forEach((window) => { if (!window.isDestroyed()) window.webContents.send('hakobi:command', { type: 'preferences', preferences }) })
})
const launcherState = { mode: 'unset', profile: { id: 'smoke-group', name: fixture.groupName, url: fixture.origin },
  preferences, message: '', connecting: false, canCancel: false }
ipcMain.handle('hakobi-launcher:state', () => launcherState)
for (const action of ['connect', 'local', 'retry', 'cancel']) ipcMain.handle('hakobi-launcher:' + action, () => {})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(window, expression, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return
    await delay(100)
  }
  const text = await window.webContents.executeJavaScript('document.body.innerText')
  throw new Error(label + ': ' + text.slice(0, 1500))
}
function createWindow(preload, partition, width, height) {
  const remoteSession = session.fromPartition(partition)
  // Keep the production denial policy, including sanitized clipboard writes.
  remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  remoteSession.setPermissionCheckHandler(() => false)
  // Measure native frame/menu insets, then render an offscreen view at the actual content size.
  // This keeps the screenshot and control visibility checks honest for the product's outer sizes.
  const measuringWindow = new BrowserWindow({ show: false, width, height, autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const [contentWidth, contentHeight] = measuringWindow.getContentSize()
  measuringWindow.destroy()
  const window = new BrowserWindow({ show: false, width: contentWidth, height: contentHeight, frame: false,
    webPreferences: { preload: path.join(fixture.root, 'out/preload', preload), partition,
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  window.webContents.on('paint', (_event, _dirty, image) => {
    const png = image.toPNG()
    if (png.length) paintedFrames.set(window.id, png)
  })
  window.webContents.setFrameRate(10)
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes('Electron Security Warning') && !message.includes('status of 401')) rendererErrors.push(message)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  windows.push(window)
  return window
}
function resizeTimerViewport(window, width, height) {
  const measuringWindow = new BrowserWindow({ show: false, width, height, autoHideMenuBar: true })
  const size = measuringWindow.getContentSize()
  measuringWindow.destroy()
  window.setSize(...size)
}
async function capture(window, name) {
  await delay(150)
  window.webContents.invalidate()
  await delay(150)
  const image = paintedFrames.get(window.id)
  assert.ok(image?.length, 'Offscreen window did not produce a frame for ' + name)
  fs.writeFileSync(path.join(fixture.imageDir, name + '.png'), image)
}
async function run() {
  await app.whenReady()
  const launcher = createWindow('launcher.js', 'persist:hakobi-smoke-launcher', 800, 710)
  await launcher.loadFile(path.join(fixture.root, 'out/renderer/index.html'), { hash: 'hakobi-launcher' })
  await until(launcher, "Boolean(document.querySelector('#hakobi-server-url'))", 'Launcher did not render')
  const launcherIsolation = await launcher.webContents.executeJavaScript('({ api: typeof window.api, desktop: typeof window.desktop, launcher: typeof window.hakobiLauncher.getState, require: typeof require, process: typeof process })')
  assert.deepEqual(launcherIsolation, { api: 'undefined', desktop: 'undefined', launcher: 'function', require: 'undefined', process: 'undefined' })
  assert.equal(await launcher.webContents.executeJavaScript("document.querySelector('#hakobi-group-name').value"), fixture.groupName)
  await capture(launcher, 'launcher')

  const authPartition = 'persist:hakobi-smoke-auth-timeout'
  const authSession = session.fromPartition(authPartition)
  const heldAuth = []
  authSession.webRequest.onBeforeRequest({ urls: [fixture.origin + '/api/auth/me'] }, (_details, callback) => { heldAuth.push(callback) })
  const authWindow = createWindow('desktop.js', authPartition, 800, 710)
  await authWindow.loadURL(fixture.origin)
  await until(authWindow, "document.body.innerText.includes('再試行') && document.body.innerText.includes('接続先の設定')", 'Initial auth timeout never reached the recovery screen')
  assert.ok(heldAuth.length, 'The initial authentication request was not stalled')
  authSession.webRequest.onBeforeRequest(null)
  heldAuth.forEach((callback) => callback({ cancel: true }))
  await authWindow.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '再試行').click()")
  await until(authWindow, "Boolean(document.querySelector('input[autocomplete=username]'))", 'Authentication did not recover after retry')
  authWindow.destroy()

  const main = createWindow('desktop.js', 'persist:hakobi-smoke-group-a', 1200, 800)
  await main.loadURL(fixture.origin)
  await until(main, "Boolean(document.querySelector('input[autocomplete=username]'))", 'Login did not render')
  const isolation = await main.webContents.executeJavaScript('({ require: typeof require, process: typeof process, ipc: typeof window.ipcRenderer, launcher: typeof window.hakobiLauncher, context: typeof window.desktop.getContext, api: typeof window.api.todoGetAll })')
  assert.deepEqual(isolation, { require: 'undefined', process: 'undefined', ipc: 'undefined', launcher: 'undefined', context: 'function', api: 'function' })
  assert.equal((await main.webContents.executeJavaScript('window.desktop.getContext()')).groupName, fixture.groupName)
  const user = await main.webContents.executeJavaScript('(async () => { const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(' + JSON.stringify({ username: fixture.username, password: fixture.password }) + ') }); if (!response.ok) throw new Error("Fixture login failed"); return (await response.json()).user })()')
  await main.loadURL(fixture.origin)
  await until(main, "document.body.innerText.includes('ガント') && !document.querySelector('input[autocomplete=username]')", 'Authenticated main App did not render')
  const todo = await main.webContents.executeJavaScript('window.api.todoCreate(' + JSON.stringify({ title: fixture.taskTitle, assignee_id: user.id, status: 'in_progress' }) + ')')
  const running = await main.webContents.executeJavaScript('window.api.timerStart(' + JSON.stringify(todo.id) + ')')
  assert.equal(running.todo_id, todo.id)
  await main.webContents.executeJavaScript('window.fixtureDateNow = Date.now; Date.now = () => window.fixtureDateNow() + 600000; void 0')
  main.webContents.send('hakobi:command', { type: 'navigate', todoId: todo.id })
  await until(main, "Boolean(document.querySelector('[aria-label=計測時間][data-running=true]'))", 'Main timer did not render')
  await until(main, "Number(document.querySelector('[aria-label=計測時間][data-running=true]').textContent.split(':').slice(-2)[0]) < 1", 'Main timer used the skewed PC clock')

  const timer = createWindow('desktop.js', 'persist:hakobi-smoke-group-a', 360, 250)
  await timer.loadURL(fixture.origin + '/#hakobi-timer')
  await until(timer, "document.querySelector('.task-title')?.textContent === " + JSON.stringify(fixture.taskTitle) + " && document.querySelector('.connection')?.textContent === '接続中'", 'Timer did not load shared session and running task')
  assert.match(await timer.webContents.executeJavaScript("document.querySelector('.elapsed').textContent"), /^\\d{2}:\\d{2}:\\d{2}$/)
  assert.equal(await timer.webContents.executeJavaScript("document.querySelector('.group').textContent"), fixture.groupName)
  assert.equal(await timer.webContents.executeJavaScript("document.querySelector('.primary-actions').getBoundingClientRect().bottom <= innerHeight"), true, 'Timer controls fall outside the window')
  await delay(1100)
  assert.ok(states.some((state) => state.userId === user.id && Math.abs(state.clockOffsetMs + 600000) < 2000), 'Tray state did not receive the server clock correction')
  await capture(timer, 'timer')
  const normalSize = timer.getSize()
  await timer.webContents.executeJavaScript("document.querySelector('button[aria-label=コンパクト表示]').click()")
  await until(timer, "Boolean(document.querySelector('.timer-window.compact'))", 'Compact timer failed')
  assert.ok(commands.some((command) => command.action === 'resize-timer' && command.value === true))
  assert.ok(timer.getSize()[1] < normalSize[1], 'Compact timer must have a smaller viewport')
  assert.equal(await timer.webContents.executeJavaScript("document.querySelector('.compact-task-title').textContent"), fixture.taskTitle)
  resizeTimerViewport(timer, 300, 150)
  await until(timer, "document.querySelector('.compact-row').getBoundingClientRect().bottom <= innerHeight && document.querySelector('[aria-label=展開]').getBoundingClientRect().right <= innerWidth", 'Compact task and controls do not fit the minimum native size')
  await capture(timer, 'timer-compact')
  await timer.webContents.executeJavaScript("window.desktop.setPreferences({hideTaskTitle:true})")
  await until(timer, "document.querySelector('.compact-task-title').textContent === '作業中のタスク'", 'Compact title ignored the privacy preference')
  await timer.webContents.executeJavaScript("window.desktop.setPreferences({hideTaskTitle:false})")
  await until(timer, "document.querySelector('.compact-task-title').textContent === " + JSON.stringify(fixture.taskTitle), 'Compact task title did not return')
  const timerReloaded = new Promise((resolve) => timer.webContents.once('did-finish-load', resolve))
  timer.reload()
  await timerReloaded
  await until(timer, "Boolean(document.querySelector('.timer-window.compact')) && document.querySelector('.compact-task-title').textContent === " + JSON.stringify(fixture.taskTitle), 'Compact mode did not survive reloading the UI')
  failNextResize = true
  await timer.webContents.executeJavaScript("document.querySelector('button[aria-label=展開]').click()")
  await until(timer, "Boolean(document.querySelector('.timer-window.compact')) && document.body.innerText.includes('表示サイズを変更できませんでした')", 'Resize failure did not preserve the compact mode or show recovery')
  await timer.webContents.executeJavaScript("document.querySelector('button[aria-label=展開]').click()")
  await until(timer, "Boolean(document.querySelector('.timer-window:not(.compact)'))", 'Timer did not recover after a resize failure')

  const progress = createWindow('desktop.js', 'persist:hakobi-smoke-group-a', 520, 560)
  await progress.loadURL(fixture.origin + '/#hakobi-progress?todo=' + encodeURIComponent(todo.id))
  await until(progress, "document.querySelector('#quick-progress-task')?.value === " + JSON.stringify(todo.id) + " && document.querySelector('button.primary')?.disabled === true && document.body.innerText.includes('チームの進捗ログに投稿されます')", 'Progress form did not render')
  const firstBody = '進捗のクイック投稿を確認しました。'
  const setBody = async (value) => {
    await progress.webContents.executeJavaScript('(() => { const textarea = document.querySelector("#quick-progress-body"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, ' + JSON.stringify(value) + '); textarea.dispatchEvent(new Event("input", { bubbles: true })); })()')
    await until(progress, "document.querySelector('button.primary').disabled === false", 'Progress input did not enable posting')
  }
  await setBody(firstBody)
  const draftKey = 'hakobi-progress-draft:' + user.id + ':' + todo.id
  assert.equal(await progress.webContents.executeJavaScript('JSON.parse(localStorage.getItem(' + JSON.stringify(draftKey) + ')).body'), firstBody)
  const secondTodo = await main.webContents.executeJavaScript('window.api.todoCreate(' + JSON.stringify({ title: '別タスクの下書き', assignee_id: user.id }) + ')')
  progress.webContents.send('hakobi:command', { type: 'progress-target', todoId: secondTodo.id })
  await until(progress, "document.querySelector('#quick-progress-task')?.value === " + JSON.stringify(secondTodo.id), 'Reopening progress did not change to task B')
  await setBody('Bだけの下書き')
  progress.webContents.send('hakobi:command', { type: 'progress-target', todoId: todo.id })
  await until(progress, "document.querySelector('#quick-progress-task')?.value === " + JSON.stringify(todo.id) + " && document.querySelector('#quick-progress-body')?.value === " + JSON.stringify(firstBody), 'Returning to task A did not restore its own draft')
  await new Promise((resolve) => { progress.webContents.once('did-finish-load', resolve); progress.reload() })
  await until(progress, "document.querySelector('#quick-progress-body')?.value === " + JSON.stringify(firstBody) + " && document.querySelector('button.primary')?.disabled === false", 'Progress draft did not survive reload')
  assert.equal(await progress.webContents.executeJavaScript("document.querySelector('.primary-actions').getBoundingClientRect().bottom <= innerHeight"), true, 'Progress footer controls fall outside the window')
  await capture(progress, 'progress')
  await progress.webContents.executeJavaScript("document.querySelector('#quick-progress-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }))")
  await until(progress, "document.body.innerText.includes('進捗を投稿しました')", 'Ctrl+Enter did not post')
  const notes = await main.webContents.executeJavaScript('window.api.progressNoteGetByTodo(' + JSON.stringify(todo.id) + ')')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].body, firstBody)
  assert.equal(await progress.webContents.executeJavaScript('localStorage.getItem(' + JSON.stringify(draftKey) + ')'), null)
  assert.equal((await main.webContents.executeJavaScript('window.api.timerGetRunning()')).todo_id, todo.id)

  await setBody('作業を終えて、計測を停止します。')
  await progress.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '投稿して計測を停止').click()")
  await until(progress, "document.body.innerText.includes('進捗を投稿して計測を停止しました')", 'Post and stop did not finish')
  assert.equal(await main.webContents.executeJavaScript('window.api.timerGetRunning()'), null)
  assert.equal((await main.webContents.executeJavaScript('window.api.progressNoteGetByTodo(' + JSON.stringify(todo.id) + ')')).length, 2)
  await until(timer, "document.querySelector('.task-title')?.textContent === '計測していません'", 'Realtime timer stop did not reach the other window')
  await delay(100)
  assert.ok(states.some((state) => state.userId === user.id && state.taskId === todo.id && state.online === true), 'Desktop main did not publish the tray state')

  const legacyKey = 'progress-note-draft:' + todo.id
  const recoveredKey = 'progress-note-draft:' + user.id + ':' + todo.id
  await main.webContents.executeJavaScript('localStorage.setItem(' + JSON.stringify(legacyKey) + ', "以前のWeb版で書いた未投稿の文章")')
  await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '設定').click()")
  await until(main, "Boolean(document.querySelector('[role=dialog][aria-label=設定]'))", 'Settings did not open')
  await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '旧版の下書きを確認・復元').click()")
  await until(main, "document.querySelector('[aria-label=旧版の下書きを復元]')?.innerText.includes('下書きの内容を確認する')", 'Legacy draft recovery did not load')
  assert.equal(await main.webContents.executeJavaScript('localStorage.getItem(' + JSON.stringify(recoveredKey) + ')'), null, 'Opening recovery silently claimed an old draft')
  await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('[aria-label=旧版の下書きを復元] button')).find((button) => button.textContent.startsWith('下書きの内容を確認する')).click()")
  await until(main, "Boolean(document.querySelector('input[aria-label=タスク詳細の進捗を復元する]'))", 'Legacy draft list did not render')
  await capture(main, 'draft-recovery')
  await main.webContents.executeJavaScript("document.querySelector('input[aria-label=タスク詳細の進捗を復元する]').click()")
  assert.equal(await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('[aria-label=旧版の下書きを復元] button')).find((button) => button.textContent.startsWith('選択した')).disabled"), true, 'Recovery did not require ownership confirmation')
  await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('[aria-label=旧版の下書きを復元] input[type=checkbox]')).find((input) => !input.getAttribute('aria-label')).click()")
  await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('[aria-label=旧版の下書きを復元] button')).find((button) => button.textContent.startsWith('選択した')).click()")
  await until(main, 'localStorage.getItem(' + JSON.stringify(recoveredKey) + ') === "以前のWeb版で書いた未投稿の文章" && localStorage.getItem(' + JSON.stringify(legacyKey) + ') === null', 'Selected legacy draft did not move to the current account')
  await main.webContents.executeJavaScript("document.querySelector('[aria-label=旧版の下書きを復元] button[aria-label=閉じる]').click()")
  await main.webContents.executeJavaScript("Array.from(document.querySelectorAll('[role=dialog][aria-label=設定] button')).find((button) => button.textContent === '×').click()")

  const previousClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() }
  const previousImage = clipboard.readImage()
  if (!previousImage.isEmpty()) previousClipboard.image = previousImage
  try {
    main.webContents.focus()
    assert.equal(await main.webContents.executeJavaScript('Boolean(navigator.clipboard && isSecureContext)'), true)
    assert.equal(await main.webContents.executeJavaScript("navigator.clipboard.writeText('denied-probe').then(() => false, () => true)", true), true, 'Production clipboard permissions were not denied')
    const expectedMarkdown = await main.webContents.executeJavaScript("fetch('/api/markdown', { credentials: 'same-origin' }).then((response) => response.json()).then((data) => data.markdown)")
    const result = await main.webContents.executeJavaScript("window.api.markdownExport('clipboard')", true)
    assert.equal(result.success, true, result.message)
    await delay(150)
    assert.equal(clipboard.readText().replaceAll('\\r\\n', '\\n'), expectedMarkdown, 'Clipboard fallback did not write the actual Markdown')
  } finally { clipboard.write(previousClipboard) }

  // A frozen request rejected after task deletion must keep the original text visible.
  const deletedDraft = { body: '削除されたタスクの文章を回復', attempt: { requestId: 'fixture-deleted-request-20261009', expectedUserId: user.id,
    todoId: secondTodo.id, body: '削除されたタスクの文章を回復', stopTimer: false, expectedStartTime: null } }
  const deletedKey = 'hakobi-progress-draft:' + user.id + ':' + secondTodo.id
  await progress.webContents.executeJavaScript('localStorage.setItem(' + JSON.stringify(deletedKey) + ',' + JSON.stringify(JSON.stringify(deletedDraft)) + ')')
  await main.webContents.executeJavaScript('window.api.todoDelete(' + JSON.stringify(secondTodo.id) + ')')
  progress.webContents.send('hakobi:command', { type: 'progress-target', todoId: secondTodo.id })
  await until(progress, "document.querySelector('#quick-progress-body')?.value === " + JSON.stringify(deletedDraft.body), 'Deleted task draft could not be recovered')
  await progress.webContents.executeJavaScript("document.querySelector('button.primary').click()")
  await until(progress, "document.querySelector('button.primary')?.textContent !== '送信中…' && Boolean(document.querySelector('[role=alert]'))", 'Deleted task rejection did not release pending')
  await delay(300)
  assert.equal(await progress.webContents.executeJavaScript("document.querySelector('#quick-progress-body').value"), deletedDraft.body, 'Rejected text disappeared')
  assert.equal(await progress.webContents.executeJavaScript("document.querySelector('#quick-progress-task').value"), secondTodo.id, 'Deleted target silently changed')
  assert.ok(await progress.webContents.executeJavaScript('localStorage.getItem(' + JSON.stringify(deletedKey) + ')'))

  // Simulate a POST with no response, then a refresh that also never responds.
  progress.webContents.send('hakobi:command', { type: 'progress-target', todoId: todo.id })
  await until(progress, "document.querySelector('#quick-progress-task')?.value === " + JSON.stringify(todo.id), 'Progress did not return to a valid target')
  await setBody('通信失敗しても残す文章')
  await progress.webContents.executeJavaScript("window.fixtureFetch = window.fetch; window.fetch = (input, options = {}) => { const url = String(input); if (url.includes('/desktop/quick-progress') || url.includes('/auth/me')) return new Promise((resolve, reject) => { if (options.signal?.aborted) reject(new DOMException('Aborted', 'AbortError')); else options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); return window.fixtureFetch(input, options); }; void 0")
  await progress.webContents.executeJavaScript("document.querySelector('button.primary').click()")
  await delay(15500)
  assert.notEqual(await progress.webContents.executeJavaScript("document.querySelector('button.primary').textContent"), '送信中…', 'Refresh left submission locked after the POST timeout')
  assert.equal(await progress.webContents.executeJavaScript("document.querySelector('button[aria-label=閉じる]').disabled"), false)
  assert.equal(await progress.webContents.executeJavaScript('JSON.parse(localStorage.getItem(' + JSON.stringify(draftKey) + ')).attempt.body'), '通信失敗しても残す文章')
  progress.webContents.send('hakobi:command', { type: 'progress-target', todoId: secondTodo.id })
  await delay(150)
  assert.equal(await progress.webContents.executeJavaScript("document.querySelector('#quick-progress-task').value"), todo.id, 'Unconfirmed send switched its target')
  await progress.webContents.executeJavaScript('window.fetch = window.fixtureFetch; window.dispatchEvent(new Event("focus"))')
  await until(progress, "document.querySelector('button.primary')?.disabled === false", 'Bounded refresh did not recover')
  await progress.webContents.executeJavaScript("document.querySelector('button.primary').click()")
  await until(progress, "document.body.innerText.includes('進捗を投稿しました')", 'Frozen request could not be safely retried')
  assert.equal((await main.webContents.executeJavaScript('window.api.progressNoteGetByTodo(' + JSON.stringify(todo.id) + ')')).filter((note) => note.body === '通信失敗しても残す文章').length, 1)

  const groupB = createWindow('desktop.js', 'persist:hakobi-smoke-group-b', 520, 580)
  await groupB.loadURL(fixture.origin)
  await until(groupB, "Boolean(document.querySelector('input[autocomplete=username]'))", 'Group B unexpectedly inherited the login')
  assert.equal((await session.fromPartition('persist:hakobi-smoke-group-b').cookies.get({ url: fixture.origin })).length, 0)
  assert.equal(await groupB.webContents.executeJavaScript("fetch('/api/auth/me', { credentials: 'same-origin' }).then((response) => response.status)"), 401)
  assert.ok((await session.fromPartition('persist:hakobi-smoke-group-a').cookies.get({ url: fixture.origin })).some((cookie) => cookie.name === 'hakobi_smoke_session'))
  assert.equal(rendererErrors.length, 0, rendererErrors.join('\\n'))
  console.log('HAKOBI Electron smoke passed: isolation, login, clock skew, progress targets, drafts, timeout/retry, deleted task and legacy recovery, clipboard, timer and realtime')
  windows.forEach((window) => { if (!window.isDestroyed()) window.destroy() })
  app.exit(0)
}
run().catch((error) => { console.error(error.stack || error.message); windows.forEach((window) => { if (!window.isDestroyed()) window.destroy() }); app.exit(1) })
`)
  const electronEnvironment = { ...process.env }
  delete electronEnvironment.ELECTRON_RUN_AS_NODE
  electron = spawn(require('electron'), [runner, fixturePath], {
    cwd: root, windowsHide: true, env: electronEnvironment, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  electron.stdout.on('data', (chunk) => { output += chunk })
  electron.stderr.on('data', (chunk) => { output += chunk })
  const timeout = setTimeout(() => electron.kill(), 90000)
  const result = await new Promise((resolve, reject) => {
    electron.once('error', reject)
    electron.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timeout)
  const cleanOutput = output.replaceAll(fixture.password, '[test password]')
  process.stdout.write(cleanOutput)
  assert.equal(result.code, 0, `Electron smoke exited ${result.code ?? result.signal}`)
  assert.ok(cleanOutput.includes('HAKOBI Electron smoke passed:'), 'Electron exited before completing the smoke checks')
  console.log('Screenshots: node_modules/.hakobi-qa/{launcher,timer,timer-compact,progress,draft-recovery}.png')
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 }).finally(async () => {
  await stop(electron)
  await stop(server)
  // This test owns only the unique directory returned by mkdtemp below node_modules.
  assert.equal(path.dirname(path.resolve(temporaryDir)), path.resolve(modulesDir))
  assert.ok(path.basename(temporaryDir).startsWith('.hakobi-electron-test-'))
  fs.rmSync(temporaryDir, { recursive: true, force: true })
})
