import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchMocks = vi.hoisted(() => ({
  startResourceWatch: vi.fn(() => ({ stop: vi.fn() })),
}))

vi.mock('../kube-watch', () => ({
  startResourceWatch: watchMocks.startResourceWatch,
}))

import type { WatchOptions } from '../kube-watch'
import { RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, readNested } from '../primitives'
import { __test, configureAgentsControllerRuntime, stopAgentsController } from './index'
import { createControllerState } from './namespace-state'

const defaultConcurrency = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
  repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map<string, number>() },
}

const buildKube = (overrides: Record<string, unknown> = {}) => ({
  apply: vi.fn(async (resource: Record<string, unknown>) => resource),
  applyStatus: vi.fn(async (resource: Record<string, unknown>) => resource),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  ...overrides,
})

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const awaitNamespaceIdle = async (namespace: string) => {
  const tail = __test.getRuntimeMutableState().namespaceQueues.get(namespace)?.tail
  if (!tail) return
  await tail
  // Status watches may add a follow-up while the previously captured tail is still running.
  await awaitNamespaceIdle(namespace)
}

const getWatch = (resource: string) => {
  const calls = watchMocks.startResourceWatch.mock.calls as unknown as Array<[WatchOptions]>
  const watch = calls.find(([options]) => options.resource === resource)?.[0]
  if (!watch) throw new Error(`Missing watch for ${resource}`)
  return watch
}

describe('agents controller startup resync', () => {
  beforeEach(() => {
    stopAgentsController()
    watchMocks.startResourceWatch.mockClear()
  })

  afterEach(() => {
    stopAgentsController()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('does not block namespace watch startup on the initial AgentRun resync', async () => {
    let releaseManualResync!: () => void
    const manualResyncList = new Promise<{ items: [] }>((resolve) => {
      releaseManualResync = () => resolve({ items: [] })
    })
    const listStarted = Promise.withResolvers<void>()
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          listStarted.resolve()
          return manualResyncList
        }
        return { items: [] }
      }),
    })
    const handles: Array<{ stop: () => void }> = []
    const startup = __test.startNamespaceWatches(
      kube as never,
      'agents',
      createControllerState(),
      defaultConcurrency,
      handles,
      { agentRunResourceVersion: '42' },
    )

    try {
      const result = await Promise.race([
        Promise.all([startup, listStarted.promise]).then(() => 'started'),
        delay(100).then(() => 'blocked'),
      ])

      expect(result).toBe('started')
      expect(watchMocks.startResourceWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'agents',
          resource: RESOURCE_MAP.AgentRun,
          resourceVersion: '42',
        }),
      )
    } finally {
      releaseManualResync()
      await startup
      await awaitNamespaceIdle('agents')
      __test.stopWatchHandles(handles)
    }
  })

  it('does not resync AgentRuns for normal watch stream closures', async () => {
    const list = vi.fn(async () => ({ items: [] }))
    const kube = buildKube({ list })
    const handles: Array<{ stop: () => void }> = []

    await __test.startNamespaceWatches(kube as never, 'agents', createControllerState(), defaultConcurrency, handles, {
      agentRunResourceVersion: '42',
    })
    await awaitNamespaceIdle('agents')

    list.mockClear()
    const agentRunWatch = getWatch(RESOURCE_MAP.AgentRun)

    void agentRunWatch.onRestart?.('closed')
    await flush()
    expect(list).not.toHaveBeenCalled()

    void agentRunWatch.onRestart?.('watch_error')
    await awaitNamespaceIdle('agents')
    expect(list).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'agents')

    __test.stopWatchHandles(handles)
  })

  it('does not let delayed watch events rewind an authoritative relist', async () => {
    const namespace = 'agents'
    const initialList = Promise.withResolvers<Record<string, unknown>>()
    const listStarted = Promise.withResolvers<void>()
    const run = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        namespace,
        name: 'run',
        resourceVersion: '90071992547409931',
        generation: 1,
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      status: { phase: 'Succeeded', observedGeneration: 1 },
    }
    const older = { ...run, metadata: { ...run.metadata, resourceVersion: '90071992547409930' }, status: {} }
    const kube = buildKube({
      list: vi.fn(async () => {
        listStarted.resolve()
        return initialList.promise
      }),
    })
    const state = createControllerState()
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, namespace, state, defaultConcurrency, handles)
      await listStarted.promise
      const watch = getWatch(RESOURCE_MAP.AgentRun)
      void watch.onEvent({ type: 'MODIFIED', object: older })
      initialList.resolve({ metadata: { resourceVersion: run.metadata.resourceVersion }, items: [run] })
      await awaitNamespaceIdle(namespace)
      void watch.onEvent({ type: 'MODIFIED', object: older })
      await awaitNamespaceIdle(namespace)
      expect(state.runs.get(namespace, 'run')).toBe(run)
      expect(kube.applyStatus).not.toHaveBeenCalled()
    } finally {
      initialList.resolve({ items: [] })
      __test.stopWatchHandles(handles)
    }
  })

  it('reconciles deleting AgentRuns observed by periodic relist even when the MODIFIED watch event is covered', async () => {
    const namespace = 'agents'
    const deletingRun = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        namespace,
        name: 'deleting-run',
        resourceVersion: '205',
        generation: 1,
        deletionTimestamp: '2026-01-20T00:01:00Z',
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'agent' },
        runtime: { type: 'job' },
      },
      status: {
        phase: 'Running',
        observedGeneration: 1,
        runtimeRef: { type: 'job', name: 'job-deleting', namespace },
      },
    }
    const list = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { resourceVersion: '200' }, items: [] })
      .mockResolvedValueOnce({ metadata: { resourceVersion: '205' }, items: [deletingRun] })
    const kube = buildKube({ list })
    const state = createControllerState()
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, namespace, state, defaultConcurrency, handles)
      await awaitNamespaceIdle(namespace)
      const watch = getWatch(RESOURCE_MAP.AgentRun)

      await __test.resyncAgentRunsForNamespace(kube as never, namespace, state, defaultConcurrency, 'periodic')
      // Watch delivers the MODIFIED event already covered by listVersion=205.
      void watch.onEvent({ type: 'MODIFIED', object: deletingRun })
      await awaitNamespaceIdle(namespace)

      expect(kube.delete).toHaveBeenCalledWith('job', 'job-deleting', namespace, expect.anything())
      expect(kube.patch).toHaveBeenCalledExactlyOnceWith(RESOURCE_MAP.AgentRun, 'deleting-run', namespace, {
        metadata: { finalizers: [] },
      })
    } finally {
      __test.stopWatchHandles(handles)
    }
  })

  it('records a terminal idempotency receipt even if the run is removed before its task starts', async () => {
    vi.stubEnv('AGENTS_AGENTRUN_IDEMPOTENCY_ENABLED', 'true')
    const markAgentRunIdempotencyKeyTerminal = vi.fn(async () => null)
    configureAgentsControllerRuntime({
      createPrimitivesStore: () => ({
        markAgentRunIdempotencyKeyTerminal,
        reserveAgentRunIdempotencyKey: vi.fn(),
        assignAgentRunIdempotencyKey: vi.fn(),
        pruneAgentRunIdempotencyKeys: vi.fn(),
      }),
    })
    const state = createControllerState()
    const kube = buildKube()
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', state, defaultConcurrency, handles)
      await awaitNamespaceIdle('agents')
      const watch = getWatch(RESOURCE_MAP.AgentRun)
      const finishedAt = '2026-01-20T00:00:00Z'
      const terminal = {
        metadata: { name: 'done', namespace: 'agents', uid: 'done-uid', resourceVersion: '2' },
        spec: { agentRef: { name: 'agent' }, idempotencyKey: 'receipt' },
        status: { phase: 'Succeeded', finishedAt },
      }
      void watch.onEvent({ type: 'MODIFIED', object: terminal })
      void watch.onEvent({ type: 'DELETED', object: terminal })
      await awaitNamespaceIdle('agents')
      expect(markAgentRunIdempotencyKeyTerminal).toHaveBeenCalledExactlyOnceWith({
        namespace: 'agents',
        agentName: 'agent',
        idempotencyKey: 'receipt',
        terminalPhase: 'Succeeded',
        terminalAt: finishedAt,
      })
      expect(state.runs.get('agents', 'done')).toBeUndefined()
      expect(kube.patch).not.toHaveBeenCalled()
      expect(kube.applyStatus).not.toHaveBeenCalled()

      void watch.onEvent({
        type: 'MODIFIED',
        object: {
          ...terminal,
          metadata: {
            ...terminal.metadata,
            name: 'cleanup',
            uid: 'cleanup-uid',
            deletionTimestamp: finishedAt,
            finalizers: ['agents.proompteng.ai/runtime-cleanup'],
          },
        },
      })
      await awaitNamespaceIdle('agents')
      expect(kube.patch).toHaveBeenCalledExactlyOnceWith(RESOURCE_MAP.AgentRun, 'cleanup', 'agents', {
        metadata: { finalizers: [] },
      })
      expect(markAgentRunIdempotencyKeyTerminal).toHaveBeenCalledTimes(1)
    } finally {
      __test.stopWatchHandles(handles)
      configureAgentsControllerRuntime({ createPrimitivesStore: undefined })
      __test.getRuntimeMutableState().primitivesStoreRef = null
    }
  })

  it('records terminal idempotency receipts observed by periodic relist even when the MODIFIED watch event is covered', async () => {
    vi.stubEnv('AGENTS_AGENTRUN_IDEMPOTENCY_ENABLED', 'true')
    const markAgentRunIdempotencyKeyTerminal = vi.fn(async () => null)
    configureAgentsControllerRuntime({
      createPrimitivesStore: () => ({
        markAgentRunIdempotencyKeyTerminal,
        reserveAgentRunIdempotencyKey: vi.fn(),
        assignAgentRunIdempotencyKey: vi.fn(),
        pruneAgentRunIdempotencyKeys: vi.fn(),
      }),
    })
    const namespace = 'agents'
    const finishedAt = new Date().toISOString()
    const runningRun = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        namespace,
        name: 'idempotent-run',
        uid: 'idem-uid',
        resourceVersion: '200',
        generation: 1,
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: { agentRef: { name: 'agent' }, idempotencyKey: 'relist-receipt' },
      status: { phase: 'Running', observedGeneration: 1 },
    }
    const terminalRun = {
      ...runningRun,
      metadata: { ...runningRun.metadata, resourceVersion: '205' },
      status: { phase: 'Succeeded', observedGeneration: 1, finishedAt },
    }
    const list = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { resourceVersion: '200' }, items: [runningRun] })
      .mockResolvedValueOnce({ metadata: { resourceVersion: '205' }, items: [terminalRun] })
      .mockResolvedValueOnce({ metadata: { resourceVersion: '206' }, items: [terminalRun] })
    const kube = buildKube({ list })
    const state = createControllerState()
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, namespace, state, defaultConcurrency, handles)
      await awaitNamespaceIdle(namespace)
      const watch = getWatch(RESOURCE_MAP.AgentRun)

      await __test.resyncAgentRunsForNamespace(kube as never, namespace, state, defaultConcurrency, 'periodic')
      // Watch delivers the MODIFIED event already covered by listVersion=205.
      void watch.onEvent({ type: 'MODIFIED', object: terminalRun })
      await awaitNamespaceIdle(namespace)

      expect(markAgentRunIdempotencyKeyTerminal).toHaveBeenCalledExactlyOnceWith({
        namespace,
        agentName: 'agent',
        idempotencyKey: 'relist-receipt',
        terminalPhase: 'Succeeded',
        terminalAt: finishedAt,
      })

      // Subsequent steady-state relists must not repeatedly write the already-terminal receipt.
      await __test.resyncAgentRunsForNamespace(kube as never, namespace, state, defaultConcurrency, 'periodic')
      await awaitNamespaceIdle(namespace)
      expect(markAgentRunIdempotencyKeyTerminal).toHaveBeenCalledTimes(1)
    } finally {
      __test.stopWatchHandles(handles)
      configureAgentsControllerRuntime({ createPrimitivesStore: undefined })
      __test.getRuntimeMutableState().primitivesStoreRef = null
    }
  })

  it('dispatches and completes a 200-run watch burst without replaying stale observations', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    __test.resetControllerRateState()
    for (const [key, value] of Object.entries({
      AGENTS_CONTROLLER_QUEUE_NAMESPACE: '250',
      AGENTS_CONTROLLER_QUEUE_REPO: '250',
      AGENTS_CONTROLLER_QUEUE_CLUSTER: '250',
      AGENTS_CONTROLLER_RATE_WINDOW_SECONDS: '60',
      AGENTS_CONTROLLER_RATE_NAMESPACE: '160',
      AGENTS_CONTROLLER_RATE_REPO: '100',
      AGENTS_CONTROLLER_RATE_CLUSTER: '160',
      AGENTS_CONTROLLER_RUNTIME_DEBRIS_CLEANUP_MODE: 'disabled',
    }))
      vi.stubEnv(key, value)

    const namespace = 'agents'
    const state = createControllerState()
    const concurrency = { ...defaultConcurrency, perNamespace: 200, perAgent: 200, cluster: 200 }
    const runs = new Map<string, Record<string, unknown>>()
    const jobs = new Map<string, Record<string, unknown>>()
    const configMaps = new Map<string, Record<string, unknown>>()
    const terminal = new Set<string>()
    const initialList = Promise.withResolvers<{ items: Record<string, unknown>[] }>()
    const listStarted = Promise.withResolvers<void>()
    const makeRun = (name: string, repository: string) => ({
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name,
        namespace,
        uid: `uid-${name}`,
        generation: 1,
        resourceVersion: '1',
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'agent' },
        implementation: { inline: { text: 'run the fixture' } },
        runtime: { type: 'job' },
        workload: { image: 'registry.example/runner:test' },
        parameters: { repository },
      },
      status: {},
    })
    let resourceVersion = 2
    const nameOf = (resource: Record<string, unknown>) => asString(readNested(resource, ['metadata', 'name']))!
    const phaseOf = (resource: Record<string, unknown>) => readNested(resource, ['status', 'phase'])
    const list = vi.fn(async (kind: string) =>
      kind === RESOURCE_MAP.AgentRun ? { items: [...runs.values()] } : { items: [] },
    )
    list.mockImplementationOnce(() => {
      listStarted.resolve()
      return initialList.promise
    })
    const get = vi.fn(async (kind: string, name: string) => {
      if (kind === RESOURCE_MAP.Agent) {
        return {
          metadata: { name },
          spec: { providerRef: { name: 'provider' }, defaults: { systemPrompt: 'fixture' } },
        }
      }
      if (kind === RESOURCE_MAP.AgentProvider) return { metadata: { name }, spec: { binary: '/runner' } }
      if (kind === 'job') return jobs.get(name) ?? null
      if (kind === 'configmap') return configMaps.get(name) ?? null
      return null
    })
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const name = nameOf(resource)
      if (resource.kind === 'Job') jobs.set(name, resource)
      if (resource.kind === 'ConfigMap') configMaps.set(name, resource)
      return resource
    })
    const applyStatus = vi.fn(async (patch: Record<string, unknown>) => {
      const name = nameOf(patch)
      const previous = runs.get(name)
      if (!previous) throw new Error(`Patched absent run ${name}`)
      if (phaseOf(patch) === 'Succeeded') {
        if (terminal.has(name)) throw new Error(`Duplicate terminal write for ${name}`)
        if (
          readNested(patch, ['metadata', 'resourceVersion']) !== readNested(previous, ['metadata', 'resourceVersion'])
        ) {
          throw new Error(`Stale terminal write for ${name}`)
        }
        terminal.add(name)
      }
      const updated = {
        ...previous,
        metadata: { ...asRecord(previous.metadata), resourceVersion: String(resourceVersion++) },
        status: { ...asRecord(previous.status), ...asRecord(patch.status) },
      }
      runs.set(name, updated)
      void getWatch(RESOURCE_MAP.AgentRun).onEvent({ type: 'MODIFIED', object: updated })
      return updated
    })
    const kube = buildKube({ list, get, apply, applyStatus }) as never
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube, namespace, state, concurrency, handles)
      await listStarted.promise
      const watch = getWatch(RESOURCE_MAP.AgentRun)
      const removed = makeRun('removed-before-reconcile', 'org/hot')
      void watch.onEvent({ type: 'ADDED', object: removed })
      void watch.onEvent({ type: 'DELETED', object: removed })
      for (let i = 0; i < 200; i++) {
        const run = makeRun(`run-${i}`, i < 120 ? 'org/hot' : 'org/cold')
        const latest = { ...run, metadata: { ...run.metadata, resourceVersion: String(resourceVersion++) } }
        runs.set(run.metadata.name, latest)
        void watch.onEvent({ type: 'ADDED', object: run })
        void watch.onEvent({ type: 'MODIFIED', object: latest })
        void watch.onEvent({ type: 'MODIFIED', object: latest })
      }
      const queued = __test.getRuntimeMutableState().namespaceQueues.get(namespace)?.pending
      expect(queued?.size).toBe(201)
      initialList.resolve({ items: [removed] })
      await awaitNamespaceIdle(namespace)

      expect(jobs.size).toBe(160)
      expect(state.runs.admission(namespace, 'not-a-run', 'agent', 'org/hot')).toMatchObject({
        runningCluster: 160,
        runningRepo: 100,
        queuedCluster: 40,
      })
      expect(state.runs.get(namespace, removed.metadata.name)).toBeUndefined()

      vi.setSystemTime(new Date('2026-01-20T00:01:00Z'))
      await __test.resyncAgentRunsForNamespace(kube, namespace, state, concurrency, 'periodic')
      await awaitNamespaceIdle(namespace)
      expect(jobs.size).toBe(200)
      expect([...runs.values()].filter((run) => phaseOf(run) === 'Running')).toHaveLength(200)
      expect(apply.mock.calls.filter(([resource]) => resource.kind === 'Job')).toHaveLength(200)

      get.mockClear()
      const jobWatch = getWatch('job')
      for (const [name, job] of jobs) {
        const finished = { ...job, status: { succeeded: 1 } }
        jobs.set(name, finished)
        void jobWatch.onEvent({ type: 'MODIFIED', object: job })
        void jobWatch.onEvent({ type: 'MODIFIED', object: finished })
        void jobWatch.onEvent({ type: 'MODIFIED', object: finished })
      }
      await awaitNamespaceIdle(namespace)
      expect(get.mock.calls.filter(([kind]) => kind === 'job')).toHaveLength(200)
      expect(terminal.size).toBe(200)
      expect([...runs.values()].every((run) => phaseOf(run) === 'Succeeded')).toBe(true)
      expect(__test.getRuntimeMutableState().namespaceQueues.has(namespace)).toBe(false)
    } finally {
      initialList.resolve({ items: [] })
      __test.stopWatchHandles(handles)
      __test.resetControllerRateState()
    }
  })

  it('does not trigger full reconcile for dependency heartbeat-only events', () => {
    const existing = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'Memory',
      metadata: {
        name: 'agents-primitives',
        namespace: 'agents',
        generation: 2,
        resourceVersion: '100',
      },
      spec: {
        type: 'postgres',
        connection: { secretRef: { name: 'memory-secret' } },
      },
      status: {
        observedGeneration: 2,
        updatedAt: '2026-01-20T00:00:00Z',
        lastCheckedAt: '2026-01-20T00:00:00Z',
        conditions: [{ type: 'Ready', status: 'True', reason: 'SecretResolved', message: '' }],
      },
    }
    const resources = new Map([[existing.metadata.name, existing]])

    expect(
      __test.shouldDependencyEventTriggerFullReconcile(resources, 'MODIFIED', {
        ...existing,
        metadata: { ...existing.metadata, resourceVersion: '101' },
        status: {
          ...existing.status,
          updatedAt: '2026-01-20T00:01:00Z',
          lastCheckedAt: '2026-01-20T00:01:00Z',
        },
      }),
    ).toBe(false)

    expect(
      __test.shouldDependencyEventTriggerFullReconcile(resources, 'MODIFIED', {
        ...existing,
        metadata: { ...existing.metadata, resourceVersion: '102' },
        spec: {
          ...existing.spec,
          default: true,
        },
      }),
    ).toBe(true)

    expect(
      __test.shouldDependencyEventTriggerFullReconcile(resources, 'MODIFIED', {
        ...existing,
        metadata: { ...existing.metadata, resourceVersion: '103' },
        status: {
          ...existing.status,
          conditions: [{ type: 'Ready', status: 'False', reason: 'SecretNotFound', message: 'secret missing' }],
        },
      }),
    ).toBe(true)

    expect(__test.shouldDependencyEventTriggerFullReconcile(resources, 'DELETED', existing)).toBe(true)
  })

  it('does not apply primitive status when only heartbeat timestamps change', async () => {
    const kube = buildKube()
    const readyCondition = { type: 'Ready', status: 'True', reason: 'Reconciled', message: '' }
    const stablePrimitiveConditions = [
      readyCondition,
      { type: 'Progressing', status: 'False', reason: 'Progressing', message: '' },
      { type: 'Degraded', status: 'False', reason: 'Degraded', message: '' },
    ]

    await __test.setStatus(
      kube as never,
      {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'Memory',
        metadata: { name: 'agents-primitives', namespace: 'agents', generation: 2 },
        status: {
          observedGeneration: 2,
          updatedAt: '2026-01-20T00:00:00Z',
          lastCheckedAt: '2026-01-20T00:00:00Z',
          conditions: stablePrimitiveConditions,
        },
      },
      {
        observedGeneration: 2,
        lastCheckedAt: '2026-01-20T00:01:00Z',
        conditions: [readyCondition],
      },
    )

    await __test.setStatus(
      kube as never,
      {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'VersionControlProvider',
        metadata: { name: 'github', namespace: 'agents', generation: 2 },
        status: {
          observedGeneration: 2,
          updatedAt: '2026-01-20T00:00:00Z',
          lastValidatedAt: '2026-01-20T00:00:00Z',
          conditions: stablePrimitiveConditions,
        },
      },
      {
        observedGeneration: 2,
        lastValidatedAt: '2026-01-20T00:01:00Z',
        conditions: [readyCondition],
      },
    )

    expect(kube.applyStatus).not.toHaveBeenCalled()
  })
})
