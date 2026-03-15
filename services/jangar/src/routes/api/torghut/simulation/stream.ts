import { createFileRoute } from '@tanstack/react-router'

import { safeJsonStringify } from '~/server/chat-text'
import { syncTorghutSimulationRun } from '~/server/torghut-simulation-control-plane'

export const Route = createFileRoute('/api/torghut/simulation/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => streamSimulationRun(request),
    },
  },
})

const STREAM_POLL_MS = 2000

export const streamSimulationRun = async (request: Request) => {
  const url = new URL(request.url)
  const runId = url.searchParams.get('run_id')?.trim()
  if (!runId) {
    const body = JSON.stringify({ ok: false, message: 'run_id is required' })
    return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
  }

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false
  let lastSnapshot = ''

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (value: string) => {
        if (closed) return
        controller.enqueue(encoder.encode(value))
      }

      const pushSnapshot = async () => {
        const run = await syncTorghutSimulationRun(runId)
        const payload = safeJsonStringify({
          type: 'torghut.simulation.snapshot',
          run,
        })
        if (payload === lastSnapshot) return
        lastSnapshot = payload
        safeEnqueue(`data: ${payload}\n\n`)
      }

      safeEnqueue('retry: 1000\n\n')
      safeEnqueue(': connected\n\n')
      await pushSnapshot()
      timer = setInterval(() => {
        void pushSnapshot().catch((error) => {
          safeEnqueue(
            `data: ${safeJsonStringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'simulation stream failed',
            })}\n\n`,
          )
        })
      }, STREAM_POLL_MS)
    },
    cancel() {
      closed = true
      if (timer) clearInterval(timer)
      timer = null
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
