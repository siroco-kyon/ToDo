import crypto from 'crypto'
import { getDb } from './connection'
import { createProgressNote } from './progress'
import { getRunningState, stopTimer } from './timer'
import type { ProgressNote, WorkLog } from './types'

export interface QuickProgressInput {
  requestId: string
  todoId: string
  body: string
  stopTimer: boolean
  expectedStartTime?: string | null
}

export interface QuickProgressResult {
  note: ProgressNote
  workLog: WorkLog | null
}

export function stopExpectedTimer(userId: string, todoId: string, startTime: string): WorkLog {
  const running = getRunningState(userId)
  if (!running || running.todo_id !== todoId || running.start_time !== startTime) {
    throw new Error('別の画面で計測が変更されました。現在のタスクを確認してから操作してください')
  }
  return stopTimer(userId)
}

/** The note, timer stop, and replay receipt are committed together. */
export function createQuickProgress(userId: string, input: QuickProgressInput): {
  result: QuickProgressResult
  replayed: boolean
} {
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) {
    throw new Error('送信IDが不正です')
  }
  if (typeof input.todoId !== 'string' || !input.todoId || typeof input.body !== 'string') {
    throw new Error('タスクと進捗の内容を指定してください')
  }
  const body = input.body.trim()
  if (!body || body.length > 10000) throw new Error('進捗は1〜10000文字で入力してください')
  if (typeof input.stopTimer !== 'boolean') throw new Error('計測停止の指定が不正です')
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    input.todoId, body, input.stopTimer, input.stopTimer ? input.expectedStartTime : null
  ])).digest('hex')
  const db = getDb()
  return db.transaction(() => {
    const receipt = db.prepare('SELECT fingerprint, response_json FROM DesktopRequests WHERE user_id = ? AND request_id = ?')
      .get(userId, input.requestId) as { fingerprint: string; response_json: string } | undefined
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error('送信内容が変更されました。新しい送信としてやり直してください')
      return { result: JSON.parse(receipt.response_json) as QuickProgressResult, replayed: true }
    }
    if (!db.prepare('SELECT id FROM Todos WHERE id = ?').get(input.todoId)) throw new Error('タスクが見つかりません')
    const workLog = input.stopTimer
      ? stopExpectedTimer(userId, input.todoId, input.expectedStartTime ?? '')
      : null
    const note = createProgressNote(input.todoId, userId, body)
    const result = { note, workLog }
    db.prepare('INSERT INTO DesktopRequests (user_id, request_id, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, input.requestId, fingerprint, JSON.stringify(result), new Date().toISOString())
    return { result, replayed: false }
  })()
}
