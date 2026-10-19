import React, { useEffect, useState } from 'react'
import { fetchDesktopRelease, type DesktopReleaseInfo } from '@renderer/lib/desktopRelease'
import { login, type CurrentUser } from './session'

export function LoginScreen({ onSuccess }: { onSuccess: (user: CurrentUser) => void }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [desktopRelease, setDesktopRelease] = useState<DesktopReleaseInfo | null>(null)

  useEffect(() => {
    // Inside the desktop app the member already has it; the app itself announces newer versions.
    if (window.desktop) return undefined
    const controller = new AbortController()
    void fetchDesktopRelease(controller.signal).then((status) => {
      if (!controller.signal.aborted) setDesktopRelease(status?.release ?? null)
    })
    return () => controller.abort()
  }, [])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const user = await login(username.trim(), password)
      onSuccess(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインに失敗しました')
      setSubmitting(false)
    }
  }

  return (
    <div style={styles.screen}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <div style={styles.brand}>
          <div style={styles.logo}>
            <svg width="44" height="44" viewBox="0 0 128 128" aria-hidden>
              <rect x="9" y="9" width="110" height="110" rx="23" fill="var(--slate-900)" />
              <rect x="28" y="35" width="51" height="15" rx="4.5" fill="var(--teal-400)" />
              <rect x="42" y="56" width="56" height="15" rx="4.5" fill="var(--teal-300)" />
              <rect x="56" y="78" width="35" height="15" rx="4.5" fill="var(--amber-400)" />
            </svg>
          </div>
          <div>
            <div style={styles.title}>HAKOBI</div>
            <div style={styles.subtitle}>チームの仕事を、前へ。</div>
          </div>
        </div>

        <label style={styles.label}>
          ユーザー名
          <input
            style={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            disabled={submitting}
          />
        </label>

        <label style={styles.label}>
          パスワード
          <input
            style={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={submitting}
          />
        </label>

        {error && <div style={styles.error}>{error}</div>}

        <button type="submit" style={{ ...styles.button, opacity: submitting ? 0.6 : 1 }} disabled={submitting}>
          {submitting ? 'サインイン中…' : 'サインイン'}
        </button>

        <div style={styles.hint}>
          アカウントは管理者が発行します。ログインできない場合は管理者にお問い合わせください。
        </div>

        {desktopRelease && <a href="/download" style={styles.link}>デスクトップ版（Windows）をダウンロード</a>}
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  screen: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'radial-gradient(circle at 30% 20%, var(--slate-800) 0%, var(--slate-900) 55%, var(--slate-950) 100%)',
    padding: 24,
    boxSizing: 'border-box'
  },
  card: {
    width: '100%',
    maxWidth: 380,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 32,
    borderRadius: 18,
    border: '1px solid var(--slate-800)',
    background: 'var(--c-0b1220)',
    boxShadow: '0 24px 60px color-mix(in srgb, var(--slate-950) 60%, transparent)'
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 },
  logo: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: '1.25rem', fontWeight: 750, letterSpacing: '0.12em', color: 'var(--slate-100)' },
  subtitle: { fontSize: '0.82rem', color: 'var(--slate-400)', marginTop: 2 },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: '0.8rem',
    color: 'var(--slate-300)',
    fontWeight: 600
  },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--slate-700)',
    background: 'var(--slate-900)',
    color: 'var(--slate-200)',
    fontSize: '0.95rem',
    outline: 'none'
  },
  error: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--red-900)',
    background: 'var(--red-950)',
    color: 'var(--red-200)',
    fontSize: '0.82rem'
  },
  button: {
    marginTop: 4,
    padding: '11px 12px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--teal-400)',
    color: 'var(--slate-900)',
    fontSize: '0.95rem',
    fontWeight: 700,
    cursor: 'pointer'
  },
  hint: { fontSize: '0.74rem', color: 'var(--text-subtle)', lineHeight: 1.6, marginTop: 4 },
  link: { fontSize: '0.78rem', color: 'var(--teal-300)', alignSelf: 'flex-start' }
}
