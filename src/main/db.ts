import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { getDataDir } from './config'

let db: Database.Database

export function getDb(): Database.Database {
  return db
}

export function initDb(): void {
  const dir = getDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'todo.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  createTables()
  migrateDb()
  insertDefaultSettings()
}

function createTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#6366f1',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      memo TEXT DEFAULT '',
      category_id TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      priority INTEGER DEFAULT 2,
      progress INTEGER DEFAULT 0,
      start_date TEXT,
      due_date TEXT,
      sort_order INTEGER DEFAULT 0,
      recurrence TEXT DEFAULT NULL,
      recurrence_copy_subtasks INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (category_id) REFERENCES Categories(id)
    );

    CREATE TABLE IF NOT EXISTS SubTasks (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      assignee_id TEXT,
      start_date TEXT,
      due_date TEXT,
      progress INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0,
      completed_at TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id)
    );

    CREATE TABLE IF NOT EXISTS TodoDependencies (
      id TEXT PRIMARY KEY,
      predecessor_todo_id TEXT NOT NULL,
      successor_todo_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'finish_to_start',
      lag_days INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(predecessor_todo_id, successor_todo_id),
      FOREIGN KEY (predecessor_todo_id) REFERENCES Todos(id) ON DELETE CASCADE,
      FOREIGN KEY (successor_todo_id) REFERENCES Todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS WorkLogs (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id)
    );

    CREATE TABLE IF NOT EXISTS RunningState (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      todo_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id)
    );

    CREATE TABLE IF NOT EXISTS DailyPlanItems (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      scheduled_start TEXT,
      estimated_minutes INTEGER,
      lane INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plan_date, todo_id),
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ProgressNotes (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      user_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS TodoChangeLogs (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ProgressNoteComments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      parent_comment_id TEXT,
      user_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (note_id) REFERENCES ProgressNotes(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_comment_id) REFERENCES ProgressNoteComments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ProgressNoteReactions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      user_id TEXT,
      actor_key TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(note_id, actor_key, emoji),
      FOREIGN KEY (note_id) REFERENCES ProgressNotes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_progress_notes_todo ON ProgressNotes(todo_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_todo_changes_todo_created ON TodoChangeLogs(todo_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_progress_comments_note ON ProgressNoteComments(note_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_progress_reactions_note ON ProgressNoteReactions(note_id, emoji);
  `)
}

function migrateDb(): void {
  const todoColumns = db.prepare('PRAGMA table_info(Todos)').all() as { name: string }[]
  const subTaskColumns = db.prepare('PRAGMA table_info(SubTasks)').all() as { name: string }[]
  const dailyPlanColumns = db.prepare('PRAGMA table_info(DailyPlanItems)').all() as { name: string }[]
  const dependencyColumns = db.prepare('PRAGMA table_info(TodoDependencies)').all() as { name: string }[]
  const progressNoteColumns = db.prepare('PRAGMA table_info(ProgressNotes)').all() as { name: string }[]
  const progressCommentColumns = db.prepare('PRAGMA table_info(ProgressNoteComments)').all() as { name: string }[]

  // Todos.progress 追加
  if (!todoColumns.some((c) => c.name === 'progress')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN progress INTEGER DEFAULT 0').run()
  }

  // 優先度3段階→5段階マイグレーション
  const priorityMigrated = db.prepare("SELECT value FROM Settings WHERE key = 'priorityMigrated'").get() as { value: string } | undefined
  if (!priorityMigrated) {
    db.prepare(`
      UPDATE Todos SET priority = CASE priority
        WHEN 1 THEN 1
        WHEN 2 THEN 3
        WHEN 3 THEN 5
        ELSE priority
      END
    `).run()
    db.prepare("INSERT OR REPLACE INTO Settings (key, value) VALUES ('priorityMigrated', '1')").run()
  }

  // Categories カラム追加
  const catColumns = db.prepare('PRAGMA table_info(Categories)').all() as { name: string }[]
  if (!catColumns.some((c) => c.name === 'description')) {
    db.prepare("ALTER TABLE Categories ADD COLUMN description TEXT DEFAULT ''").run()
  }
  if (!catColumns.some((c) => c.name === 'sort_order')) {
    db.prepare('ALTER TABLE Categories ADD COLUMN sort_order INTEGER DEFAULT 0').run()
    const cats = db.prepare('SELECT id FROM Categories ORDER BY name ASC').all() as { id: string }[]
    const updCat = db.prepare('UPDATE Categories SET sort_order = ? WHERE id = ?')
    db.transaction(() => { cats.forEach((c, i) => updCat.run(i, c.id)) })()
  }
  if (!catColumns.some((c) => c.name === 'is_private')) {
    db.prepare('ALTER TABLE Categories ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0').run()
  }

  // Todos.sort_order 追加
  if (!todoColumns.some((c) => c.name === 'sort_order')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN sort_order INTEGER DEFAULT 0').run()
    // created_at DESC順でsort_orderを初期化
    const todos = db.prepare('SELECT id FROM Todos ORDER BY created_at DESC').all() as { id: string }[]
    const upd = db.prepare('UPDATE Todos SET sort_order = ? WHERE id = ?')
    const initOrder = db.transaction(() => {
      todos.forEach((t, i) => upd.run(i, t.id))
    })
    initOrder()
  }

  // Todos.recurrence 追加
  if (!todoColumns.some((c) => c.name === 'start_date')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN start_date TEXT').run()
  }

  if (!todoColumns.some((c) => c.name === 'recurrence')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN recurrence TEXT DEFAULT NULL').run()
  }

  if (!todoColumns.some((c) => c.name === 'recurrence_copy_subtasks')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN recurrence_copy_subtasks INTEGER DEFAULT 0').run()
  }
  if (!todoColumns.some((c) => c.name === 'completed_at')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN completed_at TEXT').run()
  }
  db.prepare("UPDATE Todos SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL").run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_todos_completed ON Todos(status, completed_at)').run()

  // SubTasks.description 追加
  if (!subTaskColumns.some((c) => c.name === 'description')) {
    db.prepare("ALTER TABLE SubTasks ADD COLUMN description TEXT DEFAULT ''").run()
  }
  if (!subTaskColumns.some((c) => c.name === 'assignee_id')) {
    db.prepare('ALTER TABLE SubTasks ADD COLUMN assignee_id TEXT').run()
  }
  if (!subTaskColumns.some((c) => c.name === 'start_date')) {
    db.prepare('ALTER TABLE SubTasks ADD COLUMN start_date TEXT').run()
  }
  if (!subTaskColumns.some((c) => c.name === 'due_date')) {
    db.prepare('ALTER TABLE SubTasks ADD COLUMN due_date TEXT').run()
  }
  if (!subTaskColumns.some((c) => c.name === 'completed_at')) {
    db.prepare('ALTER TABLE SubTasks ADD COLUMN completed_at TEXT').run()
  }
  if (!subTaskColumns.some((c) => c.name === 'progress')) {
    db.prepare('ALTER TABLE SubTasks ADD COLUMN progress INTEGER DEFAULT 0').run()
    db.prepare('UPDATE SubTasks SET progress = CASE WHEN done = 1 THEN 100 ELSE 0 END WHERE progress IS NULL OR progress = 0').run()
  }

  if (!dailyPlanColumns.some((c) => c.name === 'lane')) {
    db.prepare('ALTER TABLE DailyPlanItems ADD COLUMN lane INTEGER DEFAULT 0').run()
    db.prepare('UPDATE DailyPlanItems SET lane = 0 WHERE lane IS NULL').run()
  }

  if (!dependencyColumns.some((c) => c.name === 'lag_days')) {
    db.prepare('ALTER TABLE TodoDependencies ADD COLUMN lag_days INTEGER NOT NULL DEFAULT 0').run()
  }

  if (!todoColumns.some((c) => c.name === 'memo')) {
    db.prepare("ALTER TABLE Todos ADD COLUMN memo TEXT DEFAULT ''").run()
  }

  if (!progressNoteColumns.some((c) => c.name === 'updated_at')) {
    db.prepare("ALTER TABLE ProgressNotes ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run()
    db.prepare("UPDATE ProgressNotes SET updated_at = created_at WHERE updated_at = ''").run()
  }

  if (!progressCommentColumns.some((c) => c.name === 'parent_comment_id')) {
    db.prepare('ALTER TABLE ProgressNoteComments ADD COLUMN parent_comment_id TEXT').run()
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_progress_comments_parent ON ProgressNoteComments(parent_comment_id, created_at)').run()
}

function insertDefaultSettings(): void {
  const stmt = db.prepare(`INSERT OR IGNORE INTO Settings (key, value) VALUES (?, ?)`)
  stmt.run('archiveRetentionDays', '90')
  stmt.run('workLogRetentionDays', '0')
  stmt.run('notifyBeforeDays', '0')
  stmt.run('globalShortcutQuickAdd', 'CommandOrControl+Alt+N')
  stmt.run('globalShortcutExport', 'CommandOrControl+Alt+E')
  stmt.run('globalShortcutFocus', 'CommandOrControl+Alt+T')
  stmt.run('mdHeaderTpl', '# 作業ログ - {{date}}')
  stmt.run('mdTaskTpl', '## {{title}}{{category}}\n\n**合計: {{task_min}}分**')
  stmt.run('mdEntryTpl', '- {{start}} ～ {{end}} ({{min}}分){{note}}')
  stmt.run('mdFooterTpl', '**本日合計: {{total_min}}分**')
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function diffCalendarDays(dateStr: string, baseDateStr: string): number {
  const diffMs = parseDateKey(dateStr).getTime() - parseDateKey(baseDateStr).getTime()
  return Math.round(diffMs / 86400000)
}

function addDays(dateStr: string, days: number): string {
  const date = parseDateKey(dateStr)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

interface TodoBar {
  startDate: string
  endDate: string
}

function getNormalizedTodoBar(todo: Pick<Todo, 'start_date' | 'due_date'>): TodoBar | null {
  const start = normalizeDateKey(todo.start_date)
  const end = normalizeDateKey(todo.due_date)
  if (!start && !end) return null
  if (start && end) return start <= end ? { startDate: start, endDate: end } : { startDate: end, endDate: start }
  const singleDay = start ?? end!
  return { startDate: singleDay, endDate: singleDay }
}

function getTodoDurationDays(todo: Pick<Todo, 'start_date' | 'due_date'>): number {
  const bar = getNormalizedTodoBar(todo)
  return bar ? Math.max(diffCalendarDays(bar.endDate, bar.startDate), 0) : 0
}

function clampDependencyLagDays(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(60, Math.round(value)))
}

function clampProgress(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizeDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().slice(0, 10)
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)

  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null
  }

  return trimmed
}

function normalizeTimeKey(value: string | null | undefined): string | null {
  if (!value) return null
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function shiftTimeKey(value: string, deltaMinutes: number): string {
  const normalized = normalizeTimeKey(value)
  if (!normalized) return value

  const [hours, minutes] = normalized.split(':').map(Number)
  const totalMinutes = Math.min(23 * 60 + 59, Math.max(0, hours * 60 + minutes + deltaMinutes))
  const nextHours = Math.floor(totalMinutes / 60)
  const nextMinutes = totalMinutes % 60
  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`
}

function clampRunningSeconds(startTime: string, windowStart: Date, now: Date): number {
  const startMs = new Date(startTime).getTime()
  const fromMs = Math.max(startMs, windowStart.getTime())
  const toMs = now.getTime()
  if (toMs <= fromMs) return 0
  return Math.floor((toMs - fromMs) / 1000)
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function toMinutes(seconds: number): number {
  return Math.round(seconds / 60)
}

// ─── Categories ───────────────────────────────────────────────

export function getAllCategories(): Category[] {
  return db.prepare('SELECT * FROM Categories ORDER BY sort_order ASC, name ASC').all() as Category[]
}

export function createCategory(name: string, color: string, isPrivate = false): Category {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO Categories (id, name, color, is_private, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    color,
    isPrivate ? 1 : 0,
    now
  )
  return db.prepare('SELECT * FROM Categories WHERE id = ?').get(id) as Category
}

export function deleteCategory(id: string): void {
  db.prepare('UPDATE Todos SET category_id = NULL WHERE category_id = ?').run(id)
  db.prepare('DELETE FROM Categories WHERE id = ?').run(id)
}

export function reorderCategories(orderedIds: string[]): void {
  const upd = db.prepare('UPDATE Categories SET sort_order = ? WHERE id = ?')
  db.transaction(() => { orderedIds.forEach((id, i) => upd.run(i, id)) })()
}

export function updateCategory(id: string, name: string, color: string, description: string, isPrivate = false): Category {
  db.prepare('UPDATE Categories SET name = ?, color = ?, description = ?, is_private = ? WHERE id = ?').run(
    name, color, description, isPrivate ? 1 : 0, id
  )
  return db.prepare('SELECT * FROM Categories WHERE id = ?').get(id) as Category
}

// ─── Todos ────────────────────────────────────────────────────

export function getAllTodos(): Todo[] {
  return db
    .prepare(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM Todos t
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE t.status != 'archived' OR t.archived_at IS NOT NULL
       ORDER BY t.created_at DESC`
    )
    .all() as Todo[]
}

function getTodoById(id: string): Todo {
  return db
    .prepare(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM Todos t LEFT JOIN Categories c ON t.category_id = c.id WHERE t.id = ?`
    )
    .get(id) as Todo
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

function recordTodoChanges(before: Todo, after: Todo, createdAt: string): void {
  const beforeValues = todoChangeSnapshot(before)
  const afterValues = todoChangeSnapshot(after)
  const insert = db.prepare(
    'INSERT INTO TodoChangeLogs (id, todo_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const field of Object.keys(afterValues)) {
    if (beforeValues[field] === afterValues[field]) continue
    insert.run(crypto.randomUUID(), after.id, field, beforeValues[field], afterValues[field], createdAt)
  }
}

function applyTodoUpdate(id: string, data: UpdateTodoInput, updatedAt: string): void {
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [updatedAt]

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title) }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
  if (data.memo !== undefined) { fields.push('memo = ?'); values.push(data.memo) }
  if (data.category_id !== undefined) { fields.push('category_id = ?'); values.push(data.category_id) }
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

  values.push(id)
  db.prepare(`UPDATE Todos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
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
  const predecessorRows = db
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

  const successors = db
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

    const nextRows = db
      .prepare('SELECT successor_todo_id FROM TodoDependencies WHERE predecessor_todo_id = ?')
      .all(current) as Array<{ successor_todo_id: string }>
    for (const row of nextRows) queue.push(row.successor_todo_id)
  }

  return false
}

export function createTodo(data: CreateTodoInput): Todo {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const status = data.status ?? 'not_started'
  const startDate = normalizeDateKey(data.start_date)
  const dueDate = normalizeDateKey(data.due_date)
  // 新規タスクはsort_orderを最小値-1にして先頭に表示
  const minOrder = (db.prepare('SELECT COALESCE(MIN(sort_order), 0) as m FROM Todos').get() as { m: number }).m
  db.prepare(
    `INSERT INTO Todos (id, title, description, memo, category_id, status, priority, progress, start_date, due_date, sort_order, recurrence, recurrence_copy_subtasks, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.title,
    data.description ?? '',
    data.memo ?? '',
    data.category_id ?? null,
    status,
    data.priority ?? 3,
    data.progress ?? 0,
    startDate,
    dueDate,
    minOrder - 1,
    data.recurrence ?? null,
    data.recurrence_copy_subtasks ? 1 : 0,
    now,
    now,
    status === 'done' ? now : null
  )
  return db
    .prepare(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM Todos t LEFT JOIN Categories c ON t.category_id = c.id WHERE t.id = ?`
    )
    .get(id) as Todo
}

export function reorderTodos(orderedIds: string[]): void {
  const upd = db.prepare('UPDATE Todos SET sort_order = ? WHERE id = ?')
  const run = db.transaction(() => {
    orderedIds.forEach((id, i) => upd.run(i, id))
  })
  run()
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

// 完了した繰り返しタスクの次回分を作成する。recurrence_copy_subtasks が
// 立っていればサブタスクも未完了状態・日付シフトつきで複製する。
function spawnNextRecurrence(source: Todo): void {
  const recurrence = source.recurrence
  if (!recurrence) return

  const next = createTodo({
    title: source.title,
    description: source.description,
    memo: source.memo,
    category_id: source.category_id,
    priority: source.priority,
    start_date: shiftRecurrenceDate(source.start_date, recurrence),
    due_date: shiftRecurrenceDate(source.due_date, recurrence),
    recurrence,
    recurrence_copy_subtasks: source.recurrence_copy_subtasks
  })

  if (source.recurrence_copy_subtasks) {
    const now = new Date().toISOString()
    const insert = db.prepare(
      'INSERT INTO SubTasks (id, todo_id, title, description, assignee_id, start_date, due_date, progress, done, completed_at, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)'
    )
    for (const sub of getSubTasksByTodo(source.id)) {
      insert.run(
        crypto.randomUUID(),
        next.id,
        sub.title,
        sub.description ?? '',
        sub.assignee_id,
        shiftRecurrenceDate(sub.start_date, recurrence),
        shiftRecurrenceDate(sub.due_date, recurrence),
        sub.sort_order,
        now
      )
    }
  }
}

export function updateTodo(id: string, data: UpdateTodoInput): Todo {
  const now = new Date().toISOString()
  const before = getTodoById(id)
  db.transaction(() => {
    applyTodoUpdate(id, data, now)
    resolveDependencyCascade(id, now)
    const updated = getTodoById(id)
    recordTodoChanges(before, updated, now)
    if (before.status !== 'done' && updated.status === 'done' && updated.recurrence) {
      spawnNextRecurrence(updated)
    }
  })()
  return getTodoById(id)
}

function syncTodoDueDateWithSubTask(todoId: string, subTaskDueDate: string | null): void {
  const normalizedSubTaskDueDate = normalizeDateKey(subTaskDueDate)
  if (!normalizedSubTaskDueDate) return

  const todo = getTodoById(todoId)
  const normalizedTodoDueDate = normalizeDateKey(todo.due_date)
  if (normalizedTodoDueDate && normalizedTodoDueDate >= normalizedSubTaskDueDate) return

  updateTodo(todoId, { due_date: normalizedSubTaskDueDate })
}

export function archiveTodo(id: string): void {
  const now = new Date().toISOString()
  const before = getTodoById(id)
  db.transaction(() => {
    db.prepare(`UPDATE Todos SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id)
    recordTodoChanges(before, getTodoById(id), now)
  })()
}

export function unarchiveTodo(id: string): void {
  const now = new Date().toISOString()
  const before = getTodoById(id)
  db.transaction(() => {
    db.prepare(`UPDATE Todos SET status = 'active', archived_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`).run(now, id)
    recordTodoChanges(before, getTodoById(id), now)
  })()
}

export function deleteTodo(id: string): void {
  db.prepare('DELETE FROM TodoDependencies WHERE predecessor_todo_id = ? OR successor_todo_id = ?').run(id, id)
  db.prepare('DELETE FROM WorkLogs WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM RunningState WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM SubTasks WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM Todos WHERE id = ?').run(id)
}

export function getAllTodoDependencies(): TodoDependency[] {
  return db
    .prepare('SELECT * FROM TodoDependencies ORDER BY created_at ASC')
    .all() as TodoDependency[]
}

export function createTodoDependency(predecessorTodoId: string, successorTodoId: string, lagDays = 0): TodoDependency {
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
  const current = db.prepare('SELECT * FROM TodoDependencies WHERE id = ?').get(id) as TodoDependency | undefined
  if (!current) return

  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('DELETE FROM TodoDependencies WHERE id = ?').run(id)
    resolveDependencyCascade(current.successor_todo_id, now)
  })()
}

// ─── SubTasks ─────────────────────────────────────────────────

export function getDailyPlanItems(planDate: string): DailyPlanItem[] {
  return db.prepare(
    `SELECT
        dpi.*,
        t.title,
        t.description,
        t.category_id,
        t.status,
        t.priority,
        t.progress,
        t.start_date,
        t.due_date,
        c.name AS category_name,
        c.color AS category_color
     FROM DailyPlanItems dpi
     JOIN Todos t ON dpi.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE dpi.plan_date = ?
     ORDER BY
       CASE WHEN dpi.scheduled_start IS NULL OR dpi.scheduled_start = '' THEN 1 ELSE 0 END ASC,
       dpi.scheduled_start ASC,
       dpi.lane ASC,
       dpi.sort_order ASC,
       dpi.created_at ASC`
  ).all(planDate) as DailyPlanItem[]
}

export function addDailyPlanItem(planDate: string, todoId: string): DailyPlanItem {
  const existing = db.prepare(
    `SELECT
        dpi.*,
        t.title,
        t.description,
        t.category_id,
        t.status,
        t.priority,
        t.progress,
        t.start_date,
        t.due_date,
        c.name AS category_name,
        c.color AS category_color
     FROM DailyPlanItems dpi
     JOIN Todos t ON dpi.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE dpi.plan_date = ? AND dpi.todo_id = ?`
  ).get(planDate, todoId) as DailyPlanItem | undefined

  if (existing) return existing

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (
    db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM DailyPlanItems WHERE plan_date = ?').get(planDate) as { m: number }
  ).m

  db.prepare(
    `INSERT INTO DailyPlanItems (id, plan_date, todo_id, scheduled_start, estimated_minutes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 60, ?, ?, ?)`
  ).run(id, planDate, todoId, maxOrder + 1, now, now)

  return db.prepare(
    `SELECT
        dpi.*,
        t.title,
        t.description,
        t.category_id,
        t.status,
        t.priority,
        t.progress,
        t.start_date,
        t.due_date,
        c.name AS category_name,
        c.color AS category_color
     FROM DailyPlanItems dpi
     JOIN Todos t ON dpi.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE dpi.id = ?`
  ).get(id) as DailyPlanItem
}

export function updateDailyPlanItem(id: string, data: UpdateDailyPlanItemInput): DailyPlanItem {
  const now = new Date().toISOString()
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]

  if (data.scheduled_start !== undefined) {
    fields.push('scheduled_start = ?')
    values.push(normalizeTimeKey(data.scheduled_start))
  }
  if (data.estimated_minutes !== undefined) {
    const value = data.estimated_minutes == null ? null : Math.max(15, Math.min(480, Math.round(data.estimated_minutes / 15) * 15))
    fields.push('estimated_minutes = ?')
    values.push(value)
  }
  if (data.lane !== undefined) {
    fields.push('lane = ?')
    values.push(Math.max(0, Math.min(2, data.lane)))
  }

  values.push(id)
  db.prepare(`UPDATE DailyPlanItems SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  return db.prepare(
    `SELECT
        dpi.*,
        t.title,
        t.description,
        t.category_id,
        t.status,
        t.priority,
        t.progress,
        t.start_date,
        t.due_date,
        c.name AS category_name,
        c.color AS category_color
     FROM DailyPlanItems dpi
     JOIN Todos t ON dpi.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE dpi.id = ?`
  ).get(id) as DailyPlanItem
}

export function shiftDailyPlanItem(id: string, deltaMinutes: number): DailyPlanItem {
  const current = db.prepare('SELECT scheduled_start FROM DailyPlanItems WHERE id = ?').get(id) as { scheduled_start: string | null } | undefined
  const nextTime = current?.scheduled_start ? shiftTimeKey(current.scheduled_start, deltaMinutes) : null
  return updateDailyPlanItem(id, { scheduled_start: nextTime })
}

export function deleteDailyPlanItem(id: string): void {
  db.prepare('DELETE FROM DailyPlanItems WHERE id = ?').run(id)
}

export function reorderDailyPlanItems(planDate: string, orderedIds: string[]): void {
  const update = db.prepare('UPDATE DailyPlanItems SET sort_order = ?, updated_at = ? WHERE id = ? AND plan_date = ?')
  const now = new Date().toISOString()
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, now, id, planDate))
  })()
}

export function getSubTasksByTodo(todoId: string): SubTask[] {
  return db.prepare('SELECT st.*, NULL AS assignee_name, NULL AS assignee_color FROM SubTasks st WHERE st.todo_id = ? ORDER BY st.sort_order ASC, st.created_at ASC').all(todoId) as SubTask[]
}

export function getAllSubTasks(): SubTask[] {
  return db.prepare('SELECT st.*, NULL AS assignee_name, NULL AS assignee_color FROM SubTasks st ORDER BY st.todo_id ASC, st.sort_order ASC, st.created_at ASC').all() as SubTask[]
}

export function getSubTasksForCalendar(): CalendarSubTask[] {
  return db.prepare(
    `SELECT st.*, NULL AS assignee_name, NULL AS assignee_color, t.title AS todo_title, t.status AS todo_status, c.color AS category_color
     FROM SubTasks st
     JOIN Todos t ON st.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE st.due_date IS NOT NULL AND t.status != 'archived'
     ORDER BY st.due_date ASC, st.sort_order ASC, st.created_at ASC`
  ).all() as CalendarSubTask[]
}

export function createSubTask(todoId: string, data: CreateSubTaskInput): SubTask {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM SubTasks WHERE todo_id = ?').get(todoId) as { m: number }).m
  const startDate = normalizeDateKey(data.start_date)
  const dueDate = normalizeDateKey(data.due_date)
  const progress = clampProgress(data.progress)
  const done = progress >= 100 ? 1 : 0
  db.prepare(
    'INSERT INTO SubTasks (id, todo_id, title, description, assignee_id, start_date, due_date, progress, done, completed_at, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, todoId, data.title, data.description ?? '', data.assignee_id ?? null, startDate, dueDate, progress, done, done ? now : null, maxOrder + 1, now)
  const created = db.prepare('SELECT st.*, NULL AS assignee_name, NULL AS assignee_color FROM SubTasks st WHERE st.id = ?').get(id) as SubTask
  syncTodoDueDateWithSubTask(todoId, created.due_date)
  return created
}

export function updateSubTask(id: string, data: UpdateSubTaskInput): SubTask {
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
  const updated = db.prepare('SELECT st.*, NULL AS assignee_name, NULL AS assignee_color FROM SubTasks st WHERE st.id = ?').get(id) as SubTask
  syncTodoDueDateWithSubTask(updated.todo_id, updated.due_date)
  return updated
}

export function deleteSubTask(id: string): void {
  db.prepare('DELETE FROM SubTasks WHERE id = ?').run(id)
}

// ─── Timer ────────────────────────────────────────────────────

export function startTimer(todoId: string): RunningState {
  return db.transaction(() => {
    // 切替先を先に検証し、旧タイマーの停止だけが確定する部分更新を防ぐ。
    const target = db.prepare('SELECT id FROM Todos WHERE id = ?').get(todoId) as { id: string } | undefined
    if (!target) throw new Error('開始するタスクが見つかりません')

    // 実行中のタイマーがあれば自動停止（WorkLog 記録）してから開始する。
    // 同じタスクを再度開始した場合は計測中のものを維持する（リセットしない）。
    const existing = db.prepare('SELECT * FROM RunningState WHERE id = 1').get() as RunningState | undefined
    if (existing) {
      if (existing.todo_id === todoId) return { todo_id: existing.todo_id, start_time: existing.start_time }
      stopTimer()
    }
    const now = new Date().toISOString()
    db.prepare('INSERT INTO RunningState (id, todo_id, start_time) VALUES (1, ?, ?)').run(todoId, now)
    return { todo_id: todoId, start_time: now }
  })()
}

export function stopTimer(note?: string): WorkLog {
  const running = db.prepare('SELECT * FROM RunningState WHERE id = 1').get() as RunningState | undefined
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
    `INSERT INTO WorkLogs (id, todo_id, start_time, end_time, duration_seconds, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, running.todo_id, running.start_time, endTime, durationSeconds, note ?? '', now)

  db.prepare('DELETE FROM RunningState WHERE id = 1').run()

  return db.prepare('SELECT * FROM WorkLogs WHERE id = ?').get(id) as WorkLog
}

export function getRunningState(): RunningState | undefined {
  return db.prepare('SELECT * FROM RunningState WHERE id = 1').get() as RunningState | undefined
}

// ─── WorkLogs ─────────────────────────────────────────────────

export function getWorkLogsByTodo(todoId: string): WorkLog[] {
  return db
    .prepare('SELECT * FROM WorkLogs WHERE todo_id = ? ORDER BY start_time DESC')
    .all(todoId) as WorkLog[]
}

export function getTodayWorkLogs(): TodayWorkLog[] {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)

  return db
    .prepare(
      `SELECT wl.*, t.title, c.name as category
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE wl.start_time >= ? AND wl.start_time <= ?
       ORDER BY t.id, wl.start_time`
    )
    .all(todayStart.toISOString(), todayEnd.toISOString()) as TodayWorkLog[]
}

export function getAllWorkLogRows(): WorkLogSummaryRow[] {
  return db
    .prepare(
      `SELECT wl.id, wl.todo_id, t.title,
              c.name as category_name, c.color as category_color,
              wl.start_time, wl.end_time, wl.duration_seconds, wl.note
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       ORDER BY wl.start_time ASC`
    )
    .all() as WorkLogSummaryRow[]
}

export function getWorkLogsByDate(dateStr: string): WorkLogSummaryRow[] {
  return db
    .prepare(
      `SELECT wl.id, wl.todo_id, t.title,
              c.name as category_name, c.color as category_color,
              wl.start_time, wl.end_time, wl.duration_seconds, wl.note
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE date(wl.start_time, 'localtime') = ?
       ORDER BY wl.start_time ASC`
    )
    .all(dateStr) as WorkLogSummaryRow[]
}

export function getWorkLogsSummary(days: number): WorkLogSummaryRow[] {
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  from.setHours(0, 0, 0, 0)

  return db
    .prepare(
      `SELECT wl.id, wl.todo_id, t.title,
              c.name as category_name, c.color as category_color,
              wl.start_time, wl.end_time, wl.duration_seconds, wl.note
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE wl.start_time >= ?
       ORDER BY wl.start_time DESC`
    )
    .all(from.toISOString()) as WorkLogSummaryRow[]
}

interface OverviewSubTaskRollup {
  total: number
  done: number
}

function getCurrentWeekStart(): Date {
  const start = new Date()
  const day = start.getDay()
  const diff = day === 0 ? -6 : 1 - day
  start.setDate(start.getDate() + diff)
  start.setHours(0, 0, 0, 0)
  return start
}

function buildOverviewTask(
  todo: Todo,
  reason: OverviewTaskReason,
  subTaskRollups: Map<string, OverviewSubTaskRollup>
): OverviewTaskItem {
  const subTask = subTaskRollups.get(todo.id) ?? { total: 0, done: 0 }
  return {
    todoId: todo.id,
    title: todo.title,
    categoryName: todo.category_name,
    categoryColor: todo.category_color,
    priority: todo.priority,
    progress: todo.status === 'done' ? 100 : todo.progress,
    dueDate: todo.due_date,
    updatedAt: todo.updated_at,
    reason,
    subTaskDone: subTask.done,
    subTaskTotal: subTask.total
  }
}

export function getOverviewData(): OverviewData {
  const todos = getAllTodos().filter((todo) => todo.status !== 'archived')
  const categories = getAllCategories()
  const todayKey = getTodayKey()
  const currentWeekStart = getCurrentWeekStart()
  const activeTodos = todos.filter((todo) => todo.status !== 'done')
  const doneTodos = todos.filter((todo) => todo.status === 'done')

  const subTaskRows = db.prepare(`
    SELECT
      todo_id,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS done
    FROM SubTasks
    GROUP BY todo_id
  `).all() as { todo_id: string; total: number; done: number }[]

  const subTaskRollups = new Map<string, OverviewSubTaskRollup>()
  subTaskRows.forEach((row) => {
    subTaskRollups.set(row.todo_id, { total: row.total, done: row.done })
  })

  const overdueTodos = activeTodos.filter((todo) => todo.due_date && diffCalendarDays(todo.due_date, todayKey) < 0)
  const dueSoonTodos = activeTodos.filter((todo) => {
    if (!todo.due_date) return false
    const diffDays = diffCalendarDays(todo.due_date, todayKey)
    return diffDays >= 0 && diffDays <= 3
  })

  const dueToday = activeTodos
    .filter((todo) => todo.due_date === todayKey)
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, 'ja'))
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'dueToday', subTaskRollups))

  const highPriority = activeTodos
    .filter((todo) => todo.priority >= 4 && todo.progress < 100)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date)
      if (a.due_date) return -1
      if (b.due_date) return 1
      return a.progress - b.progress
    })
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'highPriority', subTaskRollups))

  const nearlyDone = activeTodos
    .filter((todo) => todo.progress >= 75 && todo.progress < 100)
    .sort((a, b) => b.progress - a.progress || b.priority - a.priority)
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'nearlyDone', subTaskRollups))

  const staleThresholdMs = 7 * 86400000
  const stale = activeTodos
    .filter((todo) => Date.now() - new Date(todo.updated_at).getTime() >= staleThresholdMs)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'stale', subTaskRollups))

  const riskCandidates = [
    ...overdueTodos
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || b.priority - a.priority)
      .map((todo) => buildOverviewTask(todo, 'overdue', subTaskRollups)),
    ...dueSoonTodos
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || b.priority - a.priority)
      .map((todo) => buildOverviewTask(todo, 'dueSoon', subTaskRollups)),
    ...activeTodos
      .filter((todo) => todo.priority >= 4 && todo.progress <= 40)
      .sort((a, b) => b.priority - a.priority || a.progress - b.progress)
      .map((todo) => buildOverviewTask(todo, 'highPriority', subTaskRollups)),
    ...activeTodos
      .filter((todo) => Date.now() - new Date(todo.updated_at).getTime() >= staleThresholdMs)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .map((todo) => buildOverviewTask(todo, 'stale', subTaskRollups))
  ]

  const riskMap = new Map<string, OverviewTaskItem>()
  riskCandidates.forEach((item) => {
    if (!riskMap.has(item.todoId)) {
      riskMap.set(item.todoId, item)
    }
  })
  const risks = [...riskMap.values()].slice(0, 8)

  const categoryBuckets = new Map<string, OverviewCategoryStat>()
  categories.forEach((category) => {
    categoryBuckets.set(category.id, {
      categoryId: category.id,
      categoryName: category.name,
      categoryColor: category.color,
      totalTasks: 0,
      activeTasks: 0,
      doneTasks: 0,
      overdueTasks: 0,
      completionRate: 0,
      completionScore: 0,
      avgActiveProgress: 0
    })
  })

  todos.forEach((todo) => {
    const bucketKey = todo.category_id ?? '__uncategorized__'
    if (!categoryBuckets.has(bucketKey)) {
      categoryBuckets.set(bucketKey, {
        categoryId: null,
        categoryName: '未分類',
        categoryColor: '#64748b',
        totalTasks: 0,
        activeTasks: 0,
        doneTasks: 0,
        overdueTasks: 0,
        completionRate: 0,
        completionScore: 0,
        avgActiveProgress: 0
      })
    }

    const bucket = categoryBuckets.get(bucketKey)!
    bucket.totalTasks += 1
    if (todo.status === 'done') bucket.doneTasks += 1
    else bucket.activeTasks += 1
    if (todo.status !== 'done' && todo.due_date && diffCalendarDays(todo.due_date, todayKey) < 0) {
      bucket.overdueTasks += 1
    }
    bucket.completionScore += todo.status === 'done' ? 100 : todo.progress
    if (todo.status !== 'done') {
      bucket.avgActiveProgress += todo.progress
    }
  })

  const overviewCategories = [...categoryBuckets.values()]
    .filter((bucket) => bucket.totalTasks > 0)
    .map((bucket) => ({
      ...bucket,
      completionRate: Math.round((bucket.doneTasks / bucket.totalTasks) * 100),
      completionScore: Math.round(bucket.completionScore / bucket.totalTasks),
      avgActiveProgress: bucket.activeTasks > 0
        ? Math.round(bucket.avgActiveProgress / bucket.activeTasks)
        : 100
    }))
    .sort((a, b) => b.overdueTasks - a.overdueTasks || a.completionScore - b.completionScore || b.totalTasks - a.totalTasks)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 6)
  weekStart.setHours(0, 0, 0, 0)

  const todaySecondsRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS total
    FROM WorkLogs
    WHERE start_time >= ?
  `).get(todayStart.toISOString()) as { total: number }

  const weekSecondsRow = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS total
    FROM WorkLogs
    WHERE start_time >= ?
  `).get(weekStart.toISOString()) as { total: number }

  const running = getRunningState()
  const now = new Date()
  const runningToday = running ? clampRunningSeconds(running.start_time, todayStart, now) : 0
  const runningWeek = running ? clampRunningSeconds(running.start_time, weekStart, now) : 0
  const completedSubTasks = db.prepare(
    `SELECT
        st.id,
        st.todo_id,
        st.title,
        st.completed_at,
        t.title AS todo_title,
        c.name AS category_name,
        c.color AS category_color
     FROM SubTasks st
     JOIN Todos t ON st.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE st.done = 1
       AND st.completed_at IS NOT NULL
       AND st.completed_at >= ?
       AND t.status != 'archived'
     ORDER BY st.completed_at DESC`
  ).all(currentWeekStart.toISOString()) as OverviewCompletedSubTaskItem[]

  const summary: OverviewSummary = {
    totalTasks: todos.length,
    activeTasks: activeTodos.length,
    doneTasks: doneTodos.length,
    completionRate: todos.length > 0 ? Math.round((doneTodos.length / todos.length) * 100) : 0,
    completionScore: todos.length > 0
      ? Math.round(todos.reduce((sum, todo) => sum + (todo.status === 'done' ? 100 : todo.progress), 0) / todos.length)
      : 0,
    avgActiveProgress: average(activeTodos.map((todo) => todo.progress)),
    overdueTasks: overdueTodos.length,
    dueSoonTasks: dueSoonTodos.length,
    todayMinutes: toMinutes(todaySecondsRow.total + runningToday),
    weekMinutes: toMinutes(weekSecondsRow.total + runningWeek),
    completedSubTasksThisWeek: completedSubTasks.length
  }

  return {
    summary,
    categories: overviewCategories,
    risks,
    dueToday,
    highPriority,
    nearlyDone,
    stale,
    completedSubTasks: completedSubTasks.slice(0, 10)
  }
}

// ─── Settings ─────────────────────────────────────────────────

export function getSetting(key: string): string | undefined {
  if (!db) return undefined

  const row = db.prepare('SELECT value FROM Settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setSetting(key: string, value: string): void {
  if (!db) return
  db.prepare('INSERT OR REPLACE INTO Settings (key, value) VALUES (?, ?)').run(key, value)
}

// ─── Progress notes ───────────────────────────────────────────
// Desktop is single-user: notes carry no author (user_id stays NULL) and the
// digest collapses to one bucket. Kept here so the shared UI works in both modes.

const PROGRESS_NOTE_SELECT = `SELECT pn.id, pn.todo_id, pn.user_id, pn.body, pn.created_at, pn.updated_at,
              t.title AS todo_title, c.name AS category_name, c.color AS category_color,
              NULL AS author_name, NULL AS author_color,
              COUNT(pnc.id) AS comment_count
       FROM ProgressNotes pn
       JOIN Todos t ON pn.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       LEFT JOIN ProgressNoteComments pnc ON pnc.note_id = pn.id`

const PROGRESS_COMMENT_SELECT = `SELECT id, note_id, parent_comment_id, user_id, NULL AS author_name, NULL AS author_color,
              body, created_at, updated_at
       FROM ProgressNoteComments`

function hydrateProgressNotes(notes: ProgressNote[]): ProgressNote[] {
  if (notes.length === 0) return []

  const noteIds = notes.map((note) => note.id)
  const placeholders = noteIds.map(() => '?').join(', ')
  const commentRows = db
    .prepare(`${PROGRESS_COMMENT_SELECT} WHERE note_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...noteIds) as Array<Omit<ProgressNoteComment, 'replies'>>
  const reactionRows = db
    .prepare(
      `SELECT note_id, emoji, COUNT(*) AS count,
              SUM(CASE WHEN actor_key = 'desktop' THEN 1 ELSE 0 END) AS reacted_by_me
       FROM ProgressNoteReactions
       WHERE note_id IN (${placeholders})
       GROUP BY note_id, emoji
       ORDER BY emoji ASC`
    )
    .all(...noteIds) as Array<ProgressNoteReaction & { note_id: string }>

  const commentById = new Map<string, ProgressNoteComment>()
  for (const row of commentRows) {
    commentById.set(row.id, { ...row, replies: [] })
  }

  const commentsByNote = new Map<string, ProgressNoteComment[]>()
  for (const comment of commentById.values()) {
    if (comment.parent_comment_id && commentById.has(comment.parent_comment_id)) {
      commentById.get(comment.parent_comment_id)!.replies.push(comment)
      continue
    }

    const list = commentsByNote.get(comment.note_id)
    if (list) list.push(comment)
    else commentsByNote.set(comment.note_id, [comment])
  }

  const reactionsByNote = new Map<string, ProgressNoteReaction[]>()
  for (const row of reactionRows) {
    const reaction: ProgressNoteReaction = {
      emoji: row.emoji,
      count: Number(row.count),
      reacted_by_me: Boolean(row.reacted_by_me)
    }
    const list = reactionsByNote.get(row.note_id)
    if (list) list.push(reaction)
    else reactionsByNote.set(row.note_id, [reaction])
  }

  return notes.map((note) => ({
    ...note,
    comment_count: Number(note.comment_count),
    comments: commentsByNote.get(note.id) ?? [],
    reactions: reactionsByNote.get(note.id) ?? []
  }))
}

export function getProgressNotesByTodo(todoId: string): ProgressNote[] {
  const notes = db
    .prepare(`${PROGRESS_NOTE_SELECT} WHERE pn.todo_id = ? GROUP BY pn.id ORDER BY pn.created_at DESC`)
    .all(todoId) as ProgressNote[]
  return hydrateProgressNotes(notes)
}

export function getProgressNotesByDate(dateStr: string): ProgressNote[] {
  return getProgressNotesByRange(dateStr, dateStr)
}

export function getProgressNotesByRange(from: string, to: string): ProgressNote[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('進捗タイムラインの期間が不正です')
  }
  const notes = db
    .prepare(`${PROGRESS_NOTE_SELECT} WHERE date(pn.created_at, 'localtime') BETWEEN ? AND ? GROUP BY pn.id ORDER BY pn.created_at DESC`)
    .all(from, to) as ProgressNote[]
  return hydrateProgressNotes(notes)
}

export function getProgressNote(id: string): ProgressNote | undefined {
  const note = db.prepare(`${PROGRESS_NOTE_SELECT} WHERE pn.id = ? GROUP BY pn.id`).get(id) as ProgressNote | undefined
  return note ? hydrateProgressNotes([note])[0] : undefined
}

export function createProgressNote(todoId: string, body: string): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('進捗メモの内容を入力してください')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO ProgressNotes (id, todo_id, user_id, body, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)').run(
    id,
    todoId,
    trimmed,
    now,
    now
  )
  return getProgressNote(id) as ProgressNote
}

export function updateProgressNote(id: string, body: string): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('進捗ログの内容を入力してください')
  db.prepare('UPDATE ProgressNotes SET body = ?, updated_at = ? WHERE id = ?').run(trimmed, new Date().toISOString(), id)
  return getProgressNote(id) as ProgressNote
}

export function deleteProgressNote(id: string): void {
  db.prepare('DELETE FROM ProgressNotes WHERE id = ?').run(id)
}

export function getProgressNoteComment(id: string): ProgressNoteComment | undefined {
  return db.prepare(`${PROGRESS_COMMENT_SELECT} WHERE id = ?`).get(id) as ProgressNoteComment | undefined
}

export function createProgressNoteComment(noteId: string, body: string, parentCommentId?: string | null): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('コメントを入力してください')
  const parentId = parentCommentId || null
  if (parentId) {
    const parent = getProgressNoteComment(parentId)
    if (!parent || parent.note_id !== noteId) throw new Error('返信先のコメントが見つかりません')
  }
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO ProgressNoteComments (id, note_id, parent_comment_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)').run(
    id,
    noteId,
    parentId,
    trimmed,
    now,
    now
  )
  return getProgressNote(noteId) as ProgressNote
}

export function updateProgressNoteComment(id: string, body: string): ProgressNote {
  const comment = getProgressNoteComment(id)
  if (!comment) throw new Error('コメントが見つかりません')
  const trimmed = body.trim()
  if (!trimmed) throw new Error('コメントを入力してください')
  db.prepare('UPDATE ProgressNoteComments SET body = ?, updated_at = ? WHERE id = ?').run(trimmed, new Date().toISOString(), id)
  return getProgressNote(comment.note_id) as ProgressNote
}

export function deleteProgressNoteComment(id: string): ProgressNote {
  const comment = getProgressNoteComment(id)
  if (!comment) throw new Error('コメントが見つかりません')
  db.prepare(
    `WITH RECURSIVE comment_tree(id) AS (
       SELECT id FROM ProgressNoteComments WHERE id = ?
       UNION ALL
       SELECT c.id FROM ProgressNoteComments c
       JOIN comment_tree ct ON c.parent_comment_id = ct.id
     )
     DELETE FROM ProgressNoteComments WHERE id IN (SELECT id FROM comment_tree)`
  ).run(id)
  return getProgressNote(comment.note_id) as ProgressNote
}

export function toggleProgressNoteReaction(noteId: string, emoji: string): ProgressNote {
  const normalizedEmoji = emoji.trim()
  if (!normalizedEmoji) throw new Error('リアクションを選択してください')
  const existing = db
    .prepare("SELECT id FROM ProgressNoteReactions WHERE note_id = ? AND actor_key = 'desktop' AND emoji = ?")
    .get(noteId, normalizedEmoji) as { id: string } | undefined
  if (existing) {
    db.prepare('DELETE FROM ProgressNoteReactions WHERE id = ?').run(existing.id)
  } else {
    db.prepare('INSERT INTO ProgressNoteReactions (id, note_id, user_id, actor_key, emoji, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
      .run(crypto.randomUUID(), noteId, 'desktop', normalizedEmoji, new Date().toISOString())
  }
  return getProgressNote(noteId) as ProgressNote
}

export function getProgressDigest(query: ProgressDigestQuery): ProgressDigest {
  const { from, to } = query
  // 全体レンズ時はプライベートカテゴリのタスク由来の集計を除外する
  const includePrivate = query.includePrivate !== false
  const catJoin = includePrivate ? '' : 'LEFT JOIN Categories c ON t.category_id = c.id'
  const catClause = includePrivate ? '' : 'AND COALESCE(c.is_private, 0) = 0'

  const addedTodos = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.progress, t.memo,
              c.name AS category_name, c.color AS category_color, t.created_at
       FROM Todos t LEFT JOIN Categories c ON t.category_id = c.id
       WHERE date(t.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
       ORDER BY t.created_at ASC`
    )
    .all(from, to) as ProgressDigestTodo[]

  const completedTodos = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.progress, t.memo,
              c.name AS category_name, c.color AS category_color, t.completed_at
       FROM Todos t LEFT JOIN Categories c ON t.category_id = c.id
       WHERE t.status = 'done' AND t.completed_at IS NOT NULL
         AND date(t.completed_at, 'localtime') BETWEEN ? AND ? ${catClause}
       ORDER BY t.completed_at ASC`
    )
    .all(from, to) as ProgressDigestCompletedTodo[]

  const addedSubTasks = db
    .prepare(
      `SELECT st.id, st.title, st.todo_id, t.title AS todo_title, st.done, st.created_at
       FROM SubTasks st JOIN Todos t ON st.todo_id = t.id ${catJoin}
       WHERE date(st.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
       ORDER BY st.created_at ASC`
    )
    .all(from, to) as ProgressDigestSubTask[]

  const notes = db
    .prepare(
      `SELECT pn.id, pn.todo_id, t.title AS todo_title, pn.body, pn.created_at
       FROM ProgressNotes pn JOIN Todos t ON pn.todo_id = t.id ${catJoin}
       WHERE date(pn.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
       ORDER BY pn.created_at ASC`
    )
    .all(from, to) as ProgressDigestNote[]

  const taskChanges = db
    .prepare(
      `SELECT tcl.id, tcl.todo_id, t.title AS todo_title,
              c.name AS category_name, c.color AS category_color,
              tcl.field, tcl.old_value, tcl.new_value, tcl.created_at
       FROM TodoChangeLogs tcl
       JOIN Todos t ON tcl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE date(tcl.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
       ORDER BY tcl.created_at ASC`
    )
    .all(from, to) as ProgressDigestTaskChange[]

  const comments = db
    .prepare(
      `SELECT pnc.id, pnc.note_id, pn.todo_id, t.title AS todo_title,
              pnc.parent_comment_id, pnc.body, pnc.created_at
       FROM ProgressNoteComments pnc
       JOIN ProgressNotes pn ON pnc.note_id = pn.id
       JOIN Todos t ON pn.todo_id = t.id ${catJoin}
       WHERE date(pnc.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
       ORDER BY pnc.created_at ASC`
    )
    .all(from, to) as ProgressDigestComment[]

  const work = db
    .prepare(
      `SELECT COALESCE(SUM(wl.duration_seconds), 0) AS seconds, COUNT(*) AS cnt
       FROM WorkLogs wl
       ${includePrivate ? '' : 'JOIN Todos t ON wl.todo_id = t.id LEFT JOIN Categories c ON t.category_id = c.id'}
       WHERE date(wl.start_time, 'localtime') BETWEEN ? AND ? ${catClause}`
    )
    .get(from, to) as { seconds: number; cnt: number }

  return {
    from,
    to,
    users: [
      {
        user_id: null,
        display_name: '自分',
        color: '#6366f1',
        added_todos: addedTodos,
        completed_todos: completedTodos,
        added_subtasks: addedSubTasks,
        task_changes: taskChanges,
        notes,
        comments,
        work_minutes: Math.round(work.seconds / 60),
        work_log_count: work.cnt
      }
    ]
  }
}

// ─── Types ────────────────────────────────────────────────────

export interface Category {
  id: string
  name: string
  color: string
  description: string
  sort_order: number
  /** 1 のとき全体の集計（概要/チーム/進捗レポート）から除外する */
  is_private: number
  created_at: string
}

export type TodoStatus = 'not_started' | 'active' | 'done' | 'archived'

export type UserRole = 'admin' | 'member'

/** A user as exposed to clients (never includes the password hash). Web-only; the Electron build returns an empty user list. */
export interface PublicUser {
  id: string
  username: string
  display_name: string
  role: UserRole
  color: string
  is_active: number
  created_at: string
  updated_at: string
}

/** Fields accepted when an admin creates a user. Web-only. */
export interface CreateUserInput {
  username: string
  display_name: string
  password: string
  role?: UserRole
  color?: string
}

/** Fields an admin may change on an existing user. Web-only. */
export interface UpdateUserInput {
  display_name?: string
  role?: UserRole
  color?: string
  is_active?: boolean
}

/** User-specific notification shown in the server build. Desktop returns none. */
export type NotificationType = 'progress_reply' | 'task_assigned'

export interface UserNotification {
  id: string
  user_id: string
  type: NotificationType
  actor_user_id: string | null
  actor_name: string | null
  actor_color: string | null
  todo_id: string | null
  todo_title: string | null
  progress_note_id: string | null
  progress_comment_id: string | null
  title: string
  body: string
  created_at: string
  read_at: string | null
}

/** A teammate currently running a timer — "who is doing what right now". */
export interface TeamNowItem {
  user_id: string
  display_name: string
  user_color: string
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  start_time: string
  elapsed_seconds: number
}

export interface TeamDeadlineItem {
  todo_id: string
  title: string
  due_date: string
  status: TodoStatus
  priority: number
  progress: number
  category_name: string | null
  category_color: string | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  days_until_due: number
}

export interface TeamMemberWorkload {
  user_id: string
  display_name: string
  user_color: string
  active_tasks: number
  overdue_tasks: number
  today_minutes: number
}

export interface TeamDashboard {
  now: TeamNowItem[]
  overdue: TeamDeadlineItem[]
  dueSoon: TeamDeadlineItem[]
  workloads: TeamMemberWorkload[]
}

/** A timestamped, authored progress note attached to a task. On desktop the author fields are null. */
export interface ProgressNote {
  id: string
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  user_id: string | null
  author_name: string | null
  author_color: string | null
  body: string
  created_at: string
  updated_at: string
  comment_count: number
  comments: ProgressNoteComment[]
  reactions: ProgressNoteReaction[]
}

export interface ProgressNoteComment {
  id: string
  note_id: string
  parent_comment_id: string | null
  user_id: string | null
  author_name: string | null
  author_color: string | null
  body: string
  created_at: string
  updated_at: string
  replies: ProgressNoteComment[]
}

export interface ProgressNoteReaction {
  emoji: string
  count: number
  reacted_by_me: boolean
}

export interface ProgressDigestTodo {
  id: string
  title: string
  status: TodoStatus
  progress: number
  memo: string
  category_name: string | null
  category_color: string | null
  created_at: string
}

export interface ProgressDigestCompletedTodo {
  id: string
  title: string
  status: TodoStatus
  progress: number
  memo: string
  category_name: string | null
  category_color: string | null
  completed_at: string
}

export interface ProgressDigestSubTask {
  id: string
  title: string
  todo_id: string
  todo_title: string
  done: number
  created_at: string
}

export interface ProgressDigestNote {
  id: string
  todo_id: string
  todo_title: string
  body: string
  created_at: string
}

export interface ProgressDigestTaskChange {
  id: string
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  field: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

export interface ProgressDigestComment {
  id: string
  note_id: string
  todo_id: string
  todo_title: string
  parent_comment_id: string | null
  body: string
  created_at: string
}

/** One member's activity within the requested period. Desktop returns a single bucket. */
export interface ProgressDigestUser {
  user_id: string | null
  display_name: string
  color: string
  added_todos: ProgressDigestTodo[]
  completed_todos: ProgressDigestCompletedTodo[]
  added_subtasks: ProgressDigestSubTask[]
  task_changes: ProgressDigestTaskChange[]
  notes: ProgressDigestNote[]
  comments: ProgressDigestComment[]
  work_minutes: number
  work_log_count: number
}

export interface ProgressDigest {
  from: string
  to: string
  users: ProgressDigestUser[]
}

/** Period (inclusive YYYY-MM-DD) + optional member filter for the admin report. Web-only filter. */
export interface ProgressDigestQuery {
  from: string
  to: string
  userIds?: string[]
  /** false のときプライベートカテゴリのタスク由来の集計を除外する（既定は含める） */
  includePrivate?: boolean
}

/** デスクトップ版 todo.db をサーバー版へ取り込んだ結果の件数（サーバー版のみ） */
export interface DesktopImportResult {
  categories: number
  todos: number
  subTasks: number
  dependencies: number
  workLogs: number
  planItems: number
  skippedOrphans: number
  dryRun: boolean
}

export interface Todo {
  id: string
  title: string
  description: string
  memo: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  status: TodoStatus
  priority: number
  progress: number
  start_date: string | null
  due_date: string | null
  sort_order: number
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  /** 1 のとき、繰り返しの次回分にサブタスクを未完了状態で複製する */
  recurrence_copy_subtasks: number
  /** サブ担当（サーバー版のみ。デスクトップ版では常に未設定） */
  co_assignees?: TodoCoAssignee[]
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
}

export interface TodoCoAssignee {
  user_id: string
  display_name: string
  color: string
}

export interface TodoDependency {
  id: string
  predecessor_todo_id: string
  successor_todo_id: string
  type: 'finish_to_start'
  lag_days: number
  created_at: string
}

export interface SubTask {
  id: string
  todo_id: string
  title: string
  description: string
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  start_date: string | null
  due_date: string | null
  progress: number
  done: number  // SQLite INTEGER (0 or 1)
  completed_at: string | null
  sort_order: number
  created_at: string
}

export interface CalendarSubTask extends SubTask {
  todo_title: string
  todo_status: TodoStatus
  category_color: string | null
}

export interface CreateSubTaskInput {
  title: string
  description?: string
  assignee_id?: string | null
  start_date?: string | null
  due_date?: string | null
  progress?: number
}

export interface UpdateSubTaskInput {
  title?: string
  description?: string
  assignee_id?: string | null
  start_date?: string | null
  due_date?: string | null
  progress?: number
  done?: boolean
}

export interface CreateTodoInput {
  title: string
  description?: string
  memo?: string
  category_id?: string | null
  assignee_id?: string | null
  /** 省略時は 'not_started'。カンバンの列からの追加でその列のステータスを指定する */
  status?: 'not_started' | 'active' | 'done'
  priority?: number
  progress?: number
  start_date?: string | null
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
  recurrence_copy_subtasks?: number
}

export interface UpdateTodoInput {
  title?: string
  description?: string
  memo?: string
  category_id?: string | null
  assignee_id?: string | null
  status?: TodoStatus
  priority?: number
  progress?: number
  start_date?: string | null
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
  recurrence_copy_subtasks?: number
  /** 指定された場合、サブ担当をこのユーザーID群で置き換える（サーバー版のみ有効） */
  co_assignee_ids?: string[]
}

export interface WorkLog {
  id: string
  todo_id: string
  start_time: string
  end_time: string
  duration_seconds: number
  note: string
  created_at: string
}

export interface RunningState {
  todo_id: string
  start_time: string
}

export interface TodayWorkLog extends WorkLog {
  title: string
  category: string | null
}

export interface WorkLogSummaryRow {
  id: string
  todo_id: string
  title: string
  category_name: string | null
  category_color: string | null
  start_time: string
  end_time: string
  duration_seconds: number
  note: string
}

export interface DailyPlanItem {
  id: string
  plan_date: string
  todo_id: string
  scheduled_start: string | null
  estimated_minutes: number | null
  lane: number
  sort_order: number
  created_at: string
  updated_at: string
  title: string
  description: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  status: TodoStatus
  priority: number
  progress: number
  start_date: string | null
  due_date: string | null
}

export interface UpdateDailyPlanItemInput {
  scheduled_start?: string | null
  estimated_minutes?: number | null
  lane?: number
}

export type OverviewTaskReason = 'overdue' | 'dueSoon' | 'highPriority' | 'stale' | 'dueToday' | 'nearlyDone'

export interface OverviewSummary {
  totalTasks: number
  activeTasks: number
  doneTasks: number
  completionRate: number
  completionScore: number
  avgActiveProgress: number
  overdueTasks: number
  dueSoonTasks: number
  todayMinutes: number
  weekMinutes: number
  completedSubTasksThisWeek: number
}

export interface OverviewCategoryStat {
  categoryId: string | null
  categoryName: string
  categoryColor: string | null
  totalTasks: number
  activeTasks: number
  doneTasks: number
  overdueTasks: number
  completionRate: number
  completionScore: number
  avgActiveProgress: number
}

export interface OverviewTaskItem {
  todoId: string
  title: string
  categoryName: string | null
  categoryColor: string | null
  priority: number
  progress: number
  dueDate: string | null
  updatedAt: string
  reason: OverviewTaskReason
  subTaskDone: number
  subTaskTotal: number
}

export interface OverviewCompletedSubTaskItem {
  id: string
  todo_id: string
  title: string
  completed_at: string
  todo_title: string
  category_name: string | null
  category_color: string | null
}

export interface OverviewData {
  summary: OverviewSummary
  categories: OverviewCategoryStat[]
  risks: OverviewTaskItem[]
  dueToday: OverviewTaskItem[]
  highPriority: OverviewTaskItem[]
  nearlyDone: OverviewTaskItem[]
  stale: OverviewTaskItem[]
  completedSubTasks: OverviewCompletedSubTaskItem[]
}
