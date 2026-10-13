// Web UI side of the HAKOBI desktop: which notifications reach the OS and which tasks the tray offers.
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const bundle = buildSync({ entryPoints: [path.join(root, 'web/desktop/desktopFeed.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: { '@renderer': path.join(root, 'src/renderer/src') } }).outputFiles[0].text

function load(storage) {
  const module = { exports: {} }
  vm.runInContext(bundle, vm.createContext({ module, exports: module.exports, console, window: { localStorage: storage } }))
  return module.exports
}
// Values built inside the VM carry another realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value))

function notification(id, createdAt, extra = {}) {
  return { id, user_id: 'me', type: 'progress_reply', actor_user_id: 'other', actor_name: '山田', actor_color: '#fff', todo_id: 'todo-1',
    todo_title: '設計', progress_note_id: null, progress_comment_id: null, title: `${id}のタイトル`, body: `${id}の本文`,
    created_at: createdAt, read_at: null, ...extra }
}

function todo(id, extra = {}) {
  return { id, title: `${id}のタスク`, status: 'active', assignee_id: null, co_assignees: [], due_date: null, sort_order: 0, ...extra }
}

function testNotifications() {
  const memory = new Map()
  const feed = load({ getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) })
  const backlog = [notification('a', '2026-10-13T00:00:01.000Z'), notification('b', '2026-10-13T00:00:02.000Z')]
  const first = feed.selectNewNotifications(backlog, null)
  assert.equal(first.show.length, 0, 'the first check on a PC must not replay old notifications')
  assert.deepEqual(plain(first.next), { watermark: '2026-10-13T00:00:02.000Z', ids: ['b'] })

  const items = [
    notification('c', '2026-10-13T00:00:04.000Z'),
    notification('read', '2026-10-13T00:00:05.000Z', { read_at: '2026-10-13T00:00:06.000Z' }),
    notification('tie', '2026-10-13T00:00:02.000Z'),
    ...backlog,
    notification('d', '2026-10-13T00:00:03.000Z')
  ]
  const second = feed.selectNewNotifications(items, first.next)
  assert.deepEqual(plain(second.show.map((item) => item.id)), ['tie', 'd', 'c'],
    'unread notifications after the mark are shown oldest first, including one sharing the mark time')
  assert.deepEqual(plain(second.next), { watermark: '2026-10-13T00:00:05.000Z', ids: ['read'] })
  assert.equal(feed.selectNewNotifications(items, second.next).show.length, 0, 'a notification is announced once')
  const sameTime = feed.selectNewNotifications([notification('e', '2026-10-13T00:00:05.000Z'), ...items], second.next)
  assert.deepEqual(plain(sameTime.show.map((item) => item.id)), ['e'])
  assert.deepEqual(plain(sameTime.next.ids).sort(), ['e', 'read'], 'IDs at the same mark time accumulate')
  const empty = feed.selectNewNotifications([], null)
  assert.deepEqual(plain(empty), { show: [], next: { watermark: '', ids: [] } })
  assert.deepEqual(plain(feed.selectNewNotifications([notification('f', '2026-10-13T00:00:01.000Z')], empty.next).show.map((item) => item.id)), ['f'])

  const single = plain(feed.toDesktopNotifications([notification('g', '2026-10-13T00:00:01.000Z')]))
  assert.deepEqual(single, [{ notificationId: 'g', title: 'gのタイトル', body: 'gの本文（山田）' }])
  assert.deepEqual(plain(feed.toDesktopNotifications([notification('h', 'x', { actor_name: null })]))[0].body, 'hの本文')
  const three = feed.toDesktopNotifications(['1', '2', '3'].map((id) => notification(id, id)))
  assert.equal(three.length, 3)
  const burst = plain(feed.toDesktopNotifications(['1', '2', '3', '4', '5'].map((id) => notification(id, id))))
  assert.deepEqual(burst, [{ title: '新しい通知が5件あります', body: '5のタイトル\n4のタイトル\n3のタイトル' }],
    'a burst becomes one summary that opens the list')

  assert.equal(feed.readNotifiedMark('me'), null)
  feed.writeNotifiedMark('me', second.next)
  assert.deepEqual(plain(feed.readNotifiedMark('me')), plain(second.next))
  assert.equal(feed.readNotifiedMark('someone-else'), null, 'each account keeps its own mark')
  memory.set('hakobi-desktop-notified:me', '{broken')
  assert.equal(feed.readNotifiedMark('me'), null)
  memory.set('hakobi-desktop-notified:me', '{"watermark":1}')
  assert.equal(feed.readNotifiedMark('me'), null)

  const blocked = load({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
  assert.equal(blocked.readNotifiedMark('me'), null)
  assert.doesNotThrow(() => blocked.writeNotifiedMark('me', second.next))
}

function testRecentTasks() {
  const feed = load({ getItem: () => null, setItem() {} })
  const todos = [
    todo('recent-old'), todo('recent-new'), todo('running'), todo('held', { status: 'on_hold' }), todo('done', { status: 'done' }),
    todo('archived', { status: 'archived' }), todo('not-started', { status: 'not_started' }),
    todo('mine-late', { assignee_id: 'me', due_date: '2026-12-01' }), todo('mine-soon', { assignee_id: 'me', due_date: '2026-10-20' }),
    todo('mine-co', { co_assignees: [{ user_id: 'me', display_name: '自分', color: '#fff' }] }),
    todo('mine-waiting', { assignee_id: 'me', status: 'not_started' }), todo('others', { assignee_id: 'other' })
  ]
  const logs = [
    { todo_id: 'recent-old', start_time: '2026-10-10T00:00:00.000Z' },
    { todo_id: 'held', start_time: '2026-10-13T03:00:00.000Z' },
    { todo_id: 'recent-new', start_time: '2026-10-13T01:00:00.000Z' },
    { todo_id: 'running', start_time: '2026-10-13T02:00:00.000Z' },
    { todo_id: 'recent-old', start_time: '2026-10-12T00:00:00.000Z' },
    { todo_id: 'deleted', start_time: '2026-10-13T04:00:00.000Z' },
    { todo_id: 'not-started', start_time: '2026-10-09T00:00:00.000Z' }
  ]
  const picked = plain(feed.pickRecentTasks({ userId: 'me', todos, logs, runningTodoId: 'running' }))
  assert.deepEqual(picked.map((task) => task.id), ['recent-new', 'recent-old', 'not-started', 'mine-soon', 'mine-late'],
    'timed tasks come first, newest first, then my tasks in progress by due date; running, held, finished and deleted tasks are skipped')
  assert.deepEqual(plain(feed.pickRecentTasks({ userId: 'me', todos, logs: [], runningTodoId: null })).map((task) => task.id),
    ['mine-soon', 'mine-late', 'mine-co'], 'a member without work logs still gets their own tasks, including co-assigned ones')
  const long = plain(feed.pickRecentTasks({ userId: 'me', todos: [todo('long', { title: 'あ'.repeat(500) })], logs: [{ todo_id: 'long', start_time: 'x' }], runningTodoId: null }))
  assert.equal(long[0].title.length, 200, 'titles are bounded before crossing the desktop bridge')
  assert.deepEqual(plain(feed.pickRecentTasks({ userId: 'me', todos: [], logs, runningTodoId: null })), [])
}

testNotifications()
testRecentTasks()
console.log('Desktop feed checks passed: new-notification detection, burst summary, per-account marks, and tray task selection')
