import { describe, expect, it, vi } from 'vitest'

import { postAgentRunsHandler } from '~/routes/v1/agent-runs'
import { postOrchestrationsHandler } from '~/routes/v1/orchestrations'
import type { KubernetesClient } from '~/server/primitives-kube'
import type { PrimitivesStore } from '~/server/primitives-store'

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

const createKubeMock = (resources: Record<string, Record<string, unknown> | null>): KubernetesClient => ({
  apply: vi.fn(async (resource) => resource),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  get: vi.fn(async (resource, name, namespace) => resources[`${resource}:${namespace}:${name}`] ?? null),
  list: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
  listEvents: vi.fn(async () => ({ items: [] })),
})

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
