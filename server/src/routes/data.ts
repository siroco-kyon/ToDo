import { Router, type Response } from 'express'
import { requireAuth, requireAdmin } from '../auth'
import { broadcastDataChanged, type DataScope } from '../realtime'
import { generateDailyMarkdown } from '../markdown'
import {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories
} from '../db/categories'
import {
  getAllTodos,
  createTodo,
  updateTodo,
  archiveTodo,
  unarchiveTodo,
  deleteTodo,
  reorderTodos,
  getAllTodoDependencies,
  createTodoDependency,
  updateTodoDependency,
  deleteTodoDependency
} from '../db/todos'
import {
  getSubTasksByTodo,
  getAllSubTasks,
  getSubTasksForCalendar,
  createSubTask,
  updateSubTask,
  deleteSubTask
} from '../db/subtasks'
import { startTimer, stopTimer, getRunningState } from '../db/timer'
import { getWorkLogsByTodo, getWorkLogsByDate, getWorkLogsSummary } from '../db/worklogs'
import { getOverviewData } from '../db/overview'
import {
  getDailyPlanItems,
  addDailyPlanItem,
  updateDailyPlanItem,
  shiftDailyPlanItem,
  deleteDailyPlanItem,
  reorderDailyPlanItems
} from '../db/plan'
import { getSetting, setSetting, getUserSetting, setUserSetting } from '../db/settings'
import { getTeamDashboard } from '../db/team'
import {
  getProgressNotesByTodo,
  getProgressNote,
  createProgressNote,
  deleteProgressNote,
  getProgressDigest
} from '../db/progress'

export const dataRouter = Router()
dataRouter.use(requireAuth)

/** Run a handler, broadcast a change scope on success, and map thrown errors to 400. */
function run<T>(res: Response, fn: () => T, scope?: DataScope): void {
  try {
    const result = fn()
    if (scope) broadcastDataChanged(scope)
    res.json(result === undefined ? { ok: true } : result)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'エラーが発生しました' })
  }
}

// ─── Categories ───────────────────────────────────────────────
dataRouter.get('/categories', (_req, res) => run(res, () => getAllCategories()))
dataRouter.post('/categories', (req, res) => run(res, () => createCategory(req.body.name, req.body.color), 'category'))
dataRouter.put('/categories/:id', (req, res) =>
  run(res, () => updateCategory(req.params.id, req.body.name, req.body.color, req.body.description), 'category'))
dataRouter.delete('/categories/:id', (req, res) => run(res, () => deleteCategory(req.params.id), 'category'))
dataRouter.post('/categories/reorder', (req, res) => run(res, () => reorderCategories(req.body.orderedIds), 'category'))

// ─── Todos ────────────────────────────────────────────────────
dataRouter.get('/todos', (_req, res) => run(res, () => getAllTodos()))
dataRouter.post('/todos', (req, res) => run(res, () => createTodo(req.body, req.user!.id), 'todo'))
dataRouter.put('/todos/:id', (req, res) => run(res, () => updateTodo(req.params.id, req.body), 'todo'))
dataRouter.post('/todos/reorder', (req, res) => run(res, () => reorderTodos(req.body.orderedIds), 'todo'))
dataRouter.post('/todos/:id/archive', (req, res) => run(res, () => archiveTodo(req.params.id), 'todo'))
dataRouter.post('/todos/:id/unarchive', (req, res) => run(res, () => unarchiveTodo(req.params.id), 'todo'))
dataRouter.delete('/todos/:id', (req, res) => run(res, () => deleteTodo(req.params.id), 'todo'))

// ─── Dependencies ─────────────────────────────────────────────
dataRouter.get('/dependencies', (_req, res) => run(res, () => getAllTodoDependencies()))
dataRouter.post('/dependencies', (req, res) =>
  run(res, () => createTodoDependency(req.body.predecessorTodoId, req.body.successorTodoId, req.body.lagDays ?? 0), 'todo'))
dataRouter.put('/dependencies/:id', (req, res) =>
  run(res, () => updateTodoDependency(req.params.id, req.body.lagDays), 'todo'))
dataRouter.delete('/dependencies/:id', (req, res) => run(res, () => deleteTodoDependency(req.params.id), 'todo'))

// ─── SubTasks ─────────────────────────────────────────────────
dataRouter.get('/subtasks', (_req, res) => run(res, () => getAllSubTasks()))
dataRouter.get('/subtasks/calendar', (_req, res) => run(res, () => getSubTasksForCalendar()))
dataRouter.get('/todos/:todoId/subtasks', (req, res) => run(res, () => getSubTasksByTodo(req.params.todoId)))
dataRouter.post('/todos/:todoId/subtasks', (req, res) =>
  run(res, () => createSubTask(req.params.todoId, req.body), 'subtask'))
dataRouter.put('/subtasks/:id', (req, res) => run(res, () => updateSubTask(req.params.id, req.body), 'subtask'))
dataRouter.delete('/subtasks/:id', (req, res) => run(res, () => deleteSubTask(req.params.id), 'subtask'))

// ─── Timer (per-user) ─────────────────────────────────────────
dataRouter.post('/timer/start', (req, res) => run(res, () => startTimer(req.user!.id, req.body.todoId), 'todo'))
dataRouter.post('/timer/stop', (req, res) => run(res, () => stopTimer(req.user!.id, req.body.note), 'todo'))
dataRouter.get('/timer/running', (req, res) => run(res, () => getRunningState(req.user!.id) ?? null))

// ─── WorkLogs ─────────────────────────────────────────────────
dataRouter.get('/todos/:todoId/worklogs', (req, res) => run(res, () => getWorkLogsByTodo(req.params.todoId)))
dataRouter.get('/worklogs/by-date', (req, res) =>
  run(res, () => getWorkLogsByDate(req.user!.id, String(req.query.date ?? ''))))
dataRouter.get('/worklogs/summary', (req, res) =>
  run(res, () => getWorkLogsSummary(req.user!.id, Number(req.query.days ?? 7))))

// ─── Overview ─────────────────────────────────────────────────
dataRouter.get('/overview', (_req, res) => run(res, () => getOverviewData()))

// ─── Daily plan (per-user) ────────────────────────────────────
dataRouter.get('/plan', (req, res) =>
  run(res, () => getDailyPlanItems(req.user!.id, String(req.query.date ?? ''))))
dataRouter.post('/plan', (req, res) =>
  run(res, () => addDailyPlanItem(req.user!.id, req.body.date, req.body.todoId), 'plan'))
dataRouter.post('/plan/reorder', (req, res) =>
  run(res, () => reorderDailyPlanItems(req.user!.id, req.body.date, req.body.orderedIds), 'plan'))
dataRouter.put('/plan/:id', (req, res) => run(res, () => updateDailyPlanItem(req.params.id, req.body), 'plan'))
dataRouter.post('/plan/:id/shift', (req, res) =>
  run(res, () => shiftDailyPlanItem(req.params.id, req.body.deltaMinutes), 'plan'))
dataRouter.delete('/plan/:id', (req, res) => run(res, () => deleteDailyPlanItem(req.params.id), 'plan'))

// ─── Markdown export ──────────────────────────────────────────
dataRouter.get('/markdown', (req, res) => run(res, () => ({ markdown: generateDailyMarkdown(req.user!.id) })))

// ─── Settings (themeMode is per-user; everything else is global) ──
const PER_USER_SETTING_KEYS = new Set(['themeMode'])

dataRouter.get('/settings/:key', (req, res) =>
  run(res, () => {
    const key = req.params.key
    const value = PER_USER_SETTING_KEYS.has(key)
      ? getUserSetting(req.user!.id, key)
      : getSetting(key)
    return { value: value ?? null }
  }))

dataRouter.put('/settings/:key', (req, res) =>
  run(res, () => {
    const key = req.params.key
    if (PER_USER_SETTING_KEYS.has(key)) setUserSetting(req.user!.id, key, req.body.value)
    else setSetting(key, req.body.value)
  }))

// ─── Progress notes (shared) ──────────────────────────────────
dataRouter.get('/todos/:todoId/progress-notes', (req, res) =>
  run(res, () => getProgressNotesByTodo(req.params.todoId)))
dataRouter.post('/todos/:todoId/progress-notes', (req, res) =>
  run(res, () => createProgressNote(req.params.todoId, req.user!.id, req.body.body), 'todo'))
dataRouter.delete('/progress-notes/:id', (req, res) =>
  run(res, () => {
    const note = getProgressNote(req.params.id)
    if (!note) throw new Error('進捗メモが見つかりません')
    if (note.user_id !== req.user!.id && req.user!.role !== 'admin') {
      throw new Error('この進捗メモを削除する権限がありません')
    }
    deleteProgressNote(req.params.id)
  }, 'todo'))

// ─── Progress digest (admin report) ───────────────────────────
dataRouter.get('/progress-digest', requireAdmin, (req, res) =>
  run(res, () => {
    const from = String(req.query.from ?? '')
    const to = String(req.query.to ?? '')
    const rawIds = req.query.userIds
    const userIds =
      typeof rawIds === 'string' && rawIds.length > 0 ? rawIds.split(',').filter(Boolean) : undefined
    return getProgressDigest(from, to, userIds)
  }))

// ─── Team dashboard ───────────────────────────────────────────
dataRouter.get('/team', (_req, res) => run(res, () => getTeamDashboard()))
