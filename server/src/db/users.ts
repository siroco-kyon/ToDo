import crypto from 'crypto'
import { stopTimer } from './timer'
import { getDb } from './connection'
import type { PublicUser, UserRecord, UserRole, UserDeletePreview } from './types'

const USER_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6',
  '#ef4444', '#10b981', '#3b82f6', '#f97316', '#a855f7'
]

export function pickDefaultColor(): string {
  const count = countUsers()
  return USER_COLORS[count % USER_COLORS.length]
}

export function toPublicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    username: record.username,
    display_name: record.display_name,
    role: record.role,
    color: record.color,
    is_active: record.is_active,
    created_at: record.created_at,
    updated_at: record.updated_at
  }
}

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM Users').get() as { c: number }).c
}

export function listUsers(): PublicUser[] {
  const rows = getDb()
    .prepare('SELECT * FROM Users WHERE deleted_at IS NULL ORDER BY is_active DESC, display_name ASC')
    .all() as UserRecord[]
  return rows.map(toPublicUser)
}

export function getUserById(id: string): UserRecord | undefined {
  return getDb().prepare('SELECT * FROM Users WHERE id = ? AND deleted_at IS NULL').get(id) as UserRecord | undefined
}

export function getUserByUsername(username: string): UserRecord | undefined {
  return getDb().prepare('SELECT * FROM Users WHERE username = ?').get(username) as UserRecord | undefined
}

export interface CreateUserInput {
  username: string
  display_name: string
  password_hash: string
  role?: UserRole
  color?: string
}

export function createUser(input: CreateUserInput): PublicUser {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const color = input.color ?? pickDefaultColor()
  getDb()
    .prepare(
      `INSERT INTO Users (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(id, input.username, input.display_name, input.password_hash, input.role ?? 'member', color, now, now)
  return toPublicUser(getUserById(id)!)
}

export interface UpdateUserInput {
  display_name?: string
  role?: UserRole
  color?: string
  is_active?: boolean
}

export function updateUser(id: string, input: UpdateUserInput): PublicUser {
  if (!getUserById(id)) throw new Error('ユーザーが見つかりません')
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [new Date().toISOString()]

  if (input.display_name !== undefined) { fields.push('display_name = ?'); values.push(input.display_name) }
  if (input.role !== undefined) { fields.push('role = ?'); values.push(input.role) }
  if (input.color !== undefined) { fields.push('color = ?'); values.push(input.color) }
  if (input.is_active !== undefined) { fields.push('is_active = ?'); values.push(input.is_active ? 1 : 0) }

  values.push(id)
  getDb().prepare(`UPDATE Users SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  return toPublicUser(getUserById(id)!)
}

export function setUserPassword(id: string, passwordHash: string): void {
  getDb()
    .prepare('UPDATE Users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, new Date().toISOString(), id)
}

// Deleted records remain for authorship and work history; login IDs stay reserved.
export function getUserDeletePreview(id: string): UserDeletePreview {
  const user = getUserById(id)
  if (!user) throw new Error('ユーザーが見つかりません')
  const count = (sql: string): number => (getDb().prepare(sql).get(id) as { count: number }).count
  return {
    user: toPublicUser(user),
    taskCount: count('SELECT COUNT(*) AS count FROM Todos WHERE assignee_id = ?'),
    subtaskCount: count('SELECT COUNT(*) AS count FROM SubTasks WHERE assignee_id = ?'),
    coAssignedTaskCount: count('SELECT COUNT(*) AS count FROM TodoCoAssignees WHERE user_id = ?')
  }
}

export function deleteUser(id: string, actorId: string, confirmationUsername: unknown): void {
  const db = getDb()
  db.transaction(() => {
    const actor = getUserById(actorId)
    if (!actor || actor.role !== 'admin' || actor.is_active !== 1) throw new Error('管理者権限が必要です')
    const target = getUserById(id)
    if (!target) throw new Error('ユーザーが見つかりません')
    if (id === actorId) throw new Error('自分自身を削除することはできません')
    if (confirmationUsername !== target.username) throw new Error('確認用のログインIDが一致しません')
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM Users WHERE id != ? AND role = 'admin' AND is_active = 1 AND deleted_at IS NULL").get(id) as { count: number }
    if (remaining.count === 0) throw new Error('有効な管理者を最低1人残してください')
    if (db.prepare('SELECT 1 FROM RunningState WHERE user_id = ?').get(id)) stopTimer(id, 'メンバーを削除したため計測を停止しました')
    const now = new Date().toISOString()
    db.prepare('UPDATE Todos SET assignee_id = NULL, updated_at = ? WHERE assignee_id = ?').run(now, id)
    db.prepare('UPDATE SubTasks SET assignee_id = NULL WHERE assignee_id = ?').run(id)
    db.prepare('DELETE FROM TodoCoAssignees WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM Sessions WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM TodoSubscriptions WHERE user_id = ?').run(id)
    db.prepare('UPDATE Users SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
  })()
}

/** Reject stale assignment requests from clients opened before deletion. */
export function assertAssignableUser(id: string | null | undefined): void {
  if (id && !getUserById(id)) throw new Error('担当者が見つかりません。再読み込みしてください')
}
