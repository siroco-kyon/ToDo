import { app } from 'electron'
import fs from 'fs'
import path from 'path'

function getBootstrapFile(): string {
  // userData is resolved lazily so dev mode can override it before first use.
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

function copyFileIfMissing(source: string, destination: string): void {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return
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

function migrateLegacyPackagedDataDir(config: BootstrapConfig): string {
  const configuredDir = config.dataDir ?? defaultDataDir()
  if (!app.isPackaged) return configuredDir

  const legacyDir = legacyPackagedDataDir()
  const persistentDir = defaultDataDir()
  if (!pathsEqual(configuredDir, legacyDir) || pathsEqual(configuredDir, persistentDir)) {
    return configuredDir
  }

  try {
    if (!fs.existsSync(persistentDir)) fs.mkdirSync(persistentDir, { recursive: true })

    copyFileIfMissing(path.join(legacyDir, 'todo.db'), path.join(persistentDir, 'todo.db'))
    copyFileIfMissing(path.join(legacyDir, 'todo.db-wal'), path.join(persistentDir, 'todo.db-wal'))
    copyFileIfMissing(path.join(legacyDir, 'todo.db-shm'), path.join(persistentDir, 'todo.db-shm'))
    copyDirectoryIfMissing(path.join(legacyDir, 'icons'), path.join(persistentDir, 'icons'))

    config.dataDir = persistentDir
    writeConfig(config)
    return persistentDir
  } catch {
    return configuredDir
  }
}

export function getDataDir(): string {
  const config = readConfig()
  return migrateLegacyPackagedDataDir(config)
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
