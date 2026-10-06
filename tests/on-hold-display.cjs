const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { transformSync } = require('esbuild')
const code = transformSync(fs.readFileSync(path.join(__dirname, '../src/renderer/src/lib/onHold.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const sandbox = { module: { exports: {} } }
vm.runInNewContext(code, sandbox)
const { getOnHoldInfo } = sandbox.module.exports

const justBeforeMidnight = new Date(2026, 9, 1, 23, 59).toISOString()
assert.equal(getOnHoldInfo(justBeforeMidnight, new Date(2026, 9, 2, 0, 1)).days, 1)
assert.equal(getOnHoldInfo(justBeforeMidnight, new Date(2026, 9, 1, 23, 59)).durationLabel, '今日から保留')
assert.equal(getOnHoldInfo(new Date(2024, 1, 28).toISOString(), new Date(2024, 2, 1)).days, 2)
assert.equal(getOnHoldInfo(null).sinceLabel, '開始日時不明')
assert.equal(getOnHoldInfo('invalid').days, null)
assert.equal(getOnHoldInfo(new Date(2026, 9, 3).toISOString(), new Date(2026, 9, 1)).days, null)
assert.equal(getOnHoldInfo(new Date(2026, 9, 1, 9, 5).toISOString(), new Date(2026, 9, 6)).sinceLabel, '2026/10/01 09:05')
assert.equal(getOnHoldInfo(new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 6)).durationLabel, '5日間保留')
console.log('On-hold date display checks passed')
