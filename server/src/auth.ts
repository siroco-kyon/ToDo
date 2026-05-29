import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import type { NextFunction, Request, Response } from 'express'
import { getDb } from './db/connection'
import { countUsers, createUser, getUserById, toPublicUser } from './db/users'
import type { PublicUser, Session, UserRecord } from './db/types'
import { ADMIN_PASSWORD, ADMIN_USERNAME, SESSION_COOKIE, SESSION_TTL_DAYS } from './config'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser
      sessionToken?: string
    }
  }
}

const BCRYPT_ROUNDS = 10

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS)
}

export function verifyPassword(plain: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(plain, hash)
  } catch {
    return false
  }
}

function addDaysIso(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex')
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO Sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, addDaysIso(SESSION_TTL_DAYS))
  return token
}

export function getSessionUser(token: string | undefined): PublicUser | null {
  if (!token) return null
  const session = getDb().prepare('SELECT * FROM Sessions WHERE token = ?').get(token) as Session | undefined
  if (!session) return null
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    destroySession(token)
    return null
  }
  const user = getUserById(session.user_id)
  if (!user || user.is_active !== 1) return null
  return toPublicUser(user)
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM Sessions WHERE token = ?').run(token)
}

export function cleanupExpiredSessions(): void {
  getDb().prepare('DELETE FROM Sessions WHERE expires_at <= ?').run(new Date().toISOString())
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_DAYS * 86400000,
    path: '/'
  })
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

/** Attaches req.user when a valid session cookie is present. Never blocks. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined
  const user = getSessionUser(token)
  if (user) {
    req.user = user
    req.sessionToken = token
  }
  next()
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '認証が必要です' })
    return
  }
  next()
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '認証が必要です' })
    return
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: '管理者権限が必要です' })
    return
  }
  next()
}

export function verifyCredentials(username: string, password: string): UserRecord | null {
  const user = getDb().prepare('SELECT * FROM Users WHERE username = ?').get(username) as UserRecord | undefined
  if (!user || user.is_active !== 1) return null
  if (!verifyPassword(password, user.password_hash)) return null
  return user
}

/**
 * On a fresh database, create the first admin account so the operator can log
 * in and issue the rest of the team's accounts. The password comes from the
 * ADMIN_PASSWORD env var; if unset, a random one is generated and printed once
 * to the server console.
 */
export function seedAdminUser(): void {
  if (countUsers() > 0) return

  let password = ADMIN_PASSWORD
  let generated = false
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url')
    generated = true
  }

  createUser({
    username: ADMIN_USERNAME,
    display_name: '管理者',
    password_hash: hashPassword(password),
    role: 'admin'
  })

  console.log('[auth] 初期管理者アカウントを作成しました')
  console.log(`[auth]   ユーザー名: ${ADMIN_USERNAME}`)
  if (generated) {
    console.log(`[auth]   初期パスワード: ${password}`)
    console.log('[auth]   ※このパスワードは今だけ表示されます。ログイン後に変更してください。')
  } else {
    console.log('[auth]   パスワード: (ADMIN_PASSWORD 環境変数で設定済み)')
  }
}
