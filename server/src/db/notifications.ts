import crypto from 'crypto'
import { getDb } from './connection'
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

function localDateKey(offsetDays = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDayStartIso(): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.toISOString()
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
  const exists = db.prepare("SELECT 1 FROM Notifications WHERE user_id = ? AND type = 'task_due' AND todo_id = ? AND created_at >= ? LIMIT 1")
  for (const row of rows) {
    if (exists.get(userId, row.id, localDayStartIso())) continue
    createNotification({
      userId, type: 'task_due', todoId: row.id,
      title: row.due_date < today ? '期限を過ぎたタスクがあります' : '期限が近いタスクがあります',
      body: `「${row.title}」の期限は${row.due_date}です`
    })
  }
}

export function listNotifications(userId: string, limit = 50): UserNotification[] {
  ensureDueNotifications(userId)
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
