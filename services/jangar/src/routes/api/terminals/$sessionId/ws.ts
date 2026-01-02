import { createFileRoute } from '@tanstack/react-router'
import { defineWebSocket } from 'h3'

import { type TailerPeer, TerminalLogTailer } from '~/server/terminal-log-tailer'
import {
  captureTerminalSnapshot,
  ensureTerminalLogPipe,
  ensureTerminalSessionExists,
  formatSessionId,
  getTerminalSession,
  isTerminalSessionId,
  markTerminalSessionError,
  queueTerminalInput,
  resizeTerminalSession,
} from '~/server/terminals'

type PeerState = {
  sessionId: string
  closed: boolean
  tailerPeer: TailerPeer | null
}

type WebSocketPeer = {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  context?: { sessionId?: string }
  request?: Request | { url?: string } | null
}

type WebSocketMessage = {
  json: () => unknown
  text: () => string
}

type WebSocketUpgradeRequest = {
  url: string
  headers: Headers
  context?: Record<string, unknown>
}

export const Route = createFileRoute('/api/terminals/$sessionId/ws')({
  server: {
    handlers: {
      GET: () => websocketResponse(),
    },
  },
})

const peerState = new WeakMap<object, PeerState>()
const sessionTailers = new Map<string, TerminalLogTailer>()

type SnapshotRequest = {
  peer: WebSocketPeer
  seq: number | null
  cols: number
  rows: number
}

type SnapshotState = {
  inFlight: boolean
  cooldownUntil: number
  timer: ReturnType<typeof setTimeout> | null
  pending: Map<WebSocketPeer, SnapshotRequest>
}

const snapshotStates = new Map<string, SnapshotState>()
const SNAPSHOT_MIN_INTERVAL_MS = 750
const cleanupSnapshotState = (sessionId: string) => {
  const state = snapshotStates.get(sessionId)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  snapshotStates.delete(sessionId)
}

const encodeBase64 = (value: string | Uint8Array) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  return Buffer.from(value).toString('base64')
}

const decodeBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8')

const sendJson = (peer: WebSocketPeer, payload: unknown) => {
  peer.send(JSON.stringify(payload))
}

const resolveSessionIdFromUrl = (url: string) => {
  const parsed = new URL(url, 'http://localhost')
  const match = parsed.pathname.match(/\/api\/terminals\/([^/]+)\/ws$/)
  let candidate = match ? decodeURIComponent(match[1] ?? '') : (parsed.searchParams.get('sessionId') ?? '')
  candidate = formatSessionId(candidate)
  if (!candidate || !isTerminalSessionId(candidate)) return null
  return candidate
}

const resolveSessionIdFromRequest = (
  request: WebSocketUpgradeRequest | Request | WebSocketPeer['request'] | null | undefined,
) => {
  const url = request && typeof request === 'object' && 'url' in request ? request.url : ''
  if (!url) return null
  return resolveSessionIdFromUrl(url)
}

const closeWithError = (peer: WebSocketPeer, message: string) => {
  sendJson(peer, { type: 'error', message, fatal: true })
  peer.close(1008, message)
}

const getTailer = (sessionId: string) => {
  let tailer = sessionTailers.get(sessionId)
  if (!tailer) {
    tailer = new TerminalLogTailer(sessionId)
    sessionTailers.set(sessionId, tailer)
  }
  return tailer
}

const getSnapshotState = (sessionId: string) => {
  let state = snapshotStates.get(sessionId)
  if (!state) {
    state = { inFlight: false, cooldownUntil: 0, timer: null, pending: new Map() }
    snapshotStates.set(sessionId, state)
  }
  return state
}

const queueSnapshot = (sessionId: string, request: SnapshotRequest) => {
  const state = getSnapshotState(sessionId)
  state.pending.set(request.peer, request)
  scheduleSnapshot(sessionId, state)
}

const scheduleSnapshot = (sessionId: string, state: SnapshotState) => {
  if (state.inFlight || state.timer) return
  const delay = Math.max(0, state.cooldownUntil - Date.now())
  state.timer = setTimeout(() => {
    state.timer = null
    void runSnapshot(sessionId, state)
  }, delay)
}

const runSnapshot = async (sessionId: string, state: SnapshotState) => {
  if (state.inFlight || state.pending.size === 0) return
  state.inFlight = true
  const requests = Array.from(state.pending.values())
  state.pending.clear()
  const latest = requests[requests.length - 1]

  try {
    const cols = latest ? latest.cols : Number.NaN
    const rows = latest ? latest.rows : Number.NaN
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      await resizeTerminalSession(sessionId, cols, rows)
    }
    const snapshot = await captureTerminalSnapshot(sessionId, 2000)
    if (snapshot.trim().length > 0) {
      const data = encodeBase64(snapshot)
      for (const request of requests) {
        if (peerState.get(request.peer)?.closed) continue
        const payload: Record<string, unknown> = { type: 'snapshot', data }
        if (request.seq !== null) payload.seq = request.seq
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          payload.cols = cols
          payload.rows = rows
        }
        sendJson(request.peer, payload)
      }
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unable to capture terminal snapshot.'
    console.warn('[terminals] ws snapshot failed', { sessionId, message: messageText })
    for (const request of requests) {
      if (peerState.get(request.peer)?.closed) continue
      sendJson(request.peer, { type: 'error', message: messageText, fatal: false })
    }
  } finally {
    state.inFlight = false
    state.cooldownUntil = Date.now() + SNAPSHOT_MIN_INTERVAL_MS
    if (state.pending.size > 0) {
      scheduleSnapshot(sessionId, state)
    }
  }
}

const websocketHooks = defineWebSocket({
  async upgrade(request: WebSocketUpgradeRequest) {
    const sessionId = resolveSessionIdFromRequest(request)
    if (!sessionId) {
      const url = typeof request?.url === 'string' ? request.url : 'unknown'
      console.warn('[terminals] ws upgrade invalid session id', { url })
      return new Response('Invalid terminal session id.', { status: 400 })
    }

    const session = await getTerminalSession(sessionId)
    if (!session) return new Response('Session not found.', { status: 404 })
    if (session.status !== 'ready') return new Response(`Session not ready (${session.status}).`, { status: 409 })

    const exists = await ensureTerminalSessionExists(sessionId)
    if (!exists) return new Response('Session not ready.', { status: 409 })

    try {
      await ensureTerminalLogPipe(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to attach terminal log pipe.'
      console.warn('[terminals] ws log pipe failed', { sessionId, message })
      await markTerminalSessionError(sessionId, message)
      return new Response(message, { status: 500 })
    }

    request.context = request.context ?? {}
    request.context.sessionId = sessionId
    return
  },

  async open(peer: WebSocketPeer) {
    let sessionId = typeof peer.context?.sessionId === 'string' ? peer.context.sessionId : null
    if (!sessionId) {
      sessionId = resolveSessionIdFromRequest(peer.request)
    }
    if (!sessionId) {
      console.warn('[terminals] ws open missing session id', { url: peer.request?.url })
      closeWithError(peer, 'Invalid terminal session id.')
      return
    }

    const state: PeerState = {
      sessionId,
      closed: false,
      tailerPeer: null,
    }
    peerState.set(peer, state)

    console.info('[terminals] ws open', { sessionId })

    try {
      const tailer = getTailer(sessionId)
      const tailerPeer: TailerPeer = {
        send: (payload) => sendJson(peer, payload),
      }
      state.tailerPeer = tailerPeer
      await tailer.addPeer(tailerPeer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read terminal log.'
      console.warn('[terminals] ws log attach failed', { sessionId, message })
      await markTerminalSessionError(sessionId, message)
      closeWithError(peer, message)
      return
    }
  },

  async message(peer: WebSocketPeer, message: WebSocketMessage) {
    const state = peerState.get(peer)
    if (!state || state.closed) return

    let payload: unknown
    try {
      payload = message.json()
    } catch {
      try {
        payload = JSON.parse(message.text())
      } catch {
        return
      }
    }

    if (!payload || typeof payload !== 'object') return
    const data = payload as Record<string, unknown>

    if (data.type === 'input' && typeof data.data === 'string') {
      try {
        queueTerminalInput(state.sessionId, decodeBase64(data.data))
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Unable to send input.'
        console.warn('[terminals] ws input failed', { sessionId: state.sessionId, message: messageText })
        sendJson(peer, { type: 'error', message: messageText, fatal: false })
      }
      return
    }

    if (data.type === 'resize') {
      const cols = typeof data.cols === 'number' ? data.cols : Number.NaN
      const rows = typeof data.rows === 'number' ? data.rows : Number.NaN
      try {
        await resizeTerminalSession(state.sessionId, cols, rows)
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Unable to resize terminal.'
        console.warn('[terminals] ws resize failed', { sessionId: state.sessionId, message: messageText })
      }
    }

    if (data.type === 'snapshot') {
      const seq = typeof data.seq === 'number' ? data.seq : null
      const cols = typeof data.cols === 'number' ? data.cols : Number.NaN
      const rows = typeof data.rows === 'number' ? data.rows : Number.NaN
      queueSnapshot(state.sessionId, { peer, seq, cols, rows })
    }
  },

  async close(peer: WebSocketPeer) {
    const state = peerState.get(peer)
    if (!state) return
    state.closed = true
    if (state.tailerPeer) {
      const tailer = sessionTailers.get(state.sessionId)
      tailer?.removePeer(state.tailerPeer)
      if (tailer && tailer.getPeerCount() === 0) {
        tailer.dispose()
        sessionTailers.delete(state.sessionId)
        cleanupSnapshotState(state.sessionId)
      }
      state.tailerPeer = null
    }
    const snapshotState = snapshotStates.get(state.sessionId)
    snapshotState?.pending.delete(peer)
    console.info('[terminals] ws closed', { sessionId: state.sessionId })
    peerState.delete(peer)
  },

  error(peer: WebSocketPeer, error: unknown) {
    const state = peerState.get(peer)
    console.warn('[terminals] ws error', {
      sessionId: state?.sessionId,
      message: error instanceof Error ? error.message : String(error),
    })
  },
})

const websocketResponse = () => {
  const response = new Response(null, { status: 426 })
  ;(response as Response & { crossws?: typeof websocketHooks }).crossws = websocketHooks
  return response
}
