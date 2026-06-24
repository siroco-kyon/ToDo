// ─── Users & auth ─────────────────────────────────────────────

export type UserRole = 'admin' | 'member'

export interface UserRecord {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: UserRole
  color: string
  is_active: number
  created_at: string
  updated_at: string
}

/** User as exposed to clients (never includes the password hash). */
export interface PublicUser {
  id: string
  username: string
  display_name: string
  role: UserRole
  color: string
  is_active: number
  created_at: string
  updated_at: string
}

export interface Session {
  token: string
  user_id: string
  created_at: string
  expires_at: string
}

// ─── User notifications ───────────────────────────────────────

export type NotificationType = 'progress_reply' | 'task_assigned'

export interface UserNotification {
  id: string
  user_id: string
  type: NotificationType
  actor_user_id: string | null
  actor_name: string | null
  actor_color: string | null
  todo_id: string | null
  todo_title: string | null
  progress_note_id: string | null
  progress_comment_id: string | null
  title: string
  body: string
  created_at: string
  read_at: string | null
}

// ─── Categories ───────────────────────────────────────────────

export interface Category {
  id: string
  name: string
  color: string
  description: string
  sort_order: number
  /** 1 のとき全体の集計（概要/チーム/進捗レポート）から除外する */
  is_private: number
  created_at: string
}

// ─── Todos ────────────────────────────────────────────────────

export type TodoStatus = 'not_started' | 'active' | 'done' | 'archived'

export interface Todo {
  id: string
  title: string
  description: string
  memo: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  created_by: string | null
  status: TodoStatus
  priority: number
  progress: number
  start_date: string | null
  due_date: string | null
  sort_order: number
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  /** 1 のとき、繰り返しの次回分にサブタスクを未完了状態で複製する */
  recurrence_copy_subtasks: number
  /** サブ担当（主担当 assignee_id とは別に複数登録できる）。取得系で付与される */
  co_assignees?: TodoCoAssignee[]
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
}

export interface TodoCoAssignee {
  user_id: string
  display_name: string
  color: string
}

export interface CreateTodoInput {
  title: string
  description?: string
  memo?: string
  category_id?: string | null
  assignee_id?: string | null
  /** 省略時は 'not_started'。カンバンの列からの追加でその列のステータスを指定する */
  status?: 'not_started' | 'active' | 'done'
  priority?: number
  progress?: number
  start_date?: string | null
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
  recurrence_copy_subtasks?: number
}

export interface UpdateTodoInput {
  title?: string
  description?: string
  memo?: string
  category_id?: string | null
  assignee_id?: string | null
  status?: TodoStatus
  priority?: number
  progress?: number
  start_date?: string | null
  due_date?: string | null
  recurrence?: 'daily' | 'weekly' | 'monthly' | null
  recurrence_copy_subtasks?: number
  /** 指定された場合、サブ担当をこのユーザーID群で置き換える */
  co_assignee_ids?: string[]
}

export interface TodoDependency {
  id: string
  predecessor_todo_id: string
  successor_todo_id: string
  type: 'finish_to_start'
  lag_days: number
  created_at: string
}

// ─── SubTasks ─────────────────────────────────────────────────

export interface SubTask {
  id: string
  todo_id: string
  title: string
  description: string
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  start_date: string | null
  due_date: string | null
  done: number
  completed_at: string | null
  sort_order: number
  created_at: string
}

export interface CalendarSubTask extends SubTask {
  todo_title: string
  todo_status: TodoStatus
  category_color: string | null
}

export interface CreateSubTaskInput {
  title: string
  description?: string
  assignee_id?: string | null
  start_date?: string | null
  due_date?: string | null
}

export interface UpdateSubTaskInput {
  title?: string
  description?: string
  assignee_id?: string | null
  start_date?: string | null
  due_date?: string | null
  done?: boolean
}

// ─── Timer & work logs ────────────────────────────────────────

export interface WorkLog {
  id: string
  todo_id: string
  user_id: string
  start_time: string
  end_time: string
  duration_seconds: number
  note: string
  created_at: string
}

export interface RunningState {
  user_id: string
  todo_id: string
  start_time: string
}

export interface TodayWorkLog extends WorkLog {
  title: string
  category: string | null
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

// ─── Daily plan ───────────────────────────────────────────────

export interface DailyPlanItem {
  id: string
  plan_date: string
  todo_id: string
  user_id: string
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
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  status: TodoStatus
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

// ─── Overview ─────────────────────────────────────────────────

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

// ─── Team dashboard ───────────────────────────────────────────

/** A teammate currently running a timer — "who is doing what right now". */
export interface TeamNowItem {
  user_id: string
  display_name: string
  user_color: string
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  start_time: string
  elapsed_seconds: number
}

export interface TeamDeadlineItem {
  todo_id: string
  title: string
  due_date: string
  status: TodoStatus
  priority: number
  progress: number
  category_name: string | null
  category_color: string | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  days_until_due: number
}

export interface TeamMemberWorkload {
  user_id: string
  display_name: string
  user_color: string
  active_tasks: number
  overdue_tasks: number
  today_minutes: number
}

export interface TeamDashboard {
  now: TeamNowItem[]
  overdue: TeamDeadlineItem[]
  dueSoon: TeamDeadlineItem[]
  workloads: TeamMemberWorkload[]
}

// ─── Progress notes & digest ──────────────────────────────────

/** A timestamped, authored progress note attached to a task. */
export interface ProgressNote {
  id: string
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  user_id: string | null
  author_name: string | null
  author_color: string | null
  body: string
  created_at: string
  updated_at: string
  comment_count: number
  comments: ProgressNoteComment[]
  reactions: ProgressNoteReaction[]
}

export interface ProgressNoteComment {
  id: string
  note_id: string
  parent_comment_id: string | null
  user_id: string | null
  author_name: string | null
  author_color: string | null
  body: string
  created_at: string
  updated_at: string
  replies: ProgressNoteComment[]
}

export interface ProgressNoteReaction {
  emoji: string
  count: number
  reacted_by_me: boolean
}

export interface ProgressDigestTodo {
  id: string
  title: string
  status: TodoStatus
  progress: number
  memo: string
  category_name: string | null
  category_color: string | null
  created_at: string
}

export interface ProgressDigestCompletedTodo {
  id: string
  title: string
  status: TodoStatus
  progress: number
  memo: string
  category_name: string | null
  category_color: string | null
  completed_at: string
}

export interface ProgressDigestSubTask {
  id: string
  title: string
  todo_id: string
  todo_title: string
  done: number
  created_at: string
}

export interface ProgressDigestNote {
  id: string
  todo_id: string
  todo_title: string
  body: string
  created_at: string
}

export interface ProgressDigestTaskChange {
  id: string
  todo_id: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  field: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

export interface ProgressDigestComment {
  id: string
  note_id: string
  todo_id: string
  todo_title: string
  parent_comment_id: string | null
  body: string
  created_at: string
}

/** One member's activity within the requested period. */
export interface ProgressDigestUser {
  user_id: string | null
  display_name: string
  color: string
  added_todos: ProgressDigestTodo[]
  completed_todos: ProgressDigestCompletedTodo[]
  added_subtasks: ProgressDigestSubTask[]
  task_changes: ProgressDigestTaskChange[]
  notes: ProgressDigestNote[]
  comments: ProgressDigestComment[]
  work_minutes: number
  work_log_count: number
}

export interface ProgressDigest {
  from: string
  to: string
  users: ProgressDigestUser[]
}

/** Period (inclusive YYYY-MM-DD) + optional member filter for the admin report. */
export interface ProgressDigestQuery {
  from: string
  to: string
  userIds?: string[]
  /** false のときプライベートカテゴリのタスク由来の集計を除外する（既定は含める） */
  includePrivate?: boolean
}
