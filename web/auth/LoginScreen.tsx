import React, { useState } from 'react'
import { login, type CurrentUser } from './session'

export function LoginScreen({ onSuccess }: { onSuccess: (user: CurrentUser) => void }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
            <svg width="28" height="28" viewBox="0 0 128 128" aria-hidden>
              <rect width="128" height="128" rx="28" fill="#2563eb" />
              <path
                d="M36 66l18 18 38-42"
                fill="none"
                stroke="#fff"
                strokeWidth="12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <div style={styles.title}>チーム ToDo</div>
            <div style={styles.subtitle}>サインインして続行</div>
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
    background: 'radial-gradient(circle at 30% 20%, #1e293b 0%, #0f172a 55%, #020617 100%)',
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
    border: '1px solid #1e293b',
    background: '#0b1220',
    boxShadow: '0 24px 60px rgba(2, 6, 23, 0.6)'
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 },
  logo: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: '1.15rem', fontWeight: 700, color: '#f1f5f9' },
  subtitle: { fontSize: '0.82rem', color: '#94a3b8', marginTop: 2 },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: '0.8rem',
    color: '#cbd5e1',
    fontWeight: 600
  },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #334155',
    background: '#0f172a',
    color: '#e2e8f0',
    fontSize: '0.95rem',
    outline: 'none'
  },
  error: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #7f1d1d',
    background: '#450a0a',
    color: '#fecaca',
    fontSize: '0.82rem'
  },
  button: {
    marginTop: 4,
    padding: '11px 12px',
    borderRadius: 10,
    border: 'none',
    background: '#2563eb',
    color: '#fff',
    fontSize: '0.95rem',
    fontWeight: 700,
    cursor: 'pointer'
  },
  hint: { fontSize: '0.74rem', color: '#64748b', lineHeight: 1.6, marginTop: 4 }
}
