import { open as openFile } from 'node:fs/promises'
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
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let poller: ReturnType<typeof setInterval> | null = null
  let cleanup: (() => Promise<void>) | null = null
  let resolveKeepAlive: (() => void) | null = null

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
        const snapshot = await captureTerminalSnapshot(normalized, 2000)
        if (snapshot.trim().length > 0) {
          const trimmed = trimTrailingEmptyLines(snapshot)
          if (trimmed) {
            sendEvent('snapshot', encodeBase64(trimmed))
          }
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

      let handle: Awaited<ReturnType<typeof openFile>> | null = null
      let offset = 0
      let reading = false

      const keepAlive = new Promise<void>((resolve) => {
        resolveKeepAlive = resolve
      })

      cleanup = async () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (poller) clearInterval(poller)
        request.signal.removeEventListener('abort', handleAbort)
        if (handle) {
          try {
            await handle.close()
          } catch {
            // ignore
          }
        }
        console.info('[terminals] stream closed', { sessionId: normalized })
        try {
          controller.close()
        } catch {
          // ignore double-close
        }
        if (resolveKeepAlive) resolveKeepAlive()
      }

      const handleAbort = () => {
        if (cleanup) {
          void cleanup()
        }
      }

      request.signal.addEventListener('abort', handleAbort)

      const readChunk = async () => {
        if (closed || !handle || reading) return
        reading = true
        try {
          while (!closed) {
            const stats = await handle.stat()
            if (stats.size < offset) {
              offset = stats.size
            }
            if (stats.size === offset) {
              break
            }
            const remaining = stats.size - offset
            const chunkSize = Math.min(remaining, 64 * 1024)
            const buffer = Buffer.alloc(chunkSize)
            const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset)
            if (!bytesRead) {
              break
            }
            offset += bytesRead
            sendEvent('output', encodeBase64(buffer.subarray(0, bytesRead)))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to read terminal log'
          console.warn('[terminals] stream read failed', { sessionId: normalized, message })
          sendEvent('server-error', encodeBase64(message))
        } finally {
          reading = false
        }
      }

      try {
        handle = await openFile(logPath, 'r')
        const stats = await handle.stat()
        offset = stats.size
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to open terminal log'
        console.warn('[terminals] stream log open failed', { sessionId: normalized, message })
        sendEvent('server-error', encodeBase64(message))
        await cleanup()
        return
      }

      poller = setInterval(() => {
        void readChunk()
      }, 50)

      await readChunk()
      await keepAlive
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (poller) clearInterval(poller)
      if (cleanup) {
        void cleanup()
      }
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

const trimTrailingEmptyLines = (value: string) => {
  const lines = value.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last.trim().length > 0) break
    lines.pop()
  }
  return lines.join('\n')
}
