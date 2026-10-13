// Web UI side of the desktop installer download: version checks, the server answer, the download page and the update notice.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { build } = require('esbuild')
const yaml = require('js-yaml')
const { renderToStaticMarkup } = require('react-dom/server')
const React = require('react')

const root = path.resolve(__dirname, '..')
const ORIGIN = 'http://team.local:4577'
const bundle = async (entry, plugins = []) => (await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'], alias: { '@renderer': path.join(root, 'src/renderer/src') }, plugins })).outputFiles[0].text

function load(code, globals = {}) {
  const module = { exports: {} }
  vm.runInContext(code, vm.createContext({ module, exports: module.exports, require, console, URL, AbortController,
    window: { location: { origin: ORIGIN, href: `${ORIGIN}/somewhere/deep?from=${encodeURIComponent('http://evil.example')}#hash`, pathname: '/somewhere/deep' } },
    ...globals }))
  return module.exports
}
// Values built inside the VM carry another realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value))

let libCode = ''
const validRelease = { version: '1.0.5', fileName: 'HAKOBI-1.0.5-setup.exe', size: 87654321,
  sha256: 'ab'.repeat(32), releaseDate: '2026-10-13T12:00:00.000Z' }

function testVersions() {
  const lib = load(libCode)
  assert.equal(lib.LAST_VERSION_WITHOUT_APP_VERSION, '1.0.4')
  assert.equal(lib.compareVersions('1.0.10', '1.0.9'), 1, 'versions compare numerically, not as text')
  assert.equal(lib.compareVersions('1.0.9', '1.0.10'), -1)
  assert.equal(lib.compareVersions('1.2.0', '1.10.0'), -1)
  assert.equal(lib.compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(lib.compareVersions('1.0.5', '1.0.5'), 0)
  for (const [a, b] of [['1.0', '1.0.0'], ['1.0.5-beta', '1.0.5'], ['v1.0.5', '1.0.5'], ['1.0.5 ', '1.0.5'], ['', '1.0.0'],
    ['1.0.5', 'x.y.z'], ['1.0.0.1', '1.0.0'], ['99999999999999999999.0.0', '1.0.0'], [undefined, '1.0.0'], [105, '1.0.0']]) {
    assert.equal(lib.compareVersions(a, b), null, `not an x.y.z pair: ${a} / ${b}`)
  }

  assert.equal(lib.installedDesktopVersion({ appVersion: '1.0.5' }), '1.0.5')
  for (const context of [{}, { appVersion: undefined }, { appVersion: '' }, { appVersion: 'dev' }, null, undefined]) {
    assert.equal(lib.installedDesktopVersion(context), '1.0.4', 'apps that do not report a version are 1.0.4 or older')
  }

  const release = (version) => ({ ...validRelease, version, fileName: `HAKOBI-${version}-setup.exe` })
  assert.equal(lib.isNewerDesktopRelease(release('1.0.5'), {}), true, 'a 1.0.4 app learns about 1.0.5')
  assert.equal(lib.isNewerDesktopRelease(release('1.0.4'), {}), false)
  assert.equal(lib.isNewerDesktopRelease(release('1.0.5'), { appVersion: '1.0.5' }), false)
  assert.equal(lib.isNewerDesktopRelease(release('1.0.10'), { appVersion: '1.0.9' }), true)
  assert.equal(lib.isNewerDesktopRelease(release('1.0.5'), { appVersion: '1.1.0' }), false, 'a server offering an older build is not an update')
  assert.equal(lib.isNewerDesktopRelease(null, {}), false)

  assert.equal(lib.isDismissedDesktopRelease(release('1.0.5'), null), false)
  assert.equal(lib.isDismissedDesktopRelease(release('1.0.5'), '1.0.5'), true, '「後で」 hides that version')
  assert.equal(lib.isDismissedDesktopRelease(release('1.0.6'), '1.0.5'), false, 'a newer version shows again')
  assert.equal(lib.isDismissedDesktopRelease(release('1.0.5'), '1.0.6'), true, 'a rollback does not ask again')
  assert.equal(lib.isDismissedDesktopRelease(release('1.0.5'), 'garbage'), false)

  assert.deepEqual([0, 512, 2048, 87654321, 3 * 1024 ** 3].map(lib.formatBytes), ['0 B', '512 B', '2.0 KB', '83.6 MB', '3.0 GB'])
  assert.equal(lib.formatBytes(-1), '-')
  assert.equal(lib.formatBytes(NaN), '-')
}

async function testFetch() {
  const requests = []
  let respond = async () => ({ ok: true, status: 200, json: async () => ({ available: true, ...validRelease }) })
  const lib = load(libCode, { fetch: async (url, options) => { requests.push({ url, options }); return respond() } })
  const json = (body, status = 200) => () => ({ ok: status < 400, status, json: async () => body })

  const signal = new AbortController().signal
  assert.deepEqual(plain(await lib.fetchDesktopRelease(signal)), { release: validRelease, reason: null })
  assert.equal(requests[0].url, '/api/desktop-release')
  assert.equal(requests[0].options.credentials, 'same-origin')
  assert.equal(requests[0].options.cache, 'no-store')
  assert.equal(requests[0].options.signal, signal)

  respond = json({ available: true, ...validRelease, sha256: 'AB'.repeat(32), releaseDate: null, extra: 'ignored' })
  assert.deepEqual(plain(await lib.fetchDesktopRelease()), { release: { ...validRelease, releaseDate: null }, reason: null })
  respond = json({ available: true, ...validRelease, releaseDate: undefined })
  assert.equal((await lib.fetchDesktopRelease()).release.releaseDate, null)

  respond = json({ available: false })
  assert.deepEqual(plain(await lib.fetchDesktopRelease()), { release: null, reason: null })
  respond = json({ available: false, reason: '配布フォルダ C:\\HakobiServer\\dist-desktop に latest.yml がありません' })
  assert.deepEqual(plain(await lib.fetchDesktopRelease()), { release: null, reason: '配布フォルダ C:\\HakobiServer\\dist-desktop に latest.yml がありません' })
  for (const reason of [1, { text: 'x' }, ['x'], null]) {
    respond = json({ available: false, reason })
    assert.deepEqual(plain(await lib.fetchDesktopRelease()), { release: null, reason: null }, 'only a text reason is shown')
  }
  respond = json({ available: 'true', ...validRelease })
  assert.deepEqual(plain(await lib.fetchDesktopRelease()), { release: null, reason: null }, 'only available: true offers a release')

  for (const status of [401, 404, 500]) {
    respond = json({ error: '認証が必要です' }, status)
    assert.equal(await lib.fetchDesktopRelease(), null, `an older server answers ${status}`)
  }
  respond = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })
  assert.equal(await lib.fetchDesktopRelease(), null, 'an HTML page is not an answer')
  respond = () => { throw new TypeError('Failed to fetch') }
  assert.equal(await lib.fetchDesktopRelease(), null, 'network errors are not thrown')
  respond = () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  assert.equal(await lib.fetchDesktopRelease(), null)
  for (const body of [null, 'available', ['available'], 1]) {
    respond = json(body)
    assert.equal(await lib.fetchDesktopRelease(), null, `not this API: ${JSON.stringify(body)}`)
  }

  const malformed = [
    { version: 1.05 }, { version: '1.0' }, { version: '1.0.5-beta', fileName: 'HAKOBI-1.0.5-beta-setup.exe' }, { version: '<b>1</b>' },
    { fileName: 'HAKOBI-1.0.6-setup.exe' }, { fileName: 'HAKOBI-1.0.5-setup.msi' }, { fileName: '../HAKOBI-1.0.5-setup.exe' },
    { fileName: 'C:\\dist\\HAKOBI-1.0.5-setup.exe' }, { fileName: 'hakobi-1.0.5-setup.exe' }, { fileName: 'HAKOBI-1.0.5-setup.exe\n' },
    { fileName: undefined }, { size: '87654321' }, { size: 0 }, { size: -5 }, { size: 1.5 }, { size: Number.MAX_VALUE },
    { sha256: 'ab'.repeat(31) }, { sha256: 'zz'.repeat(32) }, { sha256: 123 }, { sha256: undefined },
    { releaseDate: 20261013 }, { releaseDate: { at: 'today' } }, { releaseDate: 'x'.repeat(101) }
  ]
  for (const patch of malformed) {
    respond = json({ available: true, ...validRelease, ...patch })
    assert.deepEqual(plain(await lib.fetchDesktopRelease()), { release: null, reason: null }, `malformed release accepted: ${JSON.stringify(patch)}`)
  }

  assert.equal(lib.desktopDownloadPageUrl(), `${ORIGIN}/download`, 'built from the page origin, not its path, query or server data')
  assert.equal(lib.DESKTOP_DOWNLOAD_FILE_URL, '/api/desktop-release/download')
  const other = load(libCode, { window: { location: { origin: 'http://192.168.10.20:4577' } } })
  assert.equal(other.desktopDownloadPageUrl(), 'http://192.168.10.20:4577/download')
}

async function testDownloadPage() {
  const page = load(await bundle('web/download/DesktopDownloadPage.tsx'))
  const render = (phase, onRetry) => renderToStaticMarkup(React.createElement(page.DesktopDownloadView, { phase, origin: ORIGIN, onRetry }))

  const loading = render({ kind: 'loading' })
  assert.match(loading, /HAKOBI デスクトップ版（Windows）/)
  assert.match(loading, /確認しています…/)
  assert.doesNotMatch(loading, /desktop-release\/download/)

  const failed = render({ kind: 'error' }, () => {})
  assert.match(failed, /サーバーからバージョン情報を取得できませんでした。/)
  assert.match(failed, /再試行/)

  const none = render({ kind: 'ready', status: { release: null, reason: null } })
  assert.match(none, /現在ダウンロードできるインストーラーはありません。管理者にお問い合わせください。/)
  assert.doesNotMatch(none, /管理者向けの情報/)
  assert.doesNotMatch(none, /download"/)
  const forAdmin = render({ kind: 'ready', status: { release: null, reason: 'latest.yml の sha512 がインストーラーと一致しません' } })
  assert.match(forAdmin, /管理者向けの情報: latest\.yml の sha512 がインストーラーと一致しません/)

  const ready = render({ kind: 'ready', status: { release: { ...validRelease, size: 86400000 }, reason: null } })
  assert.match(ready, /<a href="\/api\/desktop-release\/download" download="" [^>]*>ダウンロード（1\.0\.5）<\/a>/)
  assert.match(ready, /82\.4 MB/)
  assert.match(ready, /2026-10-1[34]/, 'the release date is shown as a local date')
  assert.ok(ready.includes(validRelease.sha256))
  assert.ok(ready.includes(`>${ORIGIN}<`), 'the connection URL is this server')
  for (const prompt of ['安全でないダウンロードがブロックされました', '「保存」', '一般的にダウンロードされていません', '「保持する」', '「詳細表示」',
    'Windows によって PC が保護されました', '「詳細情報」', 'アプリ: HAKOBI-1.0.5-setup.exe', '発行元: 不明な発行元', '「実行」',
    'HAKOBI が起動しています。OKをクリックして、閉じてください。', '「HAKOBIを終了」', '管理者権限は不要です', 'スマート アプリ コントロール']) {
    assert.ok(ready.includes(prompt), `missing install guidance: ${prompt}`)
  }
  assert.match(ready, /<a href="\/"[^>]*>Web版に戻る<\/a>/)
}

async function testUpdateNotice() {
  const notice = load(await bundle('web/desktop/DesktopUpdateNotice.tsx', [{
    name: 'client-stub',
    setup(builder) {
      builder.onResolve({ filter: /\/lib\/client$/ }, () => ({ path: 'client', namespace: 'stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function subscribeConnection() { return () => {} }', loader: 'js' }))
    }
  }]))
  const card = (installed) => renderToStaticMarkup(React.createElement(notice.DesktopUpdateCard, { version: '1.0.6', installed, onDismiss() {} }))
  const old = card(undefined)
  assert.match(old, /HAKOBI の新しいバージョン 1\.0\.6 があります/)
  assert.match(old, /このPC: 1\.0\.4 以前/)
  assert.match(old, /<a href="http:\/\/team\.local:4577\/download" target="_blank" rel="noopener noreferrer"[^>]*>ダウンロードページを開く<\/a>/,
    'the desktop app sends target=_blank links to the system browser')
  assert.match(old, /<button[^>]*>後で<\/button>/)
  assert.match(card('1.0.5'), /このPC: 1\.0\.5/)
  assert.equal(renderToStaticMarkup(React.createElement(notice.DesktopUpdateNotice)), '', 'nothing shows before the app and the server have answered')
}

function testPackaging() {
  const lib = load(libCode)
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  assert.equal(config.publish.provider, 'generic', 'publish makes electron-builder write dist/latest.yml for npm run publish:desktop')
  assert.equal(config.nsis.oneClick, true)
  assert.equal(config.nsis.perMachine, false, 'members install without administrator rights')
  assert.equal(config.nsis.artifactName, '${productName}-${version}-setup.${ext}', 'the server only offers HAKOBI-x.y.z-setup.exe')
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(lib.compareVersions(version, lib.LAST_VERSION_WITHOUT_APP_VERSION), 1,
    `the release reporting appVersion (${version}) must be newer than ${lib.LAST_VERSION_WITHOUT_APP_VERSION}, which older apps are assumed to be`)
}

async function main() {
  libCode = await bundle('src/renderer/src/lib/desktopRelease.ts')
  testVersions()
  await testFetch()
  await testDownloadPage()
  await testUpdateNotice()
  testPackaging()
  console.log('Desktop release checks passed: version order, server answer validation, download page, update notice and installer settings')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
