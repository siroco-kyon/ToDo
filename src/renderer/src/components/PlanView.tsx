import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AddDailyPlanItemOptions, DailyPlanItem, Todo, UpdateDailyPlanItemInput } from '../types'
import { checklistBadgeText, hasRemainingToday, type ChecklistSummary } from '../lib/todoList'
import { dataInk } from '../lib/theme'

// 優先度の表記（ほかの画面の「低・中・高」とそろえる）
const PRIORITY_LABELS: Record<number, string> = { 1: '最低', 2: '低', 3: '中', 4: '高', 5: '最高' }

interface Props {
  date: string
  planItems: DailyPlanItem[]
  todos: Todo[]
  runningTodoId: string | null
  onSelectTodo: (id: string) => void
  onAddTodo: (todoId: string, options?: AddDailyPlanItemOptions) => Promise<DailyPlanItem>
  onRemoveItem: (id: string) => Promise<void>
  /** 知らせを出す（予定を外したときに「元に戻す」を付ける） */
  onShowToast?: (message: string, type?: 'success' | 'error', action?: { label: string; run: () => void }) => void
  onUpdateItem: (id: string, data: UpdateDailyPlanItemInput) => Promise<void>
  onShiftItem: (id: string, deltaMinutes: number) => Promise<void>
  onShiftFollowing?: (id: string, deltaMinutes: number) => Promise<void>
  onReorder: (orderedIds: string[]) => Promise<void>
  onDateChange?: (date: string) => void
  onCarryOver?: () => Promise<void>
  /** タスク一覧の絞り込みの表示（候補のタスクに効く）。日付の操作の横に出す */
  listFilters?: React.ReactNode
  /** ToDoリストの項目の進み具合。今日の分が残っているリストを候補に出す（ToDoリストを使う人だけ） */
  checklistSummaries?: Map<string, ChecklistSummary>
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
/** これより狭いブロックは、操作ボタンを「⋯」にまとめる（1行に収まらずタスク名を隠すため） */
const NARROW_BLOCK_WIDTH = 400
/** 補足の行まで出せるブロックの高さ（文字の大きさ 100% のとき） */
const META_BLOCK_THRESHOLD = 84
const EDGE_SCROLL_THRESHOLD = 72
const EDGE_SCROLL_PIXELS = 24
const AUTO_SCROLL_LEAD_MINUTES = 60
/** 今日以外の計画を開いたときに見せ始める時刻（始業のころ） */
const WORKDAY_START_HOUR = 8

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function shiftDateKey(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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
  const isToday = todayKey === getTodayKey()
  const diffDays = diffCalendarDays(dueDate, todayKey)
  if (diffDays < 0) return `${Math.abs(diffDays)}日超過`
  if (diffDays === 0) return isToday ? '今日が期限' : 'この日が期限'
  if (diffDays === 1) return isToday ? '明日が期限' : '翌日が期限'
  return `あと${diffDays}日`
}

/** 「今日に入れる」のボタンの文言。今日以外の計画では「この日に入れる」 */
function addToDayLabel(dateKey: string): string {
  return dateKey === getTodayKey() ? '今日に入れる' : 'この日に入れる'
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

/** "HH:MM" を時間割の先頭からの分に。範囲外・読めないときは null */
function clockToOffset(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(clock)
  if (!match) return null
  const offset = Number(match[1]) * 60 + Number(match[2]) - TIMELINE_START_HOUR * 60
  if (offset < 0 || offset >= (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60) return null
  return offset
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
    <div title={detail} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>{label}</span>
      <span style={{ fontSize: '0.95rem', color: tone, fontWeight: 700, whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ fontSize: '0.7rem', color: 'var(--slate-400)' }}>{detail}</span>
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
        background: 'var(--gray-900)',
        border: '1px solid var(--gray-800)',
        borderRadius: 16,
        padding: 16,
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.95rem', color: 'var(--slate-50)', fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: '0.76rem', color: 'var(--text-subtle)' }}>{subtitle}</div>}
      </div>
      {children}
    </section>
  )
}

function EmptyState({ label }: { label: string }): React.JSX.Element {
  return <div style={{ color: 'var(--text-subtle)', fontSize: '0.82rem', padding: '4px 2px', lineHeight: 1.6 }}>{label}</div>
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 8,
  color: 'var(--slate-200)',
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
    lineHeight: 1.2,
    whiteSpace: 'nowrap'
  }
}

const laneHeaderStyle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: '0.74rem',
  color: 'var(--slate-400)',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-800)',
  borderRadius: 10,
  padding: '6px 8px',
  fontWeight: 700
}

function CandidateCard({
  todo,
  todayKey,
  plannedCount = 0,
  onAdd,
  onSchedule,
  onPrepareDrag,
  placementActive,
  note
}: {
  todo: Todo
  todayKey: string
  /** タスク名の下に添える一言（ToDoリストの残りなど） */
  note?: string
  plannedCount?: number
  onAdd: (todoId: string) => Promise<void>
  onSchedule: (draft: PlacementDraft) => void
  onPrepareDrag: () => void
  placementActive: boolean
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const addingRef = useRef(false)
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
        background: 'var(--slate-900)',
        border: placementActive ? '1px solid var(--blue-500)' : '1px solid var(--slate-800)',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        cursor: 'grab',
        boxShadow: placementActive ? '0 0 0 1px var(--blue-700) inset' : 'none'
      }}
      title="ドラッグで時間割へ置けます。クリックで置くときは「時間に置く」を押してください。"
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.86rem', color: 'var(--slate-200)', fontWeight: 600, lineHeight: 1.4 }}>{todo.title}</div>
        {note && <div style={{ fontSize: '0.7rem', color: 'var(--indigo-300)', marginTop: 3 }}>{note}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {todo.category_name && (
            <span
              style={{
                fontSize: '0.68rem',
                color: dataInk(todo.category_color ?? 'var(--indigo-300)'),
                background: `color-mix(in srgb, ${todo.category_color ?? 'var(--indigo-500)'} 12.5%, transparent)`,
                borderRadius: 999,
                padding: '2px 8px'
              }}
            >
              {todo.category_name}
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: 'var(--slate-300)' }}>{formatDueLabel(todo.due_date, todayKey)}</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--amber-400)' }}>優先度 {PRIORITY_LABELS[todo.priority] ?? todo.priority}</span>
          {plannedCount > 0 && (
            <span style={{ fontSize: '0.68rem', color: 'var(--blue-300)', background: 'color-mix(in srgb, var(--blue-900) 25.1%, transparent)', borderRadius: 999, padding: '2px 8px' }}>
              配置済み ×{plannedCount}
            </span>
          )}
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
          style={actionBtn(placementActive ? 'var(--blue-700)' : 'var(--slate-800)', 'var(--blue-100)', placementActive ? 'var(--blue-400)' : 'var(--slate-700)')}
          aria-label={placementActive ? `「${todo.title}」を置く時刻を選んでいます` : `「${todo.title}」を時間割に置く`}
        >
          {placementActive ? '配置中' : '時間に置く'}
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation()
            if (addingRef.current) return
            addingRef.current = true
            setAdding(true)
            void onAdd(todo.id).finally(() => { addingRef.current = false; setAdding(false) })
          }}
          disabled={adding}
          style={actionBtn('var(--blue-950)', 'var(--blue-200)', 'var(--blue-600)')}
          aria-label={`「${todo.title}」を${todayKey === getTodayKey() ? '今日' : 'この日'}の計画に入れる`}
        >
          {adding ? '追加中…' : addToDayLabel(todayKey)}
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
      data-plan-unscheduled-id={item.id}
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
        background: 'var(--slate-900)',
        border: placementActive ? '1px solid var(--blue-500)' : '1px dashed var(--slate-700)',
        borderRadius: 12,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        cursor: 'grab',
        boxShadow: placementActive ? '0 0 0 1px var(--blue-700) inset' : 'none'
      }}
      title="ドラッグかクリックで時間割に置けます。"
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          onClick={() => onSelect(item.todo_id)}
          style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.86rem', fontWeight: 600, textAlign: 'left', lineHeight: 1.4 }}
        >
          {item.status === 'on_hold' && <span style={{ color: 'var(--purple-300)' }}>保留中 · </span>}{item.title}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {item.category_name && (
            <span
              style={{
                fontSize: '0.68rem',
                color: dataInk(item.category_color ?? 'var(--indigo-300)'),
                background: `color-mix(in srgb, ${item.category_color ?? 'var(--indigo-500)'} 12.5%, transparent)`,
                borderRadius: 999,
                padding: '2px 8px'
              }}
            >
              {item.category_name}
            </span>
          )}
          <span style={{ fontSize: '0.72rem', color: 'var(--slate-300)' }}>{formatDueLabel(item.due_date, todayKey)}</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--slate-400)' }}>{formatMinutes(normalizeDuration(item.estimated_minutes))}</span>
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
          style={actionBtn(placementActive ? 'var(--blue-700)' : 'var(--slate-800)', 'var(--blue-100)', placementActive ? 'var(--blue-400)' : 'var(--slate-700)')}
          aria-label={placementActive ? `「${item.title}」を置く時刻を選んでいます` : `「${item.title}」を時間割に置く`}
        >
          {placementActive ? '配置中' : '時間に置く'}
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation()
            void onRemove(item.id)
          }}
          style={actionBtn('var(--slate-800)', 'var(--slate-300)', 'var(--slate-700)')}
          title="今日の計画から外す（タスクは消えません）"
          aria-label={`「${item.title}」を計画から外す（タスクは消えません）`}
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
  onShowToast,
  onUpdateItem,
  onShiftItem,
  onShiftFollowing,
  onReorder,
  onDateChange,
  onCarryOver,
  listFilters,
  checklistSummaries
}: Props): React.JSX.Element {
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const actionPendingRef = useRef(false)
  const reportActionError = useCallback((error: unknown): void => {
    setActionError(error instanceof Error ? error.message : '計画を変更できませんでした')
  }, [])
  const runAction = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setActionPending(true)
    try { await action(); setActionError(null) } catch (error) { reportActionError(error) }
    finally { actionPendingRef.current = false; setActionPending(false) }
  }, [reportActionError])
  useEffect(() => setActionError(null), [date])
  // 時刻未定で追加したら、そのことを知らせ、次にすること（時刻を決める）のボタンへフォーカスを移す。
  // 押したボタンは候補から消えることがあり、そのままだとフォーカスが迷子になる
  const [addedNotice, setAddedNotice] = useState<string | null>(null)
  const [focusUnscheduledId, setFocusUnscheduledId] = useState<string | null>(null)
  useEffect(() => {
    if (!addedNotice) return
    const timer = window.setTimeout(() => setAddedNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [addedNotice])
  useEffect(() => {
    if (!focusUnscheduledId) return
    const button = document.querySelector<HTMLElement>(`[data-plan-unscheduled-id="${CSS.escape(focusUnscheduledId)}"] button[aria-label$="を時間割に置く"]`)
    if (button) {
      button.focus()
      button.scrollIntoView({ block: 'nearest' })
      setFocusUnscheduledId(null)
    }
  }, [focusUnscheduledId, planItems])
  // 時刻を決めて置いたら、置いた予定（時間割のブロック）のタスク名へフォーカスを移す
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusBlockId) return
    const button = document.querySelector<HTMLElement>(`[data-plan-block-id="${CSS.escape(focusBlockId)}"] button[data-plan-block-title]`)
    if (button) {
      button.focus({ preventScroll: true })
      button.scrollIntoView({ block: 'nearest' })
      setFocusBlockId(null)
    }
  }, [focusBlockId, planItems])
  const addUnscheduled = useCallback(async (todoId: string): Promise<void> => {
    await runAction(async () => {
      const created = await onAddTodo(todoId)
      setAddedNotice(`「${created.title ?? ''}」を時刻未定に追加しました。「時間に置く」で時刻を決められます。`)
      setFocusUnscheduledId(created.id)
    })
  }, [onAddTodo, runAction])
  const timelineRef = useRef<HTMLDivElement>(null)
  // ブロックが狭いと、操作ボタンが2段になってタスク名が隠れる。狭いブロックでは −15・+15 以外を「⋯」にまとめる
  const [timelineWidth, setTimelineWidth] = useState(0)
  // 文字の大きさの設定（ルートの文字の px / 16）。ブロックの中身を詰める基準に使う
  const [textScale, setTextScale] = useState(1)
  const [openMenuItemId, setOpenMenuItemId] = useState<string | null>(null)
  // メニューの外を押したら閉じる（details は外を押しても閉じないため）
  useEffect(() => {
    if (!openMenuItemId) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      document.querySelectorAll<HTMLDetailsElement>('details.hakobi-plan-block-menu[open]').forEach((details) => {
        if (!target || !details.contains(target)) details.open = false
      })
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [openMenuItemId])
  useEffect(() => {
    const element = timelineRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      setTimelineWidth(entry.contentRect.width)
      setTextScale(Math.max(1, (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<InteractionState | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [dragOverMinutes, setDragOverMinutes] = useState<number | null>(null)
  const [dragOverLane, setDragOverLane] = useState<number | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [placementDraft, setPlacementDraft] = useState<PlacementDraft | null>(null)
  // 配置中に出す時刻の欄。始めたときに、今日なら次の15分区切り、ほかの日は 9:00 を入れてフォーカスする
  const [placementTime, setPlacementTime] = useState('09:00')
  const placementTimeInputRef = useRef<HTMLInputElement>(null)
  const placementKey = placementDraft ? `${placementDraft.source}:${placementDraft.id}` : null
  // 置き終わった・やめたときに戻すフォーカスの先（「時間に置く」のボタン。消えていれば時間割）
  const placementReturnRef = useRef<HTMLElement | null>(null)
  const previousPlacementKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const wasPlacing = previousPlacementKeyRef.current != null
    previousPlacementKeyRef.current = placementKey
    if (placementKey || !wasPlacing) return
    const active = document.activeElement
    if (active && active !== document.body && !active.hasAttribute('data-focus-region')) return
    const target = placementReturnRef.current?.isConnected ? placementReturnRef.current : timelineRef.current
    placementReturnRef.current = null
    target?.focus({ preventScroll: true })
  }, [placementKey])
  useEffect(() => {
    if (!placementKey) return
    if (document.activeElement instanceof HTMLElement && document.activeElement !== placementTimeInputRef.current) placementReturnRef.current = document.activeElement
    const start = date === getTodayKey()
      ? clamp(Math.ceil(nowOffsetMinutes() / SNAP_MINUTES) * SNAP_MINUTES, 0, (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60 - SNAP_MINUTES)
      : clamp((9 - TIMELINE_START_HOUR) * 60, 0, (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60 - SNAP_MINUTES)
    setPlacementTime(offsetToClock(start))
    placementTimeInputRef.current?.focus()
  }, [placementKey, date])
  const [placementTarget, setPlacementTarget] = useState<PlacementTarget | null>(null)
  const [interaction, setInteraction] = useState<InteractionState | null>(null)

  interactionRef.current = interaction

  // 同じタスクを複数回置けるので、配置済みかどうかではなく「何個置いたか」を持つ
  const plannedCountByTodoId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of planItems) counts.set(item.todo_id, (counts.get(item.todo_id) ?? 0) + 1)
    return counts
  }, [planItems])

  const availableTodos = useMemo(() => (
    todos
      .filter((todo) => todo.status !== 'done' && todo.status !== 'archived' && todo.status !== 'on_hold')
      .sort((a, b) => {
        // 未配置のタスクを先に出しつつ、配置済みも再配置できるよう一覧には残す
        const aPlanned = (plannedCountByTodoId.get(a.id) ?? 0) > 0 ? 1 : 0
        const bPlanned = (plannedCountByTodoId.get(b.id) ?? 0) > 0 ? 1 : 0
        if (aPlanned !== bPlanned) return aPlanned - bPlanned
        if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date)
        if (a.due_date && !b.due_date) return -1
        if (!a.due_date && b.due_date) return 1
        if (b.priority !== a.priority) return b.priority - a.priority
        return a.title.localeCompare(b.title, 'ja')
      })
  ), [plannedCountByTodoId, todos])

  // おすすめ候補は「次に何を計画するか」の提案なので、まだ置いていないタスクだけを対象にする
  const unplannedTodos = useMemo(
    () => availableTodos.filter((todo) => (plannedCountByTodoId.get(todo.id) ?? 0) === 0),
    [availableTodos, plannedCountByTodoId]
  )

  const suggestions = useMemo(() => {
    const staleLimit = Date.now() - 7 * 86400000
    const todayListTodos = unplannedTodos.filter((todo) => {
      const summary = todo.list_mode ? checklistSummaries?.get(todo.id) : undefined
      return summary != null && hasRemainingToday(summary)
    })
    const groups: SuggestedGroup[] = [
      // ToDoリストは今日の計画の日だけ。ほかの日の計画では出さない
      ...(date === getTodayKey() && todayListTodos.length > 0
        ? [{ title: 'ToDoリスト（今日の分が残っている）', items: todayListTodos.slice(0, 4) }]
        : []),
      { title: '期限が今日', items: unplannedTodos.filter((todo) => todo.due_date === date).slice(0, 4) },
      {
        title: '期限が近い',
        items: unplannedTodos
          .filter((todo) => todo.due_date && todo.due_date !== date && diffCalendarDays(todo.due_date, date) > 0 && diffCalendarDays(todo.due_date, date) <= 3)
          .slice(0, 4)
      },
      { title: '優先度が高い', items: unplannedTodos.filter((todo) => todo.priority >= 4).slice(0, 4) },
      { title: 'しばらく触っていない', items: unplannedTodos.filter((todo) => new Date(todo.updated_at).getTime() <= staleLimit).slice(0, 4) }
    ]

    return groups.filter((group) => group.items.length > 0)
  }, [checklistSummaries, date, unplannedTodos])

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

    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    const earliestScheduled = planItems
      .filter((item) => item.scheduled_start)
      .map((item) => clockToMinutes(item.scheduled_start!) - TIMELINE_START_HOUR * 60)
      .sort((a, b) => a - b)[0]
    const otherDayStart = Math.min(earliestScheduled ?? Number.POSITIVE_INFINITY, WORKDAY_START_HOUR * 60 - TIMELINE_START_HOUR * 60) - 30

    const applyScroll = (): void => {
      const startOffset = date === todayKey
        ? clamp(nowOffsetMinutes() - AUTO_SCROLL_LEAD_MINUTES, 0, TIMELINE_TOTAL_MINUTES)
        : clamp(otherDayStart, 0, TIMELINE_TOTAL_MINUTES)
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

      void runAction(() => onUpdateItem(current.itemId, {
        scheduled_start: offsetToClock(current.previewStart),
        estimated_minutes: current.previewDuration,
        lane: current.previewLane
      }).then(() => onReorder(reorderIdsByTime(nextItems))))
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [interaction, onReorder, onUpdateItem, planItems, runAction])

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

  const scheduleTodo = async (todoId: string, startMinutes: number, lane: number, durationMinutes?: number): Promise<string> => {
    const normalizedDuration = normalizeDuration(durationMinutes)
    // 作成と配置を1回で行う（未配置の重複行が途中で残らないようにする）
    const created = await onAddTodo(todoId, {
      allowDuplicate: true,
      scheduled_start: offsetToClock(startMinutes),
      estimated_minutes: normalizedDuration,
      lane
    })

    await onReorder(reorderIdsByTime([...planItems, created]))
    return created.id
  }

  const duplicateBlock = async (block: TimelineBlock): Promise<void> => {
    // 直後の時間帯に同じ長さでコピーする（末尾を越える場合は収まる位置まで戻す）
    const startMinutes = clamp(block.endMinutes, 0, TIMELINE_TOTAL_MINUTES - block.durationMinutes)
    const created = await onAddTodo(block.todo_id, {
      allowDuplicate: true,
      scheduled_start: offsetToClock(startMinutes),
      estimated_minutes: block.durationMinutes,
      lane: block.lane
    })

    await onReorder(reorderIdsByTime([...planItems, created]))
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

    // 置けたあとで配置をやめる（失敗したときに、選んだ時刻の欄が消えてやり直しにならないように）
    if (currentDraft.source === 'planItem') {
      await schedulePlanItem(currentDraft.id, minutes, lane, currentDraft.durationMinutes)
      clearPlacement()
      setFocusBlockId(currentDraft.id)
      return
    }

    const createdId = await scheduleTodo(currentDraft.id, minutes, lane, currentDraft.durationMinutes)
    clearPlacement()
    setFocusBlockId(createdId)
  }

  // 予定を外す。タスクは消えないが、時刻と長さは消えるので、知らせから同じ時刻・長さで戻せるようにする。
  // 外したボタンは消えるので、フォーカスは時間割へ移す（区分けの先頭へ飛ばないように）
  const removeItemWithUndo = async (item: DailyPlanItem): Promise<void> => {
    // 時刻が未定のカードから外したときは、隣のカードの「時間に置く」へフォーカスを移す（なければ時間割へ）
    const card = item.scheduled_start ? null : document.querySelector<HTMLElement>(`[data-plan-unscheduled-id="${CSS.escape(item.id)}"]`)
    const neighbor = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null | undefined
    const neighborButton = neighbor?.querySelector<HTMLElement>('button[aria-label$="を時間割に置く"]') ?? null
    await onRemoveItem(item.id)
    if (neighborButton?.isConnected) neighborButton.focus({ preventScroll: true })
    else timelineRef.current?.focus({ preventScroll: true })
    onShowToast?.(`「${item.title}」を計画から外しました（タスクは消えません）`, 'success', {
      label: '元に戻す',
      run: () => {
        void onAddTodo(item.todo_id, {
          allowDuplicate: true,
          scheduled_start: item.scheduled_start ?? undefined,
          estimated_minutes: item.estimated_minutes ?? undefined,
          lane: item.lane ?? undefined
        }).then(
          () => onShowToast?.(`「${item.title}」を計画に戻しました`),
          (error: unknown) => onShowToast?.(error instanceof Error ? error.message : '計画に戻せませんでした', 'error')
        )
      }
    })
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

  return (
    <div aria-busy={actionPending} style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      {actionPending && <div role="status" style={{ position: 'sticky', top: 0, zIndex: 11, padding: 10, background: 'var(--slate-800)', color: 'var(--slate-100)', borderRadius: 8, marginBottom: 10 }}>計画を更新中…</div>}
      {actionError && <div role="alert" style={{ position: 'sticky', top: 0, zIndex: 10, marginBottom: 12, padding: 12, borderRadius: 10, border: '1px solid var(--red-500)', background: 'var(--slate-900)', color: 'var(--slate-100)' }}>
        <p>計画の操作を完了できませんでした。{actionError}</p>
        <p style={{ marginTop: 6, fontSize: 'var(--font-control)' }}>社内LANへの接続と表示中の予定を確認し、同じ操作をもう一度お試しください。</p>
        <button onClick={() => setActionError(null)} style={{ ...miniActionBtn('var(--slate-800)', 'var(--slate-200)'), marginTop: 8 }}>閉じる</button>
      </div>}
      {onDateChange && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => onDateChange(shiftDateKey(date, -1))} style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}>← 前日</button>
          <input type="date" aria-label="計画の日付" disabled={actionPending} value={date} onChange={(event) => { if (event.target.value) onDateChange(event.target.value) }} style={{ padding: '7px 9px', borderRadius: 7, border: '1px solid var(--slate-700)', background: 'var(--slate-900)', color: 'var(--slate-200)' }} />
          <button onClick={() => onDateChange(shiftDateKey(date, 1))} style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}>翌日 →</button>
          <button onClick={() => onDateChange(getTodayKey())} style={miniActionBtn('var(--blue-950)', 'var(--blue-100)')}>今日</button>
          {onCarryOver && <button onClick={() => void runAction(onCarryOver)} style={miniActionBtn('var(--green-900)', 'var(--green-100)')}>前日の未完了を繰り越す</button>}
          {listFilters && <span style={{ marginLeft: 'auto' }}>{listFilters}</span>}
        </div>
      )}
      {/* 2列（時間割と候補）。狭いときは候補を時間割の下へ回す（時間割が細くならないように） */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '1.5 1 400px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {/* 日付と件数は1行にまとめる（時間割を上に寄せる） */}
            <div
              title="今日の時間割をまとめて調整できます"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                gap: '6px 18px',
              background: 'var(--gray-900)',
              border: '1px solid var(--gray-800)',
              borderRadius: 12,
              padding: '8px 14px'
            }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-subtle)' }}>日付</span>
              <span style={{ fontSize: '0.95rem', color: 'var(--slate-50)', fontWeight: 700 }}>{date}</span>
            </div>
            <SummaryCard label="予定" value={`${timedCount}件`} detail="時間あり" tone="var(--blue-400)" />
            <SummaryCard label="未定" value={`${unscheduledItems.length}件`} detail="まだ時刻なし" tone="var(--amber-400)" />
            <SummaryCard label="合計" value={formatMinutes(totalPlannedMinutes)} detail="見積もり時間" tone="var(--green-400)" />
          </div>

          <Section
            title="時間割"
            subtitle="ドラッグで時刻、下端のドラッグで長さを変えられます。候補や時刻が未定のタスクは、ドラッグかクリックで置けます。"
          >
            {placementDraft && (
              <div
                style={{
                  marginBottom: 12,
                  background: 'var(--blue-950)',
                  border: '1px solid var(--blue-600)',
                  borderRadius: 12,
                  padding: '10px 12px',
                  color: 'var(--blue-100)',
                  fontSize: '0.8rem',
                  lineHeight: 1.6
                }}
              >
                <div><strong>{placementDraft.title}</strong> を配置中です。時間割の空いている場所をクリックするか、時刻を選んで「この時刻に置く」を押します。Esc でキャンセルできます。</div>
                {/* キーボードでも置けるように、時刻の欄を出す（↑↓ で15分ずつ。Enter で置く） */}
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const minutes = clockToOffset(placementTime)
                    if (minutes == null) return
                    void runAction(() => handlePlaceDraft(minutes, 0))
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}
                >
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    時刻
                    <input
                      ref={placementTimeInputRef}
                      type="time"
                      step={SNAP_MINUTES * 60}
                      required
                      value={placementTime}
                      onChange={(event) => setPlacementTime(event.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--blue-600)', background: 'var(--slate-900)', color: 'var(--slate-100)', fontSize: '0.8rem' }}
                    />
                  </label>
                  <button type="submit" style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--blue-600)', background: 'var(--blue-700)', color: 'var(--on-fill-blue-50)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700 }}>
                    この時刻に置く
                  </button>
                  <button type="button" onClick={clearPlacement} style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--slate-600)', background: 'transparent', color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.78rem' }}>
                    やめる
                  </button>
                </form>
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
                border: '1px solid var(--gray-800)',
                background: 'var(--c-0b1220)'
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
                          color: 'var(--text-subtle)'
                        }}
                      >
                        {String(hour).padStart(2, '0')}:00
                      </div>
                    )
                  })}
                </div>

                <div
                  ref={timelineRef}
                  role="group"
                  tabIndex={-1}
                  aria-label="計画の時間割"
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

                    void runAction(() => handlePlaceDraft(minutes, lane))
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
                  onDrop={(event) => void runAction(() => handleTimelineDrop(event))}
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
                        borderTop: '1px solid var(--gray-800)',
                        background: index % 2 === 0 ? 'var(--c-0b1220)' : 'var(--c-0d1525)'
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
                        borderTop: index % 4 === 0 ? 'none' : '1px dashed var(--c-132033)'
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
                        borderTop: '2px solid var(--orange-500)',
                        zIndex: 3
                      }}
                    >
                      {/* 印は時刻の列（左の余白）に出す。時間割の中に出すと、予定のタスク名や時刻を隠してしまう */}
                      <span
                        title="現在時刻"
                        style={{
                          position: 'absolute',
                          top: '-0.7em',
                          right: 'calc(100% + 4px)',
                          fontSize: '0.68rem',
                          lineHeight: 1.2,
                          whiteSpace: 'nowrap',
                          color: 'var(--orange-200)',
                          background: 'var(--orange-900)',
                          borderRadius: 999,
                          padding: '1px 6px'
                        }}
                      >
                        今
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
                        borderTop: '2px dashed var(--blue-400)',
                        zIndex: 4
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          top: -10,
                          left: 10,
                          fontSize: '0.68rem',
                          color: 'var(--blue-200)',
                          background: 'var(--blue-950)',
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
                        background: 'color-mix(in srgb, var(--blue-400) 7.1%, transparent)',
                        borderLeft: '1px dashed color-mix(in srgb, var(--blue-400) 33.3%, transparent)',
                        borderRight: '1px dashed color-mix(in srgb, var(--blue-400) 33.3%, transparent)',
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
                            background: 'color-mix(in srgb, var(--blue-600) 13.3%, transparent)',
                            border: '1px dashed var(--blue-400)',
                            borderRadius: 12,
                            boxSizing: 'border-box',
                            padding: compactPreview ? '7px 10px' : '10px 10px 8px',
                            color: 'var(--blue-100)',
                            zIndex: 4,
                            pointerEvents: 'none',
                            overflow: 'hidden'
                          }}
                        >
                          {compactPreview ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.74rem', fontWeight: 700 }}>
                              <span style={{ color: 'var(--blue-200)', whiteSpace: 'nowrap' }}>{offsetToClock(previewTarget.minutes)}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePreview.title}</span>
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.7rem', fontWeight: 700 }}>
                                <span>
                                  {offsetToClock(previewTarget.minutes)} - {offsetToClock(Math.min(previewTarget.minutes + activePreview.durationMinutes, TIMELINE_TOTAL_MINUTES))}
                                </span>
                                <span style={{ fontWeight: 500, color: 'var(--blue-200)' }}>{formatMinutes(activePreview.durationMinutes)}</span>
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
                    const categoryColor = item.category_color ?? 'var(--indigo-500)'
                    const dueLabel = formatDueLabel(item.due_date, date)
                    const blockHeight = item.durationMinutes * PIXELS_PER_MINUTE
                    // 時間割の高さは文字の大きさによらず同じなので、文字を大きくしているときは早めに詰める
                    const compactBlock = blockHeight < COMPACT_BLOCK_THRESHOLD * textScale
                    const blockWidth = (timelineWidth - BLOCK_GAP * (placement.cols - 1)) / Math.max(1, placement.cols)
                    const narrowBlocks = timelineWidth > 0 && blockWidth < NARROW_BLOCK_WIDTH * textScale
                    // 補足の行（カテゴリ・期限・長さ）は、時刻の行とタスク名の下に収まるときだけ出す
                    const showBlockMeta = !compactBlock && blockHeight >= META_BLOCK_THRESHOLD * textScale

                    return (
                      <div
                        key={item.id}
                        data-plan-block="true"
                        data-plan-block-id={item.id}
                        style={{
                          position: 'absolute',
                          top: item.startMinutes * PIXELS_PER_MINUTE,
                          ...getColumnLayout(placement),
                          height: blockHeight,
                          minHeight: compactBlock ? 34 : 44,
                          background: `color-mix(in srgb, ${categoryColor} 12.5%, transparent)`,
                          border: `1px solid ${runningTodoId === item.todo_id ? 'var(--green-500)' : `color-mix(in srgb, ${categoryColor} 43.9%, transparent)`}`,
                          borderRadius: 12,
                          boxSizing: 'border-box',
                          // 「⋯」のメニューを開いている間は、ブロックの外へはみ出して出す
                          overflow: openMenuItemId === item.id ? 'visible' : 'hidden',
                          zIndex: interaction?.itemId === item.id || openMenuItemId === item.id ? 5 : 2,
                          transition: interaction?.itemId === item.id ? 'none' : 'top 120ms ease, left 120ms ease, height 120ms ease, box-shadow 120ms ease',
                          boxShadow: interaction?.itemId === item.id ? '0 16px 32px color-mix(in srgb, var(--slate-900) 28%, transparent)' : 'none'
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
                          {/* 時刻とボタンの行は折り返さない（折り返すと、低いブロックでタスク名が押し出されて消える）。狭いときは時刻を省略する */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 0 }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--blue-100)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                              {offsetToClock(item.startMinutes)} - {offsetToClock(item.endMinutes)}
                            </span>
                            {!compactBlock && item.status === 'done' && (
                              <span style={{ fontSize: '0.62rem', color: 'var(--green-300)', background: 'var(--green-950)', borderRadius: 999, padding: '1px 6px' }}>
                                完了
                              </span>
                            )}
                            {!compactBlock && runningTodoId === item.todo_id && (
                              <span style={{ fontSize: '0.62rem', color: 'var(--green-300)', background: 'var(--green-950)', borderRadius: 999, padding: '1px 6px' }}>
                                計測中
                              </span>
                            )}
                            {!compactBlock && <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
                              <button onPointerDown={(event) => event.stopPropagation()} onClick={() => void runAction(() => onShiftItem(item.id, -15))} style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')} title="15分早める" aria-label={`「${item.title}」を15分早める`}>−15</button>
                              <button onPointerDown={(event) => event.stopPropagation()} onClick={() => void runAction(() => onShiftItem(item.id, 15))} style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')} title="15分遅らせる" aria-label={`「${item.title}」を15分遅らせる`}>+15</button>
                              {narrowBlocks ? (
                                <details
                                  className="hakobi-plan-block-menu"
                                  onToggle={(event) => {
                                    const open = event.currentTarget.open
                                    setOpenMenuItemId((previous) => open ? item.id : previous === item.id ? null : previous)
                                  }}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key !== 'Escape') return
                                    const details = event.currentTarget
                                    if (!details.open) return
                                    event.stopPropagation()
                                    details.open = false
                                    details.querySelector('summary')?.focus()
                                  }}
                                  style={{ position: 'relative' }}
                                >
                                  <summary aria-label={`「${item.title}」のほかの操作`} title="ほかの操作（以降+15・複製・未定・外す）" style={{ ...miniActionBtn('var(--slate-800)', 'var(--slate-300)'), listStyle: 'none' }}>⋯</summary>
                                  <div
                                    onClick={(event) => { const details = event.currentTarget.parentElement as HTMLDetailsElement | null; if (details && (event.target as HTMLElement).closest('button')) details.open = false }}
                                    style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, display: 'flex', flexDirection: 'column', gap: 4, padding: 6, borderRadius: 8, background: 'var(--slate-900)', border: '1px solid var(--slate-700)', boxShadow: '0 8px 20px rgba(0,0,0,0.35)' }}
                                  >
                                    {onShiftFollowing && (
                                <button
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={() => void runAction(() => onShiftFollowing!(item.id, 15))}
                                  style={miniActionBtn('var(--blue-950)', 'var(--blue-200)')}
                                  title="この予定と、これ以降の予定を15分遅らせる"
                                  aria-label={`「${item.title}」とこれ以降の予定を15分遅らせる`}
                                >
                                  以降+15
                                </button>
                              )}
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => void runAction(() => duplicateBlock(item))}
                                style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}
                                title="同じタスクをこの直後にもう1つ置く"
                                aria-label={`「${item.title}」を複製して直後に置く`}
                              >
                                複製
                              </button>
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => {
                                  const nextItems = planItems.map((planItem) => {
                                    if (planItem.id !== item.id) return planItem
                                    return { ...planItem, scheduled_start: null }
                                  })
                                  void runAction(() => onUpdateItem(item.id, { scheduled_start: null }).then(() => onReorder(reorderIdsByTime(nextItems))))
                                }}
                                style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}
                                title="未定に戻す"
                                aria-label={`「${item.title}」の時刻を未定に戻す`}
                              >
                                未定
                              </button>
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => void runAction(() => removeItemWithUndo(item))}
                                style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}
                                title="今日の計画から外す（タスクは消えません）"
                                aria-label={`「${item.title}」を計画から外す（タスクは消えません）`}
                              >
                                外す
                              </button>
                                  </div>
                                </details>
                              ) : (
                                <>
                                  {onShiftFollowing && (
                                <button
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={() => void runAction(() => onShiftFollowing!(item.id, 15))}
                                  style={miniActionBtn('var(--blue-950)', 'var(--blue-200)')}
                                  title="この予定と、これ以降の予定を15分遅らせる"
                                  aria-label={`「${item.title}」とこれ以降の予定を15分遅らせる`}
                                >
                                  以降+15
                                </button>
                              )}
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => void runAction(() => duplicateBlock(item))}
                                style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}
                                title="同じタスクをこの直後にもう1つ置く"
                                aria-label={`「${item.title}」を複製して直後に置く`}
                              >
                                複製
                              </button>
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => {
                                  const nextItems = planItems.map((planItem) => {
                                    if (planItem.id !== item.id) return planItem
                                    return { ...planItem, scheduled_start: null }
                                  })
                                  void runAction(() => onUpdateItem(item.id, { scheduled_start: null }).then(() => onReorder(reorderIdsByTime(nextItems))))
                                }}
                                style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}
                                title="未定に戻す"
                                aria-label={`「${item.title}」の時刻を未定に戻す`}
                              >
                                未定
                              </button>
                              <button
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() => void runAction(() => removeItemWithUndo(item))}
                                style={miniActionBtn('var(--slate-800)', 'var(--slate-300)')}
                                title="今日の計画から外す（タスクは消えません）"
                                aria-label={`「${item.title}」を計画から外す（タスクは消えません）`}
                              >
                                外す
                              </button>
                                </>
                              )}
                            </div>}
                          </div>

                          <button
                            onPointerDown={(event) => event.stopPropagation()}
                            data-plan-block-title=""
                            onClick={() => onSelectTodo(item.todo_id)}
                            title={item.title}
                            style={{
                              flexShrink: 0,
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              color: 'var(--slate-50)',
                              cursor: 'pointer',
                              fontSize: '0.84rem',
                              fontWeight: 700,
                              textAlign: 'left',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {item.status === 'on_hold' && <span style={{ color: 'var(--purple-300)' }}>保留中 · </span>}{item.title}
                          </button>

                          {showBlockMeta && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.68rem', color: 'var(--slate-300)', minHeight: 0, overflow: 'hidden' }}>
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
                            background: `color-mix(in srgb, ${categoryColor} 33.3%, transparent)`
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
        <div style={{ flex: '0.9 1 270px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Section title="時刻が未定のタスク" subtitle="まだ時刻を決めていないタスクです。ドラッグかクリックで時間割に置けます。">
            <div role="status" style={addedNotice ? { marginBottom: 10, padding: '6px 10px', borderRadius: 8, background: 'var(--green-950)', border: '1px solid var(--green-700)', color: 'var(--green-200)', fontSize: '0.78rem', lineHeight: 1.5 } : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              {addedNotice}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {unscheduledItems.length === 0 ? (
                <EmptyState label="時刻が未定のタスクはありません。候補や「タスクを探す」から追加して時刻を決めてください。" />
              ) : (
                unscheduledItems.map((item) => (
                  <UnscheduledCard
                    key={item.id}
                    item={item}
                    todayKey={date}
                    onSelect={onSelectTodo}
                    onRemove={async () => { await runAction(() => removeItemWithUndo(item)) }}
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

          <Section title="候補" subtitle={`「${addToDayLabel(date)}」は時刻未定で追加。「時間に置く」は押したあと、時間割の空き時間を選びます。`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {suggestions.length === 0 ? (
                <EmptyState label="おすすめのタスクはありません。「タスクを探す」から計画に追加してください。" />
              ) : (
                suggestions.map((group) => (
                  <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: '0.78rem', color: 'var(--slate-400)', fontWeight: 700 }}>{group.title}</div>
                    {group.items.map((todo) => (
                      <CandidateCard
                        key={`${group.title}-${todo.id}`}
                        todo={todo}
                        todayKey={date}
                        note={todo.list_mode && checklistSummaries?.get(todo.id) ? `ToDoリスト: ${checklistBadgeText(checklistSummaries.get(todo.id)!)}` : undefined}
                        onAdd={addUnscheduled}
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

          <Section title="タスクを探す" subtitle={`未着手・進行中のタスク${availableTodos.length}件から検索できます。配置済みのタスクも、もう一度置けます。`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="追加したいタスクを検索..."
                style={inputStyle}
              />
              {filteredBacklog.length === 0 ? (
                <EmptyState label={searchQuery ? '検索条件に合うタスクはありません。' : '未着手・進行中のタスクはありません。'} />
              ) : (
                filteredBacklog.map((todo) => (
                  <CandidateCard
                    key={todo.id}
                    todo={todo}
                    todayKey={date}
                    plannedCount={plannedCountByTodoId.get(todo.id) ?? 0}
                    onAdd={addUnscheduled}
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

          <Section title="使い方">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--slate-400)', fontSize: '0.8rem', lineHeight: 1.6 }}>
              <div>候補や時刻が未定のタスクは、ドラッグして時間割へ落とすか、「時間に置く」を押してから空き時間をクリックすると配置できます。</div>
              <div>時間割のブロックは、ドラッグで開始時刻、下端ドラッグで長さを調整できます。</div>
              <div>同じタスクは1日に何個でも置けます。ブロックの「複製」を押すか、「タスクを探す」から同じタスクをもう一度ドラッグしてください。</div>
              <div>クリックで置いている途中は、Esc でキャンセルできます。</div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
