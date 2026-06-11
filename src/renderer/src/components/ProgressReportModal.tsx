import React, { useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import type {
  ProgressDigest,
  ProgressDigestUser,
  PublicUser,
  TodoStatus
} from '../types'

interface Props {
  users: PublicUser[]
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
  /** true のとき自分の活動だけを集計する個人サマリーとして動く（メンバー選択を隠す） */
  selfOnly?: boolean
  currentUser?: PublicUser | null
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

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const m = date.getMonth() + 1
  const d = date.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${m}/${d} ${hh}:${mm}`
}

/** 集計結果を日報・週報に貼れる Markdown に変換する */
function digestToMarkdown(digest: ProgressDigest): string {
  const lines: string[] = [`# 進捗レポート ${digest.from} ～ ${digest.to}`, '']

  for (const user of digest.users) {
    lines.push(`## ${user.display_name}`)
    lines.push(
      `- 追加タスク: ${user.added_todos.length}件 / サブタスク: ${user.added_subtasks.length}件 / 進捗メモ: ${user.notes.length}件 / 作業時間: ${formatMinutes(user.work_minutes)}（${user.work_log_count}回）`
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

    if (user.added_subtasks.length > 0) {
      lines.push('### 追加したサブタスク')
      for (const sub of user.added_subtasks) {
        lines.push(`- ${sub.done ? '[x]' : '[ ]'} ${sub.todo_title} › ${sub.title}`)
      }
      lines.push('')
    }

    if (user.notes.length > 0) {
      lines.push('### 進捗メモ')
      for (const note of user.notes) {
        const body = note.body.replace(/\r?\n/g, ' ')
        lines.push(`- ${formatDateTime(note.created_at)}［${note.todo_title}］${body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function ProgressReportModal({ users, onClose, onShowToast, selfOnly = false, currentUser = null }: Props): React.JSX.Element {
  const today = new Date()
  const [from, setFrom] = useState(() => toDateInput(addDays(today, -6)))
  const [to, setTo] = useState(() => toDateInput(today))
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(users.filter((u) => u.is_active === 1).map((u) => u.id))
  )
  const [digest, setDigest] = useState<ProgressDigest | null>(null)
  const [loading, setLoading] = useState(false)

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
      const result = await window.api.progressDigestGet({ from, to, userIds })
      setDigest(result)
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : '進捗レポートの取得に失敗しました', 'error')
    } finally {
      setLoading(false)
    }
  }, [from, to, selectedIds, selfOnly, currentUser, onShowToast])

  const handleCopyMarkdown = useCallback(async (): Promise<void> => {
    if (!digest) return
    try {
      await copyTextToClipboard(digestToMarkdown(digest))
      onShowToast('Markdownをコピーしました')
    } catch {
      onShowToast('クリップボードへのコピーに失敗しました', 'error')
    }
  }, [digest, onShowToast])

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

        {/* ─── 結果 ─── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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

function UserDigestCard({ user }: { user: ProgressDigestUser }): React.JSX.Element {
  const hasActivity =
    user.added_todos.length > 0 ||
    user.added_subtasks.length > 0 ||
    user.notes.length > 0 ||
    user.work_minutes > 0

  return (
    <div style={{ border: '1px solid #334155', borderRadius: 12, background: '#0f172a', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
        <span style={{ fontSize: '0.95rem', color: '#e2e8f0', fontWeight: 700 }}>{user.display_name}</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <span style={statBadge}>タスク {user.added_todos.length}</span>
          <span style={statBadge}>サブタスク {user.added_subtasks.length}</span>
          <span style={statBadge}>進捗メモ {user.notes.length}</span>
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

          {user.notes.length > 0 && (
            <div>
              <div style={groupLabel}>進捗メモ</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {user.notes.map((note) => (
                  <div key={note.id} style={{ background: '#1e293b', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.74rem', color: '#93c5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                        {note.todo_title}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: '#64748b' }}>{formatDateTime(note.created_at)}</span>
                    </div>
                    <div style={{ fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{note.body}</div>
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
