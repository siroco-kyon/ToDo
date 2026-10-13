import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunningState, Todo, WorkLogSummaryRow } from '@renderer/types'
import { useCurrentUser } from '../auth/UserContext'
import { useDesktopTask } from './useDesktopTask'
import { pickRecentTasks, readNotifiedMark, selectNewNotifications, toDesktopNotifications, writeNotifiedMark } from './desktopFeed'
import { api, stopDesktopTimer, subscribeConnection } from '../lib/client'
import { serverClockOffset } from '@renderer/lib/serverClock'
import type { DesktopTaskShortcut } from '../../src/shared/desktop'

const RECENT_LOG_DAYS = 14
// Due-date notifications are created when the list is read, so check again even without realtime events.
const NOTIFICATION_POLL_MS = 5 * 60 * 1000

/** Shows new team notifications as OS notifications and returns the unread count for the badge. */
function useDesktopNotifications(userId: string): number | undefined {
  const [unread, setUnread] = useState<number>()
  useEffect(() => {
    let disposed = false
    let queue = Promise.resolve()
    const check = (): void => {
      queue = queue.then(async () => {
        if (disposed) return
        const items = await api.notificationList()
        if (disposed) return
        // The list holds every unread notification, so it also gives the badge count.
        setUnread(items.filter((item) => item.read_at == null).length)
        const { show, next } = selectNewNotifications(items, readNotifiedMark(userId))
        writeNotifiedMark(userId, next)
        for (const notification of toDesktopNotifications(show)) await window.desktop?.notify?.(notification)
      }).catch((error) => console.error('[HAKOBI] 通知を確認できませんでした', error))
    }
    check()
    let wasConnected: boolean | null = null
    const unsubscribeConnection = subscribeConnection((connected) => {
      // Notifications created while the PC slept or the server was unreachable arrive on reconnect.
      if (connected && wasConnected === false) check()
      wasConnected = connected
    })
    const unsubscribeChanges = api.onNotificationsChanged(() => check())
    const interval = setInterval(check, NOTIFICATION_POLL_MS)
    return () => {
      disposed = true
      unsubscribeConnection()
      unsubscribeChanges()
      clearInterval(interval)
    }
  }, [userId])
  return unread
}

function useRecentTasks(userId: string, todos: Todo[], running: RunningState | null): DesktopTaskShortcut[] {
  const [logs, setLogs] = useState<WorkLogSummaryRow[]>([])
  // Starting or stopping the timer is what adds this user's work logs.
  useEffect(() => {
    let disposed = false
    void api.worklogGetSummary(RECENT_LOG_DAYS).then((rows) => { if (!disposed) setLogs(rows) })
      .catch((error) => console.error('[HAKOBI] 最近のタスクを読み込めませんでした', error))
    return () => { disposed = true }
  }, [userId, running?.todo_id, running?.start_time])
  return useMemo(() => pickRecentTasks({ userId, todos, logs, runningTodoId: running?.todo_id ?? null }),
    [userId, todos, logs, running?.todo_id])
}

/** The main window supplies the tray state even while hidden, and runs the tray's timer commands. */
export function DesktopCompanion(): null {
  const { user } = useCurrentUser()
  const { todos, running, connected, now, refresh } = useDesktopTask()
  const taskTitle = todos.find((todo) => todo.id === running?.todo_id)?.title ?? ''
  const unreadCount = useDesktopNotifications(user.id)
  const recentTasks = useRecentTasks(user.id, todos, running)
  const latest = useRef({ running, refresh })
  latest.current = { running, refresh }

  useEffect(() => {
    void window.desktop?.publishState({
      userId: user.id,
      taskId: running?.todo_id ?? null,
      taskTitle,
      startTime: running?.start_time ?? null,
      online: connected,
      clockOffsetMs: serverClockOffset(),
      recentTasks,
      unreadCount
    })
  }, [user.id, running?.todo_id, running?.start_time, taskTitle, connected, now, recentTasks, unreadCount])

  useEffect(() => {
    const bridge = window.desktop
    if (!bridge) return undefined
    const run = (action: () => Promise<unknown>, failure: string): void => {
      void action().catch((error) => {
        const reason = error instanceof Error && error.message ? error.message : 'サーバーに接続できません'
        void bridge.showError?.(`${failure}。${reason}`.slice(0, 500))
      }).finally(() => { void latest.current.refresh() })
    }
    return bridge.onCommand((command) => {
      if (command.type === 'timer-start') {
        run(() => api.timerStart(command.todoId), '計測を開始できませんでした')
      } else if (command.type === 'timer-stop') {
        // Stop only the timer the tray showed, so a timer switched on another PC keeps running.
        const current = latest.current.running
        if (current) run(() => stopDesktopTimer(user.id, current), '計測を停止できませんでした')
        else void latest.current.refresh()
      }
    })
  }, [user.id])
  return null
}
