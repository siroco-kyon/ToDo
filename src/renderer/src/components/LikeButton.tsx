import React, { useState } from 'react'
import type { ProgressNoteReaction } from '../types'

// 進捗ログ・コメントの「いいね」ボタン。ホバーで押した人の一覧を出す（進捗タブ・報告タブ・概要で共通）

export const LIKE_EMOJI = '👍'

export function getLikeReaction(entity: { reactions: ProgressNoteReaction[] }): ProgressNoteReaction | undefined {
  return (entity.reactions ?? []).find((reaction) => reaction.emoji === LIKE_EMOJI)
}

export function LikeButton({ reaction, onClick }: {
  reaction?: ProgressNoteReaction
  /** 省略時は押せない表示だけのボタンになる（押した人の一覧は見られる） */
  onClick?: () => void
}): React.JSX.Element | null {
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const reactors = reaction?.reactors ?? []
  const count = reaction?.count ?? 0
  // 表示だけのときは、誰も押していなければ何も出さない
  if (!onClick && count === 0) return null

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
        style={likeButtonStyle(Boolean(reaction?.reacted_by_me), Boolean(onClick))}
        aria-label={reactors.length > 0 ? `いいね: ${reactors.map((reactor) => reactor.display_name).join('、')}` : 'いいね'}
      >
        {LIKE_EMOJI} {count}
      </button>
      {tooltipVisible && reactors.length > 0 && (
        <span
          role="tooltip"
          style={{
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
            border: '1px solid #334155',
            background: '#0f172a',
            color: '#e2e8f0',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.38)',
            fontSize: '0.72rem',
            lineHeight: 1.5,
            whiteSpace: 'normal'
          }}
        >
          <strong style={{ display: 'block', marginBottom: 3, color: '#f8fafc' }}>いいねした人</strong>
          {reactors.map((reactor, index) => (
            <span key={`${reactor.user_id ?? 'desktop'}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: reactor.color ?? '#64748b', flexShrink: 0 }} />
              <span>{reactor.display_name}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

function likeButtonStyle(active: boolean, clickable: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    color: active ? '#60a5fa' : '#94a3b8',
    cursor: clickable ? 'pointer' : 'default',
    fontSize: '0.72rem',
    fontWeight: 800,
    padding: 0
  }
}
