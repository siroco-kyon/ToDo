import React, { useEffect, useRef, useState } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { registerConfirmHost, type ConfirmRequest } from '../lib/confirm'

// 確かめの小窓（削除・未保存の変更を捨てるときなど）。ブラウザ標準の confirm() と違い、アプリの見た目・テーマに合わせ、
// キーボードで操作できる（開くと安全な方＝やめるにフォーカス。Enter で選んでいるボタン、Esc でやめる）
export function ConfirmHost(): React.JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  useEffect(() => registerConfirmHost((next) => setRequest(next)), [])
  if (!request) return null
  return <ConfirmDialog key={request.id} request={request} onDone={() => setRequest(null)} />
}

function ConfirmDialog({ request, onDone }: { request: ConfirmRequest; onDone: () => void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const answer = (value: boolean): void => {
    onDone()
    request.resolve(value)
  }
  const [title, ...rest] = request.message.split('\n')
  return (
    <div
      onMouseDown={(event) => { if (event.target === event.currentTarget) answer(false) }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'color-mix(in srgb, var(--slate-950) 55%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`confirm-title-${request.id}`}
        aria-describedby={rest.length > 0 ? `confirm-body-${request.id}` : undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          answer(false)
        }}
        style={{ width: 'min(440px, 100%)', background: 'var(--slate-900)', border: '1px solid var(--slate-700)', borderRadius: 12, boxShadow: '0 24px 60px color-mix(in srgb, var(--slate-950) 60%, transparent)', padding: '18px 20px 16px' }}
      >
        <div id={`confirm-title-${request.id}`} style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--slate-100)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{title}</div>
        {rest.length > 0 && (
          <div id={`confirm-body-${request.id}`} style={{ marginTop: 6, fontSize: 'var(--font-control)', color: 'var(--slate-300)', lineHeight: 1.6 }}>
            {rest.map((line, index) => <div key={index}>{line}</div>)}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            autoFocus
            onClick={() => answer(false)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--slate-600)', background: 'var(--slate-800)', color: 'var(--slate-200)', cursor: 'pointer', fontSize: 'var(--font-control)', fontWeight: 700 }}
          >
            {request.cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => answer(true)}
            style={{
              padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--font-control)', fontWeight: 700,
              background: request.danger ? 'var(--red-600)' : 'var(--blue-600)', color: 'var(--on-fill-white)'
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
