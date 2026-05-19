import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import type { OrchestrationRunRecord } from '../primitives-store'

import { postOrchestrationRunsHandler, type OrchestrationRunsApiStore } from './orchestration-runs'
import { OrchestrationSubmitNotFoundError, submitOrchestrationRun } from './orchestration-submit'

const now = new Date('2026-05-19T12:00:00.000Z')

const makeRecord = (overrides: Partial<OrchestrationRunRecord> = {}): OrchestrationRunRecord => ({
  id: 'orchestration-run-record-1',
  orchestrationName: 'demo-orchestration',
  deliveryId: 'delivery-1',
  provider: 'workflow',
  status: 'Pending',
  externalRunId: 'demo-orchestration-run-1',
  payload: {},
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const createStore = (overrides: Partial<OrchestrationRunsApiStore> = {}): OrchestrationRunsApiStore => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  getOrchestrationRunByDeliveryId: vi.fn(async () => null),
  createOrchestrationRun: vi.fn(async (input) =>
    makeRecord({
      orchestrationName: input.orchestrationName,
      deliveryId: input.deliveryId,
      provider: input.provider,
      status: input.status,
      externalRunId: input.externalRunId,
      payload: input.payload,
    }),
  ),
  createAuditEvent: vi.fn(async () => ({})),
  getOrchestrationRunsByName: vi.fn(async () => []),
  ...overrides,
})

const createKube = (overrides: Partial<KubernetesClient> = {}): KubernetesClient => ({
  apply: vi.fn(async (input) => ({
    ...input,
    metadata: {
      ...(typeof input.metadata === 'object' && input.metadata ? input.metadata : {}),
      name: 'demo-orchestration-run-1',
      uid: 'uid-1',
    },
    status: { phase: 'Running' },
  })),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (input) => input),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch),
  get: vi.fn(async (resource) =>
    resource === RESOURCE_MAP.Orchestration
      ? {
          apiVersion: 'orchestration.proompteng.ai/v1alpha1',
          kind: 'Orchestration',
          metadata: { name: 'demo-orchestration', namespace: 'agents' },
          spec: { steps: [] },
        }
      : null,
  ),
  list: vi.fn(async () => ({ items: [] })),
  listEvents: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
  ...overrides,
})

const request = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://agents.local/v1/orchestration-runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'delivery-1',
      ...headers,
    },
    body: JSON.stringify(body),
  })

describe('orchestration runs v1 API', () => {
  it('submits an orchestration run through the Effect boundary', async () => {
    const store = createStore()
    const kube = createKube()

    const response = await postOrchestrationRunsHandler(
      request({ orchestrationRef: { name: 'demo-orchestration' }, namespace: 'agents' }),
      { storeFactory: () => store, kubeClient: kube },
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      orchestrationRun?: OrchestrationRunRecord
      resource?: Record<string, unknown>
    }
    expect(body.orchestrationRun).toMatchObject({ status: 'Running', externalRunId: 'demo-orchestration-run-1' })
    expect(body.resource).toMatchObject({ kind: 'OrchestrationRun' })
    expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.Orchestration, 'demo-orchestration', 'agents')
    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'OrchestrationRun',
        spec: expect.objectContaining({ deliveryId: 'delivery-1' }),
      }),
    )
    expect(store.close).toHaveBeenCalled()
  })

  it('returns 404 from the typed not-found submit error instead of string matching', async () => {
    const store = createStore()
    const kube = createKube({ get: vi.fn(async () => null) })

    await expect(
      submitOrchestrationRun(
        {
          deliveryId: 'delivery-1',
          orchestrationRef: { name: 'missing-orchestration' },
          namespace: 'agents',
        },
        { storeFactory: () => store, kubeClient: kube },
      ),
    ).rejects.toBeInstanceOf(OrchestrationSubmitNotFoundError)

    const response = await postOrchestrationRunsHandler(
      request({ orchestrationRef: { name: 'missing-orchestration' }, namespace: 'agents' }),
      { storeFactory: () => store, kubeClient: kube },
    )

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('orchestration missing-orchestration not found in namespace agents')
    expect(store.close).toHaveBeenCalled()
  })

  it('returns 403 for typed policy denial and still records the denied audit event', async () => {
    const store = createStore()
    const kube = createKube()

    const response = await postOrchestrationRunsHandler(
      request({
        orchestrationRef: { name: 'demo-orchestration' },
        namespace: 'agents',
        policy: { budgetRef: 'daily-budget' },
      }),
      {
        storeFactory: () => store,
        kubeClient: kube,
        validatePolicies: vi.fn(async () => {
          throw new Error('budget daily-budget exceeded')
        }),
      },
    )

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('policy denied for Orchestration agents/demo-orchestration')
    expect(body.error).toContain('budget daily-budget exceeded')
    expect(store.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'policy.denied',
        details: expect.objectContaining({
          reason: expect.stringContaining('budget daily-budget exceeded'),
        }),
      }),
    )
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('returns 503 for typed storage failures', async () => {
    const store = createStore({
      ready: new Promise((_, reject) => setTimeout(() => reject(new Error('DATABASE_URL missing')), 0)),
    })

    const response = await postOrchestrationRunsHandler(
      request({ orchestrationRef: { name: 'demo-orchestration' }, namespace: 'agents' }),
      { storeFactory: () => store, kubeClient: createKube() },
    )

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('orchestration run storage store-ready failed: DATABASE_URL missing')
    expect(store.close).toHaveBeenCalled()
  })

  it('returns 502 for typed Kubernetes apply failures', async () => {
    const store = createStore()
    const kube = createKube({
      apply: vi.fn(async () => {
        throw new Error('admission webhook rejected')
      }),
    })

    const response = await postOrchestrationRunsHandler(
      request({ orchestrationRef: { name: 'demo-orchestration' }, namespace: 'agents' }),
      { storeFactory: () => store, kubeClient: kube },
    )

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe(
      'kubernetes apply-orchestration-run failed for orchestrationruns.orchestration.proompteng.ai in namespace agents: admission webhook rejected',
    )
    expect(store.createOrchestrationRun).not.toHaveBeenCalled()
  })
})
