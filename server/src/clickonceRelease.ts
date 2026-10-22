import fs from 'node:fs/promises'
import path from 'node:path'

export const CLICKONCE_APPLICATION_URL = '/clickonce/HAKOBI.application'

export interface ClickOnceRelease {
  version: string
  applicationUrl: typeof CLICKONCE_APPLICATION_URL
  publishedAt: string
}

function isClickOnceVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) &&
    value.split('.').every((part) => Number(part) <= 65535)
}

/** The deployment manifest starts with its own identity; dependency identities must not match instead. */
function deploymentManifestVersion(xml: string): string | null {
  const source = xml.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*<\?xml\s[\s\S]*?\?>/, '').trim()
  // No DTDs/entities are needed by ClickOnce; never expand XML from a publication folder.
  if (/<!/.test(source)) return null
  const identity = source.match(/^<(?:[A-Za-z_][\w.-]*:)?assembly(?=[\s>])(?:"[^"]*"|'[^']*'|[^'">])*>\s*<(?:[A-Za-z_][\w.-]*:)?assemblyIdentity(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)\/?\s*>/)
  if (!identity) return null
  const attributes = [...identity[1].matchAll(/(?:^|\s)version\s*=\s*(?:"([^"]*)"|'([^']*)')(?=\s|\/?$)/g)]
  return attributes.length === 1 ? attributes[0][1] ?? attributes[0][2] : null
}

/** Resolve an existing regular file without following links anywhere inside the distribution folder. */
export async function clickOnceFile(dir: string, segments: string[]): Promise<string | null> {
  if (!segments.length || segments.some((part) =>
    !part || part.startsWith('.') || /[\\/:\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part)
  )) return null
  try {
    const root = await fs.lstat(dir)
    if (!root.isDirectory() || root.isSymbolicLink()) return null
    let current = dir
    for (let i = 0; i < segments.length; i += 1) {
      current = path.join(current, segments[i])
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) return null
      if (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()) return null
    }
    return current
  } catch {
    return null
  }
}

/** Read on each request so publishing a new manifest needs no server restart. */
export async function readClickOnceRelease(dir: string): Promise<ClickOnceRelease | null> {
  try {
    const [metadataFile, applicationFile] = await Promise.all([
      clickOnceFile(dir, ['clickonce-release.json']),
      clickOnceFile(dir, ['HAKOBI.application'])
    ])
    if (!metadataFile || !applicationFile) return null
    const [metadataStat, applicationStat] = await Promise.all([fs.stat(metadataFile), fs.stat(applicationFile)])
    if (metadataStat.size > 16 * 1024 || applicationStat.size === 0 || applicationStat.size > 2 * 1024 * 1024) return null
    const release: unknown = JSON.parse((await fs.readFile(metadataFile, 'utf8')).replace(/^\uFEFF/, ''))
    if (!release || typeof release !== 'object' || Array.isArray(release)) return null
    const data = release as Record<string, unknown>
    if (!isClickOnceVersion(data.version)) return null
    if (data.applicationUrl !== CLICKONCE_APPLICATION_URL) return null
    if (typeof data.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(data.publishedAt) || !Number.isFinite(Date.parse(data.publishedAt))) return null
    if (deploymentManifestVersion(await fs.readFile(applicationFile, 'utf8')) !== data.version) return null
    return { version: data.version, applicationUrl: CLICKONCE_APPLICATION_URL, publishedAt: data.publishedAt }
  } catch {
    return null
  }
}
