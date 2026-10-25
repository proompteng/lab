import { browserErrorConfig, glitchTipDsn } from '@/lib/observability/errors'
import { requireSameOrigin } from '@/lib/tengri/http'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
const MAX_ENVELOPE_BYTES = 256 * 1024
const MAX_PENDING_ENVELOPES = 8
let pendingEnvelopes = 0
const frameSchema = z.object({
  filename: z.string().max(2048).optional(),
  function: z.string().max(256).optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
})
const eventSchema = z.object({
  event_id: z.string().regex(/^[a-f0-9]{32}$/),
  timestamp: z.number().positive().optional(),
  level: z.enum(['fatal', 'error', 'warning']).optional(),
  exception: z.object({
    values: z
      .array(
        z.object({
          type: z.string().max(128).optional(),
          stacktrace: z.object({ frames: z.array(frameSchema).max(200) }).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  tags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

export async function POST(request: Request) {
  if (pendingEnvelopes >= MAX_PENDING_ENVELOPES) return new Response(null, { status: 429 })
  pendingEnvelopes += 1
  try {
    requireSameOrigin(request)
    const dsn = glitchTipDsn(process.env.SENTRY_BROWSER_DSN)
    const config = browserErrorConfig()
    if (!dsn || !config) return new Response(null, { status: 503 })
    const reader = request.body?.getReader()
    if (!reader) return new Response(null, { status: 400 })
    const chunks: Uint8Array[] = []
    let length = 0
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      void reader.cancel()
    }, 5_000)
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > MAX_ENVELOPE_BYTES) {
          await reader.cancel()
          return new Response(null, { status: 413 })
        }
        chunks.push(part.value)
      }
    } finally {
      clearTimeout(timer)
    }
    if (expired) return new Response(null, { status: 408 })
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n')
    if (lines.length !== 3) return new Response(null, { status: 400 })
    const header = z.object({ dsn: z.literal(config.dsn) }).parse(JSON.parse(lines[0] ?? ''))
    z.object({ type: z.literal('event') }).parse(JSON.parse(lines[1] ?? ''))
    const event = eventSchema.parse(JSON.parse(lines[2] ?? ''))
    const tags: Record<string, string> = { service: 'tengri-browser' }
    for (const key of ['operation', 'code', 'status', 'trace_id']) {
      const value = String(event.tags?.[key] ?? '')
      if (/^[a-zA-Z0-9_.-]{1,64}$/.test(value)) tags[key] = value
    }
    const sanitized = {
      event_id: event.event_id,
      timestamp: event.timestamp,
      level: event.level ?? 'error',
      platform: 'javascript',
      release: config.release,
      environment: config.environment,
      tags,
      exception: {
        values: event.exception.values.map((exception) => ({
          type: exception.type,
          value: 'Runtime message withheld',
          stacktrace: exception.stacktrace && {
            frames: exception.stacktrace.frames.map((frame) => ({
              ...frame,
              filename: frame.filename?.split(/[?#]/, 1)[0],
            })),
          },
        })),
      },
    }
    const body = `${JSON.stringify({ ...header, dsn: dsn.toString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(sanitized)}\n`
    const response = await fetch(`${dsn.origin}/api${dsn.pathname}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.username}`,
      },
      body,
      signal: AbortSignal.timeout(3_000),
      redirect: 'error',
    }).catch(() => null)
    if (!response) return new Response(null, { status: 502 })
    return new Response(null, { status: response.ok ? 202 : 502, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
      return new Response(null, { status: 400 })
    }
    if (error instanceof Error && 'status' in error && error.status === 403) return new Response(null, { status: 403 })
    return new Response(null, { status: 502 })
  } finally {
    pendingEnvelopes -= 1
  }
}
