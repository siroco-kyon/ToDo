import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TeamDashboard as TeamDashboardData, TeamDeadlineItem, TeamMemberWorkload, TeamNowItem, Todo } from '../types'
import { AssigneeChip } from './AssigneePicker'
import { dataInk } from '../lib/theme'
import { formatShortDate } from '../lib/dueDate'
import { behindDaysOf, isBehindSchedule, isScheduleTracked, loadScheduleSettings } from '../lib/scheduleHealth'

interface Props {
  onSelectTodo: (id: string) => void
  /** メンバーのカードを押したとき（そのメンバーで一覧を絞ってガントを開く） */
  onSelectMember?: (userId: string) => void
  /** メンバーの「超過」「遅れ」「報告なし」の数を押したとき（そのタスクだけを開く） */
  onSelectMemberMetric?: (userId: string, metric: 'overdue' | 'behind' | 'unreported') => void
  /** false のときプライベートカテゴリのタスクを集計から除外（全体レンズ） */
  includePrivate?: boolean
  /** メンバーごとの「遅れ」を数えるタスク（ガント・報告タブと同じ判定にする） */
  todos?: Todo[]
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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
  return `あと${days}日`
}

export function TeamDashboard({ onSelectTodo, onSelectMember, onSelectMemberMetric, includePrivate = true, todos = [] }: Props): React.JSX.Element {
  const [data, setData] = useState<TeamDashboardData>(EMPTY)
  const [loadedAt, setLoadedAt] = useState<number>(Date.now())
  const [nowMs, setNowMs] = useState<number>(Date.now())
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const next = await window.api.teamGetDashboard(includePrivate)
      if (request !== requestRef.current) return
      setData(next)
      setLoadedAt(Date.now())
      setNowMs(Date.now())
      setHasLoaded(true)
      setLoadError(null)
    } catch (error) {
      if (request === requestRef.current) setLoadError(error instanceof Error ? error.message : 'チーム状況を読み込めませんでした')
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [includePrivate])

  useEffect(() => {
    void load()
    return () => { requestRef.current++ }
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

  // 遅れ（期限前で、予定の進捗より遅れている主担当のタスク）。ガントの表示設定の「遅れとみなす日数」「土日・祝日を数えない」に合わせる
  const [scheduleSettings] = useState(loadScheduleSettings)
  const [holidayNames, setHolidayNames] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    if (!scheduleSettings.workingDaysOnly) return
    let cancelled = false
    void import('@holiday-jp/holiday_jp')
      .then((module) => {
        const library = ((module as { default?: unknown }).default ?? module) as { holidays: Record<string, { name: string }> }
        if (!cancelled) setHolidayNames(new Map(Object.entries(library.holidays).map(([date, holiday]) => [date, holiday.name])))
      })
      .catch(() => { /* 祝日が読めなくても土日だけ除いて数える */ })
    return () => { cancelled = true }
  }, [scheduleSettings.workingDaysOnly])
  const todayKey = toDateKey(new Date(nowMs))
  const behindCountByUser = useMemo(() => {
    const counts = new Map<string, number>()
    for (const todo of todos) {
      if (!todo.assignee_id || !isScheduleTracked(todo) || !todo.start_date || !todo.due_date) continue
      const bar = { startDate: todo.start_date.slice(0, 10), endDate: todo.due_date.slice(0, 10) }
      // 期限を過ぎたものは「超過」で数える
      if (bar.endDate < bar.startDate || todayKey > bar.endDate) continue
      const { behindDays, expectedProgress } = behindDaysOf(todo.progress, bar, todayKey, { ...scheduleSettings, holidayNames })
      if (isBehindSchedule(expectedProgress, todo.progress, behindDays, scheduleSettings.behindThresholdDays)) {
        counts.set(todo.assignee_id, (counts.get(todo.assignee_id) ?? 0) + 1)
      }
    }
    return counts
  }, [holidayNames, scheduleSettings, todayKey, todos])

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--slate-50)' }}>チーム状況</h1>
        <button disabled={loading} onClick={() => void load()} style={refreshButtonStyle}>{loading ? '更新中…' : '更新'}</button>
      </div>
      {loadError && <div role="alert" style={{ padding: 16, border: '1px solid var(--red-500)', borderRadius: 10, color: 'var(--slate-200)' }}>
        <p>チーム状況を読み込めませんでした。{loadError}</p>
        <p style={{ marginTop: 6, fontSize: 'var(--font-control)' }}>{hasLoaded ? '前回取得した内容を表示しています。' : '件数はまだ取得できていません。'}{loadError.includes('社内LAN') ? '' : ' 社内LANへの接続を確認して、もう一度お試しください。'}</p>
        <button disabled={loading} onClick={() => void load()} style={{ ...refreshButtonStyle, marginTop: 10 }}>再試行</button>
      </div>}
      {!hasLoaded && loading && <p role="status">チーム状況を読み込み中…</p>}
      {hasLoaded && <>
      <p style={{ color: 'var(--text-subtle)', fontSize: 'var(--font-control)', marginTop: -10 }}>タスクの件数は現在の状態、作業時間は今日、報告なしは直近7日を集計しています。</p>

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

      {/* メンバーごとの数（遅れ・報告なしなど）は朝いちばんに見るので、期限の一覧より先に出す */}
      <section>
        <SectionHeader title="メンバーの負荷" accent="var(--blue-400)" count={data.workloads.length} />
        {data.workloads.length === 0 ? (
          <EmptyNote text="メンバーがいません。" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 330px), 1fr))', gap: 8 }}>
            {data.workloads.map((member) => (
              <WorkloadCard key={member.user_id} member={member} behindCount={behindCountByUser.get(member.user_id) ?? 0} onSelect={onSelectMember ? () => onSelectMember(member.user_id) : undefined} onSelectMetric={onSelectMemberMetric ? (metric) => onSelectMemberMetric(member.user_id, metric) : undefined} />
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
      </>}
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

// 名前を押すとその人のタスクをガントで、「超過」「遅れ」「報告なし」の数を押すとそのタスクだけを開く
function WorkloadCard({ member, behindCount, onSelect, onSelectMetric }: { member: TeamMemberWorkload; behindCount: number; onSelect?: () => void; onSelectMetric?: (metric: 'overdue' | 'behind' | 'unreported') => void }): React.JSX.Element {
  const nameContent = (
    <>
      <span style={{ width: 11, height: 11, borderRadius: '50%', background: member.user_color, flexShrink: 0 }} />
      <span style={{ fontSize: '0.86rem', color: 'var(--slate-200)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{member.display_name}</span>
      {onSelect && <span aria-hidden="true" style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>→</span>}
    </>
  )
  const metricAction = (metric: 'overdue' | 'behind' | 'unreported', count: number): (() => void) | undefined =>
    onSelectMetric && count > 0 ? () => onSelectMetric(metric) : undefined
  return (
    <div
      style={{ background: 'var(--slate-900)', border: '1px solid var(--slate-800)', borderRadius: 10, padding: '8px 12px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 14px', textAlign: 'left', color: 'inherit', width: '100%', boxSizing: 'border-box' }}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          title={`${member.display_name}さんのタスクだけをガントで見る`}
          aria-label={`${member.display_name}さんのタスクをガントで見る`}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '7.5rem', minWidth: 0, minHeight: 32, padding: 0, background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}
        >
          {nameContent}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '7.5rem', minWidth: 0 }}>{nameContent}</div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
        <Metric label="未完了" title="未着手と進行中の数（保留中は別に数える）" value={`${member.active_tasks}`} color="var(--slate-200)" />
        <Metric label="保留中" value={`${member.on_hold_tasks}`} color="var(--purple-300)" />
        <Metric label="超過" title="期限を過ぎた未完了のタスク" value={`${member.overdue_tasks}`} color={member.overdue_tasks > 0 ? 'var(--red-400)' : 'var(--text-subtle)'}
          onClick={metricAction('overdue', member.overdue_tasks)} actionLabel={`${member.display_name}さんの期限超過のタスク${member.overdue_tasks}件をガントで見る`} />
        <Metric label="遅れ" title="期限前で、予定の進捗より遅れているタスク（ガントの「遅れ」と同じ判定）" value={`${behindCount}`} color={behindCount > 0 ? 'var(--amber-300)' : 'var(--text-subtle)'}
          onClick={metricAction('behind', behindCount)} actionLabel={`${member.display_name}さんの遅れているタスク${behindCount}件をガントで見る`} />
        {member.unreported_tasks !== undefined && (
          <Metric label="報告なし（直近7日）" title="直近7日に、担当（主・副）の進捗ログもメモの更新もない、進行中（または開始日を過ぎた未着手）の主担当のタスク。報告タブの「報告なし」と同じ数え方で、期間を直近7日にしたもの（報告のリマインドも同じ条件）" value={`${member.unreported_tasks}`} color={member.unreported_tasks > 0 ? 'var(--amber-200)' : 'var(--text-subtle)'}
            onClick={metricAction('unreported', member.unreported_tasks)} actionLabel={`${member.display_name}さんの報告なしのタスク${member.unreported_tasks}件を報告タブで見る`} />
        )}
        <Metric label="今日" value={formatMinutes(member.today_minutes)} color="var(--green-400)" />
      </div>
    </div>
  )
}

// 数。押せるとき（onClick）はボタンにし、下線で押せることを見せる
function Metric({ label, value, color, title, onClick, actionLabel }: { label: string; value: string; color: string; title?: string; onClick?: () => void; actionLabel?: string }): React.JSX.Element {
  const content = (
    <>
      <span style={{ fontSize: '0.7rem', color: 'var(--text-subtle)' }}>{label}</span>
      <span style={{ fontSize: '0.92rem', color, fontWeight: 700, fontVariantNumeric: 'tabular-nums', textDecoration: onClick ? 'underline' : 'none', textUnderlineOffset: 3 }}>{value}</span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} aria-label={actionLabel}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '2px 4px', margin: '-2px -4px', background: 'transparent', border: 'none', borderRadius: 6, font: 'inherit', cursor: 'pointer' }}>
        {content}
      </button>
    )
  }
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {content}
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
