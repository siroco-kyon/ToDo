import React, { useState, useEffect, useCallback } from 'react'
import type { Todo, WorkLogSummaryRow } from '../types'

interface Props {
  todos: Todo[]
  onSelectTodo: (id: string) => void
}

const WEEK_DAYS = ['日', '月', '火', '水', '木', '金', '土']

function getDueDateColor(dateStr: string): string {
  const diffDays = (new Date(dateStr).getTime() - Date.now()) / 86400000
  if (diffDays < 0) return '#ef4444'
  if (diffDays < 1) return '#f97316'
  if (diffDays < 3) return '#f59e0b'
  return ''
}

function fmt(isoStr: string): string {
  const d = new Date(isoStr)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function CalendarView({ todos, onSelectTodo }: Props): React.JSX.Element {
  const [current, setCurrent] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [logs, setLogs] = useState<WorkLogSummaryRow[]>([])
  const [loadingLogs, setLoadingLogs] = useState(false)

  const { year, month } = current
  const firstDayOfWeek = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  // due_dateでグループ化（アーカイブ除外）
  const byDate = new Map<string, Todo[]>()
  for (const todo of todos) {
    if (!todo.due_date || todo.status === 'archived') continue
    const key = todo.due_date.slice(0, 10)
    if (!byDate.has(key)) byDate.set(key, [])
    byDate.get(key)!.push(todo)
  }

  // セル生成
  const cells: (number | null)[] = [
    ...Array(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1)
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const prevMonth = (): void => {
    setCurrent(month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 })
    setSelectedDate(null)
  }
  const nextMonth = (): void => {
    setCurrent(month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 })
    setSelectedDate(null)
  }
  const goToday = (): void => {
    const d = new Date()
    setCurrent({ year: d.getFullYear(), month: d.getMonth() })
    setSelectedDate(null)
  }

  const loadLogs = useCallback(async (dateStr: string) => {
    setLoadingLogs(true)
    try {
      const data = await window.api.worklogGetByDate(dateStr)
      setLogs(data)
    } catch {
      setLogs([])
    } finally {
      setLoadingLogs(false)
    }
  }, [])

  const handleDayClick = (dateStr: string): void => {
    if (selectedDate === dateStr) {
      setSelectedDate(null)
      return
    }
    setSelectedDate(dateStr)
    loadLogs(dateStr)
  }

  const totalMins = logs.reduce((s, l) => s + Math.round(l.duration_seconds / 60), 0)

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* ─── カレンダー本体 ───────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        {/* ヘッダー */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={prevMonth} style={navBtn}>‹</button>
          <h2 style={{ flex: 1, textAlign: 'center', fontSize: '1rem', color: '#e2e8f0' }}>
            {year}年{month + 1}月
          </h2>
          <button onClick={nextMonth} style={navBtn}>›</button>
          <button onClick={goToday} style={{ ...navBtn, fontSize: '0.78rem', padding: '4px 10px' }}>今日</button>
        </div>

        {/* 曜日ヘッダー */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
          {WEEK_DAYS.map((d, i) => (
            <div key={d} style={{
              textAlign: 'center', fontSize: '0.72rem', fontWeight: 'bold', padding: '4px 0',
              color: i === 0 ? '#ef4444' : i === 6 ? '#60a5fa' : '#64748b'
            }}>
              {d}
            </div>
          ))}
        </div>

        {/* カレンダーグリッド */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3, flex: 1 }}>
          {cells.map((day, idx) => {
            if (!day) {
              return <div key={`empty-${idx}`} style={{ minHeight: 72 }} />
            }
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
            const dayTodos = byDate.get(dateStr) ?? []
            const isToday = dateStr === todayStr
            const isSelected = dateStr === selectedDate
            const dayOfWeek = idx % 7

            return (
              <div
                key={dateStr}
                onClick={() => handleDayClick(dateStr)}
                style={{
                  minHeight: 72,
                  background: isSelected ? '#1e3a5f' : isToday ? '#1e293b' : '#0d1525',
                  border: `1px solid ${isSelected ? '#6366f1' : isToday ? '#475569' : '#1e293b'}`,
                  borderRadius: 6, padding: '4px 5px',
                  display: 'flex', flexDirection: 'column', gap: 2,
                  cursor: 'pointer', transition: 'background 0.1s'
                }}
              >
                <div style={{
                  fontSize: '0.72rem', textAlign: 'right', marginBottom: 1,
                  color: isSelected ? '#818cf8' : isToday ? '#818cf8' : dayOfWeek === 0 ? '#ef4444' : dayOfWeek === 6 ? '#60a5fa' : '#475569',
                  fontWeight: isToday || isSelected ? 'bold' : 'normal'
                }}>
                  {day}
                </div>
                {dayTodos.map((todo) => {
                  const dueDateColor = getDueDateColor(dateStr)
                  const baseColor = todo.category_color ?? '#6366f1'
                  return (
                    <button
                      key={todo.id}
                      onClick={(e) => { e.stopPropagation(); onSelectTodo(todo.id) }}
                      title={todo.title}
                      style={{
                        background: todo.status === 'done'
                          ? '#16a34a20'
                          : dueDateColor
                            ? `${dueDateColor}20`
                            : `${baseColor}20`,
                        border: `1px solid ${todo.status === 'done' ? '#16a34a50' : dueDateColor ? `${dueDateColor}60` : `${baseColor}50`}`,
                        borderRadius: 3, padding: '2px 4px', cursor: 'pointer',
                        fontSize: '0.65rem', color: todo.status === 'done' ? '#4ade80' : '#e2e8f0',
                        textAlign: 'left', width: '100%',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        textDecoration: todo.status === 'done' ? 'line-through' : 'none',
                        lineHeight: 1.4
                      }}
                    >
                      {todo.title}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* 凡例 */}
        <div style={{ display: 'flex', gap: 14, fontSize: '0.68rem', color: '#475569', paddingTop: 4 }}>
          <span style={{ color: '#ef4444' }}>■ 期限切れ</span>
          <span style={{ color: '#f97316' }}>■ 今日まで</span>
          <span style={{ color: '#f59e0b' }}>■ 3日以内</span>
          <span style={{ color: '#4ade80' }}>■ 完了</span>
          <span style={{ marginLeft: 'auto', color: '#6366f1' }}>日付をクリック → 作業ログ表示</span>
        </div>
      </div>

      {/* ─── 作業ログパネル ───────────────────────────────── */}
      {selectedDate && (
        <div style={{
          width: 260, flexShrink: 0,
          borderLeft: '1px solid #1e293b',
          background: '#0a0f1a',
          overflowY: 'auto', padding: 14,
          display: 'flex', flexDirection: 'column', gap: 10
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 'bold' }}>{selectedDate}</span>
            <button
              onClick={() => setSelectedDate(null)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '1rem', padding: '0 2px' }}
            >×</button>
          </div>

          {loadingLogs ? (
            <div style={{ color: '#475569', fontSize: '0.82rem' }}>読み込み中…</div>
          ) : logs.length === 0 ? (
            <div style={{ color: '#475569', fontSize: '0.82rem' }}>この日の作業ログはありません</div>
          ) : (
            <>
              <div style={{ fontSize: '0.72rem', color: '#4ade80', background: '#4ade8015', borderRadius: 6, padding: '4px 10px', textAlign: 'center' }}>
                合計 {totalMins}分
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {logs.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      background: '#1e293b', borderRadius: 8, padding: '8px 10px',
                      borderLeft: `3px solid ${log.category_color ?? '#6366f1'}`
                    }}
                  >
                    <div style={{ fontSize: '0.78rem', color: '#e2e8f0', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {log.title}
                    </div>
                    {log.category_name && (
                      <div style={{ fontSize: '0.65rem', color: log.category_color ?? '#6366f1', marginBottom: 3 }}>
                        {log.category_name}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                        {fmt(log.start_time)} ～ {fmt(log.end_time)}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: '#4ade80', marginLeft: 'auto' }}>
                        {Math.round(log.duration_seconds / 60)}分
                      </span>
                    </div>
                    {log.note && (
                      <div style={{ fontSize: '0.68rem', color: '#64748b', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        — {log.note}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
  color: '#94a3b8', cursor: 'pointer', fontSize: '1.1rem',
  padding: '4px 12px', lineHeight: 1
}
