import { app } from 'electron'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

function getBootstrapFile(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function defaultDataDir(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data')
  }
  return path.join(process.cwd(), 'data')
}

function legacyPackagedDataDir(): string {
  return path.join(path.dirname(process.execPath), 'data')
}

interface BootstrapConfig {
  dataDir?: string
  skipLegacyRecovery?: boolean
}

interface DbBundleInfo {
  dir: string
  dbPath: string
  todoCount: number
  bundleSize: number
  latestMtimeMs: number
}

// Resolution happens before initDb opens the live connection. A later settings
// read must never run legacy recovery over an intentionally emptied live DB.
let resolvedDataDir: { bootstrapFile: string; dir: string } | null = null

function readConfig(): BootstrapConfig {
  const bootstrapFile = getBootstrapFile()
  try {
    if (fs.existsSync(bootstrapFile)) {
      return JSON.parse(fs.readFileSync(bootstrapFile, 'utf-8')) as BootstrapConfig
    }
  } catch {
    // ignore malformed config
  }
  return {}
}

function writeConfig(config: BootstrapConfig): void {
  const bootstrapFile = getBootstrapFile()
  const dir = path.dirname(bootstrapFile)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const temporary = path.join(dir, `.config-${randomUUID()}.tmp`)
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(config, null, 2))
      fs.fsyncSync(descriptor)
    } finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, bootstrapFile)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function normalizeForCompare(value: string): string {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathsEqual(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

function isSubPathOf(target: string, root: string): boolean {
  const targetNorm = normalizeForCompare(target)
  const rootNorm = normalizeForCompare(root)
  return targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}${path.sep}`)
}

function readTodoCount(dbPath: string): number | null {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Todos' LIMIT 1").get() as Record<string, unknown> | undefined
    if (!hasTable) return 0
    const row = db.prepare('SELECT COUNT(*) as count FROM Todos').get() as { count: number }
    return typeof row?.count === 'number' ? row.count : 0
  } catch {
    return null
  } finally {
    if (db) db.close()
  }
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function getFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function getDbBundleInfo(dirPath: string): DbBundleInfo | null {
  const dbPath = path.join(dirPath, 'todo.db')
  if (!fs.existsSync(dbPath)) return null

  const todoCount = readTodoCount(dbPath)
  if (todoCount == null) return null

  const walPath = `${dbPath}-wal`
  const shmPath = `${dbPath}-shm`
  const bundleSize = getFileSize(dbPath) + getFileSize(walPath) + getFileSize(shmPath)
  const latestMtimeMs = Math.max(getFileMtimeMs(dbPath), getFileMtimeMs(walPath), getFileMtimeMs(shmPath))

  return {
    dir: dirPath,
    dbPath,
    todoCount,
    bundleSize,
    latestMtimeMs
  }
}

function copyDirectoryIfMissing(sourceDir: string, destinationDir: string, overwriteFiles = false): void {
  if (!fs.existsSync(sourceDir)) return
  if (!fs.existsSync(destinationDir)) fs.mkdirSync(destinationDir, { recursive: true })

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)

    if (entry.isDirectory()) {
      copyDirectoryIfMissing(sourcePath, destinationPath, overwriteFiles)
      continue
    }

    if (entry.isFile() && (overwriteFiles || !fs.existsSync(destinationPath))) {
      fs.copyFileSync(sourcePath, destinationPath)
    }
  }
}

function copyDbBundle(sourceDir: string, destinationDir: string, overwriteDb: boolean, commit: () => void): void {
  if (!fs.existsSync(destinationDir)) fs.mkdirSync(destinationDir, { recursive: true })
  if (fs.existsSync(sourceDir) && pathsEqual(fs.realpathSync(sourceDir), fs.realpathSync(destinationDir))) {
    commit()
    return
  }
  const sourceDb = path.join(sourceDir, 'todo.db')
  const destinationDb = path.join(destinationDir, 'todo.db')
  const sourceIcons = path.join(sourceDir, 'icons')
  const destinationIcons = path.join(destinationDir, 'icons')
  const replaceDb = fs.existsSync(sourceDb) && (overwriteDb || !fs.existsSync(destinationDb))
  if (fs.existsSync(sourceIcons) && isSubPathOf(fs.realpathSync(destinationDir), fs.realpathSync(sourceIcons))) {
    throw new Error('旧版のアイコン保存先の中にはデータを復旧できません')
  }
  const staging = path.join(destinationDir, `.hakobi-legacy-${randomUUID()}`)
  fs.mkdirSync(staging)
  const snapshot = path.join(staging, 'todo.db')
  const stagedIcons = path.join(staging, 'icons')
  const backups: { original: string; backup: string }[] = []
  let publishedDb = false
  let publishedIcons = false
  let committed = false
  let rollbackComplete = false
  try {
    if (replaceDb) {
      const source = new Database(sourceDb, { readonly: true, fileMustExist: true })
      try { source.prepare('VACUUM INTO ?').run(snapshot) }
      finally { source.close() }
      const staged = new Database(snapshot, { fileMustExist: true })
      try {
        if (staged.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('旧版データのコピーを確認できませんでした')
        const hasSettings = staged.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Settings'").get()
        const icon = hasSettings ? staged.prepare("SELECT value FROM Settings WHERE key = 'customIconPath'").get() as { value: string } | undefined : undefined
        if (icon?.value && isSubPathOf(icon.value, sourceIcons)) {
          staged.prepare("UPDATE Settings SET value = ? WHERE key = 'customIconPath'").run(path.join(destinationIcons, path.relative(sourceIcons, icon.value)))
        }
        staged.pragma('wal_checkpoint(TRUNCATE)')
      } finally { staged.close() }
    }
    if (fs.existsSync(sourceIcons)) {
      copyDirectoryIfMissing(destinationIcons, stagedIcons)
      // When replacing the DB, its icon settings refer to the source files.
      copyDirectoryIfMissing(sourceIcons, stagedIcons, replaceDb)
    }
    const retire = (original: string, name: string): void => {
      if (!fs.existsSync(original)) return
      const backup = path.join(staging, name)
      fs.renameSync(original, backup)
      backups.push({ original, backup })
    }
    if (replaceDb) {
      // Retire every old sidecar even when the source is a closed main-only DB.
      // A stale target WAL must never be applied to the new snapshot.
      for (const suffix of ['', '-wal', '-shm', '-journal']) retire(`${destinationDb}${suffix}`, `previous.db${suffix}`)
      fs.renameSync(snapshot, destinationDb)
      publishedDb = true
    }
    if (fs.existsSync(stagedIcons)) {
      retire(destinationIcons, 'previous-icons')
      fs.renameSync(stagedIcons, destinationIcons)
      publishedIcons = true
    }
    commit()
    committed = true
  } catch (error) {
    try {
      if (publishedIcons) {
        if (!pathsEqual(path.dirname(destinationIcons), destinationDir)) throw new Error('旧版アイコンの復元先を確認できません')
        fs.rmSync(destinationIcons, { recursive: true, force: true })
      }
      if (publishedDb) fs.unlinkSync(destinationDb)
      for (const { original, backup } of [...backups].reverse()) fs.renameSync(backup, original)
      rollbackComplete = true
    } catch (rollbackError) {
      // Keep the retired bundle for manual recovery rather than erase it.
      console.error('[HAKOBI] 旧版データの復旧を元に戻せませんでした。一時フォルダに元データを保持します', staging, rollbackError)
    }
    throw error
  } finally {
    if (committed || rollbackComplete) {
      if (!pathsEqual(path.dirname(staging), destinationDir) || !path.basename(staging).startsWith('.hakobi-legacy-')) throw new Error('旧版データの一時フォルダを確認できません')
      try { fs.rmSync(staging, { recursive: true, force: true }) }
      catch (error) { console.error('[HAKOBI] 旧版データの一時フォルダを整理できませんでした', staging, error) }
    }
  }
}

function isLikelyInstallDataDir(dirPath: string): boolean {
  if (!app.isPackaged) return false
  if (path.basename(dirPath).toLowerCase() !== 'data') return false

  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  const roots = [
    localAppData ? path.join(localAppData, 'Programs') : '',
    process.env['ProgramFiles'] ?? '',
    process.env['ProgramFiles(x86)'] ?? '',
    process.env['ProgramW6432'] ?? ''
  ].filter((root) => root.length > 0)

  return roots.some((root) => isSubPathOf(dirPath, root))
}

function migrateLegacyPackagedDataDir(config: BootstrapConfig): string {
  const configuredDir = config.dataDir ?? defaultDataDir()
  if (!app.isPackaged) return configuredDir

  const persistentDir = defaultDataDir()
  const shouldMigrate = pathsEqual(configuredDir, legacyPackagedDataDir()) || isLikelyInstallDataDir(configuredDir)
  if (!shouldMigrate || pathsEqual(configuredDir, persistentDir)) {
    return configuredDir
  }

  try {
    if (!fs.existsSync(persistentDir)) fs.mkdirSync(persistentDir, { recursive: true })

    const targetInfo = getDbBundleInfo(persistentDir)
    const overwrite = !targetInfo || targetInfo.todoCount <= 0
    copyDbBundle(configuredDir, persistentDir, overwrite, () => {
      config.dataDir = persistentDir
      config.skipLegacyRecovery = true
      writeConfig(config)
    })
    return persistentDir
  } catch {
    return configuredDir
  }
}

function recoverDbFromLegacyCandidates(config: BootstrapConfig, currentDir: string): string {
  if (!app.isPackaged || config.skipLegacyRecovery) return currentDir

  try {
    const currentInfo = getDbBundleInfo(currentDir)
    if (currentInfo && currentInfo.todoCount > 0) {
      config.dataDir = currentDir
      config.skipLegacyRecovery = true
      writeConfig(config)
      return currentDir
    }

    const candidates = [
      legacyPackagedDataDir(),
      path.join(app.getPath('appData'), 'todo-app'),
      path.join(app.getPath('appData'), 'todo-app', 'data'),
      path.join(app.getPath('appData'), 'ToDo'),
      path.join(app.getPath('appData'), 'ToDo', 'data')
    ]

    const targetKey = normalizeForCompare(currentDir)
    const infos = candidates
      .filter((dirPath) => normalizeForCompare(dirPath) !== targetKey)
      .map((dirPath) => getDbBundleInfo(dirPath))
      .filter((info): info is DbBundleInfo => info != null && info.todoCount > 0)

    if (infos.length === 0) return currentDir

    infos.sort((a, b) => {
      if (b.todoCount !== a.todoCount) return b.todoCount - a.todoCount
      if (b.bundleSize !== a.bundleSize) return b.bundleSize - a.bundleSize
      return b.latestMtimeMs - a.latestMtimeMs
    })

    const best = infos[0]
    copyDbBundle(best.dir, currentDir, true, () => {
      config.dataDir = currentDir
      config.skipLegacyRecovery = true
      writeConfig(config)
    })

    return currentDir
  } catch {
    return currentDir
  }
}

export function getDataDir(): string {
  const bootstrapFile = getBootstrapFile()
  if (resolvedDataDir?.bootstrapFile === bootstrapFile) return resolvedDataDir.dir
  const config = readConfig()
  const migratedDir = migrateLegacyPackagedDataDir(config)
  const dir = recoverDbFromLegacyCandidates(config, migratedDir)
  resolvedDataDir = { bootstrapFile, dir }
  return dir
}

export function setDataDir(newDir: string): void {
  const config = readConfig()
  config.dataDir = newDir
  // An explicitly chosen empty DB is intentional; an old backup must not be
  // copied over it later just because the user deleted the last task.
  config.skipLegacyRecovery = true
  writeConfig(config)
  resolvedDataDir = { bootstrapFile: getBootstrapFile(), dir: newDir }
}

export function isFirstLaunch(): boolean {
  return !fs.existsSync(getBootstrapFile())
}

export function getDefaultDataDir(): string {
  return defaultDataDir()
}
