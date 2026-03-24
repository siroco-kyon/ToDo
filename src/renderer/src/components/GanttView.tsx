import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Category, SubTask, Todo, UpdateTodoInput } from '../types'

interface Props {
  todos: Todo[]
  categories: Category[]
  onSelectTodo: (id: string) => void
  onUpdateTodo: (id: string, data: UpdateTodoInput) => Promise<void>
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
  originalStartIndex: number
  originalEndIndex: number
  previewStartIndex: number
  previewEndIndex: number
  moved: boolean
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

type ZoomMode = 'compact' | 'normal' | 'detail' | 'focus'
type StatusFilter = 'active' | 'done' | 'all'
type TimeScale = 'day' | 'month' | 'year'
type RangePreset = '14d' | '30d' | '90d' | null
type CategoryFilterKey = string | '__uncategorized__'

const NO_CATEGORY_KEY = '__uncategorized__'
const LEFT_COLUMN_WIDTH = 252
const PARENT_ROW_HEIGHT = 60
const SUBTASK_ROW_HEIGHT = 42
const PARENT_BAR_HEIGHT = 34
const SUBTASK_BAR_HEIGHT = 22
const RANGE_PADDING_DAYS = 5
const UNIT_WIDTH: Record<TimeScale, Record<ZoomMode, number>> = {
  day: { compact: 28, normal: 40, detail: 56, focus: 84 },
  month: { compact: 64, normal: 88, detail: 120, focus: 164 },
  year: { compact: 96, normal: 128, detail: 168, focus: 216 }
}
const ZOOM_LABELS: Record<ZoomMode, string> = {
  compact: '圧縮',
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

function shortDateLabel(dateStr: string): string {
  const date = parseDateKey(dateStr)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function formatUnitLabels(unitStart: string, scale: TimeScale): Pick<TimelineUnit, 'primaryLabel' | 'secondaryLabel'> {
  const date = parseDateKey(unitStart)
  if (scale === 'month') return { primaryLabel: String(date.getFullYear()), secondaryLabel: `${date.getMonth() + 1}月` }
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

function parentTone(todo: Todo): { background: string; border: string; text: string; fill: string } {
  if (todo.status === 'done') return { background: '#16a34a22', border: '#22c55e', text: '#dcfce7', fill: '#22c55e' }
  const base = todo.category_color ?? '#6366f1'
  return { background: `${base}22`, border: `${base}cc`, text: '#e2e8f0', fill: base }
}

function subTaskTone(subTask: SubTask): { background: string; border: string; text: string } {
  return Boolean(subTask.done)
    ? { background: '#14532d33', border: '#22c55e', text: '#bbf7d0' }
    : { background: '#0f172a', border: '#60a5fa', text: '#dbeafe' }
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
  if (scale === 'month') return `${parseDateKey(dateStr).getMonth() + 1}月`
  if (scale === 'year') return `${parseDateKey(dateStr).getFullYear()}年`
  return shortDateLabel(dateStr)
}

export function GanttView({
  todos,
  categories,
  onSelectTodo,
  onUpdateTodo,
  onOpenSeparateWindow,
  standalone = false
}: Props): React.JSX.Element {
  const [zoom, setZoom] = useState<ZoomMode>('detail')
  const [timeScale, setTimeScale] = useState<TimeScale>('day')
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [interaction, setInteraction] = useState<InteractionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [showSubtasks, setShowSubtasks] = useState(true)
  const [showUnscheduled, setShowUnscheduled] = useState(true)
  const [rangeMode, setRangeMode] = useState<'auto' | 'manual'>('auto')
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualPreset, setManualPreset] = useState<RangePreset>(null)
  const [controlsCollapsed, setControlsCollapsed] = useState(true)
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState<CategoryFilterKey[]>([])
  const [taskQuery, setTaskQuery] = useState('')
  const [selectedTodoIds, setSelectedTodoIds] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<InteractionState | null>(null)
  const suppressSelectionRef = useRef(false)

  interactionRef.current = interaction

  const loadSubTasks = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.api.subtaskGetAll()
      setSubTasks(next)
    } catch {
      setSubTasks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSubTasks()
  }, [loadSubTasks])

  useEffect(() => {
    const unsubscribe = window.api.onDataChanged(() => {
      void loadSubTasks()
    })
    return () => unsubscribe()
  }, [loadSubTasks])

  useEffect(() => {
    setSelectedTodoIds((previous) => previous.filter((id) => todos.some((todo) => todo.id === id)))
  }, [todos])

  useEffect(() => {
    setSelectedCategoryKeys((previous) => previous.filter((key) => {
      if (key === NO_CATEGORY_KEY) return todos.some((todo) => !todo.category_id)
      return categories.some((category) => category.id === key)
    }))
  }, [categories, todos])

  const todayKey = getTodayKey()
  const unitWidth = UNIT_WIDTH[timeScale][zoom]
  const isTimelineEditable = timeScale === 'day'
  const normalizedTaskQuery = taskQuery.trim().toLowerCase()

  const applyManualPreset = useCallback((preset: Exclude<RangePreset, null>) => {
    const config = RANGE_PRESETS.find((item) => item.key === preset)
    if (!config) return
    setRangeMode('manual')
    setManualPreset(preset)
    setManualStart(addDays(todayKey, config.startOffset))
    setManualEnd(addDays(todayKey, config.endOffset))
  }, [todayKey])

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
      next.push({ key: NO_CATEGORY_KEY, label: 'カテゴリなし', color: '#64748b' })
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
      .sort((a, b) => b.todo.priority - a.todo.priority || a.todo.title.localeCompare(b.todo.title, 'ja'))
  ), [filteredGroups])

  const autoStart = scheduledGroups[0]?.anchorDate ?? addDays(todayKey, -7)
  const autoEnd = scheduledGroups.reduce((latest, group) => {
    let candidate = latest
    if (group.todoBar && group.todoBar.endDate > candidate) candidate = group.todoBar.endDate
    for (const subTask of group.datedSubTasks) {
      if (subTask.bar.endDate > candidate) candidate = subTask.bar.endDate
    }
    return candidate
  }, scheduledGroups[0]?.todoBar?.endDate ?? scheduledGroups[0]?.anchorDate ?? addDays(todayKey, 21))

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
  const timelineKeys = timelineUnits.map((unit) => unit.startDate)
  const timelineWidth = totalUnits * unitWidth
  const todayIndex = diffUnits(todayKey, timelineStart, timeScale)

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const focusDate = todayIndex >= 0 && todayIndex < totalUnits
      ? todayKey
      : chartGroups[0]?.anchorDate ?? normalizedRange.start
    const targetIndex = clamp(diffUnits(focusDate, timelineStart, timeScale) - 1, 0, Math.max(totalUnits - 1, 0))

    container.scrollLeft = targetIndex * unitWidth
  }, [chartGroups, normalizedRange.start, timeScale, timelineStart, todayIndex, todayKey, totalUnits, unitWidth])

  useEffect(() => {
    if (!interaction || !isTimelineEditable) return

    const handlePointerMove = (event: PointerEvent): void => {
      const current = interactionRef.current
      if (!current) return

      const deltaDays = Math.round((event.clientX - current.originClientX) / unitWidth)
      setInteraction((previous) => {
        if (!previous) return null

        if (previous.mode === 'move') {
          const span = previous.originalEndIndex - previous.originalStartIndex
          const nextStartIndex = clamp(previous.originalStartIndex + deltaDays, 0, totalUnits - 1 - span)
          return {
            ...previous,
            previewStartIndex: nextStartIndex,
            previewEndIndex: nextStartIndex + span,
            moved: previous.moved || deltaDays !== 0
          }
        }

        if (previous.mode === 'resizeStart') {
          return {
            ...previous,
            previewStartIndex: clamp(previous.originalStartIndex + deltaDays, 0, previous.originalEndIndex),
            moved: previous.moved || deltaDays !== 0
          }
        }

        return {
          ...previous,
          previewEndIndex: clamp(previous.originalEndIndex + deltaDays, previous.originalStartIndex, totalUnits - 1),
          moved: previous.moved || deltaDays !== 0
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
      if (current.previewStartIndex === current.originalStartIndex && current.previewEndIndex === current.originalEndIndex) return
      if (current.targetType === 'todo') {
        void onUpdateTodo(current.targetId, {
          start_date: timelineKeys[current.previewStartIndex],
          due_date: timelineKeys[current.previewEndIndex]
        })
        return
      }

      void window.api.subtaskUpdate(current.targetId, {
        start_date: timelineKeys[current.previewStartIndex],
        due_date: timelineKeys[current.previewEndIndex]
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
  }, [interaction, isTimelineEditable, onUpdateTodo, timelineKeys, totalUnits, unitWidth])

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
      originalStartIndex: diffUnits(startDate, timelineStart, 'day'),
      originalEndIndex: diffUnits(endDate, timelineStart, 'day'),
      previewStartIndex: diffUnits(startDate, timelineStart, 'day'),
      previewEndIndex: diffUnits(endDate, timelineStart, 'day'),
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
  const taskSelectionSummary = selectedTodoIds.length === 0 ? `${todoSelectionCandidates.length}件が対象` : `${selectedTodoIds.length}件を固定表示`

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '1rem', color: '#f8fafc', fontWeight: 700 }}>ガントチャート</div>
          <div style={{ marginTop: 4, fontSize: '0.76rem', color: '#94a3b8', lineHeight: 1.5 }}>
            {standalone ? '左の項目を押すと、メイン画面の詳細を開きます。' : '設定をたたんだままでも主要な情報は確認できます。'}
            {!isTimelineEditable && ' 月表示・年表示は閲覧用です。バー編集は日表示で行ってください。'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setControlsCollapsed((previous) => !previous)} style={headerActionButtonStyle}>
            {controlsCollapsed ? '表示設定' : '設定を閉じる'}
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
        <span style={collapsedSummaryChipStyle}>粒度 {SCALE_LABELS[timeScale]}</span>
        <span style={collapsedSummaryChipStyle}>ズーム {ZOOM_LABELS[zoom]}</span>
        <span style={collapsedSummaryChipStyle}>表示 {chartGroups.length}件</span>
        <span style={collapsedSummaryChipStyle}>サブタスク {datedSubTaskCount}件</span>
      </div>

      {!controlsCollapsed && (
        <div style={settingsPanelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: '0.86rem', color: '#f8fafc', fontWeight: 700 }}>表示設定</div>
            <button onClick={() => setControlsCollapsed(true)} style={floatingCloseButtonStyle}>閉じる</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>期間設定</label>
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
                  手動
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
                <button onClick={centerRangeOnToday} style={chipStyle(false)}>今日中心</button>
                <button onClick={() => shiftVisibleRange(1)} style={chipStyle(false)}>次へ</button>
              </div>
            </div>

            <div style={settingsSectionStyle}>
              <label style={controlLabelStyle}>粒度とズーム</label>
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
              <label style={controlLabelStyle}>絞り込み</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setStatusFilter('active')} style={chipStyle(statusFilter === 'active')}>進行中</button>
                <button onClick={() => setStatusFilter('done')} style={chipStyle(statusFilter === 'done')}>完了</button>
                <button onClick={() => setStatusFilter('all')} style={chipStyle(statusFilter === 'all')}>すべて</button>
              </div>
              <input
                value={taskQuery}
                onChange={(event) => setTaskQuery(event.target.value)}
                placeholder="タイトル・説明・カテゴリで絞り込み"
                style={{ ...inputStyle, width: '100%' }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={toggleLabelStyle}>
                  <input type="checkbox" checked={showSubtasks} onChange={(event) => setShowSubtasks(event.target.checked)} />
                  <span>サブタスクを表示</span>
                </label>
                <label style={toggleLabelStyle}>
                  <input type="checkbox" checked={showUnscheduled} onChange={(event) => setShowUnscheduled(event.target.checked)} />
                  <span>未配置タスクを表示</span>
                </label>
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
                <button onClick={() => setSelectedTodoIds([])} style={chipStyle(selectedTodoIds.length === 0)}>全件</button>
                {selectedTodoIds.length > 0 && (
                  <button onClick={() => setSelectedTodoIds([])} style={chipStyle(false)}>選択解除</button>
                )}
              </div>
              <div style={taskSelectionPanelStyle}>
                {todoSelectionCandidates.length === 0 ? (
                  <div style={selectionEmptyStyle}>条件に合う候補がありません。</div>
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
          </div>
        </div>
      )}

      <div style={{ flex: '0 0 auto', minHeight: controlsCollapsed ? 540 : 460, height: controlsCollapsed ? '72vh' : '58vh', border: '1px solid #1e293b', borderRadius: 18, background: '#0b1220', overflow: 'hidden' }}>
        {loading ? (
          <div style={centerEmptyStyle}>サブタスクを読み込み中...</div>
        ) : chartGroups.length === 0 ? (
          <div style={centerEmptyStyle}>条件に合うタスクがありません。</div>
        ) : (
          <div ref={scrollRef} style={{ height: '100%', overflow: 'auto' }}>
            <div style={{ minWidth: LEFT_COLUMN_WIDTH + timelineWidth }}>
              <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 6 }}>
                <div style={{ position: 'sticky', left: 0, width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, background: '#0f172a', borderRight: '1px solid #1e293b', borderBottom: '1px solid #1e293b', padding: '10px 12px' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>項目</div>
                  <div style={{ marginTop: 6, fontSize: '0.85rem', color: '#cbd5e1' }}>期間 / 進捗 / 階層</div>
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

              {chartGroups.map((group) => {
                const tone = parentTone(group.todo)
                const progress = group.todo.status === 'done' ? 100 : group.todo.progress
                const todoBar = group.todoBar
                const todoVisible = todoBar ? intersectsRange(todoBar.startDate, todoBar.endDate, normalizedRange.start, normalizedRange.end) : false
                const actualStartIndex = todoBar ? diffUnits(todoBar.startDate, timelineStart, timeScale) : 0
                const actualEndIndex = todoBar ? diffUnits(todoBar.endDate, timelineStart, timeScale) : 0
                const clipped = todoBar ? actualStartIndex < 0 || actualEndIndex > totalUnits - 1 : false
                const activeState = interaction?.targetType === 'todo' && interaction.targetId === group.todo.id ? interaction : null
                const displayStartIndex = todoBar ? clamp(activeState ? activeState.previewStartIndex : actualStartIndex, 0, totalUnits - 1) : 0
                const displayEndIndex = todoBar ? clamp(activeState ? activeState.previewEndIndex : actualEndIndex, 0, totalUnits - 1) : 0

                return (
                  <div key={group.todo.id}>
                    <div style={{ display: 'flex', minHeight: PARENT_ROW_HEIGHT, borderTop: '1px solid #111827' }}>
                      <div style={{ position: 'sticky', left: 0, zIndex: 4, width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, background: '#0f172a', borderRight: '1px solid #1e293b', padding: '9px 12px' }}>
                        <button onClick={() => handleChartItemSelect(group.todo.id)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: '#f8fafc', fontSize: '0.8rem', fontWeight: 700, textAlign: 'left', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.todo.title}</button>
                        <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.66rem', color: '#94a3b8' }}>
                          <span>{todoBar ? `${todoBar.startDate}${todoBar.startDate === todoBar.endDate ? '' : ` - ${todoBar.endDate}`}` : '親タスク期間なし'}</span>
                          <span>{todoBar ? `${diffCalendarDays(todoBar.endDate, todoBar.startDate) + 1}日` : 'サブタスクのみ'}</span>
                          <span>{progress}%</span>
                        </div>
                        <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.66rem' }}>
                          {group.todo.category_name && <span style={{ color: group.todo.category_color ?? '#a5b4fc' }}>{group.todo.category_name}</span>}
                          {clipped && <span style={{ color: '#fbbf24' }}>表示範囲で省略</span>}
                          {group.undatedSubTaskCount > 0 && <span style={{ color: '#94a3b8' }}>日付なしサブタスク {group.undatedSubTaskCount}件</span>}
                        </div>
                      </div>

                      <div style={rowTimelineStyle(PARENT_ROW_HEIGHT, unitWidth, timelineWidth)}>
                        {renderTodayOverlay(PARENT_ROW_HEIGHT)}
                        {todoBar && todoVisible && (
                          <div onClick={() => handleChartItemSelect(group.todo.id)} style={{ position: 'absolute', left: displayStartIndex * unitWidth + 4, top: (PARENT_ROW_HEIGHT - PARENT_BAR_HEIGHT) / 2, width: Math.max((displayEndIndex - displayStartIndex + 1) * unitWidth - 8, 24), height: PARENT_BAR_HEIGHT, borderRadius: 12, background: tone.background, border: `1px solid ${tone.border}`, boxSizing: 'border-box', overflow: 'hidden', boxShadow: activeState ? '0 10px 24px rgba(15, 23, 42, 0.28)' : 'none', cursor: clipped || !isTimelineEditable ? 'pointer' : 'grab' }}>
                            <div style={{ position: 'absolute', inset: 0, width: `${progress}%`, background: `${tone.fill}66` }} />
                            <div
                              onPointerDown={(event) => {
                                if (event.button !== 0 || clipped || !isTimelineEditable) return
                                beginInteraction('move', 'todo', group.todo.id, group.todo.id, todoBar.startDate, todoBar.endDate, event.clientX)
                              }}
                              style={{ position: 'absolute', left: 9, right: 9, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 10, cursor: clipped || !isTimelineEditable ? 'pointer' : 'grab', color: tone.text, zIndex: 2 }}
                            >
                              <span style={{ fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{barStartLabel(todoBar.startDate, timeScale)}</span>
                              <span style={{ fontSize: '0.78rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.todo.title}</span>
                            </div>
                            {isTimelineEditable && !clipped && (
                              <>
                                <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeStart', 'todo', group.todo.id, group.todo.id, todoBar.startDate, todoBar.endDate, event.clientX) }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', background: '#ffffff12' }} />
                                <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeEnd', 'todo', group.todo.id, group.todo.id, todoBar.startDate, todoBar.endDate, event.clientX) }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', background: '#ffffff12' }} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {showSubtasks && group.datedSubTasks.map(({ subTask, bar }) => {
                      const tone = subTaskTone(subTask)
                      const subTaskActiveState = interaction?.targetType === 'subtask' && interaction.targetId === subTask.id ? interaction : null
                      const actualSubTaskStartIndex = diffUnits(bar.startDate, timelineStart, timeScale)
                      const actualSubTaskEndIndex = diffUnits(bar.endDate, timelineStart, timeScale)
                      const clipped = actualSubTaskStartIndex < 0 || actualSubTaskEndIndex > totalUnits - 1
                      const subTaskStartIndex = clamp(subTaskActiveState ? subTaskActiveState.previewStartIndex : actualSubTaskStartIndex, 0, totalUnits - 1)
                      const subTaskEndIndex = clamp(subTaskActiveState ? subTaskActiveState.previewEndIndex : actualSubTaskEndIndex, 0, totalUnits - 1)
                      return (
                        <div key={subTask.id} style={{ display: 'flex', minHeight: SUBTASK_ROW_HEIGHT, borderTop: '1px solid #0f172a' }}>
                          <div style={{ position: 'sticky', left: 0, zIndex: 3, width: LEFT_COLUMN_WIDTH, minWidth: LEFT_COLUMN_WIDTH, background: '#0c1322', borderRight: '1px solid #1e293b', padding: '8px 12px 8px 24px' }}>
                            <button onClick={() => handleChartItemSelect(group.todo.id)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: '#cbd5e1', fontSize: '0.75rem', fontWeight: 600, textAlign: 'left', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>└ {subTask.title}</button>
                            <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.68rem', color: '#64748b' }}>
                              <span>サブタスク</span>
                              <span>{bar.startDate === bar.endDate ? bar.startDate : `${bar.startDate} - ${bar.endDate}`}</span>
                              {Boolean(subTask.done) ? <span style={{ color: '#86efac' }}>完了</span> : <span>未完</span>}
                            </div>
                          </div>

                          <div style={rowTimelineStyle(SUBTASK_ROW_HEIGHT, unitWidth, timelineWidth)}>
                            {renderTodayOverlay(SUBTASK_ROW_HEIGHT)}
                            <div onClick={() => handleChartItemSelect(group.todo.id)} title={`${subTask.title} (${bar.startDate}${bar.startDate === bar.endDate ? '' : ` - ${bar.endDate}`})`} style={{ position: 'absolute', left: subTaskStartIndex * unitWidth + 6, top: (SUBTASK_ROW_HEIGHT - SUBTASK_BAR_HEIGHT) / 2, width: Math.max((subTaskEndIndex - subTaskStartIndex + 1) * unitWidth - 12, 12), height: SUBTASK_BAR_HEIGHT, borderRadius: 999, background: tone.background, border: `1px dashed ${tone.border}`, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tone.text, cursor: clipped || !isTimelineEditable ? 'pointer' : 'grab', overflow: 'hidden', boxShadow: subTaskActiveState ? '0 8px 18px rgba(15, 23, 42, 0.24)' : 'none' }}>
                              <div
                                onPointerDown={(event) => {
                                  if (event.button !== 0 || clipped || !isTimelineEditable) return
                                  beginInteraction('move', 'subtask', subTask.id, group.todo.id, bar.startDate, bar.endDate, event.clientX)
                                }}
                                style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: clipped || !isTimelineEditable ? 'pointer' : 'grab' }}
                              >
                                <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '0 6px', whiteSpace: 'nowrap' }}>{unitWidth >= UNIT_WIDTH[timeScale].normal ? subTask.title : barStartLabel(bar.startDate, timeScale)}</span>
                              </div>
                              {isTimelineEditable && !clipped && (
                                <>
                                  <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeStart', 'subtask', subTask.id, group.todo.id, bar.startDate, bar.endDate, event.clientX) }} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: '#ffffff12' }} />
                                  <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); beginInteraction('resizeEnd', 'subtask', subTask.id, group.todo.id, bar.startDate, bar.endDate, event.clientX) }} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', background: '#ffffff12' }} />
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
        )}
      </div>

      {showUnscheduled && (
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 16, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: '0.92rem', color: '#f8fafc', fontWeight: 700 }}>未配置タスク</div>
            <div style={{ fontSize: '0.76rem', color: '#64748b' }}>親タスク期間も日付付きサブタスクもないものを置いています。</div>
          </div>

          {unscheduledGroups.length === 0 ? (
            <div style={{ marginTop: 12, fontSize: '0.82rem', color: '#64748b' }}>未配置のタスクはありません。</div>
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
                  <button onClick={() => void onUpdateTodo(group.todo.id, { start_date: todayKey, due_date: todayKey })} style={{ marginTop: 10, padding: '6px 10px', borderRadius: 8, border: '1px solid #2563eb', background: '#172554', color: '#dbeafe', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 700 }}>今日に置く</button>
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
