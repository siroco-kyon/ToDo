import React, { useState } from 'react'
import { LikeButton, getLikeReaction } from './LikeButton'
import type { ProgressNote, ProgressNoteComment } from '../types'

// 進捗ログ1件を、返信スレッドまで省略せずに表示するカード（報告タブ・概要で共通）。
// 操作用のコールバックを渡したときだけ、いいね・返信・要相談・編集・削除ができる。渡さなければ表示専用。

const MAX_INDENT_DEPTH = 3

interface Props {
  note: ProgressNote
  /** true のときタスク名を見出しに出す（タスク横断の一覧で使う） */
  showTask?: boolean
  onSelectTodo?: (id: string) => void
  onToggleLike?: (noteId: string) => void
  onToggleCommentLike?: (commentId: string) => void
  /** 返信を投稿する。parentCommentId が null のときは進捗ログへの返信。成功したら true */
  onReply?: (noteId: string, body: string, parentCommentId: string | null) => Promise<boolean>
  /** 「要相談」の付け外し */
  onToggleDiscussion?: (noteId: string, value: boolean) => void
  /** 編集・削除してよいか（投稿者本人・管理者・デスクトップ版） */
  canModify?: boolean
  /** 成功したら true を返す（編集欄を閉じる） */
  onUpdate?: (noteId: string, body: string) => Promise<boolean>
  onDelete?: (noteId: string) => void
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`
}

function getAuthorName(authorName: string | null): string {
  // デスクトップ版は投稿者を持たない
  return authorName?.trim() || '自分'
}

/** 返信の入力欄。Ctrl+Enter で送信、Esc で閉じる */
function ReplyComposer({
  placeholder,
  onSubmit,
  onCancel
}: {
  placeholder: string
  onSubmit: (body: string) => Promise<boolean>
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const canSend = !sending && draft.trim().length > 0

  const send = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    const ok = await onSubmit(draft)
    setSending(false)
    if (ok) setDraft('')
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            void send()
          }
          if (event.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        rows={2}
        autoFocus
        aria-label={placeholder}
        style={textareaStyle}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={onCancel} style={ghostButtonStyle}>キャンセル</button>
        <button onClick={() => void send()} disabled={!canSend} style={saveButtonStyle(canSend)}>{sending ? '送信中…' : '返信'}</button>
      </div>
    </div>
  )
}

function CommentItem({
  comment,
  depth,
  onToggleLike,
  replyingToId,
  onStartReply,
  renderReplyComposer
}: {
  comment: ProgressNoteComment
  depth: number
  onToggleLike?: (commentId: string) => void
  replyingToId: string | null
  onStartReply?: (commentId: string) => void
  renderReplyComposer: (comment: ProgressNoteComment) => React.ReactNode
}): React.JSX.Element {
  const authorColor = comment.author_color ?? '#a78bfa'
  const replies = comment.replies ?? []
  return (
    <div style={{ marginLeft: Math.min(depth, MAX_INDENT_DEPTH) * 14 }}>
      <div style={{ borderLeft: `2px solid ${authorColor}66`, paddingLeft: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: '0.72rem' }}>
          <span style={{ color: '#64748b' }}>↳</span>
          <span style={{ color: authorColor, fontWeight: 700 }}>{getAuthorName(comment.author_name)}</span>
          <span style={{ color: '#64748b' }}>{formatDateTime(comment.created_at)}</span>
          {comment.updated_at !== comment.created_at && <span style={{ color: '#475569' }}>編集済み</span>}
          <LikeButton
            reaction={getLikeReaction(comment)}
            onClick={onToggleLike ? () => onToggleLike(comment.id) : undefined}
          />
          {onStartReply && replyingToId !== comment.id && (
            <button onClick={() => onStartReply(comment.id)} style={inlineActionStyle}>返信</button>
          )}
        </div>
        <div style={{ marginTop: 2, fontSize: '0.8rem', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
          {comment.body}
        </div>
        {replyingToId === comment.id && renderReplyComposer(comment)}
      </div>
      {replies.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              depth={depth + 1}
              onToggleLike={onToggleLike}
              replyingToId={replyingToId}
              onStartReply={onStartReply}
              renderReplyComposer={renderReplyComposer}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ProgressNoteThread({
  note,
  showTask = false,
  onSelectTodo,
  onToggleLike,
  onToggleCommentLike,
  onReply,
  onToggleDiscussion,
  canModify = false,
  onUpdate,
  onDelete
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // 返信先: 'note' は進捗ログ本体、それ以外はコメントID
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const authorColor = note.author_color ?? '#93c5fd'
  const comments = note.comments ?? []
  const needsDiscussion = note.needs_discussion === 1
  const canEdit = canModify && Boolean(onUpdate)
  const canDelete = canModify && Boolean(onDelete)
  const canSave = !saving && draft.trim().length > 0 && draft.trim() !== note.body

  const save = async (): Promise<void> => {
    if (!onUpdate || !canSave) return
    setSaving(true)
    const ok = await onUpdate(note.id, draft)
    setSaving(false)
    if (ok) setEditing(false)
  }

  const submitReply = async (body: string, parentCommentId: string | null): Promise<boolean> => {
    if (!onReply) return false
    const ok = await onReply(note.id, body, parentCommentId)
    if (ok) setReplyingTo(null)
    return ok
  }

  const renderCommentReplyComposer = (comment: ProgressNoteComment): React.ReactNode => (
    <ReplyComposer
      placeholder={`${getAuthorName(comment.author_name)}さんに返信`}
      onSubmit={(body) => submitReply(body, comment.id)}
      onCancel={() => setReplyingTo(null)}
    />
  )

  return (
    <article
      style={{
        background: '#111827',
        border: `1px solid ${needsDiscussion ? '#c2410c' : '#1f2937'}`,
        borderRadius: 10,
        padding: '9px 11px',
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.74rem' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: authorColor, flexShrink: 0 }} />
        <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{getAuthorName(note.author_name)}</span>
        <span style={{ color: '#64748b' }}>{formatDateTime(note.created_at)}</span>
        {note.updated_at !== note.created_at && <span style={{ color: '#475569' }}>編集済み</span>}
        {needsDiscussion && <span style={discussionBadgeStyle}>要相談</span>}
        {showTask && (
          onSelectTodo ? (
            <button
              onClick={() => onSelectTodo(note.todo_id)}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: note.category_color ?? '#93c5fd', fontSize: '0.74rem', fontWeight: 700, textAlign: 'left' }}
            >
              {note.todo_title}
            </button>
          ) : (
            <span style={{ color: note.category_color ?? '#93c5fd', fontWeight: 700 }}>{note.todo_title}</span>
          )
        )}
      </div>

      {editing ? (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void save()
              }
              if (event.key === 'Escape') setEditing(false)
            }}
            rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
            autoFocus
            aria-label="進捗ログを編集"
            style={textareaStyle}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button onClick={() => setEditing(false)} style={ghostButtonStyle}>キャンセル</button>
            <button onClick={() => void save()} disabled={!canSave} style={saveButtonStyle(canSave)}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 5, fontSize: '0.84rem', color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
          {note.body}
        </div>
      )}

      {!editing && (onToggleLike || getLikeReaction(note) || onReply || onToggleDiscussion || canEdit || canDelete) && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <LikeButton reaction={getLikeReaction(note)} onClick={onToggleLike ? () => onToggleLike(note.id) : undefined} />
          {onReply && replyingTo !== 'note' && (
            <button onClick={() => setReplyingTo('note')} style={inlineActionStyle}>返信</button>
          )}
          {onToggleDiscussion && (
            <button
              onClick={() => onToggleDiscussion(note.id, !needsDiscussion)}
              title={needsDiscussion ? '相談が済んだら外します' : '定例で相談したい内容に印を付けます'}
              style={{ ...inlineActionStyle, color: needsDiscussion ? '#86efac' : '#fdba74' }}
            >
              {needsDiscussion ? '相談済みにする' : '要相談にする'}
            </button>
          )}
          {canEdit && (
            <button onClick={() => { setDraft(note.body); setEditing(true) }} style={inlineActionStyle}>編集</button>
          )}
          {canDelete && (
            <button onClick={() => onDelete?.(note.id)} style={inlineActionStyle}>削除</button>
          )}
        </div>
      )}

      {comments.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              depth={0}
              onToggleLike={onToggleCommentLike}
              replyingToId={replyingTo}
              onStartReply={onReply ? (commentId) => setReplyingTo(commentId) : undefined}
              renderReplyComposer={renderCommentReplyComposer}
            />
          ))}
        </div>
      )}

      {replyingTo === 'note' && (
        <ReplyComposer
          placeholder="この進捗ログに返信（Ctrl+Enterで送信）"
          onSubmit={(body) => submitReply(body, null)}
          onCancel={() => setReplyingTo(null)}
        />
      )}
    </article>
  )
}

const discussionBadgeStyle: React.CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 800,
  color: '#fed7aa',
  background: '#7c2d12',
  border: '1px solid #c2410c',
  borderRadius: 999,
  padding: '0 7px'
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 7,
  color: '#e2e8f0',
  fontSize: '0.84rem',
  lineHeight: 1.55,
  outline: 'none',
  resize: 'vertical'
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

const ghostButtonStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid #334155',
  background: '#0f172a',
  color: '#94a3b8',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 700
}

function saveButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    borderRadius: 7,
    border: `1px solid ${enabled ? '#1d4ed8' : '#334155'}`,
    background: enabled ? '#2563eb' : '#1e293b',
    color: enabled ? '#eff6ff' : '#64748b',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}
