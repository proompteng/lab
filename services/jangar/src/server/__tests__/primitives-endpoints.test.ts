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
    getAgentRunIdempotencyKey: vi.fn(async () => null),
    reserveAgentRunIdempotencyKey: vi.fn(async (input) => ({
      record: {
        id: 'idempotency-id',
        namespace: input.namespace,
        agentName: input.agentName,
        idempotencyKey: input.idempotencyKey,
        agentRunName: null,
        agentRunUid: null,
        terminalPhase: null,
        terminalAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      created: true,
    })),
    assignAgentRunIdempotencyKey: vi.fn(async () => null),
    markAgentRunIdempotencyKeyTerminal: vi.fn(async () => null),
    deleteAgentRunIdempotencyKey: vi.fn(async () => true),
    pruneAgentRunIdempotencyKeys: vi.fn(async () => 0),
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

  it('enforces AgentRun idempotency scope across retries', async () => {
    const scope = new Map<string, Record<string, unknown>>()
    const kubeResources: Record<string, Record<string, unknown> | null> = {
      'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
    }
    const store = createStoreMock()
    store.getAgentRunIdempotencyKey = vi.fn(
      async (input) => scope.get(`${input.namespace}:${input.agentName}:${input.idempotencyKey}`) ?? null,
    )
    store.reserveAgentRunIdempotencyKey = vi.fn(async (input) => {
      const key = `${input.namespace}:${input.agentName}:${input.idempotencyKey}`
      const existing = scope.get(key)
      if (existing) return { record: existing, created: false }
      const record = {
        id: `idem-${key}`,
        namespace: input.namespace,
        agentName: input.agentName,
        idempotencyKey: input.idempotencyKey,
        agentRunName: null,
        agentRunUid: null,
        terminalPhase: null,
        terminalAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      scope.set(key, record)
      return { record, created: true }
    })
    store.assignAgentRunIdempotencyKey = vi.fn(async (input) => {
      const key = `${input.namespace}:${input.agentName}:${input.idempotencyKey}`
      const existing = scope.get(key)
      if (!existing) return null
      const next = {
        ...existing,
        agentRunName: existing.agentRunName ?? input.agentRunName,
        agentRunUid: input.agentRunUid ?? null,
      }
      scope.set(key, next)
      return next
    })

    const kube: KubernetesClient = {
      ...createKubeMock(kubeResources),
      apply: vi.fn(async (resource) => {
        const applied = {
          ...resource,
          metadata: { ...(resource.metadata as Record<string, unknown>), name: 'demo-agent-run-1', uid: 'uid-1' },
          status: { phase: 'Running' },
        } as Record<string, unknown>
        kubeResources['agentruns.agents.proompteng.ai:jangar:demo-agent-run-1'] = applied
        return applied
      }),
    }

    const first = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        idempotencyKey: 'client-key-1',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
      },
      { 'Idempotency-Key': 'delivery-1' },
    )
    const firstResponse = await postAgentRunsHandler(first, { storeFactory: () => store, kubeClient: kube })
    expect(firstResponse.status).toBe(201)

    const second = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        idempotencyKey: 'client-key-1',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
      },
      { 'Idempotency-Key': 'delivery-2' },
    )
    const secondResponse = await postAgentRunsHandler(second, { storeFactory: () => store, kubeClient: kube })
    expect(secondResponse.status).toBe(409)
    expect(kube.apply).toHaveBeenCalledTimes(1)
    const body = (await secondResponse.json()) as { error?: string; details?: Record<string, unknown> }
    expect(body.error).toContain('already exists')
    expect(body.details?.existingAgentRunName).toBe('demo-agent-run-1')
  })

  it('reclaims stale AgentRun idempotency reservations', async () => {
    const scope = new Map<string, Record<string, unknown>>()
    const kubeResources: Record<string, Record<string, unknown> | null> = {
      'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
    }
    const store = createStoreMock()
    const key = 'jangar:demo-agent:stale-idem'
    scope.set(key, {
      id: `idem-${key}`,
      namespace: 'jangar',
      agentName: 'demo-agent',
      idempotencyKey: 'stale-idem',
      agentRunName: null,
      agentRunUid: null,
      terminalPhase: null,
      terminalAt: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    })

    store.getAgentRunIdempotencyKey = vi.fn(async () => null)
    store.reserveAgentRunIdempotencyKey = vi.fn(async (input) => {
      const mapKey = `${input.namespace}:${input.agentName}:${input.idempotencyKey}`
      const existing = scope.get(mapKey)
      if (existing) return { record: existing, created: false }
      const record = {
        id: `idem-${mapKey}`,
        namespace: input.namespace,
        agentName: input.agentName,
        idempotencyKey: input.idempotencyKey,
        agentRunName: null,
        agentRunUid: null,
        terminalPhase: null,
        terminalAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      scope.set(mapKey, record)
      return { record, created: true }
    })
    store.deleteAgentRunIdempotencyKey = vi.fn(async (input) => {
      scope.delete(`${input.namespace}:${input.agentName}:${input.idempotencyKey}`)
      return true
    })
    store.assignAgentRunIdempotencyKey = vi.fn(async (input) => {
      const mapKey = `${input.namespace}:${input.agentName}:${input.idempotencyKey}`
      const existing = scope.get(mapKey)
      if (!existing) return null
      const next = {
        ...existing,
        agentRunName: existing.agentRunName ?? input.agentRunName,
        agentRunUid: input.agentRunUid ?? null,
      }
      scope.set(mapKey, next)
      return next
    })

    const kube: KubernetesClient = {
      ...createKubeMock(kubeResources),
      apply: vi.fn(async (resource) => ({
        ...resource,
        metadata: { ...(resource.metadata as Record<string, unknown>), name: 'demo-agent-run-stale', uid: 'uid-stale' },
        status: { phase: 'Running' },
      })),
    }

    const resetEnv = setEnv({
      JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED: 'true',
      JANGAR_AGENTRUN_IDEMPOTENCY_RESERVATION_TTL_SECONDS: '60',
    })
    try {
      const request = buildRequest(
        'http://localhost/v1/agent-runs',
        {
          agentRef: { name: 'demo-agent' },
          namespace: 'jangar',
          runtime: { type: 'job', config: {} },
          idempotencyKey: 'stale-idem',
        },
        { 'Idempotency-Key': 'delivery-stale-1' },
      )

      const response = await postAgentRunsHandler(request, { storeFactory: () => store, kubeClient: kube })

      expect(response.status).toBe(201)
      expect(store.deleteAgentRunIdempotencyKey).toHaveBeenCalledTimes(1)
      expect(store.reserveAgentRunIdempotencyKey).toHaveBeenCalledTimes(2)
    } finally {
      resetEnv()
    }
  })

  it('returns the existing AgentRun when idempotency key points to a terminal run', async () => {
    const scope = new Map<string, Record<string, unknown>>()
    const kubeResources: Record<string, Record<string, unknown> | null> = {
      'agents.agents.proompteng.ai:jangar:demo-agent': { spec: {} },
    }
    const store = createStoreMock()
    store.getAgentRunIdempotencyKey = vi.fn(
      async (input) => scope.get(`${input.namespace}:${input.agentName}:${input.idempotencyKey}`) ?? null,
    )
    store.reserveAgentRunIdempotencyKey = vi.fn(async (input) => {
      const key = `${input.namespace}:${input.agentName}:${input.idempotencyKey}`
      const existing = scope.get(key)
      if (existing) return { record: existing, created: false }
      const record = {
        id: `idem-${key}`,
        namespace: input.namespace,
        agentName: input.agentName,
        idempotencyKey: input.idempotencyKey,
        agentRunName: null,
        agentRunUid: null,
        terminalPhase: null,
        terminalAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      scope.set(key, record)
      return { record, created: true }
    })
    store.assignAgentRunIdempotencyKey = vi.fn(async (input) => {
      const key = `${input.namespace}:${input.agentName}:${input.idempotencyKey}`
      const existing = scope.get(key)
      if (!existing) return null
      const next = { ...existing, agentRunName: existing.agentRunName ?? input.agentRunName }
      scope.set(key, next)
      return next
    })

    const kube: KubernetesClient = {
      ...createKubeMock(kubeResources),
      apply: vi.fn(async (resource) => {
        const applied = {
          ...resource,
          metadata: { ...(resource.metadata as Record<string, unknown>), name: 'demo-agent-run-2' },
          status: { phase: 'Succeeded' },
        } as Record<string, unknown>
        kubeResources['agentruns.agents.proompteng.ai:jangar:demo-agent-run-2'] = applied
        return applied
      }),
    }

    const first = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        idempotencyKey: 'client-key-2',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
      },
      { 'Idempotency-Key': 'delivery-3' },
    )
    const firstResponse = await postAgentRunsHandler(first, { storeFactory: () => store, kubeClient: kube })
    expect(firstResponse.status).toBe(201)

    const second = buildRequest(
      'http://localhost/v1/agent-runs',
      {
        agentRef: { name: 'demo-agent' },
        namespace: 'jangar',
        idempotencyKey: 'client-key-2',
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
      },
      { 'Idempotency-Key': 'delivery-4' },
    )
    const secondResponse = await postAgentRunsHandler(second, { storeFactory: () => store, kubeClient: kube })
    expect(secondResponse.status).toBe(200)
    expect(kube.apply).toHaveBeenCalledTimes(1)
    const body = (await secondResponse.json()) as { existingAgentRunName?: string }
    expect(body.existingAgentRunName).toBe('demo-agent-run-2')
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
