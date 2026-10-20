import React from 'react'

// 左のタスク一覧の絞り込み（担当・カテゴリ・検索）が、ガントやカンバンなどにも効いていることを知らせる小さな表示。
// 1行を取らないよう、各画面の見出しの横に置く。× でその条件だけ外せる。

export interface ListFilterChip {
  key: string
  label: string
  clear: () => void
}

export function ListFilterChips({ chips }: { chips: ListFilterChip[] }): React.JSX.Element | null {
  if (chips.length === 0) return null
  return (
    <span
      role="group"
      aria-label="タスク一覧の絞り込み"
      title="左のタスク一覧の絞り込みを、この画面にも反映しています"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}
    >
      <span style={{ fontSize: '0.68rem', color: 'var(--text-subtle)', whiteSpace: 'nowrap' }}>絞り込み中</span>
      {chips.map((chip) => (
        <button key={chip.key} onClick={chip.clear} title={`${chip.label} の絞り込みを解除`} aria-label={`${chip.label} の絞り込みを解除`} style={chipStyle}>
          {chip.label} <span aria-hidden="true">×</span>
        </button>
      ))}
      {chips.length > 1 && (
        <button onClick={() => chips.forEach((chip) => chip.clear())} style={clearAllStyle}>すべて解除</button>
      )}
    </span>
  )
}

const chipStyle: React.CSSProperties = {
  minHeight: 26,
  maxWidth: 220,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid var(--indigo-600)',
  background: 'var(--indigo-950)',
  color: 'var(--indigo-200)',
  cursor: 'pointer',
  fontSize: '0.68rem',
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const clearAllStyle: React.CSSProperties = {
  minHeight: 26,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid var(--slate-700)',
  background: 'transparent',
  color: 'var(--slate-400)',
  cursor: 'pointer',
  fontSize: '0.68rem',
  whiteSpace: 'nowrap'
}
