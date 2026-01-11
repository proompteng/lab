import { createFileRoute } from '@tanstack/react-router'
import { defineWebSocket } from 'h3'

import { isTerminalBackendProxyEnabled } from '~/server/terminal-backend'
import { getTerminalPtyManager } from '~/server/terminal-pty-manager'
import {
  ensureTerminalSessionExists,
  formatSessionId,
  getTerminalRuntime,
  getTerminalSession,
} from '~/server/terminals'

type PeerState = {
  sessionId: string
  token: string
}

type WebSocketPeer = {
  send: (data: string | Uint8Array) => void
  close: (code?: number, reason?: string) => void
  context?: {
    sessionId?: string
    reconnectToken?: string
    sessionToken?: string
    since?: number
    cols?: number
    rows?: number
  }
  request?: Request | { url?: string } | null
}

type WebSocketMessage = {
  json: () => unknown
  text: () => string
  arrayBuffer?: () => ArrayBuffer | SharedArrayBuffer
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
const inputEncoder = new TextEncoder()

const jsonMessage = (peer: WebSocketPeer, payload: Record<string, unknown>) => {
  peer.send(JSON.stringify(payload))
}

const resolveAttachParams = (url: string) => {
  const parsed = new URL(url, 'http://localhost')
  const match = parsed.pathname.match(/\/api\/terminals\/([^/]+)\/ws$/)
  const sessionCandidate = match ? decodeURIComponent(match[1] ?? '') : (parsed.searchParams.get('sessionId') ?? '')
  const sessionId = formatSessionId(sessionCandidate)
  const reconnectToken = parsed.searchParams.get('reconnect') ?? ''
  const sessionToken = parsed.searchParams.get('token') ?? ''
  const sinceRaw = parsed.searchParams.get('since')
  const colsRaw = parsed.searchParams.get('cols')
  const rowsRaw = parsed.searchParams.get('rows')
  const sinceParsed = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0
  const colsParsed = colsRaw ? Number.parseInt(colsRaw, 10) : Number.NaN
  const rowsParsed = rowsRaw ? Number.parseInt(rowsRaw, 10) : Number.NaN
  const since = Number.isFinite(sinceParsed) && sinceParsed > 0 ? sinceParsed : 0
  const cols = Number.isFinite(colsParsed) && colsParsed > 0 ? colsParsed : undefined
  const rows = Number.isFinite(rowsParsed) && rowsParsed > 0 ? rowsParsed : undefined
  return { sessionId, reconnectToken, sessionToken, since, cols, rows }
}

const websocketHooks = defineWebSocket({
  async upgrade(request: WebSocketUpgradeRequest) {
    if (isTerminalBackendProxyEnabled()) {
      return new Response('Terminal backend proxy enabled; connect to the terminal backend URL.', { status: 409 })
    }
    const { sessionId, reconnectToken, sessionToken, since, cols, rows } = resolveAttachParams(request.url)
    if (!sessionId || !reconnectToken) {
      return new Response('Invalid terminal session id or reconnect token.', { status: 400 })
    }

    const session = await getTerminalSession(sessionId)
    if (!session) return new Response('Session not found.', { status: 404 })
    if (session.status !== 'ready') return new Response(`Session not ready (${session.status}).`, { status: 409 })
    if (session.reconnectToken && (!sessionToken || sessionToken !== session.reconnectToken)) {
      return new Response('Invalid terminal reconnect token.', { status: 401 })
    }

    const exists = await ensureTerminalSessionExists(sessionId)
    if (!exists) return new Response('Session not ready.', { status: 409 })

    request.context = request.context ?? {}
    request.context.sessionId = sessionId
    request.context.reconnectToken = reconnectToken
    request.context.sessionToken = sessionToken
    request.context.since = since
    request.context.cols = cols
    request.context.rows = rows
    return
  },

  async open(peer: WebSocketPeer) {
    let sessionId = peer.context?.sessionId
    let token = peer.context?.reconnectToken
    let since = peer.context?.since
    let cols = peer.context?.cols
    let rows = peer.context?.rows
    if ((!sessionId || !token) && peer.request?.url) {
      const resolved = resolveAttachParams(peer.request.url)
      sessionId = sessionId ?? resolved.sessionId
      token = token ?? resolved.reconnectToken
      since = since ?? resolved.since
      cols = cols ?? resolved.cols
      rows = rows ?? resolved.rows
    }
    if (!sessionId || !token) {
      jsonMessage(peer, { type: 'error', message: 'Invalid session.' })
      peer.close(1008, 'Invalid session')
      return
    }

    const runtime = getTerminalRuntime(sessionId)
    if (!runtime) {
      jsonMessage(peer, { type: 'error', message: 'Session not found.' })
      peer.close(1011, 'Session unavailable')
      return
    }

    try {
      const manager = getTerminalPtyManager()
      manager.attach(sessionId, peer, {
        token,
        since,
        cols,
        rows,
      })
      peerState.set(peer, { sessionId, token })
    } catch (error) {
      jsonMessage(peer, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to attach session.',
      })
      peer.close(1011, 'Attach failed')
    }
  },

  message(peer: WebSocketPeer, message: WebSocketMessage) {
    const state = peerState.get(peer)
    if (!state) return

    let textPayload: string | null = null
    try {
      textPayload = message.text()
    } catch {
      textPayload = null
    }

    if (textPayload !== null) {
      let payload: unknown = null
      const trimmed = textPayload.trim()
      if (trimmed.startsWith('{')) {
        try {
          payload = JSON.parse(trimmed)
        } catch {
          payload = null
        }
      }

      if (payload && typeof payload === 'object') {
        const type = (payload as Record<string, unknown>).type
        if (type === 'resize') {
          const cols = (payload as Record<string, unknown>).cols
          const rows = (payload as Record<string, unknown>).rows
          if (typeof cols === 'number' && typeof rows === 'number') {
            const manager = getTerminalPtyManager()
            manager.resize(state.sessionId, cols, rows)
          }
          return
        }
        if (type === 'ping') {
          jsonMessage(peer, { type: 'pong' })
          return
        }
      }

      if (message.arrayBuffer) {
        const buffer = new Uint8Array(message.arrayBuffer())
        if (buffer.length > 0) {
          const manager = getTerminalPtyManager()
          manager.handleInput(state.sessionId, buffer)
        }
        return
      }

      if (textPayload.length > 0) {
        const manager = getTerminalPtyManager()
        manager.handleInput(state.sessionId, inputEncoder.encode(textPayload))
      }
      return
    }

    if (message.arrayBuffer) {
      const buffer = new Uint8Array(message.arrayBuffer())
      if (buffer.length > 0) {
        const manager = getTerminalPtyManager()
        manager.handleInput(state.sessionId, buffer)
      }
      return
    }
  },

  close(peer: WebSocketPeer) {
    const state = peerState.get(peer)
    if (!state) return
    const manager = getTerminalPtyManager()
    manager.detach(state.sessionId, state.token)
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
