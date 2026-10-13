import { nativeImage, dialog } from 'electron'
import type { NativeImage, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { getSetting, setSetting } from './db'
import { getDataDir } from './config'
import { generateDefaultIconBuffer } from './icon-pixels'

export { generateDefaultIconBuffer }

function iconsDir(): string {
  const dir = path.join(getDataDir(), 'icons')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ─── アイコン読み込み・変更 ───────────────────────────────────

export function loadAppIcon(): NativeImage {
  try {
    const customPath = getSetting('customIconPath')
    if (customPath && fs.existsSync(customPath)) {
      const img = nativeImage.createFromPath(customPath)
      if (!img.isEmpty()) return img
    }
  } catch { /* DB未初期化時はデフォルトアイコン */ }
  return nativeImage.createFromBuffer(generateDefaultIconBuffer())
}

export function getIconDataUrl(): string {
  try {
    const customPath = getSetting('customIconPath')
    if (customPath && fs.existsSync(customPath)) {
      const data = fs.readFileSync(customPath)
      const ext = customPath.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = ext === 'png' ? 'image/png' : ext === 'ico' ? 'image/x-icon' : 'image/jpeg'
      return `data:${mime};base64,${data.toString('base64')}`
    }
  } catch { /* DB未初期化時はデフォルトアイコン */ }
  const buf = generateDefaultIconBuffer()
  return `data:image/png;base64,${buf.toString('base64')}`
}

export async function pickAndSetIcon(
  mainWindow: BrowserWindow,
  updateTray: (img: NativeImage) => void
): Promise<{ success: boolean; dataUrl: string | null }> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'アイコン画像を選択',
    filters: [{ name: 'Images', extensions: ['png', 'ico', 'jpg', 'jpeg'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) {
    return { success: false, dataUrl: null }
  }

  const srcPath = result.filePaths[0]
  const img = nativeImage.createFromPath(srcPath)
  if (img.isEmpty()) return { success: false, dataUrl: null }

  // userDataにコピーして元ファイルへの依存をなくす
  const ext = srcPath.split('.').pop()?.toLowerCase() ?? 'png'
  const destPath = path.join(iconsDir(), `icon.${ext}`)
  fs.copyFileSync(srcPath, destPath)

  // 古いカスタムアイコンが別拡張子なら削除
  const oldPath = getSetting('customIconPath')
  if (oldPath && oldPath !== destPath && fs.existsSync(oldPath) && oldPath.startsWith(iconsDir())) {
    try { fs.unlinkSync(oldPath) } catch { /* ignore */ }
  }

  setSetting('customIconPath', destPath)
  const copiedImg = nativeImage.createFromPath(destPath)
  mainWindow.setIcon(copiedImg)
  updateTray(copiedImg)

  const data = fs.readFileSync(destPath)
  const mime = ext === 'png' ? 'image/png' : ext === 'ico' ? 'image/x-icon' : 'image/jpeg'
  return { success: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` }
}

export function resetIcon(
  mainWindow: BrowserWindow,
  updateTray: (img: NativeImage) => void
): string {
  setSetting('customIconPath', '')
  const buf = generateDefaultIconBuffer()
  const img = nativeImage.createFromBuffer(buf)
  mainWindow.setIcon(img)
  updateTray(img)
  return `data:image/png;base64,${buf.toString('base64')}`
}
