import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, vi } from 'vitest'

import { createAutoOntologyUpstream } from './upstream'

const upstreamWith = (fetch: FetchLike) =>
  createAutoOntologyUpstream({
    url: new URL('http://localhost:3000'),
    token: 'auto_ontology_test',
    maxResponseBytes: 1024,
    timeoutMs: 1000,
    chatTimeoutMs: 25,
    fetch,
  })
const signal = new AbortController().signal
const ask = (response: Response) => upstreamWith(async () => response).askQuestion({ question: 'Count rows' }, signal)
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })

describe('Auto Ontology upstream limits', () => {
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
})
