import React, { useEffect, useRef, useState } from 'react'
import type { ProgressNoteReaction } from '../types'

// 進捗ログ・返信のリアクション（進捗タブ・報告タブ・タスク詳細・概要で共通）。
// 👍 はいつも出し、ほかの絵文字は誰かが押したときだけ並べる。「＋」から 🎉 👀 🙏 も付けられる。
// ホバーで押した人の一覧を出す。

export const LIKE_EMOJI = '👍'

/** 選べるリアクション。サーバーは任意の絵文字を受け付けるが、画面ではこの4つに絞る */
export const REACTION_OPTIONS: Array<{ emoji: string; label: string }> = [
  { emoji: LIKE_EMOJI, label: 'いいね' },
  { emoji: '🎉', label: 'おめでとう' },
  { emoji: '👀', label: '見ました' },
  { emoji: '🙏', label: 'ありがとう' }
]

function reactionLabel(emoji: string): string {
  return REACTION_OPTIONS.find((option) => option.emoji === emoji)?.label ?? 'リアクション'
}

export function getLikeReaction(entity: { reactions: ProgressNoteReaction[] }): ProgressNoteReaction | undefined {
  return (entity.reactions ?? []).find((reaction) => reaction.emoji === LIKE_EMOJI)
}

/** リアクションの合計数（「まだ反応なし」の判定に使う） */
export function countReactions(entity: { reactions: ProgressNoteReaction[] }): number {
  return (entity.reactions ?? []).reduce((sum, reaction) => sum + reaction.count, 0)
}

export function ReactionBar({ reactions = [], onToggle }: {
  reactions?: ProgressNoteReaction[]
  /** 省略時は押せない表示だけになる（押した人の一覧は見られる） */
  onToggle?: (emoji: string) => void
}): React.JSX.Element | null {
  const byEmoji = new Map(reactions.map((reaction) => [reaction.emoji, reaction]))
  const known = REACTION_OPTIONS.map((option) => option.emoji)
  const shown = [
    ...known.filter((emoji) => (emoji === LIKE_EMOJI && onToggle) || (byEmoji.get(emoji)?.count ?? 0) > 0),
    // 画面にない絵文字が付いていても隠さない
    ...reactions.filter((reaction) => !known.includes(reaction.emoji) && reaction.count > 0).map((reaction) => reaction.emoji)
  ]
  if (shown.length === 0 && !onToggle) return null

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {shown.map((emoji) => (
        <ReactionChip key={emoji} emoji={emoji} reaction={byEmoji.get(emoji)} onClick={onToggle ? () => onToggle(emoji) : undefined} />
      ))}
      {onToggle && <ReactionPicker reactions={byEmoji} onPick={onToggle} />}
    </span>
  )
}

function ReactionChip({ emoji, reaction, onClick }: {
  emoji: string
  reaction?: ProgressNoteReaction
  onClick?: () => void
}): React.JSX.Element {
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const reactors = reaction?.reactors ?? []
  const count = reaction?.count ?? 0
  const label = reactionLabel(emoji)
  const active = Boolean(reaction?.reacted_by_me)

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      onFocus={() => setTooltipVisible(true)}
      onBlur={() => setTooltipVisible(false)}
    >
      <button
        onClick={onClick}
        disabled={!onClick}
        aria-pressed={onClick ? active : undefined}
        aria-label={reactors.length > 0 ? `${label}: ${reactors.map((reactor) => reactor.display_name).join('、')}` : label}
        style={chipStyle(active, Boolean(onClick), emoji === LIKE_EMOJI && count === 0)}
      >
        {emoji} {count}
      </button>
      {tooltipVisible && reactors.length > 0 && (
        <span role="tooltip" style={tooltipStyle}>
          <strong style={{ display: 'block', marginBottom: 3, color: 'var(--slate-50)' }}>{emoji} {label}</strong>
          {reactors.map((reactor, index) => (
            <span key={`${reactor.user_id ?? 'desktop'}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: reactor.color ?? 'var(--slate-500)', flexShrink: 0 }} />
              <span>{reactor.display_name}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

function ReactionPicker({ reactions, onPick }: {
  reactions: Map<string, ProgressNoteReaction>
  onPick: (emoji: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((value) => !value)}
        aria-label="リアクションを付ける"
        aria-haspopup="menu"
        aria-expanded={open}
        title="リアクションを付ける（🎉 おめでとう・👀 見ました・🙏 ありがとう）"
        style={pickerButtonStyle(open)}
      >
        ☺＋
      </button>
      {open && (
        <span role="menu" style={pickerMenuStyle}>
          {REACTION_OPTIONS.map((option) => {
            const active = Boolean(reactions.get(option.emoji)?.reacted_by_me)
            return (
              <button
                key={option.emoji}
                role="menuitemcheckbox"
                aria-checked={active}
                title={active ? `${option.label}を取り消す` : option.label}
                onClick={() => { setOpen(false); onPick(option.emoji) }}
                style={pickerItemStyle(active)}
              >
                <span style={{ fontSize: '1.05rem', lineHeight: 1 }}>{option.emoji}</span>
                <span style={{ fontSize: '0.64rem', color: active ? 'var(--blue-200)' : 'var(--slate-400)' }}>{option.label}</span>
              </button>
            )
          })}
        </span>
      )}
    </span>
  )
}

function chipStyle(active: boolean, clickable: boolean, quiet: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    background: active ? 'var(--blue-900)' : 'transparent',
    border: `1px solid ${active ? 'var(--blue-500)' : quiet ? 'transparent' : 'var(--slate-700)'}`,
    borderRadius: 999,
    color: active ? 'var(--blue-200)' : 'var(--slate-400)',
    cursor: clickable ? 'pointer' : 'default',
    fontSize: '0.72rem',
    fontWeight: 800,
    padding: quiet ? 0 : '0 6px',
    lineHeight: 1.6,
    fontVariantNumeric: 'tabular-nums'
  }
}

function pickerButtonStyle(open: boolean): React.CSSProperties {
  return {
    background: open ? 'var(--slate-800)' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 999,
    color: 'var(--text-subtle)',
    cursor: 'pointer',
    fontSize: '0.7rem',
    fontWeight: 700,
    padding: '0 5px',
    lineHeight: 1.6
  }
}

const pickerMenuStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  bottom: 'calc(100% + 6px)',
  zIndex: 30,
  display: 'flex',
  gap: 2,
  padding: 4,
  borderRadius: 10,
  border: '1px solid var(--slate-700)',
  background: 'var(--slate-900)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.38)'
}

function pickerItemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    minWidth: 52,
    padding: '5px 4px',
    borderRadius: 8,
    border: `1px solid ${active ? 'var(--blue-500)' : 'transparent'}`,
    background: active ? 'var(--blue-900)' : 'transparent',
    cursor: 'pointer',
    color: 'var(--slate-200)'
  }
}

const tooltipStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  bottom: 'calc(100% + 7px)',
  zIndex: 30,
  minWidth: 130,
  maxWidth: 240,
  maxHeight: 180,
  overflowY: 'auto',
  padding: '7px 9px',
  borderRadius: 7,
  border: '1px solid var(--slate-700)',
  background: 'var(--slate-900)',
  color: 'var(--slate-200)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.38)',
  fontSize: '0.72rem',
  lineHeight: 1.5,
  whiteSpace: 'normal'
}
