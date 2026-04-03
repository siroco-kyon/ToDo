export interface Category {
  id: string
  name: string
  color: string
  description: string
  sort_order: number
  created_at: string
}

export interface Todo {
  id: string
  title: string
  description: string
  memo: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  status: 'active' | 'done' | 'archived'
  priority: number
  progress: number
  start_date: string | null
  due_date: string | null
  sort_order: number
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface TodoDependency {
  id: string
  predecessor_todo_id: string
  successor_todo_id: string
  type: 'finish_to_start'
  lag_days: number
  created_at: string
}

export interface SubTask {
  id: string
  todo_id: string
  title: string
  description: string
  start_date: string | null
  due_date: string | null
  done: number  // 0 or 1
  completed_at: string | null
  sort_order: number
  created_at: string
}

export interface CalendarSubTask extends SubTask {
  todo_title: string
  todo_status: 'active' | 'done' | 'archived'
  category_color: string | null
}

export interface CreateSubTaskInput {
  title: string
  description?: string
  start_date?: string | null
  due_date?: string | null
}

export interface UpdateSubTaskInput {
  title?: string
  description?: string
  start_date?: string | null
  due_date?: string | null
  done?: boolean
}

export interface CreateTodoInput {
  title: string
  description?: string
  memo?: string
  category_id?: string | null
  priority?: number
  progress?: number
  start_date?: string | null
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
}

export interface UpdateTodoInput {
  title?: string
  description?: string
  memo?: string
  category_id?: string | null
  status?: 'active' | 'done' | 'archived'
  priority?: number
  progress?: number
  start_date?: string | null
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
}

export interface WorkLog {
  id: string
  todo_id: string
  start_time: string
  end_time: string
  duration_seconds: number
  note: string
  created_at: string
}

export interface RunningState {
  todo_id: string
  start_time: string
}

export interface WorkLogSummaryRow {
  id: string
  todo_id: string
  title: string
  category_name: string | null
  category_color: string | null
  start_time: string
  end_time: string
  duration_seconds: number
  note: string
}

export interface DailyPlanItem {
  id: string
  plan_date: string
  todo_id: string
  scheduled_start: string | null
  estimated_minutes: number | null
  lane: number
  sort_order: number
  created_at: string
  updated_at: string
  title: string
  description: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  status: 'active' | 'done' | 'archived'
  priority: number
  progress: number
  start_date: string | null
  due_date: string | null
}

export interface UpdateDailyPlanItemInput {
  scheduled_start?: string | null
  estimated_minutes?: number | null
  lane?: number
}

export type OverviewTaskReason = 'overdue' | 'dueSoon' | 'highPriority' | 'stale' | 'dueToday' | 'nearlyDone'

export interface OverviewSummary {
  totalTasks: number
  activeTasks: number
  doneTasks: number
  completionRate: number
  completionScore: number
  avgActiveProgress: number
  overdueTasks: number
  dueSoonTasks: number
  todayMinutes: number
  weekMinutes: number
  completedSubTasksThisWeek: number
}

export interface OverviewCategoryStat {
  categoryId: string | null
  categoryName: string
  categoryColor: string | null
  totalTasks: number
  activeTasks: number
  doneTasks: number
  overdueTasks: number
  completionRate: number
  completionScore: number
  avgActiveProgress: number
}

export interface OverviewTaskItem {
  todoId: string
  title: string
  categoryName: string | null
  categoryColor: string | null
  priority: number
  progress: number
  dueDate: string | null
  updatedAt: string
  reason: OverviewTaskReason
  subTaskDone: number
  subTaskTotal: number
}

export interface OverviewCompletedSubTaskItem {
  id: string
  todo_id: string
  title: string
  completed_at: string
  todo_title: string
  category_name: string | null
  category_color: string | null
}

export interface OverviewData {
  summary: OverviewSummary
  categories: OverviewCategoryStat[]
  risks: OverviewTaskItem[]
  dueToday: OverviewTaskItem[]
  highPriority: OverviewTaskItem[]
  nearlyDone: OverviewTaskItem[]
  stale: OverviewTaskItem[]
  completedSubTasks: OverviewCompletedSubTaskItem[]
}
