import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchAgentRunLogsFromAgentsService } from './agent-run-logs-client'
import {
  fetchAgentRunFromAgentsService,
  fetchAgentRunResourcesFromAgentsService,
  patchAgentRunAnnotationsViaAgentsService,
} from './agent-runs-client'
import { fetchAgentRunsFromAgentsService, submitAgentRunToAgentsService } from './agent-runs-client'
import { submitAgentMessagesToAgentsService } from './agent-messages-client'
import { buildAgentsDependencyHealth, fetchAgentsHealthFromAgentsService } from './agents-health-client'
import {
  AgentsHttpStatusError,
  AgentsTransportError,
  fetchAgentsJson,
  fetchAgentsJsonEffect,
  makeAgentsHttpClientLayer,
  postAgentsJsonEffect,
  resolveAgentsServiceBaseUrl,
} from './agents-http'
import { fetchExecutionTrustFromAgentsService } from './execution-trust-client'
import { submitOrchestrationRunToAgentsService } from './orchestration-runs-client'
import {
  countMemoryNotesFromAgentsService,
  fetchMemoryNotesStatsFromAgentsService,
  fetchMemoryResourceFromAgentsService,
  MAX_MEMORY_NOTE_CONTENT_CHARS,
  MAX_MEMORY_NOTE_SUMMARY_CHARS,
  parsePersistMemoryNoteInput,
  parseRetrieveMemoryNotesInput,
  persistMemoryNoteToAgentsService,
  retrieveMemoryNotesFromAgentsService,
  submitMemoryOperationToAgentsService,
} from './memory-client'
import { submitSwarmRequirementSignalToAgentsService } from './signals-client'
import { fetchStageTargetResourceFromAgentsService, fetchSwarmResourcesFromAgentsService } from './swarm-read-client'

const originalFetch = globalThis.fetch
const getHeader = (headers: RequestInit['headers'], name: string) =>
  headers instanceof Headers ? headers.get(name) : ((headers as Record<string, string> | undefined)?.[name] ?? null)

describe('agents typed service clients', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('defaults to the in-cluster Agents service', () => {
    expect(resolveAgentsServiceBaseUrl({})).toBe('http://agents.agents.svc.cluster.local')
  })

  it('normalizes explicit Agents service base URLs', () => {
    expect(resolveAgentsServiceBaseUrl({ AGENTS_SERVICE_BASE_URL: 'http://agents.test///' })).toBe('http://agents.test')
  })

  it('fetches Agents service JSON contracts without importing Agents runtime modules', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentsJson<{ status: string }>('/health', {
      AGENTS_SERVICE_BASE_URL: 'http://agents.test',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/health')
    expect(init.method).toBe('GET')
    expect(getHeader(init.headers, 'accept')).toBe('application/json')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { status: 'ok' },
    })
  })

  it('classifies transport failures in the Effect boundary and preserves legacy failure results', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED')
    })
    const env = { AGENTS_SERVICE_BASE_URL: 'http://agents.test' }
    const effectResult = await Effect.runPromise(
      fetchAgentsJsonEffect<{ status: string }>('/health', env).pipe(
        Effect.provide(makeAgentsHttpClientLayer({ fetch: fetchMock as unknown as typeof fetch })),
        Effect.either,
      ),
    )

    expect(effectResult._tag).toBe('Left')
    if (effectResult._tag === 'Left') {
      expect(effectResult.left).toBeInstanceOf(AgentsTransportError)
      expect(effectResult.left).toMatchObject({
        method: 'GET',
        url: 'http://agents.test/health',
      })
    }

    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    await expect(fetchAgentsJson('/health', env)).resolves.toEqual({
      ok: false,
      status: 0,
      body: null,
      error: 'connect ECONNREFUSED',
    })
  })

  it('classifies HTTP error bodies in the Effect boundary and preserves the returned body', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: 'database unavailable' }), {
        headers: { 'content-type': 'application/json' },
        status: 503,
        statusText: 'Service Unavailable',
      })
    })
    const env = { AGENTS_SERVICE_BASE_URL: 'http://agents.test' }
    const effectResult = await Effect.runPromise(
      fetchAgentsJsonEffect<{ ok: false; error: string }>('/ready', env).pipe(
        Effect.provide(makeAgentsHttpClientLayer({ fetch: fetchMock as unknown as typeof fetch })),
        Effect.either,
      ),
    )

    expect(effectResult._tag).toBe('Left')
    if (effectResult._tag === 'Left') {
      expect(effectResult.left).toBeInstanceOf(AgentsHttpStatusError)
      expect(effectResult.left).toMatchObject({
        method: 'GET',
        url: 'http://agents.test/ready',
        status: 503,
        body: { ok: false, error: 'database unavailable' },
        error: 'database unavailable',
      })
    }

    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    await expect(fetchAgentsJson('/ready', env)).resolves.toEqual({
      ok: false,
      status: 503,
      body: { ok: false, error: 'database unavailable' },
      error: 'database unavailable',
    })
  })

  it('sends client headers and idempotency keys through the Effect HTTP client', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
        status: 201,
      })
    })

    const result = await Effect.runPromise(
      postAgentsJsonEffect<{ ok: true }>(
        '/v1/agent-runs',
        { agentRef: { name: 'codex' } },
        {
          env: {
            AGENTS_SERVICE_BASE_URL: 'http://agents.test',
            AGENTS_SERVICE_CLIENT_NAME: 'facteur',
          },
          idempotencyKey: 'delivery-123',
        },
      ).pipe(Effect.provide(makeAgentsHttpClientLayer({ fetch: fetchMock as unknown as typeof fetch }))),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/agent-runs')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ agentRef: { name: 'codex' } }))
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'delivery-123',
      'x-agents-client': 'facteur',
    })
    expect(result).toEqual({
      ok: true,
      status: 201,
      body: { ok: true },
    })
  })

  it('fetches the typed Agents health contract', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'agents',
          agentsController: {
            enabled: true,
            crdsReady: true,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentsHealthFromAgentsService({
      AGENTS_SERVICE_BASE_URL: 'http://agents.test',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/health')
    expect(init.method).toBe('GET')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        status: 'ok',
        service: 'agents',
        agentsController: {
          enabled: true,
          crdsReady: true,
        },
      },
    })
  })

  it('classifies Agents health dependency results for domain consumers', () => {
    expect(
      buildAgentsDependencyHealth({
        ok: true,
        status: 200,
        body: {
          status: 'ok',
          service: 'agents',
          agentsController: {
            enabled: true,
            crdsReady: true,
          },
        },
      }),
    ).toMatchObject({
      status: 'healthy',
      ready: true,
      http_status: 200,
      error: null,
      controller: {
        enabled: true,
        crdsReady: true,
      },
    })

    expect(
      buildAgentsDependencyHealth({
        ok: true,
        status: 200,
        body: {
          status: 'ok',
          service: 'agents',
          agentsController: {
            enabled: true,
            crdsReady: false,
          },
        },
      }),
    ).toMatchObject({
      status: 'degraded',
      ready: false,
    })

    expect(
      buildAgentsDependencyHealth({
        ok: false,
        status: 0,
        body: null,
        error: 'connect ECONNREFUSED',
      }),
    ).toMatchObject({
      status: 'unavailable',
      ready: false,
      error: 'connect ECONNREFUSED',
      controller: {
        enabled: true,
        crdsReady: false,
      },
    })
  })

  it('submits AgentRun creation through the Agents service boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          agentRun: { id: 'run-1', deliveryId: 'delivery-1' },
          resource: { kind: 'AgentRun', metadata: { name: 'demo-agent-run' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 201,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitAgentRunToAgentsService(
      {
        deliveryId: 'delivery-1',
        dryRun: 'true',
        payload: { agentRef: { name: 'demo-agent' } },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/agent-runs?dryRun=true')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ agentRef: { name: 'demo-agent' } }))
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'delivery-1',
      'x-agents-client': 'agent-contracts',
    })
    expect(result).toEqual({
      ok: true,
      status: 201,
      body: {
        ok: true,
        agentRun: { id: 'run-1', deliveryId: 'delivery-1' },
        resource: { kind: 'AgentRun', metadata: { name: 'demo-agent-run' } },
      },
    })
  })

  it('propagates an AgentRun submission abort signal to fetch', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
          status: 201,
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const controller = new AbortController()

    await submitAgentRunToAgentsService(
      {
        deliveryId: 'delivery-with-signal',
        payload: { agentRef: { name: 'demo-agent' } },
        signal: controller.signal,
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('lists AgentRun projections through the Agents service boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          runs: [
            {
              id: 'run-1',
              agentName: 'codex',
              deliveryId: 'delivery-1',
              provider: 'job',
              status: 'Running',
              externalRunId: 'codex-run-1',
              payload: {},
            },
          ],
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentRunsFromAgentsService(
      { statuses: ['Running', 'Pending'], limit: 100 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/agent-runs?status=Running%2CPending&limit=100')
    expect(init.method).toBe('GET')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        runs: [
          {
            id: 'run-1',
            agentName: 'codex',
            deliveryId: 'delivery-1',
            provider: 'job',
            status: 'Running',
            externalRunId: 'codex-run-1',
            payload: {},
          },
        ],
      },
    })
  })

  it('gets one AgentRun projection through the Agents service boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          agentRun: { id: 'run/1', externalRunId: 'demo-run' },
          resource: { kind: 'AgentRun', metadata: { name: 'demo-run' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentRunFromAgentsService(
      { id: 'run/1', namespace: 'agents' },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/agent-runs/run%2F1?namespace=agents')
    expect(init.method).toBe('GET')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        agentRun: { id: 'run/1', externalRunId: 'demo-run' },
        resource: { kind: 'AgentRun', metadata: { name: 'demo-run' } },
      },
    })
  })

  it('fetches AgentRun log tails through the control-plane logs endpoint', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          name: 'demo-run',
          namespace: 'agents',
          pods: [{ name: 'demo-run-pod', phase: 'Succeeded', containers: [{ name: 'agent-runner', type: 'main' }] }],
          pod: 'demo-run-pod',
          container: 'agent-runner',
          tailLines: 5,
          logs: 'line-1\nline-2\nline-3\nline-4\nline-5\n',
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentRunLogsFromAgentsService(
      { name: 'demo-run', namespace: 'agents', tailLines: 5 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/control-plane/logs?name=demo-run&namespace=agents&tailLines=5')
    expect(init.method).toBe('GET')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        name: 'demo-run',
        namespace: 'agents',
        pods: [{ name: 'demo-run-pod', phase: 'Succeeded', containers: [{ name: 'agent-runner', type: 'main' }] }],
        pod: 'demo-run-pod',
        container: 'agent-runner',
        tailLines: 5,
        logs: 'line-1\nline-2\nline-3\nline-4\nline-5\n',
      },
    })
  })

  it('lists raw AgentRun resources through the dedicated Agents v1 resource boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'AgentRun',
          namespace: 'agents',
          total: 1,
          items: [{ kind: 'AgentRun', metadata: { name: 'artifact-run' }, status: { phase: 'Succeeded' } }],
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchAgentRunResourcesFromAgentsService(
      { namespace: 'agents', limit: 500, labelSelector: 'app=artifact-collector', phase: 'Succeeded' },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe(
      'http://agents.test/v1/agent-runs/resources?namespace=agents&labelSelector=app%3Dartifact-collector&phase=Succeeded&limit=500',
    )
    expect(init.method).toBe('GET')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'AgentRun',
        namespace: 'agents',
        total: 1,
        items: [{ kind: 'AgentRun', metadata: { name: 'artifact-run' }, status: { phase: 'Succeeded' } }],
      },
    })
  })

  it('exposes typed Swarm list and Memory get helpers for domain consumers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            kind: 'Swarm',
            namespace: 'agents',
            items: [{ kind: 'Swarm', metadata: { name: 'platform-control-plane' } }],
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            kind: 'Memory',
            namespace: 'agents',
            resource: { kind: 'Memory', metadata: { name: 'research-memory' } },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await fetchSwarmResourcesFromAgentsService(
      { namespace: 'agents', limit: 500 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )
    await fetchMemoryResourceFromAgentsService(
      { name: 'research-memory', namespace: 'agents' },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[0].toString()).toBe(
      'http://agents.test/v1/swarms/resources?namespace=agents&limit=500',
    )
    expect((fetchMock.mock.calls[1] as unknown as [URL, RequestInit])[0].toString()).toBe(
      'http://agents.test/v1/memories/resources?name=research-memory&namespace=agents',
    )
  })

  it('exposes the Agents-owned execution trust endpoint for domain consumers', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          executionTrust: {
            status: 'healthy',
            reason: 'execution trust is healthy.',
            last_evaluated_at: '2026-05-20T12:00:00Z',
            blocking_windows: [],
            evidence_summary: [],
          },
          swarms: [],
          stages: [],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await fetchExecutionTrustFromAgentsService(
      { namespace: 'agents', swarms: ['platform-control-plane'], summaryLimit: 12 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[0].toString()).toBe(
      'http://agents.test/v1/control-plane/execution-trust?namespace=agents&swarms=platform-control-plane&summaryLimit=12',
    )
  })

  it('submits memory operations through the dedicated Agents memory API', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          operation: 'embedding',
          memoryRef: 'research-memory',
          namespace: 'agents',
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitMemoryOperationToAgentsService(
      {
        deliveryId: 'memory-op-1',
        memoryRef: 'research-memory',
        namespace: 'agents',
        operation: {
          operation: 'embedding',
          key: 'note-1',
          text: 'remember this',
          metadata: { source: 'test' },
        },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/memory-operations')
    expect(init.method).toBe('POST')
    expect(getHeader(init.headers, 'idempotency-key')).toBe('memory-op-1')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(JSON.parse(String(init.body))).toEqual({
      memoryRef: 'research-memory',
      namespace: 'agents',
      operation: 'embedding',
      key: 'note-1',
      text: 'remember this',
      metadata: { source: 'test' },
    })
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        operation: 'embedding',
        memoryRef: 'research-memory',
        namespace: 'agents',
      },
    })
  })

  it('parses memory note payloads for the Agents-owned note API', () => {
    const persist = parsePersistMemoryNoteInput({
      namespace: '  project-x  ',
      content: '  hello world  ',
      summary: '  short  ',
      tags: [' tag-1 ', '', 123],
    })
    expect(persist).toEqual({
      ok: true,
      value: {
        namespace: 'project-x',
        content: 'hello world',
        summary: 'short',
        tags: ['tag-1'],
        metadata: undefined,
      },
    })

    const missingContent = parsePersistMemoryNoteInput({ namespace: 'default' })
    expect(missingContent).toEqual({ ok: false, message: 'Content is required.' })

    const tooLarge = parsePersistMemoryNoteInput({ content: 'x'.repeat(MAX_MEMORY_NOTE_CONTENT_CHARS + 1) })
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) expect(tooLarge.message).toContain(String(MAX_MEMORY_NOTE_CONTENT_CHARS))

    const summaryTooLarge = parsePersistMemoryNoteInput({
      content: 'hello',
      summary: 'x'.repeat(MAX_MEMORY_NOTE_SUMMARY_CHARS + 1),
    })
    expect(summaryTooLarge.ok).toBe(false)
    if (!summaryTooLarge.ok) expect(summaryTooLarge.message).toContain(String(MAX_MEMORY_NOTE_SUMMARY_CHARS))

    const retrieve = parseRetrieveMemoryNotesInput({ namespace: '  demo ', query: '  find me  ', limit: '75' })
    expect(retrieve).toEqual({
      ok: true,
      value: {
        namespace: 'demo',
        query: 'find me',
        limit: 50,
      },
    })
    expect(parseRetrieveMemoryNotesInput({ namespace: 'demo' })).toEqual({ ok: false, message: 'Query is required.' })
  })

  it('uses Agents-owned memory note endpoints for note persistence, retrieval, count, and stats', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            memory: {
              id: 'mem-1',
              namespace: 'demo',
              content: 'hello world',
              summary: 'hello',
              tags: ['demo'],
              metadata: {},
              createdAt: '2026-05-20T00:00:00.000Z',
            },
          }),
          { headers: { 'content-type': 'application/json' }, status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, memories: [] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, count: 3 }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            range: { days: 7, from: '2026-05-14', to: '2026-05-20' },
            byDay: [],
            topNamespaces: [],
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    await persistMemoryNoteToAgentsService(
      { namespace: 'demo', content: 'hello world', summary: 'hello', tags: ['demo'] },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )
    await retrieveMemoryNotesFromAgentsService(
      { namespace: 'demo', query: 'hello', limit: 12 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )
    await countMemoryNotesFromAgentsService({ namespace: 'demo' }, { AGENTS_SERVICE_BASE_URL: 'http://agents.test' })
    await fetchMemoryNotesStatsFromAgentsService(
      { namespace: 'demo', days: 7, topNamespaces: 3 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    const calls = fetchMock.mock.calls as unknown as [URL, RequestInit][]
    expect(calls.map(([url]) => url.toString())).toEqual([
      'http://agents.test/v1/memory-notes',
      'http://agents.test/v1/memory-notes?query=hello&limit=12&namespace=demo',
      'http://agents.test/v1/memory-notes/count?namespace=demo',
      'http://agents.test/v1/memory-notes/stats?namespace=demo&days=7&topNamespaces=3',
    ])
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'GET', 'GET', 'GET'])
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
      namespace: 'demo',
      content: 'hello world',
      summary: 'hello',
      tags: ['demo'],
    })
  })

  it('patches AgentRun annotations through the dedicated Agents v1 resource boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'AgentRun',
          resource: {
            kind: 'AgentRun',
            metadata: { name: 'artifact-run', annotations: { finalized: 'true' } },
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await patchAgentRunAnnotationsViaAgentsService(
      {
        name: 'artifact-run',
        namespace: 'agents',
        annotations: {
          'agents.proompteng.ai/finalized-phase': 'Succeeded',
          'agents.proompteng.ai/finalized-run-id': 'artifact-consumer',
        },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/agent-runs/resources?name=artifact-run&namespace=agents')
    expect(init.method).toBe('PATCH')
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-agents-client': 'agent-contracts',
    })
    expect(JSON.parse(init.body as string)).toEqual({
      metadata: {
        annotations: {
          'agents.proompteng.ai/finalized-phase': 'Succeeded',
          'agents.proompteng.ai/finalized-run-id': 'artifact-consumer',
        },
      },
    })
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'AgentRun',
        resource: {
          kind: 'AgentRun',
          metadata: { name: 'artifact-run', annotations: { finalized: 'true' } },
        },
      },
    })
  })

  it('gets orchestration-run stage target resources through the typed v1 boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'OrchestrationRun',
          namespace: 'agents',
          resource: { kind: 'OrchestrationRun', metadata: { name: 'swarm-plan' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchStageTargetResourceFromAgentsService(
      { kind: 'OrchestrationRun', name: 'swarm-plan', namespace: 'agents' },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/orchestration-runs/resources?name=swarm-plan&namespace=agents')
    expect(init.method).toBe('GET')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'OrchestrationRun',
        namespace: 'agents',
        resource: { kind: 'OrchestrationRun', metadata: { name: 'swarm-plan' } },
      },
    })
  })

  it('exposes typed Signal submission for domain publishers', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'Signal',
          namespace: 'agents',
          resource: { kind: 'Signal', metadata: { name: 'runtime-requirement-signal' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 201,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitSwarmRequirementSignalToAgentsService(
      {
        deliveryId: 'signal-delivery',
        name: 'runtime-requirement-signal',
        namespace: 'agents',
        sourceSwarm: 'platform-scheduler',
        targetSwarm: 'codex-runtime',
        channel: 'agentrun.general.requirement',
        description: 'repair runtime evidence',
        priority: 'high',
        payload: { runtime_gate: 'artifact_collection' },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/signals/resources')
    expect(init.method).toBe('POST')
    expect(getHeader(init.headers, 'idempotency-key')).toBe('signal-delivery')
    expect(result.ok).toBe(true)
  })

  it('submits orchestration runs through the Agents service boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          orchestrationRun: {
            id: 'run-1',
            deliveryId: 'delivery-1',
            externalRunId: 'orchestration-run-1',
          },
          resource: { kind: 'OrchestrationRun', metadata: { name: 'orchestration-run-1' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 201,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitOrchestrationRunToAgentsService(
      {
        deliveryId: 'delivery-1',
        orchestrationRef: { name: 'codex-rerun' },
        namespace: 'agents',
        parameters: { repository: 'proompteng/lab', head: 'codex/rerun' },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/orchestration-runs')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(
      JSON.stringify({
        orchestrationRef: { name: 'codex-rerun' },
        namespace: 'agents',
        parameters: { repository: 'proompteng/lab', head: 'codex/rerun' },
        policy: {},
      }),
    )
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'delivery-1',
      'x-agents-client': 'agent-contracts',
    })
    expect(result).toEqual({
      orchestrationRun: {
        id: 'run-1',
        deliveryId: 'delivery-1',
        externalRunId: 'orchestration-run-1',
      },
      resource: { kind: 'OrchestrationRun', metadata: { name: 'orchestration-run-1' } },
      idempotent: false,
    })
  })

  it('submits agent message batches to the Agents service', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, inserted: 1, messages: [{ id: 'msg-1' }], skipped: false }), {
        headers: { 'content-type': 'application/json' },
        status: 201,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitAgentMessagesToAgentsService(
      {
        skipIfExisting: { agentRunName: 'agent-run-1', agentRunNamespace: 'agents', runId: 'run-1' },
        messages: [
          {
            agentRunUid: 'agent-run-uid-1',
            agentRunName: 'agent-run-1',
            agentRunNamespace: 'agents',
            runId: 'run-1',
            stepId: null,
            agentId: null,
            role: 'assistant',
            kind: 'message',
            timestamp: '2026-05-19T12:00:00.000Z',
            channel: null,
            stage: null,
            content: 'hello',
            attrs: {},
            dedupeKey: 'run-1:1',
          },
        ],
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/v1/agent-messages')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain('workflow')
    expect(body).toMatchObject({
      messages: [
        {
          agentRunUid: 'agent-run-uid-1',
          agentRunName: 'agent-run-1',
          agentRunNamespace: 'agents',
        },
      ],
    })
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(typeof init.body).toBe('string')
    expect(JSON.parse(init.body as string)).toMatchObject({
      skipIfExisting: { agentRunName: 'agent-run-1', agentRunNamespace: 'agents', runId: 'run-1' },
      messages: [{ runId: 'run-1', content: 'hello' }],
    })
    expect(result).toEqual({ inserted: 1, messages: [{ id: 'msg-1' }], skipped: false })
  })

  it('preserves idempotent orchestration submit responses from Agents', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          idempotent: true,
          orchestrationRun: { id: 'run-1', deliveryId: 'delivery-1' },
          resource: null,
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      )
    }) as unknown as typeof globalThis.fetch

    await expect(
      submitOrchestrationRunToAgentsService(
        {
          deliveryId: 'delivery-1',
          orchestrationRef: { name: 'codex-rerun' },
          namespace: 'agents',
        },
        { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
      ),
    ).resolves.toEqual({
      orchestrationRun: { id: 'run-1', deliveryId: 'delivery-1' },
      resource: null,
      idempotent: true,
    })
  })

  it('surfaces Agents orchestration submit errors without falling back to local ownership', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: 'orchestration missing not found' }), {
        headers: { 'content-type': 'application/json' },
        status: 404,
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      submitOrchestrationRunToAgentsService(
        {
          deliveryId: 'delivery-1',
          orchestrationRef: { name: 'missing' },
          namespace: 'agents',
        },
        { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
      ),
    ).rejects.toThrow('Agents service orchestration submit failed (404): orchestration missing not found')
  })
})
