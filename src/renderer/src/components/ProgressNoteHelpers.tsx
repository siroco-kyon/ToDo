import React from 'react'

/** 進捗ログのひな形。書き出しに迷うときの枠 */
export const PROGRESS_NOTE_TEMPLATE = 'やったこと：\n次にやること：\n困っていること：'
/** 「予定どおり」で投稿する文 */
export const ON_TRACK_NOTE = '予定どおり進んでいます。'

/** 入力中の文にひな形を入れる（空ならそのまま、書きかけなら改行して後ろに足す） */
export function withProgressNoteTemplate(draft: string): string {
  if (draft.includes(PROGRESS_NOTE_TEMPLATE)) return draft
  return draft.trim() ? `${draft.replace(/\s+$/, '')}\n${PROGRESS_NOTE_TEMPLATE}` : PROGRESS_NOTE_TEMPLATE
}

// 進捗ログの投稿欄に置く「ひな形」「予定どおり」（詳細・報告タブ・進捗タブで共通）。
// 変化がない週でも一言で報告でき、書き出しに迷う人は枠から書き始められる
export function ProgressNoteHelpers({ draft, disabled = false, onInsertTemplate, onPostOnTrack }: {
  draft: string
  disabled?: boolean
  onInsertTemplate: () => void
  onPostOnTrack: () => void
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
      <button
        type="button"
        disabled={disabled || hasDraft}
        onClick={onPostOnTrack}
        title={hasDraft ? '書きかけの文があるときは使えません' : `「${ON_TRACK_NOTE}」をそのまま投稿します`}
        style={helperButtonStyle(disabled || hasDraft)}
      >
        予定どおり
      </button>
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
