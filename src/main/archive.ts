import { getDb, getSetting } from './db'

export function runArchiveCleanup(): void {
  const db = getDb()

  // アーカイブTodo保持期間
  const retentionDays = parseInt(getSetting('archiveRetentionDays') ?? '90', 10)
  if (!isNaN(retentionDays) && retentionDays >= 0) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)
    const cutoffIso = cutoff.toISOString()

    const archived = db
      .prepare(
        `SELECT id FROM Todos WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?`
      )
      .all(cutoffIso) as { id: string }[]

    for (const { id } of archived) {
      db.prepare('DELETE FROM WorkLogs WHERE todo_id = ?').run(id)
      db.prepare('DELETE FROM Todos WHERE id = ?').run(id)
    }

    if (archived.length > 0) {
      console.log(`アーカイブクリーンアップ: ${archived.length}件削除`)
    }
  }

  // 作業ログ保持期間
  const wlDays = parseInt(getSetting('workLogRetentionDays') ?? '0', 10)
  if (!isNaN(wlDays) && wlDays > 0) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - wlDays)
    const result = db
      .prepare('DELETE FROM WorkLogs WHERE start_time < ?')
      .run(cutoff.toISOString())
    if (result.changes > 0) {
      console.log(`作業ログクリーンアップ: ${result.changes}件削除`)
    }
  }
}
