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

export function listNotifications(userId: string, limit = 50): UserNotification[] {
  return getDb()
    .prepare(`${NOTIFICATION_SELECT} WHERE n.user_id = ? AND n.read_at IS NULL ORDER BY n.created_at DESC LIMIT ?`)
    .all(userId, clampLimit(limit)) as UserNotification[]
}

export function countUnreadNotifications(userId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS count FROM Notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as { count: number }
  ).count
}

export function createNotification(input: CreateNotificationInput): UserNotification | null {
  if (!input.userId || input.userId === input.actorUserId) return null

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
  getDb()
    .prepare('DELETE FROM Notifications WHERE user_id = ? AND id = ?')
    .run(userId, id)
  return notification
}

export function markAllNotificationsRead(userId: string): void {
  getDb()
    .prepare('DELETE FROM Notifications WHERE user_id = ?')
    .run(userId)
}
