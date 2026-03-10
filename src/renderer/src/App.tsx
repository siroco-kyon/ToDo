import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { Todo, Category, CreateTodoInput, UpdateTodoInput } from './types'
import { useTimer } from './hooks/useTimer'
import { Toolbar } from './components/Toolbar'
import { CategoryList } from './components/CategoryList'
import { TodoList } from './components/TodoList'
import { TodoDetail } from './components/TodoDetail'
import { QuickAddModal } from './components/QuickAddModal'
import { Toast } from './components/Toast'
import type { ToastMessage } from './components/Toast'
import { SettingsModal } from './components/SettingsModal'
import { WorkLogSummary } from './components/WorkLogSummary'
import { SetupWizardModal } from './components/SetupWizardModal'
import { CalendarView } from './components/CalendarView'

type SortField = 'created_at' | 'updated_at' | 'priority' | 'progress' | 'due_date' | 'title' | 'sort_order'

function calcNextDueDate(todo: Todo): string | null {
  if (!todo.recurrence) return null
  const base = todo.due_date ? new Date(todo.due_date) : new Date()
  const next = new Date(base)
  if (todo.recurrence === 'daily') next.setDate(next.getDate() + 1)
  else if (todo.recurrence === 'weekly') next.setDate(next.getDate() + 7)
  else if (todo.recurrence === 'monthly') next.setMonth(next.getMonth() + 1)
  return next.toISOString().slice(0, 10)
}

export function App(): React.JSX.Element {
  const [isFirstLaunch, setIsFirstLaunch] = useState<boolean | null>(null)
  const [todos, setTodos] = useState<Todo[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [sortField, setSortField] = useState<SortField>('created_at')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [searchQuery, setSearchQuery] = useState('')
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showLogView, setShowLogView] = useState(false)
  const [showCalendarView, setShowCalendarView] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastIdRef = useRef(0)

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, message, type }])
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const loadTodos = useCallback(async () => {
    const all = await window.api.todoGetAll()
    setTodos(all)
  }, [])

  const { isRunning, runningTodoId, elapsedSeconds, start, stop, restore } = useTimer(loadTodos)

  // 初回起動チェック
  useEffect(() => {
    window.api.appIsFirstLaunch().then(setIsFirstLaunch)
  }, [])

  const handleSetupComplete = useCallback(async () => {
    setIsFirstLaunch(false)
    const [allTodos, allCats] = await Promise.all([
      window.api.todoGetAll(),
      window.api.categoryGetAll()
    ])
    setTodos(allTodos)
    setCategories(allCats)
    const running = await window.api.timerGetRunning()
    if (running) restore(running)
  }, [restore])

  // 初期データ読み込み
  useEffect(() => {
    if (isFirstLaunch === false) {
      const init = async (): Promise<void> => {
        const [allTodos, allCats] = await Promise.all([
          window.api.todoGetAll(),
          window.api.categoryGetAll()
        ])
        setTodos(allTodos)
        setCategories(allCats)
        const running = await window.api.timerGetRunning()
        if (running) restore(running)
      }
      init()
    }
  }, [isFirstLaunch, restore])

  // グローバルショートカット
  const handleExportClipboard = useCallback(async () => {
    const result = await window.api.markdownExport('clipboard')
    showToast(result.message, result.success ? 'success' : 'error')
  }, [showToast])

  useEffect(() => {
    const unsubQuickAdd = window.api.onShortcutQuickAdd(() => setShowQuickAdd(true))
    const unsubExport = window.api.onShortcutExport(() => handleExportClipboard())
    return () => { unsubQuickAdd(); unsubExport() }
  }, [handleExportClipboard])

  // フィルタリング＋ソート
  const q = searchQuery.trim().toLowerCase()
  const filteredTodos = todos
    .filter((t) => {
      if (!showArchived && t.status === 'archived') return false
      if (selectedCategoryId && t.category_id !== selectedCategoryId) return false
      if (q) {
        const hit = t.title.toLowerCase().includes(q)
          || t.description.toLowerCase().includes(q)
          || (t.category_name?.toLowerCase().includes(q) ?? false)
        if (!hit) return false
      }
      return true
    })
    .sort((a, b) => {
      if (a.status === 'archived' && b.status !== 'archived') return 1
      if (a.status !== 'archived' && b.status === 'archived') return -1

      if (sortField === 'sort_order') {
        return (a.sort_order ?? 0) - (b.sort_order ?? 0)
      }

      let aVal: string | number
      let bVal: string | number
      if (sortField === 'title') {
        aVal = a.title.toLowerCase(); bVal = b.title.toLowerCase()
      } else if (sortField === 'due_date') {
        aVal = a.due_date ?? (sortDir === 'asc' ? '\uffff' : '')
        bVal = b.due_date ?? (sortDir === 'asc' ? '\uffff' : '')
      } else {
        aVal = (a[sortField] as number) ?? 0
        bVal = (b[sortField] as number) ?? 0
      }
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1
      return 0
    })

  const selectedTodo = todos.find((t) => t.id === selectedTodoId) ?? null

  // CRUD
  const handleAdd = useCallback(async (data: CreateTodoInput) => {
    await window.api.todoCreate(data)
    await loadTodos()
  }, [loadTodos])

  const handleUpdate = useCallback(async (id: string, data: UpdateTodoInput) => {
    await window.api.todoUpdate(id, data)
    await loadTodos()
  }, [loadTodos])

  const handleArchive = useCallback(async (id: string) => {
    await window.api.todoArchive(id)
    await loadTodos()
    if (selectedTodoId === id) setSelectedTodoId(null)
    showToast('アーカイブしました')
  }, [loadTodos, selectedTodoId, showToast])

  const handleUnarchive = useCallback(async (id: string) => {
    await window.api.todoUnarchive(id)
    await loadTodos()
    showToast('復元しました')
  }, [loadTodos, showToast])

  const handleDelete = useCallback(async (id: string) => {
    await window.api.todoDelete(id)
    await loadTodos()
    if (selectedTodoId === id) setSelectedTodoId(null)
    showToast('削除しました')
  }, [loadTodos, selectedTodoId, showToast])

  const handleToggleDone = useCallback(async (todo: Todo) => {
    const newStatus = todo.status === 'done' ? 'active' : 'done'
    await window.api.todoUpdate(todo.id, { status: newStatus })

    // 繰り返しタスク: 完了時に次のタスクを自動生成
    if (newStatus === 'done' && todo.recurrence) {
      const nextDue = calcNextDueDate(todo)
      await window.api.todoCreate({
        title: todo.title,
        description: todo.description,
        category_id: todo.category_id,
        priority: todo.priority,
        due_date: nextDue,
        recurrence: todo.recurrence
      })
      const label = todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : '毎月'
      showToast(`🔁 ${label}タスクを自動作成しました`)
    }

    await loadTodos()
  }, [loadTodos, showToast])

  const handleCategoryAdd = useCallback(async (name: string, color: string) => {
    await window.api.categoryCreate(name, color)
    const cats = await window.api.categoryGetAll()
    setCategories(cats)
  }, [])

  const handleCategoryUpdate = useCallback(async (id: string, name: string, color: string, description: string) => {
    await window.api.categoryUpdate(id, name, color, description)
    const cats = await window.api.categoryGetAll()
    setCategories(cats)
  }, [])

  const handleCategoryDelete = useCallback(async (id: string) => {
    await window.api.categoryDelete(id)
    const cats = await window.api.categoryGetAll()
    setCategories(cats)
    if (selectedCategoryId === id) setSelectedCategoryId(null)
    await loadTodos()
  }, [selectedCategoryId, loadTodos])

  const handleCategoryReorder = useCallback(async (orderedIds: string[]) => {
    await window.api.categoryReorder(orderedIds)
    const cats = await window.api.categoryGetAll()
    setCategories(cats)
  }, [])

  const handleExportFile = useCallback(async () => {
    const result = await window.api.markdownExport('file')
    showToast(result.message, result.success ? 'success' : 'error')
  }, [showToast])

  // ドラッグ並び替え
  const handleReorder = useCallback(async (orderedIds: string[]) => {
    await window.api.todoReorder(orderedIds)
    await loadTodos()
  }, [loadTodos])

  if (isFirstLaunch === null) {
    return <div style={{ height: '100vh', background: '#0a0f1a' }} />
  }
  if (isFirstLaunch) {
    return <SetupWizardModal onComplete={handleSetupComplete} />
  }

  const isManualSort = sortField === 'sort_order'
  const SORT_FIELDS: { key: SortField; label: string }[] = [
    { key: 'sort_order', label: '手動' },
    { key: 'created_at', label: '作成日' },
    { key: 'updated_at', label: '更新日' },
    { key: 'priority', label: '優先度' },
    { key: 'progress', label: '進捗' },
    { key: 'due_date', label: '期限' },
    { key: 'title', label: 'タイトル' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Toolbar
        categories={categories}
        isTimerRunning={isRunning}
        onAdd={handleAdd}
        onExportClipboard={handleExportClipboard}
        onExportFile={handleExportFile}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onOpenSettings={() => setShowSettings(true)}
        showLogView={showLogView}
        onToggleLogView={() => { setShowLogView((v) => !v); setShowCalendarView(false) }}
        showCalendarView={showCalendarView}
        onToggleCalendarView={() => { setShowCalendarView((v) => !v); setShowLogView(false) }}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左ペイン: カテゴリ */}
        <div style={{ width: 200, flexShrink: 0, background: '#0a0f1a', borderRight: '1px solid #1e293b', overflow: 'hidden' }}>
          <CategoryList
            categories={categories}
            selectedId={selectedCategoryId}
            onSelect={setSelectedCategoryId}
            onAdd={handleCategoryAdd}
            onUpdate={handleCategoryUpdate}
            onDelete={handleCategoryDelete}
            onReorder={handleCategoryReorder}
          />
        </div>

        {/* 中央ペイン: 検索＋ソート＋TODOリスト */}
        <div style={{ width: 300, flexShrink: 0, background: '#0d1525', borderRight: '1px solid #1e293b', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* 検索バー */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="🔍 タイトル・説明・カテゴリを検索..."
              style={{
                width: '100%', padding: '5px 8px', background: '#0f172a',
                border: `1px solid ${searchQuery ? '#6366f1' : '#1e293b'}`,
                borderRadius: 6, color: '#e2e8f0', fontSize: '0.8rem', outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {/* ソートバー */}
          <div style={{ padding: '5px 8px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            {SORT_FIELDS.map(({ key, label }) => {
              const active = sortField === key
              return (
                <button
                  key={key}
                  onClick={() => {
                    if (key === 'sort_order') { setSortField('sort_order'); return }
                    if (active) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
                    else { setSortField(key); setSortDir('desc') }
                  }}
                  style={{
                    fontSize: '0.68rem', padding: '2px 6px', borderRadius: 99,
                    background: active ? '#6366f120' : 'transparent',
                    border: `1px solid ${active ? '#6366f1' : '#1e293b'}`,
                    color: active ? '#818cf8' : '#475569',
                    cursor: 'pointer', whiteSpace: 'nowrap'
                  }}
                >
                  {label}{active && key !== 'sort_order' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              )
            })}
          </div>

          <div style={{ flex: 1, overflow: 'hidden' }}>
            <TodoList
              todos={filteredTodos}
              selectedId={selectedTodoId}
              runningTodoId={runningTodoId}
              isManualSort={isManualSort}
              searchQuery={q}
              onSelect={setSelectedTodoId}
              onToggleDone={handleToggleDone}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onDelete={handleDelete}
              onReorder={handleReorder}
            />
          </div>
        </div>

        {/* 右ペイン */}
        <div style={{ flex: 1, overflow: 'hidden', background: '#0f172a' }}>
          {showCalendarView ? (
            <CalendarView
              todos={todos}
              onSelectTodo={(id) => { setSelectedTodoId(id); setShowCalendarView(false) }}
            />
          ) : showLogView ? (
            <WorkLogSummary />
          ) : (
            <TodoDetail
              todo={selectedTodo}
              categories={categories}
              runningTodoId={runningTodoId}
              elapsedSeconds={elapsedSeconds}
              onUpdate={handleUpdate}
              onStartTimer={start}
              onStopTimer={stop}
              onShowToast={showToast}
            />
          )}
        </div>
      </div>

      {showQuickAdd && (
        <QuickAddModal
          categories={categories}
          onAdd={handleAdd}
          onClose={() => setShowQuickAdd(false)}
        />
      )}

      <Toast toasts={toasts} onRemove={removeToast} />

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onShowToast={showToast}
        />
      )}
    </div>
  )
}
