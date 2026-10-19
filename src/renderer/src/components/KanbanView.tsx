import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Category, Todo, TodoStatus } from '../types'
import { checklistBadgeText, checklistBadgeTitle, type ChecklistSummary } from '../lib/todoList'
import { dataInk } from '../lib/theme'
import { todoRecurrenceLabel } from '../lib/recurrence'
import { dueStateSuffix, formatShortDate } from '../lib/dueDate'

interface Props {
  todos: Todo[]
  categories: Category[]
  runningTodoId: string | null
  /** タスク一覧の絞り込みの表示。絞り込み中だけ上に出す */
  listFilters?: React.ReactNode
  onSelectTodo: (id: string) => void
  onChangeStatus: (todo: Todo, status: TodoStatus) => void | Promise<void>
  onCreateInColumn: (title: string, status: TodoStatus) => void | Promise<void>
  /** ToDoリスト（中の項目をチェックして使うタスク）の項目の進み具合 */
  checklistSummaries?: Map<string, ChecklistSummary>
}

const COLUMNS: { status: TodoStatus; label: string; accent: string }[] = [
  { status: 'not_started', label: '未着手', accent: 'var(--slate-500)' },
  { status: 'active', label: '進行中', accent: 'var(--blue-500)' },
  { status: 'on_hold', label: '保留中', accent: 'var(--purple-400)' },
  { status: 'done', label: '完了', accent: 'var(--green-500)' }
]

/** 日付のみの文字列（YYYY-MM-DD）をローカル日付の0時としてパースする */
function parseDateOnly(dateKey: string): Date {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function getDueColor(dueDate: string | null): string {
  if (!dueDate) return 'var(--slate-500)'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = (parseDateOnly(dueDate).getTime() - today.getTime()) / 86400000
  if (diffDays < 0) return 'var(--red-500)'
  if (diffDays < 1) return 'var(--orange-500)'
  if (diffDays <= 3) return 'var(--amber-500)'
  return 'var(--slate-500)'
}

function progressColor(p: number): string {
  if (p >= 100) return 'var(--green-400)'
  if (p >= 70) return 'var(--indigo-500)'
  if (p >= 30) return 'var(--indigo-400)'
  return 'var(--slate-600)'
}

// 列内の並び順: 優先度の高い順 → 期限の早い順（無期限は後ろ）→ 手動順
function sortForColumn(a: Todo, b: Todo): number {
  if (b.priority !== a.priority) return b.priority - a.priority
  const ad = a.due_date ?? '￿'
  const bd = b.due_date ?? '￿'
  if (ad !== bd) return ad < bd ? -1 : 1
  return (a.sort_order ?? 0) - (b.sort_order ?? 0)
}

function avatarStyle(color: string | null | undefined): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
    background: color ?? 'var(--slate-500)', border: '1px solid var(--slate-900)',
    color: 'var(--ink-on-data)', fontSize: '0.58rem', fontWeight: 800, textTransform: 'uppercase'
  }
}

function KanbanCard({
  todo, isRunning, isPrivate, checklist, columnLabel, autoFocus, onFocused, onSelect, onMove, onDragStart, onDragEnd
}: {
  todo: Todo; isRunning: boolean; isPrivate: boolean
  checklist?: ChecklistSummary
  columnLabel: string
  /** 列を移した直後のカード。移った先でもフォーカスを保つ */
  autoFocus: boolean
  onFocused: () => void
  onSelect: () => void
  /** キーボードで隣の列へ移す（-1 は左、1 は右） */
  onMove: (direction: -1 | 1) => void
  onDragStart: () => void; onDragEnd: () => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    cardRef.current?.focus()
    onFocused()
  }, [autoFocus, onFocused])
  // ToDoリストは進捗率を使わない（中の項目のチェックで見る）
  // 完了したタスクは進捗率を出さない（完了の前の 40% などが残って紛らわしいため）
  const prog = todo.list_mode || todo.status === 'done' ? 0 : todo.progress ?? 0
  const isDone = todo.status === 'done'
  const coAssignees = todo.co_assignees ?? []

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      // キーボードでも開ける・列を移せるようにする（ドラッグはマウスだけなので）
      role="button"
      tabIndex={0}
      aria-label={`${todo.title}（${columnLabel}）`}
      aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight"
      title="Enter で開く・Alt+← / Alt+→ で隣の列へ移す"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault()
          onMove(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
      style={{
        background: 'var(--slate-900)',
        border: `1px solid ${isRunning ? 'var(--green-900)' : 'var(--slate-800)'}`,
        borderLeft: `3px solid ${isRunning ? 'var(--green-400)' : 'transparent'}`,
        borderRadius: 8,
        padding: '8px 10px',
        cursor: 'grab',
        opacity: isPrivate ? 0.78 : 1
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
        {todo.category_name && (
          <span style={{
            fontSize: '0.66rem', padding: '1px 6px', borderRadius: 99,
            background: `color-mix(in srgb, ${todo.category_color ?? 'var(--indigo-500)'} 18.8%, transparent)`, color: dataInk(todo.category_color ?? 'var(--indigo-500)')
          }}>
            {todo.category_name}
          </span>
        )}
        {todo.priority >= 4 && (
          <span style={{ fontSize: '0.66rem', color: todo.priority === 5 ? 'var(--red-500)' : 'var(--amber-500)' }}>
            {'!'.repeat(todo.priority - 3)}
          </span>
        )}
        {todo.recurrence && (
          <span title={`繰り返し: ${todoRecurrenceLabel(todo) ?? todo.recurrence}`} style={{ fontSize: '0.62rem', color: 'var(--indigo-400)' }}>🔁</span>
        )}
        {todo.list_mode === 1 && checklist && (
          <span title={checklistBadgeTitle(checklist)} style={{ fontSize: '0.6rem', color: 'var(--indigo-300)', border: '1px solid var(--indigo-700)', borderRadius: 99, padding: '0 5px' }}>
            ☑ {checklistBadgeText(checklist)}
          </span>
        )}
        {isPrivate && (
          <span title="集計から外すカテゴリ（チームの集計・レポートに含めません。ほかの人にも見えます）" style={{ fontSize: '0.6rem', color: 'var(--slate-400)', border: '1px solid var(--slate-700)', borderRadius: 99, padding: '0 5px' }}>集計外</span>
        )}
        {isRunning && (
          <span style={{ fontSize: '0.6rem', background: 'color-mix(in srgb, var(--green-400) 12.5%, transparent)', color: 'var(--green-400)', padding: '1px 5px', borderRadius: 99 }}>計測中</span>
        )}
      </div>

      <div style={{
        fontSize: '0.84rem',
        color: isDone ? 'var(--slate-500)' : 'var(--slate-200)',
        textDecoration: isDone ? 'line-through' : 'none',
        lineHeight: 1.4, wordBreak: 'break-word'
      }}>
        {todo.title}
      </div>

      {prog > 0 && (
        <div style={{ height: 3, background: 'var(--slate-800)', borderRadius: 99, marginTop: 7, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${prog}%`, background: progressColor(prog) }} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
        {todo.due_date && (
          <span title={`期限 ${todo.due_date.slice(0, 10)}`} style={{ fontSize: '0.66rem', color: isDone ? 'var(--slate-500)' : getDueColor(todo.due_date) }}>
            期限 {formatShortDate(todo.due_date)}{dueStateSuffix(todo.due_date, isDone)}
          </span>
        )}
        {prog > 0 && (
          <span style={{ fontSize: '0.66rem', color: progressColor(prog) }}>{prog}%</span>
        )}
        {(todo.assignee_name || coAssignees.length > 0) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 'auto' }}>
            {todo.assignee_name && (
              <span title={`主担当: ${todo.assignee_name}`} style={avatarStyle(todo.assignee_color)}>
                {todo.assignee_name.slice(0, 1)}
              </span>
            )}
            {coAssignees.slice(0, 3).map((ca) => (
              <span key={ca.user_id} title={`サブ担当: ${ca.display_name}`} style={{ ...avatarStyle(ca.color), marginLeft: todo.assignee_name ? -4 : 0 }}>
                {ca.display_name.slice(0, 1)}
              </span>
            ))}
            {coAssignees.length > 3 && (
              <span style={{ ...avatarStyle('var(--slate-600)'), marginLeft: -4 }}>+{coAssignees.length - 3}</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

export function KanbanView({
  todos, categories, runningTodoId, listFilters, onSelectTodo, onChangeStatus, onCreateInColumn, checklistSummaries
}: Props): React.JSX.Element {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<TodoStatus | null>(null)
  const [addingStatus, setAddingStatus] = useState<TodoStatus | null>(null)
  const [addTitle, setAddTitle] = useState('')
  const [addError, setAddError] = useState('')
  const [adding, setAdding] = useState(false)
  const addingRef = useRef(false)
  const addButtonsRef = useRef(new Map<TodoStatus, HTMLButtonElement>())

  const privateCategoryIds = useMemo(
    () => new Set(categories.filter((c) => c.is_private).map((c) => c.id)),
    [categories]
  )

  const byStatus = useMemo(() => {
    const map: Record<TodoStatus, Todo[]> = { not_started: [], active: [], on_hold: [], done: [], archived: [] }
    for (const todo of todos) {
      if (todo.status === 'archived') continue
      map[todo.status].push(todo)
    }
    for (const status of Object.keys(map) as TodoStatus[]) map[status].sort(sortForColumn)
    return map
  }, [todos])

  const handleDrop = (status: TodoStatus): void => {
    const todo = todos.find((t) => t.id === draggedId)
    setDraggedId(null)
    setDragOverStatus(null)
    if (todo && todo.status !== status) void onChangeStatus(todo, status)
  }

  // キーボードで列を移したカードは、移った先で再びフォーカスする
  const [focusAfterMoveId, setFocusAfterMoveId] = useState<string | null>(null)
  const clearFocusAfterMove = useCallback(() => setFocusAfterMoveId(null), [])
  const moveByKeyboard = (todo: Todo, direction: -1 | 1): void => {
    const index = COLUMNS.findIndex((column) => column.status === todo.status)
    const next = COLUMNS[index + direction]
    if (index < 0 || !next) return
    // 移した先の列に描き直されてから、そのカードへフォーカスを戻す
    void Promise.resolve(onChangeStatus(todo, next.status)).then(() => setFocusAfterMoveId(todo.id))
  }

  const submitAdd = async (status: TodoStatus): Promise<void> => {
    const title = addTitle.trim()
    if (!title || addingRef.current) return
    addingRef.current = true
    setAdding(true)
    setAddError('')
    try {
      await onCreateInColumn(title, status)
      setAddTitle('')
      setAddingStatus(null)
      window.requestAnimationFrame(() => addButtonsRef.current.get(status)?.focus())
    } catch (error) {
      setAddError(error instanceof Error ? error.message : '追加できませんでした。入力を残しています。もう一度お試しください。')
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      {listFilters && <div style={{ flexShrink: 0, padding: '8px 12px 0' }}>{listFilters}</div>}
    <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10, padding: 12, overflowX: 'auto', boxSizing: 'border-box' }}>
      {COLUMNS.map((col) => {
        const items = byStatus[col.status]
        const isOver = dragOverStatus === col.status
        return (
          <div
            key={col.status}
            onDragOver={(e) => { e.preventDefault(); if (draggedId) setDragOverStatus(col.status) }}
            onDragLeave={() => setDragOverStatus((prev) => (prev === col.status ? null : prev))}
            onDrop={(e) => { e.preventDefault(); handleDrop(col.status) }}
            style={{
              flex: '1 1 0', minWidth: 200, display: 'flex', flexDirection: 'column',
              background: isOver ? 'var(--c-13203b)' : 'var(--c-0b1220)',
              border: `1px solid ${isOver ? 'var(--blue-500)' : 'var(--slate-800)'}`,
              borderRadius: 12, overflow: 'hidden'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--slate-800)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: col.accent, flexShrink: 0 }} />
              <span style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--slate-200)' }}>{col.label}</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-subtle)', background: 'var(--slate-900)', border: '1px solid var(--slate-800)', borderRadius: 99, padding: '1px 7px' }}>
                {items.length}
              </span>
              <button
                ref={(element) => { if (element) addButtonsRef.current.set(col.status, element); else addButtonsRef.current.delete(col.status) }}
                disabled={adding}
                onClick={() => { setAddingStatus(col.status); setAddTitle(''); setAddError('') }}
                title={`「${col.label}」の列にタスクを追加`}
                aria-label={`${col.label}にタスクを追加`}
                style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--slate-700)', borderRadius: 6, color: 'var(--slate-400)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '3px 7px' }}
              >
                ＋
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {addingStatus === col.status && (
                <form aria-label={`${col.label}にタスクを追加`} onSubmit={(event) => { event.preventDefault(); void submitAdd(col.status) }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  autoFocus
                  aria-label="タスク名"
                  aria-describedby={addError ? 'kanban-add-error' : undefined}
                  aria-invalid={Boolean(addError)}
                  disabled={adding}
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  onKeyDown={(e) => {
                    // 日本語変換の確定の Enter では追加しない
                    if (e.nativeEvent.isComposing) { if (e.key === 'Enter') e.preventDefault(); return }
                    if (e.key === 'Escape' && !addingRef.current) { e.preventDefault(); setAddingStatus(null); setAddTitle(''); addButtonsRef.current.get(col.status)?.focus() }
                  }}
                  placeholder="タスク名を入力して Enter"
                  style={{ width: '100%', padding: '7px 9px', background: 'var(--slate-900)', border: '1px solid var(--blue-500)', borderRadius: 8, color: 'var(--slate-200)', fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box' }}
                />
                {addError && <p id="kanban-add-error" role="alert" style={{ color: 'var(--red-400)', fontSize: '0.8rem', overflowWrap: 'anywhere' }}>{addError} 入力内容は残っています。</p>}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="submit" disabled={adding || !addTitle.trim()} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--blue-500)', background: 'var(--blue-900)', color: 'var(--blue-100)', cursor: adding ? 'wait' : 'pointer' }}>{adding ? '追加中…' : '追加'}</button>
                  <button type="button" disabled={adding} onClick={() => { setAddingStatus(null); setAddTitle(''); addButtonsRef.current.get(col.status)?.focus() }} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--slate-700)', background: 'transparent', color: 'var(--slate-300)', cursor: 'pointer' }}>キャンセル</button>
                </div>
                </form>
              )}

              {items.map((todo) => (
                <KanbanCard
                  key={todo.id}
                  todo={todo}
                  isRunning={runningTodoId === todo.id}
                  checklist={checklistSummaries?.get(todo.id)}
                  isPrivate={todo.category_id != null && privateCategoryIds.has(todo.category_id)}
                  columnLabel={col.label}
                  autoFocus={focusAfterMoveId === todo.id}
                  onFocused={clearFocusAfterMove}
                  onMove={(direction) => moveByKeyboard(todo, direction)}
                  onSelect={() => onSelectTodo(todo.id)}
                  onDragStart={() => setDraggedId(todo.id)}
                  onDragEnd={() => { setDraggedId(null); setDragOverStatus(null) }}
                />
              ))}

              {items.length === 0 && addingStatus !== col.status && (
                <div style={{ padding: '16px 8px', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.76rem' }}>
                  カードをここにドラッグ（キーボードは Alt+← / Alt+→）
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
    </div>
  )
}
