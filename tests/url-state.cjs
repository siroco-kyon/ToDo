const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// 画面と開いているタスクを URL に出す計算（lib/urlState.ts）を確かめる
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/urlState.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
}).outputFiles[0].text
const sandbox = { module: { exports: {} }, URLSearchParams }
vm.runInNewContext(bundle, sandbox)
const lib = sandbox.module.exports
const plain = (value) => JSON.parse(JSON.stringify(value))

// 読む
assert.deepEqual(plain(lib.parseUrlState('?view=report&task=abc-123')), { view: 'report', taskId: 'abc-123' })
assert.deepEqual(plain(lib.parseUrlState('')), { view: null, taskId: null })
assert.deepEqual(plain(lib.parseUrlState('?view=unknown&task=a/b')), { view: null, taskId: null }, '知らない画面・形のおかしい ID は無視')
assert.deepEqual(plain(lib.parseUrlState('?task=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')), { view: null, taskId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' })

// 書く（ほかのパラメーターは残す）
assert.equal(lib.buildUrlSearch('', { view: 'gantt', taskId: null }), '?view=gantt')
assert.equal(lib.buildUrlSearch('?view=gantt&task=x&lang=ja', { view: 'detail', taskId: 'y' }), '?lang=ja&view=detail&task=y')
assert.equal(lib.buildUrlSearch('?view=gantt', { view: null, taskId: null }), '')

// タスクのリンク
assert.equal(lib.taskLinkFor('http://192.168.0.10:4577', '/', 'abc'), 'http://192.168.0.10:4577/?view=detail&task=abc')

console.log('url-state: ok')
