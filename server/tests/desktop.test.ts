import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'

test('HAKOBI の投稿と停止は一括保存され、通信後の再試行でも重複しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-desktop-'))
  process.env.TODO_DATA_DIR = dir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const timer = await import('../src/db/timer')
  const desktop = await import('../src/db/desktop')
  const progress = await import('../src/db/progress')
  const worklogs = await import('../src/db/worklogs')
  connection.initDb()
  try {
    const now = new Date().toISOString()
    const insert = connection.getDb().prepare(`INSERT INTO Users
      (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 'member', '#3b82f6', 1, ?, ?)`)
    for (const id of ['u1', 'u2']) insert.run(id, id, id, now, now)
    const task = todos.createTodo({ title: 'HAKOBI の検証', status: 'active', assignee_id: 'u1' }, 'u1')
    const other = todos.createTodo({ title: '別のタスク', status: 'active', assignee_id: 'u1' }, 'u1')
    const running = timer.startTimer('u1', task.id)
    const input = { requestId: 'test-000000000001', todoId: task.id, body: '最初の投稿', stopTimer: true, expectedStartTime: running.start_time }
    const first = desktop.createQuickProgress('u1', input)
    assert.equal(first.replayed, false)
    assert.equal(first.result.note.user_id, 'u1')
    assert.equal(first.result.workLog?.todo_id, task.id)
    assert.equal(timer.getRunningState('u1'), undefined)

    // A response may be lost and the user may start another timer before retry.
    const nextRunning = timer.startTimer('u1', other.id)
    connection.getDb().close()
    connection.initDb()
    const replay = desktop.createQuickProgress('u1', input)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.result, first.result)
    assert.equal(progress.getProgressNotesByTodo(task.id, 'u1').length, 1)
    assert.equal(worklogs.getWorkLogsByTodo(task.id).length, 1)
    assert.equal(timer.getRunningState('u1')?.todo_id, other.id, '再試行で次のタイマーを止めない')
    assert.throws(() => desktop.createQuickProgress('u1', { ...input, body: '別の内容' }), /送信内容/)

    const stale = { ...input, requestId: 'test-000000000002', body: '古い画面からの投稿' }
    assert.throws(() => desktop.createQuickProgress('u1', stale), /計測が変更/)
    assert.equal(progress.getProgressNotesByTodo(task.id, 'u1').length, 1, '停止に失敗したときは投稿もしない')
    assert.throws(() => desktop.stopExpectedTimer('u1', other.id, 'old-start'), /計測が変更/)
    assert.equal(timer.getRunningState('u1')?.start_time, nextRunning.start_time)

    connection.getDb().exec(`CREATE TRIGGER desktop_fail_note BEFORE INSERT ON ProgressNotes
      WHEN NEW.body = '失敗' BEGIN SELECT RAISE(ABORT, 'test failure'); END;`)
    assert.throws(() => desktop.createQuickProgress('u1', {
      requestId: 'test-000000000003', todoId: other.id, body: '失敗', stopTimer: true, expectedStartTime: nextRunning.start_time
    }), /test failure/)
    assert.equal(timer.getRunningState('u1')?.todo_id, other.id, '投稿のDBエラーで先に実行した停止も取り消す')
    assert.equal(worklogs.getWorkLogsByTodo(other.id).length, 0)
    assert.equal(connection.getDb().prepare('SELECT COUNT(*) AS total FROM DesktopRequests WHERE request_id = ?').get('test-000000000003')?.total, 0)

    const secondUser = desktop.createQuickProgress('u2', { ...input, stopTimer: false, expectedStartTime: null, body: '別のユーザー' })
    assert.equal(secondUser.replayed, false, '送信IDはユーザーごとに分離する')
    assert.equal(secondUser.result.note.user_id, 'u2')
    assert.throws(() => desktop.createQuickProgress('u1', { ...input, requestId: 'test-000000000004', body: ' ' }), /1〜10000/)
    assert.throws(() => desktop.createQuickProgress('u1', { ...input, requestId: 'bad' }), /送信ID/)
    assert.throws(() => desktop.createQuickProgress('u1', { ...input, requestId: 'test-000000000005', todoId: 'missing', stopTimer: false }), /見つかりません/)

    const { dataRouter } = await import('../src/routes/data')
    const { getUserById, toPublicUser } = await import('../src/db/users')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'u1') req.user = toPublicUser(getUserById('u1')!)
      next()
    })
    app.use('/api', dataRouter)
    const httpServer = app.listen(0, '127.0.0.1')
    try {
      await new Promise<void>((resolve) => { if (httpServer.listening) resolve(); else httpServer.once('listening', resolve) })
      const address = httpServer.address() as { port: number }
      const endpoint = `http://127.0.0.1:${address.port}/api/desktop/quick-progress`
      const request = { requestId: 'test-000000000006', todoId: other.id, body: 'HTTP の投稿', stopTimer: false, expectedUserId: 'u1' }
      const send = (body: unknown, authenticated = true): Promise<Response> => fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'x-test-user': 'u1' } : {}) }, body: JSON.stringify(body)
      })
      assert.equal((await send(request, false)).status, 401, '未認証の投稿を拒否する')
      assert.equal((await send({ ...request, expectedUserId: 'u2' })).status, 400, '画面表示時からのアカウント変更を拒否する')
      const success = await send(request)
      assert.equal(success.status, 200)
      const response = await success.json() as { note: { id: string } }
      const repeated = await send(request)
      assert.equal(repeated.status, 200)
      assert.equal((await repeated.json() as { note: { id: string } }).note.id, response.note.id)
      assert.equal(progress.getProgressNotesByTodo(other.id, 'u1').length, 1)
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    }
  } finally {
    connection.getDb().close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
