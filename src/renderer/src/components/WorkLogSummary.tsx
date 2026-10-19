import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { WorkLogSummaryRow } from '../types'
import { dataInk } from '../lib/theme'

interface Props {
  hiddenTodoIds?: Set<string>
}

interface TaskGroup {
  todo_id: string
  title: string
  category_name: string | null
  category_color: string | null
  total_seconds: number
  entries: WorkLogSummaryRow[]
}

const DAY_OPTIONS = [
  { label: '3日', value: 3 },
  { label: '7日', value: 7 },
  { label: '14日', value: 14 },
  { label: '30日', value: 30 }
]

const WEEK_DAYS = ['日', '月', '火', '水', '木', '金', '土']
const NO_HIDDEN_TODOS = new Set<string>()

function formatDate(isoStr: string): string {
  const d = new Date(isoStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  if (target.getTime() === today.getTime()) return '今日'
  if (target.getTime() === yesterday.getTime()) return '昨日'
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEK_DAYS[d.getDay()]})`
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDuration(seconds: number): string {
  if (seconds > 0 && seconds < 60) return '1分未満'
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0) return `${h}時間${m > 0 ? `${m}分` : ''}`
  return `${m}分`
}

function groupByTask(rows: WorkLogSummaryRow[]): TaskGroup[] {
  const map = new Map<string, TaskGroup>()
  for (const row of rows) {
    if (!map.has(row.todo_id)) {
      map.set(row.todo_id, {
        todo_id: row.todo_id,
        title: row.title,
        category_name: row.category_name,
        category_color: row.category_color,
        total_seconds: 0,
        entries: []
      })
    }
    const g = map.get(row.todo_id)!
    g.total_seconds += row.duration_seconds
    g.entries.push(row)
  }
  return [...map.values()].sort((a, b) => b.total_seconds - a.total_seconds)
}

export function WorkLogSummary({ hiddenTodoIds = NO_HIDDEN_TODOS }: Props): React.JSX.Element {
  const [days, setDays] = useState(7)
  const [groups, setGroups] = useState<TaskGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const load = useCallback(async (d: number) => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const rows = await window.api.worklogGetSummary(d)
      if (request === requestRef.current) setGroups(groupByTask(rows.filter((row) => !hiddenTodoIds.has(row.todo_id))))
    } catch (failure) {
      if (request === requestRef.current) setError(failure instanceof Error ? failure.message : '作業ログを読み込めませんでした')
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [hiddenTodoIds])

  useEffect(() => { void load(days); return () => { requestRef.current++ } }, [days, load])

  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const totalSeconds = groups.reduce((s, g) => s + g.total_seconds, 0)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ヘッダー */}
      <div style={{
        padding: '14px 20px 10px', borderBottom: '1px solid var(--slate-800)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, flexWrap: 'wrap', gap: 10
      }}>
        <div>
          <div style={{ fontSize: '1rem', color: 'var(--slate-200)', fontWeight: 'bold' }}>記録</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-subtle)', marginTop: 4 }}>タイマーで計測した作業時間</div>
          {!loading && !error && totalSeconds > 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-subtle)', marginTop: 2 }}>
              合計 <span style={{ color: 'var(--green-400)', fontWeight: 'bold' }}>{formatDuration(totalSeconds)}</span>
              {' / '}{groups.length}タスク
            </div>
          )}
        </div>
        {/* 期間切替 */}
        <div role="group" aria-label="集計期間" style={{ display: 'flex', gap: 4 }}>
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              aria-pressed={days === opt.value}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer',
                background: days === opt.value ? 'var(--indigo-500)' : 'var(--slate-800)',
                border: `1px solid ${days === opt.value ? 'var(--indigo-500)' : 'var(--slate-700)'}`,
                color: days === opt.value ? 'var(--on-fill-white)' : 'var(--slate-400)',
                fontWeight: days === opt.value ? 'bold' : 'normal'
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* コンテンツ */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {error && <div role="alert" style={{ padding: 24, border: '1px solid var(--red-500)', borderRadius: 10, color: 'var(--slate-200)' }}>
          <p>作業ログを読み込めませんでした。</p><p style={{ marginTop: 6, fontSize: '0.85rem' }}>{error}</p>
          <button onClick={() => void load(days)} style={{ marginTop: 12, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--slate-600)', background: 'var(--slate-800)', color: 'var(--slate-100)', cursor: 'pointer' }}>再試行</button>
        </div>}
        {loading && (
          <div style={{ color: 'var(--text-subtle)', textAlign: 'center', padding: 24, fontSize: '0.9rem' }}>
            読み込み中…
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div style={{ color: 'var(--text-subtle)', textAlign: 'center', padding: 32, fontSize: '0.9rem' }}>
            この期間の作業ログはありません
            <p style={{ marginTop: 10, lineHeight: 1.7, fontSize: '0.82rem' }}>タスクの詳細で「計測開始」を押し、作業後に「停止」すると記録されます。<br />過去の記録は上の期間を切り替えて確認できます。</p>
          </div>
        )}

        {!loading && !error && groups.map((group) => {
          const expanded = expandedIds.has(group.todo_id)

          // エントリを日付ごとにグループ化（表示用）
          const byDate = new Map<string, WorkLogSummaryRow[]>()
          for (const entry of group.entries) {
            const dateKey = formatDate(entry.start_time)
            if (!byDate.has(dateKey)) byDate.set(dateKey, [])
            byDate.get(dateKey)!.push(entry)
          }

          return (
            <div
              key={group.todo_id}
              style={{
                background: 'var(--slate-800)', borderRadius: 10, marginBottom: 10,
                border: '1px solid var(--slate-700)', overflow: 'hidden'
              }}
            >
              {/* タスクヘッダー */}
              <button
                onClick={() => toggleExpand(group.todo_id)}
                aria-expanded={expanded}
                style={{
                  width: '100%', padding: '12px 14px', background: 'none', border: 'none',
                  cursor: 'pointer', textAlign: 'left', display: 'flex',
                  alignItems: 'center', gap: 10
                }}
              >
                <span style={{ color: 'var(--text-subtle)', fontSize: '0.8rem', flexShrink: 0 }}>
                  {expanded ? '▼' : '▶'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.92rem', color: 'var(--slate-200)', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {group.title}
                  </div>
                  {group.category_name && (
                    <span style={{
                      fontSize: '0.7rem', padding: '1px 6px', borderRadius: 99, marginTop: 3, display: 'inline-block',
                      background: `color-mix(in srgb, ${group.category_color ?? 'var(--indigo-500)'} 18.8%, transparent)`,
                      color: dataInk(group.category_color ?? 'var(--indigo-500)')
                    }}>
                      {group.category_name}
                    </span>
                  )}
                </div>
                {/* 合計時間バー */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '1rem', color: 'var(--green-400)', fontWeight: 'bold' }}>
                    {formatDuration(group.total_seconds)}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-subtle)' }}>
                    {group.entries.length}件
                  </div>
                </div>
              </button>

              {/* 展開: 日付ごとのエントリ */}
              {expanded && (
                <div style={{ borderTop: '1px solid var(--slate-900)' }}>
                  {[...byDate.entries()].map(([dateLabel, entries]) => {
                    const dayTotal = entries.reduce((s, e) => s + e.duration_seconds, 0)
                    return (
                      <div key={dateLabel} style={{ padding: '8px 14px 6px' }}>
                        {/* 日付ヘッダー */}
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          marginBottom: 4
                        }}>
                          <span style={{
                            fontSize: '0.72rem', color: 'var(--indigo-500)', fontWeight: 'bold',
                            background: 'color-mix(in srgb, var(--indigo-500) 8.2%, transparent)', padding: '2px 8px', borderRadius: 99
                          }}>
                            {dateLabel}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
                            {formatDuration(dayTotal)}
                          </span>
                        </div>
                        {/* ログエントリ */}
                        {entries.map((entry) => (
                          <div
                            key={entry.id}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '4px 6px', borderRadius: 5, marginBottom: 2,
                              background: 'var(--slate-900)'
                            }}
                          >
                            <span style={{ fontSize: '0.8rem', color: 'var(--slate-400)', fontFamily: 'monospace', flexShrink: 0 }}>
                              {formatTime(entry.start_time)}–{formatTime(entry.end_time)}
                            </span>
                            <span style={{ fontSize: '0.8rem', color: 'var(--green-400)', flexShrink: 0 }}>
                              {formatDuration(entry.duration_seconds)}
                            </span>
                            {entry.note && (
                              <span style={{ fontSize: '0.78rem', color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                — {entry.note}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
