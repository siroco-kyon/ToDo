// ToDoリストの「繰り返しの項目」の周期の計算。サーバー版とデスクトップ版の両方で使う。
// 周期は「始まりの日付」（YYYY-MM-DD）で表す。毎日はその日（平日だけなら直前の平日）、
// 毎週は指定した曜日（既定は月曜）、毎月は指定した日（既定は1日。その月にない日は末日）。
// 完了した日付がいまの周期の始まりより前なら、その項目は未チェックに戻す。

export type ItemRecurrence = 'daily' | 'weekly' | 'monthly'

export const ITEM_RECURRENCES: readonly ItemRecurrence[] = ['daily', 'weekly', 'monthly']

/** 毎週の既定は月曜（Date#getDay の 1）、毎月の既定は1日 */
export const DEFAULT_WEEKLY_DAY = 1
export const DEFAULT_MONTHLY_DAY = 1

export function isItemRecurrence(value: unknown): value is ItemRecurrence {
  return typeof value === 'string' && (ITEM_RECURRENCES as readonly string[]).includes(value)
}

/**
 * 戻る曜日・日付を周期に合わせて整える。毎週は 0（日）〜6（土）、毎月は 1〜31（31 はその月の末日）。
 * 毎日や範囲外の値は null（＝既定）にする。
 */
export function normalizeRecurrenceDay(recurrence: ItemRecurrence | null, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (recurrence === 'weekly') return value >= 0 && value <= 6 ? value : null
  if (recurrence === 'monthly') return value >= 1 && value <= 31 ? value : null
  return null
}

function parseKey(dateKey: string): Date {
  const [year, month, day] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shiftDays(dateKey: string, days: number): string {
  const date = parseKey(dateKey)
  date.setDate(date.getDate() + days)
  return toLocalDateKey(date)
}

function isWorkday(dateKey: string, isHoliday: (date: Date) => boolean): boolean {
  const date = parseKey(dateKey)
  const day = date.getDay()
  return day !== 0 && day !== 6 && !isHoliday(date)
}

/** その月の「day 日」。その月にない日（31日など）は末日にする */
function monthDayKey(year: number, monthIndex: number, day: number): string {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate()
  return toLocalDateKey(new Date(year, monthIndex, Math.min(day, lastDay)))
}

/**
 * dateKey を含む周期の始まりの日付。
 * 平日だけの毎日は、土日・祝日なら直前の平日の周期に含める（金曜にチェックしたものは月曜まで残る）。
 * day は戻る曜日（毎週）・日付（毎月）。null なら既定（月曜・1日）。
 */
export function periodStartOf(
  recurrence: ItemRecurrence,
  workdaysOnly: boolean,
  dateKey: string,
  isHoliday: (date: Date) => boolean,
  day: number | null = null
): string {
  const key = dateKey.slice(0, 10)
  if (recurrence === 'weekly') {
    const target = normalizeRecurrenceDay('weekly', day) ?? DEFAULT_WEEKLY_DAY
    return shiftDays(key, -((parseKey(key).getDay() - target + 7) % 7))
  }
  if (recurrence === 'monthly') {
    const target = normalizeRecurrenceDay('monthly', day) ?? DEFAULT_MONTHLY_DAY
    const date = parseKey(key)
    const thisMonth = monthDayKey(date.getFullYear(), date.getMonth(), target)
    return key >= thisMonth ? thisMonth : monthDayKey(date.getFullYear(), date.getMonth() - 1, target)
  }
  if (!workdaysOnly) return key
  let candidate = key
  // 連休が長くても止まるように上限を置く（年末年始・大型連休でも十分な日数）
  for (let i = 0; i < 31 && !isWorkday(candidate, isHoliday); i++) candidate = shiftDays(candidate, -1)
  return candidate
}

/** from〜to（日付）に重なる周期の始まりの日付の一覧。報告タブの「期間中に何回チェックしたか」の分母に使う */
export function periodsOverlapping(
  recurrence: ItemRecurrence,
  workdaysOnly: boolean,
  from: string,
  to: string,
  isHoliday: (date: Date) => boolean,
  day: number | null = null
): string[] {
  const keys = new Set<string>()
  for (let current = from.slice(0, 10); current <= to.slice(0, 10); current = shiftDays(current, 1)) {
    keys.add(periodStartOf(recurrence, workdaysOnly, current, isHoliday, day))
  }
  return [...keys]
}

/** 完了日時（ISO）がいまの周期より前なら true（＝未チェックに戻す） */
export function isCheckStale(
  recurrence: ItemRecurrence,
  workdaysOnly: boolean,
  completedAt: string | null,
  now: Date,
  isHoliday: (date: Date) => boolean,
  day: number | null = null
): boolean {
  if (!completedAt) return true
  const completed = new Date(completedAt)
  if (Number.isNaN(completed.getTime())) return true
  return toLocalDateKey(completed) < periodStartOf(recurrence, workdaysOnly, toLocalDateKey(now), isHoliday, day)
}
