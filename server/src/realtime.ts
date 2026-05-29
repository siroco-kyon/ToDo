import type { IncomingMessage, Server } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { getSessionUser } from './auth'
import { SESSION_COOKIE } from './config'
import type { PublicUser } from './db/types'

interface Client {
  socket: WebSocket
  user: PublicUser
}

const clients = new Set<Client>()
let wss: WebSocketServer | null = null

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

function authenticate(req: IncomingMessage): PublicUser | null {
  const cookies = parseCookies(req.headers.cookie)
  return getSessionUser(cookies[SESSION_COOKIE])
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

export function getOnlineUserIds(): string[] {
  return [...new Set([...clients].map((c) => c.user.id))]
}

function broadcastPresence(): void {
  const online = getOnlineUserIds()
  for (const client of clients) {
    send(client.socket, { type: 'presence', online })
  }
}

export type DataScope = 'category' | 'todo' | 'subtask' | 'plan'

/** Mirror of the desktop app's `data:changed` IPC signal: tells every client to refetch. */
export function broadcastDataChanged(scope: DataScope): void {
  for (const client of clients) {
    send(client.socket, { type: 'data:changed', scope })
  }
}

type AuthedRequest = IncomingMessage & { user?: PublicUser }

export function initRealtime(server: Server): void {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, cb) => {
      const user = authenticate(req)
      if (!user) {
        cb(false, 401, 'unauthorized')
        return
      }
      ;(req as AuthedRequest).user = user
      cb(true)
    }
  })

  wss.on('connection', (socket, req: AuthedRequest) => {
    const user = req.user
    if (!user) {
      socket.close(4401, 'unauthorized')
      return
    }

    const client: Client = { socket, user }
    clients.add(client)
    send(socket, { type: 'hello', user })
    broadcastPresence()

    socket.on('close', () => {
      clients.delete(client)
      broadcastPresence()
    })
    socket.on('error', () => {
      clients.delete(client)
    })
  })
}
