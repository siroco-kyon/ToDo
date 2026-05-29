import path from 'path'
import fs from 'fs'

/** HTTP port the server listens on. */
export const PORT = Number(process.env.PORT) || 4577

/** Directory that holds the SQLite database and uploaded assets. */
export const DATA_DIR = process.env.TODO_DATA_DIR
  ? path.resolve(process.env.TODO_DATA_DIR)
  : path.resolve(__dirname, '..', 'data')

export const DB_PATH = path.join(DATA_DIR, 'todo.db')

/**
 * Location of the built web frontend (the React app, built at the repo root
 * into `dist-web`). Served as a single-page app when present.
 */
export const WEB_DIST_DIR = process.env.TODO_WEB_DIST
  ? path.resolve(process.env.TODO_WEB_DIST)
  : path.resolve(__dirname, '..', '..', 'dist-web')

/** Bootstrap admin account, created on first launch when no users exist. */
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

/** Session cookie name and lifetime. */
export const SESSION_COOKIE = 'todo_session'
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 30

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}
