import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { ConnectionProfile, DesktopPreferences } from '../shared/desktop'
import { normalizeTimerSize } from './timer-sizing'
import type { TimerSizes } from './timer-sizing'

export const DEFAULT_PREFERENCES: DesktopPreferences = {
  showTimer: true,
  timerCompact: false,
  alwaysOnTop: true,
  hideTaskTitle: false,
  globalShortcutFocus: 'CommandOrControl+Alt+T',
  globalShortcutQuickAdd: 'CommandOrControl+Alt+N',
  globalShortcutExport: 'CommandOrControl+Alt+E',
  globalShortcutProgress: 'CommandOrControl+Alt+P'
}

export interface DesktopConfig {
  mode: 'local' | 'server' | 'unset'
  profile: ConnectionProfile | null
  preferences: DesktopPreferences
  timerPosition?: { x: number; y: number }
  timerSizes?: TimerSizes
}

/** The group is an origin; credentials, paths and query strings are never stored. */
export function normalizeServerUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('接続先は http:// または https:// から始まるURLを入力してください。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('接続先は http://サーバー名:ポート の形式で入力してください。')
  }
  return url.origin
}

export function makeProfile(name: string, input: string): ConnectionProfile {
  const url = normalizeServerUrl(input)
  const label = name.trim()
  if (!label || label.length > 80) throw new Error('グループ名は1〜80文字で入力してください。')
  return { id: createHash('sha256').update(url).digest('hex').slice(0, 24), name: label, url }
}

export function validatePreferences(patch: Partial<DesktopPreferences>): Partial<DesktopPreferences> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('設定が不正です。')
  const result: Partial<DesktopPreferences> = {}
  for (const key of ['showTimer', 'timerCompact', 'alwaysOnTop', 'hideTaskTitle'] as const) {
    if (key in patch) {
      if (typeof patch[key] !== 'boolean') throw new Error('設定が不正です。')
      result[key] = patch[key]
    }
  }
  for (const key of ['globalShortcutFocus', 'globalShortcutQuickAdd', 'globalShortcutExport', 'globalShortcutProgress'] as const) {
    if (key in patch) {
      const value = patch[key]
      if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9+\s]*$/.test(value)) throw new Error('ショートカットの形式が不正です。')
      result[key] = value
    }
  }
  return result
}

function configPath(): string { return path.join(app.getPath('userData'), 'hakobi-desktop.json') }

export function readDesktopConfig(): DesktopConfig {
  const fallback: DesktopConfig = {
    mode: fs.existsSync(path.join(app.getPath('userData'), 'config.json')) ? 'local' : 'unset',
    profile: null,
    preferences: { ...DEFAULT_PREFERENCES }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as DesktopConfig
    const profile = parsed.profile ? makeProfile(parsed.profile.name, parsed.profile.url) : null
    const mode = parsed.mode === 'server' && profile ? 'server' : parsed.mode === 'local' ? 'local' : fallback.mode
    const preferences = { ...DEFAULT_PREFERENCES, ...validatePreferences(parsed.preferences ?? {}) }
    const p = parsed.timerPosition
    const timerPosition = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : undefined
    const timerSizes = {
      normal: normalizeTimerSize(false, parsed.timerSizes?.normal),
      compact: normalizeTimerSize(true, parsed.timerSizes?.compact)
    }
    return { mode, profile, preferences, timerPosition, timerSizes }
  } catch { return fallback }
}

export function writeDesktopConfig(config: DesktopConfig): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  const file = configPath()
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}
