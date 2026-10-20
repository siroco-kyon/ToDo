import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import type { Category, CreateTodoInput, PublicUser, Todo, TodoRecurrence } from '../types'
import { AssigneePicker } from './AssigneePicker'
import { formatShortDate, toDateKey } from '../lib/dueDate'
import { TODO_RECURRENCE_OPTIONS, todoRecurrenceLabel } from '../lib/recurrence'

interface Props {
  categories: Category[]
  users?: PublicUser[]
  /** 開いた時点のカテゴリ（左で選んでいるカテゴリなど）。null はカテゴリなし */
  defaultCategoryId?: string | null
  /** 開いた時点の担当（サーバー版は自分）。null は未割り当て */
  defaultAssigneeId?: string | null
  /** ToDo タブの「ToDoリストを作る」から開いたときは、最初から ToDoリストを選んでおく */
  defaultListMode?: boolean
  onAdd: (data: CreateTodoInput) => Promise<Todo>
  /** 追加がすべて終わったときに、作ったタスクを渡す */
  onAdded?: (created: Todo[]) => void
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: 'var(--slate-900)',
  border: '1px solid var(--slate-700)',
  borderRadius: 8,
  color: 'var(--slate-200)',
  fontSize: '0.9rem',
  boxSizing: 'border-box'
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: '0.75rem',
  color: 'var(--slate-400)'
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base)
  next.setDate(next.getDate() + days)
  return next
}

function shortDate(dateKey: string): string {
  const [, m, d] = dateKey.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 期限のよく使う選択肢。日付も一緒に見せて、曜日の数え方で迷わないようにする */
function buildDuePresets(): Array<{ label: string; value: string }> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const daysUntilFriday = (5 - today.getDay() + 7) % 7
  const friday = toDateKey(addDays(today, daysUntilFriday))
  const presets = [
    { label: '今日', value: toDateKey(today) },
    { label: '明日', value: toDateKey(addDays(today, 1)) }
  ]
  // 金曜が今日・明日と重なるときは出さない
  if (daysUntilFriday > 1) presets.push({ label: `金曜 ${shortDate(friday)}`, value: friday })
  const weekLater = toDateKey(addDays(today, 7))
  presets.push({ label: `1週間後 ${shortDate(weekLater)}`, value: weekLater })
  return presets
}

export function QuickAddModal({
  categories,
  users = [],
  defaultCategoryId = null,
  defaultAssigneeId = null,
  defaultListMode = false,
  onAdd,
  onAdded,
  onClose,
  onShowToast
}: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)
  const templates = useMemo(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('todo-templates') ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed as Array<{ name: string; todo: CreateTodoInput; subTasks?: Array<{ title: string; description?: string; start_date?: string | null; due_date?: string | null; recurrence?: 'daily' | 'weekly' | 'monthly' | null; recurrence_workdays?: number; recurrence_day?: number | null }> }> : []
    } catch { return [] }
  }, [])
  const [selectedTemplateName, setSelectedTemplateName] = useState('')
  const [templateSubTasks, setTemplateSubTasks] = useState<Array<{ title: string; description?: string; start_date?: string | null; due_date?: string | null; recurrence?: 'daily' | 'weekly' | 'monthly' | null; recurrence_workdays?: number; recurrence_day?: number | null }>>([])
  const savedDraft = useMemo(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('quick-add-draft') ?? '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as { title?: string; description?: string; memo?: string } : {}
    } catch { return {} }
  }, [])
  const [title, setTitle] = useState(savedDraft.title ?? '')
  // 前回の書きかけを戻したか（戻したときは、そう知らせる。古い下書きをうっかり追加しないように）
  const [restoredDraft, setRestoredDraft] = useState(() => Boolean(savedDraft.title?.trim() || savedDraft.description?.trim() || savedDraft.memo?.trim()))
  const [description, setDescription] = useState(savedDraft.description ?? '')
  const [memo, setMemo] = useState(savedDraft.memo ?? '')
  const [categoryId, setCategoryId] = useState(() => (
    defaultCategoryId && categories.some((category) => category.id === defaultCategoryId) ? defaultCategoryId : ''
  ))
  const [assigneeId, setAssigneeId] = useState<string | null>(() => (
    defaultAssigneeId && users.some((user) => user.id === defaultAssigneeId) ? defaultAssigneeId : null
  ))
  const [status, setStatus] = useState<NonNullable<CreateTodoInput['status']>>('not_started')
  const [priority, setPriority] = useState(3)
  // 繰り返し（完了にすると次回分を作る）。ToDoリストには付けない
  const [recurrence, setRecurrence] = useState<TodoRecurrence | null>(null)
  // 開始日を入れておくと、ガントに今日から1日のバーとして出る（日付なしだと下の「未配置」に回る）
  const [startDate, setStartDate] = useState(() => toDateKey(new Date()))
  const [dueDate, setDueDate] = useState('')
  // ToDoリスト（中の項目を毎日・毎週などでチェックし直すタスク）として作る。期限は「なし」のままでも決めてもよい
  const [listMode, setListMode] = useState(defaultListMode)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const submittingRef = useRef(false)
  // 「追加後も続けて入力する」は、続けて何件も入れる人のために端末に覚える
  const [keepOpen, setKeepOpen] = useState(() => {
    try { return window.localStorage.getItem('quick-add-keep-open') === '1' } catch { return false }
  })
  const [showDetails, setShowDetails] = useState(() => Boolean(savedDraft.description?.trim() || savedDraft.memo?.trim()))
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const duePresets = useMemo(buildDuePresets, [])

  const isDateRangeInvalid = useMemo(() => (
    Boolean(startDate && dueDate && startDate > dueDate)
  ), [dueDate, startDate])

  const titles = title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  const canSubmit = titles.length > 0 && !isDateRangeInvalid && !submitting
  const [titleRequiredShown, setTitleRequiredShown] = useState(false)
  const titleMissing = titleRequiredShown && titles.length === 0

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    window.localStorage.setItem('quick-add-draft', JSON.stringify({ title, description, memo }))
  }, [description, memo, title])

  // 追加の応答が遅いとき（不安定な LAN）は、待たずに閉じられるようにする。閉じても書いた内容は下書きに残る
  const [slowSubmit, setSlowSubmit] = useState(false)
  useEffect(() => {
    if (!submitting) { setSlowSubmit(false); return }
    const timer = window.setTimeout(() => setSlowSubmit(true), 8000)
    return () => window.clearTimeout(timer)
  }, [submitting])

  const requestClose = async (): Promise<void> => {
    if (submittingRef.current) {
      if (slowSubmit && await confirmAction('追加の応答を待たずに閉じますか？\n追加されたかどうかは、一覧で確かめてください。書いた内容は下書きに残ります。', { confirmLabel: '待たずに閉じる', cancelLabel: '待つ' })) onClose()
      return
    }
    if ((title.trim() || description.trim() || memo.trim()) && !(await confirmAction('入力中の内容があります。閉じますか？\n下書きは次回まで保存されます。', { confirmLabel: '閉じる', cancelLabel: '入力を続ける' }))) return
    onClose()
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      void requestClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [description, memo, onClose, title, slowSubmit])

  const applyTemplate = (name: string): void => {
    const template = templates.find((item) => item.name === name)
    setSelectedTemplateName(name)
    if (!template) { setTemplateSubTasks([]); return }
    setTitle(template.todo.title ?? '')
    setDescription(template.todo.description ?? '')
    setMemo(template.todo.memo ?? '')
    setCategoryId(template.todo.category_id ?? '')
    setAssigneeId(template.todo.assignee_id ?? null)
    setStatus(template.todo.status ?? 'not_started')
    setPriority(template.todo.priority ?? 3)
    setStartDate(template.todo.start_date ?? '')
    setDueDate(template.todo.due_date ?? '')
    setListMode(Boolean(template.todo.list_mode))
    setTemplateSubTasks(template.subTasks ?? [])
    if (template.todo.description || template.todo.memo || (template.todo.priority ?? 3) !== 3) setShowDetails(true)
  }

  const submit = async (): Promise<void> => {
    // 名前が空のまま追加しようとしたら、黙って何もしないのではなく、欄の下に理由を出してフォーカスを戻す
    if (titles.length === 0 && !submittingRef.current) {
      setTitleRequiredShown(true)
      inputRef.current?.focus()
      return
    }
    if (!canSubmit || submittingRef.current) return

    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    const remainingTitles = [...titles]
    const created: Todo[] = []
    try {
      for (const nextTitle of titles) {
        const todo = await onAdd({
          title: nextTitle,
          description: description.trim(),
          memo: memo.trim(),
          category_id: categoryId || null,
          assignee_id: assigneeId,
          // ToDoリストは作ったときから使い始めるので、未着手のままにしない
          status: listMode && status === 'not_started' ? 'active' : status,
          priority,
          start_date: startDate || null,
          due_date: dueDate || null,
          recurrence: listMode ? null : recurrence,
          list_mode: listMode ? 1 : 0
        })
        created.push(todo)
        remainingTitles.shift()
        setTitle(remainingTitles.join('\n'))
        for (const subTask of templateSubTasks) await window.api.subtaskCreate(todo.id, subTask)
      }
      setTitle('')
      setDescription('')
      setMemo('')
      window.localStorage.removeItem('quick-add-draft')
      onAdded?.(created)
      if (keepOpen) inputRef.current?.focus()
      else onClose()
    } catch (error) {
      const detail = error instanceof Error ? error.message : '追加できませんでした'
      const message = created.length > 0
        ? remainingTitles.length > 0
          ? `${created.length}件は追加済みです。未追加の名前だけ残しています。${detail}`
          : `タスクは追加済みですが、テンプレートの項目をすべて追加できませんでした。詳細画面で項目を確認してください。${detail}`
        : detail
      if (mountedRef.current) setSubmitError(message)
      else onShowToast(`タスクの追加を完了できませんでした: ${message}`, 'error')
      // 送信中は欄を無効にしていてフォーカスが外れるので、無効を解いたあとで名前の欄へ戻す（そのまま Enter で再試行できる）
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    void submit()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 12,
        boxSizing: 'border-box'
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) void requestClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-title"
        style={{
          background: 'var(--slate-800)',
          borderRadius: 12,
          padding: 20,
          width: '36rem',
          maxWidth: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          border: '1px solid var(--slate-700)'
        }}
      >
        <h2 id="quick-add-title" style={{ margin: '0 0 14px', fontSize: '1.08rem', color: 'var(--slate-200)' }}>
          タスクを追加
        </h2>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <fieldset disabled={submitting} style={{ border: 0, minWidth: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {templates.length > 0 && (
            <div>
              <label htmlFor="quick-add-template" style={labelStyle}>テンプレート</label>
              <select id="quick-add-template" value={selectedTemplateName} onChange={(event) => applyTemplate(event.target.value)} style={selectStyle}>
                <option value="">使わない</option>
                {templates.map((template) => <option key={template.name} value={template.name}>{template.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="quick-add-input" style={labelStyle}>タスク名 <span style={{ color: 'var(--text-subtle)', fontWeight: 400 }}>（必須。ほかの欄は空でも追加できます）</span></label>
            <textarea
              id="quick-add-input"
              ref={inputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                // Enter で追加、Shift+Enter で改行。日本語変換の確定の Enter では追加しない
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="例: 見積書を作る"
              aria-required="true"
              aria-invalid={titleMissing || undefined}
              aria-describedby={[titleMissing ? 'quick-add-title-error' : '', submitError ? 'quick-add-submit-error' : ''].filter(Boolean).join(' ') || undefined}
              rows={titles.length > 1 ? Math.min(6, titles.length + 1) : 2}
              style={{ ...selectStyle, fontSize: '1rem', resize: 'vertical', lineHeight: 1.5 }}
            />
            {titleMissing && <div id="quick-add-title-error" role="alert" style={{ marginTop: 4, fontSize: 'var(--font-control)', color: 'var(--red-300)', fontWeight: 600 }}>タスク名を入力してください</div>}
            {submitError && <div id="quick-add-submit-error" role="alert" style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--red-500)', background: 'var(--red-950)', color: 'var(--red-200)', fontSize: 'var(--font-control)', lineHeight: 1.6 }}>
              <strong>追加を完了できませんでした。</strong> {submitError}
              {title.trim() && <div>入力は残っています。接続・保存状況を確認してから「追加」で再試行できます。</div>}
            </div>}
            {restoredDraft && (
              <div role="status" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.72rem', color: 'var(--amber-300)' }}>
                前回の書きかけを戻しました
                <button
                  type="button"
                  onClick={() => {
                    setTitle('')
                    setDescription('')
                    setMemo('')
                    setRestoredDraft(false)
                    try { window.localStorage.removeItem('quick-add-draft') } catch { /* 消せなくても入力欄は空にする */ }
                    inputRef.current?.focus()
                  }}
                  style={{ ...presetButtonStyle(false), padding: '2px 8px', fontSize: '0.72rem' }}
                >
                  消して新しく書く
                </button>
              </div>
            )}
            <div style={{ marginTop: 4, fontSize: '0.7rem', color: 'var(--text-subtle)' }}>
              Enter で追加・Shift+Enter で改行。複数行にすると1行ずつ別のタスクになります
              {titles.length > 1 && <span style={{ color: 'var(--blue-300)', fontWeight: 700 }}>（{titles.length}件）</span>}
            </div>
          </div>

          <div>
            <span style={labelStyle}>種類</span>
            <div role="radiogroup" aria-label="種類" onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? false : event.key === 'End' ? true : !listMode
              setListMode(next)
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next ? 1 : 0]?.focus()
            }} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" role="radio" tabIndex={listMode ? -1 : 0} aria-checked={!listMode} onClick={() => setListMode(false)} style={presetButtonStyle(!listMode)} title="開始日と期限を決めて進め、終わったら完了にします">
                タスク
              </button>
              <button type="button" role="radio" tabIndex={listMode ? 0 : -1} aria-checked={listMode} onClick={() => setListMode(true)} style={presetButtonStyle(listMode)} title="毎日・毎週のチェックや細かいやることをまとめるリストです">
                ToDoリスト
              </button>
            </div>
            {!listMode && <p style={{ marginTop: 6, fontSize: 'var(--font-caption)', color: 'var(--text-subtle)', lineHeight: 1.6 }}>タスクは、開始日・期限・進捗で管理する仕事です。毎日の確認事項をまとめたいときは「ToDoリスト」を選びます。</p>}
            {listMode && (
              <div style={{ marginTop: 4, fontSize: '0.7rem', color: 'var(--indigo-300)', lineHeight: 1.5 }}>
                毎日・毎週のチェックや細かいやることをまとめるリストです。期限は「なし」のままでも、決めても使えます。作ったあと、詳細か ToDo タブで項目を追加します。項目ごとに「毎日・平日・毎週・毎月」を選ぶと、決めた日が来るたびに未チェックに戻ります。
              </div>
            )}
          </div>

          <div>
            <span style={labelStyle}>期限</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {duePresets.map((preset) => (
                <button key={preset.label} type="button" aria-pressed={dueDate === preset.value} onClick={() => setDueDate(preset.value)} style={presetButtonStyle(dueDate === preset.value)}>
                  {preset.label}
                </button>
              ))}
              <button type="button" aria-pressed={dueDate === ''} onClick={() => setDueDate('')} style={presetButtonStyle(dueDate === '')}>なし</button>
              <input
                type="date"
                aria-label="期限"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                style={{ ...selectStyle, width: 'auto', flex: '1 1 140px', padding: '6px 10px', fontSize: '0.84rem' }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: users.length > 0 ? '1fr 1fr' : '1fr', gap: 10 }}>
            {users.length > 0 && (
              <div>
                <label style={labelStyle}>担当者</label>
                <AssigneePicker label="担当者" users={users} value={assigneeId} onChange={setAssigneeId} />
              </div>
            )}
            <div>
              <label htmlFor="quick-add-category" style={labelStyle}>カテゴリ</label>
              {categories.length > 0 ? (
                <select id="quick-add-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={selectStyle}>
                  <option value="">カテゴリなし</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              ) : (
                <div style={{ ...selectStyle, color: 'var(--text-subtle)' }}>カテゴリ未登録</div>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="quick-add-start" style={labelStyle}>開始日</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                id="quick-add-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                style={{ ...selectStyle, flex: 1 }}
              />
              {startDate && (
                <button type="button" onClick={() => setStartDate('')} style={presetButtonStyle(false)}>なし</button>
              )}
            </div>
            {!startDate && !dueDate && !listMode && (
              <div style={{ marginTop: 4, fontSize: '0.7rem', color: 'var(--amber-400)' }}>
                開始日も期限もないタスクは、ガントでは下の「未配置タスク」に表示されます。
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowDetails((previous) => !previous)}
            aria-expanded={showDetails}
            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: 'var(--blue-300)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700 }}
          >
            {showDetails ? '▾ 詳しい設定を閉じる' : '▸ 詳しく設定（説明・メモ・状態・優先度・繰り返し）'}
          </button>

          {showDetails && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10, background: 'var(--c-162033)', border: '1px solid var(--slate-700)' }}>
              <div>
                <label htmlFor="quick-add-description" style={labelStyle}>説明（目的・やること）</label>
                <textarea
                  id="quick-add-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="このタスクでやること"
                  rows={3}
                  style={{ ...selectStyle, resize: 'vertical', minHeight: 72, lineHeight: 1.5 }}
                />
              </div>

              <div>
                <label htmlFor="quick-add-memo" style={labelStyle}>メモ（現状・引き継ぎなど）</label>
                <textarea
                  id="quick-add-memo"
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  placeholder="補足メモ"
                  rows={2}
                  style={{ ...selectStyle, resize: 'vertical', minHeight: 56, lineHeight: 1.5 }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label htmlFor="quick-add-status" style={labelStyle}>状態</label>
                  <select
                    id="quick-add-status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as NonNullable<CreateTodoInput['status']>)}
                    style={selectStyle}
                  >
                    <option value="not_started">未着手</option>
                    <option value="active">進行中</option>
                    <option value="on_hold">保留中</option>
                    <option value="done">完了</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="quick-add-priority" style={labelStyle}>優先度</label>
                  <select id="quick-add-priority" value={priority} onChange={(event) => setPriority(Number(event.target.value))} style={selectStyle}>
                    <option value={1}>最低</option>
                    <option value={2}>低</option>
                    <option value={3}>中</option>
                    <option value={4}>高</option>
                    <option value={5}>最高</option>
                  </select>
                </div>
              </div>
              {!listMode && (
                <div>
                  <label htmlFor="quick-add-recurrence" style={labelStyle}>繰り返し（完了にすると次回分を自動で作ります）</label>
                  <select id="quick-add-recurrence" value={recurrence ?? ''} onChange={(event) => setRecurrence((event.target.value || null) as TodoRecurrence | null)} style={selectStyle}>
                    <option value="">なし</option>
                    {TODO_RECURRENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  {recurrence && (
                    <div style={{ marginTop: 4, fontSize: '0.72rem', color: 'var(--slate-400)', lineHeight: 1.5 }}>
                      {todoRecurrenceLabel({ recurrence, start_date: startDate || null, due_date: dueDate || null })}。{dueDate || startDate ? '完了にすると、次回分を作ります' : '日付がないので、次回分も日付なしで作ります'}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {isDateRangeInvalid && (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.76rem', color: 'var(--red-300)' }}>
              <span>期限 {formatShortDate(dueDate)} が、開始日 {formatShortDate(startDate)} より前になっています。</span>
              <button type="button" onClick={() => setStartDate(dueDate)} style={presetButtonStyle(false)}>開始日を期限と同じ日にする</button>
            </div>
          )}
          {!isDateRangeInvalid && dueDate && dueDate < toDateKey(new Date()) && (
            <div role="status" style={{ fontSize: '0.76rem', color: 'var(--amber-300)' }}>
              期限 {formatShortDate(dueDate)} は過ぎた日付です（このまま追加すると「期限超過」になります）
            </div>
          )}

          {/* 「詳しく設定」を開いて小窓が長くなっても、追加・キャンセルは下に見えたままにする */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 2, flexWrap: 'wrap', position: 'sticky', bottom: -20, margin: '2px -20px -20px', padding: '10px 20px 16px', background: 'var(--slate-800)', borderTop: '1px solid var(--slate-700)', borderRadius: '0 0 12px 12px', zIndex: 1 }}>
            <label style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--slate-400)', fontSize: '0.78rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={keepOpen} onChange={(event) => {
                setKeepOpen(event.target.checked)
                try { window.localStorage.setItem('quick-add-keep-open', event.target.checked ? '1' : '0') } catch { /* 覚えられなくてもよい */ }
              }} />
              追加後も続けて入力する
            </label>
            <button
              type="button"
              onClick={() => void requestClose()}
              style={{
                padding: '8px 16px',
                background: 'var(--slate-700)',
                border: 'none',
                borderRadius: 8,
                color: 'var(--slate-300)',
                cursor: 'pointer'
              }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={submitting || isDateRangeInvalid}
              aria-disabled={!canSubmit || undefined}
              style={{
                padding: '8px 16px',
                background: canSubmit ? 'var(--blue-600)' : 'var(--slate-700)',
                border: 'none',
                borderRadius: 8,
                color: canSubmit ? 'var(--on-fill-white)' : 'var(--slate-500)',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                fontWeight: 'bold'
              }}
            >
              {submitting ? '追加中...' : titles.length > 1 ? `${titles.length}件を追加` : '追加'}
            </button>
          </div>
          </fieldset>
          {slowSubmit && (
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--font-control)', color: 'var(--amber-200)' }}>
              応答がまだありません。待っても終わらないときは、閉じて一覧で追加されたかを確かめてください。
              <button type="button" onClick={() => void requestClose()} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--slate-600)', background: 'transparent', color: 'var(--slate-200)', cursor: 'pointer' }}>待たずに閉じる</button>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

function presetButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--blue-500)' : 'var(--slate-700)'}`,
    background: active ? 'var(--blue-900)' : 'var(--slate-900)',
    color: active ? 'var(--blue-100)' : 'var(--slate-400)',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}

import { confirmAction } from '../lib/confirm'
