import React, { useEffect, useState } from 'react'
import type { DesktopImportResult, PublicUser } from '../types'

interface Props {
  users: PublicUser[]
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

// デスクトップ版の todo.db をアップロードしてサーバー版に取り込む管理者用モーダル。
// まずドライランで件数を確認してから本実行する流れを想定している。
export function DesktopImportModal({ users, onClose, onShowToast }: Props): React.JSX.Element {
  const [file, setFile] = useState<File | null>(null)
  const [targetUserId, setTargetUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DesktopImportResult | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const runImport = async (dryRun: boolean): Promise<void> => {
    if (!file) {
      onShowToast('todo.db ファイルを選択してください', 'error')
      return
    }
    if (!targetUserId) {
      onShowToast('取り込み先のメンバーを選択してください', 'error')
      return
    }
    setBusy(true)
    try {
      const data = await file.arrayBuffer()
      const imported = await window.api.adminImportDesktopDb(data, targetUserId, dryRun)
      setResult(imported)
      onShowToast(dryRun ? 'ドライランが完了しました（まだ書き込んでいません）' : '取り込みが完了しました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '取り込みに失敗しました', 'error')
    } finally {
      setBusy(false)
    }
  }

  const activeUsers = users.filter((user) => user.is_active === 1)

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: '#1e293b', borderRadius: 14, padding: 28, width: 560,
        maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)', border: '1px solid #334155',
        display: 'flex', flexDirection: 'column', gap: 18
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', margin: 0 }}>💾 デスクトップDBの取り込み</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '1.2rem', padding: '2px 6px' }}>×</button>
        </div>

        <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.6 }}>
          デスクトップ版（1人用）の <code style={{ color: '#cbd5e1' }}>todo.db</code> を、担当者を指定してこのサーバーに取り込みます。
          同じファイルを再度取り込んでも二重登録はされません。まず「ドライラン」で件数を確認してから実行するのがおすすめです。
        </div>

        <div>
          <label style={labelStyle}>todo.db ファイル</label>
          <input
            type="file"
            accept=".db,.sqlite,.sqlite3"
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null) }}
            style={{ ...inputStyle, padding: 8 }}
          />
          {file && <div style={{ marginTop: 4, fontSize: '0.74rem', color: '#64748b' }}>{file.name}（{Math.max(1, Math.round(file.size / 1024))} KB）</div>}
        </div>

        <div>
          <label style={labelStyle}>取り込み先メンバー（タスクの担当者になります）</label>
          <select value={targetUserId} onChange={(event) => { setTargetUserId(event.target.value); setResult(null) }} style={inputStyle}>
            <option value="">選択してください</option>
            {activeUsers.map((user) => (
              <option key={user.id} value={user.id}>{user.display_name}（{user.username}）</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => void runImport(true)} disabled={busy} style={btn('#334155', '#cbd5e1')}>
            {busy ? '処理中...' : 'ドライラン（確認のみ）'}
          </button>
          <button onClick={() => void runImport(false)} disabled={busy} style={btn('#6366f1', '#fff')}>
            {busy ? '処理中...' : '取り込みを実行'}
          </button>
        </div>

        {result && (
          <div style={{ background: '#0f172a', borderRadius: 10, padding: 14, border: '1px solid #334155' }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: result.dryRun ? '#fbbf24' : '#4ade80', marginBottom: 8 }}>
              {result.dryRun ? 'ドライラン結果（未保存）' : '取り込み完了'}
            </div>
            <table style={{ fontSize: '0.8rem', color: '#cbd5e1', borderCollapse: 'collapse' }}>
              <tbody>
                <ResultRow label="カテゴリ" value={result.categories} note="（新規追加分のみ）" />
                <ResultRow label="タスク" value={result.todos} />
                <ResultRow label="サブタスク" value={result.subTasks} />
                <ResultRow label="依存関係" value={result.dependencies} />
                <ResultRow label="作業ログ" value={result.workLogs} />
                <ResultRow label="予定（レール）" value={result.planItems} />
                {result.skippedOrphans > 0 && <ResultRow label="スキップ" value={result.skippedOrphans} note="（参照先タスクが無い孤立データ）" />}
              </tbody>
            </table>
            {result.dryRun && (
              <div style={{ marginTop: 8, fontSize: '0.76rem', color: '#94a3b8' }}>
                問題なければ「取り込みを実行」を押してください。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ResultRow({ label, value, note }: { label: string; value: number; note?: string }): React.JSX.Element {
  return (
    <tr>
      <td style={{ padding: '2px 16px 2px 0', color: '#94a3b8' }}>{label}</td>
      <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value} 件</td>
      <td style={{ padding: '2px 0 2px 8px', color: '#64748b', fontSize: '0.72rem' }}>{note ?? ''}</td>
    </tr>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.74rem', color: '#94a3b8', marginBottom: 6
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: '#0f172a', border: '1px solid #334155',
  borderRadius: 7, color: '#e2e8f0', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box'
}

function btn(background: string, color: string): React.CSSProperties {
  return {
    padding: '8px 16px', background, border: 'none', borderRadius: 8,
    color, cursor: 'pointer', fontSize: '0.84rem', fontWeight: 'bold', whiteSpace: 'nowrap'
  }
}
