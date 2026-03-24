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

function drawLine(buffer, size, x1, y1, x2, y2, thickness) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 3)
  const radius = Math.ceil(thickness)

  for (let step = 0; step <= steps; step += 1) {
    const px = x1 + ((x2 - x1) * step) / steps
    const py = y1 + ((y2 - y1) * step) / steps

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy > thickness * thickness) continue

        const ix = Math.round(px + dx)
        const iy = Math.round(py + dy)
        if (ix < 0 || ix >= size || iy < 0 || iy >= size) continue

        const offset = (iy * size + ix) * 4
        if (buffer[offset + 3] === 0) continue

        buffer[offset + 0] = 255
        buffer[offset + 1] = 255
        buffer[offset + 2] = 255
        buffer[offset + 3] = 255
      }
    }
  }
}

function generateIconRgba(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const center = size / 2
  const padding = size * 0.07
  const cornerRadius = size * 0.18

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const fx = x + 0.5
      const fy = y + 0.5
      const qx = Math.max(0, Math.abs(fx - center) - (center - padding - cornerRadius))
      const qy = Math.max(0, Math.abs(fy - center) - (center - padding - cornerRadius))
      const distance = Math.sqrt(qx * qx + qy * qy) - cornerRadius

      if (distance >= 0.5) continue

      const alpha = distance < -0.5 ? 255 : Math.round((0.5 - distance) * 255)
      const offset = (y * size + x) * 4

      rgba[offset + 0] = 99
      rgba[offset + 1] = 102
      rgba[offset + 2] = 241
      rgba[offset + 3] = alpha
    }
  }

  const thickness = Math.max(1.5, size * 0.075)
  drawLine(rgba, size, size * 0.23, size * 0.52, size * 0.41, size * 0.7, thickness)
  drawLine(rgba, size, size * 0.41, size * 0.7, size * 0.77, size * 0.3, thickness)

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
