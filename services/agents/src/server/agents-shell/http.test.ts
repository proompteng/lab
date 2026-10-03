import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthVerifier, type AuthContext } from './auth'
import { defaultAgentsShellConfigFromEnv } from './config'
import { createAgentsShellRequestHandler } from './http'
import { AgentsShellRunner } from './runner'

const roots: string[] = []
const receiptSchema = Schema.Struct({
  msg: Schema.Literal('agents-shell http request'),
  requestId: Schema.String.pipe(Schema.pattern(/^[0-9a-f-]{36}$/)),
  method: Schema.String,
  path: Schema.String,
  phase: Schema.Literal('routing', 'authorization', 'connect', 'transport', 'close'),
  event: Schema.Literal('started', 'phase', 'aborted', 'failed', 'completed'),
  aborted: Schema.Boolean,
  durationMs: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
  status: Schema.optional(Schema.Number),
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-http-'))
  roots.push(root)
  const config = defaultAgentsShellConfigFromEnv({
    AGENTS_SHELL_WORKSPACE_ROOT: root,
    AGENTS_SHELL_AUDIT_LOG_PATH: '',
    AGENTS_SHELL_RESOURCE: 'https://shell.example.test',
    AGENTS_SHELL_OAUTH_ISSUER: 'https://auth.example.test',
  })
  const runner = new AgentsShellRunner(config)
  const handler = createAgentsShellRequestHandler(config, runner)
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const receipts = () =>
    info.mock.calls.map(([line]) => {
      if (typeof line !== 'string') throw new Error('expected a JSON diagnostic')
      const parsed: unknown = JSON.parse(line)
      return Schema.decodeUnknownSync(receiptSchema, { onExcessProperty: 'error' })(parsed)
    })
  return { handler, runner, receipts }
}

const listRequest = (init: RequestInit & { duplex?: 'half' } = {}) =>
  new Request('https://shell.example.test/mcp?private-query-value', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'private-header-value',
      cookie: 'private-cookie-value',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    ...init,
  })

const authorized: AuthContext = {
  subject: 'http-test-owner',
  email: null,
  username: null,
  scopes: new Set(['agents-shell.read', 'agents-shell.write']),
  payload: {},
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Agents Shell HTTP receipts', () => {
  it('correlates early phases and response without private request fields', async () => {
    const { handler, receipts } = fixture()
    const response = await handler(listRequest())
    expect(response.status).toBe(200)
    const entries = receipts()
    expect(entries.map(({ event, phase }) => [event, phase])).toEqual([
      ['started', 'routing'],
      ['phase', 'authorization'],
      ['phase', 'connect'],
      ['phase', 'transport'],
      ['phase', 'close'],
      ['completed', 'close'],
    ])
    expect(new Set(entries.map(({ requestId }) => requestId)).size).toBe(1)
    expect(response.headers.get('x-agents-shell-request-id')).toBe(entries[0]?.requestId)
    expect(entries.at(-1)).toMatchObject({ status: 200, aborted: false })
    expect(JSON.stringify(entries)).not.toContain('private-')
    await expect(response.json()).resolves.toMatchObject({ result: { tools: expect.any(Array) } })
  })

  it('records a stalled body before admission and observes abort without terminating handling', async () => {
    const { handler, runner, receipts } = fixture()
    const abort = new AbortController()
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    const request = listRequest({ body: stream.readable, signal: abort.signal, duplex: 'half' })
    const remove = vi.spyOn(request.signal, 'removeEventListener')
    const pending = handler(request)
    await vi.waitFor(() => expect(receipts().at(-1)).toMatchObject({ event: 'phase', phase: 'transport' }))
    expect(receipts().some(({ event }) => event === 'completed')).toBe(false)
    expect(runner.runningJobs()).toHaveLength(0)
    abort.abort(new Error('private-abort-reason'))
    expect(receipts().filter(({ event }) => event === 'aborted')).toEqual([
      expect.objectContaining({ phase: 'transport', aborted: true }),
    ])
    await writer.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })))
    await writer.close()
    const response = await pending
    expect(response.status).toBe(200)
    expect(receipts().at(-1)).toMatchObject({ event: 'completed', status: 200, aborted: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(JSON.stringify(receipts())).not.toContain('private-abort-reason')
  })

  it('records an abort while authorization waits and removes the observer afterward', async () => {
    const { handler, receipts } = fixture()
    const verified = Promise.withResolvers<AuthContext>()
    vi.spyOn(AuthVerifier.prototype, 'verify').mockReturnValue(verified.promise)
    const abort = new AbortController()
    const request = listRequest({
      signal: abort.signal,
      headers: {
        authorization: 'Bearer private-bearer-value',
        'content-type': 'application/json',
      },
    })
    const remove = vi.spyOn(request.signal, 'removeEventListener')
    const pending = handler(request)
    expect(receipts().at(-1)).toMatchObject({ phase: 'authorization' })
    abort.abort('private-abort-value')
    expect(receipts().at(-1)).toMatchObject({ event: 'aborted', phase: 'authorization' })
    verified.resolve(authorized)
    expect((await pending).status).toBe(200)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(receipts().filter(({ event }) => event === 'aborted')).toHaveLength(1)
    expect(JSON.stringify(receipts())).not.toContain('private-')
  })

  it('handles an already aborted request once and ignores aborts after completion', async () => {
    const { handler, receipts } = fixture()
    const before = new AbortController()
    before.abort('private-preabort')
    expect((await handler(listRequest({ signal: before.signal }))).status).toBe(200)
    expect(receipts().filter(({ event }) => event === 'aborted')).toHaveLength(1)
    const after = new AbortController()
    await handler(listRequest({ signal: after.signal }))
    const count = receipts().length
    after.abort('private-late-abort')
    expect(receipts()).toHaveLength(count)
  })

  it('records an escaped transport failure safely and preserves its response', async () => {
    const { handler, receipts } = fixture()
    const request = listRequest()
    const remove = vi.spyOn(request.signal, 'removeEventListener')
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValue(
      new Error('private-error-value'),
    )
    const response = await handler(request)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'mcp_request_failed', detail: 'private-error-value' })
    expect(receipts().filter(({ event }) => event === 'failed')).toEqual([
      expect.objectContaining({ phase: 'transport' }),
    ])
    expect(receipts().at(-1)).toMatchObject({ event: 'completed', status: 500 })
    expect(JSON.stringify(receipts())).not.toContain('private-error-value')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('preserves scope challenges and matches HTTP IDs to tool admission IDs', async () => {
    const { handler, runner, receipts } = fixture()
    const response = await handler(
      listRequest({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'shell_run', arguments: { command: 'printf should-not-run' } },
        }),
      }),
    )
    const requestId = response.headers.get('x-agents-shell-request-id')
    expect(response.status).toBe(200)
    const result: unknown = await response.json()
    expect(result).toMatchObject({
      result: {
        isError: true,
        _meta: { 'agents-shell/trace': { requestId }, 'mcp/www_authenticate': expect.any(Array) },
      },
    })
    expect(runner.runningJobs()).toHaveLength(0)
    expect(receipts().every((entry) => entry.requestId === requestId)).toBe(true)
  })

  it('reports malformed transport requests and excludes arbitrary method strings and unknown paths', async () => {
    const { handler, receipts } = fixture()
    expect((await handler(listRequest({ body: '{invalid' }))).status).toBe(400)
    expect(receipts().at(-1)).toMatchObject({ event: 'completed', status: 400 })
    const response = await handler(listRequest({ method: 'PRIVATEVALUE', body: undefined }))
    expect(response.status).toBe(405)
    expect(receipts().at(-1)).toMatchObject({ method: 'OTHER', status: 405 })
    const count = receipts().length
    expect((await handler(new Request('https://shell.example.test/private-path'))).status).toBe(404)
    expect((await handler(new Request('https://shell.example.test/healthz'))).status).toBe(200)
    expect(receipts()).toHaveLength(count)
    expect(JSON.stringify(receipts())).not.toContain('PRIVATEVALUE')
  })

  it('keeps concurrently handled requests distinct', async () => {
    const { handler, receipts } = fixture()
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        handler(
          listRequest({
            body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }),
          }),
        ),
      ),
    )
    expect(responses.every(({ status }) => status === 200)).toBe(true)
    const ids = responses.map((response) => response.headers.get('x-agents-shell-request-id'))
    expect(new Set(ids).size).toBe(8)
    for (const requestId of ids) {
      const entries = receipts().filter((entry) => entry.requestId === requestId)
      expect(entries[0]?.event).toBe('started')
      expect(entries.at(-1)).toMatchObject({ event: 'completed', status: 200 })
    }
  })
})
