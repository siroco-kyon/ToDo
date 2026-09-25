import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { dateStamp, downloadCsv, toCsv } from '../lib/csv'
import { diffDaysFromToday, getDueDateColor, isoToDateKey, toDateKey } from '../lib/dueDate'
import { LIKE_EMOJI } from './LikeButton'
import { ProgressNoteThread } from './ProgressNoteThread'
import { ProgressSlider } from './ProgressSlider'
import type {
  ProgressNote,
  ProgressNoteComment,
  PublicUser,
  SubTask,
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
  users: PublicUser[]
  currentUser: PublicUser | null
  onSelectTodo: (id: string) => void
  onUpdateTodo: (id: string, data: UpdateTodoInput) => Promise<void>
  onUpdateSubTask: (id: string, data: UpdateSubTaskInput) => Promise<void>
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

interface DateRange {
  from: string
  to: string
}

type PeriodPreset = '7' | '14' | '30' | 'custom'
type GroupMode = 'assignee' | 'category'
type Freshness = 'fresh' | 'quiet' | 'stale' | 'none' | 'done' | 'notStarted'

interface ReportRow {
  todo: Todo
  subTasks: SubTask[]
  /** 期間内の進捗ログ（新しい順） */
  notes: ProgressNote[]
  lastReportAt: string | null
  lastMemoAt: string | null
  freshness: Freshness
  /** 期間の最初の進捗率（期間中に進捗の変更がなければ null） */
  progressStart: number | null
  /** 期間中の期限の変更（古い順） */
  dueChanges: TodoChangeEntry[]
  /** 期間中に期限を後ろへずらした回数 */
  postponedCount: number
  /** 未解決の「要相談」進捗ログ（期間に関係なく） */
  discussions: ProgressNote[]
}

interface ReportGroup {
  key: string
  label: string
  color: string | null
  isMe: boolean
  rows: ReportRow[]
}

/** この日数以上報告がなければ「止まっている」扱い（赤） */
const STALE_DAYS = 14

const PRESETS: Array<{ value: Exclude<PeriodPreset, 'custom'>; label: string; days: number }> = [
  { value: '7', label: '直近7日', days: 7 },
  { value: '14', label: '直近14日', days: 14 },
  { value: '30', label: '直近30日', days: 30 }
]

const STORAGE_KEYS = {
  preset: 'report.periodPreset',
  groupMode: 'report.groupMode',
  onlyMine: 'report.onlyMine'
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  not_started: '未着手',
  active: '進行中',
  done: '完了',
  archived: 'アーカイブ'
}

const STATUS_COLOR: Record<TodoStatus, string> = {
  not_started: '#64748b',
  active: '#3b82f6',
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

function presetRange(days: number): DateRange {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  return { from: toDateKey(from), to: toDateKey(to) }
}

function formatShortDate(dateKey: string | null): string {
  if (!dateKey) return '未設定'
  const [, m, d] = dateKey.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}`
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
  discussions: ProgressNote[]
): ReportRow {
  const lastNoteAt = activity?.last_note_at ?? null
  const lastMemoAt = activity?.last_memo_at ?? null
  const lastReportAt = latestIso(lastNoteAt, lastMemoAt)
  const memoUpdatedInPeriod = lastMemoAt != null && isInRange(isoToDateKey(lastMemoAt), range)

  let freshness: Freshness
  if (todo.status === 'done') {
    freshness = 'done'
  } else if (notes.length > 0 || memoUpdatedInPeriod) {
    freshness = 'fresh'
  } else if (todo.status === 'not_started' && (!todo.start_date || todo.start_date.slice(0, 10) > range.to)) {
    freshness = 'notStarted'
  } else if (!lastReportAt) {
    freshness = 'none'
  } else if (-diffDaysFromToday(isoToDateKey(lastReportAt)) >= STALE_DAYS) {
    freshness = 'stale'
  } else {
    freshness = 'quiet'
  }

  // 期間中の最初の変更の「変更前」が、期間開始時点の値
  const progressChanges = changes.filter((change) => change.field === 'progress')
  const progressStart = progressChanges.length > 0 ? Number(progressChanges[0].old_value ?? 0) : null
  const dueChanges = changes.filter((change) => change.field === 'due_date')
  const postponedCount = dueChanges.filter((change) =>
    change.old_value != null && change.new_value != null && change.new_value.slice(0, 10) > change.old_value.slice(0, 10)
  ).length

  return { todo, subTasks, notes, lastReportAt, lastMemoAt, freshness, progressStart, dueChanges, postponedCount, discussions }
}

function groupRows(rows: ReportRow[], mode: GroupMode, users: PublicUser[], currentUserId: string | null): ReportGroup[] {
  const groups = new Map<string, ReportGroup>()
  for (const row of rows) {
    const { todo } = row
    const key = mode === 'assignee' ? (todo.assignee_id ?? '') : (todo.category_id ?? '')
    let group = groups.get(key)
    if (!group) {
      group = mode === 'assignee'
        ? {
            key,
            label: todo.assignee_name ?? '未割り当て',
            color: todo.assignee_color,
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

function freshnessText(row: ReportRow): string {
  switch (row.freshness) {
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
  }
}

function freshnessTone(freshness: Freshness): { color: string; background: string; border: string } {
  if (freshness === 'fresh') return { color: '#86efac', background: '#052e16', border: '#166534' }
  if (freshness === 'quiet') return { color: '#fde68a', background: '#422006', border: '#a16207' }
  if (freshness === 'stale' || freshness === 'none') return { color: '#fecaca', background: '#450a0a', border: '#b91c1c' }
  if (freshness === 'done') return { color: '#bbf7d0', background: '#0f172a', border: '#334155' }
  return { color: '#94a3b8', background: '#0f172a', border: '#334155' }
}

/** 状態と鮮度をまとめた表記。完了・未着手は状態だけで意味が伝わるので重ねない */
function statusSummary(row: ReportRow, separator: string): string {
  const status = STATUS_LABEL[row.todo.status]
  if (row.freshness === 'done' || row.freshness === 'notStarted') return status
  return `${status}${separator}${freshnessText(row)}`
}

/** 期間中の進捗の変化。変更がなければ null */
function progressDeltaText(row: ReportRow): string | null {
  if (row.progressStart === null) return null
  const delta = row.todo.progress - row.progressStart
  const sign = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0'
  return `${row.progressStart}% → ${row.todo.progress}%（${sign}）`
}

function progressDeltaColor(row: ReportRow): string {
  if (row.progressStart === null) return '#64748b'
  const delta = row.todo.progress - row.progressStart
  if (delta > 0) return '#86efac'
  if (delta < 0) return '#fca5a5'
  return '#94a3b8'
}

/** 期間中の期限の変更。変更がなければ null */
function dueChangeText(row: ReportRow): string | null {
  if (row.dueChanges.length === 0) return null
  const first = row.dueChanges[0].old_value
  const current = row.todo.due_date
  const route = `${formatShortDate(first)} → ${formatShortDate(current)}`
  if (row.postponedCount > 0) return `延期${row.postponedCount}回（${route}）`
  if (first && current && current.slice(0, 10) < first.slice(0, 10)) return `前倒し（${route}）`
  if (!first && current) return `期限を設定（${formatShortDate(current)}）`
  return `期限を変更（${route}）`
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

function reportToMarkdown(groups: ReportGroup[], range: DateRange, mode: GroupMode, multiUser: boolean): string {
  const lines: string[] = [`# 報告 ${range.from} ～ ${range.to}`, '']
  const discussions = groups.flatMap((group) => group.rows.flatMap((row) => row.discussions))
  if (discussions.length > 0) {
    lines.push(`## 要相談（${discussions.length}件）`, '')
    for (const note of discussions) lines.push(...noteToMarkdown(note, '', true))
    lines.push('')
  }
  for (const group of groups) {
    lines.push(`## ${group.label}（${group.rows.length}件）`, '')
    for (const row of group.rows) {
      const { todo } = row
      lines.push(`### ${todo.title}（${todo.progress}%・${statusSummary(row, '・')}）`)
      lines.push(`- 期間: 開始 ${todo.start_date?.slice(0, 10) ?? '未設定'} / 期限 ${todo.due_date?.slice(0, 10) ?? '未設定'}`)
      const delta = progressDeltaText(row)
      if (delta) lines.push(`- 期間中の進捗: ${delta}`)
      const dueChange = dueChangeText(row)
      if (dueChange) lines.push(`- 期限の変更: ${dueChange}`)
      if (mode === 'assignee') lines.push(`- カテゴリ: ${todo.category_name ?? '未分類'}`)
      else if (multiUser) lines.push(`- 担当: ${assigneeText(todo)}`)
      if (row.lastReportAt) lines.push(`- 最終報告: ${formatDateTime(row.lastReportAt)}`)
      if (todo.memo.trim()) {
        lines.push('- メモ:')
        lines.push(...indentLines(todo.memo.trim(), '  '))
      }
      if (row.subTasks.length > 0) {
        lines.push('- サブタスク:')
        for (const subTask of row.subTasks) {
          const meta = [
            subTask.assignee_name,
            subTask.due_date ? `期限 ${subTask.due_date.slice(0, 10)}` : null,
            `${subTask.progress}%`
          ].filter(Boolean).join('・')
          lines.push(`  - [${subTask.done ? 'x' : ' '}] ${subTask.title}（${meta}）`)
        }
      }
      if (row.notes.length === 0) {
        lines.push('- 進捗: この期間の記録なし')
      } else {
        lines.push('- 進捗:')
        for (const note of row.notes) lines.push(...noteToMarkdown(note, '  ', false))
      }
      lines.push('')
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

function reportToCsv(groups: ReportGroup[]): string {
  const headers = ['担当', 'カテゴリ', 'タスク', 'サブタスク', '状態', '開始', '期限', '進捗(%)', '期間中の進捗', '期限の変更', '最終報告', '要相談', '期間内の進捗コメント', 'メモ']
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
        todo.start_date?.slice(0, 10) ?? '',
        todo.due_date?.slice(0, 10) ?? '',
        todo.progress,
        progressDeltaText(row) ?? '',
        dueChangeText(row) ?? '',
        row.lastReportAt ? formatDateTime(row.lastReportAt) : '',
        row.discussions.length > 0 ? `${row.discussions.length}件` : '',
        notesToPlainText(row.notes),
        todo.memo.trim()
      ])
      for (const subTask of row.subTasks) {
        rows.push([
          subTask.assignee_name ?? '',
          todo.category_name ?? '未分類',
          todo.title,
          subTask.title,
          subTask.done ? '完了' : '未完了',
          subTask.start_date?.slice(0, 10) ?? '',
          subTask.due_date?.slice(0, 10) ?? '',
          subTask.progress,
          '',
          '',
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

export function ReportView({ todos, subTasks, users, currentUser, onSelectTodo, onUpdateTodo, onUpdateSubTask, onShowToast }: Props): React.JSX.Element {
  const multiUser = users.length > 0
  const [preset, setPreset] = useState<PeriodPreset>(loadPreset)
  const [range, setRange] = useState<DateRange>(() => presetRange(PRESETS.find((item) => item.value === loadPreset())?.days ?? 7))
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readStorage(STORAGE_KEYS.groupMode) === 'category' ? 'category' : 'assignee')
  const [onlyMine, setOnlyMine] = useState(() => readStorage(STORAGE_KEYS.onlyMine) === '1')
  const [onlyNeedsReport, setOnlyNeedsReport] = useState(false)
  const [includeOldDone, setIncludeOldDone] = useState(false)
  const [onlyDiscussion, setOnlyDiscussion] = useState(false)
  const [notes, setNotes] = useState<ProgressNote[]>([])
  const [activity, setActivity] = useState<Map<string, TodoReportActivity>>(() => new Map())
  const [changes, setChanges] = useState<TodoChangeEntry[]>([])
  const [discussions, setDiscussions] = useState<ProgressNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  // デスクトップ版には担当者がいないのでカテゴリ別に固定する
  const effectiveGroupMode: GroupMode = multiUser ? groupMode : 'category'
  const effectiveOnlyMine = multiUser && currentUser != null && onlyMine

  const load = useCallback(async (): Promise<void> => {
    if (range.from > range.to) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const [nextNotes, nextActivity, nextChanges, nextDiscussions] = await Promise.all([
        window.api.progressNoteGetByRange(range.from, range.to),
        window.api.progressNoteGetLastActivity(),
        window.api.todoChangeGetByRange(range.from, range.to),
        window.api.progressNoteGetOpenDiscussions()
      ])
      if (requestId !== requestIdRef.current) return
      setNotes(nextNotes)
      setActivity(new Map(nextActivity.map((item) => [item.todo_id, item])))
      setChanges(nextChanges)
      setDiscussions(nextDiscussions)
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
    })
    return () => unsubscribe()
  }, [load])

  const applyPreset = (value: Exclude<PeriodPreset, 'custom'>): void => {
    const days = PRESETS.find((item) => item.value === value)?.days ?? 7
    setPreset(value)
    setRange(presetRange(days))
    writeStorage(STORAGE_KEYS.preset, value)
  }

  const changeGroupMode = (mode: GroupMode): void => {
    setGroupMode(mode)
    writeStorage(STORAGE_KEYS.groupMode, mode)
  }

  const changeOnlyMine = (value: boolean): void => {
    setOnlyMine(value)
    writeStorage(STORAGE_KEYS.onlyMine, value ? '1' : '0')
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

  const rows = useMemo(() => todos
    .filter((todo) => todo.status !== 'archived')
    // 期間より前に完了したタスクは既定で隠す（期間中・期間後に完了したものは報告対象）
    .filter((todo) => includeOldDone || todo.status !== 'done' || (todo.completed_at != null && isoToDateKey(todo.completed_at) >= range.from))
    .filter((todo) => !effectiveOnlyMine || isMyTask(todo, subTasksByTodo.get(todo.id) ?? [], currentUser!.id))
    .map((todo) => buildRow(
      todo,
      subTasksByTodo.get(todo.id) ?? [],
      notesByTodo.get(todo.id) ?? [],
      activity.get(todo.id),
      range,
      changesByTodo.get(todo.id) ?? [],
      discussionsByTodo.get(todo.id) ?? []
    ))
    .filter((row) => !onlyNeedsReport || needsReport(row.freshness))
    .filter((row) => !onlyDiscussion || row.discussions.length > 0),
  [activity, changesByTodo, currentUser, discussionsByTodo, effectiveOnlyMine, includeOldDone, notesByTodo, onlyDiscussion, onlyNeedsReport, range, subTasksByTodo, todos])

  const groups = useMemo(
    () => groupRows(rows, effectiveGroupMode, users, currentUser?.id ?? null),
    [currentUser, effectiveGroupMode, rows, users]
  )

  const reportedCount = rows.filter((row) => row.freshness === 'fresh').length
  const needsReportCount = rows.filter((row) => needsReport(row.freshness)).length
  const overdueCount = rows.filter((row) => isOverdue(row.todo)).length
  const noteCount = rows.reduce((sum, row) => sum + row.notes.length, 0)
  const discussionCount = rows.reduce((sum, row) => sum + row.discussions.length, 0)
  const postponedTaskCount = rows.filter((row) => row.postponedCount > 0).length

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

  // 送信中のいいね対象。連打で toggle が交錯しないようガードする
  const pendingReactionsRef = useRef<Set<string>>(new Set())

  const toggleLike = useCallback(async (
    id: string,
    action: (id: string, emoji: string) => Promise<ProgressNote>
  ): Promise<void> => {
    if (pendingReactionsRef.current.has(id)) return
    pendingReactionsRef.current.add(id)
    try {
      patchNote(await action(id, LIKE_EMOJI))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'いいねを更新できませんでした', 'error')
    } finally {
      pendingReactionsRef.current.delete(id)
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
      onShowToast(value ? '要相談にしました' : '相談済みにしました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '要相談を切り替えられませんでした', 'error')
    } finally {
      pendingReactionsRef.current.delete(key)
    }
  }, [onShowToast, patchNote])

  const updateSubTask = useCallback(async (subTask: SubTask, data: UpdateSubTaskInput, successMessage: string): Promise<boolean> => {
    try {
      await onUpdateSubTask(subTask.id, data)
      onShowToast(successMessage)
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'サブタスクを更新できませんでした', 'error')
      return false
    }
  }, [onShowToast, onUpdateSubTask])

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
    onToggleNoteLike: (noteId) => void toggleLike(noteId, (id, emoji) => window.api.progressNoteReactionToggle(id, emoji)),
    onToggleCommentLike: (commentId) => void toggleLike(commentId, (id, emoji) => window.api.progressNoteCommentReactionToggle(id, emoji)),
    onReply: replyNote,
    onToggleDiscussion: (noteId, value) => void toggleDiscussion(noteId, value),
    onUpdateTask: updateTask,
    onUpdateSubTask: updateSubTask,
    onSelectTodo,
    onShowToast
  }), [canModifyNote, createNote, deleteNote, onSelectTodo, onShowToast, replyNote, toggleDiscussion, toggleLike, updateNote, updateSubTask, updateTask])

  const handleCopyMarkdown = async (): Promise<void> => {
    try {
      await copyTextToClipboard(reportToMarkdown(groups, range, effectiveGroupMode, multiUser))
      onShowToast('Markdownをコピーしました')
    } catch {
      onShowToast('クリップボードへのコピーに失敗しました', 'error')
    }
  }

  const handleDownloadCsv = (): void => {
    downloadCsv(`report-${range.from}_${range.to}-${dateStamp()}.csv`, reportToCsv(groups))
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#0f172a' }}>
      <div style={{ padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
        {/* ─── 見出し・操作 ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: '1.15rem', color: '#f8fafc', fontWeight: 800 }}>報告</div>
            <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
              {range.from} ～ {range.to} の進捗ログを全文で表示します。ステータス・日程・進捗・メモ・進捗ログはその場で編集できます
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={groupStyle}>
              {PRESETS.map((item) => (
                <button key={item.value} onClick={() => applyPreset(item.value)} style={chipStyle(preset === item.value)}>
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

            {multiUser && (
              <div style={groupStyle}>
                <button onClick={() => changeGroupMode('assignee')} style={chipStyle(groupMode === 'assignee')}>担当者別</button>
                <button onClick={() => changeGroupMode('category')} style={chipStyle(groupMode === 'category')}>カテゴリ別</button>
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <button onClick={() => void load()} disabled={loading} style={secondaryButtonStyle}>{loading ? '更新中…' : '更新'}</button>
              <button onClick={() => void handleCopyMarkdown()} style={secondaryButtonStyle}>Markdownをコピー</button>
              <button onClick={handleDownloadCsv} style={secondaryButtonStyle}>CSV</button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {multiUser && currentUser && (
              <label style={checkboxLabelStyle}>
                <input type="checkbox" checked={onlyMine} onChange={(event) => changeOnlyMine(event.target.checked)} style={{ accentColor: '#6366f1' }} />
                自分の担当のみ（サブタスク担当を含む）
              </label>
            )}
            <label style={checkboxLabelStyle}>
              <input type="checkbox" checked={onlyNeedsReport} onChange={(event) => setOnlyNeedsReport(event.target.checked)} style={{ accentColor: '#6366f1' }} />
              期間内の報告がないタスクのみ
            </label>
            <label style={checkboxLabelStyle}>
              <input type="checkbox" checked={includeOldDone} onChange={(event) => setIncludeOldDone(event.target.checked)} style={{ accentColor: '#6366f1' }} />
              期間前に完了したタスクも表示
            </label>
            <label style={checkboxLabelStyle}>
              <input type="checkbox" checked={onlyDiscussion} onChange={(event) => setOnlyDiscussion(event.target.checked)} style={{ accentColor: '#f97316' }} />
              要相談があるタスクのみ
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={summaryChipStyle('#cbd5e1')}>対象 {rows.length}件</span>
            <span style={summaryChipStyle('#86efac')}>期間内に報告あり {reportedCount}件</span>
            <span style={summaryChipStyle(needsReportCount > 0 ? '#fde68a' : '#64748b')}>報告なし {needsReportCount}件</span>
            <span style={summaryChipStyle(overdueCount > 0 ? '#fca5a5' : '#64748b')}>期限超過 {overdueCount}件</span>
            <span style={summaryChipStyle('#93c5fd')}>進捗ログ {noteCount}件</span>
            <span style={summaryChipStyle(discussionCount > 0 ? '#fdba74' : '#64748b')}>要相談 {discussionCount}件</span>
            <span style={summaryChipStyle(postponedTaskCount > 0 ? '#fde68a' : '#64748b')}>期間中に延期 {postponedTaskCount}件</span>
          </div>
        </div>

        {loadError && (
          <div role="alert" style={{ padding: '10px 14px', border: '1px solid #b91c1c', borderRadius: 10, background: '#450a0a', color: '#fecaca', fontSize: '0.82rem' }}>
            {loadError}
          </div>
        )}

        {!loaded && !loadError && <div style={emptyStyle}>読み込み中…</div>}

        {loaded && groups.length === 0 && (
          <div style={emptyStyle}>
            {onlyNeedsReport || onlyDiscussion ? '条件に合うタスクはありません。' : '表示できるタスクがありません。左のタスク一覧の絞り込みも確認してください。'}
          </div>
        )}

        {loaded && groups.map((group) => {
          const groupNeeds = group.rows.filter((row) => needsReport(row.freshness)).length
          const groupReported = group.rows.filter((row) => row.freshness === 'fresh').length
          const groupDiscussions = group.rows
            .flatMap((row) => row.discussions)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
          return (
            <section key={`${effectiveGroupMode}:${group.key}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={groupHeaderStyle}>
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: group.color ?? '#475569', flexShrink: 0 }} />
                <span style={{ fontSize: '0.98rem', color: '#f1f5f9', fontWeight: 800 }}>{group.label}</span>
                {group.isMe && <span style={{ fontSize: '0.68rem', color: '#c7d2fe', background: '#312e81', borderRadius: 999, padding: '1px 7px' }}>自分</span>}
                <span style={{ fontSize: '0.76rem', color: '#94a3b8' }}>{group.rows.length}件</span>
                <span style={{ fontSize: '0.76rem', color: '#86efac' }}>報告あり {groupReported}</span>
                <span style={{ fontSize: '0.76rem', color: groupNeeds > 0 ? '#fde68a' : '#64748b', fontWeight: groupNeeds > 0 ? 700 : 400 }}>
                  報告なし {groupNeeds}
                </span>
                {groupDiscussions.length > 0 && (
                  <span style={{ fontSize: '0.76rem', color: '#fdba74', fontWeight: 700 }}>要相談 {groupDiscussions.length}</span>
                )}
              </div>
              {groupDiscussions.length > 0 && (
                <div style={discussionBoxStyle}>
                  <div style={{ fontSize: '0.8rem', color: '#fdba74', fontWeight: 800 }}>
                    要相談（{groupDiscussions.length}件）
                    <span style={{ marginLeft: 8, fontSize: '0.7rem', color: '#94a3b8', fontWeight: 400 }}>相談が済んだら「相談済みにする」で外します</span>
                  </div>
                  {groupDiscussions.map((note) => (
                    <InteractiveNote key={`discussion-${note.id}`} note={note} actions={actions} showTask />
                  ))}
                </div>
              )}
              {group.rows.map((row) => (
                <ReportTaskCard
                  key={row.todo.id}
                  row={row}
                  groupMode={effectiveGroupMode}
                  multiUser={multiUser}
                  isMine={currentUser != null && isMyTask(row.todo, row.subTasks, currentUser.id)}
                  onSelectTodo={onSelectTodo}
                  actions={actions}
                />
              ))}
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
  onToggleNoteLike: (noteId: string) => void
  onToggleCommentLike: (commentId: string) => void
  onReply: (noteId: string, body: string, parentCommentId: string | null) => Promise<boolean>
  onToggleDiscussion: (noteId: string, value: boolean) => void
  onUpdateTask: (todo: Todo, data: UpdateTodoInput, successMessage: string) => Promise<boolean>
  onUpdateSubTask: (subTask: SubTask, data: UpdateSubTaskInput, successMessage: string) => Promise<boolean>
  onSelectTodo: (id: string) => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

/** 報告タブ用に操作をすべて有効にした進捗ログ表示 */
function InteractiveNote({ note, actions, showTask = false }: { note: ProgressNote; actions: ReportCardActions; showTask?: boolean }): React.JSX.Element {
  return (
    <ProgressNoteThread
      note={note}
      showTask={showTask}
      onSelectTodo={actions.onSelectTodo}
      onToggleLike={actions.onToggleNoteLike}
      onToggleCommentLike={actions.onToggleCommentLike}
      onReply={actions.onReply}
      onToggleDiscussion={actions.onToggleDiscussion}
      canModify={actions.canModifyNote(note)}
      onUpdate={actions.onUpdateNote}
      onDelete={actions.onDeleteNote}
    />
  )
}

/** サブタスク1行。完了チェック・期限・進捗率（ドラッグ）をその場で変えられる */
function SubTaskRow({ subTask, actions }: { subTask: SubTask; actions: ReportCardActions }): React.JSX.Element {
  const [editingDue, setEditingDue] = useState(false)
  const [dueDraft, setDueDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const done = subTask.done === 1
  const dueColor = done ? '' : getDueDateColor(subTask.due_date)

  const run = async (data: UpdateSubTaskInput, successMessage: string): Promise<boolean> => {
    setSaving(true)
    const ok = await actions.onUpdateSubTask(subTask, data, successMessage)
    setSaving(false)
    return ok
  }

  const openDueEditor = (): void => {
    setDueDraft(subTask.due_date?.slice(0, 10) ?? '')
    setEditingDue(true)
  }

  const saveDue = async (): Promise<void> => {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 20, minHeight: 22 }}>
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
    </div>
  )
}

function ReportTaskCard({
  row,
  groupMode,
  multiUser,
  isMine,
  onSelectTodo,
  actions
}: {
  row: ReportRow
  groupMode: GroupMode
  multiUser: boolean
  isMine: boolean
  onSelectTodo: (id: string) => void
  actions: ReportCardActions
}): React.JSX.Element {
  const { todo, subTasks, notes, lastReportAt, lastMemoAt, freshness } = row
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
  const memo = todo.memo.trim()
  const progressDelta = progressDeltaText(row)
  const dueChange = dueChangeText(row)
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
            <option value="active">進行中</option>
            <option value="done">完了</option>
          </select>
          {groupMode === 'assignee' ? (
            <span style={{ ...pillStyle, color: todo.category_color ?? '#94a3b8', borderColor: `${todo.category_color ?? '#475569'}80` }}>
              {todo.category_name ?? '未分類'}
            </span>
          ) : multiUser ? (
            <span style={{ ...pillStyle, color: '#cbd5e1' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: todo.assignee_color ?? '#475569' }} />
              {todo.assignee_name ?? '未割り当て'}
            </span>
          ) : null}
          {(todo.co_assignees ?? []).length > 0 && (
            <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
              副: {(todo.co_assignees ?? []).map((assignee) => assignee.display_name).join('、')}
            </span>
          )}
        </div>

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

        <div>
          <ProgressSlider
            value={todo.progress}
            label={`${todo.title}の進捗率`}
            onCommit={(progress) => updateField({ progress }, `進捗を${progress}%に更新しました`)}
          />
          <div style={{ fontSize: '0.72rem', color: progressDeltaColor(row), marginTop: -2 }}>
            {progressDelta ? `期間中 ${progressDelta}` : '期間中の進捗の変更なし'}
          </div>
        </div>

        {subTasks.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, paddingTop: 8, borderTop: '1px dashed #1e293b' }}>
            <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
              サブタスク {subTasks.filter((subTask) => subTask.done).length}/{subTasks.length} 完了
            </div>
            {subTasks.map((subTask) => <SubTaskRow key={subTask.id} subTask={subTask} actions={actions} />)}
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
            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#fed7aa', background: '#7c2d12', border: '1px solid #c2410c', borderRadius: 999, padding: '1px 8px' }}>
              要相談 {row.discussions.length}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {!memo && !editingMemo && (
              <button onClick={openMemoEditor} style={reportButtonStyle(false)}>＋ メモを書く</button>
            )}
            {!composerOpen && (
              <button onClick={() => setComposerOpen(true)} style={reportButtonStyle(isMine)}>＋ 進捗を報告</button>
            )}
          </div>
        </div>

        {composerOpen && (
          <div style={{ background: '#111827', border: '1px solid #334155', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void submitNote()
                }
              }}
              placeholder="今週やったこと・次にやること・困っていることなど（Ctrl+Enterで投稿）"
              rows={3}
              autoFocus
              aria-label="進捗ログ"
              style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.55, minHeight: 72 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
              <label style={{ ...checkboxLabelStyle, marginRight: 'auto', color: draftNeedsDiscussion ? '#fdba74' : '#94a3b8' }}>
                <input type="checkbox" checked={draftNeedsDiscussion} onChange={(event) => setDraftNeedsDiscussion(event.target.checked)} style={{ accentColor: '#f97316' }} />
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
              {memo}
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

function summaryChipStyle(color: string): React.CSSProperties {
  return {
    fontSize: '0.76rem',
    color,
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 999,
    padding: '3px 10px',
    fontWeight: 700
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

const discussionBoxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: '#1c1210',
  border: '1px solid #9a3412',
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
