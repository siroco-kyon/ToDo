import React, { useState, useRef } from 'react'
import type { Todo } from '../types'

interface Props {
  todos: Todo[]
  selectedId: string | null
  runningTodoId: string | null
  isManualSort: boolean
  searchQuery: string
  onSelect: (id: string) => void
  onToggleDone: (todo: Todo) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (orderedIds: string[]) => Promise<void>
  onStartTimer: (todoId: string) => Promise<void>
  onStopTimer: (note?: string) => Promise<void>
}

function getDueDateColor(dueDate: string | null): string {
  if (!dueDate) return ''
  const diffDays = (new Date(dueDate).getTime() - Date.now()) / 86400000
  if (diffDays < 0) return '#ef4444'
  if (diffDays < 1) return '#f97316'
  if (diffDays < 3) return '#f59e0b'
  return ''
}

function progressColor(p: number): string {
  if (p >= 100) return '#4ade80'
  if (p >= 70) return '#6366f1'
  if (p >= 30) return '#818cf8'
  return '#475569'
}

function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#f59e0b40', color: '#f59e0b', borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

function TodoItem({
  todo, isSelected, isRunning, isManualSort, searchQuery,
  onSelect, onToggleDone, onArchive, onUnarchive, onDelete,
  onStartTimer, onStopTimer,
  onDragStart, onDragOver, onDrop, isDragOver
}: {
  todo: Todo; isSelected: boolean; isRunning: boolean
  isManualSort: boolean; searchQuery: string
  onSelect: () => void; onToggleDone: () => void
  onArchive: () => void; onUnarchive: () => void; onDelete: () => void
  onStartTimer: () => void; onStopTimer: () => void
  onDragStart: () => void; onDragOver: () => void; onDrop: () => void
  isDragOver: boolean
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const dueColor = getDueDateColor(todo.due_date)
  const isArchived = todo.status === 'archived'
  const prog = todo.progress ?? 0

  return (
    <div
      draggable={isManualSort && !isArchived}
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); onDragOver() }}
      onDrop={(e) => { e.preventDefault(); onDrop() }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: 'pointer', position: 'relative',
        background: isDragOver ? '#6366f115' : isSelected ? '#1e293b' : hovered ? '#111827' : 'transparent',
        borderLeft: `3px solid ${isRunning ? '#4ade80' : isSelected ? '#6366f1' : 'transparent'}`,
        borderBottom: `1px solid ${isDragOver ? '#6366f140' : '#0f172a'}`,
        borderTop: isDragOver ? '2px solid #6366f1' : '2px solid transparent',
        opacity: isArchived ? 0.6 : 1, transition: 'background 0.1s'
      }}
    >
      <div style={{ padding: '8px 12px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          {/* ドラッグハンドル */}
          {isManualSort && !isArchived && (
            <span style={{ color: '#334155', fontSize: '0.8rem', cursor: 'grab', flexShrink: 0, marginTop: 2, userSelect: 'none' }}>⠿</span>
          )}

          {/* 完了チェック */}
          {!isArchived ? (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleDone() }}
              style={{
                width: 17, height: 17, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                border: `2px solid ${todo.status === 'done' ? '#4ade80' : '#475569'}`,
                background: todo.status === 'done' ? '#4ade80' : 'transparent',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}
            >
              {todo.status === 'done' && <span style={{ fontSize: 9, color: '#0f172a', fontWeight: 'bold' }}>✓</span>}
            </button>
          ) : (
            <span style={{ fontSize: '0.75rem', color: '#475569', flexShrink: 0, marginTop: 2 }}>📦</span>
          )}

          {/* タイトル・メタ */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                fontSize: '0.88rem',
                color: isArchived || todo.status === 'done' ? '#64748b' : '#e2e8f0',
                textDecoration: todo.status === 'done' || isArchived ? 'line-through' : 'none',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>
                <Highlight text={todo.title} query={searchQuery} />
              </span>
              {isRunning && (
                <span style={{ fontSize: '0.65rem', background: '#4ade8020', color: '#4ade80', padding: '1px 5px', borderRadius: 99, flexShrink: 0 }}>●</span>
              )}
              {todo.recurrence && !isArchived && (
                <span title={`繰り返し: ${todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : '毎月'}`}
                  style={{ fontSize: '0.65rem', color: '#818cf8', flexShrink: 0 }}>🔁</span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              {todo.category_name && (
                <span style={{
                  fontSize: '0.68rem', padding: '1px 5px', borderRadius: 99,
                  background: `${todo.category_color ?? '#6366f1'}30`,
                  color: todo.category_color ?? '#6366f1'
                }}>
                  {todo.category_name}
                </span>
              )}
              {todo.priority >= 4 && !isArchived && (
                <span style={{ fontSize: '0.68rem', color: todo.priority === 5 ? '#ef4444' : '#f59e0b' }}>
                  {'!'.repeat(todo.priority - 3)}
                </span>
              )}
              {todo.due_date && !isArchived && (
                <span style={{ fontSize: '0.68rem', color: dueColor || '#64748b' }}>
                  {todo.due_date.slice(0, 10)}
                </span>
              )}
              {!isArchived && (todo.assignee_name || (todo.co_assignees?.length ?? 0) > 0) && (
                <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                  {todo.assignee_name && (
                    <span title={`主担当: ${todo.assignee_name}`} style={avatarStyle(todo.assignee_color)}>
                      {todo.assignee_name.slice(0, 1)}
                    </span>
                  )}
                  {(todo.co_assignees ?? []).slice(0, 3).map((ca) => (
                    <span
                      key={ca.user_id}
                      title={`サブ担当: ${ca.display_name}`}
                      style={{ ...avatarStyle(ca.color), marginLeft: todo.assignee_name ? -4 : 0 }}
                    >
                      {ca.display_name.slice(0, 1)}
                    </span>
                  ))}
                  {(todo.co_assignees?.length ?? 0) > 3 && (
                    <span style={{ ...avatarStyle('#475569'), marginLeft: -4 }}>
                      +{(todo.co_assignees?.length ?? 0) - 3}
                    </span>
                  )}
                </span>
              )}
              {!isArchived && prog > 0 && (
                <span style={{ fontSize: '0.68rem', color: progressColor(prog), marginLeft: 'auto' }}>
                  {prog}%
                </span>
              )}
            </div>
          </div>

          {/* ホバー時アクション */}
          {hovered && (
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
              {isArchived ? (
                <>
                  <button onClick={onUnarchive} title="復元" style={actionBtn('#10b981')}>↩</button>
                  <button
                    onClick={() => { if (window.confirm(`「${todo.title}」を完全に削除しますか？`)) onDelete() }}
                    title="完全削除" style={actionBtn('#ef4444')}
                  >🗑</button>
                </>
              ) : (
                <>
                  {todo.status !== 'done' && (
                    isRunning
                      ? <button onClick={onStopTimer} title="計測停止" style={actionBtn('#ef4444')}>■</button>
                      : <button onClick={onStartTimer} title="計測開始" style={actionBtn('#4ade80')}>▶</button>
                  )}
                  <button onClick={onArchive} title="アーカイブ" style={actionBtn('#64748b')}>📦</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* プログレスバー */}
      {!isArchived && (
        <div style={{ height: 3, background: '#0f172a' }}>
          <div style={{ height: '100%', width: `${prog}%`, background: progressColor(prog), transition: 'width 0.3s' }} />
        </div>
      )}
    </div>
  )
}

export function TodoList({
  todos, selectedId, runningTodoId, isManualSort, searchQuery,
  onSelect, onToggleDone, onArchive, onUnarchive, onDelete, onReorder,
  onStartTimer, onStopTimer
}: Props): React.JSX.Element {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragging = useRef(false)

  const handleDrop = async (targetId: string): Promise<void> => {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null); setDragOverId(null); return
    }
    const ids = todos.map((t) => t.id)
    const fromIdx = ids.indexOf(draggedId)
    const toIdx = ids.indexOf(targetId)
    const newIds = [...ids]
    newIds.splice(fromIdx, 1)
    newIds.splice(toIdx, 0, draggedId)
    setDraggedId(null); setDragOverId(null)
    dragging.current = false
    await onReorder(newIds)
  }

  if (todos.length === 0) {
    return (
      <div style={{ padding: 24, color: '#64748b', textAlign: 'center', fontSize: '0.9rem' }}>
        {searchQuery ? '検索結果がありません' : 'タスクがありません'}
      </div>
    )
  }

  return (
    <div
      style={{ overflowY: 'auto', height: '100%' }}
      onDragEnd={() => { setDraggedId(null); setDragOverId(null); dragging.current = false }}
    >
      {todos.map((todo) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          isSelected={selectedId === todo.id}
          isRunning={runningTodoId === todo.id}
          isManualSort={isManualSort}
          searchQuery={searchQuery}
          isDragOver={dragOverId === todo.id}
          onSelect={() => onSelect(todo.id)}
          onToggleDone={() => onToggleDone(todo)}
          onArchive={() => onArchive(todo.id)}
          onUnarchive={() => onUnarchive(todo.id)}
          onDelete={() => onDelete(todo.id)}
          onStartTimer={() => { void onStartTimer(todo.id) }}
          onStopTimer={() => { void onStopTimer() }}
          onDragStart={() => { setDraggedId(todo.id); dragging.current = true }}
          onDragOver={() => { if (dragging.current) setDragOverId(todo.id) }}
          onDrop={() => handleDrop(todo.id)}
        />
      ))}
    </div>
  )
}

function actionBtn(color: string): React.CSSProperties {
  return {
    background: `${color}20`, border: `1px solid ${color}60`,
    borderRadius: 4, color, cursor: 'pointer',
    fontSize: '0.78rem', padding: '2px 5px', lineHeight: 1
  }
}

function avatarStyle(color: string | null | undefined): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
    background: color ?? '#64748b', border: '1px solid #0d1525',
    color: '#0b1220', fontSize: '0.58rem', fontWeight: 800, textTransform: 'uppercase'
  }
}
