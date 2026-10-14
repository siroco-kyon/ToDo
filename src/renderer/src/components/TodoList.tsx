import React, { useState, useRef } from 'react'
import type { Todo } from '../types'
import { TimerDisplay } from './TimerDisplay'
import { diffDaysFromToday, getDueDateColor } from '../lib/dueDate'
import { checklistBadgeText, checklistBadgeTitle, type ChecklistSummary } from '../lib/todoList'

interface Props {
  todos: Todo[]
  selectedId: string | null
  runningTodoId: string | null
  elapsedSeconds: number
  isManualSort: boolean
  searchQuery: string
  /** 検索以外（担当・カテゴリ）の絞り込みがかかっている */
  hasOtherFilters?: boolean
  onClearSearch?: () => void
  onClearFilters?: () => void
  onAddTodo?: () => void
  onSelect: (id: string) => void
  onToggleDone: (todo: Todo) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (orderedIds: string[]) => Promise<void>
  onStartTimer: (todoId: string) => Promise<void>
  onStopTimer: (note?: string) => Promise<void>
  /** ToDoリスト（期限なしで続くタスク）の項目の進み具合 */
  checklistSummaries?: Map<string, ChecklistSummary>
}

/** 期限の表示。近いものは「今日まで」「3日遅れ」のように残り日数で出す（完了済みは日付だけ） */
function formatDueLabel(dueDate: string, done: boolean): string {
  const [, m, d] = dueDate.slice(0, 10).split('-')
  const date = `${Number(m)}/${Number(d)}`
  if (done) return date
  const diff = diffDaysFromToday(dueDate)
  if (diff < 0) return `${date}・${Math.abs(diff)}日遅れ`
  if (diff === 0) return '今日まで'
  if (diff === 1) return '明日まで'
  if (diff <= 7) return `${date}・あと${diff}日`
  return `${date}まで`
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
  todo, isSelected, isRunning, elapsedSeconds, isManualSort, searchQuery, checklist,
  onSelect, onToggleDone, onArchive, onUnarchive, onDelete,
  onStartTimer, onStopTimer,
  onDragStart, onDragOver, onDrop, isDragOver
}: {
  todo: Todo; isSelected: boolean; isRunning: boolean; elapsedSeconds: number
  isManualSort: boolean; searchQuery: string
  /** ToDoリストのときだけ渡す */
  checklist?: ChecklistSummary
  onSelect: () => void; onToggleDone: () => void
  onArchive: () => void; onUnarchive: () => void; onDelete: () => void
  onStartTimer: () => void; onStopTimer: () => void
  onDragStart: () => void; onDragOver: () => void; onDrop: () => void
  isDragOver: boolean
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const dueColor = todo.status === 'done' ? '' : getDueDateColor(todo.due_date)
  const isArchived = todo.status === 'archived'
  const listMode = Boolean(todo.list_mode)
  const prog = listMode ? 0 : todo.progress ?? 0

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

          {/* 完了チェック。ToDoリストは中の項目をチェックして使うので、一覧からは終えられないようにする */}
          {listMode && !isArchived && todo.status !== 'done' ? (
            <span
              title="ToDoリスト（期限なしで続くタスク）。項目のチェックは詳細で行います"
              aria-label="ToDoリスト"
              style={{ width: 17, height: 17, flexShrink: 0, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a5b4fc', fontSize: '0.8rem' }}
            >
              ☑
            </span>
          ) : !isArchived ? (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleDone() }}
              title={todo.status === 'done' ? '完了を取り消す' : '完了にする'}
              aria-label={todo.status === 'done' ? '完了を取り消す' : '完了にする'}
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
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.65rem', background: '#4ade8020', color: '#4ade80', padding: '1px 5px', borderRadius: 99, flexShrink: 0 }}>
                  ●<TimerDisplay elapsedSeconds={elapsedSeconds} isRunning />
                </span>
              )}
              {todo.recurrence && !isArchived && (
                <span title={`繰り返し: ${todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : '毎月'}`}
                  style={{ fontSize: '0.65rem', color: '#818cf8', flexShrink: 0 }}>🔁</span>
              )}
              {listMode && checklist && !isArchived && (
                <span title={checklistBadgeTitle(checklist)} style={{ fontSize: '0.65rem', color: '#a5b4fc', border: '1px solid #4338ca', borderRadius: 99, padding: '0 6px', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {checklistBadgeText(checklist)}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              {todo.status === 'on_hold' && <span style={{ fontSize: '0.68rem', color: '#d8b4fe' }}>保留中</span>}
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
                <span title={`期限 ${todo.due_date.slice(0, 10)}`} style={{ fontSize: '0.68rem', color: dueColor || '#64748b', fontWeight: dueColor ? 700 : 400, whiteSpace: 'nowrap' }}>
                  {formatDueLabel(todo.due_date, todo.status === 'done')}
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
                  <button onClick={onUnarchive} title="アーカイブから戻す" aria-label="アーカイブから戻す" style={actionBtn('#10b981')}>↩</button>
                  <button
                    onClick={() => { if (window.confirm(`「${todo.title}」を完全に削除しますか？`)) onDelete() }}
                    title="完全に削除（元に戻せません）" aria-label="完全に削除" style={actionBtn('#ef4444')}
                  >🗑</button>
                </>
              ) : (
                <>
                  {todo.status !== 'done' && (
                    isRunning
                      ? <button onClick={onStopTimer} title="計測を停止" aria-label="計測を停止" style={actionBtn('#ef4444')}>■</button>
                      : <button onClick={onStartTimer} title="作業時間の計測を開始" aria-label="計測を開始" style={actionBtn('#4ade80')}>▶</button>
                  )}
                  <button onClick={onArchive} title="アーカイブ（一覧から片付ける。あとで戻せます）" aria-label="アーカイブ" style={actionBtn('#64748b')}>📦</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* プログレスバー（ToDoリストは進捗率を使わない） */}
      {!isArchived && !listMode && (
        <div style={{ height: 3, background: '#0f172a' }}>
          <div style={{ height: '100%', width: `${prog}%`, background: progressColor(prog), transition: 'width 0.3s' }} />
        </div>
      )}
    </div>
  )
}

export function TodoList({
  todos, selectedId, runningTodoId, elapsedSeconds, isManualSort, searchQuery,
  hasOtherFilters = false, onClearSearch, onClearFilters, onAddTodo,
  onSelect, onToggleDone, onArchive, onUnarchive, onDelete, onReorder,
  onStartTimer, onStopTimer, checklistSummaries
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
    // 絞り込みで隠れているだけなのに「タスクがありません」と出すと、消えたと思われる
    const filtered = Boolean(searchQuery) || hasOtherFilters
    const emptyButtonStyle: React.CSSProperties = { padding: '6px 10px', borderRadius: 7, border: '1px solid #334155', background: '#172554', color: '#dbeafe', cursor: 'pointer', fontSize: '0.8rem' }
    return (
      <div style={{ padding: 24, color: '#64748b', textAlign: 'center', fontSize: '0.9rem' }}>
        <div>{searchQuery ? '検索に合うタスクはありません' : filtered ? '絞り込み条件に合うタスクはありません' : 'タスクがありません'}</div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          {searchQuery && <button onClick={onClearSearch} style={emptyButtonStyle}>検索をクリア</button>}
          {!searchQuery && hasOtherFilters && onClearFilters && <button onClick={onClearFilters} style={emptyButtonStyle}>絞り込みを解除</button>}
          {onAddTodo && <button onClick={onAddTodo} style={{ ...emptyButtonStyle, background: '#1d4ed8', borderColor: '#2563eb' }}>＋ タスクを追加</button>}
        </div>
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
          elapsedSeconds={runningTodoId === todo.id ? elapsedSeconds : 0}
          isManualSort={isManualSort}
          searchQuery={searchQuery}
          checklist={checklistSummaries?.get(todo.id)}
          isDragOver={dragOverId === todo.id}
          onSelect={() => onSelect(todo.id)}
          onToggleDone={() => onToggleDone(todo)}
          onArchive={() => onArchive(todo.id)}
          onUnarchive={() => onUnarchive(todo.id)}
          onDelete={() => onDelete(todo.id)}
          onStartTimer={() => { void onStartTimer(todo.id) }}
          onStopTimer={() => { void onStopTimer().catch(() => { /* App displays the error. */ }) }}
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
