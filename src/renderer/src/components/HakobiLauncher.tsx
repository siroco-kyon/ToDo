import { useEffect, useRef, useState } from 'react'
import type { LauncherState } from '../../../shared/desktop'
import './HakobiLauncher.css'

function HakobiMark(): React.JSX.Element {
  return (
    <svg className="hakobi-launcher-mark" viewBox="0 0 128 128" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="110" height="110" rx="23" fill="#0F172A" />
      <rect x="28" y="35" width="51" height="15" rx="4.5" fill="#2DD4BF" />
      <rect x="42" y="56" width="56" height="15" rx="4.5" fill="#5EEAD4" />
      <rect x="56" y="78" width="35" height="15" rx="4.5" fill="#FBBF24" />
    </svg>
  )
}

export function HakobiLauncher(): React.JSX.Element {
  const [state, setState] = useState<LauncherState | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const profileKey = useRef<string | null>(null)

  useEffect(() => {
    document.title = 'HAKOBI'
    const bridge = window.hakobiLauncher
    if (!bridge) {
      setError('接続画面を起動できませんでした。HAKOBIを再起動してください。')
      return
    }

    let active = true
    const update = (next: LauncherState): void => {
      if (!active) return
      setState(next)
      const nextKey = next.profile ? `${next.profile.id}:${next.profile.url}:${next.profile.name}` : ''
      if (profileKey.current !== nextKey) {
        profileKey.current = nextKey
        setName(next.profile?.name ?? '')
        setUrl(next.profile?.url ?? '')
      }
    }
    const unsubscribe = bridge.onState(update)
    void bridge.getState().then(update).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '起動設定を読み込めませんでした。')
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作を完了できませんでした。もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  const connect = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const bridge = window.hakobiLauncher
    if (!bridge) return
    const address = url.trim()
    if (!address) {
      setError('管理者から案内されたサーバーのアドレスを入力してください。')
      return
    }
    const groupName = name.trim()
    if (!groupName) {
      setError('接続先を見分けられるグループ名を入力してください。')
      return
    }
    void run(() => bridge.connect({ name: groupName, url: address }))
  }

  const connecting = state?.connecting || busy
  const message = error || (!state?.connecting ? state?.message : '')
  const loading = !state && !error

  return (
    <main className="hakobi-launcher">
      <section className="hakobi-launcher-brand" aria-label="HAKOBI">
        <div className="hakobi-launcher-brand-lockup">
          <HakobiMark />
          <div>
            <div className="hakobi-launcher-wordmark">HAKOBI</div>
            <p className="hakobi-launcher-caption">今日の仕事を、一歩ずつ。</p>
          </div>
        </div>
        <div className="hakobi-launcher-illustration" aria-hidden="true">
          <div className="hakobi-launcher-grid">
            <span className="hakobi-launcher-bar hakobi-launcher-bar-one" />
            <span className="hakobi-launcher-bar hakobi-launcher-bar-two" />
            <span className="hakobi-launcher-bar hakobi-launcher-bar-three" />
            <span className="hakobi-launcher-bar hakobi-launcher-bar-four" />
            <span className="hakobi-launcher-current-line" />
          </div>
          <div className="hakobi-launcher-illustration-note"><span />チームの進捗を、いつものデスクトップで。</div>
        </div>
        <p className="hakobi-launcher-brand-footer">計画する。取り組む。進み具合を伝える。</p>
      </section>

      <section className="hakobi-launcher-content">
        {loading || connecting ? (
          <div className="hakobi-launcher-splash" role="status" aria-live="polite">
            <div className="hakobi-launcher-spinner" />
            <p className="hakobi-launcher-eyebrow">{loading ? 'WELCOME' : 'CONNECTING'}</p>
            <h1>{loading ? 'HAKOBIを起動しています' : 'チームに接続しています'}</h1>
            <p className="hakobi-launcher-help">
              {loading ? '設定を読み込んでいます。' : state?.message || 'サーバーの応答を待っています。'}
            </p>
            {state?.profile && (
              <div className="hakobi-launcher-destination">
                <strong>{state.profile.name}</strong>
                <span>{state.profile.url}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="hakobi-launcher-setup">
            <p className="hakobi-launcher-eyebrow">YOUR TEAM</p>
            <h1>{state?.canCancel ? '接続先の設定' : 'チームにつなぐ'}</h1>
            <p className="hakobi-launcher-help">管理者から案内された接続先を登録します。次回からは、このグループに自動で接続します。</p>

            {message && <div className="hakobi-launcher-error" role="alert">{message}</div>}

            <form onSubmit={connect} className="hakobi-launcher-form">
              <label htmlFor="hakobi-group-name">グループ名</label>
              <input id="hakobi-group-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例：開発チーム" maxLength={80} autoComplete="organization" disabled={!state} />
              <label htmlFor="hakobi-server-url">サーバーのアドレス</label>
              <input id="hakobi-server-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="例：http://192.168.1.20:4577" inputMode="url" autoComplete="url" spellCheck={false} disabled={!state} />
              <p className="hakobi-launcher-field-help">ログインには、管理者が発行したアカウントを使います。</p>
              <button className="hakobi-launcher-primary" type="submit" disabled={!state || !name.trim() || !url.trim()}>
                このチームに接続する <span aria-hidden="true">→</span>
              </button>
            </form>

            {state?.profile && (
              <button className="hakobi-launcher-secondary" type="button" onClick={() => void run(() => window.hakobiLauncher!.retry())}>
                保存済みの接続先でもう一度試す
              </button>
            )}

            {state && (
              <div className="hakobi-launcher-bottom-actions">
                <button className="hakobi-launcher-text-button" type="button" onClick={() => void run(() => window.hakobiLauncher!.useLocal())}>
                  このPCで個人用として使う
                </button>
                {state.canCancel && (
                  <button className="hakobi-launcher-text-button" type="button" onClick={() => void run(() => window.hakobiLauncher!.cancel())}>
                    戻る
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  )
}
