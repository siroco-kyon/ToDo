import fs from 'fs'
import path from 'path'

export interface DesktopDistribution {
  distribution?: 'clickonce'
  clickOnceVersion?: string
  clickOnceInstallUrl?: string
}

/** Written into the packaged resources before ClickOnce generates its file hashes. */
export function readDesktopDistribution(resourcesDirectory: string): DesktopDistribution {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(resourcesDirectory, 'hakobi-distribution.json'), 'utf8'))
    if (marker?.distribution !== 'clickonce' || typeof marker.version !== 'string') return {}
    const parts = marker.version.split('.')
    if (parts.length !== 4 || !parts.every((part: string) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535)) return {}
    const result: DesktopDistribution = { distribution: 'clickonce', clickOnceVersion: marker.version }
    if (typeof marker.installUrl === 'string') {
      try {
        const url = new URL(marker.installUrl)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/')) {
          result.clickOnceInstallUrl = url.href
        }
      } catch { /* An older marker can still identify the installation without offering update notices. */ }
    }
    return result
  } catch {
    // Existing installers and development builds have no marker.
    return {}
  }
}
