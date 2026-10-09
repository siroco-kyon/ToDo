import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import cookieParser from 'cookie-parser'
import { WebSocket } from 'ws'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Expected realtime event did not arrive')
    await pause(10)
  }
}

/** A real file with the single-user schema, including older optional columns. */
function createDesktopFixture(file: string, legacy = false): void {
  const source = new Database(file)
  try {
    source.exec(`
      CREATE TABLE Categories (id TEXT PRIMARY KEY, name TEXT, color TEXT, ${legacy ? '' : 'is_private INTEGER,'} created_at TEXT);
      CREATE TABLE Todos (id TEXT PRIMARY KEY, title TEXT, category_id TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE SubTasks (id TEXT PRIMARY KEY, todo_id TEXT, title TEXT, done INTEGER, created_at TEXT);
      CREATE TABLE TodoDependencies (id TEXT PRIMARY KEY, predecessor_todo_id TEXT, successor_todo_id TEXT, type TEXT, lag_days INTEGER, created_at TEXT);
      CREATE TABLE WorkLogs (id TEXT PRIMARY KEY, todo_id TEXT, start_time TEXT, end_time TEXT, duration_seconds INTEGER, note TEXT, created_at TEXT);
      CREATE TABLE DailyPlanItems (id TEXT PRIMARY KEY, plan_date TEXT, todo_id TEXT, created_at TEXT, updated_at TEXT);
    `)
    const created = '2025-04-01T01:02:03.000Z'
    if (legacy) {
      source.prepare('INSERT INTO Categories VALUES (?, ?, ?, ?)').run('legacy-cat', 'Legacy category', '#6366f1', created)
      source.prepare('INSERT INTO Todos VALUES (?, ?, ?, ?, ?, ?)').run('legacy-task', 'Old task', 'legacy-cat', 'active', created, created)
      return
    }
    source.prepare('INSERT INTO Categories VALUES (?, ?, ?, ?, ?)').run('import-cat', 'Private import', '#6366f1', 1, created)
    source.prepare('INSERT INTO Categories VALUES (?, ?, ?, ?, ?)').run('import-shared-cat', 'Shared category', '#6366f1', 1, created)
    const insertTask = source.prepare('INSERT INTO Todos VALUES (?, ?, ?, ?, ?, ?)')
    insertTask.run('import-task', 'Imported task', 'import-cat', 'active', created, created)
    insertTask.run('import-task-2', 'Second imported task', 'import-shared-cat', 'active', created, created)
    source.prepare('INSERT INTO SubTasks VALUES (?, ?, ?, ?, ?)').run('import-sub', 'import-task', 'Imported child', 1, created)
    source.prepare('INSERT INTO TodoDependencies VALUES (?, ?, ?, ?, ?, ?)').run('import-dep', 'import-task', 'import-task-2', 'finish_to_start', 2, created)
    source.prepare('INSERT INTO WorkLogs VALUES (?, ?, ?, ?, ?, ?, ?)').run('import-log', 'import-task', created, created, 30, 'Work note', created)
    source.prepare('INSERT INTO DailyPlanItems VALUES (?, ?, ?, ?, ?)').run('import-plan', '2025-04-01', 'import-task', created, created)
    source.exec(`
      CREATE TABLE ProgressNotes (id TEXT PRIMARY KEY, todo_id TEXT, user_id TEXT, body TEXT, needs_discussion INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE ProgressNoteComments (id TEXT PRIMARY KEY, note_id TEXT, parent_comment_id TEXT, user_id TEXT, body TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE ProgressNoteReactions (id TEXT PRIMARY KEY, note_id TEXT, user_id TEXT, actor_key TEXT, emoji TEXT, created_at TEXT);
      CREATE TABLE ProgressCommentReactions (id TEXT PRIMARY KEY, comment_id TEXT, user_id TEXT, actor_key TEXT, emoji TEXT, created_at TEXT);
      CREATE TABLE TodoChangeLogs (id TEXT PRIMARY KEY, todo_id TEXT, field TEXT, old_value TEXT, new_value TEXT, created_at TEXT);
      CREATE TABLE SubTaskChangeLogs (id TEXT PRIMARY KEY, subtask_id TEXT, todo_id TEXT, field TEXT, old_value TEXT, new_value TEXT, created_at TEXT);
    `)
    const insertNote = source.prepare('INSERT INTO ProgressNotes VALUES (?, ?, NULL, ?, ?, ?, ?)')
    insertNote.run('import-note', 'import-task', 'Saved progress', 1, created, '2025-04-02T01:02:03.000Z')
    insertNote.run('import-note-2', 'import-task-2', 'Old progress', 0, created, '')
    insertNote.run('orphan-note', 'missing-task', 'Orphan progress', 0, created, created)
    const insertComment = source.prepare('INSERT INTO ProgressNoteComments VALUES (?, ?, ?, NULL, ?, ?, ?)')
    // Child rows precede their parents, as they may in an imported SQLite file.
    insertComment.run('import-grandchild', 'import-note', 'import-child', 'Grandchild reply', created, created)
    insertComment.run('import-child', 'import-note', 'import-root', 'Child reply', created, '')
    insertComment.run('import-root', 'import-note', null, 'Root reply', created, created)
    insertComment.run('missing-parent', 'import-note', 'absent', 'Invalid reply', created, created)
    insertComment.run('orphan-descendant', 'import-note', 'missing-parent', 'Invalid descendant', created, created)
    insertComment.run('cross-note', 'import-note-2', 'import-root', 'Wrong note', created, created)
    insertComment.run('cycle-a', 'import-note', 'cycle-b', 'Cycle A', created, created)
    insertComment.run('cycle-b', 'import-note', 'cycle-a', 'Cycle B', created, created)
    insertComment.run('orphan-comment', 'orphan-note', null, 'Missing note', created, created)
    source.prepare('INSERT INTO ProgressNoteReactions VALUES (?, ?, NULL, ?, ?, ?)').run('import-note-reaction', 'import-note', 'desktop', '👍', created)
    source.prepare('INSERT INTO ProgressCommentReactions VALUES (?, ?, NULL, ?, ?, ?)').run('import-comment-reaction', 'import-child', 'desktop', '🙌', created)
    source.prepare('INSERT INTO ProgressCommentReactions VALUES (?, ?, NULL, ?, ?, ?)').run('orphan-reaction', 'missing-parent', 'desktop', '👍', created)
    source.prepare('INSERT INTO TodoChangeLogs VALUES (?, ?, ?, ?, ?, ?)').run('import-change', 'import-task', 'memo', '', 'Changed memo', created)
    source.prepare('INSERT INTO SubTaskChangeLogs VALUES (?, ?, ?, ?, ?, ?, ?)').run('import-sub-change', 'import-sub', 'import-task', 'progress', '0', '100', created)
  } finally {
    source.close()
  }
}

test('WebSocket authentication, account lifecycle and legacy imports', { timeout: 30000 }, async (t) => {
  const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-auth-import-'))
  process.env.TODO_DATA_DIR = path.join(ownedDir, 'server-data')
  process.env.TODO_ENV_FILE = path.join(ownedDir, 'empty.env')
  fs.writeFileSync(process.env.TODO_ENV_FILE, '')
  const sockets: WebSocket[] = []
  let server: http.Server | undefined
  let db: Database.Database | undefined
  try {
    const connection = await import('../src/db/connection')
    const users = await import('../src/db/users')
    const auth = await import('../src/auth')
    const todos = await import('../src/db/todos')
    const subtasks = await import('../src/db/subtasks')
    const timer = await import('../src/db/timer')
    const progress = await import('../src/db/progress')
    const { usersRouter } = await import('../src/routes/users')
    const { authRouter } = await import('../src/routes/auth')
    const { dataRouter } = await import('../src/routes/data')
    const realtime = await import('../src/realtime')
    const { SESSION_COOKIE } = await import('../src/config')
    connection.initDb()
    db = connection.getDb()
    const passwordHash = auth.hashPassword('test-password')
    const admin = users.createUser({ username: 'admin', display_name: '管理者', role: 'admin', password_hash: passwordHash })
    const member = users.createUser({ username: 'member', display_name: 'メンバー', password_hash: passwordHash })
    const adminToken = auth.createSession(admin.id)
    const memberTokens = [auth.createSession(member.id), auth.createSession(member.id)]
    const app = express()
    app.use(express.json(), cookieParser(), auth.attachUser)
    app.use('/api/auth', authRouter)
    app.use('/api/users', usersRouter)
    app.use('/api', dataRouter)
    server = http.createServer(app)
    realtime.initRealtime(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const cookie = (token: string): string => SESSION_COOKIE + '=' + token
    const call = (method: string, route: string, body?: unknown, token = adminToken): Promise<Response> => fetch('http://127.0.0.1:' + port + '/api' + route, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie(token) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000)
    })
    function newSocket(header: string): WebSocket {
      const socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Cookie: header } })
      sockets.push(socket)
      return socket
    }
    async function rejectedSocket(header: string): Promise<number | undefined> {
      const socket = newSocket(header)
      socket.on('error', () => {})
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket rejection timed out')) }, 2000)
        socket.once('unexpected-response', (_request, response) => {
          clearTimeout(timeout)
          response.resume()
          socket.terminate()
          resolve(response.statusCode)
        })
        socket.once('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('Unauthenticated socket accepted')) })
      })
    }

    await t.test('malformed unrelated and session cookies cannot crash the server', async () => {
      const socket = newSocket('zoom=100%; ' + cookie(adminToken))
      await once(socket, 'open')
      assert.equal(await rejectedSocket('zoom=100%'), 401)
      assert.equal(await rejectedSocket(SESSION_COOKIE + '=%'), 401)
      assert.equal((await call('GET', '/auth/me')).status, 200)

      // A database authentication failure must reject the handshake safely too.
      db!.exec('ALTER TABLE Sessions RENAME TO Sessions_unavailable')
      const errors = t.mock.method(console, 'error', () => {})
      try {
        assert.equal(await rejectedSocket(cookie(adminToken)), 401)
        assert.equal(errors.mock.calls.length, 1)
      } finally {
        errors.mock.restore()
        db!.exec('ALTER TABLE Sessions_unavailable RENAME TO Sessions')
      }
      const recovered = newSocket(cookie(adminToken))
      await once(recovered, 'open')
      assert.equal((await call('GET', '/auth/me')).status, 200)
    })

    const observer = newSocket(cookie(adminToken))
    const scopes: string[] = []
    observer.on('message', (message) => {
      const event = JSON.parse(String(message))
      if (event.type === 'data:changed') scopes.push(event.scope)
    })
    await once(observer, 'open')
    await t.test('user creation and profile updates notify other members', async () => {
      assert.equal((await call('POST', '/users', { username: 'new-member', display_name: '新メンバー', password: 'test-password' })).status, 200)
      await waitFor(() => scopes.includes('user'))
      assert.ok((await (await call('GET', '/users')).json()).some((user: { username: string }) => user.username === 'new-member'))
      scopes.length = 0
      assert.equal((await call('PUT', '/users/' + member.id, { display_name: '変更した表示名', color: '#123456' })).status, 200)
      await waitFor(() => ['user', 'todo', 'subtask', 'plan', 'progress'].every((scope) => scopes.includes(scope)))
      assert.equal(users.getUserById(member.id)?.display_name, '変更した表示名')
      assert.equal((await call('PUT', '/users/' + admin.id, { is_active: 0 })).status, 400)
      assert.equal(users.getUserById(admin.id)?.is_active, 1)
    })

    await t.test('disable atomically stops work, revokes every session and closes sockets', async () => {
      const task = todos.createTodo({ title: '計測中', assignee_id: member.id }, member.id)
      subtasks.createSubTask(task.id, { title: '子タスク', assignee_id: member.id })
      timer.startTimer(member.id, task.id)
      const started = new Date(Date.now() - 65000).toISOString()
      db!.prepare('UPDATE RunningState SET start_time = ? WHERE user_id = ?').run(started, member.id)
      const memberSocket = newSocket(cookie(memberTokens[0]))
      await once(memberSocket, 'open')
      assert.ok(realtime.getOnlineUserIds().includes(member.id))
      db!.exec(`CREATE TRIGGER fail_disable BEFORE UPDATE ON Users WHEN NEW.id = '${member.id}' AND NEW.is_active = 0
        BEGIN SELECT RAISE(ABORT, 'disable failed'); END;`)
      assert.equal((await call('PUT', '/users/' + member.id, { is_active: false })).status, 400)
      assert.equal(users.getUserById(member.id)?.is_active, 1)
      assert.equal(timer.getRunningState(member.id)?.start_time, started)
      assert.equal((db!.prepare('SELECT COUNT(*) AS count FROM Sessions WHERE user_id = ?').get(member.id) as { count: number }).count, 2)
      assert.equal(db!.prepare('SELECT 1 FROM WorkLogs WHERE user_id = ?').get(member.id), undefined)
      assert.equal(memberSocket.readyState, WebSocket.OPEN, 'failed disable does not disconnect the user')
      db!.exec('DROP TRIGGER fail_disable')
      scopes.length = 0
      const closed = once(memberSocket, 'close')
      const beforeDisable = Date.now()
      assert.equal((await call('PUT', '/users/' + member.id, { is_active: false })).status, 200)
      const afterDisable = Date.now()
      assert.equal((await closed)[0], 4401)
      assert.equal(realtime.getOnlineUserIds().includes(member.id), false)
      assert.equal(timer.getRunningState(member.id), undefined)
      assert.equal(db!.prepare('SELECT 1 FROM Sessions WHERE user_id = ?').get(member.id), undefined)
      const log = db!.prepare('SELECT * FROM WorkLogs WHERE user_id = ?').get(member.id) as { end_time: string; duration_seconds: number; note: string }
      assert.ok(Date.parse(log.end_time) >= beforeDisable && Date.parse(log.end_time) <= afterDisable)
      assert.equal(log.duration_seconds, Math.floor((Date.parse(log.end_time) - Date.parse(started)) / 1000))
      assert.match(log.note, /無効化/)
      assert.equal((await (await call('GET', '/team')).json()).now.some((row: { user_id: string }) => row.user_id === member.id), false)
      await waitFor(() => scopes.includes('user') && scopes.includes('todo'))
      for (const token of memberTokens) assert.equal((await call('GET', '/auth/me', undefined, token)).status, 401)
      assert.equal((await call('PUT', '/users/' + member.id, { is_active: true })).status, 200)
      for (const token of memberTokens) assert.equal((await call('GET', '/auth/me', undefined, token)).status, 401, 're-enabling does not revive revoked sessions')
      const login = await call('POST', '/auth/login', { username: 'member', password: 'test-password' })
      assert.equal(login.status, 200)
    })

    await t.test('file imports preserve notes, nested replies, reactions, history and private flags', async () => {
      const file = path.join(ownedDir, 'desktop.db')
      createDesktopFixture(file)
      const sourceHash = (): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      const beforeHash = sourceHash()
      const created = '2025-04-01T01:02:03.000Z'
      db!.prepare('INSERT INTO Categories (id, name, color, is_private, created_at) VALUES (?, ?, ?, ?, ?)').run('existing-category', 'Shared category', '#6366f1', 0, created)
      async function upload(dryRun = false): Promise<Response> {
        return fetch('http://127.0.0.1:' + port + '/api/import/desktop-db?userId=' + member.id + (dryRun ? '&dryRun=1' : ''), {
          method: 'POST', headers: { Cookie: cookie(adminToken), 'Content-Type': 'application/octet-stream' },
          body: fs.readFileSync(file), signal: AbortSignal.timeout(3000)
        })
      }
      const preview = await upload(true)
      assert.equal(preview.status, 200)
      const previewCounts = await preview.json()
      assert.equal(previewCounts.progressNotes, 2)
      assert.equal(previewCounts.progressComments, 3)
      assert.equal(db!.prepare('SELECT 1 FROM Todos WHERE id = ?').get('import-task'), undefined)
      assert.equal(db!.prepare('SELECT 1 FROM Categories WHERE name = ?').get('Private import'), undefined)
      const imported = await upload()
      assert.equal(imported.status, 200)
      const result = await imported.json()
      assert.deepEqual([result.categories, result.todos, result.subTasks, result.dependencies, result.workLogs, result.planItems], [1, 2, 1, 1, 1, 1])
      assert.deepEqual([result.progressNotes, result.progressComments, result.progressReactions, result.todoChanges, result.subTaskChanges], [2, 3, 2, 1, 1])
      assert.ok(result.skippedOrphans > 0)
      assert.deepEqual(result.categoryConflicts, ['Shared category'])
      assert.equal((db!.prepare('SELECT is_private FROM Categories WHERE name = ?').get('Private import') as { is_private: number }).is_private, 1)
      assert.equal((db!.prepare('SELECT is_private FROM Categories WHERE id = ?').get('existing-category') as { is_private: number }).is_private, 0)
      for (const [table, id] of [
        ['ProgressNotes', 'import-note'], ['ProgressNoteComments', 'import-child'], ['ProgressNoteReactions', 'import-note-reaction'],
        ['ProgressCommentReactions', 'import-comment-reaction'], ['TodoChangeLogs', 'import-change'], ['SubTaskChangeLogs', 'import-sub-change']
      ]) assert.equal((db!.prepare('SELECT user_id FROM ' + table + ' WHERE id = ?').get(id) as { user_id: string }).user_id, member.id)
      assert.equal((db!.prepare('SELECT parent_comment_id FROM ProgressNoteComments WHERE id = ?').get('import-grandchild') as { parent_comment_id: string }).parent_comment_id, 'import-child')
      assert.equal((db!.prepare('SELECT parent_comment_id FROM ProgressNoteComments WHERE id = ?').get('import-child') as { parent_comment_id: string }).parent_comment_id, 'import-root')
      assert.equal((db!.prepare('SELECT updated_at FROM ProgressNotes WHERE id = ?').get('import-note-2') as { updated_at: string }).updated_at, created)
      assert.equal((db!.prepare('SELECT updated_at FROM ProgressNoteComments WHERE id = ?').get('import-child') as { updated_at: string }).updated_at, created)
      assert.equal((db!.prepare('SELECT old_value FROM TodoChangeLogs WHERE id = ?').get('import-change') as { old_value: string }).old_value, '')
      const note = progress.getProgressNotesByTodo('import-task', member.id)[0]
      assert.equal(note.body, 'Saved progress')
      assert.equal(note.needs_discussion, 1)
      assert.equal(note.reactions[0].reacted_by_me, true)
      const reply = note.comments.find((comment) => comment.id === 'import-root')!.replies[0]
      assert.equal(reply.id, 'import-child')
      assert.equal(reply.replies[0].id, 'import-grandchild')
      assert.equal(reply.reactions[0].reacted_by_me, true)
      assert.equal(sourceHash(), beforeHash, 'the source DB remains untouched')
      db!.prepare('UPDATE ProgressNotes SET body = ? WHERE id = ?').run('Edited on server', 'import-note')
      const repeated = await upload()
      assert.equal(repeated.status, 200)
      const repeatedCounts = await repeated.json()
      for (const count of ['categories', 'todos', 'subTasks', 'dependencies', 'workLogs', 'planItems', 'progressNotes', 'progressComments', 'progressReactions', 'todoChanges', 'subTaskChanges']) assert.equal(repeatedCounts[count], 0, count + ' remains idempotent')
      assert.equal(progress.getProgressNotesByTodo('import-task', member.id)[0].body, 'Edited on server')
      assert.equal(db!.pragma('foreign_key_check').length, 0)

      // A failure late in a reply tree rolls back the entire import.
      db!.prepare('DELETE FROM WorkLogs WHERE todo_id IN (?, ?)').run('import-task', 'import-task-2')
      db!.prepare('DELETE FROM SubTasks WHERE todo_id IN (?, ?)').run('import-task', 'import-task-2')
      db!.prepare('DELETE FROM Todos WHERE id IN (?, ?)').run('import-task', 'import-task-2')
      db!.prepare('DELETE FROM Categories WHERE name = ?').run('Private import')
      db!.exec("CREATE TRIGGER fail_import_reply BEFORE INSERT ON ProgressNoteComments WHEN NEW.id = 'import-child' BEGIN SELECT RAISE(ABORT, 'reply import failed'); END;")
      try {
        assert.equal((await upload()).status, 400)
        assert.equal(db!.prepare('SELECT 1 FROM Todos WHERE id = ?').get('import-task'), undefined)
        assert.equal(db!.prepare('SELECT 1 FROM ProgressNotes WHERE id = ?').get('import-note'), undefined)
        assert.equal(db!.prepare('SELECT 1 FROM Categories WHERE name = ?').get('Private import'), undefined)
      } finally {
        db!.exec('DROP TRIGGER fail_import_reply')
      }
    })

    await t.test('older desktop files without optional progress tables still import', async () => {
      const file = path.join(ownedDir, 'legacy.db')
      createDesktopFixture(file, true)
      const { importDesktopDb } = await import('../src/import/import-desktop-db')
      const imported = importDesktopDb({ webDb: db!, sourceDbPath: file, targetUserId: member.id })
      assert.equal(imported.todos, 1)
      assert.deepEqual([imported.progressNotes, imported.progressComments, imported.progressReactions, imported.todoChanges, imported.subTaskChanges], [0, 0, 0, 0, 0])
      assert.equal((db!.prepare('SELECT is_private FROM Categories WHERE name = ?').get('Legacy category') as { is_private: number }).is_private, 0)
      const oldNotesFile = path.join(ownedDir, 'legacy-notes.db')
      createDesktopFixture(oldNotesFile, true)
      const source = new Database(oldNotesFile)
      source.exec(`
        UPDATE Todos SET id = 'legacy-noted-task';
        CREATE TABLE ProgressNotes (id TEXT PRIMARY KEY, todo_id TEXT, body TEXT, created_at TEXT);
        CREATE TABLE ProgressNoteComments (id TEXT PRIMARY KEY, note_id TEXT, body TEXT, created_at TEXT);
        INSERT INTO ProgressNotes VALUES ('legacy-note', 'legacy-noted-task', 'Old note', '2025-04-01T01:02:03.000Z');
        INSERT INTO ProgressNoteComments VALUES ('legacy-comment', 'legacy-note', 'Old comment', '2025-04-01T01:02:03.000Z');
      `)
      source.close()
      const oldNotes = importDesktopDb({ webDb: db!, sourceDbPath: oldNotesFile, targetUserId: member.id })
      assert.deepEqual([oldNotes.progressNotes, oldNotes.progressComments, oldNotes.progressReactions], [1, 1, 0])
      const note = progress.getProgressNotesByTodo('legacy-noted-task', member.id)[0]
      assert.equal(note.updated_at, note.created_at)
      assert.equal(note.needs_discussion, 0)
      assert.equal(note.comments[0].parent_comment_id, null)
      assert.equal(note.comments[0].updated_at, note.comments[0].created_at)
      assert.equal(db!.pragma('foreign_key_check').length, 0)
    })

    await t.test('importer and CLI reject deleted target accounts without storing records', async () => {
      const file = path.join(ownedDir, 'deleted-target.db')
      createDesktopFixture(file, true)
      const source = new Database(file)
      source.prepare('UPDATE Todos SET id = ?').run('must-not-import-task')
      source.close()
      const deleted = users.createUser({ username: 'deleted-import-user', display_name: '削除済み', password_hash: passwordHash })
      users.deleteUser(deleted.id, admin.id, deleted.username)
      const { importDesktopDb } = await import('../src/import/import-desktop-db')
      assert.throws(() => importDesktopDb({ webDb: db!, sourceDbPath: file, targetUserId: deleted.id }), /削除/)
      assert.throws(() => importDesktopDb({ webDb: db!, sourceDbPath: file, targetUserId: 'absent-user' }), /見つからない/)
      const cli = spawnSync(process.execPath, [
        '--import', pathToFileURL(path.resolve(__dirname, '../node_modules/tsx/dist/loader.mjs')).href,
        path.resolve(__dirname, '../src/import/cli.ts'), '--db', file, '--user', deleted.username
      ], { env: process.env, encoding: 'utf8', timeout: 5000, windowsHide: true })
      assert.equal(cli.error, undefined)
      assert.equal(cli.status, 1)
      assert.match(cli.stderr, /削除済み/)
      assert.equal(db!.prepare('SELECT 1 FROM Todos WHERE id = ?').get('must-not-import-task'), undefined)
      assert.equal((db!.prepare('SELECT COUNT(*) AS count FROM Todos WHERE assignee_id = ?').get(deleted.id) as { count: number }).count, 0)
    })

    await t.test('invalid SQLite uploads close their file handle before cleanup', async () => {
      const { importDesktopDb } = await import('../src/import/import-desktop-db')
      const file = path.join(ownedDir, 'invalid-upload.db')
      fs.writeFileSync(file, 'this is not a SQLite database')
      assert.throws(() => importDesktopDb({ webDb: db!, sourceDbPath: file, targetUserId: member.id }), /database|file|SQLite/i)
      fs.unlinkSync(file)
      assert.equal(fs.existsSync(file), false, 'Windows can delete the failed upload immediately')
      const missingTable = path.join(ownedDir, 'missing-todos.db')
      const source = new Database(missingTable)
      source.exec('CREATE TABLE Other (id TEXT)')
      source.close()
      assert.throws(() => importDesktopDb({ webDb: db!, sourceDbPath: missingTable, targetUserId: member.id }), /Todos/)
      fs.unlinkSync(missingTable)
      assert.equal(fs.existsSync(missingTable), false)
    })
  } finally {
    for (const socket of sockets) socket.terminate()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (db?.open) db.close()
    assert.equal(path.dirname(path.resolve(ownedDir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(ownedDir).startsWith('hakobi-auth-import-'))
    fs.rmSync(ownedDir, { recursive: true, force: true })
  }
})
