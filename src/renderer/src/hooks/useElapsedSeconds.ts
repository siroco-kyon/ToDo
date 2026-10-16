import { useEffect, useState } from 'react'
import { serverNow, subscribeServerClock } from '../lib/serverClock'

/** 計測を始めた時刻からの経過秒数（サーバーの時計で数える） */
export function elapsedSecondsSince(startTime: string | null): number {
  return startTime ? Math.max(0, Math.floor((serverNow() - Date.parse(startTime)) / 1000)) : 0
}

/**
 * 計測中の経過秒数。毎秒描き直すのは、これを呼んだ部品だけにする
 * （以前は App が毎秒描き直していて、計測中は一覧・ガントまで毎秒描き直していた）
 */
export function useElapsedSeconds(startTime: string | null): number {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!startTime) return
    const refresh = (): void => setTick((value) => value + 1)
    const interval = setInterval(refresh, 1000)
    // サーバーとの時計のずれを測り直したら、すぐに表示を合わせる
    const unsubscribe = subscribeServerClock(refresh)
    return () => {
      clearInterval(interval)
      unsubscribe()
    }
  }, [startTime])
  return elapsedSecondsSince(startTime)
}
