import React, { useState, useEffect } from 'react'

interface Props {
  onComplete: () => void
}

export function SetupWizardModal({ onComplete }: Props): React.JSX.Element {
  const [defaultDir, setDefaultDir] = useState('')
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.api.appGetDefaultDataDir().then((dir) => {
      setDefaultDir(dir)
    })
  }, [])

  const handlePickDir = async (): Promise<void> => {
    const picked = await window.api.dataPickDir()
    if (picked) setSelectedDir(picked)
  }

  const handleComplete = async (): Promise<void> => {
    setLoading(true)
    await window.api.appCompleteSetup(selectedDir)
    onComplete()
  }

  const displayDir = selectedDir ?? defaultDir

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'linear-gradient(135deg, #0a0f1a 0%, #0d1525 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000
      }}
    >
      <div style={{
        background: '#1e293b', borderRadius: 16, padding: 40, width: 520,
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)', border: '1px solid #334155',
        display: 'flex', flexDirection: 'column', gap: 24
      }}>
        {/* ヘッダー */}
        <div>
          <div style={{ fontSize: '1.6rem', marginBottom: 8 }}>📋</div>
          <h1 style={{ fontSize: '1.3rem', color: '#e2e8f0', marginBottom: 6 }}>
            ToDoへようこそ
          </h1>
          <p style={{ fontSize: '0.85rem', color: '#64748b', lineHeight: 1.6 }}>
            データベースの保存場所を選択してください。<br />
            後から設定で変更することもできます。
          </p>
        </div>

        {/* 保存場所選択 */}
        <div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            データ保存場所
          </div>

          <div style={{
            background: '#0f172a', border: `1px solid ${selectedDir ? '#6366f1' : '#334155'}`,
            borderRadius: 8, padding: '10px 14px',
            fontSize: '0.82rem', color: selectedDir ? '#a5b4fc' : '#94a3b8',
            fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 10,
            minHeight: 40, display: 'flex', alignItems: 'center'
          }}>
            {displayDir || '読み込み中…'}
          </div>

          {!selectedDir && (
            <p style={{ fontSize: '0.75rem', color: '#475569', marginBottom: 10 }}>
              ↑ デフォルトの保存場所（変更しない場合はこのまま）
            </p>
          )}

          <button
            onClick={handlePickDir}
            style={{
              padding: '8px 16px', background: '#334155', border: 'none',
              borderRadius: 8, color: '#94a3b8', cursor: 'pointer',
              fontSize: '0.85rem', whiteSpace: 'nowrap'
            }}
          >
            📁 別のフォルダを選択…
          </button>
        </div>

        {/* 完了ボタン */}
        <button
          onClick={handleComplete}
          disabled={loading}
          style={{
            padding: '12px 24px', background: loading ? '#334155' : '#6366f1',
            border: 'none', borderRadius: 10, color: loading ? '#64748b' : '#fff',
            cursor: loading ? 'not-allowed' : 'pointer', fontSize: '1rem',
            fontWeight: 'bold', transition: 'background 0.2s'
          }}
        >
          {loading ? '初期化中…' : 'セットアップ完了'}
        </button>
      </div>
    </div>
  )
}
