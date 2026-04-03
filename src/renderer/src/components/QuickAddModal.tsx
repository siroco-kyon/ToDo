import React, { useEffect, useRef, useState } from 'react'
import type { Category, CreateTodoInput } from '../types'

interface Props {
  categories: Category[]
  onAdd: (data: CreateTodoInput) => Promise<void>
  onClose: () => void
}

const selectStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 12px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.9rem'
}

export function QuickAddModal({ categories, onAdd, onClose }: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [priority, setPriority] = useState(3)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!title.trim()) return
    await onAdd({ title: title.trim(), category_id: categoryId || null, priority })
    onClose()
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
        zIndex: 1000
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        style={{
          background: '#1e293b',
          borderRadius: 12,
          padding: 24,
          width: 480,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          border: '1px solid #334155'
        }}
      >
        <h2 style={{ marginBottom: 16, fontSize: '1.1rem', color: '#e2e8f0' }}>
          クイック追加
        </h2>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="タスクを追加..."
            style={{
              width: '100%',
              padding: '10px 12px',
              marginBottom: 12,
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 8,
              color: '#e2e8f0',
              fontSize: '1rem',
              outline: 'none'
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {categories.length > 0 && (
              <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={selectStyle}>
                <option value="">カテゴリなし</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            )}
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))} style={{ ...selectStyle, flex: '0 0 auto', width: 90 }}>
              <option value={1}>最高</option>
              <option value={2}>高</option>
              <option value={3}>中</option>
              <option value={4}>低</option>
              <option value={5}>最低</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
              style={{
                padding: '8px 16px',
                background: '#6366f1',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              追加
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
