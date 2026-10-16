const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// ドラッグでの並べ替えの計算（タスク詳細・ガント・ToDoリストで共通）を確かめる
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/reorder.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
}).outputFiles[0].text
const sandbox = { module: { exports: {} } }
vm.runInNewContext(bundle, sandbox)
const lib = sandbox.module.exports
const list = (value) => (value == null ? value : Array.from(value))

// 行の上半分は前、下半分は後ろ
assert.equal(lib.dropPositionOf(104, { top: 100, height: 20 }), 'before')
assert.equal(lib.dropPositionOf(110, { top: 100, height: 20 }), 'after', 'ちょうど真ん中は後ろ')
assert.equal(lib.dropPositionOf(119, { top: 100, height: 20 }), 'after')

// 好きな位置へ1回で動かせる
const ids = ['a', 'b', 'c', 'd', 'e']
assert.deepEqual(list(lib.moveIdTo(ids, 'e', 'a', 'before')), ['e', 'a', 'b', 'c', 'd'], '5番目を先頭へ')
assert.deepEqual(list(lib.moveIdTo(ids, 'a', 'e', 'after')), ['b', 'c', 'd', 'e', 'a'], '先頭を最後の後ろへ')
assert.deepEqual(list(lib.moveIdTo(ids, 'a', 'c', 'before')), ['b', 'a', 'c', 'd', 'e'], '下へ動かして相手の前')
assert.deepEqual(list(lib.moveIdTo(ids, 'a', 'c', 'after')), ['b', 'c', 'a', 'd', 'e'], '下へ動かして相手の後ろ')
assert.deepEqual(list(lib.moveIdTo(ids, 'd', 'b', 'after')), ['a', 'b', 'd', 'c', 'e'], '上へ動かして相手の後ろ')

// 並びが変わらない位置では null（線を出さない・保存しない）
assert.equal(lib.moveIdTo(ids, 'c', 'c', 'before'), null, '自分の上')
assert.equal(lib.moveIdTo(ids, 'c', 'd', 'before'), null, 'すぐ後ろの行の前 = 今の位置')
assert.equal(lib.moveIdTo(ids, 'c', 'b', 'after'), null, 'すぐ前の行の後ろ = 今の位置')
assert.equal(lib.moveIdTo(ids, 'x', 'a', 'before'), null, '知らない項目')
assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e'], '元の配列は変えない')

// ポインターの位置から落とす行を決める（すき間・最後の行より下でも置ける）
const rows = [
  { id: 'a', top: 100, height: 30 },
  { id: 'b', top: 136, height: 30 },
  { id: 'c', top: 172, height: 30 }
]
assert.deepEqual({ ...lib.dropTargetAt(90, rows) }, { id: 'a', position: 'before' }, '最初の行より上は先頭の前')
assert.deepEqual({ ...lib.dropTargetAt(125, rows) }, { id: 'a', position: 'after' })
assert.deepEqual({ ...lib.dropTargetAt(133, rows) }, { id: 'b', position: 'before' }, '行のすき間は次の行の前')
assert.deepEqual({ ...lib.dropTargetAt(190, rows) }, { id: 'c', position: 'after' })
assert.deepEqual({ ...lib.dropTargetAt(400, rows) }, { id: 'c', position: 'after' }, '最後の行より下は最後の後ろ')
assert.equal(lib.dropTargetAt(100, []), null)

// キーボード（Alt+↑↓）で1つずつ
assert.deepEqual(list(lib.moveIdBy(ids, 'c', -1)), ['a', 'c', 'b', 'd', 'e'])
assert.deepEqual(list(lib.moveIdBy(ids, 'c', 1)), ['a', 'b', 'd', 'c', 'e'])
assert.equal(lib.moveIdBy(ids, 'a', -1), null, '先頭より上へは動かない')
assert.equal(lib.moveIdBy(ids, 'e', 1), null, '最後より下へは動かない')

console.log('subtask-reorder: ok')
