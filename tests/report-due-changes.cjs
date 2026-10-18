const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// 報告タブの「期間中に延期」の数え方を確かめる
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/dueChanges.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
}).outputFiles[0].text
const sandbox = { module: { exports: {} } }
vm.runInNewContext(bundle, sandbox)
const { countPostponements } = sandbox.module.exports
const change = (old_value, new_value) => ({ old_value, new_value })

assert.equal(countPostponements([]), 0)
assert.equal(countPostponements([change('2026-10-20', '2026-10-25')]), 1, '後ろへずらした')
assert.equal(countPostponements([change('2026-10-20', '2026-10-25'), change('2026-10-25', '2026-10-28')]), 2, '2回延期')
assert.equal(countPostponements([change('2026-10-23', '2026-10-25'), change('2026-10-25', '2026-10-23')]), 0, '動かして戻しただけは延期にしない')
assert.equal(countPostponements([change('2026-10-20', '2026-10-25'), change('2026-10-25', '2026-10-18')]), 0, '前倒しで終わった')
assert.equal(countPostponements([change('2026-10-20', '2026-10-25'), change('2026-10-25', '2026-10-22')]), 1, '一部戻しても始めより後ろなら延期1回')
assert.equal(countPostponements([change(null, '2026-10-25')]), 0, '期限を入れただけは延期ではない')
assert.equal(countPostponements([change('2026-10-20', null)]), 0, '期限を外しただけは延期ではない')
assert.equal(countPostponements([change('2026-10-20T00:00:00.000Z', '2026-10-21')]), 1, '時刻つきでも日付で比べる')

console.log('report due change checks passed')
