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
  category_id: string | null
  category_name: string | null
  category_color: string | null
  status: 'active' | 'done' | 'archived'
  priority: number
  progress: number
  due_date: string | null
  sort_order: number
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface SubTask {
  id: string
  todo_id: string
  title: string
  done: number  // 0 or 1
  sort_order: number
  created_at: string
}

export interface CreateTodoInput {
  title: string
  description?: string
  category_id?: string | null
  priority?: number
  progress?: number
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
}

export interface UpdateTodoInput {
  title?: string
  description?: string
  category_id?: string | null
  status?: 'active' | 'done' | 'archived'
  priority?: number
  progress?: number
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
