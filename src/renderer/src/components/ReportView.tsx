import { LinkedText } from './LinkedText'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { dateStamp, downloadCsv, toCsv } from '../lib/csv'
import { diffDaysFromToday, getDueDateColor, isoToDateKey, toDateKey } from '../lib/dueDate'
import { MentionTextarea } from './MentionTextarea'
import { ProgressNoteThread, discussionBadgeStyle } from './ProgressNoteThread'
import { ProgressSlider } from './ProgressSlider'
import { ReportSettingsPanel } from './ReportSettingsPanel'
import { getOnHoldInfo } from '../lib/onHold'
import {
  DEFAULT_REPORT_VIEW_SETTINGS,
  REPORT_SCOPE_OPTIONS,
  REPORT_STATUS_OPTIONS,
  loadReportViewSettings,
  saveReportViewSettings,
  statusesAreDefault,
  type ReportScope,
  type ReportStatusKey,
  type ReportSubTaskMode,
  type ReportViewSettings
} from '../lib/reportViewSettings'
import { checklistBadgeText, repeatLabel, summarizeChecklist } from '../lib/todoList'
import type {
  Category,
  CreateSubTaskInput,
  ProgressNote,
  ProgressNoteComment,
  PublicUser,
  SubTask,
  SubTaskCheckSummary,
  Todo,
  TodoChangeEntry,
  TodoReportActivity,
  TodoStatus,
  UpdateSubTaskInput,
  UpdateTodoInput
} from '../types'

// 定例ミーティング向けの「報告」タブ。
// 担当者ごとに、タスク・サブタスク・期限・進捗と、期間内の進捗ログ（返信込み）を全文で並べ、
// 報告が止まっているタスクを鮮度バッジで一目で分かるようにする。

interface Props {
  /** 画面表示中のタスク一覧（検索・カテゴリ・担当・レンズ適用済み） */
  todos: Todo[]
  subTasks: SubTask[]
  /** 表示設定のカテゴリの並び順と、小見出しの順に使う */
  categories: Category[]
  users: PublicUser[]
  currentUser: PublicUser | null
  onSelectTodo: (id: string) => void
  onUpdateTodo: (id: string, data: UpdateTodoInput) => Promise<void>
  onUpdateSubTask: (id: string, data: UpdateSubTaskInput) => Promise<void>
  onCreateSubTask: (todoId: string, data: CreateSubTaskInput) => Promise<void>
  onShowToast: ShowToast
  /** タスク一覧の絞り込み（カテゴリ・検索）の表示。見出しの横に出す */
  listFilters?: React.ReactNode
}

type ShowToast = (message: string, type?: 'success' | 'error', action?: { label: string; run: () => void }) => void

interface DateRange {
  from: string
  to: string
}

type PeriodPreset = 'thisWeek' | 'lastWeek' | '7' | '14' | '30' | 'custom'
/** 件数チップを押して絞り込む条件。myNeedsReport は「自分の未報告」の案内から使う */
type QuickFilter = 'all' | 'needsReport' | 'discussion' | 'onHold' | 'overdue' | 'postponed' | 'myNeedsReport'
type GroupMode = 'assignee' | 'category'
type AssigneeFilter = 'all' | 'mine' | 'mineWithSubTasks' | `user:${string}`
/** list: ToDoリスト（期限なしで続くタスク）。報告の有無では判定しない */
type Freshness = 'onHold' | 'fresh' | 'quiet' | 'stale' | 'none' | 'done' | 'notStarted' | 'list'

interface ReportRow extends ChangeSummary {
  todo: Todo
  subTasks: SubTask[]
  /** 期間内の進捗ログ（新しい順） */
  notes: ProgressNote[]
  lastReportAt: string | null
  lastMemoAt: string | null
  freshness: Freshness
  reportedInPeriod: boolean
  /** サブタスクごとの期間中の変化 */
  subTaskSummaries: Map<string, SubTaskChangeSummary>
  /** 未解決の「要相談」進捗ログ（期間に関係なく） */
  discussions: ProgressNote[]
  /** ToDoリストの繰り返しの項目ごとの、期間中の実施状況（項目のID → 状況） */
  checkSummaries: Map<string, SubTaskCheckSummary>
}

/** 期間中の進捗・期限の変化（タスク・サブタスク共通） */
interface ChangeSummary {
  /** 期間の最初の進捗率（期間中に進捗の変更がなければ null） */
  progressStart: number | null
  /** 期間中の期限の変更（古い順） */
  dueChanges: TodoChangeEntry[]
  /** 期間中に期限を後ろへずらした回数 */
  postponedCount: number
}

interface SubTaskChangeSummary extends ChangeSummary {
  addedInPeriod: boolean
}

interface ReportGroup {
  key: string
  label: string
  color: string | null
  isMe: boolean
  rows: ReportRow[]
}

/** 担当者の中のカテゴリ（カテゴリの中の担当者）の小見出し */
type SubGroupMode = 'category' | 'assignee'

interface ReportSubGroup {
  /** 畳んだ状態の保存キー（'category:<id>' / 'assignee:<id>'）。全員の同じ小見出しで共通 */
  key: string
  label: string
  color: string | null
  rows: ReportRow[]
}

/** この日数以上報告がなければ「止まっている」扱い（赤） */
const STALE_DAYS = 14

const PRESETS: Array<{ value: Exclude<PeriodPreset, 'custom'>; label: string; title: string }> = [
  { value: 'thisWeek', label: '今週', title: '今週の月曜日から今日まで' },
  { value: 'lastWeek', label: '先週', title: '先週の月曜日から日曜日まで' },
  { value: '7', label: '直近7日', title: '今日を含む直近7日間' },
  { value: '14', label: '直近14日', title: '今日を含む直近14日間' },
  { value: '30', label: '直近30日', title: '今日を含む直近30日間' }
]

const STORAGE_KEYS = {
  preset: 'report.periodPreset',
  groupMode: 'report.groupMode',
  onlyMine: 'report.onlyMine',
  assigneeFilter: 'report.assigneeFilter',
  excludeCoAssigned: 'report.excludeCoAssigned'
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  not_started: '未着手',
  active: '進行中',
  on_hold: '保留中',
  done: '完了',
  archived: 'アーカイブ'
}

const STATUS_COLOR: Record<TodoStatus, string> = {
  not_started: '#64748b',
  active: '#3b82f6',
  on_hold: '#c084fc',
  done: '#22c55e',
  archived: '#475569'
}


function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // localStorage が使えない環境では記憶しない
  }
}

function loadPreset(): Exclude<PeriodPreset, 'custom'> {
  const stored = readStorage(STORAGE_KEYS.preset)
  return PRESETS.some((preset) => preset.value === stored) ? stored as Exclude<PeriodPreset, 'custom'> : '7'
}

function loadAssigneeFilter(): AssigneeFilter {
  const stored = readStorage(STORAGE_KEYS.assigneeFilter)
  if (stored === 'all' || stored === 'mine' || stored === 'mineWithSubTasks') return stored
  if (stored?.startsWith('user:') && stored.length > 5) return stored as AssigneeFilter
  // 以前のチェックボックスの設定は、サブタスク担当を含む絞り込みとして引き継ぐ。
  return readStorage(STORAGE_KEYS.onlyMine) === '1' ? 'mineWithSubTasks' : 'all'
}

function presetRange(preset: Exclude<PeriodPreset, 'custom'>): DateRange {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (preset === 'thisWeek' || preset === 'lastWeek') {
    // 週は月曜始まり（ガントの週表示と同じ）
    const monday = new Date(today)
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    if (preset === 'thisWeek') return { from: toDateKey(monday), to: toDateKey(today) }
    const lastMonday = new Date(monday)
    lastMonday.setDate(lastMonday.getDate() - 7)
    const lastSunday = new Date(monday)
    lastSunday.setDate(lastSunday.getDate() - 1)
    return { from: toDateKey(lastMonday), to: toDateKey(lastSunday) }
  }
  const from = new Date(today)
  from.setDate(from.getDate() - (Number(preset) - 1))
  return { from: toDateKey(from), to: toDateKey(today) }
}

function matchesQuickFilter(row: ReportRow, filter: QuickFilter, currentUserId: string | null): boolean {
  switch (filter) {
    case 'all': return true
    case 'needsReport': return needsReport(row.freshness)
    case 'discussion': return row.discussions.length > 0
    case 'onHold': return row.todo.status === 'on_hold'
    case 'overdue': return isOverdue(row.todo)
    case 'postponed': return row.postponedCount > 0
    case 'myNeedsReport': return currentUserId != null && needsReport(row.freshness) && isMyTask(row.todo, [], currentUserId)
  }
}

function formatShortDate(dateKey: string | null): string {
  if (!dateKey) return '未設定'
  const [, m, d] = dateKey.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}`
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function weekdayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return WEEKDAYS[new Date(y, m - 1, d).getDay()]
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`
}

function formatDaysAgo(iso: string): string {
  const days = -diffDaysFromToday(isoToDateKey(iso))
  if (days <= 0) return '今日'
  if (days === 1) return '昨日'
  return `${days}日前`
}

function formatDueLabel(dueDate: string | null, status: TodoStatus): string | null {
  if (!dueDate || status === 'done') return null
  const diff = diffDaysFromToday(dueDate)
  if (diff < 0) return `${Math.abs(diff)}日遅れ`
  if (diff === 0) return '今日が期限'
  return `あと${diff}日`
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function isInRange(dateKey: string, range: DateRange): boolean {
  return range.from <= dateKey && dateKey <= range.to
}

function getAuthorName(authorName: string | null): string {
  return authorName?.trim() || '自分'
}

function isMyTask(todo: Todo, subTasks: SubTask[], userId: string): boolean {
  return todo.assignee_id === userId
    || (todo.co_assignees ?? []).some((assignee) => assignee.user_id === userId)
    || subTasks.some((subTask) => subTask.assignee_id === userId)
}

function groupByTodo<T extends { todo_id: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const list = map.get(item.todo_id)
    if (list) list.push(item)
    else map.set(item.todo_id, [item])
  }
  return map
}

function needsReport(freshness: Freshness): boolean {
  return freshness === 'quiet' || freshness === 'stale' || freshness === 'none'
}

function isOverdue(todo: Todo): boolean {
  return todo.status !== 'done' && todo.due_date != null && diffDaysFromToday(todo.due_date) < 0
}

function buildRow(
  todo: Todo,
  subTasks: SubTask[],
  notes: ProgressNote[],
  activity: TodoReportActivity | undefined,
  range: DateRange,
  changes: TodoChangeEntry[],
  discussions: ProgressNote[],
  checkSummaries: Map<string, SubTaskCheckSummary>
): ReportRow {
  const lastNoteAt = activity?.last_note_at ?? null
  const lastMemoAt = activity?.last_memo_at ?? null
  const lastReportAt = latestIso(lastNoteAt, lastMemoAt)
  // 最終更新だけでは、過去の期間を選んだときに期間中の更新を見落とすので、期間中の変更履歴も見る
  const memoUpdatedInPeriod = (lastMemoAt != null && isInRange(isoToDateKey(lastMemoAt), range))
    || changes.some((change) => change.subtask_id == null && change.field === 'memo')

  let freshness: Freshness
  if (todo.status === 'done') {
    freshness = 'done'
  } else if (todo.list_mode) {
    // ToDoリストは日々の項目のチェックで回すもので、進捗ログでの報告は求めない
    freshness = 'list'
  } else if (todo.status === 'on_hold') {
    freshness = 'onHold'
  } else if (notes.length > 0 || memoUpdatedInPeriod) {
    freshness = 'fresh'
  } else if (todo.status === 'not_started' && (
    !todo.start_date
    || todo.start_date.slice(0, 10) > range.to
    // 今日から始めるタスクは、まだ報告がなくて当然なので「報告なし」にしない
    || diffDaysFromToday(todo.start_date) >= 0
  )) {
    freshness = 'notStarted'
  } else if (!lastReportAt) {
    freshness = 'none'
  } else if (-diffDaysFromToday(isoToDateKey(lastReportAt)) >= STALE_DAYS) {
    freshness = 'stale'
  } else {
    freshness = 'quiet'
  }

  const summary = summarizeChanges(changes.filter((change) => change.subtask_id == null))
  const subTaskSummaries = new Map(subTasks.map((subTask) => [subTask.id, {
    ...summarizeChanges(changes.filter((change) => change.subtask_id === subTask.id)),
    addedInPeriod: isInRange(isoToDateKey(subTask.created_at), range)
  }]))

  return { todo, subTasks, notes, lastReportAt, lastMemoAt, freshness, reportedInPeriod: notes.length > 0 || memoUpdatedInPeriod, ...summary, subTaskSummaries, discussions, checkSummaries }
}

function summarizeChanges(changes: TodoChangeEntry[]): ChangeSummary {
  // 期間中の最初の変更の「変更前」が、期間開始時点の値
  const progressChanges = changes.filter((change) => change.field === 'progress')
  const progressStart = progressChanges.length > 0 ? Number(progressChanges[0].old_value ?? 0) : null
  const dueChanges = changes.filter((change) => change.field === 'due_date')
  const postponedCount = dueChanges.filter((change) =>
    change.old_value != null && change.new_value != null && change.new_value.slice(0, 10) > change.old_value.slice(0, 10)
  ).length
  return { progressStart, dueChanges, postponedCount }
}

function groupRows(rows: ReportRow[], mode: GroupMode, users: PublicUser[], currentUserId: string | null, selectedUserId: string | null = null): ReportGroup[] {
  const groups = new Map<string, ReportGroup>()
  for (const row of rows) {
    const { todo } = row
    const key = mode === 'assignee' ? (selectedUserId ?? todo.assignee_id ?? '') : (todo.category_id ?? '')
    const selectedUser = selectedUserId == null ? undefined : users.find((user) => user.id === selectedUserId)
    let group = groups.get(key)
    if (!group) {
      group = mode === 'assignee'
        ? {
            key,
            label: selectedUser?.display_name ?? todo.assignee_name ?? '未割り当て',
            color: selectedUser?.color ?? todo.assignee_color,
            isMe: key !== '' && key === currentUserId,
            rows: []
          }
        : { key, label: todo.category_name ?? '未分類', color: todo.category_color, isMe: false, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }

  const ordered = [...groups.values()]
  if (mode === 'assignee') {
    // 担当者はユーザー一覧の順（毎回同じ順で読み上げられるように）。未割り当ては最後
    const userOrder = new Map(users.map((user, index) => [user.id, index]))
    const rank = (group: ReportGroup): number => group.key === '' ? Number.MAX_SAFE_INTEGER : userOrder.get(group.key) ?? users.length
    return ordered.sort((a, b) => rank(a) - rank(b))
  }
  // カテゴリは一覧での初出順。未分類は最後
  return [...ordered.filter((group) => group.key !== ''), ...ordered.filter((group) => group.key === '')]
}

/** 小見出しで分ける。並びは毎回同じになるよう、カテゴリはカテゴリ一覧の順、担当者はユーザー一覧の順（空は最後） */
function subGroupRows(rows: ReportRow[], mode: SubGroupMode, categories: Category[], users: PublicUser[]): ReportSubGroup[] {
  const subGroups = new Map<string, ReportSubGroup & { id: string }>()
  for (const row of rows) {
    const { todo } = row
    const id = (mode === 'category' ? todo.category_id : todo.assignee_id) ?? ''
    const key = `${mode}:${id}`
    let subGroup = subGroups.get(key)
    if (!subGroup) {
      subGroup = mode === 'category'
        ? { key, id, label: todo.category_name ?? '未分類', color: todo.category_color, rows: [] }
        : { key, id, label: todo.assignee_name ?? '未割り当て', color: todo.assignee_color, rows: [] }
      subGroups.set(key, subGroup)
    }
    subGroup.rows.push(row)
  }
  const ids = mode === 'category' ? categories.map((category) => category.id) : users.map((user) => user.id)
  const order = new Map(ids.map((id, index) => [id, index]))
  const rank = (id: string): number => id === '' ? Number.MAX_SAFE_INTEGER : order.get(id) ?? ids.length
  return [...subGroups.values()]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map(({ key, label, color, rows: subRows }) => ({ key, label, color, rows: subRows }))
}

function subGroupKeyOf(todo: Todo, mode: SubGroupMode): string {
  return `${mode}:${(mode === 'category' ? todo.category_id : todo.assignee_id) ?? ''}`
}

// ─── 表示設定による絞り込み ─────────────────────────────────────

function isDoneInOrAfterPeriod(todo: Todo, range: DateRange): boolean {
  return todo.completed_at != null && isoToDateKey(todo.completed_at) >= range.from
}

function matchesStatusSetting(todo: Todo, statuses: Record<ReportStatusKey, boolean>, range: DateRange): boolean {
  switch (todo.status) {
    case 'archived': return false
    // 完了日が分からないものは期間前の完了として扱う（以前の「期間前に完了したタスクも表示」と同じ）
    case 'done': return isDoneInOrAfterPeriod(todo, range) ? statuses.doneInPeriod : statuses.doneBeforePeriod
    default: return statuses[todo.status]
  }
}

function matchesScopeSetting(row: ReportRow, scope: ReportScope, range: DateRange): boolean {
  if (scope === 'all') return true
  const { todo } = row
  if (scope === 'scheduled') {
    const start = todo.start_date?.slice(0, 10) ?? null
    let end = todo.due_date?.slice(0, 10) ?? null
    if (todo.status === 'done') {
      if (todo.completed_at) end = isoToDateKey(todo.completed_at)
    } else if (end != null) {
      // 期限を過ぎてまだ終わっていないものは、今日まで続いているとみなす
      const today = toDateKey(new Date())
      if (end < today) end = today
    }
    return (start == null || start <= range.to) && (end == null || end >= range.from)
  }
  const inRange = (iso: string | null): boolean => iso != null && isInRange(isoToDateKey(iso), range)
  return row.reportedInPeriod
    || row.discussions.length > 0
    || [...row.checkSummaries.values()].some((summary) => summary.checked_in_range > 0)
    || row.progressStart !== null
    || row.dueChanges.length > 0
    || inRange(todo.completed_at)
    || inRange(todo.created_at)
    || row.subTasks.some((subTask) => {
      const summary = row.subTaskSummaries.get(subTask.id)
      return inRange(subTask.completed_at)
        || (summary != null && (summary.addedInPeriod || summary.progressStart !== null || summary.dueChanges.length > 0))
    })
}

/** サブタスクの見せ方に応じて、そのまま出すものと畳むものに分ける */
function splitSubTasks(subTasks: SubTask[], mode: ReportSubTaskMode, periodFrom: string): { visible: SubTask[]; folded: SubTask[]; foldedLabel: string } {
  if (mode === 'hide') {
    return { visible: [], folded: subTasks, foldedLabel: `サブタスク ${subTasks.length}件を表示` }
  }
  // 完了日が不明なものは隠さず、期間より前に完了したものだけを折りたたむ。
  const isFolded = mode === 'openOnly'
    ? (subTask: SubTask) => subTask.done === 1
    : (subTask: SubTask) => subTask.done === 1 && subTask.completed_at != null && isoToDateKey(subTask.completed_at) < periodFrom
  const folded = subTasks.filter(isFolded)
  return {
    visible: subTasks.filter((subTask) => !isFolded(subTask)),
    folded,
    foldedLabel: mode === 'openOnly' ? `完了済み ${folded.length}件` : `完了済み ${folded.length}件（期間前）`
  }
}

/** ToDoリストの項目を、繰り返しの項目・まだのやること・期間中に済んだやることに分ける */
function splitListItems(row: ReportRow, period: DateRange): { repeat: SubTask[]; open: SubTask[]; doneInPeriod: SubTask[] } {
  return {
    repeat: row.subTasks.filter((item) => item.recurrence),
    open: row.subTasks.filter((item) => !item.recurrence && !item.done),
    // 過去の期間を選んだときに、その後で済んだものを数えないよう、期間の終わりでも区切る
    doneInPeriod: row.subTasks.filter((item) => !item.recurrence && item.done && item.completed_at != null && isInRange(isoToDateKey(item.completed_at), period))
  }
}

/** 繰り返しの項目の実施回数の表記（例: 4/5回）。数える周期がなければ null */
function checkCountText(summary: SubTaskCheckSummary | undefined): string | null {
  if (!summary || summary.periods === 0) return null
  return `${summary.checked}/${summary.periods}回`
}

/** Markdown・CSV に出すサブタスク。「完了済みは畳む」では未完了だけ、「すべて畳む」では出さない */
function subTasksForExport(subTasks: SubTask[], mode: ReportSubTaskMode): SubTask[] {
  if (mode === 'hide') return []
  if (mode === 'openOnly') return subTasks.filter((subTask) => subTask.done !== 1)
  return subTasks
}

function freshnessText(row: ReportRow): string {
  switch (row.freshness) {
    case 'onHold':
      return getOnHoldInfo(row.todo.on_hold_since).durationLabel
    case 'fresh':
      return '期間内に報告あり'
    case 'quiet':
      return '期間内の報告なし'
    case 'stale':
      return row.lastReportAt ? `${formatDaysAgo(row.lastReportAt).replace('前', '')}報告なし` : '報告なし'
    case 'none':
      return 'まだ報告なし'
    case 'done':
      return '完了'
    case 'notStarted':
      return '未着手'
    case 'list':
      return 'ToDoリスト'
  }
}

function freshnessTone(freshness: Freshness): { color: string; background: string; border: string } {
  if (freshness === 'onHold') return { color: '#e9d5ff', background: '#3b0764', border: '#a855f7' }
  if (freshness === 'fresh') return { color: '#86efac', background: '#052e16', border: '#166534' }
  if (freshness === 'quiet') return { color: '#fde68a', background: '#422006', border: '#a16207' }
  if (freshness === 'stale' || freshness === 'none') return { color: '#fecaca', background: '#450a0a', border: '#b91c1c' }
  if (freshness === 'done') return { color: '#bbf7d0', background: '#0f172a', border: '#334155' }
  if (freshness === 'list') return { color: '#c7d2fe', background: '#1e1b4b', border: '#4338ca' }
  return { color: '#94a3b8', background: '#0f172a', border: '#334155' }
}

/** 状態と鮮度をまとめた表記。完了・未着手は状態だけで意味が伝わるので重ねない */
function statusSummary(row: ReportRow, separator: string): string {
  const status = STATUS_LABEL[row.todo.status]
  if (row.freshness === 'list') return `ToDoリスト${separator}${checklistBadgeText(summarizeChecklist(row.subTasks))}`
  if (row.freshness === 'done' || row.freshness === 'notStarted') return status
  return `${status}${separator}${freshnessText(row)}`
}

/** 期間中の進捗の変化。変更がなければ null */
function progressDeltaText(summary: ChangeSummary, current: number): string | null {
  if (summary.progressStart === null) return null
  const delta = current - summary.progressStart
  const sign = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0'
  return `${summary.progressStart}% → ${current}%（${sign}）`
}

function progressDeltaColor(summary: ChangeSummary, current: number): string {
  if (summary.progressStart === null) return '#64748b'
  const delta = current - summary.progressStart
  if (delta > 0) return '#86efac'
  if (delta < 0) return '#fca5a5'
  return '#94a3b8'
}

/** 期間中の期限の変更。変更がなければ null */
function dueChangeText(summary: ChangeSummary, current: string | null): string | null {
  if (summary.dueChanges.length === 0) return null
  const first = summary.dueChanges[0].old_value
  const route = `${formatShortDate(first)} → ${formatShortDate(current)}`
  if (summary.postponedCount > 0) return `延期${summary.postponedCount}回（${route}）`
  if (first && current && current.slice(0, 10) < first.slice(0, 10)) return `前倒し（${route}）`
  if (!first && current) return `期限を設定（${formatShortDate(current)}）`
  return `期限を変更（${route}）`
}

/** サブタスクの期間中の変化（追加・進捗・期限）。何もなければ null */
function subTaskChangeText(subTask: SubTask, summary: SubTaskChangeSummary | undefined): string | null {
  if (!summary) return null
  const parts: string[] = []
  if (summary.addedInPeriod) parts.push('期間中に追加')
  const delta = progressDeltaText(summary, subTask.progress)
  if (delta) parts.push(`期間中 ${delta}`)
  const due = dueChangeText(summary, subTask.due_date)
  if (due) parts.push(due)
  return parts.length > 0 ? parts.join('・') : null
}

function assigneeText(todo: Todo): string {
  const co = (todo.co_assignees ?? []).map((assignee) => assignee.display_name)
  const main = todo.assignee_name ?? '未割り当て'
  return co.length > 0 ? `${main}（副: ${co.join('、')}）` : main
}

// ─── 出力 ─────────────────────────────────────────────────────

function indentLines(text: string, indent: string): string[] {
  return text.split(/\r?\n/).map((line) => `${indent}${line}`)
}

function commentsToMarkdown(comments: ProgressNoteComment[], depth: number): string[] {
  const lines: string[] = []
  for (const comment of comments) {
    const indent = '  '.repeat(depth)
    const [first, ...rest] = comment.body.split(/\r?\n/)
    lines.push(`${indent}- ↳ ${formatDateTime(comment.created_at)} ${getAuthorName(comment.author_name)}: ${first}`)
    for (const line of rest) lines.push(`${indent}  ${line}`)
    lines.push(...commentsToMarkdown(comment.replies ?? [], depth + 1))
  }
  return lines
}

function noteToMarkdown(note: ProgressNote, indent: string, withTask: boolean): string[] {
  const [first, ...rest] = note.body.split(/\r?\n/)
  const flag = note.needs_discussion === 1 ? '【要相談】' : ''
  const task = withTask ? `［${note.todo_title}］` : ''
  const lines = [`${indent}- ${flag}${task}${formatDateTime(note.created_at)} ${getAuthorName(note.author_name)}: ${first}`]
  for (const line of rest) lines.push(`${indent}  ${line}`)
  lines.push(...commentsToMarkdown(note.comments ?? [], indent.length / 2 + 1))
  return lines
}

interface MarkdownOptions {
  /** 報告の期間（ToDoリストの「期間中に済んだやること」に使う） */
  period: DateRange
  mode: GroupMode
  multiUser: boolean
  /** 小見出しで分けるとき、その分け方と並べ方 */
  subGroupMode: SubGroupMode | null
  categories: Category[]
  users: PublicUser[]
  subTaskMode: ReportSubTaskMode
}

function rowToMarkdown(row: ReportRow, heading: string, options: MarkdownOptions): string[] {
  const { todo } = row
  // ToDoリストは進捗率と期限を使わない
  const lines = [todo.list_mode
    ? `${heading} ${todo.title}（${statusSummary(row, '・')}）`
    : `${heading} ${todo.title}（${todo.progress}%・${statusSummary(row, '・')}）`]
  if (todo.status === 'on_hold') {
    const hold = getOnHoldInfo(todo.on_hold_since)
    lines.push(`- 保留開始: ${hold.sinceLabel} / ${hold.durationLabel}`)
  }
  lines.push(todo.list_mode
    ? `- 期間: 開始 ${todo.start_date?.slice(0, 10) ?? '未設定'} から続く（期限なし）`
    : `- 期間: 開始 ${todo.start_date?.slice(0, 10) ?? '未設定'} / 期限 ${todo.due_date?.slice(0, 10) ?? '未設定'}`)
  const delta = todo.list_mode ? null : progressDeltaText(row, row.todo.progress)
  if (delta) lines.push(`- 期間中の進捗: ${delta}`)
  const dueChange = todo.list_mode ? null : dueChangeText(row, row.todo.due_date)
  if (dueChange) lines.push(`- 期限の変更: ${dueChange}`)
  // 小見出しで分かることは繰り返さない
  if (options.mode === 'assignee') {
    if (options.subGroupMode !== 'category') lines.push(`- カテゴリ: ${todo.category_name ?? '未分類'}`)
  } else if (options.multiUser) {
    lines.push(`- 担当: ${assigneeText(todo)}`)
  }
  if (row.lastReportAt) lines.push(`- 最終報告: ${formatDateTime(row.lastReportAt)}`)
  if (todo.memo.trim()) {
    lines.push('- メモ:')
    lines.push(...indentLines(todo.memo.trim(), '  '))
  }
  const subTasks = todo.list_mode ? [] : subTasksForExport(row.subTasks, options.subTaskMode)
  if (todo.list_mode) {
    const items = splitListItems(row, options.period)
    if (items.repeat.length > 0) {
      lines.push('- 繰り返しの項目（期間中にチェックした回数）:')
      for (const item of items.repeat) lines.push(`  - ${item.title}（${repeatLabel(item) ?? ''}・${checkCountText(row.checkSummaries.get(item.id)) ?? '対象の期間なし'}）`)
    }
    if (items.open.length > 0) {
      lines.push('- まだのやること:')
      for (const item of items.open) lines.push(`  - [ ] ${item.title}${item.due_date ? `（期限 ${item.due_date.slice(0, 10)}）` : ''}`)
    }
    if (items.doneInPeriod.length > 0) {
      lines.push('- 期間中に済んだやること:')
      for (const item of items.doneInPeriod) lines.push(`  - [x] ${item.title}`)
    }
  }
  if (subTasks.length > 0) {
    lines.push('- サブタスク:')
    for (const subTask of subTasks) {
      const meta = [
        subTask.assignee_name,
        subTask.due_date ? `期限 ${subTask.due_date.slice(0, 10)}` : null,
        `${subTask.progress}%`
      ].filter(Boolean).join('・')
      const change = subTaskChangeText(subTask, row.subTaskSummaries.get(subTask.id))
      lines.push(`  - [${subTask.done ? 'x' : ' '}] ${subTask.title}（${meta}${change ? `・${change}` : ''}）`)
    }
  }
  if (row.notes.length === 0) {
    lines.push('- 進捗: この期間の記録なし')
  } else {
    lines.push('- 進捗:')
    for (const note of row.notes) lines.push(...noteToMarkdown(note, '  ', false))
  }
  lines.push('')
  return lines
}

function reportToMarkdown(groups: ReportGroup[], range: DateRange, options: MarkdownOptions): string {
  const lines: string[] = [`# 報告 ${range.from} ～ ${range.to}`, '']
  const discussions = groups.flatMap((group) => group.rows.flatMap((row) => row.discussions))
  if (discussions.length > 0) {
    lines.push(`## 要相談（${discussions.length}件）`, '')
    for (const note of discussions) lines.push(...noteToMarkdown(note, '', true))
    lines.push('')
  }
  for (const group of groups) {
    lines.push(`## ${group.label}（${group.rows.length}件）`, '')
    if (options.subGroupMode) {
      for (const subGroup of subGroupRows(group.rows, options.subGroupMode, options.categories, options.users)) {
        lines.push(`### ${subGroup.label}（${subGroup.rows.length}件）`, '')
        for (const row of subGroup.rows) lines.push(...rowToMarkdown(row, '####', options))
      }
    } else {
      for (const row of group.rows) lines.push(...rowToMarkdown(row, '###', options))
    }
  }
  return lines.join('\n')
}

function commentsToPlainText(comments: ProgressNoteComment[], depth: number): string[] {
  const lines: string[] = []
  for (const comment of comments) {
    lines.push(`${'  '.repeat(depth)}↳ ${formatDateTime(comment.created_at)} ${getAuthorName(comment.author_name)}: ${comment.body}`)
    lines.push(...commentsToPlainText(comment.replies ?? [], depth + 1))
  }
  return lines
}

function notesToPlainText(notes: ProgressNote[]): string {
  return notes
    .map((note) => [
      `${note.needs_discussion === 1 ? '【要相談】' : ''}${formatDateTime(note.created_at)} ${getAuthorName(note.author_name)}: ${note.body}`,
      ...commentsToPlainText(note.comments ?? [], 1)
    ].join('\n'))
    .join('\n\n')
}

function reportToCsv(groups: ReportGroup[], subTaskMode: ReportSubTaskMode, period: DateRange): string {
  const headers = ['担当', 'カテゴリ', 'タスク', 'サブタスク', '状態', '保留開始', '保留期間', '開始', '期限', '進捗(%)', '期間中の進捗', '期限の変更', '最終報告', '要相談', '期間内の進捗コメント', 'メモ']
  const rows: Array<Array<string | number | null>> = []
  for (const group of groups) {
    for (const row of group.rows) {
      const { todo } = row
      rows.push([
        assigneeText(todo),
        todo.category_name ?? '未分類',
        todo.title,
        '',
        statusSummary(row, ' / '),
        todo.status === 'on_hold' ? getOnHoldInfo(todo.on_hold_since).sinceLabel : '',
        todo.status === 'on_hold' ? getOnHoldInfo(todo.on_hold_since).durationLabel : '',
        todo.start_date?.slice(0, 10) ?? '',
        todo.due_date?.slice(0, 10) ?? '',
        todo.list_mode ? '' : todo.progress,
        todo.list_mode ? '' : progressDeltaText(row, row.todo.progress) ?? '',
        todo.list_mode ? '' : dueChangeText(row, row.todo.due_date) ?? '',
        row.lastReportAt ? formatDateTime(row.lastReportAt) : '',
        row.discussions.length > 0 ? `${row.discussions.length}件` : '',
        notesToPlainText(row.notes),
        todo.memo.trim()
      ])
      if (todo.list_mode) {
        const items = splitListItems(row, period)
        for (const item of [...items.repeat, ...items.open, ...items.doneInPeriod]) {
          rows.push([
            item.assignee_name ?? '',
            todo.category_name ?? '未分類',
            todo.title,
            item.title,
            item.recurrence
              ? `${repeatLabel(item) ?? ''} ${checkCountText(row.checkSummaries.get(item.id)) ?? '対象の期間なし'}`
              : item.done ? '済み' : 'まだ',
            '', '', '',
            item.due_date?.slice(0, 10) ?? '',
            '', '', '', '', '', '',
            item.description.trim()
          ])
        }
        continue
      }
      for (const subTask of subTasksForExport(row.subTasks, subTaskMode)) {
        const summary = row.subTaskSummaries.get(subTask.id)
        rows.push([
          subTask.assignee_name ?? '',
          todo.category_name ?? '未分類',
          todo.title,
          subTask.title,
          `${subTask.done ? '完了' : '未完了'}${summary?.addedInPeriod ? '（期間中に追加）' : ''}`,
          '',
          '',
          subTask.start_date?.slice(0, 10) ?? '',
          subTask.due_date?.slice(0, 10) ?? '',
          subTask.progress,
          summary ? progressDeltaText(summary, subTask.progress) ?? '' : '',
          summary ? dueChangeText(summary, subTask.due_date) ?? '' : '',
          '',
          '',
          '',
          subTask.description.trim()
        ])
      }
    }
  }
  return toCsv(headers, rows)
}

// ─── 画面 ─────────────────────────────────────────────────────

export function ReportView({ todos, subTasks, categories, users, currentUser, onSelectTodo, onUpdateTodo, onUpdateSubTask, onCreateSubTask, onShowToast, listFilters }: Props): React.JSX.Element {
  const multiUser = users.length > 0
  const settingsUserId = currentUser?.id ?? null
  const [preset, setPreset] = useState<PeriodPreset>(loadPreset)
  const [range, setRange] = useState<DateRange>(() => presetRange(loadPreset()))
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readStorage(STORAGE_KEYS.groupMode) === 'category' ? 'category' : 'assignee')
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>(loadAssigneeFilter)
  const [excludeCoAssigned, setExcludeCoAssigned] = useState(() => readStorage(STORAGE_KEYS.excludeCoAssigned) === '1')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  // 表示設定（カテゴリ・状態・対象・サブタスク・個別に隠したタスク・小見出し）。見ている人ごとに保存する
  const [settingsState, setSettingsState] = useState(() => ({ userId: settingsUserId, settings: loadReportViewSettings(settingsUserId) }))
  const settings = settingsState.userId === settingsUserId ? settingsState.settings : loadReportViewSettings(settingsUserId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 折りたたんだ担当者（カテゴリ）の見出しキー。定例で話し終えた人を畳んでおける
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [notes, setNotes] = useState<ProgressNote[]>([])
  const [activity, setActivity] = useState<Map<string, TodoReportActivity>>(() => new Map())
  const [changes, setChanges] = useState<TodoChangeEntry[]>([])
  const [discussions, setDiscussions] = useState<ProgressNote[]>([])
  const [checkSummaries, setCheckSummaries] = useState<SubTaskCheckSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  // デスクトップ版には担当者がいないのでカテゴリ別に固定する
  const effectiveGroupMode: GroupMode = multiUser ? groupMode : 'category'
  const unavailableAssignee = assigneeFilter.startsWith('user:') && !users.some((user) => user.id === assigneeFilter.slice(5))
  const effectiveAssigneeFilter = multiUser && currentUser != null && !unavailableAssignee ? assigneeFilter : 'all'
  const selectedUserId = effectiveAssigneeFilter.startsWith('user:')
    ? effectiveAssigneeFilter.slice(5)
    : effectiveAssigneeFilter === 'all' ? null : currentUser!.id

  const load = useCallback(async (): Promise<void> => {
    if (range.from > range.to) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const [nextNotes, nextActivity, nextChanges, nextDiscussions, nextCheckSummaries] = await Promise.all([
        window.api.progressNoteGetByRange(range.from, range.to),
        window.api.progressNoteGetLastActivity(),
        window.api.todoChangeGetByRange(range.from, range.to),
        window.api.progressNoteGetOpenDiscussions(),
        window.api.subtaskCheckSummaryGetByRange(range.from, range.to)
      ])
      if (requestId !== requestIdRef.current) return
      setNotes(nextNotes)
      setActivity(new Map(nextActivity.map((item) => [item.todo_id, item])))
      setChanges(nextChanges)
      setDiscussions(nextDiscussions)
      setCheckSummaries(nextCheckSummaries)
      setLoadError(null)
      setLoaded(true)
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      setLoadError(error instanceof Error ? error.message : '報告データを読み込めませんでした')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [range.from, range.to])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const unsubscribe = window.api.onDataChanged((scope) => {
      // 'todo' はメモの変更（最終報告日時）を反映するために必要
      if (scope === 'progress' || scope === 'todo') void load()
      // ToDoリストの項目のチェックは実施状況だけを取り直す
      if (scope === 'subtask' && range.from <= range.to) {
        void window.api.subtaskCheckSummaryGetByRange(range.from, range.to).then(setCheckSummaries).catch(() => { /* 次の読み込みで取り直す */ })
      }
    })
    return () => unsubscribe()
  }, [load])

  const applyPreset = (value: Exclude<PeriodPreset, 'custom'>): void => {
    setPreset(value)
    setRange(presetRange(value))
    writeStorage(STORAGE_KEYS.preset, value)
  }

  const changeGroupMode = (mode: GroupMode): void => {
    setGroupMode(mode)
    writeStorage(STORAGE_KEYS.groupMode, mode)
  }

  const changeAssigneeFilter = (value: AssigneeFilter): void => {
    setAssigneeFilter(value)
    writeStorage(STORAGE_KEYS.assigneeFilter, value)
  }

  // ログインし直して別の人になったら、その人の表示設定に切り替える
  useEffect(() => {
    if (settingsState.userId !== settingsUserId) {
      setSettingsState({ userId: settingsUserId, settings: loadReportViewSettings(settingsUserId) })
    }
  }, [settingsState.userId, settingsUserId])

  const updateSettings = useCallback((update: (previous: ReportViewSettings) => ReportViewSettings): void => {
    setSettingsState((previous) => {
      const base = previous.userId === settingsUserId ? previous.settings : loadReportViewSettings(settingsUserId)
      const next = update(base)
      saveReportViewSettings(settingsUserId, next)
      return { userId: settingsUserId, settings: next }
    })
  }, [settingsUserId])

  const setTodoHidden = useCallback((todo: Todo, hidden: boolean): void => {
    updateSettings((previous) => ({
      ...previous,
      hiddenTodoIds: hidden
        ? [...previous.hiddenTodoIds.filter((id) => id !== todo.id), todo.id]
        : previous.hiddenTodoIds.filter((id) => id !== todo.id)
    }))
    if (hidden) {
      onShowToast(`「${todo.title}」を報告に出さないようにしました`, 'success', { label: '元に戻す', run: () => setTodoHidden(todo, false) })
    }
  }, [onShowToast, updateSettings])

  const toggleSubGroupCollapsed = (key: string): void => {
    updateSettings((previous) => ({
      ...previous,
      collapsedSubGroupKeys: previous.collapsedSubGroupKeys.includes(key)
        ? previous.collapsedSubGroupKeys.filter((item) => item !== key)
        : [...previous.collapsedSubGroupKeys, key]
    }))
  }

  const notesByTodo = useMemo(() => {
    const map = new Map<string, ProgressNote[]>()
    for (const note of notes) {
      const list = map.get(note.todo_id)
      if (list) list.push(note)
      else map.set(note.todo_id, [note])
    }
    for (const list of map.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return map
  }, [notes])

  const subTasksByTodo = useMemo(() => {
    const map = new Map<string, SubTask[]>()
    for (const subTask of subTasks) {
      const list = map.get(subTask.todo_id)
      if (list) list.push(subTask)
      else map.set(subTask.todo_id, [subTask])
    }
    for (const list of map.values()) list.sort((a, b) => a.sort_order - b.sort_order)
    return map
  }, [subTasks])

  const changesByTodo = useMemo(() => groupByTodo(changes), [changes])
  const discussionsByTodo = useMemo(() => groupByTodo(discussions), [discussions])
  const checkSummariesByTodo = useMemo(() => {
    const map = new Map<string, Map<string, SubTaskCheckSummary>>()
    for (const summary of checkSummaries) {
      const byItem = map.get(summary.todo_id)
      if (byItem) byItem.set(summary.subtask_id, summary)
      else map.set(summary.todo_id, new Map([[summary.subtask_id, summary]]))
    }
    return map
  }, [checkSummaries])

  const hiddenTodoIdSet = useMemo(() => new Set(settings.hiddenTodoIds), [settings.hiddenTodoIds])
  const hiddenCategoryKeySet = useMemo(() => new Set(settings.hiddenCategoryKeys), [settings.hiddenCategoryKeys])

  const baseRows = useMemo(() => todos
    .filter((todo) => !hiddenTodoIdSet.has(todo.id))
    .filter((todo) => !hiddenCategoryKeySet.has(todo.category_id ?? ''))
    // 既定では、期間より前に完了したタスクは隠す（期間中・期間後に完了したものは報告対象）
    .filter((todo) => matchesStatusSetting(todo, settings.statuses, range))
    .filter((todo) => selectedUserId == null || isMyTask(todo,
      effectiveAssigneeFilter === 'mineWithSubTasks' ? subTasksByTodo.get(todo.id) ?? [] : [], selectedUserId))
    .filter((todo) => selectedUserId == null || !excludeCoAssigned || todo.assignee_id === selectedUserId)
    .map((todo) => buildRow(
      todo,
      subTasksByTodo.get(todo.id) ?? [],
      notesByTodo.get(todo.id) ?? [],
      activity.get(todo.id),
      range,
      changesByTodo.get(todo.id) ?? [],
      discussionsByTodo.get(todo.id) ?? [],
      checkSummariesByTodo.get(todo.id) ?? new Map()
    ))
    .filter((row) => matchesScopeSetting(row, settings.scope, range)),
  [activity, changesByTodo, checkSummariesByTodo, discussionsByTodo, effectiveAssigneeFilter, excludeCoAssigned, hiddenCategoryKeySet, hiddenTodoIdSet, notesByTodo, range, selectedUserId, settings.scope, settings.statuses, subTasksByTodo, todos])

  // 表示設定のカテゴリの選択肢。検索などで今は出ていないカテゴリも選べるよう、カテゴリ一覧のすべてを並べる（未分類は最後）
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const todo of todos) {
      if (todo.status === 'archived') continue
      const key = todo.category_id ?? ''
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [
      ...categories.map((category) => ({ key: category.id, label: category.name, color: category.color, count: counts.get(category.id) ?? 0 })),
      { key: '', label: '未分類', color: null, count: counts.get('') ?? 0 }
    ]
  }, [categories, todos])

  const hiddenTodos = useMemo(() => todos.filter((todo) => hiddenTodoIdSet.has(todo.id)), [hiddenTodoIdSet, todos])
  const hiddenCategoryCount = categoryOptions.filter((option) => hiddenCategoryKeySet.has(option.key)).length

  const currentUserId = currentUser?.id ?? null
  // 自分の未報告の案内はサーバー版でログインしているときだけ
  const effectiveQuickFilter: QuickFilter = quickFilter === 'myNeedsReport' && !(multiUser && currentUserId) ? 'all' : quickFilter
  const rows = useMemo(() => baseRows
    .filter((row) => matchesQuickFilter(row, effectiveQuickFilter, currentUserId))
    // 保留中だけを見るときは、保留が長いものから並べる
    .sort((a, b) => effectiveQuickFilter === 'onHold' ? (a.todo.on_hold_since ?? '9999').localeCompare(b.todo.on_hold_since ?? '9999') : 0),
  [baseRows, currentUserId, effectiveQuickFilter])

  const groups = useMemo(
    () => groupRows(rows, effectiveGroupMode, users, currentUser?.id ?? null, selectedUserId),
    [currentUser, effectiveGroupMode, rows, selectedUserId, users]
  )

  // 担当者別ではカテゴリ、カテゴリ別では担当者で小見出しを作る。カテゴリ別で一人に絞っているときは分けても同じなので分けない
  const subGroupMode: SubGroupMode | null = !settings.splitSubGroups
    ? null
    : effectiveGroupMode === 'assignee'
      ? 'category'
      : multiUser && selectedUserId == null ? 'assignee' : null
  const collapsedSubGroupSet = useMemo(() => new Set(settings.collapsedSubGroupKeys), [settings.collapsedSubGroupKeys])
  const visibleSubGroupKeys = useMemo(
    () => subGroupMode ? [...new Set(rows.map((row) => subGroupKeyOf(row.todo, subGroupMode)))] : [],
    [rows, subGroupMode]
  )
  const anySubGroupCollapsed = visibleSubGroupKeys.some((key) => collapsedSubGroupSet.has(key))
  const toggleAllSubGroups = (): void => {
    updateSettings((previous) => ({
      ...previous,
      collapsedSubGroupKeys: anySubGroupCollapsed
        ? previous.collapsedSubGroupKeys.filter((key) => !visibleSubGroupKeys.includes(key))
        : [...new Set([...previous.collapsedSubGroupKeys, ...visibleSubGroupKeys])]
    }))
  }

  // 既定と違う表示設定。見出しの近くに出して、隠れているものがあると分かるようにする
  const settingsChips: Array<{ key: string; label: string; clear: () => void }> = [
    ...(hiddenCategoryCount > 0 ? [{ key: 'category', label: `カテゴリ ${hiddenCategoryCount}件を非表示`, clear: () => updateSettings((previous) => ({ ...previous, hiddenCategoryKeys: [] })) }] : []),
    ...(!statusesAreDefault(settings.statuses) ? [{
      key: 'status',
      label: `状態: ${REPORT_STATUS_OPTIONS.filter((option) => settings.statuses[option.key]).map((option) => option.label).join('・') || 'なし'}`,
      clear: () => updateSettings((previous) => ({ ...previous, statuses: { ...DEFAULT_REPORT_VIEW_SETTINGS.statuses } }))
    }] : []),
    ...(settings.scope !== 'all' ? [{
      key: 'scope',
      label: REPORT_SCOPE_OPTIONS.find((option) => option.value === settings.scope)?.label ?? '',
      clear: () => updateSettings((previous) => ({ ...previous, scope: 'all' }))
    }] : [])
  ]

  // 件数は絞り込みチップを押す前の対象から数える（押しても他のチップの件数が変わらないように）
  const countOf = (filter: QuickFilter): number => baseRows.filter((row) => matchesQuickFilter(row, filter, currentUserId)).length
  const reportedCount = baseRows.filter((row) => row.reportedInPeriod).length
  const noteCount = baseRows.reduce((sum, row) => sum + row.notes.length, 0)
  const myNeedsReportCount = multiUser && currentUserId ? countOf('myNeedsReport') : 0
  const quickFilterChips: Array<{ value: QuickFilter; label: string; count: number; color: string; title: string }> = [
    { value: 'all', label: 'すべて', count: baseRows.length, color: '#cbd5e1', title: '絞り込まずに表示' },
    { value: 'needsReport', label: '報告なし', count: countOf('needsReport'), color: '#fde68a', title: '進行中なのに、この期間の進捗ログ・メモ更新がないタスク' },
    { value: 'discussion', label: '要相談', count: countOf('discussion'), color: '#d6b38a', title: '「要相談」が付いた進捗ログがあるタスク（期間に関係なく）' },
    { value: 'onHold', label: '保留中', count: countOf('onHold'), color: '#d8b4fe', title: '保留中のタスク（保留が長い順）' },
    { value: 'overdue', label: '期限超過', count: countOf('overdue'), color: '#fca5a5', title: '期限を過ぎて完了していないタスク' },
    { value: 'postponed', label: '期間中に延期', count: countOf('postponed'), color: '#fde68a', title: 'この期間に期限を後ろへずらしたタスク' }
  ]
  const toggleGroupCollapsed = (key: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const groupDomId = (key: string): string => `report-group-${effectiveGroupMode}-${key || 'none'}`
  const jumpToGroup = (key: string): void => {
    setCollapsedGroups((previous) => {
      if (!previous.has(key)) return previous
      const next = new Set(previous)
      next.delete(key)
      return next
    })
    window.requestAnimationFrame(() => document.getElementById(groupDomId(key))?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const canModifyNote = useCallback(
    (note: ProgressNote): boolean => currentUser == null || currentUser.role === 'admin' || note.user_id === currentUser.id,
    [currentUser]
  )

  // 期間内の一覧と「要相談」一覧の両方に同じ進捗ログが載りうるので、両方を差し替える
  const patchNote = useCallback((updated: ProgressNote): void => {
    setNotes((previous) => previous.map((note) => note.id === updated.id ? updated : note))
    setDiscussions((previous) => {
      const others = previous.filter((note) => note.id !== updated.id)
      if (updated.needs_discussion !== 1) return others
      return [...others, updated].sort((a, b) => b.created_at.localeCompare(a.created_at))
    })
  }, [])

  const createNote = useCallback(async (todo: Todo, body: string, needsDiscussion: boolean): Promise<boolean> => {
    const trimmed = body.trim()
    if (!trimmed) return false
    try {
      const created = await window.api.progressNoteCreate(todo.id, trimmed)
      if (needsDiscussion) await window.api.progressNoteSetNeedsDiscussion(created.id, true)
      await load()
      onShowToast('進捗ログを投稿しました')
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを投稿できませんでした', 'error')
      return false
    }
  }, [load, onShowToast])

  const updateNote = useCallback(async (noteId: string, body: string): Promise<boolean> => {
    try {
      patchNote(await window.api.progressNoteUpdate(noteId, body.trim()))
      onShowToast('進捗ログを更新しました')
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを更新できませんでした', 'error')
      return false
    }
  }, [onShowToast, patchNote])

  const deleteNote = useCallback(async (noteId: string): Promise<void> => {
    if (!window.confirm('この進捗ログを削除しますか？\n付いている返信も一緒に削除されます。')) return
    try {
      await window.api.progressNoteDelete(noteId)
      // 最終報告日時が変わることがあるので取り直す
      await load()
      onShowToast('進捗ログを削除しました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを削除できませんでした', 'error')
    }
  }, [load, onShowToast])

  // 送信中のリアクション（対象と絵文字）。連打で toggle が交錯しないようガードする
  const pendingReactionsRef = useRef<Set<string>>(new Set())

  const toggleReaction = useCallback(async (
    id: string,
    emoji: string,
    action: (id: string, emoji: string) => Promise<ProgressNote>
  ): Promise<void> => {
    const key = `${id}:${emoji}`
    if (pendingReactionsRef.current.has(key)) return
    pendingReactionsRef.current.add(key)
    try {
      patchNote(await action(id, emoji))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'リアクションを更新できませんでした', 'error')
    } finally {
      pendingReactionsRef.current.delete(key)
    }
  }, [onShowToast, patchNote])

  const replyNote = useCallback(async (noteId: string, body: string, parentCommentId: string | null): Promise<boolean> => {
    const trimmed = body.trim()
    if (!trimmed) return false
    try {
      patchNote(await window.api.progressNoteCommentCreate(noteId, trimmed, parentCommentId))
      onShowToast('返信しました')
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '返信できませんでした', 'error')
      return false
    }
  }, [onShowToast, patchNote])

  const toggleDiscussion = useCallback(async (noteId: string, value: boolean): Promise<void> => {
    const key = `discussion:${noteId}`
    if (pendingReactionsRef.current.has(key)) return
    pendingReactionsRef.current.add(key)
    try {
      patchNote(await window.api.progressNoteSetNeedsDiscussion(noteId, value))
      onShowToast(value ? '要相談にしました' : '要相談を外しました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '要相談を切り替えられませんでした', 'error')
    } finally {
      pendingReactionsRef.current.delete(key)
    }
  }, [onShowToast, patchNote])

  const updateSubTask = useCallback(async (subTask: SubTask, data: UpdateSubTaskInput, successMessage: string): Promise<boolean> => {
    try {
      await onUpdateSubTask(subTask.id, data)
      // 進捗・期限は期間中の変化の表示に、期限は親タスクの期限延長にも影響するので取り直す
      await load()
      onShowToast(successMessage)
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'サブタスクを更新できませんでした', 'error')
      return false
    }
  }, [load, onShowToast, onUpdateSubTask])

  const createSubTask = useCallback(async (todo: Todo, data: CreateSubTaskInput): Promise<boolean> => {
    try {
      await onCreateSubTask(todo.id, data)
      // 親タスクの期限が自動で延びた場合の変更履歴を反映する
      await load()
      onShowToast(`サブタスク「${data.title}」を追加しました`)
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'サブタスクを追加できませんでした', 'error')
      return false
    }
  }, [load, onCreateSubTask, onShowToast])

  const updateTask = useCallback(async (todo: Todo, data: UpdateTodoInput, successMessage: string): Promise<boolean> => {
    try {
      await onUpdateTodo(todo.id, data)
      // メモは最終報告日時に、進捗・期限は期間中の変化の表示に影響するので取り直す
      await load()
      onShowToast(successMessage)
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'タスクを更新できませんでした', 'error')
      return false
    }
  }, [load, onShowToast, onUpdateTodo])

  const actions = useMemo<ReportCardActions>(() => ({
    canModifyNote,
    onCreateNote: createNote,
    onUpdateNote: updateNote,
    onDeleteNote: (noteId) => void deleteNote(noteId),
    onToggleNoteReaction: (noteId, emoji) => void toggleReaction(noteId, emoji, (id, value) => window.api.progressNoteReactionToggle(id, value)),
    onToggleCommentReaction: (commentId, emoji) => void toggleReaction(commentId, emoji, (id, value) => window.api.progressNoteCommentReactionToggle(id, value)),
    onReply: replyNote,
    onToggleDiscussion: (noteId, value) => void toggleDiscussion(noteId, value),
    onUpdateTask: updateTask,
    onUpdateSubTask: updateSubTask,
    onCreateSubTask: createSubTask,
    onSelectTodo,
    onHideTodo: (todo) => setTodoHidden(todo, true),
    onShowToast,
    users,
    // 「@」の候補（自分を呼んでも通知は届かないので外す）
    mentionUsers: users.filter((user) => user.id !== currentUser?.id)
  }), [canModifyNote, createNote, createSubTask, currentUser, deleteNote, onSelectTodo, onShowToast, replyNote, setTodoHidden, toggleDiscussion, toggleReaction, updateNote, updateSubTask, updateTask, users])

  const handleCopyMarkdown = async (): Promise<void> => {
    try {
      await copyTextToClipboard(reportToMarkdown(groups, range, {
        period: range,
        mode: effectiveGroupMode,
        multiUser,
        subGroupMode,
        categories,
        users,
        subTaskMode: settings.subTaskMode
      }))
      onShowToast('Markdownをコピーしました')
    } catch {
      onShowToast('クリップボードへのコピーに失敗しました', 'error')
    }
  }

  const renderCard = (row: ReportRow): React.JSX.Element => (
    <ReportTaskCard
      key={row.todo.id}
      row={row}
      periodFrom={range.from}
      periodTo={range.to}
      groupMode={effectiveGroupMode}
      subGroupMode={subGroupMode}
      subTaskMode={settings.subTaskMode}
      showAssignee={selectedUserId != null}
      multiUser={multiUser}
      isMine={currentUser != null && isMyTask(row.todo, row.subTasks, currentUser.id)}
      onSelectTodo={onSelectTodo}
      actions={actions}
    />
  )

  const handleDownloadCsv = (): void => {
    downloadCsv(`report-${range.from}_${range.to}-${dateStamp()}.csv`, reportToCsv(groups, settings.subTaskMode, range))
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#0f172a' }}>
      <div style={{ padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
        {/* ─── 見出し・操作 ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: '1.15rem', color: '#f8fafc', fontWeight: 800 }}>報告</div>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 700 }}>
              {formatShortDate(range.from)}（{weekdayLabel(range.from)}）～ {formatShortDate(range.to)}（{weekdayLabel(range.to)}）
            </div>
            {listFilters}
            <div style={{ fontSize: '0.76rem', color: '#64748b' }}>
              定例用に、タスクごとの進捗と報告（進捗ログ・メモ）を1ページで見ます。状態・日程・進捗・メモはその場で変えられます
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={groupStyle} role="group" aria-label="報告期間">
              {PRESETS.map((item) => (
                <button key={item.value} onClick={() => applyPreset(item.value)} title={item.title} aria-pressed={preset === item.value} style={chipStyle(preset === item.value)}>
                  {item.label}
                </button>
              ))}
            </div>
            <input
              type="date"
              aria-label="報告期間の開始日"
              value={range.from}
              onChange={(event) => {
                const from = event.target.value
                if (!from) return
                setPreset('custom')
                setRange((previous) => ({ from, to: from > previous.to ? from : previous.to }))
              }}
              style={inputStyle}
            />
            <span style={{ color: '#64748b', fontSize: '0.8rem' }}>～</span>
            <input
              type="date"
              aria-label="報告期間の終了日"
              value={range.to}
              onChange={(event) => {
                const to = event.target.value
                if (!to) return
                setPreset('custom')
                setRange((previous) => ({ from: to < previous.from ? to : previous.from, to }))
              }}
              style={inputStyle}
            />

            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <button onClick={() => void load()} disabled={loading} style={secondaryButtonStyle}>{loading ? '更新中…' : '更新'}</button>
              <button onClick={() => void handleCopyMarkdown()} title="表示中の内容をMarkdownでコピーします（議事録などに貼れます）" style={secondaryButtonStyle}>Markdownをコピー</button>
              <button onClick={handleDownloadCsv} title="表示中の内容をCSVで保存します（Excelで開けます）" style={secondaryButtonStyle}>CSV</button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {multiUser && (
              <div style={groupStyle} role="group" aria-label="まとめ方">
                <button onClick={() => changeGroupMode('assignee')} aria-pressed={groupMode === 'assignee'} style={chipStyle(groupMode === 'assignee')}>担当者別</button>
                <button onClick={() => changeGroupMode('category')} aria-pressed={groupMode === 'category'} style={chipStyle(groupMode === 'category')}>カテゴリ別</button>
              </div>
            )}
            {multiUser && currentUser && (
              <label style={checkboxLabelStyle}>
                担当
                <select value={assigneeFilter} onChange={(event) => changeAssigneeFilter(event.target.value as AssigneeFilter)} style={inputStyle}>
                  <option value="all">全員</option>
                  <option value="mine">自分の担当のみ</option>
                  <option value="mineWithSubTasks">自分の担当＋サブタスク担当</option>
                  <optgroup label="担当者を選ぶ">
                    {users.map((user) => (
                      <option key={user.id} value={`user:${user.id}`}>{user.display_name}</option>
                    ))}
                  </optgroup>
                </select>
              </label>
            )}
            {multiUser && currentUser && selectedUserId != null && (
              <label style={checkboxLabelStyle}>
                <input
                  type="checkbox"
                  checked={excludeCoAssigned}
                  onChange={(event) => {
                    setExcludeCoAssigned(event.target.checked)
                    writeStorage(STORAGE_KEYS.excludeCoAssigned, event.target.checked ? '1' : '0')
                  }}
                  style={{ accentColor: '#6366f1' }}
                />
                副担当のタスクを除く（主担当のみ）
              </label>
            )}
            <button
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="report-view-settings"
              title="報告に出すカテゴリ・状態・対象・サブタスクの見せ方などを選びます"
              style={{ ...secondaryButtonStyle, borderColor: settingsOpen ? '#6366f1' : '#334155' }}
            >
              表示設定 {settingsOpen ? '▴' : '▾'}
            </button>
            {(settingsChips.length > 0 || hiddenTodos.length > 0) && (
              <span role="group" aria-label="表示設定で隠しているもの" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}>
                {settingsChips.map((chip) => (
                  <button key={chip.key} onClick={chip.clear} title={`${chip.label} をやめる`} style={settingsChipStyle}>
                    {chip.label} ×
                  </button>
                ))}
                {hiddenTodos.length > 0 && (
                  <button onClick={() => setSettingsOpen(true)} title="隠したタスクは表示設定から戻せます" style={settingsChipStyle}>
                    隠したタスク {hiddenTodos.length}件
                  </button>
                )}
              </span>
            )}
          </div>

          {settingsOpen && (
            <ReportSettingsPanel
              settings={settings}
              onChange={updateSettings}
              categoryOptions={categoryOptions}
              hiddenTodos={hiddenTodos}
              onUnhideTodo={(todo) => setTodoHidden(todo, false)}
              subGroupLabel={effectiveGroupMode === 'assignee' ? '担当者の中をカテゴリで分ける' : multiUser ? 'カテゴリの中を担当者で分ける' : null}
              onClose={() => setSettingsOpen(false)}
            />
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="件数で絞り込み">
            {quickFilterChips.map((chip) => {
              const active = effectiveQuickFilter === chip.value
              const muted = chip.value !== 'all' && chip.count === 0
              return (
                <button
                  key={chip.value}
                  onClick={() => setQuickFilter(active && chip.value !== 'all' ? 'all' : chip.value)}
                  disabled={muted && !active}
                  aria-pressed={active}
                  title={muted ? `${chip.label}のタスクはありません` : `${chip.title}${active ? '（もう一度押すと解除）' : '（押すと絞り込み）'}`}
                  style={quickFilterChipStyle(chip.color, active, muted)}
                >
                  {chip.label} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{chip.count}</span>
                </button>
              )
            })}
            <span style={{ fontSize: '0.72rem', color: '#64748b', marginLeft: 4 }}>
              期間内に報告あり {reportedCount}件 ・ 進捗ログ {noteCount}件
            </span>
          </div>

          {myNeedsReportCount > 0 && effectiveQuickFilter !== 'myNeedsReport' && (
            <div role="status" style={myReminderStyle}>
              <span>あなたの担当で、この期間まだ報告がないタスクが <strong>{myNeedsReportCount}件</strong> あります。進捗ログかメモで一言残しておきましょう。</span>
              <button onClick={() => setQuickFilter('myNeedsReport')} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>自分の未報告だけ表示</button>
            </div>
          )}
          {effectiveQuickFilter === 'myNeedsReport' && (
            <div role="status" style={myReminderStyle}>
              <span>自分の担当で、この期間まだ報告がないタスクだけを表示しています。</span>
              <button onClick={() => setQuickFilter('all')} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>すべて表示に戻す</button>
            </div>
          )}

          {loaded && (groups.length > 1 || visibleSubGroupKeys.length > 1) && (
            <nav aria-label={effectiveGroupMode === 'assignee' ? '担当者へ移動' : 'カテゴリへ移動'} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingTop: 2 }}>
              {groups.length > 1 && <span style={{ fontSize: '0.72rem', color: '#64748b' }}>{effectiveGroupMode === 'assignee' ? '担当者へ移動:' : 'カテゴリへ移動:'}</span>}
              {groups.length > 1 && groups.map((group) => {
                const needs = group.rows.filter((row) => needsReport(row.freshness)).length
                return (
                  <button key={group.key} onClick={() => jumpToGroup(group.key)} title={`${group.label}の欄へ移動`} style={jumpChipStyle}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.color ?? '#475569', flexShrink: 0 }} />
                    {group.label}
                    <span style={{ color: '#64748b', fontWeight: 600 }}>{group.rows.length}</span>
                    {needs > 0 && <span style={{ color: '#fde68a', fontWeight: 700 }}>報告なし{needs}</span>}
                  </button>
                )
              })}
              {groups.length > 1 && (
                <button onClick={() => setCollapsedGroups(collapsedGroups.size > 0 ? new Set() : new Set(groups.map((group) => group.key)))} style={{ ...inlineActionStyle, marginLeft: 4 }}>
                  {collapsedGroups.size > 0 ? 'すべて開く' : 'すべて折りたたむ'}
                </button>
              )}
              {subGroupMode && visibleSubGroupKeys.length > 1 && (
                <button onClick={toggleAllSubGroups} style={{ ...inlineActionStyle, marginLeft: 4 }}>
                  {subGroupMode === 'category'
                    ? anySubGroupCollapsed ? 'カテゴリをすべて開く' : 'カテゴリをすべて畳む'
                    : anySubGroupCollapsed ? '担当者をすべて開く' : '担当者をすべて畳む'}
                </button>
              )}
            </nav>
          )}
        </div>

        {loadError && (
          <div role="alert" style={{ padding: '10px 14px', border: '1px solid #b91c1c', borderRadius: 10, background: '#450a0a', color: '#fecaca', fontSize: '0.82rem' }}>
            {loadError}
          </div>
        )}

        {!loaded && !loadError && <div style={emptyStyle}>読み込み中…</div>}

        {loaded && groups.length === 0 && (
          <div style={emptyStyle}>
            {effectiveQuickFilter !== 'all'
              ? <>条件に合うタスクはありません。<button onClick={() => setQuickFilter('all')} style={{ ...inlineActionStyle, marginLeft: 8, fontSize: '0.82rem' }}>すべて表示</button></>
              : settingsChips.length > 0
                ? '表示できるタスクがありません。「表示設定」の横に出ている条件も確認してください。'
                : '表示できるタスクがありません。見出しの横の「絞り込み中」も確認してください。'}
          </div>
        )}

        {loaded && groups.map((group) => {
          const groupNeeds = group.rows.filter((row) => needsReport(row.freshness)).length
          const groupReported = group.rows.filter((row) => row.reportedInPeriod).length
          const groupDiscussions = group.rows
            .flatMap((row) => row.discussions)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
          const collapsed = collapsedGroups.has(group.key)
          return (
            <section key={`${effectiveGroupMode}:${group.key}`} id={groupDomId(group.key)} style={{ display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 4 }}>
              <div style={groupHeaderStyle}>
                <button
                  onClick={() => toggleGroupCollapsed(group.key)}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? `${group.label}を開く` : `${group.label}を折りたたむ`}
                  title={collapsed ? '開く' : '折りたたむ'}
                  style={collapseButtonStyle(collapsed)}
                >
                  ▾
                </button>
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: group.color ?? '#475569', flexShrink: 0 }} />
                <span style={{ fontSize: '0.98rem', color: '#f1f5f9', fontWeight: 800 }}>{group.label}</span>
                {group.isMe && <span style={{ fontSize: '0.68rem', color: '#c7d2fe', background: '#312e81', borderRadius: 999, padding: '1px 7px' }}>自分</span>}
                <span style={{ fontSize: '0.76rem', color: '#94a3b8' }}>{group.rows.length}件</span>
                <span style={{ fontSize: '0.76rem', color: '#86efac' }}>報告あり {groupReported}</span>
                <span style={{ fontSize: '0.76rem', color: groupNeeds > 0 ? '#fde68a' : '#64748b', fontWeight: groupNeeds > 0 ? 700 : 400 }}>
                  報告なし {groupNeeds}
                </span>
                {groupDiscussions.length > 0 && (
                  <span style={{ fontSize: '0.76rem', color: '#d6b38a' }}>要相談 {groupDiscussions.length}</span>
                )}
              </div>
              {!collapsed && groupDiscussions.length > 0 && (
                <div style={discussionBoxStyle}>
                  <div style={{ fontSize: '0.76rem', color: '#cbd5e1', fontWeight: 700 }}>
                    要相談（{groupDiscussions.length}件）
                    <span style={{ marginLeft: 8, fontSize: '0.7rem', color: '#64748b', fontWeight: 400 }}>相談が済んだら ⋯ から外します</span>
                  </div>
                  {groupDiscussions.map((note) => (
                    <InteractiveNote key={`discussion-${note.id}`} note={note} actions={actions} showTask />
                  ))}
                </div>
              )}
              {!collapsed && !subGroupMode && group.rows.map(renderCard)}
              {!collapsed && subGroupMode && subGroupRows(group.rows, subGroupMode, categories, users).map((subGroup) => {
                const subCollapsed = collapsedSubGroupSet.has(subGroup.key)
                const subNeeds = subGroup.rows.filter((row) => needsReport(row.freshness)).length
                const subDiscussions = subGroup.rows.reduce((sum, row) => sum + row.discussions.length, 0)
                return (
                  <div key={subGroup.key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={subGroupHeaderStyle(subGroup.color)}>
                      <button
                        onClick={() => toggleSubGroupCollapsed(subGroup.key)}
                        aria-expanded={!subCollapsed}
                        aria-label={subCollapsed ? `${group.label}の${subGroup.label}を開く` : `${group.label}の${subGroup.label}を折りたたむ`}
                        title={subCollapsed
                          ? '開く'
                          : `折りたたむ（ほかの${subGroupMode === 'category' ? '担当者' : 'カテゴリ'}の「${subGroup.label}」も一緒に畳み、次に開いたときも畳んだままにします）`}
                        style={collapseButtonStyle(subCollapsed)}
                      >
                        ▾
                      </button>
                      <span style={{ width: 9, height: 9, borderRadius: subGroupMode === 'category' ? 2 : '50%', background: subGroup.color ?? '#475569', flexShrink: 0 }} />
                      <span style={{ fontSize: '0.86rem', color: '#e2e8f0', fontWeight: 800 }}>{subGroup.label}</span>
                      <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>{subGroup.rows.length}件</span>
                      {subNeeds > 0 && <span style={{ fontSize: '0.74rem', color: '#fde68a', fontWeight: 700 }}>報告なし {subNeeds}</span>}
                      {subDiscussions > 0 && <span style={{ fontSize: '0.74rem', color: '#d6b38a' }}>要相談 {subDiscussions}</span>}
                    </div>
                    {!subCollapsed && subGroup.rows.map(renderCard)}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}

interface ReportCardActions {
  canModifyNote: (note: ProgressNote) => boolean
  onCreateNote: (todo: Todo, body: string, needsDiscussion: boolean) => Promise<boolean>
  onUpdateNote: (noteId: string, body: string) => Promise<boolean>
  onDeleteNote: (noteId: string) => void
  onToggleNoteReaction: (noteId: string, emoji: string) => void
  onToggleCommentReaction: (commentId: string, emoji: string) => void
  onReply: (noteId: string, body: string, parentCommentId: string | null) => Promise<boolean>
  onToggleDiscussion: (noteId: string, value: boolean) => void
  onUpdateTask: (todo: Todo, data: UpdateTodoInput, successMessage: string) => Promise<boolean>
  onUpdateSubTask: (subTask: SubTask, data: UpdateSubTaskInput, successMessage: string) => Promise<boolean>
  onCreateSubTask: (todo: Todo, data: CreateSubTaskInput) => Promise<boolean>
  onSelectTodo: (id: string) => void
  /** このタスクを報告に出さない（見ている人の表示設定に入る） */
  onHideTodo: (todo: Todo) => void
  onShowToast: ShowToast
  /** サブタスクの担当の選択肢（デスクトップ版は空） */
  users: PublicUser[]
  /** 進捗ログ・返信で「@」を打ったときの候補（自分を除く） */
  mentionUsers: PublicUser[]
}

/** 報告タブ用に操作をすべて有効にした進捗ログ表示 */
function InteractiveNote({ note, actions, showTask = false }: { note: ProgressNote; actions: ReportCardActions; showTask?: boolean }): React.JSX.Element {
  return (
    <ProgressNoteThread
      note={note}
      showTask={showTask}
      onSelectTodo={actions.onSelectTodo}
      onToggleReaction={actions.onToggleNoteReaction}
      onToggleCommentReaction={actions.onToggleCommentReaction}
      mentionUsers={actions.mentionUsers}
      onReply={actions.onReply}
      onToggleDiscussion={actions.onToggleDiscussion}
      canModify={actions.canModifyNote(note)}
      onUpdate={actions.onUpdateNote}
      onDelete={actions.onDeleteNote}
    />
  )
}

/** サブタスク1行。完了チェック・開始日・期限・進捗率（ドラッグ）をその場で変えられる */
function SubTaskRow({ subTask, summary, actions }: { subTask: SubTask; summary: SubTaskChangeSummary | undefined; actions: ReportCardActions }): React.JSX.Element {
  const [editingStart, setEditingStart] = useState(false)
  const [startDraft, setStartDraft] = useState('')
  const [editingDue, setEditingDue] = useState(false)
  const [dueDraft, setDueDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const done = subTask.done === 1
  const dueColor = done ? '' : getDueDateColor(subTask.due_date)
  const change = subTaskChangeText(subTask, summary)
  const changeColor = summary && summary.progressStart !== null
    ? progressDeltaColor(summary, subTask.progress)
    : summary && summary.postponedCount > 0 ? '#fde68a' : '#93c5fd'

  const run = async (data: UpdateSubTaskInput, successMessage: string): Promise<boolean> => {
    setSaving(true)
    const ok = await actions.onUpdateSubTask(subTask, data, successMessage)
    setSaving(false)
    return ok
  }

  const openDueEditor = (): void => {
    setEditingStart(false)
    setDueDraft(subTask.due_date?.slice(0, 10) ?? '')
    setEditingDue(true)
  }

  const openStartEditor = (): void => {
    setEditingDue(false)
    setStartDraft(subTask.start_date?.slice(0, 10) ?? '')
    setEditingStart(true)
  }

  const saveStart = async (): Promise<void> => {
    if (saving) return
    const next = startDraft || null
    if (next && subTask.due_date && next > subTask.due_date.slice(0, 10)) {
      actions.onShowToast('サブタスクの開始日は期限以前にしてください', 'error')
      return
    }
    if (next === (subTask.start_date?.slice(0, 10) ?? null)) {
      setEditingStart(false)
      return
    }
    if (await run({ start_date: next }, 'サブタスクの開始日を更新しました')) setEditingStart(false)
  }

  const saveDue = async (): Promise<void> => {
    if (saving) return
    const next = dueDraft || null
    if (next && subTask.start_date && subTask.start_date.slice(0, 10) > next) {
      actions.onShowToast('サブタスクの開始日は期限以前にしてください', 'error')
      return
    }
    if (next === (subTask.due_date?.slice(0, 10) ?? null)) {
      setEditingDue(false)
      return
    }
    if (await run({ due_date: next }, 'サブタスクの期限を更新しました')) setEditingDue(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <label style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: '0.78rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={done}
          disabled={saving}
          onChange={(event) => void run(
            { done: event.target.checked },
            event.target.checked ? 'サブタスクを完了にしました' : 'サブタスクを未完了に戻しました'
          )}
          style={{ accentColor: '#22c55e', cursor: 'pointer', flexShrink: 0, margin: 0, transform: 'translateY(1px)' }}
        />
        <span style={{ flex: 1, minWidth: 0, color: done ? '#64748b' : '#cbd5e1', textDecoration: done ? 'line-through' : 'none', wordBreak: 'break-word' }}>
          {subTask.title}
          {subTask.assignee_name && (
            <span style={{ marginLeft: 6, fontSize: '0.7rem', color: subTask.assignee_color ?? '#94a3b8', display: 'inline-block' }}>
              {subTask.assignee_name}
            </span>
          )}
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 20, minHeight: 22, flexWrap: 'wrap' }}>
        {editingStart ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <input
              type="date"
              value={startDraft}
              onChange={(event) => setStartDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveStart()
                if (event.key === 'Escape') setEditingStart(false)
              }}
              aria-label={`${subTask.title}の開始日`}
              autoFocus
              disabled={saving}
              style={{ ...inputStyle, padding: '2px 6px', fontSize: '0.72rem' }}
            />
            <button onClick={() => void saveStart()} disabled={saving} style={{ ...inlineActionStyle, color: '#93c5fd' }}>保存</button>
            <button onClick={() => setEditingStart(false)} style={inlineActionStyle}>取消</button>
          </div>
        ) : (
          <button
            onClick={openStartEditor}
            disabled={saving}
            title="開始日を変更"
            style={{ ...inlineActionStyle, textDecoration: 'none', color: '#64748b', flexShrink: 0 }}
          >
            {subTask.start_date ? `開始 ${formatShortDate(subTask.start_date)}` : '開始日なし'}
          </button>
        )}
        {editingDue ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <input
              type="date"
              value={dueDraft}
              onChange={(event) => setDueDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveDue()
                if (event.key === 'Escape') setEditingDue(false)
              }}
              aria-label={`${subTask.title}の期限`}
              autoFocus
              style={{ ...inputStyle, padding: '2px 6px', fontSize: '0.72rem' }}
            />
            <button onClick={() => void saveDue()} disabled={saving} style={{ ...inlineActionStyle, color: '#93c5fd' }}>保存</button>
            <button onClick={() => setEditingDue(false)} style={inlineActionStyle}>取消</button>
          </div>
        ) : (
          <button
            onClick={openDueEditor}
            disabled={saving}
            title="期限を変更"
            style={{ ...inlineActionStyle, textDecoration: 'none', color: dueColor || '#64748b', fontWeight: dueColor ? 800 : 600, flexShrink: 0 }}
          >
            {subTask.due_date ? `期限 ${formatShortDate(subTask.due_date)}` : '期限なし'}
          </button>
        )}
        <ProgressSlider
          value={subTask.progress}
          height={5}
          valueMinWidth={34}
          label={`${subTask.title}の進捗率`}
          onCommit={(progress) => run({ progress }, `サブタスクの進捗を${progress}%に更新しました`)}
        />
      </div>
      {change && (
        <div style={{ paddingLeft: 20, fontSize: '0.68rem', color: changeColor }}>{change}</div>
      )}
    </div>
  )
}

/** サブタスクの追加欄。追加後も開いたままにして、続けて入力できるようにする */
function AddSubTaskForm({ todo, actions }: { todo: Todo; actions: ReportCardActions }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [startDate, setStartDate] = useState(() => toDateKey(new Date()))
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)
  const activeUsers = actions.users.filter((user) => user.is_active === 1)
  const canSave = !saving && title.trim().length > 0

  const openForm = (): void => {
    setTitle('')
    // 担当の初期値は親タスクの主担当（いなければ未割り当て）
    setAssigneeId(todo.assignee_id ?? '')
    setStartDate(toDateKey(new Date()))
    setDueDate('')
    setOpen(true)
  }

  const submit = async (): Promise<void> => {
    if (!canSave) return
    if (startDate && dueDate && startDate > dueDate) {
      actions.onShowToast('サブタスクの開始日は期限以前にしてください', 'error')
      return
    }
    setSaving(true)
    const ok = await actions.onCreateSubTask(todo, {
      title: title.trim(),
      assignee_id: assigneeId || null,
      start_date: startDate || null,
      due_date: dueDate || null
    })
    setSaving(false)
    if (ok) {
      setTitle('')
      setStartDate(toDateKey(new Date()))
      setDueDate('')
    }
  }

  if (!open) {
    return (
      <button onClick={openForm} style={{ ...inlineActionStyle, textDecoration: 'none', alignSelf: 'flex-start', color: '#64748b' }}>
        ＋ サブタスクを追加
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: '#111827', border: '1px solid #334155', borderRadius: 8, padding: 8 }}>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          // 日本語入力の確定の Enter では追加しない
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
          if (event.key === 'Escape') setOpen(false)
        }}
        placeholder="サブタスク名（Enterで追加）"
        aria-label="追加するサブタスク名"
        autoFocus
        style={{ ...inputStyle, width: '100%' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {activeUsers.length > 0 && (
          <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} aria-label="追加するサブタスクの担当" style={inputStyle}>
            <option value="">担当なし</option>
            {activeUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
          </select>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.74rem', color: '#94a3b8' }}>
          開始日
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="追加するサブタスクの開始日" style={inputStyle} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.74rem', color: '#94a3b8' }}>
          期限
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="追加するサブタスクの期限" style={inputStyle} />
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => setOpen(false)} style={secondaryButtonStyle}>閉じる</button>
          <button onClick={() => void submit()} disabled={!canSave} style={primaryButtonStyle(canSave)}>{saving ? '追加中…' : '追加'}</button>
        </div>
      </div>
    </div>
  )
}

/** ToDoリストの項目の、期間中の実施状況（繰り返しの項目は何回チェックしたか、やることは残りと済んだもの） */
function ListItemsSummary({ row, period }: { row: ReportRow; period: DateRange }): React.JSX.Element {
  const items = splitListItems(row, period)
  const labelStyle: React.CSSProperties = { fontSize: '0.7rem', color: '#64748b' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2, paddingTop: 8, borderTop: '1px dashed #1e293b' }}>
      {row.subTasks.length === 0 && <div style={labelStyle}>まだ項目がありません</div>}
      {items.repeat.length > 0 && <div style={labelStyle}>繰り返しの項目（期間中にチェックした回数）</div>}
      {items.repeat.map((item) => {
        const summary = row.checkSummaries.get(item.id)
        const count = checkCountText(summary)
        const tone = !summary || summary.periods === 0
          ? '#64748b'
          : summary.checked >= summary.periods ? '#86efac' : summary.checked === 0 ? '#fca5a5' : '#fde68a'
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: '0.78rem' }}>
            <span style={{ flex: 1, minWidth: 0, color: '#cbd5e1', overflowWrap: 'anywhere' }}>{item.title}</span>
            <span style={{ fontSize: '0.68rem', color: '#a5b4fc', flexShrink: 0 }}>{repeatLabel(item)}</span>
            <span
              title={summary ? `期間に重なる周期 ${summary.periods}回のうち ${summary.checked}回チェック（今日の分も含みます）` : undefined}
              style={{ color: tone, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 44, textAlign: 'right' }}
            >
              {count ?? '—'}
            </span>
          </div>
        )
      })}
      {items.open.length > 0 && <div style={{ ...labelStyle, marginTop: 4 }}>まだのやること {items.open.length}件</div>}
      {items.open.map((item) => {
        const dueColor = getDueDateColor(item.due_date)
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: '0.78rem' }}>
            <span style={{ flex: 1, minWidth: 0, color: '#cbd5e1', overflowWrap: 'anywhere' }}>☐ {item.title}</span>
            {item.due_date && <span style={{ fontSize: '0.7rem', color: dueColor || '#64748b', fontWeight: dueColor ? 700 : 400, flexShrink: 0 }}>{formatShortDate(item.due_date)}まで</span>}
          </div>
        )
      })}
      {items.doneInPeriod.length > 0 && (
        <div style={{ ...labelStyle, marginTop: 4 }}>
          期間中に済んだやること {items.doneInPeriod.length}件: <span style={{ color: '#94a3b8' }}>{items.doneInPeriod.map((item) => item.title).join('、')}</span>
        </div>
      )}
    </div>
  )
}

function ReportTaskCard({
  row,
  periodFrom,
  periodTo,
  groupMode,
  subGroupMode,
  subTaskMode,
  showAssignee,
  multiUser,
  isMine,
  onSelectTodo,
  actions
}: {
  row: ReportRow
  periodFrom: string
  periodTo: string
  groupMode: GroupMode
  subGroupMode: SubGroupMode | null
  subTaskMode: ReportSubTaskMode
  showAssignee: boolean
  multiUser: boolean
  isMine: boolean
  onSelectTodo: (id: string) => void
  actions: ReportCardActions
}): React.JSX.Element {
  const { todo, subTasks, notes, lastReportAt, lastMemoAt, freshness } = row
  const { visible: visibleSubTasks, folded: foldedSubTasks, foldedLabel } = splitSubTasks(subTasks, subTaskMode, periodFrom)
  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftNeedsDiscussion, setDraftNeedsDiscussion] = useState(false)
  const [posting, setPosting] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [startDraft, setStartDraft] = useState('')
  const [dueDraft, setDueDraft] = useState('')
  const [editingMemo, setEditingMemo] = useState(false)
  const [memoDraft, setMemoDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const tone = freshnessTone(freshness)
  const dueColor = todo.status === 'done' ? '' : getDueDateColor(todo.due_date)
  const dueLabel = formatDueLabel(todo.due_date, todo.status)
  const hold = getOnHoldInfo(todo.on_hold_since)
  const memo = todo.memo.trim()
  // ToDoリストは進捗率と期限を使わないので、切り替える前の変化も出さない
  const progressDelta = todo.list_mode ? null : progressDeltaText(row, row.todo.progress)
  const dueChange = todo.list_mode ? null : dueChangeText(row, row.todo.due_date)
  const canPost = !posting && draft.trim().length > 0
  const memoChanged = memoDraft !== todo.memo

  const submitNote = async (): Promise<void> => {
    if (!canPost) return
    setPosting(true)
    const ok = await actions.onCreateNote(todo, draft, draftNeedsDiscussion)
    setPosting(false)
    if (ok) {
      setDraft('')
      setDraftNeedsDiscussion(false)
      setComposerOpen(false)
    }
  }

  const updateField = async (data: UpdateTodoInput, successMessage: string): Promise<boolean> => {
    setSaving(true)
    const ok = await actions.onUpdateTask(todo, data, successMessage)
    setSaving(false)
    return ok
  }

  const openScheduleEditor = (): void => {
    setStartDraft(todo.start_date?.slice(0, 10) ?? '')
    setDueDraft(todo.due_date?.slice(0, 10) ?? '')
    setEditingSchedule(true)
  }

  const saveSchedule = async (): Promise<void> => {
    if (startDraft && dueDraft && startDraft > dueDraft) {
      actions.onShowToast('開始日は期限より前にしてください', 'error')
      return
    }
    const data: UpdateTodoInput = {}
    const nextStart = startDraft || null
    const nextDue = dueDraft || null
    if (nextStart !== (todo.start_date?.slice(0, 10) ?? null)) data.start_date = nextStart
    if (nextDue !== (todo.due_date?.slice(0, 10) ?? null)) data.due_date = nextDue
    if (Object.keys(data).length === 0) {
      setEditingSchedule(false)
      return
    }
    if (await updateField(data, '日程を更新しました')) setEditingSchedule(false)
  }

  const openMemoEditor = (): void => {
    setMemoDraft(todo.memo ?? '')
    setEditingMemo(true)
  }

  const saveMemo = async (): Promise<void> => {
    if (saving) return
    if (!memoChanged) {
      setEditingMemo(false)
      return
    }
    if (await updateField({ memo: memoDraft }, 'メモを保存しました')) setEditingMemo(false)
  }

  return (
    <article
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        background: '#0b1220',
        border: '1px solid #1e293b',
        borderLeft: `4px solid ${tone.border}`,
        borderRadius: 12,
        padding: '14px 16px'
      }}
    >
      {/* ─── 左: タスク情報（ステータス・日程・進捗はその場で変更できる） ─── */}
      <div style={{ flex: '1 1 300px', maxWidth: 440, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <button onClick={() => onSelectTodo(todo.id)} title="タスク詳細を開く" style={taskTitleButtonStyle}>
            {todo.title}
          </button>
          {todo.priority >= 4 && (
            <span style={{ fontSize: '0.72rem', color: todo.priority === 5 ? '#ef4444' : '#f59e0b', fontWeight: 800, flexShrink: 0, marginTop: 2 }}>
              {'!'.repeat(todo.priority - 3)}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select
            value={todo.status}
            disabled={saving}
            onChange={(event) => void updateField({ status: event.target.value as TodoStatus }, 'ステータスを更新しました')}
            aria-label="ステータス"
            title="ステータスを変更"
            style={{ ...pillSelectStyle, color: STATUS_COLOR[todo.status], borderColor: `${STATUS_COLOR[todo.status]}80` }}
          >
            <option value="not_started">未着手</option>
            <option value="active">進行中</option><option value="on_hold">保留中</option>
            <option value="done">完了</option>
          </select>
          {groupMode === 'assignee' && subGroupMode !== 'category' ? (
            <span style={{ ...pillStyle, color: todo.category_color ?? '#94a3b8', borderColor: `${todo.category_color ?? '#475569'}80` }}>
              {todo.category_name ?? '未分類'}
            </span>
          ) : null}
          {multiUser && (groupMode !== 'assignee' || showAssignee) && (
            <span style={{ ...pillStyle, color: '#cbd5e1' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: todo.assignee_color ?? '#475569' }} />
              主: {todo.assignee_name ?? '未割り当て'}
            </span>
          )}
          {(todo.co_assignees ?? []).length > 0 && (
            <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
              副: {(todo.co_assignees ?? []).map((assignee) => assignee.display_name).join('、')}
            </span>
          )}
        </div>

        {todo.status === 'on_hold' && (
          <div style={{ background: '#3b0764', border: '1px solid #a855f7', borderRadius: 10, padding: '12px 14px', color: '#e9d5ff', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong style={{ fontSize: '0.92rem' }}>保留中 · {hold.durationLabel}</strong>
            <div style={{ fontSize: '0.8rem' }}>保留開始: {hold.sinceLabel}</div>
            <div style={{ fontSize: '0.74rem', color: '#d8b4fe' }}>作業を停止しています。保留理由や再開の条件をメモに残せます。</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <button onClick={() => void updateField({ status: 'active' }, '進行中に戻しました')} disabled={saving} style={secondaryButtonStyle}>進行中に戻す</button>
              <button onClick={openMemoEditor} style={secondaryButtonStyle}>{memo ? 'メモを編集' : '保留理由をメモする'}</button>
            </div>
          </div>
        )}

        {editingSchedule ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: '#111827', border: '1px solid #334155', borderRadius: 8, padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.76rem', color: '#94a3b8' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                開始
                <input type="date" value={startDraft} onChange={(event) => setStartDraft(event.target.value)} aria-label="開始日" style={inputStyle} />
              </label>
              <span style={{ color: '#475569' }}>→</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                期限
                <input type="date" value={dueDraft} onChange={(event) => setDueDraft(event.target.value)} aria-label="期限" style={inputStyle} />
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.68rem', color: '#64748b', flex: 1 }}>依存関係のある後続タスクも再計算されます</span>
              <button onClick={() => setEditingSchedule(false)} style={secondaryButtonStyle}>キャンセル</button>
              <button onClick={() => void saveSchedule()} disabled={saving} style={primaryButtonStyle(!saving)}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : todo.list_mode ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.8rem' }}>
            <span style={{ color: '#94a3b8' }}>開始 {formatShortDate(todo.start_date)}</span>
            <span style={{ color: '#a5b4fc' }} title="ToDoリストは期限を持たず、終えるまで続きます">→ 期限なしで続く</span>
            <span style={{ color: '#c7d2fe', fontWeight: 700 }}>{checklistBadgeText(summarizeChecklist(subTasks))}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.8rem' }}>
            <span style={{ color: '#94a3b8' }}>開始 {formatShortDate(todo.start_date)}</span>
            <span style={{ color: '#475569' }}>→</span>
            <span style={{ color: dueColor || '#cbd5e1', fontWeight: dueColor ? 700 : 400 }}>期限 {formatShortDate(todo.due_date)}</span>
            {dueLabel && <span style={{ color: dueColor || '#64748b', fontSize: '0.74rem' }}>（{dueLabel}）</span>}
            <button onClick={openScheduleEditor} title="開始日・期限を変更" style={inlineActionStyle}>変更</button>
          </div>
        )}
        {!editingSchedule && dueChange && (
          <div style={{ fontSize: '0.72rem', color: row.postponedCount > 0 ? '#fde68a' : '#94a3b8', fontWeight: row.postponedCount > 0 ? 700 : 400 }}>
            期間中の期限変更: {dueChange}
          </div>
        )}

        {!todo.list_mode && (
          <div>
            <ProgressSlider
              value={todo.progress}
              label={`${todo.title}の進捗率`}
              onCommit={(progress) => updateField({ progress }, `進捗を${progress}%に更新しました`)}
            />
            <div style={{ fontSize: '0.72rem', color: progressDeltaColor(row, row.todo.progress), marginTop: -2 }}>
              {progressDelta ? `期間中 ${progressDelta}` : '期間中の進捗の変更なし'}
            </div>
          </div>
        )}

        {todo.list_mode ? (
          <ListItemsSummary row={row} period={{ from: periodFrom, to: periodTo }} />
        ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, paddingTop: 8, borderTop: '1px dashed #1e293b' }}>
          {subTasks.length > 0 && (
            <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
              サブタスク {subTasks.filter((subTask) => subTask.done).length}/{subTasks.length} 完了
            </div>
          )}
          {visibleSubTasks.map((subTask) => (
            <SubTaskRow key={subTask.id} subTask={subTask} summary={row.subTaskSummaries.get(subTask.id)} actions={actions} />
          ))}
          {foldedSubTasks.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '0.76rem', color: '#94a3b8', padding: '5px 0' }}>
                {foldedLabel}
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 5 }}>
                {foldedSubTasks.map((subTask) => (
                  <SubTaskRow key={subTask.id} subTask={subTask} summary={row.subTaskSummaries.get(subTask.id)} actions={actions} />
                ))}
              </div>
            </details>
          )}
          <AddSubTaskForm todo={todo} actions={actions} />
        </div>
        )}
      </div>

      {/* ─── 右: 報告内容（メモ・進捗ログ） ─── */}
      <div style={{ flex: '2 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.74rem', fontWeight: 700, color: tone.color, background: tone.background, border: `1px solid ${tone.border}`, borderRadius: 999, padding: '2px 9px' }}>
            {freshnessText(row)}
          </span>
          <span style={{ fontSize: '0.74rem', color: '#64748b' }}>
            {lastReportAt ? `最終報告 ${formatDateTime(lastReportAt)}（${formatDaysAgo(lastReportAt)}）` : '最終報告 なし'}
          </span>
          {row.discussions.length > 0 && (
            <span style={discussionBadgeStyle}>要相談 {row.discussions.length}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {!memo && !editingMemo && (
              <button onClick={openMemoEditor} style={reportButtonStyle(false)}>＋ メモを書く</button>
            )}
            {!composerOpen && (
              <button onClick={() => setComposerOpen(true)} style={reportButtonStyle(isMine)}>＋ 進捗を報告</button>
            )}
            <button
              onClick={() => actions.onHideTodo(todo)}
              aria-label={`${todo.title}を報告に出さない`}
              title="このタスクを報告に出さない（自分の表示だけ。表示設定から戻せます）"
              style={{ ...inlineActionStyle, textDecoration: 'none', color: '#64748b', fontWeight: 700, padding: '0 2px' }}
            >
              隠す
            </button>
          </div>
        </div>

        {composerOpen && (
          <div style={{ background: '#111827', border: '1px solid #334155', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <MentionTextarea
              value={draft}
              onValueChange={setDraft}
              users={actions.mentionUsers}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void submitNote()
                }
              }}
              placeholder="今週やったこと・次にやること・困っていることなど（@で名前を呼ぶと通知・Ctrl+Enterで投稿）"
              rows={3}
              autoFocus
              aria-label="進捗ログ"
              style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.55, minHeight: 72 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
              <label style={{ ...checkboxLabelStyle, marginRight: 'auto', color: draftNeedsDiscussion ? '#d6b38a' : '#94a3b8' }}>
                <input type="checkbox" checked={draftNeedsDiscussion} onChange={(event) => setDraftNeedsDiscussion(event.target.checked)} style={{ accentColor: '#6366f1' }} />
                要相談として投稿（定例で話したいこと）
              </label>
              <button onClick={() => { setComposerOpen(false); setDraft(''); setDraftNeedsDiscussion(false) }} style={secondaryButtonStyle}>キャンセル</button>
              <button onClick={() => void submitNote()} disabled={!canPost} style={primaryButtonStyle(canPost)}>
                {posting ? '投稿中…' : '投稿'}
              </button>
            </div>
          </div>
        )}

        {editingMemo ? (
          <div style={{ background: '#111827', border: '1px solid #334155', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: '0.7rem', color: '#64748b' }}>メモ（現状・次にやること・引き継ぎなど。上書き保存）</div>
            <textarea
              value={memoDraft}
              onChange={(event) => setMemoDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void saveMemo()
                }
              }}
              rows={Math.min(12, Math.max(3, memoDraft.split('\n').length + 1))}
              autoFocus
              aria-label="メモ"
              style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.55 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.7rem', color: memoChanged ? '#93c5fd' : '#64748b', flex: 1 }}>
                {memoChanged ? '未保存の変更があります（Ctrl+Enterで保存）' : '変更なし'}
              </span>
              <button onClick={() => setEditingMemo(false)} style={secondaryButtonStyle}>キャンセル</button>
              <button onClick={() => void saveMemo()} disabled={saving || !memoChanged} style={primaryButtonStyle(!saving && memoChanged)}>
                {saving ? '保存中…' : 'メモを保存'}
              </button>
            </div>
          </div>
        ) : memo ? (
          <div style={{ background: '#111827', border: '1px dashed #334155', borderRadius: 10, padding: '8px 11px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: '0.7rem', color: '#64748b' }}>メモ{lastMemoAt ? `（更新 ${formatDateTime(lastMemoAt)}）` : ''}</span>
              <button onClick={openMemoEditor} style={{ ...inlineActionStyle, marginLeft: 'auto' }}>編集</button>
            </div>
            <div style={{ fontSize: '0.82rem', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
              <LinkedText text={memo} />
            </div>
          </div>
        ) : null}

        {notes.length === 0 ? (
          <div style={{ fontSize: '0.8rem', color: '#475569', padding: '4px 2px' }}>この期間の進捗ログはありません。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {notes.map((note) => <InteractiveNote key={note.id} note={note} actions={actions} />)}
          </div>
        )}
      </div>
    </article>
  )
}

// ─── スタイル ───────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '6px 9px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 7,
  color: '#e2e8f0',
  fontSize: '0.8rem',
  outline: 'none'
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: 3,
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: 10
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    background: active ? '#2563eb' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 7,
    color: active ? '#eff6ff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '6px 11px',
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 7,
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.78rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

function primaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    background: enabled ? '#2563eb' : '#1e293b',
    border: `1px solid ${enabled ? '#1d4ed8' : '#334155'}`,
    borderRadius: 7,
    color: enabled ? '#eff6ff' : '#64748b',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

function reportButtonStyle(emphasized: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    background: emphasized ? '#1e3a8a' : 'transparent',
    border: `1px solid ${emphasized ? '#2563eb' : '#334155'}`,
    borderRadius: 999,
    color: emphasized ? '#dbeafe' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.74rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

function quickFilterChipStyle(color: string, active: boolean, muted: boolean): React.CSSProperties {
  return {
    fontSize: '0.76rem',
    color: muted ? '#475569' : active ? '#0f172a' : color,
    background: active ? color : '#111827',
    border: `1px solid ${active ? color : muted ? '#1f2937' : `${color}55`}`,
    borderRadius: 999,
    padding: '3px 11px',
    fontWeight: 700,
    cursor: muted && !active ? 'default' : 'pointer',
    whiteSpace: 'nowrap'
  }
}

const myReminderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid #a16207',
  background: '#1c1408',
  color: '#fde68a',
  fontSize: '0.8rem'
}

const jumpChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 9px',
  borderRadius: 999,
  border: '1px solid #334155',
  background: '#0b1220',
  color: '#e2e8f0',
  cursor: 'pointer',
  fontSize: '0.74rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

function collapseButtonStyle(collapsed: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    border: '1px solid #334155',
    background: '#111827',
    color: '#94a3b8',
    cursor: 'pointer',
    padding: 0,
    fontSize: '0.8rem',
    lineHeight: 1,
    transform: collapsed ? 'rotate(-90deg)' : 'none',
    transition: 'transform 0.15s ease',
    flexShrink: 0
  }
}

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.78rem',
  color: '#94a3b8',
  cursor: 'pointer'
}

const groupHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  padding: '8px 4px',
  borderBottom: '1px solid #1e293b',
  position: 'sticky',
  top: 0,
  background: '#0f172a',
  zIndex: 1
}

const settingsChipStyle: React.CSSProperties = {
  maxWidth: 260,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid #4f46e5',
  background: '#1e1b4b',
  color: '#c7d2fe',
  cursor: 'pointer',
  fontSize: '0.68rem',
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

// 担当者の中のカテゴリ（カテゴリの中の担当者）の小見出し。大見出しより控えめにし、左の色線で区別する
function subGroupHeaderStyle(color: string | null): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '5px 8px',
    marginLeft: 6,
    borderLeft: `3px solid ${color ?? '#475569'}`,
    borderRadius: 4,
    background: '#0b1220'
  }
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: '0.7rem',
  border: '1px solid #334155',
  borderRadius: 999,
  padding: '1px 8px'
}

const pillSelectStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 999,
  padding: '1px 6px',
  cursor: 'pointer',
  outline: 'none'
}

// 要相談のまとめ枠。ほかのカードと同じ落ち着いた配色にし、左端の細い線だけで区別する
const discussionBoxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: '#0b1220',
  border: '1px solid #1e293b',
  borderLeft: '3px solid #4b3b2c',
  borderRadius: 12,
  padding: '10px 12px'
}

const inlineActionStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 800,
  padding: 0,
  textDecoration: 'underline',
  textUnderlineOffset: 2
}

const taskTitleButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: '#f1f5f9',
  fontSize: '0.95rem',
  fontWeight: 800,
  textAlign: 'left',
  lineHeight: 1.45,
  wordBreak: 'break-word'
}

const emptyStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: '0.86rem',
  padding: '20px 4px'
}
