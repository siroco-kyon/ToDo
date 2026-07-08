import React, { useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from '../lib/clipboard'
import { readTaskReportSnapshot, TASK_REPORT_SNAPSHOT_KEY, type TaskReportSnapshot } from '../lib/taskReportSnapshot'
import {
  formatDateTime,
  groupPerTaskReportByCategory,
  perTaskReportToMarkdown,
  TaskReportCard
} from './ProgressReportModal'

export function TaskReportWindow(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<TaskReportSnapshot | null>(() => readTaskReportSnapshot())
  const [showOnlyActiveTasks, setShowOnlyActiveTasks] = useState(() => snapshot?.showOnlyActiveTasks ?? false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const handler = (e: StorageEvent): void => {
      if (e.key !== TASK_REPORT_SNAPSHOT_KEY) return
      const next = readTaskReportSnapshot()
      setSnapshot(next)
      if (next) setShowOnlyActiveTasks(next.showOnlyActiveTasks)
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const rows = snapshot ? (showOnlyActiveTasks ? snapshot.rows.filter((row) => row.notes.length > 0) : snapshot.rows) : []

  const handleCopyMarkdown = useCallback(async (): Promise<void> => {
    try {
      await copyTextToClipboard(perTaskReportToMarkdown(rows))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // クリップボード権限がない環境（一部のブラウザプレビュー等）では静かに失敗させる
    }
  }, [rows])

  if (!snapshot) {
    return (
      <div style={emptyStateStyle}>
        <p>表示するレポートがありません。</p>
        <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
          メインウィンドウの進捗レポートで「集計する」を実行してから「別ウィンドウで開く」を押してください。
        </p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '32px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: '1.3rem', margin: 0 }}>📊 タスク別レポート</h1>
            <p style={{ color: '#64748b', fontSize: '0.85rem', margin: '6px 0 0' }}>
              期間 {snapshot.from} 〜 {snapshot.to} ・ 生成: {formatDateTime(snapshot.generatedAt)}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: '#94a3b8', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showOnlyActiveTasks}
                onChange={(e) => setShowOnlyActiveTasks(e.target.checked)}
                style={{ accentColor: '#6366f1' }}
              />
              活動があったタスクのみ表示
            </label>
            <button onClick={() => void handleCopyMarkdown()} style={copyBtn}>
              {copied ? '✅ コピーしました' : '📋 Markdownをコピー'}
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: '0.9rem' }}>
            {showOnlyActiveTasks ? 'この期間に進捗記録があるタスクがありません。' : '表示するタスクがありません。'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {groupPerTaskReportByCategory(rows).map((group) => (
              <div key={group.category_name ?? '未分類'} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {group.category_color && (
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: group.category_color, flexShrink: 0 }} />
                  )}
                  <span style={{ fontSize: '0.9rem', color: '#94a3b8', fontWeight: 700 }}>{group.category_name}</span>
                </div>
                {group.rows.map((row) => (
                  <TaskReportCard key={row.todo.id} row={row} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const copyBtn: React.CSSProperties = {
  padding: '8px 16px', background: '#334155', border: 'none',
  borderRadius: 8, color: '#cbd5e1', cursor: 'pointer', fontSize: '0.85rem',
  fontWeight: 'bold', whiteSpace: 'nowrap'
}

const emptyStateStyle: React.CSSProperties = {
  minHeight: '100vh', background: '#0f172a', color: '#94a3b8',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 8, fontSize: '0.95rem', textAlign: 'center', padding: 24
}
