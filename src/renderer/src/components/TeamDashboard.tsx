import React, { useCallback, useEffect, useState } from 'react'
import type { TeamDashboard as TeamDashboardData, TeamDeadlineItem, TeamMemberWorkload, TeamNowItem } from '../types'
import { AssigneeChip } from './AssigneePicker'
import { dataInk } from '../lib/theme'
import { formatShortDate } from '../lib/dueDate'

interface Props {
  onSelectTodo: (id: string) => void
  /** メンバーのカードを押したとき（そのメンバーで一覧を絞ってガントを開く） */
  onSelectMember?: (userId: string) => void
  /** false のときプライベートカテゴリのタスクを集計から除外（全体レンズ） */
  includePrivate?: boolean
}

const EMPTY: TeamDashboardData = { now: [], overdue: [], dueSoon: [], workloads: [] }

function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}分`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}時間` : `${h}時間${m}分`
}

function dueSoonLabel(days: number): string {
  if (days <= 0) return '今日'
  if (days === 1) return '明日'
  return `${days}日後`
}

export function TeamDashboard({ onSelectTodo, onSelectMember, includePrivate = true }: Props): React.JSX.Element {
  const [data, setData] = useState<TeamDashboardData>(EMPTY)
  const [loadedAt, setLoadedAt] = useState<number>(Date.now())
  const [nowMs, setNowMs] = useState<number>(Date.now())
  const [hasLoaded, setHasLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await window.api.teamGetDashboard(includePrivate)
      setData(next)
      setLoadedAt(Date.now())
      setNowMs(Date.now())
    } catch (error) {
      console.error('Failed to load team dashboard', error)
    } finally {
      setHasLoaded(true)
    }
  }, [includePrivate])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const unsubscribe = window.api.onDataChanged((scope) => {
      // 進捗ノートの投稿・いいねはダッシュボードの集計に影響しない
      if (scope === 'progress') return
      void load()
    })
    return () => unsubscribe()
  }, [load])

  useEffect(() => {
    const id = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => {
    if (data.now.length === 0) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [data.now.length])

  const secondsSinceLoad = Math.max(0, Math.floor((nowMs - loadedAt) / 1000))

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--slate-50)' }}>チーム状況</h1>
        <button onClick={() => void load()} style={refreshButtonStyle}>更新</button>
      </div>

      <section>
        <SectionHeader title="いま稼働中" accent="var(--green-400)" count={data.now.length} />
        {data.now.length === 0 ? (
          <EmptyNote text={hasLoaded ? '現在タイマーを稼働しているメンバーはいません。' : '読み込み中...'} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {data.now.map((item) => (
              <NowCard key={`${item.user_id}-${item.todo_id}`} item={item} extraSeconds={secondsSinceLoad} onSelectTodo={onSelectTodo} />
            ))}
          </div>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
        <section>
          <SectionHeader title="期限超過" accent="var(--red-500)" count={data.overdue.length} />
          {data.overdue.length === 0 ? (
            <EmptyNote text="期限超過のタスクはありません。" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.overdue.map((item) => (
                <DeadlineRow key={item.todo_id} item={item} accent="var(--red-500)" label={`${Math.abs(item.days_until_due)}日超過`} onSelectTodo={onSelectTodo} />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeader title="まもなく期限" accent="var(--amber-500)" count={data.dueSoon.length} />
          {data.dueSoon.length === 0 ? (
            <EmptyNote text="3日以内に期限を迎えるタスクはありません。" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.dueSoon.map((item) => (
                <DeadlineRow key={item.todo_id} item={item} accent="var(--amber-500)" label={dueSoonLabel(item.days_until_due)} onSelectTodo={onSelectTodo} />
              ))}
            </div>
          )}
        </section>
      </div>

      <section>
        <SectionHeader title="メンバーの負荷" accent="var(--blue-400)" count={data.workloads.length} />
        {data.workloads.length === 0 ? (
          <EmptyNote text="メンバーがいません。" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {data.workloads.map((member) => (
              <WorkloadCard key={member.user_id} member={member} onSelect={onSelectMember ? () => onSelectMember(member.user_id) : undefined} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function SectionHeader({ title, accent, count }: { title: string; accent: string; count: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
      <span style={{ fontSize: '0.9rem', color: 'var(--slate-200)', fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: '0.74rem', color: 'var(--text-subtle)' }}>{count}件</span>
    </div>
  )
}

function EmptyNote({ text }: { text: string }): React.JSX.Element {
  return <div style={{ fontSize: '0.84rem', color: 'var(--text-subtle)', padding: '8px 0' }}>{text}</div>
}

function NowCard({ item, extraSeconds, onSelectTodo }: { item: TeamNowItem; extraSeconds: number; onSelectTodo: (id: string) => void }): React.JSX.Element {
  return (
    <div style={{ background: 'var(--c-0c1a12)', border: '1px solid var(--green-900)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: item.user_color, boxShadow: `0 0 0 3px color-mix(in srgb, ${item.user_color} 20%, transparent)` }} />
        <span style={{ fontSize: '0.86rem', color: 'var(--green-50)', fontWeight: 700 }}>{item.display_name}</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.9rem', color: 'var(--green-400)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {formatElapsed(item.elapsed_seconds + extraSeconds)}
        </span>
      </div>
      <button
        onClick={() => onSelectTodo(item.todo_id)}
        style={{ background: 'transparent', border: 'none', padding: 0, textAlign: 'left', color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 600 }}
      >
        {item.todo_title}
      </button>
      {item.category_name && (
        <span style={{ alignSelf: 'flex-start', fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99, background: `color-mix(in srgb, ${item.category_color ?? 'var(--indigo-500)'} 18.8%, transparent)`, color: dataInk(item.category_color ?? 'var(--indigo-300)') }}>
          {item.category_name}
        </span>
      )}
    </div>
  )
}

function DeadlineRow({ item, accent, label, onSelectTodo }: { item: TeamDeadlineItem; accent: string; label: string; onSelectTodo: (id: string) => void }): React.JSX.Element {
  return (
    <div style={{ background: 'var(--slate-900)', border: '1px solid var(--slate-800)', borderLeft: `3px solid ${accent}`, borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => onSelectTodo(item.todo_id)}
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, textAlign: 'left', color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {item.status === 'on_hold' && <span style={{ color: 'var(--purple-300)' }}>保留中 · </span>}{item.title}
        </button>
        <span style={{ flexShrink: 0, fontSize: '0.72rem', color: accent, fontWeight: 700 }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.7rem', color: 'var(--slate-400)' }}>
        <span>期限 {formatShortDate(item.due_date)}</span>
        {item.category_name && <span style={{ color: dataInk(item.category_color ?? 'var(--indigo-300)') }}>{item.category_name}</span>}
        <span>{item.progress}%</span>
        <span style={{ marginLeft: 'auto' }}>
          <AssigneeChip name={item.assignee_name} color={item.assignee_color} fontSize={0.68} />
        </span>
      </div>
    </div>
  )
}

function WorkloadCard({ member, onSelect }: { member: TeamMemberWorkload; onSelect?: () => void }): React.JSX.Element {
  const Container = onSelect ? 'button' : 'div'
  return (
    <Container
      type={onSelect ? 'button' : undefined}
      onClick={onSelect}
      title={onSelect ? `${member.display_name}さんのタスクだけをガントで見る` : undefined}
      style={{ background: 'var(--slate-900)', border: '1px solid var(--slate-800)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left', color: 'inherit', font: 'inherit', cursor: onSelect ? 'pointer' : 'default', width: '100%' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: member.user_color }} />
        <span style={{ fontSize: '0.86rem', color: 'var(--slate-200)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member.display_name}</span>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Metric label="未完了" title="未着手と進行中の数（保留中は別に数える）" value={`${member.active_tasks}`} color="var(--slate-200)" />
        <Metric label="保留中" value={`${member.on_hold_tasks}`} color="var(--purple-300)" />
        <Metric label="超過" value={`${member.overdue_tasks}`} color={member.overdue_tasks > 0 ? 'var(--red-400)' : 'var(--slate-500)'} />
        <Metric label="今日" value={formatMinutes(member.today_minutes)} color="var(--green-400)" />
      </div>
    </Container>
  )
}

function Metric({ label, value, color, title }: { label: string; value: string; color: string; title?: string }): React.JSX.Element {
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: '0.64rem', color: 'var(--text-subtle)' }}>{label}</span>
      <span style={{ fontSize: '0.92rem', color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

const refreshButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--slate-800)',
  border: '1px solid var(--slate-700)',
  borderRadius: 8,
  color: 'var(--slate-400)',
  cursor: 'pointer',
  fontSize: '0.78rem',
  fontWeight: 700
}
