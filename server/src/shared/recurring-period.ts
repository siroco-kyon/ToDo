// ToDoリストの「繰り返しの項目」の周期の計算。サーバー版とデスクトップ版の両方で使う。
// 周期は「始まりの日付」（YYYY-MM-DD）で表す。毎日はその日（平日だけなら直前の平日）、毎週は月曜、毎月は1日。
// 完了した日付がいまの周期の始まりより前なら、その項目は未チェックに戻す。

export type ItemRecurrence = 'daily' | 'weekly' | 'monthly'

export const ITEM_RECURRENCES: readonly ItemRecurrence[] = ['daily', 'weekly', 'monthly']

export function isItemRecurrence(value: unknown): value is ItemRecurrence {
  return typeof value === 'string' && (ITEM_RECURRENCES as readonly string[]).includes(value)
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

/**
 * dateKey を含む周期の始まりの日付。
 * 平日だけの毎日は、土日・祝日なら直前の平日の周期に含める（金曜にチェックしたものは月曜まで残る）。
 */
export function periodStartOf(
  recurrence: ItemRecurrence,
  workdaysOnly: boolean,
  dateKey: string,
  isHoliday: (date: Date) => boolean
): string {
  const key = dateKey.slice(0, 10)
  if (recurrence === 'weekly') {
    const day = parseKey(key).getDay()
    return shiftDays(key, -((day + 6) % 7))
  }
  if (recurrence === 'monthly') return `${key.slice(0, 7)}-01`
  if (!workdaysOnly) return key
  let candidate = key
  // 連休が長くても止まるように上限を置く（年末年始・大型連休でも十分な日数）
  for (let i = 0; i < 31 && !isWorkday(candidate, isHoliday); i++) candidate = shiftDays(candidate, -1)
  return candidate
}

/** 完了日時（ISO）がいまの周期より前なら true（＝未チェックに戻す） */
export function isCheckStale(
  recurrence: ItemRecurrence,
  workdaysOnly: boolean,
  completedAt: string | null,
  now: Date,
  isHoliday: (date: Date) => boolean
): boolean {
  if (!completedAt) return true
  const completed = new Date(completedAt)
  if (Number.isNaN(completed.getTime())) return true
  return toLocalDateKey(completed) < periodStartOf(recurrence, workdaysOnly, toLocalDateKey(now), isHoliday)
}
