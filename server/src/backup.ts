import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { getDb } from './db/connection'
import { BACKUP_DIR, BACKUP_KEEP } from './config'
import { toLocalDateKey } from './shared/recurring-period'

// 自動バックアップのファイル名（日付ごとに1つ）。これ以外のファイルは消さない
const DAILY_BACKUP_FILE = /^hakobi-\d{4}-\d{2}-\d{2}\.db$/

export interface BackupInfo {
  /** 自動バックアップの置き場所（サーバーのパス。管理者にだけ見せる） */
  directory: string
  /** 残す数。0 なら自動バックアップをしない */
  keep: number
  count: number
  latestName: string | null
  latestAt: string | null
}

function dailyBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  // 名前に日付が入っているので、名前順＝古い順
  return fs.readdirSync(dir).filter((name) => DAILY_BACKUP_FILE.test(name)).sort()
}

/**
 * 今の DB をファイルに書き出す。SQLite のバックアップ機能を使うので、運用中でも整合した内容になる
 * （todo.db をそのままコピーすると、WAL に残っている変更が入らない）。書き終わるまでは別名にしておく
 */
export async function writeSnapshot(destination: string): Promise<void> {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`
  try {
    await getDb().backup(temporary)
    // 1つのファイルだけで開けるよう WAL をやめておく（開いたときに -wal・-shm ができない）
    const copy = new Database(temporary)
    try {
      copy.pragma('journal_mode = DELETE')
    } finally {
      copy.close()
    }
    fs.renameSync(temporary, destination)
  } finally {
    for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`]) fs.rmSync(file, { force: true })
  }
}

/** 残す数を超えた古い自動バックアップを消し、消したファイル名を返す */
export function pruneDailyBackups(dir = BACKUP_DIR, keep = BACKUP_KEEP): string[] {
  if (keep <= 0) return []
  const files = dailyBackups(dir)
  const removed = files.slice(0, Math.max(0, files.length - keep))
  for (const name of removed) {
    // バックアップを開いたときにできたファイルも一緒に消す
    for (const file of [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]) fs.rmSync(path.join(dir, file), { force: true })
  }
  return removed
}

let running: Promise<string | null> | null = null

/**
 * 1日1回の自動バックアップ。今日の分がなければ取り、残す数を超えた古いものを消す。
 * 取ったときはそのファイルのパスを返す（今日の分がもうあれば null）
 */
export function runDailyBackup(now = new Date(), dir = BACKUP_DIR, keep = BACKUP_KEEP): Promise<string | null> {
  if (keep <= 0) return Promise.resolve(null)
  if (running) return running
  running = (async () => {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `hakobi-${toLocalDateKey(now)}.db`)
    let created: string | null = null
    if (!fs.existsSync(target)) {
      await writeSnapshot(target)
      created = target
    }
    pruneDailyBackups(dir, keep)
    return created
  })().finally(() => {
    running = null
  })
  return running
}

export function getBackupInfo(dir = BACKUP_DIR, keep = BACKUP_KEEP): BackupInfo {
  const files = dailyBackups(dir)
  const latestName = files.length > 0 ? files[files.length - 1] : null
  return {
    directory: dir,
    keep,
    count: files.length,
    latestName,
    latestAt: latestName ? fs.statSync(path.join(dir, latestName)).mtime.toISOString() : null
  }
}
