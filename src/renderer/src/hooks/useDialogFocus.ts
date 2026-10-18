import { useEffect, useState, type RefObject } from 'react'

// 小窓（role="dialog"）のキーボード操作をそろえる。
// - 開いたら中へフォーカスを移す（autoFocus の欄があればそれを使う）
// - Tab・Shift+Tab は小窓の中を回る（後ろの画面へ出ない）
// - 閉じたら（部品が消えたら）、開く前にフォーカスがあった場所へ戻す

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

// 小窓が重なったとき（ユーザー管理の中の削除の確認など）は、いちばん上の小窓だけが Tab を受け持つ
const openDialogs: HTMLElement[] = []

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => element.getClientRects().length > 0)
}

export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  // 描画より前（autoFocus が効く前）のフォーカスを覚えておく
  const [opener] = useState<HTMLElement | null>(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    openDialogs.push(dialog)
    if (!dialog.contains(document.activeElement)) {
      const first = focusableIn(dialog)[0]
      if (first) first.focus()
      else {
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
        dialog.focus()
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || openDialogs[openDialogs.length - 1] !== dialog) return
      const items = focusableIn(dialog)
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      const index = openDialogs.lastIndexOf(dialog)
      if (index >= 0) openDialogs.splice(index, 1)
      // 戻す先がまだ画面にあれば戻す（消えていたら、ブラウザに任せる）
      if (opener && opener.isConnected && !dialog.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [opener, ref])
}
