import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import express from 'express'
import {
  createDesktopReleaseReader,
  parseLatestYml,
  verifyDesktopRelease
} from '../src/desktopRelease'
import { createDesktopReleaseRouter } from '../src/routes/desktopRelease'

const SERVER_DIR = path.resolve(__dirname, '..')
const TSX_CLI = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const RELEASE_DATE = '2026-10-13T12:00:00.000Z'
const NOT_PUBLISHED = { error: '配布中のインストーラーがありません' }

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-desktop-release-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface YmlFields {
  version: string
  url: string
  sha512: string
  size: number
  path?: string | null
  topSha512?: string | null
  extraFiles?: string[]
}

/** electron-builder 24 が出力する形の latest.yml */
function latestYml(fields: YmlFields): string {
  const lines = [
    `version: ${fields.version}`,
    'files:',
    `  - url: ${fields.url}`,
    `    sha512: ${fields.sha512}`,
    `    size: ${fields.size}`,
    ...(fields.extraFiles ?? [])
  ]
  if (fields.path !== null) lines.push(`path: ${fields.path ?? fields.url}`)
  if (fields.topSha512 !== null) lines.push(`sha512: ${fields.topSha512 ?? fields.sha512}`)
  lines.push(`releaseDate: '${RELEASE_DATE}'`, '')
  return lines.join('\n')
}

interface Fixture {
  dir: string
  version: string
  fileName: string
  content: Buffer
  sha512: string
  sha256: string
}

function writeRelease(dir: string, version = '1.0.5', content = crypto.randomBytes(256 * 1024 + 17)): Fixture {
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `HAKOBI-${version}-setup.exe`
  fs.writeFileSync(path.join(dir, fileName), content)
  const sha512 = crypto.createHash('sha512').update(content).digest('base64')
  const sha256 = crypto.createHash('sha256').update(content).digest('hex')
  fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ version, url: fileName, sha512, size: content.length }))
  return { dir, version, fileName, content, sha512, sha256 }
}

interface TestServer {
  origin: string
  json(pathname: string, admin?: boolean): Promise<{ status: number; headers: Headers; body: unknown }>
  raw(pathname: string, method?: string): Promise<{ status: number; type: string; body: string }>
}

async function startServer(t: test.TestContext, dir: string): Promise<TestServer> {
  const app = express()
  // 本番では attachUser が付ける req.user の代わり
  app.use((req, _res, next) => {
    if (req.headers['x-test-role'] === 'admin') {
      req.user = { id: 'admin', username: 'admin', display_name: '管理者', role: 'admin', color: '#3b82f6',
        is_active: 1, created_at: RELEASE_DATE, updated_at: RELEASE_DATE }
    }
    next()
  })
  app.use('/api/desktop-release', createDesktopReleaseRouter(dir))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', resolve) })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    async json(pathname, admin = false) {
      const response = await fetch(origin + pathname, { headers: admin ? { 'x-test-role': 'admin' } : {} })
      return { status: response.status, headers: response.headers, body: await response.json() }
    },
    // fetch はパスの .. を正規化してしまうので、生のパスのまま送る
    raw(pathname, method = 'GET') {
      return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: pathname, method }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, type: String(response.headers['content-type'] ?? ''), body }))
        })
        request.on('error', reject)
        request.end()
      })
    }
  }
}

async function assertUnavailable(server: TestServer, reasonPattern: RegExp, label = ''): Promise<void> {
  const anonymous = await server.json('/api/desktop-release')
  assert.equal(anonymous.status, 200, label)
  assert.equal(anonymous.headers.get('cache-control'), 'no-store', label)
  assert.deepEqual(anonymous.body, { available: false }, `${label} 管理者以外には理由（フォルダのパス）を返さない`)
  const admin = await server.json('/api/desktop-release', true)
  assert.equal((admin.body as { available: boolean }).available, false, label)
  assert.match((admin.body as { reason: string }).reason, reasonPattern, label)
  const download = await server.json('/api/desktop-release/download')
  assert.equal(download.status, 404, label)
  assert.match(download.headers.get('content-type') ?? '', /application\/json/, label)
  assert.equal(download.headers.get('content-disposition'), null, label)
  assert.deepEqual(download.body, NOT_PUBLISHED, label)
}

test('latest.yml の読み取り: electron-builder の出力・引用符・知らないキー・CRLF', () => {
  const text = [
    'version: 1.0.5',
    'files:',
    '  - url: HAKOBI-1.0.5-setup.exe',
    '    sha512: abc+/def==',
    '    size: 87654321',
    '    isAdminRightsRequired: false',
    '    blockMapSize: 91234',
    'path: "HAKOBI-1.0.5-setup.exe"',
    'sha512: abc+/def==',
    'sha2: 0123456789abcdef',
    "releaseDate: '2026-10-13T12:00:00.000Z'",
    ''
  ].join('\r\n')
  assert.deepEqual(parseLatestYml('\uFEFF' + text), {
    version: '1.0.5',
    path: 'HAKOBI-1.0.5-setup.exe',
    sha512: 'abc+/def==',
    releaseDate: '2026-10-13T12:00:00.000Z',
    files: [{ url: 'HAKOBI-1.0.5-setup.exe', sha512: 'abc+/def==', size: 87654321 }]
  })

  const unindented = parseLatestYml('version: 1.0.6\nfiles:\n- url: a.exe\n  size: 10\n- url: b.exe\n  size: x\npath: a.exe\n')
  assert.deepEqual(unindented.files, [{ url: 'a.exe', sha512: null, size: 10 }, { url: 'b.exe', sha512: null, size: null }])
  assert.equal(unindented.path, 'a.exe')
  assert.deepEqual(parseLatestYml('version: 1.0.5\nfiles: []\n').files, [])
  assert.deepEqual(parseLatestYml(''), { version: null, path: null, sha512: null, releaseDate: null, files: [] })
})

test('配布フォルダが無いときは配布しない（理由は管理者にだけ返す）', async (t) => {
  const missing = path.join(tempDir(t), 'dist-desktop')
  const server = await startServer(t, missing)
  await assertUnavailable(server, /配布フォルダ .*dist-desktop がありません/)

  fs.mkdirSync(missing)
  await assertUnavailable(server, /latest\.yml がありません/)
})

test('正しい配布物はログインなしで情報とファイルを返す（HEAD・Range 対応）', async (t) => {
  const fixture = writeRelease(path.join(tempDir(t), 'dist-desktop'))
  fs.writeFileSync(path.join(fixture.dir, `${fixture.fileName}.blockmap`), 'blockmap')
  const server = await startServer(t, fixture.dir)

  const info = await server.json('/api/desktop-release')
  assert.equal(info.status, 200)
  assert.equal(info.headers.get('cache-control'), 'no-store')
  assert.deepEqual(info.body, {
    available: true,
    version: '1.0.5',
    fileName: 'HAKOBI-1.0.5-setup.exe',
    size: fixture.content.length,
    sha256: fixture.sha256,
    releaseDate: RELEASE_DATE
  })
  assert.deepEqual((await server.json('/api/desktop-release', true)).body, info.body)
  assert.deepEqual(await verifyDesktopRelease(fixture.dir), {
    ok: true,
    release: { version: '1.0.5', fileName: fixture.fileName, size: fixture.content.length,
      sha256: fixture.sha256, sha512: fixture.sha512, releaseDate: RELEASE_DATE }
  })

  const download = await fetch(`${server.origin}/api/desktop-release/download`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="HAKOBI-1.0.5-setup.exe"')
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.equal(download.headers.get('cache-control'), 'no-cache')
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(download.headers.get('content-length'), String(fixture.content.length))
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(fixture.content), 'インストーラーの中身をそのまま返す')

  const head = await fetch(`${server.origin}/api/desktop-release/download`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(fixture.content.length))
  assert.equal(head.headers.get('content-disposition'), 'attachment; filename="HAKOBI-1.0.5-setup.exe"')
  assert.equal((await head.arrayBuffer()).byteLength, 0)

  const partial = await fetch(`${server.origin}/api/desktop-release/download`, { headers: { Range: 'bytes=100-1123' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 100-1123/${fixture.content.length}`)
  assert.ok(Buffer.from(await partial.arrayBuffer()).equals(fixture.content.subarray(100, 1124)), '途中から再開できる')

  const unsatisfiable = await fetch(`${server.origin}/api/desktop-release/download`, {
    headers: { Range: `bytes=${fixture.content.length + 10}-` }
  })
  assert.equal(unsatisfiable.status, 416)
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${fixture.content.length}`)
  await unsatisfiable.arrayBuffer()
})

test('latest.yml とインストーラーが食い違うものは配布しない', async (t) => {
  const root = tempDir(t)
  const content = crypto.randomBytes(4096)
  const sha512 = crypto.createHash('sha512').update(content).digest('base64')
  const fileName = 'HAKOBI-1.0.5-setup.exe'
  const base: YmlFields = { version: '1.0.5', url: fileName, sha512, size: content.length }
  const cases: Array<{ name: string; reason: RegExp; setup(dir: string): void }> = [
    { name: 'missing-file', reason: /HAKOBI-1\.0\.5-setup\.exe が配布フォルダ .* にありません/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml(base))
    } },
    { name: 'wrong-size', reason: /大きさ/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, size: content.length + 1 }))
    } },
    { name: 'wrong-sha512', reason: /sha512 がインストーラー/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      const other = crypto.createHash('sha512').update('other').digest('base64')
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, sha512: other }))
    } },
    { name: 'outside-pattern', reason: /配布できる形式/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, 'evil.exe'), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, url: 'evil.exe' }))
    } },
    { name: 'outside-pattern-suffix', reason: /配布できる形式/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, `${fileName}.bak`), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, url: `${fileName}.bak` }))
    } },
    { name: 'parent-folder', reason: /配布できる形式/, setup: (dir) => {
      fs.writeFileSync(path.join(path.dirname(dir), fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, url: `../${fileName}` }))
    } },
    { name: 'version-mismatch', reason: /version（1\.0\.6）/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, version: '1.0.6' }))
    } },
    { name: 'two-files', reason: /1つだけ.*2件/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, extraFiles: [
        '  - url: HAKOBI-1.0.5-portable.exe', `    sha512: ${sha512}`, `    size: ${content.length}`
      ] }))
    } },
    { name: 'no-files', reason: /1つだけ.*0件/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 1.0.5\npath: ${fileName}\nsha512: ${sha512}\n`)
    } },
    { name: 'path-differs', reason: /path（HAKOBI-1\.0\.4-setup\.exe）/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, path: 'HAKOBI-1.0.4-setup.exe' }))
    } },
    { name: 'top-sha512-differs', reason: /files の sha512/, setup: (dir) => {
      fs.writeFileSync(path.join(dir, fileName), content)
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml({ ...base, topSha512: 'AAAA' }))
    } },
    { name: 'directory', reason: /ファイルではありません/, setup: (dir) => {
      fs.mkdirSync(path.join(dir, fileName))
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml(base))
    } }
  ]

  const symlinkTarget = path.join(root, 'elsewhere.exe')
  fs.writeFileSync(symlinkTarget, content)
  try {
    const probe = path.join(root, 'symlink-probe')
    fs.symlinkSync(symlinkTarget, probe, 'file')
    fs.unlinkSync(probe)
    cases.push({ name: 'symlink', reason: /シンボリックリンク/, setup: (dir) => {
      fs.symlinkSync(symlinkTarget, path.join(dir, fileName), 'file')
      fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml(base))
    } })
  } catch {
    t.diagnostic('この環境ではシンボリックリンクを作れないため、シンボリックリンクの確認を省きます')
  }

  for (const entry of cases) {
    // 親フォルダへの書き込みが他のケースに混ざらないよう、ケースごとに分ける
    const dir = path.join(root, entry.name, 'dist-desktop')
    fs.mkdirSync(dir, { recursive: true })
    entry.setup(dir)
    const server = await startServer(t, dir)
    await assertUnavailable(server, entry.reason, entry.name)
    const result = await verifyDesktopRelease(dir)
    assert.equal(result.ok, false, entry.name)
  }
})

test('途中に .フォルダ があるパスでも配布できる', async (t) => {
  const fixture = writeRelease(path.join(tempDir(t), '.config', 'hakobi', 'dist-desktop'), '1.0.5', crypto.randomBytes(2048))
  const server = await startServer(t, fixture.dir)
  const download = await fetch(`${server.origin}/api/desktop-release/download`)
  assert.equal(download.status, 200)
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(fixture.content))
})

test('ルーターの下のほかのパスは JSON の 404（配布フォルダのファイルを直接読ませない）', async (t) => {
  const fixture = writeRelease(path.join(tempDir(t), 'dist-desktop'), '1.0.5', crypto.randomBytes(2048))
  fs.writeFileSync(path.join(path.dirname(fixture.dir), 'secret.txt'), 'secret')
  const server = await startServer(t, fixture.dir)
  const paths = [
    '/api/desktop-release/latest.yml',
    `/api/desktop-release/${fixture.fileName}`,
    '/api/desktop-release/../secret.txt',
    '/api/desktop-release/download/../latest.yml',
    '/api/desktop-release/download/..%2F..%2Fsecret.txt',
    '/api/desktop-release/%2e%2e/secret.txt',
    `/api/desktop-release/download/${fixture.fileName}`,
    '/api/desktop-release/download%2F..%2Flatest.yml'
  ]
  for (const pathname of paths) {
    const response = await server.raw(pathname)
    assert.equal(response.status, 404, pathname)
    assert.match(response.type, /application\/json/, pathname)
    assert.deepEqual(JSON.parse(response.body), { error: '見つかりません' }, pathname)
  }
  const post = await server.raw('/api/desktop-release/download', 'POST')
  assert.equal(post.status, 404)
  assert.deepEqual(JSON.parse(post.body), { error: '見つかりません' })
})

test('ファイルの差し替えは再起動なしで反映し、変わらなければ結果を使い回す', async (t) => {
  const dir = path.join(tempDir(t), 'dist-desktop')
  const first = writeRelease(dir, '1.0.5', crypto.randomBytes(8192))
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')) }
  t.after(() => { console.log = originalLog })

  const reader = createDesktopReleaseReader(dir)
  const [a, b] = await Promise.all([reader.read(), reader.read()])
  assert.equal(a, b, '同時の確認は1回の読み込みを共有する')
  assert.equal(await reader.read(), a, '変わっていなければ前回の結果を使う')
  assert.ok(a.ok && a.release.sha256 === first.sha256)

  // コピー中のように中身だけ変わる（大きさは同じ）
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.writeFileSync(path.join(dir, first.fileName), crypto.randomBytes(first.content.length))
  const corrupted = await reader.read()
  assert.equal(corrupted.ok, false)
  assert.equal(await reader.read(), corrupted)

  const second = writeRelease(dir, '1.0.6', crypto.randomBytes(4096))
  const updated = await reader.read()
  assert.ok(updated.ok)
  assert.equal(updated.release.version, '1.0.6')
  assert.equal(updated.release.sha256, second.sha256)
  assert.ok(fs.existsSync(path.join(dir, first.fileName)), '古いインストーラーは残っていてよい')
  const desktopLogs = logs.filter((line) => line.startsWith('[desktop]'))
  assert.equal(desktopLogs.length, 3, desktopLogs.join('\n'))
  assert.match(desktopLogs[0], /1\.0\.5 を配布しています/)
  assert.match(desktopLogs[1], /配布していません: latest\.yml の sha512/)
  assert.match(desktopLogs[2], /1\.0\.6 を配布しています/)

  // HTTP 経由でも、サーバーを作り直さずに反映する
  const server = await startServer(t, dir)
  assert.equal(((await server.json('/api/desktop-release')).body as { version: string }).version, '1.0.6')
  fs.rmSync(path.join(dir, 'latest.yml'))
  await assertUnavailable(server, /latest\.yml がありません/)
  const third = writeRelease(dir, '1.0.7', crypto.randomBytes(1024))
  const info = await server.json('/api/desktop-release')
  assert.equal((info.body as { version: string }).version, '1.0.7')
  const download = await fetch(`${server.origin}/api/desktop-release/download`)
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(third.content))
})

function runPublish(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const emptyEnv = path.join(os.tmpdir(), `hakobi-publish-empty-${process.pid}.env`)
  fs.writeFileSync(emptyEnv, '')
  try {
    const child = spawnSync(process.execPath, [TSX_CLI, 'scripts/publish-desktop.ts', ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, TODO_ENV_FILE: emptyEnv, PORT: '4599', TODO_DESKTOP_DIST: '', INIT_CWD: SERVER_DIR, ...env },
      encoding: 'utf8',
      timeout: 30000
    })
    return { status: child.status, stdout: child.stdout, stderr: child.stderr }
  } finally {
    fs.rmSync(emptyEnv, { force: true })
  }
}

function writeBuildOutput(dir: string, version: string): Fixture {
  const fixture = writeRelease(dir, version, crypto.randomBytes(64 * 1024 + 3))
  fs.writeFileSync(path.join(dir, `${fixture.fileName}.blockmap`), crypto.randomBytes(300))
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'unrelated: true\n')
  return fixture
}

test('publish:desktop は検証してから配布フォルダへ公開する', async (t) => {
  const root = tempDir(t)
  const dist = path.join(root, 'dist')
  const target = path.join(root, 'published', 'dist-desktop')
  const fixture = writeBuildOutput(dist, '2.3.4')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'HAKOBI-2.3.3-setup.exe'), 'older')

  const result = runPublish(['--from', dist, '--to', target, '--expect-version', '2.3.4'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, new RegExp(`公開しました: HAKOBI 2\\.3\\.4（${target.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}）`))
  assert.match(result.stdout, /http:\/\/<サーバー>:4599\/download を案内してください/)
  assert.ok(fs.readFileSync(path.join(target, fixture.fileName)).equals(fixture.content))
  assert.ok(fs.readFileSync(path.join(target, `${fixture.fileName}.blockmap`)).equals(fs.readFileSync(path.join(dist, `${fixture.fileName}.blockmap`))))
  assert.equal(fs.readFileSync(path.join(target, 'latest.yml'), 'utf8'), fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(target, 'HAKOBI-2.3.3-setup.exe'), 'utf8'), 'older', '古いインストーラーは消さない')
  assert.deepEqual(fs.readdirSync(target).filter((name) => name.endsWith('.partial')), [])
  assert.equal(fs.existsSync(path.join(target, 'builder-debug.yml')), false)

  const published = await createDesktopReleaseReader(target).read()
  assert.ok(published.ok)
  assert.equal(published.release.version, '2.3.4')
  assert.equal(published.release.sha256, fixture.sha256)

  // 相対パスは npm を実行したフォルダ（INIT_CWD）から解決する
  const relativeTarget = path.join(root, 'relative-target')
  const relative = runPublish(['--from', 'dist', '--to', 'relative-target', '--expect-version', '2.3.4'], { INIT_CWD: root })
  assert.equal(relative.status, 0, relative.stdout + relative.stderr)
  assert.ok((await verifyDesktopRelease(relativeTarget)).ok)
})

test('publish:desktop は中身やバージョンが合わないものを公開しない', async (t) => {
  const root = tempDir(t)
  const rootVersion = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, '..', 'package.json'), 'utf8')).version as string
  const [major, minor, patch] = rootVersion.split('.').map(Number)
  const otherVersion = `${major}.${minor}.${patch + 1}`

  const broken = path.join(root, 'broken')
  const brokenFixture = writeBuildOutput(broken, '2.3.4')
  fs.writeFileSync(path.join(broken, brokenFixture.fileName), crypto.randomBytes(brokenFixture.content.length))
  const brokenTarget = path.join(root, 'broken-target')
  const shaMismatch = runPublish(['--from', broken, '--to', brokenTarget, '--expect-version', '2.3.4'])
  assert.equal(shaMismatch.status, 1)
  assert.match(shaMismatch.stderr, /公開できませんでした: 公開元のインストーラーを確認できませんでした: latest\.yml の sha512/)
  assert.equal(fs.existsSync(brokenTarget), false, '検証に失敗したら何も書かない')

  const dist = path.join(root, 'dist')
  writeBuildOutput(dist, otherVersion)
  const target = path.join(root, 'target')
  const expected = runPublish(['--from', dist, '--to', target, '--expect-version', rootVersion])
  assert.equal(expected.status, 1)
  assert.match(expected.stderr, new RegExp(`バージョン ${otherVersion.replace(/\./g, '\\.')} が --expect-version`))
  const fromPackage = runPublish(['--from', dist, '--to', target])
  assert.equal(fromPackage.status, 1)
  assert.match(fromPackage.stderr, /package\.json のバージョン/)
  assert.equal(fs.existsSync(target), false)

  // --expect-version を省くとリポジトリ直下の package.json の version と照合する
  const current = path.join(root, 'current')
  writeBuildOutput(current, rootVersion)
  const ok = runPublish(['--from', current, '--to', target])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.ok((await verifyDesktopRelease(target)).ok)

  const sameFolder = runPublish(['--from', target, '--to', target])
  assert.equal(sameFolder.status, 1)
  assert.match(sameFolder.stderr, /同じフォルダ/)
  const badOption = runPublish(['--unknown'])
  assert.equal(badOption.status, 1)
  assert.match(badOption.stderr, /分からない指定です: --unknown/)
})
