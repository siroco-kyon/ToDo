import crypto from 'crypto'
import Database from 'better-sqlite3'

/**
 * Imports a single-user desktop (Electron) `todo.db` into the multi-user web
 * database, attributing every row to one target web user.
 *
 * The desktop schema is a subset of the web schema, so the mapping is:
 *  - Categories are de-duplicated by name (web has a UNIQUE(name) constraint);
 *    a same-named category is reused, otherwise a fresh one is created.
 *  - Todos keep their original UUIDs and gain assignee_id / created_by = target.
 *  - SubTasks / TodoDependencies copy as-is (their UUIDs do not collide).
 *  - WorkLogs / DailyPlanItems gain the missing user_id = target.
 *  - RunningState (a transient running timer) and Settings are skipped.
 *
 * Re-running is safe: every insert uses INSERT OR IGNORE / unique constraints,
 * so already-imported rows are left untouched.
 */
export interface ImportResult {
  categories: number
  todos: number
  subTasks: number
  dependencies: number
  workLogs: number
  planItems: number
  skippedOrphans: number
  dryRun: boolean
}

export interface ImportOptions {
  webDb: Database.Database
  sourceDbPath: string
  targetUserId: string
  dryRun?: boolean
}

type Row = Record<string, unknown>

const asText = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const asInt = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback
const asNullableText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(name) != null
  )
}

function readAll(db: Database.Database, table: string): Row[] {
  if (!tableExists(db, table)) return []
  return db.prepare(`SELECT * FROM ${table}`).all() as Row[]
}

export function importDesktopDb(options: ImportOptions): ImportResult {
  const { webDb, sourceDbPath, targetUserId, dryRun = false } = options

  const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true })
  if (!tableExists(source, 'Todos')) {
    source.close()
    throw new Error('指定したファイルはデスクトップ版の todo.db ではないようです（Todos テーブルがありません）。')
  }

  const now = new Date().toISOString()
  const result: ImportResult = {
    categories: 0,
    todos: 0,
    subTasks: 0,
    dependencies: 0,
    workLogs: 0,
    planItems: 0,
    skippedOrphans: 0,
    dryRun
  }

  try {
    const srcCategories = readAll(source, 'Categories')
    const srcTodos = readAll(source, 'Todos')
    const srcSubTasks = readAll(source, 'SubTasks')
    const srcDependencies = readAll(source, 'TodoDependencies')
    const srcWorkLogs = readAll(source, 'WorkLogs')
    const srcPlanItems = readAll(source, 'DailyPlanItems')

    const validTodoIds = new Set(srcTodos.map((t) => asText(t.id)))

    const findCategoryByName = webDb.prepare('SELECT id FROM Categories WHERE name = ?')
    const insertCategory = webDb.prepare(
      `INSERT INTO Categories (id, name, color, description, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertTodo = webDb.prepare(
      `INSERT OR IGNORE INTO Todos
        (id, title, description, memo, category_id, assignee_id, created_by, status,
         priority, progress, start_date, due_date, sort_order, recurrence, recurrence_copy_subtasks,
         created_at, updated_at, completed_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertSubTask = webDb.prepare(
      `INSERT OR IGNORE INTO SubTasks
        (id, todo_id, title, description, assignee_id, start_date, due_date, progress, done, completed_at, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertDependency = webDb.prepare(
      `INSERT OR IGNORE INTO TodoDependencies
        (id, predecessor_todo_id, successor_todo_id, type, lag_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertWorkLog = webDb.prepare(
      `INSERT OR IGNORE INTO WorkLogs
        (id, todo_id, user_id, start_time, end_time, duration_seconds, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertPlanItem = webDb.prepare(
      `INSERT OR IGNORE INTO DailyPlanItems
        (id, plan_date, todo_id, user_id, scheduled_start, estimated_minutes, lane, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    webDb.exec('BEGIN')

    // Categories — de-dupe by name, remembering the desktop→web id mapping.
    const categoryMap = new Map<string, string>()
    for (const cat of srcCategories) {
      const srcId = asText(cat.id)
      const name = asText(cat.name)
      if (!name) continue
      const existing = findCategoryByName.get(name) as { id: string } | undefined
      if (existing) {
        categoryMap.set(srcId, existing.id)
        continue
      }
      const newId = crypto.randomUUID()
      insertCategory.run(
        newId,
        name,
        asText(cat.color, '#6366f1'),
        asText(cat.description, ''),
        asInt(cat.sort_order, 0),
        asText(cat.created_at, now)
      )
      categoryMap.set(srcId, newId)
      result.categories += 1
    }

    // Todos
    for (const todo of srcTodos) {
      const srcCategoryId = asNullableText(todo.category_id)
      const mappedCategoryId = srcCategoryId ? categoryMap.get(srcCategoryId) ?? null : null
      const status = asText(todo.status, 'active')
      const updatedAt = asText(todo.updated_at, now)
      const completedAt = asNullableText(todo.completed_at) ?? (status === 'done' ? updatedAt : null)
      const changes = insertTodo.run(
        asText(todo.id),
        asText(todo.title),
        asText(todo.description, ''),
        asText(todo.memo, ''),
        mappedCategoryId,
        targetUserId,
        targetUserId,
        status,
        asInt(todo.priority, 3),
        asInt(todo.progress, 0),
        asNullableText(todo.start_date),
        asNullableText(todo.due_date),
        asInt(todo.sort_order, 0),
        asNullableText(todo.recurrence),
        asInt(todo.recurrence_copy_subtasks, 0),
        asText(todo.created_at, now),
        updatedAt,
        completedAt,
        asNullableText(todo.archived_at)
      ).changes
      result.todos += changes
    }

    // SubTasks
    for (const sub of srcSubTasks) {
      const todoId = asText(sub.todo_id)
      if (!validTodoIds.has(todoId)) {
        result.skippedOrphans += 1
        continue
      }
      result.subTasks += insertSubTask.run(
        asText(sub.id),
        todoId,
        asText(sub.title),
        asText(sub.description, ''),
        targetUserId,
        asNullableText(sub.start_date),
        asNullableText(sub.due_date),
        asInt(sub.progress, asInt(sub.done, 0) ? 100 : 0),
        asInt(sub.done, 0),
        asNullableText(sub.completed_at),
        asInt(sub.sort_order, 0),
        asText(sub.created_at, now)
      ).changes
    }

    // TodoDependencies
    for (const dep of srcDependencies) {
      const predId = asText(dep.predecessor_todo_id)
      const succId = asText(dep.successor_todo_id)
      if (!validTodoIds.has(predId) || !validTodoIds.has(succId)) {
        result.skippedOrphans += 1
        continue
      }
      result.dependencies += insertDependency.run(
        asText(dep.id, crypto.randomUUID()),
        predId,
        succId,
        asText(dep.type, 'finish_to_start'),
        asInt(dep.lag_days, 0),
        asText(dep.created_at, now)
      ).changes
    }

    // WorkLogs — desktop has no user_id, so attribute to the target user.
    for (const log of srcWorkLogs) {
      const todoId = asText(log.todo_id)
      if (!validTodoIds.has(todoId)) {
        result.skippedOrphans += 1
        continue
      }
      result.workLogs += insertWorkLog.run(
        asText(log.id),
        todoId,
        targetUserId,
        asText(log.start_time),
        asText(log.end_time),
        asInt(log.duration_seconds, 0),
        asText(log.note, ''),
        asText(log.created_at, now)
      ).changes
    }

    // DailyPlanItems — desktop has no user_id; attribute to the target user.
    for (const plan of srcPlanItems) {
      const todoId = asText(plan.todo_id)
      if (!validTodoIds.has(todoId)) {
        result.skippedOrphans += 1
        continue
      }
      result.planItems += insertPlanItem.run(
        asText(plan.id),
        asText(plan.plan_date),
        todoId,
        targetUserId,
        asNullableText(plan.scheduled_start),
        plan.estimated_minutes == null ? null : asInt(plan.estimated_minutes, 0),
        asInt(plan.lane, 0),
        asInt(plan.sort_order, 0),
        asText(plan.created_at, now),
        asText(plan.updated_at, now)
      ).changes
    }

    webDb.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (error) {
    try {
      webDb.exec('ROLLBACK')
    } catch {
      // already rolled back
    }
    throw error
  } finally {
    source.close()
  }

  return result
}
