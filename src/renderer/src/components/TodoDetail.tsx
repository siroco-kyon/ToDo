import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Todo, WorkLog, SubTask, UpdateTodoInput, Category, CreateSubTaskInput, DailyPlanItem } from '../types'
import { TimerDisplay } from './TimerDisplay'

interface Props {
  todo: Todo | null
  categories: Category[]
  todayPlanItems: DailyPlanItem[]
  runningTodoId: string | null
  elapsedSeconds: number
  onUpdate: (id: string, data: UpdateTodoInput) => Promise<void>
  onStartTimer: (todoId: string) => Promise<void>
  onStopTimer: (note?: string) => Promise<void>
  onAddToTodayPlan: (todoId: string) => Promise<DailyPlanItem>
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

interface EditableSubTask {
  id: string
  title: string
  description: string
  start_date: string | null
  due_date: string | null
  done: boolean
}

export function TodoDetail({
  todo, categories, todayPlanItems, runningTodoId, elapsedSeconds,
  onUpdate, onStartTimer, onStopTimer, onAddToTodayPlan, onShowToast
}: Props): React.JSX.Element {
  const [logs, setLogs] = useState<WorkLog[]>([])
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState<UpdateTodoInput>({})
  const [editableSubTasks, setEditableSubTasks] = useState<EditableSubTask[]>([])
  const [stopNote, setStopNote] = useState('')
  const [localProgress, setLocalProgress] = useState<number | null>(null)
  const [newSubTask, setNewSubTask] = useState<CreateSubTaskInput>({ title: '', description: '', start_date: null, due_date: null })
  const isDragging = useRef(false)
  const progBarRef = useRef<HTMLDivElement>(null)

  const loadSubTasks = useCallback(async (todoId: string) => {
    try {
      const st = await window.api.subtaskGetByTodo(todoId)
      setSubTasks(st)
    } catch (e) {
      console.error('Failed to load subtasks', e)
    }
  }, [])

  const todoId = todo?.id

  const createEditData = useCallback((source: Todo): UpdateTodoInput => ({
    title: source.title,
    description: source.description,
    category_id: source.category_id,
    status: source.status,
    priority: source.priority,
    progress: source.progress,
    start_date: source.start_date ?? undefined,
    due_date: source.due_date ?? undefined,
    recurrence: source.recurrence ?? undefined
  }), [])

  const createEditableSubTasks = useCallback((items: SubTask[]): EditableSubTask[] => (
    items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? '',
      start_date: item.start_date ?? null,
      due_date: item.due_date ?? null,
      done: Boolean(item.done)
    }))
  ), [])

  // todo が切り替わったときだけ編集状態をリセット
  useEffect(() => {
    if (!todoId || !todo) { setSubTasks([]); setLogs([]); return }
    setEditing(false)
    setEditData(createEditData(todo))
    window.api.worklogGetByTodo(todoId).then(setLogs).catch(console.error)
    loadSubTasks(todoId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoId, loadSubTasks, createEditData])

  useEffect(() => {
    if (!editing) {
      setEditableSubTasks(createEditableSubTasks(subTasks))
    }
  }, [subTasks, editing, createEditableSubTasks])

  useEffect(() => {
    if (!todoId) return

    const unsubscribe = window.api.onDataChanged((scope) => {
      if (scope !== 'subtask') return
      void loadSubTasks(todoId)
    })

    return () => unsubscribe()
  }, [loadSubTasks, todoId])

  // ─── 進捗バードラッグ ─────────────────────────────────────────
  // ※ Rules of Hooks: useCallback は条件分岐の前に定義する
  const calcProgress = useCallback((clientX: number): number => {
    if (!progBarRef.current) return 0
    const rect = progBarRef.current.getBoundingClientRect()
    const raw = ((clientX - rect.left) / rect.width) * 100
    return Math.min(100, Math.max(0, Math.round(raw / 5) * 5))
  }, [])

  const handleProgMouseDown = useCallback((e: React.MouseEvent): void => {
    if (!todoId) return
    e.preventDefault()
    isDragging.current = true
    setLocalProgress(calcProgress(e.clientX))
    const onMove = (ev: MouseEvent): void => { if (isDragging.current) setLocalProgress(calcProgress(ev.clientX)) }
    const onUp = (ev: MouseEvent): void => {
      isDragging.current = false
      const prog = calcProgress(ev.clientX)
      setLocalProgress(null)
      onUpdate(todoId, { progress: prog })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [todoId, calcProgress, onUpdate])

  // ─── 条件分岐 return（フックはすべて上で定義済み）────────────
  if (!todo) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#475569' }}>
        タスクを選択してください
      </div>
    )
  }

  const isRunning = runningTodoId === todo.id
  const isInTodayPlan = todayPlanItems.some((item) => item.todo_id === todo.id)
  const totalSecs = logs.reduce((s, l) => s + l.duration_seconds, 0) + (isRunning ? elapsedSeconds : 0)
  const totalMins = Math.round(totalSecs / 60)
  const startEditing = (): void => {
    setEditData(createEditData(todo))
    setEditableSubTasks(createEditableSubTasks(subTasks))
    setEditing(true)
  }

  const cancelEditing = (): void => {
    setEditData(createEditData(todo))
    setEditableSubTasks(createEditableSubTasks(subTasks))
    setEditing(false)
  }

  // ─── 編集保存 ────────────────────────────────────────────────
  const handleSave = async (): Promise<void> => {
    const invalidSubTask = editableSubTasks.some((subTask) => !subTask.title.trim())
    if (invalidSubTask) {
      onShowToast('サブタスク名は空にできません', 'error')
      return
    }

    const invalidSubTaskRange = editableSubTasks.some((subTask) => (
      subTask.start_date && subTask.due_date && subTask.start_date > subTask.due_date
    ))
    if (invalidSubTaskRange) {
      onShowToast('サブタスクの開始日は期限以前に設定してください', 'error')
      return
    }

    if (editData.start_date && editData.due_date && editData.start_date > editData.due_date) {
      onShowToast('開始日は期限以前に設定してください', 'error')
      return
    }

    const changedSubTasks = editableSubTasks.filter((draft) => {
      const current = subTasks.find((subTask) => subTask.id === draft.id)
      if (!current) return false
      return current.title !== draft.title.trim()
        || (current.description ?? '') !== draft.description.trim()
        || (current.start_date ?? null) !== (draft.start_date ?? null)
        || (current.due_date ?? null) !== (draft.due_date ?? null)
        || Boolean(current.done) !== draft.done
    })

    await onUpdate(todo.id, editData)
    await Promise.all(
      changedSubTasks.map((subTask) => window.api.subtaskUpdate(subTask.id, {
        title: subTask.title.trim(),
        description: subTask.description.trim(),
        start_date: subTask.start_date ?? null,
        due_date: subTask.due_date ?? null,
        done: subTask.done
      }))
    )
    await loadSubTasks(todo.id)
    setEditing(false)
    onShowToast('保存しました')
  }

  // ─── タイマー停止 ────────────────────────────────────────────
  const handleStop = async (): Promise<void> => {
    await onStopTimer(stopNote || undefined)
    setStopNote('')
    onShowToast('タイマーを停止しました')
    const updated = await window.api.worklogGetByTodo(todo.id)
    setLogs(updated)
  }

  // ─── サブタスク ──────────────────────────────────────────────
  const handleAddSubTask = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const title = newSubTask.title.trim()
    if (!title) return
    if (newSubTask.start_date && newSubTask.due_date && newSubTask.start_date > newSubTask.due_date) {
      onShowToast('サブタスクの開始日は期限以前に設定してください', 'error')
      return
    }
    const created = await window.api.subtaskCreate(todo.id, {
      title,
      description: newSubTask.description?.trim() ?? '',
      start_date: newSubTask.start_date ?? null,
      due_date: newSubTask.due_date ?? null
    })
    setNewSubTask({ title: '', description: '', start_date: null, due_date: null })
    setSubTasks((prev) => [...prev, created])
    if (editing) {
      setEditableSubTasks((prev) => [...prev, {
        id: created.id,
        title: created.title,
        description: created.description ?? '',
        start_date: created.start_date ?? null,
        due_date: created.due_date ?? null,
        done: Boolean(created.done)
      }])
    }
  }

  const handleToggleSubTask = async (st: SubTask): Promise<void> => {
    const updated = await window.api.subtaskUpdate(st.id, { done: !st.done })
    setSubTasks((prev) => prev.map((subTask) => subTask.id === updated.id ? updated : subTask))
  }

  const handleDeleteSubTask = async (id: string): Promise<void> => {
    await window.api.subtaskDelete(id)
    setSubTasks((prev) => prev.filter((subTask) => subTask.id !== id))
    setEditableSubTasks((prev) => prev.filter((subTask) => subTask.id !== id))
  }

  const handleEditSubTask = (id: string, data: Partial<EditableSubTask>): void => {
    setEditableSubTasks((prev) => prev.map((subTask) => (
      subTask.id === id ? { ...subTask, ...data } : subTask
    )))
  }

  const doneCount = subTasks.filter((s) => s.done).length
  const subTaskProgress = subTasks.length > 0 ? Math.round((doneCount / subTasks.length) * 100) : null
  const displayProg = localProgress ?? todo.progress ?? 0

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}>
          {editing ? (
            <input value={editData.title ?? ''} onChange={(e) => setEditData((d) => ({ ...d, title: e.target.value }))} style={inputStyle} />
          ) : (
            <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', lineHeight: 1.4 }}>
              {todo.title}
              {todo.recurrence && (
                <span style={{ marginLeft: 8, fontSize: '0.75rem', color: '#818cf8' }}>
                  🔁 {todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : '毎月'}
                </span>
              )}
            </h2>
          )}
        </div>
        {!editing && todo.status === 'active' && (
          <button
            onClick={() => onAddToTodayPlan(todo.id)}
            disabled={isInTodayPlan}
            style={smallBtnStyle(isInTodayPlan ? '#1e293b' : '#2563eb', isInTodayPlan ? '#64748b' : '#dbeafe')}
          >
            {isInTodayPlan ? '計画追加済み' : '今日の計画に追加'}
          </button>
        )}
        <button onClick={editing ? cancelEditing : startEditing} style={smallBtnStyle('#334155')}>
          {editing ? '×' : '編集'}
        </button>
      </div>

      {/* タイマー */}
      {!editing && (todo.start_date || todo.due_date) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {todo.start_date && (
            <div style={dateBadgeStyle('#0f172a', '#93c5fd')}>
              開始 {todo.start_date}
            </div>
          )}
          {todo.due_date && (
            <div style={dateBadgeStyle('#0f172a', '#fbbf24')}>
              期限 {todo.due_date}
            </div>
          )}
        </div>
      )}

      <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 4 }}>経過時間</div>
          <TimerDisplay elapsedSeconds={isRunning ? elapsedSeconds : 0} isRunning={isRunning} />
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>合計: {totalMins}分</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {isRunning ? (
            <>
              <input value={stopNote} onChange={(e) => setStopNote(e.target.value)} placeholder="メモ(任意)"
                style={{ ...inputStyle, width: 140, fontSize: '0.8rem', padding: '6px 8px' }} />
              <button onClick={handleStop} style={smallBtnStyle('#ef4444')}>停止</button>
            </>
          ) : (
            <button onClick={() => onStartTimer(todo.id)} style={smallBtnStyle('#4ade80', '#000')}>開始</button>
          )}
        </div>
      </div>

      {/* 編集フォーム */}
      {editing && (
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={labelStyle}>説明</label>
            <textarea value={editData.description ?? ''} onChange={(e) => setEditData((d) => ({ ...d, description: e.target.value }))}
              rows={4} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div>
            <label style={labelStyle}>開始日</label>
            <input
              type="date"
              value={editData.start_date?.slice(0, 10) ?? ''}
              onChange={(e) => setEditData((d) => ({ ...d, start_date: e.target.value || null }))}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>カテゴリ</label>
              <select value={editData.category_id ?? ''} onChange={(e) => setEditData((d) => ({ ...d, category_id: e.target.value || null }))} style={inputStyle}>
                <option value="">なし</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>優先度</label>
              <select value={editData.priority ?? 3} onChange={(e) => setEditData((d) => ({ ...d, priority: Number(e.target.value) }))} style={inputStyle}>
                <option value={1}>最低</option>
                <option value={2}>低</option>
                <option value={3}>中</option>
                <option value={4}>高</option>
                <option value={5}>緊急</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>期限</label>
              <input type="date" value={editData.due_date?.slice(0, 10) ?? ''}
                onChange={(e) => setEditData((d) => ({ ...d, due_date: e.target.value || null }))} style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>繰り返し</label>
              <select value={editData.recurrence ?? ''}
                onChange={(e) => setEditData((d) => ({ ...d, recurrence: (e.target.value || null) as 'daily' | 'weekly' | 'monthly' | null }))}
                style={inputStyle}>
                <option value="">なし</option>
                <option value="daily">毎日</option>
                <option value="weekly">毎週</option>
                <option value="monthly">毎月</option>
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle}>状態</label>
            <select value={editData.status ?? 'active'}
              onChange={(e) => setEditData((d) => ({ ...d, status: e.target.value as 'active' | 'done' | 'archived' }))} style={inputStyle}>
              <option value="active">進行中</option>
              <option value="done">完了</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>進捗 — {editData.progress ?? 0}%</label>
            <input type="range" min={0} max={100} step={5} value={editData.progress ?? 0}
              onChange={(e) => setEditData((d) => ({ ...d, progress: Number(e.target.value) }))}
              style={{ width: '100%', accentColor: '#6366f1' }} />
          </div>
          <button onClick={handleSave} style={{ ...smallBtnStyle('#6366f1'), alignSelf: 'flex-end', padding: '8px 20px' }}>保存</button>
        </div>
      )}

      {/* 進捗バー */}
      {!editing && (
        <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>進捗 <span style={{ color: '#334155', fontSize: '0.68rem' }}>← ドラッグで変更</span></span>
            <span style={{ fontSize: '0.75rem', color: progressColor(displayProg), fontWeight: 'bold' }}>{displayProg}%</span>
          </div>
          <div ref={progBarRef} onMouseDown={handleProgMouseDown}
            style={{ height: 10, background: '#0f172a', borderRadius: 99, cursor: 'ew-resize', userSelect: 'none' }}>
            <div style={{ height: '100%', width: `${displayProg}%`, background: progressColor(displayProg), borderRadius: 99, transition: isDragging.current ? 'none' : 'width 0.3s', pointerEvents: 'none' }} />
          </div>
          {subTaskProgress !== null && (
            <div style={{ marginTop: 8, fontSize: '0.72rem', color: '#64748b' }}>
              サブタスク: {doneCount}/{subTasks.length} 完了
              <div style={{ height: 4, background: '#0f172a', borderRadius: 99, marginTop: 4 }}>
                <div style={{ height: '100%', width: `${subTaskProgress}%`, background: '#6366f1', borderRadius: 99, transition: 'width 0.3s' }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* サブタスク */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          サブタスク {subTasks.length > 0 && `(${doneCount}/${subTasks.length})`}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
          {editing ? (
            editableSubTasks.map((st) => (
              <EditableSubTaskRow
                key={st.id}
                subTask={st}
                onChange={(data) => handleEditSubTask(st.id, data)}
                onDelete={() => handleDeleteSubTask(st.id)}
              />
            ))
          ) : (
            subTasks.map((st) => (
              <SubTaskRow key={st.id} subTask={st} onToggle={() => handleToggleSubTask(st)} onDelete={() => handleDeleteSubTask(st.id)} />
            ))
          )}
        </div>
        <form onSubmit={handleAddSubTask} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            value={newSubTask.title}
            onChange={(e) => setNewSubTask((prev) => ({ ...prev, title: e.target.value }))}
            placeholder="＋ サブタスクを追加..."
            style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }}
          />
          <textarea
            value={newSubTask.description ?? ''}
            onChange={(e) => setNewSubTask((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="説明文..."
            rows={2}
            style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div>
              <div style={subTaskDateLabelStyle}>開始日</div>
              <input
                type="date"
                value={newSubTask.start_date ?? ''}
                onChange={(e) => setNewSubTask((prev) => ({ ...prev, start_date: e.target.value || null }))}
                style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }}
              />
            </div>
            <div>
              <div style={subTaskDateLabelStyle}>期限</div>
              <input
                type="date"
                value={newSubTask.due_date ?? ''}
                onChange={(e) => setNewSubTask((prev) => ({ ...prev, due_date: e.target.value || null }))}
                style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }}
              />
            </div>
          </div>
          <button type="submit" style={{ ...smallBtnStyle('#6366f1'), padding: '6px 12px', fontSize: '0.8rem' }}>追加</button>
        </form>
      </div>

      {/* 説明 */}
      {!editing && todo.description && (
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 14, fontSize: '0.9rem', color: '#94a3b8', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {todo.description}
        </div>
      )}

      {/* 作業ログ */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          作業ログ
        </div>
        {logs.length === 0 ? (
          <div style={{ color: '#475569', fontSize: '0.85rem' }}>ログなし</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {logs.map((log) => {
              const s = new Date(log.start_time)
              const e = new Date(log.end_time)
              const mins = Math.round(log.duration_seconds / 60)
              return (
                <div key={log.id} style={{ background: '#1e293b', borderRadius: 6, padding: '8px 12px', fontSize: '0.82rem', color: '#94a3b8' }}>
                  <span style={{ color: '#e2e8f0' }}>{formatTime(s)} ～ {formatTime(e)}</span>
                  <span style={{ marginLeft: 8, color: '#4ade80' }}>{mins}分</span>
                  {log.note && <span style={{ marginLeft: 8 }}>— {log.note}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function EditableSubTaskRow({
  subTask,
  onChange,
  onDelete
}: {
  subTask: EditableSubTask
  onChange: (data: Partial<EditableSubTask>) => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#1e293b' }}>
      <button
        onClick={() => onChange({ done: !subTask.done })}
        style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0, marginTop: 8,
          border: `2px solid ${subTask.done ? '#4ade80' : '#475569'}`,
          background: subTask.done ? '#4ade80' : 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >
        {subTask.done ? <span style={{ fontSize: 9, color: '#0f172a', fontWeight: 'bold' }}>✓</span> : null}
      </button>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          value={subTask.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="サブタスク名"
          style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }}
        />
        <textarea
          value={subTask.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="説明文..."
          rows={2}
          style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <div>
            <div style={subTaskDateLabelStyle}>開始日</div>
            <input
              type="date"
              value={subTask.start_date ?? ''}
              onChange={(e) => onChange({ start_date: e.target.value || null })}
              style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }}
            />
          </div>
          <div>
            <div style={subTaskDateLabelStyle}>期限</div>
            <input
              type="date"
              value={subTask.due_date ?? ''}
              onChange={(e) => onChange({ due_date: e.target.value || null })}
              style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }}
            />
          </div>
        </div>
      </div>
      <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.75rem', padding: '6px 2px' }}>✕</button>
    </div>
  )
}

function SubTaskRow({ subTask, onToggle, onDelete }: { subTask: SubTask; onToggle: () => void; onDelete: () => void }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, background: hovered ? '#1e293b' : 'transparent' }}
    >
      <button
        onClick={onToggle}
        style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
          border: `2px solid ${subTask.done ? '#4ade80' : '#475569'}`,
          background: subTask.done ? '#4ade80' : 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}
      >
        {subTask.done ? <span style={{ fontSize: 9, color: '#0f172a', fontWeight: 'bold' }}>✓</span> : null}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', color: subTask.done ? '#475569' : '#cbd5e1', textDecoration: subTask.done ? 'line-through' : 'none' }}>
          {subTask.title}
        </div>
        {(subTask.start_date || subTask.due_date) && (
          <div style={{
            marginTop: 4,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 6px',
            borderRadius: 999,
            fontSize: '0.68rem',
            color: dueDateColor(subTask.due_date ?? subTask.start_date!, Boolean(subTask.done)),
            background: dueDateBg(subTask.due_date ?? subTask.start_date!, Boolean(subTask.done))
          }}>
            {formatSubTaskDateRange(subTask.start_date, subTask.due_date)}
          </div>
        )}
        {subTask.done && subTask.completed_at && (
          <div style={{
            marginTop: 4,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 6px',
            borderRadius: 999,
            fontSize: '0.68rem',
            color: '#86efac',
            background: '#052e16'
          }}>
            完了 {formatDateTime(subTask.completed_at)}
          </div>
        )}
        {subTask.description && (
          <div style={{ marginTop: 2, fontSize: '0.75rem', color: subTask.done ? '#334155' : '#64748b', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
            {subTask.description}
          </div>
        )}
      </div>
      {hovered && (
        <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.75rem', padding: '0 2px' }}>✕</button>
      )}
    </div>
  )
}

function dueDateColor(dueDate: string, done: boolean): string {
  if (done) return '#475569'
  return isOverdue(dueDate) ? '#fca5a5' : '#cbd5e1'
}

function dueDateBg(dueDate: string, done: boolean): string {
  if (done) return '#1e293b'
  return isOverdue(dueDate) ? '#7f1d1d' : '#1e293b'
}

function isOverdue(dueDate: string): boolean {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return dueDate < today
}

function progressColor(p: number): string {
  if (p >= 100) return '#4ade80'
  if (p >= 70) return '#6366f1'
  if (p >= 30) return '#818cf8'
  return '#475569'
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDateTime(isoStr: string): string {
  const date = new Date(isoStr)
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${formatTime(date)}`
}

function formatSubTaskDateRange(startDate: string | null, dueDate: string | null): string {
  if (startDate && dueDate) {
    return startDate === dueDate ? `1日予定 ${startDate}` : `${startDate} - ${dueDate}`
  }
  if (startDate) return `開始 ${startDate}`
  if (dueDate) return `期限 ${dueDate}`
  return ''
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: '#0f172a',
  border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0',
  fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box'
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: 4
}

const subTaskDateLabelStyle: React.CSSProperties = {
  fontSize: '0.68rem',
  color: '#64748b',
  marginBottom: 4
}

function dateBadgeStyle(background: string, color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 10px',
    borderRadius: 999,
    background,
    color,
    fontSize: '0.74rem',
    fontWeight: 600
  }
}

function smallBtnStyle(bg: string, color = '#fff'): React.CSSProperties {
  return {
    padding: '6px 12px', background: bg, border: 'none',
    borderRadius: 6, color, cursor: 'pointer', fontSize: '0.85rem',
    fontWeight: 'bold', whiteSpace: 'nowrap'
  }
}
