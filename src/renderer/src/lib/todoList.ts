import type { SubTask, Todo } from '../types'
import { toDateKey } from './dueDate'

// 「ToDoリスト」（期限を持たずに続くタスク）の項目まわりの共通処理。
// 項目＝サブタスク。繰り返しの項目は周期が変わると未チェックに戻る（戻すのはサーバー／デスクトップ版の本体）。

export type ItemRecurrence = 'daily' | 'weekly' | 'monthly'

/** 項目の繰り返しの選択肢。平日だけの毎日は recurrence='daily' + recurrence_workdays=1 */
export type ItemRepeatChoice = '' | 'daily' | 'workdays' | 'weekly' | 'monthly'

type RepeatFields = Pick<SubTask, 'recurrence' | 'recurrence_workdays' | 'recurrence_day'>

export const ITEM_REPEAT_OPTIONS: Array<{ value: ItemRepeatChoice; label: string; title: string }> = [
  { value: '', label: '繰り返さない', title: 'チェックしたら「済み」に移ります' },
  { value: 'daily', label: '毎日', title: '毎日、未チェックに戻ります' },
  { value: 'workdays', label: '平日', title: '平日ごとに未チェックに戻ります（土日・祝日は前の平日の分が続きます）' },
  { value: 'weekly', label: '毎週', title: '毎週、選んだ曜日に未チェックに戻ります' },
  { value: 'monthly', label: '毎月', title: '毎月、選んだ日に未チェックに戻ります' }
]

/** 毎週の曜日（Date#getDay の値）。月曜始まりで並べる */
export const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '月' }, { value: 2, label: '火' }, { value: 3, label: '水' }, { value: 4, label: '木' },
  { value: 5, label: '金' }, { value: 6, label: '土' }, { value: 0, label: '日' }
]

/** 毎月の日付。31 は「末日」（30日までの月はその月の最後の日） */
export const MONTH_DAY_OPTIONS: Array<{ value: number; label: string }> = [
  ...Array.from({ length: 30 }, (_, index) => ({ value: index + 1, label: `${index + 1}日` })),
  { value: 31, label: '末日' }
]

const DEFAULT_WEEKLY_DAY = 1
const DEFAULT_MONTHLY_DAY = 1

export function isListTodo(todo: Pick<Todo, 'list_mode'> | null | undefined): boolean {
  return Boolean(todo?.list_mode)
}

export function repeatChoiceOf(subTask: Pick<SubTask, 'recurrence' | 'recurrence_workdays'>): ItemRepeatChoice {
  if (!subTask.recurrence) return ''
  if (subTask.recurrence === 'daily' && subTask.recurrence_workdays) return 'workdays'
  return subTask.recurrence
}

/** 繰り返しの選択に合わせた戻る曜日・日付。未設定なら既定（月曜・1日） */
export function repeatDayOf(choice: ItemRepeatChoice, day: number | null | undefined): number | null {
  if (choice === 'weekly') return day != null && day >= 0 && day <= 6 ? day : DEFAULT_WEEKLY_DAY
  if (choice === 'monthly') return day != null && day >= 1 && day <= 31 ? day : DEFAULT_MONTHLY_DAY
  return null
}

export function repeatFields(choice: ItemRepeatChoice, day: number | null = null): { recurrence: ItemRecurrence | null; recurrence_workdays: number; recurrence_day: number | null } {
  if (choice === '') return { recurrence: null, recurrence_workdays: 0, recurrence_day: null }
  if (choice === 'workdays') return { recurrence: 'daily', recurrence_workdays: 1, recurrence_day: null }
  if (choice === 'daily') return { recurrence: 'daily', recurrence_workdays: 0, recurrence_day: null }
  return { recurrence: choice, recurrence_workdays: 0, recurrence_day: repeatDayOf(choice, day) }
}

function weekdayLabel(day: number): string {
  return WEEKDAY_OPTIONS.find((option) => option.value === day)?.label ?? '月'
}

/** 短い表記（例: 毎日・平日・毎週水・毎月25日・毎月末）。繰り返さない項目は null */
export function repeatLabel(subTask: RepeatFields): string | null {
  const choice = repeatChoiceOf(subTask)
  if (choice === '') return null
  if (choice === 'daily') return '毎日'
  if (choice === 'workdays') return '平日'
  const day = repeatDayOf(choice, subTask.recurrence_day)!
  if (choice === 'weekly') return `毎週${weekdayLabel(day)}`
  return day === 31 ? '毎月末' : `毎月${day}日`
}

/** いつ未チェックに戻るかの説明（ツールチップ用） */
export function repeatTitle(subTask: RepeatFields): string {
  const choice = repeatChoiceOf(subTask)
  if (choice === '') return 'チェックしたら「済み」に移ります'
  if (choice === 'daily') return '毎日、未チェックに戻ります'
  if (choice === 'workdays') return '平日ごとに未チェックに戻ります（土日・祝日は前の平日の分が続きます）'
  const day = repeatDayOf(choice, subTask.recurrence_day)!
  if (choice === 'weekly') return `毎週${weekdayLabel(day)}曜に未チェックに戻ります`
  return day === 31 ? '毎月の末日に未チェックに戻ります' : `毎月${day}日に未チェックに戻ります（その日がない月は末日）`
}

/** 繰り返さない項目で、期限が今日か過ぎているもの */
export function isDueByToday(item: Pick<SubTask, 'recurrence' | 'done' | 'due_date'>, todayKey: string = toDateKey(new Date())): boolean {
  return !item.recurrence && !item.done && item.due_date != null && item.due_date.slice(0, 10) <= todayKey
}

/** 期限のよく使う選択肢（今日・明日・今週中／来週中の金曜） */
export function duePresets(today: Date = new Date()): Array<{ label: string; value: string }> {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const shift = (days: number): string => {
    const date = new Date(base)
    date.setDate(date.getDate() + days)
    return toDateKey(date)
  }
  const weekday = base.getDay()
  // 月〜木は今週の金曜、金〜日は来週の金曜
  const untilFriday = weekday >= 1 && weekday <= 4 ? 5 - weekday : (5 - weekday + 7) % 7 || 7
  return [
    { label: '今日', value: shift(0) },
    { label: '明日', value: shift(1) },
    { label: weekday >= 1 && weekday <= 4 ? '今週中' : '来週中', value: shift(untilFriday) }
  ]
}

export interface ChecklistSummary {
  /** 繰り返しの項目の数と、今回の周期でチェック済みの数 */
  repeatTotal: number
  repeatDone: number
  /** 繰り返さない項目のうち、まだ済んでいないもの */
  openCount: number
  /** そのうち期限が今日か過ぎているもの */
  dueByTodayCount: number
}

export function summarizeChecklist(items: SubTask[], todayKey: string = toDateKey(new Date())): ChecklistSummary {
  let repeatTotal = 0
  let repeatDone = 0
  let openCount = 0
  let dueByTodayCount = 0
  for (const item of items) {
    if (item.recurrence) {
      repeatTotal++
      if (item.done) repeatDone++
    } else if (!item.done) {
      openCount++
      if (isDueByToday(item, todayKey)) dueByTodayCount++
    }
  }
  return { repeatTotal, repeatDone, openCount, dueByTodayCount }
}

/** 今日やる分が残っているか（繰り返しの項目の未チェック、または期限が今日までのやること） */
export function hasRemainingToday(summary: ChecklistSummary): boolean {
  return summary.repeatDone < summary.repeatTotal || summary.dueByTodayCount > 0
}

/** 一覧・カンバン・ガント用の短い表記（例: 「今回 3/5・残り2」） */
export function checklistBadgeText(summary: ChecklistSummary): string {
  const parts: string[] = []
  if (summary.repeatTotal > 0) parts.push(`今回 ${summary.repeatDone}/${summary.repeatTotal}`)
  if (summary.openCount > 0) parts.push(`残り${summary.openCount}`)
  return parts.length > 0 ? parts.join('・') : '項目なし'
}

export function checklistBadgeTitle(summary: ChecklistSummary): string {
  const due = summary.dueByTodayCount > 0 ? `（うち期限が今日まで ${summary.dueByTodayCount}件）` : ''
  return `ToDoリスト: 繰り返しの項目 ${summary.repeatDone}/${summary.repeatTotal} 済み・まだの項目 ${summary.openCount}件${due}`
}

/** タスクIDごとのまとめ。ToDoリストのタスクだけを対象にする */
export function buildChecklistSummaries(todos: Todo[], subTasks: SubTask[]): Map<string, ChecklistSummary> {
  const listIds = new Set(todos.filter(isListTodo).map((todo) => todo.id))
  const byTodo = groupListItems(listIds, subTasks)
  const todayKey = toDateKey(new Date())
  return new Map([...listIds].map((id) => [id, summarizeChecklist(byTodo.get(id) ?? [], todayKey)]))
}

/** ToDoリストの項目を、タスクIDごとに並び順どおりにまとめる */
export function groupListItems(listIds: Set<string>, subTasks: SubTask[]): Map<string, SubTask[]> {
  const byTodo = new Map<string, SubTask[]>()
  for (const subTask of subTasks) {
    if (!listIds.has(subTask.todo_id)) continue
    const list = byTodo.get(subTask.todo_id)
    if (list) list.push(subTask)
    else byTodo.set(subTask.todo_id, [subTask])
  }
  for (const list of byTodo.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
  return byTodo
}

/**
 * 「今日やる」に出す項目の並び。繰り返しの項目（並び順どおり）→ 期限が今日までのやること（期限の早い順）。
 * 済んだものも出す（チェックを外せるように）。繰り返さない項目は、今日済んだものだけ残す。
 */
export function todayItemsOf(items: SubTask[], todayKey: string = toDateKey(new Date())): SubTask[] {
  const repeat = items.filter((item) => item.recurrence)
  const due = items
    .filter((item) => !item.recurrence && (isDueByToday(item, todayKey)
      // 今日済ませたものも、期限が今日までだったものは残す（チェックを外せるように）
      || (item.done && item.completed_at != null && toDateKey(new Date(item.completed_at)) === todayKey
        && item.due_date != null && item.due_date.slice(0, 10) <= todayKey)))
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
  return [...repeat, ...due]
}

/** 使っている（完了・アーカイブでない）ToDoリスト */
export function isActiveList(todo: Pick<Todo, 'list_mode' | 'status'>): boolean {
  return Boolean(todo.list_mode) && todo.status !== 'done' && todo.status !== 'archived'
}

/**
 * 自分に関係する ToDoリストか（主担当・副担当・項目の担当のどれか）。
 * userId が null（デスクトップ版）なら、すべて自分のもの。
 */
export function isMyList(todo: Pick<Todo, 'assignee_id' | 'co_assignees'>, items: Array<Pick<SubTask, 'assignee_id'>>, userId: string | null): boolean {
  if (userId == null) return true
  return todo.assignee_id === userId
    || (todo.co_assignees ?? []).some((assignee) => assignee.user_id === userId)
    || items.some((item) => item.assignee_id === userId)
}

/** 自分がやる項目か（自分が担当、または担当なしで自分のリストの項目） */
export function isMyItem(item: Pick<SubTask, 'assignee_id'>, todo: Pick<Todo, 'assignee_id' | 'co_assignees'>, userId: string | null): boolean {
  if (userId == null) return true
  if (item.assignee_id != null) return item.assignee_id === userId
  return todo.assignee_id === userId || (todo.co_assignees ?? []).some((assignee) => assignee.user_id === userId)
}

export interface TodayListGroup {
  todo: Todo
  /** 今日やる項目（繰り返しの項目と、期限が今日までのやること） */
  items: SubTask[]
}

/** 自分の「今日やること」を ToDoリストごとにまとめる。保留中のリストは入れない */
export function buildTodayGroups(todos: Todo[], itemsByTodo: Map<string, SubTask[]>, userId: string | null, todayKey: string = toDateKey(new Date())): TodayListGroup[] {
  return todos
    .filter((todo) => isActiveList(todo) && todo.status !== 'on_hold')
    .map((todo) => {
      const items = itemsByTodo.get(todo.id) ?? []
      return { todo, items: todayItemsOf(items.filter((item) => isMyItem(item, todo, userId)), todayKey) }
    })
    .filter((group) => group.items.length > 0)
}

/** 今日やる項目のうち、まだ済んでいない数 */
export function countRemaining(groups: TodayListGroup[]): number {
  return groups.reduce((sum, group) => sum + group.items.filter((item) => !item.done).length, 0)
}

/** 今日やることの区分け。毎日の項目・やることは「今日やる」、毎週は「今週の分」、毎月は「今月の分」 */
export type TodaySection = 'today' | 'week' | 'month'

export const TODAY_SECTION_LABEL: Record<TodaySection, { label: string; title: string }> = {
  today: { label: '今日やる', title: '毎日・平日の項目と、期限が今日までのやること' },
  week: { label: '今週の分', title: '毎週の項目。戻る曜日の前日までにチェックすれば間に合います' },
  month: { label: '今月の分', title: '毎月の項目。戻る日の前日までにチェックすれば間に合います' }
}

export function sectionOf(item: Pick<SubTask, 'recurrence'>): TodaySection {
  if (item.recurrence === 'weekly') return 'week'
  if (item.recurrence === 'monthly') return 'month'
  return 'today'
}

export interface TodayEntry {
  item: SubTask
  todo: Todo
}

/** 区分けの中の項目を、ToDoリストごとにまとめる（リストの小見出しを付けるため。並びはそのまま） */
export function groupEntriesByList(entries: TodayEntry[]): Array<{ todo: Todo; items: SubTask[] }> {
  const groups: Array<{ todo: Todo; items: SubTask[] }> = []
  for (const { item, todo } of entries) {
    const last = groups[groups.length - 1]
    if (last && last.todo.id === todo.id) last.items.push(item)
    else groups.push({ todo, items: [item] })
  }
  return groups
}

/** リストごとの今日やることを、区分けごとに並べ直す（リストの順・項目の順はそのまま） */
export function buildTodaySections(groups: TodayListGroup[]): Array<{ section: TodaySection; entries: TodayEntry[] }> {
  const sections: TodaySection[] = ['today', 'week', 'month']
  return sections
    .map((section) => ({
      section,
      entries: groups.flatMap((group) => group.items.filter((item) => sectionOf(item) === section).map((item) => ({ item, todo: group.todo })))
    }))
    .filter((entry) => entry.entries.length > 0)
}
