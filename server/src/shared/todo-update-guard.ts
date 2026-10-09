const TODO_FIELDS: Record<string, string> = {
  title: 'タイトル', description: '説明', memo: 'メモ', category_id: 'カテゴリ',
  assignee_id: '担当者', co_assignee_ids: 'サブ担当', status: '状態',
  priority: '優先度', progress: '進捗', start_date: '開始日', due_date: '期限',
  recurrence: '繰り返し', recurrence_copy_subtasks: 'サブタスクの引き継ぎ',
  recurrence_skip_weekends: '土日の扱い', recurrence_skip_holidays: '祝日の扱い'
}
const SUBTASK_FIELDS: Record<string, string> = {
  title: 'サブタスク名', description: 'サブタスクの説明', assignee_id: '担当者',
  start_date: '開始日', due_date: '期限', progress: '進捗', done: '完了状態'
}

function canonical(field: string, value: unknown): unknown {
  if (field === 'co_assignee_ids') {
    if (value == null) return []
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new Error('更新前の担当者情報が不正です')
    return [...new Set(value)].sort()
  }
  if (field === 'done') return Boolean(value)
  if (field.startsWith('recurrence_')) return Number(value ?? 0)
  if (['title', 'description', 'memo'].includes(field)) return value ?? ''
  return value ?? null
}

/** Compare edited fields inside the same DB transaction as their update. */
export function assertExpectedValues(current: object, input: object, kind: 'todo' | 'subtask' = 'todo'): void {
  const update = input as Record<string, unknown>
  const expected = update.expected_values
  if (expected === undefined) return
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('更新前の情報が不正です。画面を開き直してください')
  const fields = kind === 'todo' ? TODO_FIELDS : SUBTASK_FIELDS
  const record = current as Record<string, unknown>
  for (const [field, value] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(fields, field) || update[field] === undefined) throw new Error('更新前の情報が不正です。画面を開き直してください')
    const actual = field === 'co_assignee_ids'
      ? ((record.co_assignees as Array<{ user_id: string }> | undefined) ?? []).map((item) => item.user_id)
      : record[field]
    if (JSON.stringify(canonical(field, actual)) !== JSON.stringify(canonical(field, value))) {
      throw new Error(`他のメンバーまたは別の画面で「${fields[field]}」が変更されています。入力をコピーしてから最新の内容を確認してください`)
    }
  }
}
