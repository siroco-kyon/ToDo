import { app } from 'electron'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

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
}

interface DbBundleInfo {
  dir: string
  dbPath: string
  todoCount: number
  bundleSize: number
  latestMtimeMs: number
}

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
  fs.writeFileSync(bootstrapFile, JSON.stringify(config, null, 2))
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

function copyFile(source: string, destination: string, overwrite: boolean): void {
  if (!fs.existsSync(source)) return
  if (!overwrite && fs.existsSync(destination)) return
  fs.copyFileSync(source, destination)
}

function copyDirectoryIfMissing(sourceDir: string, destinationDir: string): void {
  if (!fs.existsSync(sourceDir)) return
  if (!fs.existsSync(destinationDir)) fs.mkdirSync(destinationDir, { recursive: true })

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)

    if (entry.isDirectory()) {
      copyDirectoryIfMissing(sourcePath, destinationPath)
      continue
    }

    if (entry.isFile() && !fs.existsSync(destinationPath)) {
      fs.copyFileSync(sourcePath, destinationPath)
    }
  }
}

function copyDbBundle(sourceDir: string, destinationDir: string, overwriteDb: boolean): void {
  if (!fs.existsSync(destinationDir)) fs.mkdirSync(destinationDir, { recursive: true })

  const sourceDb = path.join(sourceDir, 'todo.db')
  const destinationDb = path.join(destinationDir, 'todo.db')
  copyFile(sourceDb, destinationDb, overwriteDb)
  copyFile(`${sourceDb}-wal`, `${destinationDb}-wal`, overwriteDb)
  copyFile(`${sourceDb}-shm`, `${destinationDb}-shm`, overwriteDb)
  copyDirectoryIfMissing(path.join(sourceDir, 'icons'), path.join(destinationDir, 'icons'))
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
    copyDbBundle(configuredDir, persistentDir, overwrite)

    config.dataDir = persistentDir
    writeConfig(config)
    return persistentDir
  } catch {
    return configuredDir
  }
}

function recoverDbFromLegacyCandidates(config: BootstrapConfig, currentDir: string): string {
  if (!app.isPackaged) return currentDir

  try {
    const currentInfo = getDbBundleInfo(currentDir)
    if (currentInfo && currentInfo.todoCount > 0) return currentDir

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
    copyDbBundle(best.dir, currentDir, true)

    if (!config.dataDir || !pathsEqual(config.dataDir, currentDir)) {
      config.dataDir = currentDir
      writeConfig(config)
    }

    return currentDir
  } catch {
    return currentDir
  }
}

export function getDataDir(): string {
  const config = readConfig()
  const migratedDir = migrateLegacyPackagedDataDir(config)
  return recoverDbFromLegacyCandidates(config, migratedDir)
}

export function setDataDir(newDir: string): void {
  const config = readConfig()
  config.dataDir = newDir
  writeConfig(config)
}

export function isFirstLaunch(): boolean {
  return !fs.existsSync(getBootstrapFile())
}

export function getDefaultDataDir(): string {
  return defaultDataDir()
}