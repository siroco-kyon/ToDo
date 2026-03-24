import React, { useEffect, useState } from 'react'
import type {
  Category,
  OverviewCategoryStat,
  OverviewCompletedSubTaskItem,
  OverviewData,
  OverviewTaskItem,
  Todo,
  WorkLogSummaryRow
} from '../types'

interface Props {
  todos: Todo[]
  categories: Category[]
  runningTodoId: string | null
  elapsedSeconds: number
  onSelectTodo: (id: string) => void
}

interface WeeklyTaskActivity {
  todoId: string
  title: string
  categoryName: string | null
  categoryColor: string | null
  totalSeconds: number
  entryCount: number
  daysWorked: number
  lastWorkedAt: string
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function getWeekStart(): Date {
  const now = new Date()
  const start = new Date(now)
  const day = start.getDay()
  const diff = day === 0 ? -6 : 1 - day
  start.setDate(start.getDate() + diff)
  start.setHours(0, 0, 0, 0)
  return start
}

function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function diffCalendarDays(dateStr: string, baseDateStr: string): number {
  const diffMs = parseDateKey(dateStr).getTime() - parseDateKey(baseDateStr).getTime()
  return Math.round(diffMs / 86400000)
}

function getLocalDateKey(isoStr: string): string {
  const d = new Date(isoStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}分`
  if (mins === 0) return `${hours}時間`
  return `${hours}時間${mins}分`
}

function formatSeconds(seconds: number): string {
  return formatMinutes(Math.round(seconds / 60))
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function formatDueLabel(dueDate: string | null): string {
  if (!dueDate) return '期限未設定'
  const diffDays = diffCalendarDays(dueDate, getTodayKey())
  if (diffDays < 0) return `${Math.abs(diffDays)}日遅れ`
  if (diffDays === 0) return '今日が期限'
  if (diffDays === 1) return '明日が期限'
  return `あと${diffDays}日`
}

function formatIdleLabel(updatedAt: string): string {
  const diffMs = Date.now() - new Date(updatedAt).getTime()
  const diffDays = Math.max(0, Math.floor(diffMs / 86400000))
  if (diffDays === 0) return '今日更新'
  if (diffDays === 1) return '1日更新なし'
  return `${diffDays}日更新なし`
}

function formatMonthDay(isoStr: string): string {
  const d = new Date(isoStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function formatDateTime(isoStr: string): string {
  const d = new Date(isoStr)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function reasonLabel(reason: OverviewTaskItem['reason']): string {
  if (reason === 'overdue') return '期限超過'
  if (reason === 'dueSoon') return '期限近い'
  if (reason === 'highPriority') return '高優先度'
  if (reason === 'stale') return '停滞'
  if (reason === 'dueToday') return '今日'
  return '完了間近'
}

function reasonTone(reason: OverviewTaskItem['reason']): { color: string; background: string; border: string } {
  if (reason === 'overdue') return { color: '#fecaca', background: '#7f1d1d', border: '#b91c1c' }
  if (reason === 'dueSoon' || reason === 'dueToday') return { color: '#fed7aa', background: '#7c2d12', border: '#ea580c' }
  if (reason === 'highPriority') return { color: '#fde68a', background: '#78350f', border: '#d97706' }
  if (reason === 'stale') return { color: '#cbd5e1', background: '#1e293b', border: '#475569' }
  return { color: '#bfdbfe', background: '#172554', border: '#2563eb' }
}

function buildWeeklyActivity(rows: WorkLogSummaryRow[]): WeeklyTaskActivity[] {
  const map = new Map<string, WeeklyTaskActivity & { dayKeys: Set<string> }>()

  rows.forEach((row) => {
    const existing = map.get(row.todo_id)
    if (!existing) {
      map.set(row.todo_id, {
        todoId: row.todo_id,
        title: row.title,
        categoryName: row.category_name,
        categoryColor: row.category_color,
        totalSeconds: row.duration_seconds,
        entryCount: 1,
        daysWorked: 0,
        lastWorkedAt: row.end_time,
        dayKeys: new Set([getLocalDateKey(row.start_time)])
      })
      return
    }

    existing.totalSeconds += row.duration_seconds
    existing.entryCount += 1
    existing.dayKeys.add(getLocalDateKey(row.start_time))
    if (new Date(row.end_time).getTime() > new Date(existing.lastWorkedAt).getTime()) {
      existing.lastWorkedAt = row.end_time
    }
  })

  return [...map.values()]
    .map((item) => ({
      todoId: item.todoId,
      title: item.title,
      categoryName: item.categoryName,
      categoryColor: item.categoryColor,
      totalSeconds: item.totalSeconds,
      entryCount: item.entryCount,
      daysWorked: item.dayKeys.size,
      lastWorkedAt: item.lastWorkedAt
    }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds || b.entryCount - a.entryCount)
}

function SummaryCard({
  label,
  value,
  detail,
  tone
}: {
  label: string
  value: string
  detail: string
  tone: string
}): React.JSX.Element {
  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid #1f2937',
        borderRadius: 14,
        padding: '14px 16px',
        minWidth: 0
      }}
    >
      <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.5rem', color: tone, fontWeight: 700, marginTop: 8 }}>
        {value}
      </div>
      <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: 6 }}>
        {detail}
      </div>
    </div>
  )
}

function Section({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      style={{
        background: '#111827',
        border: '1px solid #1f2937',
        borderRadius: 16,
        padding: 16,
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: '0.95rem', color: '#e5e7eb', fontWeight: 700 }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: '0.76rem', color: '#64748b' }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </section>
  )
}

function CategoryRow({ category }: { category: OverviewCategoryStat }): React.JSX.Element {
  const tone = category.categoryColor ?? '#6366f1'

  return (
    <div
      style={{
        background: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: 12,
        padding: '12px 14px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: tone,
            flexShrink: 0
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.88rem', color: '#e5e7eb', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {category.categoryName}
          </div>
          <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
            {category.doneTasks}/{category.totalTasks}件 完了
            {'  ・  '}
            {category.activeTasks}件 進行中
            {category.overdueTasks > 0 ? `  ・  ${category.overdueTasks}件 期限超過` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '0.92rem', color: '#f8fafc', fontWeight: 700 }}>
            {category.completionScore}%
          </div>
          <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
            平均 {category.avgActiveProgress}%
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, height: 8, background: '#020617', borderRadius: 999 }}>
        <div
          style={{
            height: '100%',
            width: `${category.completionScore}%`,
            background: `linear-gradient(90deg, ${tone}, #22c55e)`,
            borderRadius: 999
          }}
        />
      </div>
    </div>
  )
}

function TaskRow({
  item,
  onSelect
}: {
  item: OverviewTaskItem
  onSelect: (id: string) => void
}): React.JSX.Element {
  const tone = reasonTone(item.reason)

  return (
    <button
      onClick={() => onSelect(item.todoId)}
      style={{
        width: '100%',
        background: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: 12,
        padding: '12px 14px',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: '0.68rem',
            color: tone.color,
            background: tone.background,
            border: `1px solid ${tone.border}`,
            borderRadius: 999,
            padding: '2px 8px',
            flexShrink: 0
          }}
        >
          {reasonLabel(item.reason)}
        </span>
        {item.categoryName && (
          <span
            style={{
              fontSize: '0.68rem',
              color: item.categoryColor ?? '#a5b4fc',
              background: `${item.categoryColor ?? '#6366f1'}20`,
              borderRadius: 999,
              padding: '2px 8px',
              flexShrink: 0
            }}
          >
            {item.categoryName}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#fbbf24' }}>
          優先度 {item.priority}
        </span>
      </div>

      <div style={{ marginTop: 10, fontSize: '0.9rem', color: '#e5e7eb', fontWeight: 600, lineHeight: 1.45 }}>
        {item.title}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ fontSize: '0.75rem', color: '#93c5fd' }}>
          {formatDueLabel(item.dueDate)}
        </span>
        <span style={{ fontSize: '0.75rem', color: '#86efac' }}>
          進捗 {item.progress}%
        </span>
        {item.subTaskTotal > 0 && (
          <span style={{ fontSize: '0.75rem', color: '#cbd5e1' }}>
            サブタスク {item.subTaskDone}/{item.subTaskTotal}
          </span>
        )}
        <span style={{ fontSize: '0.75rem', color: '#64748b', marginLeft: 'auto' }}>
          {formatIdleLabel(item.updatedAt)}
        </span>
      </div>
    </button>
  )
}

function TaskList({
  title,
  subtitle,
  items,
  emptyLabel,
  onSelectTodo
}: {
  title: string
  subtitle?: string
  items: OverviewTaskItem[]
  emptyLabel: string
  onSelectTodo: (id: string) => void
}): React.JSX.Element {
  return (
    <Section title={title} subtitle={subtitle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '8px 2px' }}>
            {emptyLabel}
          </div>
        ) : (
          items.map((item) => (
            <TaskRow key={`${title}-${item.todoId}`} item={item} onSelect={onSelectTodo} />
          ))
        )}
      </div>
    </Section>
  )
}

function WeeklyStatCard({
  label,
  value,
  detail,
  tone
}: {
  label: string
  value: string
  detail: string
  tone: string
}): React.JSX.Element {
  return (
    <div
      style={{
        background: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: 12,
        padding: '12px 14px'
      }}
    >
      <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', color: tone, fontWeight: 700, marginTop: 8 }}>{value}</div>
      <div style={{ fontSize: '0.76rem', color: '#94a3b8', marginTop: 6 }}>{detail}</div>
    </div>
  )
}

function WeeklyActivityRow({
  activity,
  maxSeconds,
  onSelect
}: {
  activity: WeeklyTaskActivity
  maxSeconds: number
  onSelect: (id: string) => void
}): React.JSX.Element {
  const fill = maxSeconds > 0 ? Math.max(12, Math.round((activity.totalSeconds / maxSeconds) * 100)) : 0
  const tone = activity.categoryColor ?? '#6366f1'

  return (
    <button
      onClick={() => onSelect(activity.todoId)}
      style={{
        width: '100%',
        background: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: 12,
        padding: '12px 14px',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.88rem', color: '#e5e7eb', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activity.title}
          </div>
          {activity.categoryName && (
            <div style={{ fontSize: '0.7rem', color: activity.categoryColor ?? '#a5b4fc', marginTop: 4 }}>
              {activity.categoryName}
            </div>
          )}
        </div>
        <div style={{ fontSize: '0.9rem', color: '#f8fafc', fontWeight: 700, flexShrink: 0 }}>
          {formatSeconds(activity.totalSeconds)}
        </div>
      </div>

      <div style={{ marginTop: 10, height: 7, background: '#020617', borderRadius: 999 }}>
        <div
          style={{
            height: '100%',
            width: `${fill}%`,
            background: `linear-gradient(90deg, ${tone}, #22c55e)`,
            borderRadius: 999
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ fontSize: '0.74rem', color: '#cbd5e1' }}>{activity.entryCount}回 記録</span>
        <span style={{ fontSize: '0.74rem', color: '#93c5fd' }}>{activity.daysWorked}日 作業</span>
        <span style={{ fontSize: '0.74rem', color: '#64748b', marginLeft: 'auto' }}>
          最終 {formatMonthDay(activity.lastWorkedAt)}
        </span>
      </div>
    </button>
  )
}

function CompletedSubTaskRow({
  item,
  onSelect
}: {
  item: OverviewCompletedSubTaskItem
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      onClick={() => onSelect(item.todo_id)}
      style={{
        width: '100%',
        background: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: 12,
        padding: '12px 14px',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: '0.68rem',
            color: '#86efac',
            background: '#052e16',
            border: '1px solid #166534',
            borderRadius: 999,
            padding: '2px 8px'
          }}
        >
          完了
        </span>
        {item.category_name && (
          <span
            style={{
              fontSize: '0.68rem',
              color: item.category_color ?? '#a5b4fc',
              background: `${item.category_color ?? '#6366f1'}20`,
              borderRadius: 999,
              padding: '2px 8px'
            }}
          >
            {item.category_name}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#64748b' }}>
          {formatDateTime(item.completed_at)}
        </span>
      </div>

      <div style={{ marginTop: 10, fontSize: '0.9rem', color: '#e5e7eb', fontWeight: 600, lineHeight: 1.45 }}>
        {item.title}
      </div>
      <div style={{ marginTop: 6, fontSize: '0.74rem', color: '#94a3b8' }}>
        親タスク: {item.todo_title}
      </div>
    </button>
  )
}

export function OverviewDashboard({
  todos,
  categories,
  runningTodoId,
  elapsedSeconds,
  onSelectTodo
}: Props): React.JSX.Element {
  const [data, setData] = useState<OverviewData | null>(null)
  const [weeklyActivity, setWeeklyActivity] = useState<WeeklyTaskActivity[]>([])
  const [weekEntryCount, setWeekEntryCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      setLoading(true)
      try {
        const [nextData, weekRows] = await Promise.all([
          window.api.overviewGetData(),
          window.api.worklogGetSummary(7)
        ])

        const weekStart = getWeekStart().getTime()
        const currentWeekRows = weekRows.filter((row) => new Date(row.start_time).getTime() >= weekStart)

        if (!cancelled) {
          setData(nextData)
          setWeeklyActivity(buildWeeklyActivity(currentWeekRows))
          setWeekEntryCount(currentWeekRows.length)
        }
      } catch {
        if (!cancelled) {
          setData(null)
          setWeeklyActivity([])
          setWeekEntryCount(0)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [todos, categories, runningTodoId])

  const runningTodo = todos.find((todo) => todo.id === runningTodoId) ?? null
  const atRiskCount = data ? data.summary.overdueTasks + data.summary.dueSoonTasks : 0
  const topWeeklySeconds = weeklyActivity[0]?.totalSeconds ?? 0
  const currentWeekMinutes = Math.round(weeklyActivity.reduce((sum, item) => sum + item.totalSeconds, 0) / 60)

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '1.2rem', color: '#f8fafc', fontWeight: 700 }}>
            ダッシュボード
          </div>
          <div style={{ fontSize: '0.82rem', color: '#64748b', marginTop: 4 }}>
            {categories.length}カテゴリを1画面で俯瞰
          </div>
        </div>
        {data && (
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
            進行中 {data.summary.activeTasks}件 / 完了 {data.summary.doneTasks}件
          </div>
        )}
      </div>

      {loading && !data ? (
        <div style={{ color: '#64748b', fontSize: '0.9rem', paddingTop: 24 }}>
          ダッシュボードを読み込み中...
        </div>
      ) : null}

      {!loading && !data ? (
        <div style={{ color: '#fca5a5', fontSize: '0.9rem', paddingTop: 24 }}>
          ダッシュボードの読み込みに失敗しました。
        </div>
      ) : null}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <SummaryCard
              label="完了率"
              value={`${data.summary.completionRate}%`}
              detail={`${data.summary.doneTasks}/${data.summary.totalTasks}件 完了`}
              tone="#4ade80"
            />
            <SummaryCard
              label="進捗スコア"
              value={`${data.summary.completionScore}%`}
              detail={`進行中平均 ${data.summary.avgActiveProgress}%`}
              tone="#60a5fa"
            />
            <SummaryCard
              label="進行中"
              value={`${data.summary.activeTasks}`}
              detail="現在動いているタスク"
              tone="#f8fafc"
            />
            <SummaryCard
              label="要注意"
              value={`${atRiskCount}`}
              detail={`期限超過 ${data.summary.overdueTasks}件 / 直近 ${data.summary.dueSoonTasks}件`}
              tone={atRiskCount > 0 ? '#fb7185' : '#4ade80'}
            />
            <SummaryCard
              label="今日の作業"
              value={formatMinutes(data.summary.todayMinutes)}
              detail="今日の記録時間"
              tone="#fbbf24"
            />
            <SummaryCard
              label="今週完了サブタスク"
              value={`${data.summary.completedSubTasksThisWeek}件`}
              detail="今週完了したサブタスク数"
              tone="#34d399"
            />
          </div>

          <Section title="今週やったこと" subtitle={`${weeklyActivity.length}タスク / ${weekEntryCount}回 記録`}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 0.85fr) minmax(0, 1.6fr)', gap: 16, alignItems: 'start' }}>
              <div style={{ display: 'grid', gap: 10 }}>
                <WeeklyStatCard
                  label="今週の作業時間"
                  value={formatMinutes(currentWeekMinutes)}
                  detail="今週の作業ログ合計"
                  tone="#a78bfa"
                />
                <WeeklyStatCard
                  label="触ったタスク"
                  value={`${weeklyActivity.length}件`}
                  detail="今週ログがあるタスク数"
                  tone="#60a5fa"
                />
                <WeeklyStatCard
                  label="記録回数"
                  value={`${weekEntryCount}回`}
                  detail="タイマー停止で残った件数"
                  tone="#4ade80"
                />
                <WeeklyStatCard
                  label="完了サブタスク"
                  value={`${data.summary.completedSubTasksThisWeek}件`}
                  detail="今週完了したサブタスク"
                  tone="#34d399"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {weeklyActivity.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '8px 2px' }}>
                    今週の作業ログはまだありません。
                  </div>
                ) : (
                  weeklyActivity.slice(0, 6).map((activity) => (
                    <WeeklyActivityRow
                      key={activity.todoId}
                      activity={activity}
                      maxSeconds={topWeeklySeconds}
                      onSelect={onSelectTodo}
                    />
                  ))
                )}
              </div>
            </div>
          </Section>

          <Section title="今週完了したサブタスク" subtitle={`${data.completedSubTasks.length}件を表示`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.completedSubTasks.length === 0 ? (
                <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '8px 2px' }}>
                  今週完了したサブタスクはありません。
                </div>
              ) : (
                data.completedSubTasks.map((item) => (
                  <CompletedSubTaskRow key={item.id} item={item} onSelect={onSelectTodo} />
                ))
              )}
            </div>
          </Section>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(320px, 1fr)', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              <Section title="カテゴリ進捗" subtitle={`${data.categories.length}カテゴリ`}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {data.categories.map((category) => (
                    <CategoryRow key={category.categoryId ?? 'uncategorized'} category={category} />
                  ))}
                </div>
              </Section>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
                <TaskList
                  title="期限が今日"
                  subtitle="締切が今日のタスク"
                  items={data.dueToday}
                  emptyLabel="期限が今日のタスクはありません。"
                  onSelectTodo={onSelectTodo}
                />
                <TaskList
                  title="完了間近"
                  subtitle="すぐ終わらせやすいタスク"
                  items={data.nearlyDone}
                  emptyLabel="完了間近のタスクはありません。"
                  onSelectTodo={onSelectTodo}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              <Section title="いま取り組み中" subtitle={runningTodo ? 'タイマー計測中' : '計測中のタスクはありません'}>
                {runningTodo ? (
                  <button
                    onClick={() => onSelectTodo(runningTodo.id)}
                    style={{
                      width: '100%',
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      borderRadius: 14,
                      padding: '14px 16px',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '0.72rem', color: '#4ade80', background: '#052e16', borderRadius: 999, padding: '2px 8px' }}>
                        計測中
                      </span>
                      {runningTodo.category_name && (
                        <span
                          style={{
                            fontSize: '0.68rem',
                            color: runningTodo.category_color ?? '#a5b4fc',
                            background: `${runningTodo.category_color ?? '#6366f1'}20`,
                            borderRadius: 999,
                            padding: '2px 8px'
                          }}
                        >
                          {runningTodo.category_name}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 10, fontSize: '0.92rem', color: '#f8fafc', fontWeight: 600 }}>
                      {runningTodo.title}
                    </div>
                    <div style={{ marginTop: 10, fontSize: '1.3rem', color: '#4ade80', fontWeight: 700 }}>
                      {formatElapsed(elapsedSeconds)}
                    </div>
                  </button>
                ) : (
                  <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '8px 2px' }}>
                    どれかのタスクでタイマーを始めると、ここに表示されます。
                  </div>
                )}
              </Section>

              <TaskList
                title="ウォッチリスト"
                subtitle="先に見たほうがいいタスク"
                items={data.risks}
                emptyLabel="急ぎの注意タスクはありません。"
                onSelectTodo={onSelectTodo}
              />
              <TaskList
                title="高優先度"
                subtitle="重要度の高い進行中タスク"
                items={data.highPriority}
                emptyLabel="進行中の高優先度タスクはありません。"
                onSelectTodo={onSelectTodo}
              />
              <TaskList
                title="停滞中"
                subtitle="しばらく更新がないタスク"
                items={data.stale}
                emptyLabel="停滞しているタスクはありません。"
                onSelectTodo={onSelectTodo}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
