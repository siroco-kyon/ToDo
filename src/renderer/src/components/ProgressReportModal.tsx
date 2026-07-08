import React, { useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { writeTaskReportSnapshot } from '../lib/taskReportSnapshot'
import type {
  ProgressDigest,
  ProgressDigestNote,
  ProgressDigestTaskChange,
  ProgressDigestUser,
  ProgressNote,
  ProgressNoteComment,
  PublicUser,
  SubTask,
  Todo,
  TodoStatus
} from '../types'

interface Props {
  users: PublicUser[]
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
  /** true のとき自分の活動だけを集計する個人サマリーとして動く（メンバー選択を隠す） */
  selfOnly?: boolean
  currentUser?: PublicUser | null
  /** false のときプライベートカテゴリのタスクを集計から除外（全体レンズ） */
  includePrivate?: boolean
  /** 現在のタスク一覧（フィルタ・ソート済み）。タスク別レポートをこの並び順で出す */
  visibleTodos: Todo[]
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  not_started: '未着手',
  active: '進行中',
  done: '完了',
  archived: 'アーカイブ'
}

const STATUS_COLOR: Record<TodoStatus, string> = {
  not_started: '#64748b',
  active: '#3b82f6',
  done: '#22c55e',
  archived: '#475569'
}

const CHANGE_FIELD_LABEL: Record<string, string> = {
  title: 'タイトル',
  description: '説明',
  memo: 'メモ',
  category: 'カテゴリ',
  assignee: '主担当',
  co_assignees: 'サブ担当',
  status: 'ステータス',
  priority: '優先度',
  progress: '進捗',
  start_date: '開始日',
  due_date: '締切日',
  recurrence: '繰り返し',
  recurrence_copy_subtasks: 'サブタスク引継ぎ'
}

const RECURRENCE_LABEL: Record<string, string> = {
  daily: '毎日',
  weekly: '毎週',
  monthly: '毎月'
}

interface TaskActivityEvent {
  id: string
  kind: 'change' | 'note'
  created_at: string
  change?: ProgressDigestTaskChange
  note?: ProgressDigestNote
}

interface TaskActivityGroup {
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  events: TaskActivityEvent[]
}

function toDateInput(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function formatMinutes(min: number): string {
  if (min <= 0) return '0分'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`
  return `${m}分`
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const m = date.getMonth() + 1
  const d = date.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${m}/${d} ${hh}:${mm}`
}

/** 日付のみの文字列（YYYY-MM-DD）をローカル日付の0時としてパースする */
function parseDateOnly(dateKey: string): Date {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** タスク一覧と同じ配色規約: 期限切れは赤、当日は橙、3日以内は黄。時刻ではなく暦日で比較する */
function getDueDateColor(dueDate: string | null): string {
  if (!dueDate) return ''
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = (parseDateOnly(dueDate).getTime() - today.getTime()) / 86400000
  if (diffDays < 0) return '#ef4444'
  if (diffDays < 1) return '#f97316'
  if (diffDays <= 3) return '#f59e0b'
  return ''
}

function compactText(value: string | null): string {
  if (!value) return '未設定'
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact
}

function formatChangeValue(field: string, value: string | null): string {
  if (field === 'status' && value) return STATUS_LABEL[value as TodoStatus] ?? value
  if (field === 'progress' && value) return `${value}%`
  if (field === 'priority' && value) return `レベル${value}`
  if (field === 'recurrence' && value) return RECURRENCE_LABEL[value] ?? value
  if (field === 'recurrence_copy_subtasks') return value === '1' ? 'する' : 'しない'
  return compactText(value)
}

function formatTaskChange(change: ProgressDigestTaskChange): string {
  const label = CHANGE_FIELD_LABEL[change.field] ?? change.field
  return `${label}: ${formatChangeValue(change.field, change.old_value)} → ${formatChangeValue(change.field, change.new_value)}`
}

function buildTaskActivityGroups(user: ProgressDigestUser): TaskActivityGroup[] {
  const groups = new Map<string, TaskActivityGroup>()
  const ensureGroup = (
    todoId: string,
    todoTitle: string,
    categoryName: string | null = null,
    categoryColor: string | null = null
  ): TaskActivityGroup => {
    const existing = groups.get(todoId)
    if (existing) {
      if (!existing.category_name && categoryName) existing.category_name = categoryName
      if (!existing.category_color && categoryColor) existing.category_color = categoryColor
      return existing
    }
    const created: TaskActivityGroup = { todo_id: todoId, todo_title: todoTitle, category_name: categoryName, category_color: categoryColor, events: [] }
    groups.set(todoId, created)
    return created
  }

  for (const change of user.task_changes ?? []) {
    ensureGroup(change.todo_id, change.todo_title, change.category_name, change.category_color).events.push({
      id: `change:${change.id}`,
      kind: 'change',
      created_at: change.created_at,
      change
    })
  }
  for (const note of user.notes) {
    ensureGroup(note.todo_id, note.todo_title).events.push({
      id: `note:${note.id}`,
      kind: 'note',
      created_at: note.created_at,
      note
    })
  }

  return [...groups.values()]
    .map((group) => ({ ...group, events: group.events.sort((a, b) => a.created_at.localeCompare(b.created_at)) }))
    .sort((a, b) => {
      const aLatest = a.events[a.events.length - 1]?.created_at ?? ''
      const bLatest = b.events[b.events.length - 1]?.created_at ?? ''
      return bLatest.localeCompare(aLatest)
    })
}

export interface TaskReportRow {
  todo: Todo
  notes: ProgressNote[]
  subTasks: SubTask[]
}

/** タスク一覧の表示順そのままに、各タスクの進捗ノート（コメント込み）とサブタスクを紐付ける */
function buildPerTaskReport(todos: Todo[], notes: ProgressNote[], subTasks: SubTask[]): TaskReportRow[] {
  return todos
    .filter((todo) => todo.status !== 'archived')
    .map((todo) => ({
      todo,
      notes: notes.filter((note) => note.todo_id === todo.id),
      subTasks: subTasks
        .filter((sub) => sub.todo_id === todo.id)
        .sort((a, b) => a.sort_order - b.sort_order)
    }))
}

export interface TaskReportCategoryGroup {
  category_name: string | null
  category_color: string | null
  rows: TaskReportRow[]
}

/** カテゴリごとに見出しでまとめる。初出順を保ち、未分類は最後に回す */
export function groupPerTaskReportByCategory(rows: TaskReportRow[]): TaskReportCategoryGroup[] {
  const groups = new Map<string, TaskReportCategoryGroup>()
  let uncategorized: TaskReportCategoryGroup | null = null

  for (const row of rows) {
    const key = row.todo.category_id
    if (!key) {
      if (!uncategorized) uncategorized = { category_name: '未分類', category_color: null, rows: [] }
      uncategorized.rows.push(row)
      continue
    }
    let group = groups.get(key)
    if (!group) {
      group = { category_name: row.todo.category_name, category_color: row.todo.category_color, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }

  const ordered = [...groups.values()]
  if (uncategorized) ordered.push(uncategorized)
  return ordered
}

function renderCommentThread(comments: ProgressNoteComment[], depth: number): string[] {
  const lines: string[] = []
  for (const comment of comments) {
    lines.push(`${'  '.repeat(depth)}- ↳ ${comment.author_name ?? '不明'}: ${compactText(comment.body)}`)
    lines.push(...renderCommentThread(comment.replies, depth + 1))
  }
  return lines
}

/** 担当・サブ担当をまとめて「担当: X（副: Y、Z）」の形にする。誰もいなければ null */
function formatAssignees(todo: Todo): string | null {
  const co = (todo.co_assignees ?? []).map((c) => c.display_name)
  if (!todo.assignee_name && co.length === 0) return null
  const main = todo.assignee_name ? `担当: ${todo.assignee_name}` : '担当: 未割り当て'
  return co.length > 0 ? `${main}（副: ${co.join('、')}）` : main
}

/** 集計結果を日報・週報に貼れる Markdown に変換する */
/** タスク別レポートの行をMarkdownに変換する（別ウィンドウのコピー機能でも使う） */
export function perTaskReportToMarkdown(rows: TaskReportRow[]): string {
  const lines: string[] = []
  for (const group of groupPerTaskReportByCategory(rows)) {
    lines.push(`### ${group.category_name ?? '未分類'}`)
    for (const row of group.rows) {
      const due = row.todo.due_date ? `期限 ${row.todo.due_date.slice(0, 10)}` : '期限なし'
      const priority = row.todo.priority >= 4 ? `・${'!'.repeat(row.todo.priority - 3)}` : ''
      const assignees = formatAssignees(row.todo)
      lines.push(`#### ${row.todo.title}（${row.todo.progress}%・${due}${priority}）`)
      if (assignees) lines.push(`- ${assignees}`)
      if (row.todo.memo) {
        lines.push(`> ${row.todo.memo.replace(/\r?\n/g, ' ')}`)
      }
      if (row.subTasks.length > 0) {
        for (const sub of row.subTasks) {
          const subDue = sub.due_date ? `期限 ${sub.due_date.slice(0, 10)}` : ''
          lines.push(`- [${sub.done ? 'x' : ' '}] ${sub.title}（${sub.progress}%${subDue ? `・${subDue}` : ''}）`)
        }
      }
      if (row.notes.length === 0) {
        lines.push('- 進捗記録なし')
      } else {
        for (const note of row.notes) {
          lines.push(`- ${formatDateTime(note.created_at)} ${note.author_name ?? '不明'}: ${compactText(note.body)}`)
          lines.push(...renderCommentThread(note.comments, 1))
        }
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

function digestToMarkdown(digest: ProgressDigest, perTaskReport: TaskReportRow[]): string {
  const lines: string[] = [`# 進捗レポート ${digest.from} ～ ${digest.to}`, '']

  if (perTaskReport.length > 0) {
    lines.push('## タスク別レポート')
    lines.push(perTaskReportToMarkdown(perTaskReport))
  }

  for (const user of digest.users) {
    const taskChangeCount = user.task_changes?.length ?? 0
    lines.push(`## ${user.display_name}`)
    lines.push(
      `- 追加タスク: ${user.added_todos.length}件 / 完了タスク: ${user.completed_todos.length}件 / サブタスク: ${user.added_subtasks.length}件 / 変更: ${taskChangeCount}件 / 進捗ログ: ${user.notes.length}件 / コメント: ${user.comments.length}件 / 作業時間: ${formatMinutes(user.work_minutes)}（${user.work_log_count}回）`
    )
    lines.push('')

    if (user.added_todos.length > 0) {
      lines.push('### 追加したタスク')
      for (const todo of user.added_todos) {
        const category = todo.category_name ? `［${todo.category_name}］` : ''
        lines.push(`- [${STATUS_LABEL[todo.status]}] ${category}${todo.title}（${todo.progress}%）`)
      }
      lines.push('')
    }

    if (user.completed_todos.length > 0) {
      lines.push('### 完了したタスク')
      for (const todo of user.completed_todos) {
        const category = todo.category_name ? `［${todo.category_name}］` : ''
        lines.push(`- [${STATUS_LABEL[todo.status]}] ${category}${todo.title}（${todo.progress}%）`)
      }
      lines.push('')
    }

    if (user.added_subtasks.length > 0) {
      lines.push('### 追加したサブタスク')
      for (const sub of user.added_subtasks) {
        lines.push(`- ${sub.done ? '[x]' : '[ ]'} ${sub.todo_title} › ${sub.title}`)
      }
      lines.push('')
    }

    const activityGroups = buildTaskActivityGroups(user)
    if (activityGroups.length > 0) {
      lines.push('### タスク別の活動ログ')
      for (const group of activityGroups) {
        const category = group.category_name ? `［${group.category_name}］` : ''
        lines.push(`#### ${category}${group.todo_title}`)
        for (const event of group.events) {
          if (event.kind === 'change' && event.change) {
            lines.push(`- ${formatDateTime(event.created_at)} 変更: ${formatTaskChange(event.change)}`)
          } else if (event.note) {
            lines.push(`- ${formatDateTime(event.created_at)} 進捗ログ: ${compactText(event.note.body)}`)
          }
        }
      }
      lines.push('')
    }

    if (user.comments.length > 0) {
      lines.push('### コメント・返信')
      for (const comment of user.comments) {
        const body = comment.body.replace(/\r?\n/g, ' ')
        const label = comment.parent_comment_id ? '返信' : 'コメント'
        lines.push(`- ${formatDateTime(comment.created_at)} ${label}［${comment.todo_title}］${body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function ProgressReportModal({ users, onClose, onShowToast, selfOnly = false, currentUser = null, includePrivate = true, visibleTodos }: Props): React.JSX.Element {
  const today = new Date()
  const [from, setFrom] = useState(() => toDateInput(addDays(today, -6)))
  const [to, setTo] = useState(() => toDateInput(today))
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(users.filter((u) => u.is_active === 1).map((u) => u.id))
  )
  const [digest, setDigest] = useState<ProgressDigest | null>(null)
  const [taskNotes, setTaskNotes] = useState<ProgressNote[] | null>(null)
  const [taskSubTasks, setTaskSubTasks] = useState<SubTask[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [showOnlyActiveTasks, setShowOnlyActiveTasks] = useState(false)

  const fetchDigest = useCallback(async (): Promise<void> => {
    if (from > to) {
      onShowToast('開始日は終了日より前にしてください', 'error')
      return
    }
    if (!selfOnly && selectedIds.size === 0) {
      onShowToast('メンバーを1人以上選択してください', 'error')
      return
    }
    setLoading(true)
    try {
      // selfOnly: サーバー版は自分のID、デスクトップ版は指定なし（「自分」の単一バケットが返る）
      const userIds = selfOnly
        ? (currentUser ? [currentUser.id] : undefined)
        : Array.from(selectedIds)
      const [result, notes, subTasks] = await Promise.all([
        window.api.progressDigestGet({ from, to, userIds, includePrivate }),
        window.api.progressNoteGetByRange(from, to),
        window.api.subtaskGetAll()
      ])
      setDigest(result)
      setTaskNotes(notes)
      setTaskSubTasks(subTasks)
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '進捗レポートの取得に失敗しました', 'error')
    } finally {
      setLoading(false)
    }
  }, [from, to, selectedIds, selfOnly, currentUser, includePrivate, onShowToast])

  const perTaskReport = buildPerTaskReport(visibleTodos, taskNotes ?? [], taskSubTasks ?? [])
  const displayedTaskReport = showOnlyActiveTasks ? perTaskReport.filter((row) => row.notes.length > 0) : perTaskReport

  const handleCopyMarkdown = useCallback(async (): Promise<void> => {
    if (!digest) return
    try {
      await copyTextToClipboard(digestToMarkdown(digest, displayedTaskReport))
      onShowToast('Markdownをコピーしました')
    } catch {
      onShowToast('クリップボードへのコピーに失敗しました', 'error')
    }
  }, [digest, displayedTaskReport, onShowToast])

  const handleOpenTaskReportWindow = useCallback(async (): Promise<void> => {
    try {
      writeTaskReportSnapshot({
        version: 1,
        from,
        to,
        showOnlyActiveTasks,
        generatedAt: new Date().toISOString(),
        rows: perTaskReport
      })
    } catch {
      onShowToast('レポートの保存に失敗しました', 'error')
      return
    }
    await window.api.windowOpenTaskReport()
  }, [from, to, showOnlyActiveTasks, perTaskReport, onShowToast])

  // 初回オープン時に直近7日・全員で自動集計する。
  useEffect(() => {
    void fetchDigest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const applyPreset = (days: number): void => {
    const end = new Date()
    setFrom(toDateInput(addDays(end, -(days - 1))))
    setTo(toDateInput(end))
  }

  const toggleMember = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allActiveIds = users.filter((u) => u.is_active === 1).map((u) => u.id)
  const allSelected = allActiveIds.length > 0 && allActiveIds.every((id) => selectedIds.has(id))

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: '#1e293b', borderRadius: 14, padding: 28, width: 680,
        maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)', border: '1px solid #334155',
        display: 'flex', flexDirection: 'column', gap: 22
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', margin: 0 }}>
            {selfOnly ? '📊 自分の進捗サマリー' : '📊 進捗レポート'}
          </h2>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* ─── 期間 ─── */}
        <section>
          <h3 style={sectionHead}>期間</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInputStyle} />
            <span style={{ color: '#64748b' }}>〜</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={dateInputStyle} />
            <div style={{ display: 'flex', gap: 6, marginLeft: 4 }}>
              <button onClick={() => applyPreset(1)} style={presetBtn}>今日</button>
              <button onClick={() => applyPreset(7)} style={presetBtn}>7日間</button>
              <button onClick={() => applyPreset(30)} style={presetBtn}>30日間</button>
            </div>
          </div>
        </section>

        {/* ─── メンバー（個人サマリーでは非表示） ─── */}
        {!selfOnly && (
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={sectionHead}>メンバー（{selectedIds.size}人選択中）</h3>
              <button
                onClick={() => setSelectedIds(allSelected ? new Set() : new Set(allActiveIds))}
                style={linkBtn}
              >
                {allSelected ? '全解除' : '全員選択'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {users.map((user) => {
                const selected = selectedIds.has(user.id)
                const inactive = user.is_active !== 1
                return (
                  <button
                    key={user.id}
                    onClick={() => toggleMember(user.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7,
                      padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                      border: `1px solid ${selected ? user.color : '#334155'}`,
                      background: selected ? `${user.color}26` : '#0f172a',
                      color: selected ? '#e2e8f0' : '#64748b',
                      fontSize: '0.82rem', opacity: inactive ? 0.6 : 1
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
                    {user.display_name}{inactive ? '（無効）' : ''}
                  </button>
                )
              })}
            </div>
          </section>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => void fetchDigest()} disabled={loading} style={primaryBtn}>
            {loading ? '集計中…' : '集計する'}
          </button>
          {digest && (
            <button onClick={() => void handleCopyMarkdown()} style={copyBtn}>
              📋 Markdownをコピー
            </button>
          )}
        </div>

        {/* ─── タスク別レポート ─── */}
        {digest && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={sectionHead}>タスク別レポート（一覧の表示順）</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: '#94a3b8', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showOnlyActiveTasks}
                    onChange={(e) => setShowOnlyActiveTasks(e.target.checked)}
                    style={{ accentColor: '#6366f1' }}
                  />
                  活動があったタスクのみ表示
                </label>
                <button onClick={() => void handleOpenTaskReportWindow()} style={copyBtn}>
                  🗔 別ウィンドウで開く
                </button>
              </div>
            </div>
            {displayedTaskReport.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.84rem' }}>
                {showOnlyActiveTasks ? 'この期間に進捗記録があるタスクがありません。' : '表示中のタスクがありません。'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {groupPerTaskReportByCategory(displayedTaskReport).map((group) => (
                  <div key={group.category_name ?? '未分類'} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {group.category_color && (
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.category_color, flexShrink: 0 }} />
                      )}
                      <span style={groupLabel}>{group.category_name}</span>
                    </div>
                    {group.rows.map((row) => (
                      <TaskReportCard key={row.todo.id} row={row} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ─── 結果 ─── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h3 style={sectionHead}>メンバー別の活動集計</h3>
          {loading && !digest && (
            <div style={{ color: '#64748b', fontSize: '0.84rem' }}>読み込み中…</div>
          )}
          {digest && digest.users.length === 0 && (
            <div style={{ color: '#64748b', fontSize: '0.84rem' }}>対象メンバーがいません。</div>
          )}
          {digest && digest.users.map((user) => (
            <UserDigestCard key={user.user_id ?? user.display_name} user={user} />
          ))}
        </section>
      </div>
    </div>
  )
}

export function TaskReportCard({ row }: { row: TaskReportRow }): React.JSX.Element {
  const { todo, notes, subTasks } = row
  const assignees = formatAssignees(todo)
  const dueColor = getDueDateColor(todo.due_date)
  return (
    <div style={{ border: '1px solid #334155', borderRadius: 10, background: '#0f172a', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.88rem', color: '#e2e8f0', fontWeight: 700 }}>{todo.title}</span>
        {todo.priority >= 4 && (
          <span style={{ fontSize: '0.68rem', color: todo.priority === 5 ? '#ef4444' : '#f59e0b', fontWeight: 700 }}>
            {'!'.repeat(todo.priority - 3)}
          </span>
        )}
        <span style={{ ...statBadge, marginLeft: 'auto' }}>{todo.progress}%</span>
        <span style={{ ...statBadge, ...(dueColor ? { color: dueColor, borderColor: `${dueColor}60` } : {}) }}>
          {todo.due_date ? `期限 ${todo.due_date.slice(0, 10)}` : '期限なし'}
        </span>
      </div>
      {assignees && (
        <div style={{ fontSize: '0.74rem', color: '#93c5fd', marginTop: 4 }}>{assignees}</div>
      )}
      {todo.memo && (
        <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 6, whiteSpace: 'pre-wrap' }}>{todo.memo}</div>
      )}
      {subTasks.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {subTasks.map((sub) => (
            <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.78rem' }}>
              <span style={{ color: sub.done ? '#22c55e' : '#475569', flexShrink: 0 }}>{sub.done ? '✓' : '○'}</span>
              <span style={{ color: sub.done ? '#64748b' : '#cbd5e1', textDecoration: sub.done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {sub.title}
              </span>
              <span style={rowMeta}>{sub.progress}%{sub.due_date ? `・${sub.due_date.slice(0, 10)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {notes.length === 0 ? (
          <div style={{ color: '#475569', fontSize: '0.78rem' }}>進捗記録なし</div>
        ) : (
          notes.map((note) => (
            <div key={note.id} style={{ background: '#1e293b', borderRadius: 8, padding: '7px 9px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.72rem', color: '#64748b', marginBottom: 3 }}>
                <span>{formatDateTime(note.created_at)}</span>
                <span style={{ color: '#93c5fd' }}>{note.author_name ?? '不明'}</span>
              </div>
              <div style={{ fontSize: '0.82rem', color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>{note.body}</div>
              {note.comments.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <CommentThread comments={note.comments} depth={0} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function CommentThread({ comments, depth }: { comments: ProgressNoteComment[]; depth: number }): React.JSX.Element {
  return (
    <>
      {comments.map((comment) => (
        <div key={comment.id} style={{ marginLeft: depth * 16, fontSize: '0.78rem', color: '#cbd5e1' }}>
          <span style={{ color: '#a78bfa' }}>↳ {comment.author_name ?? '不明'}: </span>
          {comment.body}
          {comment.replies.length > 0 && <CommentThread comments={comment.replies} depth={depth + 1} />}
        </div>
      ))}
    </>
  )
}

function UserDigestCard({ user }: { user: ProgressDigestUser }): React.JSX.Element {
  const taskActivityGroups = buildTaskActivityGroups(user)
  const taskChangeCount = user.task_changes?.length ?? 0
  const hasActivity =
    user.added_todos.length > 0 ||
    user.completed_todos.length > 0 ||
    user.added_subtasks.length > 0 ||
    taskChangeCount > 0 ||
    user.notes.length > 0 ||
    user.comments.length > 0 ||
    user.work_minutes > 0

  return (
    <div style={{ border: '1px solid #334155', borderRadius: 12, background: '#0f172a', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
        <span style={{ fontSize: '0.95rem', color: '#e2e8f0', fontWeight: 700 }}>{user.display_name}</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <span style={statBadge}>タスク {user.added_todos.length}</span>
          <span style={statBadge}>完了 {user.completed_todos.length}</span>
          <span style={statBadge}>サブタスク {user.added_subtasks.length}</span>
          <span style={statBadge}>変更 {taskChangeCount}</span>
          <span style={statBadge}>進捗ログ {user.notes.length}</span>
          <span style={statBadge}>コメント {user.comments.length}</span>
          <span style={statBadge}>作業 {formatMinutes(user.work_minutes)}</span>
        </div>
      </div>

      {!hasActivity ? (
        <div style={{ color: '#475569', fontSize: '0.8rem', marginTop: 10 }}>この期間の活動はありません。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
          {user.added_todos.length > 0 && (
            <div>
              <div style={groupLabel}>追加したタスク</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {user.added_todos.map((todo) => (
                  <div key={todo.id} style={rowStyle}>
                    <span style={{ ...statusPill, background: `${STATUS_COLOR[todo.status]}26`, color: STATUS_COLOR[todo.status] }}>
                      {STATUS_LABEL[todo.status]}
                    </span>
                    {todo.category_name && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: todo.category_color ?? '#64748b' }} />
                        <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{todo.category_name}</span>
                      </span>
                    )}
                    <span style={rowTitle}>{todo.title}</span>
                    <span style={rowMeta}>{todo.progress}%・{formatDateTime(todo.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {user.completed_todos.length > 0 && (
            <div>
              <div style={groupLabel}>完了したタスク</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {user.completed_todos.map((todo) => (
                  <div key={todo.id} style={rowStyle}>
                    <span style={{ ...statusPill, background: `${STATUS_COLOR[todo.status]}26`, color: STATUS_COLOR[todo.status] }}>
                      {STATUS_LABEL[todo.status]}
                    </span>
                    {todo.category_name && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: todo.category_color ?? '#64748b' }} />
                        <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{todo.category_name}</span>
                      </span>
                    )}
                    <span style={rowTitle}>{todo.title}</span>
                    <span style={rowMeta}>{todo.progress}%・{formatDateTime(todo.completed_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {user.added_subtasks.length > 0 && (
            <div>
              <div style={groupLabel}>追加したサブタスク</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {user.added_subtasks.map((sub) => (
                  <div key={sub.id} style={rowStyle}>
                    <span style={{ color: sub.done ? '#22c55e' : '#475569', fontSize: '0.82rem', flexShrink: 0 }}>
                      {sub.done ? '✓' : '○'}
                    </span>
                    <span style={{ fontSize: '0.74rem', color: '#64748b', flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sub.todo_title}
                    </span>
                    <span style={{ color: '#475569', flexShrink: 0 }}>›</span>
                    <span style={rowTitle}>{sub.title}</span>
                    <span style={rowMeta}>{formatDateTime(sub.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {taskActivityGroups.length > 0 && (
            <div>
              <div style={groupLabel}>タスク別の活動ログ</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {taskActivityGroups.map((group) => (
                  <div key={group.todo_id} style={{ background: '#1e293b', borderRadius: 8, padding: '9px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, flexWrap: 'wrap' }}>
                      {group.category_name && (
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.category_color ?? '#64748b' }} />
                      )}
                      <span style={{ fontSize: '0.78rem', color: '#93c5fd', fontWeight: 700 }}>{group.todo_title}</span>
                      {group.category_name && <span style={{ fontSize: '0.68rem', color: '#64748b' }}>{group.category_name}</span>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {group.events.map((event) => (
                        <div key={event.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: '0.78rem', lineHeight: 1.45 }}>
                          <span style={{ color: '#64748b', flexShrink: 0 }}>{formatDateTime(event.created_at)}</span>
                          <span style={{ color: event.kind === 'change' ? '#fbbf24' : '#4ade80', flexShrink: 0 }}>
                            {event.kind === 'change' ? '変更' : '進捗'}
                          </span>
                          <span style={{ color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>
                            {event.change ? formatTaskChange(event.change) : event.note?.body}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {user.comments.length > 0 && (
            <div>
              <div style={groupLabel}>コメント・返信</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {user.comments.map((comment) => (
                  <div key={comment.id} style={{ background: '#1e293b', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.7rem', color: comment.parent_comment_id ? '#a78bfa' : '#38bdf8', fontWeight: 800 }}>
                        {comment.parent_comment_id ? '返信' : 'コメント'}
                      </span>
                      <span style={{ fontSize: '0.74rem', color: '#93c5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                        {comment.todo_title}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: '#64748b' }}>{formatDateTime(comment.created_at)}</span>
                    </div>
                    <div style={{ fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{comment.body}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const sectionHead: React.CSSProperties = {
  fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase',
  letterSpacing: '0.08em', fontWeight: 'bold', margin: 0
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#64748b',
  cursor: 'pointer', fontSize: '1.2rem', padding: '2px 6px'
}

const primaryBtn: React.CSSProperties = {
  padding: '8px 18px', background: '#6366f1', border: 'none',
  borderRadius: 8, color: '#fff', cursor: 'pointer', fontSize: '0.85rem',
  fontWeight: 'bold', whiteSpace: 'nowrap', alignSelf: 'flex-start'
}

const copyBtn: React.CSSProperties = {
  padding: '8px 18px', background: '#334155', border: 'none',
  borderRadius: 8, color: '#cbd5e1', cursor: 'pointer', fontSize: '0.85rem',
  fontWeight: 'bold', whiteSpace: 'nowrap'
}

const presetBtn: React.CSSProperties = {
  padding: '5px 11px', background: '#334155', border: 'none',
  borderRadius: 6, color: '#cbd5e1', cursor: 'pointer', fontSize: '0.78rem', whiteSpace: 'nowrap'
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#818cf8',
  cursor: 'pointer', fontSize: '0.76rem', padding: 0
}

const dateInputStyle: React.CSSProperties = {
  padding: '6px 10px', background: '#0f172a', border: '1px solid #334155',
  borderRadius: 7, color: '#e2e8f0', fontSize: '0.85rem', outline: 'none', colorScheme: 'dark'
}

const statBadge: React.CSSProperties = {
  fontSize: '0.7rem', color: '#cbd5e1', background: '#1e293b',
  border: '1px solid #334155', borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap'
}

const groupLabel: React.CSSProperties = {
  fontSize: '0.72rem', color: '#94a3b8', fontWeight: 700, marginBottom: 6
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem'
}

const rowTitle: React.CSSProperties = {
  color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0
}

const rowMeta: React.CSSProperties = {
  fontSize: '0.72rem', color: '#64748b', whiteSpace: 'nowrap', flexShrink: 0
}

const statusPill: React.CSSProperties = {
  fontSize: '0.68rem', fontWeight: 700, padding: '1px 7px', borderRadius: 99, flexShrink: 0
}
