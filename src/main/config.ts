import { app } from 'electron'
import fs from 'fs'
import path from 'path'

function getBootstrapFile(): string {
  // userData is resolved lazily so dev mode can override it before first use.
  return path.join(app.getPath('userData'), 'config.json')
}

function defaultDataDir(): string {
  if (app.isPackaged) {
    // パッケージ版: exeと同じフォルダの data/
    return path.join(path.dirname(process.execPath), 'data')
  }
  // 開発版: プロジェクトルートの data/
  return path.join(process.cwd(), 'data')
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
  } catch { /* ignore */ }
  return {}
}

function writeConfig(config: BootstrapConfig): void {
  const bootstrapFile = getBootstrapFile()
  const dir = path.dirname(bootstrapFile)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(bootstrapFile, JSON.stringify(config, null, 2))
}

export function getDataDir(): string {
  const config = readConfig()
  return config.dataDir ?? defaultDataDir()
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
