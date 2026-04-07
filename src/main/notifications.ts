import { Notification } from 'electron'
import { getAllTodos, getSetting } from './db'

export function checkDueNotifications(): void {
  let beforeDays: number
  try {
    const val = getSetting('notifyBeforeDays') ?? '0'
    beforeDays = parseInt(val, 10)
  } catch {
    return
  }
  if (isNaN(beforeDays) || beforeDays < 0) return

  const checkDate = new Date()
  checkDate.setDate(checkDate.getDate() + beforeDays)
  const checkStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`

  let todos: ReturnType<typeof getAllTodos>
  try {
    todos = getAllTodos()
  } catch {
    return
  }

  const dueTodos = todos.filter(
    (t) => t.status !== 'done' && t.status !== 'archived' && t.due_date?.startsWith(checkStr)
  )
  if (dueTodos.length === 0) return

  const label = beforeDays === 0 ? '今日が期限' : `${beforeDays}日後が期限`
  const body = dueTodos
    .slice(0, 5)
    .map((t) => `• ${t.title}`)
    .join('\n') + (dueTodos.length > 5 ? `\n他${dueTodos.length - 5}件` : '')

  new Notification({ title: `📋 ${label}のタスク (${dueTodos.length}件)`, body }).show()
}
