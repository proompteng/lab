import { createFileRoute } from '@tanstack/react-router'
import {
  captureTerminalSnapshot,
  ensureTerminalLogPipe,
  ensureTerminalSessionExists,
  formatSessionId,
  getTerminalLogPath,
  getTerminalSession,
} from '~/server/terminals'

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
  const normalized = formatSessionId(sessionId)
  const session = await getTerminalSession(normalized)
  if (!session) {
    console.warn('[terminals] stream session not found', { sessionId: normalized })
    return jsonResponse({ ok: false, message: 'Session not found' }, 404)
  }
  if (session.status !== 'ready') {
    return jsonResponse({ ok: false, message: `Session not ready (${session.status}).` }, 409)
  }
  const exists = await ensureTerminalSessionExists(normalized)
  if (!exists) {
    console.warn('[terminals] stream session not ready', { sessionId: normalized })
    return jsonResponse({ ok: false, message: 'Session not ready.' }, 409)
  }

  const logPath = await getTerminalLogPath(normalized)
  try {
    await ensureTerminalLogPipe(normalized)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to attach terminal log pipe'
    console.warn('[terminals] stream log pipe failed', { sessionId: normalized, message })
    return jsonResponse({ ok: false, message }, 500)
  }

  const encoder = new TextEncoder()
  let tailProcess: Bun.Subprocess | null = null
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendEvent = (event: string, data: string) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
      }

      try {
        const snapshot = await captureTerminalSnapshot(normalized, 2000)
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
      }, 15_000)

      const bunRuntime = (globalThis as { Bun?: typeof Bun }).Bun
      if (!bunRuntime) {
        sendEvent('server-error', encodeBase64('Terminal streaming requires Bun runtime.'))
        controller.close()
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        return
      }

      tailProcess = bunRuntime.spawn(['stdbuf', '-o0', 'tail', '-n', '0', '-F', logPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = tailProcess.stdout
      if (!stdout || typeof stdout === 'number') {
        sendEvent('server-error', encodeBase64('Unable to open terminal output stream.'))
        controller.close()
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        return
      }
      const reader = stdout.getReader()

      while (!closed) {
        const { done, value } = await reader.read()
        if (done || closed) break
        if (value && value.length > 0) {
          sendEvent('output', encodeBase64(value))
        }
      }

      closed = true
      if (heartbeat) clearInterval(heartbeat)
      controller.close()
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (tailProcess) {
        try {
          tailProcess.kill()
        } catch {
          // ignore
        }
      }
    },
  })

  request.signal.addEventListener('abort', () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (tailProcess) {
      try {
        tailProcess.kill()
      } catch {
        // ignore
      }
    }
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
