const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const bundle = buildSync({ entryPoints: [path.join(root, 'web/lib/client.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: { '@renderer': path.join(root, 'src/renderer/src') } }).outputFiles[0].text

function createClient(fallbackSucceeds = true, fakeTimers = false) {
  const events = { deniedWrites: 0, fallbackCalls: 0, removed: 0, requests: [], timers: new Map() }
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, require, console, URLSearchParams, AbortController,
    setTimeout: fakeTimers ? (callback, ms) => { const id = {}; events.timers.set(id, { callback, ms }); return id } : setTimeout,
    clearTimeout: fakeTimers ? (id) => events.timers.delete(id) : clearTimeout,
    navigator: { clipboard: { writeText: async () => { events.deniedWrites++; throw new Error('Write permission denied') } } },
    window: { isSecureContext: true, addEventListener() {}, location: { reload() {} }, localStorage: { removeItem() {} } },
    document: {
      createElement: () => ({ style: {}, focus() {}, select() {}, remove() { events.removed++ } }),
      body: { appendChild() {} },
      execCommand: (command) => { assert.equal(command, 'copy'); events.fallbackCalls++; return fallbackSucceeds }
    },
    fetch: async (url, options) => {
      events.requests.push({ url, options })
      const response = events.respond ? await events.respond(url, options) : { status: 200, data: { markdown: '# 作業ログ\n確認しました' } }
      return { ok: response.status < 400, status: response.status, text: async () => JSON.stringify(response.data) }
    }
  })
  vm.runInContext(bundle, context)
  return { api: module.exports.api, fetchDesktopTaskSnapshot: module.exports.fetchDesktopTaskSnapshot, events }
}

async function main() {
  const client = createClient()
  const success = await client.api.markdownExport('clipboard')
  assert.equal(success.success, true)
  assert.equal(client.events.deniedWrites, 1)
  assert.equal(client.events.fallbackCalls, 1)
  assert.equal(client.events.removed, 1)
  const blocked = createClient(false)
  const failure = await blocked.api.markdownExport('clipboard')
  assert.equal(failure.success, false, 'denial plus failed fallback must not announce a successful copy')
  assert.match(failure.message, /コピーできません/)
  assert.equal(blocked.events.removed, 1)

  const snapshot = createClient()
  const controller = new AbortController()
  snapshot.events.respond = (url) => ({ status: 200, data: url === '/api/auth/me' ? { user: { id: 'user' } } : url === '/api/todos' ? [{ id: 'task' }] : { todo_id: 'task', start_time: '2026-10-09T00:00:00Z' } })
  const data = await snapshot.fetchDesktopTaskSnapshot(controller.signal)
  assert.equal(data.user.id, 'user')
  assert.equal(data.todos[0].id, 'task')
  assert.equal(data.running.todo_id, 'task')
  assert.equal(snapshot.events.requests.length, 3)
  assert.ok(snapshot.events.requests.every(({ options }) => options.signal === controller.signal && options.credentials === 'same-origin'))

  const anonymous = createClient()
  anonymous.events.respond = () => ({ status: 401, data: { error: 'ログインが必要です' } })
  assert.equal((await anonymous.fetchDesktopTaskSnapshot(controller.signal)).user, null)
  assert.equal(anonymous.events.requests.length, 1, 'never fetch task data after an expired login')
  assert.equal(await anonymous.api.authGetCurrentUser(), null, 'shared UI authentication still treats an expired login as anonymous')

  const boundedAuth = createClient(true, true)
  boundedAuth.events.respond = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  const auth = boundedAuth.api.authGetCurrentUser()
  const rejection = assert.rejects(auth, /応答を確認できません/)
  const deadline = [...boundedAuth.events.timers.values()].find((timer) => timer.ms === 10000)
  assert.ok(deadline, 'draft recovery account checks require a deadline')
  deadline.callback()
  await rejection
  assert.equal(boundedAuth.events.requests[0].options.signal.aborted, true)
  assert.equal(boundedAuth.events.timers.size, 0)

  const cancelled = createClient()
  cancelled.events.respond = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  const abort = new AbortController()
  const pending = cancelled.fetchDesktopTaskSnapshot(abort.signal)
  abort.abort()
  await assert.rejects(pending, /aborted/)
  console.log('Web client regressions passed: clipboard fallback, abortable desktop refresh and bounded draft recovery account checks')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
