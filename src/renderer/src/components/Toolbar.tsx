import React, { useState } from 'react'
import type { CreateTodoInput, Category } from '../types'

interface Props {
  categories: Category[]
  isTimerRunning: boolean
  onAdd: (data: CreateTodoInput) => Promise<void>
  onExportClipboard: () => Promise<void>
  onExportFile: () => Promise<void>
  showArchived: boolean
  onToggleArchived: () => void
  onOpenSettings: () => void
  showLogView: boolean
  onToggleLogView: () => void
  showCalendarView: boolean
  onToggleCalendarView: () => void
}

export function Toolbar({
  categories,
  isTimerRunning,
  onAdd,
  onExportClipboard,
  onExportFile,
  showArchived,
  onToggleArchived,
  onOpenSettings,
  showLogView,
  onToggleLogView,
  showCalendarView,
  onToggleCalendarView
}: Props): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')

  const handleAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!title.trim()) return
    await onAdd({ title: title.trim(), category_id: categoryId || null })
    setTitle('')
    setCategoryId('')
    setAdding(false)
  }

  return (
    <div style={{
      padding: '10px 16px', background: '#0f172a', borderBottom: '1px solid #1e293b',
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'
    }}>
      {adding ? (
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="タスクを入力..."
            style={inputStyle}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          />
          {categories.length > 0 && (
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              style={{ ...inputStyle, maxWidth: 140 }}
            >
              <option value="">カテゴリなし</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <button type="submit" style={btnStyle('#6366f1')}>追加</button>
          <button type="button" onClick={() => setAdding(false)} style={btnStyle('#334155')}>×</button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} style={btnStyle('#6366f1')}>
          + 追加
        </button>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {isTimerRunning && (
          <span style={{ fontSize: '0.75rem', color: '#4ade80', padding: '4px 10px', background: '#4ade8015', borderRadius: 99 }}>
            ● 計測中
          </span>
        )}
        <button onClick={onToggleArchived} style={btnStyle(showArchived ? '#334155' : 'transparent', showArchived ? '#e2e8f0' : '#64748b')}>
          {showArchived ? 'アーカイブを隠す' : 'アーカイブを表示'}
        </button>
        <button
          onClick={onToggleCalendarView}
          style={btnStyle(showCalendarView ? '#6366f1' : '#334155', showCalendarView ? '#fff' : '#94a3b8')}
          title="カレンダー"
        >
          📅 カレンダー
        </button>
        <button
          onClick={onToggleLogView}
          style={btnStyle(showLogView ? '#6366f1' : '#334155', showLogView ? '#fff' : '#94a3b8')}
          title="作業ログ"
        >
          📊 ログ
        </button>
        <button onClick={onExportClipboard} style={btnStyle('#334155', '#94a3b8')} title="クリップボードにコピー">
          📋 コピー
        </button>
        <button onClick={onExportFile} style={btnStyle('#334155', '#94a3b8')} title="ファイル保存">
          💾 保存
        </button>
        <button onClick={onOpenSettings} style={btnStyle('#334155', '#94a3b8')} title="設定">
          ⚙
        </button>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  flex: 1, padding: '7px 10px', background: '#1e293b', border: '1px solid #334155',
  borderRadius: 6, color: '#e2e8f0', fontSize: '0.9rem', outline: 'none', minWidth: 0
}

function btnStyle(bg: string, color = '#fff'): React.CSSProperties {
  return {
    padding: '6px 12px', background: bg, border: `1px solid #334155`,
    borderRadius: 6, color, cursor: 'pointer', fontSize: '0.85rem',
    fontWeight: 'bold', whiteSpace: 'nowrap', flexShrink: 0
  }
}
