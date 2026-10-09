const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
let code
async function compile() {
  return (await build({ entryPoints: [path.join(root, 'web/auth/AuthGate.tsx')], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'auth-test-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, (args) => ({ path: args.path, namespace: 'mock' }))
    builder.onResolve({ filter: /^(\.\.\/lib\/client|@renderer\/lib\/serverClock|\.\/LoginScreen|\.\/UserContext)$/ }, (args) => ({ path: args.path, namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path: name }) => ({ loader: 'js', contents:
      name === 'react' ? 'module.exports = globalThis.__authHarness.React' :
      name === 'react/jsx-runtime' ? 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx' :
      name === '../lib/client' ? 'export const connectRealtime = () => {}; export const disconnectRealtime = () => {}' :
      name === '@renderer/lib/serverClock' ? 'export const startServerClockSync = () => () => {}' :
      name === './LoginScreen' ? 'export const LoginScreen = () => null' : 'export const UserProvider = () => null'
    }))
  } }] })).outputFiles[0].text
}

function harness() {
  const requests = []
  const phases = []
  const effects = []
  const callbacks = []
  const timers = new Map()
  let nextTimer = 1
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, (phase) => phases.push(phase)],
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => { callbacks.push(callback); return callback },
    useEffect: (effect) => { effects.push(effect) }
  }
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, require, __authHarness: { React }, console, AbortController,
    setTimeout: (callback, ms) => { const id = nextTimer++; timers.set(id, { callback, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    window: {}, location: { hash: '' },
    fetch: (url, options) => {
      assert.equal(url, '/api/auth/me')
      assert.equal(options.credentials, 'same-origin')
      assert.ok(options.signal instanceof AbortSignal)
      return new Promise((resolve, reject) => requests.push({ options, resolve, reject }))
    }
  })
  vm.runInContext(code, context)
  module.exports.AuthGate({ children: null })
  let cleanups = []
  return {
    requests, phases, check: callbacks[0],
    mount: () => { cleanups = effects.map((effect) => effect()) },
    unmount: () => { cleanups.forEach((cleanup) => { if (typeof cleanup === 'function') cleanup() }); cleanups = [] },
    deadline: () => { for (const [id, timer] of [...timers]) if (timer.ms === 10000) { timers.delete(id); timer.callback() } },
    reply: (index, id) => requests[index].resolve({ ok: true, status: 200, json: async () => ({ user: { id } }) }),
    phase: () => phases.at(-1), timers
  }
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
async function main() {
  code = await compile()
  const stalled = harness()
  stalled.mount()
  assert.equal(stalled.phase().kind, 'loading')
  stalled.deadline()
  await flush()
  assert.equal(stalled.requests[0].options.signal.aborted, true)
  assert.equal(stalled.phase().kind, 'error', 'initial auth must release loading even if transport ignores cancellation')
  assert.match(stalled.phase().message, /応答を確認できません/)
  const retry = stalled.check()
  stalled.reply(1, 'current-user')
  await retry
  assert.equal(stalled.phase().kind, 'authed')
  assert.equal(stalled.phase().user.id, 'current-user')
  stalled.reply(0, 'stale-user')
  await flush()
  assert.equal(stalled.phase().user.id, 'current-user', 'late completion of the timed-out attempt must not change the account')
  stalled.unmount()
  assert.equal(stalled.timers.size, 0)

  const removed = harness()
  removed.mount()
  removed.unmount()
  const previousPhaseCount = removed.phases.length
  removed.reply(0, 'user-after-unmount')
  await flush()
  assert.equal(removed.requests[0].options.signal.aborted, true)
  assert.equal(removed.phases.length, previousPhaseCount, 'cleanup must prevent state changes from an obsolete auth check')

  const strict = harness()
  strict.mount()
  strict.unmount()
  strict.mount()
  assert.equal(strict.requests[0].options.signal.aborted, true)
  strict.reply(0, 'old-mount')
  await flush()
  assert.equal(strict.phase().kind, 'loading')
  strict.reply(1, 'new-mount')
  await flush()
  assert.equal(strict.phase().user.id, 'new-mount', 'StrictMode remount must ignore the obsolete request')
  strict.unmount()

  const expired = harness()
  expired.mount()
  expired.requests[0].resolve({ ok: false, status: 401 })
  await flush()
  assert.equal(expired.phase().kind, 'anon')
  expired.unmount()
  console.log('Auth session checks passed: initial timeout, retry, stale response protection, unmount, StrictMode and expired sessions')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
