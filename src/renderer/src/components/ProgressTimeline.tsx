import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProgressNote, ProgressNoteComment, PublicUser, Todo } from '../types'

export interface ProgressTimelineFocusTarget {
  date?: string | null
  todoId?: string | null
  noteId?: string | null
  commentId?: string | null
  nonce: number
}

interface Props {
  todos: Todo[]
  currentUser?: PublicUser | null
  focusTarget?: ProgressTimelineFocusTarget | null
  onSelectTodo: (id: string) => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getMonth() + 1}/${date.getDate()} ${formatTime(iso)}`
}

function patchNote(notes: ProgressNote[], updated: ProgressNote): ProgressNote[] {
  const normalized = normalizeNote(updated)
  return notes.map((note) => note.id === normalized.id ? normalized : note)
}

function normalizeComment(comment: ProgressNoteComment): ProgressNoteComment {
  return { ...comment, replies: (comment.replies ?? []).map(normalizeComment) }
}

function normalizeNote(note: ProgressNote): ProgressNote {
  return {
    ...note,
    comments: (note.comments ?? []).map(normalizeComment),
    reactions: note.reactions ?? []
  }
}

function countComments(comments: ProgressNoteComment[] = []): number {
  return comments.reduce((sum, comment) => sum + 1 + countComments(comment.replies ?? []), 0)
}

function flattenReplies(comments: ProgressNoteComment[] = []): ProgressNoteComment[] {
  return comments.flatMap((comment) => [comment, ...flattenReplies(comment.replies ?? [])])
}

function getAuthorName(authorName: string | null, fallback = 'Desktop'): string {
  return authorName?.trim() || fallback
}

function getInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || 'D'
}

function draftKey(noteId: string, parentCommentId: string | null): string {
  return parentCommentId ? `reply:${parentCommentId}` : `note:${noteId}`
}

function noteElementId(id: string): string {
  return `progress-note-${id}`
}

function commentElementId(id: string): string {
  return `progress-comment-${id}`
}

export function ProgressTimeline({ todos, currentUser = null, focusTarget = null, onSelectTodo, onShowToast }: Props): React.JSX.Element {
  const [date, setDate] = useState(getTodayKey)
  const [notes, setNotes] = useState<ProgressNote[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedTodoId, setSelectedTodoId] = useState('')
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null)
  const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingNoteDraft, setEditingNoteDraft] = useState('')
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [commentingOnNoteId, setCommentingOnNoteId] = useState<string | null>(null)
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingCommentDraft, setEditingCommentDraft] = useState('')

  const taskOptions = useMemo(() => (
    todos
      .filter((todo) => todo.status !== 'archived')
      .slice()
      .sort((a, b) => {
        if (a.status === 'done' && b.status !== 'done') return 1
        if (a.status !== 'done' && b.status === 'done') return -1
        return a.title.localeCompare(b.title, 'ja')
      })
  ), [todos])

  useEffect(() => {
    if (selectedTodoId && taskOptions.some((todo) => todo.id === selectedTodoId)) return
    setSelectedTodoId(taskOptions[0]?.id ?? '')
  }, [selectedTodoId, taskOptions])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const loaded = await window.api.progressNoteGetByDate(date)
      setNotes(loaded.map(normalizeNote))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗タイムラインを読み込めませんでした', 'error')
      setNotes([])
    } finally {
      setLoading(false)
    }
  }, [date, onShowToast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!focusTarget) return
    if (focusTarget.date) setDate(focusTarget.date)
    if (focusTarget.todoId) setSelectedTodoId(focusTarget.todoId)
    setFocusedNoteId(focusTarget.noteId ?? null)
    setFocusedCommentId(focusTarget.commentId ?? null)
  }, [focusTarget])

  useEffect(() => {
    if (loading) return
    const targetId = focusedCommentId
      ? commentElementId(focusedCommentId)
      : focusedNoteId
        ? noteElementId(focusedNoteId)
        : null
    if (!targetId) return
    const timer = window.setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [focusedCommentId, focusedNoteId, loading, notes])

  useEffect(() => {
    const unsubscribe = window.api.onDataChanged((scope) => {
      if (scope === 'todo') void load()
    })
    return () => unsubscribe()
  }, [load])

  const canModifyNote = (note: ProgressNote): boolean =>
    currentUser == null || currentUser.role === 'admin' || note.user_id === currentUser.id

  const canModifyComment = (comment: ProgressNoteComment): boolean =>
    currentUser == null || currentUser.role === 'admin' || comment.user_id === currentUser.id

  const handleCreateNote = async (): Promise<void> => {
    const body = noteDraft.trim()
    if (!selectedTodoId || !body || savingNote) return

    try {
      setSavingNote(true)
      const created = await window.api.progressNoteCreate(selectedTodoId, body)
      setNoteDraft('')
      if (created.created_at.slice(0, 10) === date) setNotes((previous) => [normalizeNote(created), ...previous])
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを追加できませんでした', 'error')
    } finally {
      setSavingNote(false)
    }
  }

  const handleUpdateNote = async (noteId: string): Promise<void> => {
    const body = editingNoteDraft.trim()
    if (!body) return
    try {
      const updated = await window.api.progressNoteUpdate(noteId, body)
      setNotes((previous) => patchNote(previous, updated))
      setEditingNoteId(null)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを更新できませんでした', 'error')
    }
  }

  const handleDeleteNote = async (noteId: string): Promise<void> => {
    if (!window.confirm('この進捗ログを削除しますか?')) return
    try {
      await window.api.progressNoteDelete(noteId)
      setNotes((previous) => previous.filter((note) => note.id !== noteId))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを削除できませんでした', 'error')
    }
  }

  const handleCreateComment = async (noteId: string, parentCommentId: string | null = null): Promise<void> => {
    const key = draftKey(noteId, parentCommentId)
    const body = (commentDrafts[key] ?? '').trim()
    if (!body) return

    try {
      const updated = await window.api.progressNoteCommentCreate(noteId, body, parentCommentId)
      setNotes((previous) => patchNote(previous, updated))
      setCommentDrafts((previous) => ({ ...previous, [key]: '' }))
      if (parentCommentId) setReplyingToCommentId(null)
      else setCommentingOnNoteId(null)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'コメントを追加できませんでした', 'error')
    }
  }

  const handleUpdateComment = async (commentId: string): Promise<void> => {
    const body = editingCommentDraft.trim()
    if (!body) return
    try {
      const updated = await window.api.progressNoteCommentUpdate(commentId, body)
      setNotes((previous) => patchNote(previous, updated))
      setEditingCommentId(null)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'コメントを更新できませんでした', 'error')
    }
  }

  const handleDeleteComment = async (commentId: string): Promise<void> => {
    try {
      const updated = await window.api.progressNoteCommentDelete(commentId)
      setNotes((previous) => patchNote(previous, updated))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'コメントを削除できませんでした', 'error')
    }
  }

  const totalComments = notes.reduce((sum, note) => sum + countComments(note.comments ?? []), 0)
  const currentAuthorName = currentUser?.display_name ?? '自分'
  const currentAuthorColor = currentUser?.color ?? '#6366f1'

  const renderComposer = (noteId: string, parentComment: ProgressNoteComment | null, onCancel?: () => void): React.JSX.Element => {
    const key = draftKey(noteId, parentComment?.id ?? null)
    const value = commentDrafts[key] ?? ''
    const placeholder = parentComment
      ? `${getAuthorName(parentComment.author_name)} に返信`
      : 'コメントを書く'

    return (
      <div style={composerRowStyle(parentComment ? 1 : 0)}>
        <Avatar name={currentAuthorName} color={currentAuthorColor} size={30} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <textarea
            value={value}
            onChange={(event) => setCommentDrafts((previous) => ({ ...previous, [key]: event.target.value }))}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void handleCreateComment(noteId, parentComment?.id ?? null)
              }
            }}
            placeholder={placeholder}
            rows={parentComment ? 2 : 1}
            style={{ ...inputStyle, width: '100%', minHeight: parentComment ? 54 : 40, resize: 'vertical', lineHeight: 1.5 }}
          />
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            {onCancel && (
              <button onClick={onCancel} style={ghostButtonStyle}>
                取消
              </button>
            )}
            <button
              onClick={() => void handleCreateComment(noteId, parentComment?.id ?? null)}
              disabled={!value.trim()}
              style={pillButtonStyle(Boolean(value.trim()))}
            >
              {parentComment ? '返信' : '送信'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderComment = (note: ProgressNote, comment: ProgressNoteComment, depth = 0): React.JSX.Element => {
    const authorName = getAuthorName(comment.author_name)
    const authorColor = comment.author_color ?? '#64748b'
    const editingThisComment = editingCommentId === comment.id
    const displayDepth = depth > 0 ? 1 : 0
    const replies = comment.replies ?? []
    const flattenedReplies = depth === 0 ? flattenReplies(replies) : []

    return (
      <div
        id={commentElementId(comment.id)}
        key={comment.id}
        style={{ ...commentThreadStyle, marginLeft: displayDepth * 18 }}
      >
        <div style={{ position: 'relative', width: 34, display: 'flex', justifyContent: 'center' }}>
          {replies.length > 0 && <div style={verticalLineStyle} />}
          <Avatar name={authorName} color={authorColor} size={30} />
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ color: '#e2e8f0', fontSize: '0.82rem', fontWeight: 800 }}>{authorName}</span>
            <span style={{ color: '#64748b', fontSize: '0.72rem' }}>{formatDateTime(comment.created_at)}</span>
            {comment.updated_at !== comment.created_at && <span style={editedStyle}>編集済み</span>}
          </div>

          {editingThisComment ? (
            <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={editingCommentDraft}
                onChange={(event) => setEditingCommentDraft(event.target.value)}
                rows={3}
                autoFocus
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button onClick={() => setEditingCommentId(null)} style={ghostButtonStyle}>キャンセル</button>
                <button onClick={() => void handleUpdateComment(comment.id)} disabled={!editingCommentDraft.trim()} style={pillButtonStyle(Boolean(editingCommentDraft.trim()))}>保存</button>
              </div>
            </div>
          ) : (
            <div style={commentBodyStyle}>{comment.body}</div>
          )}

          {!editingThisComment && (
            <div style={commentActionRowStyle}>
              <button onClick={() => setReplyingToCommentId(comment.id)} style={inlineActionStyle}>返信</button>
              {replies.length > 0 && <span style={actionMetaStyle}>返信 {countComments(replies)}</span>}
              {canModifyComment(comment) && (
                <>
                  <button onClick={() => { setEditingCommentId(comment.id); setEditingCommentDraft(comment.body) }} style={inlineActionStyle}>編集</button>
                  <button onClick={() => void handleDeleteComment(comment.id)} style={inlineActionStyle}>削除</button>
                </>
              )}
            </div>
          )}

          {replyingToCommentId === comment.id && renderComposer(note.id, comment, () => setReplyingToCommentId(null))}
          {flattenedReplies.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {flattenedReplies.map((reply) => renderComment(note, reply, 1))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0f172a' }}>
      <div style={headerStyle}>
        <div>
          <div style={{ fontSize: '1rem', color: '#f8fafc', fontWeight: 800 }}>進捗タイムライン</div>
          <div style={{ marginTop: 3, color: '#64748b', fontSize: '0.78rem' }}>
            投稿 {notes.length}件 / コメント {totalComments}件
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setDate(getTodayKey())} style={chipStyle(date === getTodayKey())}>今日</button>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value || getTodayKey())} style={inputStyle} />
          <button onClick={() => void load()} style={secondaryButtonStyle}>更新</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={feedStyle}>
          <div style={newPostStyle}>
            <Avatar name={currentAuthorName} color={currentAuthorColor} size={42} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <select value={selectedTodoId} onChange={(event) => setSelectedTodoId(event.target.value)} disabled={taskOptions.length === 0} style={{ ...inputStyle, width: '100%', marginBottom: 8 }}>
                {taskOptions.length === 0 ? (
                  <option value="">タスクがありません</option>
                ) : taskOptions.map((todo) => (
                  <option key={todo.id} value={todo.id}>{todo.title}</option>
                ))}
              </select>
              <textarea
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void handleCreateNote()
                  }
                }}
                placeholder="今日の進捗を共有"
                rows={3}
                style={{ ...postInputStyle, minHeight: 88 }}
              />
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: '#64748b', fontSize: '0.74rem' }}>{noteDraft.length}文字</span>
                <button onClick={() => void handleCreateNote()} disabled={!selectedTodoId || !noteDraft.trim() || savingNote} style={primaryPostButtonStyle(Boolean(selectedTodoId && noteDraft.trim() && !savingNote))}>
                  {savingNote ? '投稿中' : '投稿'}
                </button>
              </div>
            </div>
          </div>

          {loading && <div style={emptyStyle}>読み込み中...</div>}
          {!loading && notes.length === 0 && <div style={emptyStyle}>この日の進捗ログはまだありません。</div>}

          {!loading && notes.map((note) => {
            const authorName = getAuthorName(note.author_name)
            const authorColor = note.author_color ?? '#64748b'
            const editingNote = editingNoteId === note.id
            const comments = note.comments ?? []
            const commentCount = countComments(comments)

            return (
              <article id={noteElementId(note.id)} key={note.id} style={postStyle}>
                <div style={{ position: 'relative', width: 52, display: 'flex', justifyContent: 'center' }}>
                  {comments.length > 0 && <div style={{ ...verticalLineStyle, top: 48 }} />}
                  <Avatar name={authorName} color={authorColor} size={42} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: '#f8fafc', fontSize: '0.9rem', fontWeight: 800 }}>{authorName}</span>
                    <span style={{ color: '#64748b', fontSize: '0.74rem' }}>{formatDateTime(note.created_at)}</span>
                    {note.updated_at !== note.created_at && <span style={editedStyle}>編集済み</span>}
                    <button onClick={() => onSelectTodo(note.todo_id)} style={{ ...taskLinkStyle, color: note.category_color ?? '#93c5fd' }}>{note.todo_title}</button>
                  </div>
                  {note.category_name && (
                    <div style={{ marginTop: 5 }}>
                      <span style={{ ...categoryPillStyle, color: note.category_color ?? '#a5b4fc' }}>{note.category_name}</span>
                    </div>
                  )}

                  {editingNote ? (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <textarea value={editingNoteDraft} onChange={(event) => setEditingNoteDraft(event.target.value)} rows={4} autoFocus style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                        <button onClick={() => setEditingNoteId(null)} style={ghostButtonStyle}>キャンセル</button>
                        <button onClick={() => void handleUpdateNote(note.id)} disabled={!editingNoteDraft.trim()} style={pillButtonStyle(Boolean(editingNoteDraft.trim()))}>保存</button>
                      </div>
                    </div>
                  ) : (
                    <div style={postBodyStyle}>{note.body}</div>
                  )}

                  {!editingNote && (
                    <div style={postActionRowStyle}>
                      <span style={actionMetaStyle}>コメント {commentCount}</span>
                      <button onClick={() => setCommentingOnNoteId(note.id)} style={inlineActionStyle}>返信</button>
                      {canModifyNote(note) && (
                        <>
                          <button onClick={() => { setEditingNoteId(note.id); setEditingNoteDraft(note.body) }} style={inlineActionStyle}>編集</button>
                          <button onClick={() => void handleDeleteNote(note.id)} style={inlineActionStyle}>削除</button>
                        </>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {comments.map((comment) => renderComment(note, comment))}
                    {commentingOnNoteId === note.id && renderComposer(note.id, null, () => setCommentingOnNoteId(null))}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Avatar({ name, color, size }: { name: string; color: string; size: number }): React.JSX.Element {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: `${Math.max(size * 0.38, 12)}px`,
        fontWeight: 900,
        flexShrink: 0,
        boxShadow: '0 0 0 3px #0f172a',
        zIndex: 1
      }}
    >
      {getInitial(name)}
    </div>
  )
}

const headerStyle: React.CSSProperties = {
  padding: '14px 18px 12px',
  borderBottom: '1px solid #1e293b',
  background: '#0b1220',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  flexShrink: 0
}

const feedStyle: React.CSSProperties = {
  width: 'min(820px, 100%)',
  margin: '0 auto',
  borderLeft: '1px solid #1e293b',
  borderRight: '1px solid #1e293b',
  minHeight: '100%',
  background: '#0b1220'
}

const newPostStyle: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: 16,
  borderBottom: '1px solid #1e293b',
  background: '#0f172a'
}

const postStyle: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: '14px 16px',
  borderBottom: '1px solid #1e293b',
  background: '#0b1220'
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.84rem',
  outline: 'none',
  boxSizing: 'border-box'
}

const postInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: '100%',
  border: '1px solid transparent',
  background: '#0b1220',
  resize: 'vertical',
  lineHeight: 1.55,
  fontSize: '0.95rem'
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 11px',
    borderRadius: 999,
    border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
    background: active ? '#172554' : '#111827',
    color: active ? '#dbeafe' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 800
  }
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 11px',
  borderRadius: 999,
  border: '1px solid #334155',
  background: '#111827',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 800
}

function primaryPostButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 18px',
    borderRadius: 999,
    border: `1px solid ${active ? '#2563eb' : '#334155'}`,
    background: active ? '#2563eb' : '#1e293b',
    color: active ? '#eff6ff' : '#64748b',
    cursor: active ? 'pointer' : 'not-allowed',
    fontSize: '0.84rem',
    fontWeight: 900
  }
}

function pillButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 999,
    border: `1px solid ${active ? '#2563eb' : '#334155'}`,
    background: active ? '#172554' : '#1e293b',
    color: active ? '#dbeafe' : '#64748b',
    cursor: active ? 'pointer' : 'not-allowed',
    fontSize: '0.76rem',
    fontWeight: 900
  }
}

const ghostButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 999,
  border: '1px solid #334155',
  background: '#0f172a',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 800
}

const postBodyStyle: React.CSSProperties = {
  marginTop: 10,
  whiteSpace: 'pre-wrap',
  lineHeight: 1.65,
  color: '#dbeafe',
  fontSize: '0.94rem',
  wordBreak: 'break-word'
}

const commentBodyStyle: React.CSSProperties = {
  marginTop: 5,
  color: '#cbd5e1',
  fontSize: '0.84rem',
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

const postActionRowStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap'
}

const commentActionRowStyle: React.CSSProperties = {
  marginTop: 7,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap'
}

const inlineActionStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 800,
  padding: 0
}

const actionMetaStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: '0.72rem',
  fontWeight: 800
}

const taskLinkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: '0.78rem',
  fontWeight: 800,
  textAlign: 'left'
}

const categoryPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  padding: '2px 8px',
  borderRadius: 999,
  background: '#0f172a',
  border: '1px solid #334155',
  fontSize: '0.68rem',
  fontWeight: 800
}

const editedStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: '0.68rem',
  fontWeight: 700
}

const commentThreadStyle: React.CSSProperties = {
  display: 'flex',
  gap: 9,
  position: 'relative'
}

function composerRowStyle(depth: number): React.CSSProperties {
  return {
    display: 'flex',
    gap: 9,
    marginTop: 8,
    marginLeft: depth * 18,
    paddingTop: 2
  }
}

const verticalLineStyle: React.CSSProperties = {
  position: 'absolute',
  top: 34,
  bottom: -8,
  width: 2,
  background: '#1e293b',
  borderRadius: 99
}

const emptyStyle: React.CSSProperties = {
  padding: 32,
  color: '#64748b',
  fontSize: '0.9rem',
  textAlign: 'center',
  borderBottom: '1px solid #1e293b'
}
