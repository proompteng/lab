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
import { ownerPrefix } from './policy'
import { createColabGatewayHandler } from './server'
import { COLAB_TOOLS, createColabUpstream } from './upstream'

const identity = { agentRun: 'example-run', namespace: 'agents', serviceAccount: 'google-triage-runner' }
const runCaller = `${identity.namespace}/${identity.agentRun}`
const runPrefix = ownerPrefix(runCaller)
const otherRunCaller = `${identity.namespace}/other-run`
const otherRunPrefix = ownerPrefix(otherRunCaller)
const ownedRuntime = (suffix: string, prefix = runPrefix) => `runtimes/${prefix}${suffix}`
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
    if (candidate === projectedToken) return identity
    if (candidate === 'other-run-token') return { ...identity, agentRun: 'other-run' }
    throw new McpRunIdentityError(401, 'invalid_token')
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
    call: async (name: string, args = {}, token = projectedToken) =>
      (await rpc('tools/call', { name, arguments: args }, token)).json(),
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
  const cpuRuntime = ownedRuntime('cpu')
  expect(await call('execute_code', { code, runtime: cpuRuntime })).toMatchObject({
    id: 1,
    result: { structuredContent: { stdout: '42\n' } },
  })
  expect(JSON.parse(String(google.mock.lastCall?.[1]?.body)).params).toEqual({
    name: 'execute_code',
    arguments: { code, runtime: cpuRuntime },
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

const fourRuntimes = () => [
  { name: ownedRuntime('one') },
  { name: ownedRuntime('two', otherRunPrefix) },
  { name: 'runtimes/personal-three' },
  { name: 'runtimes/personal-four' },
]
const runtimeLimit = { error: { data: { code: 'colab_runtime_limit_reached' } } }
const runtimeAlreadyReserved = { error: { data: { code: 'colab_runtime_already_reserved' } } }
const runtimeForbidden = { error: { data: { code: 'colab_runtime_forbidden' } } }
const deadlineExceededResult: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: '{"error":{"status":"DEADLINE_EXCEEDED"}}' }],
}

it('counts simultaneous and not-yet-listed creates against the five-runtime cap', async () => {
  const runtimes = fourRuntimes()
  let createCount = 0
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const { call } = fixture({
    callTool: async ({ params }) => {
      if (params.name === 'list_runtimes') return toolResult({ runtimes })
      if (params.name === 'delete_runtime') {
        const index = runtimes.findIndex((runtime) => runtime.name === params.arguments?.name)
        if (index >= 0) runtimes.splice(index, 1)
        return toolResult({})
      }
      expect(params.name).toBe('create_runtime')
      if (++createCount === 1) {
        started.resolve()
        await finish.promise
      }
      return toolResult({
        name: `runtimes/${params.arguments?.runtimeId}`,
        connectionInfo: { url: 'https://proxy.example', token: 'secret-proxy-token' },
      })
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
  const firstResult = await first
  expect(firstResult).toMatchObject({ result: { structuredContent: { name: ownedRuntime('fifth') } } })
  expect(firstResult.result.structuredContent).not.toHaveProperty('connectionInfo')
  expect(await create('sixth')).toMatchObject(runtimeLimit)
  runtimes.push({ name: ownedRuntime('fifth') })
  expect(await create('sixth')).toMatchObject(runtimeLimit)
  expect(await call('delete_runtime', { name: 'runtimes/personal-three' })).toMatchObject(runtimeForbidden)
  await call('delete_runtime', { name: ownedRuntime('one') })
  expect(await create('sixth')).toMatchObject({ result: { structuredContent: { name: ownedRuntime('sixth') } } })
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

it('allows matching idempotent create_runtime retries after DEADLINE_EXCEEDED at 5/5 capacity while rejecting conflicts', async () => {
  const runtimes = fourRuntimes()
  const requestId = '11111111-1111-4111-8111-111111111111'
  const otherRequestId = '22222222-2222-4222-8222-222222222222'
  let attempt = 0
  const retryStarted = Promise.withResolvers<void>()
  const finishRetry = Promise.withResolvers<void>()
  const { call } = fixture({
    callTool: async ({ params }) => {
      if (params.name === 'list_runtimes') return toolResult({ runtimes })
      if (params.name === 'delete_runtime') {
        const index = runtimes.findIndex((runtime) => runtime.name === params.arguments?.name)
        if (index >= 0) runtimes.splice(index, 1)
        return toolResult({})
      }
      expect(params.name).toBe('create_runtime')
      attempt++
      if (attempt === 1) return deadlineExceededResult
      if (attempt === 2) {
        retryStarted.resolve()
        await finishRetry.promise
      }
      return toolResult({ name: `runtimes/${params.arguments?.runtimeId}` })
    },
  })

  // 1. Initial create_runtime at 4/5 returns DEADLINE_EXCEEDED and retains its 5th slot.
  expect(
    await call('create_runtime', {
      runtime: { region: 'us-central1', machineType: 'n1-standard-4' },
      runtimeId: 'fifth',
      requestId,
    }),
  ).toMatchObject({ result: { isError: true } })

  // 2. Brand-new runtimeId at 5/5 is rejected by capacity limit.
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth', requestId: otherRequestId })).toMatchObject(
    runtimeLimit,
  )

  // 3. Conflicting requestId, mutated runtime spec, or different AgentRun cannot hijack the reserved slot.
  expect(
    await call('create_runtime', {
      runtime: { region: 'us-central1', machineType: 'n1-standard-4' },
      runtimeId: 'fifth',
      requestId: otherRequestId,
    }),
  ).toMatchObject(runtimeAlreadyReserved)
  expect(
    await call('create_runtime', {
      runtime: { region: 'us-central1', machineType: 'a2-highgpu-1g' },
      runtimeId: 'fifth',
      requestId,
    }),
  ).toMatchObject(runtimeAlreadyReserved)
  // Another AgentRun using the same short runtimeId gets its own prefix and hits the global 5/5 limit.
  expect(
    await call(
      'create_runtime',
      {
        runtime: { region: 'us-central1', machineType: 'n1-standard-4' },
        runtimeId: 'fifth',
        requestId,
      },
      'other-run-token',
    ),
  ).toMatchObject(runtimeLimit)
  // Another AgentRun attempting to spoof Run A's prefixed runtimeId is rejected as forbidden before upstream.
  expect(
    await call(
      'create_runtime',
      {
        runtime: { region: 'us-central1', machineType: 'n1-standard-4' },
        runtimeId: `${runPrefix}fifth`,
        requestId,
      },
      'other-run-token',
    ),
  ).toMatchObject(runtimeForbidden)

  // 4. Matching idempotent retry (case-insensitive UUID, equivalent runtime key order) succeeds at 5/5 capacity.
  const retry = call('create_runtime', {
    runtime: { machineType: 'n1-standard-4', region: 'us-central1' },
    runtimeId: 'fifth',
    requestId: requestId.toUpperCase(),
  })
  try {
    await retryStarted.promise
    // A concurrent duplicate retry while the first retry is still in-flight is rejected.
    expect(
      await call('create_runtime', {
        runtime: { machineType: 'n1-standard-4', region: 'us-central1' },
        runtimeId: 'fifth',
        requestId,
      }),
    ).toMatchObject(runtimeAlreadyReserved)
  } finally {
    finishRetry.resolve()
  }
  expect(await retry).toMatchObject({ result: { structuredContent: { name: ownedRuntime('fifth') } } })

  // 5. Reservation settles cleanly without double-counting once observed by list_runtimes and freed on delete.
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth' })).toMatchObject(runtimeLimit)
  runtimes.push({ name: ownedRuntime('fifth') })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth' })).toMatchObject(runtimeLimit)
  await call('delete_runtime', { name: ownedRuntime('one') })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth' })).toMatchObject({
    result: { structuredContent: { name: ownedRuntime('sixth') } },
  })
  expect(attempt).toBe(3)
})

it('releases a reserved slot when a retried create_runtime permanently fails, and preserves it on ALREADY_EXISTS', async () => {
  const runtimes = fourRuntimes()
  const requestId = '33333333-3333-4333-8333-333333333333'
  const responses: CallToolResult[] = [
    deadlineExceededResult,
    { isError: true, content: [{ type: 'text', text: '{"error":{"status":"ALREADY_EXISTS"}}' }] },
    { isError: true, content: [{ type: 'text', text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }] },
    toolResult({ name: ownedRuntime('sixth') }),
  ]
  const create = vi.fn(async () => responses.shift()!)
  const { call } = fixture({
    callTool: async ({ params }) => (params.name === 'list_runtimes' ? toolResult({ runtimes }) : create()),
  })

  // Initial create times out -> slot retained.
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'fifth', requestId })).toMatchObject({
    result: { isError: true },
  })
  // Retry gets ALREADY_EXISTS before list_runtimes catches up -> slot stays retained (not undercounted).
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'fifth', requestId })).toMatchObject({
    result: { isError: true },
  })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth' })).toMatchObject(runtimeLimit)
  // Retry permanently fails with RESOURCE_EXHAUSTED -> reservation released so a new runtime fits.
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'fifth', requestId })).toMatchObject({
    result: { isError: true },
  })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth' })).toMatchObject({
    result: { structuredContent: { name: ownedRuntime('sixth') } },
  })
  expect(create).toHaveBeenCalledTimes(4)
})

it('allows a matching idempotent retry even if Google already listed the runtime after DEADLINE_EXCEEDED', async () => {
  const runtimes = fourRuntimes()
  const requestId = '44444444-4444-4444-8444-444444444444'
  let attempt = 0
  const { call } = fixture({
    callTool: async ({ params }) => {
      if (params.name === 'list_runtimes') return toolResult({ runtimes })
      expect(params.name).toBe('create_runtime')
      if (++attempt === 1) return deadlineExceededResult
      return toolResult({ name: ownedRuntime('fifth') })
    },
  })

  expect(await call('create_runtime', { runtime: {}, runtimeId: 'fifth', requestId })).toMatchObject({
    result: { isError: true },
  })
  // Google finished creating the runtime before the client retried the identical request.
  runtimes.push({ name: ownedRuntime('fifth') })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'fifth', requestId })).toMatchObject({
    result: { structuredContent: { name: ownedRuntime('fifth') } },
  })
  expect(await call('create_runtime', { runtime: {}, runtimeId: 'sixth' })).toMatchObject(runtimeLimit)
  expect(attempt).toBe(2)
})

it('isolates runtimes and sessions per verified AgentRun and strips proxy credentials across gateway calls', async () => {
  const runARuntime = ownedRuntime('gpu-a')
  const runBRuntime = ownedRuntime('gpu-b', otherRunPrefix)
  const humanRuntime = 'runtimes/personal-human-gpu'
  const runASession = `${runARuntime}/sessions/sess-a1`
  const runBSession = `${runBRuntime}/sessions/sess-b1`
  const upstreamRuntimes = [
    {
      name: runARuntime,
      state: 'RUNNING',
      connectionInfo: { url: 'https://proxy-a.example', token: 'token-a' },
      proxy_token: 'proxy-secret-a',
    },
    {
      name: runBRuntime,
      state: 'RUNNING',
      connection_info: { url: 'https://proxy-b.example', access_token: 'token-b' },
      accessToken: 'access-secret-b',
    },
    {
      name: humanRuntime,
      state: 'RUNNING',
      connectionInfo: { url: 'https://proxy-human.example', token: 'token-human' },
    },
  ]

  const upstreamCall = vi.fn(async ({ params }: GoogleRequest): Promise<CallToolResult> => {
    if (params.name === 'list_runtimes') {
      return {
        structuredContent: { runtimes: upstreamRuntimes },
        content: [{ type: 'text', text: JSON.stringify({ runtimes: upstreamRuntimes }) }],
      }
    }
    if (params.name === 'get_runtime') {
      const match = upstreamRuntimes.find((r) => r.name === params.arguments?.name)
      return {
        structuredContent: match,
        content: [{ type: 'text', text: JSON.stringify(match) }],
      }
    }
    return toolResult({ ok: true })
  })

  const { call, google } = fixture({ callTool: upstreamCall })

  // Run B sees only its own runtime in both structuredContent and content text, with credentials stripped.
  const listB = await call('list_runtimes', {}, 'other-run-token')
  expect(listB.result.structuredContent).toEqual({
    runtimes: [{ name: runBRuntime, state: 'RUNNING' }],
  })
  expect(JSON.parse(listB.result.content[0].text)).toEqual({
    runtimes: [{ name: runBRuntime, state: 'RUNNING' }],
  })
  expect(JSON.stringify(listB)).not.toMatch(
    /gpu-a|personal-human|token-a|token-b|proxy-secret|access-secret|connectionInfo|connection_info/,
  )

  // Run B can inspect its own runtime without receiving connectionInfo or tokens.
  const getB = await call('get_runtime', { name: runBRuntime }, 'other-run-token')
  expect(getB.result.structuredContent).toEqual({ name: runBRuntime, state: 'RUNNING' })
  expect(JSON.parse(getB.result.content[0].text)).toEqual({ name: runBRuntime, state: 'RUNNING' })

  const callsBeforeForbidden = google.mock.calls.length

  // Run B is rejected BEFORE upstream for every cross-run, human, and traversal target.
  const forbiddenCalls: Array<[string, Record<string, unknown>]> = [
    ['get_runtime', { name: runARuntime }],
    ['get_runtime', { name: humanRuntime }],
    ['get_runtime', { name: `${runBRuntime}/../${runPrefix}gpu-a` }],
    ['delete_runtime', { name: runARuntime }],
    ['delete_runtime', { runtime_name: runARuntime }],
    ['list_sessions', { parent: runARuntime }],
    ['create_session', { parent: runARuntime }],
    ['delete_session', { name: runASession }],
    ['delete_session', { session: `${runBRuntime}/sessions/../other` }],
    ['execute_code', { code: 'print(1)', session: runASession }],
    ['execute_code', { code: 'print(1)', runtime: runARuntime }],
    ['execute_code', { code: 'print(1)', runtime: runBRuntime, session: runASession }],
    ['execute_code', { code: 'print(1)', runtime: `${runBRuntime}/../${runPrefix}gpu-a` }],
  ]
  for (const [toolName, toolArgs] of forbiddenCalls) {
    expect(await call(toolName, toolArgs, 'other-run-token')).toMatchObject(runtimeForbidden)
  }
  expect(google).toHaveBeenCalledTimes(callsBeforeForbidden)

  // Run B succeeds on its own session/runtime tools.
  expect(await call('list_sessions', { parent: runBRuntime }, 'other-run-token')).toMatchObject({
    result: { structuredContent: { ok: true } },
  })
  expect(await call('create_session', { parent: runBRuntime }, 'other-run-token')).toMatchObject({
    result: { structuredContent: { ok: true } },
  })
  expect(await call('execute_code', { code: 'print(1)', session: runBSession }, 'other-run-token')).toMatchObject({
    result: { structuredContent: { ok: true } },
  })
  expect(await call('delete_session', { name: runBSession }, 'other-run-token')).toMatchObject({
    result: { structuredContent: { ok: true } },
  })
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
    const cpuRuntime = ownedRuntime('cpu')
    await expect(
      client.callTool(
        { name: 'execute_code', arguments: { code: 'print(42)', runtime: cpuRuntime } },
        CallToolResultSchema,
      ),
    ).resolves.toMatchObject({ structuredContent: { stdout: '42\n' } })
    rotateToken('rotated-token')
    await writeFile(tokenPath, 'rotated-token')
    options.credentials = false
    await expect(
      client.callTool(
        { name: 'execute_code', arguments: { code: 'print(42)', runtime: cpuRuntime } },
        CallToolResultSchema,
      ),
    ).rejects.toMatchObject({
      data: { code: 'colab_credentials_unavailable' },
    })
    expect(verify).toHaveBeenLastCalledWith('rotated-token')
  } finally {
    await client.close()
    await stop?.()
    await rm(directory, { recursive: true, force: true })
  }
})
