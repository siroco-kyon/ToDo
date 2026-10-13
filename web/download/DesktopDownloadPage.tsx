import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  DESKTOP_DOWNLOAD_FILE_URL,
  fetchDesktopRelease,
  formatBytes,
  isLoopbackOrigin,
  type DesktopReleaseStatus
} from '@renderer/lib/desktopRelease'

export type DownloadPhase =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; status: DesktopReleaseStatus }

const REQUEST_TIMEOUT_MS = 10000

function formatReleaseDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Public page (no sign-in) where members get the Windows installer offered by this team server. */
export function DesktopDownloadPage(): React.JSX.Element {
  const [phase, setPhase] = useState<DownloadPhase>({ kind: 'loading' })
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)
    setPhase({ kind: 'loading' })
    void fetchDesktopRelease(controller.signal).then((status) => {
      if (controllerRef.current !== controller) return
      if (controller.signal.aborted && !timedOut) return
      setPhase(status ? { kind: 'ready', status } : { kind: 'error' })
    }).finally(() => {
      clearTimeout(timeout)
      if (controllerRef.current === controller) controllerRef.current = null
    })
  }, [])

  useEffect(() => {
    document.title = 'HAKOBI デスクトップ版のダウンロード'
    load()
    return () => {
      const controller = controllerRef.current
      controllerRef.current = null
      controller?.abort()
    }
  }, [load])

  return <DesktopDownloadView phase={phase} origin={window.location.origin} onRetry={load} />
}

export function DesktopDownloadView({ phase, origin, onRetry }: {
  phase: DownloadPhase
  origin: string
  onRetry?: () => void
}): React.JSX.Element {
  const release = phase.kind === 'ready' ? phase.status.release : null
  const releaseDate = formatReleaseDate(release?.releaseDate ?? null)
  return (
    <div style={styles.screen}>
      <main style={styles.card}>
        <div style={styles.brand}>
          <svg width="44" height="44" viewBox="0 0 128 128" aria-hidden>
            <rect x="9" y="9" width="110" height="110" rx="23" fill="#0f172a" />
            <rect x="28" y="35" width="51" height="15" rx="4.5" fill="#2dd4bf" />
            <rect x="42" y="56" width="56" height="15" rx="4.5" fill="#5eead4" />
            <rect x="56" y="78" width="35" height="15" rx="4.5" fill="#fbbf24" />
          </svg>
          <div>
            <h1 style={styles.title}>HAKOBI デスクトップ版（Windows）</h1>
            <div style={styles.subtitle}>右下タイマー・デスクトップ通知・タスクトレイが使えるアプリです。</div>
          </div>
        </div>

        {phase.kind === 'loading' && <div style={styles.message} role="status">確認しています…</div>}

        {phase.kind === 'error' && <>
          <div style={styles.error} role="alert">サーバーからバージョン情報を取得できませんでした。</div>
          {onRetry && <button type="button" onClick={onRetry} style={styles.secondary}>再試行</button>}
        </>}

        {phase.kind === 'ready' && !release && <>
          <div style={styles.message} role="status">現在ダウンロードできるインストーラーはありません。管理者にお問い合わせください。</div>
          {/* The server includes the reason only for administrators. */}
          {phase.status.reason && <div style={styles.adminNote}>管理者向けの情報: {phase.status.reason}</div>}
        </>}

        {release && <>
          <dl style={styles.facts}>
            <dt style={styles.term}>バージョン</dt>
            <dd style={styles.value}>{release.version}</dd>
            <dt style={styles.term}>サイズ</dt>
            <dd style={styles.value}>{formatBytes(release.size)}</dd>
            {releaseDate && <>
              <dt style={styles.term}>公開日</dt>
              <dd style={styles.value}>{releaseDate}</dd>
            </>}
            <dt style={styles.term}>SHA-256</dt>
            <dd style={styles.value}>
              <code style={styles.code}>{release.sha256}</code>
              <div style={styles.note}>PowerShell の Get-FileHash で照合できます。</div>
            </dd>
            <dt style={styles.term}>接続先URL</dt>
            <dd style={styles.value}>
              <code style={styles.code}>{origin}</code>
              <div style={styles.note}>初めて起動したときの接続設定で、このURLを入力します。</div>
              {isLoopbackOrigin(origin) && <div style={styles.note}>
                このPC（サーバー）用のURLです。ほかのPCでは http://&lt;サーバーのIPアドレス&gt;:{new URL(origin).port || '80'} を入力し、このページも同じアドレスで開いてください。
              </div>}
            </dd>
          </dl>

          <a href={DESKTOP_DOWNLOAD_FILE_URL} download style={styles.button}>ダウンロード（{release.version}）</a>

          <section>
            <h2 style={styles.heading}>インストールの手順</h2>
            <ol style={styles.steps}>
              <li style={styles.step}>
                <b>Chrome の場合</b>: 「安全でないダウンロードがブロックされました」と表示されたら、ダウンロード一覧を開いて「保存」を選びます。
                社内サーバーが http:// で動いているため表示されます。
              </li>
              <li style={styles.step}>
                <b>Edge の場合</b>: 同じくブロックされたら「…」→「保存」を選びます。
                続けて「一般的にダウンロードされていません」と表示されたら、「…」（または「詳細表示」）→「保持する」を選びます。
              </li>
              <li style={styles.step}>
                ダウンロードしたファイルを開くと「Windows によって PC が保護されました」と表示されます。
                「詳細情報」を押し、アプリ: {release.fileName}、発行元: 不明な発行元 であることを確かめて「実行」を押します。
                インストーラーに署名がないため、新しいバージョンのたびに表示されます。
              </li>
              <li style={styles.step}>
                HAKOBI を起動したままだと「HAKOBI が起動しています。OKをクリックして、閉じてください。」と表示されます。
                OK を押すと続行します（先にタスクトレイの「HAKOBIを終了」で終了しておくと確実です）。
              </li>
              <li style={styles.step}>
                管理者権限は不要です（このユーザーだけにインストールされます）。データと接続設定はそのまま引き継がれます。
              </li>
              <li style={styles.step}>
                スマート アプリ コントロールが有効な PC では、署名のないインストーラーはブロックされてインストールできません。管理者に相談してください。
              </li>
            </ol>
          </section>
        </>}

        <a href="/" style={styles.link}>Web版に戻る</a>
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  // The page body does not scroll, so this screen scrolls by itself on small windows.
  screen: {
    height: '100%',
    overflowY: 'auto',
    display: 'flex',
    background: 'radial-gradient(circle at 30% 20%, #1e293b 0%, #0f172a 55%, #020617 100%)',
    padding: 24,
    boxSizing: 'border-box'
  },
  card: {
    width: '100%',
    maxWidth: 560,
    margin: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 32,
    borderRadius: 18,
    border: '1px solid #1e293b',
    background: '#0b1220',
    boxShadow: '0 24px 60px rgba(2, 6, 23, 0.6)',
    boxSizing: 'border-box'
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 },
  title: { fontSize: '1.15rem', fontWeight: 750, color: '#f1f5f9', letterSpacing: '0.04em' },
  subtitle: { fontSize: '0.82rem', color: '#94a3b8', marginTop: 4, lineHeight: 1.5 },
  message: { fontSize: '0.9rem', color: '#cbd5e1', lineHeight: 1.7 },
  adminNote: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #78350f',
    background: '#1c1408',
    color: '#fcd34d',
    fontSize: '0.8rem',
    lineHeight: 1.6,
    overflowWrap: 'anywhere'
  },
  error: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #7f1d1d',
    background: '#450a0a',
    color: '#fecaca',
    fontSize: '0.85rem'
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: 16,
    rowGap: 10,
    margin: 0,
    fontSize: '0.85rem'
  },
  term: { color: '#94a3b8', fontWeight: 600 },
  value: { margin: 0, color: '#e2e8f0', minWidth: 0 },
  code: {
    display: 'block',
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid #1e293b',
    background: '#0f172a',
    color: '#cbd5e1',
    fontFamily: 'Consolas, Menlo, Monaco, monospace',
    fontSize: '0.78rem',
    userSelect: 'all',
    wordBreak: 'break-all'
  },
  note: { fontSize: '0.74rem', color: '#64748b', marginTop: 4, lineHeight: 1.5 },
  button: {
    display: 'block',
    padding: '11px 12px',
    borderRadius: 10,
    background: '#2dd4bf',
    color: '#0f172a',
    fontSize: '0.95rem',
    fontWeight: 700,
    textAlign: 'center',
    textDecoration: 'none'
  },
  secondary: {
    padding: '9px 18px',
    borderRadius: 10,
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    fontSize: '0.9rem',
    cursor: 'pointer',
    alignSelf: 'flex-start'
  },
  heading: { fontSize: '0.9rem', color: '#e2e8f0', fontWeight: 700, marginBottom: 8 },
  steps: { paddingLeft: '1.4em', display: 'flex', flexDirection: 'column', gap: 8 },
  step: { fontSize: '0.82rem', color: '#cbd5e1', lineHeight: 1.7 },
  link: { fontSize: '0.8rem', color: '#5eead4', marginTop: 4 }
}
