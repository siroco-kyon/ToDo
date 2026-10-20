// 繰り返しタスクの完了を「元に戻す」で取り消したときの後始末（React に依存しない）。
// 完了にすると DB が次回分を作り、取り消しても次回分は残る（もう一度完了にしても増えない仕様）。
// 日付のない繰り返しでは同じ名前の行が2つ並んで見分けにくいので、知らせから次回分を片付けられるようにする。
// 消すのではなくアーカイブにして、知らせの「元に戻す」で戻せるようにする。
import type { Todo } from '../types'
import { formatShortDate } from './dueDate'
import { recurrenceKindLabel } from './recurrence'

type Toast = (message: string, type?: 'success' | 'error', action?: { label: string; run: () => void }) => void

/** 完了にした時刻（ISO）より後に作られた、同じ名前・同じ繰り返しの未完了のタスク（＝そのとき作られた次回分） */
export function findSpawnedNext(todos: Todo[], source: Pick<Todo, 'id' | 'title' | 'recurrence'>, completedAtIso: string): Todo | null {
  if (!recurrenceKindLabel(source.recurrence)) return null
  // 端末とサーバーの時計の差を見込んで、少し前から探す
  const since = new Date(new Date(completedAtIso).getTime() - 60_000).toISOString()
  return todos
    .filter((todo) => todo.id !== source.id && todo.title === source.title && todo.recurrence === source.recurrence
      && todo.status !== 'done' && todo.status !== 'archived' && todo.created_at >= since)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

/** 完了の取り消しのあとに出す知らせ。次回分が残っていれば、アーカイブする操作を付ける */
export async function notifyReopenedRecurrence(
  source: Pick<Todo, 'id' | 'title' | 'recurrence'>,
  completedAtIso: string,
  showToast: Toast,
  reload: () => Promise<unknown> | void
): Promise<void> {
  let spawned: Todo | null = null
  try {
    spawned = findSpawnedNext(await window.api.todoGetAll(), source, completedAtIso)
  } catch { /* 見つけられなくても取り消しの知らせは出す */ }
  if (!spawned) {
    showToast(`「${source.title}」の完了を取り消しました`)
    return
  }
  const next = spawned
  const when = next.start_date ? `開始 ${formatShortDate(next.start_date)}` : next.due_date ? `期限 ${formatShortDate(next.due_date)}` : '日付なし'
  showToast(`「${source.title}」の完了を取り消しました。作られた次回分（${when}）は残っています`, 'success', {
    label: '次回分をアーカイブ',
    run: () => {
      void window.api.todoArchive(next.id).then(
        async () => {
          await reload()
          showToast('次回分をアーカイブしました', 'success', {
            label: '元に戻す',
            run: () => { void window.api.todoUnarchive(next.id, next.status === 'archived' ? 'not_started' : next.status).then(() => reload()) }
          })
        },
        (error: unknown) => showToast(error instanceof Error ? error.message : '次回分をアーカイブできませんでした', 'error')
      )
    }
  })
}
