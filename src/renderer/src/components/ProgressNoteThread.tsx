import { LinkedText } from './LinkedText'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ReactionBar, countReactions } from './LikeButton'
import { MentionTextarea } from './MentionTextarea'
import type { ProgressNote, ProgressNoteComment, PublicUser } from '../types'
import { dataInk } from '../lib/theme'

// 進捗ログ1件を、返信スレッドまで省略せずに表示するカード（報告タブ・概要で共通）。
// 操作用のコールバックを渡したときだけ、いいね・返信・要相談・編集・削除ができる。渡さなければ表示専用。

const MAX_INDENT_DEPTH = 3

interface Props {
  note: ProgressNote
  /** true のときタスク名を見出しに出す（タスク横断の一覧で使う） */
  showTask?: boolean
  onSelectTodo?: (id: string) => void
  /** リアクション（👍 🎉 👀 🙏）の付け外し */
  onToggleReaction?: (noteId: string, emoji: string) => void
  onToggleCommentReaction?: (commentId: string, emoji: string) => void
  /** 返信で「@」を打ったときの候補（デスクトップ版は空） */
  mentionUsers?: PublicUser[]
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
  users,
  onSubmit,
  onCancel
}: {
  placeholder: string
  users: PublicUser[]
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
      <MentionTextarea
        value={draft}
        onValueChange={setDraft}
        users={users}
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
  onToggleReaction,
  replyingToId,
  onStartReply,
  renderReplyComposer
}: {
  comment: ProgressNoteComment
  depth: number
  onToggleReaction?: (commentId: string, emoji: string) => void
  replyingToId: string | null
  onStartReply?: (commentId: string) => void
  renderReplyComposer: (comment: ProgressNoteComment) => React.ReactNode
}): React.JSX.Element {
  const authorColor = comment.author_color ?? 'var(--violet-400)'
  const replies = comment.replies ?? []
  return (
    <div style={{ marginLeft: Math.min(depth, MAX_INDENT_DEPTH) * 14 }}>
      <div style={{ borderLeft: `2px solid color-mix(in srgb, ${authorColor} 40%, transparent)`, paddingLeft: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: '0.72rem' }}>
          <span style={{ color: 'var(--text-subtle)' }}>↳</span>
          <span style={{ color: dataInk(authorColor), fontWeight: 700 }}>{getAuthorName(comment.author_name)}</span>
          <span style={{ color: 'var(--text-subtle)' }}>{formatDateTime(comment.created_at)}</span>
          {comment.updated_at !== comment.created_at && <span style={{ color: 'var(--text-subtle)' }}>編集済み</span>}
          <ReactionBar
            reactions={comment.reactions}
            onToggle={onToggleReaction ? (emoji) => onToggleReaction(comment.id, emoji) : undefined}
          />
          {onStartReply && replyingToId !== comment.id && (
            <button onClick={() => onStartReply(comment.id)} aria-label={`${getAuthorName(comment.author_name)}さんの返信に返信する`} style={inlineActionStyle}>返信</button>
          )}
        </div>
        <div style={{ marginTop: 2, fontSize: '0.8rem', color: 'var(--slate-300)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
          <LinkedText text={comment.body} />
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
              onToggleReaction={onToggleReaction}
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
  onToggleReaction,
  onToggleCommentReaction,
  mentionUsers = [],
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
  const authorColor = note.author_color ?? 'var(--blue-300)'
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

  // 送ったら入力欄が消えるので、フォーカスをこの投稿の「返信」へ戻す（ページの先頭へ飛ばないように）
  const noteReplyButtonRef = useRef<HTMLButtonElement>(null)
  const submitReply = async (body: string, parentCommentId: string | null): Promise<boolean> => {
    if (!onReply) return false
    const ok = await onReply(note.id, body, parentCommentId)
    if (ok) {
      setReplyingTo(null)
      window.setTimeout(() => noteReplyButtonRef.current?.focus({ preventScroll: true }), 0)
    }
    return ok
  }

  const renderCommentReplyComposer = (comment: ProgressNoteComment): React.ReactNode => (
    <ReplyComposer
      placeholder={`${getAuthorName(comment.author_name)}さんに返信`}
      users={mentionUsers}
      onSubmit={(body) => submitReply(body, comment.id)}
      onCancel={() => setReplyingTo(null)}
    />
  )

  return (
    <article
      style={{
        background: 'var(--gray-900)',
        border: '1px solid var(--gray-800)',
        borderRadius: 10,
        padding: '9px 11px',
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.74rem' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: authorColor, flexShrink: 0 }} />
        <span style={{ color: 'var(--slate-200)', fontWeight: 700 }}>{getAuthorName(note.author_name)}</span>
        <span style={{ color: 'var(--text-subtle)' }}>{formatDateTime(note.created_at)}</span>
        {note.updated_at !== note.created_at && <span style={{ color: 'var(--text-subtle)' }}>編集済み</span>}
        {needsDiscussion && <span style={discussionBadgeStyle}>要相談</span>}
        {showTask && (
          onSelectTodo ? (
            <button
              onClick={() => onSelectTodo(note.todo_id)}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: dataInk(note.category_color ?? 'var(--blue-300)'), fontSize: '0.74rem', fontWeight: 700, textAlign: 'left' }}
            >
              {note.todo_title}
            </button>
          ) : (
            <span style={{ color: dataInk(note.category_color ?? 'var(--blue-300)'), fontWeight: 700 }}>{note.todo_title}</span>
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
        <div style={{ marginTop: 5, fontSize: '0.84rem', color: 'var(--slate-200)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
          <LinkedText text={note.body} />
        </div>
      )}

      {!editing && (onToggleReaction || countReactions(note) > 0 || onReply || onToggleDiscussion || canEdit || canDelete) && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <ReactionBar reactions={note.reactions} onToggle={onToggleReaction ? (emoji) => onToggleReaction(note.id, emoji) : undefined} />
          {onReply && replyingTo !== 'note' && (
            <button ref={noteReplyButtonRef} onClick={() => setReplyingTo('note')} aria-label={`${getAuthorName(note.author_name)}さんの進捗ログに返信する`} style={inlineActionStyle}>返信</button>
          )}
          <NoteMenu
            items={[
              ...(onToggleDiscussion
                ? [{ label: needsDiscussion ? '要相談を外す' : '要相談にする', onSelect: () => onToggleDiscussion(note.id, !needsDiscussion) }]
                : []),
              ...(canEdit ? [{ label: '編集', onSelect: () => { setDraft(note.body); setEditing(true) } }] : []),
              ...(canDelete ? [{ label: '削除', onSelect: () => onDelete?.(note.id), danger: true }] : [])
            ]}
          />
        </div>
      )}

      {comments.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              depth={0}
              onToggleReaction={onToggleCommentReaction}
              replyingToId={replyingTo}
              onStartReply={onReply ? (commentId) => setReplyingTo(commentId) : undefined}
              renderReplyComposer={renderCommentReplyComposer}
            />
          ))}
        </div>
      )}

      {replyingTo === 'note' && (
        <ReplyComposer
          placeholder={mentionUsers.length > 0 ? 'この進捗ログに返信（@で名前を呼ぶと通知・Ctrl+Enterで送信）' : 'この進捗ログに返信（Ctrl+Enterで送信）'}
          users={mentionUsers}
          onSubmit={(body) => submitReply(body, null)}
          onCancel={() => setReplyingTo(null)}
        />
      )}
    </article>
  )
}

/** 「要相談」の印。目立ちすぎないよう、塗りなしの細い枠と落ち着いた色にする（報告タブ・進捗タブで共通） */
export const discussionBadgeStyle: React.CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 600,
  color: 'var(--c-d6b38a)',
  background: 'transparent',
  border: '1px solid var(--c-4b3b2c)',
  borderRadius: 999,
  padding: '0 7px',
  whiteSpace: 'nowrap'
}

export interface NoteMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

/** 要相談・編集・削除など、ふだんは見せなくてよい操作をまとめる「⋯」メニュー（報告タブ・進捗タブで共通） */
export function NoteMenu({ items }: { items: NoteMenuItem[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return
    const anchor = rootRef.current.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    const margin = 8
    const below = anchor.bottom + 4
    const top = below + menu.height <= window.innerHeight - margin ? below : anchor.top - menu.height - 4
    setPosition({
      left: Math.max(margin, Math.min(anchor.left, window.innerWidth - menu.width - margin)),
      top: Math.max(margin, Math.min(top, window.innerHeight - menu.height - margin))
    })
  }, [open, items.length])

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus({ preventScroll: true })
      }
    }
    const handleScroll = (event: Event): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleResize = (): void => setOpen(false)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((value) => !value)}
        aria-label="その他の操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="その他の操作"
        style={moreButtonStyle(open)}
      >
        ⋯
      </button>
      {open && createPortal(
        <div ref={menuRef} role="menu" style={{ ...menuStyle, ...position }}>
          {items.map((item) => (
            <NoteMenuButton
              key={item.label}
              item={item}
              onSelect={() => {
                setOpen(false)
                buttonRef.current?.focus({ preventScroll: true })
                item.onSelect()
              }}
            />
          ))}
        </div>,
        document.getElementById('root') ?? document.body
      )}
    </span>
  )
}

function NoteMenuButton({ item, onSelect }: { item: NoteMenuItem; onSelect: () => void }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      role="menuitem"
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...menuItemStyle(item.danger === true), background: hovered ? 'var(--slate-800)' : 'transparent' }}
    >
      {item.label}
    </button>
  )
}

function moreButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'var(--slate-800)' : 'transparent',
    border: 'none',
    borderRadius: 5,
    color: 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 800,
    lineHeight: 1,
    padding: '1px 5px'
  }
}

const menuStyle: React.CSSProperties = {
  // 詳細欄のスクロール範囲で切れないよう、画面内に配置する。
  position: 'fixed',
  zIndex: 960,
  minWidth: 120,
  maxWidth: 'calc(100vw - 16px)',
  maxHeight: 'calc(100vh - 16px)',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: 4,
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)'
}

function menuItemStyle(danger: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    borderRadius: 5,
    color: danger ? 'var(--red-300)' : 'var(--slate-300)',
    cursor: 'pointer',
    fontSize: '0.76rem',
    padding: '6px 10px',
    textAlign: 'left',
    whiteSpace: 'nowrap'
  }
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 7,
  color: 'var(--slate-200)',
  fontSize: '0.84rem',
  lineHeight: 1.55,
  outline: 'none',
  resize: 'vertical'
}

// 「返信」などの文字だけのボタン。押せる範囲は文字の周りにも広げる（高さ 1.75rem 以上）
const inlineActionStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--slate-400)',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 800,
  padding: '0.25rem 0.4rem',
  margin: '-0.25rem -0.4rem',
  minHeight: '1.75rem'
}

const ghostButtonStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid var(--slate-700)',
  background: 'var(--slate-900)',
  color: 'var(--slate-400)',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 700
}

function saveButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    borderRadius: 7,
    border: `1px solid ${enabled ? 'var(--blue-700)' : 'var(--slate-700)'}`,
    background: enabled ? 'var(--blue-600)' : 'var(--slate-800)',
    color: enabled ? 'var(--on-fill-blue-50)' : 'var(--slate-500)',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}
