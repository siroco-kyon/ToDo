// 予定の進捗（今日時点で何%進んでいるはずか）と、実績との差（何日分の遅れか）の計算。React に依存しない。
// ガントの「遅れ」と報告タブの「進捗の遅れ」で同じ判定にするため、ガントの表示設定（遅れとみなす日数・土日祝を数えないか）も読む。

export interface ScheduleOptions {
  /** 予定より何日分以上遅れていたら「遅れ」にするか */
  behindThresholdDays: number
  /** true のとき土日・祝日を数えない */
  workingDaysOnly: boolean
  holidayNames: ReadonlyMap<string, string>
}

export interface ScheduleBar {
  startDate: string
  endDate: string
}

/** ガントの表示設定の保存先（GanttView.tsx と同じ） */
export const GANTT_VIEW_SETTINGS_STORAGE_KEY = 'gantt-view-settings'
export const BEHIND_THRESHOLD_OPTIONS = [1, 2, 3, 5, 7]
export const DEFAULT_BEHIND_THRESHOLD_DAYS = 2

function parseKey(dateKey: string): Date {
  const [year, month, day] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function addDays(dateKey: string, days: number): string {
  const date = parseKey(dateKey)
  date.setDate(date.getDate() + days)
  return formatKey(date)
}

function diffCalendarDays(dateKey: string, baseKey: string): number {
  return Math.round((parseKey(dateKey).getTime() - parseKey(baseKey).getTime()) / 86400000)
}

function isCountedDay(dateKey: string, options: ScheduleOptions): boolean {
  if (!options.workingDaysOnly) return true
  const day = parseKey(dateKey).getDay()
  return day !== 0 && day !== 6 && !options.holidayNames.has(dateKey)
}

/** 開始日から終了日まで（両端を含む）の日数。workingDaysOnly のときは土日・祝日を除く */
export function countScheduleDays(startKey: string, endKey: string, options: ScheduleOptions): number {
  if (endKey < startKey) return 0
  if (!options.workingDaysOnly) return diffCalendarDays(endKey, startKey) + 1
  let count = 0
  for (let key = startKey; key <= endKey; key = addDays(key, 1)) {
    if (isCountedDay(key, options)) count += 1
  }
  return count
}

/**
 * 予定の進捗（今日時点で何%進んでいるはずか）と、期間の日数。
 * 期間のうち昨日までに過ぎた日数に、今日の半日分を足した割合を予定とする
 */
export function calculateSchedule(bar: ScheduleBar, todayKey: string, options: ScheduleOptions): { expectedProgress: number; totalDays: number } {
  let effective = options
  let totalDays = countScheduleDays(bar.startDate, bar.endDate, effective)
  // 期間がすべて休日のタスクは、暦日で数える
  if (totalDays === 0) {
    effective = { ...options, workingDaysOnly: false }
    totalDays = countScheduleDays(bar.startDate, bar.endDate, effective)
  }
  if (todayKey < bar.startDate) return { expectedProgress: 0, totalDays }
  if (todayKey > bar.endDate) return { expectedProgress: 100, totalDays }
  const passedDays = countScheduleDays(bar.startDate, addDays(todayKey, -1), effective) + (isCountedDay(todayKey, effective) ? 0.5 : 0)
  return { expectedProgress: Math.min(100, Math.max(0, Math.round((passedDays / totalDays) * 100))), totalDays }
}

/** 予定との差を期間の日数に換算した値（正なら遅れ。例: 10日間のタスクで 25% 足りなければ 2.5） */
export function behindDaysOf(progress: number, bar: ScheduleBar, todayKey: string, options: ScheduleOptions): { expectedProgress: number; behindDays: number } {
  const { expectedProgress, totalDays } = calculateSchedule(bar, todayKey, options)
  const actual = Math.min(100, Math.max(0, progress))
  return { expectedProgress, behindDays: ((expectedProgress - actual) / 100) * totalDays }
}

/** 予定の進捗を半分以上下回ったら、日数が短くても遅れとみなす（2日間のタスクの最終日に 0% など） */
export const BEHIND_PROGRESS_GAP = 50

/**
 * 遅れているか。予定との差が遅れとみなす日数以上か、予定の進捗を半分以上下回っているとき。
 * 期間の短いタスクは日数の差が小さく、日数だけでは最終日に 0% でも「順調」になってしまうため
 */
export function isBehindSchedule(expectedProgress: number, progress: number, behindDays: number, thresholdDays: number): boolean {
  if (behindDays <= 0) return false
  return behindDays >= thresholdDays || expectedProgress - progress >= BEHIND_PROGRESS_GAP
}

/** ガントの表示設定から、遅れとみなす日数と土日祝を数えないかを読む */
export function loadScheduleSettings(): { behindThresholdDays: number; workingDaysOnly: boolean } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GANTT_VIEW_SETTINGS_STORAGE_KEY) ?? 'null') as { behindThresholdDays?: unknown; workingDaysOnly?: unknown } | null
    return {
      behindThresholdDays: typeof parsed?.behindThresholdDays === 'number' && BEHIND_THRESHOLD_OPTIONS.includes(parsed.behindThresholdDays)
        ? parsed.behindThresholdDays
        : DEFAULT_BEHIND_THRESHOLD_DAYS,
      workingDaysOnly: typeof parsed?.workingDaysOnly === 'boolean' ? parsed.workingDaysOnly : false
    }
  } catch {
    return { behindThresholdDays: DEFAULT_BEHIND_THRESHOLD_DAYS, workingDaysOnly: false }
  }
}
