const assert = require('node:assert/strict')

// タスクの繰り返し「毎年」を、デスクトップ版とサーバー版の DB で同じように確かめる。
// 次回分は完了した日ではなく前回の開始日・期限から1年ずらす（毎日・毎週・毎月と同じ）。
module.exports = function checkYearlyRecurrence(api) {
  const db = api.getDb()
  const dateOf = (value) => value ? value.slice(0, 10) : null
  /** 完了にして、作られた次回分を返す */
  const completeAndNext = (todo, data = { status: 'done' }) => {
    const before = new Set(api.getAllTodos().map((item) => item.id))
    api.updateTodo(todo.id, data)
    const created = api.getAllTodos().filter((item) => !before.has(item.id))
    assert.equal(created.length, 1, `「${todo.title}」の次回分が1件できる`)
    return created[0]
  }

  // 通常の日付: 開始日・期限とも同じ月日の翌年
  const anniversary = api.createTodo({
    title: '創立記念日の準備', status: 'active', priority: 4, start_date: '2026-10-11', due_date: '2026-10-18', recurrence: 'yearly'
  })
  assert.equal(anniversary.recurrence, 'yearly', '毎年を保存できる')
  const nextAnniversary = completeAndNext(anniversary)
  assert.equal(nextAnniversary.title, '創立記念日の準備')
  assert.equal(nextAnniversary.recurrence, 'yearly', '次回分も毎年')
  assert.equal(nextAnniversary.status, 'not_started')
  assert.equal(nextAnniversary.priority, 4, '優先度を引き継ぐ')
  assert.deepEqual([dateOf(nextAnniversary.start_date), dateOf(nextAnniversary.due_date)], ['2027-10-11', '2027-10-18'])
  assert.equal(api.getTodoById(anniversary.id).status, 'done', '元のタスクは完了のまま')

  // 2/29: 次の年（平年）は 2/28。次回分をさらに完了しても続く
  const leap = api.createTodo({ title: 'うるう日の点検', status: 'active', start_date: '2028-02-20', due_date: '2028-02-29', recurrence: 'yearly' })
  const nextLeap = completeAndNext(leap)
  assert.deepEqual([dateOf(nextLeap.start_date), dateOf(nextLeap.due_date)], ['2029-02-20', '2029-02-28'], '2/29 は平年なら 2/28')
  const nextNextLeap = completeAndNext(nextLeap)
  assert.equal(dateOf(nextNextLeap.due_date), '2030-02-28')

  // 12/31: 年をまたいで翌年の 12/31
  const yearEnd = api.createTodo({ title: '年末の棚卸し', status: 'active', start_date: '2026-12-01', due_date: '2026-12-31', recurrence: 'yearly' })
  const nextYearEnd = completeAndNext(yearEnd)
  assert.deepEqual([dateOf(nextYearEnd.start_date), dateOf(nextYearEnd.due_date)], ['2027-12-01', '2027-12-31'])

  // 日付のないタスクは、日付なしの次回分を作る（ほかの繰り返しと同じ）
  const undated = api.createTodo({ title: '日付なしの毎年', status: 'active', recurrence: 'yearly' })
  const nextUndated = completeAndNext(undated)
  assert.deepEqual([nextUndated.start_date, nextUndated.due_date, nextUndated.recurrence], [null, null, 'yearly'])

  // サブタスクも引き継ぐ設定なら、サブタスクの日付も1年ずらす
  const withSubTasks = api.createTodo({
    title: '健康診断の手配', status: 'active', start_date: '2026-09-01', due_date: '2026-10-31', recurrence: 'yearly', recurrence_copy_subtasks: 1
  })
  api.createSubTask(withSubTasks.id, { title: '病院を予約', start_date: '2026-09-01', due_date: '2026-09-15' })
  api.createSubTask(withSubTasks.id, { title: '案内を送る', due_date: '2026-10-01' })
  const nextWithSubTasks = completeAndNext(withSubTasks)
  const copied = api.getSubTasksByTodo(nextWithSubTasks.id)
  assert.deepEqual(copied.map((item) => [item.title, dateOf(item.start_date), dateOf(item.due_date), item.done]), [
    ['病院を予約', '2027-09-01', '2027-09-15', 0],
    ['案内を送る', null, '2027-10-01', 0]
  ])

  // 土日・祝日をスキップする設定も、ほかの繰り返しと同じように効く
  // 2026-10-17（土）の次の年は 2027-10-17（日）→ 月曜の 10/18
  const weekend = api.createTodo({ title: '土日をよける毎年', status: 'active', due_date: '2026-10-17', recurrence: 'yearly', recurrence_skip_weekends: 1 })
  assert.equal(dateOf(completeAndNext(weekend).due_date), '2027-10-18')
  // 2027-01-01（金・元日）→ 祝日をよけると 1/2（土）、土日もよけると 1/4（月）
  const holiday = api.createTodo({ title: '祝日をよける毎年', status: 'active', due_date: '2026-01-01', recurrence: 'yearly', recurrence_skip_holidays: 1 })
  assert.equal(dateOf(completeAndNext(holiday).due_date), '2027-01-02')
  const both = api.createTodo({ title: '両方よける毎年', status: 'active', due_date: '2026-01-01', recurrence: 'yearly', recurrence_skip_holidays: 1, recurrence_skip_weekends: 1 })
  assert.equal(dateOf(completeAndNext(both).due_date), '2027-01-04')

  // 進捗を100%にして完了したときも次回分を作る
  const byProgress = api.createTodo({ title: '進捗で完了する毎年', status: 'active', due_date: '2026-06-30', recurrence: 'yearly' })
  assert.equal(dateOf(completeAndNext(byProgress, { progress: 100 }).due_date), '2027-06-30')

  // 既存のタスクを毎年に変える（繰り返しなし → 毎年、毎月 → 毎年）
  const plain = api.createTodo({ title: '繰り返しなしだったタスク', status: 'not_started', start_date: '2026-03-01', due_date: '2026-03-31' })
  assert.equal(plain.recurrence, null)
  assert.equal(api.updateTodo(plain.id, { recurrence: 'yearly' }).recurrence, 'yearly')
  const nextPlain = completeAndNext(plain)
  assert.deepEqual([dateOf(nextPlain.start_date), dateOf(nextPlain.due_date), nextPlain.recurrence], ['2027-03-01', '2027-03-31', 'yearly'])
  const monthly = api.createTodo({ title: '毎月だったタスク', status: 'active', due_date: '2026-01-31', recurrence: 'monthly' })
  api.updateTodo(monthly.id, { recurrence: 'yearly' })
  assert.equal(dateOf(completeAndNext(monthly).due_date), '2027-01-31', '毎月から変えると翌年の同じ日')
  // 毎年 → なしに戻すと、完了しても次回分を作らない
  const stop = api.createTodo({ title: '毎年をやめるタスク', status: 'active', due_date: '2026-05-01', recurrence: 'yearly' })
  assert.equal(api.updateTodo(stop.id, { recurrence: null }).recurrence, null)
  const countBeforeStop = api.getAllTodos().length
  api.updateTodo(stop.id, { status: 'done' })
  assert.equal(api.getAllTodos().length, countBeforeStop, '繰り返しをやめたら次回分は作らない')

  // これまでの繰り返しの動きは変わらない（毎月は末日に丸める）
  const legacyMonthly = api.createTodo({ title: '月末の締め', status: 'active', due_date: '2026-01-31', recurrence: 'monthly' })
  assert.equal(dateOf(completeAndNext(legacyMonthly).due_date), '2026-02-28')
  const legacyWeekly = api.createTodo({ title: '週次の会議', status: 'active', due_date: '2026-12-28', recurrence: 'weekly' })
  assert.equal(dateOf(completeAndNext(legacyWeekly).due_date), '2027-01-04')

  // ToDoリストは繰り返し（次回分の作成）を持たない。毎年でも同じ
  const list = api.createTodo({ title: '毎年のリスト', status: 'active', list_mode: 1, recurrence: 'yearly' })
  assert.equal(list.recurrence, null)
  assert.equal(api.updateTodo(list.id, { recurrence: 'yearly' }).recurrence, null)

  // 入力チェック: 知らない値は保存しない（作成・更新とも）。更新に失敗したときは元の値のまま
  assert.throws(() => api.createTodo({ title: '不正な繰り返し', recurrence: 'biweekly' }), /繰り返しの指定が正しくありません/)
  assert.equal(api.getAllTodos().some((item) => item.title === '不正な繰り返し'), false)
  const guarded = api.createTodo({ title: '値を守るタスク', status: 'active', recurrence: 'yearly' })
  assert.throws(() => api.updateTodo(guarded.id, { recurrence: 'hourly' }), /繰り返しの指定が正しくありません/)
  assert.equal(api.getTodoById(guarded.id).recurrence, 'yearly')
  assert.equal(api.updateTodo(guarded.id, { recurrence: '' }).recurrence, null, '空は「なし」')

  // DB の制約: アプリを通さずに書いても、知らない値は入らない。既にある正しい値は読める
  assert.throws(() => db.prepare("UPDATE Todos SET recurrence = 'hourly' WHERE id = ?").run(guarded.id), /繰り返しの指定が正しくありません/)
  assert.throws(() => db.prepare(`INSERT INTO Todos (id, title, sort_order, recurrence, created_at, updated_at)
    VALUES ('bad-recurrence', 'x', 0, 'fortnightly', '2026-10-18', '2026-10-18')`).run(), /繰り返しの指定が正しくありません/)
  db.prepare("UPDATE Todos SET recurrence = 'yearly' WHERE id = ?").run(guarded.id)
  db.prepare('UPDATE Todos SET recurrence = NULL WHERE id = ?').run(guarded.id)
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'todos_recurrence_%' ORDER BY name").all().map((row) => row.name)
  assert.deepEqual(triggers, ['todos_recurrence_insert_check', 'todos_recurrence_update_check'])
  // 繰り返し以外の列を書き換えるときは確かめない（古いデータに思わぬ値があっても、ほかの編集は止めない）
  db.exec('DROP TRIGGER todos_recurrence_update_check')
  db.prepare("UPDATE Todos SET recurrence = 'quarterly' WHERE id = ?").run(guarded.id)
  api.installTodoRecurrenceConstraint(db)
  assert.equal(api.updateTodo(guarded.id, { title: '値を守るタスク（改名）' }).title, '値を守るタスク（改名）')
  const countBeforeUnknown = api.getAllTodos().length
  api.updateTodo(guarded.id, { status: 'done' })
  assert.equal(api.getAllTodos().length, countBeforeUnknown, '知らない値の繰り返しは次回分を作らない')
}
