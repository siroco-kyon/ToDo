import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import { createClickOnceReleaseRouter, createClickOnceRouter } from '../src/routes/clickonce'

const METADATA = {
  version: '1.0.8.0',
  applicationUrl: '/clickonce/HAKOBI.application',
  publishedAt: '2026-10-22T00:00:00.000Z'
}

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-clickonce-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function publish(dir: string, metadata: unknown = METADATA): void {
  const payload = path.join(dir, 'Application Files', 'HAKOBI_1_0_8_0')
  fs.mkdirSync(path.join(payload, 'app'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'clickonce-release.json'), JSON.stringify(metadata))
  const version = (metadata as { version?: string } | null)?.version ?? METADATA.version
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), `<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1"><assemblyIdentity name="HAKOBI" version="${version}" /><description>deployment</description></assembly>`)
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>ClickOnce インストール</html>')
  fs.writeFileSync(path.join(payload, 'HAKOBI.ClickOnce.exe.manifest'), '<assembly>application</assembly>')
  fs.writeFileSync(path.join(payload, 'app', 'HAKOBI.exe.deploy'), 'electron payload')
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

async function startServer(t: test.TestContext, dir: string) {
  const app = express()
  app.use('/api/clickonce-release', createClickOnceReleaseRouter(dir))
  app.use('/clickonce', createClickOnceRouter(dir))
  // Any accidental fallthrough becomes an observable authentication/SPA failure.
  app.use('/api', (_req, res) => { res.status(401).json({ error: '認証が必要です' }) })
  app.get('*', (_req, res) => { res.type('html').send('<html>SPA</html>') })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', resolve) })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  return {
    async raw(pathname: string, method = 'GET'): Promise<RawResponse> {
      // Keep traversal paths intact; fetch would normalize them before sending.
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
        })
        req.on('error', reject)
        req.end()
      })
    }
  }
}

test('ClickOnce 配布は認証なしで取得でき、MIME とキャッシュを使い分ける', async (t) => {
  const dir = tempDir(t)
  publish(dir)
  const server = await startServer(t, dir)
  const status = await server.raw('/api/clickonce-release')
  assert.equal(status.status, 200)
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.equal(status.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(JSON.parse(status.body), { available: true, ...METADATA, pageUrl: '/clickonce/' })
  const redirect = await server.raw('/clickonce')
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, '/clickonce/')
  for (const [url, type, content, cache] of [
    ['/clickonce/', 'text/html; charset=utf-8', 'ClickOnce インストール', 'no-store'],
    ['/clickonce/index.html', 'text/html; charset=utf-8', 'ClickOnce インストール', 'no-store'],
    ['/clickonce/HAKOBI.application', 'application/x-ms-application', 'deployment', 'no-store'],
    ['/clickonce/Application%20Files/HAKOBI_1_0_8_0/HAKOBI.ClickOnce.exe.manifest', 'application/x-ms-manifest', 'application', 'no-cache'],
    ['/clickonce/Application%20Files/HAKOBI_1_0_8_0/app/HAKOBI.exe.deploy', 'application/octet-stream', 'electron payload', 'no-cache']
  ]) {
    const res = await server.raw(url)
    assert.equal(res.status, 200, url)
    assert.equal(res.headers['content-type'], type, url)
    assert.equal(res.headers['cache-control'], cache, url)
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url)
    assert.ok(res.body.includes(content), url)
  }
  const manifestHead = await server.raw('/clickonce/HAKOBI.application', 'HEAD')
  assert.equal(manifestHead.status, 200)
  assert.equal(manifestHead.body, '')
  const json = await server.raw('/clickonce/clickonce-release.json')
  assert.equal(json.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(json.body), METADATA)
})

test('未配布・途中の配布・不正なメタデータは利用不可になり、配布先を漏らさない', async (t) => {
  const dir = path.join(tempDir(t), 'secret-distribution')
  const server = await startServer(t, dir)
  const unavailable = async () => {
    const status = await server.raw('/api/clickonce-release')
    assert.equal(status.status, 200)
    assert.deepEqual(JSON.parse(status.body), { available: false })
    const download = await server.raw('/clickonce/HAKOBI.application')
    assert.equal(download.status, 404)
    assert.equal(download.headers['cache-control'], 'no-store')
    assert.deepEqual(JSON.parse(download.body), { error: '見つかりません' })
    assert.ok(!download.body.includes(dir))
  }
  await unavailable()
  fs.mkdirSync(dir)
  await unavailable()
  for (const data of [
    {}, null, [],
    { ...METADATA, version: '1.0.8' },
    { ...METADATA, version: '01.0.8.0' },
    { ...METADATA, version: '65536.0.8.0' },
    { ...METADATA, version: '1.0.8.0/../../secret' },
    { ...METADATA, applicationUrl: 'https://example.invalid/evil.application' },
    { ...METADATA, publishedAt: 'invalid' }
  ]) {
    publish(dir, data)
    await unavailable()
  }
  publish(dir)
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), '<assembly><assemblyIdentity version="1.0.7.0" /><dependency><assemblyIdentity version="1.0.8.0" /></dependency></assembly>')
  await unavailable()
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), '<assembly><!-- <assemblyIdentity version="1.0.8.0" /> --><assemblyIdentity version="1.0.7.0" /></assembly>')
  await unavailable()
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), '<!DOCTYPE assembly [<!ENTITY version "1.0.8.0">]><assembly><assemblyIdentity version="&version;" /></assembly>')
  await unavailable()
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), '<assembly><assemblyIdentity version="1.0.8.0" version="1.0.7.0" /></assembly>')
  await unavailable()
  publish(dir)
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), '')
  await unavailable()
  fs.rmSync(path.join(dir, 'HAKOBI.application'))
  await unavailable()
  publish(dir)
  fs.writeFileSync(path.join(dir, 'clickonce-release.json'), '{')
  await unavailable()
  fs.writeFileSync(path.join(dir, 'clickonce-release.json'), ' '.repeat(16 * 1024 + 1))
  await unavailable()
})

test('パスの改変・証明書・ディレクトリを公開せず SPA へも流さない', async (t) => {
  const dir = tempDir(t)
  publish(dir)
  fs.writeFileSync(path.join(dir, 'secret.pfx'), 'private key')
  fs.writeFileSync(path.join(dir, '.env'), 'PASSWORD=secret')
  fs.writeFileSync(path.join(dir, 'Application Files', 'HAKOBI_1_0_8_0', 'secret.pfx'), 'private key')
  const server = await startServer(t, dir)
  const paths = [
    '/clickonce/secret.pfx', '/clickonce/.env', '/clickonce/setup.exe',
    '/clickonce/Application%20Files', '/clickonce/Application%20Files/',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/secret.pfx',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/missing.deploy',
    '/clickonce/../secret.pfx', '/clickonce/%2e%2e/secret.pfx',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/../../../secret.pfx',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/..%2fHAKOBI.application',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/..%5cHAKOBI.application',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/.secret.deploy',
    '/clickonce/Application%20Files/HAKOBI_1_0_8_0/app/HAKOBI.exe.deploy%00',
    '/clickonce/%E0%A4%A', '/api/clickonce-release/secret.pfx'
  ]
  for (const pathname of paths) {
    const res = await server.raw(pathname)
    assert.equal(res.status, 404, pathname)
    assert.equal(res.headers['cache-control'], 'no-store', pathname)
    assert.match(String(res.headers['content-type']), /application\/json/, pathname)
    assert.deepEqual(JSON.parse(res.body), { error: '見つかりません' }, pathname)
  }
  assert.equal((await server.raw('/clickonce/HAKOBI.application', 'POST')).status, 404)
})

test('配布物のシンボリックリンクやジャンクションは追わない', async (t) => {
  const root = tempDir(t)
  const dir = path.join(root, 'published')
  publish(dir)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.deploy'), 'secret')
  const link = path.join(dir, 'Application Files', 'HAKOBI_1_0_8_0', 'linked')
  // Windows junction creation does not require the privilege needed for file symlinks.
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const server = await startServer(t, dir)
  assert.equal((await server.raw('/clickonce/Application%20Files/HAKOBI_1_0_8_0/linked/secret.deploy')).status, 404)
  const rootLink = path.join(root, 'distribution-link')
  fs.symlinkSync(dir, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedServer = await startServer(t, rootLink)
  assert.deepEqual(JSON.parse((await linkedServer.raw('/api/clickonce-release')).body), { available: false })
})

test('再起動なしの配布更新を反映し、メタデータには公開項目だけを返す', async (t) => {
  const dir = tempDir(t)
  publish(dir)
  const server = await startServer(t, dir)
  assert.deepEqual(JSON.parse((await server.raw('/clickonce/clickonce-release.json')).body), METADATA)
  const next = { ...METADATA, version: '1.0.9.0', publishedAt: '2026-10-23T00:00:00.000Z' }
  publish(dir, { ...next, secretDistributionPath: dir })
  assert.deepEqual(JSON.parse((await server.raw('/api/clickonce-release')).body), { available: true, ...next, pageUrl: '/clickonce/' })
  assert.deepEqual(JSON.parse((await server.raw('/clickonce/clickonce-release.json')).body), next)
  fs.rmSync(path.join(dir, 'clickonce-release.json'))
  assert.deepEqual(JSON.parse((await server.raw('/api/clickonce-release')).body), { available: false })
  assert.equal((await server.raw('/clickonce/')).status, 404)
})

test('配布マニフェストの名前空間・属性の順序・引用符に対応する', async (t) => {
  const dir = tempDir(t)
  publish(dir)
  const server = await startServer(t, dir)
  fs.writeFileSync(path.join(dir, 'HAKOBI.application'), '\uFEFF<?xml version="1.0"?>\n<!-- generated --><asmv1:assembly manifestVersion="1.0" xmlns:asmv1="urn:schemas-microsoft-com:asm.v1">\n<asmv1:assemblyIdentity processorArchitecture="amd64"\nversion = \'1.0.8.0\' name="HAKOBI"/>\n</asmv1:assembly>')
  assert.deepEqual(JSON.parse((await server.raw('/api/clickonce-release')).body), { available: true, ...METADATA, pageUrl: '/clickonce/' })
})
