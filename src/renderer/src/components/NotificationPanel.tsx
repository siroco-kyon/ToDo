import React, { useEffect, useMemo, useState } from 'react'
import type { UserNotification } from '../types'

interface Props {
  notifications: UserNotification[]
  unreadCount: number
  onClose: () => void
  onSelect: (notification: UserNotification) => void
  onMarkAllRead: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

export function NotificationPanel({
  notifications,
  unreadCount,
  onClose,
  onSelect,
  onMarkAllRead,
  onShowToast
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<'unread' | 'all'>('unread')
  const [showSettings, setShowSettings] = useState(false)
  const [preferences, setPreferences] = useState<Record<string, boolean>>({})
  const visibleNotifications = useMemo(() => tab === 'unread'
    ? notifications.filter((notification) => notification.read_at == null)
    : notifications, [notifications, tab])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    void window.api.notificationPreferencesGet().then(setPreferences).catch((error) => {
      onShowToast(error instanceof Error ? error.message : '通知設定を読み込めませんでした', 'error')
    })
  }, [onShowToast])

  const updatePreference = async (type: string, enabled: boolean): Promise<void> => {
    const previous = preferences[type] !== false
    setPreferences((current) => ({ ...current, [type]: enabled }))
    try {
      await window.api.notificationPreferenceSet(type, enabled)
    } catch (error) {
      setPreferences((current) => ({ ...current, [type]: previous }))
      onShowToast(error instanceof Error ? error.message : '通知設定を保存できませんでした', 'error')
    }
  }

  return (
    <div style={backdropStyle} onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="notification-title" style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
        <header style={headerStyle}>
          <div>
            <h2 id="notification-title" style={titleStyle}>通知</h2>
            <div style={subtitleStyle}>未読 {unreadCount} 件</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onMarkAllRead} disabled={unreadCount === 0} style={buttonStyle(unreadCount > 0)}>
              すべて既読
            </button>
            <button onClick={() => setShowSettings((value) => !value)} style={closeButtonStyle}>通知設定</button>
            <button onClick={onClose} style={closeButtonStyle}>閉じる</button>
          </div>
        </header>

        <div style={{ display: 'flex', gap: 6, padding: '8px 10px 0' }}>
          <button onClick={() => setTab('unread')} style={buttonStyle(tab === 'unread')}>未読 {unreadCount}</button>
          <button onClick={() => setTab('all')} style={buttonStyle(tab === 'all')}>すべて</button>
        </div>
        {showSettings && <div style={{ margin: '8px 10px 0', padding: 10, borderRadius: 8, border: '1px solid var(--slate-700)', display: 'grid', gap: 6 }}>
          {([['task_assigned', '担当への追加'], ['progress_reply', '返信・購読更新'], ['progress_reaction', 'いいね'], ['mention', 'メンション'], ['task_due', '期限通知'], ['report_reminder', '報告のリマインド']] as const).map(([type, label]) => {
            const enabled = preferences[type] !== false
            return <label key={type} style={{ display: 'flex', gap: 7, alignItems: 'center', color: 'var(--slate-300)', fontSize: '0.76rem' }}><input type="checkbox" checked={enabled} onChange={(event) => { void updatePreference(type, event.target.checked) }} />{label}</label>
          })}
        </div>}

        <div style={listStyle}>
          {visibleNotifications.length === 0 ? (
            <div style={emptyStyle}>{tab === 'unread' ? '未読の通知はありません' : '通知履歴はありません'}</div>
          ) : (
            visibleNotifications.map((notification) => {
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
  background: 'color-mix(in srgb, var(--slate-950) 52%, transparent)',
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'flex-start',
  padding: '58px 18px 18px'
}

const panelStyle: React.CSSProperties = {
  width: 'min(420px, calc(100vw - 36px))',
  maxHeight: 'min(620px, calc(100vh - 76px))',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
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
  borderBottom: '1px solid var(--slate-800)'
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  color: 'var(--slate-200)',
  lineHeight: 1.2
}

const subtitleStyle: React.CSSProperties = {
  marginTop: 3,
  fontSize: '0.74rem',
  color: 'var(--slate-400)'
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
  color: 'var(--slate-500)',
  textAlign: 'center',
  fontSize: '0.86rem'
}

function itemStyle(unread: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: `1px solid ${unread ? 'var(--blue-600)' : 'var(--slate-800)'}`,
    background: unread ? 'var(--blue-950)' : 'var(--gray-900)',
    color: 'var(--slate-300)',
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
  color: 'var(--slate-200)',
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
  background: 'var(--sky-400)',
  flexShrink: 0,
  marginLeft: 'auto'
}

const itemBodyStyle: React.CSSProperties = {
  marginTop: 5,
  fontSize: '0.8rem',
  color: 'var(--slate-400)',
  lineHeight: 1.45
}

const metaStyle: React.CSSProperties = {
  marginTop: 8,
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  color: 'var(--slate-500)',
  fontSize: '0.72rem'
}

function buttonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 7,
    border: `1px solid ${enabled ? 'var(--blue-600)' : 'var(--slate-700)'}`,
    background: enabled ? 'var(--blue-700)' : 'var(--slate-800)',
    color: enabled ? 'var(--on-fill-blue-50)' : 'var(--slate-500)',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}

const closeButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 7,
  border: '1px solid var(--slate-700)',
  background: 'var(--gray-900)',
  color: 'var(--slate-300)',
  cursor: 'pointer',
  fontSize: '0.76rem',
  fontWeight: 700
}
