import React, { useState } from 'react'
import type { PublicUser, SubTask, Todo, UpdateSubTaskInput } from '../types'
import { getDueDateColor } from '../lib/dueDate'
import {
  ITEM_REPEAT_OPTIONS,
  checklistBadgeText,
  repeatChoiceOf,
  repeatFields,
  repeatLabel,
  summarizeChecklist,
  type ItemRepeatChoice
} from '../lib/todoList'

// ToDoリスト（期限を持たずに続くタスク）の中身。項目＝サブタスク。
// 繰り返しの項目は周期が変わると未チェックに戻り、繰り返さない項目はチェックすると「済み」に移る。

interface Props {
  todo: Todo
  /** このタスクのサブタスク（並び順どおり） */
  items: SubTask[]
  users: PublicUser[]
  disabled?: boolean
  onItemsChange: (update: (previous: SubTask[]) => SubTask[]) => void
  /** 削除（元に戻す付き）は詳細画面の処理をそのまま使う */
  onDelete: (id: string) => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

type Group = 'repeat' | 'open' | 'done'

function groupOf(item: SubTask): Group {
  if (item.recurrence) return 'repeat'
  return item.done ? 'done' : 'open'
}

function formatShortDate(dateKey: string): string {
  const [, m, d] = dateKey.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}`
}

function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function TodoChecklist({ todo, items, users, disabled = false, onItemsChange, onDelete, onShowToast }: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [repeat, setRepeat] = useState<ItemRepeatChoice>('')
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState<string>(todo.assignee_id ?? '')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const [reordering, setReordering] = useState(false)
  const activeUsers = users.filter((user) => user.is_active === 1 || user.id === assigneeId)

  const summary = summarizeChecklist(items)
  const repeatItems = items.filter((item) => groupOf(item) === 'repeat')
  const openItems = items.filter((item) => groupOf(item) === 'open')
  // 済みは新しく済んだものから
  const doneItems = items.filter((item) => groupOf(item) === 'done')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))

  const replaceItem = (updated: SubTask): void => {
    onItemsChange((previous) => previous.map((item) => item.id === updated.id ? updated : item))
  }

  const update = async (item: SubTask, data: UpdateSubTaskInput, failure: string): Promise<boolean> => {
    if (pendingIds.has(item.id)) return false
    setPendingIds((previous) => new Set(previous).add(item.id))
    try {
      replaceItem(await window.api.subtaskUpdate(item.id, data))
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : failure, 'error')
      return false
    } finally {
      setPendingIds((previous) => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
    }
  }

  const toggle = (item: SubTask): void => {
    void update(item, { done: !item.done, expected_values: { done: Boolean(item.done) } }, '項目を更新できませんでした')
  }

  // 同じまとまり（繰り返し／やること）の中で、となりの項目と入れ替える
  const move = async (item: SubTask, direction: -1 | 1): Promise<void> => {
    if (reordering) return
    const group = groupOf(item)
    const sameGroup = items.filter((candidate) => groupOf(candidate) === group)
    const neighbor = sameGroup[sameGroup.findIndex((candidate) => candidate.id === item.id) + direction]
    if (!neighbor) return
    const ordered = items.map((candidate) => candidate.id)
    const from = ordered.indexOf(item.id)
    const to = ordered.indexOf(neighbor.id)
    ordered[from] = neighbor.id
    ordered[to] = item.id
    const previous = items
    const byId = new Map(items.map((candidate) => [candidate.id, candidate]))
    onItemsChange(() => ordered.map((id, index) => ({ ...byId.get(id)!, sort_order: index })))
    setReordering(true)
    try {
      await window.api.subtaskReorder(todo.id, ordered)
    } catch (error) {
      onItemsChange(() => previous)
      onShowToast(error instanceof Error ? error.message : '並べ替えできませんでした', 'error')
    } finally {
      setReordering(false)
    }
  }

  const add = async (): Promise<void> => {
    const titles = title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    if (titles.length === 0 || adding) return
    setAdding(true)
    const created: SubTask[] = []
    try {
      for (const itemTitle of titles) {
        created.push(await window.api.subtaskCreate(todo.id, {
          title: itemTitle,
          assignee_id: users.length > 0 ? assigneeId || null : null,
          // ToDoリストの項目は開始日を持たせない（ガントに毎日のバーが並ばないように）。期限は繰り返さない項目だけ
          start_date: null,
          due_date: repeat === '' ? dueDate || null : null,
          ...repeatFields(repeat)
        }))
      }
      setTitle('')
      setDueDate('')
    } catch (error) {
      setTitle(titles.slice(created.length).join('\n'))
      onShowToast(error instanceof Error ? error.message : '項目を追加できませんでした', 'error')
    } finally {
      if (created.length > 0) onItemsChange((previous) => [...previous, ...created])
      setAdding(false)
    }
  }

  const renderItem = (item: SubTask, index: number, groupItems: SubTask[]): React.JSX.Element => editingId === item.id ? (
    <ItemEditor
      key={item.id}
      item={item}
      users={users}
      canMoveUp={index > 0}
      canMoveDown={index < groupItems.length - 1}
      onMove={(direction) => void move(item, direction)}
      onCancel={() => setEditingId(null)}
      onSave={async (data) => {
        if (await update(item, data, '項目を保存できませんでした')) setEditingId(null)
      }}
      onDelete={() => { setEditingId(null); onDelete(item.id) }}
      onShowToast={onShowToast}
    />
  ) : (
    <ItemRow
      key={item.id}
      item={item}
      disabled={disabled || pendingIds.has(item.id)}
      onToggle={() => toggle(item)}
      onEdit={() => setEditingId(item.id)}
    />
  )

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: '0.75rem', color: '#64748b', fontWeight: 700, marginBottom: 8, letterSpacing: '0.05em' }}>
        ToDoリスト
        <span style={{ letterSpacing: 0, color: '#a5b4fc', fontWeight: 700 }}>{checklistBadgeText(summary)}</span>
      </div>
      <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: '0.74rem', color: '#94a3b8', lineHeight: 1.5 }}>
          期限なしで続くタスクです。繰り返しの項目は周期が変わると未チェックに戻り（毎週は月曜・毎月は1日）、繰り返さない項目はチェックすると「済み」に移ります。項目名を押すと編集できます。
        </div>

        {repeatItems.length > 0 && (
          <ItemGroup label="繰り返し" note={summary.repeatTotal > 0 ? `今回 ${summary.repeatDone}/${summary.repeatTotal} 済み` : undefined}>
            {repeatItems.map((item, index) => renderItem(item, index, repeatItems))}
          </ItemGroup>
        )}
        {openItems.length > 0 && (
          <ItemGroup label="やること" note={`${openItems.length}件`}>
            {openItems.map((item, index) => renderItem(item, index, openItems))}
          </ItemGroup>
        )}
        {items.length === 0 && (
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>まだ項目がありません。下の欄から追加してください。</div>
        )}
        {doneItems.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: '0.76rem', color: '#94a3b8', padding: '2px 0' }}>済み {doneItems.length}件</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 6 }}>
              {doneItems.map((item, index) => renderItem(item, index, doneItems))}
            </div>
          </details>
        )}

        <form
          onSubmit={(event) => { event.preventDefault(); void add() }}
          style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, border: '1px dashed #334155' }}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <textarea
              value={title}
              disabled={disabled || adding}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                // Enter で追加、Shift+Enter で改行（複数行は1行ずつ追加）。日本語変換の確定の Enter では追加しない
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void add()
                }
              }}
              aria-label="追加する項目"
              placeholder="＋ 項目を追加（Enterで追加・Shift+Enterで改行）"
              rows={title.includes('\n') ? Math.min(6, title.split('\n').length + 1) : 1}
              style={{ ...inputStyle, flex: 1, resize: 'vertical' }}
            />
            <button type="submit" disabled={!title.trim() || adding} style={buttonStyle(title.trim() && !adding ? '#2563eb' : '#1e293b', title.trim() && !adding ? '#fff' : '#64748b')}>
              {adding ? '追加中…' : '追加'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.72rem', color: '#94a3b8' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              繰り返し
              <select value={repeat} onChange={(event) => setRepeat(event.target.value as ItemRepeatChoice)} aria-label="追加する項目の繰り返し" style={smallInputStyle}>
                {ITEM_REPEAT_OPTIONS.map((option) => <option key={option.value} value={option.value} title={option.title}>{option.label}</option>)}
              </select>
            </label>
            {repeat === '' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                期限
                <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="追加する項目の期限" style={smallInputStyle} />
              </label>
            )}
            {users.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                担当
                <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} aria-label="追加する項目の担当" style={smallInputStyle}>
                  <option value="">担当なし</option>
                  {activeUsers.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
                </select>
              </label>
            )}
          </div>
        </form>
      </div>
    </section>
  )
}

function ItemGroup({ label, note, children }: { label: string; note?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: '0.7rem', color: '#64748b', fontWeight: 700, paddingBottom: 2 }}>
        {label}
        {note && <span style={{ fontWeight: 400 }}>{note}</span>}
      </div>
      {children}
    </div>
  )
}

function ItemRow({ item, disabled, onToggle, onEdit }: { item: SubTask; disabled: boolean; onToggle: () => void; onEdit: () => void }): React.JSX.Element {
  const done = Boolean(item.done)
  const repeat = repeatLabel(item)
  const repeatTitle = ITEM_REPEAT_OPTIONS.find((option) => option.value === repeatChoiceOf(item))?.title
  const dueColor = done ? '' : getDueDateColor(item.due_date)
  const checkedAt = done ? formatCheckedAt(item.completed_at) : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 8, background: done ? 'transparent' : '#0f172a80' }}>
      <input
        type="checkbox"
        checked={done}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`${item.title}を${done ? '未チェックに戻す' : 'チェックする'}`}
        style={{ width: 17, height: 17, accentColor: '#22c55e', cursor: disabled ? 'default' : 'pointer', flexShrink: 0, margin: 0 }}
      />
      <button
        onClick={onEdit}
        title="押すと編集できます"
        style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: done ? '#64748b' : '#e2e8f0', textDecoration: done ? 'line-through' : 'none', fontSize: '0.86rem', overflowWrap: 'anywhere' }}
      >
        {item.title}
      </button>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: '0.7rem' }}>
        {item.assignee_name && <span style={{ color: item.assignee_color ?? '#94a3b8' }}>{item.assignee_name}</span>}
        {!item.recurrence && item.due_date && (
          <span style={{ color: dueColor || '#64748b', fontWeight: dueColor ? 700 : 400 }}>{formatShortDate(item.due_date)}まで</span>
        )}
        {checkedAt && <span style={{ color: '#4ade80' }} title="チェックした日時">✓ {checkedAt}</span>}
        {repeat && <span title={repeatTitle} style={{ color: '#a5b4fc', border: '1px solid #4338ca', borderRadius: 999, padding: '0 7px' }}>{repeat}</span>}
      </span>
    </div>
  )
}

function ItemEditor({ item, users, canMoveUp, canMoveDown, onMove, onCancel, onSave, onDelete, onShowToast }: {
  item: SubTask
  users: PublicUser[]
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (direction: -1 | 1) => void
  onCancel: () => void
  onSave: (data: UpdateSubTaskInput) => Promise<void>
  onDelete: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}): React.JSX.Element {
  const [title, setTitle] = useState(item.title)
  const [repeat, setRepeat] = useState<ItemRepeatChoice>(repeatChoiceOf(item))
  const [dueDate, setDueDate] = useState(item.due_date?.slice(0, 10) ?? '')
  const [assigneeId, setAssigneeId] = useState(item.assignee_id ?? '')
  const [description, setDescription] = useState(item.description ?? '')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!title.trim()) {
      onShowToast('項目名を入力してください', 'error')
      return
    }
    const nextRepeat = repeatFields(repeat)
    const data: UpdateSubTaskInput = {}
    if (title.trim() !== item.title) data.title = title.trim()
    if (description !== (item.description ?? '')) data.description = description
    if (nextRepeat.recurrence !== (item.recurrence ?? null)) data.recurrence = nextRepeat.recurrence
    if (nextRepeat.recurrence_workdays !== (item.recurrence_workdays ? 1 : 0)) data.recurrence_workdays = nextRepeat.recurrence_workdays
    // 繰り返しの項目は期限を持たない
    const nextDue = repeat === '' ? dueDate || null : null
    if (nextDue !== (item.due_date?.slice(0, 10) ?? null)) data.due_date = nextDue
    if (users.length > 0 && (assigneeId || null) !== (item.assignee_id ?? null)) data.assignee_id = assigneeId || null
    if (Object.keys(data).length === 0) {
      onCancel()
      return
    }
    setSaving(true)
    await onSave(data)
    setSaving(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 8, border: '1px solid #334155', background: '#0f172a' }}>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save()
          if (event.key === 'Escape') onCancel()
        }}
        aria-label="項目名"
        autoFocus
        style={inputStyle}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.72rem', color: '#94a3b8' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          繰り返し
          <select value={repeat} onChange={(event) => setRepeat(event.target.value as ItemRepeatChoice)} aria-label="項目の繰り返し" style={smallInputStyle}>
            {ITEM_REPEAT_OPTIONS.map((option) => <option key={option.value} value={option.value} title={option.title}>{option.label}</option>)}
          </select>
        </label>
        {repeat === '' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            期限
            <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="項目の期限" style={smallInputStyle} />
          </label>
        )}
        {users.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            担当
            <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} aria-label="項目の担当" style={smallInputStyle}>
              <option value="">担当なし</option>
              {users.filter((user) => user.is_active === 1 || user.id === assigneeId).map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
            </select>
          </label>
        )}
      </div>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="メモ..." aria-label="項目のメモ" rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => onMove(-1)} disabled={!canMoveUp} title="ひとつ上へ" aria-label="ひとつ上へ" style={buttonStyle('#334155', canMoveUp ? '#e2e8f0' : '#475569')}>↑</button>
        <button onClick={() => onMove(1)} disabled={!canMoveDown} title="ひとつ下へ" aria-label="ひとつ下へ" style={buttonStyle('#334155', canMoveDown ? '#e2e8f0' : '#475569')}>↓</button>
        <button onClick={onDelete} style={buttonStyle('#7f1d1d', '#fecaca')}>削除</button>
        <span style={{ flex: 1 }} />
        <button onClick={onCancel} style={buttonStyle('#334155')}>取消</button>
        <button onClick={() => void save()} disabled={saving} style={buttonStyle('#2563eb')}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '7px 9px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: '0.84rem',
  outline: 'none',
  boxSizing: 'border-box'
}

const smallInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 'auto',
  fontSize: '0.76rem',
  padding: '3px 6px'
}

function buttonStyle(background: string, color = '#fff'): React.CSSProperties {
  return { padding: '5px 11px', background, border: 'none', borderRadius: 6, color, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 'bold', whiteSpace: 'nowrap' }
}
