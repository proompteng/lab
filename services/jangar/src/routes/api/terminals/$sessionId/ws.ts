import { open as openFile } from 'node:fs/promises'

import { createFileRoute } from '@tanstack/react-router'
import { defineWebSocket } from 'h3'

import {
  captureTerminalSnapshot,
  ensureTerminalLogPipe,
  ensureTerminalSessionExists,
  formatSessionId,
  getTerminalLogPath,
  getTerminalSession,
  isTerminalSessionId,
  markTerminalSessionError,
  queueTerminalInput,
  resizeTerminalSession,
} from '~/server/terminals'

type PeerState = {
  sessionId: string
  closed: boolean
  handle: Awaited<ReturnType<typeof openFile>> | null
  offset: number
  poller: ReturnType<typeof setInterval> | null
  snapshotInFlight: boolean
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

const readLogChunk = async (state: PeerState, peer: WebSocketPeer) => {
  if (state.closed || !state.handle) return
  const stats = await state.handle.stat()
  if (stats.size < state.offset) {
    state.offset = stats.size
  }
  if (stats.size === state.offset) return
  const remaining = stats.size - state.offset
  const chunkSize = Math.min(remaining, 64 * 1024)
  const buffer = Buffer.alloc(chunkSize)
  const { bytesRead } = await state.handle.read(buffer, 0, chunkSize, state.offset)
  if (!bytesRead) return
  state.offset += bytesRead
  sendJson(peer, { type: 'output', data: encodeBase64(buffer.subarray(0, bytesRead)) })
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

    const logPath = await getTerminalLogPath(sessionId)
    const state: PeerState = {
      sessionId,
      closed: false,
      handle: null,
      offset: 0,
      poller: null,
      snapshotInFlight: false,
    }
    peerState.set(peer, state)

    console.info('[terminals] ws open', { sessionId })

    try {
      state.handle = await openFile(logPath, 'r')
      const stats = await state.handle.stat()
      state.offset = stats.size
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open terminal log.'
      console.warn('[terminals] ws log open failed', { sessionId, message })
      await markTerminalSessionError(sessionId, message)
      closeWithError(peer, message)
      return
    }

    state.poller = setInterval(() => {
      void readLogChunk(state, peer).catch((error) => {
        const message = error instanceof Error ? error.message : 'Unable to read terminal log.'
        console.warn('[terminals] ws log read failed', { sessionId, message })
        sendJson(peer, { type: 'error', message, fatal: false })
      })
    }, 25)
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
      if (state.snapshotInFlight) return
      const seq = typeof data.seq === 'number' ? data.seq : null
      const cols = typeof data.cols === 'number' ? data.cols : Number.NaN
      const rows = typeof data.rows === 'number' ? data.rows : Number.NaN
      state.snapshotInFlight = true
      try {
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          await resizeTerminalSession(state.sessionId, cols, rows)
        }
        const snapshot = await captureTerminalSnapshot(state.sessionId, 2000)
        if (snapshot.trim().length > 0) {
          const payload: Record<string, unknown> = { type: 'snapshot', data: encodeBase64(snapshot) }
          if (seq !== null) payload.seq = seq
          if (Number.isFinite(cols) && Number.isFinite(rows)) {
            payload.cols = cols
            payload.rows = rows
          }
          sendJson(peer, payload)
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Unable to capture terminal snapshot.'
        console.warn('[terminals] ws snapshot failed', { sessionId: state.sessionId, message: messageText })
        sendJson(peer, { type: 'error', message: messageText, fatal: false })
      } finally {
        state.snapshotInFlight = false
      }
    }
  },

  async close(peer: WebSocketPeer) {
    const state = peerState.get(peer)
    if (!state) return
    state.closed = true
    if (state.poller) clearInterval(state.poller)
    if (state.handle) {
      try {
        await state.handle.close()
      } catch {
        // ignore
      }
    }
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
