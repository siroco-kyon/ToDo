import React, { useEffect } from 'react'

export interface ToastMessage {
  id: number
  message: string
  type: 'success' | 'error'
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
    }}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onRemove }: { toast: ToastMessage; onRemove: (id: number) => void }): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onRemove(toast.id), 3000)
    return () => clearTimeout(timer)
  }, [toast.id, onRemove])

  return (
    <div style={{
      padding: '10px 16px',
      background: toast.type === 'success' ? '#166534' : '#7f1d1d',
      border: `1px solid ${toast.type === 'success' ? '#4ade80' : '#ef4444'}`,
      borderRadius: 8, color: '#fff', fontSize: '0.9rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      pointerEvents: 'auto', userSelect: 'none'
    }}>
      {toast.type === 'success' ? '✓ ' : '✗ '}{toast.message}
    </div>
  )
}
