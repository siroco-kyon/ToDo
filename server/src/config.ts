import path from 'path'
import fs from 'fs'

/**
 * server/.env があれば読み込む（シェルで設定済みの環境変数が優先）。
 * Windows サービス運用などで、起動シェルに依存せず設定を渡すための仕組み。
 * 形式は1行1つの `KEY=value`。`#` 始まりはコメント。値は引用符で囲んでもよい。
 */
function loadEnvFile(): void {
  const envPath = path.resolve(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue

    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
  console.log(`[config] ${envPath} を読み込みました`)
}

loadEnvFile()

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
