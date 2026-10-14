import React, { useMemo, useState } from 'react'
import type { PublicUser, SubTask, Todo } from '../types'
import { toDateKey } from '../lib/dueDate'
import {
  buildTodayGroups,
  checklistBadgeText,
  countRemaining,
  isActiveList,
  isMyList,
  summarizeChecklist
} from '../lib/todoList'
import { TodoChecklist } from './TodoChecklist'
import { TodayTodoItems } from './TodayTodo'

// ToDo タブ。ToDoリスト（期限なしで続くタスク）を使う人のための画面。
// 上に「今日やること」、下に ToDoリストごとのチェックリスト（追加・編集・並べ替えもここでできる）。

type ShowToast = (message: string, type?: 'success' | 'error', action?: { label: string; run: () => void }) => void
type Scope = 'mine' | 'all'

interface Props {
  /** 画面表示中のタスク（レンズ適用済み・並び順どおり） */
  todos: Todo[]
  /** ToDoリストの項目（タスクIDごと・並び順どおり） */
  itemsByTodo: Map<string, SubTask[]>
  users: PublicUser[]
  currentUser: PublicUser | null
  pendingIds: Set<string>
  onToggleItem: (item: SubTask) => void
  onItemsChange: (todoId: string, update: (previous: SubTask[]) => SubTask[]) => void
  onSelectTodo: (id: string) => void
  onCreateList: () => void
  onShowToast: ShowToast
}

function readScope(key: string): Scope {
  try {
    return window.localStorage.getItem(key) === 'all' ? 'all' : 'mine'
  } catch {
    return 'mine'
  }
}

export function TodoListsView({ todos, itemsByTodo, users, currentUser, pendingIds, onToggleItem, onItemsChange, onSelectTodo, onCreateList, onShowToast }: Props): React.JSX.Element {
  const multiUser = users.length > 0
  const userId = multiUser ? currentUser?.id ?? null : null
  const scopeKey = `todoView.scope:${userId ?? 'local'}`
  const [scope, setScope] = useState<Scope>(() => readScope(scopeKey))
  const effectiveScope: Scope = multiUser ? scope : 'all'

  const lists = useMemo(() => todos
    .filter(isActiveList)
    .filter((todo) => effectiveScope === 'all' || isMyList(todo, itemsByTodo.get(todo.id) ?? [], userId)),
  [effectiveScope, itemsByTodo, todos, userId])

  // 「今日やること」は、自分のリストなら自分の項目だけ、全員のリストならすべての項目
  const todayGroups = useMemo(
    () => buildTodayGroups(lists, itemsByTodo, effectiveScope === 'mine' ? userId : null),
    [effectiveScope, itemsByTodo, lists, userId]
  )
  const remaining = countRemaining(todayGroups)
  const todayKey = toDateKey(new Date())
  // 表示中の範囲に ToDoリストがない（まだ使っていない・全部終えた）ときは、使い方の案内を出す
  const showIntro = lists.length === 0
  const othersHaveLists = effectiveScope === 'mine' && todos.some(isActiveList)

  const changeScope = (next: Scope): void => {
    setScope(next)
    try {
      window.localStorage.setItem(scopeKey, next)
    } catch {
      // 保存できなくても切り替えはできる
    }
  }

  // 削除は確認してから。トーストの「元に戻す」で同じ位置に作り直す
  const deleteItem = async (todo: Todo, id: string): Promise<void> => {
    const items = itemsByTodo.get(todo.id) ?? []
    const target = items.find((item) => item.id === id)
    if (!target || !window.confirm(`「${target.title}」を削除しますか？`)) return
    const originalIndex = items.findIndex((item) => item.id === id)
    const remainingIds = items.filter((item) => item.id !== id).map((item) => item.id)
    try {
      await window.api.subtaskDelete(id)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '項目を削除できませんでした', 'error')
      return
    }
    onItemsChange(todo.id, (previous) => previous.filter((item) => item.id !== id))
    onShowToast(`「${target.title}」を削除しました`, 'success', {
      label: '元に戻す',
      run: () => {
        void (async () => {
          const created = await window.api.subtaskCreate(todo.id, {
            title: target.title,
            description: target.description,
            assignee_id: target.assignee_id,
            start_date: target.start_date,
            due_date: target.due_date,
            recurrence: target.recurrence,
            recurrence_workdays: target.recurrence_workdays,
            recurrence_day: target.recurrence_day
          })
          if (target.done && !created.done) await window.api.subtaskUpdate(created.id, { done: true })
          const ordered = [...remainingIds]
          ordered.splice(Math.max(0, originalIndex), 0, created.id)
          await window.api.subtaskReorder(todo.id, ordered)
          onShowToast('項目を元の位置へ戻しました')
        })().catch((error) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error'))
      }
    })
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#0f172a' }}>
      <div style={{ padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: '1.15rem', color: '#f8fafc', fontWeight: 800 }}>ToDo</div>
          <div style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 700 }}>{todayKey}</div>
          {multiUser && (
            <div role="group" aria-label="表示するリスト" style={groupStyle}>
              <button onClick={() => changeScope('mine')} aria-pressed={effectiveScope === 'mine'} style={chipStyle(effectiveScope === 'mine')}>自分のリスト</button>
              <button onClick={() => changeScope('all')} aria-pressed={effectiveScope === 'all'} style={chipStyle(effectiveScope === 'all')}>全員のリスト</button>
            </div>
          )}
          <button onClick={onCreateList} style={{ ...primaryButtonStyle, marginLeft: 'auto' }}>＋ ToDoリストを作る</button>
        </div>

        {showIntro && (
          <section aria-label="ToDoリストとは" style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#e0e7ff' }}>ToDoリストを使ってみる</div>
            <div style={{ fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.7 }}>
              ToDoリストは、期限なしで続くチェックリストです。期限を延ばし続けなくても、ずっと使えます。
              <br />・毎日のメール確認や週1回の集計など、決まった作業は「毎日／平日／毎週〇曜／毎月〇日」を付けると、その日に未チェックに戻ります。
              <br />・思いついたやることは、繰り返さずに追加すると、チェックしたときに「済み」へ移ります。期限を付けると、期限が来た日にここの「今日やること」に出ます。
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button onClick={onCreateList} style={primaryButtonStyle}>＋ ToDoリストを作る</button>
              {othersHaveLists && (
                <button onClick={() => changeScope('all')} style={{ background: 'none', border: 'none', padding: 0, color: '#93c5fd', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700 }}>
                  ほかの人の ToDoリストを見る
                </button>
              )}
            </div>
          </section>
        )}

        {!showIntro && (
        <section aria-label="今日やること" style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: '0.92rem', fontWeight: 800, color: '#e0e7ff' }}>今日やること</span>
            <span style={{ fontSize: '0.76rem', color: remaining > 0 ? '#c7d2fe' : '#4ade80' }}>{todayGroups.length === 0 ? '' : remaining > 0 ? `残り ${remaining}` : 'すべて済み'}</span>
            <span style={{ fontSize: '0.7rem', color: '#64748b' }}>繰り返しの項目と、期限が今日までのやること</span>
          </div>
          <TodayTodoItems
            groups={todayGroups}
            pendingIds={pendingIds}
            onToggle={onToggleItem}
            onOpenList={onSelectTodo}
            showAssignee={effectiveScope === 'all'}
          />
        </section>
        )}

        {!showIntro && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16, alignItems: 'start' }}>
            {lists.map((todo) => {
              const items = itemsByTodo.get(todo.id) ?? []
              return (
                <article key={todo.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: todo.category_color ?? '#475569', flexShrink: 0 }} />
                    <button onClick={() => onSelectTodo(todo.id)} title="詳細を開く（名前・担当・説明・進捗ログなど）" style={titleButtonStyle}>{todo.title}</button>
                    {todo.status === 'on_hold' && <span style={{ fontSize: '0.7rem', color: '#d8b4fe' }}>保留中</span>}
                    {multiUser && todo.assignee_name && (
                      <span style={{ fontSize: '0.72rem', color: todo.assignee_color ?? '#94a3b8' }}>{todo.assignee_name}</span>
                    )}
                    <span style={{ fontSize: '0.7rem', color: '#a5b4fc', marginLeft: 'auto' }}>{checklistBadgeText(summarizeChecklist(items, todayKey))}</span>
                  </div>
                  <TodoChecklist
                    key={todo.id}
                    todo={todo}
                    items={items}
                    users={users}
                    compact
                    onItemsChange={(update) => onItemsChange(todo.id, update)}
                    onDelete={(id) => void deleteItem(todo, id)}
                    onShowToast={onShowToast}
                  />
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: 3,
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: 10
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    background: active ? '#2563eb' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 7,
    color: active ? '#eff6ff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '7px 14px',
  background: '#1d4ed8',
  border: '1px solid #2563eb',
  borderRadius: 8,
  color: '#eff6ff',
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

const cardStyle: React.CSSProperties = {
  background: '#0b1220',
  border: '1px solid #312e81',
  borderRadius: 12,
  padding: '14px 16px'
}

const titleButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: '#f1f5f9',
  fontSize: '0.95rem',
  fontWeight: 800,
  textAlign: 'left',
  overflowWrap: 'anywhere'
}
