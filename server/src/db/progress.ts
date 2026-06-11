import crypto from 'crypto'
import { getDb } from './connection'
import type {
  ProgressNote,
  ProgressDigest,
  ProgressDigestNote,
  ProgressDigestSubTask,
  ProgressDigestTodo,
  ProgressDigestUser
} from './types'

const NOTE_SELECT = `SELECT pn.id, pn.todo_id, pn.user_id, pn.body, pn.created_at,
              u.display_name AS author_name, u.color AS author_color
       FROM ProgressNotes pn
       LEFT JOIN Users u ON pn.user_id = u.id`

/** All progress notes for one task, newest first, with author info. */
export function getProgressNotesByTodo(todoId: string): ProgressNote[] {
  return getDb()
    .prepare(`${NOTE_SELECT} WHERE pn.todo_id = ? ORDER BY pn.created_at DESC`)
    .all(todoId) as ProgressNote[]
}

export function getProgressNote(id: string): ProgressNote | undefined {
  return getDb().prepare(`${NOTE_SELECT} WHERE pn.id = ?`).get(id) as ProgressNote | undefined
}

export function createProgressNote(todoId: string, userId: string, body: string): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('進捗メモの内容を入力してください')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO ProgressNotes (id, todo_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, todoId, userId, trimmed, now)
  return getProgressNote(id) as ProgressNote
}

export function deleteProgressNote(id: string): void {
  getDb().prepare('DELETE FROM ProgressNotes WHERE id = ?').run(id)
}

/**
 * Admin progress report: for each target member, what they added (tasks +
 * subtasks, grouped by assignee), the progress notes they authored, and the
 * time they logged — all within the inclusive [from, to] local-date range.
 */
export function getProgressDigest(from: string, to: string, userIds?: string[]): ProgressDigest {
  const db = getDb()

  let targets: Array<{ id: string; display_name: string; color: string }>
  if (userIds && userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(', ')
    targets = db
      .prepare(
        `SELECT id, display_name, color FROM Users WHERE id IN (${placeholders}) ORDER BY display_name ASC`
      )
      .all(...userIds) as typeof targets
  } else {
    targets = db
      .prepare('SELECT id, display_name, color FROM Users WHERE is_active = 1 ORDER BY display_name ASC')
      .all() as typeof targets
  }

  const addedTodosStmt = db.prepare(
    `SELECT t.id, t.title, t.status, t.progress, t.memo,
            c.name AS category_name, c.color AS category_color, t.created_at
     FROM Todos t
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE t.assignee_id = ? AND date(t.created_at, 'localtime') BETWEEN ? AND ?
     ORDER BY t.created_at ASC`
  )

  const addedSubTasksStmt = db.prepare(
    `SELECT st.id, st.title, st.todo_id, t.title AS todo_title, st.done, st.created_at
     FROM SubTasks st
     JOIN Todos t ON st.todo_id = t.id
     WHERE t.assignee_id = ? AND date(st.created_at, 'localtime') BETWEEN ? AND ?
     ORDER BY st.created_at ASC`
  )

  const notesStmt = db.prepare(
    `SELECT pn.id, pn.todo_id, t.title AS todo_title, pn.body, pn.created_at
     FROM ProgressNotes pn
     JOIN Todos t ON pn.todo_id = t.id
     WHERE pn.user_id = ? AND date(pn.created_at, 'localtime') BETWEEN ? AND ?
     ORDER BY pn.created_at ASC`
  )

  const workStmt = db.prepare(
    `SELECT COALESCE(SUM(duration_seconds), 0) AS seconds, COUNT(*) AS cnt
     FROM WorkLogs
     WHERE user_id = ? AND date(start_time, 'localtime') BETWEEN ? AND ?`
  )

  const users: ProgressDigestUser[] = targets.map((u) => {
    const work = workStmt.get(u.id, from, to) as { seconds: number; cnt: number }
    return {
      user_id: u.id,
      display_name: u.display_name,
      color: u.color,
      added_todos: addedTodosStmt.all(u.id, from, to) as ProgressDigestTodo[],
      added_subtasks: addedSubTasksStmt.all(u.id, from, to) as ProgressDigestSubTask[],
      notes: notesStmt.all(u.id, from, to) as ProgressDigestNote[],
      work_minutes: Math.round(work.seconds / 60),
      work_log_count: work.cnt
    }
  })

  return { from, to, users }
}
