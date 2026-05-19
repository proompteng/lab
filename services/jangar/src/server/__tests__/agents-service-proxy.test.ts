import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildAgentsServiceProxyUrl,
  fetchAgentRunsFromAgentsService,
  fetchAgentsServiceJson,
  proxyAgentsServiceRequest,
  resolveAgentsServiceBaseUrl,
  submitAgentRunToAgentsService,
  submitAgentMessagesToAgentsService,
  submitCodexCallbackToAgentsService,
  submitOrchestrationRunToAgentsService,
} from '~/server/agents-service-proxy'

const originalFetch = globalThis.fetch

describe('agents-service-proxy', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('defaults to the in-cluster Agents service', () => {
    expect(resolveAgentsServiceBaseUrl({})).toBe('http://agents.agents.svc.cluster.local')
  })

  it('normalizes explicit Agents service base URLs', () => {
    expect(resolveAgentsServiceBaseUrl({ AGENTS_SERVICE_BASE_URL: 'http://agents.test///' })).toBe('http://agents.test')
  })

  it('preserves request query parameters when building the upstream URL', () => {
    const target = buildAgentsServiceProxyUrl(
      new Request('http://jangar.test/api/control-plane/resources?kind=AgentRun&namespace=agents'),
      '/api/agents/control-plane/resources',
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(target.toString()).toBe(
      'http://agents.test/api/agents/control-plane/resources?kind=AgentRun&namespace=agents',
    )
  })

  it('proxies non-hop-by-hop headers and request bodies to Agents', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          connection: 'close',
          'content-length': '999',
          'content-type': 'application/json',
          'x-agents-result': 'ok',
        },
        status: 202,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const response = await proxyAgentsServiceRequest(
      new Request('http://jangar.test/api/control-plane/resource?kind=Agent', {
        body: JSON.stringify({ metadata: { name: 'agent-a' } }),
        headers: {
          connection: 'close',
          'content-length': '41',
          'content-type': 'application/json',
          'x-request-id': 'req-1',
        },
        method: 'POST',
      }),
      '/api/agents/control-plane/resource',
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test/' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/api/agents/control-plane/resource?kind=Agent')
    expect(init.method).toBe('POST')
    expect((init.headers as Headers).get('content-type')).toBe('application/json')
    expect((init.headers as Headers).get('x-request-id')).toBe('req-1')
    expect((init.headers as Headers).get('connection')).toBeNull()
    expect((init.headers as Headers).get('content-length')).toBeNull()
    expect((init.headers as Headers).get('x-agents-client')).toBe('jangar')
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"metadata":{"name":"agent-a"}}')

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-agents-result')).toBe('ok')
    expect(response.headers.get('content-length')).toBeNull()
    await expect(response.json()).resolves.toEqual({ ok: true })
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
    expect((init.headers as Headers).get('accept')).toBe('application/json')
    expect((init.headers as Headers).get('x-agents-client')).toBe('jangar')
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
      'x-agents-client': 'jangar',
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
    expect((init.headers as Headers).get('x-agents-client')).toBe('jangar')
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
      'x-agents-client': 'jangar',
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
            workflowUid: null,
            workflowName: null,
            workflowNamespace: null,
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
    expect((init.headers as Record<string, string>)['x-agents-client']).toBe('jangar')
    expect(typeof init.body).toBe('string')
    expect(JSON.parse(init.body as string)).toMatchObject({
      skipIfExisting: { runId: 'run-1' },
      messages: [{ runId: 'run-1', content: 'hello' }],
    })
    expect(result).toEqual({ inserted: 1, messages: [{ id: 'msg-1' }], skipped: false })
  })

  it('submits Codex callbacks through the Agents service callback boundary', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, callback: { kind: 'run-complete' }, inserted: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 202,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const result = await submitCodexCallbackToAgentsService(
      {
        kind: 'run-complete',
        payload: { workflowName: 'workflow-1', status: { phase: 'Succeeded' } },
      },
      { AGENTS_SERVICE_BASE_URL: 'http://agents.test' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://agents.test/api/agents/codex/run-complete')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-agents-client': 'jangar',
    })
    expect(JSON.parse(init.body as string)).toEqual({
      workflowName: 'workflow-1',
      status: { phase: 'Succeeded' },
    })
    expect(result).toEqual({
      ok: true,
      status: 202,
      body: { ok: true, callback: { kind: 'run-complete' }, inserted: [] },
    })
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
