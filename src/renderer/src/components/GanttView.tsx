import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Category, SubTask, Todo, TodoDependency, UpdateTodoInput } from '../types'

interface Props {
  todos: Todo[]
  categories: Category[]
  onSelectTodo: (id: string) => void
  onUpdateTodo: (id: string, data: UpdateTodoInput) => Promise<void>
  onReorderTodos?: (orderedIds: string[]) => Promise<void>
  onOpenSeparateWindow?: () => void
  standalone?: boolean
}

interface TodoBar {
  startDate: string
  endDate: string
}

interface DatedSubTask {
  subTask: SubTask
  bar: TodoBar
}

interface Group {
  todo: Todo
  todoBar: TodoBar | null
  datedSubTasks: DatedSubTask[]
  undatedSubTaskCount: number
  subTaskCount: number
  anchorDate: string | null
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

interface TodoScheduleSnapshot {
  id: string
  startDate: string | null
  dueDate: string | null
}

interface SubTaskScheduleSnapshot {
  id: string
  startDate: string | null
  dueDate: string | null
}

interface UndoEntry {
  label: string
  run: () => Promise<void>
}

type ZoomMode = 'compact' | 'normal' | 'detail' | 'focus'
type StatusFilter = 'active' | 'done' | 'all'
type TimeScale = 'day' | 'month' | 'year'
type RangePreset = '14d' | '30d' | '90d' | null
type CategoryFilterKey = string | '__uncategorized__'
type ScheduleHealthStatus = 'done' | 'future' | 'ahead' | 'onTrack' | 'behind' | 'overdue'

interface ScheduleHealthInfo {
  status: ScheduleHealthStatus
  expectedProgress: number
  delta: number
  label: string
  accent: string
  background: string
  text: string
}

const NO_CATEGORY_KEY = '__uncategorized__'
const GANTT_VIEW_SETTINGS_STORAGE_KEY = 'gantt-view-settings'
const COLLAPSED_TODO_STORAGE_KEY = 'gantt-collapsed-todo-ids'
const GANTT_BASELINE_STORAGE_KEY = 'gantt-baseline-snapshot'
const GANTT_SCROLL_STATE_STORAGE_KEY = 'gantt-scroll-state'
const LEFT_COLUMN_WIDTH = 252
const PARENT_ROW_HEIGHT = 60
const SUBTASK_ROW_HEIGHT = 42
const PARENT_BAR_HEIGHT = 34
const SUBTASK_BAR_HEIGHT = 22
const DEPENDENCY_HANDLE_SIZE = 14
const DEPENDENCY_TARGET_HANDLE_SIZE = 18
const DEPENDENCY_TARGET_INSET = 2
const RANGE_PADDING_DAYS = 5
const UNIT_WIDTH: Record<TimeScale, Record<ZoomMode, number>> = {
  day: { compact: 28, normal: 40, detail: 56, focus: 84 },
  month: { compact: 64, normal: 88, detail: 120, focus: 164 },
  year: { compact: 96, normal: 128, detail: 168, focus: 216 }
}
const ZOOM_LABELS: Record<ZoomMode, string> = {
  compact: 'コンパクト',
  normal: '標準',
  detail: '詳細',
  focus: '集中'
}
const SCALE_LABELS: Record<TimeScale, string> = {
  day: '日',
  month: '月',
  year: '年'
}
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']
const RANGE_PRESETS: Array<{ key: Exclude<RangePreset, null>; label: string; startOffset: number; endOffset: number }> = [
  { key: '14d', label: '14日', startOffset: -7, endOffset: 7 },
  { key: '30d', label: '30日', startOffset: -15, endOffset: 15 },
  { key: '90d', label: '90日', startOffset: -45, endOffset: 45 }
]

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

function startOfUnit(dateStr: string, scale: TimeScale): string {
  if (scale === 'month') return startOfMonth(dateStr)
  if (scale === 'year') return startOfYear(dateStr)
  return dateStr.slice(0, 10)
}

function endOfUnit(dateStr: string, scale: TimeScale): string {
  if (scale === 'month') return endOfMonth(dateStr)
  if (scale === 'year') return endOfYear(dateStr)
  return dateStr.slice(0, 10)
}

function addUnits(dateStr: string, scale: TimeScale, amount: number): string {
  if (scale === 'month') return addMonths(dateStr, amount)
  if (scale === 'year') return addYears(dateStr, amount)
  return addDays(dateStr, amount)
}

function diffUnits(dateStr: string, baseDateStr: string, scale: TimeScale): number {
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
  statusFilter: StatusFilter
  showSubtasks: boolean
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
}

function defaultGanttViewSettings(): PersistedGanttViewSettings {
  return {
    zoom: 'detail',
    timeScale: 'day',
    statusFilter: 'active',
    showSubtasks: true,
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
      timeScale: parsed.timeScale === 'day' || parsed.timeScale === 'month' || parsed.timeScale === 'year'
        ? parsed.timeScale
        : defaults.timeScale,
      statusFilter: parsed.statusFilter === 'active' || parsed.statusFilter === 'done' || parsed.statusFilter === 'all'
        ? parsed.statusFilter
        : defaults.statusFilter,
      showSubtasks: typeof parsed.showSubtasks === 'boolean' ? parsed.showSubtasks : defaults.showSubtasks,
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
  else date.setDate(date.getDate() + amount)

  return formatDateKey(date)
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
  if (scale === 'month') return { primaryLabel: String(date.getFullYear()), secondaryLabel: String(date.getMonth() + 1) }
  if (scale === 'year') return { primaryLabel: String(date.getFullYear()), secondaryLabel: '年' }
  return { primaryLabel: WEEKDAY_LABELS[date.getDay()], secondaryLabel: shortDateLabel(unitStart) }
}

function isCurrentUnit(unitStart: string, todayKey: string, scale: TimeScale): boolean {
  return startOfUnit(unitStart, scale) === startOfUnit(todayKey, scale)
}

function getUnitBackground(unitStart: string, todayKey: string, scale: TimeScale): string {
  if (isCurrentUnit(unitStart, todayKey, scale)) return '#172554'
  if (scale !== 'day') return 'transparent'
  const day = parseDateKey(unitStart).getDay()
  if (day === 0) return '#3f1d1d22'
  if (day === 6) return '#082f4922'
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

function intersectsRange(startDate: string, endDate: string, rangeStart: string, rangeEnd: string): boolean {
  return startDate <= rangeEnd && endDate >= rangeStart
}

function isDateInsideRange(dateStr: string, rangeStart: string, rangeEnd: string): boolean {
  return dateStr >= rangeStart && dateStr <= rangeEnd
}

function calculateExpectedProgress(bar: TodoBar, todayKey: string): number {
  if (todayKey < bar.startDate) return 0
  if (todayKey > bar.endDate) return 100

  const totalDays = Math.max(diffCalendarDays(bar.endDate, bar.startDate), 0) + 1
  const elapsedDays = clamp(diffCalendarDays(todayKey, bar.startDate), 0, totalDays - 1)

  return clamp(Math.round(((elapsedDays + 0.5) / totalDays) * 100), 0, 100)
}

function getScheduleHealth(todo: Todo, todoBar: TodoBar | null, todayKey: string): ScheduleHealthInfo | null {
  if (!todoBar) return null

  const progress = clamp(todo.status === 'done' ? 100 : todo.progress, 0, 100)
  const expectedProgress = calculateExpectedProgress(todoBar, todayKey)
  const delta = Math.round(progress - expectedProgress)
  const daysOverdue = todo.status === 'done' || todayKey <= todoBar.endDate
    ? 0
    : diffCalendarDays(todayKey, todoBar.endDate)

  if (todo.status === 'done') {
    return {
      status: 'done',
      expectedProgress: 100,
      delta: 0,
      label: '完了',
      accent: '#22c55e',
      background: '#052e16',
      text: '#dcfce7'
    }
  }

  if (daysOverdue > 0 && progress < 100) {
    return {
      status: 'overdue',
      expectedProgress,
      delta,
      label: daysOverdue + '日超過',
      accent: '#ef4444',
      background: '#450a0a',
      text: '#fecaca'
    }
  }

  if (todayKey < todoBar.startDate && progress === 0) {
    return {
      status: 'future',
      expectedProgress,
      delta,
      label: '開始前',
      accent: '#64748b',
      background: '#0f172a',
      text: '#cbd5e1'
    }
  }

  if (delta <= -12) {
    return {
      status: 'behind',
      expectedProgress,
      delta,
      label: Math.abs(delta) + 'pt遅れ',
      accent: '#f59e0b',
      background: '#451a03',
      text: '#fde68a'
    }
  }

  if (delta >= 12) {
    return {
      status: 'ahead',
      expectedProgress,
      delta,
      label: delta + 'pt先行',
      accent: '#22c55e',
      background: '#052e16',
      text: '#dcfce7'
    }
  }

  return {
    status: 'onTrack',
    expectedProgress,
    delta,
    label: '順調',
    accent: '#38bdf8',
    background: '#082f49',
    text: '#e0f2fe'
  }
}

function isDateKeyFormat(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function loadGanttScrollState(): PersistedGanttScrollState | null {
  try {
    const raw = window.localStorage.getItem(GANTT_SCROLL_STATE_STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<PersistedGanttScrollState>
    const timeScale = parsed.timeScale === 'day' || parsed.timeScale === 'month' || parsed.timeScale === 'year'
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

    return {
      timeScale,
      leftDate,
      leftOffset,
      scrollLeft,
      scrollTop
    }
  } catch {
    return null
  }
}

function parentTone(todo: Todo): { background: string; border: string; text: string; fill: string } {
  if (todo.status === 'done') return { background: '#16a34a22', border: '#22c55e', text: '#dcfce7', fill: '#22c55e' }
  const base = todo.category_color ?? '#6366f1'
  return { background: `${base}22`, border: `${base}cc`, text: '#e2e8f0', fill: base }
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
      background: 'linear-gradient(90deg, #166534, #15803d)',
      border: '#86efac',
      text: '#f0fdf4',
      rowBackground: '#102016',
      metaText: '#bbf7d0',
      statusBackground: '#14532d',
      statusText: '#dcfce7',
      statusLabel: '完了',
      borderStyle: 'solid'
    }
  }

  const subTaskBar = getSubTaskBar(subTask)
  const overdue = Boolean(subTaskBar) && subTaskBar.endDate < todayKey

  return overdue
    ? {
      background: 'linear-gradient(90deg, #7f1d1d, #991b1b)',
      border: '#fca5a5',
      text: '#fef2f2',
      rowBackground: '#1f1315',
      metaText: '#fecaca',
      statusBackground: '#450a0a',
      statusText: '#fecaca',
      statusLabel: '期限超過',
      borderStyle: 'solid'
    }
    : {
      background: '#0f172a',
      border: '#60a5fa',
      text: '#dbeafe',
      rowBackground: '#0c1322',
      metaText: '#64748b',
      statusBackground: '#0f172a',
      statusText: '#93c5fd',
      statusLabel: '進行中',
      borderStyle: 'dashed'
    }
}

function rowTimelineStyle(height: number, unitWidth: number, timelineWidth: number): React.CSSProperties {
  return {
    position: 'relative',
    width: timelineWidth,
    minWidth: timelineWidth,
    height,
    backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${unitWidth - 1}px, #162033 ${unitWidth - 1}px, #162033 ${unitWidth}px)`
  }
}

function todoMatchesQuery(todo: Todo, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  return todo.title.toLowerCase().includes(normalizedQuery)
    || todo.description.toLowerCase().includes(normalizedQuery)
    || (todo.category_name?.toLowerCase().includes(normalizedQuery) ?? false)
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

export function GanttView({
  todos,
  categories,
  onSelectTodo,
  onUpdateTodo,
  onReorderTodos,
  onOpenSeparateWindow,
  standalone = false
}: Props): React.JSX.Element {
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
  const [showUnscheduled, setShowUnscheduled] = useState(initialSettings.showUnscheduled)
  const [showScheduleSignals, setShowScheduleSignals] = useState(initialSettings.showScheduleSignals)
  const [showBaseline, setShowBaseline] = useState(initialSettings.showBaseline)
  const [rangeMode, setRangeMode] = useState<'auto' | 'manual'>(initialSettings.rangeMode)
  const [manualStart, setManualStart] = useState(initialSettings.manualStart)
  const [manualEnd, setManualEnd] = useState(initialSettings.manualEnd)
  const [manualPreset, setManualPreset] = useState<RangePreset>(initialSettings.manualPreset)
  const [controlsCollapsed, setControlsCollapsed] = useState(initialSettings.controlsCollapsed)
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
  const [reorderPending, setReorderPending] = useState(false)
  const [dependencyLayoutVersion, setDependencyLayoutVersion] = useState(0)
  const [scrollStateReady, setScrollStateReady] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chartCanvasRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<InteractionState | null>(null)
  const dependencyDragRef = useRef<DependencyDragState | null>(null)
  const dependencySourceHandleRefs = useRef(new Map<string, HTMLDivElement>())
  const dependencyTargetBarRefs = useRef(new Map<string, HTMLDivElement>())
  const suppressSelectionRef = useRef(false)
  const lastAutoScrollKeyRef = useRef<string | null>(null)
  const initialScrollStateRef = useRef<PersistedGanttScrollState | null>(initialScrollState)

  interactionRef.current = interaction
  dependencyDragRef.current = dependencyDrag

  const loadGanttData = useCallback(async (): Promise<void> => {
    setLoading(true)
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

  useEffect(() => {
    void loadGanttData()
  }, [loadGanttData])

  useEffect(() => {
    const unsubscribe = window.api.onDataChanged(() => {
      void loadGanttData()
    })
    return () => unsubscribe()
  }, [loadGanttData])

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
      statusFilter,
      showSubtasks,
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
    controlsCollapsed,
    manualEnd,
    manualPreset,
    manualStart,
    rangeMode,
    selectedCategoryKeys,
    showBaseline,
    showScheduleSignals,
    showSubtasks,
    showUnscheduled,
    statusFilter,
    timeScale,
    zoom
  ])

  useEffect(() => {
    setSelectedCategoryKeys((previous) => previous.filter((key) => {
      if (key === NO_CATEGORY_KEY) return todos.some((todo) => !todo.category_id)
      return categories.some((category) => category.id === key)
    }))
  }, [categories, todos])

  useEffect(() => {
    const handleResize = (): void => {
      setDependencyLayoutVersion((previous) => previous + 1)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const todayKey = getTodayKey()
  const unitWidth = UNIT_WIDTH[timeScale][zoom]
  const isTimelineEditable = !isReorderMode
  const normalizedTaskQuery = taskQuery.trim().toLowerCase()

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
      next.push({ key: NO_CATEGORY_KEY, label: '未分類', color: '#64748b' })
    }

    return next
  }, [categories, todos])

  const categoryFilteredTodos = useMemo(() => (
    todos.filter((todo) => {
      if (selectedCategoryKeys.length === 0) return true
      const key = (todo.category_id ?? NO_CATEGORY_KEY) as CategoryFilterKey
      return selectedCategoryKeys.includes(key)
    })
  ), [selectedCategoryKeys, todos])

  const todoSelectionCandidates = useMemo(() => (
    categoryFilteredTodos
      .filter((todo) => todoMatchesQuery(todo, normalizedTaskQuery))
      .sort((a, b) => a.title.localeCompare(b.title, 'ja'))
  ), [categoryFilteredTodos, normalizedTaskQuery])
  const todoById = useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos])
  const subTaskById = useMemo(() => new Map(subTasks.map((subTask) => [subTask.id, subTask])), [subTasks])

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
      const todoSubTasks = (subTasksByTodo.get(todo.id) ?? []).slice().sort((a, b) => {
        const aAnchor = (a.start_date ?? a.due_date) ?? '9999-12-31'
        const bAnchor = (b.start_date ?? b.due_date) ?? '9999-12-31'
        if (aAnchor !== bAnchor) return aAnchor.localeCompare(bAnchor)
        return (a.sort_order ?? 0) - (b.sort_order ?? 0)
      })

      const todoBar = getTodoBar(todo)
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
        datedSubTasks,
        undatedSubTaskCount: todoSubTasks.length - datedSubTasks.length,
        subTaskCount: todoSubTasks.length,
        anchorDate: anchorCandidates[0] ?? null
      }
    })
  }, [ganttTodos, subTasks])

  const filteredGroups = useMemo(() => {
    return groups
      .map((group) => ({
        ...group,
        datedSubTasks: group.datedSubTasks.filter((item) => {
          if (statusFilter === 'all') return true
          return statusFilter === 'done' ? Boolean(item.subTask.done) : !Boolean(item.subTask.done)
        })
      }))
      .filter((group) => {
        if (statusFilter === 'done' && group.todo.status !== 'done') return false
        if (statusFilter === 'active' && group.todo.status === 'done') return false
        return true
      })
  }, [groups, statusFilter])

  const scheduledGroups = useMemo(() => (
    filteredGroups
      .filter((group) => group.todoBar || group.datedSubTasks.length > 0)
      .sort((a, b) => {
        const aOrder = a.todo.sort_order ?? 0
        const bOrder = b.todo.sort_order ?? 0
        if (aOrder !== bOrder) return aOrder - bOrder
        const aAnchor = a.anchorDate ?? '9999-12-31'
        const bAnchor = b.anchorDate ?? '9999-12-31'
        if (aAnchor !== bAnchor) return aAnchor.localeCompare(bAnchor)
        if (b.todo.priority !== a.todo.priority) return b.todo.priority - a.todo.priority
        return a.todo.title.localeCompare(b.todo.title, 'ja')
      })
  ), [filteredGroups])

  const unscheduledGroups = useMemo(() => (
    filteredGroups
      .filter((group) => !group.todoBar && group.datedSubTasks.length === 0)
      .sort((a, b) => {
        const aOrder = a.todo.sort_order ?? 0
        const bOrder = b.todo.sort_order ?? 0
        if (aOrder !== bOrder) return aOrder - bOrder
        return b.todo.priority - a.todo.priority || a.todo.title.localeCompare(b.todo.title, 'ja')
      })
  ), [filteredGroups])

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

  const chartGroups = useMemo(() => (
    scheduledGroups
      .map((group) => ({
        ...group,
        datedSubTasks: group.datedSubTasks.filter((item) => intersectsRange(item.bar.startDate, item.bar.endDate, normalizedRange.start, normalizedRange.end))
      }))
      .filter((group) => {
        const todoVisible = group.todoBar
          ? intersectsRange(group.todoBar.startDate, group.todoBar.endDate, normalizedRange.start, normalizedRange.end)
          : false
        const subTaskVisible = showSubtasks && group.datedSubTasks.length > 0
        return todoVisible || subTaskVisible
      })
  ), [normalizedRange.end, normalizedRange.start, scheduledGroups, showSubtasks])

  const canStartReorderMode = Boolean(onReorderTodos) && chartGroups.length > 1

  const handleReorderDragStart = useCallback((todoId: string, event: React.DragEvent<HTMLDivElement>): void => {
    if (!isReorderMode || reorderPending || !onReorderTodos) return
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
    } finally {
      setReorderPending(false)
      setDraggingTodoId(null)
      setDragOverTodoId(null)
    }
  }, [chartGroups, draggingTodoId, isReorderMode, onReorderTodos, reorderPending])

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
      startDate: subTask.start_date?.slice(0, 10) ?? null,
      dueDate: subTask.due_date?.slice(0, 10) ?? null
    }
  }, [subTaskById])

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

  const performUndo = useCallback(async (): Promise<void> => {
    if (!lastUndoEntry || undoPending) return

    setUndoPending(true)
    try {
      await lastUndoEntry.run()
      setLastUndoEntry(null)
      setDependencyFeedback(`元に戻しました: ${lastUndoEntry.label}`)
    } catch (error) {
      setDependencyFeedback(error instanceof Error ? error.message : '元に戻せませんでした。')
    } finally {
      setUndoPending(false)
    }
  }, [lastUndoEntry, undoPending])

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
      return {
        key: `${timeScale}-${unitStart}`,
        startDate: unitStart,
        endDate: unitEnd,
        primaryLabel: labels.primaryLabel,
        secondaryLabel: labels.secondaryLabel,
        isCurrent: isCurrentUnit(unitStart, todayKey, timeScale),
        background: getUnitBackground(unitStart, todayKey, timeScale)
      }
    })
  ), [timeScale, timelineStart, todayKey, totalUnits])
  const timelineWidth = totalUnits * unitWidth
  const todayIndex = diffUnits(todayKey, timelineStart, timeScale)
  const autoScrollKey = `${normalizedRange.start}:${normalizedRange.end}:${timeScale}:${zoom}:${totalUnits}:${todayIndex}`
  const getTodayScrollLeft = useCallback((container: HTMLDivElement): number => {
    const todayStart = todayIndex * unitWidth
    const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0)
    return clamp(todayStart, 0, maxScrollLeft)
  }, [todayIndex, unitWidth])
  const handleJumpToToday = useCallback(() => {
    const container = scrollRef.current
    if (container && todayIndex >= 0 && todayIndex < totalUnits) {
      container.scrollTo({ left: getTodayScrollLeft(container), behavior: 'smooth' })
      return
    }

    centerRangeOnToday()
  }, [centerRangeOnToday, getTodayScrollLeft, todayIndex, totalUnits])

  useLayoutEffect(() => {
    if (scrollStateReady) return

    const container = scrollRef.current
    if (!container) return

    const snapshot = initialScrollStateRef.current
    if (snapshot && loading) return

    if (snapshot) {
      const maxScrollLeft = Math.max(container.scrollWidth - container.clientWidth, 0)
      const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0)
      let restoredLeft = clamp(snapshot.scrollLeft, 0, maxScrollLeft)

      if (snapshot.leftDate && snapshot.timeScale === timeScale) {
        const storedIndex = diffUnits(snapshot.leftDate, timelineStart, timeScale)
        if (Number.isFinite(storedIndex)) {
          restoredLeft = clamp(storedIndex * unitWidth + snapshot.leftOffset, 0, maxScrollLeft)
        }
      }

      container.scrollLeft = restoredLeft
      container.scrollTop = clamp(snapshot.scrollTop, 0, maxScrollTop)
      lastAutoScrollKeyRef.current = autoScrollKey
    }

    setScrollStateReady(true)
  }, [autoScrollKey, loading, scrollStateReady, timeScale, timelineStart, unitWidth])

  useEffect(() => {
    if (!scrollStateReady) return

    const container = scrollRef.current
    if (!container) return
    if (lastAutoScrollKeyRef.current === autoScrollKey) return

    container.scrollLeft = getTodayScrollLeft(container)
    lastAutoScrollKeyRef.current = autoScrollKey
  }, [autoScrollKey, getTodayScrollLeft, scrollStateReady])

  useEffect(() => {
    if (!scrollStateReady) return

    const container = scrollRef.current
    if (!container) return

    let frameId = 0
    const persistScrollState = (): void => {
      frameId = 0
      const scrollLeft = Math.max(container.scrollLeft, 0)
      const scrollTop = Math.max(container.scrollTop, 0)
      const unitIndex = totalUnits > 0 ? clamp(Math.floor(scrollLeft / unitWidth), 0, totalUnits - 1) : 0
      const leftDate = totalUnits > 0 ? addUnits(timelineStart, timeScale, unitIndex) : null
      const leftOffset = totalUnits > 0 ? Math.max(0, scrollLeft - unitIndex * unitWidth) : 0

      const nextState: PersistedGanttScrollState = {
        timeScale,
        leftDate,
        leftOffset,
        scrollLeft,
        scrollTop
      }

      window.localStorage.setItem(GANTT_SCROLL_STATE_STORAGE_KEY, JSON.stringify(nextState))
    }

    const handleScroll = (): void => {
      if (frameId) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(persistScrollState)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    persistScrollState()

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [scrollStateReady, timeScale, timelineStart, totalUnits, unitWidth])

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
        const todoTitle = todoById.get(current.targetId)?.title ?? 'タスク'
        void onUpdateTodo(current.targetId, {
          start_date: current.previewStartDate,
          due_date: current.previewEndDate
        }).then(async () => {
          const latestTodos = await window.api.todoGetAll()
          ensureRangeIncludesTodos(affectedTodoIds, latestTodos)
          if (previousSnapshots.length > 0) {
            setLastUndoEntry({
              label: `タスク移動: ${todoTitle}`,
              run: async () => {
                await restoreTodoSchedules(previousSnapshots)
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
      }).then(async () => {
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
    restoreTodoSchedules,
    snapshotSubTaskSchedule,
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
        const health = getScheduleHealth(group.todo, group.todoBar, todayKey)
        return health ? { todoId: group.todo.id, health } : null
      })
      .filter((entry): entry is { todoId: string; health: ScheduleHealthInfo } => Boolean(entry))
  ), [chartGroups, todayKey])
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

    for (const group of chartGroups) {
      positions.set(group.todo.id, { centerY: top + PARENT_ROW_HEIGHT / 2 })
      top += PARENT_ROW_HEIGHT
      if (showSubtasks && !collapsedTodoIds.includes(group.todo.id)) {
        top += group.datedSubTasks.length * SUBTASK_ROW_HEIGHT
      }
    }

    return { positions, totalHeight: top }
  }, [chartGroups, collapsedTodoIds, showSubtasks])
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
        sourceX: endIndex * unitWidth + unitWidth - 6,
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
      ? rect.left - canvasRect.left - LEFT_COLUMN_WIDTH + inset
      : edge === 'end'
        ? rect.right - canvasRect.left - LEFT_COLUMN_WIDTH - inset
        : rect.left - canvasRect.left - LEFT_COLUMN_WIDTH + rect.width / 2

    return {
      x,
      y: rect.top - canvasRect.top + rect.height / 2
    }
  }, [])
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

  const renderTodayOverlay = (height: number): React.JSX.Element | null => {
    if (todayIndex < 0 || todayIndex >= totalUnits) return null
    return (
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: todayIndex * unitWidth,
          width: unitWidth,
          background: '#2563eb12',
          borderLeft: '1px solid #3b82f6',
          borderRight: '1px solid #3b82f655'
        }}
      />
    )
  }

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

      const pointerX = event.clientX - canvasRect.left - LEFT_COLUMN_WIDTH
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
  }, [createDependency, dependencyDrag, getHoveredDependencyTargetId, getSuggestedDependencyLagDays, isTimelineEditable, setDependencyDragState])

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '1rem', color: '#f8fafc', fontWeight: 700 }}>ガントチャート</div>
          <div style={{ marginTop: 4, fontSize: '0.76rem', color: '#94a3b8', lineHeight: 1.5 }}>
            {standalone
              ? '別ウィンドウでタイムラインを編集できます。'
              : 'メイン画面で日付調整や依存関係の管理ができます。'}
            {isReorderMode
              ? ' 並び替えモード中です。左列のドラッグハンドルでタスク順を変更できます。'
              : ' バーや端のハンドルをドラッグして日程を調整できます。'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => setIsReorderMode((previous) => !previous)}
            disabled={reorderPending || (!isReorderMode && !canStartReorderMode)}
            style={{
              ...headerActionButtonStyle,
              border: `1px solid ${isReorderMode ? '#16a34a' : '#2563eb'}`,
              background: isReorderMode ? '#14532d' : '#172554',
              color: isReorderMode ? '#dcfce7' : '#dbeafe',
              cursor: reorderPending || (!isReorderMode && !canStartReorderMode) ? 'not-allowed' : 'pointer',
              opacity: reorderPending || (!isReorderMode && !canStartReorderMode) ? 0.55 : 1
            }}
            title={!isReorderMode && !canStartReorderMode ? '並び替え対象のタスクが2件以上あるときに有効です。' : undefined}
          >
            {reorderPending ? '並び替えを保存中...' : isReorderMode ? '並び替え完了' : '並び替え'}
          </button>
          <button
            onClick={() => void performUndo()}
            disabled={!lastUndoEntry || undoPending}
            title={lastUndoEntry?.label ?? '直前の変更を元に戻す'}
            style={{
              ...headerActionButtonStyle,
              border: `1px solid ${lastUndoEntry && !undoPending ? '#16a34a' : '#334155'}`,
              background: lastUndoEntry && !undoPending ? '#14532d' : '#0f172a',
              color: lastUndoEntry && !undoPending ? '#dcfce7' : '#64748b',
              cursor: lastUndoEntry && !undoPending ? 'pointer' : 'not-allowed'
            }}
          >
            {undoPending ? '戻しています...' : '1つ戻る'}
          </button>
          <button onClick={() => setControlsCollapsed((previous) => !previous)} style={headerActionButtonStyle}>
            {controlsCollapsed ? '表示設定を開く' : '表示設定を閉じる'}
          </button>
          <button onClick={handleJumpToToday} style={headerActionButtonStyle}>
            今日に戻る
          </button>
          {!standalone && onOpenSeparateWindow && (
            <button onClick={onOpenSeparateWindow} style={headerActionButtonStyle}>
              別ウィンドウで開く
            </button>
          )}
          {standalone && <div style={standaloneBadgeStyle}>別ウィンドウ表示</div>}
        </div>
      </div>

      <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 14, padding: '8px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={collapsedSummaryChipStyle}>期間 {shortDateLabel(normalizedRange.start)} - {shortDateLabel(normalizedRange.end)}</span>
        <span style={collapsedSummaryChipStyle}>表示単位 {SCALE_LABELS[timeScale]}</span>
        <span style={collapsedSummaryChipStyle}>ズーム {ZOOM_LABELS[zoom]}</span>
        <span style={collapsedSummaryChipStyle}>表示 {chartGroups.length}件</span>
        {isReorderMode && <span style={healthSummaryChipStyle('#14532d', '#16a34a', '#dcfce7')}>並び替えモード</span>}
        <span style={collapsedSummaryChipStyle}>サブタスク {visibleSubTaskCount}/{datedSubTaskCount}</span>
        {expandableTodoIds.length > 0 && (
          <span style={collapsedSummaryChipStyle}>展開 {expandedTodoCount}/{expandableTodoIds.length}</span>
        )}
        {showBaseline && baselineCapturedLabel && (
          <span style={collapsedSummaryChipStyle}>基準線 {baselineCapturedLabel}</span>
        )}
        {showScheduleSignals && scheduleHealthSummary.overdue > 0 && (
          <span style={healthSummaryChipStyle('#450a0a', '#ef4444', '#fecaca')}>期限超過 {scheduleHealthSummary.overdue}</span>
        )}
        {showScheduleSignals && scheduleHealthSummary.behind > 0 && (
          <span style={healthSummaryChipStyle('#451a03', '#f59e0b', '#fde68a')}>遅れ {scheduleHealthSummary.behind}</span>
        )}
        {showScheduleSignals && scheduleHealthSummary.healthy > 0 && (
          <span style={healthSummaryChipStyle('#082f49', '#38bdf8', '#e0f2fe')}>順調 {scheduleHealthSummary.healthy}</span>
        )}
        {showScheduleSignals && scheduleHealthSummary.future > 0 && (
          <span style={healthSummaryChipStyle('#0f172a', '#64748b', '#cbd5e1')}>開始前 {scheduleHealthSummary.future}</span>
        )}
        {lastUndoEntry && (
          <span style={collapsedSummaryChipStyle}>戻す: {lastUndoEntry.label}</span>
        )}
      </div>

      {!controlsCollapsed && (
        <div style={settingsPanelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: '0.86rem', color: '#f8fafc', fontWeight: 700 }}>表示設定</div>
            <button onClick={() => setControlsCollapsed(true)} style={floatingCloseButtonStyle}>閉じる</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
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
                {(['day', 'month', 'year'] as const).map((scale) => (
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
                <button onClick={() => setStatusFilter('active')} style={chipStyle(statusFilter === 'active')}>進行中</button>
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

            {categoryOptions.length > 0 && (
              <div style={settingsSectionStyle}>
                <label style={controlLabelStyle}>カテゴリ</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => setSelectedCategoryKeys([])} style={chipStyle(selectedCategoryKeys.length === 0)}>すべて</button>
                  {categoryOptions.map((option) => (
                    <button
                      key={option.key}
                      onClick={() => toggleCategory(option.key)}
                      style={tagStyle(selectedCategoryKeys.includes(option.key), option.color ?? '#64748b')}
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
                <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{taskSelectionSummary}</div>
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
              <div style={{ fontSize: '0.76rem', color: '#94a3b8', lineHeight: 1.5 }}>
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
              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>タスクバー右端の丸をドラッグしても依存関係を追加できます。</div>
              {dependencyFeedback && <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{dependencyFeedback}</div>}
              {dependencyList.length === 0 ? (
                <div style={{ fontSize: '0.72rem', color: '#64748b' }}>依存関係はまだありません。</div>
              ) : (
                <div style={dependencyListStyle}>
                  {dependencyList.map((dependency) => (
                    <div key={dependency.id} style={dependencyRowStyle}>
                      <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ color: '#e2e8f0', fontSize: '0.78rem', fontWeight: 700 }}>
                          {todoById.get(dependency.predecessor_todo_id)?.title ?? '不明なタスク'}
                        </span>
                        <span style={{ color: '#64748b', fontSize: '0.72rem' }}>-&gt;</span>
                        <span style={{ color: '#cbd5e1', fontSize: '0.76rem' }}>
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
              <div style={{ fontSize: '0.76rem', color: '#94a3b8', lineHeight: 1.5 }}>
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
              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                {baselineSnapshot
                  ? `保存日時 ${baselineSnapshot.capturedAt.slice(0, 10)} ${baselineSnapshot.capturedAt.slice(11, 16)}`
                  : '保存済みの基準線はありません。'}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: '0 0 auto', minHeight: controlsCollapsed ? 540 : 460, height: controlsCollapsed ? '72vh' : '58vh', border: '1px solid #1e293b', borderRadius: 18, background: '#0b1220', overflow: 'hidden' }}>
        {loading ? (
          <div style={centerEmptyStyle}>タスクを読み込み中...</div>
        ) : chartGroups.length === 0 ? (
          <div style={centerEmptyStyle}>この期間に表示できる予定タスクはありません。</div>
        ) : (
          <div ref={scrollRef} style={{ height: '100%', overflow: 'auto' }}>
            <div style={{ minWidth: LEFT_COLUMN_WIDTH + timelineWidth }}>
              <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 6 }}>
                <div style={{ position: 'sticky', left: 0, width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, background: '#0f172a', borderRight: '1px solid #1e293b', borderBottom: '1px solid #1e293b', padding: '10px 12px' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Task</div>
                  <div style={{ marginTop: 6, fontSize: '0.85rem', color: '#cbd5e1' }}>Date / Status / Expansion</div>
                </div>

                <div style={{ width: timelineWidth, display: 'flex', background: '#0f172a', borderBottom: '1px solid #1e293b' }}>
                  {timelineUnits.map((unit) => (
                    <div
                      key={unit.key}
                      style={{
                        width: unitWidth,
                        minWidth: unitWidth,
                        padding: '8px 0 9px',
                        textAlign: 'center',
                        background: unit.background,
                        borderRight: '1px solid #1e293b'
                      }}
                    >
                      <div style={{ fontSize: '0.68rem', color: unit.isCurrent ? '#bfdbfe' : '#64748b' }}>{unit.primaryLabel}</div>
                      <div style={{ marginTop: 4, fontSize: '0.72rem', color: unit.isCurrent ? '#dbeafe' : '#cbd5e1', fontWeight: unit.isCurrent ? 700 : 500 }}>{unit.secondaryLabel}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div ref={chartCanvasRef} style={{ position: 'relative' }}>
                {(dependencyPaths.length > 0 || dependencyPreviewPath) && (
                  <svg
                    width={timelineWidth}
                    height={rowLayout.totalHeight}
                    style={{ position: 'absolute', top: 0, left: LEFT_COLUMN_WIDTH, overflow: 'visible', pointerEvents: 'none', zIndex: 1 }}
                    aria-hidden="true"
                  >
                    <defs>
                      <marker id="ganttDependencyArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                        <path d="M 0 0 L 8 4 L 0 8 z" fill="#f59e0b" />
                      </marker>
                      <marker id="ganttDependencyPreviewArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                        <path d="M 0 0 L 8 4 L 0 8 z" fill="#38bdf8" />
                      </marker>
                    </defs>
                    {dependencyPaths.map((dependency) => (
                      <path
                        key={dependency.id}
                        d={dependency.path}
                        fill="none"
                        stroke="#f59e0b"
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
                        stroke={dependencyDrag?.hoverSuccessorTodoId ? '#38bdf8' : '#94a3b8'}
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

                {chartGroups.map((group) => {
                const tone = parentTone(group.todo)
                const progress = clamp(group.todo.status === 'done' ? 100 : group.todo.progress, 0, 100)
                const todoBar = group.todoBar
                const baselineBar = showBaseline ? baselineSnapshot?.todos[group.todo.id] ?? null : null
                const scheduleHealth = scheduleHealthByTodoId.get(group.todo.id) ?? null
                const canToggleSubtasks = showSubtasks && group.datedSubTasks.length > 0
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
                  ? intersectsRange(displayedTodoBar.startDate, displayedTodoBar.endDate, normalizedRange.start, normalizedRange.end)
                  : false
                const actualStartIndex = displayedTodoBar ? diffUnits(displayedTodoBar.startDate, timelineStart, timeScale) : 0
                const actualEndIndex = displayedTodoBar ? diffUnits(displayedTodoBar.endDate, timelineStart, timeScale) : 0
                const clipped = displayedTodoBar ? actualStartIndex < 0 || actualEndIndex > totalUnits - 1 : false
                const displayStartIndex = displayedTodoBar ? clamp(actualStartIndex, 0, totalUnits - 1) : 0
                const displayEndIndex = displayedTodoBar ? clamp(actualEndIndex, 0, totalUnits - 1) : 0
                const barWidth = displayedTodoBar ? Math.max((displayEndIndex - displayStartIndex + 1) * unitWidth - 8, 24) : 0
                const baselineVisible = baselineBar
                  ? intersectsRange(baselineBar.startDate, baselineBar.endDate, normalizedRange.start, normalizedRange.end)
                  : false
                const baselineStartIndex = baselineBar ? clamp(diffUnits(baselineBar.startDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                const baselineEndIndex = baselineBar ? clamp(diffUnits(baselineBar.endDate, timelineStart, timeScale), 0, totalUnits - 1) : 0

                return (
                  <div key={group.todo.id}>
                    <div
                      onDragOver={(event) => { void handleReorderDragOver(group.todo.id, event) }}
                      onDrop={(event) => { void handleReorderDrop(group.todo.id, event) }}
                      onDragEnd={() => {
                        setDraggingTodoId(null)
                        setDragOverTodoId(null)
                      }}
                      style={{
                        display: 'flex',
                        minHeight: PARENT_ROW_HEIGHT,
                        borderTop: isReorderDragTarget ? '2px solid #38bdf8' : '1px solid #111827',
                        opacity: isReorderDragSource ? 0.7 : 1
                      }}
                    >
                      <div style={{ position: 'sticky', left: 0, zIndex: 4, width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, background: '#0f172a', borderRight: '1px solid #1e293b', padding: '9px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          {isReorderMode && (
                            <div
                              draggable={!reorderPending}
                              onDragStart={(event) => handleReorderDragStart(group.todo.id, event)}
                              style={reorderHandleStyle(reorderPending, isReorderDragSource)}
                              title="ドラッグして並び替え"
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
                            aria-label={isExpanded ? 'サブタスクを折りたたむ' : 'サブタスクを展開する'}
                            style={expandToggleButtonStyle(canToggleSubtasks, isExpanded)}
                          >
                            {canToggleSubtasks ? (isExpanded ? '-' : '+') : '.'}
                          </button>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <button
                              onClick={() => {
                                if (canToggleSubtasks) {
                                  toggleTodoExpansion(group.todo.id)
                                  return
                                }
                                handleChartItemSelect(group.todo.id)
                              }}
                              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: '#f8fafc', fontSize: '0.8rem', fontWeight: 700, textAlign: 'left', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {group.todo.title}
                            </button>
                            <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.66rem', color: '#94a3b8' }}>
                              <span>{displayedTodoBar ? `${displayedTodoBar.startDate}${displayedTodoBar.startDate === displayedTodoBar.endDate ? '' : ` - ${displayedTodoBar.endDate}`}` : '未配置'}</span>
                              <span>{displayedTodoBar ? `${diffCalendarDays(displayedTodoBar.endDate, displayedTodoBar.startDate) + 1}日` : '期間なし'}</span>
                              <span>{progress}%</span>
                              {showScheduleSignals && scheduleHealth && (
                                <span style={scheduleHealthBadgeStyle(scheduleHealth)}>
                                  {scheduleHealth.label}
                                </span>
                              )}
                            </div>
                            <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.66rem' }}>
                              {group.todo.category_name && <span style={{ color: group.todo.category_color ?? '#a5b4fc' }}>{group.todo.category_name}</span>}
                              {canToggleSubtasks && (
                                <span style={{ color: isExpanded ? '#93c5fd' : '#64748b' }}>
                                  {isExpanded ? `展開 ${group.datedSubTasks.length}件` : `折りたたみ ${group.datedSubTasks.length}件`}
                                </span>
                              )}
                              {clipped && <span style={{ color: '#fbbf24' }}>表示範囲外</span>}
                              {group.undatedSubTaskCount > 0 && <span style={{ color: '#94a3b8' }}>日付未設定のサブタスク {group.undatedSubTaskCount}件</span>}
                            </div>
                          </div>
                          <button onClick={() => handleChartItemSelect(group.todo.id)} style={detailShortcutButtonStyle}>
                            詳細
                          </button>
                        </div>
                      </div>

                      <div style={rowTimelineStyle(PARENT_ROW_HEIGHT, unitWidth, timelineWidth)}>
                        {renderTodayOverlay(PARENT_ROW_HEIGHT)}
                        {baselineBar && baselineVisible && (
                          <div
                            style={{
                              position: 'absolute',
                              left: baselineStartIndex * unitWidth + 8,
                              top: (PARENT_ROW_HEIGHT - PARENT_BAR_HEIGHT) / 2 + 6,
                              width: Math.max((baselineEndIndex - baselineStartIndex + 1) * unitWidth - 16, 12),
                              height: PARENT_BAR_HEIGHT - 12,
                              borderRadius: 999,
                              background: '#94a3b81f',
                              border: '1px dashed #94a3b8',
                              boxSizing: 'border-box',
                              pointerEvents: 'none'
                            }}
                          />
                        )}
                        {displayedTodoBar && todoVisible && (
                          <div ref={(node) => setDependencyTargetBarRef(group.todo.id, node)} onClick={() => handleChartItemSelect(group.todo.id)} style={{ position: 'absolute', left: displayStartIndex * unitWidth + 4, top: (PARENT_ROW_HEIGHT - PARENT_BAR_HEIGHT) / 2, width: barWidth, height: PARENT_BAR_HEIGHT, borderRadius: 12, background: tone.background, border: `1px solid ${tone.border}`, boxSizing: 'border-box', overflow: 'hidden', boxShadow: activeState ? '0 10px 24px rgba(15, 23, 42, 0.28)' : isDependencySource || isDependencyTarget ? '0 0 0 2px rgba(56, 189, 248, 0.42), 0 10px 24px rgba(8, 47, 73, 0.24)' : 'none', cursor: !isTimelineEditable ? 'pointer' : 'grab' }}>
                            <div style={{ position: 'absolute', inset: 0, width: `${progress}%`, background: `${tone.fill}66` }} />
                            {showScheduleSignals && scheduleHealth && scheduleHealth.status !== 'done' && scheduleHealth.expectedProgress > 0 && (
                              <div style={scheduleHealthStripeStyle(scheduleHealth, barWidth)} />
                            )}
                            <div
                              onPointerDown={(event) => {
                                if (event.button !== 0 || !isTimelineEditable) return
                                beginInteraction('move', 'todo', group.todo.id, group.todo.id, displayedTodoBar.startDate, displayedTodoBar.endDate, event.clientX)
                              }}
                              style={{ position: 'absolute', left: 9, right: 9, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 10, cursor: !isTimelineEditable ? 'pointer' : 'grab', color: tone.text, zIndex: 2 }}
                            >
                              <span style={{ fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{barStartLabel(displayedTodoBar.startDate, timeScale)}</span>
                              <span style={{ fontSize: '0.78rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.todo.title}</span>
                            </div>
                            {isTimelineEditable && (
                              <>
                                <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeStart', 'todo', group.todo.id, group.todo.id, displayedTodoBar.startDate, displayedTodoBar.endDate, event.clientX) }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', background: '#ffffff12' }} />
                                <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeEnd', 'todo', group.todo.id, group.todo.id, displayedTodoBar.startDate, displayedTodoBar.endDate, event.clientX) }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', background: '#ffffff12' }} />
                              </>
                            )}
                          </div>
                        )}
                        {isTimelineEditable && dependencyGeometry && (
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
                                  border: `2px solid ${isDependencyTarget ? '#38bdf8' : '#334155'}`,
                                  background: isDependencyTarget ? '#38bdf8' : '#0b1220',
                                  boxShadow: isDependencyTarget ? '0 0 0 4px rgba(56, 189, 248, 0.18)' : 'none',
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
                                border: `2px solid ${isDependencySource ? '#bae6fd' : '#0f172a'}`,
                                background: isDependencySource ? '#38bdf8' : '#f59e0b',
                                boxShadow: isDependencySource ? '0 0 0 4px rgba(56, 189, 248, 0.18)' : '0 0 0 2px rgba(15, 23, 42, 0.58)',
                                cursor: isTimelineEditable ? 'crosshair' : 'default',
                                zIndex: 4
                              }}
                            />
                          </>
                        )}
                      </div>
                    </div>

                    {showSubtasks && isExpanded && group.datedSubTasks.map(({ subTask, bar }) => {
                      const tone = subTaskTone(subTask, todayKey)
                      const baselineBar = showBaseline ? baselineSnapshot?.subTasks[subTask.id] ?? null : null
                      const subTaskActiveState = interaction?.targetType === 'subtask' && interaction.targetId === subTask.id ? interaction : null
                      const displayedBar = subTaskActiveState
                        ? normalizeBar(subTaskActiveState.previewStartDate, subTaskActiveState.previewEndDate)
                        : bar
                      const actualSubTaskStartIndex = diffUnits(displayedBar.startDate, timelineStart, timeScale)
                      const actualSubTaskEndIndex = diffUnits(displayedBar.endDate, timelineStart, timeScale)
                      const clipped = actualSubTaskStartIndex < 0 || actualSubTaskEndIndex > totalUnits - 1
                      const subTaskStartIndex = clamp(actualSubTaskStartIndex, 0, totalUnits - 1)
                      const subTaskEndIndex = clamp(actualSubTaskEndIndex, 0, totalUnits - 1)
                      const baselineVisible = baselineBar
                        ? intersectsRange(baselineBar.startDate, baselineBar.endDate, normalizedRange.start, normalizedRange.end)
                        : false
                      const baselineStartIndex = baselineBar ? clamp(diffUnits(baselineBar.startDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                      const baselineEndIndex = baselineBar ? clamp(diffUnits(baselineBar.endDate, timelineStart, timeScale), 0, totalUnits - 1) : 0
                      return (
                        <div key={subTask.id} style={{ display: 'flex', minHeight: SUBTASK_ROW_HEIGHT, borderTop: '1px solid #0f172a' }}>
                          <div style={{ position: 'sticky', left: 0, zIndex: 3, width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, background: tone.rowBackground, borderRight: '1px solid #1e293b', padding: '8px 12px 8px 24px' }}>
                            <button
                              onClick={() => handleChartItemSelect(group.todo.id)}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                color: tone.text,
                                fontSize: '0.75rem',
                                fontWeight: 700,
                                textAlign: 'left',
                                width: '100%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                textDecoration: Boolean(subTask.done) ? 'line-through' : 'none'
                              }}
                            >
                              - {subTask.title}
                            </button>
                            <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.68rem', color: tone.metaText }}>
                              <span>サブタスク</span>
                              <span>{bar.startDate === bar.endDate ? bar.startDate : `${bar.startDate} - ${bar.endDate}`}</span>
                              <span
                                style={{
                                  padding: '1px 6px',
                                  borderRadius: 999,
                                  background: tone.statusBackground,
                                  color: tone.statusText,
                                  fontWeight: 700
                                }}
                              >
                                {tone.statusLabel}
                              </span>
                            </div>
                          </div>

                          <div style={rowTimelineStyle(SUBTASK_ROW_HEIGHT, unitWidth, timelineWidth)}>
                            {renderTodayOverlay(SUBTASK_ROW_HEIGHT)}
                            {baselineBar && baselineVisible && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: baselineStartIndex * unitWidth + 9,
                                  top: (SUBTASK_ROW_HEIGHT - SUBTASK_BAR_HEIGHT) / 2 + 4,
                                  width: Math.max((baselineEndIndex - baselineStartIndex + 1) * unitWidth - 18, 10),
                                  height: SUBTASK_BAR_HEIGHT - 8,
                                  borderRadius: 999,
                                  background: '#94a3b81a',
                                  border: '1px dashed #94a3b8',
                                  boxSizing: 'border-box',
                                  pointerEvents: 'none'
                                }}
                              />
                            )}
                            <div onClick={() => handleChartItemSelect(group.todo.id)} title={`${subTask.title} (${displayedBar.startDate}${displayedBar.startDate === displayedBar.endDate ? '' : ` - ${displayedBar.endDate}`})`} style={{ position: 'absolute', left: subTaskStartIndex * unitWidth + 6, top: (SUBTASK_ROW_HEIGHT - SUBTASK_BAR_HEIGHT) / 2, width: Math.max((subTaskEndIndex - subTaskStartIndex + 1) * unitWidth - 12, 12), height: SUBTASK_BAR_HEIGHT, borderRadius: 999, background: tone.background, border: `1px ${tone.borderStyle} ${tone.border}`, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tone.text, cursor: !isTimelineEditable ? 'pointer' : 'grab', overflow: 'hidden', boxShadow: subTaskActiveState ? '0 8px 18px rgba(15, 23, 42, 0.24)' : Boolean(subTask.done) ? '0 0 0 1px rgba(134, 239, 172, 0.18) inset' : 'none' }}>
                              <div
                                onPointerDown={(event) => {
                                  if (event.button !== 0 || !isTimelineEditable) return
                                  beginInteraction('move', 'subtask', subTask.id, group.todo.id, displayedBar.startDate, displayedBar.endDate, event.clientX)
                                }}
                                style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: !isTimelineEditable ? 'pointer' : 'grab' }}
                              >
                                <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '0 6px', whiteSpace: 'nowrap', textDecoration: Boolean(subTask.done) ? 'line-through' : 'none' }}>
                                  {Boolean(subTask.done) && unitWidth >= UNIT_WIDTH[timeScale].normal ? '完了 ' : ''}
                                  {unitWidth >= UNIT_WIDTH[timeScale].normal ? subTask.title : barStartLabel(displayedBar.startDate, timeScale)}
                                </span>
                              </div>
                              {isTimelineEditable && (
                                <>
                                  <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeStart', 'subtask', subTask.id, group.todo.id, displayedBar.startDate, displayedBar.endDate, event.clientX) }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: '#ffffff12' }} />
                                  <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeEnd', 'subtask', subTask.id, group.todo.id, displayedBar.startDate, displayedBar.endDate, event.clientX) }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: '#ffffff12' }} />
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {showUnscheduled && (
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 16, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.92rem', color: '#f8fafc', fontWeight: 700 }}>未配置タスク</div>
            <div style={{ fontSize: '0.76rem', color: '#64748b' }}>日付のないタスクは、タイムラインに配置するまでここに表示されます。</div>
          </div>

          {unscheduledGroups.length === 0 ? (
            <div style={{ marginTop: 12, fontSize: '0.82rem', color: '#64748b' }}>未配置タスクはありません。</div>
          ) : (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
              {unscheduledGroups.map((group) => (
                <div key={group.todo.id} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: '12px 13px' }}>
                  <button onClick={() => onSelectTodo(group.todo.id)} style={{ background: 'transparent', border: 'none', padding: 0, color: '#e2e8f0', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700, textAlign: 'left' }}>{group.todo.title}</button>
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.72rem', color: '#94a3b8' }}>
                    <span>P{group.todo.priority}</span>
                    <span>{group.todo.progress}%</span>
                    {group.subTaskCount > 0 && <span>サブタスク {group.subTaskCount}件</span>}
                    {group.todo.category_name && <span style={{ color: group.todo.category_color ?? '#a5b4fc' }}>{group.todo.category_name}</span>}
                  </div>
                  <button onClick={() => void onUpdateTodo(group.todo.id, { start_date: todayKey, due_date: todayKey })} style={{ marginTop: 10, padding: '6px 10px', borderRadius: 8, border: '1px solid #2563eb', background: '#172554', color: '#dbeafe', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 700 }}>今日に配置</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: 14,
  padding: '12px 14px',
  minWidth: 180
}

const cardLabelStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.08em'
}

const cardValueStyle: React.CSSProperties = {
  fontSize: '1.05rem',
  color: '#f8fafc',
  fontWeight: 700,
  marginTop: 8
}

const cardDetailStyle: React.CSSProperties = {
  fontSize: '0.76rem',
  color: '#94a3b8',
  marginTop: 5
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.82rem',
  outline: 'none'
}

const controlLabelStyle: React.CSSProperties = {
  fontSize: '0.72rem',
  color: '#94a3b8'
}

const toggleLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 10,
  background: '#0f172a',
  border: '1px solid #334155',
  color: '#cbd5e1',
  fontSize: '0.8rem'
}

const detailShortcutButtonStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid #334155',
  background: '#111827',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.68rem',
  fontWeight: 700,
  flexShrink: 0
}

const headerActionButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 999,
  border: '1px solid #2563eb',
  background: '#172554',
  color: '#dbeafe',
  cursor: 'pointer',
  fontSize: '0.78rem',
  fontWeight: 700
}

const standaloneBadgeStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 999,
  border: '1px solid #334155',
  background: '#111827',
  color: '#cbd5e1',
  fontSize: '0.78rem',
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
  border: '1px solid #1f2937',
  background: '#0f172a'
}

const dependencyListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxHeight: 180,
  overflow: 'auto',
  padding: 10,
  borderRadius: 12,
  border: '1px solid #1f2937',
  background: '#0f172a'
}

const dependencyRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 10,
  background: '#111827',
  border: '1px solid #1e293b'
}

const dependencyDeleteButtonStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid #7f1d1d',
  background: '#450a0a',
  color: '#fecaca',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 700,
  flexShrink: 0
}

const dependencyLagBadgeStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid #334155',
  background: '#0b1220',
  color: '#cbd5e1',
  fontSize: '0.72rem',
  fontWeight: 700
}

const dependencyLagButtonStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid #334155',
  background: '#111827',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 700,
  flexShrink: 0
}

const selectionEmptyStyle: React.CSSProperties = {
  fontSize: '0.78rem',
  color: '#64748b'
}

const collapsedSummaryChipStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 999,
  background: '#0f172a',
  border: '1px solid #334155',
  color: '#cbd5e1',
  fontSize: '0.76rem',
  fontWeight: 600
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
  top: 78,
  right: 14,
  width: 'min(720px, calc(100% - 28px))',
  maxHeight: '72vh',
  overflow: 'auto',
  padding: 14,
  borderRadius: 16,
  border: '1px solid #334155',
  background: '#0b1220f2',
  backdropFilter: 'blur(10px)',
  boxShadow: '0 20px 48px rgba(15, 23, 42, 0.42)',
  zIndex: 12
}

const settingsSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 12,
  border: '1px solid #1f2937',
  background: '#111827'
}

const floatingCloseButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid #334155',
  background: '#111827',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.74rem',
  fontWeight: 700
}

const centerEmptyStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#64748b',
  padding: 24,
  textAlign: 'center'
}

const secondaryActionChipStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 999,
  border: '1px solid #475569',
  background: '#0f172a',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 700
}

function scheduleHealthBadgeStyle(health: ScheduleHealthInfo): React.CSSProperties {
  return {
    padding: '1px 6px',
    borderRadius: 999,
    background: health.background,
    border: `1px solid ${health.accent}`,
    color: health.text,
    fontWeight: 700
  }
}

function scheduleHealthStripeStyle(health: ScheduleHealthInfo, barWidth: number): React.CSSProperties {
  const innerWidth = Math.max(barWidth - 18, 0)
  const stripeWidth = Math.min(
    innerWidth,
    Math.max((innerWidth * health.expectedProgress) / 100, health.expectedProgress > 0 ? 10 : 0)
  )

  return {
    position: 'absolute',
    left: 9,
    bottom: 4,
    width: stripeWidth,
    height: 4,
    borderRadius: 999,
    background: `repeating-linear-gradient(135deg, ${health.accent} 0, ${health.accent} 6px, ${health.background} 6px, ${health.background} 12px)`,
    opacity: 0.95,
    pointerEvents: 'none'
  }
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '7px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
    background: active ? '#1d4ed8' : '#111827',
    color: active ? '#eff6ff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}

function expandToggleButtonStyle(active: boolean, expanded: boolean): React.CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    border: `1px solid ${active ? '#334155' : '#1f2937'}`,
    background: active ? '#111827' : 'transparent',
    color: active ? (expanded ? '#bfdbfe' : '#94a3b8') : '#334155',
    cursor: active ? 'pointer' : 'default',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1
  }
}

function reorderHandleStyle(disabled: boolean, dragging: boolean): React.CSSProperties {
  return {
    width: 20,
    height: 22,
    borderRadius: 6,
    border: `1px solid ${dragging ? '#38bdf8' : '#334155'}`,
    background: dragging ? '#082f49' : '#111827',
    color: dragging ? '#e0f2fe' : '#94a3b8',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.76rem',
    lineHeight: 1,
    letterSpacing: '-0.1em',
    userSelect: 'none',
    cursor: disabled ? 'not-allowed' : 'grab',
    flexShrink: 0,
    marginTop: 1,
    opacity: disabled ? 0.5 : 1
  }
}

function tagStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    padding: '7px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? accent : '#334155'}`,
    background: active ? `${accent}33` : '#111827',
    color: active ? '#e2e8f0' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}

function taskToggleStyle(active: boolean, accent?: string | null): React.CSSProperties {
  const color = accent ?? '#6366f1'
  return {
    padding: '6px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? color : '#334155'}`,
    background: active ? `${color}26` : '#111827',
    color: active ? '#e2e8f0' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.75rem',
    fontWeight: 700,
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }
}
