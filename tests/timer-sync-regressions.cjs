// Exercise the actual React hook in a hidden Electron renderer. Only the API,
// clock samples and interval scheduler are controlled; no server or DB is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
const ownedParent = path.join(root, 'node_modules')
const temporary = fs.mkdtempSync(path.join(ownedParent, '.timer-sync-test-'))
let child

async function main() {
  const bundle = await build({
    stdin: { contents: `
      import React, { useEffect } from 'react'
      import { createRoot } from 'react-dom/client'
      import { flushSync } from 'react-dom'
      import { useTimer } from './src/renderer/src/hooks/useTimer'
      const intervals = new Map(); let nextInterval = 1; let activeRoot = null
      window.clockListeners = new Set(); window.clockNow = Date.parse('2026-10-09T03:00:00Z')
      window.setInterval = (callback) => { const id = nextInterval++; intervals.set(id, callback); return id }
      window.clearInterval = (id) => intervals.delete(id)
      window.unhandled = []; window.addEventListener('unhandledrejection', (event) => { window.unhandled.push(String(event.reason)); event.preventDefault() })
      window.callbackErrors = []; const previousError = console.error
      console.error = (...args) => { window.callbackErrors.push(args.map(String).join(' ')); previousError(...args) }
      window.requests = []; window.jobs = []; window.stoppedCalls = 0; window.callbackFailure = null
      const request = (kind, args) => new Promise((resolve, reject) => window.requests.push({kind,args,resolve,reject}))
      window.api = { timerGetRunning: () => request('get', []), timerStart: (id) => request('start', [id]), timerStop: (note) => request('stop', [note]) }
      function Probe({ autoSync }) {
        const timer = useTimer(() => {
          window.stoppedCalls++
          if (window.callbackFailure === 'reject') return Promise.reject(new Error('refresh rejected'))
          if (window.callbackFailure === 'throw') throw new Error('refresh threw')
        })
        useEffect(() => { window.timer = timer })
        useEffect(() => { if (autoSync) window.jobs.push(timer.sync()) }, [autoSync, timer.sync])
        return null
      }
      window.mount = (strict = false, autoSync = false) => {
        window.requests = []; window.jobs = []; window.timer = null; window.stoppedCalls = 0; window.callbackFailure = null
        window.callbackErrors = []; window.unhandled = []
        activeRoot = createRoot(document.getElementById('root'))
        flushSync(() => activeRoot.render(strict ? <React.StrictMode><Probe autoSync={autoSync}/></React.StrictMode> : <Probe autoSync={autoSync}/>))
      }
      window.unmount = () => { flushSync(() => activeRoot.unmount()); activeRoot = null }
      window.begin = async (method, value) => {
        const job = window.jobs.length; window.jobs.push(Promise.resolve(window.timer[method](value)))
        await Promise.resolve()
        return { job, request: window.requests.length - 1 }
      }
      window.reply = (index, value, fail = false) => fail ? window.requests[index].reject(new Error(value)) : window.requests[index].resolve(value)
      window.snapshot = () => ({ isRunning: window.timer.isRunning, runningTodoId: window.timer.runningTodoId,
        elapsedSeconds: window.timer.elapsedSeconds, startTime: window.timer.startTime,
        intervals: intervals.size, listeners: window.clockListeners.size, stoppedCalls: window.stoppedCalls })
      window.flush = () => flushSync(() => {})
      window.advance = (ms) => { window.clockNow += ms; for (const callback of intervals.values()) callback(); window.flush() }
      window.calibrate = (ms) => { window.clockNow += ms; for (const callback of window.clockListeners) callback(); window.flush() }
    `, resolveDir: root, loader: 'tsx' },
    outfile: path.join(temporary, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'timer-clock-boundary', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/lib\/serverClock$/ }, () => ({ path: 'clock', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents:
        'export const serverNow = () => window.clockNow; export const subscribeServerClock = (listener) => { window.clockListeners.add(listener); return () => window.clockListeners.delete(listener) }'
      }))
    } }]
  })
  assert.equal(bundle.errors.length, 0)
  fs.writeFileSync(path.join(temporary, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="renderer.js"></script></body></html>')
  const runner = path.join(temporary, 'run.cjs')
  fs.writeFileSync(runner, `
    const assert = require('node:assert/strict')
    const http = require('node:http')
    const path = require('node:path')
    const { app, BrowserWindow } = require('electron')
    const temporary = ${JSON.stringify(temporary)}
    app.setPath('userData', path.join(temporary, 'user-data'))
    app.commandLine.appendSwitch('disable-gpu')
    app.on('window-all-closed', () => {})
    let window, fixtureServer
    const heldResponses = []
    let serverRunning = null
    const A = { todo_id: 'A', start_time: '2026-10-09T02:58:00.000Z' }
    const B = { todo_id: 'B', start_time: '2026-10-09T02:59:30.000Z' }
    const js = (code) => window.webContents.executeJavaScript(code)
    const mount = () => js('window.mount(); window.flush()')
    const snapshot = () => js('window.snapshot()')
    const begin = (method, value) => js('window.begin(' + JSON.stringify(method) + ',' + JSON.stringify(value ?? null) + ')')
    const restore = async (running) => { await begin('restore', running); await js('window.flush()') }
    const reply = async (operation, value) => {
      await js('window.reply(' + operation.request + ',' + JSON.stringify(value) + ')')
      await js('window.jobs[' + operation.job + '].then(() => window.flush())')
    }
    const unmount = async () => {
      await js('window.unmount()')
      const state = await snapshot(); assert.equal(state.intervals, 0); assert.equal(state.listeners, 0)
    }
    const until = async (check) => {
      const deadline = Date.now() + 2000
      while (!await check()) { if (Date.now() >= deadline) throw new Error('Timer fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
    }
    async function run() {
      await app.whenReady()
      window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } })
      await window.loadFile(path.join(temporary, 'index.html'))
      await mount(); await restore(A)
      const beforeStop = await begin('sync'); const stop = await begin('stop', 'stop note')
      await reply(stop, null); await reply(beforeStop, A)
      assert.equal((await snapshot()).isRunning, false)
      assert.equal((await snapshot()).intervals, 0, 'old GET cannot restart interval after stop')
      await unmount()

      await mount(); await restore(A)
      const beforeSwitch = await begin('sync'); const start = await begin('start', 'B')
      await reply(start, B); await reply(beforeSwitch, A)
      assert.equal((await snapshot()).runningTodoId, 'B', 'old GET cannot undo task switch')
      assert.equal((await snapshot()).elapsedSeconds, 30)
      await js('Date.now = () => 9999999999999; window.advance(5000)')
      assert.equal((await snapshot()).elapsedSeconds, 35, 'timer uses calibrated clock despite PC clock skew')
      await js('window.calibrate(2000)')
      assert.equal((await snapshot()).elapsedSeconds, 37, 'clock calibration updates an active timer')
      await unmount()

      await mount(); await restore(A)
      const pendingStart = await begin('start', 'B'); const duringStart = await begin('sync')
      await reply(duringStart, null)
      assert.equal((await snapshot()).runningTodoId, 'A', 'GET during mutation cannot apply an older snapshot')
      await reply(pendingStart, B)
      assert.equal((await snapshot()).runningTodoId, 'B')
      const first = await begin('sync'); const second = await begin('sync')
      await reply(second, B); await reply(first, null)
      assert.equal((await snapshot()).runningTodoId, 'B', 'older overlapping GET cannot override latest result')
      const beforeRestore = await begin('sync'); await restore(A); await reply(beforeRestore, null)
      assert.equal((await snapshot()).runningTodoId, 'A', 'authoritative restore invalidates pending GET')
      await unmount()

      await mount(); await restore(A)
      const removedGet = await begin('sync'); await unmount(); await reply(removedGet, A)
      assert.equal((await snapshot()).intervals, 0, 'GET completion after unmount cannot create interval')
      await mount(); const removedStart = await begin('start', 'B'); await unmount(); await reply(removedStart, B)
      assert.equal((await snapshot()).intervals, 0, 'mutation completion after unmount cannot create interval')
      assert.equal((await snapshot()).stoppedCalls, 0)

      await js('window.mount(true, true); window.flush()')
      assert.equal(await js('window.requests.length'), 2, 'StrictMode starts a fresh effect request')
      await js('window.reply(0,' + JSON.stringify(A) + '); window.jobs[0].then(() => window.flush())')
      assert.equal((await snapshot()).isRunning, false, 'old StrictMode request is discarded')
      await js('window.reply(1,' + JSON.stringify(B) + '); window.jobs[1].then(() => window.flush())')
      assert.equal((await snapshot()).runningTodoId, 'B')
      assert.equal((await snapshot()).intervals, 1)
      await unmount()

      await mount(); await js('window.callbackFailure = "reject"')
      await reply(await begin('start', 'B'), B)
      await js('new Promise(resolve => setTimeout(resolve, 0))')
      assert.equal(await js('window.unhandled.length'), 0, 'rejected async refresh is handled')
      assert.ok(await js('window.callbackErrors.some(message => message.includes("作業時間"))'))
      await js('window.callbackFailure = "throw"')
      await reply(await begin('stop'), null)
      assert.equal((await snapshot()).isRunning, false, 'synchronous refresh failure does not reject a saved stop')
      assert.equal((await snapshot()).stoppedCalls, 2)
      await unmount()

      // Real HTTP server commits first, while the response is held independently.
      fixtureServer = http.createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*')
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        response.setHeader('Content-Type', 'application/json')
        if (request.method === 'OPTIONS') { response.end(); return }
        if (request.url === '/running') { response.end(JSON.stringify(serverRunning)); return }
        let body = ''
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          const input = JSON.parse(body || '{}')
          if (input.todoId === 'fail') {
            heldResponses.push({ response, result: { error: 'start failed' }, status: 500 })
          } else {
            serverRunning = request.url === '/start' ? input.todoId === 'A' ? A : B : null
            heldResponses.push({ response, result: serverRunning, status: 200 })
          }
        })
      })
      await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
      const base = 'http://127.0.0.1:' + fixtureServer.address().port
      await js('window.api = { timerGetRunning: () => fetch(' + JSON.stringify(base + '/running') + ').then(response => response.json()),' +
        'timerStart: id => fetch(' + JSON.stringify(base + '/start') + ', {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({todoId:id})}).then(async response => { if (!response.ok) throw new Error("start failed"); return response.json() }),' +
        'timerStop: note => fetch(' + JSON.stringify(base + '/stop') + ', {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note})}).then(response => response.json()) }; void 0')
      const release = async (index, operation) => {
        const held = heldResponses[index]; held.response.statusCode = held.status; held.response.end(JSON.stringify(held.result))
        await js('window.jobs[' + operation.job + '].then(() => window.flush(), error => error.message)')
      }
      await mount()
      const startA = await begin('start', 'A')
      await until(() => heldResponses.length === 1)
      assert.equal(serverRunning.todo_id, 'A', 'server committed A before its response arrives')
      const startB = await begin('start', 'B')
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(heldResponses.length, 1, 'B waits until A response, preventing B then A display order')
      await release(0, startA)
      await until(() => heldResponses.length === 2)
      assert.equal(serverRunning.todo_id, 'B')
      await release(1, startB)
      assert.equal((await snapshot()).runningTodoId, 'B')
      await unmount()

      await mount()
      const heldStart = await begin('start', 'A')
      await until(() => heldResponses.length === 3)
      const heldStop = await begin('stop', 'queued stop')
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(heldResponses.length, 3, 'stop waits for the earlier start response')
      await release(2, heldStart)
      await until(() => heldResponses.length === 4)
      assert.equal(serverRunning, null)
      await release(3, heldStop)
      assert.equal((await snapshot()).isRunning, false)
      assert.equal((await snapshot()).intervals, 0)
      await unmount()

      await mount()
      const failedStart = await begin('start', 'fail')
      await until(() => heldResponses.length === 5)
      const afterFailure = await begin('start', 'B')
      await release(4, failedStart)
      await until(() => heldResponses.length === 6)
      await release(5, afterFailure)
      assert.equal((await snapshot()).runningTodoId, 'B', 'failed mutation does not block queued commands')
      await unmount()

      await mount()
      const externalStart = await begin('start', 'A')
      await until(() => heldResponses.length === 7)
      serverRunning = B // Another window commits B while our old A response is held.
      const duringMutation = await begin('sync')
      await js('window.jobs[' + duringMutation.job + ']')
      await release(6, externalStart)
      await until(async () => (await snapshot()).runningTodoId === 'B')
      assert.equal((await snapshot()).intervals, 1, 'deferred sync recovers another window change during a mutation')
      await unmount()
      console.log('Timer sync regressions passed: real React/HTTP, old GET, ordered mutations, failed queue continuation, other-window resync, unmount, StrictMode, clock and callback failures')
      finish(0)
    }
    function finish(code) {
      if (window && !window.isDestroyed()) window.destroy()
      for (const held of heldResponses) held.response.destroy()
      fixtureServer?.closeAllConnections(); fixtureServer?.close()
      app.exit(code)
    }
    run().catch((error) => { console.error(error.stack || error); finish(1) })
  `)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  child = spawn(require('electron'), [runner], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 30000)
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  clearTimeout(timeout)
  process.stdout.write(output)
  assert.equal(result.code, 0, 'Timer Electron checks failed: ' + (result.code ?? result.signal))
  assert.ok(output.includes('Timer sync regressions passed'), 'Renderer exited before finishing checks')
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
  assert.equal(path.dirname(path.resolve(temporary)), ownedParent)
  assert.ok(path.basename(temporary).startsWith('.timer-sync-test-'))
  fs.rmSync(temporary, { recursive: true, force: true })
})
