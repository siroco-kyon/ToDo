import crypto from 'crypto'
import { getDb } from './connection'
import type { RunningState, WorkLog } from './types'

export function startTimer(userId: string, todoId: string): RunningState {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM RunningState WHERE user_id = ?').get(userId)
  if (existing) {
    throw new Error('既に実行中のタイマーがあります')
  }
  const now = new Date().toISOString()
  db.prepare('INSERT INTO RunningState (user_id, todo_id, start_time) VALUES (?, ?, ?)').run(userId, todoId, now)
  return { user_id: userId, todo_id: todoId, start_time: now }
}

export function stopTimer(userId: string, note?: string): WorkLog {
  const db = getDb()
  const running = db.prepare('SELECT * FROM RunningState WHERE user_id = ?').get(userId) as RunningState | undefined
  if (!running) {
    throw new Error('実行中のタイマーがありません')
  }
  const endTime = new Date().toISOString()
  const startMs = new Date(running.start_time).getTime()
  const endMs = new Date(endTime).getTime()
  const durationSeconds = Math.floor((endMs - startMs) / 1000)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO WorkLogs (id, todo_id, user_id, start_time, end_time, duration_seconds, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, running.todo_id, userId, running.start_time, endTime, durationSeconds, note ?? '', now)

  db.prepare('DELETE FROM RunningState WHERE user_id = ?').run(userId)

  return db.prepare('SELECT * FROM WorkLogs WHERE id = ?').get(id) as WorkLog
}

export function getRunningState(userId: string): RunningState | undefined {
  return getDb().prepare('SELECT * FROM RunningState WHERE user_id = ?').get(userId) as RunningState | undefined
}
