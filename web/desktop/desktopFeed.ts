import type { Todo, UserNotification, WorkLogSummaryRow } from '@renderer/types'
import { DESKTOP_RECENT_TASK_LIMIT } from '../../src/shared/desktop'
import type { DesktopNotification, DesktopTaskShortcut } from '../../src/shared/desktop'

/** The newest notification time already handled, plus the IDs sharing that time. */
export interface NotifiedMark {
  watermark: string
  ids: string[]
}

const SUMMARY_THRESHOLD = 3
const NOTIFIED_KEY_PREFIX = 'hakobi-desktop-notified:'

/**
 * Picks unread notifications created since the last check. The first check on a PC only
 * records the backlog, so installing or reinstalling the app does not replay old notifications.
 */
export function selectNewNotifications(items: UserNotification[], previous: NotifiedMark | null): { show: UserNotification[]; next: NotifiedMark } {
  const watermark = items.reduce((max, item) => item.created_at > max ? item.created_at : max, previous?.watermark ?? '')
  const next = {
    watermark,
    ids: [...new Set([...(previous?.watermark === watermark ? previous.ids : []), ...items.filter((item) => item.created_at === watermark).map((item) => item.id)])]
  }
  if (!previous) return { show: [], next }
  const show = items
    .filter((item) => item.read_at == null && (item.created_at > previous.watermark || (item.created_at === previous.watermark && !previous.ids.includes(item.id))))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  return { show, next }
}

/** A burst (for example after sleep) becomes one summary instead of a stack of OS notifications. */
export function toDesktopNotifications(items: UserNotification[]): DesktopNotification[] {
  if (items.length > SUMMARY_THRESHOLD) {
    return [{
      title: `新しい通知が${items.length}件あります`,
      body: items.slice(-SUMMARY_THRESHOLD).reverse().map((item) => item.title).join('\n')
    }]
  }
  return items.map((item) => ({
    notificationId: item.id,
    title: item.title.slice(0, 200),
    body: (item.actor_name ? `${item.body}（${item.actor_name}）` : item.body).slice(0, 1000)
  }))
}

export function readNotifiedMark(userId: string): NotifiedMark | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(NOTIFIED_KEY_PREFIX + userId) ?? 'null') as NotifiedMark | null
    return value && typeof value.watermark === 'string' && Array.isArray(value.ids) ? value : null
  } catch {
    return null
  }
}

export function writeNotifiedMark(userId: string, mark: NotifiedMark): void {
  try {
    window.localStorage.setItem(NOTIFIED_KEY_PREFIX + userId, JSON.stringify(mark))
  } catch {
    // Without storage the next launch only re-records the backlog; it never replays it.
  }
}

const startable = (todo: Todo | undefined, runningTodoId: string | null): todo is Todo =>
  !!todo && (todo.status === 'not_started' || todo.status === 'active') && todo.id !== runningTodoId

/**
 * Tasks for the tray and taskbar: the ones this user timed most recently, then their own
 * tasks in progress, so a member without work logs can still start the timer natively.
 */
export function pickRecentTasks(input: {
  userId: string
  todos: Todo[]
  logs: Array<Pick<WorkLogSummaryRow, 'todo_id' | 'start_time'>>
  runningTodoId: string | null
}): DesktopTaskShortcut[] {
  const byId = new Map(input.todos.map((todo) => [todo.id, todo]))
  const picked: Todo[] = []
  const add = (todo: Todo | undefined): void => {
    if (startable(todo, input.runningTodoId) && !picked.includes(todo)) picked.push(todo)
  }
  for (const log of [...input.logs].sort((a, b) => b.start_time.localeCompare(a.start_time))) add(byId.get(log.todo_id))
  const mine = input.todos
    .filter((todo) => todo.status === 'active' && (todo.assignee_id === input.userId || todo.co_assignees?.some((assignee) => assignee.user_id === input.userId)))
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.sort_order - b.sort_order)
  for (const todo of mine) add(todo)
  return picked.slice(0, DESKTOP_RECENT_TASK_LIMIT).map((todo) => ({ id: todo.id, title: todo.title.slice(0, 200) }))
}
