import { deleteTodo, getDb, getSetting } from './db'

export function runArchiveCleanup(): void {
  const db = getDb()
  let archivedCount = 0
  let workLogCount = 0

  // One transaction protects both a task's related data and the whole cleanup.
  db.transaction(() => {
    const retentionDays = parseInt(getSetting('archiveRetentionDays') ?? '90', 10)
    if (!isNaN(retentionDays) && retentionDays > 0) {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - retentionDays)
      const cutoffIso = cutoff.toISOString()

      const archived = db
        .prepare(`SELECT id FROM Todos WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?`)
        .all(cutoffIso) as { id: string }[]

      for (const { id } of archived) deleteTodo(id)
      archivedCount = archived.length
    }

    const wlDays = parseInt(getSetting('workLogRetentionDays') ?? '0', 10)
    if (!isNaN(wlDays) && wlDays > 0) {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - wlDays)
      workLogCount = db.prepare('DELETE FROM WorkLogs WHERE start_time < ?').run(cutoff.toISOString()).changes
    }
  })()

  if (archivedCount > 0) console.log(`アーカイブクリーンアップ: ${archivedCount}件削除`)
  if (workLogCount > 0) console.log(`作業ログクリーンアップ: ${workLogCount}件削除`)
}

/** Maintenance errors must leave the data intact and let the app open. */
export function runArchiveCleanupSafely(): string | null {
  try {
    runArchiveCleanup()
    return null
  } catch (error) {
    console.error('[HAKOBI] データ保持期間の整理に失敗しました', error)
    return `データ保持期間の整理を完了できませんでした。データは変更せず、アプリを起動します。\n${error instanceof Error ? error.message : '不明なエラー'}`
  }
}
