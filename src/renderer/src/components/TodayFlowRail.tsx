import React, { useMemo } from 'react'
import type { DailyPlanItem } from '../types'

interface Props {
  date: string
  planItems: DailyPlanItem[]
  runningTodoId: string | null
  onSelectTodo: (id: string) => void
  onOpenPlan: () => void
}

interface TimedItem extends DailyPlanItem {
  startMinutes: number
  endMinutes: number
  durationMinutes: number
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function clockToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function formatClock(minutes: number): string {
  const safeMinutes = Math.max(0, minutes)
  const hours = Math.floor(safeMinutes / 60)
  const mins = safeMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}分`
  if (mins === 0) return `${hours}時間`
  return `${hours}時間${mins}分`
}

function normalizeDuration(minutes: number | null): number {
  const raw = minutes ?? 60
  return Math.max(15, raw)
}

function buildTimedItems(items: DailyPlanItem[]): TimedItem[] {
  return items
    .filter((item) => !!item.scheduled_start)
    .map((item) => {
      const startMinutes = clockToMinutes(item.scheduled_start!)
      const durationMinutes = normalizeDuration(item.estimated_minutes)
      return {
        ...item,
        startMinutes,
        durationMinutes,
        endMinutes: startMinutes + durationMinutes
      }
    })
    .sort((a, b) => {
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
}

function StatusCard({
  label,
  item,
  accent,
  emptyLabel,
  onSelect
}: {
  label: string
  item: TimedItem | null
  accent: string
  emptyLabel: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.72rem', color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      {item ? (
        <>
          <button
            onClick={() => onSelect(item.todo_id)}
            style={{ background: 'transparent', border: 'none', padding: 0, marginTop: 8, color: '#f8fafc', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700, textAlign: 'left' }}
          >
            {item.title}
          </button>
          <div style={{ marginTop: 6, fontSize: '0.75rem', color: accent }}>
            {formatClock(item.startMinutes)} - {formatClock(item.endMinutes)}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 8, fontSize: '0.78rem', color: '#64748b', lineHeight: 1.5 }}>{emptyLabel}</div>
      )}
    </div>
  )
}

export function TodayFlowRail({
  date,
  planItems,
  runningTodoId,
  onSelectTodo,
  onOpenPlan
}: Props): React.JSX.Element {
  const timedItems = useMemo(() => buildTimedItems(planItems), [planItems])
  const unscheduledItems = useMemo(
    () => planItems.filter((item) => !item.scheduled_start).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [planItems]
  )

  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
  const currentItem = date === getTodayKey()
    ? timedItems.find((item) => nowMinutes >= item.startMinutes && nowMinutes < item.endMinutes) ?? null
    : null
  const nextItem = date === getTodayKey()
    ? timedItems.find((item) => item.startMinutes > nowMinutes && item.status !== 'done' && item.status !== 'archived') ?? null
    : timedItems.find((item) => item.status !== 'done' && item.status !== 'archived') ?? null

  return (
    <aside style={{ height: '100%', background: '#0b1220', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ color: '#f8fafc', fontSize: '0.95rem', fontWeight: 700 }}>今日の予定</div>
            <div style={{ color: '#64748b', fontSize: '0.74rem', marginTop: 4 }}>{date}</div>
          </div>
          <button
            onClick={onOpenPlan}
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              color: '#dbeafe',
              borderRadius: 8,
              padding: '6px 10px',
              cursor: 'pointer',
              fontSize: '0.74rem',
              fontWeight: 700
            }}
          >
            計画を開く
          </button>
        </div>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
          <StatusCard
            label="いま"
            item={currentItem}
            accent="#fb923c"
            emptyLabel="今の時間帯に入っている予定はありません。"
            onSelect={onSelectTodo}
          />
          <StatusCard
            label="つぎ"
            item={nextItem}
            accent="#60a5fa"
            emptyLabel="次の予定はまだ入っていません。"
            onSelect={onSelectTodo}
          />
        </div>

        <section style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#e2e8f0' }}>予定一覧</div>
            <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{timedItems.length}件</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {timedItems.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.78rem', lineHeight: 1.5 }}>まだ時刻付きの予定はありません。</div>
            ) : (
              timedItems.map((item) => {
                const active = runningTodoId === item.todo_id || currentItem?.id === item.id

                return (
                  <button
                    key={item.id}
                    onClick={() => onSelectTodo(item.todo_id)}
                    style={{
                      background: active ? '#172554' : '#111827',
                      border: `1px solid ${active ? '#3b82f6' : '#1f2937'}`,
                      borderRadius: 10,
                      padding: '10px 12px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      color: '#e2e8f0'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.72rem', color: active ? '#dbeafe' : '#93c5fd', fontWeight: 700 }}>
                        {formatClock(item.startMinutes)} - {formatClock(item.endMinutes)}
                      </span>
                      <span style={{ fontSize: '0.68rem', color: '#64748b' }}>{formatDuration(item.durationMinutes)}</span>
                      {active && (
                        <span style={{ fontSize: '0.62rem', color: '#dbeafe', background: '#1d4ed8', borderRadius: 999, padding: '1px 6px' }}>
                          進行中
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 6, fontSize: '0.82rem', fontWeight: 700, color: '#f8fafc' }}>{item.title}</div>
                    {(item.category_name || item.due_date) && (
                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.68rem', color: '#94a3b8' }}>
                        {item.category_name && <span>{item.category_name}</span>}
                        {item.due_date && <span>期限 {item.due_date}</span>}
                      </div>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </section>

        {unscheduledItems.length > 0 && (
          <section style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#e2e8f0' }}>未定</div>
              <div style={{ fontSize: '0.72rem', color: '#fbbf24' }}>{unscheduledItems.length}件</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {unscheduledItems.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  onClick={() => onSelectTodo(item.todo_id)}
                  style={{
                    background: '#111827',
                    border: '1px dashed #334155',
                    borderRadius: 10,
                    padding: '9px 11px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: '#cbd5e1'
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 700 }}>{item.title}</div>
                  <div style={{ marginTop: 4, fontSize: '0.68rem', color: '#64748b' }}>
                    {formatDuration(normalizeDuration(item.estimated_minutes))}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
