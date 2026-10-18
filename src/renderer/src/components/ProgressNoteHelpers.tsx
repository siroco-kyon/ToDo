import React from 'react'

/** 進捗ログのひな形。書き出しに迷うときの枠 */
export const PROGRESS_NOTE_TEMPLATE = 'やったこと：\n次にやること：\n困っていること：'
/** 「予定どおり」で入力欄に入れる文 */
export const ON_TRACK_NOTE = '予定どおり進んでいます。'

const TEMPLATE_HEADINGS = PROGRESS_NOTE_TEMPLATE.split('\n')

/** 投稿する前に、何も書かなかったひな形の見出し（「困っていること：」のまま次の見出しや終わりが来るもの）を外す */
export function cleanProgressNote(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (TEMPLATE_HEADINGS.includes(lines[index].trim())) {
      let next = index + 1
      while (next < lines.length && lines[next].trim() === '') next += 1
      if (next >= lines.length || TEMPLATE_HEADINGS.includes(lines[next].trim())) continue
    }
    kept.push(lines[index])
  }
  return kept.join('\n').trim()
}

/** 入力中の文にひな形を入れる（空ならそのまま、書きかけなら改行して後ろに足す） */
export function withProgressNoteTemplate(draft: string): string {
  if (draft.includes(PROGRESS_NOTE_TEMPLATE)) return draft
  return draft.trim() ? `${draft.replace(/\s+$/, '')}\n${PROGRESS_NOTE_TEMPLATE}` : PROGRESS_NOTE_TEMPLATE
}

// 進捗ログの投稿欄に置く「ひな形」「予定どおり」（詳細・報告タブ・進捗タブで共通）。
// 変化がない週でも一言で報告でき、書き出しに迷う人は枠から書き始められる。
// どちらも入力欄に文を入れるだけで、投稿は「投稿」ボタンで行う（押し間違いでチームに報告が出ないように）
export function ProgressNoteHelpers({ draft, disabled = false, showOnTrack = true, onInsertTemplate, onInsertOnTrack }: {
  draft: string
  disabled?: boolean
  showOnTrack?: boolean
  onInsertTemplate: () => void
  onInsertOnTrack: () => void
}): React.JSX.Element {
  const hasDraft = draft.trim() !== ''
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={onInsertTemplate}
        title="「やったこと／次にやること／困っていること」の枠を入れます"
        style={helperButtonStyle(disabled)}
      >
        ひな形
      </button>
      {showOnTrack && (
        <button
          type="button"
          disabled={disabled || hasDraft}
          onClick={onInsertOnTrack}
          title={hasDraft ? '書きかけの文があるときは使えません' : `「${ON_TRACK_NOTE}」を入力欄に入れます（「投稿」で送ります）`}
          style={helperButtonStyle(disabled || hasDraft)}
        >
          予定どおり
        </button>
      )}
    </div>
  )
}

function helperButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid var(--slate-700)',
    background: 'transparent',
    color: disabled ? 'var(--slate-500)' : 'var(--slate-300)',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: '0.75rem',
    fontWeight: 600,
    whiteSpace: 'nowrap'
  }
}
