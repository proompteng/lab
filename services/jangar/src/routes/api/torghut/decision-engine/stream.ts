import { createFileRoute } from '@tanstack/react-router'

import { safeJsonStringify } from '~/server/chat-text'
import { recordSseConnection, recordSseError } from '~/server/metrics'
import {
  getTorghutDecisionStreamHeartbeatMs,
  isTorghutDecisionEngineEnabled,
  listTorghutDecisionRunEvents,
  parseDecisionEngineRequest,
  submitTorghutDecisionRun,
  subscribeTorghutDecisionRunEvents,
} from '~/server/torghut-decision-engine'

export const Route = createFileRoute('/api/torghut/decision-engine/stream')({
  server: {
    handlers: {
      POST: async ({ request }) => streamDecisionRun(request),
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

const isTerminalType = (type: string) => type === 'decision.final' || type === 'decision.error'

export const streamDecisionRun = async (request: Request) => {
  if (!isTorghutDecisionEngineEnabled()) {
    return jsonResponse({ ok: false, message: 'torghut decision engine disabled' }, 503)
  }

  const payload: unknown = await request.json().catch(() => null)
  const parsed = parseDecisionEngineRequest(payload)
  if (!parsed.ok) {
    return jsonResponse({ ok: false, message: parsed.message }, 400)
  }

  const submitted = submitTorghutDecisionRun(parsed.value)
  const runId = submitted.run.runId
  const heartbeatIntervalMs = getTorghutDecisionStreamHeartbeatMs()

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      recordSseConnection('torghut-decision', 'opened')

      const closeStream = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        if (unsubscribe) unsubscribe()
        unsubscribe = null
        try {
          controller.close()
        } catch {
          // ignore
        }
      }

      const safeEnqueue = (value: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch {
          recordSseError('torghut-decision', 'enqueue')
          closeStream()
        }
      }

      const pushEvent = (eventType: string, data: unknown) => {
        safeEnqueue(`event: ${eventType}\n`)
        safeEnqueue(`data: ${safeJsonStringify(data)}\n\n`)
      }

      safeEnqueue('retry: 1000\n\n')
      safeEnqueue(': connected\n\n')

      pushEvent('decision.accepted', {
        run_id: runId,
        request_id: submitted.run.requestId,
        idempotent: submitted.idempotent,
      })

      const historical = listTorghutDecisionRunEvents(runId, 0) ?? []
      for (const event of historical) {
        pushEvent(event.type, {
          run_id: runId,
          sequence: event.sequence,
          at: event.at,
          payload: event.payload,
        })
        if (isTerminalType(event.type)) {
          closeStream()
          return
        }
      }

      unsubscribe = subscribeTorghutDecisionRunEvents(runId, (event) => {
        pushEvent(event.type, {
          run_id: runId,
          sequence: event.sequence,
          at: event.at,
          payload: event.payload,
        })
        if (isTerminalType(event.type)) {
          closeStream()
        }
      })

      heartbeat = setInterval(() => {
        safeEnqueue(': keep-alive\n\n')
      }, heartbeatIntervalMs)

      request.signal.addEventListener('abort', () => closeStream(), { once: true })
    },
    cancel() {
      closed = true
      recordSseConnection('torghut-decision', 'closed')
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (unsubscribe) unsubscribe()
      unsubscribe = null
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
