import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('保留・再開・ログ保存・依存関係を両モード共通のシナリオで検証する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-hold-'))
  process.env.TODO_DATA_DIR = dir
  const connection = await import('../src/db/connection')
  const todos = await import('../src/db/todos')
  const subtasks = await import('../src/db/subtasks')
  const timer = await import('../src/db/timer')
  const logs = await import('../src/db/worklogs')
  const plan = await import('../src/db/plan')
  const team = await import('../src/db/team')
  connection.initDb()
  try {
    const insert = connection.getDb().prepare(`INSERT INTO Users
      (id, username, display_name, password_hash, role, color, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 'member', '#3b82f6', 1, ?, ?)`)
    for (const id of ['u1', 'u2']) insert.run(id, id, id, new Date().toISOString(), new Date().toISOString())
    require('../../tests/on-hold-scenarios.cjs')({
      ...connection, ...todos, ...subtasks, ...logs,
      createTodo: (data: Parameters<typeof todos.createTodo>[0]) => todos.createTodo(data, 'u1'),
      startTimer: (id: string) => timer.startTimer('u1', id),
      stopTimer: () => timer.stopTimer('u1'),
      getRunningState: () => timer.getRunningState('u1'),
      unarchiveTodo: (id: string, status: 'on_hold') => todos.unarchiveTodo(id, 'u1', status),
      addPlan: (id: string, date: string) => plan.addDailyPlanItem('u1', date, id),
      getPlan: (date: string) => plan.getDailyPlanItems('u1', date),
      reopen: () => { connection.getDb().close(); connection.initDb() }
    })

    const shared = todos.createTodo({ title: 'チームで保留', status: 'active', assignee_id: 'u1', due_date: '2026-01-01' }, 'u1')
    timer.startTimer('u1', shared.id)
    timer.startTimer('u2', shared.id)
    assert.throws(() => todos.updateTodo(shared.id, { status: 'on_hold', co_assignee_ids: ['missing-user'] }, 'u1'))
    assert.equal(todos.getTodoById(shared.id)?.status, 'active', '更新失敗時は状態とタイマー停止をまとめて取り消す')
    assert.equal(timer.getRunningState('u2')?.todo_id, shared.id)
    assert.equal(logs.getWorkLogsByTodo(shared.id).length, 0)
    todos.updateTodo(shared.id, { status: 'on_hold' }, 'u1')
    assert.equal(timer.getRunningState('u1'), undefined)
    assert.equal(timer.getRunningState('u2'), undefined)
    assert.deepEqual(new Set(logs.getWorkLogsByTodo(shared.id).map((log) => log.user_id)), new Set(['u1', 'u2']))
    assert.throws(() => timer.startTimer('u2', shared.id), /保留中/)
    assert.equal(team.getTeamNow().length, 0)
    const workload = team.getTeamWorkloads().find((item) => item.user_id === 'u1')!
    assert.equal(workload.on_hold_tasks, 1)
    assert.equal(team.getTeamDeadlines().overdue.find((item) => item.todo_id === shared.id)?.status, 'on_hold')
  } finally {
    connection.getDb().close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
