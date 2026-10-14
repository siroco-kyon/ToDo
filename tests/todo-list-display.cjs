const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// ToDoリストの画面側の判定（表記・期限の選択肢・今日やることの選び方）を確かめる
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/todoList.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
}).outputFiles[0].text
const sandbox = { module: { exports: {} }, Date }
vm.runInNewContext(bundle, sandbox)
const lib = sandbox.module.exports

// 表記
assert.equal(lib.repeatLabel({ recurrence: 'daily', recurrence_workdays: 0, recurrence_day: null }), '毎日')
assert.equal(lib.repeatLabel({ recurrence: 'daily', recurrence_workdays: 1, recurrence_day: null }), '平日')
assert.equal(lib.repeatLabel({ recurrence: 'weekly', recurrence_workdays: 0, recurrence_day: null }), '毎週月', '未設定は月曜')
assert.equal(lib.repeatLabel({ recurrence: 'weekly', recurrence_workdays: 0, recurrence_day: 0 }), '毎週日')
assert.equal(lib.repeatLabel({ recurrence: 'monthly', recurrence_workdays: 0, recurrence_day: 25 }), '毎月25日')
assert.equal(lib.repeatLabel({ recurrence: 'monthly', recurrence_workdays: 0, recurrence_day: 31 }), '毎月末')
assert.equal(lib.repeatLabel({ recurrence: null, recurrence_workdays: 0, recurrence_day: null }), null)
assert.deepEqual({ ...lib.repeatFields('weekly', 3) }, { recurrence: 'weekly', recurrence_workdays: 0, recurrence_day: 3 })
assert.deepEqual({ ...lib.repeatFields('daily', 3) }, { recurrence: 'daily', recurrence_workdays: 0, recurrence_day: null }, '毎日には曜日を付けない')

// 期限の選択肢（2026-10-14 は水曜、10-16 は金曜）
const labels = (date) => Array.from(lib.duePresets(date), (preset) => `${preset.label}:${preset.value}`)
assert.deepEqual(labels(new Date(2026, 9, 14, 9)), ['今日:2026-10-14', '明日:2026-10-15', '今週中:2026-10-16'])
assert.deepEqual(labels(new Date(2026, 9, 16, 9)).at(-1), '来週中:2026-10-23', '金曜は来週の金曜')
assert.deepEqual(labels(new Date(2026, 9, 18, 9)).at(-1), '来週中:2026-10-23', '日曜は次の金曜')

// 今日やること: 繰り返しの項目 → 期限が今日までのやること。自分の項目だけ
const item = (id, fields) => ({
  id, todo_id: 'list', title: id, description: '', assignee_id: null, assignee_name: null, assignee_color: null,
  start_date: null, due_date: null, progress: 0, done: 0, completed_at: null, sort_order: 0, created_at: '2026-10-01T00:00:00.000Z',
  recurrence: null, recurrence_workdays: 0, recurrence_day: null, ...fields
})
const items = [
  item('mail', { recurrence: 'daily', sort_order: 0 }),
  item('later', { due_date: '2026-10-20', sort_order: 1 }),
  item('overdue', { due_date: '2026-10-10', sort_order: 2 }),
  item('today', { due_date: '2026-10-14', sort_order: 3 }),
  item('other', { recurrence: 'weekly', assignee_id: 'u2', sort_order: 4 }),
  item('nodue', { sort_order: 5 }),
  item('earlyDone', { due_date: '2026-10-20', done: 1, completed_at: new Date(2026, 9, 14, 10).toISOString(), sort_order: 6 }),
  item('dueDone', { due_date: '2026-10-14', done: 1, completed_at: new Date(2026, 9, 14, 11).toISOString(), sort_order: 7 })
]
assert.deepEqual(Array.from(lib.todayItemsOf(items, '2026-10-14'), (entry) => entry.id), ['mail', 'other', 'overdue', 'today', 'dueDone'], '期限前に済ませたものは入れない')
const list = { id: 'list', list_mode: 1, status: 'active', assignee_id: 'u1', co_assignees: [] }
const groups = lib.buildTodayGroups([list], new Map([['list', items]]), 'u1', '2026-10-14')
assert.deepEqual(Array.from(groups[0].items, (entry) => entry.id), ['mail', 'overdue', 'today', 'dueDone'], 'ほかの人が担当の項目は自分の今日やることに入れない')
assert.equal(lib.countRemaining(groups), 3)
assert.equal(lib.buildTodayGroups([{ ...list, status: 'on_hold' }], new Map([['list', items]]), 'u1', '2026-10-14').length, 0, '保留中のリストは入れない')
assert.equal(lib.isMyList({ assignee_id: 'u9', co_assignees: [] }, [{ assignee_id: 'u1' }], 'u1'), true, '項目の担当でも自分のリスト')
assert.equal(lib.isMyList({ assignee_id: 'u9', co_assignees: [] }, [], 'u1'), false)
assert.equal(lib.isMyList({ assignee_id: 'u9', co_assignees: [] }, [], null), true, 'デスクトップ版はすべて自分のもの')

// 今日の分が残っているか
const summary = lib.summarizeChecklist(items, '2026-10-14')
assert.equal(summary.dueByTodayCount, 2)
assert.equal(lib.hasRemainingToday(summary), true)
assert.equal(lib.hasRemainingToday(lib.summarizeChecklist([item('done', { recurrence: 'daily', done: 1 })], '2026-10-14')), false)

console.log('ToDo list display checks passed')
