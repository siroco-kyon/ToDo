import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

test('overview applies primary, co-assignee, unassigned, privacy and activity scopes consistently', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-overview-'))
  process.env.TODO_DATA_DIR = dataDir

  const { initDb, getDb } = await import('../src/db/connection')
  const { getOverviewData } = await import('../src/db/overview')
  initDb()
  const db = getDb()

  try {
    const now = new Date()
    const nowIso = now.toISOString()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayKey = dateKey(yesterday)

    const insertUser = db.prepare(`
      INSERT INTO Users (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 'member', ?, 1, ?, ?)
    `)
    insertUser.run('u1', 'user1', '田中', '#ef4444', nowIso, nowIso)
    insertUser.run('u2', 'user2', '佐藤', '#3b82f6', nowIso, nowIso)

    const insertCategory = db.prepare(`
      INSERT INTO Categories (id, name, color, is_private, created_at) VALUES (?, ?, ?, ?, ?)
    `)
    insertCategory.run('public', '公開', '#22c55e', 0, nowIso)
    insertCategory.run('private', '非公開', '#a855f7', 1, nowIso)

    const insertTodo = db.prepare(`
      INSERT INTO Todos (
        id, title, category_id, assignee_id, created_by, status, priority, progress,
        due_date, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertTodo.run('t1', '田中の公開タスク', 'public', 'u1', 'u1', 'active', 5, 30, yesterdayKey, nowIso, nowIso, null)
    insertTodo.run('t2', '佐藤の共同タスク', 'public', 'u2', 'u2', 'active', 4, 50, null, nowIso, nowIso, null)
    insertTodo.run('t3', '未割り当て', 'public', null, 'u1', 'not_started', 3, 0, null, nowIso, nowIso, null)
    insertTodo.run('t4', '田中の非公開タスク', 'private', 'u1', 'u1', 'active', 3, 20, null, nowIso, nowIso, null)
    insertTodo.run('t5', 'アーカイブ済み', 'public', 'u1', 'u1', 'archived', 3, 10, null, nowIso, nowIso, nowIso)
    db.prepare('INSERT INTO TodoCoAssignees (todo_id, user_id, created_at) VALUES (?, ?, ?)').run('t2', 'u1', nowIso)

    db.prepare(`
      INSERT INTO SubTasks (id, todo_id, title, assignee_id, progress, done, completed_at, created_at)
      VALUES ('s1', 't2', '共同タスクの完了項目', 'u2', 100, 1, ?, ?)
    `).run(nowIso, nowIso)
    db.prepare(`
      INSERT INTO WorkLogs (id, todo_id, user_id, start_time, end_time, duration_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('w1', 't1', 'u1', nowIso, nowIso, 1800, nowIso)
    db.prepare(`
      INSERT INTO WorkLogs (id, todo_id, user_id, start_time, end_time, duration_seconds, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('w2', 't2', 'u2', nowIso, nowIso, 900, nowIso)

    const allPublic = getOverviewData({ includePrivate: false })
    assert.equal(allPublic.summary.totalTasks, 3)
    assert.equal(allPublic.memberActivity.length, 2)
    assert.equal(allPublic.summary.todayMinutes, 45)

    const tanaka = getOverviewData({ assigneeId: 'u1', includePrivate: false })
    assert.equal(tanaka.summary.totalTasks, 2, '主担当とサブ担当の両方を含む')
    assert.deepEqual(new Set([...tanaka.risks, ...tanaka.highPriority].map((item) => item.todoId)), new Set(['t1', 't2']))
    assert.equal(tanaka.memberActivity.length, 1)
    assert.equal(tanaka.memberActivity[0].display_name, '田中')
    assert.equal(tanaka.summary.todayMinutes, 30)
    assert.equal(tanaka.completedSubTasks[0].assignee_name, '佐藤')
    assert.equal(tanaka.completedSubTasks[0].parent_assignee_name, '佐藤')
    assert.equal(tanaka.completedSubTasks[0].parent_co_assignees[0].display_name, '田中')

    const tanakaWithPrivate = getOverviewData({ assigneeId: 'u1', includePrivate: true })
    assert.equal(tanakaWithPrivate.summary.totalTasks, 3)

    const unassigned = getOverviewData({ assigneeId: '', includePrivate: false })
    assert.equal(unassigned.summary.totalTasks, 1)
    assert.equal(unassigned.memberActivity.length, 0)
    assert.equal(unassigned.summary.todayMinutes, 0)
  } finally {
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
