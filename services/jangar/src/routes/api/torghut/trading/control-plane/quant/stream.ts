import { createFileRoute } from '@tanstack/react-router'

import { safeJsonStringify } from '~/server/chat-text'
import { recordSseConnection, recordSseError } from '~/server/metrics'
import { parseQuantAccount, parseQuantStrategyId, parseQuantWindow } from '~/server/torghut-quant-http'
import {
  getTorghutQuantEmitter,
  getTorghutQuantStreamHeartbeatMs,
  type QuantStreamEvent,
} from '~/server/torghut-quant-runtime'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => streamQuantEvents(request),
    },
  },
})

export const streamQuantEvents = async (request: Request) => {
  const url = new URL(request.url)
  const strategyIdResult = parseQuantStrategyId(url)
  if (!strategyIdResult.ok) {
    const body = JSON.stringify({ ok: false, message: strategyIdResult.message })
    return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
  }

  const account = parseQuantAccount(url).value
  const windowResult = parseQuantWindow(url)
  if (!windowResult.ok) {
    const body = JSON.stringify({ ok: false, message: windowResult.message })
    return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
  }

  const encoder = new TextEncoder()
  const emitter = getTorghutQuantEmitter()
  const heartbeatIntervalMs = getTorghutQuantStreamHeartbeatMs()

  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      recordSseConnection('torghut-quant', 'opened')

      const safeEnqueue = (value: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch {
          recordSseError('torghut-quant', 'enqueue')
          if (!closed) {
            closed = true
            try {
              controller.close()
            } catch {
              // ignore
            }
          }
        }
      }

      const push = (payload: unknown) => {
        safeEnqueue(`data: ${safeJsonStringify(payload)}\n\n`)
      }

      safeEnqueue('retry: 1000\n\n')
      safeEnqueue(': connected\n\n')

      const listener = (event: QuantStreamEvent) => {
        if (event.type === 'quant.metrics.snapshot') {
          if (event.frame.strategyId !== strategyIdResult.value) return
          if (event.frame.window !== windowResult.value) return
          if (account && event.frame.account !== account) return
          push(event)
          return
        }
        if (event.type === 'quant.metrics.delta') {
          if (event.strategyId !== strategyIdResult.value) return
          if (event.window !== windowResult.value) return
          if (account && event.account !== account) return
          push(event)
          return
        }
        if (event.type === 'quant.alert.opened' || event.type === 'quant.alert.resolved') {
          if (event.alert.strategyId !== strategyIdResult.value) return
          if (event.alert.window !== windowResult.value) return
          if (account && event.alert.account !== account) return
          push(event)
          return
        }
        if (event.type === 'error') {
          push(event)
        }
      }

      emitter.on('event', listener)
      unsubscribe = () => emitter.off('event', listener)

      heartbeat = setInterval(() => {
        safeEnqueue(': keep-alive\n\n')
      }, heartbeatIntervalMs)
    },
    cancel() {
      closed = true
      recordSseConnection('torghut-quant', 'closed')
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
    },
  })
}
