import { open as openFile } from 'node:fs/promises'

import { defineWebSocketHandler } from 'h3'

import {
  captureTerminalSnapshot,
  ensureTerminalLogPipe,
  ensureTerminalSessionExists,
  formatSessionId,
  getTerminalLogPath,
  getTerminalSession,
  isTerminalSessionId,
  resizeTerminalSession,
  sendTerminalInput,
} from '~/server/terminals'

type PeerState = {
  sessionId: string
  closed: boolean
  handle: Awaited<ReturnType<typeof openFile>> | null
  offset: number
  poller: ReturnType<typeof setInterval> | null
}

const peerState = new WeakMap<object, PeerState>()

const encodeBase64 = (value: string | Uint8Array) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  return Buffer.from(value).toString('base64')
}

const decodeBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8')

const sendJson = (peer: { send: (data: string) => void }, payload: unknown) => {
  peer.send(JSON.stringify(payload))
}

const resolveSessionId = (peer: { request?: { url?: string } }) => {
  const rawUrl = peer.request?.url
  if (!rawUrl) return null
  const pathname = new URL(rawUrl, 'http://localhost').pathname
  const match = pathname.match(/\/api\/terminals\/([^/]+)\/ws$/)
  if (!match) return null
  const candidate = formatSessionId(decodeURIComponent(match[1] ?? ''))
  if (!candidate || !isTerminalSessionId(candidate)) return null
  return candidate
}

const closeWithError = (
  peer: { send: (data: string) => void; close: (code?: number, reason?: string) => void },
  message: string,
) => {
  sendJson(peer, { type: 'error', message, fatal: true })
  peer.close(1008, message)
}

const readLogChunk = async (state: PeerState, peer: { send: (data: string) => void }) => {
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

export default defineWebSocketHandler({
  async open(peer) {
    const sessionId = resolveSessionId(peer)
    if (!sessionId) {
      closeWithError(peer, 'Invalid terminal session id.')
      return
    }

    const session = await getTerminalSession(sessionId)
    if (!session) {
      closeWithError(peer, 'Session not found.')
      return
    }
    if (session.status !== 'ready') {
      closeWithError(peer, `Session not ready (${session.status}).`)
      return
    }

    const exists = await ensureTerminalSessionExists(sessionId)
    if (!exists) {
      closeWithError(peer, 'Session not ready.')
      return
    }

    try {
      await ensureTerminalLogPipe(sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to attach terminal log pipe.'
      console.warn('[terminals] ws log pipe failed', { sessionId, message })
      closeWithError(peer, message)
      return
    }

    const logPath = await getTerminalLogPath(sessionId)

    const state: PeerState = {
      sessionId,
      closed: false,
      handle: null,
      offset: 0,
      poller: null,
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
      closeWithError(peer, message)
      return
    }

    try {
      const snapshot = await captureTerminalSnapshot(sessionId, 2000)
      if (snapshot.trim().length > 0) {
        sendJson(peer, { type: 'snapshot', data: encodeBase64(snapshot) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to capture terminal snapshot.'
      console.warn('[terminals] ws snapshot failed', { sessionId, message })
      sendJson(peer, { type: 'error', message, fatal: false })
    }

    state.poller = setInterval(() => {
      void readLogChunk(state, peer).catch((error) => {
        const message = error instanceof Error ? error.message : 'Unable to read terminal log.'
        console.warn('[terminals] ws log read failed', { sessionId, message })
        sendJson(peer, { type: 'error', message, fatal: false })
      })
    }, 25)
  },

  async message(peer, message) {
    const state = peerState.get(peer)
    if (!state || state.closed) return

    let payload: unknown
    try {
      payload = await message.json()
    } catch {
      return
    }

    if (!payload || typeof payload !== 'object') return
    const data = payload as Record<string, unknown>

    if (data.type === 'input' && typeof data.data === 'string') {
      try {
        await sendTerminalInput(state.sessionId, decodeBase64(data.data))
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
  },

  async close(peer) {
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

  error(peer, error) {
    const state = peerState.get(peer)
    console.warn('[terminals] ws error', {
      sessionId: state?.sessionId,
      message: error instanceof Error ? error.message : String(error),
    })
  },
})
