import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'

test('配布回数は全体送信のみ計測し、管理者にだけ公開して再起動後も残す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-download-counts-'))
  process.env.TODO_DATA_DIR = path.join(dir, 'data')
  process.env.TODO_ENV_FILE = path.join(dir, 'empty.env')
  fs.writeFileSync(process.env.TODO_ENV_FILE, '')
  const { initDb, getDb } = await import('../src/db/connection')
  const { createSchema } = await import('../src/db/schema')
  const { createDesktopReleaseRouter } = await import('../src/routes/desktopRelease')
  const { getDesktopDownloadStats } = await import('../src/db/desktopDownloads')
  initDb()
  // Simulate an existing server DB without the new table; upgrading is additive/idempotent.
  getDb().prepare("INSERT INTO Settings VALUES ('download-test', 'preserve')").run()
  getDb().exec('DROP TABLE DesktopDownloadCounts')
  createSchema(getDb())
  createSchema(getDb())
  assert.deepEqual(getDb().prepare("SELECT value FROM Settings WHERE key = 'download-test'").get(), { value: 'preserve' })

  function publish(version: string, size = 4096): void {
    const file = `HAKOBI-${version}-setup.exe`
    const bytes = Buffer.alloc(size, 42)
    fs.writeFileSync(path.join(dir, file), bytes)
    fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${file}\n    size: ${size}\n    sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}\n`)
  }
  publish('1.0.5')
  const app = express()
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role']
    if (role === 'admin' || role === 'member') {
      req.user = { id: role, username: role, display_name: role, role, color: '#6366f1', is_active: 1 }
    }
    next()
  })
  app.use('/api/desktop-release', createDesktopReleaseRouter(dir))
  const server = http.createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/desktop-release`
  async function request(suffix: string, options?: RequestInit): Promise<Response> {
    const response = await fetch(base + suffix, options)
    await response.arrayBuffer()
    return response
  }
  try {
    assert.equal((await request('/stats')).status, 401)
    assert.equal((await request('/stats', { headers: { 'x-test-role': 'member' } })).status, 403)
    const statsResponse = await fetch(base + '/stats', { headers: { 'x-test-role': 'admin' } })
    assert.equal(statsResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await statsResponse.json(), [])
    await request('')
    const head = await request('/download', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal((await request('/download', { headers: { Range: 'bytes=0-99' } })).status, 206)
    assert.equal((await request('/download', { headers: { Range: 'bytes=100-' } })).status, 206)
    assert.equal((await request('/download', { headers: { Range: 'bytes=999999-' } })).status, 416)
    const conditionalStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(base + '/download', { headers: { 'If-None-Match': head.headers.get('etag')! } }, (res) => {
        res.resume()
        res.once('end', () => resolve(res.statusCode))
      }).once('error', reject)
    })
    assert.equal(conditionalStatus, 304)
    assert.deepEqual(getDesktopDownloadStats(), [])
    await Promise.all(Array.from({ length: 5 }, () => request('/download')))
    assert.deepEqual(getDesktopDownloadStats(), [{ version: '1.0.5', downloadCount: 5 }])
    // The version is captured before sending, and switching releases retains older counts.
    publish('1.0.10')
    await request('/download')
    assert.deepEqual(getDesktopDownloadStats(), [
      { version: '1.0.10', downloadCount: 1 }, { version: '1.0.5', downloadCount: 5 }
    ])
    // Stop a large response while the server still has bytes to send.
    publish('1.0.11', 32 * 1024 * 1024)
    await new Promise<void>((resolve, reject) => {
      const req = http.get(base + '/download', (res) => {
        res.once('data', () => { res.destroy(); resolve() })
        res.once('error', reject)
      })
      req.once('error', reject)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(getDesktopDownloadStats().some((row) => row.version === '1.0.11'), false)
    fs.unlinkSync(path.join(dir, 'latest.yml'))
    assert.equal((await request('/download')).status, 404)
    assert.equal(getDesktopDownloadStats().length, 2)
    // Daily buckets aggregate correctly, without storing personal identifiers.
    getDb().prepare('INSERT INTO DesktopDownloadCounts VALUES (?, ?, ?)').run('1.0.5', '2000-01-01', 2)
    assert.deepEqual(getDb().prepare('PRAGMA table_info(DesktopDownloadCounts)').all().map((column) => (column as { name: string }).name),
      ['version', 'download_date', 'download_count'])
    getDb().close()
    initDb()
    assert.deepEqual(getDesktopDownloadStats(), [
      { version: '1.0.10', downloadCount: 1 }, { version: '1.0.5', downloadCount: 7 }
    ])
    const stats = await fetch(base + '/stats', { headers: { 'x-test-role': 'admin' } })
    assert.deepEqual(await stats.json(), getDesktopDownloadStats())
    // If recording fails, serving the installer still succeeds.
    publish('1.0.12')
    getDb().exec('DROP TABLE DesktopDownloadCounts')
    assert.equal((await request('/download')).status, 200)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    getDb().close()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('hakobi-download-counts-'))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
