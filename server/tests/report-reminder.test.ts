import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import cookieParser from 'cookie-parser'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('報告のリマインドは定例の前日の17時から、報告がまだの担当タスクがある人に1日1回だけ出す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-reminder-'))
  process.env.TODO_DATA_DIR = dir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const settings = await import('../src/db/settings')
  const notifications = await import('../src/db/notifications')
  connection.initDb()
  try {
    const db = connection.getDb()
    const insert = db.prepare(`INSERT INTO Users
      (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 'member', '#3b82f6', ?, ?, ?)`)
    const now = new Date().toISOString()
    insert.run('u1', 'u1', '佐藤', 1, now, now)
    insert.run('u2', 'u2', '鈴木', 1, now, now)
    insert.run('u3', 'u3', '高橋', 0, now, now)

    // 2026-10-15（木）を定例の前日にする（定例は金曜 = 5）
    const thursday = (hour: number): Date => new Date(2026, 9, 15, hour, 0, 0)
    const pending = todos.createTodo({ title: '見積もり回答', status: 'active', assignee_id: 'u1', start_date: '2026-10-01' }, 'u1')
    todos.createTodo({ title: 'まだ始まらない', status: 'not_started', assignee_id: 'u1', start_date: '2026-10-20' }, 'u1')
    todos.createTodo({ title: '保留中', status: 'on_hold', assignee_id: 'u1' }, 'u1')
    todos.createTodo({ title: 'ToDoリスト', status: 'active', assignee_id: 'u1', list_mode: 1 }, 'u1')
    const reported = todos.createTodo({ title: '報告済み', status: 'active', assignee_id: 'u2' }, 'u2')
    db.prepare('INSERT INTO ProgressNotes (id, todo_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('note-1', reported.id, 'u2', '進めています', thursday(10).toISOString(), thursday(10).toISOString())
    todos.createTodo({ title: '無効な人の担当', status: 'active', assignee_id: 'u3' }, 'u1')

    assert.deepEqual(notifications.runReportReminders(thursday(18)), [], '定例の曜日を決めていないうちは出さない')

    settings.setSetting(notifications.REPORT_MEETING_WEEKDAY_SETTING, '5')
    assert.deepEqual(notifications.runReportReminders(thursday(16)), [], '17時より前は出さない')
    assert.deepEqual(notifications.runReportReminders(new Date(2026, 9, 14, 18)), [], '前日でない日は出さない')

    assert.deepEqual(notifications.runReportReminders(thursday(17)), ['u1'], '報告がまだのタスクがある有効な人だけ')
    const sent = db.prepare("SELECT title, body FROM Notifications WHERE user_id = 'u1' AND type = 'report_reminder'").all() as Array<{ title: string; body: string }>
    assert.equal(sent.length, 1)
    assert.equal(sent[0].title, '明日は定例です')
    assert.equal(sent[0].body, '報告がまだのタスクが1件あります（「見積もり回答」）', '保留中・まだ始まらない・ToDoリストは数えない')

    assert.deepEqual(notifications.runReportReminders(thursday(20)), [], '同じ日には2回出さない')

    // チームタブの「報告なし」もリマインドと同じ条件で数える
    assert.deepEqual(notifications.listUnreportedTodos('u1', thursday(18)).map((todo) => todo.title), ['見積もり回答'])
    assert.deepEqual(notifications.listUnreportedTodos('u2', thursday(18)), [], '直近7日に進捗ログがあれば数えない')
    const team = await import('../src/db/team')
    const workloads = team.getTeamWorkloads()
    assert.equal(workloads.find((member) => member.user_id === 'u1')?.unreported_tasks, notifications.listUnreportedTodos('u1').length, 'チームの集計は今日の時点で数える')

    // 通知設定で止めた人には出さない
    db.prepare("DELETE FROM Notifications WHERE type = 'report_reminder'").run()
    db.prepare("INSERT INTO NotificationPreferences (user_id, type, enabled) VALUES ('u1', 'report_reminder', 0)").run()
    assert.deepEqual(notifications.runReportReminders(thursday(18)), [], '通知設定で止められる')
    assert.ok(pending.id)

    // REST: 定例の曜日は管理者だけが変えられ、報告のリマインドは通知設定で止められる
    db.prepare("UPDATE Users SET role = 'admin' WHERE id = 'u2'").run()
    const { dataRouter } = await import('../src/routes/data')
    const { attachUser, createSession } = await import('../src/auth')
    const { SESSION_COOKIE } = await import('../src/config')
    const memberCookie = `${SESSION_COOKIE}=${createSession('u1')}`
    const adminCookie = `${SESSION_COOKIE}=${createSession('u2')}`
    const app = express()
    app.use(express.json(), cookieParser(), attachUser)
    app.use('/api', dataRouter)
    const http = createServer(app)
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    try {
      const address = http.address()
      assert.ok(address && typeof address !== 'string')
      const base = `http://127.0.0.1:${address.port}`
      const putWeekday = (cookie: string, value: unknown): Promise<Response> => fetch(`${base}/api/settings/${notifications.REPORT_MEETING_WEEKDAY_SETTING}`, {
        method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ value })
      })
      assert.equal((await putWeekday(memberCookie, '1')).status, 403, 'メンバーは定例の曜日を変えられない')
      assert.equal(settings.getSetting(notifications.REPORT_MEETING_WEEKDAY_SETTING), '5')
      assert.equal((await putWeekday(adminCookie, '9')).status, 400, '曜日でない値は保存しない')
      assert.equal((await putWeekday(adminCookie, '1')).status, 200)
      assert.equal(settings.getSetting(notifications.REPORT_MEETING_WEEKDAY_SETTING), '1')
      assert.equal((await putWeekday(adminCookie, '')).status, 200, '「決めない」に戻せる')

      const preference = await fetch(`${base}/api/notification-preferences`, {
        method: 'POST', headers: { Cookie: memberCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'report_reminder', enabled: true })
      })
      assert.equal(preference.status, 200, '報告のリマインドの通知設定を受け付ける')
      const enabled = db.prepare("SELECT enabled FROM NotificationPreferences WHERE user_id = 'u1' AND type = 'report_reminder'").get() as { enabled: number }
      assert.equal(enabled.enabled, 1)
    } finally {
      http.close()
    }
  } finally {
    connection.getDb().close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
