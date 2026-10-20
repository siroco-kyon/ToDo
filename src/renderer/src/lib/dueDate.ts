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

/** 日付のみの文字列を days 日ずらした YYYY-MM-DD */
export function shiftDateKey(dateKey: string, days: number): string {
  const date = parseDateOnly(dateKey)
  date.setDate(date.getDate() + days)
  return toDateKey(date)
}

/** ISO 日時をローカル日付の YYYY-MM-DD にする */
export function isoToDateKey(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : toDateKey(date)
}

/**
 * 短い日付の表記（例: 10/20）。今年でない日付には年を付ける（例: 2027/10/20）。
 * 毎年の繰り返しの次回分などを、今年の日付と見間違えないようにする
 */
export function formatShortDate(dateKey: string, today = new Date()): string {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return y === today.getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`
}

/** 今日から見た暦日の差（過去は負） */
export function diffDaysFromToday(dateKey: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((parseDateOnly(dateKey).getTime() - today.getTime()) / 86400000)
}

/**
 * 期限の色に添える言葉（色が分かりにくい人のため。色だけで超過を伝えない）。
 * 超過は「・2日超過」、今日は「・今日」、明日は「・明日」、7日以内は「・あと3日」（一覧と同じ書き方）。それ以外・完了したものは空文字
 */
export function dueStateSuffix(dueDate: string | null, done = false): string {
  if (!dueDate || done) return ''
  const diff = diffDaysFromToday(dueDate)
  if (diff < 0) return `・${Math.abs(diff)}日超過`
  if (diff === 0) return '・今日'
  if (diff === 1) return '・明日'
  if (diff <= 7) return `・あと${diff}日`
  return ''
}

/** 期限の配色規約: 期限切れは赤、当日は橙、3日以内は黄。該当なしは空文字 */
export function getDueDateColor(dueDate: string | null): string {
  if (!dueDate) return ''
  const diffDays = diffDaysFromToday(dueDate)
  // 文字に使うので、薄い色の面の上でも 4.5:1 に届く段にする（--red-500 はライトで 4.1〜4.3 だった）
  if (diffDays < 0) return 'var(--red-400)'
  if (diffDays < 1) return 'var(--orange-500)'
  if (diffDays <= 3) return 'var(--amber-500)'
  return ''
}
