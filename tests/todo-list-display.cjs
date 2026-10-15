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

// 今日やることの区分け（今日やる／今週の分／今月の分）
const sectionList = { ...list, id: 'list2' }
const sectionItems = [
  item('daily', { todo_id: 'list2', recurrence: 'daily' }),
  item('weekly', { todo_id: 'list2', recurrence: 'weekly', recurrence_day: 3 }),
  item('monthly', { todo_id: 'list2', recurrence: 'monthly' }),
  item('dueToday', { todo_id: 'list2', due_date: '2026-10-14' })
]
const sections = lib.buildTodaySections(lib.buildTodayGroups([sectionList], new Map([['list2', sectionItems]]), 'u1', '2026-10-14'))
assert.deepEqual(Array.from(sections, (entry) => `${entry.section}:${Array.from(entry.entries, (e) => e.item.id).join(',')}`), ['today:daily,dueToday', 'week:weekly', 'month:monthly'])

// 区分けの中は、リストごとにまとめる（小見出しにカテゴリとリスト名を出すため）
{
  const listA = { ...list, id: 'listA', title: '毎日のルーティン' }
  const listB = { ...list, id: 'listB', title: '定常業務' }
  const byList = new Map([
    ['listA', [item('a1', { todo_id: 'listA', recurrence: 'daily' }), item('a2', { todo_id: 'listA', recurrence: 'daily', sort_order: 1 })]],
    ['listB', [item('b1', { todo_id: 'listB', recurrence: 'daily' }), item('b2', { todo_id: 'listB', recurrence: 'weekly', sort_order: 1 })]]
  ])
  const today = lib.buildTodaySections(lib.buildTodayGroups([listA, listB], byList, 'u1', '2026-10-14'))
  const headings = (section) => Array.from(lib.groupEntriesByList(section.entries), (group) => `${group.todo.title}:${Array.from(group.items, (entry) => entry.id).join(',')}`)
  assert.deepEqual(headings(today[0]), ['毎日のルーティン:a1,a2', '定常業務:b1'])
  assert.deepEqual(headings(today[1]), ['定常業務:b2'], 'リストが1つでも小見出しを付ける')
}

// ─── 報告タブの実施状況（lib/todoListReport.ts） ───
const reportBundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/todoListReport.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
}).outputFiles[0].text
const reportSandbox = { module: { exports: {} }, Date }
vm.runInNewContext(reportBundle, reportSandbox)
const report = reportSandbox.module.exports
// サンドボックスの配列・オブジェクトは別のプロトタイプなので、比べる前にふつうの値にする
const plain = (value) => JSON.parse(JSON.stringify(value))
// current_key（今日を含む回）は、省略すると最後の回（期間に今日が入るとき）にする
const checks = (entries) => new Map(entries.map(([id, periodKeys, checkedKeys, currentKey = periodKeys.at(-1) ?? null]) => [id, {
  subtask_id: id, todo_id: 'list', periods: periodKeys.length, checked: checkedKeys.length, checked_in_range: checkedKeys.length,
  period_keys: periodKeys, checked_keys: checkedKeys, current_key: currentKey
}]))
const days = (from, to) => {
  const keys = []
  for (let date = new Date(`${from}T00:00:00`); ; date.setDate(date.getDate() + 1)) {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    keys.push(key)
    if (key === to) return keys
  }
}
// 2026-10-15 は木曜。期間は直近7日（10/9〜10/15）
const week = { from: '2026-10-09', to: '2026-10-15' }
const todayKey = '2026-10-15'
const dailyItems = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, { recurrence: 'daily' }))

// 作ったばかりのリストで1件だけチェックしても、100% にしない（今日の分は途中なので別に出す）
{
  const digest = report.digestListReport(dailyItems, checks(dailyItems.map(({ id }) => [id, [todayKey], id === 'a' ? [todayKey] : []])), week, todayKey)
  assert.equal(digest.groups.length, 1)
  const [group] = digest.groups
  assert.deepEqual(plain({ label: group.label, checked: group.checked, periods: group.periods, current: group.current }),
    { label: '毎日', checked: 0, periods: 0, current: { label: '今日', checked: 1, total: 5 } })
  assert.equal(report.groupSummaryText(group), '今日 1/5（明日から集計）')
  assert.equal(digest.missed.length, 0, '今日の分はまだ取りこぼしにしない')
}

// 昨日までの分と今日の分を分ける。昨日まで全部済んでいても、今日は 1/5 と出す
{
  const past = days('2026-10-11', '2026-10-14')
  const summaries = checks(dailyItems.map(({ id }) => [id, [...past, todayKey], [...(id === 'e' ? past.slice(2) : past), ...(id === 'a' ? [todayKey] : [])]]))
  const digest = report.digestListReport(dailyItems, summaries, week, todayKey)
  assert.equal(report.groupSummaryText(digest.groups[0]), '昨日まで 18/20回（90%）・今日 1/5')
  assert.deepEqual(Array.from(digest.missed, (entry) => `${entry.item.id} ${entry.checked}/${entry.periods}`), ['e 2/4'])
  assert.deepEqual(plain(digest.days.at(-1)), { day: todayKey, done: 1, total: 5, today: true })
}

// 終わった回が5回より少ないうちは率（%）を出さない
assert.equal(report.rateText(2, 3), '2/3回')
assert.equal(report.rateText(4, 5), '4/5回（80%）')
{
  const digest = report.digestListReport([item('a', { recurrence: 'daily' })], checks([['a', days('2026-10-13', todayKey), ['2026-10-13', todayKey]]]), week, todayKey)
  assert.equal(report.groupSummaryText(digest.groups[0]), '昨日まで 1/2回・今日 1/1')
}

// 毎日・毎週・毎月は1つの率に混ぜない
{
  const mixed = [item('a', { recurrence: 'daily' }), item('w', { recurrence: 'weekly', recurrence_day: 3 }), item('m', { recurrence: 'monthly' })]
  const digest = report.digestListReport(mixed, checks([
    ['a', days('2026-10-09', todayKey), days('2026-10-09', todayKey)],
    ['w', ['2026-10-07', '2026-10-14'], ['2026-10-07']],
    ['m', ['2026-10-01'], ['2026-10-01']]
  ]), week, todayKey)
  assert.deepEqual(Array.from(digest.groups, (group) => `${group.label}: ${report.groupSummaryText(group)}`), [
    '毎日: 昨日まで 6/6回（100%）・今日 1/1',
    '毎週: 先週まで 1/1回・今週の分 0/1',
    '毎月: 今月の分 1/1（来月から集計）'
  ])
}

// 過去の期間（先週）は今の回がないので、全部を「期間中」で数える
{
  const lastWeek = { from: '2026-10-05', to: '2026-10-11' }
  const digest = report.digestListReport([item('a', { recurrence: 'daily' })], checks([['a', days('2026-10-05', '2026-10-11'), days('2026-10-05', '2026-10-10'), null]]), lastWeek, todayKey)
  assert.equal(report.groupSummaryText(digest.groups[0]), '期間中 6/7回（86%）')
  assert.equal(digest.days.some((day) => day.today), false)
  // 先週を選んでも、今月の分はまだ続いているので取りこぼしにしない
  const monthly = report.digestListReport([item('m', { recurrence: 'monthly' })], checks([['m', ['2026-10-01'], [], '2026-10-01']]), lastWeek, todayKey)
  assert.equal(report.groupSummaryText(monthly.groups[0]), '今月の分 0/1（来月から集計）')
  assert.equal(monthly.missed.length, 0)
  // 先週の終わりの金曜の回（平日だけの項目）は、土曜に見るとまだ続いている
  const friday = report.digestListReport([item('w', { recurrence: 'daily', recurrence_workdays: 1 })],
    checks([['w', days('2026-10-12', '2026-10-16'), days('2026-10-12', '2026-10-15'), '2026-10-16']]), { from: '2026-10-12', to: '2026-10-16' }, '2026-10-17')
  assert.equal(report.groupSummaryText(friday.groups[0]), '期間中 4/4回・金曜の分 0/1')
}

// 平日だけの項目は、土曜に見ると金曜の回が続いている
{
  const saturday = '2026-10-17'
  const thisWeek = { from: '2026-10-12', to: saturday }
  const workdays = item('w', { recurrence: 'daily', recurrence_workdays: 1 })
  const only = report.digestListReport([workdays], checks([['w', days('2026-10-12', '2026-10-16'), ['2026-10-12']]]), thisWeek, saturday)
  assert.equal(report.groupSummaryText(only.groups[0]), 'これまで 1/4回・金曜の分 0/1')
  assert.equal(only.groups[0].label, '平日')
  const fresh = report.digestListReport([workdays], checks([['w', ['2026-10-16'], []]]), thisWeek, saturday)
  assert.equal(report.groupSummaryText(fresh.groups[0]), '金曜の分 0/1（次の平日から集計）')
  const both = report.digestListReport([workdays, item('d', { recurrence: 'daily' })], checks([
    ['w', ['2026-10-16'], ['2026-10-16']],
    ['d', [saturday], []]
  ]), thisWeek, saturday)
  assert.deepEqual(plain({ label: both.groups[0].label, current: both.groups[0].current }), { label: '毎日・平日', current: { label: '今の分', checked: 1, total: 2 } })
}

// 項目ごとの表記
{
  const daily = item('a', { recurrence: 'daily' })
  const summaries = checks([['a', days('2026-10-10', todayKey), [...days('2026-10-10', '2026-10-13'), todayKey]]])
  assert.equal(report.itemStatusText(report.itemCheckStatus(daily, summaries.get('a'), todayKey)), '4/5回・今日 済み')
  assert.equal(report.itemStatusText(report.itemCheckStatus(daily, checks([['a', [todayKey], []]]).get('a'), todayKey)), '今日 まだ')
  assert.equal(report.itemCheckStatus(item('x', {}), undefined, todayKey), null, '繰り返さない項目は数えない')
}

// やること（繰り返さない項目）は件数で数える
{
  const todoItems = [
    item('open', { due_date: '2026-10-20' }),
    item('late', { due_date: '2026-10-12' }),
    item('doneIn', { done: 1, completed_at: new Date(2026, 9, 13, 10).toISOString() }),
    item('doneBefore', { done: 1, completed_at: new Date(2026, 9, 1, 10).toISOString() })
  ]
  const digest = report.digestListReport(todoItems, new Map(), week, todayKey)
  assert.equal(digest.groups.length, 0)
  assert.deepEqual(Array.from(digest.open, (entry) => entry.id), ['open', 'late'])
  assert.deepEqual(Array.from(digest.overdue, (entry) => entry.id), ['late'])
  assert.deepEqual(Array.from(digest.doneInPeriod, (entry) => entry.id), ['doneIn'], '期間より前に済んだものは数えない')
}

console.log('ToDo list display checks passed')
