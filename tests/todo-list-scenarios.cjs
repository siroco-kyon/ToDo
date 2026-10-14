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

  // 終えた ToDoリストの項目は未チェックに戻さない
  const ended = api.createTodo({ title: '終えたリスト', status: 'active', list_mode: 1 })
  const endedItem = api.createSubTask(ended.id, { title: '毎日の項目', recurrence: 'daily' })
  api.updateTodo(ended.id, { status: 'done' })
  setCompleted(endedItem.id, local(2026, 10, 9))
  api.resetRecurringSubTasks(local(2026, 10, 13))
  assert.equal(doneOf(endedItem.id), 1, '終えたリストの項目はそのまま')

  // ふつうのタスクに戻すと、項目の繰り返しを外す（見えないまま未チェックに戻り続けないように）
  api.updateTodo(ended.id, { status: 'active', list_mode: 0 })
  assert.equal(db.prepare('SELECT recurrence FROM SubTasks WHERE id = ?').get(endedItem.id).recurrence, null)
  api.resetRecurringSubTasks(local(2026, 10, 20))
  assert.equal(doneOf(endedItem.id), 1)
  // ふつうのタスクの項目には繰り返しを付けない
  assert.equal(api.createSubTask(ended.id, { title: '繰り返しを付けようとした項目', recurrence: 'daily' }).recurrence, null)
  assert.equal(api.updateSubTask(endedItem.id, { recurrence: 'weekly' }).recurrence, null)
  // 期間中の実施状況（報告タブ）。期間に重なる周期の数と、そのうちチェックした数
  const key = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const today = key(new Date())
  const yesterday = key(new Date(Date.now() - 86400000))
  const routine = api.createTodo({ title: '実施状況の確認', status: 'active', list_mode: 1 })
  const everyDay = api.createSubTask(routine.id, { title: '毎日の確認', recurrence: 'daily' })
  api.updateSubTask(everyDay.id, { done: true })
  const summaryOf = (id, from, to) => {
    const row = api.getSubTaskCheckSummaries(from, to).find((item) => item.subtask_id === id)
    return row && { periods: row.periods, checked: row.checked, checked_in_range: row.checked_in_range }
  }
  assert.deepEqual(summaryOf(everyDay.id, today, today), { periods: 1, checked: 1, checked_in_range: 1 })
  assert.deepEqual(summaryOf(everyDay.id, yesterday, yesterday), { periods: 0, checked: 0, checked_in_range: 0 }, '項目を作る前の周期は数えない')

  // 期間の開始より前に始まった週も、期間に重なっていれば数える（2026-09-28 と 10-05 の週）
  const everyWeek = api.createSubTask(routine.id, { title: '毎週の確認', recurrence: 'weekly' })
  db.prepare("UPDATE SubTasks SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(everyWeek.id)
  const insertCheck = db.prepare('INSERT INTO SubTaskChecks (id, subtask_id, todo_id, period_key, user_id, checked_at) VALUES (?, ?, ?, ?, NULL, ?)')
  insertCheck.run('check-1', everyWeek.id, routine.id, '2026-09-28', local(2026, 9, 29).toISOString())
  assert.deepEqual(summaryOf(everyWeek.id, '2026-10-01', '2026-10-11'), { periods: 2, checked: 1, checked_in_range: 0 })
  insertCheck.run('check-2', everyWeek.id, routine.id, '2026-10-05', local(2026, 10, 7).toISOString())
  assert.deepEqual(summaryOf(everyWeek.id, '2026-10-01', '2026-10-11'), { periods: 2, checked: 2, checked_in_range: 1 })

  // ふつうのタスクの項目は対象外
  assert.equal(api.getSubTaskCheckSummaries('2026-10-01', today).some((item) => item.todo_id === task.id), false)

  // 戻る曜日・日付の指定。毎週水曜（3）、毎月31日（ない月は末日）
  const dayList = api.createTodo({ title: '曜日と日付の指定', status: 'active', list_mode: 1 })
  const wednesday = api.createSubTask(dayList.id, { title: '毎週水曜の項目', recurrence: 'weekly', recurrence_day: 3 })
  const monthEnd = api.createSubTask(dayList.id, { title: '月末の項目', recurrence: 'monthly', recurrence_day: 31 })
  assert.equal(wednesday.recurrence_day, 3)
  assert.equal(api.createSubTask(dayList.id, { title: '範囲外の曜日', recurrence: 'weekly', recurrence_day: 9 }).recurrence_day, null, '範囲外は既定にする')
  assert.equal(api.createSubTask(dayList.id, { title: '毎日に曜日', recurrence: 'daily', recurrence_day: 3 }).recurrence_day, null, '毎日には曜日を付けない')
  // 2026-10-13 は火曜、10-14 は水曜
  setCompleted(wednesday.id, local(2026, 10, 13))
  api.resetRecurringSubTasks(local(2026, 10, 13, 20))
  assert.equal(doneOf(wednesday.id), 1, '火曜のうちは戻さない')
  api.resetRecurringSubTasks(local(2026, 10, 14))
  assert.equal(doneOf(wednesday.id), 0, '水曜に戻る')
  setCompleted(wednesday.id, local(2026, 10, 14))
  api.resetRecurringSubTasks(local(2026, 10, 20))
  assert.equal(doneOf(wednesday.id), 1, '次の火曜までは戻さない')
  api.resetRecurringSubTasks(local(2026, 10, 21))
  assert.equal(doneOf(wednesday.id), 0, '次の水曜に戻る')
  // 31日の指定は、30日までの月は末日に戻る
  setCompleted(monthEnd.id, local(2026, 10, 31))
  api.resetRecurringSubTasks(local(2026, 11, 29))
  assert.equal(doneOf(monthEnd.id), 1)
  api.resetRecurringSubTasks(local(2026, 11, 30))
  assert.equal(doneOf(monthEnd.id), 0, '11月は30日に戻る')
  // 実施状況も水曜始まりの週で数える（10/1〜10/13 に重なるのは 9/30 と 10/7 の週）
  const wednesdayReport = api.createSubTask(dayList.id, { title: '水曜始まりの集計', recurrence: 'weekly', recurrence_day: 3 })
  db.prepare("UPDATE SubTasks SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(wednesdayReport.id)
  insertCheck.run('check-wed', wednesdayReport.id, dayList.id, '2026-10-07', local(2026, 10, 8).toISOString())
  assert.deepEqual(summaryOf(wednesdayReport.id, '2026-10-01', '2026-10-13'), { periods: 2, checked: 1, checked_in_range: 1 })
  // 周期だけ変えたら、戻る曜日・日付は既定に戻す
  assert.equal(api.updateSubTask(wednesday.id, { recurrence: 'monthly' }).recurrence_day, null)
  assert.equal(api.updateSubTask(wednesday.id, { recurrence_day: 25 }).recurrence_day, 25)
  assert.equal(api.updateSubTask(wednesday.id, { title: '名前だけ変える' }).recurrence_day, 25, 'ほかの変更では変えない')
}
