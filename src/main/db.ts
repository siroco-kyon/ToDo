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
      category_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER DEFAULT 2,
      progress INTEGER DEFAULT 0,
      due_date TEXT,
      sort_order INTEGER DEFAULT 0,
      recurrence TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (category_id) REFERENCES Categories(id)
    );

    CREATE TABLE IF NOT EXISTS SubTasks (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id)
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

    CREATE TABLE IF NOT EXISTS Settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

function migrateDb(): void {
  const todoColumns = db.prepare('PRAGMA table_info(Todos)').all() as { name: string }[]

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
  if (!todoColumns.some((c) => c.name === 'recurrence')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN recurrence TEXT DEFAULT NULL').run()
  }
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

// ─── Categories ───────────────────────────────────────────────

export function getAllCategories(): Category[] {
  return db.prepare('SELECT * FROM Categories ORDER BY sort_order ASC, name ASC').all() as Category[]
}

export function createCategory(name: string, color: string): Category {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO Categories (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    color,
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

export function updateCategory(id: string, name: string, color: string, description: string): Category {
  db.prepare('UPDATE Categories SET name = ?, color = ?, description = ? WHERE id = ?').run(
    name, color, description, id
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

export function createTodo(data: CreateTodoInput): Todo {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  // 新規タスクはsort_orderを最小値-1にして先頭に表示
  const minOrder = (db.prepare('SELECT COALESCE(MIN(sort_order), 0) as m FROM Todos').get() as { m: number }).m
  db.prepare(
    `INSERT INTO Todos (id, title, description, category_id, status, priority, progress, due_date, sort_order, recurrence, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, data.title, data.description ?? '', data.category_id ?? null, data.priority ?? 3, data.progress ?? 0, data.due_date ?? null, minOrder - 1, data.recurrence ?? null, now, now)
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

export function updateTodo(id: string, data: UpdateTodoInput): Todo {
  const now = new Date().toISOString()
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title) }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
  if (data.category_id !== undefined) { fields.push('category_id = ?'); values.push(data.category_id) }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status) }
  if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority) }
  if (data.progress !== undefined) { fields.push('progress = ?'); values.push(data.progress) }
  if (data.due_date !== undefined) { fields.push('due_date = ?'); values.push(data.due_date) }
  if (data.recurrence !== undefined) { fields.push('recurrence = ?'); values.push(data.recurrence) }

  values.push(id)
  db.prepare(`UPDATE Todos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return db
    .prepare(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM Todos t LEFT JOIN Categories c ON t.category_id = c.id WHERE t.id = ?`
    )
    .get(id) as Todo
}

export function archiveTodo(id: string): void {
  const now = new Date().toISOString()
  db.prepare(`UPDATE Todos SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`).run(
    now,
    now,
    id
  )
}

export function unarchiveTodo(id: string): void {
  const now = new Date().toISOString()
  db.prepare(`UPDATE Todos SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?`).run(now, id)
}

export function deleteTodo(id: string): void {
  db.prepare('DELETE FROM WorkLogs WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM RunningState WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM SubTasks WHERE todo_id = ?').run(id)
  db.prepare('DELETE FROM Todos WHERE id = ?').run(id)
}

// ─── SubTasks ─────────────────────────────────────────────────

export function getSubTasksByTodo(todoId: string): SubTask[] {
  return db.prepare('SELECT * FROM SubTasks WHERE todo_id = ? ORDER BY sort_order ASC, created_at ASC').all(todoId) as SubTask[]
}

export function createSubTask(todoId: string, title: string): SubTask {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM SubTasks WHERE todo_id = ?').get(todoId) as { m: number }).m
  db.prepare('INSERT INTO SubTasks (id, todo_id, title, done, sort_order, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, todoId, title, maxOrder + 1, now)
  return db.prepare('SELECT * FROM SubTasks WHERE id = ?').get(id) as SubTask
}

export function updateSubTask(id: string, data: { title?: string; done?: boolean }): SubTask {
  if (data.title !== undefined) {
    db.prepare('UPDATE SubTasks SET title = ? WHERE id = ?').run(data.title, id)
  }
  if (data.done !== undefined) {
    db.prepare('UPDATE SubTasks SET done = ? WHERE id = ?').run(data.done ? 1 : 0, id)
  }
  return db.prepare('SELECT * FROM SubTasks WHERE id = ?').get(id) as SubTask
}

export function deleteSubTask(id: string): void {
  db.prepare('DELETE FROM SubTasks WHERE id = ?').run(id)
}

// ─── Timer ────────────────────────────────────────────────────

export function startTimer(todoId: string): RunningState {
  const existing = db.prepare('SELECT * FROM RunningState WHERE id = 1').get()
  if (existing) {
    throw new Error('既に実行中のタイマーがあります')
  }
  const now = new Date().toISOString()
  db.prepare('INSERT INTO RunningState (id, todo_id, start_time) VALUES (1, ?, ?)').run(todoId, now)
  return { todo_id: todoId, start_time: now }
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

// ─── Settings ─────────────────────────────────────────────────

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM Settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO Settings (key, value) VALUES (?, ?)').run(key, value)
}

// ─── Types ────────────────────────────────────────────────────

export interface Category {
  id: string
  name: string
  color: string
  description: string
  sort_order: number
  created_at: string
}

export interface Todo {
  id: string
  title: string
  description: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  status: 'active' | 'done' | 'archived'
  priority: number
  progress: number
  due_date: string | null
  sort_order: number
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface SubTask {
  id: string
  todo_id: string
  title: string
  done: number  // SQLite INTEGER (0 or 1)
  sort_order: number
  created_at: string
}

export interface CreateTodoInput {
  title: string
  description?: string
  category_id?: string | null
  priority?: number
  progress?: number
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
}

export interface UpdateTodoInput {
  title?: string
  description?: string
  category_id?: string | null
  status?: 'active' | 'done' | 'archived'
  priority?: number
  progress?: number
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
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
