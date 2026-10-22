import React, { useEffect, useState } from 'react'
import {
  desktopDownloadPageUrl,
  fetchDesktopRelease,
  isDismissedDesktopRelease,
  isNewerDesktopRelease,
  type DesktopReleaseInfo
} from '@renderer/lib/desktopRelease'
import { subscribeConnection } from '../lib/client'
import type { DesktopContext } from '../../src/shared/desktop'
import { canCheckClickOnceRelease, fetchClickOnceRelease, isNewerClickOnceVersion, type ClickOnceRelease } from '@renderer/lib/clickOnceRelease'

const DISMISSED_KEY = 'hakobi-desktop-update-dismissed'
const CLICKONCE_DISMISSED_KEY = 'hakobi-clickonce-update-dismissed'
const RECHECK_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISSED_KEY) } catch { return null }
}

function writeDismissed(version: string): void {
  try { window.localStorage.setItem(DISMISSED_KEY, version) } catch { /* The notice simply returns next time. */ }
}

/** Lives in the desktop main window and tells the member when the team server offers a newer installer. */
export function DesktopUpdateNotice(): React.JSX.Element | null {
  const [context, setContext] = useState<DesktopContext | null>(null)
  const [release, setRelease] = useState<DesktopReleaseInfo | null>(null)
  const [clickOnceRelease, setClickOnceRelease] = useState<ClickOnceRelease | null>(null)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [clickOnceDismissed, setClickOnceDismissed] = useState<string | null>(() => {
    try { return window.localStorage.getItem(CLICKONCE_DISMISSED_KEY) } catch { return null }
  })

  useEffect(() => {
    let disposed = false
    window.desktop?.getContext().then((value) => { if (!disposed) setContext(value) })
      .catch((error) => console.error('[HAKOBI] アプリのバージョンを確認できませんでした', error))
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!context) return
    if (context.distribution === 'clickonce' && !canCheckClickOnceRelease(context.clickOnceInstallUrl, window.location.origin)) return
    let disposed = false
    let controller: AbortController | null = null
    const check = (): void => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      const timeout = setTimeout(() => current.abort(), REQUEST_TIMEOUT_MS)
      const request = context.distribution === 'clickonce'
        ? fetchClickOnceRelease(current.signal).then((value) => {
          if (!disposed && !current.signal.aborted && value) setClickOnceRelease(value)
        })
        : fetchDesktopRelease(current.signal).then((status) => {
          // Without an answer (offline, older server), keep what the last answer said.
          if (!disposed && !current.signal.aborted && status) setRelease(status.release)
        })
      void request.finally(() => {
        clearTimeout(timeout)
        if (controller === current) controller = null
      })
    }
    check()
    let wasConnected: boolean | null = null
    const unsubscribe = subscribeConnection((connected) => {
      // The server may have been updated while this PC slept or the server restarted.
      if (connected && wasConnected === false) check()
      wasConnected = connected
    })
    const interval = setInterval(check, RECHECK_MS)
    return () => {
      disposed = true
      controller?.abort()
      unsubscribe()
      clearInterval(interval)
    }
  }, [context])

  if (context?.distribution === 'clickonce') {
    if (!clickOnceRelease || !isNewerClickOnceVersion(clickOnceRelease.version, context.clickOnceVersion) ||
      (clickOnceDismissed && !isNewerClickOnceVersion(clickOnceRelease.version, clickOnceDismissed))) return null
    return <ClickOnceUpdateCard version={clickOnceRelease.version} onDismiss={() => {
      try { window.localStorage.setItem(CLICKONCE_DISMISSED_KEY, clickOnceRelease.version) } catch { /* Retry next launch. */ }
      setClickOnceDismissed(clickOnceRelease.version)
    }} />
  }

  if (!context || !release || !isNewerDesktopRelease(release, context) || isDismissedDesktopRelease(release, dismissed)) return null
  return (
    <DesktopUpdateCard
      version={release.version}
      installed={context.appVersion}
      onDismiss={() => {
        writeDismissed(release.version)
        setDismissed(release.version)
      }}
    />
  )
}

export function ClickOnceUpdateCard({ version, onDismiss }: {
  version: string
  onDismiss: () => void
}): React.JSX.Element {
  return <div role="status" aria-live="polite" style={styles.card}>
    <div style={styles.title}>HAKOBI の新しいバージョン {version} があります</div>
    <div style={styles.detail}>
      タスクトレイの「HAKOBIを終了」で終了し、デスクトップまたはスタートメニューの
      「HAKOBI（ClickOnce 試験版）」から起動すると更新を確認します。
    </div>
    <button type="button" onClick={onDismiss} style={styles.secondary}>後で</button>
  </div>
}

export function DesktopUpdateCard({ version, installed, onDismiss }: {
  version: string
  installed: string | undefined
  onDismiss: () => void
}): React.JSX.Element {
  return (
    // Bottom left, so it never covers the toasts in the bottom right.
    <div role="status" aria-live="polite" style={styles.card}>
      <div style={styles.title}>HAKOBI の新しいバージョン {version} があります</div>
      <div style={styles.detail}>このPC: {installed ?? '1.0.4 以前'}</div>
      <div style={styles.actions}>
        {/* The desktop app opens new windows in the system browser, where the installer can be saved. */}
        <a href={desktopDownloadPageUrl()} target="_blank" rel="noopener noreferrer" style={styles.primary}>ダウンロードページを開く</a>
        <button type="button" onClick={onDismiss} style={styles.secondary}>後で</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    position: 'fixed',
    left: 20,
    bottom: 20,
    // Above the screens, below the notification panel (40) and dialogs (1000 and up).
    zIndex: 35,
    width: 300,
    maxWidth: 'calc(100vw - 40px)',
    padding: '14px 16px',
    borderRadius: 12,
    border: '1px solid var(--slate-700)',
    background: 'var(--slate-800)',
    boxShadow: '0 12px 32px color-mix(in srgb, var(--slate-950) 55%, transparent)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    boxSizing: 'border-box'
  },
  title: { fontSize: '0.85rem', fontWeight: 700, color: 'var(--slate-200)', lineHeight: 1.5 },
  detail: { fontSize: '0.75rem', color: 'var(--slate-400)' },
  actions: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  primary: {
    padding: '6px 12px',
    borderRadius: 7,
    background: 'var(--teal-400)',
    color: 'var(--slate-900)',
    fontSize: '0.8rem',
    fontWeight: 700,
    textDecoration: 'none',
    whiteSpace: 'nowrap'
  },
  secondary: {
    padding: '6px 12px',
    borderRadius: 7,
    border: 'none',
    background: 'var(--slate-700)',
    color: 'var(--slate-300)',
    fontSize: '0.8rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }
}
