// Real server check for the public desktop installer download.
// Starts server/src/index.ts with an isolated data folder, a minimal Web build and an installer folder.
// No live DB or Windows service is touched.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { pathToFileURL } = require('node:url')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-desktop-download-'))
const admin = { username: 'hakobi_download_admin', password: 'hakobi-download-only-test-password' }
const sessionCookie = 'hakobi_download_test'
const spaMarker = 'hakobi-download-spa-fallback'
let server
let serverOutput = ''
let publishScratch = null

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([ended, delay(5000)])
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The isolated test server did not exit')
}

function writeRelease(dir, version, content) {
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `HAKOBI-${version}-setup.exe`
  const sha512 = crypto.createHash('sha512').update(content).digest('base64')
  fs.writeFileSync(path.join(dir, fileName), content)
  fs.writeFileSync(path.join(dir, 'latest.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${content.length}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-13T12:00:00.000Z'",
    ''
  ].join('\n'))
  return fileName
}

async function main() {
  const envFile = path.join(temporaryDir, 'empty.env')
  fs.writeFileSync(envFile, '')
  const webDist = path.join(temporaryDir, 'dist-web')
  fs.mkdirSync(webDist)
  fs.writeFileSync(path.join(webDist, 'index.html'), `<!doctype html><html><body><div id="root" data-test="${spaMarker}"></div></body></html>`)
  // The shared installer folder may sit under a dot-directory; it must still be served.
  const desktopDist = path.join(temporaryDir, '.shared', 'dist-desktop')
  const installer = crypto.randomBytes(512 * 1024 + 9)
  const fileName = writeRelease(desktopDist, '1.0.5', installer)

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'server/node_modules/tsx/dist/loader.mjs')).href,
    path.join(root, 'server/src/index.ts')
  ], {
    cwd: path.join(root, 'server'), windowsHide: true,
    env: { ...process.env, TODO_ENV_FILE: envFile, PORT: String(port),
      TODO_DATA_DIR: path.join(temporaryDir, 'server-data'), TODO_WEB_DIST: webDist, TODO_DESKTOP_DIST: desktopDist,
      ADMIN_USERNAME: admin.username, ADMIN_PASSWORD: admin.password, SESSION_COOKIE: sessionCookie }
  })
  server.stdout.on('data', (chunk) => { serverOutput += chunk })
  server.stderr.on('data', (chunk) => { serverOutput += chunk })
  const deadline = Date.now() + 20000
  let healthy = false
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })
      const health = await response.json()
      if (response.ok && health.ok && health.webReady) { healthy = true; break }
    } catch { /* Wait for the isolated server to listen. */ }
    await delay(150)
  }
  assert.ok(healthy, `Isolated server did not start: ${serverOutput}`)
  assert.ok(serverOutput.includes(`[server] デスクトップ版の配布フォルダ: ${desktopDist}（あり）`), serverOutput)

  // Anyone on the LAN can see and download the published installer without logging in.
  const info = await fetch(`${origin}/api/desktop-release`)
  assert.equal(info.status, 200)
  assert.equal(info.headers.get('cache-control'), 'no-store')
  const release = await info.json()
  assert.deepEqual(release, {
    available: true, version: '1.0.5', fileName, size: installer.length,
    sha256: crypto.createHash('sha256').update(installer).digest('hex'), releaseDate: '2026-10-13T12:00:00.000Z'
  })
  const download = await fetch(`${origin}/api/desktop-release/download`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="${fileName}"`)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(installer), 'The downloaded installer is byte-identical')
  console.log('[PASS] anonymous release info and installer download')

  const page = await fetch(`${origin}/download`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  assert.ok((await page.text()).includes(spaMarker), 'GET /download is the Web app (SPA fallback)')
  console.log('[PASS] /download page is served by the Web app')

  // The public router must not open up the authenticated API mounted after it.
  const todos = await fetch(`${origin}/api/todos`)
  assert.equal(todos.status, 401)
  await todos.arrayBuffer()
  const quickProgress = await fetch(`${origin}/api/desktop/quick-progress`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'test-000000000001', todoId: 'x', body: 'x', stopTimer: false })
  })
  assert.equal(quickProgress.status, 401)
  await quickProgress.arrayBuffer()
  const unknown = await fetch(`${origin}/api/desktop-release/latest.yml`)
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: '見つかりません' })
  console.log('[PASS] authenticated API stays closed and other release paths are JSON 404')

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(admin)
  })
  assert.equal(login.status, 200)
  await login.arrayBuffer()
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).find((value) => value.startsWith(`${sessionCookie}=`))
  assert.ok(cookie, 'Admin login did not set the session cookie')

  // Withdrawing the release takes effect without restarting the server.
  fs.rmSync(path.join(desktopDist, 'latest.yml'))
  const anonymousInfo = await fetch(`${origin}/api/desktop-release`)
  assert.deepEqual(await anonymousInfo.json(), { available: false }, 'Folder paths are never shown to non-admins')
  const adminInfo = await (await fetch(`${origin}/api/desktop-release`, { headers: { Cookie: cookie } })).json()
  assert.equal(adminInfo.available, false)
  assert.match(adminInfo.reason, /latest\.yml がありません/)
  const missing = await fetch(`${origin}/api/desktop-release/download`)
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/)
  const missingBody = await missing.text()
  assert.ok(!missingBody.includes(spaMarker), 'A withdrawn installer must not fall through to the SPA html')
  assert.deepEqual(JSON.parse(missingBody), { error: '配布中のインストーラーがありません' })
  console.log('[PASS] withdrawn release returns JSON 404 and the reason only to admins')

  // The admin runs the root script from any folder; relative --from/--to are taken from that folder.
  // The fixture lives inside the repo so that resolving from the wrong folder gives a different path.
  const callerDir = path.join(root, 'docs')
  publishScratch = fs.mkdtempSync(path.join(root, 'node_modules', '.hakobi-publish-test-'))
  const builtDist = path.join(publishScratch, 'built-dist')
  writeRelease(builtDist, '9.9.9', crypto.randomBytes(4096))
  const publishTarget = path.join(publishScratch, 'published')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const published = spawnSync(npm, ['run', 'publish:desktop', '--', '--from', path.relative(callerDir, builtDist),
    '--to', path.relative(callerDir, publishTarget), '--expect-version', '9.9.9'], {
    cwd: callerDir, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    env: { ...process.env, TODO_ENV_FILE: envFile }
  })
  assert.equal(published.status, 0, published.stdout + published.stderr)
  assert.match(published.stdout, /公開しました: HAKOBI 9\.9\.9/)
  assert.ok(fs.existsSync(path.join(publishTarget, 'latest.yml')), 'Relative paths must resolve from the folder npm was run in')
  assert.ok(fs.existsSync(path.join(publishTarget, 'HAKOBI-9.9.9-setup.exe')))
  console.log('[PASS] npm run publish:desktop resolves relative paths from the caller\'s folder')
}

async function run() {
  try {
    await main()
    console.log('HAKOBI desktop installer download server tests passed')
  } finally {
    await stop(server)
    // mkdtemp でこのテストが作った、OS一時フォルダ直下のディレクトリだけを削除する。
    assert.equal(path.dirname(path.resolve(temporaryDir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporaryDir).startsWith('hakobi-desktop-download-'))
    fs.rmSync(temporaryDir, { recursive: true, force: true })
    if (publishScratch) {
      // このテストが node_modules 直下に作ったフォルダだけを削除する。
      assert.equal(path.dirname(path.resolve(publishScratch)), path.join(root, 'node_modules'))
      assert.ok(path.basename(publishScratch).startsWith('.hakobi-publish-test-'))
      fs.rmSync(publishScratch, { recursive: true, force: true })
    }
  }
}

run().catch((error) => {
  console.error(error)
  if (serverOutput) console.error(`--- server output ---\n${serverOutput.replaceAll(admin.password, '[test password]')}`)
  process.exitCode = 1
})
