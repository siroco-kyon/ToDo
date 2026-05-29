import React, { useCallback, useEffect, useState } from 'react'
import { connectRealtime, disconnectRealtime } from '../lib/client'
import { fetchMe, logout as logoutRequest, type CurrentUser } from './session'
import { LoginScreen } from './LoginScreen'
import { UserProvider } from './UserContext'

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'anon' }
  | { kind: 'authed'; user: CurrentUser }

export function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  const check = useCallback(async () => {
    setPhase({ kind: 'loading' })
    try {
      const user = await fetchMe()
      setPhase(user ? { kind: 'authed', user } : { kind: 'anon' })
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'サーバーに接続できません' })
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

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
