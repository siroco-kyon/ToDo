import type { SubTask, SubTaskCheckSummary } from '../types'
import { isoToDateKey, parseDateOnly, toDateKey } from './dueDate'

// 報告タブの ToDoリストの要約（期間中にどれだけチェックしたか）。React に依存しないので、テストから直接呼べる。
// 数え方:
// - 実施の回数と率は「終わった回」（昨日まで・先週まで・先月まで）だけで出す。
// - 今日・今週・今月のような途中の回（サーバーが返す current_key）は、チェックしてもしなくても率に入れず、
//   「今日 1/5」のように別に出す。
//   途中の回をチェック済みのときだけ数えると、作ったばかりのリストは1件チェックしただけで 1/1回（100%）になるため。
// - 毎日・毎週・毎月は回の長さが違うので、1つの率に混ぜない。

export interface ReportPeriod {
  from: string
  to: string
}

/** 終わった回がこれより少ないうちは率（%）を出さず、回数だけにする */
export const MIN_PERIODS_FOR_RATE = 5

export type RepeatKind = 'daily' | 'weekly' | 'monthly'

const REPEAT_KINDS: RepeatKind[] = ['daily', 'weekly', 'monthly']

const WEEKDAY_SHORT = ['日', '月', '火', '水', '木', '金', '土']

/** 繰り返しの項目1つの、期間中の実施状況 */
export interface ItemCheckStatus {
  /** 終わった回の数と、そのうちチェックした数 */
  checked: number
  periods: number
  /** 今日を含む回（期間に重なるときだけ。先週を選んでも、今月の分のように続いている回は入る） */
  current: { label: string; checked: boolean } | null
}

/** 同じ周期（毎日・平日／毎週／毎月）の項目をまとめた実施状況 */
export interface RepeatGroupDigest {
  kind: RepeatKind
  /** 毎日・平日・毎日／平日・毎週・毎月 */
  label: string
  itemCount: number
  /** 終わった回の数の合計と、そのうちチェックした数 */
  checked: number
  periods: number
  /** 終わった回の呼び方（昨日まで・先週まで・先月まで。今日を含まない期間なら「期間中」） */
  doneLabel: string
  /** 今の回。total は今の回がある項目の数 */
  current: { label: string; checked: number; total: number } | null
  /** 終わった回がまだないときに、いつから数えるか（例: 明日から集計） */
  startsLabel: string
}

export interface ListReportDigest {
  repeatCount: number
  groups: RepeatGroupDigest[]
  /** 終わった回で取りこぼした項目（実施率の低い順） */
  missed: Array<{ item: SubTask; checked: number; periods: number }>
  /** 毎日の項目の、日ごとの実施（日付順）。today は今日（まだ途中の日） */
  days: Array<{ day: string; done: number; total: number; today: boolean }>
  /** 期限が過ぎたまだのやること（期限の早い順） */
  overdue: SubTask[]
  open: SubTask[]
  doneInPeriod: SubTask[]
}

function isInPeriod(dateKey: string, period: ReportPeriod): boolean {
  return period.from <= dateKey && dateKey <= period.to
}

function kindOf(item: Pick<SubTask, 'recurrence'>): RepeatKind | null {
  return item.recurrence === 'daily' || item.recurrence === 'weekly' || item.recurrence === 'monthly' ? item.recurrence : null
}

/** ToDoリストの項目を、繰り返しの項目・まだのやること・期間中に済んだやることに分ける */
export function splitListItems(items: SubTask[], period: ReportPeriod): { repeat: SubTask[]; open: SubTask[]; doneInPeriod: SubTask[] } {
  return {
    repeat: items.filter((item) => kindOf(item) != null),
    open: items.filter((item) => kindOf(item) == null && !item.done),
    // 過去の期間を選んだときに、その後で済んだものを数えないよう、期間の終わりでも区切る
    doneInPeriod: items.filter((item) => kindOf(item) == null && item.done && item.completed_at != null && isInPeriod(isoToDateKey(item.completed_at), period))
  }
}

/** 今の回の呼び方。平日だけの項目は、土日・祝日には前の平日の回が続いているので「金曜の分」のように書く */
function currentLabelOf(kind: RepeatKind, periodKey: string, todayKey: string): string {
  if (kind === 'weekly') return '今週の分'
  if (kind === 'monthly') return '今月の分'
  return periodKey === todayKey ? '今日' : `${WEEKDAY_SHORT[parseDateOnly(periodKey).getDay()]}曜の分`
}

/** 繰り返しの項目1つの実施状況。繰り返さない項目や、期間に回がないものは null */
export function itemCheckStatus(
  item: SubTask,
  summary: SubTaskCheckSummary | undefined,
  todayKey: string = toDateKey(new Date())
): ItemCheckStatus | null {
  const kind = kindOf(item)
  if (!kind || !summary || summary.period_keys.length === 0) return null
  // 今日を含む回はまだ途中（今日・今週・今月の分）。先週を選んでも、今月の分のように続いている回はここに入る
  const currentKey = summary.current_key
  const doneKeys = summary.period_keys.filter((key) => key !== currentKey)
  const checkedKeys = new Set(summary.checked_keys)
  return {
    checked: doneKeys.filter((key) => checkedKeys.has(key)).length,
    periods: doneKeys.length,
    current: currentKey ? { label: currentLabelOf(kind, currentKey, todayKey), checked: checkedKeys.has(currentKey) } : null
  }
}

function groupLabel(kind: RepeatKind, items: SubTask[]): string {
  if (kind === 'weekly') return '毎週'
  if (kind === 'monthly') return '毎月'
  const workdays = items.filter((item) => item.recurrence_workdays).length
  if (workdays === 0) return '毎日'
  return workdays === items.length ? '平日' : '毎日・平日'
}

function doneLabelOf(kind: RepeatKind, includesToday: boolean): string {
  if (!includesToday) return '期間中'
  if (kind === 'weekly') return '先週まで'
  if (kind === 'monthly') return '先月まで'
  return '昨日まで'
}

function startsLabelOf(kind: RepeatKind, label: string): string {
  if (kind === 'weekly') return '来週から集計'
  if (kind === 'monthly') return '来月から集計'
  return label === '平日' ? '次の平日から集計' : '明日から集計'
}

/** 報告用に ToDoリストを要約する。繰り返しの項目は周期ごとに「終わった回」と「今の回」を分けて数える */
export function digestListReport(
  items: SubTask[],
  checkSummaries: Map<string, SubTaskCheckSummary>,
  period: ReportPeriod,
  todayKey: string = toDateKey(new Date())
): ListReportDigest {
  const split = splitListItems(items, period)
  const includesToday = period.to >= todayKey
  const missed: ListReportDigest['missed'] = []
  const dayMap = new Map<string, { done: number; total: number }>()
  const groups: RepeatGroupDigest[] = []
  for (const kind of REPEAT_KINDS) {
    const kindItems = split.repeat.filter((item) => kindOf(item) === kind)
    if (kindItems.length === 0) continue
    const label = groupLabel(kind, kindItems)
    const group: RepeatGroupDigest = {
      kind,
      label,
      itemCount: kindItems.length,
      checked: 0,
      periods: 0,
      doneLabel: doneLabelOf(kind, includesToday),
      current: null,
      startsLabel: startsLabelOf(kind, label)
    }
    const currentLabels = new Set<string>()
    for (const item of kindItems) {
      const summary = checkSummaries.get(item.id)
      const status = itemCheckStatus(item, summary, todayKey)
      if (!status || !summary) continue
      group.checked += status.checked
      group.periods += status.periods
      if (status.periods > 0 && status.checked < status.periods) missed.push({ item, checked: status.checked, periods: status.periods })
      if (status.current) {
        currentLabels.add(status.current.label)
        group.current ??= { label: '', checked: 0, total: 0 }
        group.current.total++
        if (status.current.checked) group.current.checked++
      }
      if (kind === 'daily') {
        const checkedKeys = new Set(summary.checked_keys)
        for (const key of summary.period_keys) {
          const entry = dayMap.get(key) ?? { done: 0, total: 0 }
          entry.total++
          if (checkedKeys.has(key)) entry.done++
          dayMap.set(key, entry)
        }
      }
    }
    // 土日に「毎日」と「平日」の項目が混ざると、今の回が今日と金曜の分に分かれる
    if (group.current) group.current.label = currentLabels.size === 1 ? [...currentLabels][0] : '今の分'
    // 土日に平日の項目を見ると、昨日（金曜）の回はまだ途中なので「昨日まで」とは書かない
    if (includesToday && kind === 'daily' && [...currentLabels].some((label) => label !== '今日')) group.doneLabel = 'これまで'
    groups.push(group)
  }
  missed.sort((a, b) => a.checked / a.periods - b.checked / b.periods)
  return {
    repeatCount: split.repeat.length,
    groups,
    missed,
    days: [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ day, ...value, today: day === todayKey })),
    overdue: split.open
      .filter((item) => item.due_date != null && item.due_date.slice(0, 10) < todayKey)
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')),
    open: split.open,
    doneInPeriod: split.doneInPeriod
  }
}

/** 終わった回の実施（例: 18/20回（90%））。回数が少ないうちは率を付けない */
export function rateText(checked: number, periods: number): string {
  const count = `${checked}/${periods}回`
  return periods >= MIN_PERIODS_FOR_RATE ? `${count}（${Math.round((checked / periods) * 100)}%）` : count
}

/** 周期ごとの1行（例: 昨日まで 18/20回（90%）・今日 1/5）。Markdown・CSV 用 */
export function groupSummaryText(group: RepeatGroupDigest): string {
  const parts: string[] = []
  if (group.periods > 0) parts.push(`${group.doneLabel} ${rateText(group.checked, group.periods)}`)
  if (group.current) parts.push(`${group.current.label} ${group.current.checked}/${group.current.total}`)
  if (parts.length === 0) return '期間中の対象なし'
  const text = parts.join('・')
  return group.periods === 0 ? `${text}（${group.startsLabel}）` : text
}

/** 項目1つの実施状況の短い表記（例: 4/5回・今日 済み）。数える回がなければ null */
export function itemStatusText(status: ItemCheckStatus | null): string | null {
  if (!status) return null
  const parts: string[] = []
  if (status.periods > 0) parts.push(`${status.checked}/${status.periods}回`)
  if (status.current) parts.push(`${status.current.label} ${status.current.checked ? '済み' : 'まだ'}`)
  return parts.length > 0 ? parts.join('・') : null
}
