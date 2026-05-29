import { Router } from 'express'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
  verifyCredentials
} from '../auth'
import { toPublicUser } from '../db/users'

export const authRouter = Router()

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {}
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' })
    return
  }

  const user = verifyCredentials(username, password)
  if (!user) {
    res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません' })
    return
  }

  const token = createSession(user.id)
  setSessionCookie(res, token)
  res.json({ user: toPublicUser(user) })
})

authRouter.post('/logout', (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken)
  clearSessionCookie(res)
  res.json({ ok: true })
})

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})
