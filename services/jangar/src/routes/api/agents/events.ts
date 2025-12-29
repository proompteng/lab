import { createFileRoute } from '@tanstack/react-router'
import { connect, type NatsConnection, StringCodec, type Subscription } from 'nats'

import { safeJsonStringify } from '~/server/chat-text'

export const Route = createFileRoute('/api/agents/events')({
  server: {
    handlers: {
      GET: async ({ request }) => getAgentEvents(request),
    },
  },
})

const DEFAULT_NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'
const HEARTBEAT_INTERVAL_MS = 15000

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

const coerceString = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const pickMessageRecord = (payload: Record<string, unknown>): Record<string, unknown> =>
  toRecord(payload.message) ?? toRecord(payload.data) ?? payload

const readRunId = (payload: Record<string, unknown>): string | null =>
  coerceString(payload.run_id ?? payload.runId ?? payload.runID)

const readChannel = (payload: Record<string, unknown>): string | null => coerceString(payload.channel)

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const normalizePayload = (raw: string, fallbackChannel: string | null): Record<string, unknown> => {
  const parsed = safeParseJson(raw)
  const record = toRecord(parsed)
  if (record) {
    const candidate = pickMessageRecord(record)
    const merged = candidate === record ? { ...candidate } : { ...record, ...candidate }
    if (candidate !== record) {
      delete merged.message
      delete merged.data
    }
    if (fallbackChannel && !merged.channel) {
      merged.channel = fallbackChannel
    }
    return merged
  }

  return {
    content: raw,
    channel: fallbackChannel,
  }
}

const buildSubject = (runId: string | null, channel: string | null) => {
  if (!runId && channel?.toLowerCase() === 'general') return 'argo.workflow.general.>'
  return 'argo.workflow.>'
}

const getAgentEvents = async (request: Request) => {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')?.trim() || null
  const channel = url.searchParams.get('channel')?.trim() || null

  if (!runId && !channel) {
    return jsonResponse({ ok: false, error: 'runId or channel is required' }, 400)
  }

  const subject = buildSubject(runId, channel)
  const servers = process.env.NATS_URL?.trim() || DEFAULT_NATS_URL
  const user = process.env.NATS_USER?.trim()
  const pass = process.env.NATS_PASSWORD?.trim()

  let nc: NatsConnection
  try {
    const options: { servers: string; name: string; user?: string; pass?: string } = {
      servers,
      name: 'jangar-agent-comms-sse',
    }
    if (user && pass) {
      options.user = user
      options.pass = pass
    }
    nc = await connect(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ ok: false, error: message }, 500)
  }

  const sc = StringCodec()
  let subscription: Subscription | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let isClosed = false
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${safeJsonStringify(payload)}\n\n`))
      }

      const cleanup = async () => {
        if (isClosed) return
        isClosed = true
        if (heartbeat) clearInterval(heartbeat)
        try {
          subscription?.unsubscribe()
        } catch {
          // ignore unsubscribe errors
        }
        try {
          await nc.close()
        } catch {
          // ignore close errors
        }
        controller.close()
      }

      const handleAbort = () => {
        void cleanup()
      }

      request.signal.addEventListener('abort', handleAbort)

      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'))
      }, HEARTBEAT_INTERVAL_MS)

      subscription = nc.subscribe(subject)

      void (async () => {
        try {
          for await (const message of subscription) {
            const decoded = sc.decode(message.data)
            const subjectChannel = message.subject.startsWith('argo.workflow.general.') ? 'general' : null
            const payload = normalizePayload(decoded, subjectChannel ?? channel)
            const payloadRunId = readRunId(payload)
            if (runId && payloadRunId !== runId) continue

            const payloadChannel = readChannel(payload)
            if (channel) {
              if (payloadChannel && payloadChannel !== channel) continue
              if (!payloadChannel && subjectChannel && channel !== subjectChannel) continue
            }

            if (!payload.timestamp) {
              payload.timestamp = new Date().toISOString()
            }

            push(payload)
          }
        } catch (error) {
          if (!isClosed) {
            push({ error: error instanceof Error ? error.message : String(error) })
          }
        } finally {
          request.signal.removeEventListener('abort', handleAbort)
          await cleanup()
        }
      })()
    },
    cancel() {
      if (isClosed) return
      isClosed = true
      if (heartbeat) clearInterval(heartbeat)
      subscription?.unsubscribe()
      void nc.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
