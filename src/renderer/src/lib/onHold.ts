export interface OnHoldInfo {
  sinceLabel: string
  durationLabel: string
  days: number | null
}

/** 保留期間は表示端末の暦日で数える。深夜をまたいだ場合や夏時間も扱う。 */
export function getOnHoldInfo(since: string | null | undefined, now = new Date()): OnHoldInfo {
  const started = since ? new Date(since) : null
  if (!started || Number.isNaN(started.getTime())) {
    return { sinceLabel: '開始日時不明', durationLabel: '保留期間不明', days: null }
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  const sinceLabel = `${started.getFullYear()}/${pad(started.getMonth() + 1)}/${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())}`
  const calendarDay = (date: Date): number => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const days = (calendarDay(now) - calendarDay(started)) / 86400000
  if (!Number.isFinite(days) || days < 0) {
    return { sinceLabel, durationLabel: '保留期間不明', days: null }
  }
  return { sinceLabel, durationLabel: days === 0 ? '今日から保留' : `${days}日間保留`, days }
}
