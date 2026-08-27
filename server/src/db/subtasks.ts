import crypto from 'crypto'
import { getDb } from './connection'
import { clampProgress, normalizeDateKey } from './helpers'
import { syncTodoDueDateWithSubTasks } from './todos'
import type { CalendarSubTask, CreateSubTaskInput, SubTask, UpdateSubTaskInput } from './types'

const SUBTASK_SELECT = `
  SELECT st.*,
         u.display_name AS assignee_name,
         u.color AS assignee_color
  FROM SubTasks st
  LEFT JOIN Users u ON st.assignee_id = u.id
`

export function getSubTasksByTodo(todoId: string): SubTask[] {
  return getDb()
    .prepare(`${SUBTASK_SELECT} WHERE st.todo_id = ? ORDER BY st.sort_order ASC, st.created_at ASC`)
    .all(todoId) as SubTask[]
}

export function getAllSubTasks(): SubTask[] {
  return getDb()
    .prepare(`${SUBTASK_SELECT} ORDER BY st.todo_id ASC, st.sort_order ASC, st.created_at ASC`)
    .all() as SubTask[]
}

export function getSubTasksForCalendar(): CalendarSubTask[] {
  return getDb()
    .prepare(
      `SELECT st.*,
              u.display_name AS assignee_name,
              u.color AS assignee_color,
              t.title AS todo_title,
              t.status AS todo_status,
              c.color AS category_color
       FROM SubTasks st
       JOIN Todos t ON st.todo_id = t.id
       LEFT JOIN Users u ON st.assignee_id = u.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE st.due_date IS NOT NULL AND t.status != 'archived'
       ORDER BY st.due_date ASC, st.sort_order ASC, st.created_at ASC`
    )
    .all() as CalendarSubTask[]
}

export function reorderSubTasks(todoId: string, orderedIds: string[]): void {
  const db = getDb()
  const currentIds = (db.prepare(
    'SELECT id FROM SubTasks WHERE todo_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(todoId) as Array<{ id: string }>).map((row) => row.id)
  const uniqueIds = new Set(orderedIds)

  if (
    orderedIds.length !== currentIds.length
    || uniqueIds.size !== orderedIds.length
    || currentIds.some((id) => !uniqueIds.has(id))
  ) {
    throw new Error('サブタスクの並び順が最新ではありません。再読み込みしてからやり直してください')
  }

  const update = db.prepare('UPDATE SubTasks SET sort_order = ? WHERE id = ? AND todo_id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, id, todoId))
  })()
}

export function createSubTask(todoId: string, data: CreateSubTaskInput): SubTask {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM SubTasks WHERE todo_id = ?').get(todoId) as { m: number }).m
  const startDate = normalizeDateKey(data.start_date)
  const dueDate = normalizeDateKey(data.due_date)
  const progress = clampProgress(data.progress)
  const done = progress >= 100 ? 1 : 0
  db.prepare(
    'INSERT INTO SubTasks (id, todo_id, title, description, assignee_id, start_date, due_date, progress, done, completed_at, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, todoId, data.title, data.description ?? '', data.assignee_id ?? null, startDate, dueDate, progress, done, done ? now : null, maxOrder + 1, now)
  const created = db.prepare(`${SUBTASK_SELECT} WHERE st.id = ?`).get(id) as SubTask
  const extendedTo = syncTodoDueDateWithSubTasks(todoId)
  return { ...created, parent_due_date_extended_to: extendedTo }
}

export function updateSubTask(id: string, data: UpdateSubTaskInput): SubTask {
  const db = getDb()
  const current = db.prepare('SELECT done, progress, completed_at FROM SubTasks WHERE id = ?').get(id) as { done: number; progress: number; completed_at: string | null } | undefined

  if (data.title !== undefined) {
    db.prepare('UPDATE SubTasks SET title = ? WHERE id = ?').run(data.title, id)
  }
  if (data.description !== undefined) {
    db.prepare('UPDATE SubTasks SET description = ? WHERE id = ?').run(data.description, id)
  }
  if (data.assignee_id !== undefined) {
    db.prepare('UPDATE SubTasks SET assignee_id = ? WHERE id = ?').run(data.assignee_id, id)
  }
  if (data.start_date !== undefined) {
    db.prepare('UPDATE SubTasks SET start_date = ? WHERE id = ?').run(normalizeDateKey(data.start_date), id)
  }
  if (data.due_date !== undefined) {
    db.prepare('UPDATE SubTasks SET due_date = ? WHERE id = ?').run(normalizeDateKey(data.due_date), id)
  }
  if ((data.done !== undefined || data.progress !== undefined) && current) {
    const progressFromInput = data.progress !== undefined
      ? clampProgress(Number(data.progress))
      : current.progress
    const nextProgress = data.done !== undefined
      ? data.done ? 100 : Math.min(progressFromInput, 99)
      : progressFromInput
    const nextDone = data.done !== undefined
      ? data.done
      : nextProgress >= 100
    const nextCompletedAt = nextDone
      ? current.done ? current.completed_at ?? new Date().toISOString() : new Date().toISOString()
      : null
    db.prepare('UPDATE SubTasks SET progress = ?, done = ?, completed_at = ? WHERE id = ?').run(nextProgress, nextDone ? 1 : 0, nextCompletedAt, id)
  }
  const updated = db.prepare(`${SUBTASK_SELECT} WHERE st.id = ?`).get(id) as SubTask
  const extendedTo = syncTodoDueDateWithSubTasks(updated.todo_id)
  return { ...updated, parent_due_date_extended_to: extendedTo }
}

export function deleteSubTask(id: string): void {
  getDb().prepare('DELETE FROM SubTasks WHERE id = ?').run(id)
}
