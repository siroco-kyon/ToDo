// テキストをクリップボードへコピーする。
// サーバー版は社内LANの http:// で動くことがあり、その場合 navigator.clipboard が
// 使えない（secure context 限定）ため、textarea + execCommand のフォールバックを持つ。
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 権限ポリシー等で拒否されることがあるためフォールバックへ
    }
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try {
    if (!document.execCommand('copy')) throw new Error('コピーできませんでした')
  } finally {
    ta.remove()
  }
}
