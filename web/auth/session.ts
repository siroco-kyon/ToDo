export type UserRole = 'admin' | 'member'

export interface CurrentUser {
  id: string
  username: string
  display_name: string
  role: UserRole
  color: string
  is_active: number
  created_at: string
  updated_at: string
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json()
    if (data && typeof data.error === 'string') return data.error
  } catch {
    /* ignore */
  }
  return fallback
}

/** Returns the logged-in user, or null when the session is missing/expired. */
export async function fetchMe(): Promise<CurrentUser | null> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(await readError(res, 'ユーザー情報の取得に失敗しました'))
  const data = await res.json()
  return data.user as CurrentUser
}

export async function login(username: string, password: string): Promise<CurrentUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  if (!res.ok) throw new Error(await readError(res, 'ログインに失敗しました'))
  const data = await res.json()
  return data.user as CurrentUser
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch('/api/users/me/password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword })
  })
  if (!res.ok) throw new Error(await readError(res, 'パスワードの変更に失敗しました'))
}
