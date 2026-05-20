import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchAgentRunResourcesFromAgentsService,
  fetchAgentRunsFromAgentsService,
  fetchAgentsServiceJson,
  fetchControlPlaneResourceFromAgentsService,
  fetchControlPlaneResourcesFromAgentsService,
  patchAgentRunAnnotationsViaAgentsService,
  resolveAgentsServiceBaseUrl,
  submitAgentRunToAgentsService,
  submitAgentMessagesToAgentsService,
  submitControlPlaneResourceToAgentsService,
  submitOrchestrationRunToAgentsService,
} from './agents-service-client'

const originalFetch = globalThis.fetch
const getHeader = (headers: RequestInit['headers'], name: string) =>
  headers instanceof Headers ? headers.get(name) : ((headers as Record<string, string> | undefined)?.[name] ?? null)

describe('agents-service-client', () => {
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

    const result = await fetchAgentsServiceJson<{ status: string }>('/health', {
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

  it('lists raw AgentRun resources through the Agents control-plane boundary', async () => {
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
      'http://agents.test/api/agents/control-plane/resources?kind=AgentRun&namespace=agents&labelSelector=app%3Dartifact-collector&phase=Succeeded&limit=500',
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

  it('lists generic control-plane resources through the Agents service boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'Swarm',
          namespace: 'agents',
          total: 1,
          items: [{ kind: 'Swarm', metadata: { name: 'platform-control-plane' }, status: { phase: 'Ready' } }],
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await fetchControlPlaneResourcesFromAgentsService(
      { kind: 'Swarm', namespace: 'agents', limit: 100 },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe(
      'http://agents.test/api/agents/control-plane/resources?kind=Swarm&namespace=agents&limit=100',
    )
    expect(init.method).toBe('GET')
    expect(getHeader(init.headers, 'x-agents-client')).toBe('agent-contracts')
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        ok: true,
        kind: 'Swarm',
        namespace: 'agents',
        total: 1,
        items: [{ kind: 'Swarm', metadata: { name: 'platform-control-plane' }, status: { phase: 'Ready' } }],
      },
    })
  })

  it('patches AgentRun annotations through the Agents control-plane boundary', async () => {
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
    expect(url.toString()).toBe(
      'http://agents.test/api/agents/control-plane/resource?kind=AgentRun&name=artifact-run&namespace=agents',
    )
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

  it('gets individual control-plane resources through the Agents service boundary', async () => {
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

    const result = await fetchControlPlaneResourceFromAgentsService(
      { kind: 'OrchestrationRun', name: 'swarm-plan', namespace: 'agents' },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe(
      'http://agents.test/api/agents/control-plane/resource?kind=OrchestrationRun&name=swarm-plan&namespace=agents',
    )
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

  it('submits raw control-plane resources through the Agents service boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          kind: 'Signal',
          namespace: 'agents',
          resource: { kind: 'Signal', metadata: { name: 'material-reentry-signal' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 201,
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitControlPlaneResourceToAgentsService(
      {
        deliveryId: 'signal-delivery',
        resource: {
          apiVersion: 'signals.proompteng.ai/v1alpha1',
          kind: 'Signal',
          metadata: { name: 'material-reentry-signal', namespace: 'agents' },
          spec: { channel: 'agentrun.general.requirement' },
        },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/api/agents/control-plane/resource')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': 'signal-delivery',
      'x-agents-client': 'agent-contracts',
    })
    expect(JSON.parse(init.body as string)).toMatchObject({
      kind: 'Signal',
      metadata: { name: 'material-reentry-signal', namespace: 'agents' },
    })
    expect(result).toEqual({
      ok: true,
      status: 201,
      body: {
        ok: true,
        kind: 'Signal',
        namespace: 'agents',
        resource: { kind: 'Signal', metadata: { name: 'material-reentry-signal' } },
      },
    })
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
        skipIfExisting: { runId: 'run-1' },
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
    expect(url.toString()).toBe('http://agents.test/api/agents/messages')
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
      skipIfExisting: { runId: 'run-1' },
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
