// The team server may offer the Windows installer of the HAKOBI desktop app.
// Members download and run it themselves; the app only points out a newer version.

export interface DesktopReleaseInfo {
  version: string
  fileName: string
  size: number
  sha256: string
  releaseDate: string | null
}

export interface DesktopReleaseStatus {
  release: DesktopReleaseInfo | null
  /** Why nothing is offered. The server tells only administrators. */
  reason: string | null
}

/** Desktop apps before 1.0.5 do not report their version. */
export const LAST_VERSION_WITHOUT_APP_VERSION = '1.0.4'

export const DESKTOP_DOWNLOAD_FILE_URL = '/api/desktop-release/download'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
const INSTALLER_PATTERN = /^HAKOBI-\d+\.\d+\.\d+-setup\.exe$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

function versionParts(value: unknown): number[] | null {
  const match = typeof value === 'string' ? VERSION_PATTERN.exec(value) : null
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

/** Compares x.y.z versions numerically (1.0.10 is newer than 1.0.9). Anything else gives null. */
export function compareVersions(a: string, b: string): number | null {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

export function installedDesktopVersion(context: { appVersion?: string } | null | undefined): string {
  const version = context?.appVersion
  return versionParts(version) ? version! : LAST_VERSION_WITHOUT_APP_VERSION
}

export function isNewerDesktopRelease(release: DesktopReleaseInfo | null, context: { appVersion?: string } | null | undefined): boolean {
  if (!release) return false
  const order = compareVersions(release.version, installedDesktopVersion(context))
  return order !== null && order > 0
}

/** 「後で」 hides this version and older ones (also after a rollback); a newer release shows the notice again. */
export function isDismissedDesktopRelease(release: DesktopReleaseInfo, dismissedVersion: string | null): boolean {
  if (!dismissedVersion) return false
  const order = compareVersions(release.version, dismissedVersion)
  return order !== null && order <= 0
}

function parseRelease(body: Record<string, unknown>): DesktopReleaseInfo | null {
  const { version, fileName, size, sha256, releaseDate } = body
  if (typeof version !== 'string' || !versionParts(version)) return null
  // The server only offers the installer named after its own version.
  if (typeof fileName !== 'string' || !INSTALLER_PATTERN.test(fileName) || fileName !== `HAKOBI-${version}-setup.exe`) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return null
  if (releaseDate !== undefined && releaseDate !== null && (typeof releaseDate !== 'string' || releaseDate.length > 100)) return null
  return { version, fileName, size, sha256: sha256.toLowerCase(), releaseDate: typeof releaseDate === 'string' ? releaseDate : null }
}

/**
 * Asks the team server which installer it offers. Returns null when the server cannot answer,
 * including servers older than this feature (they reply 401 or 404).
 */
export async function fetchDesktopRelease(signal?: AbortSignal): Promise<DesktopReleaseStatus | null> {
  let body: unknown
  try {
    const response = await fetch('/api/desktop-release', { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) return null
    body = await response.json()
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const status = body as Record<string, unknown>
  if (status.available !== true) return { release: null, reason: typeof status.reason === 'string' ? status.reason : null }
  // A malformed answer is treated as nothing to offer rather than shown to members.
  return { release: parseRelease(status), reason: null }
}

/** Built from the page's own origin, never from server data, so the link always stays on this team server. */
export function desktopDownloadPageUrl(): string {
  return new URL('/download', window.location.origin).href
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unit = 0
  // Windows Explorer counts in 1024s, so the size matches what members see after downloading.
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`
}
