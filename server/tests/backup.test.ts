import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import cookieParser from 'cookie-parser'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

test('自動バックアップは1日1つ取り、残す数を超えた古いものから消す。管理者は今の DB をダウンロードできる', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-backup-'))
  process.env.TODO_DATA_DIR = dataDir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const backup = await import('../src/backup')
  connection.initDb()
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  try {
    const db = connection.getDb()
    const insert = db.prepare(`INSERT INTO Users
      (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', ?, '#3b82f6', 1, ?, ?)`)
    const now = new Date().toISOString()
    insert.run('admin', 'admin', '管理者', 'admin', now, now)
    insert.run('member', 'member', 'メンバー', 'member', now, now)
    todos.createTodo({ title: 'バックアップに入るタスク', status: 'active', assignee_id: 'member' }, 'member')

    const dir = path.join(dataDir, 'backups')
    const day = (date: number): Date => new Date(2026, 9, date, 3, 0, 0)
    const first = await backup.runDailyBackup(day(1), dir, 3)
    assert.equal(first, path.join(dir, 'hakobi-2026-10-01.db'))
    const copy = new Database(first!, { readonly: true })
    try {
      const rows = copy.prepare('SELECT title FROM Todos').all() as Array<{ title: string }>
      assert.deepEqual(rows.map((row) => row.title), ['バックアップに入るタスク'], 'バックアップを開くとタスクが入っている')
    } finally {
      copy.close()
    }
    assert.equal(await backup.runDailyBackup(day(1), dir, 3), null, '同じ日には2つ目を取らない')

    fs.writeFileSync(path.join(dir, 'メモ.txt'), '消さない')
    for (const date of [2, 3, 4, 5]) await backup.runDailyBackup(day(date), dir, 3)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['hakobi-2026-10-03.db', 'hakobi-2026-10-04.db', 'hakobi-2026-10-05.db', 'メモ.txt'],
      '残す数（3）を超えた古いものから消し、ほかのファイルは消さない')
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0, '書きかけのファイルを残さない')

    const info = backup.getBackupInfo(dir, 3)
    assert.equal(info.count, 3)
    assert.equal(info.latestName, 'hakobi-2026-10-05.db')
    assert.ok(info.latestAt)

    assert.equal(await backup.runDailyBackup(day(6), dir, 0), null, '残す数が 0 なら自動バックアップをしない')
    assert.equal(fs.existsSync(path.join(dir, 'hakobi-2026-10-06.db')), false)

    // REST: ダウンロードと状態は管理者だけ
    const { dataRouter } = await import('../src/routes/data')
    const { attachUser, createSession } = await import('../src/auth')
    const { SESSION_COOKIE } = await import('../src/config')
    const adminCookie = `${SESSION_COOKIE}=${createSession('admin')}`
    const memberCookie = `${SESSION_COOKIE}=${createSession('member')}`
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
      assert.equal((await fetch(`${base}/api/admin/backup`, { headers: { Cookie: memberCookie } })).status, 403, 'メンバーはダウンロードできない')
      assert.equal((await fetch(`${base}/api/admin/backup/info`, { headers: { Cookie: memberCookie } })).status, 403)

      const downloadsBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('hakobi-download-')))
      const response = await fetch(`${base}/api/admin/backup`, { headers: { Cookie: adminCookie } })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-disposition') ?? '', /hakobi-backup-\d{8}-\d{4}\.db/)
      const body = Buffer.from(await response.arrayBuffer())
      assert.equal(body.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'SQLite のファイルを返す')
      const downloaded = path.join(dataDir, 'downloaded.db')
      fs.writeFileSync(downloaded, body)
      const opened = new Database(downloaded, { readonly: true })
      try {
        assert.equal((opened.prepare('SELECT COUNT(*) AS count FROM Todos').get() as { count: number }).count, 1)
      } finally {
        opened.close()
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const leftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('hakobi-download-') && !downloadsBefore.has(name))
      assert.deepEqual(leftovers, [], '送り終えたら一時ファイルを消す')

      const infoResponse = await fetch(`${base}/api/admin/backup/info`, { headers: { Cookie: adminCookie } })
      assert.equal(infoResponse.status, 200)
      const served = await infoResponse.json() as { keep: number; directory: string }
      assert.equal(served.keep, 14, '既定は14日分')
      assert.equal(served.directory, path.join(dataDir, 'backups'))
    } finally {
      http.close()
    }
  } finally {
    connection.getDb().close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
