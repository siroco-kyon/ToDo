const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

// ガントの「遅れ」と報告タブの「進捗の遅れ」で共有する、予定の進捗の計算を確かめる
const bundle = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/scheduleHealth.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
}).outputFiles[0].text
const sandbox = { module: { exports: {} }, Date, window: { localStorage: { getItem: () => null } } }
vm.runInNewContext(bundle, sandbox)
const lib = sandbox.module.exports

const calendar = { behindThresholdDays: 2, workingDaysOnly: false, holidayNames: new Map() }
const bar = { startDate: '2026-10-01', endDate: '2026-10-10' }
// 10日間のタスクの5日目: 昨日まで4日＋今日の半日 = 4.5日 → 45%
assert.deepEqual({ ...lib.calculateSchedule(bar, '2026-10-05', calendar) }, { expectedProgress: 45, totalDays: 10 })
assert.equal(lib.calculateSchedule(bar, '2026-09-30', calendar).expectedProgress, 0, '開始前は0%')
assert.equal(lib.calculateSchedule(bar, '2026-10-11', calendar).expectedProgress, 100, '期限の翌日は100%')
// 実績20%なら、25%足りない → 10日間の2.5日分の遅れ
assert.equal(lib.behindDaysOf(20, bar, '2026-10-05', calendar).behindDays, 2.5)
assert.equal(lib.behindDaysOf(60, bar, '2026-10-05', calendar).behindDays, -1.5, '先行はマイナス')

// 土日・祝日を数えない: 2026-10-05（月）〜10-16（金）は平日10日。10-12（月）はスポーツの日
const workdays = { behindThresholdDays: 2, workingDaysOnly: true, holidayNames: new Map([['2026-10-12', 'スポーツの日']]) }
assert.equal(lib.countScheduleDays('2026-10-05', '2026-10-16', workdays), 9, '土日と祝日を除く')
assert.equal(lib.countScheduleDays('2026-10-05', '2026-10-16', calendar), 12)
// 期間がすべて休日なら暦日で数える
assert.equal(lib.calculateSchedule({ startDate: '2026-10-10', endDate: '2026-10-11' }, '2026-10-10', workdays).totalDays, 2)

// 設定がなければ既定（2日・暦日）
assert.deepEqual({ ...lib.loadScheduleSettings() }, { behindThresholdDays: 2, workingDaysOnly: false })

console.log('schedule health checks passed')
