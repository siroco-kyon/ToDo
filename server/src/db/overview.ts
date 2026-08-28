import { getDb } from './connection'
import { getAllCategories } from './categories'
import { getAllTodos } from './todos'
import { getProgressDigest } from './progress'
import { average, clampRunningSeconds, diffCalendarDays, getTodayKey, toMinutes } from './helpers'
import type {
  OverviewCategoryStat,
  OverviewCompletedSubTaskItem,
  OverviewData,
  OverviewQuery,
  OverviewSummary,
  OverviewTaskItem,
  OverviewTaskReason,
  Todo
} from './types'

interface OverviewSubTaskRollup {
  total: number
  done: number
}

function getCurrentWeekStart(): Date {
  const start = new Date()
  const day = start.getDay()
  const diff = day === 0 ? -6 : 1 - day
  start.setDate(start.getDate() + diff)
  start.setHours(0, 0, 0, 0)
  return start
}

function buildOverviewTask(
  todo: Todo,
  reason: OverviewTaskReason,
  subTaskRollups: Map<string, OverviewSubTaskRollup>
): OverviewTaskItem {
  const subTask = subTaskRollups.get(todo.id) ?? { total: 0, done: 0 }
  return {
    todoId: todo.id,
    title: todo.title,
    categoryName: todo.category_name,
    categoryColor: todo.category_color,
    priority: todo.priority,
    progress: todo.status === 'done' ? 100 : todo.progress,
    dueDate: todo.due_date,
    updatedAt: todo.updated_at,
    reason,
    subTaskDone: subTask.done,
    subTaskTotal: subTask.total,
    assigneeId: todo.assignee_id,
    assigneeName: todo.assignee_name,
    assigneeColor: todo.assignee_color,
    coAssignees: todo.co_assignees ?? []
  }
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function matchesAssignee(todo: Todo, assigneeId: string | null | undefined): boolean {
  if (assigneeId == null) return true
  if (assigneeId === '') {
    return todo.assignee_id == null && (todo.co_assignees ?? []).length === 0
  }
  return todo.assignee_id === assigneeId || (todo.co_assignees ?? []).some((item) => item.user_id === assigneeId)
}

function sumLoggedSeconds(windowStart: Date, userId: string | null | undefined, includePrivate: boolean): number {
  if (userId === '') return 0
  const rows = getDb().prepare(`
    SELECT wl.duration_seconds, wl.user_id, COALESCE(c.is_private, 0) AS is_private
    FROM WorkLogs wl
    JOIN Todos t ON wl.todo_id = t.id
    LEFT JOIN Categories c ON t.category_id = c.id
    WHERE wl.start_time >= ?
  `).all(windowStart.toISOString()) as Array<{ duration_seconds: number; user_id: string; is_private: number }>
  return rows.reduce((total, row) => {
    if (userId != null && row.user_id !== userId) return total
    if (!includePrivate && row.is_private === 1) return total
    return total + row.duration_seconds
  }, 0)
}

/** Sum of matching in-flight timers, clamped to a window. */
function sumRunningSeconds(windowStart: Date, now: Date, userId: string | null | undefined, includePrivate: boolean): number {
  if (userId === '') return 0
  const rows = getDb().prepare(`
    SELECT rs.start_time, rs.user_id, COALESCE(c.is_private, 0) AS is_private
    FROM RunningState rs
    JOIN Todos t ON rs.todo_id = t.id
    LEFT JOIN Categories c ON t.category_id = c.id
  `).all() as Array<{ start_time: string; user_id: string; is_private: number }>
  return rows.reduce((total, row) => {
    if (userId != null && row.user_id !== userId) return total
    if (!includePrivate && row.is_private === 1) return total
    return total + clampRunningSeconds(row.start_time, windowStart, now)
  }, 0)
}

export function getOverviewData(query: OverviewQuery = {}): OverviewData {
  const db = getDb()
  const categories = getAllCategories()
  const includePrivate = query.includePrivate !== false
  const privateCategoryIds = new Set(categories.filter((category) => category.is_private === 1).map((category) => category.id))
  const todos = getAllTodos().filter((todo) =>
    todo.status !== 'archived'
    && (includePrivate || todo.category_id == null || !privateCategoryIds.has(todo.category_id))
    && matchesAssignee(todo, query.assigneeId)
  )
  const todayKey = getTodayKey()
  const currentWeekStart = getCurrentWeekStart()
  const activeTodos = todos.filter((todo) => todo.status !== 'done')
  const doneTodos = todos.filter((todo) => todo.status === 'done')

  const subTaskRows = db.prepare(`
    SELECT
      todo_id,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS done
    FROM SubTasks
    GROUP BY todo_id
  `).all() as { todo_id: string; total: number; done: number }[]

  const subTaskRollups = new Map<string, OverviewSubTaskRollup>()
  subTaskRows.forEach((row) => {
    subTaskRollups.set(row.todo_id, { total: row.total, done: row.done })
  })

  const overdueTodos = activeTodos.filter((todo) => todo.due_date && diffCalendarDays(todo.due_date, todayKey) < 0)
  const dueSoonTodos = activeTodos.filter((todo) => {
    if (!todo.due_date) return false
    const diffDays = diffCalendarDays(todo.due_date, todayKey)
    return diffDays >= 0 && diffDays <= 3
  })

  const dueToday = activeTodos
    .filter((todo) => todo.due_date === todayKey)
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title, 'ja'))
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'dueToday', subTaskRollups))

  const highPriority = activeTodos
    .filter((todo) => todo.priority >= 4 && todo.progress < 100)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date)
      if (a.due_date) return -1
      if (b.due_date) return 1
      return a.progress - b.progress
    })
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'highPriority', subTaskRollups))

  const nearlyDone = activeTodos
    .filter((todo) => todo.progress >= 75 && todo.progress < 100)
    .sort((a, b) => b.progress - a.progress || b.priority - a.priority)
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'nearlyDone', subTaskRollups))

  const staleThresholdMs = 7 * 86400000
  const stale = activeTodos
    .filter((todo) => Date.now() - new Date(todo.updated_at).getTime() >= staleThresholdMs)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .slice(0, 6)
    .map((todo) => buildOverviewTask(todo, 'stale', subTaskRollups))

  const riskCandidates = [
    ...overdueTodos
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || b.priority - a.priority)
      .map((todo) => buildOverviewTask(todo, 'overdue', subTaskRollups)),
    ...dueSoonTodos
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || b.priority - a.priority)
      .map((todo) => buildOverviewTask(todo, 'dueSoon', subTaskRollups)),
    ...activeTodos
      .filter((todo) => todo.priority >= 4 && todo.progress <= 40)
      .sort((a, b) => b.priority - a.priority || a.progress - b.progress)
      .map((todo) => buildOverviewTask(todo, 'highPriority', subTaskRollups)),
    ...activeTodos
      .filter((todo) => Date.now() - new Date(todo.updated_at).getTime() >= staleThresholdMs)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .map((todo) => buildOverviewTask(todo, 'stale', subTaskRollups))
  ]

  const riskMap = new Map<string, OverviewTaskItem>()
  riskCandidates.forEach((item) => {
    if (!riskMap.has(item.todoId)) {
      riskMap.set(item.todoId, item)
    }
  })
  const risks = [...riskMap.values()].slice(0, 8)

  const categoryBuckets = new Map<string, OverviewCategoryStat>()
  categories.forEach((category) => {
    categoryBuckets.set(category.id, {
      categoryId: category.id,
      categoryName: category.name,
      categoryColor: category.color,
      totalTasks: 0,
      activeTasks: 0,
      doneTasks: 0,
      overdueTasks: 0,
      completionRate: 0,
      completionScore: 0,
      avgActiveProgress: 0
    })
  })

  todos.forEach((todo) => {
    const bucketKey = todo.category_id ?? '__uncategorized__'
    if (!categoryBuckets.has(bucketKey)) {
      categoryBuckets.set(bucketKey, {
        categoryId: null,
        categoryName: '未分類',
        categoryColor: '#64748b',
        totalTasks: 0,
        activeTasks: 0,
        doneTasks: 0,
        overdueTasks: 0,
        completionRate: 0,
        completionScore: 0,
        avgActiveProgress: 0
      })
    }

    const bucket = categoryBuckets.get(bucketKey)!
    bucket.totalTasks += 1
    if (todo.status === 'done') bucket.doneTasks += 1
    else bucket.activeTasks += 1
    if (todo.status !== 'done' && todo.due_date && diffCalendarDays(todo.due_date, todayKey) < 0) {
      bucket.overdueTasks += 1
    }
    bucket.completionScore += todo.status === 'done' ? 100 : todo.progress
    if (todo.status !== 'done') {
      bucket.avgActiveProgress += todo.progress
    }
  })

  const overviewCategories = [...categoryBuckets.values()]
    .filter((bucket) => bucket.totalTasks > 0)
    .map((bucket) => ({
      ...bucket,
      completionRate: Math.round((bucket.doneTasks / bucket.totalTasks) * 100),
      completionScore: Math.round(bucket.completionScore / bucket.totalTasks),
      avgActiveProgress: bucket.activeTasks > 0
        ? Math.round(bucket.avgActiveProgress / bucket.activeTasks)
        : 100
    }))
    .sort((a, b) => b.overdueTasks - a.overdueTasks || a.completionScore - b.completionScore || b.totalTasks - a.totalTasks)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 6)
  weekStart.setHours(0, 0, 0, 0)

  const now = new Date()
  const runningToday = sumRunningSeconds(todayStart, now, query.assigneeId, includePrivate)
  const runningWeek = sumRunningSeconds(weekStart, now, query.assigneeId, includePrivate)
  const eligibleTodoIds = new Set(todos.map((todo) => todo.id))
  const todoById = new Map(todos.map((todo) => [todo.id, todo] as const))
  const completedSubTasks = (db.prepare(
    `SELECT
        st.id,
        st.todo_id,
        st.title,
        st.completed_at,
        st.assignee_id,
        su.display_name AS assignee_name,
        su.color AS assignee_color,
        t.title AS todo_title,
        c.name AS category_name,
        c.color AS category_color
     FROM SubTasks st
     JOIN Todos t ON st.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     LEFT JOIN Users su ON st.assignee_id = su.id
     WHERE st.done = 1
       AND st.completed_at IS NOT NULL
       AND st.completed_at >= ?
       AND t.status != 'archived'
     ORDER BY st.completed_at DESC`
  ).all(currentWeekStart.toISOString()) as Array<Omit<OverviewCompletedSubTaskItem,
    'parent_assignee_id' | 'parent_assignee_name' | 'parent_assignee_color' | 'parent_co_assignees'>>)
    .filter((item) => eligibleTodoIds.has(item.todo_id))
    .map((item) => {
      const parent = todoById.get(item.todo_id)!
      return {
        ...item,
        parent_assignee_id: parent.assignee_id,
        parent_assignee_name: parent.assignee_name,
        parent_assignee_color: parent.assignee_color,
        parent_co_assignees: parent.co_assignees ?? []
      }
    })

  const activityTo = formatLocalDate(now)
  const activityFromDate = new Date(now)
  activityFromDate.setDate(activityFromDate.getDate() - 6)
  const activityFrom = formatLocalDate(activityFromDate)
  const activityUserIds = query.assigneeId == null
    ? undefined
    : query.assigneeId === '' ? [] : [query.assigneeId]
  const memberActivity = query.assigneeId === ''
    ? []
    : getProgressDigest(activityFrom, activityTo, activityUserIds, includePrivate).users

  const summary: OverviewSummary = {
    totalTasks: todos.length,
    activeTasks: activeTodos.length,
    doneTasks: doneTodos.length,
    completionRate: todos.length > 0 ? Math.round((doneTodos.length / todos.length) * 100) : 0,
    completionScore: todos.length > 0
      ? Math.round(todos.reduce((sum, todo) => sum + (todo.status === 'done' ? 100 : todo.progress), 0) / todos.length)
      : 0,
    avgActiveProgress: average(activeTodos.map((todo) => todo.progress)),
    overdueTasks: overdueTodos.length,
    dueSoonTasks: dueSoonTodos.length,
    todayMinutes: toMinutes(sumLoggedSeconds(todayStart, query.assigneeId, includePrivate) + runningToday),
    weekMinutes: toMinutes(sumLoggedSeconds(weekStart, query.assigneeId, includePrivate) + runningWeek),
    completedSubTasksThisWeek: completedSubTasks.length
  }

  return {
    summary,
    categories: overviewCategories,
    risks,
    dueToday,
    highPriority,
    nearlyDone,
    stale,
    completedSubTasks: completedSubTasks.slice(0, 10),
    activityFrom,
    activityTo,
    memberActivity
  }
}
