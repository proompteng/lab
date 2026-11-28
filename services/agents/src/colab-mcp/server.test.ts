import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect, it, vi } from 'vitest'

import { McpRunIdentityError } from '../server/mcp-run-identity'
import { connectColabBridge } from './bridge'
import { resolveColabGatewayConfig } from './config'
import { createColabTokenProvider } from './oauth'
import { createColabGatewayHandler } from './server'
import { COLAB_TOOLS, createColabUpstream } from './upstream'

const identity = { agentRun: 'example-run', namespace: 'agents', serviceAccount: 'google-triage-runner' }
const url = new URL('http://agents-colab-mcp-gateway.agents.svc.cluster.local:8080/mcp')
const toolResult = (structuredContent: Record<string, unknown>): CallToolResult => ({ content: [], structuredContent })
type GoogleRequest = {
  id: string
  method: string
  params: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
}

const fixture = (
  options: { credentials?: boolean; callTool?: (rpc: GoogleRequest) => Promise<CallToolResult> } = {},
) => {
  let projectedToken = 'projected-runner-token'
  const readAdc = vi.fn(async () => {
    if (options.credentials === false) throw new Error('ENOENT')
    return '{"type":"authorized_user","client_id":"client","client_secret":"adc-secret","refresh_token":"refresh-token"}'
  })
  const exchange = vi.fn(async () => Response.json({ access_token: 'colab-only-access-token', expires_in: 3600 }))
  const tokens = createColabTokenProvider('/adc/credentials.json', { read: readAdc, fetch: exchange })
  const config = resolveColabGatewayConfig({})
  const google = vi.fn<FetchLike>(async (input, init) => {
    expect(String(input)).toBe('https://colaboratory.googleapis.com/mcp')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-goog-user-project')).toBe('proompteng')
    expect(headers.get('authorization')).toBe(options.credentials === false ? null : 'Bearer colab-only-access-token')
    expect(headers.get('accept')).toBe('application/json, text/event-stream')
    expect(headers.get('content-type')).toBe('application/json')
    const rpc = JSON.parse(String(init?.body)) as GoogleRequest
    const response = (result: unknown) => ({ jsonrpc: '2.0', id: rpc.id, result })
    if (rpc.method === 'initialize') {
      return Response.json(
        response({
          protocolVersion: rpc.params.protocolVersion,
          serverInfo: { name: 'test-colab', version: '1' },
          capabilities: { tools: {}, resources: {} },
        }),
      )
    }
    if (rpc.method === 'tools/list') {
      return Response.json(
        response({
          tools: [...COLAB_TOOLS, 'unexpected_new_tool'].map((name) => ({ name, inputSchema: { type: 'object' } })),
        }),
      )
    }
    const result = options.callTool ? await options.callTool(rpc) : toolResult({ stdout: '42\n' })
    if (rpc.params.name === 'execute_code') {
      const envelope = JSON.stringify(response(result), null, 2)
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\r\n')
      const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })
      return new Response(`: heartbeat\r\n\r\ndata: ${progress}\r\n\r\n${envelope}\r\n\r\n`, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
    }
    return Response.json(response(result))
  })
  const audit = vi.fn()
  const verify = vi.fn(async (candidate: string) => {
    if (candidate !== projectedToken) throw new McpRunIdentityError(401, 'invalid_token')
    return identity
  })
  const handle = createColabGatewayHandler({
    verify,
    upstream: createColabUpstream({ quotaProject: config.quotaProject, tokens, fetch: google }),
    credentialsReady: tokens.credentialsReady,
    maxConcurrentRuntimes: config.maxConcurrentRuntimes,
    audit,
  })
  const rpc = (method: string, params: Record<string, unknown> = {}, token = projectedToken) =>
    handle(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-goog-user-project': 'ignored-client-project',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    )
  return {
    handle,
    rpc,
    call: async (name: string, args = {}) => (await rpc('tools/call', { name, arguments: args })).json(),
    google,
    exchange,
    audit,
    verify,
    rotateToken: (token: string) => {
      projectedToken = token
    },
  }
}

it('proxies discovery and JSON/SSE tool results with only approved tools and redacted audit fields', async () => {
  const { rpc, call, google, exchange, audit } = fixture()
  const initialize = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'test-client', version: '1' },
    capabilities: {},
  })
  expect(await initialize.json()).toMatchObject({
    result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
  })
  const tools = (await (await rpc('tools/list')).json()).result.tools
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual([...COLAB_TOOLS])
  expect(await call('get_subscription')).toMatchObject({ result: { structuredContent: { stdout: '42\n' } } })
  const code = 'print(6 * 7) # private notebook'
  expect(await call('execute_code', { code, runtime: 'runtimes/cpu' })).toMatchObject({
    id: 1,
    result: { structuredContent: { stdout: '42\n' } },
  })
  expect(JSON.parse(String(google.mock.lastCall?.[1]?.body)).params).toEqual({
    name: 'execute_code',
    arguments: { code, runtime: 'runtimes/cpu' },
  })
  expect(exchange).toHaveBeenCalledTimes(1)
  expect(audit).toHaveBeenLastCalledWith({
    ...identity,
    tool: 'execute_code',
    status: 'ok',
    durationMs: expect.any(Number),
  })
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(/private notebook|access-token|adc-secret|stdout/)
  expect(await call('unexpected_new_tool')).toMatchObject({ error: { code: -32602 } })
  expect((await rpc('tools/call', { name: 'execute_code' }, 'wrong-audience-token')).status).toBe(401)
  expect(google).toHaveBeenCalledTimes(4)
})

it('stays reachable without ADC, and fails closed before any backend tool or OAuth request', async () => {
  const { handle, call, rpc, google, exchange, audit } = fixture({ credentials: false })
  const ready = await handle(new Request(new URL('/readyz', url)))
  expect(ready.status).toBe(503)
  expect(await ready.json()).toEqual({ credentialsReady: false })
  expect((await handle(new Request(new URL('/healthz', url)))).status).toBe(200)
  expect(await call('create_runtime', { runtime: {} })).toMatchObject({
    error: { data: { code: 'colab_credentials_unavailable' } },
  })
  expect(google).not.toHaveBeenCalled()
  expect(exchange).not.toHaveBeenCalled()
  expect(audit).toHaveBeenLastCalledWith({
    ...identity,
    tool: 'create_runtime',
    status: 'colab_credentials_unavailable',
    durationMs: expect.any(Number),
  })
  expect((await rpc('tools/list')).status).toBe(200)
  expect(google).toHaveBeenCalledTimes(1)
})

const fourRuntimes = () => ['one', 'two', 'three', 'four'].map((id) => ({ name: `runtimes/${id}` }))
const runtimeLimit = { error: { data: { code: 'colab_runtime_limit_reached' } } }

it('counts simultaneous and not-yet-listed creates against the five-runtime cap', async () => {
  const runtimes = fourRuntimes()
  let createCount = 0
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const { call } = fixture({
    callTool: async ({ params }) => {
      if (params.name === 'list_runtimes') return toolResult({ runtimes })
      if (params.name === 'delete_runtime') {
        runtimes.shift()
        return toolResult({})
      }
      expect(params.name).toBe('create_runtime')
      if (++createCount === 1) {
        started.resolve()
        await finish.promise
      }
      return toolResult({ name: `runtimes/${params.arguments?.runtimeId}` })
    },
  })
  const create = (runtimeId: string) => call('create_runtime', { runtime: {}, runtimeId })
  const first = create('fifth')
  try {
    await started.promise
    const denied = await create('sixth')
    expect(denied).toMatchObject(runtimeLimit)
    expect(denied.error.message).toContain('Reuse an active runtime or call delete_runtime first.')
  } finally {
    finish.resolve()
  }
  expect(await first).toMatchObject({ result: { structuredContent: { name: 'runtimes/fifth' } } })
  expect(await create('sixth')).toMatchObject(runtimeLimit)
  runtimes.push({ name: 'runtimes/fifth' })
  expect(await create('sixth')).toMatchObject(runtimeLimit)
  await call('delete_runtime', { name: 'runtimes/one' })
  expect(await create('sixth')).toMatchObject({ result: { structuredContent: { name: 'runtimes/sixth' } } })
  expect(createCount).toBe(2)
})

it('fails closed on an unverified count and retains the slot after an unconfirmed create', async () => {
  let list = toolResult({ notRuntimes: [] })
  const create = vi.fn<() => Promise<CallToolResult>>(async () => {
    throw new Error('socket lost while creating runtime')
  })
  const { call } = fixture({
    callTool: ({ params }) => (params.name === 'list_runtimes' ? Promise.resolve(list) : create()),
  })
  expect(await call('create_runtime', { runtime: {} })).toMatchObject({
    error: { data: { code: 'colab_runtime_count_unavailable' } },
  })
  expect(create).not.toHaveBeenCalled()
  list = toolResult({ runtimes: fourRuntimes() })
  create.mockResolvedValueOnce({
    isError: true,
    content: [{ type: 'text', text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }],
  })
  expect(await call('create_runtime', { runtime: {} })).toMatchObject({ result: { isError: true } })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'fifth' })).toMatchObject({
    error: { data: { code: 'colab_runtime_creation_unconfirmed' } },
  })
  expect(await call('create_runtime', { runtime: {} })).toMatchObject(runtimeLimit)
  expect(create).toHaveBeenCalledTimes(2)
})

it('bridges MCP discovery and calls with the rotated projected token, without network I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colab-bridge-test-'))
  const tokenPath = join(directory, 'token')
  const options = { credentials: true }
  const { handle, rotateToken, verify } = fixture(options)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' })
  let stop: Awaited<ReturnType<typeof connectColabBridge>> | undefined
  try {
    await writeFile(tokenPath, 'projected-runner-token\n')
    stop = await connectColabBridge(serverTransport, {
      gatewayUrl: url,
      tokenPath,
      fetch: (input, init) => handle(new Request(input, init)),
    })
    await client.connect(clientTransport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([...COLAB_TOOLS])
    await expect(
      client.callTool(
        { name: 'execute_code', arguments: { code: 'print(42)', runtime: 'runtimes/cpu' } },
        CallToolResultSchema,
      ),
    ).resolves.toMatchObject({ structuredContent: { stdout: '42\n' } })
    rotateToken('rotated-token')
    await writeFile(tokenPath, 'rotated-token')
    options.credentials = false
    await expect(client.callTool({ name: 'execute_code' }, CallToolResultSchema)).rejects.toMatchObject({
      data: { code: 'colab_credentials_unavailable' },
    })
    expect(verify).toHaveBeenLastCalledWith('rotated-token')
  } finally {
    await client.close()
    await stop?.()
    await rm(directory, { recursive: true, force: true })
  }
})
