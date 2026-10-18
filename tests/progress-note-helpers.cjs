const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// 進捗ログの投稿欄の「ひな形」「予定どおり」の文の扱いを確かめる
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/components/ProgressNoteHelpers.tsx')],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react']
}).outputFiles[0].text
const sandbox = { module: { exports: {} }, require: () => ({}) }
vm.runInNewContext(bundle, sandbox)
const lib = sandbox.module.exports

// 何も書かなかったひな形の見出しは投稿しない
assert.equal(lib.cleanProgressNote(lib.PROGRESS_NOTE_TEMPLATE), '', 'ひな形だけなら空（投稿しない）')
assert.equal(lib.cleanProgressNote('やったこと：資料作成\n次にやること：\n困っていること：'), 'やったこと：資料作成')
assert.equal(lib.cleanProgressNote('やったこと：\n・資料作成\n次にやること：\n\n困っていること：\nなし'), 'やったこと：\n・資料作成\n\n困っていること：\nなし', '中身のある見出しは残す')
assert.equal(lib.cleanProgressNote('  予定どおり進んでいます。 '), '予定どおり進んでいます。')
assert.equal(lib.cleanProgressNote('次にやること：の確認をする'), '次にやること：の確認をする', '同じ行に書いた文は残す')

// ひな形を入れる
assert.equal(lib.withProgressNoteTemplate(''), lib.PROGRESS_NOTE_TEMPLATE)
assert.equal(lib.withProgressNoteTemplate('書きかけ  '), `書きかけ\n${lib.PROGRESS_NOTE_TEMPLATE}`)

console.log('progress note helper checks passed')
