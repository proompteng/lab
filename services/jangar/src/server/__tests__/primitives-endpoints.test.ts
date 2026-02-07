import { describe, expect, it, vi } from 'vitest'

import { postAgentRunsHandler } from '~/routes/v1/agent-runs'
import { postOrchestrationsHandler } from '~/routes/v1/orchestrations'
import type { KubernetesClient } from '~/server/primitives-kube'
import type { PrimitivesStore } from '~/server/primitives-store'

const setLeaderElectionFollower = () => {
  ;(globalThis as unknown as { __jangarLeaderElection?: unknown }).__jangarLeaderElection = {
    status: {
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'lease',
      leaseNamespace: 'jangar',
      identity: 'pod_123',
      lastTransitionAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
    },
  }
}

const clearLeaderElection = () => {
  delete (globalThis as unknown as { __jangarLeaderElection?: unknown }).__jangarLeaderElection
}

const createStoreMock = (): PrimitivesStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    createAgentRun: vi.fn(async (input) => ({
      id: 'agent-run-id',
      agentName: input.agentName,
      deliveryId: input.deliveryId,
      provider: input.provider,
      status: input.status,
      externalRunId: input.externalRunId ?? null,
      payload: input.payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    updateAgentRunStatus: vi.fn(async () => null),
    updateAgentRunDetails: vi.fn(async () => null),
    getAgentRunById: vi.fn(async () => null),
    getAgentRunByDeliveryId: vi.fn(async () => null),
    getAgentRunByExternalRunId: vi.fn(async () => null),
    getAgentRunsByAgent: vi.fn(async () => []),
    createOrchestrationRun: vi.fn(async () => {
      throw new Error('not used')
    }),
    updateOrchestrationRunStatus: vi.fn(async () => null),
    updateOrchestrationRunDetails: vi.fn(async () => null),
    getOrchestrationRunById: vi.fn(async () => null),
    getOrchestrationRunByDeliveryId: vi.fn(async () => null),
    getOrchestrationRunByExternalRunId: vi.fn(async () => null),
    getOrchestrationRunsByName: vi.fn(async () => []),
    upsertMemoryResource: vi.fn(async () => {
      throw new Error('not used')
    }),
    getMemoryResourceById: vi.fn(async () => null),
    getMemoryResourceByName: vi.fn(async () => null),
    createAuditEvent: vi.fn(async (input) => ({
      id: 'audit-id',
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: new Date(),
    })),
    getRunById: vi.fn(async () => null),
  }) as PrimitivesStore

const createKubeMock = (
  resources: Record<string, Record<string, unknown> | null>,
  lists: Record<string, Record<string, unknown>[]> = {},
): KubernetesClient => ({
  apply: vi.fn(async (resource) => resource),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  get: vi.fn(async (resource, name, namespace) => resources[`${resource}:${namespace}:${name}`] ?? null),
  list: vi.fn(async (resource, namespace) => ({ items: lists[`${resource}:${namespace}`] ?? [] })),
  logs: vi.fn(async () => ''),
  listEvents: vi.fn(async () => ({ items: [] })),
})

const setEnv = (values: Record<string, string | undefined>) => {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

const buildRequest = (url: string, payload: Record<string, unknown>, headers?: Record<string, string>) =>
  new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  })

describe('primitives endpoints', () => {
  it('rejects mutations when not leader', async () => {
    setLeaderElectionFollower()
    try {
      const store = createStoreMock()
      const kube = createKubeMock({
        'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
      })

      const request = buildRequest(
        'http://localhost/v1/agent-runs',
        {
          agentRef: { name: 'demo-agent' },
          namespace: 'jangar',
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
        },
        { 'Idempotency-Key': 'demo-agent-run-not-leader-1' },
      )

      const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

      expect(response.status).toBe(503)
      expect(kube.apply).toHaveBeenCalledTimes(0)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toContain('Not leader')
    } finally {
      clearLeaderElection()
    }
  })

  it('passes workflow steps through when submitting workflow agent runs', async () => {
    const store = createStoreMock()
    const kube = createKubeMock({
      'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
    })

    const request = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow' },
        workload: { image: 'registry.example.com/demo:latest' },
        workflow: {
          steps: [{ name: 'plan', parameters: { stage: 'plan' } }],
        },
      },
      { 'Idempotency-Key': 'demo-agent-run-workflow-1' },
    )

    const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

    expect(response.status).toBe(201)
    expect(kube.apply).toHaveBeenCalledTimes(1)
    const resource = (kube.apply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>
    const spec = resource.spec as Record<string, unknown>
    const workflow = spec.workflow as Record<string, unknown>
    expect(Array.isArray(workflow.steps)).toBe(true)
    expect((workflow.steps as Record<string, unknown>[])[0]?.name).toBe('plan')
  })

  it('rejects workflow agent runs without workflow steps', async () => {
    const store = createStoreMock()
    const kube = createKubeMock({
      'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
    })

    const request = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow' },
        workload: { image: 'registry.example.com/demo:latest' },
      },
      { 'Idempotency-Key': 'demo-agent-run-workflow-2' },
    )

    const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('workflow.steps is required')
  })

  it('rejects agent runs that request secrets without a secret binding', async () => {
    const store = createStoreMock()
    const kube = createKubeMock({
      'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
    })

    const request = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        secrets: ['api-key'],
      },
      { 'Idempotency-Key': 'demo-agent-run-1' },
    )

    const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('secretBindingRef is required')
  })

  it('rejects agent runs when namespace queue limit is exceeded', async () => {
    const restoreEnv = setEnv({
      JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE: '1',
      JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER: '0',
      JANGAR_AGENTS_CONTROLLER_QUEUE_REPO: '0',
      JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE: '0',
      JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER: '0',
      JANGAR_AGENTS_CONTROLLER_RATE_REPO: '0',
    })
    try {
      const store = createStoreMock()
      const kube = createKubeMock(
        {
          'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
        },
        {
          'agentruns.agents.proompteng.ai:jangar': [{ status: { phase: 'Pending' }, spec: { parameters: {} } }],
        },
      )

      const request = buildRequest(
        'http://localhost/v1/agent-runs',
        {
          agentRef: { name: 'demo-agent' },
          namespace: 'jangar',
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
        },
        { 'Idempotency-Key': 'demo-agent-run-queue-1' },
      )

      const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

      expect(response.status).toBe(429)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toContain('queue limit')
    } finally {
      restoreEnv()
    }
  })

  it('rejects agent runs when repository queue limit is exceeded', async () => {
    const restoreEnv = setEnv({
      JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE: '10',
      JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER: '0',
      JANGAR_AGENTS_CONTROLLER_QUEUE_REPO: '1',
      JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE: '0',
      JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER: '0',
      JANGAR_AGENTS_CONTROLLER_RATE_REPO: '0',
    })
    try {
      const store = createStoreMock()
      const kube = createKubeMock(
        {
          'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
        },
        {
          'agentruns.agents.proompteng.ai:jangar': [
            { status: { phase: 'Pending' }, spec: { parameters: { repository: 'acme/demo' } } },
          ],
        },
      )

      const request = buildRequest(
        'http://localhost/v1/agent-runs',
        {
          agentRef: { name: 'demo-agent' },
          namespace: 'jangar',
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
          parameters: { repository: 'acme/demo' },
        },
        { 'Idempotency-Key': 'demo-agent-run-queue-2' },
      )

      const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

      expect(response.status).toBe(429)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toContain('Repository acme/demo')
    } finally {
      restoreEnv()
    }
  })

  it('rejects orchestration creation when approval policy is denied', async () => {
    const store = createStoreMock()
    const kube = createKubeMock({
      'approvalpolicies.approvals.proompteng.ai:jangar:policy-1': { status: { phase: 'Denied' } },
    })

    const request = buildRequest(
      'http://localhost/v1/orchestrations',
      {
        name: 'demo-orchestration',
        namespace: 'jangar',
        spec: {
          entrypoint: 'gate',
          steps: [{ name: 'gate', kind: 'ApprovalGate', policyRef: 'policy-1' }],
        },
      },
      { 'Idempotency-Key': 'demo-orchestration-1' },
    )

    const response = await postOrchestrationsHandler(request, { storeFactory: () => store, kubeClient: kube })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('approval policy')
  })

  it('accepts orchestration creation when approval policy is approved', async () => {
    const store = createStoreMock()
    const kube = createKubeMock({
      'approvalpolicies.approvals.proompteng.ai:jangar:policy-2': { status: { phase: 'Approved' } },
    })

    const request = buildRequest(
      'http://localhost/v1/orchestrations',
      {
        name: 'demo-orchestration',
        namespace: 'jangar',
        spec: {
          entrypoint: 'gate',
          steps: [{ name: 'gate', kind: 'ApprovalGate', policyRef: 'policy-2' }],
        },
      },
      { 'Idempotency-Key': 'demo-orchestration-2' },
    )

    const response = await postOrchestrationsHandler(request, { storeFactory: () => store, kubeClient: kube })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { ok?: boolean }
    expect(body.ok).toBe(true)
  })
})
