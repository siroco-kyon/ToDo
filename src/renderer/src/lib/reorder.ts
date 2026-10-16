// ドラッグでの並べ替えの計算（タスク詳細のサブタスク・ガントのサブタスク・ToDoリストの項目で共通）。React に依存しない

/** 落とす位置。相手の行の上半分なら前、下半分なら後ろ */
export type DropPosition = 'before' | 'after'

/** ドラッグ中のポインターの縦位置から、相手の行の前と後ろのどちらに置くかを決める */
export function dropPositionOf(clientY: number, rect: { top: number; height: number }): DropPosition {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** sourceId を targetId の前（後ろ）へ動かした並びを返す。並びが変わらないときは null */
export function moveIdTo(ids: string[], sourceId: string, targetId: string, position: DropPosition): string[] | null {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return null
  const rest = ids.filter((id) => id !== sourceId)
  const targetIndex = rest.indexOf(targetId)
  rest.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, sourceId)
  return rest.every((id, index) => id === ids[index]) ? null : rest
}

/**
 * 縦に並んだ行（上から順）のうち、ポインターの位置に対応する行と前後を返す。
 * 行の間のすき間や最後の行より下でも、近い行の前後として扱う（どこで離しても置ける）
 */
export function dropTargetAt(clientY: number, rows: Array<{ id: string; top: number; height: number }>): { id: string; position: DropPosition } | null {
  if (rows.length === 0) return null
  for (const row of rows) {
    if (clientY < row.top + row.height) return { id: row.id, position: dropPositionOf(clientY, row) }
  }
  return { id: rows[rows.length - 1].id, position: 'after' }
}

/** id を1つ前（-1）・1つ後ろ（1）へ動かした並びを返す。端で動かせないときは null */
export function moveIdBy(ids: string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return null
  const next = [...ids]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** 縦にスクロールできるいちばん近い親要素 */
export function scrollParentOf(element: Element | null): HTMLElement | null {
  let node = element?.parentElement ?? null
  while (node) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}

/** ドラッグ中にポインターが上下の端に近づいたら、その方向へ少しずつスクロールする（長いリストの先へ運べるように） */
export function autoScrollNearEdge(container: HTMLElement, clientY: number, edge = 48, step = 16): void {
  const rect = container.getBoundingClientRect()
  if (clientY < rect.top + edge) container.scrollTop -= step
  else if (clientY > rect.bottom - edge) container.scrollTop += step
}
