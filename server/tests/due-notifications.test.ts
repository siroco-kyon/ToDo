import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('期限の通知は今のタスクに合わせる（完了・延期で既読、期限が変われば書き直す）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-due-notifications-'))
  process.env.TODO_DATA_DIR = dir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const notifications = await import('../src/db/notifications')
  connection.initDb()
  try {
    const db = connection.getDb()
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO Users (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES ('u1', 'u1', '佐藤', 'hash', 'member', '#3b82f6', 1, ?, ?)`).run(now, now)
    const dateKey = (offset: number): string => {
      const date = new Date()
      date.setDate(date.getDate() + offset)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    const monthDay = (key: string): string => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`
    const dueOf = (title: string) => notifications.listNotifications('u1').filter((item) => item.type === 'task_due' && item.body.includes(title))

    const soon = todos.createTodo({ title: '見積もり', status: 'active', assignee_id: 'u1', due_date: dateKey(1) }, 'u1')
    const later = todos.createTodo({ title: '資料作成', status: 'active', assignee_id: 'u1', due_date: dateKey(2) }, 'u1')
    const done = todos.createTodo({ title: '提出', status: 'active', assignee_id: 'u1', due_date: dateKey(0) }, 'u1')
    assert.equal(notifications.countUnreadNotifications('u1'), 3)
    assert.equal(dueOf('見積もり')[0].body, `「見積もり」の期限は${monthDay(dateKey(1))}です`, '日付は画面と同じ書き方')

    // 期限が変わっただけ（まだ近い）なら、今の期限に書き直す
    todos.updateTodo(soon.id, { due_date: dateKey(2) }, 'u1')
    assert.equal(dueOf('見積もり')[0].body, `「見積もり」の期限は${monthDay(dateKey(2))}です`)
    assert.equal(dueOf('見積もり')[0].read_at, null)

    // 完了した・期限を先へ延ばしたタスクの通知は既読にする
    todos.updateTodo(done.id, { status: 'done' }, 'u1')
    todos.updateTodo(later.id, { due_date: dateKey(20) }, 'u1')
    assert.notEqual(dueOf('提出')[0].read_at, null, '完了したら既読')
    assert.notEqual(dueOf('資料作成')[0].read_at, null, '期限を延ばしたら既読')
    assert.equal(notifications.countUnreadNotifications('u1'), 1)

    // 前の日に出した期限の通知が未読のまま残っていても、今日の分を出すときに既読にして、同じタスクの通知を重ねない
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    db.prepare("UPDATE Notifications SET created_at = ? WHERE user_id = 'u1' AND type = 'task_due' AND read_at IS NULL").run(yesterday)
    const unreadSoon = dueOf('見積もり').filter((item) => item.read_at == null)
    assert.equal(unreadSoon.length, 1, '同じタスクの未読の期限の通知は1件だけ')
    assert.notEqual(unreadSoon[0].created_at, yesterday, '今日の分が残る')
  } finally {
    connection.getDb().close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
