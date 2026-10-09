// The Web entry point calibrates this clock. The individual desktop mode keeps
// using the local clock because it never starts server synchronization.
let anchor: { time: number; monotonic: number } | null = null
const listeners = new Set<() => void>()

export function serverNow(): number {
  return anchor ? anchor.time + performance.now() - anchor.monotonic : Date.now()
}

export function serverClockOffset(): number {
  return serverNow() - Date.now()
}

export function subscribeServerClock(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Use a round-trip midpoint; keep ticking with a monotonic clock between samples. */
export async function syncServerClock(signal: AbortSignal): Promise<void> {
  const sent = performance.now()
  const response = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok) return
  const health = await response.json() as { time?: string }
  const received = performance.now()
  const time = Date.parse(health.time ?? '')
  if (signal.aborted || !Number.isFinite(time)) return
  anchor = { time: time + (received - sent) / 2, monotonic: received }
  listeners.forEach((listener) => listener())
}

/** One bounded request per sample, with cleanup for unmounts and StrictMode. */
export function startServerClockSync(): () => void {
  let controller: AbortController | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const sample = (): void => {
    if (disposed) return
    controller?.abort()
    if (timeout !== null) clearTimeout(timeout)
    const current = new AbortController()
    controller = current
    timeout = setTimeout(() => current.abort(), 5000)
    void syncServerClock(current.signal).catch(() => {
      // Task/auth requests report connectivity. Keep the last clock sample.
    }).finally(() => {
      if (controller === current) {
        if (timeout !== null) clearTimeout(timeout)
        timeout = null
        controller = null
      }
    })
  }
  const onFocus = (): void => { if (!disposed) sample() }
  sample()
  const interval = setInterval(sample, 30000)
  window.addEventListener('focus', onFocus)
  return () => {
    disposed = true
    clearInterval(interval)
    window.removeEventListener('focus', onFocus)
    controller?.abort()
    if (timeout !== null) clearTimeout(timeout)
  }
}
