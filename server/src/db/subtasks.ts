import { assertAssignableUser } from './users'
import crypto from 'crypto'
import HolidayJp from '@holiday-jp/holiday_jp'
import { getDb } from './connection'
import { assertExpectedValues } from '../shared/todo-update-guard'
import { isCheckStale, isItemRecurrence, normalizeRecurrenceDay, periodStartOf, periodsOverlapping, toLocalDateKey, type ItemRecurrence } from '../shared/recurring-period'
import { clampProgress, normalizeDateKey } from './helpers'
import { syncTodoDueDateWithSubTasks } from './todos'
import type { CalendarSubTask, CreateSubTaskInput, SubTask, SubTaskCheckSummary, UpdateSubTaskInput } from './types'

const SUBTASK_SELECT = `
  SELECT st.*,
         u.display_name AS assignee_name,
         u.color AS assignee_color
  FROM SubTasks st
  LEFT JOIN Users u ON st.assignee_id = u.id
`

const isHoliday = (date: Date): boolean => HolidayJp.isHoliday(date)

function normalizeItemRecurrence(value: unknown): ItemRecurrence | null {
  return isItemRecurrence(value) ? value : null
}

/** 項目の繰り返しは ToDoリストだけで使う（ふつうのタスクの項目には付けない） */
function isListTodoId(todoId: string): boolean {
  const row = getDb().prepare('SELECT list_mode FROM Todos WHERE id = ?').get(todoId) as { list_mode: number } | undefined
  return Boolean(row?.list_mode)
}

/**
 * ToDoリストの繰り返しの項目のうち、前の周期にチェックしたままのものを未チェックに戻す。戻した件数を返す。
 * 日付が変わったときの点検と、サブタスクの読み書きの前に呼ぶ。チェックの記録（SubTaskChecks）は残す。
 */
export function resetRecurringSubTasks(now: Date = new Date()): number {
  const db = getDb()
  const rows = db.prepare(
    // 終えた（完了・アーカイブ）ToDoリストの項目はそのままにしておく
    `SELECT st.id, st.recurrence, st.recurrence_workdays, st.recurrence_day, st.completed_at
     FROM SubTasks st JOIN Todos t ON t.id = st.todo_id
     WHERE st.recurrence IS NOT NULL AND st.done = 1 AND t.list_mode = 1 AND t.status NOT IN ('done', 'archived')`
  ).all() as Array<{ id: string; recurrence: string; recurrence_workdays: number; recurrence_day: number | null; completed_at: string | null }>
  const stale = rows.filter((row) => isItemRecurrence(row.recurrence)
    && isCheckStale(row.recurrence, Boolean(row.recurrence_workdays), row.completed_at, now, isHoliday, row.recurrence_day))
  if (stale.length === 0) return 0
  const reset = db.prepare('UPDATE SubTasks SET done = 0, progress = 0, completed_at = NULL WHERE id = ?')
  db.transaction(() => { for (const row of stale) reset.run(row.id) })()
  return stale.length
}

/** 繰り返しの項目のチェックを、いまの周期の記録として残す（外したときは消す） */
function recordRecurringCheck(subTask: SubTask, checked: boolean, userId: string | null): void {
  const recurrence = normalizeItemRecurrence(subTask.recurrence)
  if (!recurrence) return
  const now = new Date()
  const periodKey = periodStartOf(recurrence, Boolean(subTask.recurrence_workdays), toLocalDateKey(now), isHoliday, subTask.recurrence_day)
  const db = getDb()
  if (checked) {
    db.prepare(
      'INSERT OR IGNORE INTO SubTaskChecks (id, subtask_id, todo_id, period_key, user_id, checked_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), subTask.id, subTask.todo_id, periodKey, userId, now.toISOString())
  } else {
    db.prepare('DELETE FROM SubTaskChecks WHERE subtask_id = ? AND period_key = ?').run(subTask.id, periodKey)
  }
}

/** ToDoリストの繰り返しの項目ごとに、期間に重なる周期の数とチェックした数を返す（報告タブの実施状況） */
export function getSubTaskCheckSummaries(from: string, to: string): SubTaskCheckSummary[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('実施状況の期間が不正です')
  }
  const db = getDb()
  const items = db.prepare(
    `SELECT st.id, st.todo_id, st.recurrence, st.recurrence_workdays, st.recurrence_day, st.created_at
     FROM SubTasks st JOIN Todos t ON t.id = st.todo_id
     WHERE st.recurrence IS NOT NULL AND t.list_mode = 1`
  ).all() as Array<{ id: string; todo_id: string; recurrence: string; recurrence_workdays: number; recurrence_day: number | null; created_at: string }>
  if (items.length === 0) return []
  // 周期の始まりは期間の開始より前のこともある（毎月なら最大で約1か月前）
  const earliest = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)) - 40)
  const checks = db.prepare(
    'SELECT subtask_id, period_key, checked_at FROM SubTaskChecks WHERE period_key BETWEEN ? AND ?'
  ).all(toLocalDateKey(earliest), to) as Array<{ subtask_id: string; period_key: string; checked_at: string }>
  const checksByItem = new Map<string, typeof checks>()
  for (const check of checks) {
    const list = checksByItem.get(check.subtask_id)
    if (list) list.push(check)
    else checksByItem.set(check.subtask_id, [check])
  }
  const today = toLocalDateKey(new Date())
  return items.flatMap((item) => {
    if (!isItemRecurrence(item.recurrence)) return []
    const created = toLocalDateKey(new Date(item.created_at))
    const start = created > from ? created : from
    const end = today < to ? today : to
    const periods = new Set(start <= end ? periodsOverlapping(item.recurrence, Boolean(item.recurrence_workdays), start, end, isHoliday, item.recurrence_day) : [])
    const itemChecks = checksByItem.get(item.id) ?? []
    const checkedKeys = [...new Set(itemChecks.filter((check) => periods.has(check.period_key)).map((check) => check.period_key))].sort()
    return [{
      subtask_id: item.id,
      todo_id: item.todo_id,
      periods: periods.size,
      checked: checkedKeys.length,
      checked_in_range: itemChecks.filter((check) => {
        const day = toLocalDateKey(new Date(check.checked_at))
        return from <= day && day <= to
      }).length,
      period_keys: [...periods].sort(),
      checked_keys: checkedKeys
    }]
  })
}

export function getSubTasksByTodo(todoId: string): SubTask[] {
  resetRecurringSubTasks()
  return getDb()
    .prepare(`${SUBTASK_SELECT} WHERE st.todo_id = ? ORDER BY st.sort_order ASC, st.created_at ASC`)
    .all(todoId) as SubTask[]
}

export function getAllSubTasks(): SubTask[] {
  resetRecurringSubTasks()
  return getDb()
    .prepare(`${SUBTASK_SELECT} ORDER BY st.todo_id ASC, st.sort_order ASC, st.created_at ASC`)
    .all() as SubTask[]
}

export function getSubTasksForCalendar(): CalendarSubTask[] {
  resetRecurringSubTasks()
  return getDb()
    .prepare(
      `SELECT st.*,
              u.display_name AS assignee_name,
              u.color AS assignee_color,
              t.title AS todo_title,
              t.status AS todo_status,
              c.color AS category_color
       FROM SubTasks st
       JOIN Todos t ON st.todo_id = t.id
       LEFT JOIN Users u ON st.assignee_id = u.id
       LEFT JOIN Categories c ON t.category_id = c.id
       WHERE st.due_date IS NOT NULL AND t.status != 'archived'
       ORDER BY st.due_date ASC, st.sort_order ASC, st.created_at ASC`
    )
    .all() as CalendarSubTask[]
}

export function reorderSubTasks(todoId: string, orderedIds: string[]): void {
  const db = getDb()
  const currentIds = (db.prepare(
    'SELECT id FROM SubTasks WHERE todo_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(todoId) as Array<{ id: string }>).map((row) => row.id)
  const uniqueIds = new Set(orderedIds)

  if (
    orderedIds.length !== currentIds.length
    || uniqueIds.size !== orderedIds.length
    || currentIds.some((id) => !uniqueIds.has(id))
  ) {
    throw new Error('サブタスクの並び順が最新ではありません。再読み込みしてからやり直してください')
  }

  const update = db.prepare('UPDATE SubTasks SET sort_order = ? WHERE id = ? AND todo_id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, index) => update.run(index, id, todoId))
  })()
}

export function createSubTask(todoId: string, data: CreateSubTaskInput, createdByUserId: string | null = null): SubTask {
  assertAssignableUser(data.assignee_id)
  const db = getDb()
  return db.transaction(() => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM SubTasks WHERE todo_id = ?').get(todoId) as { m: number }).m
    const startDate = normalizeDateKey(data.start_date)
    const dueDate = normalizeDateKey(data.due_date)
    const progress = clampProgress(data.progress)
    const done = progress >= 100 ? 1 : 0
    const recurrence = isListTodoId(todoId) ? normalizeItemRecurrence(data.recurrence) : null
    db.prepare(
      'INSERT INTO SubTasks (id, todo_id, title, description, assignee_id, start_date, due_date, progress, done, completed_at, sort_order, created_at, created_by, recurrence, recurrence_workdays, recurrence_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, todoId, data.title, data.description ?? '', data.assignee_id ?? null, startDate, dueDate, progress, done, done ? now : null, maxOrder + 1, now, createdByUserId, recurrence, recurrence && data.recurrence_workdays ? 1 : 0, normalizeRecurrenceDay(recurrence, data.recurrence_day))
    const created = db.prepare(`${SUBTASK_SELECT} WHERE st.id = ?`).get(id) as SubTask
    if (done) recordRecurringCheck(created, true, createdByUserId)
    const extendedTo = syncTodoDueDateWithSubTasks(todoId, createdByUserId)
    return { ...created, parent_due_date_extended_to: extendedTo }
  })()
}

export function updateSubTask(id: string, data: UpdateSubTaskInput, changedByUserId: string | null = null): SubTask {
  assertAssignableUser(data.assignee_id)
  const db = getDb()
  return db.transaction(() => {
    // 前の周期のチェックが残ったまま操作しないよう、先に戻しておく
    resetRecurringSubTasks()
    const current = db.prepare('SELECT * FROM SubTasks WHERE id = ?').get(id) as SubTask | undefined
    if (!current) throw new Error('サブタスクが見つかりません。再読み込みしてください')
    assertExpectedValues(current, data, 'subtask')

    if (data.title !== undefined) {
      db.prepare('UPDATE SubTasks SET title = ? WHERE id = ?').run(data.title, id)
    }
    if (data.description !== undefined) {
      db.prepare('UPDATE SubTasks SET description = ? WHERE id = ?').run(data.description, id)
    }
    if (data.assignee_id !== undefined) {
      db.prepare('UPDATE SubTasks SET assignee_id = ? WHERE id = ?').run(data.assignee_id, id)
    }
    if (data.start_date !== undefined) {
      db.prepare('UPDATE SubTasks SET start_date = ? WHERE id = ?').run(normalizeDateKey(data.start_date), id)
    }
    if (data.due_date !== undefined) {
      db.prepare('UPDATE SubTasks SET due_date = ? WHERE id = ?').run(normalizeDateKey(data.due_date), id)
    }
    if (data.recurrence !== undefined) {
      db.prepare('UPDATE SubTasks SET recurrence = ? WHERE id = ?').run(isListTodoId(current.todo_id) ? normalizeItemRecurrence(data.recurrence) : null, id)
    }
    if (data.recurrence_workdays !== undefined) {
      db.prepare('UPDATE SubTasks SET recurrence_workdays = ? WHERE id = ?').run(data.recurrence_workdays ? 1 : 0, id)
    }
    // 戻る曜日・日付は、変更後の周期に合わせて整える（周期だけ変えたときは既定に戻す）
    if (data.recurrence !== undefined || data.recurrence_day !== undefined) {
      const recurrenceAfter = normalizeItemRecurrence((db.prepare('SELECT recurrence FROM SubTasks WHERE id = ?').get(id) as { recurrence: string | null }).recurrence)
      const requestedDay = data.recurrence_day !== undefined
        ? data.recurrence_day
        : recurrenceAfter === (current.recurrence ?? null) ? current.recurrence_day : null
      db.prepare('UPDATE SubTasks SET recurrence_day = ? WHERE id = ?').run(normalizeRecurrenceDay(recurrenceAfter, requestedDay), id)
    }
    if ((data.done !== undefined || data.progress !== undefined) && current) {
      const progressFromInput = data.progress !== undefined
        ? clampProgress(Number(data.progress))
        : current.progress
      const nextProgress = data.done !== undefined
        ? data.done ? 100 : Math.min(progressFromInput, 99)
        : progressFromInput
      const nextDone = data.done !== undefined
        ? data.done
        : nextProgress >= 100
      const nextCompletedAt = nextDone
        ? current.done ? current.completed_at ?? new Date().toISOString() : new Date().toISOString()
        : null
      db.prepare('UPDATE SubTasks SET progress = ?, done = ?, completed_at = ? WHERE id = ?').run(nextProgress, nextDone ? 1 : 0, nextCompletedAt, id)
    }
    const updated = db.prepare(`${SUBTASK_SELECT} WHERE st.id = ?`).get(id) as SubTask
    if (Boolean(current.done) !== Boolean(updated.done)) recordRecurringCheck(updated, Boolean(updated.done), changedByUserId)
    if (current) recordSubTaskChanges(current, updated, changedByUserId)
    const extendedTo = syncTodoDueDateWithSubTasks(updated.todo_id, changedByUserId)
    return { ...updated, parent_due_date_extended_to: extendedTo }
  })()
}

/**
 * 進捗率・期限が変わったときだけ SubTaskChangeLogs に残す（報告タブの期間中の変化表示用）。
 * 繰り返しの項目のチェックは SubTaskChecks に残すので、進捗の変化としては数えない（毎回 0%→100% と出てしまうため）
 */
function recordSubTaskChanges(
  before: { progress: number; due_date: string | null },
  after: SubTask,
  changedByUserId: string | null
): void {
  const now = new Date().toISOString()
  const insert = getDb().prepare(
    'INSERT INTO SubTaskChangeLogs (id, subtask_id, todo_id, user_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  if (before.progress !== after.progress && !after.recurrence) {
    insert.run(crypto.randomUUID(), after.id, after.todo_id, changedByUserId, 'progress', String(before.progress), String(after.progress), now)
  }
  if ((before.due_date ?? null) !== (after.due_date ?? null)) {
    insert.run(crypto.randomUUID(), after.id, after.todo_id, changedByUserId, 'due_date', before.due_date, after.due_date, now)
  }
}

export function deleteSubTask(id: string): void {
  getDb().prepare('DELETE FROM SubTasks WHERE id = ?').run(id)
}
