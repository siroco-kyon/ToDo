import type { TaskReportRow } from '../components/ProgressReportModal'

export const TASK_REPORT_SNAPSHOT_KEY = 'task-report-snapshot'

export interface TaskReportSnapshot {
  version: 1
  from: string
  to: string
  showOnlyActiveTasks: boolean
  generatedAt: string
  rows: TaskReportRow[]
}

export function writeTaskReportSnapshot(snapshot: TaskReportSnapshot): void {
  window.localStorage.setItem(TASK_REPORT_SNAPSHOT_KEY, JSON.stringify(snapshot))
}

export function readTaskReportSnapshot(): TaskReportSnapshot | null {
  try {
    const raw = window.localStorage.getItem(TASK_REPORT_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TaskReportSnapshot
    return parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}
