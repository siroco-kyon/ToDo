import React, { useMemo, useState, useRef } from 'react'
import type { SubTask, Todo } from '../types'
import { RunningTimerDisplay } from './TimerDisplay'
import { QuickCheckItem } from './TodoChecklist'
import { diffDaysFromToday, getDueDateColor, toDateKey } from '../lib/dueDate'
import { checklistBadgeText, checklistBadgeTitle, type ChecklistSummary } from '../lib/todoList'

const EXPANDED_LISTS_KEY = 'todoList.expandedLists'

function readExpandedLists(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXPANDED_LISTS_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** 一覧で開いたときに出す項目。繰り返しの項目 → まだのやること（期限が過ぎたものを上に） */
function expandedItemsOf(items: SubTask[], todayKey: string): SubTask[] {
  const open = items.filter((item) => !item.recurrence && !item.done)
  const overdue = open.filter((item) => item.due_date != null && item.due_date.slice(0, 10) < todayKey)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
  return [...items.filter((item) => item.recurrence), ...overdue, ...open.filter((item) => !overdue.includes(item))]
}

interface Props {
  todos: Todo[]
  selectedId: string | null
  runningTodoId: string | null
  /** 計測を始めた時刻（計測中でなければ null） */
  timerStartTime: string | null
  isManualSort: boolean
  searchQuery: string
  /** 検索以外（担当・カテゴリ）の絞り込みがかかっている */
  hasOtherFilters?: boolean
  /** 絞り込む前にタスクが1件でもあるか。1件もないときは、絞り込みの案内ではなく最初のタスクを作る案内を出す */
  hasAnyTodos?: boolean
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
  /** ToDoリスト（中の項目をチェックして使うタスク）の項目の進み具合 */
  checklistSummaries?: Map<string, ChecklistSummary>
  /** ToDoリストの項目（▸ で開いて、その場でチェックできる） */
  listItemsByTodo?: Map<string, SubTask[]>
  pendingItemIds?: Set<string>
  onToggleListItem?: (item: SubTask) => void
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
  if (p >= 70) return '#a5b4fc'
  if (p >= 30) return '#818cf8'
  return '#94a3b8'
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
  todo, isSelected, isRunning, timerStartTime, isManualSort, searchQuery, checklist,
  listItems, expanded, pendingItemIds, onToggleExpanded, onToggleListItem,
  onSelect, onToggleDone, onArchive, onUnarchive, onDelete,
  onStartTimer, onStopTimer,
  onDragStart, onDragOver, onDrop, isDragOver
}: {
  todo: Todo; isSelected: boolean; isRunning: boolean; timerStartTime: string | null
  isManualSort: boolean; searchQuery: string
  /** ToDoリストのときだけ渡す */
  checklist?: ChecklistSummary
  listItems?: SubTask[]
  expanded: boolean
  pendingItemIds?: Set<string>
  onToggleExpanded: () => void
  onToggleListItem?: (item: SubTask) => void
  onSelect: () => void; onToggleDone: () => void
  onArchive: () => void; onUnarchive: () => void; onDelete: () => void
  onStartTimer: () => void; onStopTimer: () => void
  onDragStart: () => void; onDragOver: () => void; onDrop: () => void
  isDragOver: boolean
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  // 行の中（行そのものやボタン）にフォーカスがあるとき。マウスを使わない人にも操作ボタンを出す
  const [focusWithin, setFocusWithin] = useState(false)
  const showActions = hovered || focusWithin || isSelected
  const dueColor = todo.status === 'done' ? '' : getDueDateColor(todo.due_date)
  const isArchived = todo.status === 'archived'
  const listMode = Boolean(todo.list_mode)
  const prog = listMode ? 0 : todo.progress ?? 0
  const canExpand = listMode && !isArchived && onToggleListItem != null && (listItems?.length ?? 0) > 0
  const todayKey = toDateKey(new Date())
  const shownItems = canExpand && expanded ? expandedItemsOf(listItems ?? [], todayKey) : []

  return (
    <div
      draggable={isManualSort && !isArchived}
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); onDragOver() }}
      onDrop={(e) => { e.preventDefault(); onDrop() }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Tab で行に入り、Enter（Space）で開く、↑↓で前後の行へ移る。中のボタンのキー操作はそのまま
      data-todo-row=""
      role="listitem"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const rows = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-todo-row]') ?? [])
        rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
      }}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
      }}
      style={{
        cursor: 'pointer', position: 'relative', outlineOffset: -3,
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
            <span style={{ color: '#64748b', fontSize: '0.8rem', cursor: 'grab', flexShrink: 0, marginTop: 2, userSelect: 'none' }}>⠿</span>
          )}

          {/* 完了チェック。ToDoリストは中の項目をチェックして使うので、一覧からは終えられないようにする */}
          {listMode && !isArchived && todo.status !== 'done' ? (
            <span
              title="ToDoリスト。▸ で項目を開くと、ここでチェックできます"
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
                color: isArchived || todo.status === 'done' ? '#94a3b8' : '#e2e8f0',
                textDecoration: todo.status === 'done' || isArchived ? 'line-through' : 'none',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0
              }}>
                <Highlight text={todo.title} query={searchQuery} />
              </span>
              {isRunning && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', background: '#4ade8020', color: '#4ade80', padding: '1px 5px', borderRadius: 99, flexShrink: 0 }}>
                  ●<RunningTimerDisplay startTime={timerStartTime} />
                </span>
              )}
              {todo.recurrence && !isArchived && (
                <span title={`繰り返し: ${todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : '毎月'}`}
                  style={{ fontSize: '0.75rem', color: '#818cf8', flexShrink: 0 }}>🔁</span>
              )}
              {listMode && checklist && !isArchived && (
                <span title={checklistBadgeTitle(checklist)} style={{ fontSize: '0.75rem', color: '#a5b4fc', border: '1px solid #4338ca', borderRadius: 99, padding: '0 6px', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {checklistBadgeText(checklist)}
                </span>
              )}
              {canExpand && (
                <button
                  onClick={(event) => { event.stopPropagation(); onToggleExpanded() }}
                  aria-expanded={expanded}
                  aria-label={expanded ? `${todo.title}の項目を閉じる` : `${todo.title}の項目を開く`}
                  title={expanded ? '項目を閉じる' : '項目を開いて、ここでチェックする'}
                  style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', color: '#a5b4fc', fontSize: '0.72rem', flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}
                >
                  ▸
                </button>
              )}
              {/* 操作ボタン（マウスを乗せたとき・キーボードで選んだとき・選択中）。タイトルの行の右端に置き、2行目（カテゴリ・期限など）の幅は減らさない */}
              {showActions && (
                <div style={{ display: 'flex', gap: 2, flexShrink: 0, marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
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

            {/* 幅が足りないときは詰めずに折り返す（カテゴリ名や期限を読めることを優先する） */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, rowGap: 2, marginTop: 3, minWidth: 0, flexWrap: 'wrap' }}>
              {todo.status === 'on_hold' && <span style={{ fontSize: '0.75rem', color: '#d8b4fe', flexShrink: 0, whiteSpace: 'nowrap' }}>保留中</span>}
              {todo.category_name && (
                <span title={todo.category_name} style={{
                  fontSize: '0.75rem', padding: '1px 5px', borderRadius: 99,
                  background: `${todo.category_color ?? '#6366f1'}30`,
                  color: todo.category_color ?? '#6366f1',
                  // 1文字ずつ縦に折れないようにする。とても長い名前だけ「…」で切る
                  maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>
                  {todo.category_name}
                </span>
              )}
              {todo.priority >= 4 && !isArchived && (
                <span style={{ fontSize: '0.75rem', color: todo.priority === 5 ? '#ef4444' : '#f59e0b', flexShrink: 0 }}>
                  {'!'.repeat(todo.priority - 3)}
                </span>
              )}
              {todo.due_date && !isArchived && (
                <span title={`期限 ${todo.due_date.slice(0, 10)}`} style={{ fontSize: '0.75rem', color: dueColor || '#94a3b8', fontWeight: dueColor ? 700 : 400, whiteSpace: 'nowrap', flexShrink: 0 }}>
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
                <span style={{ fontSize: '0.75rem', color: progressColor(prog), marginLeft: 'auto', flexShrink: 0 }}>
                  {prog}%
                </span>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ToDoリストを開いたときの項目。その場でチェックでき、名前を押すと詳細を開く */}
      {shownItems.length > 0 && (
        <div onClick={(event) => event.stopPropagation()} style={{ padding: '0 12px 8px 37px', display: 'flex', flexDirection: 'column', gap: 0 }}>
          {shownItems.map((item) => (
            <QuickCheckItem
              key={item.id}
              item={item}
              pending={pendingItemIds?.has(item.id) ?? false}
              todayKey={todayKey}
              listTitle={todo.title}
              onToggle={() => onToggleListItem?.(item)}
              onOpen={onSelect}
            />
          ))}
        </div>
      )}
      {canExpand && expanded && shownItems.length === 0 && (
        <div style={{ padding: '0 12px 8px 37px', fontSize: '0.75rem', color: '#94a3b8' }}>まだのやることはありません</div>
      )}

      {/* プログレスバー（ToDoリストは進捗率を使わない） */}
      {!isArchived && !listMode && (
        <div style={{ height: 3, background: '#0f172a' }}>
          <div style={{ height: '100%', width: `${prog}%`, background: progressColor(prog), transition: 'width 0.3s' }} />
        </div>
      )}
    </div>
  )
}

/** 行に渡す操作。どれもタスクの ID（またはタスク）を受け取り、一覧を描き直しても同じ関数のままにする */
interface RowHandlers {
  select: (id: string) => void
  toggleDone: (todo: Todo) => void
  archive: (id: string) => void
  unarchive: (id: string) => void
  remove: (id: string) => void
  startTimer: (id: string) => void
  stopTimer: () => void
  toggleExpanded: (id: string) => void
  dragStart: (id: string) => void
  dragOver: (id: string) => void
  drop: (id: string) => void
}

type TodoRowProps = Omit<React.ComponentProps<typeof TodoItem>,
  'onToggleExpanded' | 'onSelect' | 'onToggleDone' | 'onArchive' | 'onUnarchive' | 'onDelete' | 'onStartTimer' | 'onStopTimer' | 'onDragStart' | 'onDragOver' | 'onDrop'
> & { handlers: RowHandlers }

// 渡すものが変わった行だけ描き直す（タスクを選ぶたびに数百行を描き直さない）
const TodoRow = React.memo(function TodoRow({ handlers, ...props }: TodoRowProps): React.JSX.Element {
  const { todo } = props
  return (
    <TodoItem
      {...props}
      onToggleExpanded={() => handlers.toggleExpanded(todo.id)}
      onSelect={() => handlers.select(todo.id)}
      onToggleDone={() => handlers.toggleDone(todo)}
      onArchive={() => handlers.archive(todo.id)}
      onUnarchive={() => handlers.unarchive(todo.id)}
      onDelete={() => handlers.remove(todo.id)}
      onStartTimer={() => handlers.startTimer(todo.id)}
      onStopTimer={handlers.stopTimer}
      onDragStart={() => handlers.dragStart(todo.id)}
      onDragOver={() => handlers.dragOver(todo.id)}
      onDrop={() => handlers.drop(todo.id)}
    />
  )
})

export function TodoList({
  todos, selectedId, runningTodoId, timerStartTime, isManualSort, searchQuery,
  hasOtherFilters = false, hasAnyTodos = true, onClearSearch, onClearFilters, onAddTodo,
  onSelect, onToggleDone, onArchive, onUnarchive, onDelete, onReorder,
  onStartTimer, onStopTimer, checklistSummaries, listItemsByTodo, pendingItemIds, onToggleListItem
}: Props): React.JSX.Element {
  const [expandedLists, setExpandedLists] = useState<Set<string>>(readExpandedLists)
  const toggleExpanded = (id: string): void => {
    setExpandedLists((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        window.localStorage.setItem(EXPANDED_LISTS_KEY, JSON.stringify([...next]))
      } catch {
        // 保存できなくても開閉はできる
      }
      return next
    })
  }
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

  // 行に渡す操作は1回だけ作り、中から最新の props を呼ぶ（行の memo を効かせるため）
  const latestRef = useRef({ onSelect, onToggleDone, onArchive, onUnarchive, onDelete, onStartTimer, onStopTimer, handleDrop, toggleExpanded })
  latestRef.current = { onSelect, onToggleDone, onArchive, onUnarchive, onDelete, onStartTimer, onStopTimer, handleDrop, toggleExpanded }
  const handlers = useMemo<RowHandlers>(() => ({
    select: (id) => latestRef.current.onSelect(id),
    toggleDone: (todo) => latestRef.current.onToggleDone(todo),
    archive: (id) => latestRef.current.onArchive(id),
    unarchive: (id) => latestRef.current.onUnarchive(id),
    remove: (id) => latestRef.current.onDelete(id),
    startTimer: (id) => { void latestRef.current.onStartTimer(id) },
    stopTimer: () => { void latestRef.current.onStopTimer().catch(() => { /* App displays the error. */ }) },
    toggleExpanded: (id) => latestRef.current.toggleExpanded(id),
    dragStart: (id) => { setDraggedId(id); dragging.current = true },
    dragOver: (id) => { if (dragging.current) setDragOverId(id) },
    drop: (id) => { void latestRef.current.handleDrop(id) }
  }), [])

  if (todos.length === 0 && !hasAnyTodos) {
    return (
      <div style={{ padding: '28px 18px', color: '#cbd5e1', textAlign: 'center' }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0' }}>まだタスクがありません</div>
        <div style={{ marginTop: 8, fontSize: '0.8rem', lineHeight: 1.6, color: '#94a3b8' }}>
          追加したタスクはここに並び、ガントでは開始日から期限までの横棒で表示されます。
        </div>
        {onAddTodo && (
          <button onClick={onAddTodo} style={{ marginTop: 14, padding: '8px 14px', borderRadius: 8, border: '1px solid #2563eb', background: '#1d4ed8', color: '#eff6ff', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700 }}>
            ＋ 最初のタスクを追加
          </button>
        )}
      </div>
    )
  }

  if (todos.length === 0) {
    // 絞り込みで隠れているだけなのに「タスクがありません」と出すと、消えたと思われる
    const filtered = Boolean(searchQuery) || hasOtherFilters
    const emptyButtonStyle: React.CSSProperties = { padding: '6px 10px', borderRadius: 7, border: '1px solid #334155', background: '#172554', color: '#dbeafe', cursor: 'pointer', fontSize: '0.8rem' }
    return (
      <div style={{ padding: 24, color: '#94a3b8', textAlign: 'center', fontSize: '0.9rem' }}>
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
      role="list"
      aria-label="タスク一覧"
      style={{ overflowY: 'auto', height: '100%' }}
      onDragEnd={() => { setDraggedId(null); setDragOverId(null); dragging.current = false }}
    >
      {todos.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          isSelected={selectedId === todo.id}
          isRunning={runningTodoId === todo.id}
          timerStartTime={runningTodoId === todo.id ? timerStartTime : null}
          isManualSort={isManualSort}
          searchQuery={searchQuery}
          checklist={checklistSummaries?.get(todo.id)}
          listItems={listItemsByTodo?.get(todo.id)}
          expanded={expandedLists.has(todo.id)}
          // ToDoリストの行だけが使う。ほかの行は項目のチェック中に描き直さない
          pendingItemIds={todo.list_mode ? pendingItemIds : undefined}
          onToggleListItem={onToggleListItem}
          isDragOver={dragOverId === todo.id}
          handlers={handlers}
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
