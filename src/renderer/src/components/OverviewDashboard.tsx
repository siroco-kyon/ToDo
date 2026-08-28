import React, { useEffect, useState } from 'react'
import type {
  Category,
  OverviewCategoryStat,
  OverviewCompletedSubTaskItem,
  OverviewData,
  OverviewTaskItem,
  ProgressDigestUser,
  PublicUser,
  Todo,
  TodoCoAssignee
} from '../types'

interface Props {
  todos: Todo[]
  categories: Category[]
  users: PublicUser[]
  selectedAssigneeId: string | null
  includePrivate: boolean
  runningTodoId: string | null
  elapsedSeconds: number
  onSelectTodo: (id: string) => void
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day)
}

function diffCalendarDays(dateStr: string, baseDateStr: string): number {
  const diffMs = parseDateKey(dateStr).getTime() - parseDateKey(baseDateStr).getTime()
  return Math.round(diffMs / 86400000)
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}分`
  if (mins === 0) return `${hours}時間`
  return `${hours}時間${mins}分`
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

function AssigneeLabels({
  assigneeName,
  assigneeColor,
  coAssignees = [],
  label
}: {
  assigneeName: string | null
  assigneeColor: string | null
  coAssignees?: TodoCoAssignee[]
  label?: string
}): React.JSX.Element {
  const names = [assigneeName, ...coAssignees.map((item) => item.display_name)].filter((name): name is string => Boolean(name))
  if (names.length === 0) {
    return <span style={{ fontSize: '0.72rem', color: '#64748b' }}>{label ? `${label}: ` : ''}未割り当て</span>
  }

  const visibleCoAssignees = coAssignees.slice(0, assigneeName ? 1 : 2)
  const hiddenCount = coAssignees.length - visibleCoAssignees.length
  return (
    <span title={names.join('、')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
      {label && <span style={{ fontSize: '0.68rem', color: '#64748b' }}>{label}:</span>}
      {assigneeName && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.72rem', color: '#cbd5e1' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: assigneeColor ?? '#64748b' }} />
          {assigneeName}
        </span>
      )}
      {visibleCoAssignees.map((item) => (
        <span key={item.user_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#94a3b8', background: '#1e293b', borderRadius: 999, padding: '1px 6px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.color }} />
          {item.display_name}
        </span>
      ))}
      {hiddenCount > 0 && <span style={{ fontSize: '0.68rem', color: '#64748b' }}>+{hiddenCount}</span>}
    </span>
  )
}

interface RecentMemberActivity {
  id: string
  at: string
  kind: string
  todoTitle: string
  detail?: string
}

function buildRecentMemberActivity(user: ProgressDigestUser): RecentMemberActivity[] {
  return [
    ...user.added_todos.map((item) => ({ id: `todo-${item.id}`, at: item.created_at, kind: 'タスク追加', todoTitle: item.title })),
    ...user.completed_todos.map((item) => ({ id: `done-${item.id}`, at: item.completed_at, kind: 'タスク完了', todoTitle: item.title })),
    ...user.added_subtasks.map((item) => ({ id: `sub-${item.id}`, at: item.created_at, kind: 'サブタスク追加', todoTitle: item.todo_title, detail: item.title })),
    ...user.task_changes.map((item) => ({ id: `change-${item.id}`, at: item.created_at, kind: 'タスク変更', todoTitle: item.todo_title, detail: item.field })),
    ...user.notes.map((item) => ({ id: `note-${item.id}`, at: item.created_at, kind: '進捗投稿', todoTitle: item.todo_title, detail: item.body })),
    ...user.comments.map((item) => ({ id: `comment-${item.id}`, at: item.created_at, kind: 'コメント', todoTitle: item.todo_title, detail: item.body }))
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3)
}

function MemberActivityCard({ user }: { user: ProgressDigestUser }): React.JSX.Element {
  const recent = buildRecentMemberActivity(user)
  const activityCount = user.added_todos.length + user.completed_todos.length + user.added_subtasks.length
    + user.task_changes.length + user.notes.length + user.comments.length + user.work_log_count

  const badges = [
    `作業 ${formatMinutes(user.work_minutes)}`,
    `記録 ${user.work_log_count}回`,
    `追加 ${user.added_todos.length}`,
    `完了 ${user.completed_todos.length}`,
    `サブタスク ${user.added_subtasks.length}`,
    `変更 ${user.task_changes.length}`,
    `進捗 ${user.notes.length}`,
    `コメント ${user.comments.length}`
  ]

  return (
    <article style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, padding: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
        <strong style={{ color: '#e2e8f0', fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.display_name}</strong>
        <span style={{ marginLeft: 'auto', color: activityCount > 0 ? '#86efac' : '#64748b', fontSize: '0.7rem' }}>
          {activityCount > 0 ? '活動あり' : '活動なし'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 }}>
        {badges.map((badge) => <span key={badge} style={{ background: '#1e293b', color: '#94a3b8', borderRadius: 999, padding: '2px 7px', fontSize: '0.66rem' }}>{badge}</span>)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 11 }}>
        {recent.length === 0 ? (
          <span style={{ color: '#64748b', fontSize: '0.74rem' }}>この期間の活動はありません。</span>
        ) : recent.map((item) => (
          <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '2px 8px', fontSize: '0.72rem' }}>
            <span style={{ color: '#a78bfa' }}>{item.kind}</span>
            <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.todoTitle}</span>
            <span style={{ color: '#475569' }}>{formatDateTime(item.at)}</span>
            {item.detail ? <span title={item.detail} style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.detail}</span> : <span />}
          </div>
        ))}
      </div>
    </article>
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

      <div style={{ marginTop: 7 }}>
        <AssigneeLabels assigneeName={item.assigneeName} assigneeColor={item.assigneeColor} coAssignees={item.coAssignees} label="担当" />
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
      <div style={{ marginTop: 7, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {item.assignee_name && (
          <AssigneeLabels assigneeName={item.assignee_name} assigneeColor={item.assignee_color} label="サブタスク担当" />
        )}
        <AssigneeLabels assigneeName={item.parent_assignee_name} assigneeColor={item.parent_assignee_color} coAssignees={item.parent_co_assignees} label="親担当" />
      </div>
    </button>
  )
}

export function OverviewDashboard({
  todos,
  categories,
  users,
  selectedAssigneeId,
  includePrivate,
  runningTodoId,
  elapsedSeconds,
  onSelectTodo
}: Props): React.JSX.Element {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      setLoading(true)
      setData(null)
      try {
        const nextData = await window.api.overviewGetData({ assigneeId: selectedAssigneeId, includePrivate })

        if (!cancelled) {
          setData(nextData)
        }
      } catch {
        if (!cancelled) {
          setData(null)
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
  }, [todos, categories, runningTodoId, selectedAssigneeId, includePrivate])

  const runningTodo = todos.find((todo) => todo.id === runningTodoId) ?? null
  const atRiskCount = data ? data.summary.overdueTasks + data.summary.dueSoonTasks : 0
  const selectedUser = selectedAssigneeId ? users.find((user) => user.id === selectedAssigneeId) : null
  const scopeLabel = users.length === 0
    ? '自分'
    : selectedAssigneeId === null
      ? '全員'
      : selectedAssigneeId === ''
        ? '未割り当て'
        : `${selectedUser?.display_name ?? '不明なユーザー'}${selectedUser?.is_active === 0 ? '（無効）' : ''}`
  const activityWorkMinutes = data?.memberActivity.reduce((sum, user) => sum + user.work_minutes, 0) ?? 0
  const activityLogCount = data?.memberActivity.reduce((sum, user) => sum + user.work_log_count, 0) ?? 0

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '1.2rem', color: '#f8fafc', fontWeight: 700 }}>
            ダッシュボード
          </div>
          <div style={{ fontSize: '0.82rem', color: '#64748b', marginTop: 4 }}>
            {data?.categories.length ?? 0}カテゴリを1画面で俯瞰
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, border: '1px solid #334155', background: '#111827', borderRadius: 999, padding: '3px 9px', fontSize: '0.74rem', color: '#cbd5e1' }}>
            {selectedUser && <span style={{ width: 7, height: 7, borderRadius: '50%', background: selectedUser.color }} />}
            対象: {scopeLabel}
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

          <Section title={selectedAssigneeId === null ? 'メンバーそれぞれの活動' : `${scopeLabel}の活動`} subtitle={`${data.activityFrom}〜${data.activityTo}・作業 ${formatMinutes(activityWorkMinutes)} / ${activityLogCount}回 記録`}>
            {selectedAssigneeId === '' ? (
              <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '8px 2px' }}>
                未割り当てタスクには、メンバーに紐づく活動集計はありません。
              </div>
            ) : data.memberActivity.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.82rem', padding: '8px 2px' }}>
                この期間に表示できるメンバー活動はありません。
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                {data.memberActivity.map((user) => <MemberActivityCard key={user.user_id ?? 'desktop'} user={user} />)}
              </div>
            )}
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
