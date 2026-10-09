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
