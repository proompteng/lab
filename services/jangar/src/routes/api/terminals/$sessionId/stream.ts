import { createFileRoute } from '@tanstack/react-router'
import { fetchTerminalBackend, isTerminalBackendProxyEnabled } from '~/server/terminal-backend'
import { formatSessionId, getTerminalSession, getTerminalSnapshot } from '~/server/terminals'

export const Route = createFileRoute('/api/terminals/$sessionId/stream')({
  server: {
    handlers: {
      GET: async ({ params, request }) => streamHandler(params.sessionId, request),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const encodeBase64 = (value: string | Uint8Array) => {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  return Buffer.from(value).toString('base64')
}

const streamHandler = async (sessionId: string, request: Request) => {
  if (isTerminalBackendProxyEnabled()) {
    const response = await fetchTerminalBackend(
      `api/terminals/${encodeURIComponent(sessionId)}/stream`,
      { method: 'GET' },
      0,
    )
    return response
  }

  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) {
    console.warn('[terminals] stream session not found', { sessionId: normalized })
    return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  }
  if (session.status !== 'ready') {
    return jsonResponse({ ok: false, message: `Session not ready (${session.status}).` }, 409)
  }

  const encoder = new TextEncoder()
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendEvent = (event: string, data: string) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
      }

      console.info('[terminals] stream open', { sessionId: normalized })
      controller.enqueue(encoder.encode('retry: 1000\n\n'))
      controller.enqueue(encoder.encode(': connected\n\n'))

      try {
        const snapshot = await getTerminalSnapshot(normalized)
        if (snapshot.trim().length > 0) {
          sendEvent('snapshot', encodeBase64(snapshot))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to capture terminal snapshot'
        console.warn('[terminals] stream snapshot failed', { sessionId: normalized, message })
        sendEvent('server-error', encodeBase64(message))
      }

      heartbeat = setInterval(() => {
        if (closed) return
        controller.enqueue(encoder.encode(': ping\n\n'))
      }, 5_000)

      request.signal.addEventListener('abort', () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // ignore
        }
      })
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
