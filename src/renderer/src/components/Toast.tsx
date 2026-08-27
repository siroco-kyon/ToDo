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
    const timer = setTimeout(() => onRemove(toast.id), toast.type === 'error' ? 10000 : 4500)
    return () => clearTimeout(timer)
  }, [toast.id, onRemove])

  return (
    <div role={toast.type === 'error' ? 'alert' : 'status'} style={{
      padding: '10px 16px',
      background: toast.type === 'success' ? '#166534' : '#7f1d1d',
      border: `1px solid ${toast.type === 'success' ? '#4ade80' : '#ef4444'}`,
      borderRadius: 8, color: '#fff', fontSize: '0.9rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      pointerEvents: 'auto', userSelect: 'none'
    }}>
      <span>{toast.type === 'success' ? '✓ ' : '✗ '}{toast.message}</span>
      {toast.actionLabel && toast.onAction && <button onClick={() => { toast.onAction?.(); onRemove(toast.id) }} style={{ marginLeft: 12, border: '1px solid rgba(255,255,255,.65)', borderRadius: 6, background: 'transparent', color: '#fff', cursor: 'pointer', padding: '3px 7px' }}>{toast.actionLabel}</button>}
      <button onClick={() => onRemove(toast.id)} aria-label="通知を閉じる" style={{ marginLeft: 12, border: 0, background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: '1rem' }}>×</button>
    </div>
  )
}
