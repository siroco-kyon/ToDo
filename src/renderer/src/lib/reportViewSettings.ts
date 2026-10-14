// 報告タブの「表示設定」。定例の司会と各メンバーで見たいものが違うので、見ている人ごとに保存する。
// 共有PCで次の人に引き継がれないよう、保存キーにユーザーIDを含める。

export type ReportStatusKey = 'not_started' | 'active' | 'on_hold' | 'doneInPeriod' | 'doneBeforePeriod'
/** all: すべて / scheduled: 日程が期間にかかるもの / activity: 期間中に動きがあったもの */
export type ReportScope = 'all' | 'scheduled' | 'activity'
/** collapseOldDone: 期間前に完了したものは畳む / openOnly: 完了済みは畳む / hide: すべて畳む */
export type ReportSubTaskMode = 'collapseOldDone' | 'openOnly' | 'hide'

export interface ReportViewSettings {
  /** 出さないカテゴリ（未分類は ''）。新しく作ったカテゴリが出るように「出さない側」を持つ */
  hiddenCategoryKeys: string[]
  statuses: Record<ReportStatusKey, boolean>
  scope: ReportScope
  subTaskMode: ReportSubTaskMode
  /** カードの「隠す」で報告に出さないことにしたタスク */
  hiddenTodoIds: string[]
  /** 担当者別の中をカテゴリで、カテゴリ別の中を担当者で分ける */
  splitSubGroups: boolean
  /** 畳んだ小見出し（'category:<id>' / 'assignee:<id>'。未分類・未割り当ては id が空）。全員の同じ小見出しに効く */
  collapsedSubGroupKeys: string[]
}

export const REPORT_STATUS_OPTIONS: Array<{ key: ReportStatusKey; label: string; title: string }> = [
  { key: 'not_started', label: '未着手', title: '未着手のタスク' },
  { key: 'active', label: '進行中', title: '進行中のタスク' },
  { key: 'on_hold', label: '保留中', title: '保留中のタスク' },
  { key: 'doneInPeriod', label: '完了（期間に入ってから）', title: '期間の開始日以降に完了したタスク' },
  { key: 'doneBeforePeriod', label: '完了（期間より前）', title: '期間が始まる前に完了したタスク' }
]

export const REPORT_SCOPE_OPTIONS: Array<{ value: ReportScope; label: string; title: string }> = [
  { value: 'all', label: 'すべて', title: '状態とカテゴリの条件に合うタスクをすべて出します' },
  { value: 'scheduled', label: '日程が期間にかかるもの', title: '開始日〜期限が報告期間と重なるタスクだけ。期限を過ぎて完了していないものは今日まで続いているとみなします' },
  { value: 'activity', label: '期間中に動きがあったもの', title: '期間中に進捗ログ・メモ・進捗や期限の変更・サブタスクの追加や変更・完了・作成があったタスクと、要相談のタスクだけ' }
]

export const REPORT_SUBTASK_OPTIONS: Array<{ value: ReportSubTaskMode; label: string }> = [
  { value: 'collapseOldDone', label: '期間前に完了したものは畳む' },
  { value: 'openOnly', label: '完了済みは畳む' },
  { value: 'hide', label: 'すべて畳む（件数だけ）' }
]

export const DEFAULT_REPORT_VIEW_SETTINGS: ReportViewSettings = {
  hiddenCategoryKeys: [],
  statuses: { not_started: true, active: true, on_hold: true, doneInPeriod: true, doneBeforePeriod: false },
  scope: 'all',
  subTaskMode: 'collapseOldDone',
  hiddenTodoIds: [],
  splitSubGroups: true,
  collapsedSubGroupKeys: []
}

/** 隠したタスクが際限なく貯まらないようにする上限（古いものから捨てる） */
const MAX_HIDDEN_TODOS = 500

function storageKey(userId: string | null): string {
  return `report.viewSettings:${userId ?? 'local'}`
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

export function loadReportViewSettings(userId: string | null): ReportViewSettings {
  let raw: unknown = null
  try {
    const stored = window.localStorage.getItem(storageKey(userId))
    raw = stored ? JSON.parse(stored) : null
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object') {
    // 以前の「期間前に完了したタスクも表示」は保存していなかったので、引き継ぐものはない
    return { ...DEFAULT_REPORT_VIEW_SETTINGS, statuses: { ...DEFAULT_REPORT_VIEW_SETTINGS.statuses } }
  }
  const data = raw as Record<string, unknown>
  const storedStatuses = (data.statuses && typeof data.statuses === 'object' ? data.statuses : {}) as Record<string, unknown>
  const statuses = { ...DEFAULT_REPORT_VIEW_SETTINGS.statuses }
  for (const option of REPORT_STATUS_OPTIONS) {
    if (typeof storedStatuses[option.key] === 'boolean') statuses[option.key] = storedStatuses[option.key] as boolean
  }
  return {
    hiddenCategoryKeys: stringArray(data.hiddenCategoryKeys),
    statuses,
    scope: pick(data.scope, REPORT_SCOPE_OPTIONS.map((option) => option.value), DEFAULT_REPORT_VIEW_SETTINGS.scope),
    subTaskMode: pick(data.subTaskMode, REPORT_SUBTASK_OPTIONS.map((option) => option.value), DEFAULT_REPORT_VIEW_SETTINGS.subTaskMode),
    hiddenTodoIds: stringArray(data.hiddenTodoIds).slice(-MAX_HIDDEN_TODOS),
    splitSubGroups: typeof data.splitSubGroups === 'boolean' ? data.splitSubGroups : DEFAULT_REPORT_VIEW_SETTINGS.splitSubGroups,
    collapsedSubGroupKeys: stringArray(data.collapsedSubGroupKeys)
  }
}

export function saveReportViewSettings(userId: string | null, settings: ReportViewSettings): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify({
      ...settings,
      hiddenTodoIds: settings.hiddenTodoIds.slice(-MAX_HIDDEN_TODOS)
    }))
  } catch {
    // localStorage が使えない環境では記憶しない
  }
}

export function statusesAreDefault(statuses: Record<ReportStatusKey, boolean>): boolean {
  return REPORT_STATUS_OPTIONS.every((option) => statuses[option.key] === DEFAULT_REPORT_VIEW_SETTINGS.statuses[option.key])
}
