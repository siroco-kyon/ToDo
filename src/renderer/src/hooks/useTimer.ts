import { useState, useEffect, useRef, useCallback } from 'react'
import type { RunningState } from '../types'

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
}

export function useTimer(onStopped?: () => void): UseTimerReturn {
  const [state, setState] = useState<TimerState>({
    isRunning: false,
    runningTodoId: null,
    elapsedSeconds: 0,
    startTime: null
  })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const tick = useCallback((startTime: string) => {
    const elapsed = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000)
    setState((prev) => ({ ...prev, elapsedSeconds: elapsed }))
  }, [])

  const startInterval = useCallback(
    (startTime: string) => {
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
    return () => stopInterval()
  }, [stopInterval])

  const restore = useCallback(
    (running: RunningState) => {
      setState({
        isRunning: true,
        runningTodoId: running.todo_id,
        elapsedSeconds: Math.floor((Date.now() - new Date(running.start_time).getTime()) / 1000),
        startTime: running.start_time
      })
      startInterval(running.start_time)
    },
    [startInterval]
  )

  const start = useCallback(
    async (todoId: string) => {
      const running = await window.api.timerStart(todoId)
      setState({
        isRunning: true,
        runningTodoId: todoId,
        elapsedSeconds: 0,
        startTime: running.start_time
      })
      startInterval(running.start_time)
    },
    [startInterval]
  )

  const stop = useCallback(
    async (note?: string) => {
      await window.api.timerStop(note)
      stopInterval()
      setState({ isRunning: false, runningTodoId: null, elapsedSeconds: 0, startTime: null })
      onStopped?.()
    },
    [stopInterval, onStopped]
  )

  return { ...state, start, stop, restore }
}
