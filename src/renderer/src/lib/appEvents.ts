// 画面の部品のあいだで送る合図（window のイベント名）。React に依存しない

/** Ctrl+K の「進捗ログを書く」から、詳細の進捗ログの入力欄へフォーカスを移す合図 */
export const FOCUS_PROGRESS_LOG_EVENT = 'hakobi:focus-progress-log'

/** Ctrl+K でタスクを開いたとき、詳細の題名へフォーカスを移す合図（一覧やガントの行に残ったままにしない） */
export const FOCUS_TASK_DETAIL_EVENT = 'hakobi:focus-task-detail'
