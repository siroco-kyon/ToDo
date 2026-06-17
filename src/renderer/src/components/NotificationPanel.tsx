import React from 'react'
import type { UserNotification } from '../types'

interface Props {
  notifications: UserNotification[]
  unreadCount: number
  onClose: () => void
  onSelect: (notification: UserNotification) => void
  onMarkAllRead: () => void
}

export function NotificationPanel({
  notifications,
  unreadCount,
  onClose,
  onSelect,
  onMarkAllRead
}: Props): React.JSX.Element {
  return (
    <div style={backdropStyle} onMouseDown={onClose}>
      <section style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
        <header style={headerStyle}>
          <div>
            <h2 style={titleStyle}>通知</h2>
            <div style={subtitleStyle}>未読 {unreadCount} 件</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onMarkAllRead} disabled={unreadCount === 0} style={buttonStyle(unreadCount > 0)}>
              すべて既読
            </button>
            <button onClick={onClose} style={closeButtonStyle}>閉じる</button>
          </div>
        </header>

        <div style={listStyle}>
          {notifications.length === 0 ? (
            <div style={emptyStyle}>通知はありません</div>
          ) : (
            notifications.map((notification) => {
              const unread = notification.read_at == null
              return (
                <button
                  key={notification.id}
                  onClick={() => onSelect(notification)}
                  style={itemStyle(unread)}
                >
                  <div style={itemHeaderStyle}>
                    <span style={itemTitleStyle}>{notification.title}</span>
                    {unread && <span style={unreadDotStyle} />}
                  </div>
                  <div style={itemBodyStyle}>{notification.body}</div>
                  <div style={metaStyle}>
                    <span>{notification.actor_name ?? 'システム'}</span>
                    <span>{formatDateTime(notification.created_at)}</span>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </section>
    </div>
  )
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  background: 'rgba(2, 6, 23, 0.52)',
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'flex-start',
  padding: '58px 18px 18px'
}

const panelStyle: React.CSSProperties = {
  width: 'min(420px, calc(100vw - 36px))',
  maxHeight: 'min(620px, calc(100vh - 76px))',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 16px',
  borderBottom: '1px solid #1e293b'
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  color: '#e2e8f0',
  lineHeight: 1.2
}

const subtitleStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: '0.74rem',
  color: '#94a3b8'
}

const listStyle: React.CSSProperties = {
  overflowY: 'auto',
  padding: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6
}

const emptyStyle: React.CSSProperties = {
  padding: '28px 12px',
  color: '#64748b',
  textAlign: 'center',
  fontSize: '0.86rem'
}

function itemStyle(unread: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: `1px solid ${unread ? '#2563eb' : '#1e293b'}`,
    background: unread ? '#172554' : '#111827',
    color: '#cbd5e1',
    borderRadius: 8,
    padding: '10px 12px',
    cursor: 'pointer'
  }
}

const itemHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0
}

const itemTitleStyle: React.CSSProperties = {
  color: '#e2e8f0',
  fontSize: '0.84rem',
  fontWeight: 700,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const unreadDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#38bdf8',
  flexShrink: 0,
  marginLeft: 'auto'
}

const itemBodyStyle: React.CSSProperties = {
  marginTop: 5,
  fontSize: '0.8rem',
  color: '#94a3b8',
  lineHeight: 1.45
}

const metaStyle: React.CSSProperties = {
  marginTop: 8,
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  color: '#64748b',
  fontSize: '0.72rem'
}

function buttonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 7,
    border: `1px solid ${enabled ? '#2563eb' : '#334155'}`,
    background: enabled ? '#1d4ed8' : '#1e293b',
    color: enabled ? '#eff6ff' : '#64748b',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}

const closeButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 7,
  border: '1px solid #334155',
  background: '#111827',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 700
}
