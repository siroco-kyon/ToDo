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
  activeView: 'detail' | 'log' | 'plan' | 'gantt'
  showPlanRail: boolean
  onToggleLogView: () => void
  onTogglePlanView: () => void
  onToggleGanttView: () => void
  onTogglePlanRail: () => void
}

interface ViewButton {
  key: 'plan' | 'gantt' | 'log'
  label: string
  active: boolean
  onClick: () => void
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
  activeView,
  showPlanRail,
  onToggleLogView,
  onTogglePlanView,
  onToggleGanttView,
  onTogglePlanRail
}: Props): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')

  const viewButtons: ViewButton[] = [
    { key: 'gantt', label: 'ガント', active: activeView === 'gantt', onClick: onToggleGanttView },
    { key: 'plan', label: '計画', active: activeView === 'plan', onClick: onTogglePlanView },
    { key: 'log', label: '記録', active: activeView === 'log', onClick: onToggleLogView }
  ]

  const handleAdd = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!title.trim()) return
    await onAdd({ title: title.trim(), category_id: categoryId || null })
    setTitle('')
    setCategoryId('')
    setAdding(false)
  }

  return (
    <div
      style={{
        padding: '10px 16px',
        background: '#0f172a',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap'
      }}
    >
      {adding ? (
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, flex: '1 1 320px', alignItems: 'center', minWidth: 280 }}>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="タスクを追加..."
            style={inputStyle}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false)
            }}
          />
          {categories.length > 0 && (
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              style={{ ...inputStyle, maxWidth: 160 }}
            >
              <option value="">カテゴリなし</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          )}
          <button type="submit" style={primaryButtonStyle}>追加</button>
          <button type="button" onClick={() => setAdding(false)} style={ghostButtonStyle}>閉じる</button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} style={primaryButtonStyle}>
          + 追加
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
        {isTimerRunning && (
          <span
            style={{
              fontSize: '0.74rem',
              color: '#4ade80',
              padding: '5px 10px',
              background: '#052e16',
              border: '1px solid #14532d',
              borderRadius: 999
            }}
          >
            計測中
          </span>
        )}

        <div style={groupStyle}>
          {viewButtons.map((button) => (
            <button
              key={button.key}
              onClick={button.onClick}
              style={viewButtonStyle(button.active)}
            >
              {button.label}
            </button>
          ))}
        </div>

        <div style={groupStyle}>
          <button onClick={onTogglePlanRail} style={utilityButtonStyle(showPlanRail)}>
            今日のレール
          </button>
          <button onClick={onToggleArchived} style={utilityButtonStyle(showArchived)}>
            {showArchived ? 'アーカイブ表示中' : 'アーカイブ'}
          </button>
          <button onClick={onExportClipboard} style={utilityButtonStyle(false)}>コピー</button>
          <button onClick={onExportFile} style={utilityButtonStyle(false)}>保存</button>
          <button onClick={onOpenSettings} style={utilityButtonStyle(false)}>設定</button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '8px 10px',
  background: '#111827',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box'
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: 4,
  background: '#111827',
  border: '1px solid #1f2937',
  borderRadius: 12,
  flexWrap: 'wrap'
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: '#2563eb',
  border: '1px solid #1d4ed8',
  borderRadius: 8,
  color: '#eff6ff',
  cursor: 'pointer',
  fontSize: '0.84rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

const ghostButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.84rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

function viewButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '7px 10px',
    background: active ? '#2563eb' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 8,
    color: active ? '#eff6ff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

function utilityButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '7px 10px',
    background: active ? '#172554' : 'transparent',
    border: `1px solid ${active ? '#2563eb' : 'transparent'}`,
    borderRadius: 8,
    color: active ? '#dbeafe' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}
