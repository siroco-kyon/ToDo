import React, { useEffect, useId, useRef, useState } from 'react'
import type { PublicUser } from '../types'
import { RunningTimerDisplay } from './TimerDisplay'
import { handleTablistKeyDown, tabStopIndex } from '../lib/tablistKeys'
import './Toolbar.css'

interface Props {
  isTimerRunning: boolean
  /** 計測中のタスク（名前と開始時刻）。押すとそのタスクを開き、■で止められる */
  runningTask?: { title: string; startTime: string | null } | null
  onOpenRunningTask?: () => void
  onStopTimer?: () => void
  onOpenQuickAdd: () => void
  onOpenProgressReport: () => void
  /** 使い方（はじめに）の案内を開く */
  onOpenGettingStarted?: () => void
  showArchived: boolean
  onToggleArchived: () => void
  onOpenSettings: () => void
  /** Ctrl+K の移動・操作のパレットを開く */
  onOpenCommandPalette?: () => void
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
  /** サーバー版のログイン中ユーザー。デスクトップ版は null で、名前の代わりに「メニュー」を出す */
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

interface MenuItem {
  key: string
  label: string
  /** ホバーで出す説明 */
  description?: string
  /** 切り替えの項目は true / false。押してもメニューを閉じない。undefined は押すと閉じる操作の項目 */
  checked?: boolean
  onSelect: () => void
}

interface MenuSection {
  key: string
  title?: string
  items: MenuItem[]
}

// 上部バーは1段に収める。画面の切り替えだけを並べ、パネルの表示やアカウントの操作はメニューにまとめる
export function Toolbar({
  isTimerRunning, runningTask = null, onOpenRunningTask, onStopTimer,
  onOpenQuickAdd,
  onOpenProgressReport,
  onOpenGettingStarted,
  showArchived,
  onToggleArchived,
  onOpenSettings,
  onOpenCommandPalette,
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

  const isGantt = activeView === 'gantt'
  const displaySections: MenuSection[] = [
    ...(showScopeLens ? [{
      key: 'lens',
      items: [{
        key: 'hide-private',
        label: '集計外のカテゴリを隠す',
        description: '「集計から外す」にしたカテゴリのタスクを、この画面だけで隠せます（ほかの人の画面には影響しません）',
        checked: scopeLens === 'team',
        onSelect: () => onSetScopeLens(scopeLens === 'team' ? 'personal' : 'team')
      }]
    }] : []),
    {
      key: 'panes',
      // ガントは横に広く使えるよう、パネルの開閉をほかの画面とは別に覚える
      title: isGantt ? 'パネル（ガントの画面）' : 'パネル',
      items: [
        { key: 'category', label: 'カテゴリ一覧', description: '左のカテゴリ一覧を表示／非表示', checked: showCategoryPane, onSelect: onToggleCategoryPane },
        { key: 'task', label: 'タスク一覧', description: '左のタスク一覧を表示／非表示', checked: showTaskPane, onSelect: onToggleTaskPane },
        { key: 'today', label: '今日の予定', description: '右側の「今日の予定」を表示／非表示', checked: showPlanRail, onSelect: onTogglePlanRail }
      ]
    },
    {
      key: 'archive',
      items: [{ key: 'archived', label: 'アーカイブしたタスクも表示', description: 'アーカイブしたタスクも一覧に表示します', checked: showArchived, onSelect: onToggleArchived }]
    }
  ]

  const accountSections: MenuSection[] = [{
    key: 'account',
    items: [
      { key: 'report', label: '進捗レポート', description: '期間を指定して、進捗ログや作業時間をまとめます', onSelect: onOpenProgressReport },
      { key: 'settings', label: '設定', onSelect: onOpenSettings },
      ...(onOpenGettingStarted ? [{ key: 'help', label: '使い方（はじめに）', description: '毎日することと、上のタブの使いみちをまとめています', onSelect: onOpenGettingStarted }] : []),
      ...(onLogout ? [{ key: 'logout', label: 'ログアウト', onSelect: onLogout }] : [])
    ]
  }]

  return (
    <div
      style={{
        position: 'relative',
        zIndex: 30,
        padding: '8px 16px',
        background: 'var(--slate-900)',
        borderBottom: '1px solid var(--slate-800)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap'
      }}
    >
      <button onClick={onOpenQuickAdd} aria-label="タスクを追加" title="タスクを追加" style={primaryButtonStyle}>
        ＋ <span className="hakobi-toolbar-wide-only">タスクを</span>追加
      </button>

      {/* タブは Tab では1回だけ止まり、← → で移って Enter で開く */}
      <div style={groupStyle} role="tablist" aria-label="画面の切り替え（← → で移って Enter で開く）" onKeyDown={(event) => handleTablistKeyDown(event)}>
        {viewButtons.map((button, index) => (
          <button
            key={button.key}
            role="tab"
            aria-selected={button.active}
            tabIndex={tabStopIndex(button.active, index, viewButtons.some((item) => item.active))}
            // 読み上げ名は見えている名前（音声で「ガント」と言っても押せるように）。説明はツールチップに
            aria-label={button.key === 'progress' && progressUnseenCount > 0
              ? `${button.label}（新着 ${progressUnseenCount}件）`
              : button.key === 'todo' && todoRemainingCount > 0 ? `${button.label}（今日の残り ${todoRemainingCount}件）` : button.label}
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
        {isTimerRunning && (
          <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: '0.74rem', color: 'var(--green-400)', background: 'var(--green-950)', border: '1px solid var(--green-900)', borderRadius: 999, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {runningTask && onOpenRunningTask ? (
              <button
                type="button"
                onClick={onOpenRunningTask}
                title={`計測中: ${runningTask.title}（押すとこのタスクを開きます）`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 10px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit', minHeight: 28 }}
              >
                <span aria-hidden="true">●</span>
                <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{runningTask.title}</span>
                <RunningTimerDisplay startTime={runningTask.startTime} />
              </button>
            ) : (
              <span style={{ padding: '5px 10px' }}>計測中</span>
            )}
            {onStopTimer && (
              <button
                type="button"
                onClick={onStopTimer}
                aria-label="計測を止める"
                title="計測を止める"
                style={{ alignSelf: 'stretch', minWidth: 30, padding: '0 9px', background: 'transparent', border: 'none', borderLeft: '1px solid var(--green-900)', color: 'inherit', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                ■
              </button>
            )}
          </span>
        )}

        {/* ふだんと違う表示にしているときだけ、外せる印を出す（メニューにしまうと気付けないため） */}
        {showScopeLens && scopeLens === 'team' && (
          <button onClick={() => onSetScopeLens('personal')} title="押すと集計外のカテゴリのタスクも表示します" style={stateChipStyle}>集計外を非表示 ×</button>
        )}
        {showArchived && (
          <button onClick={onToggleArchived} title="押すとアーカイブしたタスクを一覧から外します" style={stateChipStyle}>アーカイブを表示中 ×</button>
        )}

        {onOpenCommandPalette && (
          <button onClick={onOpenCommandPalette} title="タスクや画面を検索して移動します（Ctrl+K）" aria-label="移動・検索（Ctrl+K）" aria-keyshortcuts="Control+K" style={menuButtonStyle(false)}>
            🔍<span className="hakobi-toolbar-roomy-only"> 移動・検索</span><span className="hakobi-toolbar-search-label">検索</span>
            <span aria-hidden="true" className="hakobi-toolbar-wide-only" style={{ fontSize: '0.66rem', color: 'var(--slate-400)', border: '1px solid var(--slate-700)', borderRadius: 4, padding: '0 4px' }}>Ctrl+K</span>
          </button>
        )}

        <ToolbarMenu
          menuKey="display"
          label="表示"
          buttonContent="表示"
          title="パネルの表示や、アーカイブ・集計外のタスクを出すかを切り替えます"
          sections={displaySections}
          footer={isGantt ? 'ガントの画面では、ほかの画面とは別に開閉を覚えます' : undefined}
        />

        {currentUser && onOpenNotifications && (
          <button
            onClick={onOpenNotifications}
            aria-haspopup="dialog"
            aria-label={notificationUnreadCount > 0 ? `通知（未読 ${notificationUnreadCount}件）` : '通知'}
            style={notificationButtonStyle(notificationUnreadCount > 0)}
          >
            通知
            {notificationUnreadCount > 0 && (
              <span style={notificationBadgeStyle}>{notificationUnreadCount > 99 ? '99+' : notificationUnreadCount}</span>
            )}
          </button>
        )}

        <ToolbarMenu
          menuKey="account"
          label={currentUser ? `${currentUser.display_name}のメニュー` : 'メニュー'}
          title={currentUser ? `${currentUser.display_name}（${currentUser.username}）でログイン中。設定・進捗レポートはここから` : '設定・進捗レポートはここから'}
          buttonContent={currentUser ? (
            <>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: currentUser.color, flexShrink: 0 }} />
              {/* 狭いときは名前の代わりに歯車を出し、設定がここにあると分かるようにする */}
              <span aria-hidden="true" className="hakobi-toolbar-narrow-only">⚙</span>
              <span className="hakobi-toolbar-wide-only">{currentUser.display_name}</span>
              {currentUser.role === 'admin' && (
                <span className="hakobi-toolbar-wide-only" style={{ fontSize: '0.64rem', fontWeight: 700, color: 'var(--amber-400)', background: 'var(--amber-950)', borderRadius: 6, padding: '1px 6px' }}>管理者</span>
              )}
            </>
          ) : 'メニュー'}
          sections={accountSections}
          align="right"
        />
      </div>
    </div>
  )
}

// 上部バーのメニュー。外を押すか Esc で閉じ、↑↓ で項目を移れる
function ToolbarMenu({ menuKey, label, buttonContent, title, sections, footer, align = 'right' }: {
  menuKey: string
  label: string
  buttonContent: React.ReactNode
  title?: string
  sections: MenuSection[]
  footer?: string
  align?: 'left' | 'right'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next].focus()
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        data-toolbar-menu={menuKey}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={title}
        onClick={() => setOpen((previous) => !previous)}
        style={menuButtonStyle(open)}
      >
        {buttonContent}
        <span aria-hidden="true" style={{ fontSize: '0.62rem', color: 'var(--text-subtle)', marginLeft: 2 }}>▼</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={moveFocus}
          style={{ ...menuPopoverStyle, [align === 'right' ? 'right' : 'left']: 0 }}
        >
          {sections.map((section, sectionIndex) => (
            <div key={section.key} role="group" aria-label={section.title} style={{ borderTop: sectionIndex > 0 ? '1px solid var(--slate-800)' : 'none', paddingTop: sectionIndex > 0 ? 4 : 0, marginTop: sectionIndex > 0 ? 4 : 0 }}>
              {section.title && <div style={{ padding: '4px 10px 2px', fontSize: '0.7rem', fontWeight: 700, color: 'var(--slate-400)' }}>{section.title}</div>}
              {section.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={item.checked}
                  tabIndex={-1}
                  title={item.description}
                  className="hakobi-toolbar-menu-item"
                  onClick={() => {
                    // 小窓を開く項目は、先にメニューのボタンへフォーカスを戻す（小窓を閉じたらこのボタンへ戻る）
                    if (item.checked === undefined) buttonRef.current?.focus()
                    item.onSelect()
                    if (item.checked === undefined) setOpen(false)
                  }}
                >
                  {item.checked !== undefined && <span aria-hidden="true" className="hakobi-toolbar-menu-check">{item.checked ? '✓' : ''}</span>}
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          {footer && <div style={{ borderTop: '1px solid var(--slate-800)', marginTop: 4, padding: '6px 10px 2px', fontSize: '0.72rem', color: 'var(--slate-400)', lineHeight: 1.5 }}>{footer}</div>}
        </div>
      )}
    </div>
  )
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: 3,
  background: 'var(--gray-900)',
  border: '1px solid var(--gray-800)',
  borderRadius: 12,
  flexWrap: 'wrap'
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--blue-600)',
  border: '1px solid var(--blue-700)',
  borderRadius: 8,
  color: 'var(--on-fill-blue-50)',
  cursor: 'pointer',
  fontSize: '0.84rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

const menuPopoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  minWidth: 220,
  padding: 6,
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 10,
  boxShadow: '0 16px 40px color-mix(in srgb, var(--slate-950) 60%, transparent)',
  zIndex: 40
}

function menuButtonStyle(open: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    padding: '6px 10px',
    background: open ? 'var(--slate-800)' : 'transparent',
    border: `1px solid ${open ? 'var(--slate-600)' : 'var(--slate-700)'}`,
    borderRadius: 8,
    color: 'var(--slate-200)',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

const stateChipStyle: React.CSSProperties = {
  padding: '4px 9px',
  borderRadius: 999,
  border: '1px solid var(--indigo-600)',
  background: 'var(--indigo-950)',
  color: 'var(--indigo-200)',
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 700,
  whiteSpace: 'nowrap'
}

function notificationButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    padding: '6px 10px',
    background: active ? 'var(--blue-950)' : 'var(--slate-900)',
    border: `1px solid ${active ? 'var(--blue-600)' : 'var(--slate-700)'}`,
    borderRadius: 8,
    color: active ? 'var(--blue-100)' : 'var(--slate-300)',
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
  background: 'var(--red-500)',
  color: 'var(--on-fill-white)',
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
  background: 'var(--blue-500)',
  color: 'var(--on-fill-white)',
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
  background: 'var(--indigo-700)',
  color: 'var(--on-fill-indigo-100)'
}

function viewButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    background: active ? 'var(--blue-600)' : 'transparent',
    border: '1px solid transparent',
    borderRadius: 8,
    color: active ? 'var(--on-fill-blue-50)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}
