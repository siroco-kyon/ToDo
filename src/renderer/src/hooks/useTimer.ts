import { useState, useEffect, useRef, useCallback } from 'react'
import type { RunningState } from '../types'
import { serverNow, subscribeServerClock } from '../lib/serverClock'

interface TimerState {
  isRunning: boolean
  runningTodoId: string | null
  elapsedSeconds: number
  startTime: string | null
}

interface UseTimerReturn extends TimerState {
  start: (todoId: string) => Promise<void>
  stop: (note?: string) => Promise<void>
  restore: (running: RunningState) => void
  sync: () => Promise<void>
}

export function useTimer(onStopped?: () => void | Promise<void>): UseTimerReturn {
  const [state, setState] = useState<TimerState>({
    isRunning: false,
    runningTodoId: null,
    elapsedSeconds: 0,
    startTime: null
  })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const lifecycleRef = useRef(0)
  const mutationsRef = useRef(0)
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const syncNeededRef = useRef(false)

  const tick = useCallback((startTime: string) => {
    if (!mountedRef.current) return
    const elapsed = Math.max(0, Math.floor((serverNow() - new Date(startTime).getTime()) / 1000))
    setState((prev) => prev.isRunning && prev.startTime === startTime ? { ...prev, elapsedSeconds: elapsed } : prev)
  }, [])

  const startInterval = useCallback(
    (startTime: string) => {
      if (!mountedRef.current) return
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = setInterval(() => tick(startTime), 1000)
    },
    [tick]
  )

  const stopInterval = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleRef.current += 1
      generationRef.current += 1
      mutationsRef.current = 0
      mutationQueueRef.current = Promise.resolve()
      syncNeededRef.current = false
      stopInterval()
    }
  }, [stopInterval])

  useEffect(() => subscribeServerClock(() => {
    if (!mountedRef.current) return
    setState((prev) => prev.startTime ? {
      ...prev,
      elapsedSeconds: Math.max(0, Math.floor((serverNow() - Date.parse(prev.startTime)) / 1000))
    } : prev)
  }), [])

  const applyRunning = useCallback(
    (running: RunningState) => {
      if (!mountedRef.current) return
      setState({
        isRunning: true,
        runningTodoId: running.todo_id,
        elapsedSeconds: Math.max(0, Math.floor((serverNow() - new Date(running.start_time).getTime()) / 1000)),
        startTime: running.start_time
      })
      startInterval(running.start_time)
    },
    [startInterval]
  )

  const restore = useCallback((running: RunningState) => {
    generationRef.current += 1
    applyRunning(running)
  }, [applyRunning])

  const clearRunning = useCallback(() => {
    if (!mountedRef.current) return
    stopInterval()
    setState({ isRunning: false, runningTodoId: null, elapsedSeconds: 0, startTime: null })
  }, [stopInterval])

  const notifyStopped = useCallback(() => {
    try {
      void Promise.resolve(onStopped?.()).catch((error) => {
        console.error('[timer] 作業時間の更新を確認できませんでした', error)
      })
    } catch (error) {
      console.error('[timer] 作業時間の更新を確認できませんでした', error)
    }
  }, [onStopped])

  // 他ユーザーや別ウィンドウによる保留でDB側が停止した計測も反映する。
  const sync = useCallback(async () => {
    if (!mountedRef.current) return
    const generation = ++generationRef.current
    if (mutationsRef.current > 0) syncNeededRef.current = true
    try {
      const running = await window.api.timerGetRunning()
      if (!mountedRef.current || generation !== generationRef.current || mutationsRef.current > 0) return
      if (running) applyRunning(running)
      else clearRunning()
    } catch (error) {
      if (mountedRef.current && generation === generationRef.current) throw error
    }
  }, [applyRunning, clearRunning])

  // Preserve user command order even when HTTP or IPC responses are delayed.
  const enqueueMutation = useCallback((operation: (lifecycle: number) => Promise<void>): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve()
    const lifecycle = lifecycleRef.current
    generationRef.current += 1
    mutationsRef.current += 1
    const pending = mutationQueueRef.current.then(async () => {
      if (mountedRef.current && lifecycle === lifecycleRef.current) await operation(lifecycle)
    }).finally(() => {
      if (lifecycle !== lifecycleRef.current) return
      mutationsRef.current -= 1
      if (mountedRef.current && mutationsRef.current === 0 && syncNeededRef.current) {
        syncNeededRef.current = false
        // A different window's change during our mutation still needs a fresh read.
        void sync().catch((error) => console.error('[timer] 計測状態を更新できませんでした', error))
      }
    })
    mutationQueueRef.current = pending.catch(() => {})
    return pending
  }, [sync])

  const start = useCallback((todoId: string) => enqueueMutation(async (lifecycle) => {
    const running = await window.api.timerStart(todoId)
    if (!mountedRef.current || lifecycle !== lifecycleRef.current) return
    generationRef.current += 1
    applyRunning(running)
    // 別タスク開始時は DB 側が前のタイマーを自動停止し WorkLog を作るため、
    // 集計（今日の計画・作業ログ）を最新化する。
    notifyStopped()
  }), [applyRunning, enqueueMutation, notifyStopped])

  const stop = useCallback(
    (note?: string) => enqueueMutation(async (lifecycle) => {
      await window.api.timerStop(note)
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) return
      generationRef.current += 1
      clearRunning()
      notifyStopped()
    }),
    [clearRunning, enqueueMutation, notifyStopped]
  )

  return { ...state, start, stop, restore, sync }
}
