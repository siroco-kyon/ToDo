import React, { useCallback, useEffect, useRef, useState } from 'react'
import { connectRealtime, disconnectRealtime } from '../lib/client'
import { fetchMe, logout as logoutRequest, type CurrentUser } from './session'
import { LoginScreen } from './LoginScreen'
import { UserProvider } from './UserContext'
import { startServerClockSync } from '@renderer/lib/serverClock'

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'anon' }
  | { kind: 'authed'; user: CurrentUser }

export function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const active = useRef(false)
  const revision = useRef(0)
  const requestController = useRef<AbortController | null>(null)

  const check = useCallback(async () => {
    const current = ++revision.current
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 10000)
    let onAbort: (() => void) | undefined
    setPhase({ kind: 'loading' })
    try {
      const user = await Promise.race([
        fetchMe(controller.signal),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error(timedOut ? 'サーバーからの応答を確認できませんでした。接続を確認して再試行してください' : '読み込みを中止しました'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
      if (active.current && current === revision.current) setPhase(user ? { kind: 'authed', user } : { kind: 'anon' })
    } catch (err) {
      if (active.current && current === revision.current) {
        setPhase({ kind: 'error', message: timedOut ? 'サーバーからの応答を確認できませんでした。接続を確認して再試行してください' : err instanceof Error ? err.message : 'サーバーに接続できません' })
      }
    } finally {
      clearTimeout(timeout)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      if (requestController.current === controller) requestController.current = null
    }
  }, [])

  useEffect(() => {
    active.current = true
    void check()
    return () => {
      active.current = false
      revision.current++
      requestController.current?.abort()
    }
  }, [check])

  useEffect(() => startServerClockSync(), [])

  useEffect(() => {
    if (phase.kind === 'anon' && window.desktop && !location.hash) {
      void window.desktop.publishState({ userId: null, taskId: null, taskTitle: '', startTime: null, online: false })
    }
  }, [phase.kind])

  // Open the realtime connection only while authenticated.
  useEffect(() => {
    if (phase.kind === 'authed') {
      connectRealtime()
      return () => disconnectRealtime()
    }
    return undefined
  }, [phase.kind])

  const handleLogout = useCallback(async () => {
    await logoutRequest()
    disconnectRealtime()
    setPhase({ kind: 'anon' })
  }, [])

  if (phase.kind === 'loading') {
    return <Splash>読み込み中…</Splash>
  }

  if (phase.kind === 'error') {
    return (
      <Splash>
        <div style={{ color: '#fecaca', marginBottom: 16 }}>{phase.message}</div>
        <button onClick={() => void check()} style={retryButton}>
          再試行
        </button>
        {window.desktop && <button onClick={() => void window.desktop?.openConnectionSettings()} style={retryButton}>接続先の設定</button>}
      </Splash>
    )
  }

  if (phase.kind === 'anon') {
    return <LoginScreen onSuccess={(user) => setPhase({ kind: 'authed', user })} />
  }

  return (
    <UserProvider user={phase.user} logout={handleLogout}>
      {children}
    </UserProvider>
  )
}

function Splash({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f172a',
        color: '#94a3b8',
        fontSize: '0.95rem',
        gap: 8
      }}
    >
      {children}
    </div>
  )
}

const retryButton: React.CSSProperties = {
  padding: '9px 18px',
  borderRadius: 10,
  border: '1px solid #334155',
  background: '#1e293b',
  color: '#e2e8f0',
  fontSize: '0.9rem',
  cursor: 'pointer'
}
