import React, { useEffect, useRef, useState } from 'react'
import { useCurrentUser } from '../auth/UserContext'
import { stopDesktopTimer } from '../lib/client'
import { elapsedTime, useDesktopContext, useDesktopTask } from './useDesktopTask'
import './desktop.css'

export function TimerWindow(): React.JSX.Element {
  const { user } = useCurrentUser()
  const context = useDesktopContext()
  const { todos, running, now, connected, loading, error, refresh } = useDesktopTask()
  const [compact, setCompact] = useState(false)
  const [resizing, setResizing] = useState(false)
  const resizePending = useRef(false)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState('')
  const task = todos.find((todo) => todo.id === running?.todo_id)
  const title = !running ? '計測していません'
    : !context || context.preferences.hideTaskTitle ? '作業中のタスク'
      : task?.title ?? '作業中のタスク'
  useEffect(() => {
    if (typeof context?.preferences.timerCompact === 'boolean') setCompact(context.preferences.timerCompact)
  }, [context?.preferences.timerCompact])
  const toggleCompact = async (): Promise<void> => {
    if (!window.desktop || resizePending.current) return
    const next = !compact
    resizePending.current = true
    setResizing(true)
    setActionError('')
    try {
      await window.desktop.resizeTimer(next)
      setCompact(next)
    } catch {
      setActionError('表示サイズを変更できませんでした。もう一度お試しください。')
    } finally {
      resizePending.current = false
      setResizing(false)
    }
  }
  const stop = async (): Promise<void> => {
    if (!running || pending) return
    setPending(true)
    setActionError('')
    try { await stopDesktopTimer(user.id, running) }
    catch (err) { setActionError(err instanceof Error ? err.message : '計測を停止できませんでした') }
    finally { setPending(false); void refresh() }
  }
  return <div className={`hakobi-desktop timer-window ${compact ? 'compact' : ''}`}>
    <header>
      <span className="brand">HAKOBI <span className="group">{context?.groupName}</span></span>
      <div className="window-actions">
        <button title="最前面に固定" aria-label="最前面に固定" aria-pressed={context?.preferences.alwaysOnTop ?? false}
          onClick={() => { if (context) void window.desktop?.setPreferences({ alwaysOnTop: !context.preferences.alwaysOnTop }) }}>⌖</button>
        <button title={compact ? '展開' : 'コンパクト表示'} aria-label={compact ? '展開' : 'コンパクト表示'} disabled={!context || resizing} onClick={() => void toggleCompact()}>{compact ? '↗' : '−'}</button>
        <button title="タイマーを隠す" aria-label="タイマーを隠す" onClick={() => void window.desktop?.hideWindow()}>×</button>
      </div>
    </header>
    {compact ? <>
      <div className="task-title compact-task-title" title={title}>{loading ? '読み込み中…' : title}</div>
      <div className="compact-row">
        <span className={`status-dot ${connected ? 'online' : ''}`} title={connected ? '接続中' : '再接続中'} />
        <strong className="elapsed">{elapsedTime(running?.start_time ?? null, now)}</strong>
        <button disabled={!running} onClick={() => void window.desktop?.openQuickProgress(running?.todo_id)}>進捗を書く</button>
      </div>
      {(actionError || error) && <div className="message error" role="alert">{actionError || error}</div>}
    </> : <>
      <div className="task-title" title={title}>{loading ? '読み込み中…' : title}</div>
      <div className="timer-row"><strong className="elapsed">{elapsedTime(running?.start_time ?? null, now)}</strong>
        <span className={`connection ${connected ? 'online' : ''}`}>{connected ? '接続中' : '再接続中'}</span></div>
      <div className="primary-actions">
        <button className="primary" disabled={!running || !connected} onClick={() => void window.desktop?.openQuickProgress(running?.todo_id)}>進捗を書く</button>
        <button disabled={!running || pending || !connected} onClick={() => void stop()}>{pending ? '停止中…' : '停止'}</button>
        <button onClick={() => void window.desktop?.openMain(running?.todo_id)}>タスクを開く</button>
      </div>
      <div className="message" role="status">{actionError || error || (!running ? 'タスク画面から計測を開始できます' : `${user.display_name} の作業時間`)}</div>
    </>}
  </div>
}
