import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

test('progress digest attributes completions and added subtasks to the member who did them', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-progress-digest-'))
  process.env.TODO_DATA_DIR = dataDir

  const { initDb, getDb } = await import('../src/db/connection')
  const { createTodo, updateTodo, archiveTodo, unarchiveTodo } = await import('../src/db/todos')
  const { createSubTask } = await import('../src/db/subtasks')
  const { getProgressDigest } = await import('../src/db/progress')
  initDb()
  const db = getDb()

  try {
    const nowIso = new Date().toISOString()
    const today = dateKey(new Date())
    const insertUser = db.prepare(`
      INSERT INTO Users (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 'member', ?, 1, ?, ?)
    `)
    insertUser.run('u1', 'user1', '田中', '#ef4444', nowIso, nowIso)
    insertUser.run('u2', 'user2', '佐藤', '#3b82f6', nowIso, nowIso)

    // 田中が主担当・佐藤が副担当のタスクを、佐藤が完了にする
    const shared = createTodo({ title: '共同タスク', assignee_id: 'u1' }, 'u1')
    updateTodo(shared.id, { co_assignee_ids: ['u2'] }, 'u1')
    updateTodo(shared.id, { status: 'done' }, 'u2')

    // 田中が完了にしたあと、佐藤がアーカイブして完了のまま戻す（復元は完了操作に数えない）
    const restored = createTodo({ title: '戻したタスク', assignee_id: 'u1' }, 'u1')
    updateTodo(restored.id, { progress: 100 }, 'u1')
    archiveTodo(restored.id, 'u2')
    unarchiveTodo(restored.id, 'u2', 'done')

    // 完了の履歴がない古いデータは主担当で数える
    db.prepare(`
      INSERT INTO Todos (id, title, assignee_id, status, progress, created_at, updated_at, completed_at)
      VALUES ('legacy-done', '古い完了タスク', 'u1', 'done', 100, ?, ?, ?)
    `).run(nowIso, nowIso, nowIso)

    // 田中のタスクに佐藤がサブタスクを追加する。追加者のない古いサブタスクは主担当で数える
    const added = createSubTask(shared.id, { title: '佐藤が追加' }, 'u2')
    assert.equal(added.created_by, 'u2')
    db.prepare(`
      INSERT INTO SubTasks (id, todo_id, title, created_at) VALUES ('legacy-sub', ?, '古いサブタスク', ?)
    `).run(shared.id, nowIso)

    const digest = getProgressDigest(today, today, ['u1', 'u2'])
    const byId = new Map(digest.users.map((user) => [user.user_id, user]))
    const tanaka = byId.get('u1')!
    const sato = byId.get('u2')!

    assert.deepEqual(sato.completed_todos.map((todo) => todo.id), [shared.id], '副担当が完了にしたタスクは副担当の完了')
    assert.deepEqual(
      new Set(tanaka.completed_todos.map((todo) => todo.id)),
      new Set([restored.id, 'legacy-done']),
      '主担当には自分が完了にしたタスクと履歴のない古いタスクだけが入る'
    )
    assert.deepEqual(sato.added_subtasks.map((sub) => sub.id), [added.id], '副担当が追加したサブタスクは副担当の追加')
    assert.deepEqual(tanaka.added_subtasks.map((sub) => sub.id), ['legacy-sub'], '追加者のない古いサブタスクだけ主担当')

    // 繰り返しの次回分に複製したサブタスクは、元のサブタスクの追加者を引き継ぐ
    const recurring = createTodo({
      title: '毎日の確認', assignee_id: 'u1', recurrence: 'daily', recurrence_copy_subtasks: 1,
      start_date: today, due_date: today
    }, 'u1')
    createSubTask(recurring.id, { title: '佐藤の確認項目' }, 'u2')
    updateTodo(recurring.id, { status: 'done' }, 'u1')
    const copies = db.prepare(`
      SELECT st.created_by FROM SubTasks st JOIN Todos t ON st.todo_id = t.id
      WHERE t.id != ? AND t.title = '毎日の確認'
    `).all(recurring.id) as Array<{ created_by: string | null }>
    assert.deepEqual(copies.map((row) => row.created_by), ['u2'])
  } finally {
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
