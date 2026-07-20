import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'

import type { AgentRunsApiStore } from './agent-run-store'
import { postAgentRunsHandler } from './agent-runs'

type MockResolvedValueOnce = {
  mockResolvedValueOnce: (value: unknown) => MockResolvedValueOnce
}

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

const buildRequest = (payload: Record<string, unknown>, url = 'http://agents.local/v1/agent-runs') =>
  new Request(url, {
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
    const idGenerator = vi.fn(() => 'policy-audit-id-1')

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
        idGenerator,
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
    expect(idGenerator).toHaveBeenCalledTimes(1)
    expect(store.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'PolicyDecision',
        entityId: 'policy-audit-id-1',
        eventType: 'policy.allowed',
      }),
    )
  })

  it('continues AgentRun submissions when audit persistence times out', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(store.createAuditEvent as unknown as { mockRejectedValue: (error: unknown) => void }).mockRejectedValue(
      new Error('Query read timeout'),
    )

    try {
      const response = await postAgentRunsHandler(
        buildRequest({
          agentRef: { name: 'demo-agent' },
          namespace: 'agents',
          implementation: { text: 'Implement the requested change.' },
          runtime: { type: 'job', config: {} },
          parameters: { repository: 'proompteng/lab' },
        }),
        {
          storeFactory: () => store,
          kubeClient: kube,
          validatePolicies: vi.fn(async () => {}),
        },
      )

      expect(response.status).toBe(201)
      expect(kube.apply).toHaveBeenCalled()
      expect(store.createAgentRun).toHaveBeenCalled()
      expect(store.createAuditEvent).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('injects runtime config for idempotency instead of reading global process env', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
        runtimeConfig: {
          env: {
            AGENTS_AGENTRUN_IDEMPOTENCY_ENABLED: 'false',
          },
        },
      },
    )

    expect(response.status).toBe(201)
    expect(store.getAgentRunIdempotencyKey).not.toHaveBeenCalled()
    expect(store.reserveAgentRunIdempotencyKey).not.toHaveBeenCalled()
    expect(store.assignAgentRunIdempotencyKey).not.toHaveBeenCalled()
    expect(kube.apply).toHaveBeenCalled()
  })

  it('previews AgentRun dry-runs without creating resources or projection records', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    const validatePolicies = vi.fn(async () => {})
    const idGenerator = vi.fn(() => 'policy-audit-id-1')

    const response = await postAgentRunsHandler(
      buildRequest(
        {
          agentRef: { name: 'demo-agent' },
          namespace: 'agents',
          implementation: { text: 'Implement the requested change.' },
          runtime: { type: 'job', config: {} },
          parameters: { repository: 'proompteng/lab' },
        },
        'http://agents.local/v1/agent-runs?dryRun=true',
      ),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies,
        idGenerator,
        runtimeConfig: { env: { AGENTS_AGENT_RUNNER_IMAGE: 'registry.example.test/lab/default-runner:test' } },
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      idempotent: false,
      namespace: 'agents',
      agentName: 'demo-agent',
      resolvedWorkloadImage: 'registry.example.test/lab/default-runner:test',
      resolvedWorkloadImageSource: 'controller-default',
    })
    expect(validatePolicies).toHaveBeenCalledTimes(1)
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.reserveAgentRunIdempotencyKey).not.toHaveBeenCalled()
    expect(store.assignAgentRunIdempotencyKey).not.toHaveBeenCalled()
    expect(store.createAgentRun).not.toHaveBeenCalled()
    expect(store.createAuditEvent).not.toHaveBeenCalled()
    expect(idGenerator).not.toHaveBeenCalled()
  })

  it('resolves provider workload image in AgentRun dry-run previews', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.get as unknown as MockResolvedValueOnce)
      .mockResolvedValueOnce({
        metadata: { name: 'anypi-agent' },
        spec: { providerRef: { name: 'anypi' } },
      })
      .mockResolvedValueOnce({
        metadata: { name: 'anypi' },
        spec: {
          binary: '/usr/local/bin/anypi-runner',
          workload: {
            image:
              'registry.ide-newton.ts.net/lab/anypi:a5796fc2b@sha256:4e4e7ac9f646c061baaa7478ae42bf3acefc2ab46b2640ffa52b677cb8ed86ca',
          },
        },
      })

    const response = await postAgentRunsHandler(
      buildRequest(
        {
          agentRef: { name: 'anypi-agent' },
          namespace: 'agents',
          implementation: { text: 'Implement the requested change.' },
          runtime: { type: 'job', config: {} },
          parameters: { repository: 'proompteng/lab' },
        },
        'http://agents.local/v1/agent-runs?dryRun=All',
      ),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
        runtimeConfig: { env: { AGENTS_AGENT_RUNNER_IMAGE: 'registry.example.test/lab/default-runner:test' } },
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      providerName: 'anypi',
      resolvedWorkloadImage:
        'registry.ide-newton.ts.net/lab/anypi:a5796fc2b@sha256:4e4e7ac9f646c061baaa7478ae42bf3acefc2ab46b2640ffa52b677cb8ed86ca',
      resolvedWorkloadImageSource: 'provider',
    })
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.createAgentRun).not.toHaveBeenCalled()
  })

  it('admits a provider service account and source that are allowlisted by the Agent', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.get as unknown as MockResolvedValueOnce)
      .mockResolvedValueOnce({
        metadata: { name: 'codex-linear-agent' },
        spec: {
          providerRef: { name: 'codex-linear' },
          security: {
            allowedServiceAccounts: ['codex-linear-runner'],
            allowedImplementationSourceProviders: ['linear'],
          },
        },
      })
      .mockResolvedValueOnce({
        metadata: { name: 'codex-linear' },
        spec: { workload: { serviceAccountName: 'codex-linear-runner' } },
      })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'codex-linear-agent' },
        namespace: 'agents',
        implementation: {
          text: 'Implement the issue.',
          source: { provider: 'linear', externalId: 'PROOMPT-123' },
        },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(201)
    expect(kube.apply).toHaveBeenCalled()
  })

  it('rejects a source provider outside the Agent allowlist before creating an AgentRun', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.get as unknown as MockResolvedValueOnce).mockResolvedValueOnce({
      metadata: { name: 'codex-linear-agent' },
      spec: {
        security: { allowedImplementationSourceProviders: ['linear'] },
      },
    })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'codex-linear-agent' },
        namespace: 'agents',
        implementation: {
          text: 'Implement the issue.',
          source: { provider: 'github', externalId: '123' },
        },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('implementation source provider github is not allowed'),
    })
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.createAgentRun).not.toHaveBeenCalled()
  })

  it('rejects a workflow step source outside the Agent allowlist', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.get as unknown as MockResolvedValueOnce).mockResolvedValueOnce({
      metadata: { name: 'codex-linear-agent' },
      spec: { security: { allowedImplementationSourceProviders: ['linear'] } },
    })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'codex-linear-agent' },
        namespace: 'agents',
        implementation: {
          text: 'Implement the Linear issue.',
          source: { provider: 'linear', externalId: 'PROOMPT-123' },
        },
        runtime: { type: 'workflow', config: {} },
        workflow: {
          steps: [
            {
              name: 'implement',
              implementation: {
                text: 'Attempt to replace the source.',
                source: { provider: 'github', externalId: 'proompteng/lab#123' },
              },
            },
          ],
        },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('implementation source provider github is not allowed'),
    })
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('rejects invalid AgentRun dry-run values before mutating state', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()

    const response = await postAgentRunsHandler(
      buildRequest(
        {
          agentRef: { name: 'demo-agent' },
          namespace: 'agents',
          implementation: { text: 'Implement the requested change.' },
          runtime: { type: 'job', config: {} },
        },
        'http://agents.local/v1/agent-runs?dryRun=maybe',
      ),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('dryRun must be true, false, or All')
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.createAgentRun).not.toHaveBeenCalled()
    expect(store.createAuditEvent).not.toHaveBeenCalled()
  })

  it('injects runtime config into admission queue limits instead of reading global process env', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.list as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
      items: [
        {
          metadata: { name: 'queued-agent-run', namespace: 'agents' },
          spec: { parameters: { repository: 'proompteng/lab' } },
          status: { phase: 'Pending' },
        },
      ],
    })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
        parameters: { repository: 'proompteng/lab' },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
        runtimeConfig: {
          env: {
            AGENTS_CONTROLLER_QUEUE_NAMESPACE: '1',
          },
        },
      },
    )

    expect(response.status).toBe(429)
    const body = (await response.json()) as {
      error?: string
      details?: { scope?: string; limit?: number; queued?: number }
    }
    expect(body.error).toBe('Namespace agents reached queue limit')
    expect(body.details).toMatchObject({ scope: 'namespace', limit: 1, queued: 1 })
    expect(kube.apply).not.toHaveBeenCalled()
    expect(store.reserveAgentRunIdempotencyKey).not.toHaveBeenCalled()
    expect(store.deleteAgentRunIdempotencyKey).not.toHaveBeenCalled()
  })

  it('reclaims stale idempotency reservations using injected runtime config and clock', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(store.reserveAgentRunIdempotencyKey as unknown as MockResolvedValueOnce)
      .mockResolvedValueOnce({
        record: {
          namespace: 'agents',
          agentName: 'demo-agent',
          idempotencyKey: 'agent-run-request-1',
          agentRunName: null,
          agentRunUid: null,
          createdAt: '2026-01-20T00:00:00.000Z',
        },
        created: false,
      })
      .mockResolvedValueOnce({
        record: {
          namespace: 'agents',
          agentName: 'demo-agent',
          idempotencyKey: 'agent-run-request-1',
          agentRunName: null,
          agentRunUid: null,
          createdAt: '2026-01-20T00:00:11.000Z',
        },
        created: true,
      })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
        runtimeConfig: {
          env: {
            AGENTS_AGENTRUN_IDEMPOTENCY_RESERVATION_TTL_SECONDS: '10',
          },
          now: () => Date.parse('2026-01-20T00:00:11.000Z'),
        },
      },
    )

    expect(response.status).toBe(201)
    expect(store.deleteAgentRunIdempotencyKey).toHaveBeenCalledWith({
      namespace: 'agents',
      agentName: 'demo-agent',
      idempotencyKey: 'agent-run-request-1',
    })
    expect(store.reserveAgentRunIdempotencyKey).toHaveBeenCalledTimes(2)
    expect(kube.apply).toHaveBeenCalled()
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

  it('preserves workflow timeout and loop fields submitted through the Agents API', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementationSpecRef: { name: 'demo-impl' },
        runtime: { type: 'workflow', config: {} },
        workflow: {
          steps: [
            {
              name: 'plan',
              timeoutSeconds: 120,
              retries: 2,
              retryBackoffSeconds: 15,
              loop: {
                maxIterations: 3,
                condition: {
                  type: 'cel',
                  expression: 'state.done == true',
                  source: {
                    type: 'file',
                    path: '/workspace/state.json',
                    onMissing: 'stop',
                    onInvalid: 'fail',
                  },
                },
                state: {
                  required: true,
                  volumeNames: ['workflow-state'],
                },
              },
            },
          ],
        },
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
        spec: expect.objectContaining({
          workflow: {
            steps: [
              expect.objectContaining({
                name: 'plan',
                timeoutSeconds: 120,
                retries: 2,
                retryBackoffSeconds: 15,
                loop: {
                  maxIterations: 3,
                  condition: {
                    type: 'cel',
                    expression: 'state.done == true',
                    source: {
                      type: 'file',
                      path: '/workspace/state.json',
                      onMissing: 'stop',
                      onInvalid: 'fail',
                    },
                  },
                  state: {
                    required: true,
                    volumeNames: ['workflow-state'],
                  },
                },
              }),
            ],
          },
        }),
      }),
    )
  })

  it('keeps raw idempotency in storage and spec while normalizing the Kubernetes delivery label', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    const request = new Request('http://agents.local/v1/agent-runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'domain/request:with spaces and slashes',
      },
      body: JSON.stringify({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
    })

    const response = await postAgentRunsHandler(request, {
      storeFactory: () => store,
      kubeClient: kube,
      validatePolicies: vi.fn(async () => {}),
    })

    expect(response.status).toBe(201)
    expect(store.reserveAgentRunIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'domain/request:with spaces and slashes' }),
    )
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          labels: {
            'agents.proompteng.ai/delivery-id': 'domain-request-with-spaces-and-slashes-a7c31d4acb3e',
          },
        }),
        spec: expect.objectContaining({
          idempotencyKey: 'domain/request:with spaces and slashes',
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

  it('categorizes store open failures as storage failures', async () => {
    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => {
          throw new Error('database pool unavailable')
        },
        kubeClient: createKubeMock(),
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('agent run storage open-store failed')
    expect(body.error).toContain('database pool unavailable')
  })

  it('keeps policy denials as forbidden when denied-audit persistence fails', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(store.createAuditEvent as unknown as { mockRejectedValueOnce: (error: unknown) => void }).mockRejectedValueOnce(
      new Error('audit store timeout'),
    )

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {
          throw new Error('budget denied')
        }),
      },
    )

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('policy denied for Agent agents/demo-agent')
    expect(body.error).toContain('budget denied')
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('preserves the original Kubernetes apply failure when idempotency cleanup fails', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(kube.apply as unknown as { mockRejectedValueOnce: (error: unknown) => void }).mockRejectedValueOnce(
      new Error('api server refused AgentRun apply'),
    )
    ;(
      store.deleteAgentRunIdempotencyKey as unknown as { mockRejectedValueOnce: (error: unknown) => void }
    ).mockRejectedValueOnce(new Error('cleanup failed'))

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
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
    expect(body.error).not.toContain('cleanup failed')
  })

  it('returns existing delivery-id submissions as idempotent successes', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(
      store.getAgentRunByDeliveryId as unknown as { mockResolvedValueOnce: (value: unknown) => void }
    ).mockResolvedValueOnce({
      id: 'existing-record-1',
      agentName: 'demo-agent',
      deliveryId: 'agent-run-request-1',
      provider: 'job',
      status: 'Running',
      externalRunId: 'existing-agent-run',
      payload: { request: { namespace: 'agents' } },
    })
    ;(kube.get as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce({
      kind: 'AgentRun',
      metadata: { name: 'existing-agent-run', namespace: 'agents' },
      status: { phase: 'Running' },
    })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { idempotent?: boolean; agentRun?: Record<string, unknown> }
    expect(body.idempotent).toBe(true)
    expect(body.agentRun).toMatchObject({ id: 'existing-record-1', externalRunId: 'existing-agent-run' })
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('rejects in-progress idempotency reservations with conflict details', async () => {
    const store = createStoreMock()
    const kube = createKubeMock()
    ;(
      store.reserveAgentRunIdempotencyKey as unknown as { mockResolvedValueOnce: (value: unknown) => void }
    ).mockResolvedValueOnce({
      record: {
        namespace: 'agents',
        agentName: 'demo-agent',
        idempotencyKey: 'agent-run-request-1',
        agentRunName: null,
        agentRunUid: null,
        createdAt: new Date(),
      },
      created: false,
    })

    const response = await postAgentRunsHandler(
      buildRequest({
        agentRef: { name: 'demo-agent' },
        namespace: 'agents',
        implementation: { text: 'Implement the requested change.' },
        runtime: { type: 'job', config: {} },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {}),
      },
    )

    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      error?: string
      details?: { namespace?: string; agentName?: string }
    }
    expect(body.error).toBe('AgentRun creation already in progress for idempotency key')
    expect(body.details).toMatchObject({ namespace: 'agents', agentName: 'demo-agent' })
    expect(kube.apply).not.toHaveBeenCalled()
  })
})
