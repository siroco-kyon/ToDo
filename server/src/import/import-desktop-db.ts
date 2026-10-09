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
 *  - Progress notes, replies, reactions and change history keep their UUIDs;
 *    all desktop authors / reaction actors become the target web user.
 *  - New categories keep their private flag. Existing same-named categories
 *    keep the server setting, with differing flags reported as conflicts.
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
  progressNotes: number
  progressComments: number
  progressReactions: number
  todoChanges: number
  subTaskChanges: number
  categoryConflicts: string[]
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
const asStoredText = (v: unknown): string | null => (typeof v === 'string' ? v : null)

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
  const target = webDb.prepare('SELECT deleted_at FROM Users WHERE id = ?').get(targetUserId) as { deleted_at: string | null } | undefined
  if (!target || target.deleted_at) throw new Error('取り込み先のユーザーが見つからないか、削除されています。別のメンバーを選択してください')

  const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true })

  const now = new Date().toISOString()
  const result: ImportResult = {
    categories: 0,
    todos: 0,
    subTasks: 0,
    dependencies: 0,
    workLogs: 0,
    planItems: 0,
    progressNotes: 0,
    progressComments: 0,
    progressReactions: 0,
    todoChanges: 0,
    subTaskChanges: 0,
    categoryConflicts: [],
    skippedOrphans: 0,
    dryRun
  }

  try {
    if (!tableExists(source, 'Todos')) {
      throw new Error('指定したファイルはデスクトップ版の todo.db ではないようです（Todos テーブルがありません）。')
    }
    const srcCategories = readAll(source, 'Categories')
    const srcTodos = readAll(source, 'Todos')
    const srcSubTasks = readAll(source, 'SubTasks')
    const srcDependencies = readAll(source, 'TodoDependencies')
    const srcWorkLogs = readAll(source, 'WorkLogs')
    const srcPlanItems = readAll(source, 'DailyPlanItems')
    const srcProgressNotes = readAll(source, 'ProgressNotes')
    const srcProgressComments = readAll(source, 'ProgressNoteComments')
    const srcNoteReactions = readAll(source, 'ProgressNoteReactions')
    const srcCommentReactions = readAll(source, 'ProgressCommentReactions')
    const srcTodoChanges = readAll(source, 'TodoChangeLogs')
    const srcSubTaskChanges = readAll(source, 'SubTaskChangeLogs')

    const validTodoIds = new Set(srcTodos.map((t) => asText(t.id)))

    const findCategoryByName = webDb.prepare('SELECT id, is_private FROM Categories WHERE name = ?')
    const insertCategory = webDb.prepare(
      `INSERT INTO Categories (id, name, color, description, sort_order, is_private, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const insertTodo = webDb.prepare(
      `INSERT OR IGNORE INTO Todos
        (id, title, description, memo, category_id, assignee_id, created_by, status,
         priority, progress, start_date, due_date, sort_order, recurrence, recurrence_copy_subtasks,
         recurrence_skip_weekends, recurrence_skip_holidays,
         created_at, updated_at, completed_at, archived_at, on_hold_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    const insertNote = webDb.prepare(
      `INSERT OR IGNORE INTO ProgressNotes (id, todo_id, user_id, body, needs_discussion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const findNote = webDb.prepare('SELECT todo_id FROM ProgressNotes WHERE id = ?')
    const insertComment = webDb.prepare(
      `INSERT OR IGNORE INTO ProgressNoteComments (id, note_id, parent_comment_id, user_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const findComment = webDb.prepare('SELECT note_id FROM ProgressNoteComments WHERE id = ?')
    const insertNoteReaction = webDb.prepare(
      `INSERT OR IGNORE INTO ProgressNoteReactions (id, note_id, user_id, actor_key, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertCommentReaction = webDb.prepare(
      `INSERT OR IGNORE INTO ProgressCommentReactions (id, comment_id, user_id, actor_key, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertTodoChange = webDb.prepare(
      `INSERT OR IGNORE INTO TodoChangeLogs (id, todo_id, user_id, field, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const insertSubTaskChange = webDb.prepare(
      `INSERT OR IGNORE INTO SubTaskChangeLogs (id, subtask_id, todo_id, user_id, field, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const findSubTask = webDb.prepare('SELECT todo_id FROM SubTasks WHERE id = ?')

    webDb.exec('BEGIN')

    // Categories — de-dupe by name, remembering the desktop→web id mapping.
    const categoryMap = new Map<string, string>()
    for (const cat of srcCategories) {
      const srcId = asText(cat.id)
      const name = asText(cat.name)
      if (!name) continue
      const isPrivate = asInt(cat.is_private, 0) === 1 ? 1 : 0
      const existing = findCategoryByName.get(name) as { id: string; is_private: number } | undefined
      if (existing) {
        categoryMap.set(srcId, existing.id)
        if (existing.is_private !== isPrivate && !result.categoryConflicts.includes(name)) result.categoryConflicts.push(name)
        continue
      }
      const newId = crypto.randomUUID()
      insertCategory.run(
        newId,
        name,
        asText(cat.color, '#6366f1'),
        asText(cat.description, ''),
        asInt(cat.sort_order, 0),
        isPrivate,
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
        asInt(todo.recurrence_skip_weekends, 0),
        asInt(todo.recurrence_skip_holidays, 0),
        asText(todo.created_at, now),
        updatedAt,
        completedAt,
        asNullableText(todo.archived_at),
        asNullableText(todo.on_hold_since)
      ).changes
      result.todos += changes
    }

    // SubTasks
    const validSubTaskIds = new Set<string>()
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
      const stored = findSubTask.get(asText(sub.id)) as { todo_id: string } | undefined
      if (stored?.todo_id === todoId) validSubTaskIds.add(asText(sub.id))
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

    // Progress notes — older desktop databases may not have these optional tables.
    const validNoteIds = new Set<string>()
    for (const note of srcProgressNotes) {
      const todoId = asText(note.todo_id)
      const noteId = asText(note.id)
      if (!validTodoIds.has(todoId)) {
        result.skippedOrphans += 1
        continue
      }
      const createdAt = asNullableText(note.created_at) ?? now
      result.progressNotes += insertNote.run(
        noteId, todoId, targetUserId, asText(note.body), asInt(note.needs_discussion, 0) === 1 ? 1 : 0,
        createdAt, asNullableText(note.updated_at) ?? createdAt
      ).changes
      const stored = findNote.get(noteId) as { todo_id: string } | undefined
      if (stored?.todo_id === todoId) validNoteIds.add(noteId)
      else result.skippedOrphans += 1
    }

    // Insert parents before replies without depending on SQLite's source row order.
    // Missing parents, cross-note links and cycles are skipped with their descendants.
    const pendingComments = new Map<string, Row>()
    for (const comment of srcProgressComments) {
      if (!validNoteIds.has(asText(comment.note_id))) result.skippedOrphans += 1
      else pendingComments.set(asText(comment.id), comment)
    }
    const commentChildren = new Map<string, string[]>()
    const commentQueue: string[] = []
    for (const [id, comment] of pendingComments) {
      const parentId = asNullableText(comment.parent_comment_id)
      if (!parentId) commentQueue.push(id)
      else {
        const parent = pendingComments.get(parentId)
        if (parent && parent.note_id === comment.note_id) {
          const children = commentChildren.get(parentId) ?? []
          children.push(id)
          commentChildren.set(parentId, children)
        }
      }
    }
    const validCommentIds = new Set<string>()
    for (let index = 0; index < commentQueue.length; index += 1) {
      const id = commentQueue[index]
      const comment = pendingComments.get(id)!
      const noteId = asText(comment.note_id)
      const parentId = asNullableText(comment.parent_comment_id)
      const createdAt = asNullableText(comment.created_at) ?? now
      result.progressComments += insertComment.run(
        id, noteId, parentId, targetUserId, asText(comment.body), createdAt,
        asNullableText(comment.updated_at) ?? createdAt
      ).changes
      const stored = findComment.get(id) as { note_id: string } | undefined
      if (stored?.note_id !== noteId) continue
      validCommentIds.add(id)
      for (const childId of commentChildren.get(id) ?? []) commentQueue.push(childId)
    }
    result.skippedOrphans += pendingComments.size - validCommentIds.size

    // Server reactions use the user's ID as actor_key; desktop uses "desktop".
    for (const reaction of srcNoteReactions) {
      const noteId = asText(reaction.note_id)
      if (!validNoteIds.has(noteId)) {
        result.skippedOrphans += 1
        continue
      }
      result.progressReactions += insertNoteReaction.run(
        asText(reaction.id), noteId, targetUserId, targetUserId, asText(reaction.emoji), asNullableText(reaction.created_at) ?? now
      ).changes
    }
    for (const reaction of srcCommentReactions) {
      const commentId = asText(reaction.comment_id)
      if (!validCommentIds.has(commentId)) {
        result.skippedOrphans += 1
        continue
      }
      result.progressReactions += insertCommentReaction.run(
        asText(reaction.id), commentId, targetUserId, targetUserId, asText(reaction.emoji), asNullableText(reaction.created_at) ?? now
      ).changes
    }

    // Preserve the date-stamped changes used by period progress reports.
    for (const change of srcTodoChanges) {
      const todoId = asText(change.todo_id)
      if (!validTodoIds.has(todoId)) {
        result.skippedOrphans += 1
        continue
      }
      result.todoChanges += insertTodoChange.run(
        asText(change.id), todoId, targetUserId, asText(change.field), asStoredText(change.old_value),
        asStoredText(change.new_value), asNullableText(change.created_at) ?? now
      ).changes
    }
    for (const change of srcSubTaskChanges) {
      const subTaskId = asText(change.subtask_id)
      const todoId = asText(change.todo_id)
      const stored = findSubTask.get(subTaskId) as { todo_id: string } | undefined
      if (!validSubTaskIds.has(subTaskId) || stored?.todo_id !== todoId) {
        result.skippedOrphans += 1
        continue
      }
      result.subTaskChanges += insertSubTaskChange.run(
        asText(change.id), subTaskId, todoId, targetUserId, asText(change.field), asStoredText(change.old_value),
        asStoredText(change.new_value), asNullableText(change.created_at) ?? now
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
