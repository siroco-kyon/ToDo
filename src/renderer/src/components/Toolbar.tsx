import React from 'react'
import type { PublicUser } from '../types'

interface Props {
  isTimerRunning: boolean
  onOpenQuickAdd: () => void
  onExportClipboard: () => Promise<void>
  onExportFile: () => Promise<void>
  showArchived: boolean
  onToggleArchived: () => void
  onOpenSettings: () => void
  activeView: 'detail' | 'log' | 'plan' | 'gantt' | 'team'
  showPlanRail: boolean
  showTeamButton?: boolean
  /** サーバー版のログイン中ユーザー。デスクトップ版は null で何も表示しない */
  currentUser?: PublicUser | null
  onLogout?: () => void
  onToggleLogView: () => void
  onTogglePlanView: () => void
  onToggleGanttView: () => void
  onToggleTeamView: () => void
  onTogglePlanRail: () => void
}

interface ViewButton {
  key: 'plan' | 'gantt' | 'log' | 'team'
  label: string
  active: boolean
  onClick: () => void
}

export function Toolbar({
  isTimerRunning,
  onOpenQuickAdd,
  onExportClipboard,
  onExportFile,
  showArchived,
  onToggleArchived,
  onOpenSettings,
  activeView,
  showPlanRail,
  showTeamButton = false,
  currentUser = null,
  onLogout,
  onToggleLogView,
  onTogglePlanView,
  onToggleGanttView,
  onToggleTeamView,
  onTogglePlanRail
}: Props): React.JSX.Element {
  const viewButtons: ViewButton[] = [
    { key: 'gantt', label: 'ガント', active: activeView === 'gantt', onClick: onToggleGanttView },
    ...(showTeamButton ? [{ key: 'team' as const, label: 'チーム', active: activeView === 'team', onClick: onToggleTeamView }] : []),
    { key: 'plan', label: '計画', active: activeView === 'plan', onClick: onTogglePlanView },
    { key: 'log', label: '記録', active: activeView === 'log', onClick: onToggleLogView }
  ]

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
      <button onClick={onOpenQuickAdd} style={primaryButtonStyle}>
        + 追加
      </button>

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
          <button onClick={onExportFile} style={utilityButtonStyle(false)}>書き出し</button>
          <button onClick={onOpenSettings} style={utilityButtonStyle(false)}>設定</button>
        </div>

        {currentUser && (
          <div style={groupStyle}>
            <span
              title={`${currentUser.display_name}（${currentUser.username}）でログイン中`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                fontSize: '0.78rem',
                fontWeight: 700,
                color: '#e2e8f0',
                whiteSpace: 'nowrap'
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: currentUser.color, flexShrink: 0 }} />
              {currentUser.display_name}
              {currentUser.role === 'admin' && (
                <span style={{ fontSize: '0.64rem', fontWeight: 700, color: '#fbbf24', background: '#451a03', borderRadius: 6, padding: '1px 6px' }}>管理者</span>
              )}
            </span>
            {onLogout && (
              <button onClick={onLogout} style={utilityButtonStyle(false)}>ログアウト</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
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
