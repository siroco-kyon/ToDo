import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Category, CreateSubTaskInput, DailyPlanItem, PublicUser, SubTask, Todo, TodoDependency, UpdateTodoInput, WorkLog } from '../types'
import { TimerDisplay } from './TimerDisplay'
import { AssigneeChip, AssigneePicker } from './AssigneePicker'

interface Props {
  todo: Todo | null
  allTodos: Todo[]
  categories: Category[]
  users?: PublicUser[]
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box'
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#64748b',
  marginBottom: 8,
  textTransform: 'uppercase',
  letterSpacing: '0.05em'
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: '#64748b',
  marginBottom: 4
}

export function TodoDetail({
  todo,
  allTodos,
  categories,
  users = [],
  todayPlanItems,
  runningTodoId,
  elapsedSeconds,
  onUpdate,
  onStartTimer,
  onStopTimer,
  onAddToTodayPlan,
  onShowToast
}: Props): React.JSX.Element {
  const [logs, setLogs] = useState<WorkLog[]>([])
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [dependencies, setDependencies] = useState<TodoDependency[]>([])
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState<UpdateTodoInput>({})
  const [editableSubTasks, setEditableSubTasks] = useState<EditableSubTask[]>([])
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionBase, setDescriptionBase] = useState('')
  const [descriptionSaving, setDescriptionSaving] = useState(false)
  const [memoDraft, setMemoDraft] = useState('')
  const [memoBase, setMemoBase] = useState('')
  const [memoSaving, setMemoSaving] = useState(false)
  const [stopNote, setStopNote] = useState('')
  const [localProgress, setLocalProgress] = useState<number | null>(null)
  const [newSubTask, setNewSubTask] = useState<CreateSubTaskInput>({
    title: '',
    description: '',
    start_date: null,
    due_date: null
  })
  const [dependencyDraft, setDependencyDraft] = useState<{
    mode: 'predecessor' | 'successor'
    relatedTodoId: string
    lagDays: string
  }>({
    mode: 'predecessor',
    relatedTodoId: '',
    lagDays: '0'
  })
  const progressBarRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

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
    recurrence: source.recurrence ?? undefined,
    assignee_id: source.assignee_id
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

  const loadSubTasks = useCallback(async (id: string) => {
    try {
      setSubTasks(await window.api.subtaskGetByTodo(id))
    } catch (error) {
      console.error('Failed to load subtasks', error)
      setSubTasks([])
    }
  }, [])

  const loadDependencies = useCallback(async (id: string) => {
    try {
      const rows = await window.api.todoDependencyGetAll()
      setDependencies(rows.filter((row) => row.predecessor_todo_id === id || row.successor_todo_id === id))
    } catch (error) {
      console.error('Failed to load dependencies', error)
      setDependencies([])
    }
  }, [])

  useEffect(() => {
    if (!todoId || !todo) {
      setLogs([])
      setSubTasks([])
      setDependencies([])
      setDescriptionDraft('')
      setDescriptionBase('')
      setMemoDraft('')
      setMemoBase('')
      return
    }

    setEditing(false)
    setEditData(createEditData(todo))
    setDescriptionDraft(todo.description ?? '')
    setDescriptionBase(todo.description ?? '')
    setMemoDraft(todo.memo ?? '')
    setMemoBase(todo.memo ?? '')
    window.api.worklogGetByTodo(todoId).then(setLogs).catch(console.error)
    void loadSubTasks(todoId)
    void loadDependencies(todoId)
  }, [createEditData, loadDependencies, loadSubTasks, todo, todoId])

  useEffect(() => {
    if (!editing) setEditableSubTasks(createEditableSubTasks(subTasks))
  }, [createEditableSubTasks, editing, subTasks])

  useEffect(() => {
    if (!todoId) return

    const unsubscribe = window.api.onDataChanged((scope) => {
      if (scope === 'subtask') void loadSubTasks(todoId)
      if (scope === 'todo') void loadDependencies(todoId)
    })

    return () => unsubscribe()
  }, [loadDependencies, loadSubTasks, todoId])

  const calcProgress = useCallback((clientX: number): number => {
    if (!progressBarRef.current) return 0
    const rect = progressBarRef.current.getBoundingClientRect()
    const raw = ((clientX - rect.left) / rect.width) * 100
    return Math.min(100, Math.max(0, Math.round(raw / 5) * 5))
  }, [])

  const handleProgressMouseDown = useCallback((event: React.MouseEvent): void => {
    if (!todoId) return

    event.preventDefault()
    draggingRef.current = true
    setLocalProgress(calcProgress(event.clientX))

    const handleMove = (moveEvent: MouseEvent): void => {
      if (draggingRef.current) setLocalProgress(calcProgress(moveEvent.clientX))
    }
    const handleUp = (upEvent: MouseEvent): void => {
      draggingRef.current = false
      const progress = calcProgress(upEvent.clientX)
      setLocalProgress(null)
      void onUpdate(todoId, { progress }).catch((error) => {
        onShowToast(error instanceof Error ? error.message : '進捗を更新できませんでした', 'error')
      })
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [calcProgress, onShowToast, onUpdate, todoId])

  const handleDeleteSubTask = async (subTaskId: string): Promise<void> => {
    await window.api.subtaskDelete(subTaskId)
    setSubTasks((previous) => previous.filter((item) => item.id !== subTaskId))
    setEditableSubTasks((previous) => previous.filter((item) => item.id !== subTaskId))
  }

  const handleSave = async (): Promise<void> => {
    if (!todo) return

    if (editableSubTasks.some((subTask) => !subTask.title.trim())) {
      onShowToast('サブタスク名を入力してください', 'error')
      return
    }
    if (editableSubTasks.some((subTask) => subTask.start_date && subTask.due_date && subTask.start_date > subTask.due_date)) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }
    if (editData.start_date && editData.due_date && editData.start_date > editData.due_date) {
      onShowToast('開始日は締切日より前にしてください', 'error')
      return
    }

    const changedSubTasks = editableSubTasks.filter((draft) => {
      const current = subTasks.find((item) => item.id === draft.id)
      if (!current) return false
      return current.title !== draft.title.trim()
        || (current.description ?? '') !== draft.description.trim()
        || (current.start_date ?? null) !== draft.start_date
        || (current.due_date ?? null) !== draft.due_date
        || Boolean(current.done) !== draft.done
    })

    await onUpdate(todo.id, editData)
    await Promise.all(changedSubTasks.map((subTask) => window.api.subtaskUpdate(subTask.id, {
      title: subTask.title.trim(),
      description: subTask.description.trim(),
      start_date: subTask.start_date ?? null,
      due_date: subTask.due_date ?? null,
      done: subTask.done
    })))
    setDescriptionDraft(editData.description ?? '')
    setDescriptionBase(editData.description ?? '')
    await loadSubTasks(todo.id)
    setEditing(false)
    onShowToast('タスクを更新しました')
  }

  const handleDescriptionSave = async (): Promise<void> => {
    if (!todoId || descriptionSaving) return

    try {
      setDescriptionSaving(true)
      await onUpdate(todoId, { description: descriptionDraft })
      setDescriptionBase(descriptionDraft)
      setEditData((previous) => ({ ...previous, description: descriptionDraft }))
      onShowToast('説明を保存しました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '説明を保存できませんでした', 'error')
    } finally {
      setDescriptionSaving(false)
    }
  }

  const handleMemoSave = async (): Promise<void> => {
    if (!todoId || memoSaving) return
    try {
      setMemoSaving(true)
      await onUpdate(todoId, { memo: memoDraft })
      setMemoBase(memoDraft)
      onShowToast('メモを保存しました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'メモを保存できませんでした', 'error')
    } finally {
      setMemoSaving(false)
    }
  }

  const handleAddSubTask = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!todo) return

    const title = newSubTask.title.trim()
    if (!title) return
    if (newSubTask.start_date && newSubTask.due_date && newSubTask.start_date > newSubTask.due_date) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }

    const created = await window.api.subtaskCreate(todo.id, {
      title,
      description: newSubTask.description?.trim() ?? '',
      start_date: newSubTask.start_date ?? null,
      due_date: newSubTask.due_date ?? null
    })
    setNewSubTask({ title: '', description: '', start_date: null, due_date: null })
    setSubTasks((previous) => [...previous, created])
    if (editing) {
      setEditableSubTasks((previous) => [...previous, {
        id: created.id,
        title: created.title,
        description: created.description ?? '',
        start_date: created.start_date ?? null,
        due_date: created.due_date ?? null,
        done: Boolean(created.done)
      }])
    }
  }

  const handleCreateDependency = async (): Promise<void> => {
    if (!todoId || !dependencyDraft.relatedTodoId) {
      onShowToast('依存先のタスクを選択してください', 'error')
      return
    }

    const lagDays = clampLag(Number(dependencyDraft.lagDays || '0'))
    const predecessorTodoId = dependencyDraft.mode === 'predecessor' ? dependencyDraft.relatedTodoId : todoId
    const successorTodoId = dependencyDraft.mode === 'predecessor' ? todoId : dependencyDraft.relatedTodoId
    await window.api.todoDependencyCreate(predecessorTodoId, successorTodoId, lagDays)
    await loadDependencies(todoId)
    setDependencyDraft((previous) => ({ ...previous, relatedTodoId: '', lagDays: String(lagDays) }))
  }

  if (!todo) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#475569' }}>
        タスクを選択してください
      </div>
    )
  }

  const isRunning = runningTodoId === todo.id
  const isInTodayPlan = todayPlanItems.some((item) => item.todo_id === todo.id)
  const totalMinutes = Math.round((logs.reduce((sum, log) => sum + log.duration_seconds, 0) + (isRunning ? elapsedSeconds : 0)) / 60)
  const displayProgress = localProgress ?? todo.progress ?? 0
  const doneCount = subTasks.filter((subTask) => subTask.done).length
  const subTaskProgress = subTasks.length > 0 ? Math.round((doneCount / subTasks.length) * 100) : null
  const predecessorDependencies = dependencies.filter((dependency) => dependency.successor_todo_id === todo.id)
  const successorDependencies = dependencies.filter((dependency) => dependency.predecessor_todo_id === todo.id)
  const blockedCandidateIds = new Set(
    (dependencyDraft.mode === 'predecessor' ? predecessorDependencies : successorDependencies)
      .map((dependency) => dependencyDraft.mode === 'predecessor' ? dependency.predecessor_todo_id : dependency.successor_todo_id)
  )
  const dependencyCandidates = allTodos.filter((candidate) => candidate.id !== todo.id && !blockedCandidateIds.has(candidate.id))

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

  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          padding: '20px 20px 12px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          borderBottom: '1px solid #1e293b',
          background: '#0b1220'
        }}
      >
        <div style={{ flex: 1 }}>
          {editing ? (
            <input value={editData.title ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, title: event.target.value }))} style={inputStyle} />
          ) : (
            <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', lineHeight: 1.4, margin: 0 }}>{todo.title}</h2>
          )}
        </div>
        {!editing && todo.status !== 'done' && todo.status !== 'archived' && (
          <button onClick={() => void onAddToTodayPlan(todo.id)} disabled={isInTodayPlan} style={buttonStyle(isInTodayPlan ? '#1e293b' : '#2563eb', isInTodayPlan ? '#64748b' : '#dbeafe')}>
            {isInTodayPlan ? '今日の計画に追加済み' : '今日の計画に追加'}
          </button>
        )}
        <button onClick={editing ? cancelEditing : startEditing} style={buttonStyle('#334155')}>
          {editing ? '閉じる' : '編集'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!editing && (todo.start_date || todo.due_date || todo.assignee_name) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {todo.start_date && <Badge color="#93c5fd">開始日 {todo.start_date}</Badge>}
          {todo.due_date && <Badge color="#fbbf24">締切 {todo.due_date}</Badge>}
          <AssigneeChip name={todo.assignee_name} color={todo.assignee_color} fontSize={0.74} />
        </div>
      )}

      <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 4 }}>計測時間</div>
          <TimerDisplay elapsedSeconds={isRunning ? elapsedSeconds : 0} isRunning={isRunning} />
          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>合計 {totalMinutes}分</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {isRunning ? (
            <>
              <input value={stopNote} onChange={(event) => setStopNote(event.target.value)} placeholder="停止メモ" style={{ ...inputStyle, width: 160, fontSize: '0.8rem', padding: '6px 8px' }} />
              <button onClick={() => void onStopTimer(stopNote || undefined).then(() => setStopNote(''))} style={buttonStyle('#ef4444')}>停止</button>
            </>
          ) : (
            <button onClick={() => void onStartTimer(todo.id)} style={buttonStyle('#4ade80', '#000')}>開始</button>
          )}
        </div>
      </div>

      {editing && (
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div><label style={labelStyle}>説明</label><textarea value={editData.description ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, description: event.target.value }))} rows={4} style={{ ...inputStyle, resize: 'vertical' }} /></div>
          <div><label style={labelStyle}>開始日</label><input type="date" value={editData.start_date?.slice(0, 10) ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, start_date: event.target.value || null }))} style={inputStyle} /></div>
          <div style={{ display: 'flex', gap: 10 }}><div style={{ flex: 1 }}><label style={labelStyle}>カテゴリ</label><select value={editData.category_id ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, category_id: event.target.value || null }))} style={inputStyle}><option value="">なし</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div><div style={{ flex: 1 }}><label style={labelStyle}>優先度</label><select value={editData.priority ?? 3} onChange={(event) => setEditData((previous) => ({ ...previous, priority: Number(event.target.value) }))} style={inputStyle}><option value={1}>最高</option><option value={2}>高</option><option value={3}>中</option><option value={4}>低</option><option value={5}>最低</option></select></div></div>
          <div style={{ display: 'flex', gap: 10 }}><div style={{ flex: 1 }}><label style={labelStyle}>締切</label><input type="date" value={editData.due_date?.slice(0, 10) ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, due_date: event.target.value || null }))} style={inputStyle} /></div><div style={{ flex: 1 }}><label style={labelStyle}>繰り返し</label><select value={editData.recurrence ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, recurrence: (event.target.value || null) as 'daily' | 'weekly' | 'monthly' | null }))} style={inputStyle}><option value="">なし</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="monthly">毎月</option></select></div></div>
          <div><label style={labelStyle}>状態</label><select value={editData.status ?? 'active'} onChange={(event) => setEditData((previous) => ({ ...previous, status: event.target.value as 'not_started' | 'active' | 'done' | 'archived' }))} style={inputStyle}><option value="not_started">未着手</option><option value="active">進行中</option><option value="done">完了</option><option value="archived">アーカイブ</option></select></div>
          {users.length > 0 && (
            <div><label style={labelStyle}>担当者</label><AssigneePicker users={users} value={editData.assignee_id ?? null} onChange={(assigneeId) => setEditData((previous) => ({ ...previous, assignee_id: assigneeId }))} selectStyle={inputStyle} /></div>
          )}
          <div><label style={labelStyle}>進捗 {editData.progress ?? 0}%</label><input type="range" min={0} max={100} step={5} value={editData.progress ?? 0} onChange={(event) => setEditData((previous) => ({ ...previous, progress: Number(event.target.value) }))} style={{ width: '100%', accentColor: '#6366f1' }} /></div>
          <button onClick={() => void handleSave()} style={{ ...buttonStyle('#6366f1'), alignSelf: 'flex-end' }}>保存</button>
        </div>
      )}

      {!editing && (
        <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>進捗 <span style={{ color: '#334155', fontSize: '0.68rem' }}>ドラッグで変更</span></span>
            <span style={{ fontSize: '0.75rem', color: progressColor(displayProgress), fontWeight: 'bold' }}>{displayProgress}%</span>
          </div>
          <div ref={progressBarRef} onMouseDown={handleProgressMouseDown} style={{ height: 10, background: '#0f172a', borderRadius: 99, cursor: 'ew-resize', userSelect: 'none' }}>
            <div style={{ height: '100%', width: `${displayProgress}%`, background: progressColor(displayProgress), borderRadius: 99, pointerEvents: 'none' }} />
          </div>
          {subTaskProgress !== null && (
            <div style={{ marginTop: 8, fontSize: '0.72rem', color: '#64748b' }}>
              サブタスク: {doneCount}/{subTasks.length} 完了
              <div style={{ height: 4, background: '#0f172a', borderRadius: 99, marginTop: 4 }}>
                <div style={{ height: '100%', width: `${subTaskProgress}%`, background: '#6366f1', borderRadius: 99 }} />
              </div>
            </div>
          )}
        </div>
      )}

      {!editing && (
        <section>
          <div style={sectionTitleStyle}>説明</div>
          <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.5 }}>
              タスクの目的や背景を記録できます。Ctrl/Cmd + Enter でも保存できます。
            </div>
            <textarea
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void handleDescriptionSave()
                }
              }}
              placeholder="タスクの説明を入力..."
              rows={4}
              style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: 100 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.72rem', color: descriptionDraft !== descriptionBase ? '#93c5fd' : '#64748b' }}>
                {descriptionDraft !== descriptionBase ? '未保存の変更があります' : '保存済み'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{descriptionDraft.length}文字</div>
                <button
                  onClick={() => void handleDescriptionSave()}
                  disabled={descriptionDraft === descriptionBase || descriptionSaving}
                  style={buttonStyle(descriptionDraft === descriptionBase || descriptionSaving ? '#1e293b' : '#2563eb', descriptionDraft === descriptionBase || descriptionSaving ? '#64748b' : '#dbeafe')}
                >
                  {descriptionSaving ? '保存中...' : '説明を保存'}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {!editing && (
        <section>
          <div style={sectionTitleStyle}>メモ</div>
          <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.5 }}>
              進捗、気づき、次にやることを残せます。Ctrl/Cmd + Enter でも保存できます。
            </div>
            <textarea value={memoDraft} onChange={(event) => setMemoDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void handleMemoSave() } }} placeholder="進捗メモ、引き継ぎ、次にやることなど..." rows={5} style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: 120 }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.72rem', color: memoDraft !== memoBase ? '#93c5fd' : '#64748b' }}>{memoDraft !== memoBase ? '未保存の変更があります' : '保存済み'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{memoDraft.length}文字</div>
                <button onClick={() => void handleMemoSave()} disabled={memoDraft === memoBase || memoSaving} style={buttonStyle(memoDraft === memoBase || memoSaving ? '#1e293b' : '#2563eb', memoDraft === memoBase || memoSaving ? '#64748b' : '#dbeafe')}>
                  {memoSaving ? '保存中...' : 'メモを保存'}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <section>
        <div style={sectionTitleStyle}>サブタスク {subTasks.length > 0 && `(${doneCount}/${subTasks.length})`}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {editing
            ? editableSubTasks.map((subTask) => (
              <EditableSubTaskItem
                key={subTask.id}
                subTask={subTask}
                onChange={(data) => setEditableSubTasks((previous) => previous.map((item) => item.id === subTask.id ? { ...item, ...data } : item))}
                onDelete={() => void handleDeleteSubTask(subTask.id)}
              />
            ))
            : subTasks.map((subTask) => (
              <ReadonlySubTaskItem
                key={subTask.id}
                subTask={subTask}
                onToggle={() => void window.api.subtaskUpdate(subTask.id, { done: !subTask.done }).then((updated) => setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item)))}
                onDelete={() => void handleDeleteSubTask(subTask.id)}
              />
            ))}
        </div>
        <form onSubmit={(event) => void handleAddSubTask(event)} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input value={newSubTask.title} onChange={(event) => setNewSubTask((previous) => ({ ...previous, title: event.target.value }))} placeholder="新しいサブタスクを追加..." style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }} />
          <textarea value={newSubTask.description ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, description: event.target.value }))} placeholder="メモ..." rows={2} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <input type="date" value={newSubTask.start_date ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, start_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} />
            <input type="date" value={newSubTask.due_date ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, due_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} />
          </div>
          <button type="submit" style={buttonStyle('#6366f1')}>追加</button>
        </form>
      </section>

      <section>
        <div style={sectionTitleStyle}>依存関係</div>
        <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.5 }}>
            このタスクの前後関係を設定できます。待機日数を増やすと、先行タスク完了後に間を空けられます。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 0.9fr) minmax(0, 1.4fr) 88px auto', gap: 6 }}>
            <select value={dependencyDraft.mode} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, mode: event.target.value as 'predecessor' | 'successor', relatedTodoId: '' }))} style={inputStyle}>
              <option value="predecessor">先行タスクを追加</option>
              <option value="successor">後続タスクを追加</option>
            </select>
            <select value={dependencyDraft.relatedTodoId} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, relatedTodoId: event.target.value }))} style={inputStyle}>
              <option value="">タスクを選択</option>
              {dependencyCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
            <input type="number" min={0} max={60} value={dependencyDraft.lagDays} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, lagDays: event.target.value }))} placeholder="待機日数" style={inputStyle} />
            <button onClick={() => void handleCreateDependency()} style={buttonStyle('#2563eb')}>追加</button>
          </div>
          <DependencyList title="先行タスク" items={predecessorDependencies} getTodoId={(item) => item.predecessor_todo_id} getTitle={(item) => allTodos.find((candidate) => candidate.id === item.predecessor_todo_id)?.title ?? '不明なタスク'} reload={() => todoId ? loadDependencies(todoId) : Promise.resolve()} />
          <DependencyList title="後続タスク" items={successorDependencies} getTodoId={(item) => item.successor_todo_id} getTitle={(item) => allTodos.find((candidate) => candidate.id === item.successor_todo_id)?.title ?? '不明なタスク'} reload={() => todoId ? loadDependencies(todoId) : Promise.resolve()} />
        </div>
      </section>

      <section>
        <div style={sectionTitleStyle}>作業ログ</div>
        {logs.length === 0 ? (
          <div style={{ color: '#475569', fontSize: '0.85rem' }}>ログはまだありません</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {logs.map((log) => (
              <div key={log.id} style={{ background: '#1e293b', borderRadius: 6, padding: '8px 12px', fontSize: '0.82rem', color: '#94a3b8' }}>
                <span style={{ color: '#e2e8f0' }}>{formatTime(new Date(log.start_time))} - {formatTime(new Date(log.end_time))}</span>
                <span style={{ marginLeft: 8, color: '#4ade80' }}>{Math.round(log.duration_seconds / 60)}分</span>
                {log.note && <span style={{ marginLeft: 8 }}>メモ: {log.note}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
    </div>
  )
}

function DependencyList({ title, items, getTodoId, getTitle, reload }: { title: string; items: TodoDependency[]; getTodoId: (item: TodoDependency) => string; getTitle: (item: TodoDependency) => string; reload: () => Promise<void> }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginBottom: 6 }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: '0.8rem', color: '#475569' }}>設定されていません</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#0f172a', flexWrap: 'wrap' }}>
              <button onClick={() => void window.api.windowOpenTodo(getTodoId(item))} style={{ background: 'none', border: 'none', padding: 0, color: '#e2e8f0', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700 }}>{getTitle(item)}</button>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>待機 {item.lag_days}日</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => void window.api.todoDependencyUpdate(item.id, clampLag(item.lag_days - 1)).then(() => reload())} style={buttonStyle('#334155')}>-1日</button>
                <button onClick={() => void window.api.todoDependencyUpdate(item.id, clampLag(item.lag_days + 1)).then(() => reload())} style={buttonStyle('#334155')}>+1日</button>
                <button onClick={() => void window.api.todoDependencyDelete(item.id).then(() => reload())} style={buttonStyle('#7f1d1d')}>削除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EditableSubTaskItem({ subTask, onChange, onDelete }: { subTask: EditableSubTask; onChange: (data: Partial<EditableSubTask>) => void; onDelete: () => void }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#1e293b' }}>
      <button onClick={() => onChange({ done: !subTask.done })} style={{ width: 16, height: 16, borderRadius: 3, marginTop: 8, border: `2px solid ${subTask.done ? '#4ade80' : '#475569'}`, background: subTask.done ? '#4ade80' : 'transparent', cursor: 'pointer' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={subTask.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="サブタスク名" style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }} />
        <textarea value={subTask.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="メモ..." rows={2} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input type="date" value={subTask.start_date ?? ''} onChange={(event) => onChange({ start_date: event.target.value || null })} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} />
          <input type="date" value={subTask.due_date ?? ''} onChange={(event) => onChange({ due_date: event.target.value || null })} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} />
        </div>
      </div>
      <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>削除</button>
    </div>
  )
}

function ReadonlySubTaskItem({ subTask, onToggle, onDelete }: { subTask: SubTask; onToggle: () => void; onDelete: () => void }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 6, background: '#1e293b' }}>
      <button onClick={onToggle} style={{ width: 16, height: 16, borderRadius: 3, marginTop: 2, border: `2px solid ${subTask.done ? '#4ade80' : '#475569'}`, background: subTask.done ? '#4ade80' : 'transparent', cursor: 'pointer' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', color: subTask.done ? '#475569' : '#cbd5e1', textDecoration: subTask.done ? 'line-through' : 'none' }}>{subTask.title}</div>
        {(subTask.start_date || subTask.due_date) && <div style={{ marginTop: 4, fontSize: '0.68rem', color: '#94a3b8' }}>{subTask.start_date ?? ''}{subTask.start_date && subTask.due_date ? ' - ' : ''}{subTask.due_date ?? ''}</div>}
        {subTask.description && <div style={{ marginTop: 2, fontSize: '0.75rem', color: subTask.done ? '#334155' : '#64748b', whiteSpace: 'pre-wrap' }}>{subTask.description}</div>}
      </div>
      <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>削除</button>
    </div>
  )
}

function Badge({ children, color }: { children: React.ReactNode; color: string }): React.JSX.Element {
  return <div style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 999, background: '#0f172a', color, fontSize: '0.74rem', fontWeight: 600 }}>{children}</div>
}

function buttonStyle(background: string, color = '#fff'): React.CSSProperties {
  return { padding: '6px 12px', background, border: 'none', borderRadius: 6, color, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold', whiteSpace: 'nowrap' }
}

function progressColor(progress: number): string {
  if (progress >= 100) return '#4ade80'
  if (progress >= 70) return '#6366f1'
  if (progress >= 30) return '#818cf8'
  return '#475569'
}

function clampLag(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(60, Math.max(0, Math.round(value)))
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
