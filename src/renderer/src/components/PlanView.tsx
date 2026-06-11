import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DailyPlanItem, Todo, UpdateDailyPlanItemInput } from '../types'

interface Props {
  date: string
  planItems: DailyPlanItem[]
  todos: Todo[]
  runningTodoId: string | null
  onSelectTodo: (id: string) => void
  onAddTodo: (todoId: string) => Promise<DailyPlanItem>
  onRemoveItem: (id: string) => Promise<void>
  onUpdateItem: (id: string, data: UpdateDailyPlanItemInput) => Promise<void>
  onShiftItem: (id: string, deltaMinutes: number) => Promise<void>
  onReorder: (orderedIds: string[]) => Promise<void>
}

interface SuggestedGroup {
  title: string
  items: Todo[]
}

interface TimelineBlock extends DailyPlanItem {
  startMinutes: number
  durationMinutes: number
  endMinutes: number
}

interface InteractionState {
  mode: 'move' | 'resize'
  itemId: string
  startMinutes: number
  durationMinutes: number
  lane: number
  originClientY: number
  previewStart: number
  previewDuration: number
  previewLane: number
}

interface DragPreview {
  title: string
  durationMinutes: number
}

interface PlacementDraft {
  source: 'todo' | 'planItem'
  id: string
  title: string
  durationMinutes: number
}

interface PlacementTarget {
  minutes: number
  lane: number
}

const TIMELINE_START_HOUR = 0
const TIMELINE_END_HOUR = 24
const TIMELINE_TOTAL_MINUTES = (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60
const SNAP_MINUTES = 15
const MIN_DURATION = 15
const DEFAULT_DURATION = 60
const MAX_DURATION = 480
const PIXELS_PER_MINUTE = 1.8
const HOUR_HEIGHT = PIXELS_PER_MINUTE * 60
const TIMELINE_HEIGHT = TIMELINE_TOTAL_MINUTES * PIXELS_PER_MINUTE
const BLOCK_GAP = 8
const LANE_COUNT = 1
const MAX_LANES = 2
const COMPACT_BLOCK_THRESHOLD = 64
const EDGE_SCROLL_THRESHOLD = 72
const EDGE_SCROLL_PIXELS = 24
const AUTO_SCROLL_LEAD_MINUTES = 60

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function diffCalendarDays(dateStr: string, baseDateStr: string): number {
  const diffMs = parseDateKey(dateStr).getTime() - parseDateKey(baseDateStr).getTime()
  return Math.round(diffMs / 86400000)
}

function formatDueLabel(dueDate: string | null, todayKey: string): string {
  if (!dueDate) return '期限なし'
  const diffDays = diffCalendarDays(dueDate, todayKey)
  if (diffDays < 0) return `${Math.abs(diffDays)}日遅れ`
  if (diffDays === 0) return '今日が期限'
  if (diffDays === 1) return '明日が期限'
  return `あと${diffDays}日`
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}分`
  if (mins === 0) return `${hours}時間`
  return `${hours}時間${mins}分`
}

function clockToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function offsetToClock(offsetMinutes: number): string {
  const totalMinutes = TIMELINE_START_HOUR * 60 + offsetMinutes
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function nowOffsetMinutes(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes() - TIMELINE_START_HOUR * 60
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function snapMinutes(value: number): number {
  return Math.round(value / SNAP_MINUTES) * SNAP_MINUTES
}

function normalizeDuration(value: number | null | undefined): number {
  return clamp(snapMinutes(value ?? DEFAULT_DURATION), MIN_DURATION, MAX_DURATION)
}

function getScheduledOffset(item: DailyPlanItem): number | null {
  if (!item.scheduled_start) return null
  return clamp(
    snapMinutes(clockToMinutes(item.scheduled_start) - TIMELINE_START_HOUR * 60),
    0,
    TIMELINE_TOTAL_MINUTES - MIN_DURATION
  )
}

function buildTimelineBlocks(items: DailyPlanItem[]): TimelineBlock[] {
  return items
    .map((item) => {
      const startMinutes = getScheduledOffset(item)
      if (startMinutes == null) return null

      const durationMinutes = clamp(
        normalizeDuration(item.estimated_minutes),
        MIN_DURATION,
        TIMELINE_TOTAL_MINUTES - startMinutes
      )

      return {
        ...item,
        startMinutes,
        durationMinutes,
        endMinutes: startMinutes + durationMinutes
      }
    })
    .filter((item): item is TimelineBlock => item !== null)
    .sort((a, b) => {
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes
      if ((a.lane ?? 0) !== (b.lane ?? 0)) return (a.lane ?? 0) - (b.lane ?? 0)
      if (a.endMinutes !== b.endMinutes) return a.endMinutes - b.endMinutes
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
}

function clampLane(value: number): number {
  return clamp(Math.round(value), 0, LANE_COUNT - 1)
}

function getLaneLayout(lane: number): { left: string; width: string } {
  const safeLane = clampLane(lane)
  const totalGap = BLOCK_GAP * (LANE_COUNT - 1)

  return {
    left: safeLane === 0
      ? '0px'
      : `calc(${safeLane} * ((100% - ${totalGap}px) / ${LANE_COUNT}) + ${safeLane * BLOCK_GAP}px)`,
    width: `calc((100% - ${totalGap}px) / ${LANE_COUNT})`
  }
}

interface ColumnPlacement {
  col: number
  cols: number
}

function getColumnLayout({ col, cols }: ColumnPlacement): { left: string; width: string } {
  if (cols <= 1) return { left: '0px', width: '100%' }

  const totalGap = BLOCK_GAP * (cols - 1)
  return {
    left: col === 0
      ? '0px'
      : `calc(${col} * ((100% - ${totalGap}px) / ${cols}) + ${col * BLOCK_GAP}px)`,
    width: `calc((100% - ${totalGap}px) / ${cols})`
  }
}

/**
 * Spreads time-overlapping blocks across up to MAX_LANES side-by-side columns
 * so they no longer stack on top of each other. Blocks within one overlap
 * cluster share the same column count (full width when nothing overlaps).
 */
function packColumns(blocks: TimelineBlock[]): Map<string, ColumnPlacement> {
  const placement = new Map<string, ColumnPlacement>()
  let index = 0

  while (index < blocks.length) {
    let clusterEnd = blocks[index].endMinutes
    let next = index + 1
    while (next < blocks.length && blocks[next].startMinutes < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, blocks[next].endMinutes)
      next += 1
    }

    const cluster = blocks.slice(index, next)
    const columnEnds: number[] = []
    const assignedColumns = cluster.map((block) => {
      let col = columnEnds.findIndex((end) => end <= block.startMinutes)
      if (col === -1) {
        if (columnEnds.length < MAX_LANES) {
          col = columnEnds.length
          columnEnds.push(block.endMinutes)
        } else {
          col = columnEnds[0] <= columnEnds[1] ? 0 : 1
          columnEnds[col] = block.endMinutes
        }
      } else {
        columnEnds[col] = block.endMinutes
      }
      return col
    })

    const cols = Math.min(columnEnds.length, MAX_LANES)
    cluster.forEach((block, offset) => {
      placement.set(block.id, { col: assignedColumns[offset], cols })
    })

    index = next
  }

  return placement
}

function readDragPreview(event: React.DragEvent<HTMLElement>): DragPreview | null {
  const raw = event.dataTransfer.getData('application/x-plan-drag-meta')
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as { title?: string; durationMinutes?: number }
    if (!parsed.title) return null
    return {
      title: parsed.title,
      durationMinutes: normalizeDuration(parsed.durationMinutes)
    }
  } catch {
    return null
  }
}

function reorderIdsByTime(items: DailyPlanItem[]): string[] {
  const scheduled = items
    .filter((item) => item.scheduled_start)
    .sort((a, b) => {
      const aStart = clockToMinutes(a.scheduled_start!)
      const bStart = clockToMinutes(b.scheduled_start!)
      if (aStart !== bStart) return aStart - bStart
      if ((a.lane ?? 0) !== (b.lane ?? 0)) return (a.lane ?? 0) - (b.lane ?? 0)
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
    .map((item) => item.id)

  const unscheduled = items
    .filter((item) => !item.scheduled_start)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((item) => item.id)

  return [...scheduled, ...unscheduled]
}

function SummaryCard({
  label,
  value,
  detail,
  tone
}: {
  label: string
  value: string
  detail: string
  tone: string
}): React.JSX.Element {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: '1.08rem', color: tone, fontWeight: 700, marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
      <div style={{ fontSize: '0.76rem', color: '#94a3b8', marginTop: 6 }}>{detail}</div>
    </div>
  )
}

function Section({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      style={{
        background: '#111827',
        border: '1px solid #1f2937',
        borderRadius: 16,
        padding: 16,
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.95rem', color: '#f8fafc', fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: '0.76rem', color: '#64748b' }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}

function EmptyState({ label }: { label: string }): React.JSX.Element {
  return <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '4px 2px', lineHeight: 1.6 }}>{label}</div>
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.84rem',
  outline: 'none',
  boxSizing: 'border-box'
}

function actionBtn(background: string, color: string, borderColor: string): React.CSSProperties {
  return {
    background,
    color,
    border: `1px solid ${borderColor}`,
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

function miniActionBtn(background: string, color: string): React.CSSProperties {
  return {
    background,
    color,
    border: '1px solid transparent',
    borderRadius: 6,
    padding: '2px 6px',
    cursor: 'pointer',
    fontSize: '0.66rem',
    lineHeight: 1.2
  }
}

const laneHeaderStyle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: '0.74rem',
  color: '#94a3b8',
  background: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 10,
  padding: '6px 8px',
  fontWeight: 700
}

function CandidateCard({
  todo,
  todayKey,
  onAdd,
  onSchedule,
  onPrepareDrag,
  placementActive
}: {
  todo: Todo
  todayKey: string
  onAdd: (todoId: string) => Promise<void>
  onSchedule: (draft: PlacementDraft) => void
  onPrepareDrag: () => void
  placementActive: boolean
}): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={(event) => {
        onPrepareDrag()
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData('application/x-todo-id', todo.id)
        event.dataTransfer.setData('application/x-plan-drag-meta', JSON.stringify({
          title: todo.title,
          durationMinutes: DEFAULT_DURATION
        }))
      }}
      style={{
        background: '#0f172a',
        border: placementActive ? '1px solid #3b82f6' : '1px solid #1e293b',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        cursor: 'grab',
        boxShadow: placementActive ? '0 0 0 1px #1d4ed8 inset' : 'none'
      }}
      title="ドラッグで時間割へ置けます。クリック配置なら「時間に置く」を押してください。"
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.86rem', color: '#e2e8f0', fontWeight: 600, lineHeight: 1.4 }}>{todo.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {todo.category_name && (
            <span
              style={{
                fontSize: '0.68rem',
                color: todo.category_color ?? '#a5b4fc',
                background: `${todo.category_color ?? '#6366f1'}20`,
                borderRadius: 999,
                padding: '2px 8px'
              }}
            >
              {todo.category_name}
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: '#cbd5e1' }}>{formatDueLabel(todo.due_date, todayKey)}</span>
          <span style={{ fontSize: '0.72rem', color: '#fbbf24' }}>P{todo.priority}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
        <button
          onClick={(event) => {
            event.stopPropagation()
            onSchedule({
              source: 'todo',
              id: todo.id,
              title: todo.title,
              durationMinutes: DEFAULT_DURATION
            })
          }}
          style={actionBtn(placementActive ? '#1d4ed8' : '#1e293b', '#dbeafe', placementActive ? '#60a5fa' : '#334155')}
        >
          {placementActive ? '配置中' : '時間に置く'}
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation()
            void onAdd(todo.id)
          }}
          style={actionBtn('#172554', '#bfdbfe', '#2563eb')}
        >
          今日に入れる
        </button>
      </div>
    </div>
  )
}

function UnscheduledCard({
  item,
  todayKey,
  onSelect,
  onRemove,
  onSchedule,
  onPrepareDrag,
  placementActive
}: {
  item: DailyPlanItem
  todayKey: string
  onSelect: (id: string) => void
  onRemove: (id: string) => Promise<void>
  onSchedule: (draft: PlacementDraft) => void
  onPrepareDrag: () => void
  placementActive: boolean
}): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={(event) => {
        onPrepareDrag()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-plan-item-id', item.id)
        event.dataTransfer.setData('application/x-plan-drag-meta', JSON.stringify({
          title: item.title,
          durationMinutes: normalizeDuration(item.estimated_minutes)
        }))
      }}
      style={{
        background: '#0f172a',
        border: placementActive ? '1px solid #3b82f6' : '1px dashed #334155',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        cursor: 'grab',
        boxShadow: placementActive ? '0 0 0 1px #1d4ed8 inset' : 'none'
      }}
      title="ドラッグまたはクリック配置で時間割に入れられます。"
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          onClick={() => onSelect(item.todo_id)}
          style={{ background: 'transparent', border: 'none', padding: 0, color: '#e2e8f0', cursor: 'pointer', fontSize: '0.86rem', fontWeight: 600, textAlign: 'left', lineHeight: 1.4 }}
        >
          {item.title}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {item.category_name && (
            <span
              style={{
                fontSize: '0.68rem',
                color: item.category_color ?? '#a5b4fc',
                background: `${item.category_color ?? '#6366f1'}20`,
                borderRadius: 999,
                padding: '2px 8px'
              }}
            >
              {item.category_name}
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: '#cbd5e1' }}>{formatDueLabel(item.due_date, todayKey)}</span>
          <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{formatMinutes(normalizeDuration(item.estimated_minutes))}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
        <button
          onClick={(event) => {
            event.stopPropagation()
            onSchedule({
              source: 'planItem',
              id: item.id,
              title: item.title,
              durationMinutes: normalizeDuration(item.estimated_minutes)
            })
          }}
          style={actionBtn(placementActive ? '#1d4ed8' : '#1e293b', '#dbeafe', placementActive ? '#60a5fa' : '#334155')}
        >
          {placementActive ? '配置中' : '時間に置く'}
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation()
            void onRemove(item.id)
          }}
          style={actionBtn('#3f1d1d', '#fca5a5', '#7f1d1d')}
        >
          外す
        </button>
      </div>
    </div>
  )
}
export function PlanView({
  date,
  planItems,
  todos,
  runningTodoId,
  onSelectTodo,
  onAddTodo,
  onRemoveItem,
  onUpdateItem,
  onShiftItem,
  onReorder
}: Props): React.JSX.Element {
  const timelineRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<InteractionState | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [dragOverMinutes, setDragOverMinutes] = useState<number | null>(null)
  const [dragOverLane, setDragOverLane] = useState<number | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [placementDraft, setPlacementDraft] = useState<PlacementDraft | null>(null)
  const [placementTarget, setPlacementTarget] = useState<PlacementTarget | null>(null)
  const [interaction, setInteraction] = useState<InteractionState | null>(null)

  interactionRef.current = interaction

  const plannedTodoIds = useMemo(() => new Set(planItems.map((item) => item.todo_id)), [planItems])

  const availableTodos = useMemo(() => (
    todos
      .filter((todo) => todo.status !== 'done' && todo.status !== 'archived')
      .filter((todo) => !plannedTodoIds.has(todo.id))
      .sort((a, b) => {
        if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date)
        if (a.due_date && !b.due_date) return -1
        if (!a.due_date && b.due_date) return 1
        if (b.priority !== a.priority) return b.priority - a.priority
        return a.title.localeCompare(b.title, 'ja')
      })
  ), [plannedTodoIds, todos])

  const suggestions = useMemo(() => {
    const staleLimit = Date.now() - 7 * 86400000
    const groups: SuggestedGroup[] = [
      { title: '期限が今日', items: availableTodos.filter((todo) => todo.due_date === date).slice(0, 4) },
      {
        title: '期限が近い',
        items: availableTodos
          .filter((todo) => todo.due_date && todo.due_date !== date && diffCalendarDays(todo.due_date, date) > 0 && diffCalendarDays(todo.due_date, date) <= 3)
          .slice(0, 4)
      },
      { title: '優先度が高い', items: availableTodos.filter((todo) => todo.priority >= 4).slice(0, 4) },
      { title: 'しばらく触っていない', items: availableTodos.filter((todo) => new Date(todo.updated_at).getTime() <= staleLimit).slice(0, 4) }
    ]

    return groups.filter((group) => group.items.length > 0)
  }, [availableTodos, date])

  const filteredBacklog = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return availableTodos.slice(0, 12)

    return availableTodos
      .filter((todo) => {
        return todo.title.toLowerCase().includes(query)
          || todo.description.toLowerCase().includes(query)
          || (todo.category_name?.toLowerCase().includes(query) ?? false)
      })
      .slice(0, 20)
  }, [availableTodos, searchQuery])

  const effectivePlanItems = useMemo(() => {
    if (!interaction) return planItems

    return planItems.map((item) => {
      if (item.id !== interaction.itemId) return item
      return {
        ...item,
        scheduled_start: offsetToClock(interaction.previewStart),
        estimated_minutes: interaction.previewDuration,
        lane: interaction.previewLane
      }
    })
  }, [interaction, planItems])

  const timelineBlocks = useMemo(() => buildTimelineBlocks(effectivePlanItems), [effectivePlanItems])
  const columnMap = useMemo(() => packColumns(timelineBlocks), [timelineBlocks])
  const unscheduledItems = useMemo(() => (
    effectivePlanItems
      .filter((item) => !item.scheduled_start)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  ), [effectivePlanItems])

  const totalPlannedMinutes = effectivePlanItems.reduce((sum, item) => sum + normalizeDuration(item.estimated_minutes), 0)
  const timedCount = timelineBlocks.length
  const currentOffset = nowOffsetMinutes()

  const activePreview = dragPreview ?? (placementDraft ? { title: placementDraft.title, durationMinutes: placementDraft.durationMinutes } : null)
  const previewTarget = dragOverMinutes != null && dragOverLane != null ? { minutes: dragOverMinutes, lane: dragOverLane } : placementTarget

  useLayoutEffect(() => {
    const todayKey = getTodayKey()
    if (date !== todayKey) return

    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    const applyScroll = (): void => {
      const startOffset = clamp(nowOffsetMinutes() - AUTO_SCROLL_LEAD_MINUTES, 0, TIMELINE_TOTAL_MINUTES)
      const targetTop = startOffset * PIXELS_PER_MINUTE
      const maxScrollTop = Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 0)
      scrollContainer.scrollTop = clamp(targetTop, 0, maxScrollTop)
    }

    applyScroll()
    const timer1 = window.setTimeout(applyScroll, 0)
    const timer2 = window.setTimeout(applyScroll, 120)
    const timer3 = window.setTimeout(applyScroll, 320)

    return () => {
      window.clearTimeout(timer1)
      window.clearTimeout(timer2)
      window.clearTimeout(timer3)
    }
  }, [date])

  useEffect(() => {
    if (!placementDraft) return undefined

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key !== 'Escape') return
      setPlacementDraft(null)
      setPlacementTarget(null)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [placementDraft])

  useEffect(() => {
    if (!interaction) return undefined

    const handlePointerMove = (event: PointerEvent): void => {
      const scrollContainer = scrollContainerRef.current
      if (scrollContainer) {
        const rect = scrollContainer.getBoundingClientRect()
        if (event.clientY < rect.top + EDGE_SCROLL_THRESHOLD) {
          scrollContainer.scrollTop -= EDGE_SCROLL_PIXELS
        } else if (event.clientY > rect.bottom - EDGE_SCROLL_THRESHOLD) {
          scrollContainer.scrollTop += EDGE_SCROLL_PIXELS
        }
      }

      setInteraction((prev) => {
        if (!prev) return prev

        const deltaMinutes = snapMinutes((event.clientY - prev.originClientY) / PIXELS_PER_MINUTE)
        const timelineRect = timelineRef.current?.getBoundingClientRect()
        const previewLane = timelineRect
          ? clampLane(((event.clientX - timelineRect.left) / Math.max(timelineRect.width, 1)) * LANE_COUNT)
          : prev.previewLane

        if (prev.mode === 'move') {
          const previewStart = clamp(prev.startMinutes + deltaMinutes, 0, TIMELINE_TOTAL_MINUTES - prev.durationMinutes)
          return { ...prev, previewStart, previewDuration: prev.durationMinutes, previewLane }
        }

        const maxDuration = Math.min(MAX_DURATION, TIMELINE_TOTAL_MINUTES - prev.startMinutes)
        const previewDuration = clamp(prev.durationMinutes + deltaMinutes, MIN_DURATION, maxDuration)
        return { ...prev, previewDuration: snapMinutes(previewDuration), previewLane: prev.previewLane }
      })
    }

    const handlePointerUp = (): void => {
      const current = interactionRef.current
      setInteraction(null)
      if (!current) return

      const startChanged = current.previewStart !== current.startMinutes
      const durationChanged = current.previewDuration !== current.durationMinutes
      const laneChanged = current.previewLane !== current.lane
      if (!startChanged && !durationChanged && !laneChanged) return

      const nextItems = planItems.map((item) => {
        if (item.id !== current.itemId) return item
        return {
          ...item,
          scheduled_start: offsetToClock(current.previewStart),
          estimated_minutes: current.previewDuration,
          lane: current.previewLane
        }
      })

      void onUpdateItem(current.itemId, {
        scheduled_start: offsetToClock(current.previewStart),
        estimated_minutes: current.previewDuration,
        lane: current.previewLane
      }).then(() => onReorder(reorderIdsByTime(nextItems)))
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [interaction, onReorder, onUpdateItem, planItems])

  const clearPlacement = (): void => {
    setPlacementDraft(null)
    setPlacementTarget(null)
  }

  const beginInteraction = (mode: 'move' | 'resize', item: TimelineBlock, clientY: number): void => {
    clearPlacement()
    setInteraction({
      mode,
      itemId: item.id,
      startMinutes: item.startMinutes,
      durationMinutes: item.durationMinutes,
      lane: clampLane(item.lane ?? 0),
      originClientY: clientY,
      previewStart: item.startMinutes,
      previewDuration: item.durationMinutes,
      previewLane: clampLane(item.lane ?? 0)
    })
  }

  const getDropMinutes = (clientY: number): number | null => {
    const element = timelineRef.current
    if (!element) return null

    const rect = element.getBoundingClientRect()
    const relativeY = clientY - rect.top
    return clamp(snapMinutes(relativeY / PIXELS_PER_MINUTE), 0, TIMELINE_TOTAL_MINUTES - MIN_DURATION)
  }

  const getDropLane = (clientX: number): number | null => {
    const element = timelineRef.current
    if (!element) return null

    const rect = element.getBoundingClientRect()
    const relativeX = clientX - rect.left
    return clampLane((relativeX / Math.max(rect.width, 1)) * LANE_COUNT)
  }
  const schedulePlanItem = async (planItemId: string, startMinutes: number, lane: number, durationMinutes?: number): Promise<void> => {
    const normalizedDuration = durationMinutes == null ? undefined : normalizeDuration(durationMinutes)
    const nextItems = planItems.map((item) => {
      if (item.id !== planItemId) return item
      return {
        ...item,
        scheduled_start: offsetToClock(startMinutes),
        estimated_minutes: normalizedDuration ?? item.estimated_minutes,
        lane
      }
    })

    await onUpdateItem(planItemId, {
      scheduled_start: offsetToClock(startMinutes),
      estimated_minutes: normalizedDuration,
      lane
    })
    await onReorder(reorderIdsByTime(nextItems))
  }

  const scheduleTodo = async (todoId: string, startMinutes: number, lane: number, durationMinutes?: number): Promise<void> => {
    const normalizedDuration = normalizeDuration(durationMinutes)
    const created = await onAddTodo(todoId)
    const nextCreated = {
      ...created,
      scheduled_start: offsetToClock(startMinutes),
      estimated_minutes: normalizedDuration,
      lane
    }

    await onUpdateItem(created.id, {
      scheduled_start: offsetToClock(startMinutes),
      estimated_minutes: normalizedDuration,
      lane
    })
    await onReorder(reorderIdsByTime([...planItems, nextCreated]))
  }

  const handleTimelineDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    const rect = timelineRef.current?.getBoundingClientRect()
    if (
      rect
      && event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom
    ) {
      return
    }

    setDragOverMinutes(null)
    setDragOverLane(null)
    setDragPreview(null)
  }

  const handlePlaceDraft = async (minutes: number, lane: number): Promise<void> => {
    const currentDraft = placementDraft
    if (!currentDraft) return

    clearPlacement()

    if (currentDraft.source === 'planItem') {
      await schedulePlanItem(currentDraft.id, minutes, lane, currentDraft.durationMinutes)
      return
    }

    await scheduleTodo(currentDraft.id, minutes, lane, currentDraft.durationMinutes)
  }

  const handleTimelineDrop = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    setDragOverMinutes(null)
    setDragOverLane(null)
    setDragPreview(null)

    const dropMinutes = getDropMinutes(event.clientY)
    const dropLane = getDropLane(event.clientX)
    if (dropMinutes == null || dropLane == null) return

    const preview = readDragPreview(event)
    const planItemId = event.dataTransfer.getData('application/x-plan-item-id')
    if (planItemId) {
      await schedulePlanItem(planItemId, dropMinutes, dropLane, preview?.durationMinutes)
      return
    }

    const todoId = event.dataTransfer.getData('application/x-todo-id')
    if (todoId) {
      await scheduleTodo(todoId, dropMinutes, dropLane, preview?.durationMinutes)
    }
  }

  void onShiftItem

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(320px, 0.9fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(160px, 1.3fr) repeat(3, minmax(120px, 0.7fr))',
              gap: 10,
              background: '#111827',
              border: '1px solid #1f2937',
              borderRadius: 14,
              padding: 12
            }}
            >
              <div>
              <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>日付</div>
              <div style={{ marginTop: 6, fontSize: '1rem', color: '#f8fafc', fontWeight: 700 }}>{date}</div>
              <div style={{ marginTop: 4, fontSize: '0.76rem', color: '#94a3b8' }}>今日の時間割をまとめて調整できます</div>
            </div>
            <SummaryCard label="予定" value={`${timedCount}件`} detail="時間あり" tone="#60a5fa" />
            <SummaryCard label="未定" value={`${unscheduledItems.length}件`} detail="まだ時刻なし" tone="#fbbf24" />
            <SummaryCard label="合計" value={formatMinutes(totalPlannedMinutes)} detail="見積もり時間" tone="#4ade80" />
          </div>

          <Section
            title="時間割"
            subtitle="ドラッグで時間変更。下端ドラッグで長さ調整。候補や未割当はドラッグまたはクリック配置できます。"
          >
            {placementDraft && (
              <div
                style={{
                  marginBottom: 12,
                  background: '#172554',
                  border: '1px solid #2563eb',
                  borderRadius: 12,
                  padding: '10px 12px',
                  color: '#dbeafe',
                  fontSize: '0.8rem',
                  lineHeight: 1.6
                }}
              >
                <strong>{placementDraft.title}</strong> を配置中です。時間割の空いている場所をクリックすると置けます。`Esc` でキャンセルできます。
              </div>
            )}

            {LANE_COUNT > 1 && (
              <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 12, marginBottom: 10 }}>
                <div />
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${LANE_COUNT}, 1fr)`, gap: BLOCK_GAP }}>
                  <div style={laneHeaderStyle}>左</div>
                  <div style={laneHeaderStyle}>中央</div>
                  <div style={laneHeaderStyle}>右</div>
                </div>
              </div>
            )}

            <div
              ref={scrollContainerRef}
              style={{
                height: '70vh',
                overflowY: 'auto',
                borderRadius: 14,
                border: '1px solid #1f2937',
                background: '#0b1220'
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 12 }}>
                <div style={{ position: 'relative', height: TIMELINE_HEIGHT, borderRadius: 14, overflow: 'hidden' }}>
                  {Array.from({ length: TIMELINE_END_HOUR - TIMELINE_START_HOUR + 1 }, (_, index) => {
                    const hour = TIMELINE_START_HOUR + index
                    return (
                      <div
                        key={hour}
                        style={{
                          position: 'absolute',
                          top: index * HOUR_HEIGHT - 8,
                          left: 0,
                          right: 0,
                          textAlign: 'right',
                          fontSize: '0.72rem',
                          color: '#64748b'
                        }}
                      >
                        {String(hour).padStart(2, '0')}:00
                      </div>
                    )
                  })}
                </div>

                <div
                  ref={timelineRef}
                  onMouseMove={(event) => {
                    if (!placementDraft || interaction) return

                    const minutes = getDropMinutes(event.clientY)
                    const lane = getDropLane(event.clientX)
                    if (minutes == null || lane == null) {
                      setPlacementTarget(null)
                      return
                    }

                    setPlacementTarget({ minutes, lane })
                  }}
                  onMouseLeave={() => {
                    if (placementDraft) {
                      setPlacementTarget(null)
                    }
                  }}
                  onClick={(event) => {
                    if (!placementDraft) return
                    const target = event.target as HTMLElement
                    if (target.closest('[data-plan-block="true"]')) return

                    const minutes = getDropMinutes(event.clientY)
                    const lane = getDropLane(event.clientX)
                    if (minutes == null || lane == null) return

                    void handlePlaceDraft(minutes, lane)
                  }}
                  onDragOver={(event) => {
                    const types = Array.from(event.dataTransfer.types)
                    if (!types.includes('application/x-plan-item-id') && !types.includes('application/x-todo-id')) {
                      return
                    }
                    event.preventDefault()

                    const scrollContainer = scrollContainerRef.current
                    if (scrollContainer) {
                      const rect = scrollContainer.getBoundingClientRect()
                      if (event.clientY < rect.top + EDGE_SCROLL_THRESHOLD) {
                        scrollContainer.scrollTop -= EDGE_SCROLL_PIXELS
                      } else if (event.clientY > rect.bottom - EDGE_SCROLL_THRESHOLD) {
                        scrollContainer.scrollTop += EDGE_SCROLL_PIXELS
                      }
                    }

                    setDragOverMinutes(getDropMinutes(event.clientY))
                    setDragOverLane(getDropLane(event.clientX))
                    setDragPreview(readDragPreview(event))
                  }}
                  onDragLeave={handleTimelineDragLeave}
                  onDrop={(event) => void handleTimelineDrop(event)}
                  style={{ position: 'relative', height: TIMELINE_HEIGHT, cursor: placementDraft ? 'copy' : 'default' }}
                >
                  {Array.from({ length: TIMELINE_END_HOUR - TIMELINE_START_HOUR }, (_, index) => (
                    <div
                      key={TIMELINE_START_HOUR + index}
                      style={{
                        position: 'absolute',
                        top: index * HOUR_HEIGHT,
                        left: 0,
                        right: 0,
                        height: HOUR_HEIGHT,
                        borderTop: '1px solid #1f2937',
                        background: index % 2 === 0 ? '#0b1220' : '#0d1525'
                      }}
                    />
                  ))}

                  {Array.from({ length: (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 4 }, (_, index) => (
                    <div
                      key={`quarter-${index}`}
                      style={{
                        position: 'absolute',
                        top: index * SNAP_MINUTES * PIXELS_PER_MINUTE,
                        left: 0,
                        right: 0,
                        borderTop: index % 4 === 0 ? 'none' : '1px dashed #132033'
                      }}
                    />
                  ))}

                  {date === getTodayKey() && currentOffset >= 0 && currentOffset <= TIMELINE_TOTAL_MINUTES && (
                    <div
                      style={{
                        position: 'absolute',
                        top: currentOffset * PIXELS_PER_MINUTE,
                        left: 0,
                        right: 0,
                        borderTop: '2px solid #f97316',
                        zIndex: 3
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          top: -10,
                          left: 10,
                          fontSize: '0.68rem',
                          color: '#fed7aa',
                          background: '#7c2d12',
                          borderRadius: 999,
                          padding: '2px 8px'
                        }}
                      >
                        現在時刻
                      </span>
                    </div>
                  )}
                  {dragOverMinutes != null && (
                    <div
                      style={{
                        position: 'absolute',
                        top: dragOverMinutes * PIXELS_PER_MINUTE,
                        left: 0,
                        right: 0,
                        borderTop: '2px dashed #60a5fa',
                        zIndex: 4
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          top: -10,
                          left: 10,
                          fontSize: '0.68rem',
                          color: '#bfdbfe',
                          background: '#172554',
                          borderRadius: 999,
                          padding: '2px 8px'
                        }}
                      >
                        {offsetToClock(dragOverMinutes)}
                      </span>
                    </div>
                  )}

                  {dragOverLane != null && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        ...getLaneLayout(dragOverLane),
                        background: '#60a5fa12',
                        borderLeft: '1px dashed #60a5fa55',
                        borderRight: '1px dashed #60a5fa55',
                        zIndex: 1
                      }}
                    />
                  )}

                  {activePreview && previewTarget && (
                    (() => {
                      const previewHeight = activePreview.durationMinutes * PIXELS_PER_MINUTE
                      const compactPreview = previewHeight < COMPACT_BLOCK_THRESHOLD

                      return (
                        <div
                          style={{
                            position: 'absolute',
                            top: previewTarget.minutes * PIXELS_PER_MINUTE,
                            height: previewHeight,
                            minHeight: compactPreview ? 34 : 44,
                            ...getLaneLayout(previewTarget.lane),
                            background: '#2563eb22',
                            border: '1px dashed #60a5fa',
                            borderRadius: 12,
                            boxSizing: 'border-box',
                            padding: compactPreview ? '7px 10px' : '10px 10px 8px',
                            color: '#dbeafe',
                            zIndex: 4,
                            pointerEvents: 'none',
                            overflow: 'hidden'
                          }}
                        >
                          {compactPreview ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.74rem', fontWeight: 700 }}>
                              <span style={{ color: '#bfdbfe', whiteSpace: 'nowrap' }}>{offsetToClock(previewTarget.minutes)}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePreview.title}</span>
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.7rem', fontWeight: 700 }}>
                                <span>
                                  {offsetToClock(previewTarget.minutes)} - {offsetToClock(Math.min(previewTarget.minutes + activePreview.durationMinutes, TIMELINE_TOTAL_MINUTES))}
                                </span>
                                <span style={{ fontWeight: 500, color: '#bfdbfe' }}>{formatMinutes(activePreview.durationMinutes)}</span>
                              </div>
                              <div style={{ marginTop: 6, fontSize: '0.8rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {activePreview.title}
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })()
                  )}

                  {timelineBlocks.map((item) => {
                    const placement = columnMap.get(item.id) ?? { col: 0, cols: 1 }
                    const categoryColor = item.category_color ?? '#6366f1'
                    const dueLabel = formatDueLabel(item.due_date, date)
                    const blockHeight = item.durationMinutes * PIXELS_PER_MINUTE
                    const compactBlock = blockHeight < COMPACT_BLOCK_THRESHOLD

                    return (
                      <div
                        key={item.id}
                        data-plan-block="true"
                        style={{
                          position: 'absolute',
                          top: item.startMinutes * PIXELS_PER_MINUTE,
                          ...getColumnLayout(placement),
                          height: blockHeight,
                          minHeight: compactBlock ? 34 : 44,
                          background: `${categoryColor}20`,
                          border: `1px solid ${runningTodoId === item.todo_id ? '#22c55e' : `${categoryColor}70`}`,
                          borderRadius: 12,
                          boxSizing: 'border-box',
                          overflow: 'hidden',
                          zIndex: interaction?.itemId === item.id ? 5 : 2,
                          transition: interaction?.itemId === item.id ? 'none' : 'top 120ms ease, left 120ms ease, height 120ms ease, box-shadow 120ms ease',
                          boxShadow: interaction?.itemId === item.id ? '0 16px 32px rgba(15, 23, 42, 0.28)' : 'none'
                        }}
                        onDoubleClick={() => onSelectTodo(item.todo_id)}
                      >
                        <div
                          onPointerDown={(event) => {
                            if (event.button !== 0) return
                            beginInteraction('move', item, event.clientY)
                          }}
                          style={{
                            height: 'calc(100% - 10px)',
                            padding: compactBlock ? '7px 10px 6px' : '10px 10px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: compactBlock ? 4 : 6,
                            cursor: 'grab',
                            userSelect: 'none'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <span style={{ fontSize: '0.7rem', color: '#dbeafe', fontWeight: 700, whiteSpace: 'nowrap' }}>
                              {offsetToClock(item.startMinutes)} - {offsetToClock(item.endMinutes)}
                            </span>
                            {!compactBlock && item.status === 'done' && (
                              <span style={{ fontSize: '0.62rem', color: '#86efac', background: '#052e16', borderRadius: 999, padding: '1px 6px' }}>
                                完了
                              </span>
                            )}
                            {!compactBlock && runningTodoId === item.todo_id && (
                              <span style={{ fontSize: '0.62rem', color: '#86efac', background: '#052e16', borderRadius: 999, padding: '1px 6px' }}>
                                計測中
                              </span>
                            )}
                            {!compactBlock && <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => {
                                  const nextItems = planItems.map((planItem) => {
                                    if (planItem.id !== item.id) return planItem
                                    return { ...planItem, scheduled_start: null }
                                  })
                                  void onUpdateItem(item.id, { scheduled_start: null }).then(() => onReorder(reorderIdsByTime(nextItems)))
                                }}
                                style={miniActionBtn('#1e293b', '#cbd5e1')}
                                title="未定に戻す"
                              >
                                未定
                              </button>
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => void onRemoveItem(item.id)}
                                style={miniActionBtn('#3f1d1d', '#fca5a5')}
                                title="今日の計画から外す"
                              >
                                外す
                              </button>
                            </div>}
                          </div>

                          <button
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => onSelectTodo(item.todo_id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              color: '#f8fafc',
                              cursor: 'pointer',
                              fontSize: '0.84rem',
                              fontWeight: 700,
                              textAlign: 'left',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {item.title}
                          </button>

                          {!compactBlock && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.68rem', color: '#cbd5e1' }}>
                              {item.category_name && <span>{item.category_name}</span>}
                              <span>{dueLabel}</span>
                              <span>{formatMinutes(item.durationMinutes)}</span>
                            </div>
                          )}
                        </div>

                        <div
                          onPointerDown={(event) => {
                            if (event.button !== 0) return
                            event.stopPropagation()
                            beginInteraction('resize', item, event.clientY)
                          }}
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: 10,
                            cursor: 'ns-resize',
                            background: `${categoryColor}55`
                          }}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </Section>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Section title="未割当の今日タスク" subtitle="まだ時刻を決めていないタスクです。ドラッグまたはクリック配置できます。">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {unscheduledItems.length === 0 ? (
                <EmptyState label="未割当のタスクはありません。候補やバックログから追加して時間を決めてください。" />
              ) : (
                unscheduledItems.map((item) => (
                  <UnscheduledCard
                    key={item.id}
                    item={item}
                    todayKey={date}
                    onSelect={onSelectTodo}
                    onRemove={onRemoveItem}
                    onSchedule={(draft) => {
                      setPlacementDraft(draft)
                      setPlacementTarget(null)
                    }}
                    onPrepareDrag={clearPlacement}
                    placementActive={placementDraft?.source === 'planItem' && placementDraft.id === item.id}
                  />
                ))
              )}
            </div>
          </Section>

          <Section title="候補" subtitle="おすすめのタスクをそのまま時間割へ置けます。">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {suggestions.length === 0 ? (
                <EmptyState label="おすすめ候補はありません。バックログから今日の計画に入れてください。" />
              ) : (
                suggestions.map((group) => (
                  <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 700 }}>{group.title}</div>
                    {group.items.map((todo) => (
                      <CandidateCard
                        key={`${group.title}-${todo.id}`}
                        todo={todo}
                        todayKey={date}
                        onAdd={async (todoId) => { await onAddTodo(todoId) }}
                        onSchedule={(draft) => {
                          setPlacementDraft(draft)
                          setPlacementTarget(null)
                        }}
                        onPrepareDrag={clearPlacement}
                        placementActive={placementDraft?.source === 'todo' && placementDraft.id === todo.id}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section title="未計画タスク" subtitle={`${availableTodos.length}件のアクティブタスクから検索できます。`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="追加したいタスクを検索..."
                style={inputStyle}
              />
              {filteredBacklog.length === 0 ? (
                <EmptyState label={searchQuery ? '検索条件に合うタスクはありません。' : 'アクティブなタスクはありません。'} />
              ) : (
                filteredBacklog.map((todo) => (
                  <CandidateCard
                    key={todo.id}
                    todo={todo}
                    todayKey={date}
                    onAdd={async (todoId) => { await onAddTodo(todoId) }}
                    onSchedule={(draft) => {
                      setPlacementDraft(draft)
                      setPlacementTarget(null)
                    }}
                    onPrepareDrag={clearPlacement}
                    placementActive={placementDraft?.source === 'todo' && placementDraft.id === todo.id}
                  />
                ))
              )}
            </div>
          </Section>

          <Section title="使い方" subtitle="配置と移動をすばやく行うためのヒントです。">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, color: '#94a3b8', fontSize: '0.8rem', lineHeight: 1.6 }}>
              <div>候補や未割当のカードは、ドラッグして時間割へ落とすか、「時間に置く」を押してから空き時間をクリックすると配置できます。</div>
              <div>時間割のブロックは、ドラッグで開始時刻、下端ドラッグで長さを調整できます。</div>
              <div>時刻ラベルと時間割は同じスクロール領域なので、上下に動かしてもズレません。</div>
              <div>`Esc` を押すとクリック配置モードをキャンセルできます。</div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
