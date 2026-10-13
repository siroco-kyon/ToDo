import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'

export const WINDOWS_APP_ID = 'com.hakobi.app'

function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

/** Brand the Windows shell independently of the legacy installer/data identities. */
export function applyWindowsTaskbarBranding(window: BrowserWindow): void {
  if (process.platform !== 'win32') return

  const executable = process.execPath
  const appPath = app.isPackaged ? null : app.getAppPath()
  const developmentIcon = appPath ? path.join(appPath, 'build', 'icon.ico') : null
  const iconPath = developmentIcon && fs.existsSync(developmentIcon) ? developmentIcon : executable
  const relaunchCommand = appPath
    ? `${quoteWindowsArgument(executable)} ${quoteWindowsArgument(appPath)}`
    : quoteWindowsArgument(executable)

  // A distinct shell ID prevents Windows from reusing the old ToDo taskbar group.
  window.setAppDetails({
    appId: WINDOWS_APP_ID,
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand,
    relaunchDisplayName: 'HAKOBI'
  })
}

export type LaunchAction = 'quick-add' | 'progress' | 'timer'

const LAUNCH_ACTION_PREFIX = '--hakobi-action='
const LAUNCH_ACTIONS: Record<LaunchAction, { title: string; description: string }> = {
  'quick-add': { title: 'タスクを追加', description: 'HAKOBIにタスクを追加します' },
  progress: { title: '進捗をすぐ書く', description: '計測中のタスクの進捗を書きます' },
  timer: { title: '右下タイマーを表示', description: '作業時間のタイマーを表示します' }
}

/** Only the fixed jump list actions are accepted from a command line. */
export function parseLaunchAction(argv: readonly string[]): LaunchAction | null {
  for (const argument of argv) {
    if (!argument.startsWith(LAUNCH_ACTION_PREFIX)) continue
    const action = argument.slice(LAUNCH_ACTION_PREFIX.length)
    if (Object.prototype.hasOwnProperty.call(LAUNCH_ACTIONS, action)) return action as LaunchAction
  }
  return null
}

/** Taskbar right-click tasks start a second instance, which forwards its action to the running app. */
export function applyWindowsJumpList(enabled: boolean): void {
  if (process.platform !== 'win32') return
  const appPath = app.isPackaged ? null : app.getAppPath()
  const tasks = enabled
    ? (Object.entries(LAUNCH_ACTIONS) as Array<[LaunchAction, { title: string; description: string }]>).map(([action, label]) => ({
        program: process.execPath,
        arguments: [appPath ? quoteWindowsArgument(appPath) : '', `${LAUNCH_ACTION_PREFIX}${action}`].filter(Boolean).join(' '),
        iconPath: process.execPath,
        iconIndex: 0,
        title: label.title,
        description: label.description
      }))
    : []
  try {
    if (!app.setUserTasks(tasks)) console.error('[HAKOBI] タスクバーのジャンプリストを更新できませんでした')
  } catch (error) {
    console.error('[HAKOBI] タスクバーのジャンプリストを更新できませんでした', error)
  }
}
