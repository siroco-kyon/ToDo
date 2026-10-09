const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

const directory = fs.mkdtempSync(path.join(__dirname, '../node_modules/.legacy-draft-test-'))
const output = path.join(directory, 'drafts.cjs')
buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/src/lib/legacyProgressDrafts.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs' })
const { listLegacyProgressDrafts, legacyDraftAvailability, restoreLegacyProgressDrafts } = require(output)
class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); this.failWrite = false }
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failWrite) throw new Error('storage full'); this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}
try {
  const storage = new MemoryStorage({
    'progress-note-draft:task-detail': '詳細で途中まで書いた進捗',
    'progress-note-draft:other-user:task-secret': '他ユーザーの現在の下書き',
    'progress-timeline-note-drafts': JSON.stringify({ 'task-timeline': 'タイムラインの下書き', 'task-untouched': '今回は選ばない', empty: '', invalid: 5 }),
    'progress-timeline-comment-drafts': JSON.stringify({ 'note:note-1': '進捗へのコメント', 'reply:comment-1': 'コメントへの返信' }),
    'progress-timeline-comment-drafts:other-user': JSON.stringify({ 'note:secret': '他ユーザーの返信' })
  })
  const before = [...storage.values.entries()]
  const available = listLegacyProgressDrafts(storage)
  assert.equal(available.length, 5)
  assert.deepEqual([...storage.values.entries()], before, 'listing must not import, remove, or change unclaimed drafts')
  assert.ok(available.every((draft) => !draft.body.includes('他ユーザー')), 'never inspect another user’s scoped drafts')

  const chosen = available.filter((draft) => draft.todoId !== 'task-untouched')
  const restored = restoreLegacyProgressDrafts(storage, chosen, 'current-user')
  assert.equal(restored.restored.length, 4)
  assert.equal(storage.getItem('progress-note-draft:current-user:task-detail'), chosen.find((draft) => draft.kind === 'detail').body)
  assert.equal(storage.getItem('progress-note-draft:task-detail'), null)
  assert.deepEqual(JSON.parse(storage.getItem('progress-timeline-note-drafts:current-user')), { 'task-timeline': 'タイムラインの下書き' })
  assert.deepEqual(JSON.parse(storage.getItem('progress-timeline-note-drafts')), { 'task-untouched': '今回は選ばない', empty: '', invalid: 5 })
  assert.deepEqual(JSON.parse(storage.getItem('progress-timeline-comment-drafts:current-user')), { 'note:note-1': '進捗へのコメント', 'reply:comment-1': 'コメントへの返信' })
  assert.equal(storage.getItem('progress-timeline-comment-drafts'), null)
  assert.equal(storage.getItem('progress-note-draft:other-user:task-secret'), '他ユーザーの現在の下書き')
  assert.equal(restoreLegacyProgressDrafts(storage, chosen, 'current-user').restored.length, 0, 'repeating a stale selection must not duplicate a restored draft')

  const conflicts = new MemoryStorage({
    'progress-note-draft:task-conflict': '旧版の文章',
    'progress-note-draft:current-user:task-conflict': '今の文章を保持する',
    'progress-timeline-note-drafts': JSON.stringify({ same: '同じ内容', conflict: '古い内容' }),
    'progress-timeline-note-drafts:current-user': JSON.stringify({ same: '同じ内容', conflict: '新しい内容', untouched: 'そのまま' })
  })
  const conflictDrafts = listLegacyProgressDrafts(conflicts)
  assert.equal(legacyDraftAvailability(conflicts, conflictDrafts.find((draft) => draft.todoId === 'same'), 'current-user'), 'same')
  assert.equal(legacyDraftAvailability(conflicts, conflictDrafts.find((draft) => draft.todoId === 'task-conflict'), 'current-user'), 'conflict')
  const previous = [...conflicts.values.entries()]
  assert.equal(restoreLegacyProgressDrafts(conflicts, conflictDrafts, 'current-user').restored.length, 0)
  assert.deepEqual([...conflicts.values.entries()], previous, 'duplicates and conflicts must not overwrite or remove either draft')

  const changed = new MemoryStorage({ 'progress-note-draft:task': '最初の文章' })
  const selection = listLegacyProgressDrafts(changed)
  changed.setItem('progress-note-draft:task', '別ウィンドウで修正済み')
  assert.equal(restoreLegacyProgressDrafts(changed, selection, 'current-user').restored.length, 0)
  assert.equal(changed.getItem('progress-note-draft:task'), '別ウィンドウで修正済み')
  assert.equal(changed.getItem('progress-note-draft:current-user:task'), null)

  const quota = new MemoryStorage({ 'progress-note-draft:task': '保存に失敗しても残す文章' })
  const quotaSelection = listLegacyProgressDrafts(quota)
  quota.failWrite = true
  assert.throws(() => restoreLegacyProgressDrafts(quota, quotaSelection, 'current-user'), /storage full/)
  assert.equal(quota.getItem('progress-note-draft:task'), '保存に失敗しても残す文章')

  const malformedCurrent = new MemoryStorage({ 'progress-timeline-note-drafts': JSON.stringify({ task: '旧版の下書き' }), 'progress-timeline-note-drafts:current-user': '{ damaged current draft' })
  assert.equal(restoreLegacyProgressDrafts(malformedCurrent, listLegacyProgressDrafts(malformedCurrent), 'current-user').restored.length, 0)
  assert.equal(malformedCurrent.getItem('progress-timeline-note-drafts:current-user'), '{ damaged current draft', 'do not replace a malformed existing account draft store')

  assert.deepEqual(listLegacyProgressDrafts(new MemoryStorage({ 'progress-timeline-note-drafts': '{broken', 'progress-timeline-comment-drafts': '[]' })), [])
  console.log('Legacy draft recovery passed: explicit selection, account isolation, note/comment/reply recovery, conflict protection, stale selections and write failures')
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(__dirname, '../node_modules'))
  assert.ok(path.basename(directory).startsWith('.legacy-draft-test-'))
  fs.rmSync(directory, { recursive: true, force: true })
}
