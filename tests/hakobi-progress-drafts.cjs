const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

function bundled(file) {
  return buildSync({ entryPoints: [path.join(__dirname, '..', file)], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
}
const draftModule = { exports: {} }
new Function('module', 'exports', bundled('web/desktop/progressDrafts.ts'))(draftModule, draftModule.exports)
const { progressDraftKey, readProgressDraft, writeProgressDraft, listProgressDrafts, transferProgressDraft } = draftModule.exports
class MemoryStorage {
  values = new Map()
  failWrites = false
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failWrites) throw new Error('Storage full'); this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const storage = new MemoryStorage()
const attempt = { requestId: 'progress-draft-fixture-0001', expectedUserId: 'u1', todoId: 'deleted', body: '送信結果を確認する本文', stopTimer: true, expectedStartTime: '2026-10-09T10:00:00.000Z' }
writeProgressDraft(storage, 'u1', 'deleted', { body: attempt.body, attempt, taskTitle: '削除されたタスク', lastError: '応答未確認' })
writeProgressDraft(storage, 'u2', 'private', { body: '別のアカウントの本文' })
writeProgressDraft(storage, 'u1x', 'private', { body: '似たIDの別のアカウント' })
assert.deepEqual(listProgressDrafts(storage, 'u1').map(({ todoId }) => todoId), ['deleted'])
assert.deepEqual(readProgressDraft(storage, 'u1', 'deleted').attempt, attempt, 'A restored attempt preserves the exact request/timer payload')
assert.equal(readProgressDraft(storage, 'u1', 'deleted').lastError, '応答未確認')
assert.throws(() => transferProgressDraft(storage, 'u1', 'deleted', 'new'), /未確認/)
assert.equal(storage.getItem(progressDraftKey('u1', 'new')), null)
storage.setItem(progressDraftKey('u1', 'corrupt'), 'null')
assert.deepEqual(readProgressDraft(storage, 'u1', 'corrupt'), { body: '' })
storage.setItem(progressDraftKey('u1', 'wrong-account'), JSON.stringify({ body: '本文', attempt: { ...attempt, todoId: 'wrong-account', expectedUserId: 'u2' } }))
assert.equal(readProgressDraft(storage, 'u1', 'wrong-account').attempt, undefined)
writeProgressDraft(storage, 'u1', 'source', { body: '移す本文' })
writeProgressDraft(storage, 'u1', 'destination', { body: '先にある本文' })
assert.equal(transferProgressDraft(storage, 'u1', 'source', 'destination').body, '先にある本文\n\n移す本文')
assert.equal(storage.getItem(progressDraftKey('u1', 'source')), null)
writeProgressDraft(storage, 'u1', 'source', { body: '消してはいけない本文' })
storage.failWrites = true
assert.throws(() => transferProgressDraft(storage, 'u1', 'source', 'destination'), /Storage full/)
storage.failWrites = false
assert.equal(readProgressDraft(storage, 'u1', 'source').body, '消してはいけない本文', 'Destination write failure leaves the source intact')
assert.throws(() => transferProgressDraft(storage, 'u1', 'source', 'deleted'), /未確認/)
writeProgressDraft(storage, 'u1', 'large', { body: 'a'.repeat(10000) })
assert.throws(() => transferProgressDraft(storage, 'u1', 'source', 'large'), /10000/)
assert.equal(readProgressDraft(storage, 'u1', 'source').body, '消してはいけない本文')
assert.equal(readProgressDraft(storage, 'u1', 'large').body.length, 10000)

let onCommand
let onHash
const location = { hash: '#hakobi-progress' }
const targetModule = { exports: {} }
new Function('window', 'location', 'module', 'exports', bundled('web/desktop/progressTarget.ts'))({
  desktop: { onCommand: (listener) => { onCommand = listener } },
  addEventListener: (event, listener) => { if (event === 'hashchange') onHash = listener }
}, location, targetModule, targetModule.exports)
onCommand({ type: 'progress-target', todoId: 'before-auth-A' })
onCommand({ type: 'progress-target', todoId: 'before-auth-B' })
const received = []
const unsubscribe = targetModule.exports.subscribeProgressTarget((id) => received.push(id))
assert.deepEqual(received, ['before-auth-B'], 'Only the latest target arriving before AuthGate mounts is replayed')
location.hash = '#hakobi-progress?todo=after-hash'
onHash()
assert.deepEqual(received, ['before-auth-B', 'after-hash'])
unsubscribe()
onCommand({ type: 'progress-target', todoId: 'while-unmounted' })
targetModule.exports.subscribeProgressTarget((id) => received.push(id))()
assert.equal(received.at(-1), 'while-unmounted')
console.log('HAKOBI progress draft checks passed: account isolation, deleted drafts, frozen requests, safe transfers, size/storage failures and pre-auth target queue')
