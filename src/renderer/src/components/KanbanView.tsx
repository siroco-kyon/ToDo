import React, { useMemo, useState } from 'react'
import type { Category, Todo, TodoStatus } from '../types'

interface Props {
  todos: Todo[]
  categories: Category[]
  runningTodoId: string | null
  onSelectTodo: (id: string) => void
  onChangeStatus: (todo: Todo, status: TodoStatus) => void | Promise<void>
  onCreateInColumn: (title: string, status: TodoStatus) => void | Promise<void>
}

const COLUMNS: { status: TodoStatus; label: string; accent: string }[] = [
  { status: 'not_started', label: '未着手', accent: '#64748b' },
  { status: 'active', label: '進行中', accent: '#3b82f6' },
  { status: 'done', label: '完了', accent: '#22c55e' }
]

/** 日付のみの文字列（YYYY-MM-DD）をローカル日付の0時としてパースする */
function parseDateOnly(dateKey: string): Date {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function getDueColor(dueDate: string | null): string {
  if (!dueDate) return '#64748b'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = (parseDateOnly(dueDate).getTime() - today.getTime()) / 86400000
  if (diffDays < 0) return '#ef4444'
  if (diffDays < 1) return '#f97316'
  if (diffDays <= 3) return '#f59e0b'
  return '#64748b'
}

function progressColor(p: number): string {
  if (p >= 100) return '#4ade80'
  if (p >= 70) return '#6366f1'
  if (p >= 30) return '#818cf8'
  return '#475569'
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
    background: color ?? '#64748b', border: '1px solid #0f172a',
    color: '#0b1220', fontSize: '0.58rem', fontWeight: 800, textTransform: 'uppercase'
  }
}

function KanbanCard({
  todo, isRunning, isPrivate, onSelect, onDragStart, onDragEnd
}: {
  todo: Todo; isRunning: boolean; isPrivate: boolean
  onSelect: () => void; onDragStart: () => void; onDragEnd: () => void
}): React.JSX.Element {
  const prog = todo.progress ?? 0
  const isDone = todo.status === 'done'
  const coAssignees = todo.co_assignees ?? []

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      style={{
        background: '#0f172a',
        border: `1px solid ${isRunning ? '#14532d' : '#1e293b'}`,
        borderLeft: `3px solid ${isRunning ? '#4ade80' : 'transparent'}`,
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
            background: `${todo.category_color ?? '#6366f1'}30`, color: todo.category_color ?? '#6366f1'
          }}>
            {todo.category_name}
          </span>
        )}
        {todo.priority >= 4 && (
          <span style={{ fontSize: '0.66rem', color: todo.priority === 5 ? '#ef4444' : '#f59e0b' }}>
            {'!'.repeat(todo.priority - 3)}
          </span>
        )}
        {todo.recurrence && (
          <span title="繰り返し" style={{ fontSize: '0.62rem', color: '#818cf8' }}>🔁</span>
        )}
        {isPrivate && (
          <span title="プライベート（全体の集計から除外）" style={{ fontSize: '0.62rem' }}>🔒</span>
        )}
        {isRunning && (
          <span style={{ fontSize: '0.6rem', background: '#4ade8020', color: '#4ade80', padding: '1px 5px', borderRadius: 99 }}>計測中</span>
        )}
      </div>

      <div style={{
        fontSize: '0.84rem',
        color: isDone ? '#64748b' : '#e2e8f0',
        textDecoration: isDone ? 'line-through' : 'none',
        lineHeight: 1.4, wordBreak: 'break-word'
      }}>
        {todo.title}
      </div>

      {prog > 0 && (
        <div style={{ height: 3, background: '#1e293b', borderRadius: 99, marginTop: 7, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${prog}%`, background: progressColor(prog) }} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
        {todo.due_date && (
          <span style={{ fontSize: '0.66rem', color: getDueColor(todo.due_date) }}>
            {todo.due_date.slice(5, 10)}
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
              <span style={{ ...avatarStyle('#475569'), marginLeft: -4 }}>+{coAssignees.length - 3}</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

export function KanbanView({
  todos, categories, runningTodoId, onSelectTodo, onChangeStatus, onCreateInColumn
}: Props): React.JSX.Element {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<TodoStatus | null>(null)
  const [addingStatus, setAddingStatus] = useState<TodoStatus | null>(null)
  const [addTitle, setAddTitle] = useState('')

  const privateCategoryIds = useMemo(
    () => new Set(categories.filter((c) => c.is_private).map((c) => c.id)),
    [categories]
  )

  const byStatus = useMemo(() => {
    const map: Record<TodoStatus, Todo[]> = { not_started: [], active: [], done: [], archived: [] }
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

  const submitAdd = (status: TodoStatus): void => {
    const title = addTitle.trim()
    if (title) void onCreateInColumn(title, status)
    setAddTitle('')
    setAddingStatus(null)
  }

  return (
    <div style={{ height: '100%', display: 'flex', gap: 10, padding: 12, overflowX: 'auto', boxSizing: 'border-box' }}>
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
              flex: '1 1 0', minWidth: 240, display: 'flex', flexDirection: 'column',
              background: isOver ? '#13203b' : '#0b1220',
              border: `1px solid ${isOver ? '#3b82f6' : '#1e293b'}`,
              borderRadius: 12, overflow: 'hidden'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid #1e293b' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: col.accent, flexShrink: 0 }} />
              <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#e2e8f0' }}>{col.label}</span>
              <span style={{ fontSize: '0.7rem', color: '#64748b', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 99, padding: '1px 7px' }}>
                {items.length}
              </span>
              <button
                onClick={() => { setAddingStatus(col.status); setAddTitle('') }}
                title="このステータスでタスクを追加"
                style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #334155', borderRadius: 6, color: '#94a3b8', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '3px 7px' }}
              >
                ＋
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {addingStatus === col.status && (
                <input
                  autoFocus
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitAdd(col.status)
                    if (e.key === 'Escape') { setAddingStatus(null); setAddTitle('') }
                  }}
                  onBlur={() => submitAdd(col.status)}
                  placeholder="タスク名を入力して Enter"
                  style={{ width: '100%', padding: '7px 9px', background: '#0f172a', border: '1px solid #3b82f6', borderRadius: 8, color: '#e2e8f0', fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box' }}
                />
              )}

              {items.map((todo) => (
                <KanbanCard
                  key={todo.id}
                  todo={todo}
                  isRunning={runningTodoId === todo.id}
                  isPrivate={todo.category_id != null && privateCategoryIds.has(todo.category_id)}
                  onSelect={() => onSelectTodo(todo.id)}
                  onDragStart={() => setDraggedId(todo.id)}
                  onDragEnd={() => { setDraggedId(null); setDragOverStatus(null) }}
                />
              ))}

              {items.length === 0 && addingStatus !== col.status && (
                <div style={{ padding: '16px 8px', textAlign: 'center', color: '#475569', fontSize: '0.76rem' }}>
                  ここにドロップ
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
