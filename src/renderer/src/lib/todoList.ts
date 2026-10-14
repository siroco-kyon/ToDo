import type { SubTask, Todo } from '../types'

// 「ToDoリスト」（期限を持たずに続くタスク）の項目まわりの共通処理。
// 項目＝サブタスク。繰り返しの項目は周期が変わると未チェックに戻る（戻すのはサーバー／デスクトップ版の本体）。

export type ItemRecurrence = 'daily' | 'weekly' | 'monthly'

/** 項目の繰り返しの選択肢。平日だけの毎日は recurrence='daily' + recurrence_workdays=1 */
export type ItemRepeatChoice = '' | 'daily' | 'workdays' | 'weekly' | 'monthly'

export const ITEM_REPEAT_OPTIONS: Array<{ value: ItemRepeatChoice; label: string; title: string }> = [
  { value: '', label: '繰り返さない', title: 'チェックしたら「済み」に移ります' },
  { value: 'daily', label: '毎日', title: '毎日、未チェックに戻ります' },
  { value: 'workdays', label: '平日', title: '平日の朝に未チェックに戻ります（土日・祝日は前の平日の分が続きます）' },
  { value: 'weekly', label: '毎週', title: '毎週月曜に未チェックに戻ります' },
  { value: 'monthly', label: '毎月', title: '毎月1日に未チェックに戻ります' }
]

export function isListTodo(todo: Pick<Todo, 'list_mode'> | null | undefined): boolean {
  return Boolean(todo?.list_mode)
}

export function repeatChoiceOf(subTask: Pick<SubTask, 'recurrence' | 'recurrence_workdays'>): ItemRepeatChoice {
  if (!subTask.recurrence) return ''
  if (subTask.recurrence === 'daily' && subTask.recurrence_workdays) return 'workdays'
  return subTask.recurrence
}

export function repeatFields(choice: ItemRepeatChoice): { recurrence: ItemRecurrence | null; recurrence_workdays: number } {
  if (choice === '') return { recurrence: null, recurrence_workdays: 0 }
  if (choice === 'workdays') return { recurrence: 'daily', recurrence_workdays: 1 }
  return { recurrence: choice, recurrence_workdays: 0 }
}

export function repeatLabel(subTask: Pick<SubTask, 'recurrence' | 'recurrence_workdays'>): string | null {
  const choice = repeatChoiceOf(subTask)
  return choice === '' ? null : ITEM_REPEAT_OPTIONS.find((option) => option.value === choice)?.label ?? null
}

export interface ChecklistSummary {
  /** 繰り返しの項目の数と、今回の周期でチェック済みの数 */
  repeatTotal: number
  repeatDone: number
  /** 繰り返さない項目のうち、まだ済んでいないもの */
  openCount: number
}

export function summarizeChecklist(items: SubTask[]): ChecklistSummary {
  let repeatTotal = 0
  let repeatDone = 0
  let openCount = 0
  for (const item of items) {
    if (item.recurrence) {
      repeatTotal++
      if (item.done) repeatDone++
    } else if (!item.done) {
      openCount++
    }
  }
  return { repeatTotal, repeatDone, openCount }
}

/** 一覧・カンバン・ガント用の短い表記（例: 「今回 3/5・残り2」） */
export function checklistBadgeText(summary: ChecklistSummary): string {
  const parts: string[] = []
  if (summary.repeatTotal > 0) parts.push(`今回 ${summary.repeatDone}/${summary.repeatTotal}`)
  if (summary.openCount > 0) parts.push(`残り${summary.openCount}`)
  return parts.length > 0 ? parts.join('・') : '項目なし'
}

export function checklistBadgeTitle(summary: ChecklistSummary): string {
  return `ToDoリスト（期限なしで続くタスク）: 繰り返しの項目 ${summary.repeatDone}/${summary.repeatTotal} 済み・まだの項目 ${summary.openCount}件`
}

/** タスクIDごとのまとめ。ToDoリストのタスクだけを対象にする */
export function buildChecklistSummaries(todos: Todo[], subTasks: SubTask[]): Map<string, ChecklistSummary> {
  const listIds = new Set(todos.filter(isListTodo).map((todo) => todo.id))
  const byTodo = new Map<string, SubTask[]>()
  for (const subTask of subTasks) {
    if (!listIds.has(subTask.todo_id)) continue
    const list = byTodo.get(subTask.todo_id)
    if (list) list.push(subTask)
    else byTodo.set(subTask.todo_id, [subTask])
  }
  return new Map([...listIds].map((id) => [id, summarizeChecklist(byTodo.get(id) ?? [])]))
}
