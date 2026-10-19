import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('タスクの繰り返し「毎年」を両モード共通のシナリオで検証する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yearly-recurrence-'))
  process.env.TODO_DATA_DIR = dir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const subtasks = await import('../src/db/subtasks')
  const recurrence = await import('../src/shared/todo-recurrence')
  connection.initDb()
  try {
    connection.getDb().prepare(`INSERT INTO Users
      (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES ('u1', 'u1', 'u1', 'hash', 'member', '#3b82f6', 1, ?, ?)`).run(new Date().toISOString(), new Date().toISOString())
    require('../../tests/yearly-recurrence-scenarios.cjs')({
      ...connection, ...todos, ...subtasks,
      installTodoRecurrenceConstraint: recurrence.installTodoRecurrenceConstraint,
      createTodo: (data: Parameters<typeof todos.createTodo>[0]) => todos.createTodo(data, 'u1'),
      createSubTask: (todoId: string, data: Parameters<typeof subtasks.createSubTask>[1]) => subtasks.createSubTask(todoId, data, 'u1'),
      updateTodo: (id: string, data: Parameters<typeof todos.updateTodo>[1]) => todos.updateTodo(id, data, 'u1')
    })
  } finally {
    connection.getDb().close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
