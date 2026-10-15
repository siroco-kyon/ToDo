import React from 'react'
import type { PublicUser } from '../types'

interface Props {
  isTimerRunning: boolean
  onOpenQuickAdd: () => void
  onOpenProgressReport: () => void
  showArchived: boolean
  onToggleArchived: () => void
  onOpenSettings: () => void
  activeView: 'detail' | 'overview' | 'log' | 'progress' | 'report' | 'plan' | 'gantt' | 'team' | 'kanban' | 'todo'
  scopeLens: 'personal' | 'team'
  onSetScopeLens: (lens: 'personal' | 'team') => void
  /** 「集計から外す」カテゴリがあるときだけ、隠す／表示の切り替えを出す */
  showScopeLens?: boolean
  showPlanRail: boolean
  showCategoryPane: boolean
  showTaskPane: boolean
  showTeamButton?: boolean
  /** 「進捗」タブに出す新着の件数（前回見たあとにほかの人が書いた投稿・返信） */
  progressUnseenCount?: number
  /** ToDo タブに出す、今日やる項目のうちまだの数 */
  todoRemainingCount?: number
  onToggleTodoView: () => void
  /** サーバー版のログイン中ユーザー。デスクトップ版は null で何も表示しない */
  currentUser?: PublicUser | null
  notificationUnreadCount?: number
  onLogout?: () => void
  onOpenNotifications?: () => void
  onToggleLogView: () => void
  onToggleOverviewView: () => void
  onToggleProgressView: () => void
  onToggleReportView: () => void
  onTogglePlanView: () => void
  onToggleGanttView: () => void
  onToggleKanbanView: () => void
  onToggleTeamView: () => void
  onTogglePlanRail: () => void
  onToggleCategoryPane: () => void
  onToggleTaskPane: () => void
}

interface ViewButton {
  key: 'overview' | 'plan' | 'gantt' | 'kanban' | 'log' | 'progress' | 'report' | 'team' | 'todo'
  label: string
  /** 何をする画面かをホバーで出す */
  description: string
  active: boolean
  onClick: () => void
}

export function Toolbar({
  isTimerRunning,
  onOpenQuickAdd,
  onOpenProgressReport,
  showArchived,
  onToggleArchived,
  onOpenSettings,
  activeView,
  scopeLens,
  onSetScopeLens,
  showScopeLens = false,
  showPlanRail,
  showCategoryPane,
  showTaskPane,
  showTeamButton = false,
  progressUnseenCount = 0,
  todoRemainingCount = 0,
  onToggleTodoView,
  currentUser = null,
  notificationUnreadCount = 0,
  onLogout,
  onOpenNotifications,
  onToggleLogView,
  onToggleOverviewView,
  onToggleProgressView,
  onToggleReportView,
  onTogglePlanView,
  onToggleGanttView,
  onToggleKanbanView,
  onToggleTeamView,
  onTogglePlanRail,
  onToggleCategoryPane,
  onToggleTaskPane
}: Props): React.JSX.Element {
  const viewButtons: ViewButton[] = [
    { key: 'overview', label: '概要', description: '期限が近いタスクや最近の動きをまとめて表示します', active: activeView === 'overview', onClick: onToggleOverviewView },
    { key: 'gantt', label: 'ガント', description: '開始日から期限までを横棒で表示します。バーをドラッグすると日程を変えられます', active: activeView === 'gantt', onClick: onToggleGanttView },
    { key: 'kanban', label: 'カンバン', description: '未着手・進行中・保留中・完了の列に分けて表示します。カードを動かすと状態を変えられます', active: activeView === 'kanban', onClick: onToggleKanbanView },
    ...(showTeamButton ? [{ key: 'team' as const, label: 'チーム', description: '誰が何を計測中か、期限超過・期限が近いタスク、メンバーごとの件数を表示します', active: activeView === 'team', onClick: onToggleTeamView }] : []),
    { key: 'progress', label: '進捗', description: '進捗ログのタイムライン。投稿・返信・いいねができます', active: activeView === 'progress', onClick: onToggleProgressView },
    { key: 'report', label: '報告', description: '定例ミーティング用に、担当者ごとの進捗と報告の有無を並べて表示します', active: activeView === 'report', onClick: onToggleReportView },
    { key: 'plan', label: '計画', description: '1日の予定を時間割で組み立てられます', active: activeView === 'plan', onClick: onTogglePlanView },
    { key: 'todo', label: 'ToDo', description: 'ToDoリストの今日やることと項目をまとめて表示します。その場でチェックできます', active: activeView === 'todo', onClick: onToggleTodoView },
    { key: 'log', label: '記録', description: 'タイマーで計測した作業時間の記録を表示します', active: activeView === 'log', onClick: onToggleLogView }
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
        ＋ タスクを追加
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

        {showScopeLens && (
          <div style={groupStyle} title="「集計から外す」にしたカテゴリのタスクを、この画面だけで隠せます（ほかの人の画面には影響しません）">
            <button onClick={() => onSetScopeLens('personal')} aria-pressed={scopeLens === 'personal'} style={viewButtonStyle(scopeLens === 'personal')}>すべて表示</button>
            <button onClick={() => onSetScopeLens('team')} aria-pressed={scopeLens === 'team'} style={viewButtonStyle(scopeLens === 'team')}>集計外を隠す</button>
          </div>
        )}

        <div style={groupStyle} role="tablist" aria-label="画面の切り替え">
          {viewButtons.map((button) => (
            <button
              key={button.key}
              role="tab"
              aria-selected={button.active}
              onClick={button.onClick}
              title={button.key === 'progress' && progressUnseenCount > 0
                ? `${button.description}（新着 ${progressUnseenCount}件）`
                : button.key === 'todo' && todoRemainingCount > 0 ? `${button.description}（今日の残り ${todoRemainingCount}件）` : button.description}
              style={viewButtonStyle(button.active)}
            >
              {button.label}
              {button.key === 'progress' && progressUnseenCount > 0 && (
                <span aria-label={`新着 ${progressUnseenCount}件`} style={tabBadgeStyle}>{progressUnseenCount > 99 ? '99+' : progressUnseenCount}</span>
              )}
              {button.key === 'todo' && todoRemainingCount > 0 && (
                <span aria-label={`今日の残り ${todoRemainingCount}件`} style={todoBadgeStyle}>{todoRemainingCount > 99 ? '99+' : todoRemainingCount}</span>
              )}
            </button>
          ))}
        </div>

        <div style={groupStyle}>
          <button onClick={onToggleCategoryPane} aria-pressed={showCategoryPane} title="左のカテゴリ一覧を表示／非表示" style={utilityButtonStyle(showCategoryPane)}>
            カテゴリ
          </button>
          <button onClick={onToggleTaskPane} aria-pressed={showTaskPane} title="左のタスク一覧を表示／非表示" style={utilityButtonStyle(showTaskPane)}>
            タスク一覧
          </button>
          <button onClick={onTogglePlanRail} aria-pressed={showPlanRail} title="右側の「今日の予定」を表示／非表示" style={utilityButtonStyle(showPlanRail)}>
            今日の予定
          </button>
          <button onClick={onToggleArchived} aria-pressed={showArchived} title="アーカイブしたタスクも一覧に表示します" style={utilityButtonStyle(showArchived)}>
            {showArchived ? 'アーカイブ表示中' : 'アーカイブ'}
          </button>
          <button onClick={onOpenProgressReport} title="期間を指定して、進捗ログや作業時間をまとめます" style={utilityButtonStyle(false)}>進捗レポート</button>
          <button onClick={onOpenSettings} style={utilityButtonStyle(false)}>設定</button>
        </div>

        {currentUser && (
          <div style={groupStyle}>
            {onOpenNotifications && (
              <button onClick={onOpenNotifications} style={notificationButtonStyle(notificationUnreadCount > 0)}>
                通知
                {notificationUnreadCount > 0 && (
                  <span style={notificationBadgeStyle}>{notificationUnreadCount > 99 ? '99+' : notificationUnreadCount}</span>
                )}
              </button>
            )}
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

function notificationButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 30,
    padding: '6px 10px',
    background: active ? '#172554' : '#0f172a',
    border: `1px solid ${active ? '#2563eb' : '#334155'}`,
    borderRadius: 8,
    color: active ? '#dbeafe' : '#cbd5e1',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

const notificationBadgeStyle: React.CSSProperties = {
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 99,
  background: '#ef4444',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.68rem',
  lineHeight: 1,
  fontWeight: 800
}

const tabBadgeStyle: React.CSSProperties = {
  marginLeft: 5,
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 99,
  background: '#3b82f6',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.64rem',
  lineHeight: 1,
  fontWeight: 800,
  verticalAlign: 'middle'
}

// ToDo タブの残り。新着のような赤ではなく、落ち着いた色にする
const todoBadgeStyle: React.CSSProperties = {
  ...tabBadgeStyle,
  background: '#4338ca',
  color: '#e0e7ff'
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
