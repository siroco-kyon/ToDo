import type { Todo } from './types'

export function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function diffCalendarDays(dateStr: string, baseDateStr: string): number {
  const diffMs = parseDateKey(dateStr).getTime() - parseDateKey(baseDateStr).getTime()
  return Math.round(diffMs / 86400000)
}

export function addDays(dateStr: string, days: number): string {
  const date = parseDateKey(dateStr)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function normalizeDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().slice(0, 10)
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)

  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null
  }

  return trimmed
}

export function normalizeTimeKey(value: string | null | undefined): string | null {
  if (!value) return null
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function shiftTimeKey(value: string, deltaMinutes: number): string {
  const normalized = normalizeTimeKey(value)
  if (!normalized) return value

  const [hours, minutes] = normalized.split(':').map(Number)
  const totalMinutes = Math.min(23 * 60 + 59, Math.max(0, hours * 60 + minutes + deltaMinutes))
  const nextHours = Math.floor(totalMinutes / 60)
  const nextMinutes = totalMinutes % 60
  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`
}

export function clampRunningSeconds(startTime: string, windowStart: Date, now: Date): number {
  const startMs = new Date(startTime).getTime()
  const fromMs = Math.max(startMs, windowStart.getTime())
  const toMs = now.getTime()
  if (toMs <= fromMs) return 0
  return Math.floor((toMs - fromMs) / 1000)
}

export function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

export function toMinutes(seconds: number): number {
  return Math.round(seconds / 60)
}

export function clampDependencyLagDays(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(60, Math.round(value)))
}

export function clampProgress(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

export interface TodoBar {
  startDate: string
  endDate: string
}

export function getNormalizedTodoBar(todo: Pick<Todo, 'start_date' | 'due_date'>): TodoBar | null {
  const start = normalizeDateKey(todo.start_date)
  const end = normalizeDateKey(todo.due_date)
  if (!start && !end) return null
  if (start && end) return start <= end ? { startDate: start, endDate: end } : { startDate: end, endDate: start }
  const singleDay = start ?? end!
  return { startDate: singleDay, endDate: singleDay }
}

export function getTodoDurationDays(todo: Pick<Todo, 'start_date' | 'due_date'>): number {
  const bar = getNormalizedTodoBar(todo)
  return bar ? Math.max(diffCalendarDays(bar.endDate, bar.startDate), 0) : 0
}
