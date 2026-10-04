import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '../kube-types'

import { postOrchestrationsHandler, type OrchestrationsApiStore } from './orchestrations'

const createStore = (overrides: Partial<OrchestrationsApiStore> = {}): OrchestrationsApiStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    createAuditEvent: vi.fn(async () => ({})),
    ...overrides,
  }) satisfies OrchestrationsApiStore

const createKube = (overrides: Partial<KubernetesClient> = {}): KubernetesClient => ({
  apply: vi.fn(async (resource) => ({
    ...resource,
    metadata: {
      ...((resource.metadata ?? {}) as Record<string, unknown>),
      uid: 'orchestration-uid-1',
    },
  })),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  listEvents: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
  ...overrides,
})

const request = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://agents.local/v1/orchestrations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'delivery-1',
      ...headers,
    },
    body: JSON.stringify(body),
  })

describe('Orchestrations v1 API', () => {
  it('creates an Orchestration through the Effect submit boundary', async () => {
    const store = createStore({
      close: vi.fn(async () => {
        throw new Error('close failed after response')
      }),
    })
    const kube = createKube()
    const idGenerator = vi.fn(() => 'policy-allowed-id')

    const response = await postOrchestrationsHandler(
      request({
        name: 'demo-orchestration',
        namespace: 'agents',
        spec: { steps: [{ name: 'implement', agentRef: { name: 'demo-agent' } }] },
      }),
      { storeFactory: () => store, kubeClient: kube, validatePolicies: vi.fn(async () => {}), idGenerator },
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as { orchestration?: Record<string, unknown> }
    expect(body.orchestration).toMatchObject({
      kind: 'Orchestration',
      metadata: {
        name: 'demo-orchestration',
        namespace: 'agents',
        uid: 'orchestration-uid-1',
      },
      spec: { steps: [{ name: 'implement', agentRef: { name: 'demo-agent' } }] },
    })
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'Orchestration',
        metadata: expect.objectContaining({
          labels: { 'agents.proompteng.ai/delivery-id': 'delivery-1' },
        }),
      }),
    )
    expect(idGenerator).toHaveBeenCalledTimes(1)
    expect(store.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'PolicyDecision',
        entityId: 'policy-allowed-id',
        eventType: 'policy.allowed',
      }),
    )
    expect(store.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Orchestration',
        entityId: 'orchestration-uid-1',
        eventType: 'orchestration.created',
      }),
    )
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('keeps allowed-audit storage failures as storage failures instead of policy denials', async () => {
    const store = createStore({
      createAuditEvent: vi.fn(async (input) => {
        if (input.eventType === 'policy.allowed') {
          throw new Error('audit table unavailable')
        }
        return {}
      }),
    })
    const kube = createKube()
    const idGenerator = vi.fn(() => 'policy-allowed-id')

    const response = await postOrchestrationsHandler(
      request({
        name: 'demo-orchestration',
        namespace: 'agents',
        spec: { steps: [{ name: 'implement', agentRef: { name: 'demo-agent' } }] },
      }),
      { storeFactory: () => store, kubeClient: kube, validatePolicies: vi.fn(async () => {}), idGenerator },
    )

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('orchestration storage create-audit-event failed: audit table unavailable')
    expect(body.error).not.toContain('policy denied')
    expect(store.createAuditEvent).toHaveBeenCalledTimes(1)
    expect(store.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'policy-allowed-id',
        eventType: 'policy.allowed',
      }),
    )
    expect(kube.apply).not.toHaveBeenCalled()
  })
})
