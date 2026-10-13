import zlib from 'zlib'

// Pure pixel and PNG helpers. Kept apart from icon.ts so the team desktop can draw
// badges without loading the personal-mode database that icon.ts depends on.

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

export function encodePNG(rgba: Buffer, w: number, h: number): Buffer {
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

function drawRoundedRect(
  rgba: Buffer, size: number, left: number, top: number,
  width: number, height: number, radius: number, color: readonly number[]
): void {
  const cx = left + width / 2
  const cy = top + height / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = Math.max(0, Math.abs(x + 0.5 - cx) - (width / 2 - radius))
      const qy = Math.max(0, Math.abs(y + 0.5 - cy) - (height / 2 - radius))
      const distance = Math.hypot(qx, qy) - radius
      if (distance >= 0.5) continue
      const coverage = Math.min(1, 0.5 - distance)
      const index = (y * size + x) * 4
      const oldAlpha = rgba[index + 3] / 255
      const alpha = coverage + oldAlpha * (1 - coverage)
      for (let channel = 0; channel < 3; channel++) {
        rgba[index + channel] = Math.round(
          (color[channel] * coverage + rgba[index + channel] * oldAlpha * (1 - coverage)) / alpha
        )
      }
      rgba[index + 3] = Math.round(alpha * 255)
    }
  }
}

export function generateDefaultIconRGBA(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4)
  // HAKOBI: 日程と仕事の流れを表す、右へ進む3本のガントバー。
  drawRoundedRect(rgba, size, size * 0.07, size * 0.07, size * 0.86, size * 0.86, size * 0.18, [15, 23, 42])
  drawRoundedRect(rgba, size, size * 0.22, size * 0.27, size * 0.40, size * 0.12, size * 0.035, [45, 212, 191])
  drawRoundedRect(rgba, size, size * 0.33, size * 0.44, size * 0.44, size * 0.12, size * 0.035, [94, 234, 212])
  drawRoundedRect(rgba, size, size * 0.44, size * 0.61, size * 0.27, size * 0.12, size * 0.035, [251, 191, 36])
  return rgba
}

export function generateDefaultIconBuffer(): Buffer {
  return encodePNG(generateDefaultIconRGBA(64), 64, 64)
}
