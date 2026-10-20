import React, { useState } from 'react'
import type { PublicUser, SubTask, Todo, UpdateSubTaskInput } from '../types'
import { getDueDateColor, toDateKey } from '../lib/dueDate'
import { dropPositionOf, moveIdTo, type DropPosition } from '../lib/reorder'
import {
  ITEM_REPEAT_OPTIONS,
  MONTH_DAY_OPTIONS,
  WEEKDAY_OPTIONS,
  checklistBadgeText,
  duePresets,
  isDueByToday,
  itemPeriodText,
  repeatChoiceOf,
  repeatDayOf,
  repeatFields,
  repeatLabel,
  repeatTitle,
  summarizeChecklist,
  type ItemRepeatChoice
} from '../lib/todoList'
import { dataInk, textOnFill } from '../lib/theme'
import { confirmAction } from '../lib/confirm'

// ToDoリスト（中の項目をチェックして使うタスク。期限はなしでもよい）の中身。項目＝サブタスク。
// 繰り返しの項目は周期が変わると未チェックに戻り、繰り返さない項目はチェックすると「済み」に移る。

interface Props {
  todo: Todo
  /** このタスクのサブタスク（並び順どおり） */
  items: SubTask[]
  users: PublicUser[]
  disabled?: boolean
  /** ToDo タブのように見出しを外に出すときは、見出しと説明を省く */
  compact?: boolean
  onItemsChange: (update: (previous: SubTask[]) => SubTask[]) => void
  /** 削除（元に戻す付き）は詳細画面の処理をそのまま使う */
  onDelete: (id: string) => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

type Group = 'repeat' | 'open' | 'done'

/** 済んだやることは、この日数を過ぎたら「それより前」に畳む */
const RECENT_DONE_DAYS = 7

function groupOf(item: SubTask): Group {
  if (item.recurrence) return 'repeat'
  return item.done ? 'done' : 'open'
}

function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function completedKeyOf(item: SubTask): string | null {
  if (!item.completed_at) return null
  const date = new Date(item.completed_at)
  return Number.isNaN(date.getTime()) ? null : toDateKey(date)
}

/** やることの表示順。期限が過ぎたものを上に（期限の早い順）、ほかは並び順どおり */
function orderOpenItems(items: SubTask[], todayKey: string): SubTask[] {
  const overdue = items
    .filter((item) => item.due_date != null && item.due_date.slice(0, 10) < todayKey)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
  const overdueIds = new Set(overdue.map((item) => item.id))
  return [...overdue, ...items.filter((item) => !overdueIds.has(item.id))]
}

export function TodoChecklist({ todo, items, users, disabled = false, compact = false, onItemsChange, onDelete, onShowToast }: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [repeat, setRepeat] = useState<ItemRepeatChoice>('')
  const [repeatDay, setRepeatDay] = useState<number | null>(null)
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState<string>(todo.assignee_id ?? '')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const [reordering, setReordering] = useState(false)
  const [dragging, setDragging] = useState<{ id: string; group: Group } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null)
  const [showOldDone, setShowOldDone] = useState(false)
  // ToDo タブではリストが並ぶので、項目を追加する欄は押したときだけ開く
  const [formOpen, setFormOpen] = useState(!compact)
  const [clearing, setClearing] = useState(false)
  const activeUsers = users.filter((user) => user.is_active === 1 || user.id === assigneeId)

  const todayKey = toDateKey(new Date())
  const recentLimit = new Date()
  recentLimit.setDate(recentLimit.getDate() - RECENT_DONE_DAYS)
  const recentLimitKey = toDateKey(recentLimit)

  const summary = summarizeChecklist(items, todayKey)
  const repeatItems = items.filter((item) => groupOf(item) === 'repeat')
  const openItems = orderOpenItems(items.filter((item) => groupOf(item) === 'open'), todayKey)
  // 済みは新しく済んだものから。しばらく前に済んだものは畳んでおく
  const doneItems = items.filter((item) => groupOf(item) === 'done')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
  const recentDone = doneItems.filter((item) => (completedKeyOf(item) ?? '') >= recentLimitKey)
  const oldDone = doneItems.filter((item) => (completedKeyOf(item) ?? '') < recentLimitKey)

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

  const displayedOf = (group: Group): SubTask[] => group === 'repeat' ? repeatItems : group === 'open' ? openItems : doneItems

  /** あるまとまりの並びを変える。ほかのまとまりの項目の位置はそのまま */
  const reorderGroup = async (group: Group, groupIds: string[]): Promise<void> => {
    if (reordering) return
    const ordered = items.map((item) => item.id)
    const positions = items.map((item, index) => groupOf(item) === group ? index : -1).filter((index) => index >= 0)
    positions.forEach((position, index) => { ordered[position] = groupIds[index] })
    if (ordered.every((id, index) => id === items[index].id)) return
    const previous = items
    const byId = new Map(items.map((item) => [item.id, item]))
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

  // 同じまとまりの中で、となりの項目と入れ替える（編集欄の ↑↓）
  const move = (item: SubTask, direction: -1 | 1): void => {
    const group = groupOf(item)
    const ids = displayedOf(group).map((candidate) => candidate.id)
    const from = ids.indexOf(item.id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    void reorderGroup(group, ids)
  }

  // ドラッグした項目を、落とした項目の前か後ろへ動かしたときの並び（同じまとまりの中だけ）。並びが変わらないときは null
  const droppedIds = (target: SubTask, position: DropPosition): string[] | null => {
    if (!dragging || dragging.group !== groupOf(target)) return null
    return moveIdTo(displayedOf(dragging.group).map((item) => item.id), dragging.id, target.id, position)
  }

  const dropOn = (target: SubTask, position: DropPosition): void => {
    const ids = droppedIds(target, position)
    if (ids && dragging) void reorderGroup(dragging.group, ids)
  }

  const add = async (): Promise<void> => {
    const titles = title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    if (titles.length === 0 || adding) return
    if (repeat === '' && startDate && dueDate && startDate > dueDate) {
      onShowToast('開始日は期限以前にしてください', 'error')
      return
    }
    setAdding(true)
    // 追加している間も欄は使えるままにし（無効にするとフォーカスが外れ、続けて打った文字が消える）、送った分だけを消す
    const submitted = title
    const restAfterSubmitted = (current: string): string => current.startsWith(submitted) ? current.slice(submitted.length).replace(/^\r?\n/, '') : current
    const created: SubTask[] = []
    try {
      for (const itemTitle of titles) {
        created.push(await window.api.subtaskCreate(todo.id, {
          title: itemTitle,
          assignee_id: users.length > 0 ? assigneeId || null : null,
          // 開始日と期限は繰り返さない項目だけ（繰り返しの項目に持たせると、ガントに毎日のバーが並ぶ）。
          // 開始日を入れると、その日から「今日やること」に出る
          start_date: repeat === '' ? startDate || null : null,
          due_date: repeat === '' ? dueDate || null : null,
          ...repeatFields(repeat, repeatDay)
        }))
      }
      setTitle(restAfterSubmitted)
      setStartDate('')
      setDueDate('')
    } catch (error) {
      setTitle((current) => [titles.slice(created.length).join('\n'), current.startsWith(submitted) ? restAfterSubmitted(current) : ''].filter(Boolean).join('\n'))
      onShowToast(error instanceof Error ? error.message : '項目を追加できませんでした', 'error')
    } finally {
      if (created.length > 0) onItemsChange((previous) => [...previous, ...created])
      setAdding(false)
    }
  }

  const clearOldDone = async (): Promise<void> => {
    if (oldDone.length === 0 || clearing) return
    if (!(await confirmAction(`${RECENT_DONE_DAYS}日より前に済んだやること ${oldDone.length}件を削除しますか？\n報告タブの「期間中に済んだやること」にも出なくなります。元には戻せません。`, { confirmLabel: '削除する', danger: true }))) return
    setClearing(true)
    const removed: string[] = []
    try {
      for (const item of oldDone) {
        await window.api.subtaskDelete(item.id)
        removed.push(item.id)
      }
      onShowToast(`済んだやること ${removed.length}件を削除しました`)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '済んだやることを削除できませんでした', 'error')
    } finally {
      if (removed.length > 0) onItemsChange((previous) => previous.filter((item) => !removed.includes(item.id)))
      setClearing(false)
    }
  }

  const renderItem = (item: SubTask, index: number, groupItems: SubTask[]): React.JSX.Element => {
    if (editingId === item.id) {
      return (
        <ItemEditor
          key={item.id}
          item={item}
          users={users}
          canMoveUp={groupOf(item) !== 'done' && index > 0}
          canMoveDown={groupOf(item) !== 'done' && index < groupItems.length - 1}
          onMove={(direction) => move(item, direction)}
          onCancel={() => setEditingId(null)}
          onSave={async (data) => {
            if (await update(item, data, '項目を保存できませんでした')) setEditingId(null)
          }}
          onDelete={() => { setEditingId(null); onDelete(item.id) }}
          onShowToast={onShowToast}
        />
      )
    }
    const group = groupOf(item)
    const draggable = group !== 'done' && !disabled && !reordering && groupItems.length > 1
    return (
      <div
        key={item.id}
        draggable={draggable}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', item.id)
          setDragging({ id: item.id, group })
        }}
        onDragOver={(event) => {
          if (!dragging || dragging.group !== group) return
          event.preventDefault()
          const position = dropPositionOf(event.clientY, event.currentTarget.getBoundingClientRect())
          const changes = droppedIds(item, position) != null
          event.dataTransfer.dropEffect = changes ? 'move' : 'none'
          if (!changes) {
            if (dropTarget?.id === item.id) setDropTarget(null)
            return
          }
          if (dropTarget?.id !== item.id || dropTarget.position !== position) setDropTarget({ id: item.id, position })
        }}
        onDragLeave={(event) => {
          if (dropTarget?.id === item.id && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dropOn(item, dropPositionOf(event.clientY, event.currentTarget.getBoundingClientRect()))
          setDropTarget(null)
        }}
        onDragEnd={() => { setDragging(null); setDropTarget(null) }}
        style={{
          position: 'relative',
          paddingTop: 2,
          opacity: dragging?.id === item.id ? 0.4 : 1
        }}
      >
        {dropTarget?.id === item.id && (
          // 落とす位置の線（上半分なら前、下半分なら後ろ）
          <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, [dropTarget.position === 'before' ? 'top' : 'bottom']: -1, height: 2, borderRadius: 2, background: 'var(--indigo-500)', pointerEvents: 'none', zIndex: 1 }} />
        )}
        <ItemRow
          item={item}
          todayKey={todayKey}
          draggable={draggable}
          disabled={disabled || pendingIds.has(item.id)}
          onToggle={() => toggle(item)}
          onEdit={() => setEditingId(item.id)}
        />
      </div>
    )
  }

  return (
    <section>
      {!compact && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-control)', color: 'var(--text-subtle)', fontWeight: 700, marginBottom: 8, letterSpacing: '0.05em' }}>
          ToDoリスト
          <span style={{ letterSpacing: 0, color: 'var(--indigo-300)', fontWeight: 700 }}>{checklistBadgeText(summary)}</span>
        </div>
      )}
      <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!compact && (
          <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)', lineHeight: 1.5 }}>
            繰り返しの項目は決めた日が来ると未チェックに戻り、繰り返さない項目はチェックすると「済み」に移ります。項目名か ✎ を押すと編集、⠿ をドラッグすると並べ替えられます。
          </div>
        )}

        {repeatItems.length > 0 && (
          <ItemGroup label="繰り返し" note={summary.repeatTotal > 0 ? `今回 ${summary.repeatDone}/${summary.repeatTotal} 済み` : undefined}>
            {repeatItems.map((item, index) => renderItem(item, index, repeatItems))}
          </ItemGroup>
        )}
        {openItems.length > 0 && (
          <ItemGroup label="やること" note={`${openItems.length}件${summary.todayCount > 0 ? `（今日やる ${summary.todayCount}件）` : ''}`}>
            {openItems.map((item, index) => renderItem(item, index, openItems))}
          </ItemGroup>
        )}
        {items.length === 0 && (
          <div style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)' }}>まだ項目がありません。下の欄から追加してください。</div>
        )}
        {doneItems.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--font-control)', color: 'var(--slate-400)', padding: '2px 0' }}>
              済み {recentDone.length}件{oldDone.length > 0 ? `（ほかに ${RECENT_DONE_DAYS}日より前 ${oldDone.length}件）` : ''}
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 6 }}>
              {recentDone.map((item, index) => renderItem(item, index, recentDone))}
              {recentDone.length === 0 && <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>この{RECENT_DONE_DAYS}日に済んだやることはありません。</div>}
              {oldDone.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 4, fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>
                  {RECENT_DONE_DAYS}日より前に済んだもの {oldDone.length}件
                  <button onClick={() => setShowOldDone((open) => !open)} style={linkButtonStyle}>{showOldDone ? '隠す' : '表示する'}</button>
                  <button onClick={() => void clearOldDone()} disabled={clearing} style={{ ...linkButtonStyle, color: 'var(--red-300)' }}>{clearing ? '削除中…' : 'まとめて削除'}</button>
                </div>
              )}
              {showOldDone && oldDone.map((item, index) => renderItem(item, index, oldDone))}
            </div>
          </details>
        )}

        {!formOpen && (
          <button onClick={() => setFormOpen(true)} disabled={disabled} style={{ alignSelf: 'flex-start', background: 'none', border: '1px dashed var(--slate-700)', borderRadius: 8, padding: '5px 12px', color: 'var(--blue-300)', cursor: 'pointer', fontSize: 'var(--font-control)', fontWeight: 700 }}>
            ＋ 項目を追加
          </button>
        )}
        {formOpen && (
        <form
          onSubmit={(event) => { event.preventDefault(); void add() }}
          style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, border: '1px dashed var(--slate-700)' }}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <textarea
              value={title}
              disabled={disabled}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                // Enter で追加、Shift+Enter で改行（複数行は1行ずつ追加）。日本語変換の確定の Enter では追加しない
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void add()
                }
              }}
              aria-label="追加する項目"
              autoFocus={compact}
              placeholder={items.length === 0 ? '例: メール確認（下で「毎日」を選ぶ）／ 見積もりを送る' : '＋ 項目を追加（Enterで追加・Shift+Enterで改行）'}
              rows={title.includes('\n') ? Math.min(6, title.split('\n').length + 1) : 1}
              style={{ ...inputStyle, flex: 1, resize: 'vertical' }}
            />
            <button type="submit" disabled={!title.trim() || adding} style={buttonStyle(title.trim() && !adding ? 'var(--blue-600)' : 'var(--slate-800)', title.trim() && !adding ? 'var(--on-fill-white)' : 'var(--slate-500)')}>
              {adding ? '追加中…' : '追加'}
            </button>
            {compact && (
              <button type="button" onClick={() => setFormOpen(false)} style={buttonStyle('var(--slate-700)', 'var(--slate-300)')}>閉じる</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
            <RepeatPicker
              choice={repeat}
              day={repeatDay}
              onChange={(choice, day) => { setRepeat(choice); setRepeatDay(day) }}
              labelPrefix="追加する項目の"
            />
            {repeat === '' && (
              <>
                <StartPicker value={startDate} onChange={setStartDate} label="追加する項目の開始日" />
                <DuePicker value={dueDate} onChange={setDueDate} label="追加する項目の期限" />
              </>
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
        )}
      </div>
    </section>
  )
}

/** 繰り返しの選択と、毎週の曜日・毎月の日付 */
function RepeatPicker({ choice, day, onChange, labelPrefix }: {
  choice: ItemRepeatChoice
  day: number | null
  onChange: (choice: ItemRepeatChoice, day: number | null) => void
  labelPrefix: string
}): React.JSX.Element {
  const effectiveDay = repeatDayOf(choice, day)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        繰り返し
        <select
          value={choice}
          onChange={(event) => {
            const next = event.target.value as ItemRepeatChoice
            onChange(next, repeatDayOf(next, null))
          }}
          aria-label={`${labelPrefix}繰り返し`}
          style={smallInputStyle}
        >
          {ITEM_REPEAT_OPTIONS.map((option) => <option key={option.value} value={option.value} title={option.title}>{option.label}</option>)}
        </select>
      </label>
      {choice === 'weekly' && (
        <select
          value={effectiveDay ?? 1}
          onChange={(event) => onChange(choice, Number(event.target.value))}
          aria-label={`${labelPrefix}戻る曜日`}
          title="この曜日に未チェックに戻ります"
          style={smallInputStyle}
        >
          {WEEKDAY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}曜</option>)}
        </select>
      )}
      {choice === 'monthly' && (
        <select
          value={effectiveDay ?? 1}
          onChange={(event) => onChange(choice, Number(event.target.value))}
          aria-label={`${labelPrefix}戻る日`}
          title="この日に未チェックに戻ります（その日がない月は末日）"
          style={smallInputStyle}
        >
          {MONTH_DAY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
    </span>
  )
}

/** 期限の入力。今日・明日・今週中（来週中）はボタン一つで */
function DuePicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      期限
      {duePresets().map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onChange(value === preset.value ? '' : preset.value)}
          aria-pressed={value === preset.value}
          title={`${preset.value}（もう一度押すと期限なし）`}
          style={presetStyle(value === preset.value)}
        >
          {preset.label}
        </button>
      ))}
      <input type="date" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} style={smallInputStyle} />
    </span>
  )
}

/** 開始日の入力。入れると、その日から「今日やること」に出る */
function StartPicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }} title="この日から「今日やること」に出ます">
      開始日
      {duePresets().slice(0, 2).map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onChange(value === preset.value ? '' : preset.value)}
          aria-pressed={value === preset.value}
          title={`${preset.value}（もう一度押すと開始日なし）`}
          style={presetStyle(value === preset.value)}
        >
          {preset.label}
        </button>
      ))}
      <input type="date" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} style={smallInputStyle} />
    </span>
  )
}

function ItemGroup({ label, note, children }: { label: string; note?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', fontWeight: 700, paddingBottom: 2 }}>
        {label}
        {note && <span style={{ fontWeight: 400 }}>{note}</span>}
      </div>
      {children}
    </div>
  )
}

function ItemRow({ item, todayKey, draggable, disabled, onToggle, onEdit }: {
  item: SubTask
  todayKey: string
  draggable: boolean
  disabled: boolean
  onToggle: () => void
  onEdit: () => void
}): React.JSX.Element {
  const done = Boolean(item.done)
  const repeat = repeatLabel(item)
  const dueColor = done ? '' : getDueDateColor(item.due_date)
  const overdue = !done && !item.recurrence && item.due_date != null && item.due_date.slice(0, 10) < todayKey
  const period = itemPeriodText(item)
  const notStarted = !done && item.start_date != null && item.start_date.slice(0, 10) > todayKey
  const checkedAt = done ? formatCheckedAt(item.completed_at) : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 8, background: done ? 'transparent' : overdue ? 'color-mix(in srgb, var(--red-950) 40%, transparent)' : 'color-mix(in srgb, var(--slate-900) 50.2%, transparent)' }}>
      <span
        aria-hidden="true"
        title={draggable ? 'ドラッグして並べ替え' : undefined}
        style={{ width: 10, flexShrink: 0, color: draggable ? 'var(--slate-600)' : 'transparent', cursor: draggable ? 'grab' : 'default', fontSize: 'var(--font-control)', userSelect: 'none' }}
      >
        ⠿
      </span>
      <input
        type="checkbox"
        checked={done}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`${item.title}を${done ? '未チェックに戻す' : 'チェックする'}`}
        style={{ width: 17, height: 17, accentColor: 'var(--green-500)', cursor: disabled ? 'default' : 'pointer', flexShrink: 0, margin: 0 }}
      />
      <button
        onClick={onEdit}
        title="押すと編集できます"
        style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: done ? 'var(--slate-500)' : 'var(--slate-200)', textDecoration: done ? 'line-through' : 'none', fontSize: '0.86rem', overflowWrap: 'anywhere' }}
      >
        {item.title}
      </button>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: 'var(--font-caption)' }}>
        {item.assignee_name && <span style={{ color: dataInk(item.assignee_color ?? 'var(--slate-400)') }}>{item.assignee_name}</span>}
        {period && (
          <span style={{ color: dueColor || (notStarted ? 'var(--text-subtle)' : 'var(--text-subtle)'), fontWeight: dueColor ? 700 : 400 }} title={notStarted ? '開始日が来たら「今日やること」に出ます' : undefined}>
            {overdue ? `${period}（過ぎています）` : period}
          </span>
        )}
        {checkedAt && <span style={{ color: 'var(--green-400)' }} title="チェックした日時">✓ {checkedAt}</span>}
        {repeat && <span title={repeatTitle(item)} style={repeatChipStyle}>{repeat}</span>}
        <button
          onClick={onEdit}
          aria-label={`${item.title}を編集`}
          title="編集（名前・繰り返し・開始日・期限・担当・メモ・並べ替え・削除）"
          style={{ background: 'none', border: 'none', padding: '0 2px', color: 'var(--text-subtle)', cursor: 'pointer', fontSize: 'var(--font-control)' }}
        >
          ✎
        </button>
      </span>
    </div>
  )
}

/**
 * ほかの画面（右の「今日のToDo」・タスク一覧の展開）で使う、チェックだけできる小さな行。
 * 名前を押すと、その ToDoリストの詳細を開く。
 */
export function QuickCheckItem({ item, pending, todayKey, listTitle, showAssignee = false, onToggle, onOpen }: {
  item: SubTask
  pending: boolean
  todayKey: string
  /** どの ToDoリストの項目か（ツールチップ用） */
  listTitle?: string
  showAssignee?: boolean
  onToggle: () => void
  onOpen: () => void
}): React.JSX.Element {
  const done = Boolean(item.done)
  const repeat = repeatLabel(item)
  const overdue = !done && isDueByToday(item, todayKey) && (item.due_date ?? '').slice(0, 10) < todayKey
  const dueColor = done ? '' : getDueDateColor(item.due_date)
  const period = itemPeriodText(item)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 2px', minWidth: 0 }}>
      <input
        type="checkbox"
        checked={done}
        // 保存中も無効にはしない（無効にするとフォーカスが外れ、キーボードで続けてチェックできなかった）。保存中の操作は受け付けない
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        data-quick-check-id={item.id}
        onChange={() => {
          if (pending) return
          onToggle()
          // 並びが変わって行が作り直されても、同じ項目のチェックボックスへフォーカスを戻す
          window.requestAnimationFrame(() => {
            if (document.activeElement && document.activeElement !== document.body && !document.activeElement.hasAttribute('data-focus-region')) return
            document.querySelector<HTMLElement>(`[data-quick-check-id="${CSS.escape(item.id)}"]`)?.focus({ preventScroll: true })
          })
        }}
        onClick={(event) => event.stopPropagation()}
        aria-label={`${item.title}を${done ? '未チェックに戻す' : 'チェックする'}`}
        style={{ width: 15, height: 15, accentColor: 'var(--green-500)', cursor: pending ? 'progress' : 'pointer', flexShrink: 0, margin: 0, opacity: pending ? 0.6 : 1 }}
      />
      <button
        onClick={(event) => { event.stopPropagation(); onOpen() }}
        title={listTitle ? `「${listTitle}」を開く` : 'ToDoリストを開く'}
        style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: done ? 'var(--slate-500)' : 'var(--slate-200)', textDecoration: done ? 'line-through' : 'none', fontSize: 'var(--font-control)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {item.title}
      </button>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontSize: 'var(--font-caption)' }}>
        {showAssignee && item.assignee_name && <span style={{ color: dataInk(item.assignee_color ?? 'var(--slate-400)') }}>{item.assignee_name}</span>}
        {period && (
          <span style={{ color: dueColor || 'var(--text-subtle)', fontWeight: overdue ? 700 : 400 }}>{overdue ? '期限切れ' : period}</span>
        )}
        {repeat && <span title={repeatTitle(item)} style={{ ...repeatChipStyle, padding: '0 5px' }}>{repeat}</span>}
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
  const [repeatDay, setRepeatDay] = useState<number | null>(repeatDayOf(repeatChoiceOf(item), item.recurrence_day))
  const [startDate, setStartDate] = useState(item.start_date?.slice(0, 10) ?? '')
  const [dueDate, setDueDate] = useState(item.due_date?.slice(0, 10) ?? '')
  const [assigneeId, setAssigneeId] = useState(item.assignee_id ?? '')
  const [description, setDescription] = useState(item.description ?? '')
  const [saving, setSaving] = useState(false)
  // 編集を始めたときの値。ほかの人が同時に変えていたら、保存時にサーバーが気づけるように送る
  const [base] = useState(() => ({
    title: item.title,
    description: item.description ?? '',
    recurrence: item.recurrence ?? null,
    recurrence_workdays: item.recurrence_workdays ? 1 : 0,
    recurrence_day: item.recurrence_day ?? null,
    start_date: item.start_date?.slice(0, 10) ?? null,
    due_date: item.due_date?.slice(0, 10) ?? null,
    assignee_id: item.assignee_id ?? null
  }))

  const save = async (): Promise<void> => {
    if (!title.trim()) {
      onShowToast('項目名を入力してください', 'error')
      return
    }
    if (repeat === '' && startDate && dueDate && startDate > dueDate) {
      onShowToast('開始日は期限以前にしてください', 'error')
      return
    }
    const nextRepeat = repeatFields(repeat, repeatDay)
    const data: UpdateSubTaskInput = {}
    const expected: Record<string, unknown> = {}
    const change = <K extends keyof typeof base>(field: K, value: (typeof base)[K]): void => {
      if (value === base[field]) return
      ;(data as Record<string, unknown>)[field] = value
      expected[field] = base[field]
    }
    change('title', title.trim())
    change('description', description)
    change('recurrence', nextRepeat.recurrence)
    change('recurrence_workdays', nextRepeat.recurrence_workdays)
    // 既定（月曜・1日）のままなら null と同じ扱いなので、送らない
    if (nextRepeat.recurrence_day !== repeatDayOf(repeatChoiceOf(base), base.recurrence_day) || nextRepeat.recurrence !== base.recurrence) {
      change('recurrence_day', nextRepeat.recurrence_day)
    }
    // 繰り返しの項目は開始日と期限を持たない
    change('start_date', repeat === '' ? startDate || null : null)
    change('due_date', repeat === '' ? dueDate || null : null)
    if (users.length > 0) change('assignee_id', assigneeId || null)
    if (Object.keys(data).length === 0) {
      onCancel()
      return
    }
    setSaving(true)
    await onSave({ ...data, expected_values: expected })
    setSaving(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 8, border: '1px solid var(--slate-700)', background: 'var(--slate-900)' }}>
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
        <RepeatPicker choice={repeat} day={repeatDay} onChange={(choice, day) => { setRepeat(choice); setRepeatDay(day) }} labelPrefix="項目の" />
        {repeat === '' && (
          <>
            <StartPicker value={startDate} onChange={setStartDate} label="項目の開始日" />
            <DuePicker value={dueDate} onChange={setDueDate} label="項目の期限" />
          </>
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
        <button onClick={() => onMove(-1)} disabled={!canMoveUp} title="ひとつ上へ" aria-label="ひとつ上へ" style={buttonStyle('var(--slate-700)', canMoveUp ? 'var(--slate-200)' : 'var(--slate-600)')}>↑</button>
        <button onClick={() => onMove(1)} disabled={!canMoveDown} title="ひとつ下へ" aria-label="ひとつ下へ" style={buttonStyle('var(--slate-700)', canMoveDown ? 'var(--slate-200)' : 'var(--slate-600)')}>↓</button>
        <button onClick={onDelete} style={buttonStyle('var(--red-900)', 'var(--red-200)')}>削除</button>
        <span style={{ flex: 1 }} />
        <button onClick={onCancel} style={buttonStyle('var(--slate-700)')}>取消</button>
        <button onClick={() => void save()} disabled={saving} style={buttonStyle('var(--blue-600)')}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '7px 9px',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 6,
  color: 'var(--slate-200)',
  fontSize: '0.84rem',
  outline: 'none',
  boxSizing: 'border-box'
}

const smallInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 'auto',
  fontSize: 'var(--font-control)',
  padding: '3px 6px'
}

const repeatChipStyle: React.CSSProperties = {
  color: 'var(--indigo-300)',
  border: '1px solid var(--indigo-700)',
  borderRadius: 999,
  padding: '0 7px',
  whiteSpace: 'nowrap'
}

const linkButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--blue-300)',
  cursor: 'pointer',
  fontSize: 'var(--font-caption)',
  fontWeight: 700
}

function presetStyle(active: boolean): React.CSSProperties {
  return {
    padding: '2px 8px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--indigo-500)' : 'var(--slate-700)'}`,
    background: active ? 'var(--indigo-900)' : 'transparent',
    color: active ? 'var(--indigo-100)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: 'var(--font-caption)',
    fontWeight: 700
  }
}

function buttonStyle(background: string, color = textOnFill(background)): React.CSSProperties {
  return { padding: '5px 11px', background, border: 'none', borderRadius: 6, color, cursor: 'pointer', fontSize: 'var(--font-control)', fontWeight: 'bold', whiteSpace: 'nowrap' }
}
