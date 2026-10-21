import React, { useEffect, useState } from 'react'
import type { DesktopDownloadStat } from '../types'

/** Rendered only inside the team administrator's user management dialog. */
export function DesktopDownloadStats(): React.JSX.Element {
  const [stats, setStats] = useState<DesktopDownloadStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    window.api.desktopDownloadStats().then((rows) => {
      if (active) setStats(rows)
    }).catch(() => {
      if (active) setError(true)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [revision])

  return (
    <section aria-label="デスクトップ版の配布状況" style={{ fontSize: '0.84rem', color: 'var(--slate-300)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--slate-200)' }}>デスクトップ版の配布状況</h3>
        <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}
          style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--slate-600)', background: 'var(--slate-700)', color: 'var(--slate-200)', cursor: loading ? 'default' : 'pointer' }}>
          {error ? '再試行' : '更新'}
        </button>
      </div>
      <div aria-live="polite" style={{ marginTop: 10 }}>
        {loading ? <p>読み込み中…</p> : error ? <p role="alert">ダウンロード回数を取得できませんでした。再試行してください。</p> : stats.length === 0 ?
          <p>まだダウンロードの記録はありません。</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th scope="col" style={{ textAlign: 'left', padding: '6px 8px' }}>バージョン</th>
                <th scope="col" style={{ textAlign: 'right', padding: '6px 8px' }}>ダウンロード回数</th>
              </tr></thead>
              <tbody>{stats.map((row) => <tr key={row.version} style={{ borderTop: '1px solid var(--slate-700)' }}>
                <td style={{ padding: '6px 8px' }}>{row.version}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.downloadCount.toLocaleString('ja-JP')}回</td>
              </tr>)}</tbody>
            </table>
          )}
      </div>
      <p style={{ margin: '10px 0 0', color: 'var(--text-subtle)', fontSize: '0.76rem', lineHeight: 1.6 }}>
        計測開始後に、サーバーからファイル全体を送信できた回数です。取り直しも含みます。途中再開・送信失敗は含まず、インストール台数とは異なります。
      </p>
    </section>
  )
}
