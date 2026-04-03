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
    { key: 'gantt', label: '\u30ac\u30f3\u30c8', active: activeView === 'gantt', onClick: onToggleGanttView },
    { key: 'plan', label: '\u8a08\u753b', active: activeView === 'plan', onClick: onTogglePlanView },
    { key: 'log', label: '\u8a18\u9332', active: activeView === 'log', onClick: onToggleLogView }
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
            placeholder="\u30bf\u30b9\u30af\u3092\u8ffd\u52a0..."
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
              <option value="">\u30ab\u30c6\u30b4\u30ea\u306a\u3057</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          )}
          <button type="submit" style={primaryButtonStyle}>{'\u8ffd\u52a0'}</button>
          <button type="button" onClick={() => setAdding(false)} style={ghostButtonStyle}>{'\u9589\u3058\u308b'}</button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} style={primaryButtonStyle}>
          + {'\u8ffd\u52a0'}
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
            {'\u8a08\u6e2c\u4e2d'}
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
            {'\u4eca\u65e5\u306e\u30ec\u30fc\u30eb'}
          </button>
          <button onClick={onToggleArchived} style={utilityButtonStyle(showArchived)}>
            {showArchived ? '\u30a2\u30fc\u30ab\u30a4\u30d6\u8868\u793a\u4e2d' : '\u30a2\u30fc\u30ab\u30a4\u30d6'}
          </button>
          <button onClick={onExportClipboard} style={utilityButtonStyle(false)}>{'\u30b3\u30d4\u30fc'}</button>
          <button onClick={onExportFile} style={utilityButtonStyle(false)}>{'\u4fdd\u5b58'}</button>
          <button onClick={onOpenSettings} style={utilityButtonStyle(false)}>{'\u8a2d\u5b9a'}</button>
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
