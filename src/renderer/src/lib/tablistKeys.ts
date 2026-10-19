import type React from 'react'

// role="tablist" の中を ← → Home End で移る（タブは Tab では1回だけ止まる。WAI-ARIA のタブの作り）。
// activate が true なら移った先のタブをそのまま選ぶ（設定の分類など、切り替えが軽いとき）。
// false なら移るだけで、Enter・Space で選ぶ（画面の切り替えなど、選ぶと重い処理や確認が出るとき）
export function handleTablistKeyDown(event: React.KeyboardEvent<HTMLElement>, activate = false): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
    .filter((tab) => tab.getClientRects().length > 0 && !tab.hasAttribute('disabled'))
  if (tabs.length === 0) return
  event.preventDefault()
  const current = tabs.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (current + 1) % tabs.length
        : (current - 1 + tabs.length) % tabs.length
  tabs[next].focus()
  if (activate) tabs[next].click()
}

/** タブの tabIndex。選ばれているタブ（どれも選ばれていなければ先頭）だけを Tab で止める */
export function tabStopIndex(active: boolean, index: number, anyActive: boolean): 0 | -1 {
  return active || (!anyActive && index === 0) ? 0 : -1
}
