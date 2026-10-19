import React, { useEffect, useRef, useState } from 'react'

export interface ToastMessage {
  id: number
  message: string
  type: 'success' | 'error'
  actionLabel?: string
  onAction?: () => void
}

interface Props {
  toasts: ToastMessage[]
  onRemove: (id: number) => void
}

export function Toast({ toasts, onRemove }: Props): React.JSX.Element {
  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20,
      display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999,
      pointerEvents: 'none'
    }} aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onRemove }: { toast: ToastMessage; onRemove: (id: number) => void }): React.JSX.Element {
  // マウスを乗せている・フォーカスがあるあいだは消さない（「元に戻す」を押す前に消えないように）
  const [held, setHeld] = useState(false)
  // キーボードで知らせに入る前にいた場所。押して知らせが消えたら、そこへ戻す（ページの先頭に飛ばないように）
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const removeAndReturn = (): void => {
    const target = returnFocusRef.current
    onRemove(toast.id)
    window.setTimeout(() => {
      if (target && target.isConnected) target.focus({ preventScroll: true })
      else document.getElementById('hakobi-main')?.focus({ preventScroll: true })
    }, 0)
  }
  useEffect(() => {
    if (held) return
    // 操作ボタン付きは押す時間が要るので長めに出す
    const timer = setTimeout(() => onRemove(toast.id), toast.type === 'error' ? 12000 : toast.actionLabel ? 12000 : 5000)
    return () => clearTimeout(timer)
  }, [held, toast.id, toast.actionLabel, toast.type, onRemove])

  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={(event) => {
        setHeld(true)
        const from = event.relatedTarget
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) returnFocusRef.current = from
      }}
      onBlur={() => setHeld(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        removeAndReturn()
      }}
      style={{
      padding: '10px 16px',
      background: toast.type === 'success' ? 'var(--green-800)' : 'var(--red-900)',
      border: `1px solid ${toast.type === 'success' ? 'var(--green-400)' : 'var(--red-500)'}`,
      borderRadius: 8, color: 'var(--white)', fontSize: '0.9rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      pointerEvents: 'auto', userSelect: 'none'
    }}>
      <span>{toast.type === 'success' ? '✓ ' : '✗ '}{toast.message}</span>
      {toast.actionLabel && toast.onAction && <button onClick={() => { toast.onAction?.(); removeAndReturn() }} style={{ marginLeft: 12, border: '1px solid rgba(255,255,255,.65)', borderRadius: 6, background: 'transparent', color: 'var(--white)', cursor: 'pointer', padding: '3px 7px' }}>{toast.actionLabel}</button>}
      <button onClick={removeAndReturn} aria-label="この知らせを閉じる" style={{ marginLeft: 12, border: 0, background: 'transparent', color: 'var(--white)', cursor: 'pointer', fontSize: '1rem' }}>×</button>
    </div>
  )
}
