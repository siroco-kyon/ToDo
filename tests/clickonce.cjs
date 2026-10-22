const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { build } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const root = path.resolve(__dirname, '..')
async function bundle(entry, stubClient = false) {
  return (await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react'], alias: { '@renderer': path.join(root, 'src/renderer/src') },
    plugins: stubClient ? [{ name: 'offline-client', setup(builder) {
      builder.onResolve({ filter: /\/lib\/client$/ }, () => ({ path: 'client', namespace: 'stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const subscribeConnection = () => () => {}' }))
    } }] : [] })).outputFiles[0].text
}
function load(code, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require, console, URL, AbortController, ...globals })
  return module.exports
}

async function checkNoticeLifecycle(code, context, available, dismissed = null) {
  // Exercise the mounted effects: a missing initial context must not prevent getContext,
  // and ClickOnce installations must never be offered the exe updater.
  const states = [], effects = [], requests = []
  let cursor = 0, pending = [], dirty = false, tree
  const fakeReact = {
    createElement: React.createElement,
    useState(initial) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], (value) => { states[i] = value; dirty = true }]
    },
    useEffect(callback, deps) {
      const i = cursor++
      if (!effects[i] || deps.some((value, index) => value !== effects[i].deps[index])) pending.push(() => {
        effects[i]?.cleanup?.()
        effects[i] = { deps, cleanup: callback() }
      })
    }
  }
  const component = load(code, {
    require: (name) => name === 'react' ? fakeReact : require(name),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
    window: { location: { origin: 'https://team.example' },
      localStorage: { getItem: () => dismissed, setItem() {} }, desktop: { getContext: async () => context } },
    fetch: async (url) => {
      requests.push(url)
      return { ok: true, json: async () => url.includes('clickonce') ? available : {
        available: true, version: '1.0.6', fileName: 'HAKOBI-1.0.6-setup.exe', size: 1024, sha256: 'ab'.repeat(32)
      } }
    }
  })
  try {
    for (let iteration = 0; iteration < 6; iteration++) {
      if (iteration === 0 || dirty) {
        dirty = false; cursor = 0
        tree = component.DesktopUpdateNotice()
        const callbacks = pending; pending = []
        callbacks.forEach((callback) => callback())
      }
      await new Promise(setImmediate)
    }
    return { tree, requests }
  } finally { effects.forEach((effect) => effect?.cleanup?.()) }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hakobi-distribution-'))
  try {
    const lib = load(await bundle('src/main/desktop-distribution.ts'))
    assert.deepEqual(JSON.parse(JSON.stringify(lib.readDesktopDistribution(directory))), {})
    const marker = path.join(directory, 'hakobi-distribution.json')
    for (const body of ['invalid', '{}', JSON.stringify({ distribution: 'clickonce', version: '1.0.5' }),
      JSON.stringify({ distribution: 'clickonce', version: '1.0.5.65536' })]) {
      fs.writeFileSync(marker, body)
      assert.deepEqual(JSON.parse(JSON.stringify(lib.readDesktopDistribution(directory))), {})
    }
    fs.writeFileSync(marker, JSON.stringify({ distribution: 'clickonce', version: '1.0.5.2' }))
    assert.deepEqual(JSON.parse(JSON.stringify(lib.readDesktopDistribution(directory))), { distribution: 'clickonce', clickOnceVersion: '1.0.5.2' })
    fs.writeFileSync(marker, JSON.stringify({ distribution: 'clickonce', version: '1.0.5.2', installUrl: 'https://team.example/clickonce/' }))
    assert.equal(lib.readDesktopDistribution(directory).clickOnceInstallUrl, 'https://team.example/clickonce/')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }

  const code = await bundle('src/renderer/src/lib/clickOnceRelease.ts')
  const available = { available: true, version: '1.0.5.2', applicationUrl: '/clickonce/HAKOBI.application', pageUrl: '/clickonce/' }
  let response = available
  const lib = load(code, { fetch: async () => ({ ok: true, json: async () => response }) })
  assert.equal(lib.canCheckClickOnceRelease('https://team.example/clickonce/', 'https://team.example'), true)
  assert.equal(lib.canCheckClickOnceRelease('https://first.example/clickonce/', 'https://team.example'), false)
  assert.equal(lib.canCheckClickOnceRelease('https://team.example/another-install/', 'https://team.example'), false)
  assert.equal(lib.canCheckClickOnceRelease(undefined, 'https://team.example'), false)
  assert.equal(lib.isNewerClickOnceVersion('1.0.5.2', '1.0.5.1'), true)
  assert.equal(lib.isNewerClickOnceVersion('1.0.5.10', '1.0.5.9'), true)
  assert.equal(lib.isNewerClickOnceVersion('1.0.4.99', '1.0.5.0'), false)
  for (const invalid of [undefined, '1.0.5', '1.0.5.65536', '1.0.5.01', '1.0.5.0\n']) {
    assert.equal(lib.isNewerClickOnceVersion('1.0.5.2', invalid), false)
  }
  assert.equal((await lib.fetchClickOnceRelease()).version, '1.0.5.2')
  for (const patch of [{ available: false }, { applicationUrl: 'https://elsewhere/evil.application' }, { pageUrl: '//elsewhere/' }, { version: '1.0.5' }]) {
    response = { ...available, ...patch }
    assert.equal(await lib.fetchClickOnceRelease(), null)
  }

  const notice = await bundle('web/desktop/DesktopUpdateNotice.tsx', true)
  const context = { appVersion: '1.0.5', distribution: 'clickonce', clickOnceVersion: '1.0.5.1', clickOnceInstallUrl: 'https://team.example/clickonce/' }
  const clickOnce = await checkNoticeLifecycle(notice, context, available)
  assert.deepEqual(clickOnce.requests, ['/api/clickonce-release'])
  assert.equal(clickOnce.tree.props.version, '1.0.5.2')
  const html = renderToStaticMarkup(clickOnce.tree)
  assert.match(html, /ClickOnce 試験版/)
  assert.match(html, /タスクトレイ/)
  assert.doesNotMatch(html, /ダウンロードページ|href=/)
  assert.equal((await checkNoticeLifecycle(notice, context, available, '1.0.5.2')).tree, null)
  assert.equal((await checkNoticeLifecycle(notice, { ...context, clickOnceVersion: '1.0.5.2' }, available)).tree, null)
  const otherServer = await checkNoticeLifecycle(notice, { ...context, clickOnceInstallUrl: 'https://first.example/clickonce/' }, available)
  assert.deepEqual(otherServer.requests, [], 'do not advertise releases from a different ClickOnce provider')
  assert.equal(otherServer.tree, null)
  const exe = await checkNoticeLifecycle(notice, { appVersion: '1.0.5' }, available)
  assert.deepEqual(exe.requests, ['/api/desktop-release'])
  assert.match(renderToStaticMarkup(exe.tree), /ダウンロードページを開く/)
  const option = load(await bundle('web/download/ClickOnceDownloadOption.tsx'))
  assert.match(renderToStaticMarkup(React.createElement(option.ClickOnceDownloadCard, { release: available })), /href="\/clickonce\/"/)
  console.log('ClickOnce checks passed: packaged identity, revision comparison, trusted links, mounted update notice and exe compatibility')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
