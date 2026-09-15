import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '../kube-types'

import { postAgentsHandler, type AgentsApiStore } from './agents'

const createStore = (overrides: Partial<AgentsApiStore> = {}): AgentsApiStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => {}),
    createAuditEvent: vi.fn(async () => ({})),
    ...overrides,
  }) satisfies AgentsApiStore

const createKube = (overrides: Partial<KubernetesClient> = {}): KubernetesClient => ({
  apply: vi.fn(async (resource) => ({
    ...resource,
    metadata: {
      ...((resource.metadata ?? {}) as Record<string, unknown>),
      uid: 'agent-uid-1',
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
  new Request('http://agents.local/v1/agents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'delivery-1',
      ...headers,
    },
    body: JSON.stringify(body),
  })

describe('Agents v1 API', () => {
  it('creates an Agent through the Effect submit boundary', async () => {
    const store = createStore({
      close: vi.fn(async () => {
        throw new Error('close failed after response')
      }),
    })
    const kube = createKube()
    const idGenerator = vi.fn(() => 'policy-allowed-id')

    const response = await postAgentsHandler(
      request({ name: 'demo-agent', namespace: 'agents', spec: { defaults: { model: 'gpt-5.4' } } }),
      { storeFactory: () => store, kubeClient: kube, validatePolicies: vi.fn(async () => {}), idGenerator },
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as { agent?: Record<string, unknown> }
    expect(body.agent).toMatchObject({
      kind: 'Agent',
      metadata: {
        name: 'demo-agent',
        namespace: 'agents',
        uid: 'agent-uid-1',
      },
      spec: { defaults: { model: 'gpt-5.4' } },
    })
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'Agent',
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
        entityType: 'Agent',
        entityId: 'agent-uid-1',
        eventType: 'agent.created',
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

    const response = await postAgentsHandler(
      request({ name: 'demo-agent', namespace: 'agents', spec: { defaults: { model: 'gpt-5.4' } } }),
      { storeFactory: () => store, kubeClient: kube, validatePolicies: vi.fn(async () => {}), idGenerator },
    )

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('agent storage create-audit-event failed: audit table unavailable')
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
