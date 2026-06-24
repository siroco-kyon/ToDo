import React, { useState, useRef } from 'react'
import type { Category } from '../types'

interface Props {
  categories: Category[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (name: string, color: string, isPrivate: boolean) => Promise<void>
  onUpdate: (id: string, name: string, color: string, description: string, isPrivate: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (orderedIds: string[]) => Promise<void>
}

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6']

export function CategoryList({ categories, selectedId, onSelect, onAdd, onUpdate, onDelete, onReorder }: Props): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(COLORS[0])
  const [newPrivate, setNewPrivate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState(COLORS[0])
  const [editDesc, setEditDesc] = useState('')
  const [editPrivate, setEditPrivate] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // ─── ドラッグ並び替え ──────────────────────────────────────
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragging = useRef(false)

  const handleDrop = async (targetId: string): Promise<void> => {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null); setDragOverId(null); return
    }
    const ids = categories.map((c) => c.id)
    const fromIdx = ids.indexOf(draggedId)
    const toIdx = ids.indexOf(targetId)
    const newIds = [...ids]
    newIds.splice(fromIdx, 1)
    newIds.splice(toIdx, 0, draggedId)
    setDraggedId(null); setDragOverId(null)
    dragging.current = false
    await onReorder(newIds)
  }

  // ─── カテゴリ追加 ──────────────────────────────────────────
  const handleAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!newName.trim()) return
    await onAdd(newName.trim(), newColor, newPrivate)
    setNewName('')
    setNewColor(COLORS[0])
    setNewPrivate(false)
    setAdding(false)
  }

  // ─── カテゴリ編集 ──────────────────────────────────────────
  const startEdit = (cat: Category, e: React.MouseEvent): void => {
    e.stopPropagation()
    setEditingId(cat.id)
    setEditName(cat.name)
    setEditColor(cat.color)
    setEditDesc(cat.description ?? '')
    setEditPrivate(!!cat.is_private)
  }

  const handleUpdate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!editingId || !editName.trim()) return
    await onUpdate(editingId, editName.trim(), editColor, editDesc, editPrivate)
    setEditingId(null)
  }

  // ─── カテゴリ削除 ──────────────────────────────────────────
  const handleDelete = async (cat: Category, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!window.confirm(`「${cat.name}」を削除しますか？\n関連タスクのカテゴリは「未分類」になります。`)) return
    await onDelete(cat.id)
  }

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      onDragEnd={() => { setDraggedId(null); setDragOverId(null); dragging.current = false }}
    >
      <div style={{ padding: '16px 12px 8px', fontSize: '0.75rem', color: '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        カテゴリ
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <button
          onClick={() => onSelect(null)}
          style={itemStyle(selectedId === null)}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#64748b', display: 'inline-block', marginRight: 8 }} />
          すべて
        </button>

        {categories.map((cat) => (
          <div key={cat.id}>
            {editingId === cat.id ? (
              <form onSubmit={handleUpdate} style={{ padding: '8px 12px', borderBottom: '1px solid #1e293b' }}>
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="カテゴリ名"
                  style={inputStyle}
                  onKeyDown={(e) => e.key === 'Escape' && setEditingId(null)}
                />
                <div style={{ display: 'flex', gap: 4, margin: '6px 0' }}>
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setEditColor(c)}
                      style={{
                        width: 18, height: 18, borderRadius: '50%', background: c,
                        border: `2px solid ${editColor === c ? '#fff' : 'transparent'}`,
                        cursor: 'pointer', padding: 0
                      }}
                    />
                  ))}
                </div>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="説明（任意）"
                  rows={2}
                  style={{ ...inputStyle, resize: 'vertical', marginBottom: 4 }}
                />
                <label style={privateLabelStyle}>
                  <input type="checkbox" checked={editPrivate} onChange={(e) => setEditPrivate(e.target.checked)} style={{ accentColor: '#6366f1' }} />
                  プライベート（全体の集計から除外）
                </label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button type="submit" style={btnStyle('#6366f1')}>保存</button>
                  <button type="button" onClick={() => setEditingId(null)} style={btnStyle('#334155')}>×</button>
                </div>
              </form>
            ) : (
              <div
                draggable
                onDragStart={() => { setDraggedId(cat.id); dragging.current = true }}
                onDragOver={(e) => { if (dragging.current) { e.preventDefault(); setDragOverId(cat.id) } }}
                onDrop={(e) => { e.preventDefault(); if (dragging.current) handleDrop(cat.id) }}
                onMouseEnter={() => setHoveredId(cat.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  position: 'relative',
                  borderTop: dragOverId === cat.id ? '2px solid #6366f1' : '2px solid transparent'
                }}
              >
                <button
                  onClick={() => onSelect(cat.id)}
                  style={{ ...itemStyle(selectedId === cat.id), paddingRight: hoveredId === cat.id ? 60 : 12 }}
                >
                  <span style={{ width: 6, height: 20, borderRadius: 2, background: '#334155', display: 'inline-block', marginRight: 6, flexShrink: 0, cursor: 'grab' }} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: cat.color, display: 'inline-block', marginRight: 8, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                    {cat.name}
                  </span>
                  {cat.is_private ? (
                    <span title="プライベート（全体の集計から除外）" style={{ marginLeft: 4, fontSize: '0.7rem', flexShrink: 0 }}>🔒</span>
                  ) : null}
                </button>
                {cat.description && hoveredId !== cat.id && (
                  <div style={{
                    fontSize: '0.68rem', color: '#475569', padding: '0 12px 4px 34px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    lineHeight: 1.4
                  }}>
                    {cat.description}
                  </div>
                )}
                {hoveredId === cat.id && (
                  <div style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: 2 }}>
                    <button
                      onClick={(e) => startEdit(cat, e)}
                      title="編集"
                      style={iconBtn('#334155', '#94a3b8')}
                    >
                      ✏
                    </button>
                    <button
                      onClick={(e) => handleDelete(cat, e)}
                      title="削除"
                      style={iconBtn('#7f1d1d', '#ef4444')}
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {adding ? (
        <form onSubmit={handleAdd} style={{ padding: '8px 12px', borderTop: '1px solid #1e293b' }}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="カテゴリ名"
            style={inputStyle}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          />
          <div style={{ display: 'flex', gap: 4, margin: '6px 0' }}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setNewColor(c)}
                style={{
                  width: 18, height: 18, borderRadius: '50%', background: c, border: `2px solid ${newColor === c ? '#fff' : 'transparent'}`,
                  cursor: 'pointer', padding: 0
                }}
              />
            ))}
          </div>
          <label style={privateLabelStyle}>
            <input type="checkbox" checked={newPrivate} onChange={(e) => setNewPrivate(e.target.checked)} style={{ accentColor: '#6366f1' }} />
            プライベート（全体の集計から除外）
          </label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="submit" style={btnStyle('#6366f1')}>追加</button>
            <button type="button" onClick={() => setAdding(false)} style={btnStyle('#334155')}>×</button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 'calc(100% - 16px)', margin: '8px', padding: '7px',
            background: '#1e293b', border: '1px dashed #334155',
            borderRadius: 6, color: '#6366f1', cursor: 'pointer',
            fontSize: '0.85rem', fontWeight: 'bold'
          }}
        >
          + カテゴリ追加
        </button>
      )}
    </div>
  )
}

function itemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', width: '100%', padding: '8px 12px',
    background: active ? '#1e293b' : 'transparent', border: 'none', borderRadius: 6,
    color: active ? '#e2e8f0' : '#94a3b8', cursor: 'pointer', textAlign: 'left',
    fontSize: '0.9rem', transition: 'background 0.15s'
  }
}

function iconBtn(bg: string, color: string): React.CSSProperties {
  return {
    background: bg, border: 'none', borderRadius: 4,
    color, cursor: 'pointer', fontSize: '0.7rem',
    padding: '2px 5px', lineHeight: 1
  }
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: '#0f172a',
  border: '1px solid #334155', borderRadius: 6, color: '#e2e8f0',
  fontSize: '0.85rem', outline: 'none', marginBottom: 4, boxSizing: 'border-box'
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    flex: 1, padding: '4px 8px', background: bg, border: 'none',
    borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: '0.8rem'
  }
}

const privateLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0 6px',
  fontSize: '0.72rem', color: '#94a3b8', cursor: 'pointer'
}
