// Native lifecycle regressions use the real BrowserWindow/network/preload in an
// isolated userData directory. Shortcut, tray and dialog adapters avoid OS changes.
// Run after npm run build. No live server, account, local DB or clipboard is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
const modules = path.join(root, 'node_modules')
const temporary = fs.mkdtempSync(path.join(modules, '.hakobi-native-electron-'))
let child

async function main() {
  for (const file of ['out/preload/desktop.js', 'out/preload/launcher.js', 'out/renderer/index.html']) {
    assert.ok(fs.existsSync(path.join(root, file)), `Build first: missing ${file}`)
  }
  const bundled = await build({
    stdin: { contents: "export { DesktopController } from './desktop-controller'", resolveDir: path.join(root, 'src/main'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'isolated-native-boundary', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onResolve({ filter: /^@electron-toolkit\/utils$/ }, () => ({ path: 'toolkit', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\/icon$/ }, () => ({ path: 'icon', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ loader: 'js', contents:
        args.path === 'electron' ? 'module.exports = globalThis.__hakobiNative' :
          args.path === 'toolkit' ? 'export const is = { dev: false }' :
            "export function generateDefaultIconBuffer() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }"
      }))
    } }]
  })
  fs.writeFileSync(path.join(temporary, 'controller.cjs'), bundled.outputFiles[0].text)
  const runner = path.join(temporary, 'run.cjs')
  fs.writeFileSync(runner, `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const electron = require('electron')
const { app, BrowserWindow } = electron
const root = ${JSON.stringify(root)}
const temporary = ${JSON.stringify(temporary)}
app.setPath('userData', path.join(temporary, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const desiredVisibility = new Map()
const dialogs = []
const ownedIpcChannels = new Set()
class FixtureTray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}
function HiddenWindow(options) {
  const window = new BrowserWindow({ ...options, show: false, webPreferences: {
    ...options.webPreferences, offscreen: true, backgroundThrottling: false
  } })
  const hide = window.hide.bind(window)
  window.show = () => desiredVisibility.set(window.id, true)
  window.showInactive = () => desiredVisibility.set(window.id, true)
  window.focus = () => {}
  window.hide = () => { desiredVisibility.set(window.id, false); hide() }
  return window
}
globalThis.__hakobiNative = {
  ...electron, BrowserWindow: HiddenWindow, Tray: FixtureTray,
  ipcMain: { handle: (channel, handler) => { ownedIpcChannels.add(channel); electron.ipcMain.handle(channel, handler) } },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  dialog: { showMessageBox: async (...args) => { dialogs.push(args.at(-1)); return { response: 1 } } }
}
const controllerModule = new Module(path.join(root, 'out/main/hakobi-native-fixture.cjs'), module)
controllerModule.filename = path.join(root, 'out/main/hakobi-native-fixture.cjs')
controllerModule.paths = Module._nodeModulePaths(path.join(root, 'out/main'))
controllerModule._compile(fs.readFileSync(path.join(temporary, 'controller.cjs'), 'utf8'), controllerModule.filename)
const { DesktopController } = controllerModule.exports
let documentRequests = 0
let holdDocument = true
let failDocuments = false
const heldResponses = new Set()
const sockets = new Set()
const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ ok: true, time: new Date().toISOString(), desktopProtocol: 1, webReady: true }))
    return
  }
  if (request.url === '/favicon.ico') { response.statusCode = 404; response.end(); return }
  documentRequests++
  if (failDocuments) { request.socket.destroy(); return }
  if (holdDocument) { heldResponses.add(response); response.on('close', () => heldResponses.delete(response)); return }
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><html><head><title>HAKOBI</title></head><body>HAKOBI Native lifecycle fixture</body></html>')
})
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
let controller
async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { if (await predicate()) return; await delay(25) }
  throw new Error(label)
}
async function loaded(window, label) {
  await until(() => !window.isDestroyed() && controller.windowStatus.get(window) === 'ready', label + ': document did not finish')
  assert.equal(await window.webContents.executeJavaScript('document.body.innerText'), 'HAKOBI Native lifecycle fixture')
  assert.equal(await window.webContents.executeJavaScript('typeof window.desktop.getContext'), 'function')
  assert.equal(window.getTitle(), 'HAKOBI — Native fixture', label + ': HTML title must preserve the group name')
  const updated = new Promise((resolve) => window.once('page-title-updated', (_event, title) => resolve(title)))
  await window.webContents.executeJavaScript('document.title = "Task-specific title"')
  assert.equal(await updated, 'Task-specific title')
  assert.equal(window.getTitle(), 'HAKOBI — Native fixture', label + ': dynamic page title must preserve the group name')
}
async function run() {
  await app.whenReady()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  controller = new DesktopController(() => { throw new Error('Must not start the personal DB') }, () => {})
  controller.start()
  await controller.connect({ name: 'Native fixture', url: origin })
  const initialMain = controller.windows.get('main')
  await until(() => documentRequests > 0, 'Initial remote request did not start')
  assert.equal(controller.connecting, true)
  const crash = new Promise((resolve) => initialMain.webContents.once('render-process-gone', resolve))
  initialMain.webContents.forcefullyCrashRenderer()
  await crash
  await until(() => !controller.connecting && initialMain.isDestroyed(), 'Initial crash did not release the connection state')
  assert.match(controller.launcherState().message, /停止|再接続/)
  await until(() => controller.launcher && !controller.launcher.webContents.isLoadingMainFrame(), 'Recovery launcher did not finish loading')
  assert.equal(controller.launcher.getTitle(), 'HAKOBI — 接続設定', 'Launcher HTML must preserve its native title')
  holdDocument = false
  for (const response of heldResponses) response.destroy()
  await controller.launcher.webContents.executeJavaScript('window.hakobiLauncher.retry()')
  const main = controller.windows.get('main')
  assert.notEqual(main, initialMain)
  await loaded(main, 'Retry main')
  await until(() => !controller.connecting, 'Retry main did not finish connecting')
  await main.loadURL(origin + '/same-origin-navigation')
  await loaded(main, 'Main after navigation')
  console.log('PASS group title: initial HTML, dynamic page titles and same-origin navigation keep the native group label')
  console.log('PASS B4: initial renderer crash unlocks connection form and actual launcher retry loads a fresh main')

  failDocuments = true
  await main.webContents.executeJavaScript('window.desktop.publishState(' + JSON.stringify({ userId: 'native-fixture-user', taskId: null, taskTitle: '', startTime: null, online: true }) + ')')
  const failedTimer = controller.windows.get('timer')
  await until(() => controller.windowStatus.get(failedTimer) === 'failed', 'Timer load failure was not recognized')
  assert.equal(desiredVisibility.get(failedTimer.id), false)
  assert.match(dialogs.at(-1).message, /タイマー.*開けません/)
  const requestsBeforeTimerRetry = documentRequests
  failDocuments = false
  await main.webContents.executeJavaScript('window.desktop.openTimer()')
  const timer = controller.windows.get('timer')
  assert.notEqual(timer, failedTimer)
  assert.equal(failedTimer.isDestroyed(), true)
  await loaded(timer, 'Retry timer')
  assert.ok(documentRequests > requestsBeforeTimerRetry)
  console.log('PASS B3 timer: failed document hidden, then reopened instance makes a new HTTP request and renders')

  assert.equal(timer.isResizable(), true, 'native timer window must be manually resizable')
  assert.deepEqual(timer.getSize(), [360, 250])
  assert.deepEqual(timer.getMinimumSize(), [320, 240])
  await assert.rejects(() => main.webContents.executeJavaScript('window.desktop.resizeTimer(true)'), /不正/)
  await assert.rejects(() => timer.webContents.executeJavaScript('window.desktop.resizeTimer("true")'), /不正/)
  const savedConfig = () => JSON.parse(fs.readFileSync(path.join(temporary, 'user-data', 'hakobi-desktop.json'), 'utf8'))
  const savedSize = (mode, width, height) => {
    const size = savedConfig().timerSizes?.[mode]
    return size?.width === width && size?.height === height
  }
  timer.setSize(430, 290)
  await until(() => savedSize('normal', 430, 290), 'Manual normal resize was not persisted')
  await timer.webContents.executeJavaScript('window.desktop.resizeTimer(true)')
  assert.deepEqual(timer.getMinimumSize(), [300, 150])
  assert.deepEqual(timer.getSize(), [320, 150], 'actual compact size must shrink below the old 250px minimum')
  assert.equal(savedConfig().preferences.timerCompact, true)
  timer.setSize(345, 170)
  await until(() => savedSize('compact', 345, 170), 'Manual compact resize was not persisted')
  await timer.webContents.executeJavaScript('window.desktop.resizeTimer(false)')
  assert.deepEqual(timer.getSize(), [430, 290])
  assert.deepEqual(timer.getMinimumSize(), [320, 240])
  await timer.webContents.executeJavaScript('window.desktop.resizeTimer(true)')
  assert.deepEqual(timer.getSize(), [345, 170])
  timer.destroy()
  await main.webContents.executeJavaScript('window.desktop.openTimer()')
  const recreatedTimer = controller.windows.get('timer')
  await loaded(recreatedTimer, 'Recreated custom compact timer')
  assert.deepEqual(recreatedTimer.getSize(), [345, 170])
  assert.equal(recreatedTimer.isResizable(), true)
  console.log('PASS real timer resize: native minimum constraints, compact shrink, manual resizing, persisted separate mode sizes and recreated window')

  for (const [kind, api] of [['gantt', 'openGantt'], ['report', 'openReport'], ['progress', 'openQuickProgress']]) {
    failDocuments = true
    await main.webContents.executeJavaScript('window.desktop.' + api + '()')
    const failed = controller.windows.get(kind)
    await until(() => controller.windowStatus.get(failed) === 'failed', kind + ' load failure was not recognized')
    assert.equal(desiredVisibility.get(failed.id), false)
    failDocuments = false
    const previousRequests = documentRequests
    await main.webContents.executeJavaScript('window.desktop.' + api + '()')
    const recovered = controller.windows.get(kind)
    assert.notEqual(recovered, failed)
    assert.equal(failed.isDestroyed(), true)
    await loaded(recovered, 'Retry ' + kind)
    assert.ok(documentRequests > previousRequests)
    console.log('PASS B3 ' + kind + ': failed instance replaced and document loaded after server recovery')
  }
  // Simulate restart using the same isolated persisted userData. Only the fixture's
  // own windows and handlers are removed; no live application or server is touched.
  controller.dispose()
  BrowserWindow.getAllWindows().forEach((window) => window.destroy())
  for (const channel of ownedIpcChannels) electron.ipcMain.removeHandler(channel)
  ownedIpcChannels.clear()
  controller = new DesktopController(() => { throw new Error('Must not start the personal DB after restart') }, () => {})
  controller.start()
  await until(() => controller.windows.has('main'), 'Restart did not open the saved server')
  const restartedMain = controller.windows.get('main')
  await loaded(restartedMain, 'Main after restart')
  await restartedMain.webContents.executeJavaScript('window.desktop.publishState(' + JSON.stringify({ userId: 'native-fixture-user', taskId: null, taskTitle: '', startTime: null, online: true }) + ')')
  const restartedTimer = controller.windows.get('timer')
  await loaded(restartedTimer, 'Timer after restart')
  assert.deepEqual(restartedTimer.getSize(), [345, 170], 'restart must restore custom compact geometry')
  assert.deepEqual(restartedTimer.getMinimumSize(), [300, 150])
  await restartedTimer.webContents.executeJavaScript('window.desktop.resizeTimer(false)')
  assert.deepEqual(restartedTimer.getSize(), [430, 290], 'restart must preserve separate normal geometry')
  console.log('PASS real timer restart: persisted compact preference and both custom mode dimensions reloaded from isolated userData')
  console.log('HAKOBI native Electron lifecycle checks passed')
  finish(0)
}
function finish(code) {
  controller?.dispose()
  BrowserWindow.getAllWindows().forEach((window) => window.destroy())
  for (const response of heldResponses) response.destroy()
  for (const socket of sockets) socket.destroy()
  server.close()
  app.exit(code)
}
run().catch((error) => { console.error(error.stack || error.message); finish(1) })
`)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(require('electron'), [runner], { cwd: root, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 60000)
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  clearTimeout(timeout)
  process.stdout.write(output)
  assert.equal(exit.code, 0, `Native Electron checks exited ${exit.code ?? exit.signal}`)
  assert.ok(output.includes('HAKOBI native Electron lifecycle checks passed'), 'Electron exited before completing the native checks')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(modules))
  assert.ok(path.basename(temporary).startsWith('.hakobi-native-electron-'))
  fs.rmSync(temporary, { recursive: true, force: true })
})
