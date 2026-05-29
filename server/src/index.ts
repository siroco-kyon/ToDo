import http from 'http'
import path from 'path'
import fs from 'fs'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PORT, WEB_DIST_DIR } from './config'
import { initDb } from './db/connection'
import { attachUser, cleanupExpiredSessions, seedAdminUser } from './auth'
import { initRealtime } from './realtime'
import { authRouter } from './routes/auth'
import { dataRouter } from './routes/data'
import { usersRouter } from './routes/users'

initDb()
cleanupExpiredSessions()
seedAdminUser()

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())
app.use(attachUser)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.use('/api/auth', authRouter)
app.use('/api/users', usersRouter)
app.use('/api', dataRouter)

// Static web app (built separately into dist-web). Served when present.
if (fs.existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(WEB_DIST_DIR, 'index.html'))
  })
}

const server = http.createServer(app)
initRealtime(server)

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
  if (!fs.existsSync(WEB_DIST_DIR)) {
    console.log(`[server] web build not found at ${WEB_DIST_DIR} — run the web build to serve the UI`)
  }
})
