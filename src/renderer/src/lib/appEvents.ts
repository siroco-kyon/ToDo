// 画面の部品のあいだで送る合図（window のイベント名）。React に依存しない

/** Ctrl+K の「進捗ログを書く」から、詳細の進捗ログの入力欄へフォーカスを移す合図 */
export const FOCUS_PROGRESS_LOG_EVENT = 'hakobi:focus-progress-log'

/** Ctrl+K でタスクを開いたとき、詳細の題名へフォーカスを移す合図（一覧やガントの行に残ったままにしない） */
export const FOCUS_TASK_DETAIL_EVENT = 'hakobi:focus-task-detail'

// 開いたばかりの詳細は、合図を送った時点ではまだ描かれていないことがある（タスクごとに作り直すため）。
// 合図を少しのあいだ覚えておき、詳細が描かれたときに受け取れるようにする
let pendingTaskDetailFocusAt = 0

/** 詳細の題名へフォーカスを移すよう頼む（描かれていれば今、まだなら描かれたときに移る） */
export function requestTaskDetailFocus(): void {
  pendingTaskDetailFocusAt = Date.now()
  window.dispatchEvent(new CustomEvent(FOCUS_TASK_DETAIL_EVENT))
}

/** 2秒以内に頼まれていれば true を返し、頼みを消す */
export function consumeTaskDetailFocus(): boolean {
  const pending = pendingTaskDetailFocusAt > 0 && Date.now() - pendingTaskDetailFocusAt < 2000
  pendingTaskDetailFocusAt = 0
  return pending
}

/** Ctrl+K からガントの表示（日・週・月・年、カテゴリ別・担当者別）を切り替える合図。detail に変えたい値を入れる */
export const GANTT_VIEW_EVENT = 'hakobi:gantt-view'
export interface GanttViewRequest {
  timeScale?: 'day' | 'week' | 'month' | 'year'
  groupMode?: 'category' | 'assignee'
}
