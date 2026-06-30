import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import type { Api } from '../../preload/index'
import './styles/gantt-neumorphic.css'

declare global {
  interface Window {
    api: Api
  }
}

interface RootErrorBoundaryProps {
  children: React.ReactNode
}

interface RootErrorBoundaryState {
  error: Error | null
}

class RootErrorBoundary extends React.Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('Renderer render error:', error, errorInfo)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <FailureScreen
          title="Renderer error"
          message={this.state.error.message || 'Unknown renderer error'}
          detail={this.state.error.stack ?? ''}
        />
      )
    }

    return this.props.children
  }
}

function Root(): React.JSX.Element {
  const [runtimeError, setRuntimeError] = React.useState<{ title: string; message: string; detail: string } | null>(null)

  React.useEffect(() => {
    const handleError = (event: ErrorEvent): void => {
      const error = event.error instanceof Error ? event.error : null
      const message = error?.message ?? event.message ?? 'Unknown window error'
      const detail = error?.stack ?? ''
      console.error('Renderer window error:', error ?? event)
      setRuntimeError({ title: 'Window error', message, detail })
    }

    const handleRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason instanceof Error ? event.reason : null
      const message = reason?.message ?? String(event.reason ?? 'Unknown promise rejection')
      const detail = reason?.stack ?? ''
      console.error('Renderer unhandled rejection:', event.reason)
      setRuntimeError({ title: 'Unhandled rejection', message, detail })
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)
    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])

  if (runtimeError) {
    return (
      <FailureScreen
        title={runtimeError.title}
        message={runtimeError.message}
        detail={runtimeError.detail}
      />
    )
  }

  return <App />
}

function FailureScreen({ title, message, detail }: { title: string; message: string; detail: string }): React.JSX.Element {
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
          boxShadow: '0 20px 48px rgba(15, 23, 42, 0.35)',
          overflow: 'hidden'
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #7f1d1d', background: '#450a0a', color: '#fecaca', fontWeight: 700 }}>
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
      <Root />
    </RootErrorBoundary>
  </React.StrictMode>
)
