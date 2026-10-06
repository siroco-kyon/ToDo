import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { WebSocket } from 'ws'

test('confirmed deletion preserves history and revokes HTTP/WS access', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-member-delete-'))
  process.env.TODO_DATA_DIR = dataDir
  const { initDb, getDb } = await import('../src/db/connection')
  const users = await import('../src/db/users')
  const auth = await import('../src/auth')
  const { usersRouter } = await import('../src/routes/users')
  const { initRealtime, getOnlineUserIds } = await import('../src/realtime')
  const todos = await import('../src/db/todos')
  const subtasks = await import('../src/db/subtasks')
  const { startTimer } = await import('../src/db/timer')
  const { runMigrations } = await import('../src/db/schema')
  const { SESSION_COOKIE } = await import('../src/config')
  initDb()
  const db = getDb()
  db.exec('ALTER TABLE Users DROP COLUMN deleted_at')
  runMigrations(db)
  runMigrations(db)
  const passwordHash = auth.hashPassword('test-password')
  const admin = users.createUser({ username: 'admin', display_name: '管理者', role: 'admin', password_hash: passwordHash })
  const member = users.createUser({ username: 'member', display_name: '削除対象', password_hash: passwordHash })
  const other = users.createUser({ username: 'other', display_name: '別のメンバー', password_hash: passwordHash })
  const task = todos.createTodo({ title: '担当タスク', assignee_id: member.id }, member.id)
  const coTask = todos.createTodo({ title: '共同担当', assignee_id: other.id })
  todos.updateTodo(coTask.id, { co_assignee_ids: [member.id, admin.id] })
  const sub = subtasks.createSubTask(task.id, { title: '子タスク', assignee_id: member.id })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO ProgressNotes (id, todo_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('note', task.id, member.id, 'https://example.com/進捗', now, now)
  db.prepare('INSERT INTO ProgressNoteComments (id, note_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('comment', 'note', member.id, '返信', now, now)
  db.prepare('INSERT INTO TodoChangeLogs (id, todo_id, user_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('change', task.id, member.id, 'memo', '', '更新', now)
  db.prepare('INSERT INTO TodoSubscriptions (todo_id, user_id, created_at) VALUES (?, ?, ?)').run(task.id, member.id, now)
  startTimer(member.id, task.id)
  db.prepare('UPDATE RunningState SET start_time = ? WHERE user_id = ?').run(new Date(Date.now() - 65000).toISOString(), member.id)
  const tokens = { admin: auth.createSession(admin.id), member: auth.createSession(member.id), other: auth.createSession(other.id) }
  const app = express()
  app.use(express.json(), cookieParser(), auth.attachUser)
  app.use('/api/users', usersRouter)
  app.get('/protected', auth.requireAuth, (_req, res) => res.json({ ok: true }))
  const server = http.createServer(app)
  initRealtime(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const call = (method: string, route: string, token?: string, body?: unknown): Promise<Response> => fetch('http://127.0.0.1:' + port + route, {
    method, headers: { 'Content-Type': 'application/json', Cookie: token ? SESSION_COOKIE + '=' + token : '' }, body: body === undefined ? undefined : JSON.stringify(body)
  })
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Cookie: SESSION_COOKIE + '=' + tokens.member } })
  const adminSocket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Cookie: SESSION_COOKIE + '=' + tokens.admin } })
  const scopes: string[] = []
  adminSocket.on('message', (message) => { const data = JSON.parse(String(message)); if (data.type === 'data:changed') scopes.push(data.scope) })
  try {
    await Promise.all([once(socket, 'open'), once(adminSocket, 'open')])
    assert.ok(getOnlineUserIds().includes(member.id))
    assert.equal((await call('GET', '/api/users/' + member.id + '/delete-preview', tokens.other)).status, 403)
    const preview = await (await call('GET', '/api/users/' + member.id + '/delete-preview', tokens.admin)).json()
    assert.deepEqual([preview.taskCount, preview.subtaskCount, preview.coAssignedTaskCount], [1, 1, 1])
    assert.equal(preview.user.username, member.username)
    assert.equal(preview.user.password_hash, undefined)
    for (const [token, id, body, status] of [
      [undefined, member.id, { confirmationUsername: 'member' }, 401],
      [tokens.other, member.id, { confirmationUsername: 'member' }, 403],
      [tokens.admin, admin.id, { confirmationUsername: 'admin' }, 400],
      [tokens.admin, member.id, {}, 400],
      [tokens.admin, member.id, { confirmationUsername: 'other' }, 400],
      [tokens.admin, member.id, { confirmationUsername: ' member ' }, 400]
    ] as const) assert.equal((await call('DELETE', '/api/users/' + id, token, body)).status, status)
    assert.ok(users.getUserById(member.id))
    assert.equal(todos.getTodoById(task.id).assignee_id, member.id)
    assert.ok(db.prepare('SELECT 1 FROM RunningState WHERE user_id = ?').get(member.id))
    const closed = once(socket, 'close')
    assert.equal((await call('DELETE', '/api/users/' + member.id, tokens.admin, { confirmationUsername: 'member' })).status, 204)
    assert.equal((await closed)[0], 4401)
    assert.equal(getOnlineUserIds().includes(member.id), false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(new Set(scopes), new Set(['user', 'todo', 'subtask', 'plan', 'progress']))
    assert.equal((await call('GET', '/protected', tokens.member)).status, 401)
    assert.equal(auth.verifyCredentials('member', 'test-password'), null)
    assert.equal(auth.getSessionUser(tokens.member), null)
    assert.equal(users.listUsers().some((user) => user.id === member.id), false)
    assert.equal(users.getUserById(member.id), undefined)
    assert.ok(users.getUserByUsername('member')?.deleted_at, 'login ID stays reserved')
    assert.equal(todos.getTodoById(task.id).assignee_id, null)
    assert.equal(todos.getTodoById(task.id).created_by, member.id)
    assert.equal(subtasks.getSubTasksByTodo(task.id)[0].assignee_id, null)
    assert.deepEqual(todos.getTodoById(coTask.id).co_assignees?.map((user) => user.user_id), [admin.id])
    assert.equal(todos.getTodoById(coTask.id).assignee_id, other.id)
    for (const table of ['ProgressNotes', 'ProgressNoteComments', 'TodoChangeLogs']) {
      assert.ok(db.prepare('SELECT 1 FROM ' + table + ' WHERE user_id = ?').get(member.id), table + ' retains authorship')
    }
    const log = db.prepare('SELECT * FROM WorkLogs WHERE user_id = ?').get(member.id) as { duration_seconds: number }
    assert.ok(log.duration_seconds >= 60)
    assert.equal(db.prepare('SELECT 1 FROM RunningState WHERE user_id = ?').get(member.id), undefined)
    assert.equal(db.prepare('SELECT 1 FROM TodoSubscriptions WHERE user_id = ?').get(member.id), undefined)
    assert.throws(() => todos.updateTodo(task.id, { assignee_id: member.id }), /担当者/)
    assert.throws(() => todos.updateTodo(coTask.id, { co_assignee_ids: [member.id] }), /担当者/)
    assert.deepEqual(todos.getTodoById(coTask.id).co_assignees?.map((user) => user.user_id), [admin.id], 'invalid stale assignment rolls back')
    assert.throws(() => subtasks.updateSubTask(sub.id, { assignee_id: member.id }), /担当者/)
    assert.throws(() => todos.createTodo({ title: '不正な担当', assignee_id: member.id }), /担当者/)
    assert.throws(() => users.updateUser(member.id, { is_active: true }), /見つかりません/)
    assert.equal((await call('PUT', '/api/users/' + member.id, tokens.admin, { is_active: true })).status, 404)
    assert.equal((await call('DELETE', '/api/users/' + member.id, tokens.admin, { confirmationUsername: 'member' })).status, 400)
    users.updateUser(other.id, { is_active: false })
    users.deleteUser(other.id, admin.id, 'other')
    const secondAdmin = users.createUser({ username: 'admin2', display_name: '管理者2', role: 'admin', password_hash: passwordHash })
    users.deleteUser(secondAdmin.id, admin.id, 'admin2')
    assert.equal(users.listUsers().filter((user) => user.role === 'admin' && user.is_active === 1).length, 1)
    assert.equal(db.pragma('foreign_key_check').length, 0)
  } finally {
    socket.terminate()
    adminSocket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
