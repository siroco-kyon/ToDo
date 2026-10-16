import React, { useEffect } from 'react'

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
  useEffect(() => {
    // 操作ボタン付きは押す時間が要るので長めに出す
    const timer = setTimeout(() => onRemove(toast.id), toast.type === 'error' ? 10000 : toast.actionLabel ? 8000 : 4500)
    return () => clearTimeout(timer)
  }, [toast.id, toast.actionLabel, toast.type, onRemove])

  return (
    <div role={toast.type === 'error' ? 'alert' : 'status'} style={{
      padding: '10px 16px',
      background: toast.type === 'success' ? 'var(--green-800)' : 'var(--red-900)',
      border: `1px solid ${toast.type === 'success' ? 'var(--green-400)' : 'var(--red-500)'}`,
      borderRadius: 8, color: 'var(--white)', fontSize: '0.9rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      pointerEvents: 'auto', userSelect: 'none'
    }}>
      <span>{toast.type === 'success' ? '✓ ' : '✗ '}{toast.message}</span>
      {toast.actionLabel && toast.onAction && <button onClick={() => { toast.onAction?.(); onRemove(toast.id) }} style={{ marginLeft: 12, border: '1px solid rgba(255,255,255,.65)', borderRadius: 6, background: 'transparent', color: 'var(--white)', cursor: 'pointer', padding: '3px 7px' }}>{toast.actionLabel}</button>}
      <button onClick={() => onRemove(toast.id)} aria-label="通知を閉じる" style={{ marginLeft: 12, border: 0, background: 'transparent', color: 'var(--white)', cursor: 'pointer', fontSize: '1rem' }}>×</button>
    </div>
  )
}
