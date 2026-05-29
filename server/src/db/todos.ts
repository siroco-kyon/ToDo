import crypto from 'crypto'
import { getDb } from './connection'
import {
  addDays,
  clampDependencyLagDays,
  getNormalizedTodoBar,
  getTodoDurationDays,
  normalizeDateKey,
  type TodoBar
} from './helpers'
import type { CreateTodoInput, Todo, TodoDependency, UpdateTodoInput } from './types'

const TODO_SELECT = `
  SELECT t.*,
         c.name AS category_name, c.color AS category_color,
         u.display_name AS assignee_name, u.color AS assignee_color
  FROM Todos t
  LEFT JOIN Categories c ON t.category_id = c.id
  LEFT JOIN Users u ON t.assignee_id = u.id
`

export function getAllTodos(): Todo[] {
  return getDb()
    .prepare(`${TODO_SELECT} WHERE t.status != 'archived' OR t.archived_at IS NOT NULL ORDER BY t.created_at DESC`)
    .all() as Todo[]
}

export function getTodoById(id: string): Todo {
  return getDb().prepare(`${TODO_SELECT} WHERE t.id = ?`).get(id) as Todo
}

function applyTodoUpdate(id: string, data: UpdateTodoInput, updatedAt: string): void {
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [updatedAt]

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title) }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
  if (data.memo !== undefined) { fields.push('memo = ?'); values.push(data.memo) }
  if (data.category_id !== undefined) { fields.push('category_id = ?'); values.push(data.category_id) }
  if (data.assignee_id !== undefined) { fields.push('assignee_id = ?'); values.push(data.assignee_id) }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status) }
  if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority) }
  if (data.progress !== undefined) { fields.push('progress = ?'); values.push(data.progress) }
  if (data.start_date !== undefined) { fields.push('start_date = ?'); values.push(normalizeDateKey(data.start_date)) }
  if (data.due_date !== undefined) { fields.push('due_date = ?'); values.push(normalizeDateKey(data.due_date)) }
  if (data.recurrence !== undefined) { fields.push('recurrence = ?'); values.push(data.recurrence) }

  values.push(id)
  getDb().prepare(`UPDATE Todos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

function shiftTodoToStart(todoId: string, nextStartDate: string, updatedAt: string): TodoBar {
  const current = getTodoById(todoId)
  const currentBar = getNormalizedTodoBar(current)

  if (!currentBar) {
    applyTodoUpdate(todoId, { start_date: nextStartDate, due_date: nextStartDate }, updatedAt)
    return { startDate: nextStartDate, endDate: nextStartDate }
  }

  if (currentBar.startDate === nextStartDate) return currentBar

  const durationDays = getTodoDurationDays(current)
  const nextEndDate = addDays(nextStartDate, durationDays)
  applyTodoUpdate(todoId, { start_date: nextStartDate, due_date: nextEndDate }, updatedAt)
  return { startDate: nextStartDate, endDate: nextEndDate }
}

function enforcePredecessorConstraints(todoId: string, updatedAt: string): TodoBar | null {
  const predecessorRows = getDb()
    .prepare('SELECT predecessor_todo_id, lag_days FROM TodoDependencies WHERE successor_todo_id = ? ORDER BY created_at ASC')
    .all(todoId) as Array<{ predecessor_todo_id: string; lag_days: number }>

  if (predecessorRows.length === 0) {
    return getNormalizedTodoBar(getTodoById(todoId))
  }

  let requiredStart: string | null = null
  for (const row of predecessorRows) {
    const predecessorBar = getNormalizedTodoBar(getTodoById(row.predecessor_todo_id))
    if (!predecessorBar) continue
    const candidate = addDays(predecessorBar.endDate, 1 + clampDependencyLagDays(row.lag_days))
    if (!requiredStart || candidate > requiredStart) requiredStart = candidate
  }

  if (!requiredStart) return getNormalizedTodoBar(getTodoById(todoId))
  return shiftTodoToStart(todoId, requiredStart, updatedAt)
}

function resolveDependencyCascade(todoId: string, updatedAt: string, visited = new Set<string>()): void {
  if (visited.has(todoId)) return
  visited.add(todoId)

  enforcePredecessorConstraints(todoId, updatedAt)

  const successors = getDb()
    .prepare('SELECT successor_todo_id FROM TodoDependencies WHERE predecessor_todo_id = ? ORDER BY created_at ASC')
    .all(todoId) as Array<{ successor_todo_id: string }>

  for (const row of successors) {
    resolveDependencyCascade(row.successor_todo_id, updatedAt, visited)
  }
}

function dependencyCreatesCycle(predecessorTodoId: string, successorTodoId: string): boolean {
  const queue = [successorTodoId]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === predecessorTodoId) return true
    if (visited.has(current)) continue
    visited.add(current)

    const nextRows = getDb()
      .prepare('SELECT successor_todo_id FROM TodoDependencies WHERE predecessor_todo_id = ?')
      .all(current) as Array<{ successor_todo_id: string }>
    for (const row of nextRows) queue.push(row.successor_todo_id)
  }

  return false
}

export function createTodo(data: CreateTodoInput, createdByUserId: string | null = null): Todo {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const startDate = normalizeDateKey(data.start_date)
  const dueDate = normalizeDateKey(data.due_date)
  const minOrder = (db.prepare('SELECT COALESCE(MIN(sort_order), 0) AS m FROM Todos').get() as { m: number }).m
  db.prepare(
    `INSERT INTO Todos (id, title, description, memo, category_id, assignee_id, created_by, status, priority, progress, start_date, due_date, sort_order, recurrence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.title,
    data.description ?? '',
    data.memo ?? '',
    data.category_id ?? null,
    data.assignee_id ?? null,
    createdByUserId,
    data.priority ?? 3,
    data.progress ?? 0,
    startDate,
    dueDate,
    minOrder - 1,
    data.recurrence ?? null,
    now,
    now
  )
  return getTodoById(id)
}

export function reorderTodos(orderedIds: string[]): void {
  const db = getDb()
  const upd = db.prepare('UPDATE Todos SET sort_order = ? WHERE id = ?')
  db.transaction(() => { orderedIds.forEach((id, i) => upd.run(i, id)) })()
}

export function updateTodo(id: string, data: UpdateTodoInput): Todo {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    applyTodoUpdate(id, data, now)
    resolveDependencyCascade(id, now)
  })()
  return getTodoById(id)
}

export function syncTodoDueDateWithSubTask(todoId: string, subTaskDueDate: string | null): void {
  const normalizedSubTaskDueDate = normalizeDateKey(subTaskDueDate)
  if (!normalizedSubTaskDueDate) return

  const todo = getTodoById(todoId)
  const normalizedTodoDueDate = normalizeDateKey(todo.due_date)
  if (normalizedTodoDueDate && normalizedTodoDueDate >= normalizedSubTaskDueDate) return

  updateTodo(todoId, { due_date: normalizedSubTaskDueDate })
}

export function archiveTodo(id: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare("UPDATE Todos SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id)
}

export function unarchiveTodo(id: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare("UPDATE Todos SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?")
    .run(now, id)
}

export function deleteTodo(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM TodoDependencies WHERE predecessor_todo_id = ? OR successor_todo_id = ?').run(id, id)
  db.prepare('DELETE FROM WorkLogs WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM RunningState WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM SubTasks WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM Todos WHERE id = ?').run(id)
}

// ─── Dependencies ─────────────────────────────────────────────

export function getAllTodoDependencies(): TodoDependency[] {
  return getDb()
    .prepare('SELECT * FROM TodoDependencies ORDER BY created_at ASC')
    .all() as TodoDependency[]
}

export function createTodoDependency(predecessorTodoId: string, successorTodoId: string, lagDays = 0): TodoDependency {
  const db = getDb()
  if (predecessorTodoId === successorTodoId) {
    throw new Error('同じタスク同士は依存関係にできません')
  }

  const predecessorExists = db.prepare('SELECT 1 FROM Todos WHERE id = ?').get(predecessorTodoId)
  const successorExists = db.prepare('SELECT 1 FROM Todos WHERE id = ?').get(successorTodoId)
  if (!predecessorExists || !successorExists) {
    throw new Error('依存関係の対象タスクが見つかりません')
  }

  const existing = db
    .prepare('SELECT id FROM TodoDependencies WHERE predecessor_todo_id = ? AND successor_todo_id = ?')
    .get(predecessorTodoId, successorTodoId) as { id: string } | undefined
  if (existing) {
    throw new Error('その依存関係はすでに存在します')
  }

  if (dependencyCreatesCycle(predecessorTodoId, successorTodoId)) {
    throw new Error('循環する依存関係は作成できません')
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const normalizedLagDays = clampDependencyLagDays(lagDays)

  db.transaction(() => {
    db.prepare(
      `INSERT INTO TodoDependencies (id, predecessor_todo_id, successor_todo_id, type, lag_days, created_at)
       VALUES (?, ?, ?, 'finish_to_start', ?, ?)`
    ).run(id, predecessorTodoId, successorTodoId, normalizedLagDays, now)
    resolveDependencyCascade(successorTodoId, now)
  })()

  return db.prepare('SELECT * FROM TodoDependencies WHERE id = ?').get(id) as TodoDependency
}

export function updateTodoDependency(id: string, lagDays: number): TodoDependency {
  const db = getDb()
  const current = db.prepare('SELECT * FROM TodoDependencies WHERE id = ?').get(id) as TodoDependency | undefined
  if (!current) {
    throw new Error('依存関係が見つかりません')
  }

  const now = new Date().toISOString()
  const normalizedLagDays = clampDependencyLagDays(lagDays)
  db.transaction(() => {
    db.prepare('UPDATE TodoDependencies SET lag_days = ? WHERE id = ?').run(normalizedLagDays, id)
    resolveDependencyCascade(current.successor_todo_id, now)
  })()

  return db.prepare('SELECT * FROM TodoDependencies WHERE id = ?').get(id) as TodoDependency
}

export function deleteTodoDependency(id: string): void {
  const db = getDb()
  const current = db.prepare('SELECT * FROM TodoDependencies WHERE id = ?').get(id) as TodoDependency | undefined
  if (!current) return

  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('DELETE FROM TodoDependencies WHERE id = ?').run(id)
    resolveDependencyCascade(current.successor_todo_id, now)
  })()
}
