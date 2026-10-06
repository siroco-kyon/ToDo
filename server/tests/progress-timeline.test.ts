import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import cookieParser from 'cookie-parser'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

test('timeline includes recent replies, nested replies and deletion in activity order', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-progress-timeline-'))
  process.env.TODO_DATA_DIR = dataDir
  const { initDb, getDb } = await import('../src/db/connection')
  const progress = await import('../src/db/progress')
  initDb()
  const db = getDb()
  try {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO Users (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES ('author', 'author', '投稿者', 'hash', 'member', '#6366f1', 1, ?, ?)`).run(now, now)
    db.prepare(`INSERT INTO Users (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES ('replier', 'replier', '返信者', 'hash', 'member', '#6366f1', 1, ?, ?)`).run(now, now)
    require('../../tests/progress-timeline-scenarios.cjs')({
      ...progress, getDb,
      createComment: (id: string, body: string, parent?: string) => progress.createProgressNoteComment(id, 'replier', body, parent),
      editNote: (id: string, body: string) => progress.updateProgressNote(id, body, 'author'),
      editComment: (id: string, body: string) => progress.updateProgressNoteComment(id, body, 'replier'),
      react: (id: string) => progress.toggleProgressNoteReaction(id, 'replier', '👍'),
      deleteProgressNoteComment: (id: string) => progress.deleteProgressNoteComment(id, 'replier')
    }, 'author')

    // 実際のRESTルートと、別ユーザーへのWebSocket更新通知を検証する。
    const { dataRouter } = await import('../src/routes/data')
    const { attachUser, createSession } = await import('../src/auth')
    const { initRealtime } = await import('../src/realtime')
    const { SESSION_COOKIE } = await import('../src/config')
    const authorCookie = `${SESSION_COOKIE}=${createSession('author')}`
    const replierCookie = `${SESSION_COOKIE}=${createSession('replier')}`
    const app = express()
    app.use(express.json(), cookieParser(), attachUser)
    app.use('/api', dataRouter)
    const http = createServer(app)
    initRealtime(http)
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Cookie: authorCookie } })
    try {
      await once(socket, 'open')
      const change = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('進捗の更新通知が届かない')), 5000)
        socket.on('message', (data) => {
          const event = JSON.parse(data.toString())
          if (event.type === 'data:changed' && event.scope === 'progress') {
            clearTimeout(timeout)
            resolve()
          }
        })
      })
      const response = await fetch(`${base}/api/progress-notes/old/comments`, {
        method: 'POST', headers: { Cookie: replierCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '別ユーザーからの返信' })
      })
      assert.equal(response.status, 200)
      const note = await response.json()
      await change
      const date = new Date(note.last_activity_at)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const listResponse = await fetch(`${base}/api/progress-notes/activity-timeline?from=${key}&to=${key}`, { headers: { Cookie: authorCookie } })
      assert.equal(listResponse.status, 200)
      const notes = await listResponse.json()
      assert.equal(notes[0].id, 'old')
      assert.equal(notes[0].last_reply_at, note.last_reply_at)
      assert.equal(notes[0].comments[0].author_name, '返信者')
      const anonymous = await fetch(`${base}/api/progress-notes/activity-timeline?from=${key}&to=${key}`)
      assert.equal(anonymous.status, 401)
    } finally {
      const closed = once(socket, 'close')
      socket.close()
      await closed
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    }
  } finally {
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
