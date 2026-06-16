import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Category, CreateTodoInput, DailyPlanItem, PublicUser, Todo, UpdateDailyPlanItemInput, UpdateTodoInput } from './types'
import { useTimer } from './hooks/useTimer'
import { Toolbar } from './components/Toolbar'
import { CategoryList } from './components/CategoryList'
import { TodoList } from './components/TodoList'
import { TodoDetail } from './components/TodoDetail'
import { QuickAddModal } from './components/QuickAddModal'
import { Toast } from './components/Toast'
import type { ToastMessage } from './components/Toast'
import { SettingsModal } from './components/SettingsModal'
import { UserManagementModal } from './components/UserManagementModal'
import { ProgressReportModal } from './components/ProgressReportModal'
import { DesktopImportModal } from './components/DesktopImportModal'
import { WorkLogSummary } from './components/WorkLogSummary'
import { ProgressTimeline } from './components/ProgressTimeline'
import { SetupWizardModal } from './components/SetupWizardModal'
import { PlanView } from './components/PlanView'
import { TodayFlowRail } from './components/TodayFlowRail'
import { GanttView } from './components/GanttView'
import { TeamDashboard } from './components/TeamDashboard'

type SortField = 'created_at' | 'updated_at' | 'priority' | 'progress' | 'due_date' | 'title' | 'sort_order'
type CenterView = 'detail' | 'log' | 'progress' | 'plan' | 'gantt' | 'team'
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
  const [users, setUsers] = useState<PublicUser[]>([])
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null)
  const [showUserManagement, setShowUserManagement] = useState(false)
  const [showProgressReport, setShowProgressReport] = useState(false)
  const [showDesktopImport, setShowDesktopImport] = useState(false)
  const [showMySummary, setShowMySummary] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null)
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
  const [showCategoryPane, setShowCategoryPane] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('show-category-pane')
    return saved == null ? true : saved === 'true'
  })
  const [showTaskPane, setShowTaskPane] = useState<boolean>(() => {
    const saved = window.localStorage.getItem('show-task-pane')
    return saved == null ? true : saved === 'true'
  })
  const [assigneeDefaultApplied, setAssigneeDefaultApplied] = useState(false)
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

  const loadUsers = useCallback(async () => {
    const [allUsers, me] = await Promise.all([
      window.api.userList(),
      window.api.authGetCurrentUser()
    ])
    setUsers(allUsers)
    setCurrentUser(me)
  }, [])

  const loadInitialData = useCallback(async () => {
    const [allTodos, allCategories, planItems, allUsers, me] = await Promise.all([
      window.api.todoGetAll(),
      window.api.categoryGetAll(),
      window.api.dailyPlanGetByDate(getTodayKey()),
      window.api.userList(),
      window.api.authGetCurrentUser()
    ])
    setTodos(allTodos)
    setCategories(allCategories)
    setTodayPlanItems(planItems)
    setUsers(allUsers)
    setCurrentUser(me)
  }, [])

  const { isRunning, runningTodoId, elapsedSeconds, start, stop, restore } = useTimer(loadTodos)

  useEffect(() => {
    window.api.appIsFirstLaunch().then(setIsFirstLaunch)
  }, [])

  useEffect(() => {
    if (isFirstLaunch !== false) return

    let disposed = false
    window.api.settingsGet('themeMode').then((value) => {
      if (disposed) return
      if (value === 'dark' || value === 'light') setThemeMode(value)
    })
    return () => {
      disposed = true
    }
  }, [isFirstLaunch])

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
    window.localStorage.setItem('show-category-pane', String(showCategoryPane))
  }, [showCategoryPane])

  useEffect(() => {
    window.localStorage.setItem('show-task-pane', String(showTaskPane))
  }, [showTaskPane])

  useEffect(() => {
    if (assigneeDefaultApplied || !currentUser || users.length === 0) return
    setSelectedAssigneeId(currentUser.id)
    setAssigneeDefaultApplied(true)
  }, [assigneeDefaultApplied, currentUser, users.length])

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
  const multiUser = users.length > 0
  const isAdmin = currentUser?.role === 'admin'

  const filteredTodos = todos
    .filter((todo) => {
      if (!showArchived && todo.status === 'archived') return false
      if (selectedCategoryId && todo.category_id !== selectedCategoryId) return false
      if (selectedAssigneeId !== null) {
        if (selectedAssigneeId === '' && todo.assignee_id !== null) return false
        // 主担当またはサブ担当のどちらかに入っていれば表示する
        if (
          selectedAssigneeId !== '' &&
          todo.assignee_id !== selectedAssigneeId &&
          !(todo.co_assignees ?? []).some((coAssignee) => coAssignee.user_id === selectedAssigneeId)
        ) return false
      }

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
    setActiveView((prev) => prev === view ? 'detail' : view)
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
    const newStatus: Todo['status'] = todo.status === 'done'
      ? (todo.progress > 0 ? 'active' : 'not_started')
      : 'done'
    // 繰り返しタスクの次回分はDB層が完了時に自動生成する
    await window.api.todoUpdate(todo.id, { status: newStatus })

    if (newStatus === 'done' && todo.recurrence) {
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

  const standaloneSortOptions: { key: SortField; label: string }[] = [
    { key: 'sort_order', label: '手動' },
    { key: 'created_at', label: '作成日' },
    { key: 'updated_at', label: '更新日' },
    { key: 'priority', label: '優先度' },
    { key: 'progress', label: '進捗' },
    { key: 'due_date', label: '期限' },
    { key: 'title', label: 'タイトル' }
  ]

  if (isFirstLaunch === null) {
    return <div style={{ height: '100vh', background: '#0a0f1a' }} />
  }

  if (isFirstLaunch) {
    return <SetupWizardModal onComplete={handleSetupComplete} />
  }

  if (isStandaloneGanttWindow) {
    return (
      <div style={{ height: '100vh', overflow: 'hidden', background: '#0f172a', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flexShrink: 0, padding: '10px 12px', borderBottom: '1px solid #1e293b', background: '#0b1220', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="タスク検索"
            style={{ minWidth: 200, flex: '1 1 220px', padding: '7px 9px', background: '#0f172a', border: `1px solid ${searchQuery ? '#6366f1' : '#334155'}`, borderRadius: 7, color: '#e2e8f0', fontSize: '0.82rem', outline: 'none' }}
          />
          {multiUser && (
            <select
              value={selectedAssigneeId === null ? '__all__' : selectedAssigneeId === '' ? '__none__' : selectedAssigneeId}
              onChange={(e) => {
                const v = e.target.value
                setSelectedAssigneeId(v === '__all__' ? null : v === '__none__' ? '' : v)
              }}
              style={{ padding: '7px 9px', background: '#0f172a', border: `1px solid ${selectedAssigneeId !== null ? '#6366f1' : '#334155'}`, borderRadius: 7, color: '#e2e8f0', fontSize: '0.82rem', outline: 'none' }}
            >
              <option value="__all__">全員</option>
              <option value="__none__">未割り当て</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name}{user.is_active ? '' : ' (無効)'}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {standaloneSortOptions.map(({ key, label }) => {
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
                  style={{ padding: '6px 9px', borderRadius: 999, border: `1px solid ${active ? '#3b82f6' : '#334155'}`, background: active ? '#172554' : '#111827', color: active ? '#dbeafe' : '#94a3b8', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 700 }}
                >
                  {label}{active && key !== 'sort_order' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              )
            })}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <GanttView
            categories={categories}
            users={users}
            todos={filteredTodos}
            onSelectTodo={(id) => {
              void window.api.windowOpenTodo(id)
            }}
            onUpdateTodo={handleUpdate}
            onReorderTodos={handleReorder}
            standalone
          />
        </div>
        <Toast toasts={toasts} onRemove={removeToast} />
      </div>
    )
  }

  const isManualSort = sortField === 'sort_order'
  const showRightPlanRail = showPlanRail && activeView !== 'plan' && activeView !== 'team' && activeView !== 'progress'
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
        isTimerRunning={isRunning}
        onOpenQuickAdd={() => setShowQuickAdd(true)}
        onExportClipboard={handleExportClipboard}
        onExportFile={handleExportFile}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((prev) => !prev)}
        onOpenSettings={() => setShowSettings(true)}
        activeView={activeView}
        showPlanRail={showPlanRail}
        showCategoryPane={showCategoryPane}
        showTaskPane={showTaskPane}
        showTeamButton={multiUser}
        currentUser={currentUser}
        onLogout={multiUser ? () => void window.api.authLogout() : undefined}
        onToggleLogView={() => toggleCenterView('log')}
        onToggleProgressView={() => toggleCenterView('progress')}
        onTogglePlanView={() => toggleCenterView('plan')}
        onToggleGanttView={() => toggleCenterView('gantt')}
        onToggleTeamView={() => toggleCenterView('team')}
        onTogglePlanRail={() => setShowPlanRail((prev) => !prev)}
        onToggleCategoryPane={() => setShowCategoryPane((prev) => !prev)}
        onToggleTaskPane={() => setShowTaskPane((prev) => !prev)}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ width: paneWidths.category, flexShrink: 0, background: '#0a0f1a', borderRight: '1px solid #1e293b', overflow: 'hidden', display: showCategoryPane ? 'block' : 'none' }}>
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
          style={{ ...resizeHandleStyle, display: showCategoryPane ? 'block' : 'none' }}
        />

        <div style={{ width: paneWidths.list, flexShrink: 0, background: '#0d1525', borderRight: '1px solid #1e293b', overflow: 'hidden', display: showTaskPane ? 'flex' : 'none', flexDirection: 'column' }}>
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
            {multiUser && (
              <select
                value={selectedAssigneeId === null ? '__all__' : selectedAssigneeId === '' ? '__none__' : selectedAssigneeId}
                onChange={(e) => {
                  const v = e.target.value
                  setSelectedAssigneeId(v === '__all__' ? null : v === '__none__' ? '' : v)
                }}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '5px 8px',
                  background: '#0f172a',
                  border: `1px solid ${selectedAssigneeId !== null ? '#6366f1' : '#1e293b'}`,
                  borderRadius: 6,
                  color: selectedAssigneeId !== null ? '#e2e8f0' : '#94a3b8',
                  fontSize: '0.8rem',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              >
                <option value="__all__">担当者: 全員</option>
                <option value="__none__">担当者: 未割り当て</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    担当: {user.display_name}{user.is_active ? '' : '（無効）'}
                  </option>
                ))}
              </select>
            )}
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
          style={{ ...resizeHandleStyle, display: showTaskPane ? 'block' : 'none' }}
        />

        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: '#0f172a' }}>
          {activeView === 'gantt' ? (
            <GanttView
              categories={categories}
              users={users}
              todos={filteredTodos}
              onSelectTodo={openTodoDetail}
              onUpdateTodo={handleUpdate}
              onReorderTodos={handleReorder}
              onOpenSeparateWindow={handleOpenGanttWindow}
            />
          ) : activeView === 'plan' ? (
            <PlanView
              date={getTodayKey()}
              planItems={todayPlanItems}
              todos={filteredTodos}
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
          ) : activeView === 'progress' ? (
            <ProgressTimeline
              todos={filteredTodos}
              currentUser={currentUser}
              onSelectTodo={openTodoDetail}
              onShowToast={showToast}
            />
          ) : activeView === 'team' ? (
            <TeamDashboard onSelectTodo={openTodoDetail} />
          ) : (
            <TodoDetail
              todo={selectedTodo}
              allTodos={todos}
              categories={categories}
              users={users}
              currentUser={currentUser}
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
                        users={users}
                        currentUser={currentUser}
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
          users={users}
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
          canManageUsers={isAdmin}
          onManageUsers={() => { setShowSettings(false); setShowUserManagement(true) }}
          onProgressReport={isAdmin ? () => { setShowSettings(false); setShowProgressReport(true) } : undefined}
          onDesktopImport={isAdmin && multiUser ? () => { setShowSettings(false); setShowDesktopImport(true) } : undefined}
          onMySummary={() => { setShowSettings(false); setShowMySummary(true) }}
        />
      )}

      {showUserManagement && currentUser && (
        <UserManagementModal
          currentUserId={currentUser.id}
          onClose={() => setShowUserManagement(false)}
          onShowToast={showToast}
          onChanged={() => void loadUsers()}
        />
      )}

      {showProgressReport && isAdmin && multiUser && (
        <ProgressReportModal
          users={users}
          onClose={() => setShowProgressReport(false)}
          onShowToast={showToast}
        />
      )}

      {showDesktopImport && isAdmin && multiUser && (
        <DesktopImportModal
          users={users}
          onClose={() => setShowDesktopImport(false)}
          onShowToast={showToast}
        />
      )}

      {showMySummary && (
        <ProgressReportModal
          users={users}
          selfOnly
          currentUser={currentUser}
          onClose={() => setShowMySummary(false)}
          onShowToast={showToast}
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
