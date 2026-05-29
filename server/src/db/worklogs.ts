import { getDb } from './connection'
import type { TodayWorkLog, WorkLog, WorkLogSummaryRow } from './types'

/** All time logged against a single todo, across the whole team. */
export function getWorkLogsByTodo(todoId: string): WorkLog[] {
  return getDb()
    .prepare('SELECT * FROM WorkLogs WHERE todo_id = ? ORDER BY start_time DESC')
    .all(todoId) as WorkLog[]
}

export function getTodayWorkLogs(userId: string): TodayWorkLog[] {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)

  return getDb()
    .prepare(
      `SELECT wl.*, t.title, c.name AS category
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE wl.user_id = ? AND wl.start_time >= ? AND wl.start_time <= ?
       ORDER BY t.id, wl.start_time`
    )
    .all(userId, todayStart.toISOString(), todayEnd.toISOString()) as TodayWorkLog[]
}

export function getWorkLogsByDate(userId: string, dateStr: string): WorkLogSummaryRow[] {
  return getDb()
    .prepare(
      `SELECT wl.id, wl.todo_id, t.title,
              c.name AS category_name, c.color AS category_color,
              wl.start_time, wl.end_time, wl.duration_seconds, wl.note
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE wl.user_id = ? AND date(wl.start_time, 'localtime') = ?
       ORDER BY wl.start_time ASC`
    )
    .all(userId, dateStr) as WorkLogSummaryRow[]
}

export function getWorkLogsSummary(userId: string, days: number): WorkLogSummaryRow[] {
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  from.setHours(0, 0, 0, 0)

  return getDb()
    .prepare(
      `SELECT wl.id, wl.todo_id, t.title,
              c.name AS category_name, c.color AS category_color,
              wl.start_time, wl.end_time, wl.duration_seconds, wl.note
       FROM WorkLogs wl
       JOIN Todos t ON wl.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE wl.user_id = ? AND wl.start_time >= ?
       ORDER BY wl.start_time DESC`
    )
    .all(userId, from.toISOString()) as WorkLogSummaryRow[]
}
