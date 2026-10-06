const assert = require('node:assert/strict')

// デスクトップ版とサーバー版で同じ状態遷移を検証する。
module.exports = function checkOnHold(api) {
  const target = api.createTodo({
    title: '保留するタスク', status: 'active', progress: 30,
    memo: '返答待ち', start_date: '2026-10-01', due_date: '2026-10-05',
    recurrence: 'weekly'
  })
  const child = api.createSubTask(target.id, { title: '残りの作業', progress: 20 })
  const successor = api.createTodo({ title: '後続', start_date: '2026-10-06', due_date: '2026-10-08' })
  const dependency = api.createTodoDependency(target.id, successor.id, 0)
  const plan = api.addPlan(target.id, '2026-10-05')

  api.startTimer(target.id)
  api.getDb().prepare("UPDATE RunningState SET start_time = '2026-01-01T00:00:00.000Z' WHERE todo_id = ?").run(target.id)
  const beforeCount = api.getAllTodos().length
  const held = api.updateTodo(target.id, { status: 'on_hold' })
  assert.equal(held.status, 'on_hold')
  assert.ok(Number.isFinite(Date.parse(held.on_hold_since)))
  // 別日にメモを更新した状況を作り、保留開始が更新日時に追従しないことを確かめる。
  const earlierSince = '2026-01-01T00:00:00.000Z'
  api.getDb().prepare('UPDATE Todos SET on_hold_since = ? WHERE id = ?').run(earlierSince, target.id)
  assert.equal(api.updateTodo(target.id, { memo: '返答待ち' }).on_hold_since, earlierSince)
  assert.equal(held.progress, 30)
  assert.equal(held.memo, '返答待ち')
  assert.equal(held.start_date, target.start_date)
  assert.equal(held.due_date, target.due_date)
  assert.equal(held.completed_at, null)
  assert.equal(api.getTodoById(successor.id).start_date, successor.start_date)
  assert.equal(api.getRunningState(), undefined)
  const logs = api.getWorkLogsByTodo(target.id)
  assert.equal(logs.length, 1)
  assert.ok(logs[0].duration_seconds > 0)
  assert.equal(logs[0].note, 'タスクを保留しました')
  assert.equal(api.getSubTasksByTodo(target.id)[0].id, child.id)
  assert.equal(api.getSubTasksByTodo(target.id)[0].progress, 20)
  assert.equal(api.getAllTodoDependencies()[0].id, dependency.id)
  const heldPlan = api.getPlan('2026-10-05').find((item) => item.id === plan.id)
  assert.equal(heldPlan.status, 'on_hold')

  api.updateTodo(target.id, { status: 'on_hold' })
  assert.equal(api.getTodoById(target.id).on_hold_since, earlierSince, '保留の再保存で開始日時をリセットしない')
  assert.equal(api.getWorkLogsByTodo(target.id).length, 1, '保留の再保存でログを重複させない')
  assert.equal(api.updateTodo(target.id, { progress: 100 }).status, 'on_hold')
  assert.equal(api.getAllTodos().length, beforeCount, '保留中は繰り返しの次回分を作らない')

  const other = api.createTodo({ title: '別のタスク', status: 'active' })
  api.startTimer(other.id)
  assert.throws(() => api.startTimer(target.id), /保留中/)
  assert.equal(api.getRunningState().todo_id, other.id, '開始拒否で別タスクの計測を止めない')
  api.stopTimer()

  api.archiveTodo(target.id)
  assert.equal(api.getTodoById(target.id).on_hold_since, earlierSince)
  api.unarchiveTodo(target.id, 'on_hold')
  assert.equal(api.getTodoById(target.id).status, 'on_hold')
  assert.equal(api.getTodoById(target.id).on_hold_since, earlierSince, 'アーカイブ取り消しでも開始日時を保持する')
  const createdHeld = api.createTodo({ title: '最初から保留', status: 'on_hold' })
  assert.equal(createdHeld.status, 'on_hold')
  assert.equal(createdHeld.on_hold_since, createdHeld.created_at)
  api.reopen()
  assert.equal(api.getTodoById(target.id).status, 'on_hold', '再起動後も保留状態を保持する')
  assert.equal(api.getTodoById(target.id).on_hold_since, earlierSince)
  assert.equal(api.getPlan('2026-10-05').find((item) => item.id === plan.id).status, 'on_hold')
  assert.equal(api.updateTodo(createdHeld.id, { status: 'done' }).status, 'done', '保留中でも明示的な完了操作は受け付ける')

  api.updateTodo(target.id, { status: 'active', progress: 30 })
  assert.equal(api.getTodoById(target.id).on_hold_since, null, '再開で現在の保留開始をクリアする')
  api.updateTodo(target.id, { status: 'on_hold' })
  assert.notEqual(api.getTodoById(target.id).on_hold_since, earlierSince, '再度の保留は新しい開始日時にする')
  api.updateTodo(target.id, { status: 'active' })
  api.startTimer(target.id)
  assert.equal(api.getRunningState().todo_id, target.id)
  api.stopTimer()
  api.updateTodo(target.id, { progress: 100 })
  assert.equal(api.getTodoById(target.id).status, 'done')
  assert.equal(api.getAllTodos().length, beforeCount + 3, '再開後の完了時は次回分を1件作る')

  // on_hold_since追加前のDBに戻して移行を検証する。
  api.updateTodo(target.id, { status: 'on_hold' })
  const expectedSince = api.getTodoById(target.id).on_hold_since
  const unknown = api.createTodo({ title: '履歴がない既存の保留', status: 'on_hold' })
  const archived = api.createTodo({ title: 'アーカイブ済みの保留', status: 'active' })
  const archivedSince = api.updateTodo(archived.id, { status: 'on_hold' }).on_hold_since
  api.archiveTodo(archived.id)
  api.getDb().exec('ALTER TABLE Todos DROP COLUMN on_hold_since')
  api.reopen()
  assert.equal(api.getTodoById(target.id).on_hold_since, expectedSince, '履歴から保留開始を復元する')
  assert.equal(api.getTodoById(unknown.id).on_hold_since, null, '履歴がない開始日時は推測しない')
  api.unarchiveTodo(archived.id, 'on_hold')
  assert.equal(api.getTodoById(archived.id).on_hold_since, archivedSince, '移行前にアーカイブした保留も開始日時を復元する')
  api.updateTodo(target.id, { memo: '移行後の更新' })
  api.reopen()
  assert.equal(api.getTodoById(target.id).on_hold_since, expectedSince, '移行後の再起動でも開始日時を維持する')
}
