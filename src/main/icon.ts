import { nativeImage, dialog } from 'electron'
import type { NativeImage, BrowserWindow } from 'electron'
import zlib from 'zlib'
import fs from 'fs'
import path from 'path'
import { getSetting, setSetting } from './db'
import { getDataDir } from './config'

function iconsDir(): string {
  const dir = path.join(getDataDir(), 'icons')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ─── 最小PNGエンコーダー ──────────────────────────────────────

const crcTable = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32buf(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32buf(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crcBuf])
}

function encodePNG(rgba: Buffer, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA

  const rowLen = 1 + w * 4
  const raw = Buffer.alloc(h * rowLen)
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0 // filter: None
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      raw.set(rgba.subarray(s, s + 4), y * rowLen + 1 + x * 4)
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ─── アイコン描画 ─────────────────────────────────────────────

function drawLine(
  buf: Buffer, size: number,
  x1: number, y1: number, x2: number, y2: number,
  thick: number
): void {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 3)
  for (let s = 0; s <= steps; s++) {
    const px = x1 + (x2 - x1) * s / steps
    const py = y1 + (y2 - y1) * s / steps
    const tr = Math.ceil(thick)
    for (let dy = -tr; dy <= tr; dy++) {
      for (let dx = -tr; dx <= tr; dx++) {
        if (dx * dx + dy * dy <= thick * thick) {
          const ix = Math.round(px + dx)
          const iy = Math.round(py + dy)
          if (ix >= 0 && ix < size && iy >= 0 && iy < size) {
            const idx = (iy * size + ix) * 4
            if (buf[idx + 3] > 0) { // 背景がある部分のみ
              buf[idx] = 255; buf[idx + 1] = 255
              buf[idx + 2] = 255; buf[idx + 3] = 255
            }
          }
        }
      }
    }
  }
}

function generateDefaultIconRGBA(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4) // 全透明
  const cx = size / 2
  const pad = size * 0.07
  const cr = size * 0.18 // 角丸半径

  // 角丸四角形の背景（インディゴ #6366f1）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5, fy = y + 0.5
      const qx = Math.max(0, Math.abs(fx - cx) - (cx - pad - cr))
      const qy = Math.max(0, Math.abs(fy - cx) - (cx - pad - cr))
      const dist = Math.sqrt(qx * qx + qy * qy) - cr
      if (dist < 0.5) {
        const alpha = dist < -0.5 ? 255 : Math.round((0.5 - dist) * 255)
        const i = (y * size + x) * 4
        rgba[i] = 99; rgba[i + 1] = 102; rgba[i + 2] = 241; rgba[i + 3] = alpha
      }
    }
  }

  // 白いチェックマーク
  const t = Math.max(1.5, size * 0.075)
  drawLine(rgba, size, size * 0.23, size * 0.52, size * 0.41, size * 0.70, t)
  drawLine(rgba, size, size * 0.41, size * 0.70, size * 0.77, size * 0.30, t)

  return rgba
}

export function generateDefaultIconBuffer(): Buffer {
  return encodePNG(generateDefaultIconRGBA(64), 64, 64)
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
