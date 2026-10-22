import { Router, type NextFunction, type Request, type Response } from 'express'
import { clickOnceFile, readClickOnceRelease } from '../clickonceRelease'

function notFound(res: Response): void {
  res.removeHeader('Content-Type')
  res.set('Cache-Control', 'no-store').status(404).json({ error: '見つかりません' })
}

/** Public status must be mounted before the authenticated /api data router. */
export function createClickOnceReleaseRouter(dir: string): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    next()
  })
  router.get('/', async (_req, res) => {
    const release = await readClickOnceRelease(dir)
    res.json(release ? { available: true, ...release, pageUrl: '/clickonce/' } : { available: false })
  })
  router.use((_req, res) => notFound(res))
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => notFound(res))
  return router
}

/** Serve only the ClickOnce publication files; never fall through to the SPA. */
export function createClickOnceRouter(dir: string): Router {
  const router = Router()
  router.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff')
    next()
  })
  router.get('*', async (req, res) => {
    let segments: string[]
    try {
      const pathname = req.path
      segments = pathname === '/' ? ['index.html'] : pathname.slice(1).split('/').map(decodeURIComponent)
    } catch {
      notFound(res)
      return
    }

    const rootFile = segments.length === 1 && ['index.html', 'HAKOBI.application', 'clickonce-release.json'].includes(segments[0])
    const payloadFile = segments.length >= 3 && segments[0] === 'Application Files' && /\.(?:deploy|manifest)$/.test(segments[segments.length - 1])
    if (!rootFile && !payloadFile) {
      notFound(res)
      return
    }
    const release = await readClickOnceRelease(dir)
    const file = release ? await clickOnceFile(dir, segments) : null
    if (!file) {
      notFound(res)
      return
    }
    // Keep relative manifest links in the landing page valid when /clickonce was entered without a slash.
    if (req.path === '/' && req.originalUrl.split('?')[0] === req.baseUrl) {
      res.set('Cache-Control', 'no-store').redirect(302, '/clickonce/')
      return
    }
    // Return only the public contract, even if extra properties were placed in the metadata file.
    if (segments.length === 1 && segments[0] === 'clickonce-release.json') {
      res.set('Cache-Control', 'no-store').json(release)
      return
    }
    const name = segments[segments.length - 1]
    const type = name.endsWith('.application') ? 'application/x-ms-application'
      : name.endsWith('.manifest') ? 'application/x-ms-manifest'
        : name.endsWith('.deploy') ? 'application/octet-stream' : 'text/html; charset=utf-8'
    res.sendFile(segments.join('/'), {
      root: dir,
      dotfiles: 'deny',
      cacheControl: false,
      headers: { 'Content-Type': type, 'Cache-Control': rootFile ? 'no-store' : 'no-cache' }
    }, (error?: Error & { status?: number }) => {
      if (!error) return
      if (res.headersSent) { res.destroy(); return }
      if (error.status === 412 || error.status === 416) { res.status(error.status).end(); return }
      notFound(res)
    })
  })
  router.use((_req, res) => notFound(res))
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => notFound(res))
  return router
}
