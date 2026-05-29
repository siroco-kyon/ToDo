import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from '@renderer/App'
import type { Api } from '@preload'
import { api } from './lib/client'
import { AuthGate } from './auth/AuthGate'

declare global {
  interface Window {
    api: Api
  }
}

// Install the HTTP/WebSocket-backed API before any component mounts, so the
// renderer's `window.api.*` calls behave exactly as they did over Electron IPC.
window.api = api

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Renderer render error:', error, info)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <FailureScreen
          title="表示エラー"
          message={this.state.error.message || '不明なエラーが発生しました'}
          detail={this.state.error.stack ?? ''}
        />
      )
    }
    return this.props.children
  }
}

function FailureScreen({
  title,
  message,
  detail
}: {
  title: string
  message: string
  detail: string
}): React.JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        padding: 24,
        boxSizing: 'border-box',
        background: '#020617',
        color: '#e2e8f0',
        fontFamily: 'Consolas, Menlo, Monaco, monospace'
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
          borderRadius: 16,
          border: '1px solid #7f1d1d',
          background: '#111827',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #7f1d1d',
            background: '#450a0a',
            color: '#fecaca',
            fontWeight: 700
          }}
        >
          {title}
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: '0.95rem', lineHeight: 1.6 }}>{message}</div>
          {detail && (
            <pre
              style={{
                margin: 0,
                padding: 16,
                borderRadius: 12,
                border: '1px solid #334155',
                background: '#0f172a',
                color: '#cbd5e1',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '0.78rem',
                lineHeight: 1.5
              }}
            >
              {detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </RootErrorBoundary>
  </React.StrictMode>
)
