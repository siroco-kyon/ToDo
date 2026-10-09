const listeners = new Set<(todoId: string) => void>()
let queuedTarget: string | null = null

function deliver(todoId: string): void {
  if (!todoId) return
  if (!listeners.size) queuedTarget = todoId
  else for (const listener of [...listeners]) listener(todoId)
}

// Installed before AuthGate resolves. Reopening a loading window must not lose its target.
window.desktop?.onCommand((command) => {
  if (command.type === 'progress-target') deliver(command.todoId)
})
window.addEventListener('hashchange', () => {
  if (location.hash.split('?')[0] !== '#hakobi-progress') return
  const todoId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('todo')
  if (todoId) deliver(todoId)
})

export function subscribeProgressTarget(listener: (todoId: string) => void): () => void {
  listeners.add(listener)
  if (queuedTarget) { const target = queuedTarget; queuedTarget = null; listener(target) }
  return () => { listeners.delete(listener) }
}
