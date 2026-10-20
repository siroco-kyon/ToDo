import { LinkedText } from './LinkedText'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { dateStamp, downloadCsv, toCsv } from '../lib/csv'
import { diffDaysFromToday, dueStateSuffix, formatShortDate as formatShortDateKey, getDueDateColor, isoToDateKey, toDateKey } from '../lib/dueDate'
import { MentionTextarea } from './MentionTextarea'
import { ON_TRACK_NOTE, ProgressNoteHelpers, cleanProgressNote, withProgressNoteTemplate } from './ProgressNoteHelpers'
import { countPostponements } from '../lib/dueChanges'
import { behindDaysLabel, behindDaysOf, isBehindSchedule, isScheduleTracked, loadScheduleSettings } from '../lib/scheduleHealth'
import { ProgressNoteThread, discussionBadgeStyle } from './ProgressNoteThread'
import { ProgressSlider } from './ProgressSlider'
import { ReportSettingsPanel } from './ReportSettingsPanel'
import { MeetingMode, createMeetingState, resumeMeetingState, type MeetingGroup, type MeetingState } from './MeetingMode'
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
import { itemPeriodText, repeatLabel } from '../lib/todoList'
import {
  digestListReport,
  groupSummaryText,
  itemCheckStatus,
  itemStatusText,
  MIN_PERIODS_FOR_RATE,
  rateText,
  splitListItems,
  type ListReportDigest,
  type RepeatGroupDigest
} from '../lib/todoListReport'
import type {
  Category,
  CreateSubTaskInput,
  CreateTodoInput,
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
import { dataInk } from '../lib/theme'
import { confirmAction } from '../lib/confirm'

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
  /** 定例モードで、決まったことをタスクにする */
  onCreateTodo?: (data: CreateTodoInput) => Promise<Todo>
  /** 開いたときに、この人の「報告なし」だけを出す（チームの数字から開いたとき。報告タブの担当の設定は書き換えない） */
  initialUnreportedAssigneeId?: string | null
}

type ShowToast = (message: string, type?: 'success' | 'error', action?: { label: string; run: () => void; key?: string }) => void

interface DateRange {
  from: string
  to: string
}

type PeriodPreset = 'thisWeek' | 'lastWeek' | '7' | '14' | '30' | 'custom'
/** 件数チップを押して絞り込む条件。myNeedsReport は「自分の未報告」の案内から使う */
type QuickFilter = 'all' | 'needsReport' | 'discussion' | 'onHold' | 'overdue' | 'behind' | 'postponed' | 'myNeedsReport'
type GroupMode = 'assignee' | 'category'
type AssigneeFilter = 'all' | 'mine' | 'mineWithSubTasks' | `user:${string}`
/** list: ToDoリスト（中の項目をチェックして使うタスク）。報告の有無では判定しない */
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
  /** 進捗が予定より遅れている日数（ガントの「遅れ」と同じ判定。遅れていない・判定しないときは null） */
  behind: { days: number; expectedProgress: number } | null
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
  not_started: 'var(--slate-500)',
  active: 'var(--blue-500)',
  on_hold: 'var(--purple-400)',
  done: 'var(--green-500)',
  archived: 'var(--slate-600)'
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

// タブを開いているあいだだけ覚えるもの（ほかの画面へ行って戻ったときに続きから見られるように）
const SESSION_KEYS = { quickFilter: 'report.quickFilter', scrollTop: 'report.scrollTop', returnPending: 'report.returnPending' }
const QUICK_FILTERS: readonly QuickFilter[] = ['all', 'needsReport', 'discussion', 'onHold', 'overdue', 'behind', 'postponed', 'myNeedsReport']

function loadSessionQuickFilter(): QuickFilter {
  try {
    const stored = window.sessionStorage.getItem(SESSION_KEYS.quickFilter)
    return QUICK_FILTERS.includes(stored as QuickFilter) ? stored as QuickFilter : 'all'
  } catch {
    return 'all'
  }
}

// 位置を戻すのは、報告タブからタスクを開いて戻ってきたときだけ（タブで開き直したときは先頭から。
// 以前は前回の位置で開き、題名や期間の選択が画面の外に隠れていた）
function loadSessionScrollTop(): number | null {
  try {
    const returning = window.sessionStorage.getItem(SESSION_KEYS.returnPending) === '1'
    window.sessionStorage.removeItem(SESSION_KEYS.returnPending)
    if (!returning) return null
    const stored = Number(window.sessionStorage.getItem(SESSION_KEYS.scrollTop))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}

/** 期間の日数（両端を含む） */
function rangeDays(range: DateRange): number {
  return Math.round((new Date(`${range.to}T00:00:00`).getTime() - new Date(`${range.from}T00:00:00`).getTime()) / 86400000) + 1
}

/** 定例の進み具合を読む。12時間より前に始めたもの（前の定例の残り）は使わない */
const MEETING_KEEP_MS = 12 * 60 * 60 * 1000
function loadMeetingState(key: string): MeetingState | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as MeetingState | null
    if (!parsed || typeof parsed.startedAt !== 'number' || Date.now() - parsed.startedAt > MEETING_KEEP_MS) return null
    if (typeof parsed.notes !== 'object' || typeof parsed.spentSeconds !== 'object' || typeof parsed.createdTasks !== 'object') return null
    // 開いたまま離れた（閉じた時刻がない）ときは、読んだ時刻から止まっていたことにする
    return parsed.pausedAt == null ? { ...parsed, pausedAt: Date.now() } : parsed
  } catch {
    return null
  }
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
    case 'behind': return row.behind != null
    case 'postponed': return row.postponedCount > 0
    case 'myNeedsReport': return currentUserId != null && needsReport(row.freshness) && isMyTask(row.todo, [], currentUserId)
  }
}

function formatShortDate(dateKey: string | null): string {
  return dateKey ? formatShortDateKey(dateKey) : '未設定'
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
  if (diff < 0) return `${Math.abs(diff)}日超過`
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
  checkSummaries: Map<string, SubTaskCheckSummary>,
  behind: ReportRow['behind']
): ReportRow {
  const lastNoteAt = activity?.last_note_at ?? null
  const lastMemoAt = activity?.last_memo_at ?? null
  const lastReportAt = latestIso(lastNoteAt, lastMemoAt)
  // 最終更新だけでは、過去の期間を選んだときに期間中の更新を見落とすので、期間中の変更履歴も見る
  const memoUpdatedInPeriod = (lastMemoAt != null && isInRange(isoToDateKey(lastMemoAt), range))
    || changes.some((change) => change.subtask_id == null && change.field === 'memo')
  // 「報告あり」は担当（主・サブ）の書いた進捗ログで数える。リーダーなどほかの人の書き込みだけでは、本人が報告したことにしない。
  // 担当がいないタスク・デスクトップ版（書いた人の記録がない）は、すべての書き込みを数える
  const memberIds = new Set([todo.assignee_id, ...(todo.co_assignees ?? []).map((item) => item.user_id)].filter((id): id is string => Boolean(id)))
  const memberNotes = memberIds.size === 0 ? notes : notes.filter((note) => note.user_id == null || memberIds.has(note.user_id))

  let freshness: Freshness
  if (todo.status === 'done') {
    freshness = 'done'
  } else if (todo.list_mode) {
    // ToDoリストは日々の項目のチェックで回すもので、進捗ログでの報告は求めない
    freshness = 'list'
  } else if (todo.status === 'on_hold') {
    freshness = 'onHold'
  } else if (memberNotes.length > 0 || memoUpdatedInPeriod) {
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

  return { todo, subTasks, notes, lastReportAt, lastMemoAt, freshness, reportedInPeriod: memberNotes.length > 0 || memoUpdatedInPeriod, ...summary, subTaskSummaries, discussions, checkSummaries, behind }
}

function summarizeChanges(changes: TodoChangeEntry[]): ChangeSummary {
  // 期間中の最初の変更の「変更前」が、期間開始時点の値
  const progressChanges = changes.filter((change) => change.field === 'progress')
  const progressStart = progressChanges.length > 0 ? Number(progressChanges[0].old_value ?? 0) : null
  const dueChanges = changes.filter((change) => change.field === 'due_date')
  const postponedCount = countPostponements(dueChanges)
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

/** 名前を数件だけ並べ、残りは件数にする */
function namesText(names: string[], limit: number): string {
  return names.length <= limit ? names.join('、') : `${names.slice(0, limit).join('、')} ほか${names.length - limit}件`
}

/** 報告用の ToDoリストの要約（数え方は lib/todoListReport.ts） */
function digestRow(row: ReportRow, period: DateRange): ListReportDigest {
  return digestListReport(row.subTasks, row.checkSummaries, period)
}

/** 取りこぼした繰り返しの項目の表記。終わった回がなければ null */
function missedText(digest: ListReportDigest, limit: number): string | null {
  if (!digest.groups.some((group) => group.periods > 0)) return null
  return digest.missed.length > 0
    ? `取りこぼし: ${namesText(digest.missed.map(({ item, checked, periods }) => `${item.title} ${checked}/${periods}回`), limit)}`
    : '取りこぼしなし'
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
      // 担当でない人（リーダーなど）の書き込みだけがあるときは、そう書く（「最終報告」の日付と食い違って見えないように）
      return row.notes.length > 0 ? '担当者の報告なし（ほかの人の書き込みだけ）' : '期間内の報告なし'
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
  if (freshness === 'onHold') return { color: 'var(--purple-200)', background: 'var(--purple-950)', border: 'var(--purple-500)' }
  if (freshness === 'fresh') return { color: 'var(--green-300)', background: 'var(--green-950)', border: 'var(--green-800)' }
  if (freshness === 'quiet') return { color: 'var(--amber-200)', background: 'var(--yellow-950)', border: 'var(--yellow-700)' }
  if (freshness === 'stale' || freshness === 'none') return { color: 'var(--red-200)', background: 'var(--red-950)', border: 'var(--red-700)' }
  if (freshness === 'done') return { color: 'var(--green-200)', background: 'var(--slate-900)', border: 'var(--slate-700)' }
  if (freshness === 'list') return { color: 'var(--indigo-200)', background: 'var(--indigo-950)', border: 'var(--indigo-700)' }
  return { color: 'var(--slate-400)', background: 'var(--slate-900)', border: 'var(--slate-700)' }
}

/** 状態と鮮度をまとめた表記。完了・未着手は状態だけで意味が伝わるので重ねない */
function statusSummary(row: ReportRow, separator: string): string {
  const status = STATUS_LABEL[row.todo.status]
  // ToDoリストの実施状況は別の行に出す（一覧の「今回 3/5」は今の回だけの数で、期間の報告と紛らわしいため使わない）
  if (row.freshness === 'list') return 'ToDoリスト'
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
  if (summary.progressStart === null) return 'var(--text-subtle)'
  const delta = current - summary.progressStart
  if (delta > 0) return 'var(--green-300)'
  if (delta < 0) return 'var(--red-300)'
  return 'var(--slate-400)'
}

/** 期間中の期限の変更。変更がなければ null */
function dueChangeText(summary: ChangeSummary): string | null {
  if (summary.dueChanges.length === 0) return null
  // 期間の始めと終わりの期限。終わりは今の期限ではなく、期間中の最後の変更の値
  // （過去の期間を選んだとき、その後の変更と混ぜないため）
  const first = summary.dueChanges[0].old_value
  const end = summary.dueChanges[summary.dueChanges.length - 1].new_value
  const route = `${formatShortDate(first)} → ${formatShortDate(end)}`
  if (summary.postponedCount > 0) return `延期${summary.postponedCount}回（${route}）`
  // 入れてから外した・変えてから戻したなど、期間の始めと同じ期限に戻っているなら出さない
  if ((first?.slice(0, 10) ?? null) === (end?.slice(0, 10) ?? null)) return null
  if (first && end && end.slice(0, 10) < first.slice(0, 10)) return `前倒し（${route}）`
  if (!first && end) return `期限を設定（${formatShortDate(end)}）`
  if (first && !end) return `期限を外した（${formatShortDate(first)} → なし）`
  return `期限を変更（${route}）`
}

/** サブタスクの期間中の変化（追加・進捗・期限）。何もなければ null */
function subTaskChangeText(subTask: SubTask, summary: SubTaskChangeSummary | undefined): string | null {
  if (!summary) return null
  const parts: string[] = []
  if (summary.addedInPeriod) parts.push('期間中に追加')
  const delta = progressDeltaText(summary, subTask.progress)
  if (delta) parts.push(`期間中 ${delta}`)
  const due = dueChangeText(summary)
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
  lines.push(todo.list_mode && !todo.due_date
    ? `- 期間: 開始 ${todo.start_date?.slice(0, 10) ?? '未設定'}・期限なし`
    : `- 期間: 開始 ${todo.start_date?.slice(0, 10) ?? '未設定'} / 期限 ${todo.due_date?.slice(0, 10) ?? '未設定'}`)
  const delta = todo.list_mode ? null : progressDeltaText(row, row.todo.progress)
  if (delta) lines.push(`- 期間中の進捗: ${delta}`)
  const dueChange = dueChangeText(row)
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
    // 繰り返しの項目は周期ごとに1行にまとめ、取りこぼしたものだけ名前を出す（全部並べると長くなりすぎるため）
    const digest = digestRow(row, options.period)
    for (const group of digest.groups) lines.push(`- ${group.label}の項目 ${group.itemCount}件: ${groupSummaryText(group)}`)
    const missed = missedText(digest, 3)
    if (missed) lines.push(`- ${missed}`)
    if (digest.open.length > 0 || digest.doneInPeriod.length > 0) {
      const parts: string[] = []
      if (digest.overdue.length > 0) parts.push(`期限切れ ${digest.overdue.length}件（${namesText(digest.overdue.map((item) => item.title), 3)}）`)
      parts.push(`まだ ${digest.open.length}件`)
      if (digest.doneInPeriod.length > 0) parts.push(`期間中に済んだ ${digest.doneInPeriod.length}件（${namesText(digest.doneInPeriod.map((item) => item.title), 5)}）`)
      lines.push(`- やること: ${parts.join('・')}`)
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

/** CSV の「期間中の進捗」欄に入れる ToDoリストの実施状況（周期ごと） */
function listProgressText(row: ReportRow, period: DateRange): string {
  return digestRow(row, period).groups.map((group) => `${group.label}: ${groupSummaryText(group)}`).join(' / ')
}

function reportToCsv(groups: ReportGroup[], subTaskMode: ReportSubTaskMode, period: DateRange): string {
  const headers = ['担当', 'カテゴリ', 'タスク', 'サブタスク', '状態', '保留開始', '保留期間', '開始', '期限', '進捗(%)', '期間中の進捗', '期限の変更', '最終報告', '要相談', '期間内の進捗ログ', 'メモ']
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
        todo.list_mode ? listProgressText(row, period) : progressDeltaText(row, row.todo.progress) ?? '',
        dueChangeText(row) ?? '',
        row.lastReportAt ? formatDateTime(row.lastReportAt) : '',
        row.discussions.length > 0 ? `${row.discussions.length}件` : '',
        notesToPlainText(row.notes),
        todo.memo.trim()
      ])
      if (todo.list_mode) {
        const items = splitListItems(row.subTasks, period)
        for (const item of [...items.repeat, ...items.open, ...items.doneInPeriod]) {
          rows.push([
            item.assignee_name ?? '',
            todo.category_name ?? '未分類',
            todo.title,
            item.title,
            item.recurrence
              ? `${repeatLabel(item) ?? ''} ${itemStatusText(itemCheckStatus(item, row.checkSummaries.get(item.id))) ?? '期間中の対象なし'}`
              : item.done ? '済み' : 'まだ',
            '', '',
            item.start_date?.slice(0, 10) ?? '',
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
          summary ? dueChangeText(summary) ?? '' : '',
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

export function ReportView({ todos, subTasks, categories, users, currentUser, onSelectTodo, onUpdateTodo, onUpdateSubTask, onCreateSubTask, onShowToast, listFilters, onCreateTodo, initialUnreportedAssigneeId = null }: Props): React.JSX.Element {
  const multiUser = users.length > 0
  const settingsUserId = currentUser?.id ?? null
  const [preset, setPreset] = useState<PeriodPreset>(loadPreset)
  const [range, setRange] = useState<DateRange>(() => presetRange(loadPreset()))
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readStorage(STORAGE_KEYS.groupMode) === 'category' ? 'category' : 'assignee')
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>(() => initialUnreportedAssigneeId ? `user:${initialUnreportedAssigneeId}` : loadAssigneeFilter())
  const [excludeCoAssigned, setExcludeCoAssigned] = useState(() => readStorage(STORAGE_KEYS.excludeCoAssigned) === '1')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(() => initialUnreportedAssigneeId ? 'needsReport' : loadSessionQuickFilter())
  // この画面を開いてから進捗ログを書いたタスク（「報告なし」で絞っていても、書いた直後は残す）
  const [reportedNowIds, setReportedNowIds] = useState<Set<string>>(() => new Set())
  const quickFilterFromTeamRef = useRef(initialUnreportedAssigneeId != null)
  useEffect(() => {
    // チームの数字から開いたときの「報告なし」はその場だけ。自分で選び直すまでは覚えない
    if (quickFilterFromTeamRef.current) {
      if (quickFilter === 'needsReport') return
      quickFilterFromTeamRef.current = false
    }
    try { window.sessionStorage.setItem(SESSION_KEYS.quickFilter, quickFilter) } catch { /* 覚えられなくても絞り込みはできる */ }
  }, [quickFilter])
  // 読み込み直したときに、前に見ていた位置へ戻す（タスクを開いて報告タブへ戻ったとき）
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const lastScrollTopRef = useRef(0)
  const scrollRestoreRef = useRef<number | null>(loadSessionScrollTop())
  // 本文の幅が狭いとき（1024px・大きい文字）は、見出しの操作を畳む
  const [compactHeader, setCompactHeader] = useState(false)
  const [headerExpanded, setHeaderExpanded] = useState(false)
  useEffect(() => {
    const element = scrollContainerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = (): void => {
      const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      // 文字の大きさで割った幅（100% のときの幅に直す）で決める
      // 1440px で一覧を出しているくらいの幅（1100px 未満）でも畳む。操作が多く、毎週の定例で中身まで遠かった
      setCompactHeader(element.clientWidth / (rootFont / 16) < 1100)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // タスクを開くときは、戻ってきたら今の位置へ戻せるよう印を付ける
  const openTodoFromReport = useCallback((id: string): void => {
    try { window.sessionStorage.setItem(SESSION_KEYS.returnPending, '1') } catch { /* 位置は戻せなくてもよい */ }
    onSelectTodo(id)
  }, [onSelectTodo])
  // 画面を離れるとき（DOM が消える前）に位置を覚える
  useLayoutEffect(() => () => {
    const top = scrollContainerRef.current?.scrollTop ?? lastScrollTopRef.current
    try { window.sessionStorage.setItem(SESSION_KEYS.scrollTop, String(top)) } catch { /* 位置は覚えなくてもよい */ }
  }, [])
  // 表示設定（カテゴリ・状態・対象・サブタスク・個別に隠したタスク・小見出し）。見ている人ごとに保存する
  const [settingsState, setSettingsState] = useState(() => ({ userId: settingsUserId, settings: loadReportViewSettings(settingsUserId) }))
  const settings = settingsState.userId === settingsUserId ? settingsState.settings : loadReportViewSettings(settingsUserId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [customDatesOpen, setCustomDatesOpen] = useState(false)
  // 定例モード（担当者を1人ずつ大きく表示する）。閉じても、この画面を開いている間は進み具合を残す
  const [meetingOpen, setMeetingOpen] = useState(false)
  // 定例の進み具合（メモ・決まったこと・持ち時間）は、ほかの画面を見に行っても消えないよう端末に覚える（見ている人ごと）
  // 読み込み直した直後はログイン中の人がまだ分からず、保存先が変わる。保存先が変わったら、その人の進み具合を読み直す
  // （以前は空の状態のまま新しい保存先に書いてしまい、再読み込みで定例の途中経過が消えていた）
  const meetingStorageKey = `report.meeting:${settingsUserId ?? 'local'}`
  const [meetingStore, setMeetingStore] = useState<{ key: string; state: MeetingState | null }>(() => ({ key: meetingStorageKey, state: loadMeetingState(meetingStorageKey) }))
  if (meetingStore.key !== meetingStorageKey) setMeetingStore({ key: meetingStorageKey, state: loadMeetingState(meetingStorageKey) })
  const meetingState = meetingStore.key === meetingStorageKey ? meetingStore.state : null
  const setMeetingState = useCallback((next: MeetingState | null | ((previous: MeetingState | null) => MeetingState | null)): void => {
    setMeetingStore((previous) => ({ key: previous.key, state: typeof next === 'function' ? next(previous.state) : next }))
  }, [])
  useEffect(() => {
    try {
      if (meetingState) window.localStorage.setItem(meetingStorageKey, JSON.stringify(meetingState))
      else window.localStorage.removeItem(meetingStorageKey)
    } catch { /* 覚えられなくても定例は続けられる */ }
  }, [meetingState, meetingStorageKey])
  // 定例モードを開いたままほかの画面へ移ったときは、その時刻を「閉じた時刻」として覚え、戻ったときに離れていた時間を除く
  const meetingStateRef = useRef(meetingState)
  meetingStateRef.current = meetingState
  useEffect(() => () => {
    const state = meetingStateRef.current
    if (!state || state.pausedAt != null) return
    try { window.localStorage.setItem(meetingStorageKey, JSON.stringify({ ...state, pausedAt: Date.now() })) } catch { /* 覚えられなくてもよい */ }
  }, [meetingStorageKey])
  // 折りたたんだ担当者（カテゴリ）の見出しキー。定例で話し終えた人を畳んでおける
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [notes, setNotes] = useState<ProgressNote[]>([])
  const [activity, setActivity] = useState<Map<string, TodoReportActivity>>(() => new Map())
  const [changes, setChanges] = useState<TodoChangeEntry[]>([])
  const [discussions, setDiscussions] = useState<ProgressNote[]>([])
  const [checkSummaries, setCheckSummaries] = useState<SubTaskCheckSummary[]>([])
  const [hasLoaded, setLoaded] = useState(false)
  const [loadedRangeKey, setLoadedRangeKey] = useState('')
  const loaded = hasLoaded && loadedRangeKey === `${range.from}|${range.to}`
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
      setLoadedRangeKey(`${range.from}|${range.to}`)
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
    if (!loaded || scrollRestoreRef.current == null) return
    const top = scrollRestoreRef.current
    scrollRestoreRef.current = null
    lastScrollTopRef.current = top
    // 読み込んだ内容はこの時点で描かれているので、そのまま位置を戻す
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = top
  }, [loaded])

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

  // 進捗の遅れ（ガントの表示設定の「遅れとみなす日数」「土日・祝日を数えない」に合わせる）
  const [scheduleSettings] = useState(loadScheduleSettings)
  const [holidayNames, setHolidayNames] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    if (!scheduleSettings.workingDaysOnly) return
    let cancelled = false
    void import('@holiday-jp/holiday_jp')
      .then((module) => {
        const library = ((module as { default?: unknown }).default ?? module) as { holidays: Record<string, { name: string }> }
        if (!cancelled) setHolidayNames(new Map(Object.entries(library.holidays).map(([date, holiday]) => [date, holiday.name])))
      })
      .catch(() => { /* 祝日が読めなくても土日だけ除いて数える */ })
    return () => { cancelled = true }
  }, [scheduleSettings.workingDaysOnly])
  const todayKey = toDateKey(new Date())
  const behindOf = useCallback((todo: Todo): ReportRow['behind'] => {
    // 期限を過ぎたものは「期限超過」で出すので、ここでは期限前のものだけ
    if (!isScheduleTracked(todo) || !todo.start_date || !todo.due_date) return null
    const bar = { startDate: todo.start_date.slice(0, 10), endDate: todo.due_date.slice(0, 10) }
    if (bar.endDate < bar.startDate || todayKey > bar.endDate) return null
    const { behindDays, expectedProgress } = behindDaysOf(todo.progress, bar, todayKey, { ...scheduleSettings, holidayNames })
    return isBehindSchedule(expectedProgress, todo.progress, behindDays, scheduleSettings.behindThresholdDays) ? { days: behindDays, expectedProgress } : null
  }, [holidayNames, scheduleSettings, todayKey])

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
      checkSummariesByTodo.get(todo.id) ?? new Map(),
      behindOf(todo)
    ))
    .filter((row) => matchesScopeSetting(row, settings.scope, range)),
  [activity, behindOf, changesByTodo, checkSummariesByTodo, discussionsByTodo, effectiveAssigneeFilter, excludeCoAssigned, hiddenCategoryKeySet, hiddenTodoIdSet, notesByTodo, range, selectedUserId, settings.scope, settings.statuses, subTasksByTodo, todos])

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
    // 「報告なし」で絞っているあいだに書いたタスクは、すぐに消さず残す（書いた内容を確かめ・直せるように）
    .filter((row) => matchesQuickFilter(row, effectiveQuickFilter, currentUserId)
      || ((effectiveQuickFilter === 'needsReport' || effectiveQuickFilter === 'myNeedsReport') && reportedNowIds.has(row.todo.id)))
    // 保留中だけを見るときは、保留が長いものから並べる
    .sort((a, b) => effectiveQuickFilter === 'onHold' ? (a.todo.on_hold_since ?? '9999').localeCompare(b.todo.on_hold_since ?? '9999') : 0),
  [baseRows, currentUserId, effectiveQuickFilter, reportedNowIds])

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
  const myTaskCount = multiUser && currentUserId ? baseRows.filter((row) => isMyTask(row.todo, [], currentUserId)).length : 0
  const quickFilterChips: Array<{ value: QuickFilter; label: string; count: number; color: string; title: string }> = [
    { value: 'all', label: 'すべて', count: baseRows.length, color: 'var(--slate-300)', title: '絞り込まずに表示' },
    { value: 'needsReport', label: '報告なし', count: countOf('needsReport'), color: 'var(--amber-200)', title: '進行中（または開始日を過ぎた未着手）なのに、この期間に担当（主・副）の進捗ログもメモの更新もないタスク。チームタブの「報告なし（直近7日）」は、期間を直近7日にした同じ数え方' },
    { value: 'discussion', label: '要相談', count: countOf('discussion'), color: 'var(--c-d6b38a)', title: '「要相談」が付いた進捗ログがあるタスク（期間に関係なく）' },
    { value: 'onHold', label: '保留中', count: countOf('onHold'), color: 'var(--purple-300)', title: '保留中のタスク（保留が長い順）' },
    { value: 'overdue', label: '期限超過', count: countOf('overdue'), color: 'var(--red-300)', title: '期限を過ぎて完了していないタスク' },
    { value: 'behind', label: '進捗の遅れ', count: countOf('behind'), color: 'var(--amber-200)', title: `期限前だが、今日時点の予定の進捗より${scheduleSettings.behindThresholdDays}日分以上、または半分以上遅れているタスク（ガントの「遅れ」と同じ判定）` },
    { value: 'postponed', label: '期間中に延期', count: countOf('postponed'), color: 'var(--amber-200)', title: 'この期間に期限を後ろへずらしたタスク' }
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
    // スクロールに合わせてフォーカスも移す（キーボードで続けて、その担当者の欄の中を Tab で進めるように）
    window.requestAnimationFrame(() => {
      const section = document.getElementById(groupDomId(key))
      if (!section) return
      section.scrollIntoView({ behavior: 'smooth', block: 'start' })
      section.focus({ preventScroll: true })
    })
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
      setReportedNowIds((previous) => new Set(previous).add(todo.id))
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
    if (!(await confirmAction('この進捗ログを削除しますか？\n付いている返信も一緒に削除されます。元に戻せません。', { confirmLabel: '削除する', danger: true }))) return
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
    // 変える前の値（「元に戻す」で戻す）。詳細・ガントの変更と同じく、報告タブの変更も戻せるようにする
    const previous = Object.fromEntries(Object.keys(data).map((key) => [key, (todo as unknown as Record<string, unknown>)[key] ?? null])) as UpdateTodoInput
    try {
      await onUpdateTodo(todo.id, data)
      // メモは最終報告日時に、進捗・期限は期間中の変化の表示に影響するので取り直す
      await load()
      onShowToast(successMessage, 'success', {
        label: '元に戻す',
        // 同じタスクの同じ項目を続けて変えたときは、知らせを1枚にまとめる
        key: `report:${todo.id}:${Object.keys(data).sort().join(',')}`,
        run: () => {
          void onUpdateTodo(todo.id, previous).then(
            async () => { await load(); onShowToast('元に戻しました') },
            (error: unknown) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
          )
        }
      })
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
    onSelectTodo: openTodoFromReport,
    onHideTodo: (todo) => setTodoHidden(todo, true),
    onShowToast,
    users,
    // 「@」の候補（自分を呼んでも通知は届かないので外す）
    mentionUsers: users.filter((user) => user.id !== currentUser?.id)
  }), [canModifyNote, createNote, createSubTask, currentUser, deleteNote, openTodoFromReport, onShowToast, replyNote, setTodoHidden, toggleDiscussion, toggleReaction, updateNote, updateSubTask, updateTask, users])

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

  const renderCard = (row: ReportRow, inMeeting = false): React.JSX.Element => (
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
      showOnTrackHelper={!inMeeting}
      onSelectTodo={openTodoFromReport}
      actions={actions}
    />
  )

  // 定例モードで見せるまとまりと、その中身（要相談 → タスクのカード）
  const meetingGroups: MeetingGroup[] = groups.map((group) => {
    const needs = group.rows.filter((row) => needsReport(row.freshness)).length
    const discussions = group.rows.reduce((sum, row) => sum + row.discussions.length, 0)
    return {
      key: group.key,
      label: group.label,
      color: group.color,
      summary: [`${group.rows.length}件`, needs > 0 ? `報告なし ${needs}` : null, discussions > 0 ? `要相談 ${discussions}` : null].filter(Boolean).join('・')
    }
  })
  const renderMeetingBody = (groupKey: string): React.ReactNode => {
    const group = groups.find((item) => item.key === groupKey)
    if (!group) return null
    const discussions = group.rows.flatMap((row) => row.discussions).sort((a, b) => b.created_at.localeCompare(a.created_at))
    return (
      <>
        {discussions.length > 0 && (
          <div style={discussionBoxStyle}>
            <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-300)', fontWeight: 700 }}>要相談（{discussions.length}件）</div>
            {discussions.map((note) => <InteractiveNote key={`meeting-discussion-${note.id}`} note={note} actions={actions} showTask />)}
          </div>
        )}
        {group.rows.map((row) => renderCard(row, true))}
      </>
    )
  }
  const meetingTaskInput = (groupKey: string, title: string): CreateTodoInput => effectiveGroupMode === 'assignee'
    ? { title, status: 'not_started', start_date: toDateKey(new Date()), assignee_id: users.some((user) => user.id === groupKey) ? groupKey : null }
    : { title, status: 'not_started', start_date: toDateKey(new Date()), category_id: categories.some((category) => category.id === groupKey) ? groupKey : null, assignee_id: currentUser?.id ?? null }
  const createMeetingTask = onCreateTodo
    ? async (groupKey: string, title: string, dueDate: string | null): Promise<boolean> => {
        try {
          const created = await onCreateTodo({ ...meetingTaskInput(groupKey, title), due_date: dueDate })
          // 間違えて作ったときのために、ほかの操作と同じく「元に戻す」を付ける（消さずにアーカイブする）
          onShowToast(`タスク「${title}」を作りました${dueDate ? `（期限 ${formatShortDate(dueDate)}）` : ''}`, 'success', {
            label: '元に戻す',
            run: () => {
              void window.api.todoArchive(created.id).then(
                () => onShowToast(`タスク「${title}」を取り消しました（アーカイブしました）`),
                (error: unknown) => onShowToast(error instanceof Error ? error.message : '取り消せませんでした', 'error')
              )
            }
          })
          return true
        } catch (error) {
          onShowToast(error instanceof Error ? error.message : 'タスクを作れませんでした', 'error')
          return false
        }
      }
    : undefined
  const meetingTaskHint = (groupKey: string): string => {
    const label = groups.find((group) => group.key === groupKey)?.label ?? ''
    if (effectiveGroupMode === 'assignee') return groupKey ? `担当: ${label}` : '担当: なし'
    return `カテゴリ: ${groupKey ? label : 'なし'}・担当: 自分`
  }
  const openMeeting = (): void => {
    const first = meetingGroups[0]
    setMeetingState((previous) => previous ? resumeMeetingState(previous) : createMeetingState(Date.now(), first ? { key: first.key, label: first.label } : undefined))
    setMeetingOpen(true)
  }

  const handleDownloadCsv = (): void => {
    downloadCsv(`report-${range.from}_${range.to}-${dateStamp()}.csv`, reportToCsv(groups, settings.subTaskMode, range))
  }

  return (
    <div ref={scrollContainerRef} onScroll={(event) => { lastScrollTopRef.current = event.currentTarget.scrollTop }} style={{ height: '100%', overflowY: 'auto', background: 'var(--slate-900)' }}>
      <div style={{ padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
        {/* ─── 見出し・操作 ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: '1.15rem', color: 'var(--slate-50)', fontWeight: 800 }}>報告</div>
            <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)', fontWeight: 700 }}>
              {formatShortDate(range.from)}（{weekdayLabel(range.from)}）～ {formatShortDate(range.to)}（{weekdayLabel(range.to)}）
            </div>
            {listFilters}
            <details style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)' }}>
              <summary style={{ cursor: 'pointer' }}>使い方</summary>
              <p style={{ marginTop: 8, lineHeight: 1.7 }}>定例用に、タスクごとの進捗と報告（進捗ログ・メモ）をまとめます。状態・日程・進捗・メモはその場で変更できます。報告の担当は、この画面の「報告の担当」で選びます。</p>
            </details>
            {compactHeader && (
              // 狭い画面では、期間・まとめ方・報告の担当の切り替えを畳み、本文を上へ寄せる（今の設定は1行で見せる）
              <button
                type="button"
                onClick={() => setHeaderExpanded((open) => !open)}
                aria-expanded={headerExpanded}
                style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}
              >
                {headerExpanded ? '期間・表示を閉じる ▴' : `${[
                  PRESETS.find((item) => item.value === preset)?.label ?? '期間指定',
                  effectiveGroupMode === 'assignee' ? '担当者別' : 'カテゴリ別',
                  // 担当を絞っているときは、畳んでいても誰の分かを見せる（全員分を見ているつもりにならないように）
                  effectiveAssigneeFilter === 'all' ? null
                    : effectiveAssigneeFilter === 'mine' || effectiveAssigneeFilter === 'mineWithSubTasks' ? '自分の担当'
                      : `${users.find((user) => user.id === selectedUserId)?.display_name ?? '選んだ人'}の担当`
                ].filter(Boolean).join('・')}　変える ▾`}
              </button>
            )}
            {compactHeader && !headerExpanded && (
              <button
                onClick={openMeeting}
                disabled={loading || !loaded || Boolean(loadError) || groups.length === 0}
                style={{ ...secondaryButtonStyle, borderColor: 'var(--indigo-600)', color: 'var(--indigo-200)' }}
              >
                {meetingState ? '定例モードに戻る' : '定例モード'}
              </button>
            )}
          </div>

          {(!compactHeader || headerExpanded) && (<>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={groupStyle} role="group" aria-label="報告期間">
              {PRESETS.map((item) => (
                <button key={item.value} onClick={() => applyPreset(item.value)} title={item.title} aria-pressed={preset === item.value} style={chipStyle(preset === item.value)}>
                  {item.label}
                </button>
              ))}
            </div>
            <button onClick={() => setCustomDatesOpen((open) => !open)} aria-expanded={customDatesOpen} aria-controls="report-custom-dates" style={secondaryButtonStyle}>日付を指定</button>
            {customDatesOpen && <div id="report-custom-dates" role="group" aria-label="報告期間の日付指定" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
            <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--font-control)' }}>～</span>
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

            </div>}
            {preset === 'thisWeek' && rangeDays(range) <= 2 && (
              <span role="note" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-control)', color: 'var(--amber-200)', border: '1px solid var(--yellow-700)', background: 'var(--yellow-950)', borderRadius: 999, padding: '3px 4px 3px 10px' }}>
                今週はまだ{rangeDays(range)}日分です。報告の有無は直近7日で見るのがおすすめです
                <button onClick={() => applyPreset('7')} style={{ ...chipStyle(false), padding: '2px 10px' }}>直近7日にする</button>
              </span>
            )}
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <button onClick={() => void load()} disabled={loading} style={secondaryButtonStyle}>{loading ? '更新中…' : '更新'}</button>
              <button onClick={() => void handleCopyMarkdown()} disabled={loading || !loaded || Boolean(loadError)} title="表示中の内容をMarkdownでコピーします（議事録などに貼れます）" style={secondaryButtonStyle}>Markdownをコピー</button>
              <button onClick={handleDownloadCsv} disabled={loading || !loaded || Boolean(loadError)} title="表示中の内容をCSVで保存します（Excelで開けます）" style={secondaryButtonStyle}>CSV</button>
              <button
                onClick={openMeeting}
                disabled={loading || !loaded || Boolean(loadError) || groups.length === 0}
                title="担当者を1人ずつ大きく表示し、持ち時間を計りながら進めます。決まったことはその場でタスクにでき、終わったら議事録をコピーできます"
                style={{ ...secondaryButtonStyle, borderColor: 'var(--indigo-600)', color: 'var(--indigo-200)' }}
              >
                {meetingState ? '定例モードに戻る' : '定例モード'}
              </button>
              {meetingState && !meetingOpen && (
                <button onClick={() => { void confirmAction('定例のメモ・決まったこと・持ち時間を消して、最初からにしますか？', { confirmLabel: '最初からにする', danger: true }).then((ok) => { if (ok) setMeetingState(null) }) }} title="定例モードの進み具合（時間・メモ）を消して、最初からにします" style={secondaryButtonStyle}>定例をリセット</button>
              )}
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
                報告の担当
                <select aria-label="報告の担当" value={assigneeFilter} onChange={(event) => changeAssigneeFilter(event.target.value as AssigneeFilter)} style={inputStyle}>
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
                  style={{ accentColor: 'var(--indigo-500)' }}
                />
                副担当のタスクを除く（主担当のみ）
              </label>
            )}
            <button
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="report-view-settings"
              title="報告に出すカテゴリ・状態・対象・サブタスクの見せ方などを選びます"
              style={{ ...secondaryButtonStyle, borderColor: settingsOpen ? 'var(--indigo-500)' : 'var(--slate-700)' }}
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
          </>)}

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
                  disabled={!loaded || (muted && !active)}
                  aria-pressed={active}
                  title={muted ? `${chip.label}のタスクはありません` : chip.value === 'all' ? (active ? '絞り込まずに表示しています' : '絞り込みを外して、すべて表示します') : `${chip.title}${active ? '（もう一度押すと解除）' : '（押すと絞り込み）'}`}
                  style={quickFilterChipStyle(chip.color, active, muted)}
                >
                  {active && <span aria-hidden="true">✓ </span>}{chip.label} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{loaded ? chip.count : '…'}</span>
                </button>
              )
            })}
            {(!compactHeader || headerExpanded) && (
              <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', marginLeft: 4 }}>
                {loaded ? `期間内に報告あり ${reportedCount}件 ・ 進捗ログ ${noteCount}件` : loadError ? 'この期間の件数は未取得です' : 'この期間の報告を取得しています'}
              </span>
            )}
          </div>

          {loaded && myNeedsReportCount > 0 && effectiveQuickFilter !== 'myNeedsReport' && (
            <div role="status" style={myReminderStyle}>
              <span>あなたの担当で、この期間まだ報告がないタスクが <strong>{myNeedsReportCount}件</strong> あります。<span className="hakobi-hide-narrow">進捗ログかメモで一言残しておきましょう。</span></span>
              <button onClick={() => setQuickFilter('myNeedsReport')} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>自分の未報告だけ表示</button>
            </div>
          )}
          {/* 自分の報告が済んだら、注意が消えるだけでなく「済んだ」と出す（定例の前に安心できるように） */}
          {loaded && multiUser && currentUserId && myNeedsReportCount === 0 && myTaskCount > 0 && effectiveQuickFilter !== 'myNeedsReport' && (
            <div role="status" style={myDoneStyle}>
              <span>✓ この期間の自分の報告は済んでいます（担当 {myTaskCount}件）</span>
              {effectiveGroupMode === 'assignee' && groups.some((group) => group.key === currentUserId) && (
                <button onClick={() => jumpToGroup(currentUserId)} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>自分の欄へ</button>
              )}
            </div>
          )}
          {effectiveQuickFilter === 'myNeedsReport' && (
            <div role="status" style={myReminderStyle}>
              <span>自分の担当で、この期間まだ報告がないタスクだけを表示しています。</span>
              <button onClick={() => setQuickFilter('all')} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>すべて表示に戻す</button>
            </div>
          )}

          {loaded && (groups.length > 1 || visibleSubGroupKeys.length > 1) && (
            <nav aria-label={effectiveGroupMode === 'assignee' ? '担当者へ移動' : 'カテゴリへ移動'} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {groups.length > 1 && <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-control)', color: 'var(--text-subtle)' }}>
                {effectiveGroupMode === 'assignee' ? '担当者へ移動' : 'カテゴリへ移動'}
                <select value="" onChange={(event) => { if (event.target.value.startsWith('group:')) jumpToGroup(event.target.value.slice(6)) }} style={{ ...inputStyle, maxWidth: 'min(360px, 100%)' }}>
                  <option value="">選んで移動…</option>
                  {groups.map((group) => <option key={group.key} value={`group:${group.key}`}>{group.label}（{group.rows.length}件・報告なし {group.rows.filter((row) => needsReport(row.freshness)).length}件）</option>)}
                </select>
              </label>}
              {groups.length > 1 && (
                <button onClick={() => setCollapsedGroups(collapsedGroups.size > 0 ? new Set() : new Set(groups.map((group) => group.key)))} style={{ ...inlineActionStyle, marginLeft: 4 }}>
                  {collapsedGroups.size > 0 ? 'すべて開く' : 'すべて折りたたむ'}
                </button>
              )}
              {subGroupMode && visibleSubGroupKeys.length > 1 && (
                <button onClick={toggleAllSubGroups} style={{ ...inlineActionStyle, marginLeft: 4 }}>
                  {subGroupMode === 'category'
                    ? anySubGroupCollapsed ? 'カテゴリをすべて開く' : 'カテゴリをすべて折りたたむ'
                    : anySubGroupCollapsed ? '担当者をすべて開く' : '担当者をすべて折りたたむ'}
                </button>
              )}
            </nav>
          )}
        </div>

        {loadError && (
          <div role="alert" style={{ padding: '10px 14px', border: '1px solid var(--red-700)', borderRadius: 10, background: 'var(--red-950)', color: 'var(--red-200)', fontSize: '0.82rem' }}>
            <p>報告データを読み込めませんでした。{loadError}</p>
            <p style={{ marginTop: 6 }}>{loaded ? '前回取得した内容を表示しています。' : 'この期間の報告はまだ取得できていません。'} 社内LANへの接続を確認して、もう一度お試しください。</p>
            <button disabled={loading} onClick={() => void load()} style={{ ...secondaryButtonStyle, marginTop: 8 }}>再試行</button>
          </div>
        )}

        {!loaded && !loadError && <div style={emptyStyle}>読み込み中…</div>}

        {loaded && groups.length === 0 && (
          <div style={emptyStyle}>
            {effectiveQuickFilter === 'myNeedsReport'
              ? <>この期間の自分の報告はすべて済んでいます。<button onClick={() => setQuickFilter('all')} style={{ ...inlineActionStyle, marginLeft: 8, fontSize: '0.82rem' }}>すべて表示</button></>
              : effectiveQuickFilter !== 'all'
              ? <>条件に合うタスクはありません。<button onClick={() => setQuickFilter('all')} style={{ ...inlineActionStyle, marginLeft: 8, fontSize: '0.82rem' }}>すべて表示</button></>
              : settingsChips.length > 0
                ? '表示できるタスクがありません。「表示設定」の横に出ている条件も確認してください。'
                : '表示できるタスクがありません。見出しの横の「絞り込み中」も確認してください。'}
          </div>
        )}

        {meetingOpen && meetingState && (
          <MeetingMode
            groups={meetingGroups}
            state={meetingState}
            onStateChange={(updater) => setMeetingState((previous) => previous ? updater(previous) : previous)}
            periodLabel={`${formatShortDate(range.from)}（${weekdayLabel(range.from)}）〜${formatShortDate(range.to)}（${weekdayLabel(range.to)}）`}
            renderBody={renderMeetingBody}
            onCreateTask={createMeetingTask}
            createTaskHint={meetingTaskHint}
            onShowToast={onShowToast}
            onClose={() => setMeetingOpen(false)}
          />
        )}

        {loaded && groups.map((group) => {
          const groupNeeds = group.rows.filter((row) => needsReport(row.freshness)).length
          const groupReported = group.rows.filter((row) => row.reportedInPeriod).length
          const groupDiscussions = group.rows
            .flatMap((row) => row.discussions)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
          const collapsed = collapsedGroups.has(group.key)
          return (
            <section key={`${effectiveGroupMode}:${group.key}`} id={groupDomId(group.key)} tabIndex={-1} aria-label={`${group.label}（${group.rows.length}件）`} style={{ display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 4, outlineOffset: -2 }}>
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
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: group.color ?? 'var(--slate-600)', flexShrink: 0 }} />
                {/* 読み上げで担当者ごとに飛べるように見出しにする（見た目は変えない） */}
                <h2 style={{ margin: 0, fontSize: '0.98rem', color: 'var(--slate-100)', fontWeight: 800 }}>{group.label}</h2>
                {group.isMe && <span style={{ fontSize: 'var(--font-caption)', color: 'var(--indigo-200)', background: 'var(--indigo-900)', borderRadius: 999, padding: '1px 7px' }}>自分</span>}
                <span style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>{group.rows.length}件</span>
                <span style={{ fontSize: 'var(--font-control)', color: 'var(--green-300)' }}>報告あり {groupReported}</span>
                <span style={{ fontSize: 'var(--font-control)', color: groupNeeds > 0 ? 'var(--amber-200)' : 'var(--text-subtle)', fontWeight: groupNeeds > 0 ? 700 : 400 }}>
                  報告なし {groupNeeds}
                </span>
                {groupDiscussions.length > 0 && (
                  <span style={{ fontSize: 'var(--font-control)', color: 'var(--c-d6b38a)' }}>要相談 {groupDiscussions.length}</span>
                )}
              </div>
              {!collapsed && groupDiscussions.length > 0 && (
                <div style={discussionBoxStyle}>
                  <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-300)', fontWeight: 700 }}>
                    要相談（{groupDiscussions.length}件）
                    <span style={{ marginLeft: 8, fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', fontWeight: 400 }}>相談が済んだら ⋯ から外します</span>
                  </div>
                  {groupDiscussions.map((note) => (
                    <InteractiveNote key={`discussion-${note.id}`} note={note} actions={actions} showTask />
                  ))}
                </div>
              )}
              {!collapsed && !subGroupMode && group.rows.map((row) => renderCard(row))}
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
                          : `折りたたむ（ほかの${subGroupMode === 'category' ? '担当者' : 'カテゴリ'}の「${subGroup.label}」も一緒に折りたたみ、次に開いたときも折りたたんだままにします）`}
                        style={collapseButtonStyle(subCollapsed)}
                      >
                        ▾
                      </button>
                      <span style={{ width: 9, height: 9, borderRadius: subGroupMode === 'category' ? 2 : '50%', background: subGroup.color ?? 'var(--slate-600)', flexShrink: 0 }} />
                      <span style={{ fontSize: '0.86rem', color: 'var(--slate-200)', fontWeight: 800 }}>{subGroup.label}</span>
                      <span style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>{subGroup.rows.length}件</span>
                      {subNeeds > 0 && <span style={{ fontSize: 'var(--font-caption)', color: 'var(--amber-200)', fontWeight: 700 }}>報告なし {subNeeds}</span>}
                      {subDiscussions > 0 && <span style={{ fontSize: 'var(--font-caption)', color: 'var(--c-d6b38a)' }}>要相談 {subDiscussions}</span>}
                    </div>
                    {!subCollapsed && subGroup.rows.map((row) => renderCard(row))}
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
    : summary && summary.postponedCount > 0 ? 'var(--amber-200)' : 'var(--blue-300)'

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
      <label style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 'var(--font-control)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={done}
          disabled={saving}
          onChange={(event) => void run(
            { done: event.target.checked },
            event.target.checked ? 'サブタスクを完了にしました' : 'サブタスクを未完了に戻しました'
          )}
          style={{ width: 18, height: 18, accentColor: 'var(--green-500)', cursor: 'pointer', flexShrink: 0, margin: 3, transform: 'translateY(1px)' }}
        />
        <span style={{ flex: 1, minWidth: 0, color: done ? 'var(--text-subtle)' : 'var(--slate-300)', textDecoration: done ? 'line-through' : 'none', wordBreak: 'break-word' }}>
          {subTask.title}
          {subTask.assignee_name && (
            <span style={{ marginLeft: 6, fontSize: 'var(--font-caption)', color: dataInk(subTask.assignee_color ?? 'var(--slate-400)'), display: 'inline-block' }}>
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
              style={{ ...inputStyle, padding: '2px 6px', fontSize: 'var(--font-caption)' }}
            />
            <button onClick={() => void saveStart()} disabled={saving} style={{ ...inlineActionStyle, color: 'var(--blue-300)' }}>保存</button>
            <button onClick={() => setEditingStart(false)} style={inlineActionStyle}>取消</button>
          </div>
        ) : (
          <button
            onClick={openStartEditor}
            disabled={saving}
            title="開始日を変更"
            style={{ ...inlineActionStyle, textDecoration: 'none', color: 'var(--text-subtle)', flexShrink: 0 }}
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
              style={{ ...inputStyle, padding: '2px 6px', fontSize: 'var(--font-caption)' }}
            />
            <button onClick={() => void saveDue()} disabled={saving} style={{ ...inlineActionStyle, color: 'var(--blue-300)' }}>保存</button>
            <button onClick={() => setEditingDue(false)} style={inlineActionStyle}>取消</button>
          </div>
        ) : (
          <button
            onClick={openDueEditor}
            disabled={saving}
            title="期限を変更"
            style={{ ...inlineActionStyle, textDecoration: 'none', color: dueColor || 'var(--text-subtle)', fontWeight: dueColor ? 800 : 600, flexShrink: 0 }}
          >
            {subTask.due_date ? `期限 ${formatShortDate(subTask.due_date)}${dueStateSuffix(subTask.due_date, done)}` : '期限なし'}
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
        <div style={{ paddingLeft: 20, fontSize: 'var(--font-caption)', color: changeColor }}>{change}</div>
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
      <button onClick={openForm} style={{ ...inlineActionStyle, textDecoration: 'none', alignSelf: 'flex-start', color: 'var(--text-subtle)' }}>
        ＋ サブタスクを追加
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--gray-900)', border: '1px solid var(--slate-700)', borderRadius: 8, padding: 8 }}>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
          開始日
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="追加するサブタスクの開始日" style={inputStyle} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
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

const WEEKDAY_SHORT = ['日', '月', '火', '水', '木', '金', '土']

function dayTone(done: number, total: number): string {
  if (total === 0) return 'var(--slate-800)'
  if (done >= total) return 'var(--green-500)'
  if (done === 0) return 'var(--red-900)'
  return done / total >= 0.5 ? 'var(--yellow-500)' : 'var(--orange-500)'
}

/** 終わった回の実施の色。全部済みは緑、8割以上は黄、それより下は赤 */
function rateTone(checked: number, periods: number): string {
  if (periods === 0) return 'var(--text-subtle)'
  if (checked >= periods) return 'var(--green-300)'
  return checked / periods >= 0.8 ? 'var(--amber-200)' : 'var(--red-300)'
}

/** 周期（毎日・毎週・毎月）ごとの1行。終わった回の実施と、今の回の進み具合を分けて出す */
function RepeatGroupLine({ group }: { group: RepeatGroupDigest }): React.JSX.Element {
  const muted: React.CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }
  const currentDone = group.current != null && group.current.checked >= group.current.total
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-control)' }}>
      <span style={{ color: 'var(--slate-400)' }}>{group.label} {group.itemCount}件</span>
      {group.periods > 0 && (
        <span
          title={`${group.doneLabel}の回のうち、チェックした回数。今日・今週・今月の分はまだ途中なので入れません。${MIN_PERIODS_FOR_RATE}回以上になると率（%）も出します`}
          style={{ color: rateTone(group.checked, group.periods), fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}
        >
          {group.doneLabel} {rateText(group.checked, group.periods)}
        </span>
      )}
      {group.current && (
        <span
          title="まだ途中の回です。チェックしても上の回数には入りません"
          style={{ color: currentDone ? 'var(--green-300)' : 'var(--indigo-200)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
        >
          {group.current.label} {group.current.checked}/{group.current.total}
        </span>
      )}
      {group.periods === 0 && <span style={muted}>{group.current ? `（${group.startsLabel}）` : '期間中の対象なし'}</span>}
    </div>
  )
}

/**
 * ToDoリストの、期間中の実施状況の要約。
 * 繰り返しの項目は周期ごとに1行（終わった回の実施・今の回）と、毎日の項目の日ごとのマス・取りこぼしたものの名前だけ。
 * やることは件数（期限切れは名前も）。項目ごとの内訳は折りたたんでおき、必要なときだけ開く。
 */
function ListItemsSummary({ row, period }: { row: ReportRow; period: DateRange }): React.JSX.Element {
  const digest = digestRow(row, period)
  const labelStyle: React.CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }
  const items = splitListItems(row.subTasks, period)
  const missed = missedText(digest, 3)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, paddingTop: 8, borderTop: '1px dashed var(--slate-800)' }}>
      {row.subTasks.length === 0 && <div style={labelStyle}>まだ項目がありません</div>}
      {digest.groups.map((group) => (
        <React.Fragment key={group.kind}>
          <RepeatGroupLine group={group} />
          {group.kind === 'daily' && digest.days.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={labelStyle}>日ごと</span>
              <span role="img" aria-label="毎日の項目の日ごとの実施" style={{ display: 'inline-flex', gap: 2, flexWrap: 'wrap' }}>
                {digest.days.map(({ day, done, total, today }) => {
                  const [y, m, d] = day.split('-').map(Number)
                  const label = `${m}/${d}（${WEEKDAY_SHORT[new Date(y, m - 1, d).getDay()]}） ${done}/${total}${today ? '（今日・途中）' : ''}`
                  // 今日はまだ途中なので、済んでいなくても赤くせず、枠だけにする
                  const background = today && done < total ? (done > 0 ? 'color-mix(in srgb, var(--yellow-500) 40%, transparent)' : 'transparent') : dayTone(done, total)
                  return <span key={day} title={label} style={{ width: 11, height: 11, borderRadius: 2, background, boxSizing: 'border-box', border: today ? '1px solid var(--slate-400)' : 'none' }} />
                })}
              </span>
              <span style={{ ...labelStyle, fontSize: 'var(--font-caption)' }}>{formatShortDate(digest.days[0].day)}〜{formatShortDate(digest.days[digest.days.length - 1].day)}</span>
            </div>
          )}
        </React.Fragment>
      ))}
      {missed && (
        <div style={{ fontSize: 'var(--font-caption)', color: digest.missed.length > 0 ? 'var(--amber-200)' : 'var(--green-300)' }}>{missed}</div>
      )}
      {(digest.open.length > 0 || digest.doneInPeriod.length > 0) && (
        <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span>やること</span>
          {digest.overdue.length > 0 && (
            <span style={{ color: 'var(--red-300)', fontWeight: 700 }}>期限切れ {digest.overdue.length}件（{namesText(digest.overdue.map((item) => item.title), 2)}）</span>
          )}
          <span>まだ {digest.open.length}件</span>
          {digest.doneInPeriod.length > 0 && (
            <span title={digest.doneInPeriod.map((item) => item.title).join('\n')} style={{ color: 'var(--green-300)' }}>期間中に済んだ {digest.doneInPeriod.length}件</span>
          )}
        </div>
      )}
      {row.subTasks.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>項目ごとに見る</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 5 }}>
            {items.repeat.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-control)' }}>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-300)', overflowWrap: 'anywhere' }}>{item.title}</span>
                <span style={{ fontSize: 'var(--font-caption)', color: 'var(--indigo-300)', flexShrink: 0 }}>{repeatLabel(item)}</span>
                <span style={{ color: 'var(--slate-400)', fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 40, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {itemStatusText(itemCheckStatus(item, row.checkSummaries.get(item.id))) ?? '—'}
                </span>
              </div>
            ))}
            {items.open.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-control)' }}>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--slate-300)', overflowWrap: 'anywhere' }}>☐ {item.title}</span>
                {itemPeriodText(item) && <span style={{ fontSize: 'var(--font-caption)', color: getDueDateColor(item.due_date) || 'var(--text-subtle)', flexShrink: 0 }}>{itemPeriodText(item)}</span>}
              </div>
            ))}
            {items.doneInPeriod.map((item) => (
              <div key={item.id} style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)', textDecoration: 'line-through', overflowWrap: 'anywhere' }}>☑ {item.title}</div>
            ))}
          </div>
        </details>
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
  showOnTrackHelper,
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
  showOnTrackHelper: boolean
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
  // 保存できない日付は欄の下に出し、開始日の欄へフォーカスを移す。閉じたら「変更」へフォーカスを戻す
  const [scheduleError, setScheduleError] = useState('')
  const scheduleStartInputRef = useRef<HTMLInputElement>(null)
  const scheduleButtonRef = useRef<HTMLButtonElement>(null)
  const wasEditingScheduleRef = useRef(false)
  useEffect(() => {
    if (wasEditingScheduleRef.current && !editingSchedule) {
      const active = document.activeElement
      if (!active || active === document.body || active.hasAttribute('data-focus-region')) scheduleButtonRef.current?.focus({ preventScroll: true })
    }
    wasEditingScheduleRef.current = editingSchedule
    if (!editingSchedule) setScheduleError('')
  }, [editingSchedule])
  const [editingMemo, setEditingMemo] = useState(false)
  const [memoDraft, setMemoDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const tone = freshnessTone(freshness)
  const dueColor = todo.status === 'done' ? '' : getDueDateColor(todo.due_date)
  const dueLabel = formatDueLabel(todo.due_date, todo.status)
  const hold = getOnHoldInfo(todo.on_hold_since)
  const memo = todo.memo.trim()
  // ToDoリストは進捗率を使わないので、切り替える前の進捗の変化も出さない
  const progressDelta = todo.list_mode ? null : progressDeltaText(row, row.todo.progress)
  const dueChange = dueChangeText(row)
  const canPost = !posting && cleanProgressNote(draft).length > 0
  const memoChanged = memoDraft !== todo.memo

  const submitNote = async (): Promise<void> => {
    if (!canPost) return
    setPosting(true)
    const ok = await actions.onCreateNote(todo, cleanProgressNote(draft), draftNeedsDiscussion)
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
      setScheduleError('開始日は期限以前にしてください')
      scheduleStartInputRef.current?.focus()
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
        background: 'var(--c-0b1220)',
        border: '1px solid var(--slate-800)',
        borderLeft: `4px solid ${tone.border}`,
        borderRadius: 12,
        padding: '14px 16px'
      }}
    >
      {/* ─── 左: タスク情報（状態・日程・進捗はその場で変更できる） ─── */}
      <div style={{ flex: '1 1 300px', maxWidth: 440, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 'inherit', fontWeight: 'inherit', minWidth: 0 }}>
            <button onClick={() => onSelectTodo(todo.id)} title="タスク詳細を開く" style={taskTitleButtonStyle}>
              {todo.title}
            </button>
          </h3>
          {todo.priority >= 4 && (
            <span style={{ fontSize: 'var(--font-caption)', color: todo.priority === 5 ? 'var(--red-500)' : 'var(--amber-500)', fontWeight: 800, flexShrink: 0, marginTop: 2 }}>
              {'!'.repeat(todo.priority - 3)}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select
            value={todo.status}
            disabled={saving}
            onChange={(event) => void updateField({ status: event.target.value as TodoStatus }, '状態を変えました')}
            aria-label="状態"
            title="状態を変える"
            style={{ ...pillSelectStyle, color: STATUS_COLOR[todo.status], borderColor: `color-mix(in srgb, ${STATUS_COLOR[todo.status]} 50.2%, transparent)` }}
          >
            <option value="not_started">未着手</option>
            <option value="active">進行中</option><option value="on_hold">保留中</option>
            <option value="done">完了</option>
          </select>
          {groupMode === 'assignee' && subGroupMode !== 'category' ? (
            <span style={{ ...pillStyle, color: dataInk(todo.category_color ?? 'var(--slate-400)'), borderColor: `color-mix(in srgb, ${todo.category_color ?? 'var(--slate-600)'} 50.2%, transparent)` }}>
              {todo.category_name ?? '未分類'}
            </span>
          ) : null}
          {multiUser && (groupMode !== 'assignee' || showAssignee) && (
            <span style={{ ...pillStyle, color: 'var(--slate-300)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: todo.assignee_color ?? 'var(--slate-600)' }} />
              主: {todo.assignee_name ?? '未割り当て'}
            </span>
          )}
          {(todo.co_assignees ?? []).length > 0 && (
            <span style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
              副: {(todo.co_assignees ?? []).map((assignee) => assignee.display_name).join('、')}
            </span>
          )}
        </div>

        {todo.status === 'on_hold' && (
          <div style={{ background: 'var(--purple-950)', border: '1px solid var(--purple-500)', borderRadius: 10, padding: '12px 14px', color: 'var(--purple-200)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong style={{ fontSize: '0.92rem' }}>保留中 · {hold.durationLabel}</strong>
            <div style={{ fontSize: 'var(--font-control)' }}>保留開始: {hold.sinceLabel}</div>
            <div style={{ fontSize: 'var(--font-caption)', color: 'var(--purple-300)' }}>作業を停止しています。保留理由や再開の条件をメモに残せます。</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <button onClick={() => void updateField({ status: 'active' }, '進行中に戻しました')} disabled={saving} style={secondaryButtonStyle}>進行中に戻す</button>
              <button onClick={openMemoEditor} style={secondaryButtonStyle}>{memo ? 'メモを編集' : '保留理由をメモする'}</button>
            </div>
          </div>
        )}

        {editingSchedule ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--gray-900)', border: '1px solid var(--slate-700)', borderRadius: 8, padding: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                開始
                <input ref={scheduleStartInputRef} type="date" value={startDraft} onChange={(event) => { setStartDraft(event.target.value); setScheduleError('') }} aria-label="開始日" aria-invalid={scheduleError ? true : undefined} aria-describedby={scheduleError ? `schedule-error-${todo.id}` : undefined} style={inputStyle} />
              </label>
              <span style={{ color: 'var(--text-subtle)' }}>→</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                期限
                <input type="date" value={dueDraft} onChange={(event) => { setDueDraft(event.target.value); setScheduleError('') }} aria-label="期限" aria-invalid={scheduleError ? true : undefined} aria-describedby={scheduleError ? `schedule-error-${todo.id}` : undefined} style={inputStyle} />
              </label>
            </div>
            {scheduleError && <div id={`schedule-error-${todo.id}`} role="alert" style={{ fontSize: 'var(--font-control)', color: 'var(--red-300)', fontWeight: 600 }}>{scheduleError}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', flex: 1 }}>依存関係のある後続タスクも再計算されます</span>
              <button onClick={() => setEditingSchedule(false)} style={secondaryButtonStyle}>キャンセル</button>
              <button onClick={() => void saveSchedule()} disabled={saving} style={primaryButtonStyle(!saving)}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : todo.list_mode && !todo.due_date ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--font-control)' }}>
            <span style={{ color: 'var(--slate-400)' }}>開始 {formatShortDate(todo.start_date)}</span>
            <span style={{ color: 'var(--indigo-300)' }} title="期限のない ToDoリストです。使い終えたら「リストを終える」を押します">→ 期限なし</span>
            <button ref={scheduleButtonRef} onClick={openScheduleEditor} title="開始日・期限を変更" aria-label={`「${todo.title}」の開始日・期限を変更`} style={inlineActionStyle}>変更</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--font-control)' }}>
            <span style={{ color: 'var(--slate-400)' }}>開始 {formatShortDate(todo.start_date)}</span>
            <span style={{ color: 'var(--text-subtle)' }}>→</span>
            <span style={{ color: dueColor || 'var(--slate-300)', fontWeight: dueColor ? 700 : 400 }}>期限 {formatShortDate(todo.due_date)}</span>
            {dueLabel && <span style={{ color: dueColor || 'var(--text-subtle)', fontSize: 'var(--font-caption)' }}>（{dueLabel}）</span>}
            <button ref={scheduleButtonRef} onClick={openScheduleEditor} title="開始日・期限を変更" aria-label={`「${todo.title}」の開始日・期限を変更`} style={inlineActionStyle}>変更</button>
          </div>
        )}
        {!editingSchedule && dueChange && (
          <div style={{ fontSize: 'var(--font-caption)', color: row.postponedCount > 0 ? 'var(--amber-200)' : 'var(--slate-400)', fontWeight: row.postponedCount > 0 ? 700 : 400 }}>
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
            <div style={{ fontSize: 'var(--font-caption)', color: progressDeltaColor(row, row.todo.progress), marginTop: -2 }}>
              {progressDelta ? `期間中 ${progressDelta}` : '期間中の進捗の変更なし'}
            </div>
          </div>
        )}

        {todo.list_mode ? (
          <ListItemsSummary row={row} period={{ from: periodFrom, to: periodTo }} />
        ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, paddingTop: 8, borderTop: '1px dashed var(--slate-800)' }}>
          {subTasks.length > 0 && (
            <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>
              サブタスク {subTasks.filter((subTask) => subTask.done).length}/{subTasks.length} 完了
            </div>
          )}
          {visibleSubTasks.map((subTask) => (
            <SubTaskRow key={subTask.id} subTask={subTask} summary={row.subTaskSummaries.get(subTask.id)} actions={actions} />
          ))}
          {foldedSubTasks.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--font-control)', color: 'var(--slate-400)', padding: '5px 0' }}>
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
          <span style={{ fontSize: 'var(--font-caption)', fontWeight: 700, color: tone.color, background: tone.background, border: `1px solid ${tone.border}`, borderRadius: 999, padding: '2px 9px' }}>
            {freshnessText(row)}
          </span>
          {row.behind && (
            <span
              title={`今日時点の予定 ${row.behind.expectedProgress}% ／ 実績 ${todo.progress}%（ガントの「遅れ」と同じ判定）`}
              style={{ fontSize: 'var(--font-caption)', fontWeight: 700, color: 'var(--amber-200)', background: 'var(--amber-950)', border: '1px solid var(--amber-500)', borderRadius: 999, padding: '2px 9px' }}
            >
              進捗 {behindDaysLabel(row.behind.days)}
            </span>
          )}
          <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>
            {/* 担当以外の人の書き込みだけのときは「最終報告」と書かない（「報告なし」と食い違って見えるため） */}
            {lastReportAt ? `${freshness === 'quiet' && notes.length > 0 ? '最後の書き込み（担当以外）' : '最終報告'} ${formatDateTime(lastReportAt)}（${formatDaysAgo(lastReportAt)}）` : '最終報告 なし'}
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
              style={{ ...inlineActionStyle, textDecoration: 'none', color: 'var(--text-subtle)', fontWeight: 700, padding: '0 2px' }}
            >
              隠す
            </button>
          </div>
        </div>

        {composerOpen && (
          <div style={{ background: 'var(--gray-900)', border: '1px solid var(--slate-700)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <ProgressNoteHelpers
                draft={draft}
                disabled={posting}
                showOnTrack={showOnTrackHelper}
                onInsertTemplate={() => setDraft(withProgressNoteTemplate(draft))}
                onInsertOnTrack={() => setDraft(ON_TRACK_NOTE)}
              />
              <label style={{ ...checkboxLabelStyle, marginRight: 'auto', color: draftNeedsDiscussion ? 'var(--c-d6b38a)' : 'var(--slate-400)' }}>
                <input type="checkbox" checked={draftNeedsDiscussion} onChange={(event) => setDraftNeedsDiscussion(event.target.checked)} style={{ accentColor: 'var(--indigo-500)' }} />
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
          <div style={{ background: 'var(--gray-900)', border: '1px solid var(--slate-700)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>メモ（現状・次にやること・引き継ぎなど。上書き保存）</div>
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
              <span style={{ fontSize: 'var(--font-caption)', color: memoChanged ? 'var(--blue-300)' : 'var(--text-subtle)', flex: 1 }}>
                {memoChanged ? '未保存の変更があります（Ctrl+Enterで保存）' : '変更なし'}
              </span>
              <button onClick={() => setEditingMemo(false)} style={secondaryButtonStyle}>キャンセル</button>
              <button onClick={() => void saveMemo()} disabled={saving || !memoChanged} style={primaryButtonStyle(!saving && memoChanged)}>
                {saving ? '保存中…' : 'メモを保存'}
              </button>
            </div>
          </div>
        ) : memo ? (
          <div style={{ background: 'var(--gray-900)', border: '1px dashed var(--slate-700)', borderRadius: 10, padding: '8px 11px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>メモ{lastMemoAt ? `（更新 ${formatDateTime(lastMemoAt)}）` : ''}</span>
              <button onClick={openMemoEditor} style={{ ...inlineActionStyle, marginLeft: 'auto' }}>編集</button>
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--slate-300)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
              <LinkedText text={memo} />
            </div>
          </div>
        ) : null}

        {notes.length === 0 ? (
          <div style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)', padding: '4px 2px' }}>この期間の進捗ログはありません。</div>
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
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 7,
  color: 'var(--slate-200)',
  fontSize: 'var(--font-control)',
  outline: 'none'
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: 3,
  background: 'var(--gray-900)',
  border: '1px solid var(--gray-800)',
  borderRadius: 10
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    background: active ? 'var(--blue-600)' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 7,
    color: active ? 'var(--on-fill-blue-50)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: 'var(--font-control)',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '6px 11px',
  background: 'var(--gray-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 7,
  color: 'var(--slate-300)',
  cursor: 'pointer',
  fontSize: 'var(--font-control)',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

function primaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    background: enabled ? 'var(--blue-600)' : 'var(--slate-800)',
    border: `1px solid ${enabled ? 'var(--blue-700)' : 'var(--slate-700)'}`,
    borderRadius: 7,
    color: enabled ? 'var(--on-fill-blue-50)' : 'var(--slate-500)',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 'var(--font-control)',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

function reportButtonStyle(emphasized: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    background: emphasized ? 'var(--blue-900)' : 'transparent',
    border: `1px solid ${emphasized ? 'var(--blue-600)' : 'var(--slate-700)'}`,
    borderRadius: 999,
    color: emphasized ? 'var(--blue-100)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: 'var(--font-caption)',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

// 選んでいるチップは色で塗って「✓」を付ける（色だけで選んでいるかを示さない）。0件のチップは点線の枠で、文字は読める濃さにする
function quickFilterChipStyle(color: string, active: boolean, muted: boolean): React.CSSProperties {
  return {
    fontSize: 'var(--font-control)',
    color: muted ? 'var(--text-subtle)' : active ? 'var(--slate-900)' : color,
    background: active ? color : 'var(--gray-900)',
    border: `${active ? 2 : 1}px ${muted && !active ? 'dashed' : 'solid'} ${active ? color : muted ? 'var(--slate-700)' : `color-mix(in srgb, ${color} 33.3%, transparent)`}`,
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
  padding: '5px 6px 5px 12px',
  borderRadius: 10,
  border: '1px solid var(--yellow-700)',
  background: 'var(--c-1c1408)',
  color: 'var(--amber-200)',
  fontSize: 'var(--font-control)'
}

const myDoneStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  padding: '5px 6px 5px 12px',
  borderRadius: 10,
  border: '1px solid var(--green-700)',
  background: 'var(--green-950)',
  color: 'var(--green-200)',
  fontSize: 'var(--font-control)'
}

const jumpChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 9px',
  borderRadius: 999,
  border: '1px solid var(--slate-700)',
  background: 'var(--c-0b1220)',
  color: 'var(--slate-200)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

function collapseButtonStyle(collapsed: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    border: '1px solid var(--slate-700)',
    background: 'var(--gray-900)',
    color: 'var(--slate-400)',
    cursor: 'pointer',
    padding: 0,
    fontSize: 'var(--font-control)',
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
  fontSize: 'var(--font-control)',
  color: 'var(--slate-400)',
  cursor: 'pointer'
}

const groupHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  padding: '8px 4px',
  borderBottom: '1px solid var(--slate-800)',
  position: 'sticky',
  top: 0,
  background: 'var(--slate-900)',
  zIndex: 1
}

const settingsChipStyle: React.CSSProperties = {
  maxWidth: 260,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid var(--indigo-600)',
  background: 'var(--indigo-950)',
  color: 'var(--indigo-200)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
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
    borderLeft: `3px solid ${color ?? 'var(--slate-600)'}`,
    borderRadius: 4,
    background: 'var(--c-0b1220)'
  }
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 'var(--font-caption)',
  border: '1px solid var(--slate-700)',
  borderRadius: 999,
  padding: '1px 8px'
}

const pillSelectStyle: React.CSSProperties = {
  fontSize: 'var(--font-caption)',
  fontWeight: 700,
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
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
  background: 'var(--c-0b1220)',
  border: '1px solid var(--slate-800)',
  borderLeft: '3px solid var(--c-4b3b2c)',
  borderRadius: 12,
  padding: '10px 12px'
}

const inlineActionStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--slate-400)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 800,
  // 見た目は文字のリンクのまま、押せる範囲を 24px 以上にする
  padding: '0.3rem 0.25rem',
  margin: '-0.3rem -0.25rem',
  minHeight: 24,
  textDecoration: 'underline',
  textUnderlineOffset: 2
}

const taskTitleButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--slate-100)',
  fontSize: '0.95rem',
  fontWeight: 800,
  textAlign: 'left',
  lineHeight: 1.45,
  wordBreak: 'break-word'
}

const emptyStyle: React.CSSProperties = {
  color: 'var(--text-subtle)',
  fontSize: '0.86rem',
  padding: '20px 4px'
}
