// 画面と開いているタスクを URL の検索部分（?view=gantt&task=<id>）に出すための計算。React に依存しない。
// ハッシュ（#gantt-only など）はほかの窓の判定に使っているので使わない

export const URL_VIEWS = ['detail', 'overview', 'log', 'progress', 'report', 'plan', 'gantt', 'team', 'kanban', 'todo'] as const
export type UrlView = typeof URL_VIEWS[number]

export interface UrlState {
  view: UrlView | null
  taskId: string | null
}

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

/** URL の検索部分から画面とタスクを読む。知らない画面や形のおかしい ID は無視する */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search)
  const view = params.get('view')
  const taskId = params.get('task')
  return {
    view: view && (URL_VIEWS as readonly string[]).includes(view) ? view as UrlView : null,
    taskId: taskId && TASK_ID_PATTERN.test(taskId) ? taskId : null
  }
}

/** 今の検索部分の view・task だけを置き換えた検索部分を作る（ほかのパラメーターは残す） */
export function buildUrlSearch(currentSearch: string, state: UrlState): string {
  const params = new URLSearchParams(currentSearch)
  params.delete('view')
  params.delete('task')
  if (state.view) params.set('view', state.view)
  if (state.taskId) params.set('task', state.taskId)
  const search = params.toString()
  return search ? `?${search}` : ''
}

/** チャットなどに貼れる、タスクの詳細を開く URL */
export function taskLinkFor(origin: string, pathname: string, taskId: string): string {
  return `${origin}${pathname}${buildUrlSearch('', { view: 'detail', taskId })}`
}
