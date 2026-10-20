import { LinkedText, TextLinks } from './LinkedText'
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Category, CreateSubTaskInput, DailyPlanItem, ProgressNote, PublicUser, SubTask, Todo, TodoDependency, TodoHistoryEntry, UpdateSubTaskInput, UpdateTodoInput, WorkLog } from '../types'
import { RunningTimerDisplay, TimerDisplay } from './TimerDisplay'
import { useElapsedSeconds } from '../hooks/useElapsedSeconds'
import { AssigneeChip, AssigneePicker } from './AssigneePicker'
import { diffDaysFromToday, formatShortDate, getDueDateColor, toDateKey } from '../lib/dueDate'
import { subscribeProgressDraftChanges } from '../lib/legacyProgressDrafts'
import { buildEditPatch } from '../lib/editChanges'
import { ProgressSlider } from './ProgressSlider'
import { NoteMenu, ProgressNoteThread } from './ProgressNoteThread'
import { MentionTextarea } from './MentionTextarea'
import { ON_TRACK_NOTE, ProgressNoteHelpers, cleanProgressNote, withProgressNoteTemplate } from './ProgressNoteHelpers'
import { TodoChecklist } from './TodoChecklist'
import { isListTodo } from '../lib/todoList'
import { autoScrollNearEdge, dropTargetAt, moveIdBy, moveIdTo, scrollParentOf, type DropPosition } from '../lib/reorder'
import { copyTextToClipboard } from '../lib/clipboard'
import { taskLinkFor } from '../lib/urlState'
import { dataInk, textOnFill } from '../lib/theme'
import { changeFieldLabel } from '../lib/changeFields'
import { FOCUS_PROGRESS_LOG_EVENT, FOCUS_TASK_DETAIL_EVENT, consumeTaskDetailFocus } from '../lib/appEvents'
import { taskOptionLabel } from '../lib/taskLabel'
import { TODO_RECURRENCE_OPTIONS, nextRecurrenceDue, recurrenceDoneMessage, recurrenceKindLabel, recurrenceReopenMessage, todoRecurrenceLabel } from '../lib/recurrence'
import { notifyReopenedRecurrence } from '../lib/recurrenceUndo'
import { confirmAction } from '../lib/confirm'

interface Props {
  todo: Todo | null
  allTodos: Todo[]
  categories: Category[]
  users?: PublicUser[]
  currentUser?: PublicUser | null
  todayPlanItems: DailyPlanItem[]
  runningTodoId: string | null
  /** 計測を始めた時刻（計測中でなければ null） */
  timerStartTime: string | null
  onUpdate: (id: string, data: UpdateTodoInput) => Promise<void>
  onStartTimer: (todoId: string) => Promise<void>
  onStopTimer: (note?: string) => Promise<void>
  onAddToTodayPlan: (todoId: string) => Promise<DailyPlanItem>
  onShowToast: (message: string, type?: 'success' | 'error', action?: { label?: string; run?: () => void; key?: string }) => void
  onDirtyChange?: (dirty: boolean) => void
  /** 「⋯」から片付ける（一覧から外す。あとで戻せる。完全な削除はアーカイブの中から） */
  onArchive?: (id: string) => Promise<void>
  /** アーカイブしたタスクを完全に消す（「⋯」から。確かめてから） */
  onDelete?: (id: string) => Promise<void>
  /** ほかの画面（チーム・報告など）から開いたとき、その画面へ戻るボタン */
  returnTo?: { label: string; onReturn: () => void } | null
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
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 6,
  color: 'var(--slate-200)',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box'
}

/** 画面には出さず、読み上げにだけ伝える文の置き場 */
// fixed にする（absolute だと、位置の基準のない所では文書の下へ置かれてページ全体が伸び、上部のタブが押し上げられた）
const visuallyHiddenStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap'
}

const fieldErrorStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 'var(--font-control)',
  color: 'var(--red-300)',
  fontWeight: 600
}

/** 説明・メモを自動で保存するまでの、入力が止まってからの時間 */
const AUTOSAVE_DELAY_MS = 1500
/** 詳細の欄がこの幅以上あれば2列にする（左: 説明・メモ・サブタスク・進捗ログ、右: 状態などの欄・計測・進捗・依存関係・記録） */
const TWO_COLUMN_MIN_WIDTH = 880

// 欄の見出し（h3。読み上げで欄ごとに飛べるように見出しにし、見た目は小さい灰色の文字のまま）
const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontWeight: 400,
  fontSize: 'var(--font-control)',
  color: 'var(--slate-400)',
  marginBottom: 8,
  textTransform: 'uppercase',
  letterSpacing: '0.05em'
}

// 欄の見出し。何を書く欄かを短く添え、詳しい説明は ⓘ（マウスを乗せる・キーボードで選ぶ）で出す。
// 以前は欄の上に毎回長い説明文を出していたが、慣れた人には縦の場所を取るだけだった
function SectionHeading({ title, summary, detail }: { title: React.ReactNode; summary?: string; detail?: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <h3 style={{ ...sectionTitleStyle, marginBottom: 0 }}>{title}</h3>
      {summary && <span style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>{summary}</span>}
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
        style={{ fontSize: 'var(--font-control)', color: open ? 'var(--slate-200)' : 'var(--slate-400)', cursor: 'help', lineHeight: 1 }}
      >
        ⓘ
      </span>
      <span
        id={tipId}
        role="tooltip"
        hidden={!open}
        style={{ position: 'absolute', top: 'calc(100% + 6px)', left: -8, zIndex: 20, width: 280, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--slate-700)', background: 'var(--slate-900)', color: 'var(--slate-200)', fontSize: 'var(--font-control)', lineHeight: 1.6, boxShadow: '0 10px 24px color-mix(in srgb, var(--slate-950) 50%, transparent)', textTransform: 'none', letterSpacing: 0 }}
      >
        {text}
      </span>
    </span>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--font-control)',
  color: 'var(--text-subtle)',
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
  timerStartTime,
  onUpdate,
  onStartTimer,
  onStopTimer,
  onAddToTodayPlan,
  onShowToast,
  onDirtyChange,
  onArchive,
  onDelete,
  returnTo = null
}: Props): React.JSX.Element {
  const [logs, setLogs] = useState<WorkLog[]>([])
  const [subTasks, setSubTasks] = useState<SubTask[]>([])
  const [dependencies, setDependencies] = useState<TodoDependency[]>([])
  const [progressNotes, setProgressNotes] = useState<ProgressNote[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  // 説明の自動保存が終わったときに、全体の編集を始めていたかを見る（保存の途中で「編集」を押すことがある）
  const editingRef = useRef(false)
  editingRef.current = editing
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState('')
  // 保存できない入力は、知らせだけでなく欄の下にも出し、その欄へフォーカスを移す
  const [fieldError, setFieldError] = useState<{ field: 'title' | 'dates'; message: string } | null>(null)
  const [subTaskAnnouncement, setSubTaskAnnouncement] = useState('')
  const editStartDateInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!editing) setFieldError(null) }, [editing])
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
  // 「編集」を開いたらタスク名の欄へ、保存・やめたら「編集」ボタンへフォーカスを移す（キーボードで迷子にならないように）
  const editTitleInputRef = useRef<HTMLInputElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const wasEditingRef = useRef(false)
  useEffect(() => {
    if (editing) editTitleInputRef.current?.focus()
    else if (wasEditingRef.current) editButtonRef.current?.focus()
    wasEditingRef.current = editing
  }, [editing])
  // 進捗バーの横の「進捗ログを書く」から、下の方にある入力欄へ移る
  const progressLogInputId = useId()
  const focusProgressLogInput = (): void => {
    const input = document.getElementById(progressLogInputId)
    if (!input) return
    input.scrollIntoView({ block: 'center', behavior: 'smooth' })
    input.focus({ preventScroll: true })
  }
  // Ctrl+K の「進捗ログを書く」からも入力欄へ移る
  const focusProgressLogRef = useRef(focusProgressLogInput)
  focusProgressLogRef.current = focusProgressLogInput
  useEffect(() => {
    const handle = (): void => focusProgressLogRef.current()
    window.addEventListener(FOCUS_PROGRESS_LOG_EVENT, handle)
    return () => window.removeEventListener(FOCUS_PROGRESS_LOG_EVENT, handle)
  }, [])
  // Ctrl+K でタスクを開いたときは、題名へフォーカスを移す（続けて Tab で詳細の中を進める）
  const titleHeadingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const handle = (): void => { if (titleHeadingRef.current && consumeTaskDetailFocus()) titleHeadingRef.current.focus() }
    window.addEventListener(FOCUS_TASK_DETAIL_EVENT, handle)
    return () => window.removeEventListener(FOCUS_TASK_DETAIL_EVENT, handle)
  }, [])
  // 合図を受けたときにまだ描かれていなかった（開いたばかりのタスク）ときは、題名が出たときに移す
  const headingShown = Boolean(todo)
  useEffect(() => {
    if (headingShown && titleHeadingRef.current && consumeTaskDetailFocus()) titleHeadingRef.current.focus()
  }, [headingShown])
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
  // 進捗の保存は順番に送る。続けて操作したとき、前の保存が画面に反映される前の値を「変更前」として送ると、
  // 自分の変更をほかの人の変更と取り違えて弾かれるため、直前に保存した値を「変更前」に使う
  const progressSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const lastSavedProgressRef = useRef<{ todoId: string; progress: number; status: Todo['status'] } | null>(null)
  // 画面の値が保存した値に追いついたら、画面の値を使う（そのあとのほかの人の変更を正しく見分けるため）
  useEffect(() => {
    const saved = lastSavedProgressRef.current
    if (saved && saved.todoId === todo?.id && saved.progress === todo?.progress) lastSavedProgressRef.current = null
  }, [todo?.id, todo?.progress])
  // サブタスクをチェックする前の進捗（チェックを外したときに戻す）
  const progressBeforeDoneRef = useRef(new Map<string, number>())
  // 続けて進捗を変えたときは、知らせを1枚にまとめ、「元に戻す」で最初の値まで戻す
  const progressUndoBaseRef = useRef<{ todoId: string; progress: number; status: Todo['status']; at: number } | null>(null)
  const handleProgressCommit = (progress: number): Promise<void> => {
    const run = progressSaveChainRef.current.then(() => commitProgress(progress))
    progressSaveChainRef.current = run.catch(() => undefined)
    return run
  }
  const commitProgress = async (progress: number): Promise<void> => {
    if (!todoId) return
    const saved = lastSavedProgressRef.current?.todoId === todoId ? lastSavedProgressRef.current : null
    const previous = saved ?? { progress: todo?.progress ?? 0, status: todo?.status ?? 'not_started' }
    if (progress === previous.progress) return
    try {
      await onUpdate(todoId, { progress, expected_values: { progress: previous.progress } })
      lastSavedProgressRef.current = { todoId, progress, status: progress >= 100 && previous.status !== 'on_hold' ? 'done' : previous.status === 'not_started' && progress > 0 ? 'active' : previous.status }
      // バーを押し間違えたときにすぐ戻せるようにする（状態が自動で変わった分も戻す）。
      // 12秒以内に続けて変えたときは、最初に変える前の値へ戻す
      const recentBase = progressUndoBaseRef.current
      const base = recentBase && recentBase.todoId === todoId && Date.now() - recentBase.at < 12000
        ? recentBase
        : { todoId, progress: previous.progress, status: previous.status, at: 0 }
      progressUndoBaseRef.current = { ...base, at: Date.now() }
      const undo = {
        label: '元に戻す',
        key: `progress:${todoId}`,
        run: () => {
          progressUndoBaseRef.current = null
          void onUpdate(todoId, { progress: base.progress, status: base.status }).then(
            () => {
              lastSavedProgressRef.current = { todoId, progress: base.progress, status: base.status }
              onShowToast(`進捗を${base.progress}%に戻しました`)
            },
            (error: unknown) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
          )
        }
      }
      onShowToast(progress >= 100 && previous.status !== 'done'
        ? '進捗が100%になったので完了にしました'
        : `進捗を${progress}%にしました${base.progress !== previous.progress ? `（${base.progress}%から）` : ''}`, 'success', undo)
    } catch (error) {
      lastSavedProgressRef.current = null
      onShowToast(error instanceof Error ? error.message : '進捗を更新できませんでした', 'error')
    }
  }

  // 完了・完了の取り消し（タスク一覧の丸と同じ動き）
  const toggleDone = async (): Promise<void> => {
    if (!todo) return
    const nextStatus: Todo['status'] = todo.status === 'done'
      ? (todo.progress > 0 ? 'active' : 'not_started')
      : 'done'
    const previousStatus = todo.status
    const todoId = todo.id
    const changedAt = new Date().toISOString()
    const source = todo
    // 一覧で完了にしたときと同じく、知らせから元に戻せるようにする。繰り返しの完了を戻したときは、作られた次回分も片付けられるようにする
    const undo = {
      label: '元に戻す',
      // 完了と取り消しを続けたとき、前の知らせ（古い「元に戻す」）を置き換える
      key: `status:${todoId}`,
      run: () => {
        void onUpdate(todoId, { status: previousStatus }).then(
          () => nextStatus === 'done' && recurrenceKindLabel(source.recurrence)
            ? void notifyReopenedRecurrence(source, changedAt, onShowToast, () => undefined)
            : onShowToast('元に戻しました'),
          (error: unknown) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
        )
      }
    }
    try {
      await onUpdate(todo.id, { status: nextStatus })
      if (nextStatus === 'done') {
        const recurrenceMessage = recurrenceDoneMessage(todo)
        // サブタスクが残ったまま完了にしたときは件数を書き添える（一覧で完了にしたときと同じ）
        const openSubTaskCount = todo.list_mode ? 0 : subTasks.filter((subTask) => subTask.progress < 100).length
        const doneMessage = openSubTaskCount > 0 ? `完了にしました（未完了のサブタスクが${openSubTaskCount}件あります）` : '完了にしました'
        onShowToast(recurrenceMessage ? `${doneMessage}。${recurrenceMessage}` : doneMessage, 'success', undo)
      } else {
        const reopenMessage = recurrenceReopenMessage(todo)
        onShowToast(reopenMessage ? `完了を取り消しました。${reopenMessage}` : '完了を取り消しました', 'success', undo)
      }
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '状態を変更できませんでした', 'error')
    }
  }

  const handleDeleteSubTask = async (subTaskId: string): Promise<void> => {
    const target = subTasks.find((item) => item.id === subTaskId)
    if (!(await confirmAction(`サブタスク「${target?.title ?? ''}」を削除しますか？`, { confirmLabel: '削除する', danger: true }))) return
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
    if (!(editData.title ?? '').trim()) {
      setFieldError({ field: 'title', message: 'タスク名を入力してください' })
      onShowToast('タスク名を入力してください', 'error')
      editTitleInputRef.current?.focus()
      return
    }

    if (editableSubTasks.some((subTask) => !subTask.title.trim())) {
      onShowToast('サブタスク名を入力してください', 'error')
      return
    }
    if (editableSubTasks.some((subTask) => subTask.start_date && subTask.due_date && subTask.start_date > subTask.due_date)) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }
    if (editData.start_date && editData.due_date && editData.start_date > editData.due_date) {
      setFieldError({ field: 'dates', message: '開始日は期限以前にしてください' })
      onShowToast('開始日は期限以前にしてください', 'error')
      editStartDateInputRef.current?.focus()
      return
    }
    setFieldError(null)

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
    const previousBase = descriptionBase
    descriptionSavingRef.current = true
    try {
      setDescriptionSaving(true)
      await onUpdate(todoId, { description: draft, expected_values: { description: previousBase } })
      setDescriptionBase(draft)
      setDescriptionFailedDraft(null)
      if (editingRef.current) {
        // 保存の途中で全体の編集を始めていたら、編集中の内容は上書きしない。
        // 変更前の値（基準）だけを保存した値に合わせ、あとで全体を保存したときにぶつからないようにする
        if (editBaseRef.current.description === previousBase) editBaseRef.current = { ...editBaseRef.current, description: draft }
      } else {
        setEditData((previous) => ({ ...previous, description: draft }))
      }
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

  // Enter のすぐ後に次の名前を打っても前の名前とつながらないよう、送る前に入力欄を空にし、
  // 保存中に押された分は順番待ちにして1件ずつ追加する
  const subTaskQueueRef = useRef<Array<{ todoId: string; input: CreateSubTaskInput }>>([])
  const subTaskAddingRef = useRef(false)
  const handleAddSubTask = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!todo || savingRef.current) return

    const titles = newSubTask.title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    if (titles.length === 0) return
    if (newSubTask.start_date && newSubTask.due_date && newSubTask.start_date > newSubTask.due_date) {
      onShowToast('サブタスクの日付が不正です', 'error')
      return
    }

    for (const title of titles) {
      subTaskQueueRef.current.push({
        todoId: todo.id,
        input: {
          title,
          description: newSubTask.description?.trim() ?? '',
          assignee_id: users.length > 0 ? newSubTask.assignee_id ?? null : null,
          start_date: newSubTask.start_date ?? null,
          due_date: newSubTask.due_date ?? null,
          progress: clampProgress(newSubTask.progress ?? 0)
        }
      })
    }
    setNewSubTask((previous) => ({ ...previous, title: '' }))
    if (subTaskAddingRef.current) return

    subTaskAddingRef.current = true
    const createdItems: SubTask[] = []
    try {
      while (subTaskQueueRef.current.length > 0) {
        const next = subTaskQueueRef.current[0]
        const created = await window.api.subtaskCreate(next.todoId, next.input)
        subTaskQueueRef.current.shift()
        createdItems.push(created)
        setSubTasks((previous) => previous.some((item) => item.id === created.id) ? previous : [...previous, created])
        if (editingRef.current) {
          const base = createEditableSubTasks([created])[0]
          subTaskBasesRef.current.set(created.id, base)
          setEditableSubTasks((previous) => previous.some((item) => item.id === created.id) ? previous : [...previous, base])
        }
      }
    } catch (error) {
      // 追加できなかった分は入力欄へ戻し、そのまま再試行できるようにする
      const failedTitles = subTaskQueueRef.current.map((item) => item.input.title)
      subTaskQueueRef.current = []
      setNewSubTask((previous) => ({ ...previous, title: [...failedTitles, previous.title].filter((value) => value.trim()).join('\n') }))
      onShowToast(`${createdItems.length}件は追加済みです。残りを再試行できます: ${error instanceof Error ? error.message : '追加できませんでした'}`, 'error')
      return
    } finally {
      subTaskAddingRef.current = false
    }
    // 名前の欄は、保存中に打ち始めた次の名前を消さないようそのまま残す
    setNewSubTask((previous) => ({ title: previous.title, description: '', assignee_id: previous.assignee_id ?? null, start_date: toDateKey(new Date()), due_date: null, progress: 0 }))
    // 入力欄にフォーカスを残したまま続けて足せるので、知らせは出さず読み上げだけで伝える（一覧には増えた行が見える）
    setSubTaskAnnouncement(createdItems.length === 1 ? `サブタスク「${createdItems[0].title}」を追加しました` : `サブタスクを${createdItems.length}件追加しました`)
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

  // bodyOverride を渡すと（「予定どおり」）、入力中の文には触らずにその文を投稿する
  const handleAddProgressNote = async (bodyOverride?: string): Promise<void> => {
    if (!todoId || noteSaving) return
    const body = cleanProgressNote(bodyOverride ?? noteDraft)
    if (!body) {
      if (noteDraft.trim()) onShowToast('ひな形の見出しだけでは投稿できません。やったことなどを書いてください', 'error')
      return
    }
    try {
      setNoteSaving(true)
      const created = await window.api.progressNoteCreate(todoId, body)
      setProgressNotes((previous) => [created, ...previous])
      if (bodyOverride === undefined) {
        setNoteDraft('')
        window.localStorage.removeItem(progressDraftKey)
      }
      // 報告タブ・進捗タブと同じく、投稿したことを知らせる
      onShowToast('進捗ログを投稿しました')
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
    if (!(await confirmAction('この進捗ログを削除しますか？\n付いている返信も一緒に削除されます。元に戻せません。', { confirmLabel: '削除する', danger: true }))) return
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
      onShowToast('返信しました')
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-subtle)' }}>
        タスクを選択してください
      </div>
    )
  }

  const isRunning = runningTodoId === todo.id
  const isInTodayPlan = todayPlanItems.some((item) => item.todo_id === todo.id)
  const loggedSeconds = logs.reduce((sum, log) => sum + log.duration_seconds, 0)
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
  // アーカイブしたタスクは選択肢に出さない（同じ名前の次回分などと見分けがつかないため）
  const dependencyCandidates = allTodos.filter((candidate) => candidate.id !== todo.id && candidate.status !== 'archived' && !blockedCandidateIds.has(candidate.id))

  const startEditing = async (): Promise<void> => {
    if (childDraftIds.size > 0 && !(await confirmAction('未保存のサブタスクの変更があります。全体編集に切り替えますか？\nサブタスクで書きかけの変更は消えます。', { confirmLabel: '切り替える' }))) return
    const base = createEditData(todo)
    const childBases = createEditableSubTasks(subTasks)
    editBaseRef.current = descriptionDraft !== descriptionBase ? { ...base, description: descriptionBase } : base
    subTaskBasesRef.current = new Map(childBases.map((item) => [item.id, item]))
    setEditData({ ...base, description: descriptionDraft })
    setEditableSubTasks(childBases)
    setSaveError('')
    setEditing(true)
  }

  const cancelEditing = async (): Promise<void> => {
    if (savingRef.current) return
    const changed = Object.keys(buildEditPatch(editBaseRef.current, editData)).length > 0
      || editableSubTasks.some((draft) => {
        const base = subTaskBasesRef.current.get(draft.id)
        return base ? Object.keys(buildEditPatch(base, draft)).length > 0 : false
      })
    if (changed && !(await confirmAction('未保存の変更があります。編集をやめますか？\n入力した変更は消えます。', { confirmLabel: '変更を捨てる', cancelLabel: '編集を続ける', danger: true }))) return
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

  const copyTaskLink = async (): Promise<void> => {
    if (!todo) return
    try {
      await copyTextToClipboard(taskLinkFor(window.location.origin, window.location.pathname, todo.id))
      onShowToast('タスクのリンクをコピーしました')
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : 'リンクをコピーできませんでした', 'error')
    }
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
          {/* 狭いパネルでは停止メモと停止を下の段へ折り返す（右端で切れないように） */}
          <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)', marginBottom: 4 }}>計測時間</div>
              {isRunning ? <RunningTimerDisplay startTime={timerStartTime} /> : <TimerDisplay elapsedSeconds={0} isRunning={false} />}
              <div style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)', marginTop: 2 }}>合計 <TotalMinutes loggedSeconds={loggedSeconds} startTime={isRunning ? timerStartTime : null} />分</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 }}>
              {isRunning ? (
                <>
                  <input disabled={timerStopping} value={stopNote} onChange={(event) => setStopNote(event.target.value)} placeholder="停止メモ" aria-label="停止メモ" style={{ ...inputStyle, width: 160, maxWidth: '100%', flex: '1 1 120px', fontSize: 'var(--font-control)', padding: '6px 8px' }} />
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
                  }} style={buttonStyle('var(--red-500)')}>{timerStopping ? '停止中…' : '停止'}</button>
                </>
              ) : (
                <button onClick={() => void onStartTimer(todo.id)} title="このタスクの作業時間を計り始めます（終わったら「停止」）" style={buttonStyle('var(--green-400)', 'var(--black)')}>計測開始</button>
              )}
            </div>
          </div>
    </>
  )

  const editSection = (
    <>
          {editing && (
            <fieldset disabled={saving} style={{ border: 0, margin: 0, minWidth: 0, background: 'var(--slate-800)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                  <div style={{ marginTop: 4, fontSize: 'var(--font-caption)', color: 'var(--indigo-300)', lineHeight: 1.5 }}>
                    保存すると繰り返し（次回分の作成）を外します。期限はそのままです（期限なしにするときは期限を空にします）。今のサブタスクはそのまま項目になります（繰り返しは項目ごとに設定できます）。
                  </div>
                )}
                {!editingListMode && listMode && (
                  <div style={{ marginTop: 4, fontSize: 'var(--font-caption)', color: 'var(--amber-200)', lineHeight: 1.5 }}>
                    保存すると、項目の繰り返し（毎日・毎週など）を外し、サブタスクに戻します。
                  </div>
                )}
              </div>
              <div><label style={labelStyle}>説明</label><textarea aria-label="説明" value={editData.description ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, description: event.target.value }))} rows={4} style={{ ...inputStyle, resize: 'vertical' }} /></div>
              <div style={{ display: 'flex', gap: 10 }}><div style={{ flex: 1 }}><label style={labelStyle}>開始日</label><input ref={editStartDateInputRef} type="date" aria-label="開始日" aria-invalid={fieldError?.field === 'dates' || undefined} aria-describedby={fieldError?.field === 'dates' ? 'detail-dates-error' : undefined} value={editData.start_date?.slice(0, 10) ?? ''} onChange={(event) => { setEditData((previous) => ({ ...previous, start_date: event.target.value || null })); if (fieldError?.field === 'dates') setFieldError(null) }} style={fieldError?.field === 'dates' ? { ...inputStyle, borderColor: 'var(--red-500)' } : inputStyle} /></div><div style={{ flex: 1 }}><label style={labelStyle}>{editingListMode ? '期限（空にすると期限なし）' : '期限'}</label><input type="date" aria-label="期限" aria-invalid={fieldError?.field === 'dates' || undefined} aria-describedby={fieldError?.field === 'dates' ? 'detail-dates-error' : undefined} value={editData.due_date?.slice(0, 10) ?? ''} onChange={(event) => { setEditData((previous) => ({ ...previous, due_date: event.target.value || null })); if (fieldError?.field === 'dates') setFieldError(null) }} style={fieldError?.field === 'dates' ? { ...inputStyle, borderColor: 'var(--red-500)' } : inputStyle} /></div></div>
              {fieldError?.field === 'dates' && <div id="detail-dates-error" role="alert" style={fieldErrorStyle}>{fieldError?.message}</div>}
              <div style={{ display: 'flex', gap: 10 }}><div style={{ flex: 1 }}><label style={labelStyle}>カテゴリ</label><select aria-label="カテゴリ" value={editData.category_id ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, category_id: event.target.value || null }))} style={inputStyle}><option value="">なし</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div><div style={{ flex: 1 }}><label style={labelStyle}>優先度</label><select aria-label="優先度" value={editData.priority ?? 3} onChange={(event) => setEditData((previous) => ({ ...previous, priority: Number(event.target.value) }))} style={inputStyle}><option value={1}>最低</option><option value={2}>低</option><option value={3}>中</option><option value={4}>高</option><option value={5}>最高</option></select></div></div>
              {!editingListMode && (
                <div>
                  <label style={labelStyle}>繰り返し（完了にすると次回分を自動で作ります）</label>
                  <select aria-label="繰り返し" value={editData.recurrence ?? ''} onChange={(event) => setEditData((previous) => ({ ...previous, recurrence: (event.target.value || null) as Todo['recurrence'] }))} style={inputStyle}>
                    <option value="">なし</option>
                    {TODO_RECURRENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <RecurrenceHint data={editData} />
                </div>
              )}
              {!editingListMode && editData.recurrence && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--slate-300)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(editData.recurrence_copy_subtasks ?? 0) === 1}
                    onChange={(event) => setEditData((previous) => ({ ...previous, recurrence_copy_subtasks: event.target.checked ? 1 : 0 }))}
                    style={{ accentColor: 'var(--indigo-500)' }}
                  />
                  サブタスクも次回分に引き継ぐ（未完了状態で複製）
                </label>
              )}
              {!editingListMode && editData.recurrence && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--slate-300)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(editData.recurrence_skip_weekends ?? 0) === 1}
                    onChange={(event) => setEditData((previous) => ({ ...previous, recurrence_skip_weekends: event.target.checked ? 1 : 0 }))}
                    style={{ accentColor: 'var(--indigo-500)' }}
                  />
                  土日をスキップする
                </label>
              )}
              {!editingListMode && editData.recurrence && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--slate-300)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(editData.recurrence_skip_holidays ?? 0) === 1}
                    onChange={(event) => setEditData((previous) => ({ ...previous, recurrence_skip_holidays: event.target.checked ? 1 : 0 }))}
                    style={{ accentColor: 'var(--indigo-500)' }}
                  />
                  日本の祝日をスキップする
                </label>
              )}
              <div><label style={labelStyle}>状態</label><select aria-label="状態" value={editData.status ?? 'active'} onChange={(event) => setEditData((previous) => ({ ...previous, status: event.target.value as Todo['status'] }))} style={inputStyle}><option value="not_started">未着手</option><option value="active">進行中</option><option value="on_hold">保留中</option><option value="done">完了</option><option value="archived">アーカイブ</option></select></div>
              {users.length > 0 && (
                <div><label style={labelStyle}>担当者</label><AssigneePicker label="担当者" users={users} value={editData.assignee_id ?? null} onChange={(assigneeId) => setEditData((previous) => ({ ...previous, assignee_id: assigneeId, co_assignee_ids: (previous.co_assignee_ids ?? []).filter((id) => id !== assigneeId) }))} selectStyle={inputStyle} /></div>
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
                            border: `1px solid ${selected ? user.color : 'var(--slate-700)'}`,
                            background: selected ? `color-mix(in srgb, ${user.color} 14.9%, transparent)` : 'var(--slate-900)',
                            color: selected ? 'var(--slate-200)' : 'var(--text-subtle)', fontSize: 'var(--font-control)'
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
              {!editingListMode && <div><label style={labelStyle}>進捗 {editData.progress ?? 0}%</label><input type="range" aria-label="進捗率" min={0} max={100} step={5} value={editData.progress ?? 0} onChange={(event) => setEditData((previous) => ({ ...previous, progress: Number(event.target.value) }))} style={{ width: '100%', accentColor: 'var(--indigo-500)' }} /></div>}
              <button onClick={() => void handleSave()} disabled={saving} style={{ ...buttonStyle('var(--indigo-500)'), alignSelf: 'flex-end' }}>{saving ? '保存中…' : '保存'}</button>
            </fieldset>
          )}
    </>
  )

  const progressSection = (
    <>
          {!editing && !listMode && (
            <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>
                  進捗{' '}
                  {todo.status !== 'done' && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--font-caption)' }}>バーをドラッグ（←→キーでも可）。100%で完了になります</span>}
                </span>
                {!isArchived && (
                  <button
                    type="button"
                    onClick={focusProgressLogInput}
                    title="下の進捗ログの入力欄へ移ります（Ctrl+Enter で投稿）"
                    style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--indigo-700)', background: 'transparent', color: 'var(--indigo-300)', cursor: 'pointer', fontSize: 'var(--font-caption)', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    ✎ 進捗ログを書く
                  </button>
                )}
              </div>
              {todo.status === 'done' ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '4px 0' }}>
                  <span style={{ color: 'var(--green-400)', fontSize: '1rem', fontWeight: 800 }}>✓ 完了</span>
                  {(todo.progress ?? 0) < 100 && <span style={{ color: 'var(--text-subtle)', fontSize: 'var(--font-caption)' }}>完了にしたときの進捗は {todo.progress ?? 0}% でした（書き直す必要はありません）</span>}
                </div>
              ) : (
                <ProgressSlider
                  value={todo.progress ?? 0}
                  label={`${todo.title}の進捗率`}
                  disabled={isArchived}
                  onCommit={handleProgressCommit}
                />
              )}
              {subTaskProgress !== null && (
                <div style={{ marginTop: 8, fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>
                  サブタスク: {doneCount}/{subTasks.length} 完了
                  <div style={{ height: 4, background: 'var(--slate-900)', borderRadius: 99, marginTop: 4 }}>
                    <div style={{ height: '100%', width: `${subTaskProgress}%`, background: 'var(--indigo-500)', borderRadius: 99 }} />
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
              <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                  id={progressLogInputId}
                  aria-label="進捗ログを書く"
                  placeholder="例: 〇〇まで終わった。次は△△。□□で困っている（Ctrl+Enterで投稿）"
                  rows={3}
                  style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: 72 }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ marginRight: 'auto' }}>
                    <ProgressNoteHelpers
                      draft={noteDraft}
                      disabled={noteSaving}
                      onInsertTemplate={() => {
                        const next = withProgressNoteTemplate(noteDraft)
                        setNoteDraft(next)
                        if (todoId) window.localStorage.setItem(progressDraftKey, next)
                      }}
                      onInsertOnTrack={() => {
                        setNoteDraft(ON_TRACK_NOTE)
                        if (todoId) window.localStorage.setItem(progressDraftKey, ON_TRACK_NOTE)
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>{noteDraft.length}文字</div>
                  <button
                    onClick={() => void handleAddProgressNote()}
                    disabled={!noteDraft.trim() || noteSaving}
                    style={buttonStyle(!noteDraft.trim() || noteSaving ? 'var(--slate-800)' : 'var(--indigo-500)', !noteDraft.trim() || noteSaving ? 'var(--slate-500)' : 'var(--on-fill-white)')}
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
            <h3 style={sectionTitleStyle}>サブタスク {subTasks.length > 0 && `(${doneCount}/${subTasks.length})`}</h3>
            <div role="status" style={visuallyHiddenStyle}>{subTaskAnnouncement}</div>
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
                        onToggle={() => {
                          // チェックを外したときは、チェックする前の進捗に戻す（覚えていないときは、これまでどおり 99%）
                          const nextDone = !subTask.done
                          const restoreProgress = nextDone ? undefined : progressBeforeDoneRef.current.get(subTask.id)
                          if (nextDone) progressBeforeDoneRef.current.set(subTask.id, subTask.progress)
                          else progressBeforeDoneRef.current.delete(subTask.id)
                          void window.api.subtaskUpdate(subTask.id, { done: nextDone, ...(restoreProgress !== undefined ? { progress: restoreProgress } : {}), expected_values: { done: Boolean(subTask.done) } })
                            .then((updated) => setSubTasks((previous) => previous.map((item) => item.id === updated.id ? updated : item)))
                            .catch((error) => onShowToast(error instanceof Error ? error.message : 'サブタスクを更新できませんでした', 'error'))
                        }}
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
            <form onSubmit={(event) => void handleAddSubTask(event)} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, border: '1px dashed var(--slate-700)' }}>
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
                <button type="submit" disabled={!newSubTask.title.trim()} style={buttonStyle(newSubTask.title.trim() ? 'var(--blue-600)' : 'var(--slate-800)', newSubTask.title.trim() ? 'var(--on-fill-white)' : 'var(--slate-500)')}>追加</button>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
                {users.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    担当
                    <select
                      value={newSubTask.assignee_id ?? ''}
                      onChange={(event) => setNewSubTask((previous) => ({ ...previous, assignee_id: event.target.value || null }))}
                      aria-label="追加するサブタスクの担当"
                      style={{ ...inputStyle, width: 'auto', fontSize: 'var(--font-control)', padding: '3px 6px' }}
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
                  <input type="date" value={newSubTask.due_date ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, due_date: event.target.value || null }))} aria-label="追加するサブタスクの期限" style={{ ...inputStyle, width: 'auto', fontSize: 'var(--font-control)', padding: '3px 6px' }} />
                </label>
                <button type="button" onClick={() => setShowSubTaskDetails((previous) => !previous)} aria-expanded={showSubTaskDetails} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue-300)', cursor: 'pointer', fontSize: 'var(--font-caption)', fontWeight: 700 }}>
                  {showSubTaskDetails ? '▾ 閉じる' : '▸ 開始日・メモ・進捗'}
                </button>
              </div>
              {showSubTaskDetails && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={labelStyle}>開始日<input type="date" value={newSubTask.start_date ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, start_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px' }} /></label>
                  <textarea value={newSubTask.description ?? ''} onChange={(event) => setNewSubTask((previous) => ({ ...previous, description: event.target.value }))} placeholder="メモ..." aria-label="追加するサブタスクのメモ" rows={2} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
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
            <div style={{ background: 'var(--slate-800)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* 右の列（狭いとき）は2段に折り返す */}<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <select aria-label="依存の向き" value={dependencyDraft.mode} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, mode: event.target.value as 'predecessor' | 'successor', relatedTodoId: '' }))} style={{ ...inputStyle, flex: '1 1 130px', width: 'auto', minWidth: 0 }}>
                  <option value="predecessor">先行タスクを追加</option>
                  <option value="successor">後続タスクを追加</option>
                </select>
                <select aria-label="依存させるタスク" value={dependencyDraft.relatedTodoId} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, relatedTodoId: event.target.value }))} style={{ ...inputStyle, flex: '2 1 170px', width: 'auto', minWidth: 0 }}>
                  <option value="">タスクを選択</option>
                  {dependencyCandidates.filter((candidate) => candidate.status !== 'done').map((candidate) => <option key={candidate.id} value={candidate.id}>{taskOptionLabel(candidate)}</option>)}
                  {dependencyCandidates.some((candidate) => candidate.status === 'done') && (
                    <optgroup label="完了したタスク">
                      {dependencyCandidates.filter((candidate) => candidate.status === 'done').map((candidate) => <option key={candidate.id} value={candidate.id}>{taskOptionLabel(candidate)}</option>)}
                    </optgroup>
                  )}
                </select>
                <input type="number" min={0} max={60} value={dependencyDraft.lagDays} onChange={(event) => setDependencyDraft((previous) => ({ ...previous, lagDays: event.target.value }))} placeholder="待機日数" aria-label="待機日数" title="先行タスクの完了から、何日空けて始めるか" style={{ ...inputStyle, flex: '0 0 88px', width: 88 }} />
                <button onClick={() => void handleCreateDependency()} style={buttonStyle('var(--blue-600)')}>追加</button>
              </div>
              <DependencyList title="先行タスク" items={predecessorDependencies} getTodoId={(item) => item.predecessor_todo_id} getTitle={(item) => allTodos.find((candidate) => candidate.id === item.predecessor_todo_id)?.title ?? '不明なタスク'} reload={() => todoId ? loadDependencies(todoId) : Promise.resolve()} onShowToast={onShowToast} />
              <DependencyList title="後続タスク" items={successorDependencies} getTodoId={(item) => item.successor_todo_id} getTitle={(item) => allTodos.find((candidate) => candidate.id === item.successor_todo_id)?.title ?? '不明なタスク'} reload={() => todoId ? loadDependencies(todoId) : Promise.resolve()} onShowToast={onShowToast} />
            </div>
          </section>
          )}
    </>
  )

  const workLogSection = (
    <>
          <section>
            <h3 style={sectionTitleStyle}>作業ログ</h3>
            {logs.length === 0 ? (
              <div style={{ color: 'var(--slate-400)', fontSize: '0.85rem' }}>ログはまだありません</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {logs.map((log) => (
                  <div key={log.id} style={{ background: 'var(--slate-800)', borderRadius: 6, padding: '8px 12px', fontSize: '0.82rem', color: 'var(--slate-400)' }}>
                    <span style={{ color: 'var(--slate-200)' }}>{formatTime(new Date(log.start_time))} - {formatTime(new Date(log.end_time))}</span>
                    <span style={{ marginLeft: 8, color: 'var(--green-400)' }}>{Math.round(log.duration_seconds / 60)}分</span>
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
    <div onKeyDown={(event) => {
      if (editing && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void handleSave()
      }
      // 編集中の Esc は編集をやめる（変更があれば確かめる）。開いている小窓やメニューの Esc は、そちらが先に受け取る
      if (editing && event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented) {
        event.preventDefault()
        void cancelEditing()
      }
    }} style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          padding: '20px 20px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderBottom: '1px solid var(--slate-800)',
          background: 'var(--c-0b1220)'
        }}
      >
        <div style={{ width: '100%', minWidth: 0 }}>
          {returnTo && !editing && (
            <button
              type="button"
              onClick={returnTo.onReturn}
              style={{ marginBottom: 4, padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--blue-300)', cursor: 'pointer', fontSize: 'var(--font-control)', fontWeight: 700 }}
            >
              ← {returnTo.label}へ戻る
            </button>
          )}
          {editing ? (
            <>
              <input
                ref={editTitleInputRef}
                disabled={saving}
                aria-label="タスク名"
                aria-invalid={fieldError?.field === 'title' || undefined}
                aria-describedby={fieldError?.field === 'title' ? 'detail-title-error' : undefined}
                value={editData.title ?? ''}
                onChange={(event) => {
                  const title = event.target.value
                  setEditData((previous) => ({ ...previous, title }))
                  if (fieldError?.field === 'title' && title.trim()) setFieldError(null)
                }}
                style={fieldError?.field === 'title' ? { ...inputStyle, borderColor: 'var(--red-500)' } : inputStyle}
              />
              {fieldError?.field === 'title' && <div id="detail-title-error" role="alert" style={fieldErrorStyle}>{fieldError.message}</div>}
            </>
          ) : (
            <h2 ref={titleHeadingRef} tabIndex={-1} style={{ fontSize: '1.1rem', color: 'var(--slate-200)', lineHeight: 1.4, margin: 0, overflowWrap: 'anywhere' }}>{todo.title}</h2>
          )}
        </div>
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!editing && !isArchived && (
            <button
              onClick={() => void toggleDone()}
              title={isDone ? '完了を取り消して、未完了に戻します' : listMode ? 'このToDoリストを使い終えたときに押します（中の項目のチェックとは別です）' : 'このタスクを完了にします'}
              style={isDone ? buttonStyle('var(--slate-700)', 'var(--slate-300)') : listMode ? buttonStyle('var(--slate-700)', 'var(--slate-300)') : buttonStyle('var(--green-700)', 'var(--on-fill-green-50)')}
            >
              {isDone ? '完了を取り消す' : listMode ? 'リストを終える' : '✓ 完了にする'}
            </button>
          )}
          {!editing && todo.status === 'on_hold' && <Badge color="var(--purple-400)">保留中</Badge>}
          {!editing && !isDone && !isArchived && (
            <button
              onClick={() => void onUpdate(todo.id, { status: todo.status === 'on_hold' ? 'active' : 'on_hold' }).then(() => onShowToast(todo.status === 'on_hold' ? '進行中に戻しました' : 'タスクを保留しました')).catch(() => onShowToast('状態を変更できませんでした', 'error'))}
              title={todo.status === 'on_hold' ? '保留をやめて、進行中に戻します' : '待ち状態などで作業を止めるときに使います。保留中は報告タブでも分かるように表示されます'}
              style={buttonStyle('var(--purple-800)')}
            >
              {todo.status === 'on_hold' ? '進行中に戻す' : '保留する'}
            </button>
          )}
          {!editing && !isDone && !isArchived && (
            <button onClick={() => void onAddToTodayPlan(todo.id)} disabled={isInTodayPlan} title="「計画」タブの今日の予定に入れます" style={buttonStyle(isInTodayPlan ? 'var(--slate-800)' : 'var(--blue-900)', isInTodayPlan ? 'var(--slate-500)' : 'var(--blue-100)')}>
              {isInTodayPlan ? '今日の計画に追加済み' : '今日の計画に追加'}
            </button>
          )}
          {editing && <button onClick={() => void handleSave()} disabled={saving} title="変更を保存します（Ctrl+Enter）" aria-keyshortcuts="Control+Enter Meta+Enter" style={buttonStyle('var(--indigo-500)')}>{saving ? '保存中…' : '変更を保存'}</button>}
          <button ref={editButtonRef} onClick={() => void (editing ? cancelEditing() : startEditing())} disabled={saving} title={editing ? undefined : 'タスク名・説明・繰り返し・サブ担当などをまとめて編集します'} style={buttonStyle('var(--slate-700)')}>
            {editing ? '編集をやめる' : '編集'}
          </button>
          {editing && <span style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)' }}>編集中・Ctrl+Enter で保存</span>}
          {!editing && currentUser && (
            <button
              disabled={subscriptionPending}
              onClick={() => void toggleSubscription()}
              title={subscribed ? 'このタスクに進捗ログや返信が付くと通知が届きます。押すとオフにします' : 'このタスクに進捗ログや返信が付いたら通知を受け取ります'}
              aria-pressed={subscribed}
              style={buttonStyle(subscribed ? 'var(--green-900)' : 'var(--slate-700)')}
            >
              {subscribed ? '🔔 更新通知: オン' : '🔕 更新通知: オフ'}
            </button>
          )}
          {!editing && (
            <NoteMenu
              items={[
                // サーバー版だけ。チャットなどに貼ると、このタスクの詳細を開ける（個人用のデスクトップ版はファイルの URL なので出さない）
                ...(users.length > 0 ? [{ label: 'リンクをコピー', onSelect: () => void copyTaskLink() }] : []),
                { label: '複製する（サブタスクも一緒に）', onSelect: () => void duplicateTodo() },
                { label: 'テンプレートとして保存', onSelect: saveAsTemplate },
                ...(onArchive && todo.status !== 'archived' ? [{ label: 'アーカイブする（一覧から片付ける。あとで戻せます。完全に消すのはアーカイブのあと）', onSelect: () => void onArchive(todo.id) }] : []),
                ...(onDelete && todo.status === 'archived' ? [{
                  label: '完全に削除する…',
                  onSelect: () => {
                    void confirmAction(`「${todo.title}」を完全に削除しますか？
サブタスク・進捗ログ・作業ログも消え、元に戻せません。`, { confirmLabel: '完全に削除する', danger: true })
                      .then((ok) => { if (ok) void onDelete(todo.id) })
                  }
                }] : [])
              ]}
            />
          )}
        </div>
      </div>

      <div ref={detailBodyRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {saveError && <div role="alert" style={{ padding: 10, color: 'var(--red-200)', border: '1px solid var(--red-500)', borderRadius: 8 }}>{saveError}</div>}
      {sectionLoadError && <div role="alert" style={{ padding: 10, borderRadius: 8, border: '1px solid var(--red-500)', background: 'var(--red-950)', color: 'var(--red-200)', fontSize: 'var(--font-control)' }}>{sectionLoadError}<button onClick={() => { setSectionLoadError(null); void Promise.all([loadWorkLogs(todo.id), loadSubTasks(todo.id), loadDependencies(todo.id), loadProgressNotes(todo.id)]) }} style={{ marginLeft: 10, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--red-500)', background: 'var(--red-900)', color: 'var(--white)' }}>再試行</button></div>}
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
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-control)', color: failed ? 'var(--red-300)' : dirty || saving ? 'var(--blue-300)' : 'var(--slate-400)' }}>
        {saving ? '保存中…' : failed ? '保存できませんでした' : dirty ? '入力が止まると保存します' : '保存済み'}
        {failed && !saving && (
          <button type="button" onClick={onRetry} style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid var(--red-500)', background: 'var(--red-950)', color: 'var(--red-200)', cursor: 'pointer', fontSize: 'var(--font-control)' }}>再試行</button>
        )}
      </div>
      <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>{length}文字</div>
    </div>
  )
}

const HISTORY_PAGE_SIZE = 20
const HISTORY_STATUS_LABELS: Record<string, string> = { not_started: '未着手', active: '進行中', on_hold: '保留中', done: '完了', archived: 'アーカイブ' }

function historyValue(field: string, value: string | null): string {
  if (value == null || value === '') return 'なし'
  if (field === 'status') return HISTORY_STATUS_LABELS[value] ?? value
  if (field === 'priority') return PRIORITY_OPTIONS.find((option) => String(option.value) === value)?.label ?? value
  if (field === 'progress') return `${value}%`
  if (field === 'start_date' || field === 'due_date') return formatShortDate(value.slice(0, 10))
  if (field === 'recurrence') return recurrenceKindLabel(value) ?? value
  if (field === 'recurrence_copy_subtasks') return value === '1' ? 'する' : 'しない'
  if (field === 'list_mode') return value === '1' ? 'ToDoリスト' : 'タスク'
  return value
}

function historyText(entry: TodoHistoryEntry): string {
  const label = changeFieldLabel(entry.field)
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
        <div role="alert" style={{ fontSize: 'var(--font-control)', color: 'var(--red-300)' }}>
          {error}
          <button type="button" onClick={() => void load(0)} style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--red-500)', background: 'var(--red-950)', color: 'var(--red-200)', cursor: 'pointer', fontSize: 'var(--font-control)' }}>再試行</button>
        </div>
      ) : entries.length === 0 ? (
        <div style={{ color: 'var(--slate-400)', fontSize: '0.85rem' }}>{loading ? '読み込み中…' : '変更はまだありません'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map((entry) => (
            <div key={entry.id} style={{ background: 'var(--slate-800)', borderRadius: 6, padding: '6px 10px', fontSize: 'var(--font-control)', color: 'var(--slate-200)', lineHeight: 1.5 }}>
              <span style={{ color: 'var(--slate-400)', marginRight: 8, whiteSpace: 'nowrap' }}>{formatHistoryTime(entry.created_at)}{entry.user_name ? `　${entry.user_name}` : ''}</span>
              <span style={{ overflowWrap: 'anywhere' }}>{historyText(entry)}</span>
            </div>
          ))}
          {hasMore && (
            <button type="button" disabled={loading} onClick={() => void load(entries.length)} style={{ alignSelf: 'flex-start', marginTop: 2, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--slate-700)', background: 'transparent', color: 'var(--slate-300)', cursor: loading ? 'default' : 'pointer', fontSize: 'var(--font-control)' }}>
              {loading ? '読み込み中…' : 'もっと見る'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function DependencyList({ title, items, getTodoId, getTitle, reload, onShowToast }: { title: string; items: TodoDependency[]; getTodoId: (item: TodoDependency) => string; getTitle: (item: TodoDependency) => string; reload: () => Promise<void>; onShowToast: Props['onShowToast'] }): React.JSX.Element {
  // 待機日数を変える・依存関係を外すと、後続のタスクの日程が自動で動く。何件動いたかを知らせ、元に戻せるようにする
  // （期限の変更と同じ。黙って動くと、ほかの人のタスクの日程が変わったことに気付けない）
  const scheduleKey = (todo: Todo): string => `${todo.start_date?.slice(0, 10) ?? ''}/${todo.due_date?.slice(0, 10) ?? ''}`
  const movedTodosAfter = async (change: () => Promise<unknown>): Promise<Todo[]> => {
    const before = new Map((await window.api.todoGetAll()).map((todo) => [todo.id, scheduleKey(todo)]))
    await change()
    await reload()
    return (await window.api.todoGetAll()).filter((todo) => before.has(todo.id) && before.get(todo.id) !== scheduleKey(todo))
  }
  const movedText = (moved: Todo[]): string => moved.length === 0 ? '' : `。後続の${moved.length}件（「${moved[0].title}」${moved.length > 1 ? 'ほか' : ''}）の日程も動きました`
  const changeLag = async (item: TodoDependency, nextLag: number): Promise<void> => {
    if (nextLag === item.lag_days) return
    try {
      const moved = await movedTodosAfter(() => window.api.todoDependencyUpdate(item.id, nextLag))
      onShowToast(`「${getTitle(item)}」との待機を${nextLag}日にしました${movedText(moved)}`, 'success', {
        label: '元に戻す',
        run: () => {
          void window.api.todoDependencyUpdate(item.id, item.lag_days).then(() => reload()).then(
            () => onShowToast('待機日数を元に戻しました'),
            (error: unknown) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
          )
        }
      })
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '待機日数を変えられませんでした', 'error')
    }
  }
  const removeDependency = async (item: TodoDependency): Promise<void> => {
    try {
      const moved = await movedTodosAfter(() => window.api.todoDependencyDelete(item.id))
      onShowToast(`「${getTitle(item)}」との依存関係を外しました${movedText(moved)}`, 'success', {
        label: '元に戻す',
        run: () => {
          void window.api.todoDependencyCreate(item.predecessor_todo_id, item.successor_todo_id, item.lag_days).then(() => reload()).then(
            () => onShowToast('依存関係を元に戻しました'),
            (error: unknown) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
          )
        }
      })
    } catch (error) {
      onShowToast(error instanceof Error ? error.message : '依存関係を外せませんでした', 'error')
    }
  }
  return (
    <div>
      <div style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)', marginBottom: 6 }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 'var(--font-control)', color: 'var(--text-subtle)' }}>設定されていません</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--slate-900)', flexWrap: 'wrap' }}>
              <button onClick={() => void window.api.windowOpenTodo(getTodoId(item))} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--slate-200)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700 }}>{getTitle(item)}</button>
              <span style={{ fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>待機 {item.lag_days}日</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {/* 期限の「+1日」と見分けられるよう「待機」と書く */}
                <button onClick={() => void changeLag(item, clampLag(item.lag_days - 1))} aria-label={`「${getTitle(item)}」との待機を1日減らす`} title="待機日数を1日減らします（後続の日程も動きます）" style={buttonStyle('var(--slate-700)')}>待機 -1日</button>
                <button onClick={() => void changeLag(item, clampLag(item.lag_days + 1))} aria-label={`「${getTitle(item)}」との待機を1日増やす`} title="待機日数を1日増やします（後続の日程も動きます）" style={buttonStyle('var(--slate-700)')}>待機 +1日</button>
                <button onClick={() => void removeDependency(item)} aria-label={`「${getTitle(item)}」との依存関係を外す`} style={buttonStyle('var(--red-900)')}>外す</button>
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
        background: hovered && !disabled ? 'var(--slate-800)' : 'transparent',
        color: disabled ? 'var(--slate-700)' : hovered ? 'var(--slate-300)' : 'var(--text-subtle)',
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
    background: 'var(--sky-400)',
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--sky-400) 25%, transparent)',
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
      style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px' }}
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
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--slate-800)' }}>
      <button onClick={() => onChange({ done: !subTask.done, progress: subTask.done ? Math.min(progress, 99) : 100 })} style={{ width: 16, height: 16, borderRadius: 3, marginTop: 8, border: `2px solid ${subTask.done ? 'var(--green-400)' : 'var(--slate-600)'}`, background: subTask.done ? 'var(--green-400)' : 'transparent', cursor: 'pointer' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={subTask.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="サブタスク名" style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }} />
        <textarea value={subTask.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="メモ..." rows={2} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
        {users.length > 0 && <SubTaskAssigneeSelect users={users} value={subTask.assignee_id} onChange={(assigneeId) => onChange({ assignee_id: assigneeId })} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input type="date" aria-label="開始日" title="開始日" value={subTask.start_date ?? ''} onChange={(event) => onChange({ start_date: event.target.value || null })} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px' }} />
          <input type="date" aria-label="期限" title="期限" value={subTask.due_date ?? ''} onChange={(event) => onChange({ due_date: event.target.value || null })} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px' }} />
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
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
      <button onClick={onDelete} aria-label={`${subTask.title || 'サブタスク'}を削除`} style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer' }}>削除</button>
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
      <fieldset disabled={saving} style={{ margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 8, background: 'var(--slate-800)', border: '1px solid var(--indigo-500)' }}>
        {saveError && <div role="alert" style={{ color: 'var(--red-200)', fontSize: 'var(--font-control)' }}>{saveError}</div>}
        <input
          value={draft.title}
          onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void handleSave() } }}
          placeholder="サブタスク名"
          autoFocus
          style={{ ...inputStyle, fontSize: '0.82rem', padding: '6px 8px' }}
        />
        <textarea value={draft.description} onChange={(event) => setDraft((previous) => ({ ...previous, description: event.target.value }))} placeholder="メモ..." rows={2} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px', resize: 'vertical', minHeight: 56 }} />
        {users.length > 0 && <SubTaskAssigneeSelect users={users} value={draft.assignee_id} onChange={(assigneeId) => setDraft((previous) => ({ ...previous, assignee_id: assigneeId }))} />}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>開始日<input type="date" value={draft.start_date ?? ''} onChange={(event) => setDraft((previous) => ({ ...previous, start_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px' }} /></label>
          <label style={{ ...labelStyle, marginBottom: 0 }}>期限<input type="date" value={draft.due_date ?? ''} onChange={(event) => setDraft((previous) => ({ ...previous, due_date: event.target.value || null }))} style={{ ...inputStyle, fontSize: 'var(--font-control)', padding: '6px 8px' }} /></label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
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
          <button onClick={() => setEditing(false)} style={buttonStyle('var(--slate-700)')}>キャンセル</button>
          <button onClick={() => void handleSave()} disabled={saving} style={buttonStyle('var(--indigo-500)')}>{saving ? '保存中...' : '保存'}</button>
        </div>
      </fieldset>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--slate-800)' }}>
      <button
        onClick={onToggle}
        title={subTask.done ? '未完了に戻す' : '完了にする'}
        aria-label={subTask.done ? `${subTask.title}を未完了に戻す` : `${subTask.title}を完了にする`}
        style={{ width: 16, height: 16, borderRadius: 3, marginTop: 2, flexShrink: 0, border: `2px solid ${subTask.done ? 'var(--green-400)' : 'var(--slate-600)'}`, background: subTask.done ? 'var(--green-400)' : 'transparent', cursor: 'pointer', padding: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', color: subTask.done ? 'var(--slate-600)' : 'var(--slate-300)', textDecoration: subTask.done ? 'line-through' : 'none', wordBreak: 'break-word' }}>{subTask.title}</div>
        {(assigneeName || subTask.start_date || subTask.due_date) && (
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }}>
            {assigneeName && <AssigneeChip name={assigneeName} color={subTask.assignee_color ?? null} fontSize={0.66} />}
            {(subTask.start_date || subTask.due_date) && (
              <span style={{ color: subTask.done ? 'var(--slate-400)' : getDueDateColor(subTask.due_date) || 'var(--slate-400)' }}>
                {subTask.start_date ? formatShortDate(subTask.start_date) : ''}{subTask.start_date && subTask.due_date ? ' → ' : ''}{subTask.due_date ? `期限 ${formatShortDate(subTask.due_date)}` : ''}
              </span>
            )}
          </div>
        )}
        {subTask.description && <div style={{ marginTop: 2, fontSize: 'var(--font-control)', color: subTask.done ? 'var(--slate-700)' : 'var(--text-subtle)', whiteSpace: 'pre-wrap' }}><LinkedText text={subTask.description} /></div>}
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
      <button onClick={startEditing} title="編集" aria-label={`${subTask.title}を編集`} style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer' }}>✎</button>
      <button onClick={onDelete} title="サブタスクを削除" aria-label={`${subTask.title}を削除`} style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer' }}>削除</button>
    </div>
  )
}

const STATUS_OPTIONS: Array<{ value: Todo['status']; label: string; color: string }> = [
  { value: 'not_started', label: '未着手', color: 'var(--slate-400)' },
  { value: 'active', label: '進行中', color: 'var(--blue-400)' },
  { value: 'on_hold', label: '保留中', color: 'var(--purple-400)' },
  { value: 'done', label: '完了', color: 'var(--green-400)' }
]

const PRIORITY_OPTIONS = [
  { value: 1, label: '最低' },
  { value: 2, label: '低' },
  { value: 3, label: '中' },
  { value: 4, label: '高' },
  { value: 5, label: '最高' }
]

function dueRemainingLabel(dueDate: string): string {
  const diff = diffDaysFromToday(dueDate)
  if (diff < 0) return `${Math.abs(diff)}日超過`
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
  onShowToast: (message: string, type?: 'success' | 'error', action?: { label?: string; run?: () => void; key?: string }) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [startDraft, setStartDraft] = useState('')
  const [dueDraft, setDueDraft] = useState('')
  const [recurrenceDraft, setRecurrenceDraft] = useState<Todo['recurrence']>(null)
  const isArchived = todo.status === 'archived'
  const listMode = isListTodo(todo)
  const scheduleErrorId = useId()
  // キーボードで使う人のために、日程の欄を開いたら開始日へ、閉じたら「変更」へフォーカスを移す
  const startInputRef = useRef<HTMLInputElement>(null)
  const scheduleButtonRef = useRef<HTMLButtonElement>(null)
  const wasEditingScheduleRef = useRef(false)
  useEffect(() => {
    if (editingSchedule) startInputRef.current?.focus()
    else if (wasEditingScheduleRef.current) scheduleButtonRef.current?.focus()
    wasEditingScheduleRef.current = editingSchedule
  }, [editingSchedule])
  const statusTone = STATUS_OPTIONS.find((option) => option.value === todo.status)?.color ?? 'var(--slate-400)'
  const dueColor = todo.status === 'done' ? '' : getDueDateColor(todo.due_date)
  const recurrenceLabel = listMode ? null : todoRecurrenceLabel(todo)

  const save = async (data: UpdateTodoInput, message: string, undo?: UpdateTodoInput): Promise<boolean> => {
    setSaving(true)
    try {
      await onUpdate(todo.id, data)
      // 日程などは、知らせから元に戻せるようにする（依存関係の後続も元の日程で計算し直される）。
      // 戻したら、後続が動いた知らせを「元に戻しました」で置き換える（古い知らせが残って、戻ったか分からなくならないように）
      onShowToast(message, 'success', undo ? {
        label: '元に戻す',
        run: () => {
          void onUpdate(todo.id, undo).then(
            () => onShowToast('元に戻しました', 'success', { key: 'schedule-change' }),
            (error: unknown) => onShowToast(error instanceof Error ? error.message : '元に戻せませんでした', 'error')
          )
        }
      } : undefined)
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
    setRecurrenceDraft(todo.recurrence ?? null)
    setEditingSchedule(true)
  }

  // 開始日が期限より後なら、その場で知らせて保存させない
  const scheduleInvalid = Boolean(startDraft && dueDraft && startDraft > dueDraft)

  const saveSchedule = async (): Promise<void> => {
    if (scheduleInvalid) return
    const data: UpdateTodoInput = {}
    const undo: UpdateTodoInput = {}
    if (!listMode && (recurrenceDraft ?? null) !== (todo.recurrence ?? null)) {
      data.recurrence = recurrenceDraft
      undo.recurrence = todo.recurrence ?? null
    }
    if ((startDraft || null) !== (todo.start_date?.slice(0, 10) ?? null)) {
      data.start_date = startDraft || null
      undo.start_date = todo.start_date?.slice(0, 10) ?? null
    }
    if ((dueDraft || null) !== (todo.due_date?.slice(0, 10) ?? null)) {
      data.due_date = dueDraft || null
      undo.due_date = todo.due_date?.slice(0, 10) ?? null
    }
    if (Object.keys(data).length === 0) {
      setEditingSchedule(false)
      return
    }
    const message = data.due_date !== undefined && data.due_date
      ? `期限を${formatShortDate(data.due_date)}にしました`
      : data.recurrence !== undefined && Object.keys(data).length === 1
        ? `繰り返しを「${recurrenceKindLabel(data.recurrence) ?? 'なし'}」にしました`
        : '日程を変更しました'
    if (await save(data, message, undo)) setEditingSchedule(false)
  }

  // 期限を延ばす近道（今の期限、なければ今日から）。押すと期限の欄に入る。保存は「保存」で
  const shiftDueDraft = (days: number): void => {
    const base = dueDraft || toDateKey(new Date())
    const date = new Date(`${base}T00:00:00`)
    date.setDate(date.getDate() + days)
    setDueDraft(toDateKey(date))
  }
  const nextFridayDraft = (): void => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    // 来週の金曜（今日が何曜日でも、次の週の金曜）
    date.setDate(date.getDate() + ((5 - date.getDay() + 7) % 7) + 7)
    setDueDraft(toDateKey(date))
  }

  const fieldLabelStyle: React.CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', marginBottom: 3 }
  const compactSelectStyle: React.CSSProperties = { ...inputStyle, padding: '5px 8px', fontSize: 'var(--font-control)' }
  const dueShortcutStyle: React.CSSProperties = { padding: '4px 10px', borderRadius: 999, border: '1px solid var(--slate-600)', background: 'transparent', color: 'var(--slate-300)', cursor: 'pointer', fontSize: 'var(--font-caption)', fontWeight: 600, minHeight: 26 }

  return (
    <div style={{ background: 'var(--c-162033)', border: '1px solid var(--slate-800)', borderRadius: 10, padding: '10px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))', gap: '10px 12px' }}>
      <div>
        <div style={fieldLabelStyle}>状態</div>
        {isArchived ? (
          <div style={{ fontSize: 'var(--font-control)', color: 'var(--slate-400)', padding: '5px 0' }}>アーカイブ</div>
        ) : (
          <select
            value={todo.status}
            disabled={saving}
            aria-label="状態"
            onChange={(event) => {
              const status = event.target.value as Todo['status']
              const label = STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status
              // 状態・優先度・カテゴリ・担当も、知らせから元に戻せる（押し間違えたときに元の値を覚えていなくてよい）
              void save({ status }, `状態を「${label}」にしました`, { status: todo.status })
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
            void save({ priority }, `優先度を「${PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? priority}」にしました`, { priority: todo.priority })
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
            void save({ category_id: categoryId }, `カテゴリを「${categories.find((category) => category.id === categoryId)?.name ?? 'なし'}」にしました`, { category_id: todo.category_id ?? null })
          }}
          style={{ ...compactSelectStyle, color: dataInk(todo.category_color ?? 'var(--slate-200)') }}
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
              }, `担当を「${users.find((user) => user.id === assigneeId)?.display_name ?? '未割り当て'}」にしました`, {
                assignee_id: todo.assignee_id ?? null,
                co_assignee_ids: (todo.co_assignees ?? []).map((item) => item.user_id)
              })
            }}
            selectStyle={compactSelectStyle}
          />
          {(todo.co_assignees ?? []).length > 0 && (
            <div style={{ marginTop: 3, fontSize: 'var(--font-caption)', color: 'var(--slate-400)' }} title="サブ担当は「編集」で変えられます">
              副: {(todo.co_assignees ?? []).map((item) => item.display_name).join('、')}
            </div>
          )}
        </div>
      )}
      <div style={{ gridColumn: '1 / -1' }}>
        <div style={fieldLabelStyle}>日程</div>
        {editingSchedule ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--font-control)', color: 'var(--slate-400)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              開始
              <input ref={startInputRef} type="date" value={startDraft} onChange={(event) => setStartDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditingSchedule(false) }} aria-label="開始日" style={{ ...compactSelectStyle, width: 'auto' }} />
            </label>
            <span>→</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              期限
              <input
                type="date"
                value={dueDraft}
                onChange={(event) => setDueDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveSchedule()
                  if (event.key === 'Escape') setEditingSchedule(false)
                }}
                aria-invalid={scheduleInvalid}
                aria-describedby={scheduleInvalid ? scheduleErrorId : undefined}
                aria-label="期限"
                style={{ ...compactSelectStyle, width: 'auto' }}
              />
            </label>
            {listMode && dueDraft && (
              <button onClick={() => setDueDraft('')} title="期限を外して、期限なしのリストにします" style={{ ...buttonStyle('var(--slate-700)'), padding: '3px 10px', fontSize: 'var(--font-caption)' }}>期限なし</button>
            )}
            <span role="group" aria-label="期限を延ばす" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', width: '100%' }}>
              <span aria-hidden="true" style={{ fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>期限を</span>
              {[{ label: '+1日', days: 1 }, { label: '+3日', days: 3 }, { label: '+1週', days: 7 }].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => shiftDueDraft(option.days)}
                  title={`期限を${option.days}日後ろにします（${dueDraft ? '今の期限' : '今日'}から）`}
                  style={dueShortcutStyle}
                >
                  {option.label}
                </button>
              ))}
              <button type="button" onClick={nextFridayDraft} title="期限を来週の金曜にします" style={dueShortcutStyle}>来週金曜</button>
            </span>
            {!listMode && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                繰り返し
                <select value={recurrenceDraft ?? ''} onChange={(event) => setRecurrenceDraft((event.target.value || null) as Todo['recurrence'])} aria-label="繰り返し" title="完了にすると次回分を自動で作ります" style={{ ...compactSelectStyle, width: 'auto' }}>
                  <option value="">なし</option>
                  {TODO_RECURRENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            )}
            {scheduleInvalid && (
              <span id={scheduleErrorId} role="alert" style={{ width: '100%', fontSize: 'var(--font-caption)', color: 'var(--red-300)', fontWeight: 700 }}>
                開始日が期限より後になっています。期限か開始日を直してください
              </span>
            )}
            <button onClick={() => setEditingSchedule(false)} style={buttonStyle('var(--slate-700)')}>取消</button>
            <button onClick={() => void saveSchedule()} disabled={saving || scheduleInvalid} style={buttonStyle(scheduleInvalid ? 'var(--slate-800)' : 'var(--blue-600)', scheduleInvalid ? 'var(--text-subtle)' : undefined)}>{saving ? '保存中…' : '保存'}</button>
            <span style={{ width: '100%', fontSize: 'var(--font-caption)', color: 'var(--text-subtle)' }}>依存関係のある後続タスクも自動で再計算されます</span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.82rem' }}>
            <span style={{ color: 'var(--slate-300)' }}>開始 {todo.start_date ? formatShortDate(todo.start_date) : '未設定'}</span>
            {listMode && !todo.due_date ? (
              <span style={{ color: 'var(--indigo-300)' }} title="期限を決めるときは「変更」から入れます。使い終えたら「リストを終える」を押します">→ 期限なし</span>
            ) : (
              <>
                <span style={{ color: 'var(--text-subtle)' }}>→</span>
                <span style={{ color: dueColor || 'var(--slate-300)', fontWeight: dueColor ? 700 : 400 }}>期限 {todo.due_date ? formatShortDate(todo.due_date) : '未設定'}</span>
                {todo.due_date && todo.status !== 'done' && <span style={{ fontSize: 'var(--font-caption)', color: dueColor || 'var(--text-subtle)' }}>（{dueRemainingLabel(todo.due_date)}）</span>}
              </>
            )}
            {!isArchived && (
              <button ref={scheduleButtonRef} onClick={openScheduleEditor} aria-label="日程を変更" style={{ ...buttonStyle('var(--slate-700)'), padding: '3px 10px', fontSize: 'var(--font-caption)' }}>変更</button>
            )}
            {recurrenceLabel && (
              <span title="完了にすると次回分を自動で作ります。変えるときは「編集」から" style={{ fontSize: 'var(--font-caption)', color: 'var(--indigo-300)', border: '1px solid var(--indigo-700)', borderRadius: 99, padding: '1px 8px', whiteSpace: 'nowrap' }}>
                🔁 {recurrenceLabel}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 編集欄の繰り返しの下に、次回分の日付を出す（毎年は基準の月日も） */
function RecurrenceHint({ data }: { data: UpdateTodoInput }): React.JSX.Element | null {
  const recurrence = data.recurrence ?? null
  if (!recurrence) return null
  const source = {
    recurrence,
    start_date: data.start_date ?? null,
    due_date: data.due_date ?? null,
    recurrence_skip_weekends: data.recurrence_skip_weekends ?? 0,
    recurrence_skip_holidays: data.recurrence_skip_holidays ?? 0
  }
  const next = nextRecurrenceDue(source)
  const label = todoRecurrenceLabel(source)
  const text = next
    ? `${label}。完了にすると、次回分を${next.kind} ${formatShortDate(next.dateKey)}${next.holidayMayShift ? '（祝日ならその後ろ）' : ''}で作ります`
    : `${label}。日付がないので、次回分も日付なしで作ります`
  return <div style={{ marginTop: 4, fontSize: 'var(--font-caption)', color: 'var(--slate-400)', lineHeight: 1.5 }}>{text}</div>
}

function Badge({ children, color }: { children: React.ReactNode; color: string }): React.JSX.Element {
  return <div style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 999, background: 'var(--slate-900)', color, fontSize: 'var(--font-caption)', fontWeight: 600 }}>{children}</div>
}

function buttonStyle(background: string, color = textOnFill(background)): React.CSSProperties {
  return { padding: '6px 12px', background, border: 'none', borderRadius: 6, color, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold', whiteSpace: 'nowrap' }
}

function progressColor(progress: number): string {
  if (progress >= 100) return 'var(--green-400)'
  if (progress >= 70) return 'var(--indigo-500)'
  if (progress >= 30) return 'var(--indigo-400)'
  return 'var(--slate-600)'
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

// 記録済みの時間＋計測中の時間（分）。計測中は毎秒描き直すが、詳細の全体は描き直さない
function TotalMinutes({ loggedSeconds, startTime }: { loggedSeconds: number; startTime: string | null }): React.JSX.Element {
  const runningSeconds = useElapsedSeconds(startTime)
  return <>{Math.round((loggedSeconds + runningSeconds) / 60)}</>
}
