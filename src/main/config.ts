import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// bootstrap設定はAppDataに最小限だけ置く
const BOOTSTRAP_FILE = path.join(app.getPath('userData'), 'config.json')

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
  try {
    if (fs.existsSync(BOOTSTRAP_FILE)) {
      return JSON.parse(fs.readFileSync(BOOTSTRAP_FILE, 'utf-8')) as BootstrapConfig
    }
  } catch { /* ignore */ }
  return {}
}

function writeConfig(config: BootstrapConfig): void {
  const dir = path.dirname(BOOTSTRAP_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(BOOTSTRAP_FILE, JSON.stringify(config, null, 2))
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
  return !fs.existsSync(BOOTSTRAP_FILE)
}

export function getDefaultDataDir(): string {
  return defaultDataDir()
}
