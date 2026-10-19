// 選択肢に出すタスクの名前（同じ名前の繰り返しの回などを見分けられるよう、期限と完了を添える）。React に依存しない
import type { Todo } from '../types'
import { formatShortDate } from './dueDate'

export function taskOptionLabel(todo: Pick<Todo, 'title' | 'due_date' | 'status'>): string {
  const due = todo.due_date ? `期限 ${formatShortDate(todo.due_date)}` : '期限なし'
  return todo.status === 'done' ? `${todo.title}（完了・${due}）` : `${todo.title}（${due}）`
}
