import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { encodePNG, generateDefaultIconRGBA } from './icon-pixels'

type Color = readonly [number, number, number]
type Inside = (x: number, y: number) => boolean
export type ThumbarGlyph = 'start' | 'stop' | 'progress' | 'add'

const GLYPH_SIZE = 32
const RED: Color = [220, 38, 38]
const WHITE: Color = [255, 255, 255]
const SLATE: Color = [15, 23, 42]
// 3x5 pixel digits keep the badge legible after Windows shrinks it to 16px.
const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

/** Paints with 4x4 supersampling so small taskbar images keep smooth edges. */
function fill(rgba: Buffer, size: number, inside: Inside, color: Color): void {
  const samples = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) if (inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) hits++
      }
      if (!hits) continue
      const coverage = hits / (samples * samples)
      const index = (y * size + x) * 4
      const oldAlpha = rgba[index + 3] / 255
      const alpha = coverage + oldAlpha * (1 - coverage)
      for (let channel = 0; channel < 3; channel++) {
        rgba[index + channel] = Math.round((color[channel] * coverage + rgba[index + channel] * oldAlpha * (1 - coverage)) / alpha)
      }
      rgba[index + 3] = Math.round(alpha * 255)
    }
  }
}

const circle = (cx: number, cy: number, r: number): Inside => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
const rect = (left: number, top: number, width: number, height: number): Inside =>
  (x, y) => x >= left && x <= left + width && y >= top && y <= top + height
const union = (...shapes: Inside[]): Inside => (x, y) => shapes.some((shape) => shape(x, y))
const grow = (shape: Inside, by: number): Inside => (x, y) =>
  [[0, 0], [by, 0], [-by, 0], [0, by], [0, -by], [by, by], [by, -by], [-by, by], [-by, -by]].some(([dx, dy]) => shape(x + dx, y + dy))

function triangle(points: Array<[number, number]>): Inside {
  const [[ax, ay], [bx, by], [cx, cy]] = points
  const side = (px: number, py: number, qx: number, qy: number, x: number, y: number): number => (qx - px) * (y - py) - (qy - py) * (x - px)
  return (x, y) => {
    const d1 = side(ax, ay, bx, by, x, y)
    const d2 = side(bx, by, cx, cy, x, y)
    const d3 = side(cx, cy, ax, ay, x, y)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
}

function text(value: string, scale: number, size: number): Inside {
  const width = value.length * 3 * scale + (value.length - 1) * scale
  const left = (size - width) / 2
  const top = (size - 5 * scale) / 2
  const cells: Inside[] = []
  ;[...value].forEach((char, index) => {
    FONT[char].forEach((row, rowIndex) => [...row].forEach((bit, column) => {
      if (bit === '1') cells.push(rect(left + index * 4 * scale + column * scale, top + rowIndex * scale, scale, scale))
    }))
  })
  return union(...cells)
}

const toImage = (rgba: Buffer, size: number): NativeImage => nativeImage.createFromBuffer(encodePNG(rgba, size, size))

export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(Math.max(1, Math.floor(count)))
}

export function badgePixels(count: number): Buffer {
  const label = badgeLabel(count)
  const rgba = Buffer.alloc(GLYPH_SIZE * GLYPH_SIZE * 4)
  fill(rgba, GLYPH_SIZE, circle(16, 16, 16), RED)
  fill(rgba, GLYPH_SIZE, text(label, label.length > 1 ? 3 : 4, GLYPH_SIZE), WHITE)
  return rgba
}

const badgeCache = new Map<string, NativeImage>()
/** A red count badge for the Windows taskbar overlay. */
export function unreadBadgeImage(count: number): NativeImage {
  const label = badgeLabel(count)
  let image = badgeCache.get(label)
  if (!image) {
    image = toImage(badgePixels(count), GLYPH_SIZE)
    badgeCache.set(label, image)
  }
  return image
}

let trayWithDot: NativeImage | null = null
/** The HAKOBI mark with a red dot, shown in the tray while notifications are unread. */
export function unreadTrayImage(): NativeImage {
  if (trayWithDot) return trayWithDot
  const size = 64
  const rgba = generateDefaultIconRGBA(size)
  fill(rgba, size, circle(50, 14, 14), SLATE)
  fill(rgba, size, circle(50, 14, 11), RED)
  trayWithDot = toImage(rgba, size)
  return trayWithDot
}

const GLYPHS: Record<ThumbarGlyph, Inside> = {
  start: triangle([[10, 7], [25, 16], [10, 25]]),
  stop: rect(8, 8, 16, 16),
  progress: union(rect(6, 8, 20, 4), rect(6, 14, 20, 4), rect(6, 20, 12, 4)),
  add: union(rect(14, 6, 4, 20), rect(6, 14, 20, 4))
}

/** White glyphs with a dark outline stay visible on light and dark taskbar previews. */
export function glyphPixels(glyph: ThumbarGlyph): Buffer {
  const rgba = Buffer.alloc(GLYPH_SIZE * GLYPH_SIZE * 4)
  fill(rgba, GLYPH_SIZE, grow(GLYPHS[glyph], 2), SLATE)
  fill(rgba, GLYPH_SIZE, GLYPHS[glyph], WHITE)
  return rgba
}

const glyphCache = new Map<ThumbarGlyph, NativeImage>()
export function thumbarImage(glyph: ThumbarGlyph): NativeImage {
  let image = glyphCache.get(glyph)
  if (!image) {
    image = toImage(glyphPixels(glyph), GLYPH_SIZE)
    glyphCache.set(glyph, image)
  }
  return image
}
