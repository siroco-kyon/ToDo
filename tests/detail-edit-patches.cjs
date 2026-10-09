const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')
const moduleValue = { exports: {} }
const code = buildSync({ entryPoints: [path.resolve(__dirname, '../src/renderer/src/lib/editChanges.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports })
const patch = (base, draft) => JSON.parse(JSON.stringify(moduleValue.exports.buildEditPatch(base, draft)))
const original = { title: '元の名前', status: 'active', priority: 3, due_date: null, co_assignee_ids: ['b', 'a'] }
assert.deepEqual(patch(original, { ...original, title: '新しい名前' }), { title: '新しい名前', expected_values: { title: '元の名前' } })
assert.deepEqual(patch(original, { ...original, due_date: undefined, co_assignee_ids: ['a', 'b', 'a'] }), {})
assert.deepEqual(patch(original, { ...original, due_date: '2026-10-20' }), { due_date: '2026-10-20', expected_values: { due_date: null } })
const child = { id: 'child', title: '子', description: '説明', progress: 10, done: false }
assert.deepEqual(patch(child, { ...child, progress: 40 }), { progress: 40, expected_values: { progress: 10 } })
assert.deepEqual(patch(child, { ...child, done: true, progress: 100 }), { done: true, progress: 100, expected_values: { done: false, progress: 10 } })
console.log('Detail edit patch checks passed: changed fields, original expectations, no-op, null and co-assignee normalization')
