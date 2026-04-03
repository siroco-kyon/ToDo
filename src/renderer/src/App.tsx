import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Category, CreateTodoInput, DailyPlanItem, Todo, UpdateDailyPlanItemInput, UpdateTodoInput } from './types'
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
import { PlanView } from './components/PlanView'
import { TodayFlowRail } from './components/TodayFlowRail'
import { GanttView } from './components/GanttView'

type SortField = 'created_at' | 'updated_at' | 'priority' | 'progress' | 'due_date' | 'title' | 'sort_order'
type CenterView = 'detail' | 'log' | 'plan' | 'gantt'
type GanttSidePanelMode = 'detail' | 'today'
type PaneKey = 'category' | 'list' | 'side'
type ThemeMode = 'dark' | 'light'

interface PaneWidths {
  category: number
  list: number
  side: number
}

const DEFAULT_PANE_WIDTHS: PaneWidths = {
  category: 168,
  list: 264,
  side: 360
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function loadPaneWidths(): PaneWidths {
  try {
    const raw = window.localStorage.getItem('app-pane-widths')
    if (!raw) return DEFAULT_PANE_WIDTHS
    const parsed = JSON.parse(raw) as Partial<PaneWidths>
    return {
      category: clamp(Number(parsed.category) || DEFAULT_PANE_WIDTHS.category, 132, 320),
      list: clamp(Number(parsed.list) || DEFAULT_PANE_WIDTHS.list, 220, 460),
      side: clamp(Number(parsed.side) || DEFAULT_PANE_WIDTHS.side, 280, 720)
    }
  } catch {
    return DEFAULT_PANE_WIDTHS
  }
}

function shiftRecurringDate(dateStr: string | null | undefined, recurrence: Todo['recurrence']): string | null {
  if (!dateStr || !recurrence) return null

  const next = new Date(dateStr)

  if (recurrence === 'daily') next.setDate(next.getDate() + 1)
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7)
  else if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1)

  return next.toISOString().slice(0, 10)
}

function getTodayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function App(): React.JSX.Element {
  const isStandaloneGanttWindow = window.location.hash === '#gantt-only'
  const [isFirstLaunch, setIsFirstLaunch] = useState<boolean | null>(null)
  const [todos, setTodos] = useState<Todo[]>([])
  const [todayPlanItems, setTodayPlanItems] = useState<DailyPlanItem[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [sortField, setSortField] = useState<SortField>('created_at')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [searchQuery, setSearchQuery] = useState('')
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem('app-theme-mode')
    return saved === 'light' ? 'light' : 'dark'
  })
  const [activeView, setActiveView] = useState<CenterView>(() => 'gantt')
  const [ganttSidePanelMode, setGanttSidePanelMode] = useState<GanttSidePanelMode>('today')
  const [showPlanRail, setShowPlanRail] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('show-plan-rail')
    return saved == null ? true : saved === 'true'
  })
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths())
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const toastIdRef = useRef(0)
  const resizeRef = useRef<{ key: PaneKey; startX: number; startWidth: number } | null>(null)

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, message, type }])
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const loadTodos = useCallback(async () => {
    const [allTodos, planItems] = await Promise.all([
      window.api.todoGetAll(),
      window.api.dailyPlanGetByDate(getTodayKey())
    ])
    setTodos(allTodos)
    setTodayPlanItems(planItems)
  }, [])

  const loadCategories = useCallback(async () => {
    const all = await window.api.categoryGetAll()
    setCategories(all)
  }, [])

  const loadInitialData = useCallback(async () => {
    const [allTodos, allCategories, planItems] = await Promise.all([
      window.api.todoGetAll(),
      window.api.categoryGetAll(),
      window.api.dailyPlanGetByDate(getTodayKey())
    ])
    setTodos(allTodos)
    setCategories(allCategories)
    setTodayPlanItems(planItems)
  }, [])

  const { isRunning, runningTodoId, elapsedSeconds, start, stop, restore } = useTimer(loadTodos)

  useEffect(() => {
    window.api.appIsFirstLaunch().then(setIsFirstLaunch)
  }, [])

  useEffect(() => {
    let disposed = false
    window.api.settingsGet('themeMode').then((value) => {
      if (disposed) return
      if (value === 'dark' || value === 'light') setThemeMode(value)
    })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onNavigateTodo((todoId) => {
      setSelectedTodoId(todoId)
      setActiveView('detail')
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    if (isFirstLaunch !== false) return

    const unsubscribe = window.api.onDataChanged(() => {
      void loadInitialData()
    })
    return () => unsubscribe()
  }, [isFirstLaunch, loadInitialData])

  useEffect(() => {
    window.localStorage.setItem('show-plan-rail', String(showPlanRail))
  }, [showPlanRail])

  useEffect(() => {
    window.localStorage.setItem('app-theme-mode', themeMode)
    if (themeMode === 'light') document.body.classList.add('theme-light')
    else document.body.classList.remove('theme-light')
  }, [themeMode])

  useEffect(() => {
    window.localStorage.setItem('app-pane-widths', JSON.stringify(paneWidths))
  }, [paneWidths])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const current = resizeRef.current
      if (!current) return

      const delta = event.clientX - current.startX
      setPaneWidths((previous) => {
        if (current.key === 'category') {
          return { ...previous, category: clamp(current.startWidth + delta, 132, 320) }
        }

        if (current.key === 'list') {
          return { ...previous, list: clamp(current.startWidth + delta, 220, 460) }
        }

        return { ...previous, side: clamp(current.startWidth - delta, 280, 720) }
      })
    }

    const stopResize = (): void => {
      resizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }
  }, [])

  const handleSetupComplete = useCallback(async () => {
    setIsFirstLaunch(false)
    await loadInitialData()
    const running = await window.api.timerGetRunning()
    if (running) restore(running)
  }, [loadInitialData, restore])

  useEffect(() => {
    if (isFirstLaunch !== false) return

    const init = async (): Promise<void> => {
      await loadInitialData()
      const running = await window.api.timerGetRunning()
      if (running) restore(running)
    }

    init()
  }, [isFirstLaunch, loadInitialData, restore])

  const handleExportClipboard = useCallback(async () => {
    const result = await window.api.markdownExport('clipboard')
    showToast(result.message, result.success ? 'success' : 'error')
  }, [showToast])

  const handleThemeModeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode)
    await window.api.settingsSet('themeMode', mode)
  }, [])

  useEffect(() => {
    const unsubQuickAdd = window.api.onShortcutQuickAdd(() => setShowQuickAdd(true))
    const unsubExport = window.api.onShortcutExport(() => handleExportClipboard())
    return () => {
      unsubQuickAdd()
      unsubExport()
    }
  }, [handleExportClipboard])

  const q = searchQuery.trim().toLowerCase()

  const filteredTodos = todos
    .filter((todo) => {
      if (!showArchived && todo.status === 'archived') return false
      if (selectedCategoryId && todo.category_id !== selectedCategoryId) return false

      if (q) {
        const hit = todo.title.toLowerCase().includes(q)
          || todo.description.toLowerCase().includes(q)
          || (todo.category_name?.toLowerCase().includes(q) ?? false)

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
        aVal = a.title.toLowerCase()
        bVal = b.title.toLowerCase()
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

  const selectedTodo = todos.find((todo) => todo.id === selectedTodoId) ?? null

  const toggleCenterView = useCallback((view: CenterView) => {
    setActiveView((prev) => prev === view ? (view === 'gantt' ? 'gantt' : 'detail') : view)
    if (view === 'gantt') setGanttSidePanelMode('today')
  }, [])

  const openTodoDetail = useCallback((id: string) => {
    setSelectedTodoId(id)
    if (activeView === 'gantt') {
      setGanttSidePanelMode('detail')
      return
    }
    setActiveView('detail')
  }, [activeView])

  const beginResize = useCallback((key: PaneKey, startWidth: number, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeRef.current = { key, startX: event.clientX, startWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const hideGanttSidePanel = useCallback(() => {
    setGanttSidePanelMode('today')
    setShowPlanRail(false)
  }, [])

  const handleAdd = useCallback(async (data: CreateTodoInput) => {
    await window.api.todoCreate(data)
    await loadTodos()
  }, [loadTodos])

  const handleUpdate = useCallback(async (id: string, data: UpdateTodoInput) => {
    await window.api.todoUpdate(id, data)
    await loadTodos()
  }, [loadTodos])

  const handleOpenGanttWindow = useCallback(async () => {
    await window.api.windowOpenGantt()
  }, [])

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

    if (newStatus === 'done' && todo.recurrence) {
      const nextStartDate = shiftRecurringDate(todo.start_date, todo.recurrence)
      const nextDue = shiftRecurringDate(todo.due_date, todo.recurrence)
      await window.api.todoCreate({
        title: todo.title,
        description: todo.description,
        memo: todo.memo,
        category_id: todo.category_id,
        priority: todo.priority,
        start_date: nextStartDate,
        due_date: nextDue,
        recurrence: todo.recurrence
      })
      const recurrenceLabel = todo.recurrence === 'daily' ? '毎日' : todo.recurrence === 'weekly' ? '毎週' : '毎月'
      showToast(`${recurrenceLabel}タスクを次回分として作成しました`)
    }

    await loadTodos()
  }, [loadTodos, showToast])

  const handleCategoryAdd = useCallback(async (name: string, color: string) => {
    await window.api.categoryCreate(name, color)
    await loadCategories()
  }, [loadCategories])

  const handleCategoryUpdate = useCallback(async (id: string, name: string, color: string, description: string) => {
    await window.api.categoryUpdate(id, name, color, description)
    await loadCategories()
  }, [loadCategories])

  const handleCategoryDelete = useCallback(async (id: string) => {
    await window.api.categoryDelete(id)
    await loadCategories()
    if (selectedCategoryId === id) setSelectedCategoryId(null)
    await loadTodos()
  }, [selectedCategoryId, loadCategories, loadTodos])

  const handleCategoryReorder = useCallback(async (orderedIds: string[]) => {
    await window.api.categoryReorder(orderedIds)
    await loadCategories()
  }, [loadCategories])

  const handleExportFile = useCallback(async () => {
    const result = await window.api.markdownExport('file')
    showToast(result.message, result.success ? 'success' : 'error')
  }, [showToast])

  const handleReorder = useCallback(async (orderedIds: string[]) => {
    await window.api.todoReorder(orderedIds)
    await loadTodos()
  }, [loadTodos])

  const handleAddToTodayPlan = useCallback(async (todoId: string) => {
    const planItem = await window.api.dailyPlanAdd(getTodayKey(), todoId)
    await loadTodos()
    showToast('今日の計画に追加しました')
    return planItem
  }, [loadTodos, showToast])

  const handleUpdateTodayPlanItem = useCallback(async (id: string, data: UpdateDailyPlanItemInput) => {
    await window.api.dailyPlanUpdate(id, data)
    await loadTodos()
  }, [loadTodos])

  const handleShiftTodayPlanItem = useCallback(async (id: string, deltaMinutes: number) => {
    await window.api.dailyPlanShift(id, deltaMinutes)
    await loadTodos()
  }, [loadTodos])

  const handleRemoveTodayPlanItem = useCallback(async (id: string) => {
    await window.api.dailyPlanDelete(id)
    await loadTodos()
    showToast('今日の計画から外しました')
  }, [loadTodos, showToast])

  const handleReorderTodayPlan = useCallback(async (orderedIds: string[]) => {
    await window.api.dailyPlanReorder(getTodayKey(), orderedIds)
    await loadTodos()
  }, [loadTodos])

  if (isFirstLaunch === null) {
    return <div style={{ height: '100vh', background: '#0a0f1a' }} />
  }

  if (isFirstLaunch) {
    return <SetupWizardModal onComplete={handleSetupComplete} />
  }

  if (isStandaloneGanttWindow) {
    return (
      <div style={{ height: '100vh', overflow: 'hidden', background: '#0f172a' }}>
        <GanttView
          categories={categories}
          todos={filteredTodos}
          onSelectTodo={(id) => {
            void window.api.windowOpenTodo(id)
          }}
          onUpdateTodo={handleUpdate}
          standalone
        />
        <Toast toasts={toasts} onRemove={removeToast} />
      </div>
    )
  }

  const isManualSort = sortField === 'sort_order'
  const showRightPlanRail = showPlanRail && activeView !== 'plan'
  const showGanttSidePanel = activeView === 'gantt' && (ganttSidePanelMode === 'detail' || showPlanRail)
  const showAuxiliaryPanel = activeView === 'gantt' ? showGanttSidePanel : showRightPlanRail
  const SORT_FIELDS: { key: SortField; label: string }[] = [
    { key: 'sort_order', label: '手動' },
    { key: 'created_at', label: '作成日' },
    { key: 'updated_at', label: '更新日' },
    { key: 'priority', label: '優先度' },
    { key: 'progress', label: '進捗' },
    { key: 'due_date', label: '期限' },
    { key: 'title', label: 'タイトル' }
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
        onToggleArchived={() => setShowArchived((prev) => !prev)}
        onOpenSettings={() => setShowSettings(true)}
        activeView={activeView}
        showPlanRail={showPlanRail}
        onToggleLogView={() => toggleCenterView('log')}
        onTogglePlanView={() => toggleCenterView('plan')}
        onToggleGanttView={() => toggleCenterView('gantt')}
        onTogglePlanRail={() => setShowPlanRail((prev) => !prev)}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ width: paneWidths.category, flexShrink: 0, background: '#0a0f1a', borderRight: '1px solid #1e293b', overflow: 'hidden' }}>
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

        <div
          onPointerDown={(event) => beginResize('category', paneWidths.category, event)}
          style={resizeHandleStyle}
        />

        <div style={{ width: paneWidths.list, flexShrink: 0, background: '#0d1525', borderRight: '1px solid #1e293b', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #1e293b' }}>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="タスク名・メモ・カテゴリで検索..."
              style={{
                width: '100%',
                padding: '5px 8px',
                background: '#0f172a',
                border: `1px solid ${searchQuery ? '#6366f1' : '#1e293b'}`,
                borderRadius: 6,
                color: '#e2e8f0',
                fontSize: '0.8rem',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ padding: '5px 8px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            {SORT_FIELDS.map(({ key, label }) => {
              const active = sortField === key

              return (
                <button
                  key={key}
                  onClick={() => {
                    if (key === 'sort_order') {
                      setSortField('sort_order')
                      return
                    }

                    if (active) setSortDir((prev) => prev === 'asc' ? 'desc' : 'asc')
                    else {
                      setSortField(key)
                      setSortDir('desc')
                    }
                  }}
                  style={{
                    fontSize: '0.68rem',
                    padding: '2px 6px',
                    borderRadius: 99,
                    background: active ? '#6366f120' : 'transparent',
                    border: `1px solid ${active ? '#6366f1' : '#1e293b'}`,
                    color: active ? '#818cf8' : '#475569',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {label}
                  {active && key !== 'sort_order' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
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
              onSelect={openTodoDetail}
              onToggleDone={handleToggleDone}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onDelete={handleDelete}
              onReorder={handleReorder}
            />
          </div>
        </div>

        <div
          onPointerDown={(event) => beginResize('list', paneWidths.list, event)}
          style={resizeHandleStyle}
        />

        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: '#0f172a' }}>
          {activeView === 'gantt' ? (
            <GanttView
              categories={categories}
              todos={filteredTodos}
              onSelectTodo={openTodoDetail}
              onUpdateTodo={handleUpdate}
              onOpenSeparateWindow={handleOpenGanttWindow}
            />
          ) : activeView === 'plan' ? (
            <PlanView
              date={getTodayKey()}
              planItems={todayPlanItems}
              todos={todos}
              runningTodoId={runningTodoId}
              onSelectTodo={openTodoDetail}
              onAddTodo={handleAddToTodayPlan}
              onRemoveItem={handleRemoveTodayPlanItem}
              onUpdateItem={handleUpdateTodayPlanItem}
              onShiftItem={handleShiftTodayPlanItem}
              onReorder={handleReorderTodayPlan}
            />
          ) : activeView === 'log' ? (
            <WorkLogSummary />
          ) : (
            <TodoDetail
              todo={selectedTodo}
              allTodos={todos}
              categories={categories}
              todayPlanItems={todayPlanItems}
              runningTodoId={runningTodoId}
              elapsedSeconds={elapsedSeconds}
              onUpdate={handleUpdate}
              onStartTimer={start}
              onStopTimer={stop}
              onAddToTodayPlan={handleAddToTodayPlan}
              onShowToast={showToast}
            />
          )}
        </div>

        {showAuxiliaryPanel && (
          <>
            <div
              onPointerDown={(event) => beginResize('side', paneWidths.side, event)}
              style={resizeHandleStyle}
            />

            <div style={{ width: paneWidths.side, flexShrink: 0, borderLeft: '1px solid #1e293b', background: '#0b1220', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {activeView === 'gantt' ? (
                <>
                  <div style={{ padding: '10px 12px', borderBottom: '1px solid #1e293b', background: '#0b1220', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setGanttSidePanelMode('detail')}
                        style={sideTabButtonStyle(ganttSidePanelMode === 'detail')}
                      >
                        詳細
                      </button>
                      <button
                        onClick={() => {
                          setGanttSidePanelMode('today')
                          if (!showPlanRail) setShowPlanRail(true)
                        }}
                        style={sideTabButtonStyle(ganttSidePanelMode === 'today')}
                      >
                        今日
                      </button>
                    </div>

                    <button onClick={hideGanttSidePanel} style={auxButtonStyle(true)}>
                      隠す
                    </button>
                  </div>

                  <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    {ganttSidePanelMode === 'detail' ? (
                      <TodoDetail
                        todo={selectedTodo}
                        allTodos={todos}
                        categories={categories}
                        todayPlanItems={todayPlanItems}
                        runningTodoId={runningTodoId}
                        elapsedSeconds={elapsedSeconds}
                        onUpdate={handleUpdate}
                        onStartTimer={start}
                        onStopTimer={stop}
                        onAddToTodayPlan={handleAddToTodayPlan}
                        onShowToast={showToast}
                      />
                    ) : (
                      <TodayFlowRail
                        date={getTodayKey()}
                        planItems={todayPlanItems}
                        runningTodoId={runningTodoId}
                        onSelectTodo={openTodoDetail}
                        onOpenPlan={() => setActiveView('plan')}
                      />
                    )}
                  </div>
                </>
              ) : (
                <TodayFlowRail
                  date={getTodayKey()}
                  planItems={todayPlanItems}
                  runningTodoId={runningTodoId}
                  onSelectTodo={openTodoDetail}
                  onOpenPlan={() => setActiveView('plan')}
                />
              )}
            </div>
          </>
        )}
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
          themeMode={themeMode}
          onThemeChange={handleThemeModeChange}
        />
      )}
    </div>
  )
}

const resizeHandleStyle: React.CSSProperties = {
  width: 6,
  flexShrink: 0,
  cursor: 'col-resize',
  background: 'linear-gradient(to right, transparent 0, transparent 2px, #162033 2px, #162033 4px, transparent 4px)',
  opacity: 0.8
}

function sideTabButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? '#2563eb' : '#334155'}`,
    background: active ? '#1d4ed8' : '#111827',
    color: active ? '#eff6ff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.76rem',
    fontWeight: 700
  }
}

function auxButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${active ? '#2563eb' : '#334155'}`,
    background: active ? '#172554' : '#111827',
    color: active ? '#dbeafe' : '#94a3b8',
    cursor: 'pointer',
    fontSize: '0.74rem',
    fontWeight: 700
  }
}
