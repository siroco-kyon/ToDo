import crypto from 'crypto'
import { getDb } from './connection'
import { normalizeDateKey } from './helpers'
import { syncTodoDueDateWithSubTask } from './todos'
import type { CalendarSubTask, CreateSubTaskInput, SubTask, UpdateSubTaskInput } from './types'

export function getSubTasksByTodo(todoId: string): SubTask[] {
  return getDb()
    .prepare('SELECT * FROM SubTasks WHERE todo_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(todoId) as SubTask[]
}

export function getAllSubTasks(): SubTask[] {
  return getDb()
    .prepare('SELECT * FROM SubTasks ORDER BY todo_id ASC, sort_order ASC, created_at ASC')
    .all() as SubTask[]
}

export function getSubTasksForCalendar(): CalendarSubTask[] {
  return getDb()
    .prepare(
      `SELECT st.*, t.title AS todo_title, t.status AS todo_status, c.color AS category_color
       FROM SubTasks st
       JOIN Todos t ON st.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE st.due_date IS NOT NULL AND t.status != 'archived'
       ORDER BY st.due_date ASC, st.sort_order ASC, st.created_at ASC`
    )
    .all() as CalendarSubTask[]
}

export function createSubTask(todoId: string, data: CreateSubTaskInput): SubTask {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM SubTasks WHERE todo_id = ?').get(todoId) as { m: number }).m
  const startDate = normalizeDateKey(data.start_date)
  const dueDate = normalizeDateKey(data.due_date)
  db.prepare(
    'INSERT INTO SubTasks (id, todo_id, title, description, start_date, due_date, done, completed_at, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)'
  ).run(id, todoId, data.title, data.description ?? '', startDate, dueDate, maxOrder + 1, now)
  const created = db.prepare('SELECT * FROM SubTasks WHERE id = ?').get(id) as SubTask
  syncTodoDueDateWithSubTask(todoId, created.due_date)
  return created
}

export function updateSubTask(id: string, data: UpdateSubTaskInput): SubTask {
  const db = getDb()
  const current = db.prepare('SELECT done FROM SubTasks WHERE id = ?').get(id) as { done: number } | undefined

  if (data.title !== undefined) {
    db.prepare('UPDATE SubTasks SET title = ? WHERE id = ?').run(data.title, id)
  }
  if (data.description !== undefined) {
    db.prepare('UPDATE SubTasks SET description = ? WHERE id = ?').run(data.description, id)
  }
  if (data.start_date !== undefined) {
    db.prepare('UPDATE SubTasks SET start_date = ? WHERE id = ?').run(normalizeDateKey(data.start_date), id)
  }
  if (data.due_date !== undefined) {
    db.prepare('UPDATE SubTasks SET due_date = ? WHERE id = ?').run(normalizeDateKey(data.due_date), id)
  }
  if (data.done !== undefined && current) {
    if (data.done && current.done === 0) {
      db.prepare('UPDATE SubTasks SET done = 1, completed_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    } else if (!data.done && current.done === 1) {
      db.prepare('UPDATE SubTasks SET done = 0, completed_at = NULL WHERE id = ?').run(id)
    }
  }
  const updated = db.prepare('SELECT * FROM SubTasks WHERE id = ?').get(id) as SubTask
  syncTodoDueDateWithSubTask(updated.todo_id, updated.due_date)
  return updated
}

export function deleteSubTask(id: string): void {
  getDb().prepare('DELETE FROM SubTasks WHERE id = ?').run(id)
}
