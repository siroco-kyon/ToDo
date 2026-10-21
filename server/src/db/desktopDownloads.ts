import { getDb } from './connection'
import { toLocalDateKey } from '../shared/recurring-period'

export interface DesktopDownloadStat {
  version: string
  downloadCount: number
}

/** Only aggregate counts are stored; no user, IP or device information. */
export function recordDesktopDownload(version: string): void {
  getDb().prepare(`
    INSERT INTO DesktopDownloadCounts (version, download_date, download_count) VALUES (?, ?, 1)
    ON CONFLICT (version, download_date) DO UPDATE SET download_count = download_count + 1
  `).run(version, toLocalDateKey(new Date()))
}

export function getDesktopDownloadStats(): DesktopDownloadStat[] {
  const rows = getDb().prepare(`
    SELECT version, SUM(download_count) AS downloadCount
    FROM DesktopDownloadCounts GROUP BY version
  `).all() as DesktopDownloadStat[]
  return rows.sort((a, b) => {
    const left = a.version.split('.').map(Number)
    const right = b.version.split('.').map(Number)
    for (let index = 0; index < 3; index++) {
      if (left[index] !== right[index]) return right[index] - left[index]
    }
    return 0
  })
}
