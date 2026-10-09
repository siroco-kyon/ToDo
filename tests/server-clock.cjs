const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/lib/serverClock.ts'), 'utf8')
const code = transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code
function clock() {
  let local = Date.parse('2026-10-09T03:00:00Z')
  let monotonic = 1000
  const listeners = new Map()
  const sandbox = {
    module: { exports: {} }, Date: { now: () => local, parse: Date.parse },
    performance: { now: () => monotonic }, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name) }
    },
    fetch: async (_url, options) => {
      assert.equal(options.signal.aborted, false)
      monotonic += 200
      local += 200
      return { ok: true, json: async () => ({ time: '2026-10-09T02:50:00.100Z' }) }
    }
  }
  vm.runInNewContext(code, sandbox)
  return { api: sandbox.module.exports, sandbox, advance: (ms) => { local += ms; monotonic += ms },
    skewLocal: (ms) => { local += ms }, local: () => local, listeners }
}
async function main() {
  const test = clock()
  assert.equal(test.api.serverNow(), test.local(), 'Individual mode retains the local clock')
  let updates = 0
  const unsubscribe = test.api.subscribeServerClock(() => { updates++ })
  await test.api.syncServerClock(new AbortController().signal)
  assert.equal(updates, 1)
  assert.equal(test.api.serverClockOffset(), -600000, 'Correct a PC clock ten minutes ahead using RTT midpoint')
  assert.equal(test.api.serverNow(), Date.parse('2026-10-09T02:50:00.200Z'))
  test.advance(1500)
  assert.equal(test.api.serverNow(), Date.parse('2026-10-09T02:50:01.700Z'))
  test.skewLocal(-1200000)
  assert.equal(test.api.serverNow(), Date.parse('2026-10-09T02:50:01.700Z'), 'A local clock correction must not jump the running timer')
  assert.equal(test.api.serverClockOffset(), 600000, 'Tray offset adapts to local clock changes')
  unsubscribe()
  await test.api.syncServerClock(new AbortController().signal)
  assert.equal(updates, 1)

  const cancelled = clock()
  const request = new AbortController()
  cancelled.sandbox.fetch = async () => {
    request.abort()
    return { ok: true, json: async () => ({ time: '2026-10-09T01:00:00Z' }) }
  }
  await cancelled.api.syncServerClock(request.signal)
  assert.equal(cancelled.api.serverNow(), cancelled.local(), 'A cancelled sample cannot replace the current clock')

  const failure = clock()
  failure.sandbox.fetch = async () => ({ ok: false })
  await failure.api.syncServerClock(new AbortController().signal)
  assert.equal(failure.api.serverNow(), failure.local(), 'Unavailable health samples retain the previous clock')
  failure.sandbox.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const cleanup = failure.api.startServerClockSync()
  assert.ok(failure.listeners.has('focus'))
  cleanup()
  assert.equal(failure.listeners.size, 0, 'Unmount removes focus listeners and cancels the in-flight sample')
  console.log('Server clock checks passed: local mode, skew, RTT, monotonic ticking and cancellation')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
