import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, CreateTodoInput, PublicUser, Todo } from '../types'
import { AssigneePicker } from './AssigneePicker'

interface Props {
  categories: Category[]
  users?: PublicUser[]
  onAdd: (data: CreateTodoInput) => Promise<Todo>
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

export function QuickAddModal({ categories, users = [], onAdd, onClose, onShowToast }: Props): React.JSX.Element {
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
  const [categoryId, setCategoryId] = useState('')
  const [assigneeId, setAssigneeId] = useState<string | null>(null)
  const [status, setStatus] = useState<NonNullable<CreateTodoInput['status']>>('not_started')
  const [priority, setPriority] = useState(3)
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [keepOpen, setKeepOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const isDateRangeInvalid = useMemo(() => (
    Boolean(startDate && dueDate && startDate > dueDate)
  ), [dueDate, startDate])

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

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (submitting) return

    const titles = title.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    if (titles.length === 0 || isDateRangeInvalid) return

    setSubmitting(true)
    const remainingTitles = [...titles]
    let createdCount = 0
    try {
      for (const nextTitle of titles) {
        const created = await onAdd({
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
        createdCount += 1
        remainingTitles.shift()
        setTitle(remainingTitles.join('\n'))
        for (const subTask of templateSubTasks) await window.api.subtaskCreate(created.id, subTask)
      }
      setTitle('')
      setDescription('')
      setMemo('')
      window.localStorage.removeItem('quick-add-draft')
      if (keepOpen) inputRef.current?.focus()
      else onClose()
    } catch (error) {
      const detail = error instanceof Error ? error.message : '追加できませんでした'
      onShowToast(createdCount > 0 ? `${createdCount}件は追加済みです。残りを再試行できます: ${detail}` : detail, 'error')
    } finally {
      setSubmitting(false)
    }
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
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          border: '1px solid #334155'
        }}
      >
        <h2 id="quick-add-title" style={{ margin: '0 0 14px', fontSize: '1.08rem', color: '#e2e8f0' }}>
          タスク追加
        </h2>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {templates.length > 0 && <div><label style={labelStyle}>テンプレート</label><select value={selectedTemplateName} onChange={(event) => { const template = templates.find((item) => item.name === event.target.value); setSelectedTemplateName(event.target.value); if (!template) { setTemplateSubTasks([]); return }; setTitle(template.todo.title ?? ''); setDescription(template.todo.description ?? ''); setMemo(template.todo.memo ?? ''); setCategoryId(template.todo.category_id ?? ''); setAssigneeId(template.todo.assignee_id ?? null); setStatus(template.todo.status ?? 'not_started'); setPriority(template.todo.priority ?? 3); setStartDate(template.todo.start_date ?? ''); setDueDate(template.todo.due_date ?? ''); setTemplateSubTasks(template.subTasks ?? []) }} style={selectStyle}><option value="">選択しない</option>{templates.map((template) => <option key={template.name} value={template.name}>{template.name}</option>)}</select></div>}
          <div>
            <label style={labelStyle}>タイトル</label>
            <textarea
              ref={inputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="タスクを入力...（複数行で一括追加）"
              rows={2}
              style={{ ...selectStyle, fontSize: '1rem', resize: 'vertical' }}
            />
          </div>

          <div>
            <label style={labelStyle}>内容</label>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="このタスクでやること"
              rows={3}
              style={{ ...selectStyle, resize: 'vertical', minHeight: 84, lineHeight: 1.5 }}
            />
          </div>

          <div>
            <label style={labelStyle}>メモ</label>
            <textarea
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              placeholder="補足メモ"
              rows={2}
              style={{ ...selectStyle, resize: 'vertical', minHeight: 64, lineHeight: 1.5 }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={labelStyle}>開始日</label>
              <input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                style={selectStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>期限</label>
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                style={selectStyle}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(90px, 0.55fr) minmax(90px, 0.55fr)', gap: 10 }}>
            <div>
              <label style={labelStyle}>カテゴリ</label>
              {categories.length > 0 ? (
                <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={selectStyle}>
                  <option value="">カテゴリなし</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              ) : (
                <div style={{ ...selectStyle, color: '#64748b' }}>カテゴリ未登録</div>
              )}
            </div>
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
                <option value="done">完了</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>優先度</label>
              <select value={priority} onChange={(event) => setPriority(Number(event.target.value))} style={selectStyle}>
              <option value={1}>最低</option>
              <option value={2}>低</option>
              <option value={3}>中</option>
              <option value={4}>高</option>
              <option value={5}>最高</option>
              </select>
            </div>
          </div>

          {users.length > 0 && (
            <div>
              <label style={labelStyle}>担当者</label>
              <AssigneePicker users={users} value={assigneeId} onChange={setAssigneeId} />
            </div>
          )}

          {isDateRangeInvalid && (
            <div style={{ fontSize: '0.76rem', color: '#fca5a5' }}>
              開始日は期限以前にしてください。
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <label style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: '0.78rem' }}><input type="checkbox" checked={keepOpen} onChange={(event) => setKeepOpen(event.target.checked)} />追加後も続ける</label>
            <button
              type="button"
              onClick={requestClose}
              style={{
                padding: '8px 16px',
                background: '#334155',
                border: 'none',
                borderRadius: 8,
                color: '#94a3b8',
                cursor: 'pointer'
              }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!title.trim() || isDateRangeInvalid || submitting}
              style={{
                padding: '8px 16px',
                background: !title.trim() || isDateRangeInvalid || submitting ? '#334155' : '#6366f1',
                border: 'none',
                borderRadius: 8,
                color: !title.trim() || isDateRangeInvalid || submitting ? '#64748b' : '#fff',
                cursor: !title.trim() || isDateRangeInvalid || submitting ? 'not-allowed' : 'pointer',
                fontWeight: 'bold'
              }}
            >
              {submitting ? '追加中...' : '追加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
