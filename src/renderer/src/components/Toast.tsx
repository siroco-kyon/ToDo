import React, { useEffect, useRef, useState } from 'react'

export interface ToastMessage {
  id: number
  message: string
  /** info は、操作の結果ではない案内（パネルを自動で畳んだことなど）。控えめな色で出す */
  type: 'success' | 'error' | 'info'
  actionLabel?: string
  onAction?: () => void
  /** 同じ key の知らせは新しいもので置き換える */
  key?: string
}

interface Props {
  toasts: ToastMessage[]
  onRemove: (id: number) => void
}

export function Toast({ toasts, onRemove }: Props): React.JSX.Element {
  // 知らせは右下に出す。右に詳細などのパネルが開いているときは、そのパネルの左に出す（変えた結果を確かめたい所を隠さないように）。
  // 操作中の部品（フォーカスのある進捗バーなど）が知らせの位置にあって隠れるときは、上に出す
  const [placeTop, setPlaceTop] = useState(false)
  const [rightOffset, setRightOffset] = useState(20)
  useEffect(() => {
    if (toasts.length === 0) return
    const update = (): void => {
      const sidePanel = document.getElementById('hakobi-side-panel')
      const sideWidth = sidePanel && sidePanel.getClientRects().length > 0 ? sidePanel.getBoundingClientRect().width : 0
      // パネルの左に出すと狭すぎる（知らせが 280px 入らない）ときは、これまでどおり右下に出す
      const offset = sideWidth > 0 && window.innerWidth - sideWidth - 40 >= 280 ? sideWidth + 20 : 20
      setRightOffset(offset)
      const toastTop = window.innerHeight - 20 - toasts.length * 64
      const toastRight = window.innerWidth - offset
      const toastLeft = toastRight - 460
      const covers = (element: Element): boolean => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.bottom > toastTop && rect.right > toastLeft && rect.left < toastRight
      }
      // 開いているメニュー・候補の一覧も隠さない（進捗ログの「⋯」のメニューなど）
      const popupCovered = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).some((element) => !element.closest('[data-toast]') && covers(element))
      const active = document.activeElement
      const activeCovered = active instanceof HTMLElement && active !== document.body && !active.closest('[data-toast]') && covers(active)
      setPlaceTop(popupCovered || activeCovered)
    }
    update()
    // メニューが開いた・閉じたことは DOM の変化で拾う（知らせが出ているあいだだけ見る）。
    // 描き直しを待たずにすぐ確かめる（メニューを押す前に知らせが動いているように）
    let pending = false
    const observer = new MutationObserver(() => {
      if (pending) return
      pending = true
      queueMicrotask(() => { pending = false; update() })
    })
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('focusin', update)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', update)
      window.removeEventListener('resize', update)
    }
  }, [toasts.length])
  return (
    <div style={{
      position: 'fixed', ...(placeTop ? { top: 72 } : { bottom: 20 }), right: rightOffset,
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
      data-toast
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
      // 長い文は折り返す（横に長く伸びて、画面の中ほどのメニューやボタンを覆わないように）
      maxWidth: 'min(28rem, calc(100vw - 40px))',
      boxSizing: 'border-box',
      background: toast.type === 'success' ? 'var(--green-800)' : toast.type === 'info' ? 'var(--slate-800)' : 'var(--red-900)',
      border: `1px solid ${toast.type === 'success' ? 'var(--green-400)' : toast.type === 'info' ? 'var(--slate-600)' : 'var(--red-500)'}`,
      // 案内（info）は灰色の地なので、文字もテーマに合わせる（ライトでは濃い文字）
      borderRadius: 8, color: toast.type === 'info' ? 'var(--slate-100)' : 'var(--white)', fontSize: '0.9rem',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      pointerEvents: 'auto', userSelect: 'none'
    }}>
      <span>{toast.type === 'success' ? '✓ ' : toast.type === 'info' ? 'ⓘ ' : '✗ '}{toast.message}</span>
      {toast.actionLabel && toast.onAction && <button onClick={() => { toast.onAction?.(); removeAndReturn() }} style={{ marginLeft: 12, border: '1px solid currentColor', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '3px 7px' }}>{toast.actionLabel}</button>}
      <button onClick={removeAndReturn} aria-label="この知らせを閉じる" style={{ marginLeft: 8, minWidth: '1.75rem', minHeight: '1.75rem', border: 0, borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '1rem' }}>×</button>
    </div>
  )
}
