export interface ClickOnceRelease {
  version: string
  applicationUrl: '/clickonce/HAKOBI.application'
  pageUrl: '/clickonce/'
}

/** A team connection can change without changing the ClickOnce update provider. */
export function canCheckClickOnceRelease(installUrl: string | undefined, origin: string): boolean {
  if (!installUrl) return false
  try { return new URL(installUrl).href === new URL('/clickonce/', origin).href } catch { return false }
}

function versionParts(value: unknown): number[] | null {
  if (typeof value !== 'string') return null
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535)
    ? parts.map(Number) : null
}

export function isNewerClickOnceVersion(candidate: unknown, installed: unknown): boolean {
  const next = versionParts(candidate)
  const current = versionParts(installed)
  if (!next || !current) return false
  for (let index = 0; index < 4; index++) {
    if (next[index] !== current[index]) return next[index] > current[index]
  }
  return false
}

/** Fixed same-origin URLs only. Older servers simply have no ClickOnce option. */
export async function fetchClickOnceRelease(signal?: AbortSignal): Promise<ClickOnceRelease | null> {
  try {
    const response = await fetch('/api/clickonce-release', { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) return null
    const body = await response.json()
    if (body?.available !== true || !versionParts(body.version) ||
      body.applicationUrl !== '/clickonce/HAKOBI.application' || body.pageUrl !== '/clickonce/') return null
    return { version: body.version, applicationUrl: '/clickonce/HAKOBI.application', pageUrl: '/clickonce/' }
  } catch {
    return null
  }
}
