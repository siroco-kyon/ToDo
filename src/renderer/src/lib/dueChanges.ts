// 報告タブの「期間中に延期」の数え方（React に依存しない）。

interface DueChange {
  old_value: string | null
  new_value: string | null
}

/**
 * 期間中に期限を後ろへずらした回数。期間の終わりの期限が始めより後ろになったときだけ数える。
 * 動かしてから戻した（ガントの「1つ戻る」など）・前倒しで終わったものは延期にしない。
 * changes は古い順
 */
export function countPostponements(changes: readonly DueChange[]): number {
  const firstDue = changes[0]?.old_value?.slice(0, 10) ?? null
  const endDue = changes[changes.length - 1]?.new_value?.slice(0, 10) ?? null
  if (firstDue == null || endDue == null || endDue <= firstDue) return 0
  return changes.filter((change) =>
    change.old_value != null && change.new_value != null && change.new_value.slice(0, 10) > change.old_value.slice(0, 10)
  ).length
}
