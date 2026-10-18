import React, { Suspense } from 'react'

interface State {
  error: Error | null
}

// サーバーの画面が更新されると、開いたままの古い画面からは分けて置いたファイルを読めなくなる
function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(error.message)
}

interface BoundaryProps {
  children: React.ReactNode
  /** 小窓のときは、画面の下に浮かべて「閉じる」を出す（閉じると小窓ごと閉じる） */
  onDismiss?: () => void
}

// 1つの画面が表示できなくても、アプリ全体は止めない（上部のタブやタスク一覧はそのまま使える）
class ViewErrorBoundary extends React.Component<BoundaryProps, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[view] 画面を表示できませんでした', error, errorInfo)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const updated = isChunkLoadError(error)
    const { onDismiss } = this.props
    const placement: React.CSSProperties = onDismiss
      ? { position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1200, width: 'min(440px, calc(100vw - 32px))', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)' }
      : { margin: 24 }
    return (
      <div role="alert" style={{ ...placement, padding: 16, border: '1px solid var(--amber-700)', borderRadius: 10, background: 'var(--c-1c1408)', color: 'var(--amber-200)', fontSize: '0.85rem', lineHeight: 1.6, boxSizing: 'border-box' }}>
        <strong>{updated ? 'アプリが更新されました' : 'この画面を表示できませんでした'}</strong>
        <div style={{ marginTop: 4, color: 'var(--amber-300)' }}>
          {updated ? '新しい版を読み込むため、再読み込みしてください。' : '再読み込みすると直ることがあります。'}
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--amber-700)', background: 'var(--amber-900)', color: 'var(--white)', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            再読み込み
          </button>
          {onDismiss && (
            <button
              onClick={onDismiss}
              style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--slate-600)', background: 'transparent', color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.8rem' }}
            >
              閉じる
            </button>
          )}
        </div>
      </div>
    )
  }
}

export function ViewLoading(): React.JSX.Element {
  return <div aria-busy="true" style={{ padding: 24, color: 'var(--text-subtle)', fontSize: '0.85rem' }}>読み込み中…</div>
}

/**
 * 分けて読み込む画面（React.lazy）を包む。読み込み中は fallback を出し、読み込めないときは再読み込みを案内する。
 * 画面を切り替えたら key を変えて、前の画面のエラーを持ち越さない
 */
export function ViewBoundary({ children, fallback = <ViewLoading />, onDismiss }: {
  children: React.ReactNode
  fallback?: React.ReactNode
  onDismiss?: () => void
}): React.JSX.Element {
  return (
    <ViewErrorBoundary onDismiss={onDismiss}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ViewErrorBoundary>
  )
}
