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

export type TodoStatus = 'not_started' | 'active' | 'done' | 'archived'

export type UserRole = 'admin' | 'member'

/** A user as exposed to clients. Web-only; the Electron build returns an empty user list. */
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

/** Fields accepted when an admin creates a user. Web-only. */
export interface CreateUserInput {
  username: string
  display_name: string
  password: string
  role?: UserRole
  color?: string
}

/** Fields an admin may change on an existing user. Web-only. */
export interface UpdateUserInput {
  display_name?: string
  role?: UserRole
  color?: string
  is_active?: boolean
}

export type NotificationType = 'progress_reply' | 'task_assigned' | 'progress_reaction' | 'task_due' | 'mention'

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
  status: TodoStatus
  priority: number
  progress: number
  start_date: string | null
  due_date: string | null
  sort_order: number
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  /** 1 のとき、繰り返しの次回分にサブタスクを未完了状態で複製する */
  recurrence_copy_subtasks: number
  /** 1 のとき、繰り返しの次回分が土日に当たる場合は平日にずらす */
  recurrence_skip_weekends: number
  /** 1 のとき、繰り返しの次回分が日本の祝日に当たる場合はずらす */
  recurrence_skip_holidays: number
  /** サブ担当（サーバー版のみ。デスクトップ版では常に未設定） */
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
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  start_date: string | null
  due_date: string | null
  progress: number
  done: number  // 0 or 1
  completed_at: string | null
  sort_order: number
  created_at: string
  parent_due_date_extended_to?: string | null
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
  progress?: number
}

export interface UpdateSubTaskInput {
  title?: string
  description?: string
  assignee_id?: string | null
  start_date?: string | null
  due_date?: string | null
  progress?: number
  done?: boolean
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
  recurrence_skip_weekends?: number
  recurrence_skip_holidays?: number
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
  recurrence_skip_weekends?: number
  recurrence_skip_holidays?: number
  /** 指定された場合、サブ担当をこのユーザーID群で置き換える（サーバー版のみ有効） */
  co_assignee_ids?: string[]
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

/**
 * 計画への追加オプション。
 * allowDuplicate を指定しない限り、同じ日・同じタスクの既存行を返す（従来の挙動）。
 */
export interface AddDailyPlanItemOptions {
  allowDuplicate?: boolean
  scheduled_start?: string | null
  estimated_minutes?: number | null
  lane?: number
}

export type OverviewTaskReason = 'overdue' | 'dueSoon' | 'highPriority' | 'stale' | 'dueToday' | 'nearlyDone'

export interface OverviewQuery {
  /** undefined/null: 全員、空文字: 未割り当て、その他: 主担当またはサブ担当のユーザーID */
  assigneeId?: string | null
  /** false のときプライベートカテゴリを集計から除外する */
  includePrivate?: boolean
}

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
  assigneeId: string | null
  assigneeName: string | null
  assigneeColor: string | null
  coAssignees: TodoCoAssignee[]
}

export interface OverviewCompletedSubTaskItem {
  id: string
  todo_id: string
  title: string
  completed_at: string
  todo_title: string
  category_name: string | null
  category_color: string | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_color: string | null
  parent_assignee_id: string | null
  parent_assignee_name: string | null
  parent_assignee_color: string | null
  parent_co_assignees: TodoCoAssignee[]
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
  activityFrom: string
  activityTo: string
  memberActivity: ProgressDigestUser[]
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

/** A timestamped, authored progress note attached to a task. On desktop the author fields are null. */
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
  reactions: ProgressNoteReaction[]
}

export interface ProgressNoteReaction {
  emoji: string
  count: number
  reacted_by_me: boolean
  reactors: ProgressNoteReactionActor[]
}

export interface ProgressNoteReactionActor {
  user_id: string | null
  display_name: string
  color: string | null
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

/** One member's activity within the requested period. Desktop returns a single bucket. */
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

/** Period (inclusive YYYY-MM-DD) + optional member filter for the admin report. Web-only filter. */
export interface ProgressDigestQuery {
  from: string
  to: string
  userIds?: string[]
  /** false のときプライベートカテゴリのタスク由来の集計を除外する（既定は含める） */
  includePrivate?: boolean
}

/** デスクトップ版 todo.db をサーバー版へ取り込んだ結果の件数（サーバー版のみ） */
export interface DesktopImportResult {
  categories: number
  todos: number
  subTasks: number
  dependencies: number
  workLogs: number
  planItems: number
  skippedOrphans: number
  dryRun: boolean
}
