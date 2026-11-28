import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, vi } from 'vitest'

import { createAutoOntologyUpstream } from './upstream'

const upstreamWith = (fetch: FetchLike, chatTimeoutMs = 25) =>
  createAutoOntologyUpstream({
    url: new URL('http://localhost:3000'),
    token: 'auto_ontology_test',
    maxResponseBytes: 1024,
    timeoutMs: 10_000,
    chatTimeoutMs,
    fetch,
  })
const signal = new AbortController().signal
const ask = (response: Response) => upstreamWith(async () => response).askQuestion({ question: 'Count rows' }, signal)
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })

describe('Auto Ontology upstream limits', () => {
  it('waits past the regular timeout for a JSON answerability response', async () => {
    const chatTimeoutMs = 75_000
    vi.useFakeTimers()
    // Native AbortSignal.timeout does not use Vitest's fake clock.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), ms)
      return controller.signal
    })
    try {
      const fetch = vi.fn<FetchLike>(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10_001))
        return Response.json({ answerable: true })
      })
      const result = upstreamWith(fetch, chatTimeoutMs).checkAnswerable({ question: 'Count rows' }, signal)
      await Promise.all([expect(result).resolves.toEqual({ answerable: true }), vi.advanceTimersByTimeAsync(10_001)])
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('accept')).toBe('application/json')
      expect(timeout).toHaveBeenCalledExactlyOnceWith(chatTimeoutMs)
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })

  it('cancels a stalled chat body within its deadline, even after headers arrive', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    await expect(ask(response)).rejects.toMatchObject({ code: 'upstream_timeout' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('limits decoded bytes even when upstream omits content length', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025))
      },
      cancel,
    })
    const response = new Response(stream, { headers: { 'content-type': 'application/json' } })
    await expect(upstreamWith(async () => response).get('/api/terms', signal)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('returns only the first 100 rows and records the original result size', async () => {
    const rows = Array.from({ length: 101 }, () => ({}))
    const event = { type: 'result', answer: { response: 'Found 101 rows', sql_response_from_db: rows } }
    const answer = await ask(sse(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`))
    expect(answer.rows).toHaveLength(100)
    expect(answer).toMatchObject({ row_count: 101, truncated: true })
  })

  it.each([
    ['data: {"type":"error","message":"private upstream error"}\n\n', 'upstream_chat_error'],
    ['data: {"type":"step"}\n\ndata: [DONE]\n\n', 'upstream_chat_incomplete'],
    ['data: {"type":"result","answer":{}}\n\n', 'upstream_invalid_response'],
    ['data: {broken\n\n', 'upstream_invalid_response'],
  ])('fails closed on an unsuccessful SSE response (%s)', async (message, code) => {
    await expect(ask(sse(message))).rejects.toMatchObject({ code })
  })

  it('does not accept an HTML login or error page as a successful response', async () => {
    await expect(
      ask(
        new Response('<html>Login</html>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'upstream_invalid_response' })
  })

  it('probes /api/health without x-api-key and fails closed when status is not ok', async () => {
    const seenHeaders: Headers[] = []
    const okUpstream = upstreamWith(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/api/health')
      seenHeaders.push(new Headers(init?.headers))
      return Response.json({ status: 'ok', postgres: { status: 'ok' } })
    })
    await expect(okUpstream.checkHealth(signal)).resolves.toMatchObject({ status: 'ok' })
    expect(seenHeaders[0]?.has('x-api-key')).toBe(false)

    const degradedUpstream = upstreamWith(async () => Response.json({ status: 'degraded' }))
    await expect(degradedUpstream.checkHealth(signal)).rejects.toMatchObject({ code: 'upstream_unhealthy' })
  })

  it('runs checkReadiness upstream calls sequentially to avoid API-key row-lock contention', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const upstream = upstreamWith(async (input) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      const path = new URL(String(input)).pathname
      inFlight -= 1
      if (path === '/api/semantic-compilation/status') return Response.json({ calculated: true })
      return Response.json({ data: [{ id: 'db-1', name: 'agents' }] })
    })
    await expect(upstream.checkReadiness(signal)).resolves.toEqual({
      ready: true,
      semantic_layer_built: true,
      catalog_present: true,
      databases: ['agents'],
    })
    expect(maxInFlight).toBe(1)
  })
})
