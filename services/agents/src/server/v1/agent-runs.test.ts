import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'

import { postAgentRunsHandler, type AgentRunsApiStore } from './agent-runs'

const createStoreMock = (): AgentRunsApiStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    listAgentRuns: vi.fn(async () => []),
    getAgentRunByDeliveryId: vi.fn(async () => null),
    getAgentRunIdempotencyKey: vi.fn(async () => null),
    reserveAgentRunIdempotencyKey: vi.fn(async (input) => ({
      record: {
        namespace: input.namespace,
        agentName: input.agentName,
        idempotencyKey: input.idempotencyKey,
        agentRunName: null,
        agentRunUid: null,
        createdAt: new Date(),
      },
      created: true,
    })),
    deleteAgentRunIdempotencyKey: vi.fn(async () => true),
    assignAgentRunIdempotencyKey: vi.fn(async () => null),
    createAgentRun: vi.fn(async (input) => ({
      id: 'agent-run-record-1',
      agentName: input.agentName,
      deliveryId: input.deliveryId,
      provider: input.provider,
      status: input.status,
      externalRunId: input.externalRunId,
      payload: input.payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    createAuditEvent: vi.fn(async () => ({ id: 'audit-event-1' })),
  }) satisfies AgentRunsApiStore

const createKubeMock = (): KubernetesClient => ({
  apply: vi.fn(async (resource) => ({
    ...resource,
    metadata: {
      ...((resource.metadata ?? {}) as Record<string, unknown>),
      name: 'demo-agent-run-1',
      uid: 'agent-run-uid-1',
    },
    status: { phase: 'Running' },
  })),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  get: vi.fn(async (resource, name, namespace) => {
    if (resource === RESOURCE_MAP.Agent && name === 'demo-agent' && namespace === 'agents') {
      return { spec: {} }
    }
    return null
  }),
  list: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
  listEvents: vi.fn(async () => ({ items: [] })),
})

const buildRequest = (payload: Record<string, unknown>) =>
  new Request('http://agents.local/v1/agent-runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'agent-run-request-1',
    },
    body: JSON.stringify(payload),
  })

describe('AgentRun v1 API', () => {
  it('creates an AgentRun through injected Agents service dependencies', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        goal: { objective: 'ship the agent harness extraction', tokenBudget: 2048 },
        runtime: { type: 'job', config: { image: 'registry.example.test/lab/agents-codex-runner:test' } },
        parameters: { repository: 'proompteng/lab' },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as { resource?: Record<string, unknown>; agentRun?: Record<string, unknown> }
    expect(body.resource?.metadata).toMatchObject({ name: 'demo-agent-run-1', uid: 'agent-run-uid-1' })
    expect(body.agentRun).toMatchObject({
      id: 'agent-run-record-1',
      agentName: 'demo-agent',
      deliveryId: 'agent-run-request-1',
      provider: 'job',
      status: 'Running',
      externalRunId: 'demo-agent-run-1',
    })
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'AgentRun',
        spec: expect.objectContaining({
          agentRef: { name: 'demo-agent' },
          goal: { objective: 'ship the agent harness extraction', tokenBudget: 2048 },
          runtime: { type: 'job', config: { image: 'registry.example.test/lab/agents-codex-runner:test' } },
          idempotencyKey: 'agent-run-request-1',
        }),
      }),
    )
    expect(store.assignAgentRunIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunName: 'demo-agent-run-1', agentRunUid: 'agent-run-uid-1' }),
    )
  })

  it('preserves submitted AgentRun metadata while keeping Agents delivery labels authoritative', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        metadata: {
          generateName: 'domain-owned-run-',
          labels: {
            'domain.example/purpose': 'market-context',
            'agents.proompteng.ai/delivery-id': 'caller-must-not-win',
          },
          annotations: {
            'domain.example/request-id': 'request-1',
          },
        },
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(201)
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          generateName: 'domain-owned-run-',
          namespace: 'agents',
          labels: {
            'domain.example/purpose': 'market-context',
            'agents.proompteng.ai/delivery-id': 'agent-run-request-1',
          },
          annotations: {
            'domain.example/request-id': 'request-1',
          },
        }),
      }),
    )
  })

  it('rejects AgentRun prompt overrides in the extracted API package', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Use the implementation text.' },
        runtime: { type: 'job', config: {} },
        parameters: { prompt: 'override implementation text' },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('parameters.prompt is not allowed')
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.createAgentRun).not.toHaveBeenCalled()
  })

  it('categorizes Kubernetes apply failures and closes the store', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.apply as unknown as { mockRejectedValueOnce: (error: unknown) => void }).mockRejectedValueOnce(
      new Error('api server refused AgentRun apply'),
    )

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: { image: 'registry.example.test/lab/agents-codex-runner:test' } },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('kubernetes apply-agent-run failed')
    expect(body.error).toContain('api server refused AgentRun apply')
    expect(store.deleteAgentRunIdempotencyKey).toHaveBeenCalledWith({
      namespace: 'agents',
      agentName: 'demo-agent',
      idempotencyKey: 'agent-run-request-1',
    })
    expect(store.createAgentRun).not.toHaveBeenCalled()
    expect(store.close).toHaveBeenCalledTimes(1)
  })
})
