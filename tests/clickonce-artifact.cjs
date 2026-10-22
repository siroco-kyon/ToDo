// Exercise the real signed publication through the public Express routes, without
// installing the application, touching a database or starting the production server.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { build } = require('esbuild')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')
const serverRequire = createRequire(path.join(root, 'server/package.json'))

async function main() {
  assert.ok(process.argv[2], 'Specify a signed release folder: node tests/clickonce-artifact.cjs release/clickonce/1.0.5.1')
  const directory = path.resolve(process.argv[2])
  const { version } = JSON.parse(fs.readFileSync(path.join(directory, 'clickonce-release.json'), 'utf8'))
  const code = (await build({ entryPoints: [path.join(root, 'server/src/routes/clickonce.ts')],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: serverRequire })
  const express = serverRequire('express')
  const app = express()
  app.use('/api/clickonce-release', module.exports.createClickOnceReleaseRouter(directory))
  app.use('/clickonce', module.exports.createClickOnceRouter(directory))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const status = await fetch(`${base}/api/clickonce-release`)
    assert.equal((await status.json()).version, version)
    const page = await fetch(`${base}/clickonce/`)
    assert.match(await page.text(), /href="HAKOBI\.application"/)
    const manifest = await fetch(`${base}/clickonce/HAKOBI.application`)
    assert.equal(manifest.headers.get('content-type'), 'application/x-ms-application')
    const xml = await manifest.text()
    assert.ok(xml.includes(`version="${version}"`))
    const versionFolder = fs.readdirSync(path.join(directory, 'Application Files'))[0]
    const files = path.join(directory, 'Application Files', versionFolder)
    const applicationManifest = fs.readdirSync(files).find((name) => name.endsWith('.manifest'))
    const servedManifest = await fetch(`${base}/clickonce/Application%20Files/${encodeURIComponent(versionFolder)}/${applicationManifest}`)
    assert.equal(servedManifest.headers.get('content-type'), 'application/x-ms-manifest')
    assert.match(await servedManifest.text(), /<Signature\b/)
    const relative = `Application Files/${versionFolder}/payload/resources/app.asar.deploy`
    const payload = await fetch(new URL(`/clickonce/${relative}`, base))
    assert.equal(payload.status, 200)
    assert.equal(payload.headers.get('content-type'), 'application/octet-stream')
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
    assert.equal(hash(Buffer.from(await payload.arrayBuffer())), hash(fs.readFileSync(path.join(directory, relative))))
    assert.equal((await fetch(`${base}/clickonce/private-key.pfx`)).status, 404)
    console.log(`Real ClickOnce ${version}: status, install page, manifests and Electron payload served successfully`)
  } finally { await new Promise((resolve) => server.close(resolve)) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
