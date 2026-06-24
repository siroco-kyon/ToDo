import type Database from 'better-sqlite3'

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      color TEXT NOT NULL DEFAULT '#6366f1',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#6366f1',
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      is_private INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      memo TEXT DEFAULT '',
      category_id TEXT,
      assignee_id TEXT,
      created_by TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      priority INTEGER DEFAULT 3,
      progress INTEGER DEFAULT 0,
      start_date TEXT,
      due_date TEXT,
      sort_order INTEGER DEFAULT 0,
      recurrence TEXT DEFAULT NULL,
      recurrence_copy_subtasks INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      archived_at TEXT,
      FOREIGN KEY (category_id) REFERENCES Categories(id),
      FOREIGN KEY (assignee_id) REFERENCES Users(id),
      FOREIGN KEY (created_by) REFERENCES Users(id)
    );

    CREATE TABLE IF NOT EXISTS SubTasks (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      assignee_id TEXT,
      start_date TEXT,
      due_date TEXT,
      done INTEGER DEFAULT 0,
      completed_at TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id),
      FOREIGN KEY (assignee_id) REFERENCES Users(id)
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
      user_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id),
      FOREIGN KEY (user_id) REFERENCES Users(id)
    );

    CREATE TABLE IF NOT EXISTS RunningState (
      user_id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS DailyPlanItems (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scheduled_start TEXT,
      estimated_minutes INTEGER,
      lane INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plan_date, todo_id, user_id),
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS UserSettings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS TodoCoAssignees (
      todo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (todo_id, user_id),
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS TodoChangeLogs (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      user_id TEXT,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ProgressNotes (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      user_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE SET NULL
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
      FOREIGN KEY (parent_comment_id) REFERENCES ProgressNoteComments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ProgressNoteReactions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      user_id TEXT,
      actor_key TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(note_id, actor_key, emoji),
      FOREIGN KEY (note_id) REFERENCES ProgressNotes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor_user_id TEXT,
      todo_id TEXT,
      progress_note_id TEXT,
      progress_comment_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT,
      FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES Users(id) ON DELETE SET NULL,
      FOREIGN KEY (todo_id) REFERENCES Todos(id) ON DELETE CASCADE,
      FOREIGN KEY (progress_note_id) REFERENCES ProgressNotes(id) ON DELETE CASCADE,
      FOREIGN KEY (progress_comment_id) REFERENCES ProgressNoteComments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_todos_assignee ON Todos(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_todos_status ON Todos(status);
    CREATE INDEX IF NOT EXISTS idx_worklogs_user ON WorkLogs(user_id);
    CREATE INDEX IF NOT EXISTS idx_worklogs_todo ON WorkLogs(todo_id);
    CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON SubTasks(todo_id);
    CREATE INDEX IF NOT EXISTS idx_plan_date_user ON DailyPlanItems(plan_date, user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON Sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_co_assignees_user ON TodoCoAssignees(user_id);
    CREATE INDEX IF NOT EXISTS idx_todo_changes_todo_created ON TodoChangeLogs(todo_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_todo_changes_user_created ON TodoChangeLogs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_progress_notes_todo ON ProgressNotes(todo_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_progress_notes_user ON ProgressNotes(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_progress_comments_note ON ProgressNoteComments(note_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_progress_reactions_note ON ProgressNoteReactions(note_id, emoji);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON Notifications(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON Notifications(user_id, read_at, created_at);
  `)
}

/**
 * Idempotent column additions for forward compatibility across server
 * versions. Safe to run on every boot.
 */
export function runMigrations(db: Database.Database): void {
  const todoColumns = db.prepare('PRAGMA table_info(Todos)').all() as { name: string }[]
  if (!todoColumns.some((c) => c.name === 'assignee_id')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN assignee_id TEXT').run()
  }
  if (!todoColumns.some((c) => c.name === 'created_by')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN created_by TEXT').run()
  }
  if (!todoColumns.some((c) => c.name === 'recurrence_copy_subtasks')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN recurrence_copy_subtasks INTEGER DEFAULT 0').run()
  }
  if (!todoColumns.some((c) => c.name === 'completed_at')) {
    db.prepare('ALTER TABLE Todos ADD COLUMN completed_at TEXT').run()
  }
  db.prepare("UPDATE Todos SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL").run()
  db.prepare('CREATE INDEX IF NOT EXISTS idx_todos_completed ON Todos(assignee_id, status, completed_at)').run()

  const subTaskColumns = db.prepare('PRAGMA table_info(SubTasks)').all() as { name: string }[]
  if (!subTaskColumns.some((c) => c.name === 'assignee_id')) {
    db.prepare('ALTER TABLE SubTasks ADD COLUMN assignee_id TEXT').run()
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_subtasks_assignee ON SubTasks(assignee_id)').run()

  const progressNoteColumns = db.prepare('PRAGMA table_info(ProgressNotes)').all() as { name: string }[]
  if (!progressNoteColumns.some((c) => c.name === 'updated_at')) {
    db.prepare("ALTER TABLE ProgressNotes ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''").run()
    db.prepare("UPDATE ProgressNotes SET updated_at = created_at WHERE updated_at = ''").run()
  }

  const progressCommentColumns = db.prepare('PRAGMA table_info(ProgressNoteComments)').all() as { name: string }[]
  if (!progressCommentColumns.some((c) => c.name === 'parent_comment_id')) {
    db.prepare('ALTER TABLE ProgressNoteComments ADD COLUMN parent_comment_id TEXT').run()
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_progress_comments_parent ON ProgressNoteComments(parent_comment_id, created_at)').run()

  const categoryColumns = db.prepare('PRAGMA table_info(Categories)').all() as { name: string }[]
  if (!categoryColumns.some((c) => c.name === 'is_private')) {
    db.prepare('ALTER TABLE Categories ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0').run()
  }
}

export function insertDefaultSettings(db: Database.Database): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO Settings (key, value) VALUES (?, ?)')
  stmt.run('archiveRetentionDays', '90')
  stmt.run('workLogRetentionDays', '0')
  stmt.run('notifyBeforeDays', '0')
  stmt.run('mdHeaderTpl', '# 作業ログ - {{date}}')
  stmt.run('mdTaskTpl', '## {{title}}{{category}}\n\n**合計: {{task_min}}分**')
  stmt.run('mdEntryTpl', '- {{start}} ～ {{end}} ({{min}}分){{note}}')
  stmt.run('mdFooterTpl', '**本日合計: {{total_min}}分**')
}
