import http from 'http'
import path from 'path'
import fs from 'fs'
import express from 'express'
import cookieParser from 'cookie-parser'
import { DESKTOP_DIST_DIR, PORT, WEB_DIST_DIR } from './config'
import { initDb } from './db/connection'
import { attachUser, cleanupExpiredSessions, seedAdminUser } from './auth'
import { broadcastDataChanged, initRealtime } from './realtime'
import { resetRecurringSubTasks } from './db/subtasks'
import { toLocalDateKey } from './shared/recurring-period'
import { authRouter } from './routes/auth'
import { dataRouter } from './routes/data'
import { createDesktopReleaseRouter } from './routes/desktopRelease'
import { usersRouter } from './routes/users'

initDb()
cleanupExpiredSessions()
seedAdminUser()

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())
app.use(attachUser)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), desktopProtocol: 1,
    webReady: fs.existsSync(path.join(WEB_DIST_DIR, 'index.html')) })
})

// デスクトップ版インストーラーの配布はログイン不要。認証が必要な dataRouter（/api 以下すべて）より前に置く。
app.use('/api/desktop-release', createDesktopReleaseRouter(DESKTOP_DIST_DIR))

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

// ToDoリストの繰り返しの項目は、日付が変わったら未チェックに戻して各画面に取り直してもらう
let lastDayKey = toLocalDateKey(new Date())
setInterval(() => {
  const dayKey = toLocalDateKey(new Date())
  if (dayKey === lastDayKey) return
  lastDayKey = dayKey
  try {
    resetRecurringSubTasks()
    broadcastDataChanged('subtask')
  } catch (error) {
    console.error('[server] ToDoリストの項目を未チェックに戻せませんでした', error)
  }
}, 60 * 1000)

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
  if (!fs.existsSync(WEB_DIST_DIR)) {
    console.log(`[server] web build not found at ${WEB_DIST_DIR} — run the web build to serve the UI`)
  }
  const desktopDist = fs.existsSync(DESKTOP_DIST_DIR) ? 'あり' : 'なし。npm run publish:desktop で作成されます'
  console.log(`[server] デスクトップ版の配布フォルダ: ${DESKTOP_DIST_DIR}（${desktopDist}）`)
})
