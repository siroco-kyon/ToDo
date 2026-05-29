import Database from 'better-sqlite3'
import { DB_PATH, ensureDataDir } from '../config'
import { createSchema, runMigrations, insertDefaultSettings } from './schema'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb() first')
  return db
}

export function initDb(): void {
  ensureDataDir()
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  createSchema(db)
  runMigrations(db)
  insertDefaultSettings(db)
}
