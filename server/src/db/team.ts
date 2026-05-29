import { getDb } from './connection'
import { clampRunningSeconds, diffCalendarDays, getTodayKey } from './helpers'
import type {
  TeamDashboard,
  TeamDeadlineItem,
  TeamMemberWorkload,
  TeamNowItem
} from './types'

/** Everyone with a running timer right now, with the task they are on. */
export function getTeamNow(): TeamNowItem[] {
  const rows = getDb()
    .prepare(
      `SELECT rs.user_id, rs.todo_id, rs.start_time,
              u.display_name, u.color AS user_color,
              t.title AS todo_title,
              c.name AS category_name, c.color AS category_color
       FROM RunningState rs
       JOIN Users u ON rs.user_id = u.id
       JOIN Todos t ON rs.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       ORDER BY rs.start_time ASC`
    )
    .all() as Array<Omit<TeamNowItem, 'elapsed_seconds'>>

  const now = new Date()
  return rows.map((row) => ({
    ...row,
    elapsed_seconds: Math.max(0, Math.floor((now.getTime() - new Date(row.start_time).getTime()) / 1000))
  }))
}

interface DeadlineRow {
  todo_id: string
  title: string
  due_date: string
  status: TeamDeadlineItem['status']
  priority: number
  progress: number
  category_name: string | null
  category_color: string | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
}

function getActiveDatedTodos(): DeadlineRow[] {
  return getDb()
    .prepare(
      `SELECT t.id AS todo_id, t.title, t.due_date, t.status, t.priority, t.progress,
              c.name AS category_name, c.color AS category_color,
              t.assignee_id, u.display_name AS assignee_name, u.color AS assignee_color
       FROM Todos t
       LEFT JOIN Categories c ON t.category_id = c.id
       LEFT JOIN Users u ON t.assignee_id = u.id
       WHERE t.status NOT IN ('done', 'archived') AND t.due_date IS NOT NULL
       ORDER BY t.due_date ASC, t.priority DESC`
    )
    .all() as DeadlineRow[]
}

/** Overdue + soon-due tasks across the team, each tagged with days until due. */
export function getTeamDeadlines(): { overdue: TeamDeadlineItem[]; dueSoon: TeamDeadlineItem[] } {
  const todayKey = getTodayKey()
  const overdue: TeamDeadlineItem[] = []
  const dueSoon: TeamDeadlineItem[] = []

  for (const row of getActiveDatedTodos()) {
    const daysUntilDue = diffCalendarDays(row.due_date, todayKey)
    const item: TeamDeadlineItem = { ...row, days_until_due: daysUntilDue }
    if (daysUntilDue < 0) overdue.push(item)
    else if (daysUntilDue <= 3) dueSoon.push(item)
  }

  return { overdue, dueSoon }
}

/** Per-member load: active tasks, overdue count, minutes logged today (incl. running). */
export function getTeamWorkloads(): TeamMemberWorkload[] {
  const db = getDb()
  const todayKey = getTodayKey()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const now = new Date()

  const users = db
    .prepare("SELECT id, display_name, color FROM Users WHERE is_active = 1 ORDER BY display_name ASC")
    .all() as Array<{ id: string; display_name: string; color: string }>

  return users.map((user) => {
    const assigned = db
      .prepare("SELECT due_date FROM Todos WHERE assignee_id = ? AND status NOT IN ('done', 'archived')")
      .all(user.id) as Array<{ due_date: string | null }>

    const overdueTasks = assigned.filter(
      (t) => t.due_date && diffCalendarDays(t.due_date, todayKey) < 0
    ).length

    const loggedRow = db
      .prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM WorkLogs WHERE user_id = ? AND start_time >= ?')
      .get(user.id, todayStart.toISOString()) as { total: number }

    const running = db
      .prepare('SELECT start_time FROM RunningState WHERE user_id = ?')
      .get(user.id) as { start_time: string } | undefined
    const runningToday = running ? clampRunningSeconds(running.start_time, todayStart, now) : 0

    return {
      user_id: user.id,
      display_name: user.display_name,
      user_color: user.color,
      active_tasks: assigned.length,
      overdue_tasks: overdueTasks,
      today_minutes: Math.round((loggedRow.total + runningToday) / 60)
    }
  })
}

export function getTeamDashboard(): TeamDashboard {
  const { overdue, dueSoon } = getTeamDeadlines()
  return {
    now: getTeamNow(),
    overdue,
    dueSoon,
    workloads: getTeamWorkloads()
  }
}
