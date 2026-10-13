import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, CreateTodoInput, PublicUser, Todo } from '../types'
import { AssigneePicker } from './AssigneePicker'
import { toDateKey } from '../lib/dueDate'

interface Props {
  categories: Category[]
  users?: PublicUser[]
  /** 開いた時点のカテゴリ（左で選んでいるカテゴリなど）。null はカテゴリなし */
  defaultCategoryId?: string | null
  /** 開いた時点の担当（サーバー版は自分）。null は未割り当て */
  defaultAssigneeId?: string | null
  onAdd: (data: CreateTodoInput) => Promise<Todo>
  /** 追加がすべて終わったときに、作ったタスクを渡す */
  onAdded?: (created: Todo[]) => void
  onClose: () => void
  onShowToast: (message: string, type?: 'success' | 'error') => void
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.9rem',
  boxSizing: 'border-box'
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: '0.75rem',
  color: '#94a3b8'
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
  onAdd,
  onAdded,
  onClose,
  onShowToast
}: Props): React.JSX.Element {
  const templates = useMemo(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('todo-templates') ?? '[]') as unknown
      return Array.isArray(parsed) ? parsed as Array<{ name: string; todo: CreateTodoInput; subTasks?: Array<{ title: string; description?: string; start_date?: string | null; due_date?: string | null }> }> : []
    } catch { return [] }
  }, [])
  const [selectedTemplateName, setSelectedTemplateName] = useState('')
  const [templateSubTasks, setTemplateSubTasks] = useState<Array<{ title: string; description?: string; start_date?: string | null; due_date?: string | null }>>([])
  const savedDraft = useMemo(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('quick-add-draft') ?? '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as { title?: string; description?: string; memo?: string } : {}
    } catch { return {} }
  }, [])
  const [title, setTitle] = useState(savedDraft.title ?? '')
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
  // 開始日を入れておくと、ガントに今日から1日のバーとして出る（日付なしだと下の「未配置」に回る）
  const [startDate, setStartDate] = useState(() => toDateKey(new Date()))
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [keepOpen, setKeepOpen] = useState(false)
  const [showDetails, setShowDetails] = useState(() => Boolean(savedDraft.description?.trim() || savedDraft.memo?.trim()))
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const duePresets = useMemo(buildDuePresets, [])

  const isDateRangeInvalid = useMemo(() => (
    Boolean(startDate && dueDate && startDate > dueDate)
  ), [dueDate, startDate])

  const titles = title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  const canSubmit = titles.length > 0 && !isDateRangeInvalid && !submitting

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    window.localStorage.setItem('quick-add-draft', JSON.stringify({ title, description, memo }))
  }, [description, memo, title])

  const requestClose = (): void => {
    if ((title.trim() || description.trim() || memo.trim()) && !window.confirm('入力中の内容があります。閉じてもよいですか？\n下書きは次回まで保存されます。')) return
    onClose()
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      requestClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [description, memo, onClose, title])

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
    setTemplateSubTasks(template.subTasks ?? [])
    if (template.todo.description || template.todo.memo || (template.todo.priority ?? 3) !== 3) setShowDetails(true)
  }

  const submit = async (): Promise<void> => {
    if (!canSubmit) return

    setSubmitting(true)
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
          status,
          priority,
          start_date: startDate || null,
          due_date: dueDate || null
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
      onShowToast(created.length > 0 ? `${created.length}件は追加済みです。残りを再試行できます: ${detail}` : detail, 'error')
    } finally {
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
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-title"
        style={{
          background: '#1e293b',
          borderRadius: 12,
          padding: 20,
          width: 560,
          maxWidth: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          border: '1px solid #334155'
        }}
      >
        <h2 id="quick-add-title" style={{ margin: '0 0 14px', fontSize: '1.08rem', color: '#e2e8f0' }}>
          タスクを追加
        </h2>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
            <label htmlFor="quick-add-input" style={labelStyle}>タスク名</label>
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
              rows={titles.length > 1 ? Math.min(6, titles.length + 1) : 2}
              style={{ ...selectStyle, fontSize: '1rem', resize: 'vertical', lineHeight: 1.5 }}
            />
            <div style={{ marginTop: 4, fontSize: '0.7rem', color: '#64748b' }}>
              Enter で追加・Shift+Enter で改行。複数行にすると1行ずつ別のタスクになります
              {titles.length > 1 && <span style={{ color: '#93c5fd', fontWeight: 700 }}>（{titles.length}件）</span>}
            </div>
          </div>

          <div>
            <span style={labelStyle}>期限</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {duePresets.map((preset) => (
                <button key={preset.label} type="button" onClick={() => setDueDate(preset.value)} style={presetButtonStyle(dueDate === preset.value)}>
                  {preset.label}
                </button>
              ))}
              <button type="button" onClick={() => setDueDate('')} style={presetButtonStyle(dueDate === '')}>なし</button>
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
                <AssigneePicker users={users} value={assigneeId} onChange={setAssigneeId} />
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
                <div style={{ ...selectStyle, color: '#64748b' }}>カテゴリ未登録</div>
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
            {!startDate && !dueDate && (
              <div style={{ marginTop: 4, fontSize: '0.7rem', color: '#fbbf24' }}>
                開始日も期限もないタスクは、ガントでは下の「未配置タスク」に表示されます。
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowDetails((previous) => !previous)}
            aria-expanded={showDetails}
            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: '#93c5fd', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700 }}
          >
            {showDetails ? '▾ 詳しい設定を閉じる' : '▸ 詳しく設定（内容・メモ・状態・優先度）'}
          </button>

          {showDetails && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10, background: '#162033', border: '1px solid #334155' }}>
              <div>
                <label htmlFor="quick-add-description" style={labelStyle}>内容（このタスクでやること・目的）</label>
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
            </div>
          )}

          {isDateRangeInvalid && (
            <div role="alert" style={{ fontSize: '0.76rem', color: '#fca5a5' }}>
              開始日は期限以前にしてください。
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
            <label style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: '0.78rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={keepOpen} onChange={(event) => setKeepOpen(event.target.checked)} />
              追加後も続けて入力する
            </label>
            <button
              type="button"
              onClick={requestClose}
              style={{
                padding: '8px 16px',
                background: '#334155',
                border: 'none',
                borderRadius: 8,
                color: '#cbd5e1',
                cursor: 'pointer'
              }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: '8px 16px',
                background: canSubmit ? '#2563eb' : '#334155',
                border: 'none',
                borderRadius: 8,
                color: canSubmit ? '#fff' : '#64748b',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                fontWeight: 'bold'
              }}
            >
              {submitting ? '追加中...' : titles.length > 1 ? `${titles.length}件を追加` : '追加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function presetButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? '#3b82f6' : '#334155'}`,
    background: active ? '#1e3a8a' : '#0f172a',
    color: active ? '#dbeafe' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.78rem',
    fontWeight: 700,
    whiteSpace: 'nowrap'
  }
}
