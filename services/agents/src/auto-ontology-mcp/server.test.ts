import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

import { McpRunIdentityError } from '../server/mcp-run-identity'
import { createAutoOntologyGatewayHandler } from './server'
import { createAutoOntologyUpstream } from './upstream'

const gatewayUrl = new URL('http://gateway.test/mcp')
const apiUrl = new URL('http://frontend.auto-ontology.svc.cluster.local:3000')
const apiToken = 'auto_ontology_test'

const fixture = (overrides: Partial<Parameters<typeof createAutoOntologyUpstream>[0]> = {}) => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    expect(url.origin).toBe(apiUrl.origin)
    if (url.pathname === '/api/health') {
      expect(headers.has('x-api-key')).toBe(false)
    } else {
      expect(headers.get('x-api-key')).toBe(apiToken)
    }
    expect(headers.has('authorization')).toBe(false)
    expect(init?.redirect).toBe('error')
    calls.push({
      method,
      path: url.pathname + url.search,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    })
    if (url.pathname === '/api/health') return Response.json({ status: 'ok', postgres: { status: 'ok' } })
    if (url.pathname === '/api/semantic-compilation/status') return Response.json({ calculated: true })
    if (url.pathname === '/api/datasources/dbs') return Response.json({ data: [{ id: 'db-1', name: 'warehouse' }] })
    if (url.pathname === '/api/chat/completions') {
      expect(headers.get('accept')).toBe('text/event-stream')
      return new Response(
        ': ping\r\n\r\ndata: {"type":"step","label":"Querying"}\r\n\r\n' +
          'data: {"type":"result","answer":{"response":"One café","sql_code":"SELECT 1","sql_response_from_db":["[{\\"count\\":1}]"]}}\r\n\r\n' +
          'data: [DONE]\r\n\r\n',
        { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      )
    }
    return Response.json({ data: [], count: 0 })
  })
  const verify = vi.fn(async (token: string) => {
    if (token !== 'runner-token') throw new McpRunIdentityError(403, 'identity_denied')
  })
  const upstream = createAutoOntologyUpstream({
    url: apiUrl,
    token: apiToken,
    maxResponseBytes: 1024,
    timeoutMs: 1000,
    chatTimeoutMs: 1000,
    fetch,
    ...overrides,
  })
  const handler = createAutoOntologyGatewayHandler({ verify, upstream, maxRequestBytes: 1024 })
  const client = new Client({ name: 'fixture', version: '1' })
  const transport = new StreamableHTTPClientTransport(gatewayUrl, {
    fetch: (input, init) => handler(new Request(input, init)),
    requestInit: { headers: { authorization: 'Bearer runner-token' } },
  })
  return { calls, fetch, verify, handler, client, transport, upstream }
}

const mcpRequest = (body: string | ReadableStream<Uint8Array>, overrides: HeadersInit = {}) => {
  const headers = new Headers({
    authorization: 'Bearer runner-token',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  })
  new Headers(overrides).forEach((value, key) => headers.set(key, value))
  const init = { method: 'POST', headers, body, duplex: 'half' as const }
  return new Request(gatewayUrl, init)
}

const exposedTools = [
  'check_readiness',
  'search_terms',
  'get_term',
  'get_term_columns',
  'get_term_sql_attributes',
  'get_sql_attribute',
  'describe_table',
  'list_acronyms',
  'list_rules',
  'list_custom_analyses',
  'check_answerable',
  'ask_question',
]

describe('Auto Ontology Streamable HTTP gateway', () => {
  it('advertises only curated read-only tools and uses the pinned REST paths and argument shapes', async () => {
    const { client, transport, calls, verify } = fixture()
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map(({ name }) => name)).toEqual(exposedTools)
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
        expect(tool.inputSchema.additionalProperties).toBe(false)
      }
      const call = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args }, CallToolResultSchema)
      expect((await call('check_readiness')).structuredContent).toEqual({
        ready: true,
        semantic_layer_built: true,
        catalog_present: true,
        databases: ['warehouse'],
      })
      await call('search_terms', { query: 'net & gross', skip: 5, limit: 2 })
      await call('get_term', { term_id: 'term-1' })
      await call('get_term_columns', { term_id: 'term-1' })
      await call('get_term_sql_attributes', { term_id: 'term-1', skip: 25 })
      await call('get_sql_attribute', { attr_id: 'att-1' })
      await call('describe_table', { table_id: 'table-1', limit: 1 })
      await call('list_acronyms')
      await call('list_rules', { query: 'test' })
      await call('list_custom_analyses')
      await call('check_answerable', { question: 'What is net revenue?', max_distance: 0.5 })
      const answer = await call('ask_question', { question: 'What is net revenue?', evidence: 'Use USD' })
      expect(answer.structuredContent).toEqual({
        answer: 'One café',
        sql: 'SELECT 1',
        rows: [{ count: 1 }],
        row_count: 1,
        truncated: false,
      })
      expect(calls).toEqual([
        { method: 'GET', path: '/api/semantic-compilation/status' },
        { method: 'GET', path: '/api/datasources/dbs' },
        { method: 'GET', path: '/api/terms?skip=5&limit=2&query=net+%26+gross' },
        { method: 'GET', path: '/api/terms/term-1' },
        { method: 'GET', path: '/api/terms/term-1/column-attributes?limit=25' },
        { method: 'GET', path: '/api/terms/term-1/sql-attributes?skip=25&limit=25' },
        { method: 'GET', path: '/api/sql-attributes/att-1' },
        { method: 'GET', path: '/api/exploration/tables/table-1/details?limit=1' },
        { method: 'GET', path: '/api/acronyms' },
        { method: 'GET', path: '/api/rules?limit=25&query=test' },
        { method: 'GET', path: '/api/custom-analyses?limit=25' },
        {
          method: 'POST',
          path: '/api/question-entity-coverage',
          body: { question: 'What is net revenue?', max_distance: 0.5 },
        },
        {
          method: 'POST',
          path: '/api/chat/completions',
          body: { question: 'What is net revenue?', evidence: 'Use USD' },
        },
      ])
      expect(verify).toHaveBeenCalledWith('runner-token')
      expect(verify.mock.calls.length).toBeGreaterThan(exposedTools.length)
    } finally {
      await client.close()
    }
  })

  it('denies mutation tools, unsafe IDs, unexpected arguments and invalid pagination before sending HTTP', async () => {
    const { client, transport, fetch } = fixture()
    await client.connect(transport)
    try {
      for (const [name, args, code] of [
        ['delete_term', {}, 'tool_not_exposed'],
        ['constructor', {}, 'tool_not_exposed'],
        ['get_term', { term_id: '..' }, 'argument_denied'],
        ['get_term', { term_id: 'x%2f..' }, 'argument_denied'],
        ['get_term', { term_id: 'x/../../connections' }, 'argument_denied'],
        ['get_term', { term_id: 'valid', url: 'https://example.com' }, 'argument_denied'],
        ['search_terms', { limit: 101 }, 'argument_denied'],
        ['search_terms', { limit: '25' }, 'argument_denied'],
        ['ask_question', { question: 'Read data', conversation_id: 'persist-it' }, 'argument_denied'],
        ['ask_question', { question: 'Read data', target_db: 'other' }, 'argument_denied'],
        ['ask_question', { question: ' ' }, 'argument_denied'],
      ] as const) {
        const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
        expect(result).toMatchObject({ isError: true, structuredContent: { error: code } })
      }
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('requires projected identity and rejects malformed or oversized HTTP requests', async () => {
    const { handler, verify, fetch } = fixture()
    expect((await handler(mcpRequest('{}', { authorization: '' }))).status).toBe(401)
    expect((await handler(mcpRequest('{}', { authorization: 'Bearer wrong-token' }))).status).toBe(403)
    expect((await handler(mcpRequest('{}', { origin: 'https://untrusted.test' }))).status).toBe(403)
    expect((await handler(mcpRequest('{}', { 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await handler(new Request(gatewayUrl))).status).toBe(405)
    expect((await handler(mcpRequest('{malformed'))).status).toBe(400)
    expect((await handler(mcpRequest('{}', { 'content-length': '1025' }))).status).toBe(413)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(900))
        controller.enqueue(new Uint8Array(200))
        controller.close()
      },
    })
    expect((await handler(mcpRequest(stream))).status).toBe(413)
    expect(fetch).not.toHaveBeenCalled()
    verify.mockRejectedValueOnce(new Error('private Kubernetes API response'))
    const response = await handler(mcpRequest('{}'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'identity_unavailable' })
  })

  it('probes unauthenticated upstream /api/health for /readyz and reports uncompiled catalog via check_readiness', async () => {
    const { handler, fetch, upstream } = fixture()
    fetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.pathname === '/api/health') {
        expect(headers.has('x-api-key')).toBe(false)
        return Response.json({ status: 'ok', postgres: { status: 'ok' } })
      }
      expect(headers.get('x-api-key')).toBe(apiToken)
      return Response.json(url.pathname.endsWith('/status') ? { calculated: false } : { data: [] })
    })
    expect(await upstream.checkReadiness()).toMatchObject({ ready: false, catalog_present: false })
    expect((await handler(new Request(new URL('/readyz', gatewayUrl)))).status).toBe(200)
    fetch.mockImplementation(async () => Response.json({ status: 'degraded' }))
    expect((await handler(new Request(new URL('/readyz', gatewayUrl)))).status).toBe(503)
    fetch.mockImplementation(async () => new Response('private upstream response', { status: 401 }))
    expect((await handler(new Request(new URL('/readyz', gatewayUrl)))).status).toBe(503)
    expect((await handler(new Request(new URL('/healthz', gatewayUrl)))).status).toBe(200)
    await expect(upstream.get('/api/terms', new AbortController().signal)).rejects.toThrow(
      'Auto Ontology returned HTTP 401',
    )
  })
})
