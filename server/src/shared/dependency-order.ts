interface DependencyEdge { predecessor_todo_id: string; successor_todo_id: string }

/** Calculate each reachable task only after every reachable predecessor. */
export function dependencyCascadeOrder(todoId: string, edges: DependencyEdge[]): string[] {
  const successors = new Map<string, string[]>()
  for (const edge of edges) {
    const list = successors.get(edge.predecessor_todo_id) ?? []
    list.push(edge.successor_todo_id)
    successors.set(edge.predecessor_todo_id, list)
  }
  const reachable = new Set([todoId])
  const pending = [todoId]
  for (let index = 0; index < pending.length; index++) {
    for (const next of successors.get(pending[index]) ?? []) {
      if (!reachable.has(next)) { reachable.add(next); pending.push(next) }
    }
  }
  const indegrees = new Map([...reachable].map((id) => [id, 0]))
  for (const edge of edges) {
    if (reachable.has(edge.predecessor_todo_id) && reachable.has(edge.successor_todo_id)) {
      indegrees.set(edge.successor_todo_id, indegrees.get(edge.successor_todo_id)! + 1)
    }
  }
  const ordered = [...reachable].filter((id) => indegrees.get(id) === 0)
  for (let index = 0; index < ordered.length; index++) {
    for (const next of successors.get(ordered[index]) ?? []) {
      const remaining = indegrees.get(next)! - 1
      indegrees.set(next, remaining)
      if (remaining === 0) ordered.push(next)
    }
  }
  if (ordered.length !== reachable.size) throw new Error('依存関係に循環があります。依存関係を見直してください')
  return ordered
}
