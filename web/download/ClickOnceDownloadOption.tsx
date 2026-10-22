import React, { useEffect, useState } from 'react'
import { fetchClickOnceRelease, type ClickOnceRelease } from '@renderer/lib/clickOnceRelease'

export function ClickOnceDownloadOption(): React.JSX.Element | null {
  const [release, setRelease] = useState<ClickOnceRelease | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    void fetchClickOnceRelease(controller.signal).then((value) => {
      if (!controller.signal.aborted) setRelease(value)
    }).finally(() => clearTimeout(timeout))
    return () => { controller.abort(); clearTimeout(timeout) }
  }, [])
  return release ? <ClickOnceDownloadCard release={release} /> : null
}

export function ClickOnceDownloadCard({ release }: { release: ClickOnceRelease }): React.JSX.Element {
  return <section style={{ border: '1px solid #475569', borderRadius: 10, padding: 16, display: 'grid', gap: 10 }}>
    <h2 style={{ margin: 0, fontSize: '1rem' }}>ClickOnce 版（試験配布）</h2>
    <div>バージョン {release.version}。起動時に更新を確認する Windows 版です。</div>
    <a href={release.pageUrl} style={{ color: '#5eead4', fontWeight: 700 }}>インストールの案内を開く</a>
    <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
      初回は Edge から ClickOnce を開きます。会社のポリシーにより利用できない場合は、管理者にお問い合わせください。
      通常の exe 版を使用中の方は、案内に沿って終了してから導入してください。
    </div>
  </section>
}
