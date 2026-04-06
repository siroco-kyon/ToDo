import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, CreateTodoInput } from '../types'

interface Props {
  categories: Category[]
  onAdd: (data: CreateTodoInput) => Promise<void>
  onClose: () => void
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

export function QuickAddModal({ categories, onAdd, onClose }: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [memo, setMemo] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [priority, setPriority] = useState(3)
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isDateRangeInvalid = useMemo(() => (
    Boolean(startDate && dueDate && startDate > dueDate)
  ), [dueDate, startDate])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (submitting) return

    const trimmedTitle = title.trim()
    if (!trimmedTitle || isDateRangeInvalid) return

    setSubmitting(true)
    try {
      await onAdd({
        title: trimmedTitle,
        description: description.trim(),
        memo: memo.trim(),
        category_id: categoryId || null,
        priority,
        start_date: startDate || null,
        due_date: dueDate || null
      })
      onClose()
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
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
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
        <h2 style={{ margin: '0 0 14px', fontSize: '1.08rem', color: '#e2e8f0' }}>
          タスク追加
        </h2>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={labelStyle}>タイトル</label>
            <input
              ref={inputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="タスクを入力..."
              style={{ ...selectStyle, fontSize: '1rem' }}
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
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
              <label style={labelStyle}>優先度</label>
              <select value={priority} onChange={(event) => setPriority(Number(event.target.value))} style={selectStyle}>
                <option value={1}>低</option>
                <option value={2}>中低</option>
                <option value={3}>中</option>
                <option value={4}>中高</option>
                <option value={5}>高</option>
              </select>
            </div>
          </div>

          {isDateRangeInvalid && (
            <div style={{ fontSize: '0.76rem', color: '#fca5a5' }}>
              開始日は期限以前にしてください。
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
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
