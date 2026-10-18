// タスクの繰り返し（完了にすると次回分を作る）の表記と、次回分の日付の計算（画面用。React に依存しない）。
// 日付の計算は server/src/shared/todo-recurrence.ts と同じ。tests/recurrence-dates.cjs で一致を確かめている。
import type { Todo, TodoRecurrence } from '../types'
import { formatShortDate } from './dueDate'

export const TODO_RECURRENCE_OPTIONS: ReadonlyArray<{ value: TodoRecurrence; label: string }> = [
  { value: 'daily', label: '毎日' },
  { value: 'weekly', label: '毎週' },
  { value: 'monthly', label: '毎月' },
  { value: 'yearly', label: '毎年' }
]

/** 毎日・毎週・毎月・毎年。繰り返さない・知らない値は null */
export function recurrenceKindLabel(recurrence: string | null | undefined): string | null {
  return TODO_RECURRENCE_OPTIONS.find((option) => option.value === recurrence)?.label ?? null
}

function toKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 日付（YYYY-MM-DD）を1周期ずらす。毎月・毎年はその月にない日を末日に丸める（2/29 の次の年は平年なら 2/28） */
export function nextRecurrenceDateKey(dateKey: string, recurrence: TodoRecurrence): string {
  const [year, month, day] = dateKey.slice(0, 10).split('-').map(Number)
  if (recurrence === 'daily' || recurrence === 'weekly') {
    const date = new Date(Date.UTC(year, month - 1, day + (recurrence === 'daily' ? 1 : 7)))
    return toKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
  }
  const targetYear = recurrence === 'yearly' ? year + 1 : year + Math.floor(month / 12)
  const targetMonth = recurrence === 'yearly' ? month : (month % 12) + 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  return toKey(targetYear, targetMonth, Math.min(day, lastDay))
}

/** 毎年の基準の月日（期限、なければ開始日）。例: 10/18 */
function yearlyMonthDay(todo: Pick<Todo, 'start_date' | 'due_date'>): string | null {
  const dateKey = (todo.due_date ?? todo.start_date)?.slice(0, 10)
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null
  return `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}`
}

/** 繰り返しの表記。毎年は月日を付ける（例: 毎年 10/18。月日は期限、なければ開始日）。繰り返さないときは null */
export function todoRecurrenceLabel(todo: Pick<Todo, 'recurrence' | 'start_date' | 'due_date'>): string | null {
  const label = recurrenceKindLabel(todo.recurrence)
  if (!label) return null
  if (todo.recurrence !== 'yearly') return label
  const monthDay = yearlyMonthDay(todo)
  return monthDay ? `${label} ${monthDay}` : label
}

type RecurrenceSource = Pick<Todo, 'recurrence' | 'start_date' | 'due_date' | 'recurrence_skip_weekends' | 'recurrence_skip_holidays'>

/**
 * 完了にしたときに作る次回分の期限（期限がなければ開始日）。日付がないときは null。
 * 土日をスキップする設定なら、土日に当たるときは月曜にずらす。祝日は画面では数えないので、
 * 祝日をスキップする設定のときは holidayMayShift を立てる（日付がさらに後ろへずれることがある）
 */
export function nextRecurrenceDue(todo: RecurrenceSource): { kind: '期限' | '開始日'; dateKey: string; holidayMayShift: boolean } | null {
  const recurrence = TODO_RECURRENCE_OPTIONS.find((option) => option.value === todo.recurrence)?.value
  if (!recurrence) return null
  const base = todo.due_date ? { kind: '期限' as const, dateKey: todo.due_date } : todo.start_date ? { kind: '開始日' as const, dateKey: todo.start_date } : null
  if (!base) return null
  let next = nextRecurrenceDateKey(base.dateKey, recurrence)
  if (todo.recurrence_skip_weekends) {
    while ([0, 6].includes(new Date(`${next}T00:00:00`).getDay())) next = nextRecurrenceDateKey(next, 'daily')
  }
  return { kind: base.kind, dateKey: next, holidayMayShift: Boolean(todo.recurrence_skip_holidays) }
}

/** 完了にしたあとの知らせ（例: 毎年 10/20 の次回分（期限 2027/10/20）を作りました）。繰り返さないときは null */
export function recurrenceDoneMessage(todo: RecurrenceSource, today = new Date()): string | null {
  const label = todoRecurrenceLabel(todo)
  if (!label) return null
  const next = nextRecurrenceDue(todo)
  // 祝日でずれるかは画面では分からないので、そのときは日付を書かない
  return next && !next.holidayMayShift
    ? `${label}の次回分（${next.kind} ${formatShortDate(next.dateKey, today)}）を作りました`
    : `${label}の次回分を作りました`
}
