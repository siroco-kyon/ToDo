import crypto from 'crypto'
import { getDb } from './connection'
import type { PublicUser, UserRecord, UserRole } from './types'

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
    .prepare('SELECT * FROM Users ORDER BY is_active DESC, display_name ASC')
    .all() as UserRecord[]
  return rows.map(toPublicUser)
}

export function getUserById(id: string): UserRecord | undefined {
  return getDb().prepare('SELECT * FROM Users WHERE id = ?').get(id) as UserRecord | undefined
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
