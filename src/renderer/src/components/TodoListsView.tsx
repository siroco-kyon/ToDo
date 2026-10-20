import React, { useMemo, useState } from 'react'
import type { PublicUser, SubTask, Todo } from '../types'
import { getDueDateColor, toDateKey } from '../lib/dueDate'
import {
  buildTodayGroups,
  checklistBadgeText,
  countRemaining,
  isActiveList,
  isMyList,
  sectionOf,
  summarizeChecklist,
  TODAY_SECTION_LABEL
} from '../lib/todoList'
import { TodoChecklist } from './TodoChecklist'
import { TodayTodoItems } from './TodayTodo'
import { dataInk } from '../lib/theme'
import { confirmAction } from '../lib/confirm'

// ToDo タブ。ToDoリスト（中の項目をチェックして使うタスク）を使う人のための画面。
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
  /** 名前だけで ToDoリストを作る（担当は自分・今日から） */
  onCreateList: (title: string) => Promise<boolean>
  /** カテゴリなども決めて作る（タスク追加の画面を ToDoリストで開く） */
  onCreateListWithDetails: () => void
  onShowToast: ShowToast
}

function readScope(key: string): Scope {
  try {
    return window.localStorage.getItem(key) === 'all' ? 'all' : 'mine'
  } catch {
    return 'mine'
  }
}

export function TodoListsView({ todos, itemsByTodo, users, currentUser, pendingIds, onToggleItem, onItemsChange, onSelectTodo, onCreateList, onCreateListWithDetails, onShowToast }: Props): React.JSX.Element {
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
  // 「残り」には今週・今月の分も入る。「今日やる」が全部済んでいても残りが出て食い違って見えるので、内訳を添える
  const remainingBySection = (['today', 'week', 'month'] as const).map((section) => ({
    section,
    count: todayGroups.reduce((sum, group) => sum + group.items.filter((item) => !item.done && sectionOf(item) === section).length, 0)
  })).filter((entry) => entry.count > 0)
  const remainingDetail = remainingBySection.length > 1 || remainingBySection.some((entry) => entry.section !== 'today')
    ? `（${remainingBySection.map((entry) => `${TODAY_SECTION_LABEL[entry.section].label} ${entry.count}`).join('・')}）`
    : ''
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
    if (!target || !(await confirmAction(`「${target.title}」を削除しますか？`, { confirmLabel: '削除する', danger: true }))) return
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
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--slate-900)' }}>
      <div style={{ padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: '1.15rem', color: 'var(--slate-50)', fontWeight: 800 }}>ToDo</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--slate-400)', fontWeight: 700 }}>{todayKey}</div>
          {multiUser && (
            <div role="group" aria-label="表示するリスト" style={groupStyle}>
              <button onClick={() => changeScope('mine')} aria-pressed={effectiveScope === 'mine'} style={chipStyle(effectiveScope === 'mine')}>自分のリスト</button>
              <button onClick={() => changeScope('all')} aria-pressed={effectiveScope === 'all'} style={chipStyle(effectiveScope === 'all')}>全員のリスト</button>
            </div>
          )}
          <NewListForm onCreate={onCreateList} onCreateWithDetails={onCreateListWithDetails} />
        </div>

        {showIntro && (
          <section aria-label="ToDoリストとは" style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--indigo-100)' }}>ToDoリストを使ってみる</div>
            <div style={{ fontSize: '0.82rem', color: 'var(--slate-300)', lineHeight: 1.7 }}>
              ToDoリストは、毎日・毎週のチェックや細かいやることをまとめるリストです。期限を決めなくても使えるので、延長し続けなくてもかまいません（期限を決めたいときは「詳しく設定して作る」か、作ったあとの詳細で入れられます）。
              <br />・毎日のメール確認や週1回の集計など、決まった作業は「毎日／平日／毎週〇曜／毎月〇日」を付けると、その日に未チェックに戻ります。
              <br />・思いついたやることは、繰り返さずに追加すると、チェックしたときに「済み」へ移ります。開始日を付けるとその日から、期限だけを付けると期限の日から、ここの「今日やること」に出ます。
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--slate-400)' }}>
              上の欄に名前（例: 毎日のルーティン・今週のやること）を入れて「作る」を押すと始められます。
              {othersHaveLists && (
                <button onClick={() => changeScope('all')} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue-300)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700 }}>
                  ほかの人の ToDoリストを見る
                </button>
              )}
            </div>
          </section>
        )}

        {!showIntro && (
        <section aria-label="今日やること" style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--indigo-100)' }}>今日やること</span>
            <span style={{ fontSize: '0.76rem', color: remaining > 0 ? 'var(--indigo-200)' : 'var(--green-400)' }}>{todayGroups.length === 0 ? '' : remaining > 0 ? `残り ${remaining}${remainingDetail}` : 'すべて済み'}</span>
            <span style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>各リストから、今日やる項目をまとめて表示</span>
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
          <details open={todayGroups.length === 0 || undefined} style={{ borderTop: '1px solid var(--slate-700)', paddingTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--slate-200)', fontSize: '0.9rem', padding: '6px 0' }}>リストと項目を管理・追加する（{lists.length}リスト）</summary>
          <p style={{ margin: '6px 0 14px', color: 'var(--text-subtle)', fontSize: 'var(--font-caption)' }}>上の「今日やること」と同じ項目です。ここでは、日付・繰り返しの設定や項目の追加ができます。</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start' }}>
            {lists.map((todo) => {
              const items = itemsByTodo.get(todo.id) ?? []
              return (
                <article key={todo.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: todo.category_color ?? 'var(--slate-600)', flexShrink: 0 }} />
                    <button onClick={() => onSelectTodo(todo.id)} title="詳細を開く（名前・担当・説明・進捗ログなど）" style={titleButtonStyle}>{todo.title}</button>
                    {todo.status === 'on_hold' && <span style={{ fontSize: '0.7rem', color: 'var(--purple-300)' }}>保留中</span>}
                    {multiUser && todo.assignee_name && (
                      <span style={{ fontSize: '0.72rem', color: dataInk(todo.assignee_color ?? 'var(--slate-400)') }}>{todo.assignee_name}</span>
                    )}
                    {todo.due_date && (
                      <span title="この ToDoリストの期限" style={{ fontSize: '0.72rem', color: getDueDateColor(todo.due_date) || 'var(--slate-400)', fontWeight: getDueDateColor(todo.due_date) ? 700 : 400 }}>
                        期限 {Number(todo.due_date.slice(5, 7))}/{Number(todo.due_date.slice(8, 10))}
                      </span>
                    )}
                    <span style={{ fontSize: '0.7rem', color: 'var(--indigo-300)', marginLeft: 'auto' }}>{checklistBadgeText(summarizeChecklist(items, todayKey))}</span>
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
          </details>
        )}
      </div>
    </div>
  )
}

/** 名前だけで ToDoリストを作る欄 */
function NewListForm({ onCreate, onCreateWithDetails }: { onCreate: (title: string) => Promise<boolean>; onCreateWithDetails: () => void }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const submit = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || creating) return
    setCreating(true)
    if (await onCreate(trimmed)) setTitle('')
    setCreating(false)
  }
  return (
    <form
      onSubmit={(event) => { event.preventDefault(); void submit() }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}
    >
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="新しい ToDoリストの名前"
        aria-label="新しい ToDoリストの名前"
        disabled={creating}
        style={{ padding: '7px 10px', background: 'var(--c-0b1220)', border: '1px solid var(--slate-700)', borderRadius: 8, color: 'var(--slate-200)', fontSize: '0.82rem', width: 220, outline: 'none' }}
      />
      <button type="submit" disabled={!title.trim() || creating} style={{ ...primaryButtonStyle, opacity: title.trim() && !creating ? 1 : 0.5 }}>
        {creating ? '作成中…' : '作る'}
      </button>
      <button type="button" onClick={onCreateWithDetails} title="カテゴリや担当なども決めて作ります" style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue-300)', cursor: 'pointer', fontSize: '0.74rem', fontWeight: 700 }}>
        詳しく設定して作る
      </button>
    </form>
  )
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: 3,
  background: 'var(--gray-900)',
  border: '1px solid var(--gray-800)',
  borderRadius: 10
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    background: active ? 'var(--blue-600)' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 7,
    color: active ? 'var(--on-fill-blue-50)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '7px 14px',
  background: 'var(--blue-700)',
  border: '1px solid var(--blue-600)',
  borderRadius: 8,
  color: 'var(--on-fill-blue-50)',
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

const cardStyle: React.CSSProperties = {
  background: 'var(--c-0b1220)',
  border: '1px solid var(--indigo-900)',
  borderRadius: 12,
  padding: '14px 16px'
}

const titleButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--slate-100)',
  fontSize: '0.95rem',
  fontWeight: 800,
  textAlign: 'left',
  overflowWrap: 'anywhere'
}
