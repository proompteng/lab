import { afterEach, describe, expect, mock, test } from 'bun:test'
import { browserErrorConfig, glitchTipDsn, sanitizeErrorEvent } from './errors'

void mock.module('server-only', () => ({}))
const { POST } = await import('../../app/api/telemetry/errors/route')
const originalFetch = globalThis.fetch
const previous = { ...process.env }
const key = '0123456789abcdef0123456789abcdef'
const internalDsn = `http://${key}@glitchtip-web.glitchtip.svc.cluster.local/4`
const publicDsn = `https://${key}@proompteng.ai/4`

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.SENTRY_BROWSER_DSN = previous.SENTRY_BROWSER_DSN
  process.env.APP_SOURCE_REVISION = previous.APP_SOURCE_REVISION
})

function envelope(event: object, dsn = publicDsn, item = 'event') {
  return `${JSON.stringify({ dsn })}\n${JSON.stringify({ type: item })}\n${JSON.stringify(event)}\n`
}

function request(body: string | ReadableStream<Uint8Array>, origin = 'https://proompteng.ai') {
  return new Request('https://proompteng.ai/api/telemetry/errors', { method: 'POST', headers: { origin }, body })
}

function configure() {
  process.env.SENTRY_BROWSER_DSN = internalDsn
  process.env.APP_SOURCE_REVISION = 'a'.repeat(40)
}

const event = {
  type: undefined,
  event_id: 'b'.repeat(32),
  timestamp: Date.now() / 1000,
  level: 'error' as const,
  exception: {
    values: [
      {
        type: 'Error',
        value: 'PRIVATE_SENTINEL',
        stacktrace: {
          frames: [
            {
              filename: 'https://proompteng.ai/_next/static/chunk.js?secret=PRIVATE_SENTINEL',
              lineno: 3,
              vars: { private: 'PRIVATE_SENTINEL' },
            },
          ],
        },
      },
    ],
  },
  request: { headers: { cookie: 'PRIVATE_SENTINEL' } },
  user: { email: 'PRIVATE_SENTINEL' },
  tags: { trace_id: 'c'.repeat(32), operation: 'terminal.websocket', private: 'PRIVATE_SENTINEL' },
}

describe('bounded browser error ingestion', () => {
  test('limits unfinished bodies and releases every slot after rejection', async () => {
    configure()
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const pending = Array.from({ length: 8 }, () =>
      POST(
        request(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller)
            },
          }),
        ),
      ),
    )
    expect((await POST(request(envelope(event)))).status).toBe(429)
    controllers.forEach((controller) => controller.close())
    expect((await Promise.all(pending)).every((response) => response.status === 400)).toBe(true)
    expect((await POST(request('invalid'))).status).toBe(400)
  })
  test('forwards only sanitized errors to the configured project with authoritative release and trace', async () => {
    configure()
    let forwarded = ''
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL, options?: RequestInit) => {
        expect(input).toBe('http://glitchtip-web.glitchtip.svc.cluster.local/api/4/envelope/')
        expect(options?.redirect).toBe('error')
        expect(new Headers(options?.headers).get('x-sentry-auth')).toBe(`Sentry sentry_version=7, sentry_key=${key}`)
        forwarded = String(options?.body)
        return new Response(null, { status: 202 })
      }),
      { preconnect: originalFetch.preconnect },
    )
    expect((await POST(request(envelope({ ...event, release: 'spoofed' })))).status).toBe(202)
    expect(forwarded).not.toContain('PRIVATE_SENTINEL')
    expect(forwarded).not.toContain('spoofed')
    expect(forwarded).toContain('c'.repeat(32))
    expect(forwarded).toContain('a'.repeat(40))
  })

  test('denies foreign origins, arbitrary DSNs, non-error envelopes and oversized streams before forwarding', async () => {
    configure()
    const forward = mock(async () => new Response(null, { status: 202 }))
    globalThis.fetch = Object.assign(forward, { preconnect: originalFetch.preconnect })
    expect((await POST(request(envelope(event), 'https://attacker.invalid'))).status).toBe(403)
    expect((await POST(request(envelope(event, 'http://127.0.0.1:1234/1')))).status).toBe(400)
    expect((await POST(request(envelope(event, publicDsn, 'attachment')))).status).toBe(400)
    expect((await POST(request('a'.repeat(256 * 1024 + 1)))).status).toBe(413)
    expect(forward).not.toHaveBeenCalled()
  })

  test('reports collector failure and rejects malformed payloads', async () => {
    configure()
    globalThis.fetch = Object.assign(
      mock(async () => new Response(null, { status: 503 })),
      { preconnect: originalFetch.preconnect },
    )
    expect((await POST(request(envelope(event)))).status).toBe(502)
    expect((await POST(request('invalid'))).status).toBe(400)
    expect((await POST(request(envelope({ ...event, event_id: 'invalid' })))).status).toBe(400)
  })

  test('collector transport failures return 502 while invalid UTF-8 remains a bad envelope', async () => {
    configure()
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError('fetch failed')
      },
      {
        preconnect: originalFetch.preconnect,
      },
    )
    expect((await POST(request(envelope(event)))).status).toBe(502)
    const invalid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]))
        controller.close()
      },
    })
    expect((await POST(request(invalid))).status).toBe(400)
  })
})

test('SDK sanitization removes request content and dynamic frame URLs', () => {
  const sanitized = JSON.stringify(sanitizeErrorEvent(structuredClone(event)))
  expect(sanitized).not.toContain('PRIVATE_SENTINEL')
  expect(sanitized).toContain('c'.repeat(32))
  expect(sanitized).toContain('chunk.js')
})

test('runtime browser configuration exposes only the public same-origin ingest DSN', () => {
  configure()
  expect(browserErrorConfig()?.dsn).toBe(publicDsn)
  expect(() => glitchTipDsn('http://key@169.254.169.254/4')).toThrow()
})
