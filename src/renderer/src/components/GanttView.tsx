import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Category, CreateSubTaskInput, ProgressNote, PublicUser, SubTask, Todo, TodoDependency, TodoStatus, UpdateSubTaskInput, UpdateTodoInput } from '../types'
import { discussionBadgeStyle } from './ProgressNoteThread'
import { buildChecklistSummaries, checklistBadgeText } from '../lib/todoList'
import { autoScrollNearEdge, dropPositionOf, moveIdBy, moveIdTo, type DropPosition } from '../lib/reorder'
import { dataInk } from '../lib/theme'
import { formatShortDate } from '../lib/dueDate'
import { BEHIND_THRESHOLD_OPTIONS, DEFAULT_BEHIND_THRESHOLD_DAYS, GANTT_VIEW_SETTINGS_STORAGE_KEY, behindDaysLabel, calculateSchedule, isBehindSchedule, isScheduleTracked, type ScheduleOptions } from '../lib/scheduleHealth'

interface Props {
  todos: Todo[]
  categories: Category[]
  users?: PublicUser[]
  onSelectTodo: (id: string) => void
  onUpdateTodo: (id: string, data: UpdateTodoInput) => Promise<void>
  onReorderTodos?: (orderedIds: string[]) => Promise<void>
  onOpenSeparateWindow?: () => void
  /** タスク追加画面を開く。見出しの「＋」から開くときは、そのカテゴリ・担当を初期値にする */
  onAddTodo?: (defaults?: { categoryId?: string | null; assigneeId?: string | null }) => void
  /** タスク一覧の絞り込みの表示（見出しの横に出す） */
  listFilters?: React.ReactNode
  standalone?: boolean
  groupByCategory?: boolean
  /** 絞り込む前にタスクが1件でもあるか。1件もないときは、絞り込みの案内ではなく最初のタスクを作る案内を出す */
  hasAnyTodos?: boolean
  /** 右に詳細を開いているタスク。ガントが狭くなっても、このタスクのバーが見えるように横へ送る */
  focusTodoId?: string | null
  /** タスクをまだ読み込んでいる（「まだタスクがありません」を出さない） */
  dataLoading?: boolean
  /** 文字の大きさの倍率（設定の文字の大きさ。1 = 100%）。大きいときは左の表の幅も広げる */
  textScale?: number
  /** 知らせを出す（キーで日程を変えたときに「元に戻す」付きで知らせる） */
  onShowToast?: (message: string, type?: 'success' | 'error', action?: { label?: string; run?: () => void; key?: string }) => void
}

/** チャートの最小の高さ（これより低い窓では、ガントの画面ごとスクロールする） */
const CHART_MIN_HEIGHT = 320

interface TodoBar {
  startDate: string
  endDate: string
}

interface DatedSubTask {
  subTask: SubTask
  bar: TodoBar
}

interface ChartGroup {
  todo: Todo
  todoBar: TodoBar | null
  allSubTasks: SubTask[]
  datedSubTasks: DatedSubTask[]
  undatedSubTaskCount: number
  subTaskCount: number
  anchorDate: string | null
}

interface ChartCategorySection {
  key: CategoryFilterKey
  label: string
  color: string
  groups: ChartGroup[]
  totalCount: number
  allDone: boolean
  collapsed: boolean
}

interface InteractionState {
  targetType: 'todo' | 'subtask'
  targetId: string
  ownerTodoId: string
  mode: 'move' | 'resizeStart' | 'resizeEnd'
  originClientX: number
  originalStartDate: string
  originalEndDate: string
  previewStartDate: string
  previewEndDate: string
  moved: boolean
}

interface GanttBaselineSnapshot {
  capturedAt: string
  todos: Record<string, TodoBar>
  subTasks: Record<string, TodoBar>
}

interface TimelineUnit {
  key: string
  startDate: string
  endDate: string
  primaryLabel: string
  secondaryLabel: string
  isCurrent: boolean
  background: string
  /** 日単位のときの土日・祝日の区別（それ以外の単位では null） */
  dayKind: DayKind
  holidayName: string | null
}

interface DependencyPath {
  id: string
  path: string
}

interface DependencyDragState {
  predecessorTodoId: string
  originX: number
  originY: number
  pointerX: number
  pointerY: number
  hoverSuccessorTodoId: string | null
}

interface PanDragState {
  originClientX: number
  originScrollLeft: number
}

interface TodoScheduleSnapshot {
  id: string
  startDate: string | null
  dueDate: string | null
}

interface SubTaskScheduleSnapshot {
  id: string
  todoId: string
  startDate: string | null
  dueDate: string | null
}

interface NewSubTaskDraft {
  title: string
  startDate: string
  dueDate: string
}

interface UndoEntry {
  label: string
  run: () => Promise<void>
  /** この変更の知らせの key（「1つ戻る」で戻したら、その知らせを「元に戻しました」で置き換える） */
  toastKey?: string
}

type EditableTodoField = 'start_date' | 'due_date' | 'progress' | 'assignee_id'
type EditableSubTaskField = 'title' | 'start_date' | 'due_date' | 'progress' | 'done' | 'assignee_id'
type GanttLeftColumnKey = 'title' | 'start' | 'due' | 'progress' | 'assignee'
/** 左の表で出し入れできる列（タスク名はいつも出す） */
type GanttOptionalColumnKey = Exclude<GanttLeftColumnKey, 'title'>
type ZoomMode = 'compact' | 'normal' | 'detail' | 'focus'
type StatusFilter = 'active' | 'on_hold' | 'done' | 'all'
type TimeScale = 'day' | 'week' | 'month' | 'year'
type GroupMode = 'category' | 'assignee'
type DayKind = 'saturday' | 'sunday' | 'holiday' | null
type RangePreset = '14d' | '30d' | '90d' | null
type CategoryFilterKey = string | '__uncategorized__'
type ScheduleHealthStatus = 'done' | 'future' | 'ahead' | 'onTrack' | 'behind' | 'overdue'

interface ScheduleHealthInfo {
  status: ScheduleHealthStatus
  expectedProgress: number
  delta: number
  /** 予定より何日分遅れているか（先行しているときは負） */
  behindDays: number
  label: string
  accent: string
  background: string
  text: string
}

const NO_CATEGORY_KEY = '__uncategorized__'
/** 担当者別に並べるときのセクションのキーの接頭辞（カテゴリIDと混ざらないようにする） */
const ASSIGNEE_SECTION_PREFIX = 'assignee:'
/** 最新の進捗ログをツールチップに出すために読む期間（日） */
const PROGRESS_NOTE_LOOKBACK_DAYS = 60
const COLLAPSED_TODO_STORAGE_KEY = 'gantt-collapsed-todo-ids'
const GANTT_UNSCHEDULED_OPEN_STORAGE_KEY = 'hakobi-gantt-unscheduled-open'
const GANTT_BASELINE_STORAGE_KEY = 'gantt-baseline-snapshot'
const GANTT_SCROLL_STATE_STORAGE_KEY = 'gantt-scroll-state'
const GANTT_LEFT_COLUMN_WIDTHS_STORAGE_KEY = 'gantt-left-column-widths'
const GANTT_LEFT_VISIBLE_COLUMNS_STORAGE_KEY = 'gantt-left-visible-columns'
const OPTIONAL_LEFT_COLUMNS: GanttOptionalColumnKey[] = ['start', 'due', 'progress', 'assignee']
const PARENT_ROW_HEIGHT = 38
const SUBTASK_ROW_HEIGHT = 28
const SUBTASK_ADD_ROW_HEIGHT = 70
// タスクの間はすき間を空けず表のように続ける。すき間はカテゴリの境目だけ
const TASK_GROUP_GAP = 0
const CATEGORY_HEADER_HEIGHT = 34
const CATEGORY_GROUP_GAP = 10
const PARENT_BAR_HEIGHT = 20
const SUBTASK_BAR_HEIGHT = 14
const DEPENDENCY_HANDLE_SIZE = 10
const DEPENDENCY_TARGET_HANDLE_SIZE = 14
const DEPENDENCY_TARGET_INSET = 2
const RANGE_PADDING_DAYS = 5
const LEFT_COLUMN_GAP = 8
const LEFT_TABLE_HORIZONTAL_PADDING = 32
const LEFT_TABLE_CATEGORY_STRIPE_WIDTH = 3
const LEFT_COLUMN_DEFS: Array<{ key: GanttLeftColumnKey; label: string; min: number; max: number }> = [
  { key: 'title', label: 'タスク', min: 120, max: 520 },
  { key: 'start', label: '開始', min: 54, max: 140 },
  { key: 'due', label: '期限', min: 54, max: 140 },
  { key: 'progress', label: '進捗', min: 44, max: 120 },
  { key: 'assignee', label: '担当', min: 56, max: 220 }
]
const DEFAULT_LEFT_COLUMN_WIDTHS: GanttLeftColumnWidths = {
  // 既定では左の表にタスク名だけを出すので、名前が読める幅にする（行の「保留」「＋」のボタンの分も見込む）
  title: 220,
  start: 64,
  due: 64,
  progress: 46,
  assignee: 62
}
const UNIT_WIDTH: Record<TimeScale, Record<ZoomMode, number>> = {
  day: { compact: 28, normal: 40, detail: 56, focus: 84 },
  week: { compact: 44, normal: 60, detail: 84, focus: 120 },
  month: { compact: 64, normal: 88, detail: 120, focus: 164 },
  year: { compact: 96, normal: 128, detail: 168, focus: 216 }
}
/** 見出しの −／＋ で1段ずつ動かすズームの順番 */
const ZOOM_ORDER: ZoomMode[] = ['compact', 'normal', 'detail', 'focus']
const ZOOM_LABELS: Record<ZoomMode, string> = {
  compact: 'コンパクト',
  normal: '標準',
  detail: '詳細',
  focus: '集中'
}
const SCALE_LABELS: Record<TimeScale, string> = {
  day: '日',
  week: '週',
  month: '月',
  year: '年'
}
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']
const RANGE_PRESETS: Array<{ key: Exclude<RangePreset, null>; label: string; startOffset: number; endOffset: number }> = [
  { key: '14d', label: '14日', startOffset: -7, endOffset: 7 },
  { key: '30d', label: '30日', startOffset: -15, endOffset: 15 },
  { key: '90d', label: '90日', startOffset: -45, endOffset: 45 }
]
const GANTT_SURFACE = 'var(--c-2a2d3e)'
const GANTT_SURFACE_RAISED = 'var(--c-303449)'
const GANTT_SURFACE_PRESSED = 'var(--c-242839)'
const GANTT_SURFACE_DARK = 'var(--c-1d2030)'
const GANTT_LINE = 'color-mix(in srgb, var(--c-a3b1c6) 22%, transparent)'
const GANTT_TEXT = 'var(--c-edf2f7)'
const GANTT_MUTED = 'var(--c-bac5d8)'
// バーの塗り（--gantt-*）は、ライトでは明るい色にして、上に載せる名前（ライトでは濃い文字）を読めるようにする
const STATUS_TONE: Record<TodoStatus, { background: string; border: string; text: string; fill: string; label: string }> = {
  not_started: { background: 'var(--gantt-bar-idle)', border: 'var(--slate-300)', text: 'var(--white)', fill: 'var(--c-647181)', label: '未着手' },
  on_hold: { background: 'var(--purple-800)', border: 'var(--purple-300)', text: 'var(--purple-50)', fill: 'var(--purple-400)', label: '保留中' },
  active: { background: 'var(--gantt-bar-active)', border: 'var(--indigo-300)', text: 'var(--white)', fill: 'var(--indigo-400)', label: '進行中' },
  done: { background: 'var(--gantt-bar-done)', border: 'var(--emerald-300)', text: 'var(--white)', fill: 'var(--emerald-400)', label: '完了' },
  archived: { background: 'var(--gantt-bar-archived)', border: 'var(--slate-400)', text: 'var(--slate-200)', fill: 'var(--slate-400)', label: 'アーカイブ' }
}
/** 進捗シグナルごとのバーの色（順調=青、遅れ=橙、期限超過=赤、完了=緑、開始前=灰） */
const HEALTH_BAR_TONE: Record<ScheduleHealthStatus, { fill: string; track: string; border: string; text: string }> = {
  onTrack: { fill: 'var(--gantt-fill-blue)', track: 'color-mix(in srgb, var(--blue-900) 50.2%, transparent)', border: 'var(--blue-400)', text: 'var(--blue-50)' },
  ahead: { fill: 'var(--gantt-fill-blue)', track: 'color-mix(in srgb, var(--blue-900) 50.2%, transparent)', border: 'var(--blue-400)', text: 'var(--blue-50)' },
  behind: { fill: 'var(--gantt-fill-amber)', track: 'color-mix(in srgb, var(--amber-900) 50.2%, transparent)', border: 'var(--amber-400)', text: 'var(--amber-50)' },
  overdue: { fill: 'var(--gantt-fill-red)', track: 'color-mix(in srgb, var(--red-900) 50.2%, transparent)', border: 'var(--red-400)', text: 'var(--red-50)' },
  done: { fill: 'var(--gantt-fill-green)', track: 'color-mix(in srgb, var(--green-900) 50.2%, transparent)', border: 'var(--green-400)', text: 'var(--green-50)' },
  future: { fill: 'var(--gantt-fill-slate)', track: 'color-mix(in srgb, var(--slate-700) 50.2%, transparent)', border: 'var(--slate-400)', text: 'var(--slate-50)' }
}
const OVERDUE_HATCH = 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--red-500) 45%, transparent) 0 4px, transparent 4px 8px)'
const TODAY_LINE_COLOR = 'var(--rose-500)'
/** 「遅れ」と判定する日数の選択肢（予定より何日分以上遅れていたら遅れにするか） */
/** 親タスクの行の上に引く区切り線（タスクのまとまりが分かるように、サブタスク間より濃くする） */
const TASK_DIVIDER_COLOR = 'var(--c-3b4258)'
const SUBTASK_DIVIDER_COLOR = 'var(--c-23283a)'
/** サブタスク行の背景（親タスクより少し暗くして、配下だと分かるようにする） */
const GANTT_SUBTASK_SURFACE = 'var(--c-23263a)'

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function addDays(dateStr: string, days: number): string {
  const date = parseDateKey(dateStr)
  date.setDate(date.getDate() + days)
  return formatDateKey(date)
}

function addMonths(dateStr: string, months: number): string {
  const date = parseDateKey(startOfMonth(dateStr))
  date.setMonth(date.getMonth() + months)
  return formatDateKey(date)
}

function addYears(dateStr: string, years: number): string {
  const date = parseDateKey(startOfYear(dateStr))
  date.setFullYear(date.getFullYear() + years)
  return formatDateKey(date)
}

function startOfMonth(dateStr: string): string {
  const date = parseDateKey(dateStr)
  date.setDate(1)
  return formatDateKey(date)
}

function endOfMonth(dateStr: string): string {
  const date = parseDateKey(dateStr)
  return formatDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0))
}

function startOfYear(dateStr: string): string {
  const date = parseDateKey(dateStr)
  return formatDateKey(new Date(date.getFullYear(), 0, 1))
}

function endOfYear(dateStr: string): string {
  const date = parseDateKey(dateStr)
  return formatDateKey(new Date(date.getFullYear(), 11, 31))
}

function diffCalendarDays(dateStr: string, baseDateStr: string): number {
  return Math.round((parseDateKey(dateStr).getTime() - parseDateKey(baseDateStr).getTime()) / 86400000)
}

function diffCalendarMonths(dateStr: string, baseDateStr: string): number {
  const date = parseDateKey(dateStr)
  const base = parseDateKey(baseDateStr)
  return (date.getFullYear() - base.getFullYear()) * 12 + (date.getMonth() - base.getMonth())
}

function diffCalendarYears(dateStr: string, baseDateStr: string): number {
  return parseDateKey(dateStr).getFullYear() - parseDateKey(baseDateStr).getFullYear()
}

/** 週の始まり（月曜）。週単位の表示で使う */
function startOfWeek(dateStr: string): string {
  const date = parseDateKey(dateStr)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return formatDateKey(date)
}

function startOfUnit(dateStr: string, scale: TimeScale): string {
  if (scale === 'week') return startOfWeek(dateStr)
  if (scale === 'month') return startOfMonth(dateStr)
  if (scale === 'year') return startOfYear(dateStr)
  return dateStr.slice(0, 10)
}

function endOfUnit(dateStr: string, scale: TimeScale): string {
  if (scale === 'week') return addDays(startOfWeek(dateStr), 6)
  if (scale === 'month') return endOfMonth(dateStr)
  if (scale === 'year') return endOfYear(dateStr)
  return dateStr.slice(0, 10)
}

function addUnits(dateStr: string, scale: TimeScale, amount: number): string {
  if (scale === 'week') return addDays(dateStr, amount * 7)
  if (scale === 'month') return addMonths(dateStr, amount)
  if (scale === 'year') return addYears(dateStr, amount)
  return addDays(dateStr, amount)
}

function diffUnits(dateStr: string, baseDateStr: string, scale: TimeScale): number {
  if (scale === 'week') return Math.round(diffCalendarDays(startOfWeek(dateStr), startOfWeek(baseDateStr)) / 7)
  if (scale === 'month') return diffCalendarMonths(startOfMonth(dateStr), startOfMonth(baseDateStr))
  if (scale === 'year') return diffCalendarYears(startOfYear(dateStr), startOfYear(baseDateStr))
  return diffCalendarDays(dateStr, baseDateStr)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface PersistedGanttViewSettings {
  zoom: ZoomMode
  timeScale: TimeScale
  groupMode: GroupMode
  behindThresholdDays: number
  workingDaysOnly: boolean
  statusFilter: StatusFilter
  showSubtasks: boolean
  showOutOfRange: boolean
  showUnscheduled: boolean
  showScheduleSignals: boolean
  showBaseline: boolean
  rangeMode: 'auto' | 'manual'
  manualStart: string
  manualEnd: string
  manualPreset: RangePreset
  controlsCollapsed: boolean
  selectedCategoryKeys: CategoryFilterKey[]
}

interface PersistedGanttScrollState {
  timeScale: TimeScale
  leftDate: string | null
  leftOffset: number
  scrollLeft: number
  scrollTop: number
  unitWidth?: number
}

interface EditingTodoCell {
  todoId: string
  field: EditableTodoField
  value: string
}

interface EditingSubTaskCell {
  subTaskId: string
  field: EditableSubTaskField
  value: string
}

interface GanttLeftColumnWidths {
  title: number
  start: number
  due: number
  progress: number
  assignee: number
}

interface LeftColumnResizeState {
  column: GanttLeftColumnKey
  originClientX: number
  originalWidth: number
  /** つかんだときの文字の大きさの倍率（画面上の移動量を 100% の幅に直す） */
  scale: number
}

function leftColumnDef(key: GanttLeftColumnKey): { key: GanttLeftColumnKey; label: string; min: number; max: number } {
  return LEFT_COLUMN_DEFS.find((column) => column.key === key) ?? LEFT_COLUMN_DEFS[0]
}

function clampLeftColumnWidth(key: GanttLeftColumnKey, width: number): number {
  const column = leftColumnDef(key)
  return clamp(Math.round(width), column.min, column.max)
}

function loadGanttLeftColumnWidths(): GanttLeftColumnWidths {
  const defaults: GanttLeftColumnWidths = { ...DEFAULT_LEFT_COLUMN_WIDTHS }

  try {
    const raw = window.localStorage.getItem(GANTT_LEFT_COLUMN_WIDTHS_STORAGE_KEY)
    if (!raw) return defaults

    const parsed = JSON.parse(raw) as Partial<Record<GanttLeftColumnKey, unknown>>
    const next: GanttLeftColumnWidths = { ...defaults }
    for (const column of LEFT_COLUMN_DEFS) {
      const value = parsed[column.key]
      next[column.key] = typeof value === 'number' && Number.isFinite(value)
        ? clampLeftColumnWidth(column.key, value)
        : defaults[column.key]
    }
    return next
  } catch {
    return defaults
  }
}

// 左の表に出す列（開始・期限・進捗・担当）。既定はタスク名だけ（バーの上にも名前・担当・進捗が出るので、時間軸を広く見せる）
function loadVisibleLeftColumns(): GanttOptionalColumnKey[] {
  try {
    const raw = window.localStorage.getItem(GANTT_LEFT_VISIBLE_COLUMNS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return OPTIONAL_LEFT_COLUMNS.filter((key) => parsed.includes(key))
  } catch {
    return []
  }
}

function visibleLeftColumnDefsFor(visibleColumns: GanttOptionalColumnKey[]): typeof LEFT_COLUMN_DEFS {
  return LEFT_COLUMN_DEFS.filter((column) => column.key === 'title' || visibleColumns.includes(column.key))
}

function leftGridTemplateFor(widths: GanttLeftColumnWidths, visibleColumns: GanttOptionalColumnKey[]): string {
  return visibleLeftColumnDefsFor(visibleColumns).map((column) => `${widths[column.key]}px`).join(' ')
}

function leftTableWidthFor(widths: GanttLeftColumnWidths, visibleColumns: GanttOptionalColumnKey[]): number {
  const columns = visibleLeftColumnDefsFor(visibleColumns)
  const columnTotal = columns.reduce((total, column) => total + widths[column.key], 0)
  return columnTotal
    + LEFT_COLUMN_GAP * (columns.length - 1)
    + LEFT_TABLE_HORIZONTAL_PADDING
    + LEFT_TABLE_CATEGORY_STRIPE_WIDTH
}

function defaultGanttViewSettings(): PersistedGanttViewSettings {
  return {
    zoom: 'detail',
    timeScale: 'day',
    groupMode: 'category',
    behindThresholdDays: DEFAULT_BEHIND_THRESHOLD_DAYS,
    workingDaysOnly: false,
    statusFilter: 'active',
    showSubtasks: true,
    showOutOfRange: true,
    showUnscheduled: true,
    showScheduleSignals: true,
    showBaseline: true,
    rangeMode: 'auto',
    manualStart: '',
    manualEnd: '',
    manualPreset: null,
    controlsCollapsed: true,
    selectedCategoryKeys: []
  }
}

function loadGanttViewSettings(): PersistedGanttViewSettings {
  const defaults = defaultGanttViewSettings()

  try {
    const raw = window.localStorage.getItem(GANTT_VIEW_SETTINGS_STORAGE_KEY)
    if (!raw) return defaults

    const parsed = JSON.parse(raw) as Partial<PersistedGanttViewSettings>
    return {
      zoom: parsed.zoom === 'compact' || parsed.zoom === 'normal' || parsed.zoom === 'detail' || parsed.zoom === 'focus'
        ? parsed.zoom
        : defaults.zoom,
      timeScale: parsed.timeScale === 'day' || parsed.timeScale === 'week' || parsed.timeScale === 'month' || parsed.timeScale === 'year'
        ? parsed.timeScale
        : defaults.timeScale,
      groupMode: parsed.groupMode === 'assignee' ? 'assignee' : defaults.groupMode,
      behindThresholdDays: typeof parsed.behindThresholdDays === 'number' && BEHIND_THRESHOLD_OPTIONS.includes(parsed.behindThresholdDays)
        ? parsed.behindThresholdDays
        : defaults.behindThresholdDays,
      workingDaysOnly: typeof parsed.workingDaysOnly === 'boolean' ? parsed.workingDaysOnly : defaults.workingDaysOnly,
      statusFilter: parsed.statusFilter === 'on_hold' || parsed.statusFilter === 'active' || parsed.statusFilter === 'done' || parsed.statusFilter === 'all'
        ? parsed.statusFilter
        : defaults.statusFilter,
      showSubtasks: typeof parsed.showSubtasks === 'boolean' ? parsed.showSubtasks : defaults.showSubtasks,
      showOutOfRange: typeof parsed.showOutOfRange === 'boolean' ? parsed.showOutOfRange : defaults.showOutOfRange,
      showUnscheduled: typeof parsed.showUnscheduled === 'boolean' ? parsed.showUnscheduled : defaults.showUnscheduled,
      showScheduleSignals: typeof parsed.showScheduleSignals === 'boolean'
        ? parsed.showScheduleSignals
        : defaults.showScheduleSignals,
      showBaseline: typeof parsed.showBaseline === 'boolean' ? parsed.showBaseline : defaults.showBaseline,
      rangeMode: parsed.rangeMode === 'manual' ? 'manual' : 'auto',
      manualStart: typeof parsed.manualStart === 'string' ? parsed.manualStart : defaults.manualStart,
      manualEnd: typeof parsed.manualEnd === 'string' ? parsed.manualEnd : defaults.manualEnd,
      manualPreset: parsed.manualPreset === '14d' || parsed.manualPreset === '30d' || parsed.manualPreset === '90d'
        ? parsed.manualPreset
        : null,
      controlsCollapsed: typeof parsed.controlsCollapsed === 'boolean' ? parsed.controlsCollapsed : defaults.controlsCollapsed,
      selectedCategoryKeys: Array.isArray(parsed.selectedCategoryKeys)
        ? parsed.selectedCategoryKeys.filter((value): value is CategoryFilterKey => typeof value === 'string')
        : defaults.selectedCategoryKeys
    }
  } catch {
    return defaults
  }
}

function loadCollapsedTodoIds(): string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_TODO_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function normalizeBar(startDate: string, endDate: string): TodoBar {
  return startDate <= endDate ? { startDate, endDate } : { startDate: endDate, endDate: startDate }
}

function shiftDateByScale(dateStr: string, scale: TimeScale, amount: number): string {
  const date = parseDateKey(dateStr)

  if (scale === 'year') date.setFullYear(date.getFullYear() + amount)
  else if (scale === 'month') date.setMonth(date.getMonth() + amount)
  else if (scale === 'week') date.setDate(date.getDate() + amount * 7)
  else date.setDate(date.getDate() + amount)

  return formatDateKey(date)
}

function shiftOptionalDate(dateStr: string | null, days: number): string | null {
  return dateStr ? addDays(dateStr, days) : null
}

function shiftBarByDays(bar: TodoBar, days: number): TodoBar {
  return {
    startDate: addDays(bar.startDate, days),
    endDate: addDays(bar.endDate, days)
  }
}

function getPureScheduleShiftDays(previous: TodoScheduleSnapshot, latest: Todo | undefined): number | null {
  if (!latest) return null

  const nextStart = latest.start_date?.slice(0, 10) ?? null
  const nextDue = latest.due_date?.slice(0, 10) ?? null
  const startDelta = previous.startDate && nextStart ? diffCalendarDays(nextStart, previous.startDate) : null
  const dueDelta = previous.dueDate && nextDue ? diffCalendarDays(nextDue, previous.dueDate) : null

  if (startDelta != null && dueDelta != null) return startDelta === dueDelta && startDelta !== 0 ? startDelta : null
  if (startDelta != null && previous.dueDate == null && nextDue == null) return startDelta !== 0 ? startDelta : null
  if (dueDelta != null && previous.startDate == null && nextStart == null) return dueDelta !== 0 ? dueDelta : null

  return null
}

function isTodoBar(value: unknown): value is TodoBar {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<TodoBar>
  return typeof candidate.startDate === 'string' && typeof candidate.endDate === 'string'
}

function loadBaselineSnapshot(): GanttBaselineSnapshot | null {
  try {
    const raw = window.localStorage.getItem(GANTT_BASELINE_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<GanttBaselineSnapshot>
    if (typeof parsed.capturedAt !== 'string') return null

    const todos = Object.fromEntries(
      Object.entries(parsed.todos ?? {}).filter((entry): entry is [string, TodoBar] => isTodoBar(entry[1]))
    )
    const subTasks = Object.fromEntries(
      Object.entries(parsed.subTasks ?? {}).filter((entry): entry is [string, TodoBar] => isTodoBar(entry[1]))
    )

    return { capturedAt: parsed.capturedAt, todos, subTasks }
  } catch {
    return null
  }
}

function shortDateLabel(dateStr: string): string {
  const date = parseDateKey(dateStr)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function formatUnitLabels(unitStart: string, scale: TimeScale): Pick<TimelineUnit, 'primaryLabel' | 'secondaryLabel'> {
  const date = parseDateKey(unitStart)
  if (scale === 'week') return { primaryLabel: `${date.getMonth() + 1}月`, secondaryLabel: `${date.getDate()}〜` }
  if (scale === 'month') return { primaryLabel: String(date.getFullYear()), secondaryLabel: String(date.getMonth() + 1) }
  if (scale === 'year') return { primaryLabel: String(date.getFullYear()), secondaryLabel: '年' }
  return { primaryLabel: WEEKDAY_LABELS[date.getDay()], secondaryLabel: shortDateLabel(unitStart) }
}

function isCurrentUnit(unitStart: string, todayKey: string, scale: TimeScale): boolean {
  return startOfUnit(unitStart, scale) === startOfUnit(todayKey, scale)
}

function getUnitBackground(unitStart: string, todayKey: string, scale: TimeScale, dayKind: DayKind): string {
  if (isCurrentUnit(unitStart, todayKey, scale)) return scale === 'day' ? 'var(--rose-950)' : 'var(--blue-950)'
  if (dayKind === 'sunday' || dayKind === 'holiday') return 'color-mix(in srgb, var(--c-3f1d1d) 50.2%, transparent)'
  if (dayKind === 'saturday') return 'color-mix(in srgb, var(--c-0c2a44) 50.2%, transparent)'
  return 'transparent'
}

function getTodoBar(todo: Todo): TodoBar | null {
  const start = todo.start_date?.slice(0, 10) ?? null
  const end = todo.due_date?.slice(0, 10) ?? null
  if (!start && !end) return null
  if (start && end) {
    return start <= end ? { startDate: start, endDate: end } : { startDate: end, endDate: start }
  }
  const singleDay = start ?? end!
  return { startDate: singleDay, endDate: singleDay }
}

function localDateKeyOf(iso: string | null, fallback: string): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return fallback
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** ToDoリストは期限を持たずに続くので、開始日（なければ作った日）から今日まで（終えたリストは終えた日まで）のバーにする */
function getListTodoBar(todo: Todo, todayKey: string): TodoBar {
  const start = todo.start_date?.slice(0, 10) ?? localDateKeyOf(todo.created_at, todayKey)
  // 期限のあるリストは期限まで、期限のないリストは今日まで（終えたリストは終えた日まで）
  const end = todo.status === 'done' ? localDateKeyOf(todo.completed_at, todayKey) : todo.due_date?.slice(0, 10) ?? todayKey
  return { startDate: start, endDate: start <= end ? end : start }
}

function getSubTaskBar(subTask: SubTask): TodoBar | null {
  const start = subTask.start_date?.slice(0, 10) ?? null
  const end = subTask.due_date?.slice(0, 10) ?? null
  if (!start && !end) return null
  if (start && end) {
    return start <= end ? { startDate: start, endDate: end } : { startDate: end, endDate: start }
  }
  const singleDay = start ?? end!
  return { startDate: singleDay, endDate: singleDay }
}

function getDraftSubTaskBar(draft: NewSubTaskDraft): TodoBar | null {
  const start = draft.startDate || null
  const end = draft.dueDate || null
  if (!start && !end) return null
  if (start && end) return normalizeBar(start, end)
  const singleDay = start ?? end!
  return { startDate: singleDay, endDate: singleDay }
}

function intersectsRange(startDate: string, endDate: string, rangeStart: string, rangeEnd: string): boolean {
  return startDate <= rangeEnd && endDate >= rangeStart
}

function matchesStatusFilter(done: boolean, statusFilter: StatusFilter): boolean {
  if (statusFilter === 'all') return true
  return statusFilter === 'done' ? done : !done
}

function outOfRangeDirection(bar: TodoBar, rangeStart: string, rangeEnd: string): 'before' | 'after' | null {
  if (bar.endDate < rangeStart) return 'before'
  if (bar.startDate > rangeEnd) return 'after'
  return null
}

// 予定の進捗の計算は lib/scheduleHealth.ts と共有する（報告タブの「進捗の遅れ」と同じ判定にする）
type ScheduleHealthOptions = ScheduleOptions

function getScheduleHealth(todo: Todo, todoBar: TodoBar | null, todayKey: string, options: ScheduleHealthOptions): ScheduleHealthInfo | null {
  if (!todoBar) return null

  const progress = clamp(todo.status === 'done' ? 100 : todo.progress, 0, 100)
  const { expectedProgress, totalDays } = calculateSchedule(todoBar, todayKey, options)
  const delta = Math.round(progress - expectedProgress)
  // 予定との差を、期間の日数に換算する（例: 10日間のタスクで 25% 足りなければ 2.5日分の遅れ）
  const behindDays = ((expectedProgress - progress) / 100) * totalDays
  const daysOverdue = todo.status === 'done' || todayKey <= todoBar.endDate
    ? 0
    : diffCalendarDays(todayKey, todoBar.endDate)

  if (todo.status === 'done') {
    return { status: 'done', expectedProgress: 100, delta: 0, behindDays: 0, label: '完了', accent: 'var(--green-500)', background: 'var(--green-950)', text: 'var(--green-100)' }
  }
  // 期限のないタスク（開始日だけ）は、予定の進捗も遅れも出さない（1日だけのバーとして遅れに数えていた）
  if (!todo.due_date) return null

  if (daysOverdue > 0 && progress < 100) {
    return { status: 'overdue', expectedProgress, delta, behindDays, label: `期限を${daysOverdue}日超過`, accent: 'var(--red-500)', background: 'var(--red-950)', text: 'var(--red-200)' }
  }

  if (todayKey < todoBar.startDate && progress === 0) {
    return { status: 'future', expectedProgress, delta, behindDays, label: '開始前', accent: 'var(--slate-500)', background: 'var(--slate-900)', text: 'var(--slate-300)' }
  }

  // 遅れは、開始日と期限があり、保留中でないタスクだけ（報告タブ・チームタブと同じ。lib/scheduleHealth の isScheduleTracked）
  if (isScheduleTracked(todo) && isBehindSchedule(expectedProgress, progress, behindDays, options.behindThresholdDays)) {
    return { status: 'behind', expectedProgress, delta, behindDays, label: behindDaysLabel(behindDays), accent: 'var(--amber-500)', background: 'var(--amber-950)', text: 'var(--amber-200)' }
  }

  if (-behindDays >= options.behindThresholdDays) {
    return { status: 'ahead', expectedProgress, delta, behindDays, label: `約${Math.round(-behindDays)}日先行`, accent: 'var(--green-500)', background: 'var(--green-950)', text: 'var(--green-100)' }
  }

  return { status: 'onTrack', expectedProgress, delta, behindDays, label: '順調', accent: 'var(--sky-400)', background: 'var(--sky-950)', text: 'var(--sky-100)' }
}

function isDateKeyFormat(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function loadGanttScrollState(): PersistedGanttScrollState | null {
  try {
    const raw = window.localStorage.getItem(GANTT_SCROLL_STATE_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<PersistedGanttScrollState>
    const timeScale = parsed.timeScale === 'day' || parsed.timeScale === 'week' || parsed.timeScale === 'month' || parsed.timeScale === 'year'
      ? parsed.timeScale
      : null
    if (!timeScale) return null

    const leftDate = typeof parsed.leftDate === 'string' && isDateKeyFormat(parsed.leftDate)
      ? parsed.leftDate
      : null
    const leftOffset = typeof parsed.leftOffset === 'number' && Number.isFinite(parsed.leftOffset)
      ? Math.max(0, parsed.leftOffset)
      : 0
    const scrollLeft = typeof parsed.scrollLeft === 'number' && Number.isFinite(parsed.scrollLeft)
      ? Math.max(0, parsed.scrollLeft)
      : 0
    const scrollTop = typeof parsed.scrollTop === 'number' && Number.isFinite(parsed.scrollTop)
      ? Math.max(0, parsed.scrollTop)
      : 0
    const unitWidth = typeof parsed.unitWidth === 'number' && Number.isFinite(parsed.unitWidth) && parsed.unitWidth > 0
      ? parsed.unitWidth
      : undefined

    return {
      timeScale,
      leftDate,
      leftOffset,
      scrollLeft,
      scrollTop,
      unitWidth
    }
  } catch {
    return null
  }
}

function parentTone(todo: Todo): { background: string; border: string; text: string; fill: string; label: string } {
  return STATUS_TONE[todo.status] ?? STATUS_TONE.active
}

function subTaskTone(subTask: SubTask, todayKey: string): {
  background: string
  border: string
  text: string
  rowBackground: string
  metaText: string
  statusBackground: string
  statusText: string
  statusLabel: string
  borderStyle: 'solid' | 'dashed'
} {
  if (Boolean(subTask.done)) {
    return {
      background: 'linear-gradient(90deg, var(--gantt-sub-done-from), var(--gantt-sub-done-to))',
      border: 'var(--green-300)',
      text: 'var(--green-50)',
      rowBackground: 'var(--c-102016)',
      metaText: 'var(--green-200)',
      statusBackground: 'var(--green-900)',
      statusText: 'var(--green-100)',
      statusLabel: '完了',
      borderStyle: 'solid'
    }
  }

  const subTaskBar = getSubTaskBar(subTask)
  const overdue = subTaskBar != null && subTaskBar.endDate < todayKey

  return overdue
    ? {
      background: 'var(--c-3f1d1d)',
      border: 'var(--red-300)',
      text: 'var(--red-50)',
      rowBackground: 'var(--c-1f1315)',
      metaText: 'var(--red-200)',
      statusBackground: 'var(--red-950)',
      statusText: 'var(--red-200)',
      statusLabel: '期限超過',
      borderStyle: 'solid'
    }
    : {
      background: 'var(--slate-700)',
      border: 'var(--emerald-400)',
      text: 'var(--emerald-50)',
      rowBackground: 'var(--c-182a2a)',
      metaText: 'var(--emerald-200)',
      statusBackground: 'var(--emerald-900)',
      statusText: 'var(--green-200)',
      statusLabel: '進行中',
      borderStyle: 'solid'
    }
}

function rowTimelineStyle(height: number, unitWidth: number, timelineWidth: number, nonWorkingBackground: string | null, surface: string = GANTT_SURFACE): React.CSSProperties {
  const gridLines = `repeating-linear-gradient(to right, transparent 0, transparent ${unitWidth - 1}px, ${GANTT_LINE} ${unitWidth - 1}px, ${GANTT_LINE} ${unitWidth}px)`
  return {
    position: 'relative',
    width: timelineWidth,
    minWidth: timelineWidth,
    height,
    backgroundColor: surface,
    // 罫線を上に、土日祝の塗り（1枚の SVG）を下に重ねる
    backgroundImage: nonWorkingBackground ? `${gridLines}, ${nonWorkingBackground}` : gridLines,
    backgroundSize: nonWorkingBackground ? `auto, ${timelineWidth}px 100%` : undefined,
    backgroundRepeat: nonWorkingBackground ? 'repeat, no-repeat' : undefined,
    cursor: 'grab'
  }
}

function formatNoteDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** バーにマウスを乗せたときのツールチップ。担当・進捗・予定との差・最新の進捗ログ・要相談をまとめる */
function buildTodoBarTooltip(options: {
  todo: Todo
  bar: TodoBar
  outside: 'before' | 'after' | null
  health: ScheduleHealthInfo | null
  progress: number
  latestNote: ProgressNote | null
  lastReportAt: string | null
  discussionCount: number
  /** ToDoリストの項目の進み具合（例: 今回 3/5・残り2） */
  checklistText?: string
}): string {
  const { todo, bar, outside, health, progress, latestNote, lastReportAt, discussionCount } = options
  const assignees = [todo.assignee_name, ...(todo.co_assignees ?? []).map((item) => item.display_name)].filter(Boolean)
  const lines = todo.list_mode
    ? [
      todo.title,
      'ToDoリスト。項目は詳細か ToDo タブでチェックします',
      `担当: ${assignees.length > 0 ? assignees.join('、') : '未割り当て'}${options.checklistText ? ` ・ ${options.checklistText}` : ''}`,
      todo.status === 'done'
        ? `期間: ${shortDateLabel(bar.startDate)} → ${shortDateLabel(bar.endDate)}（終えたリスト）`
        : todo.due_date ? `期間: ${shortDateLabel(bar.startDate)} → ${shortDateLabel(bar.endDate)}` : `開始: ${shortDateLabel(bar.startDate)}・期限なし`
    ]
    : [
      todo.title,
      `状態: ${STATUS_TONE[todo.status].label}`,
      `担当: ${assignees.length > 0 ? assignees.join('、') : '未割り当て'} ・ 進捗 ${progress}%${health ? ` ・ ${health.label}` : ''}`,
      `${todo.due_date ? `期間: ${shortDateLabel(bar.startDate)} → ${shortDateLabel(bar.endDate)}` : `開始: ${shortDateLabel(bar.startDate)}・期限なし`}${outside ? `（${outside === 'before' ? '表示期間より前' : '表示期間より後'}）` : ''}`
    ]
  if (health && health.status !== 'done' && health.status !== 'future') {
    // 「順調」と判定した差（遅れとみなす日数未満）は「遅れ」と書かない
    const gapDays = (value: number): number => value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
    const gap = health.status === 'behind' || (health.status === 'overdue' && health.behindDays >= 0.5)
      ? `（約${gapDays(health.behindDays)}日分の遅れ）`
      : health.status === 'ahead' ? `（約${gapDays(-health.behindDays)}日分の先行）`
        : Math.abs(health.behindDays) >= 0.5 ? `（予定より約${gapDays(Math.abs(health.behindDays))}日分${health.behindDays > 0 ? '少なめ。遅れとみなす日数には届いていません' : '多め'}）` : ''
    lines.push(`今日時点の予定 ${health.expectedProgress}% ／ 実績 ${progress}%${gap}`)
  }
  lines.push('')
  if (latestNote) {
    const body = latestNote.body.replace(/\s+/g, ' ').trim()
    lines.push(`最新の進捗ログ（${formatNoteDateTime(latestNote.created_at)} ${latestNote.author_name ?? '自分'}）`)
    lines.push(body.length > 160 ? `${body.slice(0, 157)}…` : body)
  } else if (lastReportAt) {
    lines.push(`最終報告: ${formatNoteDateTime(lastReportAt)}`)
  } else {
    lines.push('進捗ログ: まだありません')
  }
  if (discussionCount > 0) lines.push(`要相談: ${discussionCount}件`)
  return lines.join('\n')
}

function todoMatchesQuery(todo: Todo, subTasks: SubTask[], normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  return todo.title.toLowerCase().includes(normalizedQuery)
    || todo.description.toLowerCase().includes(normalizedQuery)
    || todo.memo.toLowerCase().includes(normalizedQuery)
    || (todo.category_name?.toLowerCase().includes(normalizedQuery) ?? false)
    || (todo.assignee_name?.toLowerCase().includes(normalizedQuery) ?? false)
    || (todo.co_assignees ?? []).some((assignee) => assignee.display_name.toLowerCase().includes(normalizedQuery))
    || subTasks.some((subTask) => subTask.todo_id === todo.id && (
      subTask.title.toLowerCase().includes(normalizedQuery)
      || subTask.description.toLowerCase().includes(normalizedQuery)
      || (subTask.assignee_name?.toLowerCase().includes(normalizedQuery) ?? false)
    ))
}

function barStartLabel(dateStr: string, scale: TimeScale): string {
  if (scale === 'month') return String(parseDateKey(dateStr).getMonth() + 1)
  if (scale === 'year') return String(parseDateKey(dateStr).getFullYear())
  return shortDateLabel(dateStr)
}

function buildDependencyPath(startX: number, startY: number, endX: number, endY: number): string {
  const endHookX = endX - 10
  const endBendOffset = 12
  const horizontalGap = endX - startX

  const bendY = endY + (startY <= endY ? -endBendOffset : endBendOffset)
  const laneX = horizontalGap >= 36
    ? Math.max(startX + 22, endHookX + 10, startX + 22 + Math.abs(endY - startY) * 0.12)
    : Math.max(startX + 10, endHookX + 10)

  // 終端手前で一度Yをずらしてから右向きに入ることで、終端付近の自己重なりを防ぐ。
  return `M ${startX} ${startY} H ${laneX} V ${bendY} H ${endHookX} V ${endY} H ${endX}`
}

function areDependencyPathsEqual(previous: DependencyPath[], next: DependencyPath[]): boolean {
  if (previous.length !== next.length) return false
  return previous.every((path, index) => path.id === next[index]?.id && path.path === next[index]?.path)
}

function GanttViewContent({
  todos,
  categories,
  users = [],
  onSelectTodo,
  onUpdateTodo,
  onReorderTodos,
  onOpenSeparateWindow,
  onAddTodo,
  listFilters,
  standalone = false,
  groupByCategory = false,
  hasAnyTodos = true,
  focusTodoId = null,
  dataLoading = false,
  textScale = 1,
  onShowToast
}: Props): React.JSX.Element {
  const unscheduledSectionRef = useRef<HTMLDivElement>(null)
  const initialSettings = useMemo(() => loadGanttViewSettings(), [])
  const initialScrollState = useMemo(() => loadGanttScrollState(), [])
  const [zoom, setZoom] = useState<ZoomMode>(initialSettings.zoom)
  const [timeScale, setTimeScale] = useState<TimeScale>(initialSettings.timeScale)
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [dependencies, setDependencies] = useState<TodoDependency[]>([])
  const [interaction, setInteraction] = useState<InteractionState | null>(null)
  const [dependencyDrag, setDependencyDrag] = useState<DependencyDragState | null>(null)
  const [dependencyPaths, setDependencyPaths] = useState<DependencyPath[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialSettings.statusFilter)
  const [showSubtasks, setShowSubtasks] = useState(initialSettings.showSubtasks)
  const [showOutOfRange, setShowOutOfRange] = useState(initialSettings.showOutOfRange)
  const [showUnscheduled, setShowUnscheduled] = useState(initialSettings.showUnscheduled)
  // 未配置タスクの一覧は畳める。覚えていなければ、高さの低い窓（900px 未満）では畳んでチャートの行を多く見せる
  const [unscheduledOpen, setUnscheduledOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem(GANTT_UNSCHEDULED_OPEN_STORAGE_KEY)
      if (saved === '1' || saved === '0') return saved === '1'
    } catch { /* 読めなければ既定 */ }
    return window.innerHeight >= 900
  })
  const toggleUnscheduledOpen = useCallback((open: boolean) => {
    setUnscheduledOpen(open)
    try { window.localStorage.setItem(GANTT_UNSCHEDULED_OPEN_STORAGE_KEY, open ? '1' : '0') } catch { /* 覚えられなくても開閉はする */ }
  }, [])
  const [showScheduleSignals, setShowScheduleSignals] = useState(initialSettings.showScheduleSignals)
  const [showBaseline, setShowBaseline] = useState(initialSettings.showBaseline)
  const [rangeMode, setRangeMode] = useState<'auto' | 'manual'>(initialSettings.rangeMode)
  const [manualStart, setManualStart] = useState(initialSettings.manualStart)
  const [manualEnd, setManualEnd] = useState(initialSettings.manualEnd)
  const [manualPreset, setManualPreset] = useState<RangePreset>(initialSettings.manualPreset)
  const [controlsCollapsed, setControlsCollapsed] = useState(initialSettings.controlsCollapsed)
  // 見出しの「期限超過」「遅れ」を押したときの絞り込み（覚えない）
  const [healthFilter, setHealthFilter] = useState<'overdue' | 'behind' | null>(null)
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState<CategoryFilterKey[]>(initialSettings.selectedCategoryKeys)
  const [taskQuery, setTaskQuery] = useState('')
  const [selectedTodoIds, setSelectedTodoIds] = useState<string[]>([])
  const [collapsedTodoIds, setCollapsedTodoIds] = useState<string[]>(() => loadCollapsedTodoIds())
  const [baselineSnapshot, setBaselineSnapshot] = useState<GanttBaselineSnapshot | null>(() => loadBaselineSnapshot())
  const [dependencyDraft, setDependencyDraft] = useState<{ predecessorTodoId: string; successorTodoId: string; lagDays: string }>({ predecessorTodoId: '', successorTodoId: '', lagDays: '0' })
  const [dependencyFeedback, setDependencyFeedback] = useState<string | null>(null)
  const [lastUndoEntry, setLastUndoEntry] = useState<UndoEntry | null>(null)
  const [undoPending, setUndoPending] = useState(false)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [draggingTodoId, setDraggingTodoId] = useState<string | null>(null)
  const [dragOverTodoId, setDragOverTodoId] = useState<string | null>(null)
  const [draggingSubTaskId, setDraggingSubTaskId] = useState<string | null>(null)
  const [subTaskDropTarget, setSubTaskDropTarget] = useState<{ id: string; position: DropPosition } | null>(null)
  const [reorderPending, setReorderPending] = useState(false)
  const [reorderFeedback, setReorderFeedback] = useState<string | null>(null)
  const [dependencyLayoutVersion, setDependencyLayoutVersion] = useState(0)
  const [scrollStateReady, setScrollStateReady] = useState(false)
  const [leftColumnWidths, setLeftColumnWidths] = useState<GanttLeftColumnWidths>(() => loadGanttLeftColumnWidths())
  const [visibleLeftColumns, setVisibleLeftColumns] = useState<GanttOptionalColumnKey[]>(() => loadVisibleLeftColumns())
  const [resizingLeftColumn, setResizingLeftColumn] = useState<LeftColumnResizeState | null>(null)
  const [panDrag, setPanDrag] = useState<PanDragState | null>(null)
  const [editingTodoCell, setEditingTodoCell] = useState<EditingTodoCell | null>(null)
  const [editingTodoCellSaving, setEditingTodoCellSaving] = useState(false)
  const [editingSubTaskCell, setEditingSubTaskCell] = useState<EditingSubTaskCell | null>(null)
  const [editingSubTaskCellSaving, setEditingSubTaskCellSaving] = useState(false)
  const [collapsedCategoryKeys, setCollapsedCategoryKeys] = useState<CategoryFilterKey[]>([])
  const [addingSubTaskTodoId, setAddingSubTaskTodoId] = useState<string | null>(null)
  const [newSubTaskDraft, setNewSubTaskDraft] = useState<NewSubTaskDraft>({ title: '', startDate: '', dueDate: '' })
  const [creatingSubTask, setCreatingSubTask] = useState(false)
  const [groupMode, setGroupMode] = useState<GroupMode>(initialSettings.groupMode)
  const [behindThresholdDays, setBehindThresholdDays] = useState(initialSettings.behindThresholdDays)
  const [workingDaysOnly, setWorkingDaysOnly] = useState(initialSettings.workingDaysOnly)
  // 祝日（YYYY-MM-DD → 名前）。ライブラリが大きいので表示後に読み込む
  const [holidayNames, setHolidayNames] = useState<Map<string, string>>(() => new Map())
  // バーのツールチップ・要相談マーク用
  const [latestNoteByTodo, setLatestNoteByTodo] = useState<Map<string, ProgressNote>>(() => new Map())
  const [lastReportByTodo, setLastReportByTodo] = useState<Map<string, string>>(() => new Map())
  const [discussionCountByTodo, setDiscussionCountByTodo] = useState<Map<string, number>>(() => new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const chartCanvasRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<InteractionState | null>(null)
  const dependencyDragRef = useRef<DependencyDragState | null>(null)
  const dependencySourceHandleRefs = useRef(new Map<string, HTMLDivElement>())
  const dependencyTargetBarRefs = useRef(new Map<string, HTMLDivElement>())
  const suppressSelectionRef = useRef(false)
  const initialScrollStateRef = useRef<PersistedGanttScrollState | null>(initialScrollState)
  const viewportScrollStateRef = useRef<PersistedGanttScrollState | null>(null)
  const jumpToTodayPendingRef = useRef(false)
  const panDragRef = useRef<PanDragState | null>(null)

  interactionRef.current = interaction
  dependencyDragRef.current = dependencyDrag
  panDragRef.current = panDrag

  // 覚えている列の幅は文字の大きさ 100% のときの幅。文字を大きくしたら同じ割合で広げる（150% でタスク名が数文字で切れないように）
  const leftColumnScale = Math.max(1, textScale)
  // ガントの幅（窓が狭い・左右のパネルを開いているときは狭い）。左の表がその 4 割を超えるときは、タスク名の列を縮める
  // （狭い窓で、日付が 1〜2 列しか見えなくならないように）
  const [chartAreaWidth, setChartAreaWidth] = useState(0)
  const observedChartRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = scrollRef.current
    if (element === observedChartRef.current) return
    observedChartRef.current = element
    if (!element || typeof ResizeObserver === 'undefined') return
    setChartAreaWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setChartAreaWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  })
  const displayedLeftColumnWidths = useMemo<GanttLeftColumnWidths>(() => {
    const scaled = leftColumnScale === 1
      ? leftColumnWidths
      : Object.fromEntries(Object.entries(leftColumnWidths).map(([key, width]) => [key, Math.round(width * leftColumnScale)])) as unknown as GanttLeftColumnWidths
    if (chartAreaWidth <= 0) return scaled
    const overflow = leftTableWidthFor(scaled, visibleLeftColumns) - Math.round(chartAreaWidth * 0.4)
    if (overflow <= 0) return scaled
    return { ...scaled, title: Math.max(Math.round(150 * leftColumnScale), scaled.title - overflow) }
  }, [chartAreaWidth, leftColumnScale, leftColumnWidths, visibleLeftColumns])
  // タスク名の列が狭いときは、行の「保留」「＋」をマウスを乗せたとき・キーボードで選んだときだけ出す（名前の場所を空ける）
  const compactRowTools = displayedLeftColumnWidths.title < 200
  const leftGridTemplate = useMemo(() => leftGridTemplateFor(displayedLeftColumnWidths, visibleLeftColumns), [displayedLeftColumnWidths, visibleLeftColumns])
  const leftTableWidth = useMemo(() => leftTableWidthFor(displayedLeftColumnWidths, visibleLeftColumns), [displayedLeftColumnWidths, visibleLeftColumns])
  const visibleLeftColumnDefs = useMemo(() => visibleLeftColumnDefsFor(visibleLeftColumns), [visibleLeftColumns])
  // 行の左の表は5つの欄を同じ順で並べている。出さない列は CSS で隠し、残りが表示中の列の幅に入る
  const leftGridAttributes = useMemo(() => ({
    className: 'tarbo-gantt-left-grid',
    'data-hidden-columns': OPTIONAL_LEFT_COLUMNS.filter((key) => !visibleLeftColumns.includes(key)).join(' ')
  }), [visibleLeftColumns])

  const loadGanttData = useCallback(async (): Promise<void> => {
    // 更新中もチャートを残し、バーの編集や同期でスクロール領域を作り直さない。
    try {
      const [nextSubTasks, nextDependencies] = await Promise.all([
        window.api.subtaskGetAll(),
        window.api.todoDependencyGetAll()
      ])
      setSubTasks(nextSubTasks)
      setDependencies(nextDependencies)
    } catch {
      setSubTasks([])
      setDependencies([])
    } finally {
      setLoading(false)
    }
  }, [])

  const loadProgressSignals = useCallback(async (): Promise<void> => {
    try {
      const today = getTodayKey()
      const [notes, discussions, activity] = await Promise.all([
        window.api.progressNoteGetByRange(addDays(today, -PROGRESS_NOTE_LOOKBACK_DAYS), today),
        window.api.progressNoteGetOpenDiscussions(),
        window.api.progressNoteGetLastActivity()
      ])
      const latest = new Map<string, ProgressNote>()
      for (const note of notes) {
        const current = latest.get(note.todo_id)
        if (!current || note.created_at > current.created_at) latest.set(note.todo_id, note)
      }
      const discussionCounts = new Map<string, number>()
      for (const note of discussions) discussionCounts.set(note.todo_id, (discussionCounts.get(note.todo_id) ?? 0) + 1)
      const lastReports = new Map<string, string>()
      for (const item of activity) {
        const last = [item.last_note_at, item.last_memo_at].filter((value): value is string => Boolean(value)).sort().pop()
        if (last) lastReports.set(item.todo_id, last)
      }
      setLatestNoteByTodo(latest)
      setDiscussionCountByTodo(discussionCounts)
      setLastReportByTodo(lastReports)
    } catch {
      // ツールチップと要相談マークのための補助情報なので、取れなくてもガントは表示する
    }
  }, [])

  useEffect(() => {
    void loadGanttData()
    void loadProgressSignals()
  }, [loadGanttData, loadProgressSignals])

  useEffect(() => {
    const unsubscribe = window.api.onDataChanged((scope) => {
      // 進捗ログの投稿・要相談はバーの形に影響しないので、ツールチップ用の情報だけ取り直す
      if (scope === 'progress') {
        void loadProgressSignals()
        return
      }
      void loadGanttData()
      if (scope === 'todo') void loadProgressSignals()
    })
    return () => unsubscribe()
  }, [loadGanttData, loadProgressSignals])

  useEffect(() => {
    let cancelled = false
    void import('@holiday-jp/holiday_jp')
      .then((module) => {
        const library = ((module as { default?: unknown }).default ?? module) as { holidays: Record<string, { name: string }> }
        if (cancelled) return
        setHolidayNames(new Map(Object.entries(library.holidays).map(([date, holiday]) => [date, holiday.name])))
      })
      .catch(() => {
        // 祝日が読めなくても土日の塗り分けだけで表示する
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setSelectedTodoIds((previous) => previous.filter((id) => todos.some((todo) => todo.id === id)))
  }, [todos])

  useEffect(() => {
    setDependencyDraft((previous) => ({
      predecessorTodoId: todos.some((todo) => todo.id === previous.predecessorTodoId) ? previous.predecessorTodoId : '',
      successorTodoId: todos.some((todo) => todo.id === previous.successorTodoId) ? previous.successorTodoId : '',
      lagDays: previous.lagDays
    }))
  }, [todos])

  useEffect(() => {
    setCollapsedTodoIds((previous) => previous.filter((id) => todos.some((todo) => todo.id === id)))
  }, [todos])

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_TODO_STORAGE_KEY, JSON.stringify(collapsedTodoIds))
  }, [collapsedTodoIds])

  useEffect(() => {
    if (!baselineSnapshot) {
      window.localStorage.removeItem(GANTT_BASELINE_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(GANTT_BASELINE_STORAGE_KEY, JSON.stringify(baselineSnapshot))
  }, [baselineSnapshot])

  useEffect(() => {
    const nextSettings: PersistedGanttViewSettings = {
      zoom,
      timeScale,
      groupMode,
      behindThresholdDays,
      workingDaysOnly,
      statusFilter,
      showSubtasks,
      showOutOfRange,
      showUnscheduled,
      showScheduleSignals,
      showBaseline,
      rangeMode,
      manualStart,
      manualEnd,
      manualPreset,
      controlsCollapsed,
      selectedCategoryKeys
    }

    window.localStorage.setItem(GANTT_VIEW_SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))
  }, [
    behindThresholdDays,
    controlsCollapsed,
    groupMode,
    manualEnd,
    manualPreset,
    manualStart,
    rangeMode,
    selectedCategoryKeys,
    showBaseline,
    showScheduleSignals,
    showSubtasks,
    showOutOfRange,
    showUnscheduled,
    statusFilter,
    timeScale,
    workingDaysOnly,
    zoom
  ])

  useEffect(() => {
    window.localStorage.setItem(GANTT_LEFT_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(leftColumnWidths))
    setDependencyLayoutVersion((previous) => previous + 1)
  }, [leftColumnWidths])

  // 左の表の列を出し入れすると時間軸の位置が動くので、依存関係の線も引き直す
  useEffect(() => {
    window.localStorage.setItem(GANTT_LEFT_VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(visibleLeftColumns))
    setDependencyLayoutVersion((previous) => previous + 1)
  }, [visibleLeftColumns])

  useEffect(() => {
    if (!resizingLeftColumn) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent): void => {
      // 画面上の移動量を、文字の大きさ 100% のときの幅に直して覚える
      const nextWidth = clampLeftColumnWidth(
        resizingLeftColumn.column,
        Math.round(resizingLeftColumn.originalWidth + (event.clientX - resizingLeftColumn.originClientX) / resizingLeftColumn.scale)
      )
      setLeftColumnWidths((previous) => (
        previous[resizingLeftColumn.column] === nextWidth
          ? previous
          : { ...previous, [resizingLeftColumn.column]: nextWidth }
      ))
    }

    const handlePointerUp = (): void => {
      setResizingLeftColumn(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [resizingLeftColumn])

  useEffect(() => {
    if (!panDrag) return
    const container = scrollRef.current
    if (!container) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event: PointerEvent): void => {
      const current = panDragRef.current
      if (!current) return
      container.scrollLeft = current.originScrollLeft - (event.clientX - current.originClientX)
    }

    const handlePointerUp = (): void => {
      setPanDrag(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [panDrag])

  useEffect(() => {
    setSelectedCategoryKeys((previous) => previous.filter((key) => {
      if (key === NO_CATEGORY_KEY) return todos.some((todo) => !todo.category_id)
      return categories.some((category) => category.id === key)
    }))
  }, [categories, todos])

  useEffect(() => {
    setCollapsedCategoryKeys((previous) => previous.filter((key) => {
      if (key.startsWith(ASSIGNEE_SECTION_PREFIX)) return true
      if (key === NO_CATEGORY_KEY) return todos.some((todo) => !todo.category_id)
      return categories.some((category) => category.id === key)
    }))
  }, [categories, todos])

  useEffect(() => {
    if (!addingSubTaskTodoId || todos.some((todo) => todo.id === addingSubTaskTodoId)) return
    setAddingSubTaskTodoId(null)
    setNewSubTaskDraft({ title: '', startDate: '', dueDate: '' })
  }, [addingSubTaskTodoId, todos])

  useEffect(() => {
    const handleResize = (): void => {
      setDependencyLayoutVersion((previous) => previous + 1)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const todayKey = getTodayKey()
  const unitWidth = Math.round(UNIT_WIDTH[timeScale][zoom] * Math.max(1, textScale))
  const isTimelineEditable = !isReorderMode
  const normalizedTaskQuery = taskQuery.trim().toLowerCase()

  const beginLeftColumnResize = useCallback((column: GanttLeftColumnKey, event: React.PointerEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setEditingTodoCell(null)
    setEditingSubTaskCell(null)
    setResizingLeftColumn({
      column,
      originClientX: event.clientX,
      originalWidth: leftColumnWidths[column],
      scale: leftColumnScale
    })
  }, [leftColumnScale, leftColumnWidths])

  const beginPan = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.button !== 0) return
    const container = scrollRef.current
    if (!container) return
    setPanDrag({ originClientX: event.clientX, originScrollLeft: container.scrollLeft })
  }, [])

  const stepZoom = useCallback((direction: -1 | 1) => {
    setZoom((previous) => ZOOM_ORDER[clamp(ZOOM_ORDER.indexOf(previous) + direction, 0, ZOOM_ORDER.length - 1)])
  }, [])

  const applyManualPreset = useCallback((preset: Exclude<RangePreset, null>) => {
    const config = RANGE_PRESETS.find((item) => item.key === preset)
    if (!config) return
    setRangeMode('manual')
    setManualPreset(preset)
    setManualStart(addDays(todayKey, config.startOffset))
    setManualEnd(addDays(todayKey, config.endOffset))
  }, [todayKey])

  useEffect(() => {
    if (!isReorderMode) return
    setInteraction(null)
    setDependencyDrag(null)
  }, [isReorderMode])

  useEffect(() => {
    if (isReorderMode) return
    setDraggingTodoId(null)
    setDragOverTodoId(null)
  }, [isReorderMode])

  useEffect(() => {
    if (!isReorderMode) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key !== 'Escape') return
      const target = event.target
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      setIsReorderMode(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isReorderMode])

  const categoryOptions = useMemo(() => {
    const usedCategoryIds = new Set(todos.map((todo) => todo.category_id).filter((value): value is string => Boolean(value)))
    const next = categories
      .filter((category) => usedCategoryIds.has(category.id))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name, 'ja'))
      .map((category) => ({
        key: category.id as CategoryFilterKey,
        label: category.name,
        color: category.color
      }))

    if (todos.some((todo) => !todo.category_id)) {
      next.push({ key: NO_CATEGORY_KEY, label: '未分類', color: 'var(--text-subtle)' })
    }

    return next
  }, [categories, todos])

  const assigneeOptions = useMemo(() => (
    users
      .filter((user) => user.is_active !== 0)
      .slice()
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'))
  ), [users])

  const categoryFilteredTodos = useMemo(() => (
    todos.filter((todo) => {
      if (selectedCategoryKeys.length === 0) return true
      const key = (todo.category_id ?? NO_CATEGORY_KEY) as CategoryFilterKey
      return selectedCategoryKeys.includes(key)
    })
  ), [selectedCategoryKeys, todos])

  const todoOrderById = useMemo(() => new Map(todos.map((todo, index) => [todo.id, index])), [todos])

  const todoSelectionCandidates = useMemo(() => (
    categoryFilteredTodos
      .filter((todo) => todoMatchesQuery(todo, subTasks, normalizedTaskQuery))
      .sort((a, b) => (todoOrderById.get(a.id) ?? 0) - (todoOrderById.get(b.id) ?? 0) || a.title.localeCompare(b.title, 'ja'))
  ), [categoryFilteredTodos, normalizedTaskQuery, subTasks, todoOrderById])
  const todoById = useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos])
  const subTaskById = useMemo(() => new Map(subTasks.map((subTask) => [subTask.id, subTask])), [subTasks])

  useEffect(() => {
    if (!editingTodoCell) return
    if (!todoById.has(editingTodoCell.todoId)) setEditingTodoCell(null)
  }, [editingTodoCell, todoById])

  useEffect(() => {
    if (!editingSubTaskCell) return
    if (!subTaskById.has(editingSubTaskCell.subTaskId)) setEditingSubTaskCell(null)
  }, [editingSubTaskCell, subTaskById])

  const beginTodoCellEdit = useCallback((todo: Todo, field: EditableTodoField): void => {
    if (isReorderMode || editingTodoCellSaving) return

    const value = field === 'start_date'
        ? todo.start_date?.slice(0, 10) ?? ''
        : field === 'due_date'
          ? todo.due_date?.slice(0, 10) ?? ''
          : field === 'progress'
            ? String(clamp(todo.status === 'done' ? 100 : todo.progress, 0, 100))
            : todo.assignee_id ?? ''

    setEditingSubTaskCell(null)
    setEditingTodoCell({ todoId: todo.id, field, value })
  }, [editingTodoCellSaving, isReorderMode])

  const cancelTodoCellEdit = useCallback((): void => {
    setEditingTodoCell(null)
  }, [])

  const commitTodoCellEdit = useCallback(async (): Promise<void> => {
    const edit = editingTodoCell
    if (!edit || editingTodoCellSaving) return

    const todo = todoById.get(edit.todoId)
    if (!todo) {
      setEditingTodoCell(null)
      return
    }

    const update: UpdateTodoInput = {}
    if (edit.field === 'start_date') {
      const next = edit.value || null
      const current = todo.start_date?.slice(0, 10) ?? null
      if (next === current) {
        setEditingTodoCell(null)
        return
      }
      update.start_date = next
    } else if (edit.field === 'due_date') {
      const next = edit.value || null
      const current = todo.due_date?.slice(0, 10) ?? null
      if (next === current) {
        setEditingTodoCell(null)
        return
      }
      update.due_date = next
    } else if (edit.field === 'progress') {
      const progress = clamp(Math.round(Number(edit.value)), 0, 100)
      if (!Number.isFinite(progress) || progress === todo.progress) {
        setEditingTodoCell(null)
        return
      }
      update.progress = progress
    } else {
      const next = edit.value || null
      if (next === todo.assignee_id) {
        setEditingTodoCell(null)
        return
      }
      update.assignee_id = next
    }

    setEditingTodoCellSaving(true)
    setEditingTodoCell(null)
    try {
      await onUpdateTodo(todo.id, update)
    } finally {
      setEditingTodoCellSaving(false)
    }
  }, [editingTodoCell, editingTodoCellSaving, onUpdateTodo, todoById])

  const handleTodoCellEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>): void => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitTodoCellEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelTodoCellEdit()
    }
  }, [cancelTodoCellEdit, commitTodoCellEdit])

  const beginSubTaskCellEdit = useCallback((subTask: SubTask, field: EditableSubTaskField): void => {
    if (isReorderMode || editingSubTaskCellSaving) return

    const value = field === 'title'
      ? subTask.title
      : field === 'start_date'
        ? subTask.start_date?.slice(0, 10) ?? ''
        : field === 'due_date'
          ? subTask.due_date?.slice(0, 10) ?? ''
          : field === 'progress'
            ? String(clamp(Boolean(subTask.done) ? 100 : subTask.progress ?? 0, 0, 100))
          : field === 'done'
            ? Boolean(subTask.done) ? 'done' : 'active'
            : subTask.assignee_id ?? ''

    setEditingTodoCell(null)
    setEditingSubTaskCell({ subTaskId: subTask.id, field, value })
  }, [editingSubTaskCellSaving, isReorderMode])

  const cancelSubTaskCellEdit = useCallback((): void => {
    setEditingSubTaskCell(null)
  }, [])

  const commitSubTaskCellEdit = useCallback(async (): Promise<void> => {
    const edit = editingSubTaskCell
    if (!edit || editingSubTaskCellSaving) return

    const subTask = subTaskById.get(edit.subTaskId)
    if (!subTask) {
      setEditingSubTaskCell(null)
      return
    }

    const update: UpdateSubTaskInput = {}
    if (edit.field === 'title') {
      const title = edit.value.trim()
      if (!title || title === subTask.title) {
        setEditingSubTaskCell(null)
        return
      }
      update.title = title
    } else if (edit.field === 'start_date') {
      const next = edit.value || null
      const current = subTask.start_date?.slice(0, 10) ?? null
      if (next === current) {
        setEditingSubTaskCell(null)
        return
      }
      update.start_date = next
    } else if (edit.field === 'due_date') {
      const next = edit.value || null
      const current = subTask.due_date?.slice(0, 10) ?? null
      if (next === current) {
        setEditingSubTaskCell(null)
        return
      }
      update.due_date = next
    } else if (edit.field === 'progress') {
      const progress = clamp(Math.round(Number(edit.value)), 0, 100)
      const current = clamp(Boolean(subTask.done) ? 100 : subTask.progress ?? 0, 0, 100)
      if (!Number.isFinite(progress) || progress === current) {
        setEditingSubTaskCell(null)
        return
      }
      update.progress = progress
    } else if (edit.field === 'done') {
      const done = edit.value === 'done'
      if (done === Boolean(subTask.done)) {
        setEditingSubTaskCell(null)
        return
      }
      update.done = done
    } else {
      const next = edit.value || null
      if (next === subTask.assignee_id) {
        setEditingSubTaskCell(null)
        return
      }
      update.assignee_id = next
    }

    setEditingSubTaskCellSaving(true)
    setEditingSubTaskCell(null)
    try {
      const updated = await window.api.subtaskUpdate(subTask.id, update)
      setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item))
    } finally {
      setEditingSubTaskCellSaving(false)
    }
  }, [editingSubTaskCell, editingSubTaskCellSaving, subTaskById])

  const handleSubTaskCellEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>): void => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitSubTaskCellEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelSubTaskCellEdit()
    }
  }, [cancelSubTaskCellEdit, commitSubTaskCellEdit])

  const ganttTodos = useMemo(() => (
    todoSelectionCandidates.filter((todo) => selectedTodoIds.length === 0 || selectedTodoIds.includes(todo.id))
  ), [selectedTodoIds, todoSelectionCandidates])

  const groups = useMemo(() => {
    const subTasksByTodo = new Map<string, SubTask[]>()

    for (const subTask of subTasks) {
      const current = subTasksByTodo.get(subTask.todo_id)
      if (current) current.push(subTask)
      else subTasksByTodo.set(subTask.todo_id, [subTask])
    }

    return ganttTodos.map((todo) => {
      const todoSubTasks = (subTasksByTodo.get(todo.id) ?? []).slice().sort((a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at)
      )

      const todoBar = todo.list_mode ? getListTodoBar(todo, todayKey) : getTodoBar(todo)
      const datedSubTasks = todoSubTasks
        .map((subTask) => {
          const bar = getSubTaskBar(subTask)
          return bar ? { subTask, bar } : null
        })
        .filter((item): item is DatedSubTask => Boolean(item))

      const anchorCandidates = [todoBar?.startDate, ...datedSubTasks.map((item) => item.bar.startDate)]
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => a.localeCompare(b))

      return {
        todo,
        todoBar,
        allSubTasks: todoSubTasks,
        datedSubTasks,
        undatedSubTaskCount: todoSubTasks.length - datedSubTasks.length,
        subTaskCount: todoSubTasks.length,
        anchorDate: anchorCandidates[0] ?? null
      }
    })
  }, [ganttTodos, subTasks, todayKey])

  const filteredGroups = useMemo(() => {
    return groups.map((group): ChartGroup | null => {
      if (statusFilter === 'on_hold' && group.todo.status !== 'on_hold') return null
      const parentMatches = statusFilter === 'on_hold' || matchesStatusFilter(group.todo.status === 'done', statusFilter)
      const matchingSubTasks = showSubtasks
        ? group.allSubTasks.filter((subTask) => statusFilter === 'on_hold' || matchesStatusFilter(Boolean(subTask.done), statusFilter))
        : []
      if (!parentMatches && matchingSubTasks.length === 0) return null

      const matchingIds = new Set(matchingSubTasks.map((subTask) => subTask.id))
      const datedSubTasks = group.datedSubTasks.filter((item) => matchingIds.has(item.subTask.id))
      const todoBar = parentMatches ? group.todoBar : null
      const anchorCandidates = [todoBar?.startDate, ...datedSubTasks.map((item) => item.bar.startDate)]
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => a.localeCompare(b))

      return {
        ...group,
        todoBar,
        allSubTasks: matchingSubTasks,
        datedSubTasks,
        undatedSubTaskCount: matchingSubTasks.length - datedSubTasks.length,
        subTaskCount: matchingSubTasks.length,
        anchorDate: anchorCandidates[0] ?? null
      }
    }).filter((group): group is ChartGroup => Boolean(group))
  }, [groups, showSubtasks, statusFilter])

  const scheduledGroups = useMemo(() => (
    filteredGroups
      .filter((group) => group.todoBar || group.datedSubTasks.length > 0)
      .sort((a, b) => {
        const aOrder = todoOrderById.get(a.todo.id) ?? 0
        const bOrder = todoOrderById.get(b.todo.id) ?? 0
        if (aOrder !== bOrder) return aOrder - bOrder
        const aAnchor = a.anchorDate ?? '9999-12-31'
        const bAnchor = b.anchorDate ?? '9999-12-31'
        if (aAnchor !== bAnchor) return aAnchor.localeCompare(bAnchor)
        if (b.todo.priority !== a.todo.priority) return b.todo.priority - a.todo.priority
        return a.todo.title.localeCompare(b.todo.title, 'ja')
      })
  ), [filteredGroups, todoOrderById])

  const unscheduledGroups = useMemo(() => (
    filteredGroups
      .filter((group) => !group.todoBar && group.datedSubTasks.length === 0)
      .sort((a, b) => {
        const aOrder = todoOrderById.get(a.todo.id) ?? 0
        const bOrder = todoOrderById.get(b.todo.id) ?? 0
        if (aOrder !== bOrder) return aOrder - bOrder
        return b.todo.priority - a.todo.priority || a.todo.title.localeCompare(b.todo.title, 'ja')
      })
  ), [filteredGroups, todoOrderById])

  const autoStartBase = scheduledGroups[0]?.anchorDate ?? addDays(todayKey, -7)
  const autoEndBase = scheduledGroups.reduce((latest, group) => {
    let candidate = latest
    if (group.todoBar && group.todoBar.endDate > candidate) candidate = group.todoBar.endDate
    for (const subTask of group.datedSubTasks) {
      if (subTask.bar.endDate > candidate) candidate = subTask.bar.endDate
    }
    return candidate
  }, scheduledGroups[0]?.todoBar?.endDate ?? scheduledGroups[0]?.anchorDate ?? addDays(todayKey, 21))
  const autoStart = autoStartBase <= todayKey ? autoStartBase : todayKey
  const autoEnd = autoEndBase >= todayKey ? autoEndBase : todayKey

  const rangeStart = rangeMode === 'manual' && manualStart ? manualStart : addDays(autoStart, -RANGE_PADDING_DAYS)
  const rangeEnd = rangeMode === 'manual' && manualEnd ? manualEnd : addDays(autoEnd, RANGE_PADDING_DAYS)
  const normalizedRange = rangeStart <= rangeEnd
    ? { start: rangeStart, end: rangeEnd }
    : { start: rangeEnd, end: rangeStart }

  const shiftVisibleRange = useCallback((direction: -1 | 1) => {
    const currentStart = rangeMode === 'manual' && manualStart ? manualStart : normalizedRange.start
    const currentEnd = rangeMode === 'manual' && manualEnd ? manualEnd : normalizedRange.end
    const span = Math.max(diffCalendarDays(currentEnd, currentStart), 0) + 1
    setRangeMode('manual')
    setManualPreset(null)
    setManualStart(addDays(currentStart, direction * span))
    setManualEnd(addDays(currentEnd, direction * span))
  }, [manualEnd, manualStart, normalizedRange.end, normalizedRange.start, rangeMode])

  const centerRangeOnToday = useCallback(() => {
    const currentStart = rangeMode === 'manual' && manualStart ? manualStart : normalizedRange.start
    const currentEnd = rangeMode === 'manual' && manualEnd ? manualEnd : normalizedRange.end
    const span = Math.max(diffCalendarDays(currentEnd, currentStart), 0)
    const before = Math.floor(span / 2)
    const after = span - before
    setRangeMode('manual')
    setManualPreset(null)
    setManualStart(addDays(todayKey, -before))
    setManualEnd(addDays(todayKey, after))
  }, [manualEnd, manualStart, normalizedRange.end, normalizedRange.start, rangeMode, todayKey])

  const rangeChartGroups = useMemo<ChartGroup[]>(() => (
    scheduledGroups
      .map((group) => ({
        ...group,
        datedSubTasks: showOutOfRange
          ? group.datedSubTasks
          : group.datedSubTasks.filter((item) => intersectsRange(item.bar.startDate, item.bar.endDate, normalizedRange.start, normalizedRange.end))
      }))
      .filter((group) => {
        const todoVisible = group.todoBar
          ? showOutOfRange || intersectsRange(group.todoBar.startDate, group.todoBar.endDate, normalizedRange.start, normalizedRange.end)
          : false
        const subTaskVisible = showSubtasks && group.datedSubTasks.length > 0
        return todoVisible || subTaskVisible
      })
  ), [normalizedRange.end, normalizedRange.start, scheduledGroups, showOutOfRange, showSubtasks])

  // 「期限超過」「遅れ」のチップの件数と絞り込み。件数は絞り込む前の行で数える（押しても、もう一方の件数が消えないように）
  const rangeHealthByTodoId = useMemo(() => new Map(rangeChartGroups.map((group) => [
    group.todo.id,
    // ToDoリストは進捗率を使わないので、遅れ・期限超過の判定はしない
    group.todo.list_mode ? null : getScheduleHealth(group.todo, group.todoBar, todayKey, { behindThresholdDays, workingDaysOnly, holidayNames })
  ])), [behindThresholdDays, holidayNames, rangeChartGroups, todayKey, workingDaysOnly])
  const healthChipCounts = useMemo(() => {
    const counts = { overdue: 0, behind: 0 }
    for (const health of rangeHealthByTodoId.values()) {
      if (health?.status === 'overdue') counts.overdue += 1
      else if (health?.status === 'behind') counts.behind += 1
    }
    return counts
  }, [rangeHealthByTodoId])
  // 右に詳細を開いているタスクは、絞り込みの条件から外れても残す（期限を延ばして「遅れ」でなくなった行が、黙って消えないように）
  const displayedRangeGroups = useMemo(() => (
    healthFilter && showScheduleSignals
      ? rangeChartGroups.filter((group) => rangeHealthByTodoId.get(group.todo.id)?.status === healthFilter || group.todo.id === focusTodoId)
      : rangeChartGroups
  ), [focusTodoId, healthFilter, rangeChartGroups, rangeHealthByTodoId, showScheduleSignals])

  // 担当者別はサーバー版（メンバーがいる）だけ。カテゴリで絞り込み中でも担当者別には分けられる
  const sectionGrouping: 'category' | 'assignee' | 'none' = groupMode === 'assignee' && users.length > 0
    ? 'assignee'
    : groupByCategory ? 'category' : 'none'

  const chartSections = useMemo<ChartCategorySection[]>(() => {
    const makeSection = (key: CategoryFilterKey, label: string, color: string, groups: ChartGroup[]): ChartCategorySection => ({
      key,
      label,
      color,
      groups,
      totalCount: groups.length,
      allDone: groups.length > 0 && groups.every((group) => group.todo.status === 'done'),
      collapsed: sectionGrouping !== 'none' && collapsedCategoryKeys.includes(key)
    })

    if (sectionGrouping === 'none') {
      return [makeSection('__all__' as CategoryFilterKey, 'すべて', 'var(--indigo-500)', displayedRangeGroups)]
    }

    if (sectionGrouping === 'assignee') {
      // 担当者はユーザー一覧の順（報告タブと同じ）。未割り当ては最後
      const userOrder = new Map(users.map((user, index) => [user.id, { user, index }]))
      const groupsByKey = new Map<string, ChartGroup[]>()
      for (const group of displayedRangeGroups) {
        const key = `${ASSIGNEE_SECTION_PREFIX}${group.todo.assignee_id ?? ''}`
        const current = groupsByKey.get(key)
        if (current) current.push(group)
        else groupsByKey.set(key, [group])
      }
      return [...groupsByKey.entries()]
        .map(([key, groups]) => {
          const userId = key.slice(ASSIGNEE_SECTION_PREFIX.length)
          const entry = userId ? userOrder.get(userId) : undefined
          const label = userId ? entry?.user.display_name ?? groups[0].todo.assignee_name ?? '不明なユーザー' : '未割り当て'
          const color = userId ? entry?.user.color ?? groups[0].todo.assignee_color ?? 'var(--slate-500)' : 'var(--slate-500)'
          return { section: makeSection(key as CategoryFilterKey, label, color, groups), rank: userId ? entry?.index ?? users.length : Number.MAX_SAFE_INTEGER }
        })
        .sort((a, b) => a.rank - b.rank)
        .map((item) => item.section)
    }

    const groupsByKey = new Map<CategoryFilterKey, ChartGroup[]>()
    for (const group of displayedRangeGroups) {
      const key = (group.todo.category_id ?? NO_CATEGORY_KEY) as CategoryFilterKey
      const current = groupsByKey.get(key)
      if (current) current.push(group)
      else groupsByKey.set(key, [group])
    }

    const orderedSections = categoryOptions
      .map((option) => {
        const groups = groupsByKey.get(option.key) ?? []
        return groups.length > 0 ? makeSection(option.key, option.label, option.color ?? 'var(--slate-500)', groups) : null
      })
      .filter((section): section is ChartCategorySection => Boolean(section))

    for (const [key, groups] of groupsByKey.entries()) {
      if (orderedSections.some((section) => section.key === key)) continue
      orderedSections.push(makeSection(key, key === NO_CATEGORY_KEY ? '未分類' : 'その他', 'var(--slate-500)', groups))
    }

    return orderedSections
  }, [categoryOptions, collapsedCategoryKeys, displayedRangeGroups, sectionGrouping, users])

  const showCategoryGrouping = sectionGrouping !== 'none' && chartSections.length > 0
  const chartGroups = useMemo<ChartGroup[]>(() => (
    chartSections.flatMap((section) => section.collapsed ? [] : section.groups)
  ), [chartSections])

  // 絞り込み中に並べ替えても、App 側で隠れているタスクの位置を保ったまま保存する
  const canStartReorderMode = (Boolean(onReorderTodos) && chartGroups.length > 1)
    || chartGroups.some((group) => group.datedSubTasks.length > 1)

  const handleReorderDragStart = useCallback((todoId: string, event: React.DragEvent<HTMLDivElement>): void => {
    if (!isReorderMode || reorderPending || !onReorderTodos) return
    setReorderFeedback(null)
    setDraggingTodoId(todoId)
    setDragOverTodoId(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', todoId)
  }, [isReorderMode, onReorderTodos, reorderPending])

  const handleReorderDragOver = useCallback((todoId: string, event: React.DragEvent<HTMLDivElement>): void => {
    if (!isReorderMode || reorderPending || !draggingTodoId || draggingTodoId === todoId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverTodoId(todoId)
  }, [draggingTodoId, isReorderMode, reorderPending])

  const handleReorderDrop = useCallback(async (targetTodoId: string, event: React.DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    if (!isReorderMode || reorderPending || !onReorderTodos || !draggingTodoId || draggingTodoId === targetTodoId) {
      setDragOverTodoId(null)
      return
    }

    const orderedIds = chartGroups.map((group) => group.todo.id)
    const fromIndex = orderedIds.indexOf(draggingTodoId)
    const toIndex = orderedIds.indexOf(targetTodoId)
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingTodoId(null)
      setDragOverTodoId(null)
      return
    }

    const nextOrderedIds = [...orderedIds]
    nextOrderedIds.splice(fromIndex, 1)
    nextOrderedIds.splice(toIndex, 0, draggingTodoId)

    setReorderPending(true)
    try {
      await onReorderTodos(nextOrderedIds)
    } catch (error) {
      setReorderFeedback(error instanceof Error ? error.message : 'タスクを並べ替えできませんでした')
    } finally {
      setReorderPending(false)
      setDraggingTodoId(null)
      setDragOverTodoId(null)
    }
  }, [chartGroups, draggingTodoId, isReorderMode, onReorderTodos, reorderPending])

  // サブタスクは並べ替えモードに入らなくても、左の表のつかみで同じタスクの中を動かせる（親タスクの並べ替えはモードの中だけ）
  const siblingSubTaskIdsOf = useCallback((todoId: string): string[] => subTasks
    .filter((item) => item.todo_id === todoId)
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at))
    .map((item) => item.id), [subTasks])

  // サブタスクの並びを変えて保存する。すぐ画面に反映し、失敗したら元に戻す
  const applySubTaskSiblingOrder = useCallback(async (todoId: string, nextOrderedIds: string[]): Promise<void> => {
    if (reorderPending) return
    const orderById = new Map(nextOrderedIds.map((id, index) => [id, index]))
    const previousSubTasks = subTasks
    setReorderFeedback(null)
    setSubTasks((previous) => previous.map((item) => item.todo_id === todoId
      ? { ...item, sort_order: orderById.get(item.id) ?? item.sort_order }
      : item))

    setReorderPending(true)
    try {
      await window.api.subtaskReorder(todoId, nextOrderedIds)
    } catch (error) {
      setSubTasks(previousSubTasks)
      setReorderFeedback(error instanceof Error ? error.message : 'サブタスクを並べ替えできませんでした')
    } finally {
      setReorderPending(false)
    }
  }, [reorderPending, subTasks])

  const handleSubTaskReorderDragStart = useCallback((subTaskId: string, event: React.DragEvent<HTMLDivElement>): void => {
    if (reorderPending) {
      event.preventDefault()
      return
    }
    event.stopPropagation()
    // ドラッグ中の見た目は左の表の部分（タスク名の欄）だけにする。行全体は時間軸まで続いて横に長すぎる
    const leftCell = event.currentTarget.parentElement
    if (leftCell) event.dataTransfer.setDragImage(leftCell, 10, 12)
    setReorderFeedback(null)
    setDraggingSubTaskId(subTaskId)
    setSubTaskDropTarget(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', subTaskId)
  }, [reorderPending])

  // 落とす位置（相手の行の上半分なら前、下半分なら後ろ）。並びが変わらない位置では線を出さない
  const subTaskDropOf = useCallback((targetSubTaskId: string, event: React.DragEvent<HTMLDivElement>): { todoId: string; orderedIds: string[]; position: DropPosition } | null => {
    if (!draggingSubTaskId) return null
    const source = subTaskById.get(draggingSubTaskId)
    const target = subTaskById.get(targetSubTaskId)
    if (!source || !target || source.todo_id !== target.todo_id) return null
    const position = dropPositionOf(event.clientY, event.currentTarget.getBoundingClientRect())
    const orderedIds = moveIdTo(siblingSubTaskIdsOf(source.todo_id), source.id, target.id, position)
    return orderedIds ? { todoId: source.todo_id, orderedIds, position } : null
  }, [draggingSubTaskId, siblingSubTaskIdsOf, subTaskById])

  const handleSubTaskReorderDragOver = useCallback((subTaskId: string, event: React.DragEvent<HTMLDivElement>): void => {
    if (reorderPending || !draggingSubTaskId) return
    const source = subTaskById.get(draggingSubTaskId)
    const target = subTaskById.get(subTaskId)
    // ほかのタスクのサブタスクの上では落とせない（同じタスクの中だけで動かす）
    if (!source || !target || source.todo_id !== target.todo_id) return
    event.preventDefault()
    event.stopPropagation()
    const drop = subTaskDropOf(subTaskId, event)
    event.dataTransfer.dropEffect = drop ? 'move' : 'none'
    setSubTaskDropTarget((previous) => {
      if (!drop) return previous?.id === subTaskId ? null : previous
      return previous?.id === subTaskId && previous.position === drop.position ? previous : { id: subTaskId, position: drop.position }
    })
  }, [draggingSubTaskId, reorderPending, subTaskById, subTaskDropOf])

  const handleSubTaskReorderDrop = useCallback(async (targetSubTaskId: string, event: React.DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    const drop = reorderPending ? null : subTaskDropOf(targetSubTaskId, event)
    setDraggingSubTaskId(null)
    setSubTaskDropTarget(null)
    if (drop) await applySubTaskSiblingOrder(drop.todoId, drop.orderedIds)
  }, [applySubTaskSiblingOrder, reorderPending, subTaskDropOf])

  // つかみにフォーカスして Alt+↑↓ で1つずつ動かす
  const handleSubTaskReorderKeyDown = useCallback((subTask: SubTask, event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const next = moveIdBy(siblingSubTaskIdsOf(subTask.todo_id), subTask.id, event.key === 'ArrowUp' ? -1 : 1)
    if (next) void applySubTaskSiblingOrder(subTask.todo_id, next)
  }, [applySubTaskSiblingOrder, siblingSubTaskIdsOf])

  // サブタスクをドラッグしている間は、ガントの上下の端に近づけるとスクロールする
  useEffect(() => {
    if (!draggingSubTaskId) return
    const container = scrollRef.current
    if (!container) return
    const handleDragOver = (event: DragEvent): void => autoScrollNearEdge(container, event.clientY)
    window.addEventListener('dragover', handleDragOver)
    return () => window.removeEventListener('dragover', handleDragOver)
  }, [draggingSubTaskId])

  const collectDependentTodoIds = useCallback((rootTodoIds: string[]): string[] => {
    const queue = [...rootTodoIds]
    const visited = new Set<string>()

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)

      for (const dependency of dependencies) {
        if (dependency.predecessor_todo_id === current) {
          queue.push(dependency.successor_todo_id)
        }
      }
    }

    return Array.from(visited)
  }, [dependencies])

  const ensureRangeIncludesTodos = useCallback((todoIds: string[], sourceTodos: Todo[]): void => {
    if (rangeMode !== 'manual' || todoIds.length === 0) return

    const bars = todoIds
      .map((todoId) => {
        const todo = sourceTodos.find((candidate) => candidate.id === todoId)
        return todo ? getTodoBar(todo) : null
      })
      .filter((bar): bar is TodoBar => Boolean(bar))

    if (bars.length === 0) return

    const minStart = bars.reduce((earliest, bar) => bar.startDate < earliest ? bar.startDate : earliest, bars[0].startDate)
    const maxEnd = bars.reduce((latest, bar) => bar.endDate > latest ? bar.endDate : latest, bars[0].endDate)
    const nextStart = minStart < normalizedRange.start ? addDays(minStart, -RANGE_PADDING_DAYS) : normalizedRange.start
    const nextEnd = maxEnd > normalizedRange.end ? addDays(maxEnd, RANGE_PADDING_DAYS) : normalizedRange.end

    setManualStart(nextStart)
    setManualEnd(nextEnd)
  }, [normalizedRange.end, normalizedRange.start, rangeMode])

  const snapshotTodoSchedules = useCallback((todoIds: string[]): TodoScheduleSnapshot[] => (
    todoIds
      .map((todoId) => todoById.get(todoId))
      .filter((todo): todo is Todo => Boolean(todo))
      .map((todo) => ({
        id: todo.id,
        startDate: todo.start_date?.slice(0, 10) ?? null,
        dueDate: todo.due_date?.slice(0, 10) ?? null
      }))
  ), [todoById])

  const snapshotSubTaskSchedule = useCallback((subTaskId: string): SubTaskScheduleSnapshot | null => {
    const subTask = subTaskById.get(subTaskId)
    if (!subTask) return null

    return {
      id: subTask.id,
      todoId: subTask.todo_id,
      startDate: subTask.start_date?.slice(0, 10) ?? null,
      dueDate: subTask.due_date?.slice(0, 10) ?? null
    }
  }, [subTaskById])

  const snapshotSubTaskSchedulesForTodos = useCallback((todoIds: string[]): SubTaskScheduleSnapshot[] => {
    const todoIdSet = new Set(todoIds)
    return subTasks
      .filter((subTask) => todoIdSet.has(subTask.todo_id) && (subTask.start_date || subTask.due_date))
      .map((subTask) => ({
        id: subTask.id,
        todoId: subTask.todo_id,
        startDate: subTask.start_date?.slice(0, 10) ?? null,
        dueDate: subTask.due_date?.slice(0, 10) ?? null
      }))
  }, [subTasks])

  const restoreTodoSchedules = useCallback(async (snapshots: TodoScheduleSnapshot[]): Promise<void> => {
    if (snapshots.length === 0) return

    for (const snapshot of snapshots) {
      await window.api.todoUpdate(snapshot.id, {
        start_date: snapshot.startDate,
        due_date: snapshot.dueDate
      })
    }

    const latestTodos = await window.api.todoGetAll()
    ensureRangeIncludesTodos(snapshots.map((snapshot) => snapshot.id), latestTodos)
  }, [ensureRangeIncludesTodos])

  const restoreSubTaskSchedule = useCallback(async (snapshot: SubTaskScheduleSnapshot): Promise<void> => {
    await window.api.subtaskUpdate(snapshot.id, {
      start_date: snapshot.startDate,
      due_date: snapshot.dueDate
    })
  }, [])

  const restoreSubTaskSchedules = useCallback(async (snapshots: SubTaskScheduleSnapshot[]): Promise<void> => {
    for (const snapshot of snapshots) {
      await window.api.subtaskUpdate(snapshot.id, {
        start_date: snapshot.startDate,
        due_date: snapshot.dueDate
      })
    }
  }, [])

  const shiftSubTasksForMovedTodos = useCallback(async (
    previousTodoSnapshots: TodoScheduleSnapshot[],
    previousSubTaskSnapshots: SubTaskScheduleSnapshot[],
    latestTodos: Todo[]
  ): Promise<void> => {
    if (previousSubTaskSnapshots.length === 0) return

    const previousTodoById = new Map(previousTodoSnapshots.map((snapshot) => [snapshot.id, snapshot]))
    const latestTodoById = new Map(latestTodos.map((todo) => [todo.id, todo]))
    const updates = previousSubTaskSnapshots
      .map((snapshot) => {
        const previousTodo = previousTodoById.get(snapshot.todoId)
        if (!previousTodo) return null
        const shiftDays = getPureScheduleShiftDays(previousTodo, latestTodoById.get(snapshot.todoId))
        if (!shiftDays) return null

        return {
          snapshot,
          startDate: shiftOptionalDate(snapshot.startDate, shiftDays),
          dueDate: shiftOptionalDate(snapshot.dueDate, shiftDays)
        }
      })
      .filter((entry): entry is { snapshot: SubTaskScheduleSnapshot; startDate: string | null; dueDate: string | null } => Boolean(entry))

    for (const update of updates) {
      await window.api.subtaskUpdate(update.snapshot.id, {
        start_date: update.startDate,
        due_date: update.dueDate
      })
    }

    if (updates.length > 0) {
      const latestSubTasks = await window.api.subtaskGetAll()
      setSubTasks(latestSubTasks)
    }
  }, [])

  // 行のタスク名で Alt+→ / Alt+← を押すと期限を1日ずらす。Shift も押すと開始日ごと（日程を）ずらす。
  // バーのドラッグと同じく、後続のタスクとサブタスクも動き、「1つ戻る」（Ctrl+Z）で戻せる
  const shiftTodoByKeyboard = useCallback((todo: Todo, days: number, moveWhole: boolean): void => {
    const start = todo.start_date?.slice(0, 10) ?? null
    const due = todo.due_date?.slice(0, 10) ?? null
    const notify = (message: string, type: 'success' | 'error' = 'success', action?: { label?: string; run?: () => void; key?: string }): void => {
      if (onShowToast) onShowToast(message, type, action)
      else setDependencyFeedback(message)
    }
    const update: UpdateTodoInput = {}
    if (moveWhole) {
      if (!start && !due) {
        notify('日付のないタスクは、詳細で開始日か期限を入れてください', 'error')
        return
      }
      if (start) update.start_date = addDays(start, days)
      if (due) update.due_date = addDays(due, days)
    } else {
      if (!due) {
        notify('期限のないタスクは、詳細で期限を入れてください', 'error')
        return
      }
      const nextDue = addDays(due, days)
      if (start && nextDue < start) {
        notify('期限を開始日より前にはできません', 'error')
        return
      }
      update.due_date = nextDue
    }
    const affectedTodoIds = collectDependentTodoIds([todo.id])
    const previousSnapshots = snapshotTodoSchedules(affectedTodoIds)
    const previousSubTaskSnapshots = moveWhole ? snapshotSubTaskSchedulesForTodos(affectedTodoIds) : []
    const label = `${moveWhole ? '日程の移動' : '期限の変更'}: ${todo.title}`
    const undo = async (): Promise<void> => {
      await restoreTodoSchedules(previousSnapshots)
      await restoreSubTaskSchedules(previousSubTaskSnapshots)
    }
    void onUpdateTodo(todo.id, update).then(async () => {
      const latestTodos = await window.api.todoGetAll()
      await shiftSubTasksForMovedTodos(previousSnapshots, previousSubTaskSnapshots, latestTodos)
      ensureRangeIncludesTodos(affectedTodoIds, latestTodos)
      const toastKey = `gantt-schedule:${todo.id}`
      if (previousSnapshots.length > 0) setLastUndoEntry({ label, run: undo, toastKey })
      const range = moveWhole
        ? `${update.start_date ? formatShortDate(update.start_date) : '—'}〜${update.due_date ? formatShortDate(update.due_date) : '—'}`
        : formatShortDate(update.due_date!)
      notify(`「${todo.title}」の${moveWhole ? '日程' : '期限'}を${range}にしました`, 'success', {
        key: toastKey,
        label: '元に戻す',
        run: () => {
          setLastUndoEntry(null)
          void undo().then(() => notify('元に戻しました'), (error) => notify(error instanceof Error ? error.message : '元に戻せませんでした', 'error'))
        }
      })
    }, (error) => notify(error instanceof Error ? error.message : '日程を変えられませんでした', 'error'))
  }, [collectDependentTodoIds, ensureRangeIncludesTodos, onShowToast, onUpdateTodo, restoreSubTaskSchedules, restoreTodoSchedules, shiftSubTasksForMovedTodos, snapshotSubTaskSchedulesForTodos, snapshotTodoSchedules])

  const performUndo = useCallback(async (): Promise<void> => {
    if (!lastUndoEntry || undoPending) return

    setUndoPending(true)
    try {
      await lastUndoEntry.run()
      setLastUndoEntry(null)
      setDependencyFeedback(`元に戻しました: ${lastUndoEntry.label}`)
      // キーで変えたときの知らせが残っていれば、「元に戻しました」で置き換える
      if (lastUndoEntry.toastKey && onShowToast) onShowToast(`元に戻しました（${lastUndoEntry.label}）`, 'success', { key: lastUndoEntry.toastKey })
    } catch (error) {
      setDependencyFeedback(error instanceof Error ? error.message : '元に戻せませんでした。')
    } finally {
      setUndoPending(false)
    }
  }, [lastUndoEntry, onShowToast, undoPending])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return
      if (!lastUndoEntry || undoPending) return

      const target = event.target
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      void performUndo()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [lastUndoEntry, performUndo, undoPending])

  const timelineStart = startOfUnit(normalizedRange.start, timeScale)
  const timelineEnd = startOfUnit(normalizedRange.end, timeScale)
  const totalUnits = diffUnits(timelineEnd, timelineStart, timeScale) + 1
  const timelineUnits = useMemo(() => (
    Array.from({ length: totalUnits }, (_, index) => {
      const unitStart = addUnits(timelineStart, timeScale, index)
      const unitEnd = endOfUnit(unitStart, timeScale)
      const labels = formatUnitLabels(unitStart, timeScale)
      const holidayName = timeScale === 'day' ? holidayNames.get(unitStart) ?? null : null
      const dayOfWeek = parseDateKey(unitStart).getDay()
      const dayKind: DayKind = timeScale !== 'day'
        ? null
        : holidayName ? 'holiday' : dayOfWeek === 0 ? 'sunday' : dayOfWeek === 6 ? 'saturday' : null
      return {
        key: `${timeScale}-${unitStart}`,
        startDate: unitStart,
        endDate: unitEnd,
        primaryLabel: holidayName ? '祝' : labels.primaryLabel,
        secondaryLabel: labels.secondaryLabel,
        isCurrent: isCurrentUnit(unitStart, todayKey, timeScale),
        background: getUnitBackground(unitStart, todayKey, timeScale, dayKind),
        dayKind,
        holidayName
      }
    })
  ), [holidayNames, timeScale, timelineStart, todayKey, totalUnits])
  const timelineWidth = totalUnits * unitWidth
  const todayIndex = diffUnits(todayKey, timelineStart, timeScale)
  // 今日の縦線の位置（週・月・年の単位では、単位の中での今日の位置に合わせる）
  const todayUnitStart = startOfUnit(todayKey, timeScale)
  const todayUnitDays = diffCalendarDays(endOfUnit(todayKey, timeScale), todayUnitStart) + 1
  const todayOffsetInUnit = ((diffCalendarDays(todayKey, todayUnitStart) + 0.5) / todayUnitDays) * unitWidth
  const todayX = todayIndex < 0 ? null : todayIndex >= totalUnits ? timelineWidth : todayIndex * unitWidth + todayOffsetInUnit
  // 土日・祝日の列の塗り。全行で同じ1枚の SVG を背景に敷く（行ごとに要素を増やさない）。
  // 画像の中では CSS の変数が効かないので色は直書きする（薄い色なのでダーク・ライトのどちらでも使える）
  const nonWorkingBackground = useMemo(() => {
    const rects = timelineUnits
      .map((unit, index) => unit.dayKind
        ? `<rect x='${index * unitWidth}' y='0' width='${unitWidth}' height='10' fill='${unit.dayKind === 'saturday' ? '#38bdf8' : '#f87171'}' fill-opacity='0.08'/>`
        : '')
      .join('')
    if (!rects) return null
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${timelineWidth}' height='10' viewBox='0 0 ${timelineWidth} 10' preserveAspectRatio='none'>${rects}</svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  }, [timelineUnits, timelineWidth, unitWidth])
  const getTodayScrollLeft = useCallback((container: HTMLDivElement): number => {
    // 今日を左端ではなく、見えている時間軸の左から 1/4 の位置に出して、進行中タスクの前半も見えるようにする
    const visibleTimelineWidth = Math.max(container.clientWidth - leftTableWidth, 0)
    const todayStart = todayIndex * unitWidth - Math.round(visibleTimelineWidth / 4)
    const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0)
    return clamp(todayStart, 0, maxScrollLeft)
  }, [leftTableWidth, todayIndex, unitWidth])
  const handleJumpToToday = useCallback(() => {
    const container = scrollRef.current
    if (container && todayIndex >= 0 && todayIndex < totalUnits) {
      container.scrollTo({ left: getTodayScrollLeft(container), behavior: 'smooth' })
      return
    }

    jumpToTodayPendingRef.current = true
    centerRangeOnToday()
  }, [centerRangeOnToday, getTodayScrollLeft, todayIndex, totalUnits])

  const hasScrollableChart = !loading && displayedRangeGroups.length > 0

  // 詳細を開いているタスクの行が、期限の変更などで並び替わって動いたときは、縦にもその行まで送る
  // （動いていないときは送らない。自分で縦にスクロールした位置を、読み込み直しのたびに戻さないように）
  const focusRowOrder = focusTodoId ? displayedRangeGroups.findIndex((group) => group.todo.id === focusTodoId) : -1
  const lastFocusRowRef = useRef<{ id: string; order: number } | null>(null)
  useEffect(() => {
    const container = scrollRef.current
    const previous = lastFocusRowRef.current
    lastFocusRowRef.current = focusTodoId ? { id: focusTodoId, order: focusRowOrder } : null
    if (!container || !focusTodoId || focusRowOrder < 0 || !previous || previous.id !== focusTodoId || previous.order === focusRowOrder) return
    const frame = window.requestAnimationFrame(() => {
      const row = container.querySelector<HTMLElement>(`[data-gantt-todo-id="${CSS.escape(focusTodoId)}"]`)
      if (!row) return
      const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      const headerHeight = 48
      if (rowTop >= container.scrollTop + headerHeight && rowTop + row.offsetHeight <= container.scrollTop + container.clientHeight) return
      container.scrollTop = Math.max(0, rowTop - headerHeight - 24)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRowOrder, focusTodoId])

  // 右に詳細を開いてガントが狭くなったときも、そのタスクのバーが見えるように横へ送る
  useEffect(() => {
    const container = scrollRef.current
    if (!container || !focusTodoId) return
    const ensureVisible = (): void => {
      const bar = chartGroups.find((group) => group.todo.id === focusTodoId)?.todoBar
      if (!bar) return
      const barLeft = diffUnits(bar.startDate, timelineStart, timeScale) * unitWidth
      const barRight = (diffUnits(bar.endDate, timelineStart, timeScale) + 1) * unitWidth
      const visibleWidth = Math.max(container.clientWidth - leftTableWidth, 0)
      const visibleLeft = container.scrollLeft
      if (visibleWidth === 0 || (barLeft >= visibleLeft && barRight <= visibleLeft + visibleWidth)) return
      const margin = Math.round(visibleWidth / 8)
      container.scrollLeft = barLeft < visibleLeft || barRight - barLeft > visibleWidth - margin
        ? Math.max(0, barLeft - margin)
        : barRight - visibleWidth + margin
    }
    ensureVisible()
    const observer = new ResizeObserver(ensureVisible)
    observer.observe(container)
    return () => observer.disconnect()
  }, [chartGroups, focusTodoId, leftTableWidth, timeScale, timelineStart, unitWidth])

  useLayoutEffect(() => {
    if (!hasScrollableChart) return
    const container = scrollRef.current
    if (!container) return

    const snapshot = viewportScrollStateRef.current ?? initialScrollStateRef.current
    if (snapshot && !jumpToTodayPendingRef.current) {
      const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0)
      const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0)
      let restoredLeft = clamp(snapshot.scrollLeft, 0, maxScrollLeft)

      if (snapshot.leftDate && snapshot.timeScale === timeScale) {
        const storedIndex = diffUnits(snapshot.leftDate, timelineStart, timeScale)
        if (Number.isFinite(storedIndex)) {
          const offset = snapshot.unitWidth
            ? snapshot.leftOffset / snapshot.unitWidth * unitWidth
            : snapshot.leftOffset
          restoredLeft = clamp(storedIndex * unitWidth + offset, 0, maxScrollLeft)
        }
      } else if (snapshot.leftDate) {
        // 表示単位を変えても、今見ている日付を新しい時間軸へ移す。
        const storedUnitDays = diffCalendarDays(endOfUnit(snapshot.leftDate, snapshot.timeScale), snapshot.leftDate) + 1
        const fraction = snapshot.unitWidth ? snapshot.leftOffset / snapshot.unitWidth : 0
        const anchorDate = addDays(snapshot.leftDate, Math.floor(fraction * storedUnitDays))
        const nextUnitStart = startOfUnit(anchorDate, timeScale)
        const nextUnitDays = diffCalendarDays(endOfUnit(anchorDate, timeScale), nextUnitStart) + 1
        const nextOffset = diffCalendarDays(anchorDate, nextUnitStart) / nextUnitDays * unitWidth
        restoredLeft = clamp(diffUnits(anchorDate, timelineStart, timeScale) * unitWidth + nextOffset, 0, maxScrollLeft)
      }

      container.scrollLeft = restoredLeft
      container.scrollTop = clamp(snapshot.scrollTop, 0, maxScrollTop)
    } else {
      container.scrollLeft = getTodayScrollLeft(container)
    }
    jumpToTodayPendingRef.current = false
    initialScrollStateRef.current = null
    setScrollStateReady(true)
  }, [getTodayScrollLeft, hasScrollableChart, timeScale, timelineStart, totalUnits, unitWidth])

  useLayoutEffect(() => {
    if (!scrollStateReady || !hasScrollableChart) return

    const container = scrollRef.current
    if (!container) return

    let frameId = 0
    const captureScrollState = (): PersistedGanttScrollState => {
      const scrollLeft = Math.max(container.scrollLeft, 0)
      const scrollTop = Math.max(container.scrollTop, 0)
      const unitIndex = totalUnits > 0 ? clamp(Math.floor(scrollLeft / unitWidth), 0, totalUnits - 1) : 0
      const leftDate = totalUnits > 0 ? addUnits(timelineStart, timeScale, unitIndex) : null
      const leftOffset = totalUnits > 0 ? Math.max(0, scrollLeft - unitIndex * unitWidth) : 0

      return {
        timeScale,
        leftDate,
        leftOffset,
        scrollLeft,
        scrollTop,
        unitWidth
      }
    }
    const persistScrollState = (): void => {
      frameId = 0
      window.localStorage.setItem(GANTT_SCROLL_STATE_STORAGE_KEY, JSON.stringify(viewportScrollStateRef.current))
    }

    const handleScroll = (): void => {
      // 次の描画前に期間が変わっても、最後に見ていた日付を使えるよう同期的に記録する。
      viewportScrollStateRef.current = captureScrollState()
      if (frameId) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(persistScrollState)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    viewportScrollStateRef.current = captureScrollState()
    persistScrollState()

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [hasScrollableChart, scrollStateReady, timeScale, timelineStart, totalUnits, unitWidth])

  useEffect(() => {
    if (!interaction || !isTimelineEditable) return

    const handlePointerMove = (event: PointerEvent): void => {
      const current = interactionRef.current
      if (!current) return

      const deltaUnits = Math.round((event.clientX - current.originClientX) / unitWidth)
      setInteraction((previous) => {
        if (!previous) return null

        if (previous.mode === 'move') {
          const nextStartDate = shiftDateByScale(previous.originalStartDate, timeScale, deltaUnits)
          const nextEndDate = shiftDateByScale(previous.originalEndDate, timeScale, deltaUnits)
          return {
            ...previous,
            previewStartDate: nextStartDate,
            previewEndDate: nextEndDate,
            moved: previous.moved || deltaUnits !== 0
          }
        }

        if (previous.mode === 'resizeStart') {
          const nextStartDate = shiftDateByScale(previous.originalStartDate, timeScale, deltaUnits)
          return {
            ...previous,
            previewStartDate: nextStartDate <= previous.originalEndDate ? nextStartDate : previous.originalEndDate,
            moved: previous.moved || deltaUnits !== 0
          }
        }

        const nextEndDate = shiftDateByScale(previous.originalEndDate, timeScale, deltaUnits)
        return {
          ...previous,
          previewEndDate: nextEndDate >= previous.originalStartDate ? nextEndDate : previous.originalStartDate,
          moved: previous.moved || deltaUnits !== 0
        }
      })
    }

    const handlePointerUp = (): void => {
      const current = interactionRef.current
      setInteraction(null)
      if (!current) return
      if (current.moved) {
        suppressSelectionRef.current = true
        window.setTimeout(() => {
          suppressSelectionRef.current = false
        }, 0)
      }
      if (current.previewStartDate === current.originalStartDate && current.previewEndDate === current.originalEndDate) return
      if (current.targetType === 'todo') {
        const affectedTodoIds = collectDependentTodoIds([current.targetId])
        const previousSnapshots = snapshotTodoSchedules(affectedTodoIds)
        const previousSubTaskSnapshots = current.mode === 'move' ? snapshotSubTaskSchedulesForTodos(affectedTodoIds) : []
        const todoTitle = todoById.get(current.targetId)?.title ?? 'タスク'
        void onUpdateTodo(current.targetId, {
          start_date: current.previewStartDate,
          due_date: current.previewEndDate
        }).then(async () => {
          const latestTodos = await window.api.todoGetAll()
          await shiftSubTasksForMovedTodos(previousSnapshots, previousSubTaskSnapshots, latestTodos)
          ensureRangeIncludesTodos(affectedTodoIds, latestTodos)
          if (previousSnapshots.length > 0) {
            setLastUndoEntry({
              label: `タスク移動: ${todoTitle}`,
              run: async () => {
                await restoreTodoSchedules(previousSnapshots)
                await restoreSubTaskSchedules(previousSubTaskSnapshots)
              }
            })
          }
        })
        return
      }

      const previousSubTaskSnapshot = snapshotSubTaskSchedule(current.targetId)
      const affectedTodoIds = collectDependentTodoIds([current.ownerTodoId])
      const previousTodoSnapshots = snapshotTodoSchedules(affectedTodoIds)
      const ownerTodo = todoById.get(current.ownerTodoId)
      const ownerDueDate = ownerTodo?.due_date?.slice(0, 10) ?? null
      const shouldExtendOwnerDue = !ownerDueDate || current.previewEndDate > ownerDueDate

      void window.api.subtaskUpdate(current.targetId, {
        start_date: current.previewStartDate,
        due_date: current.previewEndDate
      }).then(async (updated) => {
        // 変更通知を待たずに、動かしたサブタスクをすぐ反映する（通知が遅れても元の位置に戻って見えないように）
        setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item))
        if (shouldExtendOwnerDue) {
          const latestTodos = await window.api.todoGetAll()
          ensureRangeIncludesTodos(affectedTodoIds, latestTodos)
        }

        if (!previousSubTaskSnapshot) return
        setLastUndoEntry({
          label: 'サブタスク移動',
          run: async () => {
            await restoreSubTaskSchedule(previousSubTaskSnapshot)
            if (shouldExtendOwnerDue && previousTodoSnapshots.length > 0) {
              await restoreTodoSchedules(previousTodoSnapshots)
            }
          }
        })
      })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [
    collectDependentTodoIds,
    ensureRangeIncludesTodos,
    interaction,
    isTimelineEditable,
    onUpdateTodo,
    restoreSubTaskSchedule,
    restoreSubTaskSchedules,
    restoreTodoSchedules,
    shiftSubTasksForMovedTodos,
    snapshotSubTaskSchedule,
    snapshotSubTaskSchedulesForTodos,
    snapshotTodoSchedules,
    timeScale,
    todoById,
    unitWidth
  ])

  const handleChartItemSelect = useCallback((todoId: string): void => {
    if (suppressSelectionRef.current) return
    onSelectTodo(todoId)
  }, [onSelectTodo])

  const beginInteraction = (
    mode: InteractionState['mode'],
    targetType: InteractionState['targetType'],
    targetId: string,
    ownerTodoId: string,
    startDate: string,
    endDate: string,
    clientX: number
  ): void => {
    if (!isTimelineEditable) return
    setInteraction({
      targetType,
      targetId,
      ownerTodoId,
      mode,
      originClientX: clientX,
      originalStartDate: startDate,
      originalEndDate: endDate,
      previewStartDate: startDate,
      previewEndDate: endDate,
      moved: false
    })
  }

  const toggleCategory = (key: CategoryFilterKey): void => {
    setSelectedCategoryKeys((previous) => previous.includes(key)
      ? previous.filter((current) => current !== key)
      : [...previous, key]
    )
  }

  const toggleTodoSelection = (todoId: string): void => {
    setSelectedTodoIds((previous) => {
      if (previous.length === 0) return [todoId]
      return previous.includes(todoId)
        ? previous.filter((current) => current !== todoId)
        : [...previous, todoId]
    })
  }

  const toggleTodoExpansion = useCallback((todoId: string): void => {
    setCollapsedTodoIds((previous) => (
      previous.includes(todoId)
        ? previous.filter((current) => current !== todoId)
        : [...previous, todoId]
    ))
  }, [])

  const toggleCategorySection = useCallback((key: CategoryFilterKey): void => {
    setCollapsedCategoryKeys((previous) => (
      previous.includes(key)
        ? previous.filter((current) => current !== key)
        : [...previous, key]
    ))
  }, [])

  const beginAddSubTask = useCallback((todo: Todo, todoBar: TodoBar | null): void => {
    if (creatingSubTask || isReorderMode) return

    setEditingTodoCell(null)
    setEditingSubTaskCell(null)
    setShowSubtasks(true)
    setCollapsedTodoIds((previous) => previous.filter((id) => id !== todo.id))
    setAddingSubTaskTodoId(todo.id)
    setNewSubTaskDraft({
      title: '',
      startDate: formatDateKey(new Date()),
      dueDate: todoBar?.endDate ?? todoBar?.startDate ?? todayKey
    })
  }, [creatingSubTask, isReorderMode, todayKey])

  const cancelAddSubTask = useCallback((): void => {
    setAddingSubTaskTodoId(null)
    setNewSubTaskDraft({ title: '', startDate: '', dueDate: '' })
  }, [])

  const commitNewSubTask = useCallback(async (todo: Todo): Promise<void> => {
    if (creatingSubTask) return

    const title = newSubTaskDraft.title.trim()
    if (!title) {
      setDependencyFeedback('サブタスク名を入力してください。')
      return
    }
    if (newSubTaskDraft.startDate && newSubTaskDraft.dueDate && newSubTaskDraft.startDate > newSubTaskDraft.dueDate) {
      setDependencyFeedback('サブタスクの開始日は期限以前にしてください。')
      return
    }

    const payload: CreateSubTaskInput = {
      title,
      start_date: newSubTaskDraft.startDate || null,
      due_date: newSubTaskDraft.dueDate || null
    }

    setCreatingSubTask(true)
    try {
      const created = await window.api.subtaskCreate(todo.id, payload)
      setSubTasks((previous) => [...previous, created])
      setAddingSubTaskTodoId(null)
      setNewSubTaskDraft({ title: '', startDate: '', dueDate: '' })
      setDependencyFeedback('サブタスクを追加しました。')

      const createdStart = created.start_date?.slice(0, 10) ?? null
      const createdDue = created.due_date?.slice(0, 10) ?? null
      const todoStart = todo.start_date?.slice(0, 10) ?? null
      const todoDue = todo.due_date?.slice(0, 10) ?? null
      const todoUpdate: UpdateTodoInput = {}
      if (createdStart && (!todoStart || createdStart < todoStart)) todoUpdate.start_date = createdStart
      if (!todo.list_mode && createdDue && (!todoDue || createdDue > todoDue)) todoUpdate.due_date = createdDue
      if (Object.keys(todoUpdate).length > 0) {
        await onUpdateTodo(todo.id, todoUpdate)
        const latestTodos = await window.api.todoGetAll()
        ensureRangeIncludesTodos([todo.id], latestTodos)
      }
    } catch (error) {
      setDependencyFeedback(error instanceof Error ? error.message : 'サブタスクを追加できませんでした。')
    } finally {
      setCreatingSubTask(false)
    }
  }, [creatingSubTask, ensureRangeIncludesTodos, newSubTaskDraft, onUpdateTodo])

  const captureBaseline = useCallback((): void => {
    const todoEntries = todos
      .map((todo) => {
        const bar = getTodoBar(todo)
        return bar ? [todo.id, bar] as const : null
      })
      .filter((entry): entry is readonly [string, TodoBar] => Boolean(entry))
    const subTaskEntries = subTasks
      .map((subTask) => {
        const bar = getSubTaskBar(subTask)
        return bar ? [subTask.id, bar] as const : null
      })
      .filter((entry): entry is readonly [string, TodoBar] => Boolean(entry))

    setBaselineSnapshot({
      capturedAt: new Date().toISOString(),
      todos: Object.fromEntries(todoEntries),
      subTasks: Object.fromEntries(subTaskEntries)
    })
    setShowBaseline(true)
  }, [subTasks, todos])

  const createDependency = useCallback(async (
    predecessorTodoId = dependencyDraft.predecessorTodoId,
    successorTodoId = dependencyDraft.successorTodoId,
    lagDaysInput: string | number = dependencyDraft.lagDays
  ): Promise<boolean> => {
    if (!predecessorTodoId || !successorTodoId) {
      setDependencyFeedback('前タスクと後タスクの両方を選択してください。')
      return false
    }

    try {
      const rawLagDays = Number(lagDaysInput || '0')
      const lagDays = Number.isFinite(rawLagDays) ? clamp(rawLagDays, 0, 60) : 0
      const affectedTodoIds = collectDependentTodoIds([successorTodoId])
      const previousSnapshots = snapshotTodoSchedules(affectedTodoIds)
      const predecessorTitle = todoById.get(predecessorTodoId)?.title ?? '前タスク'
      const successorTitle = todoById.get(successorTodoId)?.title ?? '後タスク'
      const createdDependency = await window.api.todoDependencyCreate(predecessorTodoId, successorTodoId, lagDays)
      const latestTodos = await window.api.todoGetAll()
      ensureRangeIncludesTodos(
        [predecessorTodoId, ...affectedTodoIds],
        latestTodos
      )
      setDependencyFeedback('依存関係を追加しました。')
      setLastUndoEntry({
        label: `依存関係追加: ${predecessorTitle} → ${successorTitle}`,
        run: async () => {
          await window.api.todoDependencyDelete(createdDependency.id)
          await restoreTodoSchedules(previousSnapshots)
        }
      })
      setDependencyDraft((previous) => ({
        ...previous,
        predecessorTodoId,
        successorTodoId: '',
        lagDays: String(lagDays)
      }))
      return true
    } catch (error) {
      setDependencyFeedback(error instanceof Error ? error.message : '依存関係を追加できませんでした。')
      return false
    }
  }, [
    collectDependentTodoIds,
    dependencyDraft.lagDays,
    dependencyDraft.predecessorTodoId,
    dependencyDraft.successorTodoId,
    ensureRangeIncludesTodos,
    restoreTodoSchedules,
    snapshotTodoSchedules,
    todoById
  ])

  const getSuggestedDependencyLagDays = useCallback((predecessorTodoId: string, successorTodoId: string): number => {
    const predecessor = todoById.get(predecessorTodoId)
    const successor = todoById.get(successorTodoId)
    if (!predecessor || !successor) return 0

    const predecessorBar = getTodoBar(predecessor)
    const successorBar = getTodoBar(successor)
    if (!predecessorBar || !successorBar) return 0

    return clamp(diffCalendarDays(successorBar.startDate, predecessorBar.endDate) - 1, 0, 60)
  }, [todoById])

  const updateDependencyLag = useCallback(async (dependencyId: string, lagDays: number, predecessorTodoId: string, successorTodoId: string): Promise<void> => {
    try {
      const affectedTodoIds = collectDependentTodoIds([successorTodoId])
      const previousSnapshots = snapshotTodoSchedules(affectedTodoIds)
      const previousLagDays = dependencies.find((dependency) => dependency.id === dependencyId)?.lag_days ?? lagDays
      await window.api.todoDependencyUpdate(dependencyId, lagDays)
      const latestTodos = await window.api.todoGetAll()
      ensureRangeIncludesTodos([predecessorTodoId, ...affectedTodoIds], latestTodos)
      setLastUndoEntry({
        label: '待機日数変更',
        run: async () => {
          await window.api.todoDependencyUpdate(dependencyId, previousLagDays)
          await restoreTodoSchedules(previousSnapshots)
        }
      })
      setDependencyFeedback('待機日数を更新しました。')
    } catch (error) {
      setDependencyFeedback(error instanceof Error ? error.message : '待機日数を更新できませんでした。')
    }
  }, [collectDependentTodoIds, dependencies, ensureRangeIncludesTodos, restoreTodoSchedules, snapshotTodoSchedules])

  const removeDependency = useCallback(async (dependencyId: string): Promise<void> => {
    try {
      const dependency = dependencies.find((entry) => entry.id === dependencyId)
      if (!dependency) {
        setDependencyFeedback('依存関係が見つかりません。')
        return
      }

      const affectedTodoIds = collectDependentTodoIds([dependency.successor_todo_id])
      const previousSnapshots = snapshotTodoSchedules(affectedTodoIds)
      const predecessorTitle = todoById.get(dependency.predecessor_todo_id)?.title ?? '前タスク'
      const successorTitle = todoById.get(dependency.successor_todo_id)?.title ?? '後タスク'
      await window.api.todoDependencyDelete(dependencyId)
      setLastUndoEntry({
        label: `依存関係削除: ${predecessorTitle} → ${successorTitle}`,
        run: async () => {
          await window.api.todoDependencyCreate(
            dependency.predecessor_todo_id,
            dependency.successor_todo_id,
            dependency.lag_days
          )
          await restoreTodoSchedules(previousSnapshots)
        }
      })
      setDependencyFeedback('依存関係を削除しました。')
    } catch (error) {
      setDependencyFeedback(error instanceof Error ? error.message : '依存関係を削除できませんでした。')
    }
  }, [collectDependentTodoIds, dependencies, restoreTodoSchedules, snapshotTodoSchedules, todoById])

  const expandableTodoIds = chartGroups
    .filter((group) => group.datedSubTasks.length > 0)
    .map((group) => group.todo.id)
  const expandedTodoCount = expandableTodoIds.filter((todoId) => !collapsedTodoIds.includes(todoId)).length
  const visibleSubTaskCount = chartGroups.reduce((sum, group) => (
    sum + (showSubtasks && !collapsedTodoIds.includes(group.todo.id) ? group.datedSubTasks.length : 0)
  ), 0)
  const scheduleHealthEntries = useMemo(() => (
    chartGroups
      .map((group) => {
        // ToDoリストは進捗率を使わないので、遅れ・期限超過の判定はしない（期限があれば期限の欄の色で分かる）
        if (group.todo.list_mode) return null
        const health = getScheduleHealth(group.todo, group.todoBar, todayKey, { behindThresholdDays, workingDaysOnly, holidayNames })
        return health ? { todoId: group.todo.id, health } : null
      })
      .filter((entry): entry is { todoId: string; health: ScheduleHealthInfo } => Boolean(entry))
  ), [behindThresholdDays, chartGroups, holidayNames, todayKey, workingDaysOnly])
  // ToDoリストの項目の進み具合。完了したサブタスクを隠す絞り込みの影響を受けないよう、絞り込み前の項目で数える
  const checklistSummaryByTodo = useMemo(() => buildChecklistSummaries(todos, subTasks), [subTasks, todos])
  const scheduleHealthByTodoId = useMemo(() => (
    new Map(scheduleHealthEntries.map((entry) => [entry.todoId, entry.health]))
  ), [scheduleHealthEntries])
  const scheduleHealthSummary = useMemo(() => (
    scheduleHealthEntries.reduce((summary, entry) => {
      if (entry.health.status === 'overdue') summary.overdue += 1
      else if (entry.health.status === 'behind') summary.behind += 1
      else if (entry.health.status === 'ahead' || entry.health.status === 'onTrack') summary.healthy += 1
      else if (entry.health.status === 'future') summary.future += 1
      return summary
    }, { overdue: 0, behind: 0, healthy: 0, future: 0 })
  ), [scheduleHealthEntries])
  const baselineCapturedLabel = baselineSnapshot ? shortDateLabel(baselineSnapshot.capturedAt.slice(0, 10)) : null
  const dependencyOptions = todoSelectionCandidates
  const visibleTodoIdSet = useMemo(() => new Set(chartGroups.map((group) => group.todo.id)), [chartGroups])
  const displayedTodoBarsById = useMemo(() => {
    const next = new Map<string, TodoBar>()

    for (const group of chartGroups) {
      if (!group.todoBar) continue
      const activeState = interaction?.targetType === 'todo' && interaction.targetId === group.todo.id ? interaction : null
      next.set(
        group.todo.id,
        normalizeBar(
          activeState ? activeState.previewStartDate : group.todoBar.startDate,
          activeState ? activeState.previewEndDate : group.todoBar.endDate
        )
      )
    }

    return next
  }, [chartGroups, interaction])
  const rowLayout = useMemo(() => {
    const positions = new Map<string, { centerY: number }>()
    let top = 0

    for (const section of chartSections) {
      if (showCategoryGrouping) {
        top += CATEGORY_HEADER_HEIGHT + TASK_GROUP_GAP
      }

      if (!section.collapsed) {
        section.groups.forEach((group, index) => {
          positions.set(group.todo.id, { centerY: top + PARENT_ROW_HEIGHT / 2 })
          top += PARENT_ROW_HEIGHT
          if (showSubtasks && !collapsedTodoIds.includes(group.todo.id)) {
            top += group.datedSubTasks.length * SUBTASK_ROW_HEIGHT
            if (addingSubTaskTodoId === group.todo.id) top += SUBTASK_ADD_ROW_HEIGHT
          }
          top += index === section.groups.length - 1 ? CATEGORY_GROUP_GAP : TASK_GROUP_GAP
        })
      }
    }

    return { positions, totalHeight: top }
  }, [addingSubTaskTodoId, chartSections, collapsedTodoIds, showCategoryGrouping, showSubtasks])
  const dependencyGeometryByTodoId = useMemo(() => {
    const next = new Map<string, { sourceX: number; targetX: number; centerY: number }>()

    for (const group of chartGroups) {
      const displayedTodoBar = displayedTodoBarsById.get(group.todo.id)
      const row = rowLayout.positions.get(group.todo.id)
      if (!displayedTodoBar || !row) continue
      if (!intersectsRange(displayedTodoBar.startDate, displayedTodoBar.endDate, normalizedRange.start, normalizedRange.end)) continue

      const startIndex = clamp(diffUnits(displayedTodoBar.startDate, timelineStart, timeScale), 0, totalUnits - 1)
      const endIndex = clamp(diffUnits(displayedTodoBar.endDate, timelineStart, timeScale), 0, totalUnits - 1)

      next.set(group.todo.id, {
        // 依存関係を引くつかみはバーの右端のすぐ外に置く。バーの中に置くと、期限を変える右端のつかみと重なってドラッグできなくなる
        sourceX: endIndex * unitWidth + unitWidth + 3,
        targetX: startIndex * unitWidth + DEPENDENCY_TARGET_INSET,
        centerY: row.centerY
      })
    }

    return next
  }, [chartGroups, displayedTodoBarsById, normalizedRange.end, normalizedRange.start, rowLayout, timeScale, timelineStart, totalUnits, unitWidth])
  const visibleDependencies = useMemo(() => (
    dependencies.filter((dependency) => todoById.has(dependency.predecessor_todo_id) && todoById.has(dependency.successor_todo_id))
  ), [dependencies, todoById])
  const setDependencySourceHandleRef = useCallback((todoId: string, node: HTMLDivElement | null): void => {
    if (node) dependencySourceHandleRefs.current.set(todoId, node)
    else dependencySourceHandleRefs.current.delete(todoId)
  }, [])
  const setDependencyTargetBarRef = useCallback((todoId: string, node: HTMLDivElement | null): void => {
    if (node) dependencyTargetBarRefs.current.set(todoId, node)
    else dependencyTargetBarRefs.current.delete(todoId)
  }, [])
  const getDependencyPointInCanvas = useCallback((
    element: HTMLDivElement,
    edge: 'start' | 'center' | 'end' = 'center',
    inset = edge === 'center' ? 0 : 6
  ): { x: number; y: number } | null => {
    const canvasRect = chartCanvasRef.current?.getBoundingClientRect()
    if (!canvasRect) return null

    const rect = element.getBoundingClientRect()
    const x = edge === 'start'
      ? rect.left - canvasRect.left - leftTableWidth + inset
      : edge === 'end'
        ? rect.right - canvasRect.left - leftTableWidth - inset
        : rect.left - canvasRect.left - leftTableWidth + rect.width / 2

    return {
      x,
      y: rect.top - canvasRect.top + rect.height / 2
    }
  }, [leftTableWidth])
  const getHoveredDependencyTargetId = useCallback((clientX: number, clientY: number, predecessorTodoId: string): string | null => {
    for (const [todoId, element] of dependencyTargetBarRefs.current.entries()) {
      if (todoId === predecessorTodoId) continue
      const rect = element.getBoundingClientRect()
      if (
        clientX >= rect.left - 14
        && clientX <= rect.right + 14
        && clientY >= rect.top - 10
        && clientY <= rect.bottom + 10
      ) {
        return todoId
      }
    }

    return null
  }, [])
  useLayoutEffect(() => {
    let frameId = 0

    const measureDependencyPaths = (): void => {
      if (visibleDependencies.length === 0) {
        setDependencyPaths((previous) => previous.length === 0 ? previous : [])
        return
      }

      const nextPaths: DependencyPath[] = []

      for (const dependency of visibleDependencies) {
        if (!visibleTodoIdSet.has(dependency.predecessor_todo_id) || !visibleTodoIdSet.has(dependency.successor_todo_id)) continue

        const sourceElement = dependencySourceHandleRefs.current.get(dependency.predecessor_todo_id)
        const targetElement = dependencyTargetBarRefs.current.get(dependency.successor_todo_id)
        if (!sourceElement || !targetElement) continue

        const sourcePoint = getDependencyPointInCanvas(sourceElement, 'end', 0)
        const targetPoint = getDependencyPointInCanvas(targetElement, 'start', DEPENDENCY_TARGET_INSET)
        if (!sourcePoint || !targetPoint) continue

        nextPaths.push({
          id: dependency.id,
          path: buildDependencyPath(sourcePoint.x, sourcePoint.y, targetPoint.x, targetPoint.y)
        })
      }

      setDependencyPaths((previous) => areDependencyPathsEqual(previous, nextPaths) ? previous : nextPaths)
    }

    // 描いた直後に測って矢印を合わせる（次のフレームを待たない。画面が隠れているとフレームが来ないことがある）。
    // 文字の読み込みなどで位置が変わることもあるので、次のフレームでもう一度測る
    measureDependencyPaths()
    frameId = window.requestAnimationFrame(measureDependencyPaths)
    return () => window.cancelAnimationFrame(frameId)
  }, [
    chartGroups,
    collapsedTodoIds,
    dependencyGeometryByTodoId,
    dependencyLayoutVersion,
    getDependencyPointInCanvas,
    interaction,
    normalizedRange.end,
    normalizedRange.start,
    showSubtasks,
    timeScale,
    unitWidth,
    visibleDependencies,
    visibleTodoIdSet,
    zoom
  ])
  const dependencyPreviewPath = useMemo(() => {
    if (!dependencyDrag) return null

    const hoveredTargetElement = dependencyDrag.hoverSuccessorTodoId
      ? dependencyTargetBarRefs.current.get(dependencyDrag.hoverSuccessorTodoId) ?? null
      : null
    const hoveredPoint = hoveredTargetElement ? getDependencyPointInCanvas(hoveredTargetElement, 'start', DEPENDENCY_TARGET_INSET) : null
    const endX = hoveredPoint ? hoveredPoint.x : dependencyDrag.pointerX
    const endY = hoveredPoint ? hoveredPoint.y : dependencyDrag.pointerY

    return buildDependencyPath(dependencyDrag.originX, dependencyDrag.originY, endX, endY)
  }, [dependencyDrag, getDependencyPointInCanvas])
  const dependencyList = useMemo(() => (
    visibleDependencies
      .slice()
      .sort((a, b) => {
        const predecessorTitleA = todoById.get(a.predecessor_todo_id)?.title ?? ''
        const predecessorTitleB = todoById.get(b.predecessor_todo_id)?.title ?? ''
        if (predecessorTitleA !== predecessorTitleB) return predecessorTitleA.localeCompare(predecessorTitleB, 'ja')
        const successorTitleA = todoById.get(a.successor_todo_id)?.title ?? ''
        const successorTitleB = todoById.get(b.successor_todo_id)?.title ?? ''
        return successorTitleA.localeCompare(successorTitleB, 'ja')
      })
  ), [todoById, visibleDependencies])

  // 今日の列を囲む枠。行ごとに描くとカテゴリの境目で途切れるので、チャート全体に1つだけ重ねる。
  // 週・月・年表示では、単位の中の今日1日分の幅にする
  const todayBox = todayIndex >= 0 && todayIndex < totalUnits && todayX !== null
    ? (() => {
        const width = Math.max(unitWidth / todayUnitDays, 6)
        return { left: todayX - width / 2, width }
      })()
    : null

  const datedSubTaskCount = chartGroups.reduce((sum, group) => sum + group.datedSubTasks.length, 0)
  const taskSelectionSummary = selectedTodoIds.length === 0
    ? `${todoSelectionCandidates.length}件を表示中`
    : `${selectedTodoIds.length}件を選択中`

  const setDependencyDragState = useCallback((
    next: DependencyDragState | null | ((previous: DependencyDragState | null) => DependencyDragState | null)
  ): void => {
    const resolved = typeof next === 'function'
      ? next(dependencyDragRef.current)
      : next
    dependencyDragRef.current = resolved
    setDependencyDrag(resolved)
  }, [])

  const beginDependencyDrag = useCallback((todoId: string, event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !isTimelineEditable) return

    const origin = getDependencyPointInCanvas(event.currentTarget, 'end', 0)
    if (!origin) return

    event.preventDefault()
    event.stopPropagation()

    setDependencyFeedback(null)
    setDependencyDragState({
      predecessorTodoId: todoId,
      originX: origin.x,
      originY: origin.y,
      pointerX: origin.x,
      pointerY: origin.y,
      hoverSuccessorTodoId: null
    })
  }, [getDependencyPointInCanvas, isTimelineEditable, setDependencyDragState])

  useEffect(() => {
    if (!dependencyDrag || !isTimelineEditable) return

    const handlePointerMove = (event: PointerEvent): void => {
      const current = dependencyDragRef.current
      const canvasRect = chartCanvasRef.current?.getBoundingClientRect()
      if (!current || !canvasRect) return

      const pointerX = event.clientX - canvasRect.left - leftTableWidth
      const pointerY = event.clientY - canvasRect.top
      const hoverSuccessorTodoId = getHoveredDependencyTargetId(event.clientX, event.clientY, current.predecessorTodoId)

      setDependencyDragState((previous) => (
        previous
          ? { ...previous, pointerX, pointerY, hoverSuccessorTodoId }
          : null
      ))
    }

    const handlePointerUp = (): void => {
      const current = dependencyDragRef.current
      setDependencyDragState(null)
      if (!current?.hoverSuccessorTodoId) return
      const suggestedLagDays = getSuggestedDependencyLagDays(current.predecessorTodoId, current.hoverSuccessorTodoId)
      void createDependency(current.predecessorTodoId, current.hoverSuccessorTodoId, suggestedLagDays)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [createDependency, dependencyDrag, getHoveredDependencyTargetId, getSuggestedDependencyLagDays, isTimelineEditable, leftTableWidth, setDependencyDragState])

  return (
    <div className="tarbo-gantt" style={{ height: '100%', overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative', background: GANTT_SURFACE, color: GANTT_TEXT }}>
      {/* 見出しは1段の道具バー。期間・単位・ズームの操作をここに出し、件数や凡例は表示設定の中へ */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginRight: 4 }}>
          <div style={{ fontSize: '0.95rem', color: 'var(--slate-50)', fontWeight: 700, whiteSpace: 'nowrap' }}>ガントチャート</div>
          {listFilters}
        </div>

        <span role="group" aria-label="表示する期間" style={toolGroupStyle}>
          <button onClick={() => shiftVisibleRange(-1)} aria-label="前の期間へ" title="前の期間へ" style={toolButtonStyle(false)}>◀</button>
          <button onClick={handleJumpToToday} title="今日を左から 1/4 の位置に表示します" style={toolButtonStyle(false)}>今日</button>
          <button onClick={() => shiftVisibleRange(1)} aria-label="次の期間へ" title="次の期間へ" style={toolButtonStyle(false)}>▶</button>
        </span>

        <span role="group" aria-label="表示単位" style={toolGroupStyle}>
          {(['day', 'week', 'month', 'year'] as const).map((scale) => (
            <button key={scale} onClick={() => setTimeScale(scale)} aria-pressed={timeScale === scale} style={toolButtonStyle(timeScale === scale)}>
              {SCALE_LABELS[scale]}
            </button>
          ))}
        </span>

        <span role="group" aria-label={`ズーム（${ZOOM_LABELS[zoom]}）`} title={`ズーム: ${ZOOM_LABELS[zoom]}`} style={toolGroupStyle}>
          <button onClick={() => stepZoom(-1)} disabled={zoom === ZOOM_ORDER[0]} aria-label="縮小" title={`縮小（今: ${ZOOM_LABELS[zoom]}）`} style={toolButtonStyle(false, zoom === ZOOM_ORDER[0])}>−</button>
          <button onClick={() => stepZoom(1)} disabled={zoom === ZOOM_ORDER[ZOOM_ORDER.length - 1]} aria-label="拡大" title={`拡大（今: ${ZOOM_LABELS[zoom]}）`} style={toolButtonStyle(false, zoom === ZOOM_ORDER[ZOOM_ORDER.length - 1])}>＋</button>
        </span>

        {users.length > 0 && (
          <span role="group" aria-label="タスクの並べ方" title="タスクの並べ方" style={toolGroupStyle}>
            <button onClick={() => setGroupMode('category')} aria-pressed={groupMode === 'category'} style={toolButtonStyle(groupMode === 'category')}>カテゴリ別</button>
            <button onClick={() => setGroupMode('assignee')} aria-pressed={groupMode === 'assignee'} style={toolButtonStyle(groupMode === 'assignee')}>担当者別</button>
          </span>
        )}

        {/* 押すと、その状態のタスクだけに絞る。もう一度押すと戻す */}
        {showScheduleSignals && (healthChipCounts.overdue > 0 || healthFilter === 'overdue') && (
          <button
            onClick={() => setHealthFilter((previous) => previous === 'overdue' ? null : 'overdue')}
            aria-pressed={healthFilter === 'overdue'}
            title={healthFilter === 'overdue' ? '押すと絞り込みを外します' : '期限を過ぎたタスクだけを表示します'}
            style={healthFilterChipStyle('var(--red-950)', 'var(--red-500)', 'var(--red-200)', healthFilter === 'overdue')}
          >
            期限超過 {healthChipCounts.overdue}{healthFilter === 'overdue' ? ' ×' : ''}
          </button>
        )}
        {showScheduleSignals && (healthChipCounts.behind > 0 || healthFilter === 'behind') && (
          <button
            onClick={() => setHealthFilter((previous) => previous === 'behind' ? null : 'behind')}
            aria-pressed={healthFilter === 'behind'}
            title={healthFilter === 'behind' ? '押すと絞り込みを外します' : `予定より${behindThresholdDays}日分以上、または半分以上遅れているタスクだけを表示します（日数は表示設定で変えられます）`}
            style={healthFilterChipStyle('var(--amber-950)', 'var(--amber-500)', 'var(--amber-200)', healthFilter === 'behind')}
          >
            遅れ {healthChipCounts.behind}{healthFilter === 'behind' ? ' ×' : ''}
          </button>
        )}
        {unscheduledGroups.length > 0 && (
          // 日付のないタスクはチャートの下に出るので、件数を見せて押すとそこへ移動する
          <button
            onClick={() => {
              setShowUnscheduled(true)
              toggleUnscheduledOpen(true)
              window.requestAnimationFrame(() => unscheduledSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
            }}
            title="開始日・期限のないタスク。押すとチャートの下の一覧へ移動します"
            style={{ ...healthSummaryChipStyle('var(--yellow-950)', 'var(--amber-500)', 'var(--amber-200)'), cursor: 'pointer' }}
          >
            日付なし {unscheduledGroups.length}件 ↓
          </button>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
          <button
            onClick={() => void performUndo()}
            disabled={!lastUndoEntry || undoPending}
            title={lastUndoEntry ? `戻す: ${lastUndoEntry.label}（Ctrl+Z）` : 'ガントで動かした日程や依存関係を1つ戻せます（いまは戻すものがありません）。詳細での変更は、知らせの「元に戻す」で戻せます'}
            style={{
              ...headerActionButtonStyle,
              border: `1px solid ${lastUndoEntry && !undoPending ? 'var(--green-600)' : 'var(--slate-700)'}`,
              background: lastUndoEntry && !undoPending ? 'var(--green-900)' : 'var(--slate-900)',
              color: lastUndoEntry && !undoPending ? 'var(--green-100)' : 'var(--slate-500)',
              cursor: lastUndoEntry && !undoPending ? 'pointer' : 'not-allowed'
            }}
          >
            {undoPending ? '戻しています...' : '1つ戻る'}
          </button>
          <button
            onClick={() => setIsReorderMode((previous) => !previous)}
            disabled={reorderPending || (!isReorderMode && !canStartReorderMode)}
            style={{
              ...headerActionButtonStyle,
              border: `1px solid ${isReorderMode ? 'var(--green-600)' : 'var(--blue-600)'}`,
              background: isReorderMode ? 'var(--green-900)' : 'var(--blue-950)',
              color: isReorderMode ? 'var(--green-100)' : 'var(--blue-100)',
              cursor: reorderPending || (!isReorderMode && !canStartReorderMode) ? 'not-allowed' : 'pointer',
              opacity: reorderPending || (!isReorderMode && !canStartReorderMode) ? 0.55 : 1
            }}
            title={!isReorderMode && !canStartReorderMode ? '並べ替え対象のタスクが2件以上あるときに有効です。' : isReorderMode ? '並べ替えモード中です。押すと終わります（Esc でも終わります）' : 'タスクの行をドラッグして並べ替えます'}
          >
            {reorderPending ? '並べ替えを保存中...' : isReorderMode ? '並べ替え完了' : '並べ替え'}
          </button>
          <button onClick={() => setControlsCollapsed((previous) => !previous)} aria-expanded={!controlsCollapsed} style={headerActionButtonStyle}>
            表示設定
          </button>
          {!standalone && onOpenSeparateWindow && (
            <button onClick={onOpenSeparateWindow} style={headerActionButtonStyle}>
              別ウィンドウで開く
            </button>
          )}
          {standalone && <div style={standaloneBadgeStyle}>別ウィンドウ表示</div>}
        </div>
      </div>
      {reorderFeedback && <div role="alert" style={{ fontSize: 'var(--font-caption)', color: 'var(--red-300)' }}>{reorderFeedback}</div>}

      {!controlsCollapsed && (
        <div style={settingsPanelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: '0.86rem', color: 'var(--slate-50)', fontWeight: 700 }}>表示設定</div>
            <button onClick={() => setControlsCollapsed(true)} style={floatingCloseButtonStyle}>閉じる</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            {/* 以前は見出しの下に並べていた今の表示の内容と凡例。毎回は見ないので、ここにまとめる */}
            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>今の表示</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={collapsedSummaryChipStyle}>期間 {shortDateLabel(normalizedRange.start)} - {shortDateLabel(normalizedRange.end)}</span>
                <span style={collapsedSummaryChipStyle}>表示単位 {SCALE_LABELS[timeScale]}</span>
                <span style={collapsedSummaryChipStyle}>ズーム {ZOOM_LABELS[zoom]}</span>
                <span style={collapsedSummaryChipStyle}>表示 {displayedRangeGroups.length}件</span>
                <span style={collapsedSummaryChipStyle}>サブタスク {visibleSubTaskCount}/{datedSubTaskCount}</span>
                {expandableTodoIds.length > 0 && <span style={collapsedSummaryChipStyle}>展開 {expandedTodoCount}/{expandableTodoIds.length}</span>}
                {showBaseline && baselineCapturedLabel && <span style={collapsedSummaryChipStyle}>基準線 {baselineCapturedLabel}</span>}
                {showScheduleSignals && scheduleHealthSummary.healthy > 0 && <span style={healthSummaryChipStyle('var(--sky-950)', 'var(--sky-400)', 'var(--sky-100)')}>順調 {scheduleHealthSummary.healthy}</span>}
                {showScheduleSignals && scheduleHealthSummary.future > 0 && <span style={healthSummaryChipStyle('var(--slate-900)', 'var(--slate-500)', 'var(--slate-300)')}>開始前 {scheduleHealthSummary.future}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} aria-label="凡例">
                <span style={legendItemStyle()}><span style={{ width: 10, height: 10, borderRadius: 2, background: STATUS_TONE.on_hold.background, border: `1px solid ${STATUS_TONE.on_hold.border}` }} />保留中</span>
                <span style={legendItemStyle()}><span style={{ width: 10, height: 12, border: `2px solid ${TODAY_LINE_COLOR}`, borderTop: 'none', borderBottom: 'none', background: 'color-mix(in srgb, var(--rose-500) 15%, transparent)' }} />今日</span>
                {timeScale === 'day' && (
                  <span style={legendItemStyle()}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'color-mix(in srgb, var(--red-400) 25.1%, transparent)', border: '1px solid color-mix(in srgb, var(--red-400) 40%, transparent)' }} />土日祝</span>
                )}
                {showScheduleSignals && (
                  <>
                    <span style={legendItemStyle()}><span style={{ width: 10, height: 10, borderRadius: 2, background: HEALTH_BAR_TONE.onTrack.fill }} />順調</span>
                    <span style={legendItemStyle()}><span style={{ width: 10, height: 10, borderRadius: 2, background: HEALTH_BAR_TONE.behind.fill }} />遅れ</span>
                    <span style={legendItemStyle()}><span style={{ width: 10, height: 10, borderRadius: 2, background: HEALTH_BAR_TONE.overdue.fill }} />期限超過</span>
                    <span style={legendItemStyle()}><span style={{ width: 14, height: 8, background: OVERDUE_HATCH, border: '1px dashed var(--red-500)' }} />超過している日数</span>
                  </>
                )}
              </div>
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>左の表に出す列</label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {OPTIONAL_LEFT_COLUMNS.map((key) => (
                  <label key={key} style={toggleLabelStyle}>
                    <input
                      type="checkbox"
                      checked={visibleLeftColumns.includes(key)}
                      onChange={(event) => setVisibleLeftColumns((previous) => (
                        event.target.checked
                          ? OPTIONAL_LEFT_COLUMNS.filter((column) => column === key || previous.includes(column))
                          : previous.filter((column) => column !== key)
                      ))}
                    />
                    <span>{leftColumnDef(key).label}</span>
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>タスク名はいつも出します。バーの上にも担当と進捗が出ます。</div>
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>期間</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setRangeMode('auto')} style={chipStyle(rangeMode === 'auto')}>自動</button>
                <button
                  onClick={() => {
                    setRangeMode('manual')
                    setManualPreset(null)
                    if (!manualStart) setManualStart(addDays(todayKey, -7))
                    if (!manualEnd) setManualEnd(addDays(todayKey, 14))
                  }}
                  style={chipStyle(rangeMode === 'manual' && manualPreset === null)}
                >
                  カスタム
                </button>
                {RANGE_PRESETS.map((preset) => (
                  <button
                    key={`floating-${preset.key}`}
                    onClick={() => applyManualPreset(preset.key)}
                    style={chipStyle(rangeMode === 'manual' && manualPreset === preset.key)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="date"
                  value={rangeMode === 'manual' ? manualStart : normalizedRange.start}
                  onChange={(event) => {
                    setRangeMode('manual')
                    setManualPreset(null)
                    setManualStart(event.target.value)
                  }}
                  style={{ ...inputStyle, minWidth: 152 }}
                />
                <input
                  type="date"
                  value={rangeMode === 'manual' ? manualEnd : normalizedRange.end}
                  onChange={(event) => {
                    setRangeMode('manual')
                    setManualPreset(null)
                    setManualEnd(event.target.value)
                  }}
                  style={{ ...inputStyle, minWidth: 152 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => shiftVisibleRange(-1)} style={chipStyle(false)}>前へ</button>
                <button onClick={handleJumpToToday} style={chipStyle(false)}>今日</button>
                <button onClick={() => shiftVisibleRange(1)} style={chipStyle(false)}>次へ</button>
              </div>
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>表示単位とズーム</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['day', 'week', 'month', 'year'] as const).map((scale) => (
                  <button key={scale} onClick={() => setTimeScale(scale)} style={chipStyle(timeScale === scale)}>
                    {SCALE_LABELS[scale]}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['compact', 'normal', 'detail', 'focus'] as const).map((mode) => (
                  <button key={mode} onClick={() => setZoom(mode)} style={chipStyle(zoom === mode)}>
                    {ZOOM_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>フィルター</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setStatusFilter('active')} style={chipStyle(statusFilter === 'active')}>未完了</button>
                <button onClick={() => setStatusFilter('on_hold')} style={chipStyle(statusFilter === 'on_hold')}>保留中</button>
                <button onClick={() => setStatusFilter('done')} style={chipStyle(statusFilter === 'done')}>完了</button>
                <button onClick={() => setStatusFilter('all')} style={chipStyle(statusFilter === 'all')}>すべて</button>
              </div>
              <input
                value={taskQuery}
                onChange={(event) => setTaskQuery(event.target.value)}
                placeholder="タイトル・メモ・カテゴリで絞り込み"
                style={{ ...inputStyle, width: '100%' }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={toggleLabelStyle}>
                  <input type="checkbox" checked={showSubtasks} onChange={(event) => setShowSubtasks(event.target.checked)} />
                  <span>サブタスクを表示</span>
                </label>
                <label style={toggleLabelStyle}>
                  <input type="checkbox" checked={showOutOfRange} onChange={(event) => setShowOutOfRange(event.target.checked)} />
                  <span>期間外の項目を表示</span>
                </label>
                <label style={toggleLabelStyle}>
                  <input type="checkbox" checked={showUnscheduled} onChange={(event) => setShowUnscheduled(event.target.checked)} />
                  <span>未配置を表示</span>
                </label>
                <label style={toggleLabelStyle}>
                  <input type="checkbox" checked={showScheduleSignals} onChange={(event) => setShowScheduleSignals(event.target.checked)} />
                  <span>進捗シグナルを表示</span>
                </label>
                {baselineSnapshot && (
                  <label style={toggleLabelStyle}>
                    <input type="checkbox" checked={showBaseline} onChange={(event) => setShowBaseline(event.target.checked)} />
                    <span>基準線を表示</span>
                  </label>
                )}
              </div>
              {showSubtasks && expandableTodoIds.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => setCollapsedTodoIds([])} style={chipStyle(collapsedTodoIds.length === 0)}>
                    すべて展開
                  </button>
                  <button onClick={() => setCollapsedTodoIds(expandableTodoIds)} style={chipStyle(expandedTodoCount === 0)}>
                    すべて折りたたむ
                  </button>
                </div>
              )}
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>遅れの判定</label>
              <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)', lineHeight: 1.6 }}>
                期間のうち今日までに過ぎた日数の割合を「予定の進捗」とし、実際の進捗が予定より何日分遅れているかで判定します。
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--font-control)', color: 'var(--slate-300)' }}>予定より</span>
                {BEHIND_THRESHOLD_OPTIONS.map((days) => (
                  <button key={days} onClick={() => setBehindThresholdDays(days)} style={chipStyle(behindThresholdDays === days)}>
                    {days}日
                  </button>
                ))}
                <span style={{ fontSize: 'var(--font-control)', color: 'var(--slate-300)' }}>以上遅れていたら「遅れ」</span>
              </div>
              <label style={toggleLabelStyle}>
                <input type="checkbox" checked={workingDaysOnly} onChange={(event) => setWorkingDaysOnly(event.target.checked)} />
                <span>土日・祝日を除いて数える</span>
              </label>
              <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', lineHeight: 1.6 }}>
                例: 10日間のタスクの5日目なら予定は45%。実際が20%なら約2.5日分の遅れです。
                期限を過ぎて100%未満は「期限超過」、開始日前で0%は「開始前」になります。
              </div>
            </div>

            {categoryOptions.length > 0 && (
              <div style={settingsSectionStyle}>
                <label style={controlLabelStyle}>カテゴリ</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => setSelectedCategoryKeys([])} style={chipStyle(selectedCategoryKeys.length === 0)}>すべて</button>
                  {categoryOptions.map((option) => (
                    <button
                      key={option.key}
                      onClick={() => toggleCategory(option.key)}
                      style={tagStyle(selectedCategoryKeys.includes(option.key), option.color ?? 'var(--slate-500)')}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={settingsSectionStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <label style={controlLabelStyle}>表示タスク</label>
                <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>{taskSelectionSummary}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setSelectedTodoIds([])} style={chipStyle(selectedTodoIds.length === 0)}>すべて</button>
                {selectedTodoIds.length > 0 && (
                  <button onClick={() => setSelectedTodoIds([])} style={chipStyle(false)}>解除</button>
                )}
              </div>
              <div style={taskSelectionPanelStyle}>
                {todoSelectionCandidates.length === 0 ? (
                  <div style={selectionEmptyStyle}>該当するタスクはありません。</div>
                ) : (
                  todoSelectionCandidates.map((todo) => (
                    <button
                      key={todo.id}
                      onClick={() => toggleTodoSelection(todo.id)}
                      style={taskToggleStyle(selectedTodoIds.includes(todo.id), todo.category_color)}
                    >
                      {todo.title}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>依存関係</label>
              <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)', lineHeight: 1.5 }}>
                前タスクの完了後に後タスクを開始する関係です。待機日数を入れると、その分だけ開始を後ろへずらします。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                <select
                  value={dependencyDraft.predecessorTodoId}
                  onChange={(event) => setDependencyDraft((previous) => ({ ...previous, predecessorTodoId: event.target.value }))}
                  style={inputStyle}
                >
                  <option value="">前タスクを選択</option>
                  {dependencyOptions.map((todo) => (
                    <option key={`pred-${todo.id}`} value={todo.id}>{todo.title}</option>
                  ))}
                </select>
                <select
                  value={dependencyDraft.successorTodoId}
                  onChange={(event) => setDependencyDraft((previous) => ({ ...previous, successorTodoId: event.target.value }))}
                  style={inputStyle}
                >
                  <option value="">後タスクを選択</option>
                  {dependencyOptions.map((todo) => (
                    <option key={`succ-${todo.id}`} value={todo.id}>{todo.title}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={dependencyDraft.lagDays}
                  onChange={(event) => setDependencyDraft((previous) => ({ ...previous, lagDays: event.target.value }))}
                  style={inputStyle}
                  placeholder="待機日数"
                />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => void createDependency()} style={chipStyle(false)}>依存関係を追加</button>
              </div>
              <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>タスクバー右端の丸をドラッグしても依存関係を追加できます。</div>
              {dependencyFeedback && <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>{dependencyFeedback}</div>}
              {dependencyList.length === 0 ? (
                <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>依存関係はまだありません。</div>
              ) : (
                <div style={dependencyListStyle}>
                  {dependencyList.map((dependency) => (
                    <div key={dependency.id} style={dependencyRowStyle}>
                      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--slate-200)', fontSize: 'var(--font-control)', fontWeight: 700 }}>
                          {todoById.get(dependency.predecessor_todo_id)?.title ?? '不明なタスク'}
                        </span>
                        <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--font-caption)' }}>-&gt;</span>
                        <span style={{ color: 'var(--slate-300)', fontSize: 'var(--font-control)' }}>
                          {todoById.get(dependency.successor_todo_id)?.title ?? '不明なタスク'}
                        </span>
                        <span style={dependencyLagBadgeStyle}>
                          待機 {dependency.lag_days}日
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button onClick={() => void updateDependencyLag(dependency.id, Math.max(0, dependency.lag_days - 1), dependency.predecessor_todo_id, dependency.successor_todo_id)} style={dependencyLagButtonStyle}>-1日</button>
                        <button onClick={() => void updateDependencyLag(dependency.id, dependency.lag_days + 1, dependency.predecessor_todo_id, dependency.successor_todo_id)} style={dependencyLagButtonStyle}>+1日</button>
                        <button onClick={() => void removeDependency(dependency.id)} style={dependencyDeleteButtonStyle}>削除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>基準線</label>
              <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)', lineHeight: 1.5 }}>
                現在の予定を保存し、あとから実際の計画と見比べられます。
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={captureBaseline} style={chipStyle(false)}>現在の予定を保存</button>
                {baselineSnapshot && (
                  <button onClick={() => setShowBaseline((previous) => !previous)} style={chipStyle(showBaseline)}>
                    {showBaseline ? '基準線を隠す' : '基準線を表示'}
                  </button>
                )}
                {baselineSnapshot && (
                  <button onClick={() => setBaselineSnapshot(null)} style={secondaryActionChipStyle}>
                    基準線を削除
                  </button>
                )}
              </div>
              <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>
                {baselineSnapshot
                  ? `保存日時 ${baselineSnapshot.capturedAt.slice(0, 10)} ${baselineSnapshot.capturedAt.slice(11, 16)}`
                  : '保存済みの基準線はありません。'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* チャートは、ガントの画面に残っている高さいっぱいに広げる（低い窓で横スクロールバーが窓の外に出ないように）。最小は CHART_MIN_HEIGHT */}
      <div style={{ flex: `1 0 ${CHART_MIN_HEIGHT}px`, minHeight: CHART_MIN_HEIGHT, border: '1px solid var(--slate-800)', borderRadius: 8, background: 'var(--c-0b1220)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {loading || (dataLoading && todos.length === 0) ? (
          <div style={centerEmptyStyle}>タスクを読み込み中...</div>
        ) : !hasAnyTodos ? (
          <div style={{ ...centerEmptyStyle, flexDirection: 'column' }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--slate-200)' }}>まだタスクがありません</div>
            <div style={{ marginTop: 6, fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>
              タスクを追加すると、開始日から期限までが横棒で表示されます。バーをドラッグすると日程を変えられます。
            </div>
            {onAddTodo && (
              <button onClick={() => onAddTodo()} style={{ ...headerActionButtonStyle, marginTop: 12, background: 'var(--blue-700)', borderColor: 'var(--blue-600)', color: 'var(--on-fill-blue-50)' }}>＋ 最初のタスクを追加</button>
            )}
          </div>
        ) : displayedRangeGroups.length === 0 ? (
          <div style={{ ...centerEmptyStyle, flexDirection: 'column' }}>
            <div>この条件で表示できる予定タスクはありません。</div>
            <div style={{ marginTop: 6, fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>
              {unscheduledGroups.length > 0 ? `日付のないタスクが${unscheduledGroups.length}件あります（下の「未配置タスク」）。` : ''}
              画面上部に「タスク一覧の絞り込み」が出ているときは、そこでも解除できます。
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
              {onAddTodo && <button onClick={() => onAddTodo()} style={{ ...headerActionButtonStyle, background: 'var(--blue-700)', borderColor: 'var(--blue-600)', color: 'var(--on-fill-blue-50)' }}>＋ タスクを追加</button>}
              <button onClick={() => { setTaskQuery(''); setStatusFilter('all'); setShowOutOfRange(true); setShowUnscheduled(true); setHealthFilter(null) }} style={headerActionButtonStyle}>ガントの絞り込みを解除</button>
              <button onClick={() => setRangeMode('auto')} style={headerActionButtonStyle}>期間を自動に戻す</button>
            </div>
          </div>
        ) : (
          <div ref={scrollRef} style={{ height: '100%', minHeight: 0, overflow: 'auto' }}>
            <div style={{ minWidth: leftTableWidth + timelineWidth }}>
              <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 6 }}>
                <div style={{ position: 'sticky', left: 0, width: leftTableWidth, minWidth: leftTableWidth, boxSizing: 'border-box', background: 'var(--slate-900)', borderRight: '1px solid var(--slate-800)', borderBottom: '1px solid var(--slate-800)', padding: '6px 8px' }}>
                  <div style={{ ...leftHeaderGridStyle, gridTemplateColumns: leftGridTemplate }}>
                    {visibleLeftColumnDefs.map((column) => (
                      <div key={column.key} style={leftHeaderCellStyle}>
                        <span style={leftHeaderLabelStyle}>{column.label}</span>
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`${column.label}列幅を変更`}
                          onPointerDown={(event) => beginLeftColumnResize(column.key, event)}
                          style={leftColumnResizeHandleStyle(resizingLeftColumn?.column === column.key)}
                          title={`${column.label}列の幅を変更`}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ width: timelineWidth, display: 'flex', background: 'var(--slate-900)', borderBottom: '1px solid var(--slate-800)' }}>
                  {timelineUnits.map((unit) => (
                    <div
                      key={unit.key}
                      title={unit.holidayName ?? undefined}
                      style={{
                        width: unitWidth,
                        minWidth: unitWidth,
                        padding: '5px 0 6px',
                        textAlign: 'center',
                        background: unit.background,
                        borderRight: '1px solid var(--slate-800)',
                        // 日表示では、下の今日の列の枠とつながるように上と左右を囲む
                        boxShadow: unit.isCurrent && timeScale === 'day'
                          ? `inset 2px 0 0 ${TODAY_LINE_COLOR}, inset -2px 0 0 ${TODAY_LINE_COLOR}, inset 0 2px 0 ${TODAY_LINE_COLOR}`
                          : undefined
                      }}
                    >
                      <div style={{ fontSize: 'var(--font-caption)', color: unit.isCurrent ? (timeScale === 'day' ? 'var(--rose-200)' : 'var(--blue-200)') : unit.dayKind === 'saturday' ? 'var(--sky-300)' : unit.dayKind ? 'var(--red-300)' : 'var(--text-subtle)' }}>{unit.primaryLabel}</div>
                      <div style={{ marginTop: 2, fontSize: 'var(--font-caption)', color: unit.isCurrent ? 'var(--blue-100)' : 'var(--slate-300)', fontWeight: unit.isCurrent ? 700 : 500 }}>{unit.secondaryLabel}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div ref={chartCanvasRef} style={{ position: 'relative' }}>
                {(dependencyPaths.length > 0 || dependencyPreviewPath) && (
                  <svg
                    width={timelineWidth}
                    height={rowLayout.totalHeight}
                    style={{ position: 'absolute', top: 0, left: leftTableWidth, overflow: 'visible', pointerEvents: 'none', zIndex: 1 }}
                    aria-hidden="true"
                  >
                    <defs>
                      <marker id="ganttDependencyArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                        <path d="M 0 0 L 8 4 L 0 8 z" style={{ fill: 'var(--amber-500)' }} />
                      </marker>
                      <marker id="ganttDependencyPreviewArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                        <path d="M 0 0 L 8 4 L 0 8 z" style={{ fill: 'var(--sky-400)' }} />
                      </marker>
                    </defs>
                    {dependencyPaths.map((dependency) => (
                      <path
                        key={dependency.id}
                        d={dependency.path}
                        fill="none"
                        // SVG の属性では var() が効かないので、色は style で渡す
                        style={{ stroke: 'var(--amber-500)' }}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        markerEnd="url(#ganttDependencyArrow)"
                        opacity="0.92"
                      />
                    ))}
                    {dependencyPreviewPath && (
                      <path
                        d={dependencyPreviewPath}
                        fill="none"
                        style={{ stroke: dependencyDrag?.hoverSuccessorTodoId ? 'var(--sky-400)' : 'var(--slate-400)' }}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray="7 5"
                        markerEnd="url(#ganttDependencyPreviewArrow)"
                        opacity="0.96"
                      />
                    )}
                  </svg>
                )}

                {todayBox && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: leftTableWidth + todayBox.left,
                      width: todayBox.width,
                      borderLeft: `2px solid ${TODAY_LINE_COLOR}`,
                      borderRight: `2px solid ${TODAY_LINE_COLOR}`,
                      background: 'color-mix(in srgb, var(--rose-500) 8%, transparent)',
                      boxSizing: 'border-box',
                      pointerEvents: 'none',
                      // 左の一覧（z-index 3 以上）より下、バーの文字（同じ 2 で後から描かれる）より下
                      zIndex: 2
                    }}
                  />
                )}

                {chartSections.map((section) => (
                  <React.Fragment key={section.key}>
                    {showCategoryGrouping && (
                      <div
                        style={{
                          display: 'flex',
                          minHeight: CATEGORY_HEADER_HEIGHT,
                          background: `color-mix(in srgb, ${section.color} 7.8%, transparent)`
                        }}
                      >
                        <div
                          style={{
                            position: 'sticky',
                            left: 0,
                            zIndex: 5,
                            width: leftTableWidth,
                            minWidth: leftTableWidth,
                            boxSizing: 'border-box',
                            backgroundColor: 'var(--c-161b2c)',
                            backgroundImage: `linear-gradient(90deg, color-mix(in srgb, ${section.color} 33.3%, transparent), color-mix(in srgb, ${section.color} 7.8%, transparent) 80%)`,
                            borderRight: `1px solid ${GANTT_LINE}`,
                            borderLeft: `3px solid ${section.color}`,
                            // 上端にカテゴリ色の線を引いて、ここから新しいまとまりだと分かるようにする
                            boxShadow: `inset 0 2px 0 ${section.color}`,
                            padding: '0 12px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10
                          }}
                        >
                          <button
                            onClick={() => toggleCategorySection(section.key)}
                            aria-label={section.collapsed ? `${section.label}を展開する` : `${section.label}を折りたたむ`}
                            style={categoryCollapseButtonStyle(section.collapsed)}
                          >
                            ▾
                          </button>
                          <span style={{ color: GANTT_TEXT, fontSize: '0.86rem', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{section.label}</span>
                          <span className="nm-pressed-xs" style={categoryCountBadgeStyle}>{section.totalCount}</span>
                          {section.allDone && <span style={{ ...statusDotStyle, width: 8, height: 8, background: STATUS_TONE.done.fill }} title="すべて完了" />}
                          {onAddTodo && !isReorderMode && (
                            <button
                              onClick={() => {
                                if (String(section.key).startsWith(ASSIGNEE_SECTION_PREFIX)) {
                                  onAddTodo({ assigneeId: String(section.key).slice(ASSIGNEE_SECTION_PREFIX.length) || null })
                                } else {
                                  const categoryId = String(section.key)
                                  onAddTodo({ categoryId: categoryOptions.some((option) => option.key === section.key) && categoryId !== NO_CATEGORY_KEY ? categoryId : null })
                                }
                              }}
                              title={`「${section.label}」にタスクを追加`}
                              aria-label={`${section.label}にタスクを追加`}
                              style={{ ...subTaskAddButtonStyle(false), marginLeft: 'auto', width: 'auto', padding: '0 8px', fontSize: 'var(--font-caption)' }}
                            >
                              ＋ 追加
                            </button>
                          )}
                        </div>
                        <div
                          onPointerDown={beginPan}
                          style={{
                            width: timelineWidth,
                            minWidth: timelineWidth,
                            minHeight: CATEGORY_HEADER_HEIGHT,
                            boxShadow: `inset 0 2px 0 ${section.color}`,
                            cursor: 'grab'
                          }}
                        />
                      </div>
                    )}
                    {!section.collapsed && section.groups.map((group, groupIndex) => {
                const tone = parentTone(group.todo)
                // ToDoリストは進捗率を使わず、ドラッグで日程も変えない（開始日は表の欄で変えられる）
                const listMode = group.todo.list_mode === 1
                const barEditable = isTimelineEditable && !listMode
                const checklistSummary = checklistSummaryByTodo.get(group.todo.id)
                const checklistText = listMode && checklistSummary ? checklistBadgeText(checklistSummary) : undefined
                const progress = listMode ? 0 : clamp(group.todo.status === 'done' ? 100 : group.todo.progress, 0, 100)
                const todoBar = group.todoBar
                const baselineBar = showBaseline ? baselineSnapshot?.todos[group.todo.id] ?? null : null
                const scheduleHealth = scheduleHealthByTodoId.get(group.todo.id) ?? null
                const canToggleSubtasks = showSubtasks && (group.datedSubTasks.length > 0 || addingSubTaskTodoId === group.todo.id)
                const isExpanded = !collapsedTodoIds.includes(group.todo.id)
                const activeState = interaction?.targetType === 'todo' && interaction.targetId === group.todo.id ? interaction : null
                const dependencyGeometry = dependencyGeometryByTodoId.get(group.todo.id) ?? null
                const isDependencySource = dependencyDrag?.predecessorTodoId === group.todo.id
                const isDependencyTarget = dependencyDrag?.hoverSuccessorTodoId === group.todo.id
                const isReorderDragSource = isReorderMode && draggingTodoId === group.todo.id
                const isReorderDragTarget = isReorderMode && dragOverTodoId === group.todo.id && draggingTodoId !== group.todo.id
                const displayedTodoBar = todoBar
                  ? normalizeBar(
                    activeState ? activeState.previewStartDate : todoBar.startDate,
                    activeState ? activeState.previewEndDate : todoBar.endDate
                  )
                  : null
                const todoVisible = displayedTodoBar
                  ? showOutOfRange || intersectsRange(displayedTodoBar.startDate, displayedTodoBar.endDate, normalizedRange.start, normalizedRange.end)
                  : false
                const todoOutsideRange = displayedTodoBar
                  ? outOfRangeDirection(displayedTodoBar, normalizedRange.start, normalizedRange.end)
                  : null
                const actualStartIndex = displayedTodoBar ? diffUnits(displayedTodoBar.startDate, timelineStart, timeScale) : 0
                const actualEndIndex = displayedTodoBar ? diffUnits(displayedTodoBar.endDate, timelineStart, timeScale) : 0
                const clipped = displayedTodoBar ? actualStartIndex < 0 || actualEndIndex > totalUnits - 1 : false
                const displayStartIndex = displayedTodoBar ? clamp(actualStartIndex, 0, totalUnits - 1) : 0
                const displayEndIndex = displayedTodoBar ? clamp(actualEndIndex, 0, totalUnits - 1) : 0
                const barWidth = displayedTodoBar
                  ? todoOutsideRange ? 76 : Math.max((displayEndIndex - displayStartIndex + 1) * unitWidth - 8, 24)
                  : 0
                const barLeft = todoOutsideRange === 'after'
                  ? Math.max(timelineWidth - barWidth - 4, 4)
                  : todoOutsideRange === 'before'
                    ? 4
                    : displayStartIndex * unitWidth + 4
                const trackBackground = group.todo.status === 'not_started'
                  ? `linear-gradient(90deg, ${tone.fill}, var(--c-596474))`
                  : `linear-gradient(90deg, color-mix(in srgb, ${tone.fill} var(--gantt-track-mix), transparent), color-mix(in srgb, ${tone.border} var(--gantt-track-mix), transparent))`
                const baselineVisible = baselineBar
                  ? intersectsRange(baselineBar.startDate, baselineBar.endDate, normalizedRange.start, normalizedRange.end)
                  : false
                const baselineStartIndex = baselineBar ? clamp(diffUnits(baselineBar.startDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                const baselineEndIndex = baselineBar ? clamp(diffUnits(baselineBar.endDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                // 進捗シグナルを出すときは、バーの色で順調／遅れ／期限超過が分かるようにする
                const barTone = group.todo.status !== 'on_hold' && showScheduleSignals && scheduleHealth
                  ? HEALTH_BAR_TONE[scheduleHealth.status]
                  : { fill: tone.background, track: trackBackground, border: tone.border, text: tone.text }
                const barEnd = barLeft + barWidth
                // 期限を過ぎているタスクは、期限から今日までを斜線で延ばして遅れを見せる
                // 遅れ・期限超過は、バーの色に加えて文字でも出す（色の見分けが付きにくい人にも分かるように）
                const scheduleStatusText = showScheduleSignals && group.todo.status !== 'on_hold' && (scheduleHealth?.status === 'behind' || scheduleHealth?.status === 'overdue')
                  ? scheduleHealth.label
                  : null
                const overdueTail = showScheduleSignals && scheduleHealth?.status === 'overdue' && displayedTodoBar && todoVisible && !todoOutsideRange && todayX !== null && todayX > barEnd
                  ? { left: barEnd, width: Math.min(todayX, timelineWidth) - barEnd, title: `${scheduleHealth.label}（期限 ${shortDateLabel(displayedTodoBar.endDate)} から今日まで）` }
                  : null
                const discussionCount = discussionCountByTodo.get(group.todo.id) ?? 0
                const sectionStripeColor = showCategoryGrouping ? section.color : (group.todo.category_color ?? 'transparent')
                // 要相談の印は、バーの右外にある依存関係のつかみ（または期限超過の斜線）を避けて置く
                const discussionMarkerLeft = Math.min(overdueTail ? overdueTail.left + overdueTail.width + 6 : barEnd + 18, Math.max(timelineWidth - 60, 0))
                // バーが短くて名前が入らないときは、バーの右の外（依存関係のつかみ・期限超過の斜線・要相談の印の後ろ）に名前を出す
                const parentTitleText = `${listMode ? '☑ ' : group.todo.status === 'on_hold' ? '保留中 · ' : ''}${group.todo.title}`
                const parentTitleWidth = Array.from(parentTitleText).reduce((sum, char) => sum + (char.charCodeAt(0) < 0x2000 ? 7 : 11.5), 0) + 24
                const parentLabelOutside = Boolean(displayedTodoBar && todoVisible && !todoOutsideRange && unitWidth >= UNIT_WIDTH[timeScale].normal && barWidth < parentTitleWidth)
                const parentLabelLeft = discussionCount > 0
                  ? discussionMarkerLeft + 64
                  : overdueTail ? overdueTail.left + overdueTail.width + 8 : barEnd + 22
                const barTooltip = displayedTodoBar
                  ? buildTodoBarTooltip({
                    todo: group.todo,
                    bar: displayedTodoBar,
                    outside: todoOutsideRange,
                    health: scheduleHealth,
                    progress,
                    latestNote: latestNoteByTodo.get(group.todo.id) ?? null,
                    lastReportAt: lastReportByTodo.get(group.todo.id) ?? null,
                    discussionCount,
                    checklistText
                  })
                  : undefined

                return (
                  <div
                    key={group.todo.id}
                    style={{
                      marginBottom: groupIndex === section.groups.length - 1 ? CATEGORY_GROUP_GAP : TASK_GROUP_GAP,
                      background: GANTT_SURFACE_PRESSED,
                      boxShadow: isReorderDragTarget ? '0 0 0 2px color-mix(in srgb, var(--sky-400) 34%, transparent) inset' : undefined
                    }}
                  >
                    <div
                      className="tarbo-gantt-row"
                      data-gantt-todo-id={group.todo.id}
                      onDragOver={(event) => { void handleReorderDragOver(group.todo.id, event) }}
                      onDrop={(event) => { void handleReorderDrop(group.todo.id, event) }}
                      onDragEnd={() => {
                        setDraggingTodoId(null)
                        setDragOverTodoId(null)
                      }}
                      style={{
                        display: 'flex',
                        minHeight: PARENT_ROW_HEIGHT,
                        borderTop: isReorderDragTarget ? '2px solid var(--sky-400)' : `1px solid ${TASK_DIVIDER_COLOR}`,
                        opacity: isReorderDragSource ? 0.7 : 1
                      }}
                    >
                      <div style={{ position: 'sticky', left: 0, zIndex: 4, width: leftTableWidth, minWidth: leftTableWidth, boxSizing: 'border-box', background: 'var(--slate-900)', borderRight: '1px solid var(--slate-800)', padding: '0 8px', borderLeft: `3px solid ${sectionStripeColor}` }}>
                        <div {...leftGridAttributes} style={{ ...leftRowGridStyle, gridTemplateColumns: leftGridTemplate }}>
                          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {isReorderMode && (
                            <div
                              draggable={!reorderPending}
                              onDragStart={(event) => handleReorderDragStart(group.todo.id, event)}
                              style={reorderHandleStyle(reorderPending, isReorderDragSource)}
                              title="ドラッグして並べ替え"
                            >
                              ⋮⋮
                            </div>
                          )}
                          <button
                            onClick={() => {
                              if (!canToggleSubtasks) return
                              toggleTodoExpansion(group.todo.id)
                            }}
                            disabled={!canToggleSubtasks}
                            aria-hidden={canToggleSubtasks ? undefined : true}
                            tabIndex={canToggleSubtasks ? undefined : -1}
                            aria-label={isExpanded ? `「${group.todo.title}」のサブタスクを折りたたむ` : `「${group.todo.title}」のサブタスクを展開する`}
                            title={canToggleSubtasks ? (isExpanded ? 'サブタスクを折りたたむ' : 'サブタスクを開く') : undefined}
                            style={expandToggleButtonStyle(canToggleSubtasks, isExpanded)}
                          >
                            {/* サブタスクがない行は何も出さない（「.」が何かのボタンに見えていた） */}
                            {canToggleSubtasks ? (isExpanded ? '▾' : '▸') : ''}
                          </button>
                          <span
                            title={tone.label}
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: '50%',
                              background: tone.fill,
                              boxShadow: `0 0 0 3px color-mix(in srgb, ${tone.border} 20%, transparent)`,
                              flexShrink: 0
                            }}
                          />
                            <button
                              onClick={() => handleChartItemSelect(group.todo.id)}
                              onKeyDown={(event) => {
                                if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return
                                event.preventDefault()
                                if (group.todo.status === 'archived' || isReorderMode) return
                                shiftTodoByKeyboard(group.todo, event.key === 'ArrowRight' ? 1 : -1, event.shiftKey)
                              }}
                              aria-keyshortcuts="Alt+ArrowRight Alt+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowLeft"
                              title={[
                                group.todo.title,
                                group.todo.category_name ? `カテゴリ: ${group.todo.category_name}` : null,
                                canToggleSubtasks ? `サブタスク: ${group.datedSubTasks.length}件` : null,
                                group.undatedSubTaskCount > 0 ? `日付未設定サブタスク: ${group.undatedSubTaskCount}件` : null,
                                clipped ? '表示範囲外あり' : null,
                                'Alt+→ / Alt+← で期限を1日ずらす（Shift も押すと日程ごと）'
                              ].filter(Boolean).join('\n')}
                              style={tableTitleButtonStyle}
                            >
                              {group.todo.title}
                            </button>
                            {group.todo.status !== 'done' && group.todo.status !== 'archived' && (
                              // 保留中のタスクだけ紫の「再開」ボタンを常に出す。
                              // 保留していないタスクの「保留する」ボタンは、行にマウスを乗せたときだけ控えめに出す
                              <button
                                className={[group.todo.status === 'on_hold' ? null : 'tarbo-gantt-hold-toggle', compactRowTools ? 'tarbo-gantt-compact-tool' : null].filter(Boolean).join(' ') || undefined}
                                onClick={() => {
                                  const todo = group.todo
                                  const previousStatus = todo.status
                                  const nextStatus = previousStatus === 'on_hold' ? 'active' : 'on_hold'
                                  void onUpdateTodo(todo.id, { status: nextStatus }).then(() => {
                                    // 保留・再開も知らせる（バーの「保留中・」の文字だけでは気付きにくい）
                                    onShowToast?.(nextStatus === 'on_hold' ? `「${todo.title}」を保留にしました` : `「${todo.title}」を進行中に戻しました`, 'success', {
                                      label: '元に戻す',
                                      run: () => void onUpdateTodo(todo.id, { status: previousStatus }).catch(() => onShowToast?.('元に戻せませんでした', 'error'))
                                    })
                                  }, () => {
                                    if (onShowToast) onShowToast('状態を変更できませんでした', 'error')
                                    else window.alert('状態を変更できませんでした')
                                  })
                                }}
                                title={group.todo.status === 'on_hold' ? '保留中です。押すと進行中に戻します' : 'タスクを保留する'}
                                aria-label={group.todo.status === 'on_hold' ? `「${group.todo.title}」を進行中に戻す` : `「${group.todo.title}」を保留する`}
                                style={{ ...subTaskAddButtonStyle(false), color: group.todo.status === 'on_hold' ? 'var(--purple-300)' : 'var(--slate-400)' }}
                              >{group.todo.status === 'on_hold' ? '▶' : <span aria-hidden="true" style={{ fontSize: '0.62em', letterSpacing: '-0.1em' }}>❚❚</span>}</button>
                            )}
                            <button
                              onClick={(event) => {
                                event.stopPropagation()
                                beginAddSubTask(group.todo, displayedTodoBar ?? todoBar)
                              }}
                              disabled={creatingSubTask || isReorderMode}
                              title="サブタスクを追加"
                              aria-label={`「${group.todo.title}」にサブタスクを追加`}
                              className={compactRowTools ? 'tarbo-gantt-compact-tool' : undefined}
                              style={subTaskAddButtonStyle(creatingSubTask || isReorderMode)}
                            >
                              +
                            </button>
                          </div>
                          {editingTodoCell?.todoId === group.todo.id && editingTodoCell.field === 'start_date' ? (
                            <input
                              autoFocus
                              type="date"
                              value={editingTodoCell.value}
                              onChange={(event) => setEditingTodoCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                              onBlur={() => void commitTodoCellEdit()}
                              onKeyDown={handleTodoCellEditorKeyDown}
                              style={{ ...tableInputStyle, width: '100%' }}
                            />
                          ) : (
                            <button onClick={() => beginTodoCellEdit(group.todo, 'start_date')} style={tableCellButtonStyle}>
                              {displayedTodoBar ? shortDateLabel(displayedTodoBar.startDate) : '-'}
                            </button>
                          )}
                          {editingTodoCell?.todoId === group.todo.id && editingTodoCell.field === 'due_date' ? (
                            <input
                              autoFocus
                              type="date"
                              value={editingTodoCell.value}
                              onChange={(event) => setEditingTodoCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                              onBlur={() => void commitTodoCellEdit()}
                              onKeyDown={handleTodoCellEditorKeyDown}
                              style={{ ...tableInputStyle, width: '100%' }}
                            />
                          ) : (
                            listMode ? (
                              <button onClick={() => beginTodoCellEdit(group.todo, 'due_date')} title="ToDoリストの期限（空にすると期限なし）" style={{ ...tableCellButtonStyle, color: group.todo.due_date ? undefined : 'var(--indigo-300)' }}>
                                {group.todo.due_date ? shortDateLabel(group.todo.due_date.slice(0, 10)) : 'なし'}
                              </button>
                            ) : (
                              <button onClick={() => beginTodoCellEdit(group.todo, 'due_date')} style={tableCellButtonStyle}>
                                {displayedTodoBar ? shortDateLabel(displayedTodoBar.endDate) : '-'}
                              </button>
                            )
                          )}
                          {editingTodoCell?.todoId === group.todo.id && editingTodoCell.field === 'progress' ? (
                            <input
                              autoFocus
                              type="number"
                              min={0}
                              max={100}
                              value={editingTodoCell.value}
                              onChange={(event) => setEditingTodoCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                              onBlur={() => void commitTodoCellEdit()}
                              onKeyDown={handleTodoCellEditorKeyDown}
                              style={{ ...tableInputStyle, width: '100%' }}
                            />
                          ) : (
                            listMode ? (
                              <span title={`ToDoリストの項目: ${checklistText ?? ''}（詳細か ToDo タブでチェックします）`} style={{ ...tableCellButtonStyle, cursor: 'default', color: 'var(--indigo-300)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{checklistText}</span>
                            ) : (
                            <button
                              onClick={() => beginTodoCellEdit(group.todo, 'progress')}
                              style={tableCellButtonStyle}
                              title={showScheduleSignals && scheduleHealth ? scheduleHealth.label : undefined}
                            >
                              {showScheduleSignals && scheduleHealth && scheduleHealth.status !== 'onTrack' && (
                                <span style={{ ...statusDotStyle, background: scheduleHealth.accent }} />
                              )}
                              {progress}%
                            </button>
                            )
                          )}
                          {editingTodoCell?.todoId === group.todo.id && editingTodoCell.field === 'assignee_id' ? (
                            <select
                              autoFocus
                              value={editingTodoCell.value}
                              onChange={(event) => {
                                const value = event.target.value
                                if (value === (group.todo.assignee_id ?? '')) {
                                  setEditingTodoCell(null)
                                  return
                                }
                                setEditingTodoCellSaving(true)
                                void onUpdateTodo(group.todo.id, { assignee_id: value || null }).finally(() => {
                                  setEditingTodoCell(null)
                                  setEditingTodoCellSaving(false)
                                })
                              }}
                              onBlur={() => setEditingTodoCell(null)}
                              onKeyDown={handleTodoCellEditorKeyDown}
                              style={{ ...tableSelectStyle, width: '100%' }}
                            >
                              <option value="">未割り当て</option>
                              {group.todo.assignee_id && !assigneeOptions.some((user) => user.id === group.todo.assignee_id) && (
                                <option value={group.todo.assignee_id}>{group.todo.assignee_name ?? '現在の担当'}</option>
                              )}
                              {assigneeOptions.map((user) => (
                                <option key={user.id} value={user.id}>{user.display_name}</option>
                              ))}
                            </select>
                          ) : (
                            <button
                              onClick={() => beginTodoCellEdit(group.todo, 'assignee_id')}
                              style={tableCellButtonStyle}
                              title={[
                                group.todo.assignee_name ? `担当: ${group.todo.assignee_name}` : null,
                                (group.todo.co_assignees ?? []).length > 0 ? `サブ担当: ${(group.todo.co_assignees ?? []).map((coAssignee) => coAssignee.display_name).join('、')}` : null
                              ].filter(Boolean).join('\n') || undefined}
                            >
                              {group.todo.assignee_name && (
                                <span style={assigneeInitialStyle(group.todo.assignee_color, 12)}>{assigneeInitial(group.todo.assignee_name)}</span>
                              )}
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {group.todo.assignee_name ?? '-'}
                              </span>
                              {(group.todo.co_assignees ?? []).map((coAssignee) => (
                                <span key={coAssignee.user_id} style={assigneeInitialStyle(coAssignee.color, 12)} title={`サブ担当: ${coAssignee.display_name}`}>
                                  {assigneeInitial(coAssignee.display_name)}
                                </span>
                              ))}
                            </button>
                          )}
                        </div>
                      </div>

                      <div style={rowTimelineStyle(PARENT_ROW_HEIGHT, unitWidth, timelineWidth, nonWorkingBackground)} onPointerDown={beginPan}>
                        {baselineBar && baselineVisible && (
                          <div
                            style={{
                              position: 'absolute',
                              left: baselineStartIndex * unitWidth + 8,
                              top: (PARENT_ROW_HEIGHT - PARENT_BAR_HEIGHT) / 2 + 3,
                              width: Math.max((baselineEndIndex - baselineStartIndex + 1) * unitWidth - 16, 12),
                              height: 4,
                              borderRadius: 3,
                              background: 'color-mix(in srgb, var(--slate-400) 12.2%, transparent)',
                              border: '1px dashed var(--slate-400)',
                              boxSizing: 'border-box',
                              pointerEvents: 'none'
                            }}
                          />
                        )}
                        {overdueTail && (
                          <div
                            title={overdueTail.title}
                            style={{
                              position: 'absolute',
                              left: overdueTail.left,
                              top: (PARENT_ROW_HEIGHT - PARENT_BAR_HEIGHT) / 2 + 3,
                              width: overdueTail.width,
                              height: PARENT_BAR_HEIGHT - 6,
                              borderRadius: '0 4px 4px 0',
                              border: '1px dashed var(--red-500)',
                              borderLeft: 'none',
                              background: OVERDUE_HATCH,
                              boxSizing: 'border-box'
                            }}
                          />
                        )}
                        {displayedTodoBar && todoVisible && (
                          <div
                            ref={(node) => setDependencyTargetBarRef(group.todo.id, todoOutsideRange ? null : node)}
                            onClick={() => handleChartItemSelect(group.todo.id)}
                            title={barTooltip}
                            style={{ position: 'absolute', left: barLeft, top: (PARENT_ROW_HEIGHT - PARENT_BAR_HEIGHT) / 2, width: barWidth, height: PARENT_BAR_HEIGHT, borderRadius: 4, background: barTone.track, border: `1px ${todoOutsideRange || listMode ? 'dashed' : 'solid'} ${barTone.border}`, boxSizing: 'border-box', opacity: group.todo.status === 'done' ? 0.75 : 1, boxShadow: activeState ? '0 0 0 2px color-mix(in srgb, var(--blue-500) 28%, transparent)' : isDependencySource || isDependencyTarget ? '0 0 0 2px color-mix(in srgb, var(--sky-400) 42%, transparent)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 3px 8px color-mix(in srgb, var(--c-0a0c16) 28%, transparent)', cursor: todoOutsideRange || !barEditable ? 'pointer' : 'grab' }}
                          >
                            {/* 塗りは内側で切り取る。バー自体は overflow を切らない（タスク名を sticky で左端に留めるため） */}
                            <div style={{ position: 'absolute', inset: 0, borderRadius: 3, overflow: 'hidden', pointerEvents: 'none' }}>
                              <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${progress}%`, background: barTone.fill }} />
                              {group.todo.assignee_color && (
                                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: group.todo.assignee_color }} />
                              )}
                            </div>
                            <div
                              onPointerDown={(event) => {
                                if (event.button !== 0 || !barEditable || todoOutsideRange) return
                                beginInteraction('move', 'todo', group.todo.id, group.todo.id, displayedTodoBar.startDate, displayedTodoBar.endDate, event.clientX)
                              }}
                              style={{ position: 'absolute', left: 8, right: 8, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: todoOutsideRange ? 'center' : undefined, cursor: todoOutsideRange || !barEditable ? 'pointer' : 'grab', color: barTone.text, zIndex: 2 }}
                            >
                              {todoOutsideRange ? (
                                <span style={{ fontSize: 'var(--font-caption)', fontWeight: 800, whiteSpace: 'nowrap' }}>{todoOutsideRange === 'before' ? '← 期間前' : '期間後 →'}</span>
              ) : parentLabelOutside ? (
                                barWidth > 36 && <span style={{ fontSize: 'var(--font-caption)', fontWeight: 700, whiteSpace: 'nowrap', textShadow: 'var(--bar-label-shadow)' }}>{listMode ? '☑' : `${progress}%`}</span>
                              ) : barWidth > 56 && (
                                // 開始日が画面の左外にあっても、見えている範囲の左端にタスク名を出し続ける
                                <span style={{ position: 'sticky', left: leftTableWidth + 10, display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textShadow: 'var(--bar-label-shadow)' }}>
                                  <span style={{ fontSize: 'var(--font-caption)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{listMode ? '☑ ' : group.todo.status === 'on_hold' ? '保留中 · ' : ''}{group.todo.title}</span>
                                  {barWidth > 170 ? (
                                    <span style={{ fontSize: 'var(--font-caption)', fontWeight: 600, opacity: 0.9, flexShrink: 0 }}>
                                      {[group.todo.assignee_name, listMode ? checklistText : `${progress}%`, scheduleStatusText].filter(Boolean).join('・')}
                                    </span>
                                  ) : scheduleStatusText && (
                                    <span style={{ fontSize: 'var(--font-caption)', fontWeight: 700, flexShrink: 0 }}>{scheduleStatusText}</span>
                                  )}
                                </span>
                              )}
                            </div>
                            {barEditable && !todoOutsideRange && (
                              <>
                                <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeStart', 'todo', group.todo.id, group.todo.id, displayedTodoBar.startDate, displayedTodoBar.endDate, event.clientX) }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: 'transparent', zIndex: 3 }} />
                                <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeEnd', 'todo', group.todo.id, group.todo.id, displayedTodoBar.startDate, displayedTodoBar.endDate, event.clientX) }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: 'transparent', zIndex: 3 }} />
                              </>
                            )}
                          </div>
                        )}
                        {parentLabelOutside && (
                          <span
                            aria-hidden="true"
                            style={{ position: 'absolute', left: parentLabelLeft, top: 0, height: PARENT_ROW_HEIGHT, display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-caption)', fontWeight: 700, color: GANTT_TEXT, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 1 }}
                          >
                            {parentTitleText}
                            <span style={{ fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--text-subtle)' }}>
                              {[group.todo.assignee_name, listMode ? checklistText : `${progress}%`, scheduleStatusText].filter(Boolean).join('・')}
                            </span>
                          </span>
                        )}
                        {discussionCount > 0 && displayedTodoBar && todoVisible && !todoOutsideRange && (
                          <span
                            title={`要相談 ${discussionCount}件（報告タブの担当者ごとの先頭にまとめて表示されます）`}
                            style={{ ...discussionBadgeStyle, position: 'absolute', left: discussionMarkerLeft, top: (PARENT_ROW_HEIGHT - 16) / 2, lineHeight: '14px', background: 'var(--c-0b1220)', zIndex: 2 }}
                          >
                            要相談{discussionCount > 1 ? ` ${discussionCount}` : ''}
                          </span>
                        )}
                        {barEditable && !todoOutsideRange && dependencyGeometry && (
                          <>
                            {dependencyDrag && dependencyDrag.predecessorTodoId !== group.todo.id && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: dependencyGeometry.targetX - DEPENDENCY_TARGET_HANDLE_SIZE / 2,
                                  top: (PARENT_ROW_HEIGHT - DEPENDENCY_TARGET_HANDLE_SIZE) / 2,
                                  width: DEPENDENCY_TARGET_HANDLE_SIZE,
                                  height: DEPENDENCY_TARGET_HANDLE_SIZE,
                                  borderRadius: 999,
                                  border: `2px solid ${isDependencyTarget ? 'var(--sky-400)' : 'var(--slate-700)'}`,
                                  background: isDependencyTarget ? 'var(--sky-400)' : 'var(--c-0b1220)',
                                  boxShadow: isDependencyTarget ? '0 0 0 4px color-mix(in srgb, var(--sky-400) 18%, transparent)' : 'none',
                                  opacity: isDependencyTarget ? 1 : 0.35,
                                  pointerEvents: 'none',
                                  zIndex: 4
                                }}
                              />
                            )}
                            <div
                              ref={(node) => setDependencySourceHandleRef(group.todo.id, node)}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => beginDependencyDrag(group.todo.id, event)}
                              title="ドラッグして依存関係を追加"
                              style={{
                                position: 'absolute',
                                left: dependencyGeometry.sourceX - DEPENDENCY_HANDLE_SIZE / 2,
                                top: (PARENT_ROW_HEIGHT - DEPENDENCY_HANDLE_SIZE) / 2,
                                width: DEPENDENCY_HANDLE_SIZE,
                                height: DEPENDENCY_HANDLE_SIZE,
                                borderRadius: 999,
                                border: `2px solid ${isDependencySource ? 'var(--sky-200)' : 'var(--slate-900)'}`,
                                background: isDependencySource ? 'var(--sky-400)' : 'var(--amber-500)',
                                boxShadow: isDependencySource ? '0 0 0 4px color-mix(in srgb, var(--sky-400) 18%, transparent)' : 'none',
                                opacity: isDependencySource ? 1 : 0.5,
                                cursor: isTimelineEditable ? 'crosshair' : 'default',
                                zIndex: 4
                              }}
                            />
                          </>
                        )}
                      </div>
                    </div>

                    {showSubtasks && isExpanded && group.datedSubTasks.map(({ subTask, bar }, subTaskIndex) => {
                      // ツリーの枝: 最後のサブタスク（追加欄が開いていないとき）は └、それ以外は ├
                      const isLastSubTask = subTaskIndex === group.datedSubTasks.length - 1 && addingSubTaskTodoId !== group.todo.id
                      const tone = subTaskTone(subTask, todayKey)
                      const isSubTaskReorderSource = draggingSubTaskId === subTask.id
                      const subTaskDropPosition = subTaskDropTarget?.id === subTask.id && !isSubTaskReorderSource ? subTaskDropTarget.position : null
                      const canReorderSubTask = group.datedSubTasks.length > 1
                      const subTaskProgress = clamp(Boolean(subTask.done) ? 100 : subTask.progress ?? 0, 0, 100)
                      const baselineBar = showBaseline ? baselineSnapshot?.subTasks[subTask.id] ?? null : null
                      const subTaskActiveState = interaction?.targetType === 'subtask' && interaction.targetId === subTask.id ? interaction : null
                      const parentMoveState = interaction?.targetType === 'todo' && interaction.targetId === group.todo.id && interaction.mode === 'move' ? interaction : null
                      const parentShiftDays = parentMoveState ? diffCalendarDays(parentMoveState.previewStartDate, parentMoveState.originalStartDate) : 0
                      const displayedBar = subTaskActiveState
                        ? normalizeBar(subTaskActiveState.previewStartDate, subTaskActiveState.previewEndDate)
                        : parentShiftDays !== 0
                          ? shiftBarByDays(bar, parentShiftDays)
                          : bar
                      const actualSubTaskStartIndex = diffUnits(displayedBar.startDate, timelineStart, timeScale)
                      const actualSubTaskEndIndex = diffUnits(displayedBar.endDate, timelineStart, timeScale)
                      const subTaskOutsideRange = outOfRangeDirection(displayedBar, normalizedRange.start, normalizedRange.end)
                      const subTaskStartIndex = clamp(actualSubTaskStartIndex, 0, totalUnits - 1)
                      const subTaskEndIndex = clamp(actualSubTaskEndIndex, 0, totalUnits - 1)
                      const subTaskBarWidth = subTaskOutsideRange
                        ? 68
                        : Math.max((subTaskEndIndex - subTaskStartIndex + 1) * unitWidth - 12, 12)
                      const subTaskBarLeft = subTaskOutsideRange === 'after'
                        ? Math.max(timelineWidth - subTaskBarWidth - 6, 6)
                        : subTaskOutsideRange === 'before'
                          ? 6
                          : subTaskStartIndex * unitWidth + 6
                      // 名前が入る長さか（全角は約1文字10px、半角は約6px として見積もる）
                      const subTaskOverdue = !subTask.done && subTaskTone(subTask, todayKey).statusLabel === '期限超過'
                      const subTaskLabelWidth = Array.from(`${subTaskProgress}% ${subTask.title}`).reduce((sum, char) => sum + (char.charCodeAt(0) < 0x2000 ? 6 : 10), 0) + 16
                      const subTaskLabelOutside = !subTaskOutsideRange && unitWidth >= UNIT_WIDTH[timeScale].normal && subTaskBarWidth < subTaskLabelWidth
                      const baselineVisible = baselineBar
                        ? intersectsRange(baselineBar.startDate, baselineBar.endDate, normalizedRange.start, normalizedRange.end)
                        : false
                      const baselineStartIndex = baselineBar ? clamp(diffUnits(baselineBar.startDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                      const baselineEndIndex = baselineBar ? clamp(diffUnits(baselineBar.endDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                      return (
                        <div
                          key={subTask.id}
                          className="tarbo-gantt-row"
                          onDragOver={(event) => handleSubTaskReorderDragOver(subTask.id, event)}
                          onDrop={(event) => void handleSubTaskReorderDrop(subTask.id, event)}
                          onDragEnd={() => {
                            setDraggingSubTaskId(null)
                            setSubTaskDropTarget(null)
                          }}
                          style={{
                            display: 'flex',
                            minHeight: SUBTASK_ROW_HEIGHT,
                            borderTop: `1px solid ${SUBTASK_DIVIDER_COLOR}`,
                            opacity: isSubTaskReorderSource ? 0.5 : 1
                          }}
                        >
                          {subTaskDropPosition && <div aria-hidden="true" style={subTaskDropLineStyle(subTaskDropPosition)} />}
                          <div style={{ position: 'sticky', left: 0, zIndex: 3, width: leftTableWidth, minWidth: leftTableWidth, boxSizing: 'border-box', background: 'var(--c-0b1220)', borderRight: '1px solid var(--slate-800)', borderLeft: `3px solid ${sectionStripeColor}`, padding: '0 8px 0 21px' }}>
                            {canReorderSubTask && (
                              // 左の余白に置き、行にマウスを乗せたときだけ出す（タスク名の位置は動かさない）。並べ替えモード中は常に出す
                              <div
                                className="tarbo-gantt-subtask-grip"
                                role="button"
                                tabIndex={reorderPending ? -1 : 0}
                                aria-disabled={reorderPending}
                                aria-label={`「${subTask.title}」を並べ替え`}
                                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                                title="ドラッグして同じタスクの中で並べ替え（Alt+↑↓ でも動かせます）"
                                draggable={!reorderPending}
                                onDragStart={(event) => handleSubTaskReorderDragStart(subTask.id, event)}
                                onKeyDown={(event) => { if (!reorderPending) handleSubTaskReorderKeyDown(subTask, event) }}
                                style={{
                                  ...subTaskGripStyle(reorderPending, isSubTaskReorderSource),
                                  ...(isReorderMode || isSubTaskReorderSource ? { opacity: 1 } : {})
                                }}
                              >
                                ⠿
                              </div>
                            )}
                            <div {...leftGridAttributes} style={{ ...leftSubRowGridStyle, gridTemplateColumns: leftGridTemplate }}>
                              <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                                {editingSubTaskCell?.subTaskId === subTask.id && editingSubTaskCell.field === 'title' ? (
                                  <input
                                    autoFocus
                                    value={editingSubTaskCell.value}
                                    onChange={(event) => setEditingSubTaskCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                                    onBlur={() => void commitSubTaskCellEdit()}
                                    onKeyDown={handleSubTaskCellEditorKeyDown}
                                    style={{ ...tableInputStyle, width: '100%' }}
                                  />
                                ) : (
                                <>
                                <span aria-hidden="true" style={{ color: 'var(--text-subtle)', fontSize: 'var(--font-caption)', flexShrink: 0, width: 12, textAlign: 'center' }}>
                                  {isLastSubTask ? '└' : '├'}
                                </span>
                                <button
                                  onClick={() => beginSubTaskCellEdit(subTask, 'title')}
                                  title={subTask.title}
                                  style={{
                                    ...tableTitleButtonStyle,
                                    color: tone.text,
                                    cursor: 'text',
                                    fontSize: 'var(--font-caption)',
                                    fontWeight: 600,
                                    textDecoration: Boolean(subTask.done) ? 'line-through' : 'none'
                                  }}
                                >
                                  {subTask.title}
                                </button>
                                </>
                              )}
                              </div>
                              {editingSubTaskCell?.subTaskId === subTask.id && editingSubTaskCell.field === 'start_date' ? (
                                <input
                                  autoFocus
                                  type="date"
                                  value={editingSubTaskCell.value}
                                  onChange={(event) => setEditingSubTaskCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                                  onBlur={() => void commitSubTaskCellEdit()}
                                  onKeyDown={handleSubTaskCellEditorKeyDown}
                                  style={{ ...tableInputStyle, width: '100%' }}
                                />
                              ) : (
                                <button onClick={() => beginSubTaskCellEdit(subTask, 'start_date')} style={{ ...tableCellButtonStyle, ...subTableCellStyle }}>
                                  {shortDateLabel(displayedBar.startDate)}
                                </button>
                              )}
                              {editingSubTaskCell?.subTaskId === subTask.id && editingSubTaskCell.field === 'due_date' ? (
                                <input
                                  autoFocus
                                  type="date"
                                  value={editingSubTaskCell.value}
                                  onChange={(event) => setEditingSubTaskCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                                  onBlur={() => void commitSubTaskCellEdit()}
                                  onKeyDown={handleSubTaskCellEditorKeyDown}
                                  style={{ ...tableInputStyle, width: '100%' }}
                                />
                              ) : (
                                <button onClick={() => beginSubTaskCellEdit(subTask, 'due_date')} style={{ ...tableCellButtonStyle, ...subTableCellStyle }}>
                                  {shortDateLabel(displayedBar.endDate)}
                                </button>
                              )}
                              {editingSubTaskCell?.subTaskId === subTask.id && editingSubTaskCell.field === 'progress' ? (
                                <input
                                  autoFocus
                                  type="number"
                                  min={0}
                                  max={100}
                                  value={editingSubTaskCell.value}
                                  onChange={(event) => setEditingSubTaskCell((previous) => previous ? { ...previous, value: event.target.value } : previous)}
                                  onBlur={() => void commitSubTaskCellEdit()}
                                  onKeyDown={handleSubTaskCellEditorKeyDown}
                                  style={{ ...tableInputStyle, width: '100%' }}
                                />
                              ) : (
                                <button onClick={() => beginSubTaskCellEdit(subTask, 'progress')} style={{ ...tableCellButtonStyle, ...subTableCellStyle }} title={`${tone.statusLabel}: ${subTaskProgress}%`}>
                                  <span style={{ ...statusDotStyle, background: subTaskProgress >= 100 ? 'var(--green-300)' : tone.border }} />
                                  {subTaskProgress}%
                                </button>
                              )}
                              {editingSubTaskCell?.subTaskId === subTask.id && editingSubTaskCell.field === 'assignee_id' ? (
                                <select
                                  autoFocus
                                  value={editingSubTaskCell.value}
                                  onChange={(event) => {
                                    const value = event.target.value
                                    if (value === (subTask.assignee_id ?? '')) {
                                      setEditingSubTaskCell(null)
                                      return
                                    }
                                    setEditingSubTaskCellSaving(true)
                                    void window.api.subtaskUpdate(subTask.id, { assignee_id: value || null }).then((updated) => {
                                      setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item))
                                    }).finally(() => {
                                      setEditingSubTaskCell(null)
                                      setEditingSubTaskCellSaving(false)
                                    })
                                  }}
                                  onBlur={() => setEditingSubTaskCell(null)}
                                  onKeyDown={handleSubTaskCellEditorKeyDown}
                                  style={{ ...tableSelectStyle, width: '100%' }}
                                >
                                  <option value="">未割り当て</option>
                                  {subTask.assignee_id && !assigneeOptions.some((user) => user.id === subTask.assignee_id) && (
                                    <option value={subTask.assignee_id}>{subTask.assignee_name ?? '現在の担当'}</option>
                                  )}
                                  {assigneeOptions.map((user) => (
                                    <option key={user.id} value={user.id}>{user.display_name}</option>
                                  ))}
                                </select>
                              ) : (
                                <button
                                  onClick={() => beginSubTaskCellEdit(subTask, 'assignee_id')}
                                  style={{ ...tableCellButtonStyle, ...subTableCellStyle }}
                                  title={subTask.assignee_name ? `担当: ${subTask.assignee_name}` : undefined}
                                >
                                  {subTask.assignee_name ? (
                                    <>
                                      <span style={assigneeInitialStyle(subTask.assignee_color, 12)}>{assigneeInitial(subTask.assignee_name)}</span>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subTask.assignee_name}</span>
                                    </>
                                  ) : '-'}
                                </button>
                              )}
                            </div>
                          </div>

                          <div style={rowTimelineStyle(SUBTASK_ROW_HEIGHT, unitWidth, timelineWidth, nonWorkingBackground, GANTT_SUBTASK_SURFACE)} onPointerDown={beginPan}>
                            {baselineBar && baselineVisible && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: baselineStartIndex * unitWidth + 9,
                                  top: (SUBTASK_ROW_HEIGHT - SUBTASK_BAR_HEIGHT) / 2 + 3,
                                  width: Math.max((baselineEndIndex - baselineStartIndex + 1) * unitWidth - 18, 10),
                                  height: 3,
                                  borderRadius: 3,
                                  background: 'color-mix(in srgb, var(--slate-400) 10.2%, transparent)',
                                  border: '1px dashed var(--slate-400)',
                                  boxSizing: 'border-box',
                                  pointerEvents: 'none'
                                }}
                              />
                            )}
                            <div onClick={() => handleChartItemSelect(group.todo.id)} title={`${subTaskOutsideRange ? `${subTaskOutsideRange === 'before' ? '期間前' : '期間後'}: ` : ''}${!subTask.done && tone.statusLabel === '期限超過' ? '期限超過: ' : ''}${subTask.title} ${subTaskProgress}% (${displayedBar.startDate}${displayedBar.startDate === displayedBar.endDate ? '' : ` - ${displayedBar.endDate}`})`} style={{ position: 'absolute', left: subTaskBarLeft, top: (SUBTASK_ROW_HEIGHT - SUBTASK_BAR_HEIGHT) / 2, width: subTaskBarWidth, height: SUBTASK_BAR_HEIGHT, borderRadius: 3, background: tone.background, border: `1px ${subTaskOutsideRange ? 'dashed' : tone.borderStyle} ${tone.border}`, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tone.text, cursor: subTaskOutsideRange || !isTimelineEditable ? 'pointer' : 'grab', boxShadow: subTaskActiveState ? '0 0 0 2px color-mix(in srgb, var(--blue-500) 22%, transparent)' : Boolean(subTask.done) ? '0 0 0 1px color-mix(in srgb, var(--green-300) 18%, transparent) inset' : 'none' }}>
                              {/* 塗りは内側で切り取る。バー自体は overflow を切らない（名前を sticky で左端に留めるため） */}
                              <div style={{ position: 'absolute', inset: 0, borderRadius: 2, overflow: 'hidden', pointerEvents: 'none' }}>
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    bottom: 0,
                                    left: 0,
                                    width: `${subTaskProgress}%`,
                                    background: Boolean(subTask.done)
                                      ? 'linear-gradient(90deg, var(--gantt-sub-done-from), var(--gantt-sub-done-to))'
                                      : 'linear-gradient(90deg, var(--gantt-sub-fill-from), var(--gantt-sub-fill-to))'
                                  }}
                                />
                              </div>
                              <div
                                onPointerDown={(event) => {
                                  if (event.button !== 0 || !isTimelineEditable || subTaskOutsideRange) return
                                  beginInteraction('move', 'subtask', subTask.id, group.todo.id, displayedBar.startDate, displayedBar.endDate, event.clientX)
                                }}
                                style={{ position: 'absolute', left: 4, right: 4, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: subTaskOutsideRange ? 'center' : 'flex-start', cursor: subTaskOutsideRange || !isTimelineEditable ? 'pointer' : 'grab', zIndex: 2 }}
                              >
                                <span style={{ position: subTaskOutsideRange ? undefined : 'sticky', left: leftTableWidth + 10, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 'var(--font-caption)', fontWeight: 700, padding: '0 2px', whiteSpace: 'nowrap', textShadow: 'var(--bar-label-shadow)', textDecoration: Boolean(subTask.done) ? 'line-through' : 'none' }}>
                                  {subTaskOutsideRange
                                    ? subTaskOutsideRange === 'before' ? '← 期間前' : '期間後 →'
                                    : subTaskLabelOutside
                                      ? `${subTaskOverdue ? '⚠ ' : ''}${subTaskProgress}%`
                                      : <>{subTaskOverdue ? '⚠ ' : ''}{Boolean(subTask.done) && unitWidth >= UNIT_WIDTH[timeScale].normal ? '完了 ' : ''}{unitWidth >= UNIT_WIDTH[timeScale].normal ? `${subTaskProgress}% ${subTask.title}` : barStartLabel(displayedBar.startDate, timeScale)}</>}
                                </span>
                              </div>
                              {isTimelineEditable && !subTaskOutsideRange && (
                                <>
                                  <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeStart', 'subtask', subTask.id, group.todo.id, displayedBar.startDate, displayedBar.endDate, event.clientX) }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 7, cursor: 'ew-resize', background: 'transparent', zIndex: 3 }} />
                                  <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeEnd', 'subtask', subTask.id, group.todo.id, displayedBar.startDate, displayedBar.endDate, event.clientX) }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 7, cursor: 'ew-resize', background: 'transparent', zIndex: 3 }} />
                                </>
                              )}
                            </div>
                            {/* バーが短くて名前が入らないときは、バーの右の外に名前を出す（「⚠ 0...」で切れて読めなかったため） */}
                            {subTaskLabelOutside && (
                              <span
                                aria-hidden="true"
                                style={{
                                  position: 'absolute',
                                  left: subTaskBarLeft + subTaskBarWidth + 6,
                                  top: 0,
                                  height: SUBTASK_ROW_HEIGHT,
                                  display: 'flex',
                                  alignItems: 'center',
                                  fontSize: 'var(--font-caption)',
                                  fontWeight: 700,
                                  color: subTaskOverdue ? 'var(--red-300)' : GANTT_TEXT,
                                  whiteSpace: 'nowrap',
                                  pointerEvents: 'none',
                                  textDecoration: Boolean(subTask.done) ? 'line-through' : 'none'
                                }}
                              >
                                {subTaskOverdue ? '期限超過 ' : ''}{Boolean(subTask.done) ? '完了 ' : ''}{subTask.title}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {showSubtasks && isExpanded && addingSubTaskTodoId === group.todo.id && (() => {
                      const draftBar = getDraftSubTaskBar(newSubTaskDraft)
                      const draftVisible = draftBar
                        ? intersectsRange(draftBar.startDate, draftBar.endDate, normalizedRange.start, normalizedRange.end)
                        : false
                      const draftStartIndex = draftBar ? clamp(diffUnits(draftBar.startDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                      const draftEndIndex = draftBar ? clamp(diffUnits(draftBar.endDate, timelineStart, timeScale), 0, totalUnits - 1) : 0

                      return (
                        <div style={{ display: 'flex', minHeight: SUBTASK_ADD_ROW_HEIGHT, borderTop: `1px solid ${GANTT_LINE}` }}>
                          <div
                            style={{
                              position: 'sticky',
                              left: 0,
                              zIndex: 3,
                              width: leftTableWidth,
                              minWidth: leftTableWidth,
                              boxSizing: 'border-box',
                              background: GANTT_SURFACE_DARK,
                              borderRight: `1px solid ${GANTT_LINE}`,
                              borderLeft: `3px solid ${sectionStripeColor}`,
                              padding: '8px 10px 8px 29px'
                            }}
                          >
                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 116px 116px auto auto', gap: 8, alignItems: 'center', height: '100%' }}>
                              <input
                                autoFocus
                                value={newSubTaskDraft.title}
                                onChange={(event) => setNewSubTaskDraft((previous) => ({ ...previous, title: event.target.value }))}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void commitNewSubTask(group.todo)
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelAddSubTask()
                                  }
                                }}
                                placeholder="サブタスク名"
                                style={{ ...tableInputStyle, height: 32, fontSize: 'var(--font-control)' }}
                              />
                              <input
                                type="date"
                                value={newSubTaskDraft.startDate}
                                onChange={(event) => setNewSubTaskDraft((previous) => ({ ...previous, startDate: event.target.value }))}
                                style={{ ...tableInputStyle, height: 32 }}
                              />
                              <input
                                type="date"
                                value={newSubTaskDraft.dueDate}
                                onChange={(event) => setNewSubTaskDraft((previous) => ({ ...previous, dueDate: event.target.value }))}
                                style={{ ...tableInputStyle, height: 32 }}
                              />
                              <button
                                onClick={() => void commitNewSubTask(group.todo)}
                                disabled={creatingSubTask}
                                style={inlineConfirmButtonStyle(creatingSubTask)}
                              >
                                追加
                              </button>
                              <button
                                onClick={cancelAddSubTask}
                                disabled={creatingSubTask}
                                style={inlineCancelButtonStyle(creatingSubTask)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                          <div style={rowTimelineStyle(SUBTASK_ADD_ROW_HEIGHT, unitWidth, timelineWidth, nonWorkingBackground, GANTT_SUBTASK_SURFACE)} onPointerDown={beginPan}>
                            {draftBar && draftVisible && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: draftStartIndex * unitWidth + 6,
                                  top: (SUBTASK_ADD_ROW_HEIGHT - SUBTASK_BAR_HEIGHT) / 2,
                                  width: Math.max((draftEndIndex - draftStartIndex + 1) * unitWidth - 12, 14),
                                  height: SUBTASK_BAR_HEIGHT,
                                  borderRadius: 999,
                                  background: 'linear-gradient(90deg, var(--green-500), var(--emerald-500))',
                                  border: '1px solid var(--emerald-400)',
                                  color: 'var(--on-fill-emerald-50)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: 'var(--font-caption)',
                                  fontWeight: 800,
                                  opacity: 0.82,
                                  overflow: 'hidden'
                                }}
                              >
                                {newSubTaskDraft.title.trim() || '新規'}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 日付のないタスクが0件のときは1行だけにして、チャートの高さを取らない */}
      {showUnscheduled && unscheduledGroups.length === 0 && (
        <div ref={unscheduledSectionRef} style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)', padding: '2px 4px' }}>
          未配置タスク（日付なし）はありません。開始日も期限もないタスクは、ここに並びます。
        </div>
      )}
      {showUnscheduled && unscheduledGroups.length > 0 && (
        <div ref={unscheduledSectionRef} style={{ background: 'var(--gray-900)', border: '1px solid var(--gray-800)', borderRadius: 16, padding: unscheduledOpen ? 16 : '8px 16px', scrollMarginTop: 8, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              aria-expanded={unscheduledOpen}
              aria-controls="gantt-unscheduled-list"
              onClick={() => toggleUnscheduledOpen(!unscheduledOpen)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: '4px 2px', cursor: 'pointer', fontSize: '0.92rem', color: 'var(--slate-50)', fontWeight: 700 }}
            >
              <span aria-hidden="true" style={{ display: 'inline-block', width: 12, color: 'var(--slate-400)', transform: unscheduledOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
              未配置タスク（日付なし） {unscheduledGroups.length}件
              <span style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)', fontWeight: 600 }}>{unscheduledOpen ? '畳む' : '開く'}</span>
            </button>
            <div style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)' }}>開始日も期限もないタスクです。「今日に配置」を押すか、詳細で日程を入れるとチャートに出ます。</div>
          </div>

          {!unscheduledOpen ? null : (
            <div id="gantt-unscheduled-list" style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
              {unscheduledGroups.map((group) => (
                <div key={group.todo.id} style={{ background: 'var(--slate-900)', border: '1px solid var(--slate-800)', borderRadius: 12, padding: '12px 13px' }}>
                  <button onClick={() => onSelectTodo(group.todo.id)} style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700, textAlign: 'left' }}>{group.todo.title}</button>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
                    {group.todo.priority >= 4 && (
                      <span style={{ color: group.todo.priority === 5 ? 'var(--red-500)' : 'var(--amber-500)', fontWeight: 700 }}>優先度 {group.todo.priority === 5 ? '最高' : '高'}</span>
                    )}
                    {group.todo.status === 'on_hold' && <span style={{ color: 'var(--purple-300)' }}>保留中</span>}
                    <span>進捗 {group.todo.progress}%</span>
                    {group.subTaskCount > 0 && <span>サブタスク {group.subTaskCount}件</span>}
                    {group.todo.category_name && <span style={{ color: dataInk(group.todo.category_color ?? 'var(--indigo-300)') }}>{group.todo.category_name}</span>}
                    {group.todo.assignee_name && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: dataInk(group.todo.assignee_color ?? 'var(--slate-400)') }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.todo.assignee_color ?? 'var(--slate-500)' }} />
                        {group.todo.assignee_name}
                      </span>
                    )}
                  </div>
                  <button onClick={() => void onUpdateTodo(group.todo.id, { start_date: todayKey, due_date: todayKey })} style={{ marginTop: 10, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--blue-600)', background: 'var(--blue-950)', color: 'var(--blue-100)', cursor: 'pointer', fontSize: 'var(--font-caption)', fontWeight: 700 }}>今日に配置</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 8,
  color: 'var(--slate-200)',
  fontSize: '0.82rem',
  outline: 'none'
}

const controlLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-caption)',
  color: 'var(--slate-400)'
}

const toggleLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 10,
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  color: 'var(--slate-300)',
  fontSize: 'var(--font-control)'
}

const leftHeaderGridStyle: React.CSSProperties = {
  height: 31,
  display: 'grid',
  alignItems: 'center',
  gap: 8,
  color: 'var(--slate-400)',
  fontSize: 'var(--font-caption)',
  fontWeight: 700,
  textTransform: 'uppercase'
}

const leftRowGridStyle: React.CSSProperties = {
  height: PARENT_ROW_HEIGHT,
  display: 'grid',
  alignItems: 'center',
  gap: 8,
  minWidth: 0
}

const leftSubRowGridStyle: React.CSSProperties = {
  height: SUBTASK_ROW_HEIGHT,
  display: 'grid',
  alignItems: 'center',
  gap: 8,
  minWidth: 0
}

const leftHeaderCellStyle: React.CSSProperties = {
  position: 'relative',
  minWidth: 0,
  height: '100%',
  display: 'flex',
  alignItems: 'center'
}

const leftHeaderLabelStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

function leftColumnResizeHandleStyle(active: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    top: 2,
    right: -6,
    width: 12,
    height: 27,
    cursor: 'col-resize',
    borderRadius: 4,
    background: active ? 'var(--sky-400)' : 'var(--slate-600)',
    opacity: active ? 1 : 0.9,
    boxShadow: active ? '0 0 0 1px color-mix(in srgb, var(--sky-400) 35%, transparent)' : 'none',
    zIndex: 2
  }
}

function assigneeInitial(name: string | null | undefined): string {
  const trimmed = name?.trim()
  return trimmed ? trimmed.slice(0, 1) : '?'
}

function assigneeInitialStyle(color: string | null | undefined, size: number): React.CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    background: color ?? 'var(--slate-500)',
    color: 'var(--slate-50)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: `${Math.max(size - 5, 7)}px`,
    fontWeight: 800,
    lineHeight: 1
  }
}

const tableTitleButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--slate-50)',
  fontSize: 'var(--font-control)',
  fontWeight: 700,
  textAlign: 'left',
  width: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const tableCellStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  overflow: 'hidden',
  color: 'var(--slate-300)',
  fontSize: 'var(--font-caption)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap'
}

const tableCellButtonStyle: React.CSSProperties = {
  ...tableCellStyle,
  width: '100%',
  border: '1px solid transparent',
  borderRadius: 4,
  background: 'transparent',
  padding: '2px 3px',
  cursor: 'text',
  textAlign: 'left'
}

const tableInputStyle: React.CSSProperties = {
  height: 24,
  minWidth: 0,
  border: '1px solid var(--blue-500)',
  borderRadius: 4,
  background: 'var(--slate-950)',
  color: 'var(--slate-200)',
  padding: '2px 5px',
  fontSize: 'var(--font-caption)',
  fontVariantNumeric: 'tabular-nums',
  outline: 'none',
  boxSizing: 'border-box'
}

const tableSelectStyle: React.CSSProperties = {
  ...tableInputStyle,
  cursor: 'pointer'
}

const subTableCellStyle: React.CSSProperties = {
  ...tableCellStyle,
  color: 'var(--slate-400)',
  fontSize: 'var(--font-caption)'
}

const statusDotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  flexShrink: 0
}

const categoryCountBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 22,
  height: 20,
  padding: '0 7px',
  borderRadius: 999,
  color: GANTT_MUTED,
  fontSize: 'var(--font-caption)',
  fontWeight: 800,
  lineHeight: 1
}

function categoryCollapseButtonStyle(collapsed: boolean): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    borderRadius: 6,
    border: `1px solid ${GANTT_LINE}`,
    background: GANTT_SURFACE_PRESSED,
    color: GANTT_MUTED,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
    transition: 'transform 120ms ease, color 120ms ease',
    flexShrink: 0,
    fontSize: 'var(--font-caption)',
    lineHeight: 1
  }
}

// 行の小さいボタン（＋・保留）。文字の大きさに合わせて広げる（行の高さ 38px に収まる 32px まで。150% で 33.6px → 32px）
function subTaskAddButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 'clamp(24px, 1.5rem, 32px)',
    height: 'clamp(24px, 1.5rem, 32px)',
    borderRadius: 6,
    border: `1px solid ${disabled ? 'var(--slate-600)' : GANTT_LINE}`,
    background: disabled ? GANTT_SURFACE_PRESSED : GANTT_SURFACE_RAISED,
    color: disabled ? 'var(--slate-500)' : 'var(--indigo-200)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: '0.9rem',
    fontWeight: 800,
    boxShadow: disabled ? 'none' : '3px 3px 8px color-mix(in srgb, var(--c-10131f) 42%, transparent), -2px -2px 6px color-mix(in srgb, var(--c-4e5370) 45%, transparent)'
  }
}

function inlineConfirmButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: '0 11px',
    borderRadius: 8,
    border: '1px solid var(--green-500)',
    background: disabled ? 'var(--emerald-900)' : 'var(--emerald-700)',
    color: 'var(--on-fill-green-100)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'var(--font-caption)',
    fontWeight: 800,
    whiteSpace: 'nowrap'
  }
}

function inlineCancelButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: '0 11px',
    borderRadius: 8,
    border: `1px solid ${GANTT_LINE}`,
    background: GANTT_SURFACE_PRESSED,
    color: disabled ? 'var(--slate-500)' : GANTT_MUTED,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'var(--font-caption)',
    fontWeight: 800,
    whiteSpace: 'nowrap'
  }
}

const headerActionButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--blue-600)',
  background: 'var(--blue-950)',
  color: 'var(--blue-100)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 700
}

const standaloneBadgeStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--slate-700)',
  background: 'var(--gray-900)',
  color: 'var(--slate-300)',
  fontSize: 'var(--font-caption)',
  fontWeight: 700
}

const taskSelectionPanelStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  maxHeight: 120,
  overflow: 'auto',
  padding: 10,
  borderRadius: 12,
  border: '1px solid var(--gray-800)',
  background: 'var(--slate-900)'
}

const dependencyListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxHeight: 180,
  overflow: 'auto',
  padding: 10,
  borderRadius: 12,
  border: '1px solid var(--gray-800)',
  background: 'var(--slate-900)'
}

const dependencyRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 10,
  background: 'var(--gray-900)',
  border: '1px solid var(--slate-800)'
}

const dependencyDeleteButtonStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid var(--red-900)',
  background: 'var(--red-950)',
  color: 'var(--red-200)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 700,
  flexShrink: 0
}

const dependencyLagBadgeStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid var(--slate-700)',
  background: 'var(--c-0b1220)',
  color: 'var(--slate-300)',
  fontSize: 'var(--font-caption)',
  fontWeight: 700
}

const dependencyLagButtonStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid var(--slate-700)',
  background: 'var(--gray-900)',
  color: 'var(--slate-300)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 700,
  flexShrink: 0
}

const selectionEmptyStyle: React.CSSProperties = {
  fontSize: 'var(--font-control)',
  color: 'var(--text-subtle)'
}

const collapsedSummaryChipStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 5,
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  color: 'var(--slate-300)',
  fontSize: 'var(--font-caption)',
  fontWeight: 600
}

// 見出しの道具バーで、関係するボタンを1つの枠にまとめる
const toolGroupStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: 'var(--c-0b1220)',
  border: '1px solid var(--gray-800)'
}

function toolButtonStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    minWidth: 28,
    padding: '4px 8px',
    borderRadius: 6,
    border: 'none',
    background: active ? 'var(--blue-600)' : 'transparent',
    color: disabled ? 'var(--slate-600)' : active ? 'var(--on-fill-blue-50)' : 'var(--slate-300)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 'var(--font-control)',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

// 「期限超過」「遅れ」のチップ。押すとその行だけに絞る。絞っている間は枠を太くする
function healthFilterChipStyle(background: string, border: string, text: string, active: boolean): React.CSSProperties {
  return {
    ...healthSummaryChipStyle(background, border, text),
    cursor: 'pointer',
    boxShadow: active ? `0 0 0 2px ${border}` : undefined
  }
}

function healthSummaryChipStyle(background: string, border: string, text: string): React.CSSProperties {
  return {
    ...collapsedSummaryChipStyle,
    background,
    border: `1px solid ${border}`,
    color: text
  }
}

const settingsPanelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 52,
  right: 14,
  width: 'min(720px, calc(100% - 28px))',
  maxHeight: '72vh',
  overflow: 'auto',
  padding: 14,
  borderRadius: 16,
  border: '1px solid var(--slate-700)',
  background: 'color-mix(in srgb, var(--c-0b1220) 94.9%, transparent)',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 20px 48px color-mix(in srgb, var(--slate-900) 42%, transparent)',
  zIndex: 12
}

const settingsSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 12,
  border: '1px solid var(--gray-800)',
  background: 'var(--gray-900)'
}

const floatingCloseButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--slate-700)',
  background: 'var(--gray-900)',
  color: 'var(--slate-300)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 700
}

const centerEmptyStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-subtle)',
  padding: 24,
  textAlign: 'center'
}

const secondaryActionChipStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  border: '1px solid var(--slate-600)',
  background: 'var(--slate-900)',
  color: 'var(--slate-300)',
  cursor: 'pointer',
  fontSize: 'var(--font-control)',
  fontWeight: 700
}

function legendItemStyle(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 'var(--font-caption)',
    color: 'var(--slate-400)',
    whiteSpace: 'nowrap'
  }
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '7px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--blue-500)' : 'var(--slate-700)'}`,
    background: active ? 'var(--blue-700)' : 'var(--gray-900)',
    color: active ? 'var(--on-fill-blue-50)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: 'var(--font-control)',
    fontWeight: 700
  }
}

function expandToggleButtonStyle(active: boolean, expanded: boolean): React.CSSProperties {
  return {
    width: 'clamp(24px, 1.5rem, 32px)',
    height: 'clamp(24px, 1.5rem, 32px)',
    borderRadius: 4,
    border: `1px solid ${active ? 'var(--slate-700)' : 'var(--gray-800)'}`,
    background: active ? 'var(--gray-900)' : 'transparent',
    color: active ? (expanded ? 'var(--blue-200)' : 'var(--slate-400)') : 'var(--slate-700)',
    cursor: active ? 'pointer' : 'default',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: 'var(--font-caption)'
  }
}

// サブタスクのつかみ。行の左の余白（21px）に重ねる
function subTaskGripStyle(disabled: boolean, dragging: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    left: 2,
    top: '50%',
    transform: 'translateY(-50%)',
    width: 16,
    height: 20,
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // ふだんの色とマウスを乗せたときの色は CSS（.tarbo-gantt-subtask-grip）で決める
    ...(dragging ? { background: 'var(--sky-950)', color: 'var(--sky-100)' } : {}),
    fontSize: 'var(--font-control)',
    lineHeight: 1,
    userSelect: 'none',
    cursor: disabled ? 'not-allowed' : 'grab'
  }
}

// サブタスクを落とす位置を示す線（相手の行の上端か下端）
function subTaskDropLineStyle(position: DropPosition): React.CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    [position === 'before' ? 'top' : 'bottom']: -1,
    height: 2,
    background: 'var(--sky-400)',
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--sky-400) 30%, transparent)',
    pointerEvents: 'none',
    zIndex: 5
  }
}

function reorderHandleStyle(disabled: boolean, dragging: boolean): React.CSSProperties {
  return {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: `1px solid ${dragging ? 'var(--sky-400)' : 'var(--slate-700)'}`,
    background: dragging ? 'var(--sky-950)' : 'var(--gray-900)',
    color: dragging ? 'var(--sky-100)' : 'var(--slate-400)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--font-caption)',
    lineHeight: 1,
    letterSpacing: '-0.1em',
    userSelect: 'none',
    cursor: disabled ? 'not-allowed' : 'grab',
    flexShrink: 0,
    opacity: disabled ? 0.5 : 1
  }
}

function tagStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    padding: '7px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? accent : 'var(--slate-700)'}`,
    background: active ? `color-mix(in srgb, ${accent} 20%, transparent)` : 'var(--gray-900)',
    color: active ? 'var(--slate-200)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: 'var(--font-control)',
    fontWeight: 700
  }
}

function taskToggleStyle(active: boolean, accent?: string | null): React.CSSProperties {
  const color = accent ?? 'var(--indigo-500)'
  return {
    padding: '6px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? color : 'var(--slate-700)'}`,
    background: active ? `color-mix(in srgb, ${color} 14.9%, transparent)` : 'var(--gray-900)',
    color: active ? 'var(--slate-200)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: 'var(--font-control)',
    fontWeight: 700,
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }
}

// 渡すものが変わらない限り、App の描き直し（タスクの選択など）ではガントを描き直さない。
// 全行（数百行）を描き直すと、タスクを選ぶたびに 100ms 以上かかっていた
export const GanttView = React.memo(GanttViewContent)
