const assert = require('node:assert/strict')

module.exports = function checkTimeline(api, userId = null) {
  const db = api.getDb()
  const iso = (day, hour = 12) => new Date(2026, 9, day, hour).toISOString()
  const old = iso(1), recent = iso(5), reply = iso(6)
  db.prepare('INSERT INTO Todos (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('task', '確認用タスク', old, old)
  const insertNote = db.prepare('INSERT INTO ProgressNotes (id, todo_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  insertNote.run('old', 'task', userId, '先週の投稿', old, old)
  insertNote.run('new', 'task', userId, '新しい投稿', recent, recent)
  const timeline = (from = '2026-10-01', to = '2026-10-06') => api.getProgressTimeline(from, to)
  const ids = (notes) => notes.map((note) => note.id)
  assert.deepEqual(ids(timeline()), ['new', 'old'])
  assert.equal(timeline()[0].last_reply_at, null)

  const direct = api.createComment('old', '返信')
  const commentId = direct.comments[0].id
  db.prepare('UPDATE ProgressNoteComments SET created_at = ?, updated_at = ? WHERE id = ?').run(reply, reply, commentId)
  assert.deepEqual(ids(timeline()), ['old', 'new'])
  assert.deepEqual(ids(timeline('2026-10-06', '2026-10-06')), ['old'])
  assert.equal(timeline()[0].last_activity_at, reply)
  assert.equal(timeline()[0].last_reply_at, reply)
  // 報告・ガント用の既存APIは投稿日時で取得する。
  assert.deepEqual(ids(api.getProgressNotesByRange('2026-10-06', '2026-10-06')), [])
  assert.deepEqual(ids(api.getProgressNotesByRange('2026-10-01', '2026-10-01')), ['old'])

  const nested = api.createComment('old', '返信への返信', commentId)
  const nestedId = nested.comments[0].replies[0].id
  const nestedDate = iso(7, 0)
  db.prepare('UPDATE ProgressNoteComments SET created_at = ?, updated_at = ? WHERE id = ?').run(nestedDate, nestedDate, nestedId)
  assert.deepEqual(ids(timeline('2026-10-07', '2026-10-07')), ['old'])
  assert.deepEqual(ids(timeline('2026-10-06', '2026-10-06')), [])
  assert.equal(timeline('2026-10-07', '2026-10-07')[0].comment_count, 2)

  api.editNote('old', '編集済み')
  api.editComment(nestedId, '返信編集')
  api.react('old')
  api.setProgressNoteNeedsDiscussion('old', true)
  assert.equal(timeline('2026-10-07', '2026-10-07')[0].last_activity_at, nestedDate)

  const deleted = api.deleteProgressNoteComment(nestedId)
  assert.equal(deleted.last_activity_at, reply)
  assert.deepEqual(ids(timeline('2026-10-07', '2026-10-07')), [])
  assert.deepEqual(ids(timeline('2026-10-06', '2026-10-06')), ['old'])
  api.createComment('old', '削除対象の子返信', commentId)
  const noReplies = api.deleteProgressNoteComment(commentId)
  assert.equal(noReplies.last_activity_at, old)
  assert.equal(noReplies.last_reply_at, null)
  assert.equal(noReplies.comment_count, 0)
  assert.deepEqual(ids(timeline()), ['new', 'old'])

  insertNote.run('tie-a', 'task', userId, '同時刻A', recent, recent)
  insertNote.run('tie-b', 'task', userId, '同時刻B', recent, recent)
  assert.deepEqual(ids(timeline()), ['new', 'tie-a', 'tie-b', 'old'])
  assert.throws(() => timeline('invalid', '2026-10-06'))
  assert.throws(() => timeline('2026-10-07', '2026-10-06'))
}
