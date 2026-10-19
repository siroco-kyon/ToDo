import crypto from 'crypto'
import { getDb } from './connection'
import { getSetting } from './settings'
import type { NotificationType, UserNotification } from './types'

interface CreateNotificationInput {
  userId: string
  type: NotificationType
  actorUserId?: string | null
  todoId?: string | null
  progressNoteId?: string | null
  progressCommentId?: string | null
  title: string
  body: string
}

const NOTIFICATION_SELECT = `
  SELECT n.*,
         actor.display_name AS actor_name,
         actor.color AS actor_color,
         t.title AS todo_title
  FROM Notifications n
  LEFT JOIN Users actor ON n.actor_user_id = actor.id
  LEFT JOIN Todos t ON n.todo_id = t.id
`

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50
  return Math.min(100, Math.max(1, Math.floor(limit)))
}

function getNotificationForUser(userId: string, id: string): UserNotification | undefined {
  return getDb()
    .prepare(`${NOTIFICATION_SELECT} WHERE n.user_id = ? AND n.id = ?`)
    .get(userId, id) as UserNotification | undefined
}

function localDateKey(offsetDays = 0, base = new Date()): string {
  const date = new Date(base)
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDayStartIso(base = new Date()): string {
  const date = new Date(base)
  date.setHours(0, 0, 0, 0)
  return date.toISOString()
}

/** 定例の曜日（0=日〜6=土）の設定のキー。管理者が設定画面で選ぶ。空なら報告のリマインドを出さない */
export const REPORT_MEETING_WEEKDAY_SETTING = 'reportMeetingWeekday'
/** 定例の前日の、この時刻（サーバーの時計の時）を過ぎたらリマインドを出す */
export const REPORT_REMINDER_HOUR = 17
/** この日数のあいだ進捗ログもメモの更新もない担当タスクを「報告がまだ」とする */
export const REPORT_REMINDER_LOOKBACK_DAYS = 7

/**
 * 報告がまだの担当タスク。直近7日に進捗ログもメモの更新もない、未着手・進行中のタスク
 * （保留中・完了・ToDoリスト・まだ始まらないタスクは除く）。報告のリマインドとチームタブの「報告なし」で使う
 */
export function listUnreportedTodos(userId: string, now = new Date(), includePrivate = true): Array<{ id: string; title: string }> {
  const since = new Date(now)
  since.setDate(since.getDate() - REPORT_REMINDER_LOOKBACK_DAYS)
  const sinceIso = since.toISOString()
  const privateClause = includePrivate ? '' : 'AND COALESCE(c.is_private, 0) = 0'
  return getDb().prepare(
    `SELECT t.id, t.title FROM Todos t LEFT JOIN Categories c ON t.category_id = c.id
     WHERE t.assignee_id = ? AND t.status IN ('not_started', 'active') AND COALESCE(t.list_mode, 0) = 0
       AND (t.start_date IS NULL OR substr(t.start_date, 1, 10) <= ?)
       AND NOT EXISTS (SELECT 1 FROM ProgressNotes n WHERE n.todo_id = t.id AND n.created_at >= ?)
       AND NOT EXISTS (SELECT 1 FROM TodoChangeLogs l WHERE l.todo_id = t.id AND l.field = 'memo' AND l.created_at >= ?)
       ${privateClause}
     ORDER BY t.due_date IS NULL, t.due_date, t.title`
  ).all(userId, localDateKey(0, now), sinceIso, sinceIso) as Array<{ id: string; title: string }>
}

/**
 * 報告のリマインド。定例の前日の17時を過ぎたら、直近7日に進捗ログもメモの更新もない担当タスク
 * （未着手・進行中。保留中・完了・ToDoリスト・まだ始まらないタスクは除く）がある人に1日1回知らせる
 */
export function ensureReportReminder(userId: string, now = new Date()): UserNotification | null {
  const setting = getSetting(REPORT_MEETING_WEEKDAY_SETTING)
  if (setting == null || !/^[0-6]$/.test(setting)) return null
  const reminderWeekday = (Number(setting) + 6) % 7
  if (now.getDay() !== reminderWeekday || now.getHours() < REPORT_REMINDER_HOUR) return null

  const db = getDb()
  const sent = db.prepare("SELECT 1 FROM Notifications WHERE user_id = ? AND type = 'report_reminder' AND created_at >= ? LIMIT 1")
    .get(userId, localDayStartIso(now))
  if (sent) return null

  const rows = listUnreportedTodos(userId, now)
  if (rows.length === 0) return null

  return createNotification({
    userId,
    type: 'report_reminder',
    title: '明日は定例です',
    body: `報告がまだのタスクが${rows.length}件あります（「${rows[0].title}」${rows.length > 1 ? 'ほか' : ''}）`
  })
}

/** 有効なメンバー全員の報告のリマインドを確かめ、出した人の ID を返す（サーバーの1分ごとの点検から呼ぶ） */
export function runReportReminders(now = new Date()): string[] {
  const userIds = (getDb().prepare('SELECT id FROM Users WHERE is_active = 1').all() as Array<{ id: string }>).map((row) => row.id)
  return userIds.filter((userId) => ensureReportReminder(userId, now) != null)
}

/** 期限の通知の見出しと本文（今の期限で書く。日付は画面と同じ「10/22」の書き方） */
function dueNotificationText(title: string, dueDate: string, today: string): { title: string; body: string } {
  const [, month, day] = dueDate.slice(0, 10).split('-').map(Number)
  return {
    title: dueDate.slice(0, 10) < today ? '期限を過ぎたタスクがあります' : '期限が近いタスクがあります',
    body: `「${title}」の期限は${month}/${day}です`
  }
}

function ensureDueNotifications(userId: string): void {
  const db = getDb()
  const today = localDateKey()
  const rows = db.prepare(
    `SELECT DISTINCT t.id, t.title, t.due_date
     FROM Todos t LEFT JOIN TodoCoAssignees ca ON ca.todo_id = t.id
     WHERE t.status NOT IN ('done', 'archived') AND t.due_date IS NOT NULL
       AND t.due_date <= ? AND (t.assignee_id = ? OR ca.user_id = ?)`
  ).all(localDateKey(3), userId, userId) as Array<{ id: string; title: string; due_date: string }>
  const current = new Map(rows.map((row) => [row.id, row]))

  // まだ読んでいない期限の通知を、今のタスクに合わせる。完了した・期限を延ばした・担当を外れたタスクの通知は既読にし、
  // 期限や名前が変わっただけなら今の内容に書き直す（古い期限のまま知らせ続けないように）
  const unread = db.prepare(
    "SELECT id, todo_id, title, body FROM Notifications WHERE user_id = ? AND type = 'task_due' AND read_at IS NULL"
  ).all(userId) as Array<{ id: string; todo_id: string | null; title: string; body: string }>
  const markRead = db.prepare('UPDATE Notifications SET read_at = ? WHERE id = ?')
  const rewrite = db.prepare('UPDATE Notifications SET title = ?, body = ? WHERE id = ?')
  const now = new Date().toISOString()
  for (const notification of unread) {
    const todo = notification.todo_id ? current.get(notification.todo_id) : undefined
    if (!todo) {
      markRead.run(now, notification.id)
      continue
    }
    const text = dueNotificationText(todo.title, todo.due_date, today)
    if (text.title !== notification.title || text.body !== notification.body) rewrite.run(text.title, text.body, notification.id)
  }

  const exists = db.prepare("SELECT 1 FROM Notifications WHERE user_id = ? AND type = 'task_due' AND todo_id = ? AND created_at >= ? LIMIT 1")
  for (const row of rows) {
    if (exists.get(userId, row.id, localDayStartIso())) continue
    createNotification({ userId, type: 'task_due', todoId: row.id, ...dueNotificationText(row.title, row.due_date, today) })
  }
}

export function listNotifications(userId: string, limit = 50): UserNotification[] {
  ensureDueNotifications(userId)
  ensureReportReminder(userId)
  const db = getDb()
  const unread = db
    .prepare(`${NOTIFICATION_SELECT} WHERE n.user_id = ? AND n.read_at IS NULL ORDER BY n.created_at DESC`)
    .all(userId) as UserNotification[]
  const recent = db
    .prepare(`${NOTIFICATION_SELECT} WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ?`)
    .all(userId, clampLimit(limit)) as UserNotification[]
  return Array.from(new Map([...unread, ...recent].map((notification) => [notification.id, notification])).values())
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function countUnreadNotifications(userId: string): number {
  ensureDueNotifications(userId)
  ensureReportReminder(userId)
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS count FROM Notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as { count: number }
  ).count
}

export function createNotification(input: CreateNotificationInput): UserNotification | null {
  if (!input.userId || input.userId === input.actorUserId) return null
  const preference = getDb().prepare('SELECT enabled FROM NotificationPreferences WHERE user_id = ? AND type = ?').get(input.userId, input.type) as { enabled: number } | undefined
  if (preference?.enabled === 0) return null

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO Notifications (
        id, user_id, type, actor_user_id, todo_id, progress_note_id,
        progress_comment_id, title, body, created_at, read_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      id,
      input.userId,
      input.type,
      input.actorUserId ?? null,
      input.todoId ?? null,
      input.progressNoteId ?? null,
      input.progressCommentId ?? null,
      input.title,
      input.body,
      now
    )

  return getNotificationForUser(input.userId, id) ?? null
}

export function markNotificationRead(userId: string, id: string): UserNotification | undefined {
  const notification = getNotificationForUser(userId, id)
  if (!notification) return undefined
  getDb()
    .prepare('UPDATE Notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ? AND id = ?')
    .run(new Date().toISOString(), userId, id)
  return getNotificationForUser(userId, id)
}

export function markAllNotificationsRead(userId: string): void {
  getDb()
    .prepare('UPDATE Notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ?')
    .run(new Date().toISOString(), userId)
}
