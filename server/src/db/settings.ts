import { getDb } from './connection'

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM Settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO Settings (key, value) VALUES (?, ?)').run(key, value)
}

export function getUserSetting(userId: string, key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM UserSettings WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined
  return row?.value
}

export function setUserSetting(userId: string, key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO UserSettings (user_id, key, value) VALUES (?, ?, ?)')
    .run(userId, key, value)
}

export function getAllUserSettings(userId: string): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM UserSettings WHERE user_id = ?')
    .all(userId) as { key: string; value: string }[]
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value
  return result
}
