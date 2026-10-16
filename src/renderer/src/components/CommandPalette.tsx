import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Todo } from '../types'

/** パレットの1項目（画面の切り替え・操作）。タスクは別に並べる */
export interface PaletteCommand {
  key: string
  label: string
  /** 探すときに名前のほかに当てる言葉（例: 「gantt」「チャート」） */
  keywords?: string
  group: '画面' | '操作'
  run: () => void
}

interface Props {
  commands: PaletteCommand[]
  todos: Todo[]
  onOpenTodo: (id: string) => void
  onClose: () => void
}

interface PaletteItem {
  key: string
  group: '画面' | '操作' | 'タスク'
  label: string
  detail?: string
  run: () => void
}

const MAX_TASKS = 30

// Ctrl+K で開く移動・操作のパレット。タスク名で探して開く、画面の切り替え、よく使う操作をキーボードだけでできる
export function CommandPalette({ commands, todos, onOpenTodo, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const matches = (text: string): boolean => !q || text.toLowerCase().includes(q)
    const commandItems: PaletteItem[] = commands
      .filter((command) => matches(`${command.label} ${command.keywords ?? ''}`))
      .map((command) => ({ key: command.key, group: command.group, label: command.label, run: command.run }))
    // タスクは、何も入れていないときは最近更新した順に少しだけ、入れたら名前・カテゴリ・担当で探す
    const taskItems: PaletteItem[] = todos
      .filter((todo) => todo.status !== 'archived')
      .filter((todo) => !q || matches(`${todo.title} ${todo.category_name ?? ''} ${todo.assignee_name ?? ''}`))
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      .slice(0, q ? MAX_TASKS : 8)
      .map((todo) => ({
        key: `todo:${todo.id}`,
        group: 'タスク' as const,
        label: todo.title,
        detail: [todo.category_name, todo.assignee_name, todo.status === 'done' ? '完了' : todo.status === 'on_hold' ? '保留中' : null].filter(Boolean).join('・'),
        run: () => onOpenTodo(todo.id)
      }))
    // 何も入れていないときは画面と操作を先に、入れたらタスクを先に出す
    return q ? [...taskItems, ...commandItems] : [...commandItems, ...taskItems]
  }, [commands, onOpenTodo, query, todos])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((previous) => items.length === 0 ? 0 : (previous + 1) % items.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((previous) => items.length === 0 ? 0 : (previous - 1 + items.length) % items.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(items[activeIndex])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  let lastGroup: string | null = null
  return (
    <div
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'color-mix(in srgb, var(--slate-950) 60%, transparent)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }}
    >
      <div role="dialog" aria-modal="true" aria-label="移動・操作" style={{ width: 'min(640px, calc(100vw - 32px))', background: 'var(--slate-900)', border: '1px solid var(--slate-700)', borderRadius: 12, boxShadow: '0 24px 60px color-mix(in srgb, var(--slate-950) 70%, transparent)', overflow: 'hidden' }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="hakobi-command-palette-list"
          aria-activedescendant={items[activeIndex] ? `hakobi-palette-item-${activeIndex}` : undefined}
          aria-label="タスク名・画面・操作を探す"
          placeholder="タスク名・画面・操作を入力（↑↓で選び Enter）"
          style={{ width: '100%', padding: '14px 16px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--slate-800)', color: 'var(--slate-200)', fontSize: '0.95rem', outline: 'none', boxSizing: 'border-box' }}
        />
        <div ref={listRef} id="hakobi-command-palette-list" role="listbox" aria-label="候補" style={{ maxHeight: '52vh', overflowY: 'auto', padding: 6 }}>
          {items.length === 0 && <div style={{ padding: '12px 10px', color: 'var(--slate-400)', fontSize: '0.85rem' }}>当てはまるものはありません</div>}
          {items.map((item, index) => {
            const showGroup = item.group !== lastGroup
            lastGroup = item.group
            const active = index === activeIndex
            return (
              <React.Fragment key={item.key}>
                {showGroup && <div style={{ padding: '8px 10px 4px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--slate-400)' }}>{item.group}</div>}
                <div
                  id={`hakobi-palette-item-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => { event.preventDefault(); choose(item) }}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: active ? 'var(--slate-800)' : 'transparent' }}
                >
                  <span style={{ color: 'var(--slate-200)', fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.label}</span>
                  {item.detail && <span style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--slate-400)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{item.detail}</span>}
                </div>
              </React.Fragment>
            )
          })}
        </div>
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--slate-800)', color: 'var(--slate-400)', fontSize: '0.72rem' }}>
          ↑↓ で選ぶ・Enter で開く・Esc で閉じる
        </div>
      </div>
    </div>
  )
}
