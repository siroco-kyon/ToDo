import crypto from 'crypto'
import { getDb } from './connection'
import { normalizeTimeKey, shiftTimeKey } from './helpers'
import type { DailyPlanItem, UpdateDailyPlanItemInput } from './types'

const PLAN_SELECT = `
  SELECT
      dpi.*,
      t.title,
      t.description,
      t.category_id,
      t.assignee_id,
      t.status,
      t.priority,
      t.progress,
      t.start_date,
      t.due_date,
      c.name AS category_name,
      c.color AS category_color,
      u.display_name AS assignee_name,
      u.color AS assignee_color
   FROM DailyPlanItems dpi
   JOIN Todos t ON dpi.todo_id = t.id
   LEFT JOIN Categories c ON t.category_id = c.id
   LEFT JOIN Users u ON t.assignee_id = u.id
`

export function getDailyPlanItems(userId: string, planDate: string): DailyPlanItem[] {
  return getDb().prepare(
    `${PLAN_SELECT}
     WHERE dpi.plan_date = ? AND dpi.user_id = ?
     ORDER BY
       CASE WHEN dpi.scheduled_start IS NULL OR dpi.scheduled_start = '' THEN 1 ELSE 0 END ASC,
       dpi.scheduled_start ASC,
       dpi.lane ASC,
       dpi.sort_order ASC,
       dpi.created_at ASC`
  ).all(planDate, userId) as DailyPlanItem[]
}

export function addDailyPlanItem(userId: string, planDate: string, todoId: string): DailyPlanItem {
  const db = getDb()
  const existing = db.prepare(
    `${PLAN_SELECT} WHERE dpi.plan_date = ? AND dpi.todo_id = ? AND dpi.user_id = ?`
  ).get(planDate, todoId, userId) as DailyPlanItem | undefined

  if (existing) return existing

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const maxOrder = (
    db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM DailyPlanItems WHERE plan_date = ? AND user_id = ?').get(planDate, userId) as { m: number }
  ).m

  db.prepare(
    `INSERT INTO DailyPlanItems (id, plan_date, todo_id, user_id, scheduled_start, estimated_minutes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 60, ?, ?, ?)`
  ).run(id, planDate, todoId, userId, maxOrder + 1, now, now)

  return db.prepare(`${PLAN_SELECT} WHERE dpi.id = ?`).get(id) as DailyPlanItem
}

export function updateDailyPlanItem(id: string, data: UpdateDailyPlanItemInput): DailyPlanItem {
  const db = getDb()
  const now = new Date().toISOString()
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]

  if (data.scheduled_start !== undefined) {
    fields.push('scheduled_start = ?')
    values.push(normalizeTimeKey(data.scheduled_start))
  }
  if (data.estimated_minutes !== undefined) {
    const value = data.estimated_minutes == null ? null : Math.max(15, Math.min(480, Math.round(data.estimated_minutes / 15) * 15))
    fields.push('estimated_minutes = ?')
    values.push(value)
  }
  if (data.lane !== undefined) {
    fields.push('lane = ?')
    values.push(Math.max(0, Math.min(2, data.lane)))
  }

  values.push(id)
  db.prepare(`UPDATE DailyPlanItems SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  return db.prepare(`${PLAN_SELECT} WHERE dpi.id = ?`).get(id) as DailyPlanItem
}

export function shiftDailyPlanItem(id: string, deltaMinutes: number): DailyPlanItem {
  const current = getDb().prepare('SELECT scheduled_start FROM DailyPlanItems WHERE id = ?').get(id) as { scheduled_start: string | null } | undefined
  const nextTime = current?.scheduled_start ? shiftTimeKey(current.scheduled_start, deltaMinutes) : null
  return updateDailyPlanItem(id, { scheduled_start: nextTime })
}

export function deleteDailyPlanItem(id: string): void {
  getDb().prepare('DELETE FROM DailyPlanItems WHERE id = ?').run(id)
}

export function reorderDailyPlanItems(userId: string, planDate: string, orderedIds: string[]): void {
  const db = getDb()
  const update = db.prepare('UPDATE DailyPlanItems SET sort_order = ?, updated_at = ? WHERE id = ? AND plan_date = ? AND user_id = ?')
  const now = new Date().toISOString()
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, now, id, planDate, userId))
  })()
}
