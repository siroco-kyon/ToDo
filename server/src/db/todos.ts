import crypto from 'crypto'
import HolidayJp from '@holiday-jp/holiday_jp'
import { getDb } from './connection'
import {
  addDays,
  clampDependencyLagDays,
  getNormalizedTodoBar,
  getTodoDurationDays,
  normalizeDateKey,
  parseDateKey,
  type TodoBar
} from './helpers'
import type { CreateTodoInput, Todo, TodoCoAssignee, TodoDependency, UpdateTodoInput } from './types'

const TODO_SELECT = `
  SELECT t.*,
         c.name AS category_name, c.color AS category_color,
         u.display_name AS assignee_name, u.color AS assignee_color
  FROM Todos t
  LEFT JOIN Categories c ON t.category_id = c.id
  LEFT JOIN Users u ON t.assignee_id = u.id
`

// サブ担当を todo にぶら下げる。一覧は全件分を一括で引いて JS 側でグループ化する
function attachCoAssignees(todos: Todo[]): Todo[] {
  if (todos.length === 0) return todos
  const rows = getDb()
    .prepare(
      `SELECT ca.todo_id, ca.user_id, u.display_name, u.color
       FROM TodoCoAssignees ca
       JOIN Users u ON ca.user_id = u.id
       ORDER BY u.display_name ASC`
    )
    .all() as Array<TodoCoAssignee & { todo_id: string }>

  const byTodo = new Map<string, TodoCoAssignee[]>()
  for (const { todo_id, ...coAssignee } of rows) {
    const list = byTodo.get(todo_id)
    if (list) list.push(coAssignee)
    else byTodo.set(todo_id, [coAssignee])
  }
  for (const todo of todos) todo.co_assignees = byTodo.get(todo.id) ?? []
  return todos
}

export function getAllTodos(): Todo[] {
  return attachCoAssignees(
    getDb()
      .prepare(`${TODO_SELECT} WHERE t.status != 'archived' OR t.archived_at IS NOT NULL ORDER BY t.created_at DESC`)
      .all() as Todo[]
  )
}

export function getTodoById(id: string): Todo {
  const todo = getDb().prepare(`${TODO_SELECT} WHERE t.id = ?`).get(id) as Todo
  if (todo) {
    todo.co_assignees = getDb()
      .prepare(
        `SELECT ca.user_id, u.display_name, u.color
         FROM TodoCoAssignees ca
         JOIN Users u ON ca.user_id = u.id
         WHERE ca.todo_id = ?
         ORDER BY u.display_name ASC`
      )
      .all(id) as TodoCoAssignee[]
  }
  return todo
}

function replaceCoAssignees(todoId: string, userIds: string[], now: string): void {
  const db = getDb()
  db.prepare('DELETE FROM TodoCoAssignees WHERE todo_id = ?').run(todoId)
  const insert = db.prepare(
    'INSERT OR IGNORE INTO TodoCoAssignees (todo_id, user_id, created_at) VALUES (?, ?, ?)'
  )
  for (const userId of userIds) {
    if (userId) insert.run(todoId, userId, now)
  }
}

function todoChangeSnapshot(todo: Todo): Record<string, string | null> {
  return {
    title: todo.title,
    description: todo.description,
    memo: todo.memo,
    category: todo.category_name,
    assignee: todo.assignee_name,
    status: todo.status,
    priority: String(todo.priority),
    progress: String(todo.progress),
    start_date: todo.start_date,
    due_date: todo.due_date,
    recurrence: todo.recurrence,
    recurrence_copy_subtasks: todo.recurrence_copy_subtasks ? '1' : '0',
    co_assignees: (todo.co_assignees ?? []).map((assignee) => assignee.display_name).sort().join('、')
  }
}

function recordTodoChanges(before: Todo, after: Todo, userId: string | null, createdAt: string): void {
  const beforeValues = todoChangeSnapshot(before)
  const afterValues = todoChangeSnapshot(after)
  const insert = getDb().prepare(
    'INSERT INTO TodoChangeLogs (id, todo_id, user_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const field of Object.keys(afterValues)) {
    if (beforeValues[field] === afterValues[field]) continue
    insert.run(crypto.randomUUID(), after.id, userId, field, beforeValues[field], afterValues[field], createdAt)
  }
}

function applyTodoUpdate(id: string, data: UpdateTodoInput, updatedAt: string): void {
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [updatedAt]

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title) }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
  if (data.memo !== undefined) { fields.push('memo = ?'); values.push(data.memo) }
  if (data.category_id !== undefined) { fields.push('category_id = ?'); values.push(data.category_id) }
  if (data.assignee_id !== undefined) { fields.push('assignee_id = ?'); values.push(data.assignee_id) }
  if (data.status !== undefined) {
    fields.push('status = ?')
    values.push(data.status)
    if (data.status === 'done') {
      fields.push('completed_at = COALESCE(completed_at, ?)')
      values.push(updatedAt)
    } else {
      fields.push('completed_at = NULL')
    }
  }
  if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority) }
  if (data.progress !== undefined) {
    fields.push('progress = ?'); values.push(data.progress)
    // 進捗100%で自動完了（status を明示指定していない時のみ）。
    // updateTodo 側が done 遷移を検知して繰り返し次回分も生成する。
    if (data.status === undefined && data.progress >= 100) {
      fields.push('status = ?'); values.push('done')
      fields.push('completed_at = COALESCE(completed_at, ?)'); values.push(updatedAt)
    }
  }
  if (data.start_date !== undefined) { fields.push('start_date = ?'); values.push(normalizeDateKey(data.start_date)) }
  if (data.due_date !== undefined) { fields.push('due_date = ?'); values.push(normalizeDateKey(data.due_date)) }
  if (data.recurrence !== undefined) { fields.push('recurrence = ?'); values.push(data.recurrence) }
  if (data.recurrence_copy_subtasks !== undefined) { fields.push('recurrence_copy_subtasks = ?'); values.push(data.recurrence_copy_subtasks ? 1 : 0) }
  if (data.recurrence_skip_weekends !== undefined) { fields.push('recurrence_skip_weekends = ?'); values.push(data.recurrence_skip_weekends ? 1 : 0) }
  if (data.recurrence_skip_holidays !== undefined) { fields.push('recurrence_skip_holidays = ?'); values.push(data.recurrence_skip_holidays ? 1 : 0) }

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
  const status = data.status ?? 'not_started'
  const startDate = normalizeDateKey(data.start_date)
  const dueDate = normalizeDateKey(data.due_date)
  const minOrder = (db.prepare('SELECT COALESCE(MIN(sort_order), 0) AS m FROM Todos').get() as { m: number }).m
  db.prepare(
    `INSERT INTO Todos (id, title, description, memo, category_id, assignee_id, created_by, status, priority, progress, start_date, due_date, sort_order, recurrence, recurrence_copy_subtasks, recurrence_skip_weekends, recurrence_skip_holidays, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.title,
    data.description ?? '',
    data.memo ?? '',
    data.category_id ?? null,
    data.assignee_id ?? null,
    createdByUserId,
    status,
    data.priority ?? 3,
    data.progress ?? 0,
    startDate,
    dueDate,
    minOrder - 1,
    data.recurrence ?? null,
    data.recurrence_copy_subtasks ? 1 : 0,
    data.recurrence_skip_weekends ? 1 : 0,
    data.recurrence_skip_holidays ? 1 : 0,
    now,
    now,
    status === 'done' ? now : null
  )
  return getTodoById(id)
}

export function reorderTodos(orderedIds: string[]): void {
  const db = getDb()
  const upd = db.prepare('UPDATE Todos SET sort_order = ? WHERE id = ?')
  db.transaction(() => { orderedIds.forEach((id, i) => upd.run(i, id)) })()
}

// ─── Recurrence ───────────────────────────────────────────────

function shiftRecurrenceDate(value: string | null, recurrence: 'daily' | 'weekly' | 'monthly'): string | null {
  const dateKey = normalizeDateKey(value)
  if (!dateKey) return null
  if (recurrence === 'daily') return addDays(dateKey, 1)
  if (recurrence === 'weekly') return addDays(dateKey, 7)

  // monthly は月末を丸める（1/31 の次を 3/3 にしない）
  const date = parseDateKey(dateKey)
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() + 1)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(day, lastDay))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 土日・祝日をスキップする設定に応じて、候補日が有効な日になるまで1日ずつ進める
function applySkipRules(
  dateKey: string | null,
  skipWeekends: boolean,
  skipHolidays: boolean
): string | null {
  if (!dateKey) return null
  if (!skipWeekends && !skipHolidays) return dateKey

  let result = dateKey
  while (true) {
    const day = parseDateKey(result).getDay()
    const isWeekend = day === 0 || day === 6
    const isHoliday = skipHolidays && HolidayJp.isHoliday(parseDateKey(result))
    if (!(skipWeekends && isWeekend) && !isHoliday) break
    result = addDays(result, 1)
  }
  return result
}

// 完了した繰り返しタスクの次回分を作成する。recurrence_copy_subtasks が
// 立っていればサブタスクも未完了状態・日付シフトつきで複製する。
function spawnNextRecurrence(source: Todo): void {
  const recurrence = source.recurrence
  if (!recurrence) return

  const skipWeekends = !!source.recurrence_skip_weekends
  const skipHolidays = !!source.recurrence_skip_holidays
  const shiftAndSkip = (value: string | null): string | null =>
    applySkipRules(shiftRecurrenceDate(value, recurrence), skipWeekends, skipHolidays)

  const next = createTodo(
    {
      title: source.title,
      description: source.description,
      memo: source.memo,
      category_id: source.category_id,
      assignee_id: source.assignee_id,
      priority: source.priority,
      start_date: shiftAndSkip(source.start_date),
      due_date: shiftAndSkip(source.due_date),
      recurrence,
      recurrence_copy_subtasks: source.recurrence_copy_subtasks,
      recurrence_skip_weekends: source.recurrence_skip_weekends,
      recurrence_skip_holidays: source.recurrence_skip_holidays
    },
    source.created_by
  )

  // サブ担当も次回分へ引き継ぐ
  const coAssignees = source.co_assignees ?? []
  if (coAssignees.length > 0) {
    replaceCoAssignees(next.id, coAssignees.map((c) => c.user_id), new Date().toISOString())
  }

  if (source.recurrence_copy_subtasks) {
    const db = getDb()
    const now = new Date().toISOString()
    const insert = db.prepare(
      'INSERT INTO SubTasks (id, todo_id, title, description, assignee_id, start_date, due_date, progress, done, completed_at, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)'
    )
    const subTasks = db
      .prepare('SELECT * FROM SubTasks WHERE todo_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(source.id) as Array<{ title: string; description: string | null; assignee_id: string | null; start_date: string | null; due_date: string | null; sort_order: number }>
    for (const sub of subTasks) {
      insert.run(
        crypto.randomUUID(),
        next.id,
        sub.title,
        sub.description ?? '',
        sub.assignee_id,
        shiftAndSkip(sub.start_date),
        shiftAndSkip(sub.due_date),
        sub.sort_order,
        now
      )
    }
  }
}

export function updateTodo(id: string, data: UpdateTodoInput, changedByUserId: string | null = null): Todo {
  const db = getDb()
  const now = new Date().toISOString()
  const before = getTodoById(id)
  db.transaction(() => {
    applyTodoUpdate(id, data, now)
    if (data.co_assignee_ids !== undefined) {
      replaceCoAssignees(id, data.co_assignee_ids, now)
    }
    resolveDependencyCascade(id, now)
    const updated = getTodoById(id)
    recordTodoChanges(before, updated, changedByUserId, now)
    if (before.status !== 'done' && updated.status === 'done' && updated.recurrence) {
      spawnNextRecurrence(updated)
    }
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

export function archiveTodo(id: string, changedByUserId: string | null = null): void {
  const db = getDb()
  const now = new Date().toISOString()
  const before = getTodoById(id)
  db.transaction(() => {
    db.prepare("UPDATE Todos SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
    recordTodoChanges(before, getTodoById(id), changedByUserId, now)
  })()
}

export function unarchiveTodo(id: string, changedByUserId: string | null = null): void {
  const db = getDb()
  const now = new Date().toISOString()
  const before = getTodoById(id)
  db.transaction(() => {
    db.prepare("UPDATE Todos SET status = 'active', archived_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?").run(now, id)
    recordTodoChanges(before, getTodoById(id), changedByUserId, now)
  })()
}

export function deleteTodo(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM TodoDependencies WHERE predecessor_todo_id = ? OR successor_todo_id = ?').run(id, id)
  db.prepare('DELETE FROM WorkLogs WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM RunningState WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM SubTasks WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM TodoCoAssignees WHERE todo_id = ?').run(id)
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
