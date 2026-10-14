const assert = require('node:assert/strict')

// ToDoリスト（期限なしで続くタスク）と、周期で未チェックに戻る項目を、デスクトップ版とサーバー版で同じように検証する。
module.exports = function checkTodoList(api) {
  const db = api.getDb()
  const doneOf = (id) => db.prepare('SELECT done FROM SubTasks WHERE id = ?').get(id).done
  const countChecks = (id) => db.prepare('SELECT COUNT(*) AS n FROM SubTaskChecks WHERE subtask_id = ?').get(id).n
  const setCompleted = (id, date) => db.prepare('UPDATE SubTasks SET done = 1, progress = 100, completed_at = ? WHERE id = ?').run(date.toISOString(), id)
  const local = (y, m, d, h = 9) => new Date(y, m - 1, d, h)

  // 作るときは期限と繰り返し（次回分の作成）を持たない
  const list = api.createTodo({
    title: '日々のToDo', status: 'active', start_date: '2026-10-01', due_date: '2026-10-20', recurrence: 'daily', list_mode: 1
  })
  assert.equal(list.list_mode, 1)
  assert.equal(list.due_date, null)
  assert.equal(list.recurrence, null)
  assert.equal(api.updateTodo(list.id, { due_date: '2026-11-01' }).due_date, null, 'ToDoリストには期限を入れない')

  // 項目の期限に合わせて親の期限を延ばさない
  const oneOff = api.createSubTask(list.id, { title: '見積もりに返信', due_date: '2026-12-01' })
  assert.equal(oneOff.parent_due_date_extended_to ?? null, null)
  assert.equal(api.getTodoById(list.id).due_date, null)

  const daily = api.createSubTask(list.id, { title: 'メール確認', recurrence: 'daily' })
  const workdays = api.createSubTask(list.id, { title: '日報', recurrence: 'daily', recurrence_workdays: 1 })
  const weekly = api.createSubTask(list.id, { title: '週次バックアップの確認', recurrence: 'weekly' })
  const monthly = api.createSubTask(list.id, { title: '月次請求', recurrence: 'monthly' })
  assert.equal(daily.recurrence, 'daily')
  assert.equal(workdays.recurrence_workdays, 1)
  assert.equal(api.createSubTask(list.id, { title: '不正な値', recurrence: 'hourly' }).recurrence, null, '知らない周期は繰り返さない項目にする')

  // チェックするといまの周期の記録が残り、同じ周期のうちに外すと消える
  assert.equal(api.updateSubTask(daily.id, { done: true }).done, 1)
  assert.equal(countChecks(daily.id), 1)
  api.updateSubTask(daily.id, { done: false })
  assert.equal(countChecks(daily.id), 0)
  const progressLogs = db.prepare("SELECT COUNT(*) AS n FROM SubTaskChangeLogs WHERE subtask_id = ? AND field = 'progress'").get(daily.id).n
  assert.equal(progressLogs, 0, '繰り返しの項目のチェックは進捗の変化として残さない')

  // 周期の切り替わり。2026-10-09 は金曜、10-10 は土曜、10-12 は月曜（スポーツの日）、10-13 は火曜
  api.updateSubTask(weekly.id, { done: true })
  for (const item of [daily, workdays, weekly, monthly]) setCompleted(item.id, local(2026, 10, 9))
  setCompleted(oneOff.id, local(2026, 10, 1))
  assert.equal(api.resetRecurringSubTasks(local(2026, 10, 9, 18)), 0, '同じ日のうちは戻さない')
  api.resetRecurringSubTasks(local(2026, 10, 10))
  assert.equal(doneOf(daily.id), 0, '毎日は翌日に未チェックに戻る')
  assert.equal(doneOf(workdays.id), 1, '平日だけの項目は土曜には戻らない')
  assert.equal(doneOf(weekly.id), 1, '毎週は週の途中では戻らない')
  api.resetRecurringSubTasks(local(2026, 10, 12))
  assert.equal(doneOf(workdays.id), 1, '祝日の月曜も前の平日の分が続く')
  assert.equal(doneOf(weekly.id), 0, '毎週は月曜に戻る')
  assert.equal(doneOf(monthly.id), 1)
  api.resetRecurringSubTasks(local(2026, 10, 13))
  assert.equal(doneOf(workdays.id), 0, '次の平日に戻る')
  api.resetRecurringSubTasks(local(2026, 11, 1))
  assert.equal(doneOf(monthly.id), 0, '毎月は1日に戻る')
  assert.equal(doneOf(oneOff.id), 1, '繰り返さない項目は戻さない')
  assert.equal(countChecks(weekly.id), 1, '未チェックに戻してもチェックの記録は残す')

  // ふつうのタスクを ToDoリストにすると、期限と繰り返しが外れ、完了しても次回分を作らない
  const task = api.createTodo({ title: '延長し続けていたタスク', status: 'active', start_date: '2026-09-01', due_date: '2026-10-31', recurrence: 'weekly' })
  api.createSubTask(task.id, { title: '既存の項目', due_date: '2026-11-15' })
  assert.equal(api.getTodoById(task.id).due_date, '2026-11-15', 'ふつうのタスクは項目の期限に合わせて延びる')
  const converted = api.updateTodo(task.id, { list_mode: 1, expected_values: { list_mode: 0 } })
  assert.equal(converted.list_mode, 1)
  assert.equal(converted.due_date, null)
  assert.equal(converted.recurrence, null)
  const countBefore = api.getAllTodos().length
  api.updateTodo(task.id, { status: 'done' })
  assert.equal(api.getAllTodos().length, countBefore, 'ToDoリストを終えても次回分は作らない')

  // ふつうのタスクに戻すと期限を入れられる
  const back = api.updateTodo(task.id, { list_mode: 0, due_date: '2026-12-01' })
  assert.equal(back.list_mode, 0)
  assert.equal(back.due_date, '2026-12-01')
}
