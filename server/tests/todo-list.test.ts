import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('ToDoリストと周期で未チェックに戻る項目を両モード共通のシナリオで検証する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-list-'))
  process.env.TODO_DATA_DIR = dir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const subtasks = await import('../src/db/subtasks')
  connection.initDb()
  try {
    connection.getDb().prepare(`INSERT INTO Users
      (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES ('u1', 'u1', 'u1', 'hash', 'member', '#3b82f6', 1, ?, ?)`).run(new Date().toISOString(), new Date().toISOString())
    require('../../tests/todo-list-scenarios.cjs')({
      ...connection, ...todos, ...subtasks,
      createTodo: (data: Parameters<typeof todos.createTodo>[0]) => todos.createTodo(data, 'u1'),
      createSubTask: (todoId: string, data: Parameters<typeof subtasks.createSubTask>[1]) => subtasks.createSubTask(todoId, data, 'u1'),
      updateSubTask: (id: string, data: Parameters<typeof subtasks.updateSubTask>[1]) => subtasks.updateSubTask(id, data, 'u1'),
      updateTodo: (id: string, data: Parameters<typeof todos.updateTodo>[1]) => todos.updateTodo(id, data, 'u1')
    })
  } finally {
    connection.getDb().close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
