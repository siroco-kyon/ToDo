import { LinkedText, TextLinks } from './LinkedText'
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Category, CreateSubTaskInput, DailyPlanItem, ProgressNote, PublicUser, SubTask, Todo, TodoDependency, TodoHistoryEntry, UpdateSubTaskInput, UpdateTodoInput, WorkLog } from '../types'
import { TimerDisplay } from './TimerDisplay'
import { AssigneeChip, AssigneePicker } from './AssigneePicker'
import { diffDaysFromToday, getDueDateColor, toDateKey } from '../lib/dueDate'
import { subscribeProgressDraftChanges } from '../lib/legacyProgressDrafts'
import { buildEditPatch } from '../lib/editChanges'
import { ProgressSlider } from './ProgressSlider'
import { NoteMenu, ProgressNoteThread } from './ProgressNoteThread'
import { MentionTextarea } from './MentionTextarea'
import { TodoChecklist } from './TodoChecklist'
import { isListTodo } from '../lib/todoList'
import { autoScrollNearEdge, dropTargetAt, moveIdBy, moveIdTo, scrollParentOf, type DropPosition } from '../lib/reorder'

interface Props {
  todo: Todo | null
  allTodos: Todo[]
  categories: Category[]
  users?: PublicUser[]
  currentUser?: PublicUser | null
  todayPlanItems: DailyPlanItem[]
  runningTodoId: string | null
  elapsedSeconds: number
  onUpdate: (id: string, data: UpdateTodoInput) => Promise<void>
  onStartTimer: (todoId: string) => Promise<void>
  onStopTimer: (note?: string) => Promise<void>
  onAddToTodayPlan: (todoId: string) => Promise<DailyPlanItem>
  onShowToast: (message: string, type?: 'success' | 'error', action?: { label: string; run: () => void }) => void
  onDirtyChange?: (dirty: boolean) => void
}

interface EditableSubTask {
  id: string
  title: string
  description: string
  assignee_id: string | null
  start_date: string | null
  due_date: string | null
  progress: number
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

/** 説明・メモを自動で保存するまでの、入力が止まってからの時間 */
const AUTOSAVE_DELAY_MS = 1500
/** 詳細の欄がこの幅以上あれば2列にする（左: 説明・メモ・サブタスク・進捗ログ、右: 状態などの欄・計測・進捗・依存関係・記録） */
const TWO_COLUMN_MIN_WIDTH = 880

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#94a3b8',
  marginBottom: 8,
  textTransform: 'uppercase',
  letterSpacing: '0.05em'
}

// 欄の見出し。何を書く欄かを短く添え、詳しい説明は ⓘ（マウスを乗せる・キーボードで選ぶ）で出す。
// 以前は欄の上に毎回長い説明文を出していたが、慣れた人には縦の場所を取るだけだった
function SectionHeading({ title, summary, detail }: { title: React.ReactNode; summary?: string; detail?: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <span style={{ ...sectionTitleStyle, marginBottom: 0 }}>{title}</span>
      {summary && <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{summary}</span>}
      {detail && <InfoTip text={detail} />}
    </div>
  )
}

// ⓘ にマウスを乗せたとき・キーボードで選んだときに出す吹き出し（title のヒントはマウスでしか出ないため）
function InfoTip({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const tipId = useId()
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        tabIndex={0}
        aria-label="説明"
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
        style={{ fontSize: '0.8rem', color: open ? '#e2e8f0' : '#94a3b8', cursor: 'help', lineHeight: 1 }}
      >
        ⓘ
      </span>
      <span
        id={tipId}
        role="tooltip"
        hidden={!open}
        style={{ position: 'absolute', top: 'calc(100% + 6px)', left: -8, zIndex: 20, width: 280, padding: '8px 10px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', fontSize: '0.78rem', lineHeight: 1.6, boxShadow: '0 10px 24px rgba(2, 6, 23, 0.5)', textTransform: 'none', letterSpacing: 0 }}
      >
        {text}
      </span>
    </span>
  )
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
  currentUser = null,
  todayPlanItems,
  runningTodoId,
  elapsedSeconds,
  onUpdate,
  onStartTimer,
  onStopTimer,
  onAddToTodayPlan,
  onShowToast,
  onDirtyChange
}: Props): React.JSX.Element {
  const [logs, setLogs] = useState<WorkLog[]>([])
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [dependencies, setDependencies] = useState<TodoDependency[]>([])
  const [progressNotes, setProgressNotes] = useState<ProgressNote[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState('')
  const editBaseRef = useRef<UpdateTodoInput>({})
  const subTaskBasesRef = useRef(new Map<string, EditableSubTask>())
  const [editData, setEditData] = useState<UpdateTodoInput>({})
  const [editableSubTasks, setEditableSubTasks] = useState<EditableSubTask[]>([])
  const [subTaskReorderPending, setSubTaskReorderPending] = useState(false)
  // サブタスクをドラッグで並べ替えている間の、動かしている項目と落とす位置
  const [draggingSubTaskId, setDraggingSubTaskId] = useState<string | null>(null)
  const [subTaskDropTarget, setSubTaskDropTarget] = useState<{ id: string; position: DropPosition } | null>(null)
  const subTaskListRef = useRef<HTMLDivElement>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [subscriptionPending, setSubscriptionPending] = useState(false)
  const subscriptionPendingRef = useRef(false)
  const [childDraftIds, setChildDraftIds] = useState<Set<string>>(() => new Set())
  const handleChildDirty = useCallback((id: string, dirty: boolean): void => {
    setChildDraftIds((previous) => {
      if (previous.has(id) === dirty) return previous
      const next = new Set(previous)
      if (dirty) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const [sectionLoadError, setSectionLoadError] = useState<string | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionBase, setDescriptionBase] = useState('')
  const [descriptionSaving, setDescriptionSaving] = useState(false)
  const descriptionSavingRef = useRef(false)
  const [memoDraft, setMemoDraft] = useState('')
  const [memoBase, setMemoBase] = useState('')
  const [memoSaving, setMemoSaving] = useState(false)
  const memoSavingRef = useRef(false)
  // 自動保存に失敗した内容。同じ内容は自動では送り直さない（書き直すか「再試行」で保存する）
  const [descriptionFailedDraft, setDescriptionFailedDraft] = useState<string | null>(null)
  const [memoFailedDraft, setMemoFailedDraft] = useState<string | null>(null)
  // 詳細の欄の幅。広いときは2列にする
  const [detailBodyWidth, setDetailBodyWidth] = useState(0)
  const bodyObserverRef = useRef<ResizeObserver | null>(null)
  const detailBodyRef = useCallback((node: HTMLDivElement | null) => {
    bodyObserverRef.current?.disconnect()
    bodyObserverRef.current = null
    if (!node) return
    setDetailBodyWidth(node.clientWidth)
    const observer = new ResizeObserver((entries) => setDetailBodyWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(node)
    bodyObserverRef.current = observer
  }, [])
  const [stopNote, setStopNote] = useState('')
  const [timerStopping, setTimerStopping] = useState(false)
  const timerStoppingRef = useRef(false)
  const [newSubTask, setNewSubTask] = useState<CreateSubTaskInput>({
    title: '',
    description: '',
    // 担当の初期値は親タスクの主担当（報告タブのサブタスク追加と同じ）
    assignee_id: todo?.assignee_id ?? null,
    start_date: toDateKey(new Date()),
    due_date: null,
    progress: 0
  })
  const [showSubTaskDetails, setShowSubTaskDetails] = useState(false)
  const [dependencyDraft, setDependencyDraft] = useState<{
    mode: 'predecessor' | 'successor'
    relatedTodoId: string
    lagDays: string
  }>({
    mode: 'predecessor',
    relatedTodoId: '',
    lagDays: '0'
  })
  const initializedTodoIdRef = useRef<string | undefined>(undefined)

  const todoId = todo?.id
  const liveTodoIdRef = useRef(todoId)
  liveTodoIdRef.current = todoId
  const mountedRef = useRef(true)
  const sectionRequestsRef = useRef<Record<string, number>>({})
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const section of Object.keys(sectionRequestsRef.current)) sectionRequestsRef.current[section]++
    }
  }, [])
  const progressDraftKey = currentUser?.id ? `progress-note-draft:${currentUser.id}:${todoId}` : `progress-note-draft:${todoId}`

  useEffect(() => {
    const read = (): void => { setNoteDraft(todoId ? window.localStorage.getItem(progressDraftKey) ?? '' : '') }
    read()
    return subscribeProgressDraftChanges(progressDraftKey, read)
  }, [progressDraftKey, todoId])

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
    recurrence_copy_subtasks: source.recurrence_copy_subtasks ?? 0,
    recurrence_skip_weekends: source.recurrence_skip_weekends ?? 0,
    recurrence_skip_holidays: source.recurrence_skip_holidays ?? 0,
    list_mode: source.list_mode ?? 0,
    assignee_id: source.assignee_id,
    co_assignee_ids: (source.co_assignees ?? []).map((coAssignee) => coAssignee.user_id)
  }), [])

  const createEditableSubTasks = useCallback((items: SubTask[]): EditableSubTask[] => (
    items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? '',
      assignee_id: item.assignee_id ?? null,
      start_date: item.start_date ?? null,
      due_date: item.due_date ?? null,
      progress: Boolean(item.done) ? 100 : clampProgress(item.progress ?? 0),
      done: Boolean(item.done)
    }))
  ), [])

  useEffect(() => {
    if (!todo) {
      onDirtyChange?.(false)
      return
    }
    const structuredChanged = editing && (
      Object.keys(buildEditPatch(editBaseRef.current, editData)).length > 0
      || editableSubTasks.some((draft) => {
        const base = subTaskBasesRef.current.get(draft.id)
        return base ? Object.keys(buildEditPatch(base, draft)).length > 0 : false
      })
    )
    onDirtyChange?.(structuredChanged || childDraftIds.size > 0 || descriptionDraft !== descriptionBase || memoDraft !== memoBase || Boolean(newSubTask.title || newSubTask.description))
  }, [childDraftIds, descriptionBase, descriptionDraft, editData, editableSubTasks, editing, memoBase, memoDraft, newSubTask.description, newSubTask.title, onDirtyChange, todo])

  const loadSection = useCallback(async <T,>(section: string, id: string, get: () => Promise<T>, apply: (value: T) => void, failure: string): Promise<void> => {
    const request = (sectionRequestsRef.current[section] ?? 0) + 1
    sectionRequestsRef.current[section] = request
    const current = (): boolean => mountedRef.current && liveTodoIdRef.current === id && sectionRequestsRef.current[section] === request
    try {
      const value = await get()
      if (current()) apply(value)
    } catch (error) {
      if (current()) { console.error(failure, error); setSectionLoadError(failure) }
    }
  }, [])
  const loadSubTasks = useCallback((id: string) => loadSection('subtasks', id, () => window.api.subtaskGetByTodo(id), (rows) => setSubTasks(rows.filter((row) => row.todo_id === id)), 'サブタスクを読み込めませんでした'), [loadSection])
  const loadDependencies = useCallback((id: string) => loadSection('dependencies', id, () => window.api.todoDependencyGetAll(), (rows) => setDependencies(rows.filter((row) => row.predecessor_todo_id === id || row.successor_todo_id === id)), '依存関係を読み込めませんでした'), [loadSection])
  const loadProgressNotes = useCallback((id: string) => loadSection('progress', id, () => window.api.progressNoteGetByTodo(id), (rows) => setProgressNotes(rows.filter((row) => row.todo_id === id)), '進捗ログを読み込めませんでした'), [loadSection])
  const loadWorkLogs = useCallback((id: string) => loadSection('logs', id, () => window.api.worklogGetByTodo(id), (rows) => setLogs(rows.filter((row) => row.todo_id === id)), '作業ログを読み込めませんでした'), [loadSection])

  useEffect(() => {
    if (!todoId) {
      setLogs([])
      setSubTasks([])
      setDependencies([])
      setProgressNotes([])
      setNoteDraft('')
      setDescriptionDraft('')
      setDescriptionBase('')
      setMemoDraft('')
      setMemoBase('')
      return
    }

    void loadWorkLogs(todoId)
    setSectionLoadError(null)
    void loadSubTasks(todoId)
    void loadDependencies(todoId)
    void loadProgressNotes(todoId)
  }, [loadDependencies, loadProgressNotes, loadSubTasks, loadWorkLogs, todoId])

  useEffect(() => {
    if (!todoId || !todo) {
      initializedTodoIdRef.current = undefined
      setEditing(false)
      setEditData({})
      setDescriptionDraft('')
      setDescriptionBase('')
      setMemoDraft('')
      setMemoBase('')
      return
    }

    const selectedTodoChanged = initializedTodoIdRef.current !== todoId
    initializedTodoIdRef.current = todoId

    if (selectedTodoChanged) {
      setEditing(false)
      setSaveError('')
      setEditData(createEditData(todo))
      setDescriptionDraft(todo.description ?? '')
      setDescriptionBase(todo.description ?? '')
      setMemoDraft(todo.memo ?? '')
      setMemoBase(todo.memo ?? '')
      setNoteDraft(window.localStorage.getItem(progressDraftKey) ?? '')
      return
    }

    if (editing) return

    const nextDescription = todo.description ?? ''
    const nextMemo = todo.memo ?? ''

    setEditData(createEditData(todo))
    if (descriptionDraft === descriptionBase) { setDescriptionDraft(nextDescription); setDescriptionBase(nextDescription) }
    if (memoDraft === memoBase) { setMemoDraft(nextMemo); setMemoBase(nextMemo) }
  }, [createEditData, descriptionBase, descriptionDraft, editing, memoBase, memoDraft, todo, todoId])

  useEffect(() => {
    if (!editing) setEditableSubTasks(createEditableSubTasks(subTasks))
  }, [createEditableSubTasks, editing, subTasks])

  useEffect(() => {
    if (!todoId) return

    const unsubscribe = window.api.onDataChanged((scope) => {
      if (scope === 'subtask') void loadSubTasks(todoId)
      if (scope === 'progress') void loadProgressNotes(todoId)
      if (scope === 'todo') {
        void loadWorkLogs(todoId)
        void loadDependencies(todoId)
      }
    })

    return () => unsubscribe()
  }, [loadDependencies, loadProgressNotes, loadSubTasks, loadWorkLogs, todoId])

  useEffect(() => {
    if (!todoId || !currentUser) { setSubscribed(false); return }
    void loadSection('subscription', todoId, () => window.api.todoSubscriptionGet(todoId), (result) => setSubscribed(result.subscribed), '更新通知の設定を読み込めませんでした')
    return () => { sectionRequestsRef.current.subscription = (sectionRequestsRef.current.subscription ?? 0) + 1 }
  }, [currentUser, loadSection, todoId])

  const toggleSubscription = async (): Promise<void> => {
    if (!todoId || subscriptionPendingRef.current) return
    subscriptionPendingRef.current = true
    setSubscriptionPending(true)
    // A GET started before the local toggle must not replace its newer result.
    sectionRequestsRef.current.subscription = (sectionRequestsRef.current.subscription ?? 0) + 1
    try {
      const result = await window.api.todoSubscriptionSet(todoId, !subscribed)
      if (mountedRef.current && liveTodoIdRef.current === todoId) {
        setSubscribed(result.subscribed)
        onShowToast(result.subscribed ? 'このタスクの更新通知を受け取ります' : '更新通知をオフにしました')
      }
    } catch (error) {
      if (mountedRef.current) onShowToast(error instanceof Error ? error.message : '更新通知を変更できませんでした', 'error')
    } finally {
      subscriptionPendingRef.current = false
      if (mountedRef.current) setSubscriptionPending(false)
    }
  }

  // 進捗バーは報告タブと同じスライダー（ドラッグ・←→キー）。離したときに1回だけ保存する
  const handleProgressCommit = async (progress: number): Promise<void> => {
    if (!todoId) return
    try {
      await onUpdate(todoId, { progress, expected_values: { progress: todo?.progress ?? 0 } })
      if (progress >= 100 && todo?.status !== 'done') onShowToast('進捗が100%になったので完了にしました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗を更新できませんでした', 'error')
    }
  }

  // 完了・完了の取り消し（タスク一覧の丸と同じ動き）
  const toggleDone = async (): Promise<void> => {
    if (!todo) return
    const nextStatus: Todo['status'] = todo.status === 'done'
      ? (todo.progress > 0 ? 'active' : 'not_started')
      : 'done'
    try {
      await onUpdate(todo.id, { status: nextStatus })
      if (nextStatus === 'done') {
        const recurrenceLabel = todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : todo.recurrence === 'monthly' ? '毎月' : null
        onShowToast(recurrenceLabel ? `完了にしました。${recurrenceLabel}タスクの次回分を作成しました` : '完了にしました')
      } else {
        onShowToast('完了を取り消しました')
      }
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '状態を変更できませんでした', 'error')
    }
  }

  const handleDeleteSubTask = async (subTaskId: string): Promise<void> => {
    const target = subTasks.find((item) => item.id === subTaskId)
    if (!window.confirm(`サブタスク「${target?.title ?? ''}」を削除しますか？`)) return
    if (!target || !todoId) return
    const originalIndex = subTasks.findIndex((item) => item.id === subTaskId)
    const remainingIds = subTasks.filter((item) => item.id !== subTaskId).map((item) => item.id)
    await window.api.subtaskDelete(subTaskId)
    setSubTasks((previous) => previous.filter((item) => item.id !== subTaskId))
    setEditableSubTasks((previous) => previous.filter((item) => item.id !== subTaskId))
    onShowToast(`サブタスク「${target.title}」を削除しました`, 'success', {
      label: '元に戻す',
      run: () => {
        void window.api.subtaskCreate(todoId, {
          title: target.title,
          description: target.description,
          assignee_id: target.assignee_id,
          start_date: target.start_date,
          due_date: target.due_date,
          progress: target.progress,
          recurrence: target.recurrence,
          recurrence_workdays: target.recurrence_workdays,
          recurrence_day: target.recurrence_day
        }).then(async (created) => {
          if (target.done && !created.done) await window.api.subtaskUpdate(created.id, { done: true })
          const orderedIds = [...remainingIds]
          orderedIds.splice(Math.max(0, originalIndex), 0, created.id)
          await window.api.subtaskReorder(todoId, orderedIds)
          await loadSubTasks(todoId)
          onShowToast('サブタスクを元の位置へ戻しました')
        })
      }
    })
  }

  // サブタスクの並びを変えて保存する。すぐ画面に反映し、失敗したら元の並びに戻す
  const applySubTaskOrder = async (orderedIds: string[]): Promise<void> => {
    if (!todo || subTaskReorderPending) return

    const previousSubTasks = subTasks
    const previousEditableSubTasks = editableSubTasks
    const subTaskById = new Map(subTasks.map((item) => [item.id, item]))
    const editableById = new Map(editableSubTasks.map((item) => [item.id, item]))

    setSubTasks(orderedIds.map((id) => subTaskById.get(id)).filter((item): item is SubTask => Boolean(item)))
    setEditableSubTasks(orderedIds.map((id) => editableById.get(id)).filter((item): item is EditableSubTask => Boolean(item)))
    setSubTaskReorderPending(true)
    try {
      await window.api.subtaskReorder(todo.id, orderedIds)
    } catch (error) {
      setSubTasks(previousSubTasks)
      setEditableSubTasks(previousEditableSubTasks)
      onShowToast(error instanceof Error ? error.message : 'サブタスクを並べ替えできませんでした', 'error')
    } finally {
      setSubTaskReorderPending(false)
    }
  }

  // つかみにフォーカスして Alt+↑↓ で1つずつ動かす
  const handleMoveSubTask = (subTaskId: string, direction: -1 | 1): void => {
    const next = moveIdBy(subTasks.map((item) => item.id), subTaskId, direction)
    if (next) void applySubTaskOrder(next)
  }

  // ポインターの位置から、落とす行と前後を決める（行のすき間や最後の行より下でも置ける）
  const subTaskDropAt = (clientY: number): { orderedIds: string[]; target: { id: string; position: DropPosition } } | null => {
    if (!draggingSubTaskId) return null
    const rows = Array.from(subTaskListRef.current?.querySelectorAll<HTMLElement>('[data-subtask-row]') ?? []).map((row) => {
      const rect = row.getBoundingClientRect()
      return { id: row.dataset.subtaskRow ?? '', top: rect.top, height: rect.height }
    })
    const target = dropTargetAt(clientY, rows)
    const orderedIds = target ? moveIdTo(subTasks.map((item) => item.id), draggingSubTaskId, target.id, target.position) : null
    return target && orderedIds ? { orderedIds, target } : null
  }

  const handleSubTaskListDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!draggingSubTaskId) return
    event.preventDefault()
    const drop = subTaskDropAt(event.clientY)
    event.dataTransfer.dropEffect = drop ? 'move' : 'none'
    setSubTaskDropTarget((previous) => {
      if (!drop) return null
      return previous?.id === drop.target.id && previous.position === drop.target.position ? previous : drop.target
    })
  }

  const handleSubTaskListDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!draggingSubTaskId) return
    event.preventDefault()
    const drop = subTaskDropAt(event.clientY)
    setDraggingSubTaskId(null)
    setSubTaskDropTarget(null)
    if (drop) void applySubTaskOrder(drop.orderedIds)
  }

  // ドラッグ中は、詳細の上下の端に近づけるとスクロールする
  useEffect(() => {
    if (!draggingSubTaskId) return
    const container = scrollParentOf(subTaskListRef.current)
    if (!container) return
    const handleDragOver = (event: DragEvent): void => autoScrollNearEdge(container, event.clientY)
    window.addEventListener('dragover', handleDragOver)
    return () => window.removeEventListener('dragover', handleDragOver)
  }, [draggingSubTaskId])

  const renderSubTaskRow = (subTask: { id: string; title: string }, content: React.ReactNode): React.JSX.Element => (
    <div
      key={subTask.id}
      data-subtask-row={subTask.id}
      style={{ position: 'relative', display: 'flex', alignItems: 'stretch', gap: 6, opacity: draggingSubTaskId === subTask.id ? 0.45 : 1 }}
    >
      {subTaskDropTarget?.id === subTask.id && <div aria-hidden="true" style={subTaskDropLineStyle(subTaskDropTarget.position)} />}
      <SubTaskDragHandle
        title={subTask.title}
        disabled={subTaskReorderPending || saving}
        onDragStart={(event) => {
          const row = event.currentTarget.closest('[data-subtask-row]')
          if (row) event.dataTransfer.setDragImage(row, 16, 20)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', subTask.id)
          setDraggingSubTaskId(subTask.id)
        }}
        onDragEnd={() => {
          setDraggingSubTaskId(null)
          setSubTaskDropTarget(null)
        }}
        onMove={(direction) => handleMoveSubTask(subTask.id, direction)}
      />
      <div style={{ flex: 1, minWidth: 0 }}>{content}</div>
    </div>
  )

  const handleSave = async (): Promise<void> => {
    if (!todo || savingRef.current) return
    if (!(editData.title ?? '').trim()) { onShowToast('タスク名を入力してください', 'error'); return }

    if (editableSubTasks.some((subTask) => !subTask.title.trim())) {
      onShowToast('サブタスク名を入力してください', 'error')
      return
    }
    if (editableSubTasks.some((subTask) => subTask.start_date && subTask.due_date && subTask.start_date > subTask.due_date)) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }
    if (editData.start_date && editData.due_date && editData.start_date > editData.due_date) {
      onShowToast('開始日は期限以前にしてください', 'error')
      return
    }

    const nextEditData = { ...editData, title: editData.title!.trim() }
    const taskPatch = buildEditPatch(editBaseRef.current, nextEditData)
    const changedSubTasks = editableSubTasks.flatMap((draft) => {
      const base = subTaskBasesRef.current.get(draft.id)
      if (!base) return []
      const normalized = { ...draft, title: draft.title.trim(), description: draft.description === base.description ? draft.description : draft.description.trim(), progress: clampProgress(draft.done ? 100 : draft.progress) }
      const patch = buildEditPatch(base, normalized)
      return Object.keys(patch).length ? [{ draft: normalized, patch }] : []
    })
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    let savedTask = false
    let savedChildren = 0
    let writesComplete = false
    const updatedSubTasks: SubTask[] = []
    try {
      if (Object.keys(taskPatch).length) {
        await onUpdate(todo.id, taskPatch)
        savedTask = true
        editBaseRef.current = { ...editBaseRef.current, ...nextEditData }
      }
      // Remember successful parts so a retry only saves the remaining drafts.
      for (const { draft, patch } of changedSubTasks) {
        updatedSubTasks.push(await window.api.subtaskUpdate(draft.id, patch))
        subTaskBasesRef.current.set(draft.id, draft)
        savedChildren++
      }
      writesComplete = true
      if (!mountedRef.current) return
      const latest = await window.api.todoGetAll()
      if (!mountedRef.current) return
      const saved = latest.find((item) => item.id === todo.id)
      setDescriptionDraft(saved?.description ?? nextEditData.description ?? '')
      setDescriptionBase(saved?.description ?? nextEditData.description ?? '')
      await loadSubTasks(todo.id)
      if (!mountedRef.current) return
      setEditing(false)
      const extendedTo = updatedSubTasks.map((item) => item.parent_due_date_extended_to).filter(Boolean).sort().at(-1)
      onShowToast(extendedTo ? `タスクを更新し、親期限を${extendedTo}まで延長しました` : 'タスクを更新しました')
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'タスクを保存できませんでした'
      if (writesComplete) {
        if (mountedRef.current) { setEditing(false); onShowToast(`変更は保存しましたが、表示を更新できませんでした: ${failure}`, 'error') }
        return
      }
      const summary = savedTask || savedChildren ? `タスク${savedTask ? 'の変更は保存済み' : 'は未変更'}、サブタスク${savedChildren}件は保存済みです。残りの編集内容は保持しています。` : '編集内容は保持しています。'
      if (mountedRef.current) { setSaveError(`${failure} ${summary}`); onShowToast(`${failure} ${summary}`, 'error') }
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  // 説明・メモは自動で保存する（入力が止まって1.5秒後・欄から離れたとき・Ctrl+Enter）。
  // 保存中も入力は止めない。保存中に書き足した分は、保存が終わったあとに続けて保存する
  const handleDescriptionSave = async (): Promise<void> => {
    if (!todoId || descriptionSavingRef.current || descriptionDraft === descriptionBase) return

    const draft = descriptionDraft
    descriptionSavingRef.current = true
    try {
      setDescriptionSaving(true)
      await onUpdate(todoId, { description: draft, expected_values: { description: descriptionBase } })
      setDescriptionBase(draft)
      setDescriptionFailedDraft(null)
      setEditData((previous) => ({ ...previous, description: draft }))
    } catch (error) {
      setDescriptionFailedDraft(draft)
      onShowToast(error instanceof Error ? error.message : '説明を保存できませんでした', 'error')
    } finally {
      descriptionSavingRef.current = false
      setDescriptionSaving(false)
    }
  }

  const handleMemoSave = async (): Promise<void> => {
    if (!todoId || memoSavingRef.current || memoDraft === memoBase) return
    const draft = memoDraft
    memoSavingRef.current = true
    try {
      setMemoSaving(true)
      await onUpdate(todoId, { memo: draft, expected_values: { memo: memoBase } })
      setMemoBase(draft)
      setMemoFailedDraft(null)
    } catch (error) {
      setMemoFailedDraft(draft)
      onShowToast(error instanceof Error ? error.message : 'メモを保存できませんでした', 'error')
    } finally {
      memoSavingRef.current = false
      setMemoSaving(false)
    }
  }

  // 入力が止まって1.5秒たったら保存する。失敗した内容のままなら送り直さない
  useEffect(() => {
    if (!todoId || editing || descriptionSaving || descriptionDraft === descriptionBase || descriptionDraft === descriptionFailedDraft) return
    const timer = window.setTimeout(() => { void handleDescriptionSave() }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptionBase, descriptionDraft, descriptionFailedDraft, descriptionSaving, editing, todoId])

  useEffect(() => {
    if (!todoId || editing || memoSaving || memoDraft === memoBase || memoDraft === memoFailedDraft) return
    const timer = window.setTimeout(() => { void handleMemoSave() }, AUTOSAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, memoBase, memoDraft, memoFailedDraft, memoSaving, todoId])

  const handleAddSubTask = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!todo || savingRef.current) return

    const titles = newSubTask.title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    if (titles.length === 0) return
    if (newSubTask.start_date && newSubTask.due_date && newSubTask.start_date > newSubTask.due_date) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }

    const createdItems: SubTask[] = []
    const remainingTitles = [...titles]
    try {
      for (const title of titles) {
        const created = await window.api.subtaskCreate(todo.id, {
          title,
          description: newSubTask.description?.trim() ?? '',
          assignee_id: users.length > 0 ? newSubTask.assignee_id ?? null : null,
          start_date: newSubTask.start_date ?? null,
          due_date: newSubTask.due_date ?? null,
          progress: clampProgress(newSubTask.progress ?? 0)
        })
        createdItems.push(created)
        if (editing) {
          const base = createEditableSubTasks([created])[0]
          subTaskBasesRef.current.set(created.id, base)
          setEditableSubTasks((previous) => previous.some((item) => item.id === created.id) ? previous : [...previous, base])
        }
        remainingTitles.shift()
        setNewSubTask((previous) => ({ ...previous, title: remainingTitles.join('\n') }))
      }
    } catch (error) {
      if (createdItems.length > 0) setSubTasks((previous) => [...previous, ...createdItems])
      onShowToast(`${createdItems.length}件は追加済みです。残りを再試行できます: ${error instanceof Error ? error.message : '追加できませんでした'}`, 'error')
      return
    }
    setNewSubTask((previous) => ({ title: '', description: '', assignee_id: previous.assignee_id ?? null, start_date: toDateKey(new Date()), due_date: null, progress: 0 }))
    setSubTasks((previous) => [...previous, ...createdItems])
    const extendedTo = createdItems.map((item) => item.parent_due_date_extended_to).filter(Boolean).sort().at(-1)
    if (extendedTo) onShowToast(`サブタスクに合わせて親タスクの期限を${extendedTo}まで延長しました`)
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

  const handleAddProgressNote = async (): Promise<void> => {
    if (!todoId || noteSaving) return
    const body = noteDraft.trim()
    if (!body) return
    try {
      setNoteSaving(true)
      const created = await window.api.progressNoteCreate(todoId, body)
      setProgressNotes((previous) => [created, ...previous])
      setNoteDraft('')
      window.localStorage.removeItem(progressDraftKey)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを追加できませんでした', 'error')
    } finally {
      setNoteSaving(false)
    }
  }

  // 進捗ログの表示は報告タブと同じ（返信・いいね・要相談つき）。操作の結果で1件だけ差し替える
  const patchProgressNote = (updated: ProgressNote): void => {
    setProgressNotes((previous) => previous.map((note) => note.id === updated.id ? updated : note))
  }

  const handleUpdateProgressNote = async (id: string, body: string): Promise<boolean> => {
    const trimmed = body.trim()
    if (!trimmed) return false
    try {
      patchProgressNote(await window.api.progressNoteUpdate(id, trimmed))
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを更新できませんでした', 'error')
      return false
    }
  }

  const handleDeleteProgressNote = async (id: string): Promise<void> => {
    if (!window.confirm('この進捗ログを削除しますか？\n付いている返信も一緒に削除されます。')) return
    try {
      await window.api.progressNoteDelete(id)
      setProgressNotes((previous) => previous.filter((note) => note.id !== id))
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '進捗ログを削除できませんでした', 'error')
    }
  }

  const pendingNoteActionsRef = useRef<Set<string>>(new Set())
  const runNoteAction = async (key: string, action: () => Promise<ProgressNote>, failure: string, success?: string): Promise<void> => {
    if (pendingNoteActionsRef.current.has(key)) return
    pendingNoteActionsRef.current.add(key)
    try {
      patchProgressNote(await action())
      if (success) onShowToast(success)
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : failure, 'error')
    } finally {
      pendingNoteActionsRef.current.delete(key)
    }
  }

  const handleReplyProgressNote = async (noteId: string, body: string, parentCommentId: string | null): Promise<boolean> => {
    const trimmed = body.trim()
    if (!trimmed) return false
    try {
      patchProgressNote(await window.api.progressNoteCommentCreate(noteId, trimmed, parentCommentId))
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '返信できませんでした', 'error')
      return false
    }
  }

  // 「@」の候補（自分を呼んでも通知は届かないので外す）
  const mentionUsers = users.filter((user) => user.id !== currentUser?.id)

  const canModifyNote = (note: ProgressNote): boolean =>
    currentUser == null || currentUser.role === 'admin' || note.user_id === currentUser.id

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
  const isDone = todo.status === 'done'
  const isArchived = todo.status === 'archived'
  const listMode = isListTodo(todo)
  // 編集中は「使い方」の選択に合わせて、期限・繰り返し・進捗の欄を出し分ける
  const editingListMode = Boolean(editData.list_mode)
  const doneCount = subTasks.filter((subTask) => subTask.done).length
  const subTaskProgress = subTasks.length > 0
    ? Math.round(subTasks.reduce((sum, subTask) => sum + clampProgress(Boolean(subTask.done) ? 100 : subTask.progress ?? 0), 0) / subTasks.length)
    : null
  const visibleTodoIds = new Set(allTodos.map((candidate) => candidate.id))
  const predecessorDependencies = dependencies.filter(
    (dependency) => dependency.successor_todo_id === todo.id && visibleTodoIds.has(dependency.predecessor_todo_id)
  )
  const successorDependencies = dependencies.filter(
    (dependency) => dependency.predecessor_todo_id === todo.id && visibleTodoIds.has(dependency.successor_todo_id)
  )
  const blockedCandidateIds = new Set(
    (dependencyDraft.mode === 'predecessor' ? predecessorDependencies : successorDependencies)
      .map((dependency) => dependencyDraft.mode === 'predecessor' ? dependency.predecessor_todo_id : dependency.successor_todo_id)
  )
  const dependencyCandidates = allTodos.filter((candidate) => candidate.id !== todo.id && !blockedCandidateIds.has(candidate.id))

  const startEditing = (): void => {
    if (childDraftIds.size > 0 && !window.confirm('未保存のサブタスクの変更があります。全体編集に切り替えますか？')) return
    const base = createEditData(todo)
    const childBases = createEditableSubTasks(subTasks)
    editBaseRef.current = descriptionDraft !== descriptionBase ? { ...base, description: descriptionBase } : base
    subTaskBasesRef.current = new Map(childBases.map((item) => [item.id, item]))
    setEditData({ ...base, description: descriptionDraft })
    setEditableSubTasks(childBases)
    setSaveError('')
    setEditing(true)
  }

  const cancelEditing = (): void => {
    if (savingRef.current) return
    const changed = Object.keys(buildEditPatch(editBaseRef.current, editData)).length > 0
      || editableSubTasks.some((draft) => {
        const base = subTaskBasesRef.current.get(draft.id)
        return base ? Object.keys(buildEditPatch(base, draft)).length > 0 : false
      })
    if (changed && !window.confirm('未保存の変更があります。編集を閉じてもよいですか？')) return
    setEditData(createEditData(todo))
    setEditableSubTasks(createEditableSubTasks(subTasks))
    setEditing(false)
    setSaveError('')
  }

  const duplicateTodo = async (): Promise<void> => {
    const created = await window.api.todoCreate({
      title: `${todo.title}（コピー）`, description: todo.description, memo: todo.memo,
      category_id: todo.category_id, assignee_id: todo.assignee_id, priority: todo.priority,
      status: 'not_started', progress: 0, start_date: todo.start_date, due_date: todo.due_date,
      list_mode: todo.list_mode
    })
    for (const subTask of subTasks) {
      await window.api.subtaskCreate(created.id, {
        title: subTask.title, description: subTask.description, assignee_id: subTask.assignee_id,
        start_date: subTask.start_date, due_date: subTask.due_date, progress: 0,
        recurrence: subTask.recurrence, recurrence_workdays: subTask.recurrence_workdays, recurrence_day: subTask.recurrence_day
      })
    }
    onShowToast(`「${created.title}」を作成しました`)
  }

  const saveAsTemplate = (): void => {
    const name = window.prompt('テンプレート名を入力してください', todo.title)?.trim()
    if (!name) return
    const key = 'todo-templates'
    let templates: Array<{ name?: string }> = []
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown
      if (Array.isArray(parsed)) templates = parsed as Array<{ name?: string }>
    } catch { templates = [] }
    templates = templates.filter((template) => template.name !== name)
    templates.push({ name, todo: createEditData(todo), subTasks: subTasks.map((item) => ({ title: item.title, description: item.description, start_date: item.start_date, due_date: item.due_date, recurrence: item.recurrence, recurrence_workdays: item.recurrence_workdays, recurrence_day: item.recurrence_day })) } as { name: string })
    window.localStorage.setItem(key, JSON.stringify(templates))
    onShowToast(`テンプレート「${name}」を保存しました`)
  }

  // 詳細の欄。幅があるときは2列（左: 書く欄、右: 状態などの欄と記録）、狭いときは1列に並べる
  const quickPropsSection = (
    <>
          {!editing && (
            <QuickProperties
              todo={todo}
              categories={categories}
              users={users}
              onUpdate={onUpdate}
              onShowToast={onShowToast}
            />
          )}
    </>
  )

  const checklistSection = (
    <>
          {/* ToDoリストは中の項目を毎日使うので、いちばん上に出す */}
          {listMode && (
            <TodoChecklist
              todo={todo}
              items={subTasks}
              users={users}
              disabled={saving}
              onItemsChange={setSubTasks}
              onDelete={(id) => void handleDeleteSubTask(id)}
              onShowToast={onShowToast}
            />
          )}
    </>
  )

  const timerSection = (
    <>
          <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: 4 }}>計測時間</div>
              <TimerDisplay elapsedSeconds={isRunning ? elapsedSeconds : 0} isRunning={isRunning} />
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>合計 {totalMinutes}分</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {isRunning ? (
                <>
                  <input disabled={timerStopping} value={stopNote} onChange={(event) => setStopNote(event.target.value)} placeholder="停止メモ" style={{ ...inputStyle, width: 160, fontSize: '0.8rem', padding: '6px 8px' }} />
                  <button disabled={timerStopping} onClick={() => {
                    if (timerStoppingRef.current) return
                    timerStoppingRef.current = true
                    setTimerStopping(true)
                    void onStopTimer(stopNote || undefined).then(() => {
                      if (mountedRef.current) setStopNote('')
                    }).catch(() => { /* App displays the error; preserve the memo for retry. */ }).finally(() => {
                      timerStoppingRef.current = false
                      if (mountedRef.current) setTimerStopping(false)
                    })
                  }} style={buttonStyle('#ef4444')}>{timerStopping ? '停止中…' : '停止'}</button>
                </>
              ) : (
                <button onClick={() => void onStartTimer(todo.id)} style={buttonStyle('#4ade80', '#000')}>開始</button>
              )}
            </div>
          </div>
    </>
  )

  const editSection = (
    <>
          {editing && (
            <fieldset disabled={saving} style={{ border: 0, margin: 0, minWidth: 0, background: '#1e293b', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={labelStyle}>種類</label>
                <select
                  value={editingListMode ? 'list' : 'task'}
                  aria-label="種類"
                  onChange={(event) => {
                    const list = event.target.value === 'list'
                    // ToDoリストは繰り返し（次回分の作成）を持たない。期限はそのまま（空にすると期限なし）
                    setEditData((previous) => list ? { ...previous, list_mode: 1, recurrence: null } : { ...previous, list_mode: 0 })
                  }}
                  style={inputStyle}
                >
                  <option value="task">タスク（開始日と期限を決めて進める）</option>
                  <option value="list">ToDoリスト（毎日・毎週のチェックや細かいやることをまとめる）</option>
                </select>
                {editingListMode && !listMode && (
                  <div style={{ marginTop: 4, fontSize: '0.72rem', color: '#a5b4fc', lineHeight: 1.5 }}>
                    保存すると繰り返し（次回分の作成）を外します。期限はそのままです（期限なしにするときは期限を空にします）。今のサブタスクはそのまま項目になります（繰り返しは項目ごとに設定できます）。
                  </div>
                )}
                {!editingListMode && listMode && (
                  <div style={{ marginTop: 4, fontSize: '0.72rem', color: '#fde68a', lineHeight: 1.5 }}>
                    保存すると、項目の繰り返し（毎日・毎週など）を外し、サブタスクに戻します。
                  </div>
                )}
              </div>
              <div><label style={labelStyle}>説明</label><textarea value={editData.description ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, description: event.target.value }))} rows={4} style={{ ...inputStyle, resize: 'vertical' }} /></div>
              <div style={{ display: 'flex', gap: 10 }}><div style={{ flex: 1 }}><label style={labelStyle}>開始日</label><input type="date" value={editData.start_date?.slice(0, 10) ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, start_date: event.target.value || null }))} style={inputStyle} /></div><div style={{ flex: 1 }}><label style={labelStyle}>{editingListMode ? '期限（空にすると期限なし）' : '期限'}</label><input type="date" value={editData.due_date?.slice(0, 10) ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, due_date: event.target.value || null }))} style={inputStyle} /></div></div>
              <div style={{ display: 'flex', gap: 10 }}><div style={{ flex: 1 }}><label style={labelStyle}>カテゴリ</label><select value={editData.category_id ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, category_id: event.target.value || null }))} style={inputStyle}><option value="">なし</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div><div style={{ flex: 1 }}><label style={labelStyle}>優先度</label><select value={editData.priority ?? 3} onChange={(event) => setEditData((previous) => ({ ...previous, priority: Number(event.target.value) }))} style={inputStyle}><option value={1}>最低</option><option value={2}>低</option><option value={3}>中</option><option value={4}>高</option><option value={5}>最高</option></select></div></div>
              {!editingListMode && <div><label style={labelStyle}>繰り返し（完了にすると次回分を自動で作ります）</label><select value={editData.recurrence ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, recurrence: (event.target.value || null) as 'daily' | 'weekly' | 'monthly' | null }))} style={inputStyle}><option value="">なし</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="monthly">毎月</option></select></div>}
              {!editingListMode && editData.recurrence && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: '#cbd5e1', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(editData.recurrence_copy_subtasks ?? 0) === 1}
                    onChange={(event) => setEditData((previous) => ({ ...previous, recurrence_copy_subtasks: event.target.checked ? 1 : 0 }))}
                    style={{ accentColor: '#6366f1' }}
                  />
                  サブタスクも次回分に引き継ぐ（未完了状態で複製）
                </label>
              )}
              {!editingListMode && editData.recurrence && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: '#cbd5e1', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(editData.recurrence_skip_weekends ?? 0) === 1}
                    onChange={(event) => setEditData((previous) => ({ ...previous, recurrence_skip_weekends: event.target.checked ? 1 : 0 }))}
                    style={{ accentColor: '#6366f1' }}
                  />
                  土日をスキップする
                </label>
              )}
              {!editingListMode && editData.recurrence && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: '#cbd5e1', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(editData.recurrence_skip_holidays ?? 0) === 1}
                    onChange={(event) => setEditData((previous) => ({ ...previous, recurrence_skip_holidays: event.target.checked ? 1 : 0 }))}
                    style={{ accentColor: '#6366f1' }}
                  />
                  日本の祝日をスキップする
                </label>
              )}
              <div><label style={labelStyle}>状態</label><select value={editData.status ?? 'active'} onChange={(event) => setEditData((previous) => ({ ...previous, status: event.target.value as Todo['status'] }))} style={inputStyle}><option value="not_started">未着手</option><option value="active">進行中</option><option value="on_hold">保留中</option><option value="done">完了</option><option value="archived">アーカイブ</option></select></div>
              {users.length > 0 && (
                <div><label style={labelStyle}>担当者</label><AssigneePicker users={users} value={editData.assignee_id ?? null} onChange={(assigneeId) => setEditData((previous) => ({ ...previous, assignee_id: assigneeId, co_assignee_ids: (previous.co_assignee_ids ?? []).filter((id) => id !== assigneeId) }))} selectStyle={inputStyle} /></div>
              )}
              {users.length > 0 && (
                <div>
                  <label style={labelStyle}>サブ担当（複数選択可）</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {users.filter((user) => user.is_active === 1 && user.id !== (editData.assignee_id ?? null)).map((user) => {
                      const selected = (editData.co_assignee_ids ?? []).includes(user.id)
                      return (
                        <button
                          key={user.id}
                          onClick={() => setEditData((previous) => {
                            const current = previous.co_assignee_ids ?? []
                            return {
                              ...previous,
                              co_assignee_ids: selected ? current.filter((id) => id !== user.id) : [...current, user.id]
                            }
                          })}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            padding: '4px 10px', borderRadius: 99, cursor: 'pointer',
                            border: `1px solid ${selected ? user.color : '#334155'}`,
                            background: selected ? `${user.color}26` : '#0f172a',
                            color: selected ? '#e2e8f0' : '#64748b', fontSize: '0.78rem'
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
                          {user.display_name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {!editingListMode && <div><label style={labelStyle}>進捗 {editData.progress ?? 0}%</label><input type="range" min={0} max={100} step={5} value={editData.progress ?? 0} onChange={(event) => setEditData((previous) => ({ ...previous, progress: Number(event.target.value) }))} style={{ width: '100%', accentColor: '#6366f1' }} /></div>}
              <button onClick={() => void handleSave()} disabled={saving} style={{ ...buttonStyle('#6366f1'), alignSelf: 'flex-end' }}>{saving ? '保存中…' : '保存'}</button>
            </fieldset>
          )}
    </>
  )

  const progressSection = (
    <>
          {!editing && !listMode && (
            <div style={{ background: '#1e293b', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>進捗 <span style={{ color: '#64748b', fontSize: '0.68rem' }}>バーをドラッグ（←→キーでも可）。100%で完了になります</span></span>
              </div>
              <ProgressSlider
                value={todo.progress ?? 0}
                label={`${todo.title}の進捗率`}
                disabled={isArchived}
                onCommit={handleProgressCommit}
              />
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
    </>
  )

  const descriptionSection = (
    <>
          {!editing && (
            <section>
              <SectionHeading title="説明" summary="目的・やること（あまり変わらない内容）" />
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <textarea
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  onBlur={() => { if (descriptionDraft !== descriptionFailedDraft) void handleDescriptionSave() }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void handleDescriptionSave()
                    }
                  }}
                  aria-label="説明"
                  placeholder="例: 〇〇の見積もりを作って、△△さんに確認してもらう"
                  rows={descriptionDraft ? 4 : 2}
                  style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: descriptionDraft ? 100 : 56 }}
                />
                <TextLinks text={descriptionDraft} />
                <AutosaveStatus
                  saving={descriptionSaving}
                  dirty={descriptionDraft !== descriptionBase}
                  failed={descriptionFailedDraft !== null && descriptionDraft === descriptionFailedDraft}
                  length={descriptionDraft.length}
                  onRetry={() => { setDescriptionFailedDraft(null); void handleDescriptionSave() }}
                />
              </div>
            </section>
          )}
    </>
  )

  const memoSection = (
    <>
          {!editing && (
            <section>
              <SectionHeading title="メモ" summary="今の状況・次にやること（上書き。履歴は残りません）" detail="引き継ぎにも使えます。日付つきで残したい報告は、下の進捗ログに書きます。" />
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <textarea
                  value={memoDraft}
                  onChange={(event) => setMemoDraft(event.target.value)}
                  onBlur={() => { if (memoDraft !== memoFailedDraft) void handleMemoSave() }}
                  onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void handleMemoSave() } }}
                  aria-label="メモ"
                  placeholder="例: 〇〇待ち。返事が来たら△△に進む"
                  rows={memoDraft ? 5 : 2}
                  style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: memoDraft ? 120 : 56 }}
                />
                <TextLinks text={memoDraft} />
                <AutosaveStatus
                  saving={memoSaving}
                  dirty={memoDraft !== memoBase}
                  failed={memoFailedDraft !== null && memoDraft === memoFailedDraft}
                  length={memoDraft.length}
                  onRetry={() => { setMemoFailedDraft(null); void handleMemoSave() }}
                />
              </div>
            </section>
          )}
    </>
  )

  const progressLogSection = (
    <>
          {!editing && (
            <section>
              <SectionHeading
                title={<>進捗ログ {progressNotes.length > 0 && `(${progressNotes.length})`}</>}
                summary="日付つきで積み上がる報告"
                detail={`報告タブ・進捗タブに表示され、返信やリアクションが付きます。${users.length > 0 ? '「@名前」で呼ぶと相手に通知が届きます。' : ''}Ctrl+Enter でも投稿できます。`}
              />
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <MentionTextarea
                  value={noteDraft}
                  users={mentionUsers}
                  onValueChange={(value) => {
                    setNoteDraft(value)
                    if (todoId) {
                      if (value) window.localStorage.setItem(progressDraftKey, value)
                      else window.localStorage.removeItem(progressDraftKey)
                    }
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void handleAddProgressNote()
                    }
                  }}
                  aria-label="進捗ログを書く"
                  placeholder="例: 〇〇まで終わった。次は△△。□□で困っている"
                  rows={3}
                  style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: 72 }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{noteDraft.length}文字</div>
                  <button
                    onClick={() => void handleAddProgressNote()}
                    disabled={!noteDraft.trim() || noteSaving}
                    style={buttonStyle(!noteDraft.trim() || noteSaving ? '#1e293b' : '#6366f1', !noteDraft.trim() || noteSaving ? '#64748b' : '#fff')}
                  >
                    {noteSaving ? '投稿中...' : '投稿'}
                  </button>
                </div>
                {progressNotes.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {progressNotes.map((note) => (
                      <ProgressNoteThread
                        key={note.id}
                        note={note}
                        onToggleReaction={(noteId, emoji) => void runNoteAction(`reaction:${noteId}:${emoji}`, () => window.api.progressNoteReactionToggle(noteId, emoji), 'リアクションを更新できませんでした')}
                        onToggleCommentReaction={(commentId, emoji) => void runNoteAction(`reaction:${commentId}:${emoji}`, () => window.api.progressNoteCommentReactionToggle(commentId, emoji), 'リアクションを更新できませんでした')}
                        mentionUsers={mentionUsers}
                        onReply={handleReplyProgressNote}
                        onToggleDiscussion={(noteId, value) => void runNoteAction(`discussion:${noteId}`, () => window.api.progressNoteSetNeedsDiscussion(noteId, value), '要相談を切り替えられませんでした', value ? '要相談にしました' : '要相談を外しました')}
                        canModify={canModifyNote(note)}
                        onUpdate={handleUpdateProgressNote}
                        onDelete={(noteId) => void handleDeleteProgressNote(noteId)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
    </>
  )

  const subTaskSection = (
    <>
          {!listMode && (
          <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div style={sectionTitleStyle}>サブタスク {subTasks.length > 0 && `(${doneCount}/${subTasks.length})`}</div>
            <div
              ref={subTaskListRef}
              onDragOver={handleSubTaskListDragOver}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSubTaskDropTarget(null)
              }}
              onDrop={handleSubTaskListDrop}
              style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}
            >
              {editing
                ? editableSubTasks.map((subTask) => renderSubTaskRow(subTask, (
                      <EditableSubTaskItem
                        subTask={subTask}
                        users={users}
                        onChange={(data) => setEditableSubTasks((previous) => previous.map((item) => item.id === subTask.id ? { ...item, ...data } : item))}
                        onDelete={() => void handleDeleteSubTask(subTask.id)}
                      />
                )))
                : subTasks.map((subTask) => renderSubTaskRow(subTask, (
                      <ReadonlySubTaskItem
                        subTask={subTask}
                        users={users}
                        onToggle={() => void window.api.subtaskUpdate(subTask.id, { done: !subTask.done, expected_values: { done: Boolean(subTask.done) } }).then((updated) => setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item))).catch((error) => onShowToast(error instanceof Error ? error.message : 'サブタスクを更新できませんでした', 'error'))}
                        onSave={async (data) => {
                          const updated = await window.api.subtaskUpdate(subTask.id, data)
                          setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item))
                          if (updated.parent_due_date_extended_to) onShowToast(`親タスクの期限を${updated.parent_due_date_extended_to}まで延長しました`)
                        }}
                        onDelete={() => void handleDeleteSubTask(subTask.id)}
                        onShowToast={onShowToast}
                        onDirtyChange={(dirty) => handleChildDirty(subTask.id, dirty)}
                      />
                )))}
            </div>
            <form onSubmit={(event) => void handleAddSubTask(event)} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, border: '1px dashed #334155' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <textarea
                  value={newSubTask.title}
                  onChange={(event) => setNewSubTask((previous) => ({ ...previous, title: event.target.value }))}
                  onKeyDown={(event) => {
                    // Enter で追加、Shift+Enter で改行（複数行は1行ずつ追加）。日本語変換の確定の Enter では追加しない
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void handleAddSubTask(event)
                    }
                  }}
                  aria-label="追加するサブタスク名"
                  placeholder="＋ サブタスクを追加（Enterで追加・Shift+Enterで改行）"
                  rows={newSubTask.title.includes('\n') ? Math.min(6, newSubTask.title.split('\n').length + 1) : 1}
                  style={{ ...inputStyle, fontSize: '0.84rem', padding: '7px 9px', resize: 'vertical', flex: 1 }}
                />
                <button type="submit" disabled={!newSubTask.title.trim()} style={buttonStyle(newSubTask.title.trim() ? '#2563eb' : '#1e293b', newSubTask.title.trim() ? '#fff' : '#64748b')}>追加</button>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.72rem', color: '#94a3b8' }}>
                {users.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    担当
                    <select
                      value={newSubTask.assignee_id ?? ''}
                      onChange={(event) => setNewSubTask((previous) => ({ ...previous, assignee_id: event.target.value || null }))}
                      aria-label="追加するサブタスクの担当"
                      style={{ ...inputStyle, width: 'auto', fontSize: '0.76rem', padding: '3px 6px' }}
                    >
                      <option value="">担当なし</option>
                      {users.filter((user) => user.is_active === 1 || user.id === newSubTask.assignee_id).map((user) => (
                        <option key={user.id} value={user.id}>{user.display_name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  期限
                  <input type="date" value={newSubTask.due_date ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, due_date: event.target.value || null }))} aria-label="追加するサブタスクの期限" style={{ ...inputStyle, width: 'auto', fontSize: '0.76rem', padding: '3px 6px' }} />
                </label>
                <button type="button" onClick={() => setShowSubTaskDetails((previous) => !previous)} aria-expanded={showSubTaskDetails} style={{ background: 'none', border: 'none', padding: 0, color: '#93c5fd', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700 }}>
                  {showSubTaskDetails ? '▾ 閉じる' : '▸ 開始日・メモ・進捗'}
                </button>
              </div>
              {showSubTaskDetails && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={labelStyle}>開始日<input type="date" value={newSubTask.start_date ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, start_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} /></label>
                  <textarea value={newSubTask.description ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, description: event.target.value }))} placeholder="メモ..." aria-label="追加するサブタスクのメモ" rows={2} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.72rem', color: '#94a3b8' }}>
                    <span>進捗 {clampProgress(newSubTask.progress ?? 0)}%</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={clampProgress(newSubTask.progress ?? 0)}
                      onChange={(event) => setNewSubTask((previous) => ({ ...previous, progress: clampProgress(Number(event.target.value)) }))}
                      style={{ width: '100%', accentColor: progressColor(clampProgress(newSubTask.progress ?? 0)) }}
                    />
                  </label>
                </div>
              )}
            </form>
          </fieldset>
          )}
    </>
  )

  const dependencySection = (
    <>
          {/* ToDoリストは日程を持たないので、依存関係はすでにあるときだけ出す */}
          {(!listMode || dependencies.length > 0) && (
          <section>
            <SectionHeading title="依存関係" summary="前後のタスク" detail="先行タスクが終わってから、このタスクを始めます。待機日数を増やすと、先行タスクの完了後に間を空けられます。" />
            <div style={{ background: '#1e293b', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* 右の列（狭いとき）は2段に折り返す */}<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <select value={dependencyDraft.mode} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, mode: event.target.value as 'predecessor' | 'successor', relatedTodoId: '' }))} style={{ ...inputStyle, flex: '1 1 130px', width: 'auto', minWidth: 0 }}>
                  <option value="predecessor">先行タスクを追加</option>
                  <option value="successor">後続タスクを追加</option>
                </select>
                <select value={dependencyDraft.relatedTodoId} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, relatedTodoId: event.target.value }))} style={{ ...inputStyle, flex: '2 1 170px', width: 'auto', minWidth: 0 }}>
                  <option value="">タスクを選択</option>
                  {dependencyCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
                </select>
                <input type="number" min={0} max={60} value={dependencyDraft.lagDays} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, lagDays: event.target.value }))} placeholder="待機日数" aria-label="待機日数" title="先行タスクの完了から、何日空けて始めるか" style={{ ...inputStyle, flex: '0 0 88px', width: 88 }} />
                <button onClick={() => void handleCreateDependency()} style={buttonStyle('#2563eb')}>追加</button>
              </div>
              <DependencyList title="先行タスク" items={predecessorDependencies} getTodoId={(item) => item.predecessor_todo_id} getTitle={(item) => allTodos.find((candidate) => candidate.id === item.predecessor_todo_id)?.title ?? '不明なタスク'} reload={() => todoId ? loadDependencies(todoId) : Promise.resolve()} />
              <DependencyList title="後続タスク" items={successorDependencies} getTodoId={(item) => item.successor_todo_id} getTitle={(item) => allTodos.find((candidate) => candidate.id === item.successor_todo_id)?.title ?? '不明なタスク'} reload={() => todoId ? loadDependencies(todoId) : Promise.resolve()} />
            </div>
          </section>
          )}
    </>
  )

  const workLogSection = (
    <>
          <section>
            <div style={sectionTitleStyle}>作業ログ</div>
            {logs.length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>ログはまだありません</div>
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
    </>
  )

  const historySection = (
    <>
          {!editing && <TodoHistory todoId={todo.id} refreshKey={todo.updated_at} />}
    </>
  )
  const twoColumns = !editing && detailBodyWidth >= TWO_COLUMN_MIN_WIDTH

  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          padding: '20px 20px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderBottom: '1px solid #1e293b',
          background: '#0b1220'
        }}
      >
        <div style={{ width: '100%', minWidth: 0 }}>
          {editing ? (
            <input disabled={saving} value={editData.title ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, title: event.target.value }))} style={inputStyle} />
          ) : (
            <h2 style={{ fontSize: '1.1rem', color: '#e2e8f0', lineHeight: 1.4, margin: 0, overflowWrap: 'anywhere' }}>{todo.title}</h2>
          )}
        </div>
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!editing && !isArchived && (
            <button
              onClick={() => void toggleDone()}
              title={isDone ? '完了を取り消して、未完了に戻します' : listMode ? 'このToDoリストを使い終えたときに押します（中の項目のチェックとは別です）' : 'このタスクを完了にします'}
              style={isDone ? buttonStyle('#334155', '#cbd5e1') : listMode ? buttonStyle('#334155', '#cbd5e1') : buttonStyle('#15803d', '#f0fdf4')}
            >
              {isDone ? '完了を取り消す' : listMode ? 'リストを終える' : '✓ 完了にする'}
            </button>
          )}
          {!editing && todo.status === 'on_hold' && <Badge color="#c084fc">保留中</Badge>}
          {!editing && !isDone && !isArchived && (
            <button
              onClick={() => void onUpdate(todo.id, { status: todo.status === 'on_hold' ? 'active' : 'on_hold' }).then(() => onShowToast(todo.status === 'on_hold' ? '進行中に戻しました' : 'タスクを保留しました')).catch(() => onShowToast('状態を変更できませんでした', 'error'))}
              title={todo.status === 'on_hold' ? '保留をやめて、進行中に戻します' : '待ち状態などで作業を止めるときに使います。保留中は報告タブでも分かるように表示されます'}
              style={buttonStyle('#6b21a8')}
            >
              {todo.status === 'on_hold' ? '進行中に戻す' : '保留する'}
            </button>
          )}
          {!editing && !isDone && !isArchived && (
            <button onClick={() => void onAddToTodayPlan(todo.id)} disabled={isInTodayPlan} title="「計画」タブの今日の予定に入れます" style={buttonStyle(isInTodayPlan ? '#1e293b' : '#1e3a8a', isInTodayPlan ? '#64748b' : '#dbeafe')}>
              {isInTodayPlan ? '今日の計画に追加済み' : '今日の計画に追加'}
            </button>
          )}
          <button onClick={editing ? cancelEditing : startEditing} disabled={saving} title={editing ? undefined : 'タスク名・説明・繰り返し・サブ担当などをまとめて編集します'} style={buttonStyle('#334155')}>
            {editing ? '編集をやめる' : '編集'}
          </button>
          {!editing && currentUser && (
            <button
              disabled={subscriptionPending}
              onClick={() => void toggleSubscription()}
              title={subscribed ? 'このタスクに進捗ログや返信が付くと通知が届きます。押すとオフにします' : 'このタスクに進捗ログや返信が付いたら通知を受け取ります'}
              aria-pressed={subscribed}
              style={buttonStyle(subscribed ? '#14532d' : '#334155')}
            >
              {subscribed ? '🔔 更新通知: オン' : '🔕 更新通知: オフ'}
            </button>
          )}
          {!editing && (
            <NoteMenu
              items={[
                { label: '複製する（サブタスクも一緒に）', onSelect: () => void duplicateTodo() },
                { label: 'テンプレートとして保存', onSelect: saveAsTemplate }
              ]}
            />
          )}
        </div>
      </div>

      <div ref={detailBodyRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {saveError && <div role="alert" style={{ padding: 10, color: '#fecaca', border: '1px solid #ef4444', borderRadius: 8 }}>{saveError}</div>}
      {sectionLoadError && <div role="alert" style={{ padding: 10, borderRadius: 8, border: '1px solid #ef4444', background: '#450a0a', color: '#fecaca', fontSize: '0.8rem' }}>{sectionLoadError}<button onClick={() => { setSectionLoadError(null); void Promise.all([loadWorkLogs(todo.id), loadSubTasks(todo.id), loadDependencies(todo.id), loadProgressNotes(todo.id)]) }} style={{ marginLeft: 10, padding: '4px 8px', borderRadius: 6, border: '1px solid #ef4444', background: '#7f1d1d', color: '#fff' }}>再試行</button></div>}
      {twoColumns ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 360px)', gap: 20, alignItems: 'start' }}>
          <div style={detailColumnStyle}>
            {checklistSection}
            {descriptionSection}
            {memoSection}
            {subTaskSection}
            {progressLogSection}
          </div>
          <div style={detailColumnStyle}>
            {quickPropsSection}
            {timerSection}
            {progressSection}
            {dependencySection}
            {workLogSection}
            {historySection}
          </div>
        </div>
      ) : (
        <>
          {quickPropsSection}
          {checklistSection}
          {timerSection}
          {editSection}
          {progressSection}
          {descriptionSection}
          {memoSection}
          {subTaskSection}
          {progressLogSection}
          {dependencySection}
          {workLogSection}
          {historySection}
        </>
      )}
    </div>
    </div>
  )
}

const detailColumnStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }

// 説明・メモの下に出す保存の状態
function AutosaveStatus({ saving, dirty, failed, length, onRetry }: { saving: boolean; dirty: boolean; failed: boolean; length: number; onRetry: () => void }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.75rem', color: failed ? '#fca5a5' : dirty || saving ? '#93c5fd' : '#94a3b8' }}>
        {saving ? '保存中…' : failed ? '保存できませんでした' : dirty ? '入力が止まると保存します' : '保存済み'}
        {failed && !saving && (
          <button type="button" onClick={onRetry} style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid #ef4444', background: '#450a0a', color: '#fecaca', cursor: 'pointer', fontSize: '0.75rem' }}>再試行</button>
        )}
      </div>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{length}文字</div>
    </div>
  )
}

const HISTORY_PAGE_SIZE = 20
const HISTORY_FIELD_LABELS: Record<string, string> = {
  title: 'タスク名',
  description: '説明',
  memo: 'メモ',
  category: 'カテゴリ',
  assignee: '担当',
  co_assignees: 'サブ担当',
  status: '状態',
  priority: '優先度',
  progress: '進捗',
  start_date: '開始日',
  due_date: '期限',
  recurrence: '繰り返し',
  recurrence_copy_subtasks: '繰り返しでサブタスクも作る',
  list_mode: '種類'
}
const HISTORY_STATUS_LABELS: Record<string, string> = { not_started: '未着手', active: '進行中', on_hold: '保留中', done: '完了', archived: 'アーカイブ' }
const HISTORY_RECURRENCE_LABELS: Record<string, string> = { daily: '毎日', weekly: '毎週', monthly: '毎月' }

function historyValue(field: string, value: string | null): string {
  if (value == null || value === '') return 'なし'
  if (field === 'status') return HISTORY_STATUS_LABELS[value] ?? value
  if (field === 'priority') return PRIORITY_OPTIONS.find((option) => String(option.value) === value)?.label ?? value
  if (field === 'progress') return `${value}%`
  if (field === 'start_date' || field === 'due_date') return formatShortDate(value.slice(0, 10))
  if (field === 'recurrence') return HISTORY_RECURRENCE_LABELS[value] ?? value
  if (field === 'recurrence_copy_subtasks') return value === '1' ? 'する' : 'しない'
  if (field === 'list_mode') return value === '1' ? 'ToDoリスト' : 'タスク'
  return value
}

function historyText(entry: TodoHistoryEntry): string {
  const label = HISTORY_FIELD_LABELS[entry.field] ?? entry.field
  // 説明・メモは本文を返さないので、変えたことだけを出す
  if (entry.field === 'description' || entry.field === 'memo') return `${label}を変更`
  return `${label}: ${historyValue(entry.field, entry.old_value)} → ${historyValue(entry.field, entry.new_value)}`
}

function formatHistoryTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// このタスクの変更履歴（いつ・誰が・何を変えたか）。新しい順に20件ずつ
function TodoHistory({ todoId, refreshKey }: { todoId: string; refreshKey: string }): React.JSX.Element {
  const [entries, setEntries] = useState<TodoHistoryEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  const load = useCallback(async (offset: number): Promise<void> => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const page = await window.api.todoChangeGetByTodo(todoId, { limit: HISTORY_PAGE_SIZE, offset })
      if (request !== requestRef.current) return
      setEntries((previous) => offset === 0 ? page : [...previous, ...page])
      setHasMore(page.length === HISTORY_PAGE_SIZE)
    } catch (loadError) {
      if (request === requestRef.current) setError(loadError instanceof Error ? loadError.message : '変更履歴を読み込めませんでした')
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [todoId])

  // タスクが変わったら最初の20件を取り直す
  useEffect(() => {
    void load(0)
  }, [load, refreshKey])

  return (
    <section>
      <SectionHeading title="変更履歴" summary="いつ・誰が変えたか" />
      {error ? (
        <div role="alert" style={{ fontSize: '0.8rem', color: '#fca5a5' }}>
          {error}
          <button type="button" onClick={() => void load(0)} style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, border: '1px solid #ef4444', background: '#450a0a', color: '#fecaca', cursor: 'pointer', fontSize: '0.75rem' }}>再試行</button>
        </div>
      ) : entries.length === 0 ? (
        <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>{loading ? '読み込み中…' : '変更はまだありません'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map((entry) => (
            <div key={entry.id} style={{ background: '#1e293b', borderRadius: 6, padding: '6px 10px', fontSize: '0.8rem', color: '#e2e8f0', lineHeight: 1.5 }}>
              <span style={{ color: '#94a3b8', marginRight: 8, whiteSpace: 'nowrap' }}>{formatHistoryTime(entry.created_at)}{entry.user_name ? `　${entry.user_name}` : ''}</span>
              <span style={{ overflowWrap: 'anywhere' }}>{historyText(entry)}</span>
            </div>
          ))}
          {hasMore && (
            <button type="button" disabled={loading} onClick={() => void load(entries.length)} style={{ alignSelf: 'flex-start', marginTop: 2, padding: '4px 10px', borderRadius: 6, border: '1px solid #334155', background: 'transparent', color: '#cbd5e1', cursor: loading ? 'default' : 'pointer', fontSize: '0.78rem' }}>
              {loading ? '読み込み中…' : 'もっと見る'}
            </button>
          )}
        </div>
      )}
    </section>
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

// サブタスクを並べ替えるつかみ。ドラッグで好きな位置へ、フォーカスして Alt+↑↓ で1つずつ動かす。
// 行の中には進捗バーのドラッグや入力欄があるので、行全体ではなくつかみだけをドラッグできるようにする
function SubTaskDragHandle({ title, disabled, onDragStart, onDragEnd, onMove }: {
  title: string
  disabled: boolean
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onMove: (direction: -1 | 1) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={`「${title}」を並べ替え`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      title="ドラッグして並べ替え（Alt+↑↓ でも動かせます）"
      draggable={!disabled}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        onDragStart(event)
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        if (disabled || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        onMove(event.key === 'ArrowUp' ? -1 : 1)
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 20,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        background: hovered && !disabled ? '#1e293b' : 'transparent',
        color: disabled ? '#334155' : hovered ? '#cbd5e1' : '#64748b',
        cursor: disabled ? 'default' : 'grab',
        fontSize: '0.95rem',
        userSelect: 'none'
      }}
    >
      ⠿
    </div>
  )
}

// 落とす位置を示す線。行のすき間（6px）の真ん中に引く
function subTaskDropLineStyle(position: DropPosition): React.CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    [position === 'before' ? 'top' : 'bottom']: -4,
    height: 2,
    borderRadius: 2,
    background: '#38bdf8',
    boxShadow: '0 0 0 1px rgba(56, 189, 248, 0.25)',
    pointerEvents: 'none',
    zIndex: 2
  }
}

function SubTaskAssigneeSelect({ users, value, onChange, disabled = false }: { users: PublicUser[]; value: string | null; onChange: (value: string | null) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      aria-label="サブタスクの担当"
      style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }}
    >
      <option value="">担当なし</option>
      {users.filter((user) => user.is_active === 1 || user.id === value).map((user) => (
        <option key={user.id} value={user.id}>{user.display_name}{user.is_active === 1 ? '' : '（無効）'}</option>
      ))}
    </select>
  )
}

function EditableSubTaskItem({ subTask, users, onChange, onDelete }: { subTask: EditableSubTask; users: PublicUser[]; onChange: (data: Partial<EditableSubTask>) => void; onDelete: () => void }): React.JSX.Element {
  const progress = clampProgress(subTask.done ? 100 : subTask.progress)

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#1e293b' }}>
      <button onClick={() => onChange({ done: !subTask.done, progress: subTask.done ? Math.min(progress, 99) : 100 })} style={{ width: 16, height: 16, borderRadius: 3, marginTop: 8, border: `2px solid ${subTask.done ? '#4ade80' : '#475569'}`, background: subTask.done ? '#4ade80' : 'transparent', cursor: 'pointer' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={subTask.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="サブタスク名" style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }} />
        <textarea value={subTask.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="メモ..." rows={2} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
        {users.length > 0 && <SubTaskAssigneeSelect users={users} value={subTask.assignee_id} onChange={(assigneeId) => onChange({ assignee_id: assigneeId })} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input type="date" aria-label="開始日" title="開始日" value={subTask.start_date ?? ''} onChange={(event) => onChange({ start_date: event.target.value || null })} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} />
          <input type="date" aria-label="期限" title="期限" value={subTask.due_date ?? ''} onChange={(event) => onChange({ due_date: event.target.value || null })} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} />
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.72rem', color: '#94a3b8' }}>
          <span>進捗 {progress}%</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={progress}
            onChange={(event) => {
              const nextProgress = clampProgress(Number(event.target.value))
              onChange({ progress: nextProgress, done: nextProgress >= 100 })
            }}
            style={{ width: '100%', accentColor: progressColor(progress) }}
          />
        </label>
      </div>
      <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>削除</button>
    </div>
  )
}

interface SubTaskDraft {
  title: string
  description: string
  assignee_id: string | null
  start_date: string | null
  due_date: string | null
  progress: number
}

// 閲覧モードでもサブタスク単体をその場で編集できる項目。
// ✎ でフォームに切り替わり、保存するとそのサブタスクだけ即時更新される。
function ReadonlySubTaskItem({ subTask, users, onToggle, onSave, onDelete, onShowToast, onDirtyChange }: {
  subTask: SubTask
  users: PublicUser[]
  onToggle: () => void
  onSave: (data: UpdateSubTaskInput) => Promise<void>
  onDelete: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<SubTaskDraft>({ title: '', description: '', assignee_id: null, start_date: null, due_date: null, progress: 0 })
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const baseRef = useRef<SubTaskDraft>({ title: '', description: '', assignee_id: null, start_date: null, due_date: null, progress: 0 })
  const [saveError, setSaveError] = useState('')
  const dirtyCallbackRef = useRef(onDirtyChange)
  dirtyCallbackRef.current = onDirtyChange
  useEffect(() => { dirtyCallbackRef.current(editing && Object.keys(buildEditPatch(baseRef.current, draft)).length > 0) }, [draft, editing])
  useEffect(() => () => dirtyCallbackRef.current(false), [])
  const progress = clampProgress(Boolean(subTask.done) ? 100 : subTask.progress ?? 0)

  const startEditing = (): void => {
    const original = {
      title: subTask.title,
      description: subTask.description ?? '',
      assignee_id: subTask.assignee_id ?? null,
      start_date: subTask.start_date ?? null,
      due_date: subTask.due_date ?? null,
      progress: Boolean(subTask.done) ? 100 : clampProgress(subTask.progress ?? 0)
    }
    baseRef.current = original
    setDraft(original)
    setSaveError('')
    setEditing(true)
  }

  const handleSave = async (): Promise<void> => {
    if (savingRef.current) return
    if (!draft.title.trim()) {
      onShowToast('サブタスク名を入力してください', 'error')
      return
    }
    if (draft.start_date && draft.due_date && draft.start_date > draft.due_date) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }
    savingRef.current = true
    setSaveError('')
    try {
      setSaving(true)
      const patch = buildEditPatch(baseRef.current, { ...draft, title: draft.title.trim() })
      if (Object.keys(patch).length) await onSave(patch)
      setEditing(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'サブタスクを更新できませんでした'
      setSaveError(message)
      onShowToast(message, 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // 進捗はタスク本体と同じスライダー。離したときに1回だけ保存する
  const handleProgressCommit = async (nextProgress: number): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await onSave({ progress: nextProgress, expected_values: { progress: subTask.progress ?? 0 } })
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'サブタスクの進捗を更新できませんでした', 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const assigneeName = subTask.assignee_name ?? (subTask.assignee_id ? users.find((user) => user.id === subTask.assignee_id)?.display_name ?? null : null)

  if (editing) {
    return (
      <fieldset disabled={saving} style={{ margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 8, background: '#1e293b', border: '1px solid #6366f1' }}>
        {saveError && <div role="alert" style={{ color: '#fecaca', fontSize: '0.8rem' }}>{saveError}</div>}
        <input
          value={draft.title}
          onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void handleSave() } }}
          placeholder="サブタスク名"
          autoFocus
          style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }}
        />
        <textarea value={draft.description} onChange={(event) => setDraft((previous) => ({ ...previous, description: event.target.value }))} placeholder="メモ..." rows={2} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
        {users.length > 0 && <SubTaskAssigneeSelect users={users} value={draft.assignee_id} onChange={(assigneeId) => setDraft((previous) => ({ ...previous, assignee_id: assigneeId }))} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>開始日<input type="date" value={draft.start_date ?? ''} onChange={(event) => setDraft((previous) => ({ ...previous, start_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} /></label>
          <label style={{ ...labelStyle, marginBottom: 0 }}>期限<input type="date" value={draft.due_date ?? ''} onChange={(event) => setDraft((previous) => ({ ...previous, due_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: '0.8rem', padding: '6px 8px' }} /></label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.72rem', color: '#94a3b8' }}>
          <span>進捗 {draft.progress}%</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={draft.progress}
            onChange={(event) => setDraft((previous) => ({ ...previous, progress: clampProgress(Number(event.target.value)) }))}
            style={{ width: '100%', accentColor: progressColor(draft.progress) }}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button onClick={() => setEditing(false)} style={buttonStyle('#334155')}>キャンセル</button>
          <button onClick={() => void handleSave()} disabled={saving} style={buttonStyle('#6366f1')}>{saving ? '保存中...' : '保存'}</button>
        </div>
      </fieldset>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 6, background: '#1e293b' }}>
      <button
        onClick={onToggle}
        title={subTask.done ? '未完了に戻す' : '完了にする'}
        aria-label={subTask.done ? `${subTask.title}を未完了に戻す` : `${subTask.title}を完了にする`}
        style={{ width: 16, height: 16, borderRadius: 3, marginTop: 2, flexShrink: 0, border: `2px solid ${subTask.done ? '#4ade80' : '#475569'}`, background: subTask.done ? '#4ade80' : 'transparent', cursor: 'pointer', padding: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', color: subTask.done ? '#475569' : '#cbd5e1', textDecoration: subTask.done ? 'line-through' : 'none', wordBreak: 'break-word' }}>{subTask.title}</div>
        {(assigneeName || subTask.start_date || subTask.due_date) && (
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.68rem', color: '#94a3b8' }}>
            {assigneeName && <AssigneeChip name={assigneeName} color={subTask.assignee_color ?? null} fontSize={0.66} />}
            {(subTask.start_date || subTask.due_date) && (
              <span style={{ color: subTask.done ? '#94a3b8' : getDueDateColor(subTask.due_date) || '#94a3b8' }}>
                {subTask.start_date ? formatShortDate(subTask.start_date) : ''}{subTask.start_date && subTask.due_date ? ' → ' : ''}{subTask.due_date ? `期限 ${formatShortDate(subTask.due_date)}` : ''}
              </span>
            )}
          </div>
        )}
        {subTask.description && <div style={{ marginTop: 2, fontSize: '0.75rem', color: subTask.done ? '#334155' : '#64748b', whiteSpace: 'pre-wrap' }}><LinkedText text={subTask.description} /></div>}
        <div style={{ marginTop: 2 }}>
          <ProgressSlider
            value={progress}
            height={6}
            valueMinWidth={34}
            disabled={saving}
            label={`${subTask.title}の進捗率`}
            onCommit={handleProgressCommit}
          />
        </div>
      </div>
      <button onClick={startEditing} title="編集" aria-label={`${subTask.title}を編集`} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>✎</button>
      <button onClick={onDelete} title="サブタスクを削除" style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>削除</button>
    </div>
  )
}

const STATUS_OPTIONS: Array<{ value: Todo['status']; label: string; color: string }> = [
  { value: 'not_started', label: '未着手', color: '#94a3b8' },
  { value: 'active', label: '進行中', color: '#60a5fa' },
  { value: 'on_hold', label: '保留中', color: '#c084fc' },
  { value: 'done', label: '完了', color: '#4ade80' }
]

const PRIORITY_OPTIONS = [
  { value: 1, label: '最低' },
  { value: 2, label: '低' },
  { value: 3, label: '中' },
  { value: 4, label: '高' },
  { value: 5, label: '最高' }
]

function formatShortDate(dateKey: string): string {
  const [, m, d] = dateKey.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}`
}

function dueRemainingLabel(dueDate: string): string {
  const diff = diffDaysFromToday(dueDate)
  if (diff < 0) return `${Math.abs(diff)}日遅れ`
  if (diff === 0) return '今日まで'
  return `あと${diff}日`
}

// 「編集」を押さなくても、よく変える項目（状態・優先度・カテゴリ・担当・日程）をその場で変えられる欄。
// 選択肢はその場で保存する。日付は年の入力途中で保存すると依存関係の再計算が走るので、「変更」→「保存」の明示操作にする。
function QuickProperties({ todo, categories, users, onUpdate, onShowToast }: {
  todo: Todo
  categories: Category[]
  users: PublicUser[]
  onUpdate: (id: string, data: UpdateTodoInput) => Promise<void>
  onShowToast: (message: string, type?: 'success' | 'error') => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [startDraft, setStartDraft] = useState('')
  const [dueDraft, setDueDraft] = useState('')
  const isArchived = todo.status === 'archived'
  const listMode = isListTodo(todo)
  const statusTone = STATUS_OPTIONS.find((option) => option.value === todo.status)?.color ?? '#94a3b8'
  const dueColor = todo.status === 'done' ? '' : getDueDateColor(todo.due_date)

  const save = async (data: UpdateTodoInput, message: string): Promise<boolean> => {
    setSaving(true)
    try {
      await onUpdate(todo.id, data)
      onShowToast(message)
      return true
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '変更できませんでした', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const openScheduleEditor = (): void => {
    setStartDraft(todo.start_date?.slice(0, 10) ?? '')
    setDueDraft(todo.due_date?.slice(0, 10) ?? '')
    setEditingSchedule(true)
  }

  const saveSchedule = async (): Promise<void> => {
    if (startDraft && dueDraft && startDraft > dueDraft) {
      onShowToast('開始日は期限以前にしてください', 'error')
      return
    }
    const data: UpdateTodoInput = {}
    if ((startDraft || null) !== (todo.start_date?.slice(0, 10) ?? null)) data.start_date = startDraft || null
    if ((dueDraft || null) !== (todo.due_date?.slice(0, 10) ?? null)) data.due_date = dueDraft || null
    if (Object.keys(data).length === 0) {
      setEditingSchedule(false)
      return
    }
    if (await save(data, '日程を変更しました')) setEditingSchedule(false)
  }

  const fieldLabelStyle: React.CSSProperties = { fontSize: '0.68rem', color: '#64748b', marginBottom: 3 }
  const compactSelectStyle: React.CSSProperties = { ...inputStyle, padding: '5px 8px', fontSize: '0.8rem' }

  return (
    <div style={{ background: '#162033', border: '1px solid #1e293b', borderRadius: 10, padding: '10px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: '10px 12px' }}>
      <div>
        <div style={fieldLabelStyle}>状態</div>
        {isArchived ? (
          <div style={{ fontSize: '0.8rem', color: '#94a3b8', padding: '5px 0' }}>アーカイブ</div>
        ) : (
          <select
            value={todo.status}
            disabled={saving}
            aria-label="状態"
            onChange={(event) => {
              const status = event.target.value as Todo['status']
              const label = STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
              void save({ status }, `状態を「${label}」にしました`)
            }}
            style={{ ...compactSelectStyle, color: statusTone, fontWeight: 700 }}
          >
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
      </div>
      <div>
        <div style={fieldLabelStyle}>優先度</div>
        <select
          value={todo.priority}
          disabled={saving || isArchived}
          aria-label="優先度"
          onChange={(event) => {
            const priority = Number(event.target.value)
            void save({ priority }, `優先度を「${PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? priority}」にしました`)
          }}
          style={compactSelectStyle}
        >
          {PRIORITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div>
        <div style={fieldLabelStyle}>カテゴリ</div>
        <select
          value={todo.category_id ?? ''}
          disabled={saving || isArchived}
          aria-label="カテゴリ"
          onChange={(event) => {
            const categoryId = event.target.value || null
            void save({ category_id: categoryId }, `カテゴリを「${categories.find((category) => category.id === categoryId)?.name ?? 'なし'}」にしました`)
          }}
          style={{ ...compactSelectStyle, color: todo.category_color ?? '#e2e8f0' }}
        >
          <option value="">なし</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </div>
      {users.length > 0 && (
        <div>
          <div style={fieldLabelStyle}>担当</div>
          <AssigneePicker
            users={users.filter((user) => user.is_active === 1 || user.id === todo.assignee_id)}
            value={todo.assignee_id}
            onChange={(assigneeId) => {
              if (assigneeId === todo.assignee_id) return
              void save({
                assignee_id: assigneeId,
                // 主担当にした人はサブ担当から外す（編集画面と同じ）
                co_assignee_ids: (todo.co_assignees ?? []).map((item) => item.user_id).filter((id) => id !== assigneeId)
              }, `担当を「${users.find((user) => user.id === assigneeId)?.display_name ?? '未割り当て'}」にしました`)
            }}
            selectStyle={compactSelectStyle}
          />
          {(todo.co_assignees ?? []).length > 0 && (
            <div style={{ marginTop: 3, fontSize: '0.68rem', color: '#94a3b8' }} title="サブ担当は「編集」で変えられます">
              副: {(todo.co_assignees ?? []).map((item) => item.display_name).join('、')}
            </div>
          )}
        </div>
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <div style={fieldLabelStyle}>日程</div>
        {editingSchedule ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.76rem', color: '#94a3b8' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              開始
              <input type="date" value={startDraft} onChange={(event) => setStartDraft(event.target.value)} aria-label="開始日" style={{ ...compactSelectStyle, width: 'auto' }} />
            </label>
            <span>→</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              期限
              <input
                type="date"
                value={dueDraft}
                onChange={(event) => setDueDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void saveSchedule() }}
                aria-label="期限"
                style={{ ...compactSelectStyle, width: 'auto' }}
              />
            </label>
            {listMode && dueDraft && (
              <button onClick={() => setDueDraft('')} title="期限を外して、期限なしのリストにします" style={{ ...buttonStyle('#334155'), padding: '3px 10px', fontSize: '0.74rem' }}>期限なし</button>
            )}
            <button onClick={() => setEditingSchedule(false)} style={buttonStyle('#334155')}>取消</button>
            <button onClick={() => void saveSchedule()} disabled={saving} style={buttonStyle('#2563eb')}>{saving ? '保存中…' : '保存'}</button>
            <span style={{ width: '100%', fontSize: '0.66rem', color: '#64748b' }}>依存関係のある後続タスクも自動で再計算されます</span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.82rem' }}>
            <span style={{ color: '#cbd5e1' }}>開始 {todo.start_date ? formatShortDate(todo.start_date) : '未設定'}</span>
            {listMode && !todo.due_date ? (
              <span style={{ color: '#a5b4fc' }} title="期限を決めるときは「変更」から入れます。使い終えたら「リストを終える」を押します">→ 期限なし</span>
            ) : (
              <>
                <span style={{ color: '#475569' }}>→</span>
                <span style={{ color: dueColor || '#cbd5e1', fontWeight: dueColor ? 700 : 400 }}>期限 {todo.due_date ? formatShortDate(todo.due_date) : '未設定'}</span>
                {todo.due_date && todo.status !== 'done' && <span style={{ fontSize: '0.74rem', color: dueColor || '#64748b' }}>（{dueRemainingLabel(todo.due_date)}）</span>}
              </>
            )}
            {!isArchived && (
              <button onClick={openScheduleEditor} style={{ ...buttonStyle('#334155'), padding: '3px 10px', fontSize: '0.74rem' }}>変更</button>
            )}
          </div>
        )}
      </div>
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

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function clampLag(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(60, Math.max(0, Math.round(value)))
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
