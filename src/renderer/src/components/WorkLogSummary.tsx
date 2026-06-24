import React, { useState, useEffect, useCallback } from 'react'
import type { WorkLogSummaryRow } from '../types'

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
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const load = useCallback(async (d: number) => {
    setLoading(true)
    const rows = await window.api.worklogGetSummary(d)
    setGroups(groupByTask(rows.filter((row) => !hiddenTodoIds.has(row.todo_id))))
    setLoading(false)
  }, [hiddenTodoIds])

  useEffect(() => { load(days) }, [days, load])

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
        padding: '14px 20px 10px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0
      }}>
        <div>
          <div style={{ fontSize: '1rem', color: '#e2e8f0', fontWeight: 'bold' }}>作業ログ</div>
          {totalSeconds > 0 && (
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 2 }}>
              合計 <span style={{ color: '#4ade80', fontWeight: 'bold' }}>{formatDuration(totalSeconds)}</span>
              {' / '}{groups.length}タスク
            </div>
          )}
        </div>
        {/* 期間切替 */}
        <div style={{ display: 'flex', gap: 4 }}>
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer',
                background: days === opt.value ? '#6366f1' : '#1e293b',
                border: `1px solid ${days === opt.value ? '#6366f1' : '#334155'}`,
                color: days === opt.value ? '#fff' : '#94a3b8',
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
        {loading && (
          <div style={{ color: '#475569', textAlign: 'center', padding: 24, fontSize: '0.9rem' }}>
            読み込み中…
          </div>
        )}

        {!loading && groups.length === 0 && (
          <div style={{ color: '#475569', textAlign: 'center', padding: 32, fontSize: '0.9rem' }}>
            この期間の作業ログはありません
          </div>
        )}

        {!loading && groups.map((group) => {
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
                background: '#1e293b', borderRadius: 10, marginBottom: 10,
                border: '1px solid #334155', overflow: 'hidden'
              }}
            >
              {/* タスクヘッダー */}
              <button
                onClick={() => toggleExpand(group.todo_id)}
                style={{
                  width: '100%', padding: '12px 14px', background: 'none', border: 'none',
                  cursor: 'pointer', textAlign: 'left', display: 'flex',
                  alignItems: 'center', gap: 10
                }}
              >
                <span style={{ color: '#64748b', fontSize: '0.8rem', flexShrink: 0 }}>
                  {expanded ? '▼' : '▶'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.92rem', color: '#e2e8f0', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {group.title}
                  </div>
                  {group.category_name && (
                    <span style={{
                      fontSize: '0.7rem', padding: '1px 6px', borderRadius: 99, marginTop: 3, display: 'inline-block',
                      background: `${group.category_color ?? '#6366f1'}30`,
                      color: group.category_color ?? '#6366f1'
                    }}>
                      {group.category_name}
                    </span>
                  )}
                </div>
                {/* 合計時間バー */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '1rem', color: '#4ade80', fontWeight: 'bold' }}>
                    {formatDuration(group.total_seconds)}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#475569' }}>
                    {group.entries.length}件
                  </div>
                </div>
              </button>

              {/* 展開: 日付ごとのエントリ */}
              {expanded && (
                <div style={{ borderTop: '1px solid #0f172a' }}>
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
                            fontSize: '0.72rem', color: '#6366f1', fontWeight: 'bold',
                            background: '#6366f115', padding: '2px 8px', borderRadius: 99
                          }}>
                            {dateLabel}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
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
                              background: '#0f172a'
                            }}
                          >
                            <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>
                              {formatTime(entry.start_time)}–{formatTime(entry.end_time)}
                            </span>
                            <span style={{ fontSize: '0.8rem', color: '#4ade80', flexShrink: 0 }}>
                              {formatDuration(entry.duration_seconds)}
                            </span>
                            {entry.note && (
                              <span style={{ fontSize: '0.78rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
