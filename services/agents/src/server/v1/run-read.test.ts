import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'

import {
  getAgentRunHandler,
  getRunHandler,
  getRunWithServicesEffect,
  makeRunReadLayer,
  RunReadKubeError,
  type AgentRunDetailsUpdate,
  type RunLookupRecord,
  type RunReadApiStore,
} from './run-read'

const now = new Date('2026-05-18T12:00:00.000Z')

const createKubeMock = (resource: Record<string, unknown> | null): KubernetesClient => ({
  apply: vi.fn(async (input) => input),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (input) => input),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch),
  get: vi.fn(async () => resource),
  list: vi.fn(async () => ({ items: [] })),
  listEvents: vi.fn(async () => ({ items: [] })),
  logs: vi.fn(async () => ''),
})

const createStoreMock = (overrides: Partial<RunReadApiStore>): RunReadApiStore => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  getAgentRunById: vi.fn(async () => null),
  updateAgentRunDetails: vi.fn(async (input: AgentRunDetailsUpdate) => ({
    id: input.id,
    agentName: 'demo-agent',
    deliveryId: 'delivery-1',
    provider: 'job',
    status: input.status,
    externalRunId: input.externalRunId ?? null,
    payload: input.payload ?? {},
    createdAt: now,
    updatedAt: now,
  })),
  getRunById: vi.fn(async () => null),
  updateOrchestrationRunDetails: vi.fn(async (input: AgentRunDetailsUpdate) => ({
    id: input.id,
    orchestrationName: 'demo-orchestration',
    deliveryId: 'delivery-1',
    provider: 'workflow',
    status: input.status,
    externalRunId: input.externalRunId ?? null,
    payload: input.payload ?? {},
    createdAt: now,
    updatedAt: now,
  })),
  ...overrides,
})

describe('run read v1 API', () => {
  it('refreshes an AgentRun status from the Kubernetes resource', async () => {
    const resource = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: { name: 'agent-run-1', namespace: 'agents' },
      status: { phase: 'Succeeded' },
    }
    const store = createStoreMock({
      getAgentRunById: vi.fn(async () => ({
        id: 'record-1',
        agentName: 'demo-agent',
        deliveryId: 'delivery-1',
        provider: 'job',
        status: 'Running',
        externalRunId: 'agent-run-1',
        payload: { request: { namespace: 'agents' } },
        createdAt: now,
        updatedAt: now,
      })),
    })
    const kube = createKubeMock(resource)

    const response = await getAgentRunHandler('record-1', new Request('http://agents.local/v1/agent-runs/record-1'), {
      storeFactory: () => store,
      kubeClient: kube,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { agentRun?: { status?: string }; resource?: Record<string, unknown> }
    expect(body.agentRun?.status).toBe('Succeeded')
    expect(body.resource).toEqual(resource)
    expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'agent-run-1', 'agents')
    expect(store.updateAgentRunDetails).toHaveBeenCalledWith({
      id: 'record-1',
      status: 'Succeeded',
      externalRunId: 'agent-run-1',
      payload: { request: { namespace: 'agents' }, resource },
    })
    expect(store.close).toHaveBeenCalled()
  })

  it('refreshes an OrchestrationRun status from the generic run lookup endpoint', async () => {
    const resource = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: { name: 'orchestration-run-1', namespace: 'agents' },
      status: { phase: 'Failed' },
    }
    const run: RunLookupRecord = {
      kind: 'orchestration',
      record: {
        id: 'orchestration-record-1',
        orchestrationName: 'demo-orchestration',
        deliveryId: 'delivery-1',
        provider: 'workflow',
        status: 'Running',
        externalRunId: 'orchestration-run-1',
        payload: { resource: { metadata: { namespace: 'agents' } } },
        createdAt: now,
        updatedAt: now,
      },
    }
    const store = createStoreMock({ getRunById: vi.fn(async () => run) })
    const kube = createKubeMock(resource)

    const response = await getRunHandler(
      'orchestration-record-1',
      new Request('http://agents.local/v1/runs/record-1'),
      {
        storeFactory: () => store,
        kubeClient: kube,
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      kind?: string
      run?: { status?: string }
      resource?: Record<string, unknown>
    }
    expect(body.kind).toBe('orchestration')
    expect(body.run?.status).toBe('Failed')
    expect(body.resource).toEqual(resource)
    expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.OrchestrationRun, 'orchestration-run-1', 'agents')
    expect(store.updateOrchestrationRunDetails).toHaveBeenCalledWith({
      id: 'orchestration-record-1',
      status: 'Failed',
      externalRunId: 'orchestration-run-1',
      payload: { resource },
    })
    expect(store.close).toHaveBeenCalled()
  })

  it('returns not found when a run record does not exist', async () => {
    const store = createStoreMock({})

    const response = await getRunHandler('missing-run', new Request('http://agents.local/v1/runs/missing-run'), {
      storeFactory: () => store,
      kubeClient: createKubeMock(null),
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('Run not found')
    expect(store.close).toHaveBeenCalled()
  })

  it('returns typed service-layer Kubernetes errors and still closes the store', async () => {
    const run: RunLookupRecord = {
      kind: 'agent',
      record: {
        id: 'record-1',
        agentName: 'demo-agent',
        deliveryId: 'delivery-1',
        provider: 'job',
        status: 'Running',
        externalRunId: 'agent-run-1',
        payload: { request: { namespace: 'agents' } },
        createdAt: now,
        updatedAt: now,
      },
    }
    const store = createStoreMock({ getRunById: vi.fn(async () => run) })
    const kube = { ...createKubeMock(null), get: vi.fn(async () => Promise.reject(new Error('api unavailable'))) }

    const result = await Effect.runPromise(
      getRunWithServicesEffect('record-1', 'agents').pipe(
        Effect.provide(makeRunReadLayer({ storeFactory: () => store, kubeClient: kube })),
        Effect.either,
      ),
    )

    if (result._tag !== 'Left') throw new Error('expected run read to fail')
    expect(result.left).toBeInstanceOf(RunReadKubeError)
    if (!(result.left instanceof RunReadKubeError)) throw new Error('expected RunReadKubeError')
    expect(result.left.operation).toBe('get-resource')
    expect(result.left.resource).toBe(RESOURCE_MAP.AgentRun)
    expect(result.left.namespace).toBe('agents')
    expect(store.close).toHaveBeenCalled()
  })
})
