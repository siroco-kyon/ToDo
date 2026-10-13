import { useCallback, useEffect, useRef, useState } from 'react'
import { toDateKey } from '../lib/dueDate'
import { countUnseenActivity, readProgressSeenAt, subscribeProgressSeenAt, writeProgressSeenAt } from '../lib/progressActivity'
import { serverNow } from '../lib/serverClock'

// 上部の「進捗」タブに出す新着の件数。前回進捗タブを見たあとに、ほかの人が書いた投稿・返信を数える。
// 進捗タブを開いている間は 0（見ているので）。サーバー版でログインしているときだけ数える。

/** 長く開いていなかった人でも重くならないよう、さかのぼるのはこの日数まで */
const MAX_LOOKBACK_DAYS = 30

export function useProgressUnseenCount(userId: string | null, viewing: boolean, hiddenTodoIds: Set<string>): number {
  const [count, setCount] = useState(0)
  const requestRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current
    if (!userId || viewing) {
      setCount(0)
      return
    }
    const seenAt = readProgressSeenAt(userId)
    if (!seenAt) {
      // 初めてのときは、今までの投稿を新着にしない
      writeProgressSeenAt(userId, new Date(serverNow()).toISOString())
      setCount(0)
      return
    }
    const earliest = new Date()
    earliest.setDate(earliest.getDate() - (MAX_LOOKBACK_DAYS - 1))
    const seenDate = new Date(seenAt)
    const from = toDateKey(Number.isNaN(seenDate.getTime()) || seenDate < earliest ? earliest : seenDate)
    const to = toDateKey(new Date())
    try {
      const notes = await window.api.progressNoteGetTimeline(from > to ? to : from, to)
      if (request === requestRef.current) setCount(countUnseenActivity(notes, userId, seenAt, hiddenTodoIds))
    } catch {
      // 件数が出せなくても、ほかの操作には影響させない
    }
  }, [hiddenTodoIds, userId, viewing])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => window.api.onDataChanged((scope) => {
    if (scope === 'progress') void load()
  }), [load])

  useEffect(() => subscribeProgressSeenAt(() => void load()), [load])

  return count
}
