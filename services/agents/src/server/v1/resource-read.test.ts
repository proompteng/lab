import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import type { OrchestrationRunRecord } from '../primitives-store'

import {
  getAgentHandler,
  getMemoryHandler,
  getOrchestrationRunWithServicesEffect,
  makeOrchestrationRunReadStoreLayer,
  makeResourceReadKubernetesLayer,
  ResourceReadKubeError,
  type MemoryReadStore,
  type OrchestrationRunReadStore,
} from './resource-read'

const now = new Date('2026-05-20T14:00:00.000Z')

const createKube = (overrides: Partial<KubernetesClient> = {}): KubernetesClient => ({
  apply: vi.fn(async (input) => input),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (input) => input),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  listEvents: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
  ...overrides,
})

const orchestrationRecord = (overrides: Partial<OrchestrationRunRecord> = {}): OrchestrationRunRecord => ({
  id: 'orchestration-record-1',
  orchestrationName: 'demo-orchestration',
  deliveryId: 'delivery-1',
  provider: 'workflow',
  status: 'Running',
  externalRunId: 'demo-orchestration-run-1',
  payload: { request: { namespace: 'agents' } },
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

const createOrchestrationStore = (overrides: Partial<OrchestrationRunReadStore> = {}): OrchestrationRunReadStore => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  getOrchestrationRunById: vi.fn(async () => null),
  updateOrchestrationRunDetails: vi.fn(async (input) => orchestrationRecord(input)),
  ...overrides,
})

const createMemoryStore = (overrides: Partial<MemoryReadStore> = {}): MemoryReadStore => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  upsertMemoryResource: vi.fn(async () => ({})),
  ...overrides,
})

describe('resource read v1 API', () => {
  it('maps typed Kubernetes failures to a 502 response for simple resource reads', async () => {
    const kube = createKube({
      get: vi.fn(async () => {
        throw new Error('apiserver unavailable')
      }),
    })

    const response = await getAgentHandler('demo-agent', new Request('http://agents.local/v1/agents/demo-agent'), {
      kubeClient: kube,
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error:
        'kubernetes get-resource failed for agents.agents.proompteng.ai/demo-agent in namespace agents: apiserver unavailable',
    })
  })

  it('refreshes OrchestrationRun status through injected Effect services and closes the store', async () => {
    const resource = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'demo-orchestration-run-1', namespace: 'agents' },
      status: { phase: 'Succeeded' },
    }
    const store = createOrchestrationStore({
      getOrchestrationRunById: vi.fn(async () => orchestrationRecord()),
    })
    const kube = createKube({ get: vi.fn(async () => resource) })

    const result = await Effect.runPromise(
      getOrchestrationRunWithServicesEffect('orchestration-record-1', 'agents').pipe(
        Effect.provide(makeResourceReadKubernetesLayer({ kubeClient: kube })),
        Effect.provide(makeOrchestrationRunReadStoreLayer(() => store)),
      ),
    )

    expect(result.orchestrationRun.status).toBe('Succeeded')
    expect(result.resource).toEqual(resource)
    expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.OrchestrationRun, 'demo-orchestration-run-1', 'agents')
    expect(store.updateOrchestrationRunDetails).toHaveBeenCalledWith({
      id: 'orchestration-record-1',
      status: 'Succeeded',
      externalRunId: 'demo-orchestration-run-1',
      payload: { request: { namespace: 'agents' }, resource },
    })
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('keeps typed ResourceReadKubeError details on OrchestrationRun resource refresh failures', async () => {
    const store = createOrchestrationStore({
      getOrchestrationRunById: vi.fn(async () => orchestrationRecord()),
    })
    const kube = createKube({
      get: vi.fn(async () => {
        throw new Error('rbac denied')
      }),
    })

    const result = await Effect.runPromise(
      getOrchestrationRunWithServicesEffect('orchestration-record-1', 'agents').pipe(
        Effect.provide(makeResourceReadKubernetesLayer({ kubeClient: kube })),
        Effect.provide(makeOrchestrationRunReadStoreLayer(() => store)),
        Effect.either,
      ),
    )

    if (result._tag !== 'Left') throw new Error('expected resource refresh to fail')
    expect(result.left).toBeInstanceOf(ResourceReadKubeError)
    if (!(result.left instanceof ResourceReadKubeError)) throw new Error('expected ResourceReadKubeError')
    expect(result.left.operation).toBe('get-resource')
    expect(result.left.resource).toBe(RESOURCE_MAP.OrchestrationRun)
    expect(result.left.namespace).toBe('agents')
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('closes the memory store when a Memory resource is not found', async () => {
    const store = createMemoryStore()
    const response = await getMemoryHandler('missing-memory', new Request('http://agents.local/v1/memories/missing'), {
      kubeClient: createKube(),
      storeFactory: () => store,
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Memory not found' })
    expect(store.close).toHaveBeenCalledTimes(1)
  })
})
