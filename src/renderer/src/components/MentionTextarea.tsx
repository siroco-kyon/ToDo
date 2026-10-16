import React, { useMemo, useRef, useState } from 'react'
import type { PublicUser } from '../types'
import { MENTION_BEFORE } from '../lib/progressActivity'

// 「@」を打つとメンバーの候補を出す入力欄（進捗ログ・返信の入力で共通）。
// 選ぶと「@表示名 」を差し込む。サーバーは本文中の「@表示名」「@ユーザー名」でメンション通知を送る。
// 候補は「@」がメールアドレスの一部でないときだけ出す（サーバーの判定と同じ。「。@」でも出る）。
// 日本語変換中のキー操作には手を出さない。

type TextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>

interface Props extends TextareaProps {
  value: string
  onValueChange: (value: string) => void
  /** 候補に出すメンバー（無効なメンバーは出さない）。空なら普通の入力欄 */
  users?: PublicUser[]
}

interface MentionQuery {
  /** 「@」の位置 */
  start: number
  query: string
}

const MAX_CANDIDATES = 6

function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret)
  const match = new RegExp(`${MENTION_BEFORE}@([^\\s@]*)$`, 'u').exec(before)
  if (!match) return null
  return { start: caret - match[1].length - 1, query: match[1] }
}

export function MentionTextarea({ value, onValueChange, users = [], onKeyDown, onBlur, style, ...rest }: Props): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const candidates = useMemo(() => {
    if (!mention) return []
    const query = mention.query.toLowerCase()
    const active = users.filter((user) => user.is_active === 1)
    const score = (user: PublicUser): number => {
      const name = user.display_name.toLowerCase()
      const username = user.username.toLowerCase()
      if (!query) return 1
      if (name.startsWith(query) || username.startsWith(query)) return 3
      if (name.includes(query) || username.includes(query)) return 2
      return 0
    }
    return active
      .map((user) => ({ user, score: score(user) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES)
      .map((item) => item.user)
  }, [mention, users])

  const open = mention !== null && candidates.length > 0

  const refreshMention = (element: HTMLTextAreaElement): void => {
    if (users.length === 0) return
    const next = findMentionQuery(element.value, element.selectionStart ?? element.value.length)
    setMention(next)
    if (next?.query !== mention?.query) setActiveIndex(0)
  }

  const insert = (user: PublicUser): void => {
    const element = textareaRef.current
    if (!element || !mention) return
    const caret = element.selectionStart ?? value.length
    const inserted = `@${user.display_name} `
    const next = value.slice(0, mention.start) + inserted + value.slice(caret)
    onValueChange(next)
    setMention(null)
    const position = mention.start + inserted.length
    window.requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(position, position)
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((index) => (index + delta + candidates.length) % candidates.length)
        return
      }
      if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        insert(candidates[Math.min(activeIndex, candidates.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        // 候補だけ閉じる（入力欄自体のキャンセルは次の Esc で）
        event.preventDefault()
        event.stopPropagation()
        setMention(null)
        return
      }
    }
    onKeyDown?.(event)
  }

  return (
    <span style={{ position: 'relative', display: 'block', width: style?.width ?? '100%', flex: style?.flex, minWidth: 0 }}>
      <textarea
        {...rest}
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
          refreshMention(event.target)
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') refreshMention(event.currentTarget)
        }}
        onClick={(event) => refreshMention(event.currentTarget)}
        onBlur={(event) => {
          setMention(null)
          onBlur?.(event)
        }}
        aria-autocomplete={users.length > 0 ? 'list' : undefined}
        aria-expanded={users.length > 0 ? open : undefined}
        style={{ ...style, width: '100%', flex: undefined }}
      />
      {open && (
        <span role="listbox" aria-label="メンションする人" style={listStyle}>
          <span style={{ display: 'block', padding: '3px 8px 4px', fontSize: '0.64rem', color: 'var(--slate-500)' }}>
            メンションすると相手に通知が届きます（↑↓で選んで Enter）
          </span>
          {candidates.map((user, index) => (
            <span
              key={user.id}
              role="option"
              aria-selected={index === activeIndex}
              // 入力欄のフォーカスを外さずに選べるよう、押した時点で確定する
              onMouseDown={(event) => { event.preventDefault(); insert(user) }}
              onMouseEnter={() => setActiveIndex(index)}
              style={optionStyle(index === activeIndex)}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 700, color: 'var(--slate-200)' }}>{user.display_name}</span>
              <span style={{ color: 'var(--slate-500)', fontSize: '0.7rem' }}>@{user.username}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

const listStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 'calc(100% + 4px)',
  zIndex: 40,
  minWidth: 220,
  maxWidth: '100%',
  padding: 4,
  borderRadius: 10,
  border: '1px solid var(--slate-700)',
  background: 'var(--slate-900)',
  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.45)',
  display: 'flex',
  flexDirection: 'column'
}

function optionStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 8px',
    borderRadius: 7,
    cursor: 'pointer',
    background: active ? 'var(--blue-900)' : 'transparent',
    fontSize: '0.8rem'
  }
}
