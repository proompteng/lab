import { createRunnerTelemetry } from '../../runner/telemetry'
import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import type { AgentRunRecord } from './agent-run-store'

import {
  getAgentRunHandler,
  cancelAgentRunHandler,
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

const cancellationFixture = () => {
  const resource = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: { name: 'agent-run-1', namespace: 'agents', uid: 'original-uid' },
    status: { phase: 'Running' },
  }
  let live: Record<string, unknown> | null = resource
  let record: AgentRunRecord = {
    id: 'record-1',
    agentName: 'codex-agent',
    deliveryId: 'delivery-1',
    provider: 'job',
    status: 'Running',
    externalRunId: 'agent-run-1',
    payload: { resource },
  }
  const store = createStoreMock({
    getAgentRunById: vi.fn(async () => record),
    updateAgentRunDetails: vi.fn(async (input) => {
      record = { ...record, ...input, payload: input.payload ?? record.payload }
      return record
    }),
  })
  const kube = createKubeMock(resource)
  vi.mocked(kube.get).mockImplementation(async () => live)
  vi.mocked(kube.delete).mockImplementation(async () => {
    live = null
    return {}
  })
  return {
    deps: { storeFactory: vi.fn(() => store), kubeClient: kube },
    kube,
    store,
    record: () => record,
    setResource: (value: Record<string, unknown> | null) => {
      live = value
    },
  }
}

describe('AgentRun cancellation and retained results', () => {
  const request = () => new Request('http://agents.local/v1/agent-runs/record-1', { method: 'DELETE' })

  it('exposes a UID-bound live snapshot and retains it after resource cleanup', async () => {
    const f = cancellationFixture()
    const resource = {
      ...(f.record().payload.resource as Record<string, unknown>),
      spec: { runtime: { type: 'job' }, secrets: ['agents-artifacts'] },
    }
    f.setResource(resource)
    const telemetry = createRunnerTelemetry({ model: 'gpt-6-astra', effort: 'high', write: () => {} }).snapshot()
    const originalGet = f.kube.get
    f.kube.get = vi.fn(async (...args: Parameters<KubernetesClient['get']>) =>
      args[0] === 'secret'
        ? {
            data: {
              AWS_ACCESS_KEY_ID: Buffer.from('test').toString('base64'),
              AWS_SECRET_ACCESS_KEY: Buffer.from('secret').toString('base64'),
            },
          }
        : originalGet(...args),
    )
    const fetchSnapshot = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify(telemetry)),
    )
    const deps = {
      ...f.deps,
      kubeClient: f.kube,
      env: { AGENTS_ARTIFACTS_ENDPOINT: 'http://storage.test', AGENTS_ARTIFACTS_BUCKET: 'agents-artifacts' },
      fetch: Object.assign(fetchSnapshot, { preconnect: () => undefined }),
    }
    let response = await getAgentRunHandler('record-1', new Request('http://test/run'), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ resource: { status: { runner: { telemetry } } } })
    expect(String(fetchSnapshot.mock.calls[0]?.[0])).toContain('/runner-telemetry/agents/original-uid.json')
    f.setResource(null)
    response = await getAgentRunHandler('record-1', new Request('http://test/run'), deps)
    expect(await response.json()).toMatchObject({
      resource: null,
      agentRun: { payload: { resource: { status: { runner: { telemetry } } } } },
    })
  })

  it('rejects a replacement UID before reading artifact credentials', async () => {
    const f = cancellationFixture()
    f.setResource({
      metadata: { name: 'agent-run-1', namespace: 'agents', uid: 'replacement-uid' },
      spec: { runtime: { type: 'job' }, secrets: ['agents-artifacts'] },
      status: { phase: 'Running' },
    })
    const response = await getAgentRunHandler('record-1', new Request('http://test/run'), f.deps)
    expect(response.status).toBe(409)
    expect(f.kube.get).toHaveBeenCalledTimes(1)
    expect(f.store.updateAgentRunDetails).not.toHaveBeenCalled()
  })

  it('persists cancellation intent before deleting the matching UID and retains the record after cleanup', async () => {
    const f = cancellationFixture()
    const response = await cancelAgentRunHandler('record-1', request(), f.deps)
    expect(response.status).toBe(202)
    expect(f.record()).toMatchObject({ status: 'Cancelling', payload: { cancellation: { uid: 'original-uid' } } })
    expect(f.kube.delete).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'agent-run-1', 'agents', { uid: 'original-uid' })
    expect(vi.mocked(f.store.updateAgentRunDetails).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.kube.delete).mock.invocationCallOrder[0],
    )
    const read = await getAgentRunHandler('record-1', new Request('http://agents.local/v1/agent-runs/record-1'), f.deps)
    expect(await read.json()).toMatchObject({ agentRun: { id: 'record-1', status: 'Cancelled' }, resource: null })
    expect((await cancelAgentRunHandler('record-1', request(), f.deps)).status).toBe(200)
    expect(f.kube.delete).toHaveBeenCalledTimes(1)
  })

  it('retries a failed deletion without losing the cancellation intent', async () => {
    const f = cancellationFixture()
    vi.mocked(f.kube.delete).mockRejectedValueOnce(new Error('temporary Kubernetes failure'))
    expect((await cancelAgentRunHandler('record-1', request(), f.deps)).status).toBe(500)
    const intent = f.record().payload.cancellation
    expect(f.record().status).toBe('Cancelling')
    expect((await cancelAgentRunHandler('record-1', request(), f.deps)).status).toBe(202)
    expect(f.record().payload.cancellation).toEqual(intent)
    expect(f.kube.delete).toHaveBeenCalledTimes(2)
  })

  it('rejects a replacement AgentRun without changing its identity or deleting it', async () => {
    const f = cancellationFixture()
    f.setResource({
      metadata: { name: 'agent-run-1', namespace: 'agents', uid: 'replacement-uid' },
      status: { phase: 'Running' },
    })
    expect((await cancelAgentRunHandler('record-1', request(), f.deps)).status).toBe(409)
    expect(f.kube.delete).not.toHaveBeenCalled()
    expect(f.store.updateAgentRunDetails).not.toHaveBeenCalled()
  })

  it('preserves a completed result when cancellation races with completion', async () => {
    const f = cancellationFixture()
    f.setResource({
      metadata: { name: 'agent-run-1', namespace: 'agents', uid: 'original-uid' },
      status: { phase: 'Succeeded', artifacts: [{ name: 'result', url: 's3://agents/result.json' }] },
    })
    const response = await cancelAgentRunHandler('record-1', request(), f.deps)
    expect(await response.json()).toMatchObject({ agentRun: { status: 'Succeeded' }, cancellationRequested: false })
    expect(f.kube.delete).not.toHaveBeenCalled()
  })

  it('retains new artifact references even when the phase is unchanged', async () => {
    const f = cancellationFixture()
    const resource = {
      metadata: { name: 'agent-run-1', namespace: 'agents', uid: 'original-uid' },
      status: { phase: 'Running', artifacts: [{ name: 'result', url: 's3://agents/result.json' }] },
    }
    f.setResource(resource)
    await getAgentRunHandler('record-1', new Request('http://agents.local/v1/agent-runs/record-1'), f.deps)
    f.setResource(null)
    const response = await getAgentRunHandler(
      'record-1',
      new Request('http://agents.local/v1/agent-runs/record-1'),
      f.deps,
    )
    expect(await response.json()).toMatchObject({ agentRun: { payload: { resource } }, resource: null })
  })

  it('preserves rerun review state and leaves a completed parent resource alone', async () => {
    const f = cancellationFixture()
    const resource = {
      metadata: { name: 'agent-run-1', namespace: 'agents', uid: 'original-uid' },
      status: { phase: 'Succeeded' },
    }
    await f.store.updateAgentRunDetails({ id: 'record-1', status: 'needs_iteration', payload: { resource } })
    f.setResource(resource)
    const response = await cancelAgentRunHandler('record-1', request(), f.deps)
    expect(await response.json()).toMatchObject({
      agentRun: { status: 'needs_iteration' },
      cancellationRequested: false,
    })
    expect(f.kube.delete).not.toHaveBeenCalled()
  })

  it('defers cancellation to the mutation leader before opening a store', async () => {
    const f = cancellationFixture()
    const response = await cancelAgentRunHandler('record-1', request(), {
      ...f.deps,
      requireLeaderForMutation: () => new Response('not leader', { status: 503 }),
    })
    expect(response.status).toBe(503)
    expect(f.deps.storeFactory).not.toHaveBeenCalled()
    expect(f.kube.delete).not.toHaveBeenCalled()
  })
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
