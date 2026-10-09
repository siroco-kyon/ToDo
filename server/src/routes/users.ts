import { broadcastDataChanged, disconnectUser } from '../realtime'
import { Router } from 'express'
import { hashPassword, requireAdmin, requireAuth, verifyPassword } from '../auth'
import {
  createUser,
  deleteUser,
  getUserDeletePreview,
  getUserById,
  getUserByUsername,
  listUsers,
  setUserPassword,
  toPublicUser,
  updateUser
} from '../db/users'
import type { UserRole } from '../db/types'

export const usersRouter = Router()

const MIN_PASSWORD_LENGTH = 6
const VALID_ROLES: UserRole[] = ['admin', 'member']

/** Any authenticated user can change their own password. */
usersRouter.post('/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {}
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'パスワードを入力してください' })
    return
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください` })
    return
  }

  const record = getUserById(req.user!.id)
  if (!record || !verifyPassword(currentPassword, record.password_hash)) {
    res.status(400).json({ error: '現在のパスワードが正しくありません' })
    return
  }

  setUserPassword(record.id, hashPassword(newPassword))
  res.json({ ok: true })
})

// ─── Admin-only user management ───────────────────────────────

usersRouter.get('/', requireAuth, (_req, res) => {
  res.json(listUsers())
})

usersRouter.post('/', requireAdmin, (req, res) => {
  const { username, display_name, password, role, color } = req.body ?? {}
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'ユーザー名を入力してください' })
    return
  }
  if (typeof display_name !== 'string' || !display_name.trim()) {
    res.status(400).json({ error: '表示名を入力してください' })
    return
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください` })
    return
  }
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    res.status(400).json({ error: '権限の指定が不正です' })
    return
  }
  if (getUserByUsername(username)) {
    res.status(400).json({ error: 'そのユーザー名は既に使われています' })
    return
  }

  const user = createUser({
    username: username.trim(),
    display_name: display_name.trim(),
    password_hash: hashPassword(password),
    role,
    color
  })
  broadcastDataChanged('user')
  res.json(user)
})

usersRouter.put('/:id', requireAdmin, (req, res) => {
  const target = getUserById(req.params.id)
  if (!target) {
    res.status(404).json({ error: 'ユーザーが見つかりません' })
    return
  }

  const { display_name, role, color, is_active } = req.body ?? {}
  if (is_active !== undefined && typeof is_active !== 'boolean') {
    res.status(400).json({ error: '有効状態の指定が不正です' })
    return
  }
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    res.status(400).json({ error: '権限の指定が不正です' })
    return
  }

  // Guard against an admin locking themselves out.
  const isSelf = req.user!.id === target.id
  if (isSelf && is_active === false) {
    res.status(400).json({ error: '自分自身を無効化することはできません' })
    return
  }
  if (isSelf && role !== undefined && role !== 'admin') {
    res.status(400).json({ error: '自分自身の管理者権限は外せません' })
    return
  }

  try {
    const user = updateUser(target.id, { display_name, role, color, is_active })
    if (is_active === false) disconnectUser(target.id)
    for (const scope of ['user', 'todo', 'subtask', 'plan', 'progress'] as const) broadcastDataChanged(scope)
    res.json(user)
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'メンバーを更新できませんでした' })
  }
})

usersRouter.post('/:id/password', requireAdmin, (req, res) => {
  const target = getUserById(req.params.id)
  if (!target) {
    res.status(404).json({ error: 'ユーザーが見つかりません' })
    return
  }
  const { password } = req.body ?? {}
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください` })
    return
  }
  setUserPassword(target.id, hashPassword(password))
  res.json({ user: toPublicUser(getUserById(target.id)!) })
})

usersRouter.get('/:id/delete-preview', requireAdmin, (req, res) => {
  if (!getUserById(req.params.id)) {
    res.status(404).json({ error: 'ユーザーが見つかりません' })
    return
  }
  res.json(getUserDeletePreview(req.params.id))
})

usersRouter.delete('/:id', requireAdmin, (req, res) => {
  try {
    deleteUser(req.params.id, req.user!.id, req.body?.confirmationUsername)
    disconnectUser(req.params.id)
    for (const scope of ['user', 'todo', 'subtask', 'plan', 'progress'] as const) broadcastDataChanged(scope)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'メンバーを削除できませんでした' })
  }
})
