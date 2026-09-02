import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { Router, raw, type Response } from 'express'
import { requireAuth, requireAdmin } from '../auth'
import { broadcastDataChanged, sendNotificationChanged, type DataScope } from '../realtime'
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
  getTodoById,
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
  reorderSubTasks,
  createSubTask,
  updateSubTask,
  deleteSubTask
} from '../db/subtasks'
import { startTimer, stopTimer, getRunningState } from '../db/timer'
import { getWorkLogsByTodo, getAllWorkLogRows, getWorkLogsByDate, getWorkLogsSummary } from '../db/worklogs'
import { getUserById, listUsers } from '../db/users'
import { getDb } from '../db/connection'
import { importDesktopDb } from '../import/import-desktop-db'
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
  getProgressNotesByRange,
  getProgressNote,
  createProgressNote,
  updateProgressNote,
  deleteProgressNote,
  getProgressNoteComment,
  createProgressNoteCommentWithId,
  updateProgressNoteComment,
  deleteProgressNoteComment,
  toggleProgressNoteReaction,
  toggleProgressNoteCommentReaction,
  getProgressDigest
} from '../db/progress'
import {
  listNotifications,
  countUnreadNotifications,
  createNotification,
  markNotificationRead,
  markAllNotificationsRead
} from '../db/notifications'
import type { ProgressNote, ProgressNoteComment, Todo } from '../db/types'

export const dataRouter = Router()
dataRouter.use(requireAuth)

/** Run a handler, broadcast a change scope on success, and map thrown errors to 400. */
function run<T>(res: Response, fn: () => T, scope?: DataScope | DataScope[]): void {
  try {
    const result = fn()
    if (scope) {
      const scopes = Array.isArray(scope) ? scope : [scope]
      scopes.forEach(broadcastDataChanged)
    }
    res.json(result === undefined ? { ok: true } : result)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'エラーが発生しました' })
  }
}

function assignedUserIds(todo: Todo | null | undefined): Set<string> {
  const ids = new Set<string>()
  if (todo?.assignee_id) ids.add(todo.assignee_id)
  for (const coAssignee of todo?.co_assignees ?? []) {
    if (coAssignee.user_id) ids.add(coAssignee.user_id)
  }
  return ids
}

function notifyUnreadChanged(userIds: Iterable<string>): void {
  for (const userId of userIds) {
    try {
      sendNotificationChanged(userId, countUnreadNotifications(userId))
    } catch (error) {
      console.error('Failed to send notification update', error)
    }
  }
}

function notifyNewAssignments(actorUserId: string, before: Set<string>, after: Todo): void {
  const changed = new Set<string>()
  for (const userId of assignedUserIds(after)) {
    if (before.has(userId) || userId === actorUserId) continue
    try {
      const notification = createNotification({
        userId,
        type: 'task_assigned',
        actorUserId,
        todoId: after.id,
        title: '担当タスクが追加されました',
        body: `「${after.title}」の担当に追加されました`
      })
      if (notification) changed.add(userId)
    } catch (error) {
      console.error('Failed to create assignment notification', error)
    }
  }
  notifyUnreadChanged(changed)
}

function notifyProgressReply(
  actorUserId: string,
  note: ProgressNote | undefined,
  parentComment: ProgressNoteComment | undefined,
  commentId: string,
  excluded = new Set<string>()
): Set<string> {
  if (!note) return new Set<string>()

  const recipients = new Set<string>()
  if (note.user_id && note.user_id !== actorUserId) recipients.add(note.user_id)
  if (parentComment?.user_id && parentComment.user_id !== actorUserId) recipients.add(parentComment.user_id)

  const changed = new Set<string>()
  for (const userId of recipients) {
    if (excluded.has(userId)) continue
    try {
      const isParentRecipient = parentComment?.user_id === userId
      const notification = createNotification({
        userId,
        type: 'progress_reply',
        actorUserId,
        todoId: note.todo_id,
        progressNoteId: note.id,
        progressCommentId: commentId,
        title: isParentRecipient ? '返信に返信がありました' : '進捗に返信がありました',
        body: `「${note.todo_title}」の${isParentRecipient ? '返信' : '進捗'}に返信がありました`
      })
      if (notification) changed.add(userId)
    } catch (error) {
      console.error('Failed to create progress reply notification', error)
    }
  }
  notifyUnreadChanged(changed)
  return changed
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsMention(body: string, name: string): boolean {
  const escaped = escapeRegex(name.trim())
  if (!escaped) return false
  return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s.,!?、。！？:：;；()（）])`, 'iu').test(body)
}

function notifyMentions(actorUserId: string, body: string, note: ProgressNote, commentId?: string, excluded = new Set<string>()): Set<string> {
  const changed = new Set<string>()
  for (const user of listUsers()) {
    if (!user.is_active || user.id === actorUserId || excluded.has(user.id)) continue
    if (!containsMention(body, user.display_name) && !containsMention(body, user.username)) continue
    const notification = createNotification({
      userId: user.id, type: 'mention', actorUserId, todoId: note.todo_id,
      progressNoteId: note.id, progressCommentId: commentId ?? null,
      title: '進捗でメンションされました', body: `「${note.todo_title}」の進捗であなたがメンションされました`
    })
    if (notification) changed.add(user.id)
  }
  notifyUnreadChanged(changed)
  return changed
}

function notifySubscribers(actorUserId: string, note: ProgressNote, commentId?: string, excluded = new Set<string>()): Set<string> {
  const rows = getDb().prepare('SELECT user_id FROM TodoSubscriptions WHERE todo_id = ? AND user_id != ?').all(note.todo_id, actorUserId) as Array<{ user_id: string }>
  const changed = new Set<string>()
  for (const row of rows) {
    if (excluded.has(row.user_id)) continue
    const notification = createNotification({
      userId: row.user_id, type: 'progress_reply', actorUserId, todoId: note.todo_id,
      progressNoteId: note.id, progressCommentId: commentId ?? null,
      title: '購読中のタスクに更新があります', body: `「${note.todo_title}」に進捗が追加されました`
    })
    if (notification) changed.add(row.user_id)
  }
  notifyUnreadChanged(changed)
  return changed
}

function findCommentInTree(comments: ProgressNoteComment[], commentId: string): ProgressNoteComment | undefined {
  for (const comment of comments) {
    if (comment.id === commentId) return comment
    const found = findCommentInTree(comment.replies, commentId)
    if (found) return found
  }
  return undefined
}

function notifyProgressReaction(actorUserId: string, note: ProgressNote | undefined): void {
  if (!note?.user_id || note.user_id === actorUserId) return
  try {
    const notification = createNotification({
      userId: note.user_id,
      type: 'progress_reaction',
      actorUserId,
      todoId: note.todo_id,
      progressNoteId: note.id,
      title: '進捗にいいねがありました',
      body: `「${note.todo_title}」の進捗にいいねがありました`
    })
    if (notification) notifyUnreadChanged([note.user_id])
  } catch (error) {
    console.error('Failed to create progress reaction notification', error)
  }
}

function notifyCommentReaction(actorUserId: string, note: ProgressNote | undefined, comment: ProgressNoteComment | undefined): void {
  if (!comment?.user_id || comment.user_id === actorUserId) return
  try {
    const notification = createNotification({
      userId: comment.user_id,
      type: 'progress_reaction',
      actorUserId,
      todoId: note?.todo_id ?? null,
      progressNoteId: note?.id ?? null,
      progressCommentId: comment.id,
      title: '返信にいいねがありました',
      body: `「${note?.todo_title ?? ''}」の返信にいいねがありました`
    })
    if (notification) notifyUnreadChanged([comment.user_id])
  } catch (error) {
    console.error('Failed to create comment reaction notification', error)
  }
}

// ─── Categories ───────────────────────────────────────────────
dataRouter.get('/categories', (_req, res) => run(res, () => getAllCategories()))
dataRouter.post('/categories', (req, res) => run(res, () => createCategory(req.body.name, req.body.color, req.body.isPrivate), 'category'))
dataRouter.put('/categories/:id', (req, res) =>
  run(res, () => updateCategory(req.params.id, req.body.name, req.body.color, req.body.description, req.body.isPrivate), 'category'))
dataRouter.delete('/categories/:id', (req, res) => run(res, () => deleteCategory(req.params.id), 'category'))
dataRouter.post('/categories/reorder', (req, res) => run(res, () => reorderCategories(req.body.orderedIds), 'category'))

// ─── Todos ────────────────────────────────────────────────────
dataRouter.get('/todos', (_req, res) => run(res, () => getAllTodos()))
dataRouter.post('/todos', (req, res) =>
  run(res, () => {
    const created = createTodo(req.body, req.user!.id)
    notifyNewAssignments(req.user!.id, new Set(), created)
    return created
  }, 'todo'))
dataRouter.put('/todos/:id', (req, res) =>
  run(res, () => {
    const before = assignedUserIds(getTodoById(req.params.id))
    const updated = updateTodo(req.params.id, req.body, req.user!.id)
    notifyNewAssignments(req.user!.id, before, updated)
    return updated
  }, 'todo'))
dataRouter.post('/todos/reorder', (req, res) => run(res, () => reorderTodos(req.body.orderedIds), 'todo'))
dataRouter.post('/todos/:id/archive', (req, res) => run(res, () => archiveTodo(req.params.id, req.user!.id), 'todo'))
dataRouter.post('/todos/:id/unarchive', (req, res) => run(res, () => {
  const restoreStatus = ['not_started', 'active', 'done'].includes(req.body?.status) ? req.body.status : 'active'
  return unarchiveTodo(req.params.id, req.user!.id, restoreStatus)
}, 'todo'))
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
dataRouter.get('/todos/:todoId/subscription', (req, res) => run(res, () => ({ subscribed: Boolean(getDb().prepare('SELECT 1 FROM TodoSubscriptions WHERE user_id = ? AND todo_id = ?').get(req.user!.id, req.params.todoId)) })))
dataRouter.post('/todos/:todoId/subscription', (req, res) => run(res, () => {
  if (req.body.subscribed) getDb().prepare('INSERT OR IGNORE INTO TodoSubscriptions (user_id, todo_id, created_at) VALUES (?, ?, ?)').run(req.user!.id, req.params.todoId, new Date().toISOString())
  else getDb().prepare('DELETE FROM TodoSubscriptions WHERE user_id = ? AND todo_id = ?').run(req.user!.id, req.params.todoId)
  return { subscribed: Boolean(req.body.subscribed) }
}))
dataRouter.post('/todos/:todoId/subtasks/reorder', (req, res) =>
  run(res, () => reorderSubTasks(req.params.todoId, req.body.orderedIds), 'subtask'))
dataRouter.post('/todos/:todoId/subtasks', (req, res) =>
  run(res, () => createSubTask(req.params.todoId, req.body), ['subtask', 'todo']))
dataRouter.put('/subtasks/:id', (req, res) => run(res, () => updateSubTask(req.params.id, req.body), ['subtask', 'todo']))
dataRouter.delete('/subtasks/:id', (req, res) => run(res, () => deleteSubTask(req.params.id), 'subtask'))

// ─── Timer (per-user) ─────────────────────────────────────────
dataRouter.post('/timer/start', (req, res) => run(res, () => startTimer(req.user!.id, req.body.todoId), 'todo'))
dataRouter.post('/timer/stop', (req, res) => run(res, () => stopTimer(req.user!.id, req.body.note), 'todo'))
dataRouter.get('/timer/running', (req, res) => run(res, () => getRunningState(req.user!.id) ?? null))

// ─── WorkLogs ─────────────────────────────────────────────────
dataRouter.get('/todos/:todoId/worklogs', (req, res) => run(res, () => getWorkLogsByTodo(req.params.todoId)))
dataRouter.get('/worklogs/all', (req, res) => run(res, () => getAllWorkLogRows(req.user!.id)))
dataRouter.get('/worklogs/by-date', (req, res) =>
  run(res, () => getWorkLogsByDate(req.user!.id, String(req.query.date ?? ''))))
dataRouter.get('/worklogs/summary', (req, res) =>
  run(res, () => getWorkLogsSummary(req.user!.id, Number(req.query.days ?? 7))))

// ─── Overview ─────────────────────────────────────────────────
dataRouter.get('/overview', (req, res) => run(res, () => getOverviewData({
  assigneeId: req.query.assigneeId == null ? undefined : String(req.query.assigneeId),
  includePrivate: req.query.includePrivate !== 'false'
})))

// ─── Daily plan (per-user) ────────────────────────────────────
dataRouter.get('/plan', (req, res) =>
  run(res, () => getDailyPlanItems(req.user!.id, String(req.query.date ?? ''))))
dataRouter.post('/plan', (req, res) =>
  run(res, () => addDailyPlanItem(req.user!.id, req.body.date, req.body.todoId, req.body.options), 'plan'))
dataRouter.post('/plan/reorder', (req, res) =>
  run(res, () => reorderDailyPlanItems(req.user!.id, req.body.date, req.body.orderedIds), 'plan'))
dataRouter.put('/plan/:id', (req, res) => run(res, () => updateDailyPlanItem(req.params.id, req.body), 'plan'))
dataRouter.post('/plan/:id/shift', (req, res) =>
  run(res, () => shiftDailyPlanItem(req.params.id, req.body.deltaMinutes), 'plan'))
dataRouter.delete('/plan/:id', (req, res) => run(res, () => deleteDailyPlanItem(req.params.id), 'plan'))

// ─── Markdown export ──────────────────────────────────────────
dataRouter.get('/markdown', (req, res) => run(res, () => ({ markdown: generateDailyMarkdown(req.user!.id) })))

// ─── Settings (themeMode/fontFamily/fontScale are per-user; everything else is global) ──
const PER_USER_SETTING_KEYS = new Set(['themeMode', 'fontFamily', 'fontScale'])

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

// ─── Notifications (per-user) ─────────────────────────────────
dataRouter.get('/notifications', (req, res) =>
  run(res, () => listNotifications(req.user!.id, Number(req.query.limit ?? 50))))
dataRouter.get('/notifications/unread-count', (req, res) =>
  run(res, () => ({ unread: countUnreadNotifications(req.user!.id) })))
dataRouter.post('/notifications/:id/read', (req, res) =>
  run(res, () => {
    const notification = markNotificationRead(req.user!.id, req.params.id)
    notifyUnreadChanged([req.user!.id])
    return notification ?? null
  }))
dataRouter.post('/notifications/read-all', (req, res) =>
  run(res, () => {
    markAllNotificationsRead(req.user!.id)
    notifyUnreadChanged([req.user!.id])
  }))
dataRouter.get('/notification-preferences', (req, res) => run(res, () => {
  const rows = getDb().prepare('SELECT type, enabled FROM NotificationPreferences WHERE user_id = ?').all(req.user!.id) as Array<{ type: string; enabled: number }>
  return Object.fromEntries(rows.map((row) => [row.type, Boolean(row.enabled)]))
}))
dataRouter.post('/notification-preferences', (req, res) => run(res, () => {
  const type = String(req.body.type ?? '')
  if (!['progress_reply', 'task_assigned', 'progress_reaction', 'task_due', 'mention'].includes(type)) throw new Error('通知種別が不正です')
  const enabled = Boolean(req.body.enabled)
  getDb().prepare('INSERT INTO NotificationPreferences (user_id, type, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, type) DO UPDATE SET enabled = excluded.enabled').run(req.user!.id, type, enabled ? 1 : 0)
  return { type, enabled }
}))

// ─── Progress notes (shared) ──────────────────────────────────
dataRouter.get('/todos/:todoId/progress-notes', (req, res) =>
  run(res, () => getProgressNotesByTodo(req.params.todoId, req.user!.id)))
dataRouter.get('/progress-notes/timeline', (req, res) =>
  run(res, () => {
    const date = String(req.query.date ?? '')
    const from = String(req.query.from ?? date)
    const to = String(req.query.to ?? date)
    return getProgressNotesByRange(from, to, req.user!.id)
  }))
dataRouter.post('/todos/:todoId/progress-notes', (req, res) =>
  run(res, () => {
    const created = createProgressNote(req.params.todoId, req.user!.id, req.body.body)
    const mentioned = notifyMentions(req.user!.id, req.body.body, created)
    notifySubscribers(req.user!.id, created, undefined, mentioned)
    return created
  }, 'progress'))
dataRouter.put('/progress-notes/:id', (req, res) =>
  run(res, () => {
    const note = getProgressNote(req.params.id, req.user!.id)
    if (!note) throw new Error('進捗ログが見つかりません')
    if (note.user_id !== req.user!.id && req.user!.role !== 'admin') {
      throw new Error('この進捗ログを編集する権限がありません')
    }
    return updateProgressNote(req.params.id, req.body.body, req.user!.id)
  }, 'progress'))
dataRouter.delete('/progress-notes/:id', (req, res) =>
  run(res, () => {
    const note = getProgressNote(req.params.id, req.user!.id)
    if (!note) throw new Error('進捗ログが見つかりません')
    if (note.user_id !== req.user!.id && req.user!.role !== 'admin') {
      throw new Error('この進捗ログを削除する権限がありません')
    }
    deleteProgressNote(req.params.id)
  }, 'progress'))

// ─── Progress comments/reactions ──────────────────────────────
dataRouter.post('/progress-notes/:id/comments', (req, res) =>
  run(res, () => {
    const note = getProgressNote(req.params.id, req.user!.id)
    const parentComment = req.body.parentCommentId
      ? getProgressNoteComment(req.body.parentCommentId)
      : undefined
    const created = createProgressNoteCommentWithId(req.params.id, req.user!.id, req.body.body, req.body.parentCommentId)
    const notified = notifyProgressReply(req.user!.id, note, parentComment, created.commentId)
    if (note) {
      const mentioned = notifyMentions(req.user!.id, req.body.body, note, created.commentId, notified)
      mentioned.forEach((userId) => notified.add(userId))
      notifySubscribers(req.user!.id, note, created.commentId, notified)
    }
    return created.note
  }, 'progress'))
dataRouter.put('/progress-note-comments/:id', (req, res) =>
  run(res, () => {
    const comment = getProgressNoteComment(req.params.id)
    if (!comment) throw new Error('コメントが見つかりません')
    if (comment.user_id !== req.user!.id && req.user!.role !== 'admin') {
      throw new Error('このコメントを編集する権限がありません')
    }
    return updateProgressNoteComment(req.params.id, req.body.body, req.user!.id)
  }, 'progress'))
dataRouter.delete('/progress-note-comments/:id', (req, res) =>
  run(res, () => {
    const comment = getProgressNoteComment(req.params.id)
    if (!comment) throw new Error('コメントが見つかりません')
    if (comment.user_id !== req.user!.id && req.user!.role !== 'admin') {
      throw new Error('このコメントを削除する権限がありません')
    }
    return deleteProgressNoteComment(req.params.id, req.user!.id)
  }, 'progress'))
dataRouter.post('/progress-notes/:id/reactions', (req, res) =>
  run(res, () => {
    const updated = toggleProgressNoteReaction(req.params.id, req.user!.id, req.body.emoji)
    const liked = updated.reactions.find((reaction) => reaction.emoji === req.body.emoji)?.reacted_by_me
    if (liked) notifyProgressReaction(req.user!.id, updated)
    return updated
  }, 'progress'))
dataRouter.post('/progress-note-comments/:id/reactions', (req, res) =>
  run(res, () => {
    const updated = toggleProgressNoteCommentReaction(req.params.id, req.user!.id, req.body.emoji)
    const comment = findCommentInTree(updated.comments, req.params.id)
    const liked = comment?.reactions.find((reaction) => reaction.emoji === req.body.emoji)?.reacted_by_me
    if (liked) notifyCommentReaction(req.user!.id, updated, comment)
    return updated
  }, 'progress'))

// ─── Progress digest (admin: anyone / member: self only) ──────
dataRouter.get('/progress-digest', (req, res) =>
  run(res, () => {
    const from = String(req.query.from ?? '')
    const to = String(req.query.to ?? '')
    const rawIds = req.query.userIds
    let userIds =
      typeof rawIds === 'string' && rawIds.length > 0 ? rawIds.split(',').filter(Boolean) : undefined
    if (req.user!.role !== 'admin') userIds = [req.user!.id]
    const includePrivate = req.query.includePrivate !== 'false'
    return getProgressDigest(from, to, userIds, includePrivate)
  }))

// ─── Desktop DB import (admin) ────────────────────────────────
// Body is the raw bytes of a desktop todo.db. Written to a temp file because
// better-sqlite3 only opens databases from a path.
dataRouter.post(
  '/import/desktop-db',
  requireAdmin,
  raw({ type: () => true, limit: '500mb' }),
  (req, res) => {
    try {
      const targetUserId = String(req.query.userId ?? '')
      const dryRun = req.query.dryRun === '1'
      if (!targetUserId || !getUserById(targetUserId)) {
        throw new Error('取り込み先のユーザーが見つかりません')
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new Error('ファイルが空か、読み込めませんでした')
      }

      const tmpPath = path.join(os.tmpdir(), `desktop-import-${crypto.randomUUID()}.db`)
      fs.writeFileSync(tmpPath, req.body)
      try {
        const result = importDesktopDb({
          webDb: getDb(),
          sourceDbPath: tmpPath,
          targetUserId,
          dryRun
        })
        if (!dryRun) {
          broadcastDataChanged('category')
          broadcastDataChanged('todo')
          broadcastDataChanged('subtask')
          broadcastDataChanged('plan')
          broadcastDataChanged('progress')
        }
        res.json(result)
      } finally {
        try { fs.unlinkSync(tmpPath) } catch { /* 一時ファイルの削除失敗は無視 */ }
      }
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'エラーが発生しました' })
    }
  }
)

// ─── Team dashboard ───────────────────────────────────────────
dataRouter.get('/team', (req, res) => run(res, () => getTeamDashboard(req.query.includePrivate !== 'false')))
