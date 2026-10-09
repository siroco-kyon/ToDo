import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { getDb, switchDatabase } from './db'
import { setDataDir } from './config'

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Synchronous snapshot + swap: no IPC write can interleave with the migration. */
export function changeLocalDataDirectory(input: string): { moved: boolean } {
  if (typeof input !== 'string' || !input.trim()) throw new Error('変更先のフォルダを選択してください')
  const source = getDb()
  const sourceDir = fs.realpathSync(path.dirname(path.resolve(source.name)))
  const selected = path.resolve(input.trim())
  fs.mkdirSync(selected, { recursive: true })
  const destination = fs.realpathSync(selected)
  if (samePath(sourceDir, destination)) return { moved: false }
  const sourceIcons = path.join(sourceDir, 'icons')
  const destinationIcons = path.join(destination, 'icons')
  if (fs.existsSync(sourceIcons) && isWithin(destination, fs.realpathSync(sourceIcons))) {
    throw new Error('現在のアイコン保存フォルダの中には移動できません。別のフォルダを選択してください')
  }
  const destinationDb = path.join(destination, 'todo.db')
  const databaseFiles = ['', '-wal', '-shm', '-journal'].map((suffix) => `${destinationDb}${suffix}`)
  const assertEmptyDestination = (): void => {
    if (databaseFiles.some((file) => fs.existsSync(file)) || (fs.existsSync(sourceIcons) && fs.existsSync(destinationIcons))) {
      throw new Error('変更先に既存のデータベースまたはアイコンがあります。上書きせず、別の空のフォルダを選択してください')
    }
  }
  assertEmptyDestination()
  const staging = path.join(destination, `.hakobi-migration-${randomUUID()}`)
  const stagingDb = path.join(staging, 'todo.db')
  const stagingIcons = path.join(staging, 'icons')
  fs.mkdirSync(staging)
  let publishedDb = false
  let publishedIcons = false
  let committed = false
  try {
    // VACUUM INTO reads the live SQLite view, including transactions still in WAL.
    source.prepare('VACUUM INTO ?').run(stagingDb)
    if (fs.existsSync(sourceIcons)) fs.cpSync(sourceIcons, stagingIcons, { recursive: true, force: false, errorOnExist: true })
    const staged = new Database(stagingDb, { fileMustExist: true })
    try {
      const violations = staged.pragma('foreign_key_check') as unknown[]
      if (staged.pragma('quick_check', { simple: true }) !== 'ok' || violations.length > 0) {
        throw new Error('コピーしたデータベースを確認できませんでした。現在の保存先を継続します')
      }
      const icon = staged.prepare("SELECT value FROM Settings WHERE key = 'customIconPath'").get() as { value: string } | undefined
      if (icon?.value && isWithin(path.resolve(icon.value), sourceIcons)) {
        const copiedPath = path.join(destinationIcons, path.relative(sourceIcons, path.resolve(icon.value)))
        staged.prepare("UPDATE Settings SET value = ? WHERE key = 'customIconPath'").run(copiedPath)
      }
      staged.pragma('wal_checkpoint(TRUNCATE)')
    } finally { staged.close() }

    assertEmptyDestination()
    // Reserve the final name exclusively; neither an existing DB nor a partial
    // copy error may silently overwrite another database in the chosen folder.
    const output = fs.openSync(destinationDb, 'wx', 0o600)
    publishedDb = true
    try {
      const original = fs.openSync(stagingDb, 'r')
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let read: number
        while ((read = fs.readSync(original, buffer, 0, buffer.length, null)) > 0) {
          let written = 0
          while (written < read) written += fs.writeSync(output, buffer, written, read - written)
        }
        fs.fsyncSync(output)
      } finally { fs.closeSync(original) }
    } finally { fs.closeSync(output) }
    if (fs.existsSync(stagingIcons)) {
      fs.mkdirSync(destinationIcons)
      publishedIcons = true
      fs.cpSync(stagingIcons, destinationIcons, { recursive: true, force: false, errorOnExist: true })
    }
    switchDatabase(destination, () => setDataDir(destination))
    committed = true
    return { moved: true }
  } finally {
    const cleanup = (action: () => void): void => {
      try { action() }
      catch (error) { console.error('[HAKOBI] 保存先変更の一時ファイルを整理できませんでした', error) }
    }
    if (!committed) {
      if (publishedDb) for (const file of databaseFiles) {
        if (path.dirname(path.resolve(file)) !== destination) throw new Error('データベースの整理先を確認できません')
        cleanup(() => { if (fs.existsSync(file)) fs.unlinkSync(file) })
      }
      if (publishedIcons) {
        if (path.dirname(path.resolve(destinationIcons)) !== destination) throw new Error('アイコンの整理先を確認できません')
        cleanup(() => fs.rmSync(destinationIcons, { recursive: true, force: true }))
      }
    }
    if (path.dirname(path.resolve(staging)) !== destination || !path.basename(staging).startsWith('.hakobi-migration-')) throw new Error('一時ファイルの整理先を確認できません')
    // A completed live switch must still report success if staging cleanup fails.
    cleanup(() => fs.rmSync(staging, { recursive: true, force: true }))
  }
}
