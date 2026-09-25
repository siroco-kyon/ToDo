// 日付のみの文字列（YYYY-MM-DD）の扱いと、期限の色分けの共通ヘルパー。
// new Date('YYYY-MM-DD') は UTC 0時として解釈され、JST では当日でも「期限切れ」になるため、
// 必ずローカル日付として組み立てて暦日単位で比較する。

/** 日付のみの文字列（YYYY-MM-DD）をローカル日付の0時としてパースする */
export function parseDateOnly(dateKey: string): Date {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Date をローカル日付の YYYY-MM-DD にする */
export function toDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** ISO 日時をローカル日付の YYYY-MM-DD にする */
export function isoToDateKey(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : toDateKey(date)
}

/** 今日から見た暦日の差（過去は負） */
export function diffDaysFromToday(dateKey: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((parseDateOnly(dateKey).getTime() - today.getTime()) / 86400000)
}

/** 期限の配色規約: 期限切れは赤、当日は橙、3日以内は黄。該当なしは空文字 */
export function getDueDateColor(dueDate: string | null): string {
  if (!dueDate) return ''
  const diffDays = diffDaysFromToday(dueDate)
  if (diffDays < 0) return '#ef4444'
  if (diffDays < 1) return '#f97316'
  if (diffDays <= 3) return '#f59e0b'
  return ''
}
