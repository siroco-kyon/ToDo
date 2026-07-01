import crypto from 'crypto'
import { getDb } from './connection'
import type {
  ProgressNote,
  ProgressNoteComment,
  ProgressNoteReaction,
  ProgressDigest,
  ProgressDigestComment,
  ProgressDigestCompletedTodo,
  ProgressDigestNote,
  ProgressDigestSubTask,
  ProgressDigestTaskChange,
  ProgressDigestTodo,
  ProgressDigestUser
} from './types'

const NOTE_SELECT = `SELECT pn.id, pn.todo_id, pn.user_id, pn.body, pn.created_at, pn.updated_at,
              t.title AS todo_title, c.name AS category_name, c.color AS category_color,
              u.display_name AS author_name, u.color AS author_color,
              COUNT(pnc.id) AS comment_count
       FROM ProgressNotes pn
       JOIN Todos t ON pn.todo_id = t.id
       LEFT JOIN Categories c ON t.category_id = c.id
       LEFT JOIN Users u ON pn.user_id = u.id
       LEFT JOIN ProgressNoteComments pnc ON pnc.note_id = pn.id`

const COMMENT_SELECT = `SELECT pnc.id, pnc.note_id, pnc.parent_comment_id, pnc.user_id, pnc.body, pnc.created_at, pnc.updated_at,
              u.display_name AS author_name, u.color AS author_color
       FROM ProgressNoteComments pnc
       LEFT JOIN Users u ON pnc.user_id = u.id`

function actorKey(userId: string | null | undefined): string {
  return userId ?? 'desktop'
}

function hydrateNotes(notes: ProgressNote[], currentUserId?: string | null): ProgressNote[] {
  if (notes.length === 0) return []

  const db = getDb()
  const noteIds = notes.map((note) => note.id)
  const placeholders = noteIds.map(() => '?').join(', ')

  const commentRows = db
    .prepare(`${COMMENT_SELECT} WHERE pnc.note_id IN (${placeholders}) ORDER BY pnc.created_at ASC`)
    .all(...noteIds) as Array<Omit<ProgressNoteComment, 'replies' | 'reactions'>>

  const reactionRows = db
    .prepare(
      `SELECT note_id, emoji, COUNT(*) AS count,
              SUM(CASE WHEN actor_key = ? THEN 1 ELSE 0 END) AS reacted_by_me
       FROM ProgressNoteReactions
       WHERE note_id IN (${placeholders})
       GROUP BY note_id, emoji
       ORDER BY emoji ASC`
    )
    .all(actorKey(currentUserId), ...noteIds) as Array<ProgressNoteReaction & { note_id: string }>

  const commentIds = commentRows.map((row) => row.id)
  const commentReactionRows = commentIds.length === 0 ? [] : db
    .prepare(
      `SELECT comment_id, emoji, COUNT(*) AS count,
              SUM(CASE WHEN actor_key = ? THEN 1 ELSE 0 END) AS reacted_by_me
       FROM ProgressCommentReactions
       WHERE comment_id IN (${commentIds.map(() => '?').join(', ')})
       GROUP BY comment_id, emoji
       ORDER BY emoji ASC`
    )
    .all(actorKey(currentUserId), ...commentIds) as Array<ProgressNoteReaction & { comment_id: string }>

  const commentReactionsByComment = new Map<string, ProgressNoteReaction[]>()
  for (const row of commentReactionRows) {
    const reaction: ProgressNoteReaction = {
      emoji: row.emoji,
      count: Number(row.count),
      reacted_by_me: Boolean(row.reacted_by_me)
    }
    const list = commentReactionsByComment.get(row.comment_id)
    if (list) list.push(reaction)
    else commentReactionsByComment.set(row.comment_id, [reaction])
  }

  const commentById = new Map<string, ProgressNoteComment>()
  for (const row of commentRows) {
    commentById.set(row.id, { ...row, replies: [], reactions: commentReactionsByComment.get(row.id) ?? [] })
  }

  const commentsByNote = new Map<string, ProgressNoteComment[]>()
  for (const comment of commentById.values()) {
    if (comment.parent_comment_id && commentById.has(comment.parent_comment_id)) {
      commentById.get(comment.parent_comment_id)!.replies.push(comment)
      continue
    }

    const list = commentsByNote.get(comment.note_id)
    if (list) list.push(comment)
    else commentsByNote.set(comment.note_id, [comment])
  }

  const reactionsByNote = new Map<string, ProgressNoteReaction[]>()
  for (const row of reactionRows) {
    const reaction: ProgressNoteReaction = {
      emoji: row.emoji,
      count: Number(row.count),
      reacted_by_me: Boolean(row.reacted_by_me)
    }
    const list = reactionsByNote.get(row.note_id)
    if (list) list.push(reaction)
    else reactionsByNote.set(row.note_id, [reaction])
  }

  return notes.map((note) => ({
    ...note,
    comment_count: Number(note.comment_count),
    comments: commentsByNote.get(note.id) ?? [],
    reactions: reactionsByNote.get(note.id) ?? []
  }))
}

export function getProgressNotesByTodo(todoId: string, currentUserId?: string | null): ProgressNote[] {
  const notes = getDb()
    .prepare(`${NOTE_SELECT} WHERE pn.todo_id = ? GROUP BY pn.id ORDER BY pn.created_at DESC`)
    .all(todoId) as ProgressNote[]
  return hydrateNotes(notes, currentUserId)
}

export function getProgressNotesByDate(dateStr: string, currentUserId?: string | null): ProgressNote[] {
  return getProgressNotesByRange(dateStr, dateStr, currentUserId)
}

export function getProgressNotesByRange(from: string, to: string, currentUserId?: string | null): ProgressNote[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('進捗タイムラインの期間が不正です')
  }
  const notes = getDb()
    .prepare(`${NOTE_SELECT} WHERE date(pn.created_at, 'localtime') BETWEEN ? AND ? GROUP BY pn.id ORDER BY pn.created_at DESC`)
    .all(from, to) as ProgressNote[]
  return hydrateNotes(notes, currentUserId)
}

export function getProgressNote(id: string, currentUserId?: string | null): ProgressNote | undefined {
  const note = getDb()
    .prepare(`${NOTE_SELECT} WHERE pn.id = ? GROUP BY pn.id`)
    .get(id) as ProgressNote | undefined
  return note ? hydrateNotes([note], currentUserId)[0] : undefined
}

export function createProgressNote(todoId: string, userId: string, body: string): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('進捗ログの内容を入力してください')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO ProgressNotes (id, todo_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, todoId, userId, trimmed, now, now)
  return getProgressNote(id, userId) as ProgressNote
}

export function updateProgressNote(id: string, body: string, currentUserId: string): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('進捗ログの内容を入力してください')
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE ProgressNotes SET body = ?, updated_at = ? WHERE id = ?')
    .run(trimmed, now, id)
  return getProgressNote(id, currentUserId) as ProgressNote
}

export function deleteProgressNote(id: string): void {
  getDb().prepare('DELETE FROM ProgressNotes WHERE id = ?').run(id)
}

export function getProgressNoteComment(id: string): ProgressNoteComment | undefined {
  return getDb().prepare(`${COMMENT_SELECT} WHERE pnc.id = ?`).get(id) as ProgressNoteComment | undefined
}

export function createProgressNoteCommentWithId(
  noteId: string,
  userId: string,
  body: string,
  parentCommentId?: string | null
): { note: ProgressNote; commentId: string } {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('コメントを入力してください')
  const parentId = parentCommentId || null
  if (parentId) {
    const parent = getProgressNoteComment(parentId)
    if (!parent || parent.note_id !== noteId) throw new Error('返信先のコメントが見つかりません')
  }
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO ProgressNoteComments (id, note_id, parent_comment_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, noteId, parentId, userId, trimmed, now, now)
  return { note: getProgressNote(noteId, userId) as ProgressNote, commentId: id }
}

export function createProgressNoteComment(noteId: string, userId: string, body: string, parentCommentId?: string | null): ProgressNote {
  return createProgressNoteCommentWithId(noteId, userId, body, parentCommentId).note
}

export function updateProgressNoteComment(id: string, body: string, currentUserId: string): ProgressNote {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('コメントを入力してください')
  const comment = getProgressNoteComment(id)
  if (!comment) throw new Error('コメントが見つかりません')
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE ProgressNoteComments SET body = ?, updated_at = ? WHERE id = ?')
    .run(trimmed, now, id)
  return getProgressNote(comment.note_id, currentUserId) as ProgressNote
}

export function deleteProgressNoteComment(id: string, currentUserId: string): ProgressNote {
  const comment = getProgressNoteComment(id)
  if (!comment) throw new Error('コメントが見つかりません')
  getDb()
    .prepare(
      `WITH RECURSIVE comment_tree(id) AS (
         SELECT id FROM ProgressNoteComments WHERE id = ?
         UNION ALL
         SELECT c.id FROM ProgressNoteComments c
         JOIN comment_tree ct ON c.parent_comment_id = ct.id
       )
       DELETE FROM ProgressNoteComments WHERE id IN (SELECT id FROM comment_tree)`
    )
    .run(id)
  return getProgressNote(comment.note_id, currentUserId) as ProgressNote
}

export function toggleProgressNoteReaction(noteId: string, userId: string, emoji: string): ProgressNote {
  const normalizedEmoji = emoji.trim()
  if (!normalizedEmoji) throw new Error('リアクションを選択してください')
  const key = actorKey(userId)
  const db = getDb()
  const existing = db
    .prepare('SELECT id FROM ProgressNoteReactions WHERE note_id = ? AND actor_key = ? AND emoji = ?')
    .get(noteId, key, normalizedEmoji) as { id: string } | undefined

  if (existing) {
    db.prepare('DELETE FROM ProgressNoteReactions WHERE id = ?').run(existing.id)
  } else {
    db.prepare('INSERT INTO ProgressNoteReactions (id, note_id, user_id, actor_key, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), noteId, userId, key, normalizedEmoji, new Date().toISOString())
  }

  return getProgressNote(noteId, userId) as ProgressNote
}

export function toggleProgressNoteCommentReaction(commentId: string, userId: string, emoji: string): ProgressNote {
  const normalizedEmoji = emoji.trim()
  if (!normalizedEmoji) throw new Error('リアクションを選択してください')
  const comment = getProgressNoteComment(commentId)
  if (!comment) throw new Error('コメントが見つかりません')
  const key = actorKey(userId)
  const db = getDb()
  const existing = db
    .prepare('SELECT id FROM ProgressCommentReactions WHERE comment_id = ? AND actor_key = ? AND emoji = ?')
    .get(commentId, key, normalizedEmoji) as { id: string } | undefined

  if (existing) {
    db.prepare('DELETE FROM ProgressCommentReactions WHERE id = ?').run(existing.id)
  } else {
    db.prepare('INSERT INTO ProgressCommentReactions (id, comment_id, user_id, actor_key, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), commentId, userId, key, normalizedEmoji, new Date().toISOString())
  }

  return getProgressNote(comment.note_id, userId) as ProgressNote
}

/**
 * Admin progress report: for each target member, what they added (tasks +
 * subtasks, with legacy task creation falling back to the assignee), the progress notes they authored, and the
 * time they logged, all within the inclusive [from, to] local-date range.
 */
export function getProgressDigest(from: string, to: string, userIds?: string[], includePrivate = true): ProgressDigest {
  const db = getDb()
  // 全体レンズ時はプライベートカテゴリのタスク由来の集計を除外する
  const catJoin = includePrivate ? '' : 'LEFT JOIN Categories c ON t.category_id = c.id'
  const catClause = includePrivate ? '' : 'AND COALESCE(c.is_private, 0) = 0'

  let targets: Array<{ id: string; display_name: string; color: string }>
  if (userIds && userIds.length > 0) {
    const placeholders = userIds.map(() => '?').join(', ')
    targets = db
      .prepare(
        `SELECT id, display_name, color FROM Users WHERE id IN (${placeholders}) ORDER BY display_name ASC`
      )
      .all(...userIds) as typeof targets
  } else {
    targets = db
      .prepare('SELECT id, display_name, color FROM Users WHERE is_active = 1 ORDER BY display_name ASC')
      .all() as typeof targets
  }

  const addedTodosStmt = db.prepare(
    `SELECT t.id, t.title, t.status, t.progress, t.memo,
            c.name AS category_name, c.color AS category_color, t.created_at
     FROM Todos t
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE COALESCE(t.created_by, t.assignee_id) = ? AND date(t.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
     ORDER BY t.created_at ASC`
  )

  const completedTodosStmt = db.prepare(
    `SELECT t.id, t.title, t.status, t.progress, t.memo,
            c.name AS category_name, c.color AS category_color, t.completed_at
     FROM Todos t
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE t.assignee_id = ? AND t.status = 'done' AND t.completed_at IS NOT NULL
       AND date(t.completed_at, 'localtime') BETWEEN ? AND ? ${catClause}
     ORDER BY t.completed_at ASC`
  )

  const addedSubTasksStmt = db.prepare(
    `SELECT st.id, st.title, st.todo_id, t.title AS todo_title, st.done, st.created_at
     FROM SubTasks st
     JOIN Todos t ON st.todo_id = t.id
     ${catJoin}
     WHERE t.assignee_id = ? AND date(st.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
     ORDER BY st.created_at ASC`
  )

  const notesStmt = db.prepare(
    `SELECT pn.id, pn.todo_id, t.title AS todo_title, pn.body, pn.created_at
     FROM ProgressNotes pn
     JOIN Todos t ON pn.todo_id = t.id
     ${catJoin}
     WHERE pn.user_id = ? AND date(pn.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
     ORDER BY pn.created_at ASC`
  )

  const taskChangesStmt = db.prepare(
    `SELECT tcl.id, tcl.todo_id, t.title AS todo_title,
            c.name AS category_name, c.color AS category_color,
            tcl.field, tcl.old_value, tcl.new_value, tcl.created_at
     FROM TodoChangeLogs tcl
     JOIN Todos t ON tcl.todo_id = t.id
     LEFT JOIN Categories c ON t.category_id = c.id
     WHERE (tcl.user_id = ? OR (tcl.user_id IS NULL AND t.assignee_id = ?))
       AND date(tcl.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
     ORDER BY tcl.created_at ASC`
  )

  const commentsStmt = db.prepare(
    `SELECT pnc.id, pnc.note_id, pn.todo_id, t.title AS todo_title,
            pnc.parent_comment_id, pnc.body, pnc.created_at
     FROM ProgressNoteComments pnc
     JOIN ProgressNotes pn ON pnc.note_id = pn.id
     JOIN Todos t ON pn.todo_id = t.id
     ${catJoin}
     WHERE pnc.user_id = ? AND date(pnc.created_at, 'localtime') BETWEEN ? AND ? ${catClause}
     ORDER BY pnc.created_at ASC`
  )

  const workStmt = db.prepare(
    `SELECT COALESCE(SUM(wl.duration_seconds), 0) AS seconds, COUNT(*) AS cnt
     FROM WorkLogs wl
     ${includePrivate ? '' : 'JOIN Todos t ON wl.todo_id = t.id LEFT JOIN Categories c ON t.category_id = c.id'}
     WHERE wl.user_id = ? AND date(wl.start_time, 'localtime') BETWEEN ? AND ? ${catClause}`
  )

  const users: ProgressDigestUser[] = targets.map((u) => {
    const work = workStmt.get(u.id, from, to) as { seconds: number; cnt: number }
    return {
      user_id: u.id,
      display_name: u.display_name,
      color: u.color,
      added_todos: addedTodosStmt.all(u.id, from, to) as ProgressDigestTodo[],
      completed_todos: completedTodosStmt.all(u.id, from, to) as ProgressDigestCompletedTodo[],
      added_subtasks: addedSubTasksStmt.all(u.id, from, to) as ProgressDigestSubTask[],
      task_changes: taskChangesStmt.all(u.id, u.id, from, to) as ProgressDigestTaskChange[],
      notes: notesStmt.all(u.id, from, to) as ProgressDigestNote[],
      comments: commentsStmt.all(u.id, from, to) as ProgressDigestComment[],
      work_minutes: Math.round(work.seconds / 60),
      work_log_count: work.cnt
    }
  })

  return { from, to, users }
}
