const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(PROJECT_ROOT, 'build')
const PNG_PATH = path.join(BUILD_DIR, 'icon.png')
const ICO_PATH = path.join(BUILD_DIR, 'icon.ico')
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]

const crcTable = (() => {
  const table = []
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = crcTable[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  const crcBuffer = Buffer.alloc(4)

  lengthBuffer.writeUInt32BE(data.length, 0)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6

  const rowLength = 1 + width * 4
  const raw = Buffer.alloc(height * rowLength)

  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * 4
      const rowOffset = y * rowLength + 1 + x * 4
      raw.set(rgba.subarray(pixelOffset, pixelOffset + 4), rowOffset)
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function drawRoundedRect(rgba, size, left, top, width, height, radius, color) {
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

function generateIconRgba(size) {
  const rgba = Buffer.alloc(size * size * 4)
  // Keep these shapes/colors in sync with src/main/icon.ts.
  drawRoundedRect(rgba, size, size * 0.07, size * 0.07, size * 0.86, size * 0.86, size * 0.18, [15, 23, 42])
  drawRoundedRect(rgba, size, size * 0.22, size * 0.27, size * 0.40, size * 0.12, size * 0.035, [45, 212, 191])
  drawRoundedRect(rgba, size, size * 0.33, size * 0.44, size * 0.44, size * 0.12, size * 0.035, [94, 234, 212])
  drawRoundedRect(rgba, size, size * 0.44, size * 0.61, size * 0.27, size * 0.12, size * 0.035, [251, 191, 36])
  return rgba
}

function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)

  let imageOffset = directory.length
  const payloads = []

  entries.forEach((entry, index) => {
    const offset = 6 + index * 16
    directory[offset + 0] = entry.size >= 256 ? 0 : entry.size
    directory[offset + 1] = entry.size >= 256 ? 0 : entry.size
    directory[offset + 2] = 0
    directory[offset + 3] = 0
    directory.writeUInt16LE(1, offset + 4)
    directory.writeUInt16LE(32, offset + 6)
    directory.writeUInt32LE(entry.buffer.length, offset + 8)
    directory.writeUInt32LE(imageOffset, offset + 12)

    payloads.push(entry.buffer)
    imageOffset += entry.buffer.length
  })

  return Buffer.concat([directory, ...payloads])
}

function writeIfChanged(filePath, contents) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath)
    if (existing.equals(contents)) return false
  }

  fs.writeFileSync(filePath, contents)
  return true
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true })

  const pngEntries = ICON_SIZES.map((size) => ({
    size,
    buffer: encodePng(generateIconRgba(size), size, size)
  }))

  const pngChanged = writeIfChanged(PNG_PATH, pngEntries[pngEntries.length - 1].buffer)
  const icoChanged = writeIfChanged(ICO_PATH, encodeIco(pngEntries))

  console.log(`Generated ${path.relative(PROJECT_ROOT, PNG_PATH)}${pngChanged ? '' : ' (unchanged)'}`)
  console.log(`Generated ${path.relative(PROJECT_ROOT, ICO_PATH)}${icoChanged ? '' : ' (unchanged)'}`)
}

main()
