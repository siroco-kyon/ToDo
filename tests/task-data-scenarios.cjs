const assert = require('node:assert/strict')

module.exports = function checkTaskData(api) {
  const entries = { A: ['2026-10-01', '2026-10-01'], B: ['2026-10-02', '2026-10-02'], C: ['2026-10-02', '2026-10-06'], D: ['2026-10-07', '2026-10-08'], E: ['2026-10-09', '2026-10-09'] }
  const tasks = Object.fromEntries(Object.entries(entries).map(([title, [start_date, due_date]]) => [title, api.createTodo({ title, start_date, due_date })]))
  const edges = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['D', 'E']]
  const dependencies = edges.map(([a, b], index) => {
    const edge = api.createTodoDependency(tasks[a].id, tasks[b].id)
    api.getDb().prepare('UPDATE TodoDependencies SET created_at=? WHERE id=?').run(`2026-10-01T00:00:0${index}.000Z`, edge.id)
    return edge
  })
  const bar = (name) => { const task = api.getTodoById(tasks[name].id); return [task.start_date, task.due_date] }
  api.updateTodo(tasks.A.id, { due_date: '2026-10-06' })
  assert.deepEqual(bar('C'), ['2026-10-07', '2026-10-11'])
  assert.deepEqual(bar('D'), ['2026-10-12', '2026-10-13'], '全前工程の更新後に合流先を計算する')
  assert.deepEqual(bar('E'), ['2026-10-14', '2026-10-14'])
  api.updateTodoDependency(dependencies[3].id, 2)
  assert.deepEqual(bar('D'), ['2026-10-14', '2026-10-15'])
  assert.deepEqual(bar('E'), ['2026-10-16', '2026-10-16'])
  api.deleteTodoDependency(dependencies[3].id)
  assert.deepEqual(bar('D'), ['2026-10-08', '2026-10-09'])
  assert.deepEqual(bar('E'), ['2026-10-10', '2026-10-10'])
  const untouched = api.createTodo({ title: '無関係なタスク', start_date: '2026-11-01', due_date: '2026-11-02' })
  api.updateTodo(tasks.A.id, { due_date: '2026-10-10' })
  assert.equal(api.getTodoById(untouched.id).due_date, '2026-11-02')

  // Vary branching, merge depth and insertion order against an independent date oracle.
  const date = (offset) => new Date(Date.UTC(2026, 9, 1 + offset)).toISOString().slice(0, 10)
  let seed = 9731
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let trial = 0; trial < 12; trial++) {
    const spans = Array.from({ length: 7 }, () => Math.floor(random() * 4))
    const graph = spans.map((span, index) => api.createTodo({ title: `DAG ${trial}/${index}`, start_date: date(0), due_date: date(span) }))
    const links = []
    for (let from = 0; from < graph.length; from++) for (let to = from + 1; to < graph.length; to++) {
      if (random() < 0.4 || to === from + 1) links.push({ from, to, lag: Math.floor(random() * 3) })
    }
    // Random insertion order must not affect the final schedule.
    for (let index = links.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1)); [links[index], links[other]] = [links[other], links[index]]
    }
    for (const edge of links) api.createTodoDependency(graph[edge.from].id, graph[edge.to].id, edge.lag)
    spans[0] += 9
    api.updateTodo(graph[0].id, { due_date: date(spans[0]) })
    const ends = []
    for (let index = 0; index < graph.length; index++) {
      const predecessors = links.filter((edge) => edge.to === index)
      const start = predecessors.length ? Math.max(...predecessors.map((edge) => ends[edge.from] + edge.lag + 1)) : 0
      ends[index] = start + spans[index]
      const actual = api.getTodoById(graph[index].id)
      assert.deepEqual([actual.start_date, actual.due_date], [date(start), date(ends[index])], `DAG ${trial} task ${index}`)
    }
  }

  const shared = api.createTodo({ title: '編集前', status: 'active', priority: 3 })
  api.updateTodo(shared.id, { status: 'on_hold', priority: 1 })
  const titleOnly = api.updateTodo(shared.id, { title: 'タイトルだけ変更', expected_values: { title: '編集前' } })
  assert.equal(titleOnly.status, 'on_hold')
  assert.equal(titleOnly.priority, 1)
  api.updateTodo(shared.id, { title: '別の画面のタイトル' })
  assert.throws(() => api.updateTodo(shared.id, {
    title: '古い画面のタイトル', priority: 5, expected_values: { title: 'タイトルだけ変更', priority: 1 }
  }), /変更されています/)
  assert.equal(api.getTodoById(shared.id).title, '別の画面のタイトル')
  assert.equal(api.getTodoById(shared.id).priority, 1, '競合時はほかの変更も確定させない')
  assert.throws(() => api.updateTodo(shared.id, { title: '不正', expected_values: { unknown: 1 } }), /不正/)
  assert.throws(() => api.updateTodo('missing', { title: '存在しない' }), /見つかりません/)

  const child = api.createSubTask(shared.id, { title: '元の子', progress: 0 })
  api.updateSubTask(child.id, { progress: 30 })
  const renamed = api.updateSubTask(child.id, { title: '子の名前だけ', expected_values: { title: '元の子' } })
  assert.equal(renamed.progress, 30)
  assert.throws(() => api.updateSubTask(child.id, {
    title: '競合時の名前', progress: 100, done: true, expected_values: { title: '子の名前だけ', progress: 0, done: false }
  }), /変更されています/)
  assert.equal(api.getSubTasksByTodo(shared.id)[0].title, '子の名前だけ')
  const completed = api.updateSubTask(child.id, { done: true, expected_values: { done: false } })
  assert.equal(completed.done, 1, 'SQLiteの完了フラグとbooleanを比較できる')
  assert.throws(() => api.updateSubTask('missing', { title: '存在しない' }), /見つかりません/)

  const parent = api.createTodo({ title: '親期限更新失敗', due_date: '2026-10-01' })
  const rollbackChild = api.createSubTask(parent.id, { title: '期限を延長する子' })
  api.getDb().exec(`CREATE TEMP TRIGGER fail_parent_due BEFORE UPDATE OF due_date ON Todos WHEN NEW.id = '${parent.id}' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  try {
    assert.throws(() => api.updateSubTask(rollbackChild.id, { title: '失敗する更新', due_date: '2026-10-31' }), /fixture failure/)
    assert.equal(api.getSubTasksByTodo(parent.id)[0].title, '期限を延長する子')
    assert.equal(api.getSubTasksByTodo(parent.id)[0].due_date, null, '親更新が失敗したら子の更新も取り消す')
    assert.throws(() => api.createSubTask(parent.id, { title: '失敗する追加', due_date: '2026-10-31' }), /fixture failure/)
    assert.equal(api.getSubTasksByTodo(parent.id).length, 1)
  } finally { api.getDb().exec('DROP TRIGGER fail_parent_due') }

  const toDelete = api.createTodo({ title: '削除途中の失敗', status: 'active' })
  const deletingChild = api.createSubTask(toDelete.id, { title: '残す子' })
  api.startTimer(toDelete.id)
  api.stopTimer()
  api.getDb().exec(`CREATE TEMP TRIGGER fail_parent_delete BEFORE DELETE ON Todos WHEN OLD.id = '${toDelete.id}' BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END`)
  try {
    assert.throws(() => api.deleteTodo(toDelete.id), /fixture delete failure/)
    assert.equal(api.getSubTasksByTodo(toDelete.id)[0].id, deletingChild.id)
    assert.equal(api.getWorkLogsByTodo(toDelete.id).length, 1, '親削除失敗時にログを失わない')
  } finally { api.getDb().exec('DROP TRIGGER fail_parent_delete') }
  api.deleteTodo(toDelete.id)
  assert.equal(api.getAllTodos().some((item) => item.id === toDelete.id), false)

  const timed = api.createTodo({ title: '停止の一括保存' })
  api.startTimer(timed.id)
  api.getDb().exec("CREATE TEMP TRIGGER fail_timer_delete BEFORE DELETE ON RunningState BEGIN SELECT RAISE(ABORT, 'fixture timer failure'); END")
  try {
    assert.throws(() => api.stopTimer(), /fixture timer failure/)
    assert.equal(api.getWorkLogsByTodo(timed.id).length, 0, '停止失敗時はログだけ確定しない')
    assert.equal(api.getDb().prepare('SELECT todo_id FROM RunningState').get().todo_id, timed.id)
  } finally { api.getDb().exec('DROP TRIGGER fail_timer_delete') }
  api.stopTimer()
  assert.equal(api.getWorkLogsByTodo(timed.id).length, 1, '停止の再試行でもログは1件')
}
