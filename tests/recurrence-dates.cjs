const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// タスクの繰り返し（毎日・毎週・毎月・毎年）の次回の日付と表記を確かめる。
// DB 側（server/src/shared/todo-recurrence.ts）と画面側（src/renderer/src/lib/recurrence.ts）の計算が一致することも確かめる。
function load(file) {
  const bundle = buildSync({
    entryPoints: [path.join(__dirname, '..', file)],
    bundle: true, write: false, format: 'cjs', platform: 'node'
  }).outputFiles[0].text
  const sandbox = { module: { exports: {} }, Date }
  vm.runInNewContext(bundle, sandbox)
  return sandbox.module.exports
}
const shared = load('server/src/shared/todo-recurrence.ts')
const view = load('src/renderer/src/lib/recurrence.ts')

// 毎年: 同じ月日。2/29 は平年なら 2/28。12/31 は翌年の 12/31
assert.equal(shared.nextRecurrenceDateKey('2026-10-18', 'yearly'), '2027-10-18', '通常の日付')
assert.equal(shared.nextRecurrenceDateKey('2028-02-29', 'yearly'), '2029-02-28', '2/29 の次の年（平年）は 2/28')
assert.equal(shared.nextRecurrenceDateKey('2024-02-29', 'yearly'), '2025-02-28')
assert.equal(shared.nextRecurrenceDateKey('2027-02-28', 'yearly'), '2028-02-28', '2/28 はうるう年でも 2/28')
assert.equal(shared.nextRecurrenceDateKey('2026-12-31', 'yearly'), '2027-12-31', '12/31')
assert.equal(shared.nextRecurrenceDateKey('2026-01-01', 'yearly'), '2027-01-01')
assert.equal(shared.nextRecurrenceDateKey('2026-10-18T09:30:00.000Z', 'yearly'), '2027-10-18', '時刻つきでも日付で数える')

// これまでの繰り返しは変わらない（毎月は末日に丸める）
assert.equal(shared.nextRecurrenceDateKey('2026-12-31', 'daily'), '2027-01-01')
assert.equal(shared.nextRecurrenceDateKey('2026-12-28', 'weekly'), '2027-01-04')
assert.equal(shared.nextRecurrenceDateKey('2026-01-31', 'monthly'), '2026-02-28')
assert.equal(shared.nextRecurrenceDateKey('2024-01-31', 'monthly'), '2024-02-29')
assert.equal(shared.nextRecurrenceDateKey('2026-12-31', 'monthly'), '2027-01-31')
assert.equal(shared.nextRecurrenceDateKey('2026-11-30', 'monthly'), '2026-12-30')

// 画面側の計算は DB 側と同じ（2023〜2029年の全部の日で確かめる）
for (let time = Date.UTC(2023, 0, 1); time <= Date.UTC(2029, 11, 31); time += 86400000) {
  const key = new Date(time).toISOString().slice(0, 10)
  for (const recurrence of shared.TODO_RECURRENCES) {
    assert.equal(view.nextRecurrenceDateKey(key, recurrence), shared.nextRecurrenceDateKey(key, recurrence), `${key} ${recurrence}`)
  }
}
assert.deepEqual(Array.from(view.TODO_RECURRENCE_OPTIONS, (option) => option.value), Array.from(shared.TODO_RECURRENCES), '画面の選択肢と保存できる値が同じ')

// 入力チェック
assert.equal(shared.normalizeTodoRecurrence('yearly'), 'yearly')
assert.equal(shared.normalizeTodoRecurrence(''), null, '空は「なし」')
assert.equal(shared.normalizeTodoRecurrence(null), null)
assert.equal(shared.normalizeTodoRecurrence(undefined), null)
assert.throws(() => shared.normalizeTodoRecurrence('biweekly'), /繰り返しの指定が正しくありません/)
assert.throws(() => shared.normalizeTodoRecurrence('YEARLY'), /繰り返しの指定が正しくありません/)
assert.throws(() => shared.normalizeTodoRecurrence(1), /繰り返しの指定が正しくありません/)
assert.equal(shared.isTodoRecurrence('yearly'), true)
assert.equal(shared.isTodoRecurrence('hourly'), false)

// 表記: 毎年は月日を付ける（期限、なければ開始日）
const todo = (recurrence, due_date = null, start_date = null, extra = {}) => ({
  recurrence, due_date, start_date, recurrence_skip_weekends: 0, recurrence_skip_holidays: 0, ...extra
})
assert.equal(view.todoRecurrenceLabel(todo('yearly', '2026-10-18')), '毎年 10/18')
assert.equal(view.todoRecurrenceLabel(todo('yearly', null, '2028-02-29')), '毎年 2/29', '期限がなければ開始日')
assert.equal(view.todoRecurrenceLabel(todo('yearly', '2026-12-31', '2026-12-01')), '毎年 12/31', '期限を優先')
assert.equal(view.todoRecurrenceLabel(todo('yearly')), '毎年', '日付がなければ月日なし')
assert.equal(view.todoRecurrenceLabel(todo('monthly', '2026-10-18')), '毎月')
assert.equal(view.todoRecurrenceLabel(todo('weekly')), '毎週')
assert.equal(view.todoRecurrenceLabel(todo('daily')), '毎日')
assert.equal(view.todoRecurrenceLabel(todo(null, '2026-10-18')), null)
assert.equal(view.todoRecurrenceLabel(todo('hourly')), null, '知らない値は表記しない')
assert.equal(view.recurrenceKindLabel('yearly'), '毎年')

// 完了したときの知らせ
const today = new Date(2026, 9, 18)
assert.equal(view.recurrenceDoneMessage(todo('yearly', '2026-10-18'), today), '毎年 10/18の次回分（期限 2027/10/18）を作りました')
assert.equal(view.recurrenceDoneMessage(todo('weekly', '2026-10-20'), today), '毎週の次回分（期限 10/27）を作りました')
assert.equal(view.recurrenceDoneMessage(todo('yearly', null, '2028-02-29'), today), '毎年 2/29の次回分（開始日 2029/2/28）を作りました')
assert.equal(view.recurrenceDoneMessage(todo('yearly'), today), '毎年の次回分を作りました')
assert.equal(view.recurrenceDoneMessage(todo('yearly', '2026-01-01', null, { recurrence_skip_holidays: 1 }), today), '毎年 1/1の次回分を作りました', '祝日でずれるかは画面で分からないので日付を書かない')
assert.equal(view.recurrenceDoneMessage(todo(null, '2026-10-18'), today), null)
// 土日をスキップ: 2026-10-17（土）の次の年は 2027-10-17（日）→ 月曜の 10/18
assert.equal(view.nextRecurrenceDue(todo('yearly', '2026-10-17', null, { recurrence_skip_weekends: 1 })).dateKey, '2027-10-18')

// 一覧などの短い日付: 今年でない日付には年を付ける（毎年の次回分を今年と見間違えない）
const dueDate = load('src/renderer/src/lib/dueDate.ts')
assert.equal(dueDate.formatShortDate('2026-10-20', today), '10/20')
assert.equal(dueDate.formatShortDate('2027-10-20', today), '2027/10/20')
assert.equal(dueDate.formatShortDate('2025-12-31T00:00:00.000Z', today), '2025/12/31')

console.log('recurrence date checks passed')
