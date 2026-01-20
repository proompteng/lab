import { spawn } from 'node:child_process'

import { safeJsonStringify } from '~/server/chat-text'

export type KubectlWatchEvent = {
  type: string
  object: Record<string, unknown>
}

type KubectlWatchOptions = {
  request: Request
  args: string[]
  onEvent: (event: KubectlWatchEvent) => unknown | null
  heartbeatMs?: number
}

const parseWatchEvent = (line: string): KubectlWatchEvent | null => {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    const type = typeof parsed.type === 'string' ? parsed.type : null
    const object =
      parsed.object && typeof parsed.object === 'object' && !Array.isArray(parsed.object)
        ? (parsed.object as Record<string, unknown>)
        : null
    if (!type || !object) return null
    return { type, object }
  } catch {
    return null
  }
}

export const createKubectlWatchStream = ({ request, args, onEvent, heartbeatMs = 5000 }: KubectlWatchOptions) => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let buffer = ''
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let lastError: string | null = null

      const safeEnqueue = (value: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch {
          cleanup('enqueue-failed')
        }
      }

      const comment = (value: string) => {
        safeEnqueue(`: ${value.replaceAll('\n', ' ')}\n\n`)
      }

      const push = (payload: unknown) => {
        safeEnqueue(`data: ${safeJsonStringify(payload)}\n\n`)
      }

      const cleanup = (reason: string) => {
        if (closed) return
        closed = true
        request.signal.removeEventListener('abort', handleAbort)
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        try {
          child.kill()
        } catch {
          // ignore
        }
        comment(`closed: ${reason}`)
        try {
          controller.close()
        } catch {
          // ignore
        }
      }

      const handleAbort = () => cleanup('abort')

      request.signal.addEventListener('abort', handleAbort)

      safeEnqueue('retry: 1000\n\n')
      comment('connected')

      heartbeat = setInterval(() => {
        comment('keep-alive')
      }, heartbeatMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = parseWatchEvent(line)
          if (!event) continue
          const payload = onEvent(event)
          if (payload) push(payload)
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        lastError = chunk.toString('utf8').trim() || lastError
      })

      child.on('close', (code) => {
        if (closed) return
        if (code && code !== 0) {
          push({ type: 'ERROR', error: lastError ?? `kubectl exited with ${code}` })
        }
        cleanup('closed')
      })
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  })
}
