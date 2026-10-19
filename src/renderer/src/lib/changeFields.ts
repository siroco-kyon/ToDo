// タスクの変更履歴の項目名（詳細の変更履歴・進捗レポート・概要で共通。React に依存しない）
export const TODO_CHANGE_FIELD_LABELS: Record<string, string> = {
  title: 'タスク名',
  description: '説明',
  memo: 'メモ',
  category: 'カテゴリ',
  assignee: '担当',
  co_assignees: 'サブ担当',
  status: '状態',
  priority: '優先度',
  progress: '進捗',
  start_date: '開始日',
  due_date: '期限',
  recurrence: '繰り返し',
  recurrence_copy_subtasks: '繰り返しでサブタスクも作る',
  list_mode: '種類'
}

/** 変更した項目の名前。知らない項目はそのまま */
export function changeFieldLabel(field: string): string {
  return TODO_CHANGE_FIELD_LABELS[field] ?? field
}
