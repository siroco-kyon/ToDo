import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunningState, Todo } from '@renderer/types'
import type { DesktopContext } from '../../src/shared/desktop'
import { api, fetchDesktopTaskSnapshot, subscribeConnection } from '../lib/client'
import { useCurrentUser } from '../auth/UserContext'
import { serverNow, subscribeServerClock } from '@renderer/lib/serverClock'

export function useDesktopContext(): DesktopContext | null {
  const [context, setContext] = useState<DesktopContext | null>(null)
  useEffect(() => {
    const bridge = window.desktop
    if (!bridge) return
    let disposed = false
    void bridge.getContext().then((value) => { if (!disposed) setContext(value) }).catch(() => {})
    const unsubscribe = bridge.onCommand((command) => {
      if (command.type === 'preferences') {
        setContext((value) => value ? { ...value, preferences: command.preferences } : value)
      }
    })
    return () => { disposed = true; unsubscribe() }
  }, [])
  return context
}

export function useDesktopTask(): {
  todos: Todo[]
  running: RunningState | null
  connected: boolean
  loading: boolean
  error: string
  now: number
  refresh: () => Promise<void>
} {
  const { user } = useCurrentUser()
  const [todos, setTodos] = useState<Todo[]>([])
  const [running, setRunning] = useState<RunningState | null>(null)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(serverNow)
  const active = useRef(false)
  const revision = useRef(0)
  const requestController = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    const current = ++revision.current
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 10000)
    let abortListener: (() => void) | undefined
    try {
      const snapshot = await Promise.race([
        fetchDesktopTaskSnapshot(controller.signal),
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new Error(timedOut ? 'サーバーの応答を確認できません。再接続後に操作してください' : '読み込みを中止しました'))
          controller.signal.addEventListener('abort', abortListener, { once: true })
        })
      ])
      if (!active.current || current !== revision.current) return
      if (!snapshot.user || snapshot.user.id !== user.id) {
        if (active.current && current === revision.current) window.location.reload()
        return
      }
      setTodos(snapshot.todos)
      setRunning(snapshot.running)
      setError('')
    } catch (err) {
      if (active.current && current === revision.current) setError(err instanceof Error ? err.message : 'サーバーに接続できません')
    } finally {
      clearTimeout(timeout)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      if (requestController.current === controller) requestController.current = null
      if (active.current && current === revision.current) setLoading(false)
    }
  }, [user.id])
  useEffect(() => {
    active.current = true
    const onFocus = (): void => { void refresh() }
    void refresh()
    const unsubscribeData = api.onDataChanged((scope) => { if (scope === 'todo' || scope === 'category') void refresh() })
    const unsubscribeConnection = subscribeConnection((value) => { setConnected(value); if (value) onFocus() })
    const interval = setInterval(onFocus, 30000)
    window.addEventListener('focus', onFocus)
    return () => {
      active.current = false
      revision.current++
      requestController.current?.abort()
      unsubscribeData()
      unsubscribeConnection()
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])
  useEffect(() => {
    const tick = (): void => setNow(serverNow())
    tick()
    const unsubscribeClock = subscribeServerClock(tick)
    const interval = setInterval(tick, 1000)
    return () => { clearInterval(interval); unsubscribeClock() }
  }, [])
  return { todos, running, connected: connected && !error, loading, error, now, refresh }
}

export function elapsedTime(startTime: string | null, now: number): string {
  const seconds = startTime ? Math.max(0, Math.floor((now - Date.parse(startTime)) / 1000)) : 0
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}
