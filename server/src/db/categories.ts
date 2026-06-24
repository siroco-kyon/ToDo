import crypto from 'crypto'
import { getDb } from './connection'
import type { Category } from './types'

export function getAllCategories(): Category[] {
  return getDb()
    .prepare('SELECT * FROM Categories ORDER BY sort_order ASC, name ASC')
    .all() as Category[]
}

export function createCategory(name: string, color: string, isPrivate = false): Category {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO Categories (id, name, color, is_private, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, color, isPrivate ? 1 : 0, now)
  return getDb().prepare('SELECT * FROM Categories WHERE id = ?').get(id) as Category
}

export function updateCategory(id: string, name: string, color: string, description: string, isPrivate = false): Category {
  getDb()
    .prepare('UPDATE Categories SET name = ?, color = ?, description = ?, is_private = ? WHERE id = ?')
    .run(name, color, description, isPrivate ? 1 : 0, id)
  return getDb().prepare('SELECT * FROM Categories WHERE id = ?').get(id) as Category
}

export function deleteCategory(id: string): void {
  const db = getDb()
  db.prepare('UPDATE Todos SET category_id = NULL WHERE category_id = ?').run(id)
  db.prepare('DELETE FROM Categories WHERE id = ?').run(id)
}

export function reorderCategories(orderedIds: string[]): void {
  const db = getDb()
  const upd = db.prepare('UPDATE Categories SET sort_order = ? WHERE id = ?')
  db.transaction(() => { orderedIds.forEach((id, i) => upd.run(i, id)) })()
}
