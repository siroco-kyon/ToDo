import { useState, useEffect, useRef, useCallback } from 'react'
import type { RunningState } from '../types'

// 経過秒数はここでは持たない。表示する部品が useElapsedSeconds(startTime) で数える
// （ここで毎秒 state を変えると、これを使う App 全体が毎秒描き直される）
interface TimerState {
  isRunning: boolean
  runningTodoId: string | null
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
    startTime: null
  })
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const lifecycleRef = useRef(0)
  const mutationsRef = useRef(0)
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const syncNeededRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleRef.current += 1
      generationRef.current += 1
      mutationsRef.current = 0
      mutationQueueRef.current = Promise.resolve()
      syncNeededRef.current = false
    }
  }, [])

  const applyRunning = useCallback((running: RunningState) => {
    if (!mountedRef.current) return
    // 同じ計測を読み直しただけなら state を変えない（App を描き直さない）
    setState((prev) => prev.isRunning && prev.runningTodoId === running.todo_id && prev.startTime === running.start_time
      ? prev
      : { isRunning: true, runningTodoId: running.todo_id, startTime: running.start_time })
  }, [])

  const restore = useCallback((running: RunningState) => {
    generationRef.current += 1
    applyRunning(running)
  }, [applyRunning])

  const clearRunning = useCallback(() => {
    if (!mountedRef.current) return
    setState((prev) => prev.isRunning ? { isRunning: false, runningTodoId: null, startTime: null } : prev)
  }, [])

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
