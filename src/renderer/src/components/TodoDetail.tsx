import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Todo, WorkLog, SubTask, UpdateTodoInput, Category } from '../types'
import { TimerDisplay } from './TimerDisplay'

interface Props {
  todo: Todo | null
  categories: Category[]
  runningTodoId: string | null
  elapsedSeconds: number
  onUpdate: (id: string, data: UpdateTodoInput) => Promise<void>
  onStartTimer: (todoId: string) => Promise<void>
  onStopTimer: (note?: string) => Promise<void>
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

export function TodoDetail({
  todo, categories, runningTodoId, elapsedSeconds,
  onUpdate, onStartTimer, onStopTimer, onShowToast
}: Props): React.JSX.Element {
  const [logs, setLogs] = useState<WorkLog[]>([])
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState<UpdateTodoInput>({})
  const [stopNote, setStopNote] = useState('')
  const [localProgress, setLocalProgress] = useState<number | null>(null)
  const [newSubTaskTitle, setNewSubTaskTitle] = useState('')
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

  // todo が切り替わったときだけ編集状態をリセット
  useEffect(() => {
    if (!todoId || !todo) { setSubTasks([]); setLogs([]); return }
    setEditing(false)
    setEditData({
      title: todo.title,
      description: todo.description,
      category_id: todo.category_id,
      status: todo.status,
      priority: todo.priority,
      progress: todo.progress,
      due_date: todo.due_date ?? undefined,
      recurrence: todo.recurrence ?? undefined
    })
    window.api.worklogGetByTodo(todoId).then(setLogs).catch(console.error)
    loadSubTasks(todoId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoId, loadSubTasks])

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
  const totalSecs = logs.reduce((s, l) => s + l.duration_seconds, 0) + (isRunning ? elapsedSeconds : 0)
  const totalMins = Math.round(totalSecs / 60)

  // ─── 編集保存 ────────────────────────────────────────────────
  const handleSave = async (): Promise<void> => {
    await onUpdate(todo.id, editData)
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
    if (!newSubTaskTitle.trim()) return
    await window.api.subtaskCreate(todo.id, newSubTaskTitle.trim())
    setNewSubTaskTitle('')
    await loadSubTasks(todo.id)
  }

  const handleToggleSubTask = async (st: SubTask): Promise<void> => {
    await window.api.subtaskUpdate(st.id, { done: !st.done })
    await loadSubTasks(todo.id)
  }

  const handleDeleteSubTask = async (id: string): Promise<void> => {
    await window.api.subtaskDelete(id)
    await loadSubTasks(todo.id)
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
        <button onClick={() => setEditing(!editing)} style={smallBtnStyle('#334155')}>
          {editing ? '×' : '編集'}
        </button>
      </div>

      {/* タイマー */}
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
          {subTasks.map((st) => (
            <SubTaskRow key={st.id} subTask={st} onToggle={() => handleToggleSubTask(st)} onDelete={() => handleDeleteSubTask(st.id)} />
          ))}
        </div>
        <form onSubmit={handleAddSubTask} style={{ display: 'flex', gap: 6 }}>
          <input
            value={newSubTaskTitle}
            onChange={(e) => setNewSubTaskTitle(e.target.value)}
            placeholder="＋ サブタスクを追加..."
            style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }}
          />
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
      <span style={{ flex: 1, fontSize: '0.85rem', color: subTask.done ? '#475569' : '#cbd5e1', textDecoration: subTask.done ? 'line-through' : 'none' }}>
        {subTask.title}
      </span>
      {hovered && (
        <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.75rem', padding: '0 2px' }}>✕</button>
      )}
    </div>
  )
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

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: '#0f172a',
  border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0',
  fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box'
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.75rem', color: '#64748b', marginBottom: 4
}

function smallBtnStyle(bg: string, color = '#fff'): React.CSSProperties {
  return {
    padding: '6px 12px', background: bg, border: 'none',
    borderRadius: 6, color, cursor: 'pointer', fontSize: '0.85rem',
    fontWeight: 'bold', whiteSpace: 'nowrap'
  }
}
