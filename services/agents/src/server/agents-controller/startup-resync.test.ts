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
import { hashAgentRunImmutableSpec } from './immutable-spec'
import { __test, configureAgentsControllerRuntime, stopAgentsController } from './index'
import { createControllerState } from './namespace-state'

const defaultConcurrency = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
  repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map<string, number>() },
}

const makeJobRun = (name: string, namespace = 'agents', status: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name,
    namespace,
    uid: `uid-${name}`,
    generation: 1,
    resourceVersion: '10',
    finalizers: ['agents.proompteng.ai/runtime-cleanup'],
  },
  spec: {
    agentRef: { name: 'agent' },
    implementation: { inline: { text: 'run the fixture' } },
    runtime: { type: 'job' },
    workload: { image: 'registry.example/runner:test' },
  },
  status: { observedGeneration: 1, ...status },
})

const makeRunJob = (run: ReturnType<typeof makeJobRun>, status: Record<string, unknown> = {}) => ({
  metadata: {
    name: `${run.metadata.name}-job`,
    namespace: run.metadata.namespace,
    uid: `job-${run.metadata.uid}`,
    labels: { 'agents.proompteng.ai/agent-run': run.metadata.name, 'agents.proompteng.ai/run-uid': run.metadata.uid },
  },
  status,
})

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

const getWatch = (resource: string, namespace = 'agents') => {
  const calls = watchMocks.startResourceWatch.mock.calls as unknown as Array<[WatchOptions]>
  const watch = calls.find(([options]) => options.resource === resource && options.namespace === namespace)?.[0]
  if (!watch) throw new Error(`Missing watch for ${resource}`)
  return watch
}

const buildJobApi = (initial: ReturnType<typeof makeJobRun>[]) => {
  const runs = new Map(initial.map((run) => [`${run.metadata.namespace}/${run.metadata.name}`, run]))
  const jobs = new Map<string, Record<string, unknown>>()
  let resourceVersion = 11
  const revise = (run: ReturnType<typeof makeJobRun>, status: Record<string, unknown>, watch = true) => {
    const { name, namespace } = run.metadata
    const next = {
      ...run,
      metadata: { ...run.metadata, resourceVersion: String(resourceVersion++) },
      status: { ...run.status, ...status },
    }
    runs.set(`${namespace}/${name}`, next)
    if (watch) void getWatch(RESOURCE_MAP.AgentRun, namespace).onEvent({ type: 'MODIFIED', object: next })
    return next
  }
  const applyStatus = vi.fn(async (patch: Record<string, unknown>) => {
    const metadata = asRecord(patch.metadata)
    const previous = runs.get(`${asString(metadata?.namespace)}/${asString(metadata?.name)}`)
    if (!previous || metadata?.resourceVersion !== previous.metadata.resourceVersion) {
      throw Object.assign(new Error('resourceVersion conflict'), { code: 409 })
    }
    return revise(previous, asRecord(patch.status) ?? {})
  })
  const get = vi.fn(async (kind: string, name: string, namespace: string) => {
    if (kind === RESOURCE_MAP.AgentRun) return runs.get(`${namespace}/${name}`) ?? null
    if (kind === RESOURCE_MAP.Agent) {
      return { metadata: { name }, spec: { providerRef: { name: 'provider' }, defaults: { systemPrompt: 'fixture' } } }
    }
    if (kind === RESOURCE_MAP.AgentProvider) return { metadata: { name }, spec: {} }
    if (kind === 'job') return jobs.get(`${namespace}/${name}`) ?? null
    if (kind === 'configmap') return { metadata: { name } }
    return null
  })
  const apply = vi.fn(async (resource: Record<string, unknown>) => {
    if (resource.kind !== 'Job') return resource
    const metadata = asRecord(resource.metadata)
    const name = asString(metadata?.name)
    const key = `${asString(metadata?.namespace)}/${name}`
    if (jobs.has(key)) throw new Error(`Duplicate Job create: ${key}`)
    const job = { ...resource, metadata: { ...metadata, uid: `uid-${name}` } }
    jobs.set(key, job)
    return job
  })
  const list = vi.fn(async (kind: string, namespace: string) => ({
    items:
      kind === RESOURCE_MAP.AgentRun ? [...runs.values()].filter((run) => run.metadata.namespace === namespace) : [],
  }))
  return { ...buildKube(), runs, jobs, revise, applyStatus, get, apply, list }
}

describe('agents controller startup resync', () => {
  beforeEach(() => {
    stopAgentsController()
    __test.resetControllerRateState()
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

  it.each(['Pending', ''])('repairs phase %j with an existing Job on periodic resync', async (phase) => {
    const runtimeRef = {
      type: 'job',
      name: 'stale-job',
      namespace: 'agents',
      uid: 'job-uid-stale',
      jobObservedAt: '2026-11-28T10:00:00.000Z',
    }
    const run = makeJobRun('stale', 'agents', { phase, runtimeRef })
    const state = createControllerState()
    state.runs.update('agents', 'stale', run)
    const kube = buildKube({
      get: vi.fn(async (kind: string) => (kind === 'job' ? makeRunJob(run, { active: 1 }) : null)),
      list: vi.fn(async (kind: string) => ({ items: kind === RESOURCE_MAP.AgentRun ? [run] : [] })),
    })

    await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state, defaultConcurrency, 'periodic')

    expect(kube.applyStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { name: 'stale', namespace: 'agents', resourceVersion: '10' },
        status: expect.objectContaining({ phase: 'Running', runtimeRef: expect.objectContaining(runtimeRef) }),
      }),
    )
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('finishes an owned Job left by a restart before checking admission', async () => {
    const run = makeJobRun('orphan')
    const job = makeRunJob(run, { succeeded: 1 })
    const state = createControllerState()
    const running = makeJobRun('occupant', 'agents', { phase: 'Running' })
    state.runs.update('agents', 'occupant', running)
    const kube = buildKube({
      get: vi.fn(async (kind: string, name: string) => (kind === 'job' && name === job.metadata.name ? job : null)),
      list: vi.fn(async (kind: string) => ({ items: kind === RESOURCE_MAP.AgentRun ? [run, running] : [] })),
    })

    await __test.resyncAgentRunsForNamespace(
      kube as never,
      'agents',
      state,
      { ...defaultConcurrency, perAgent: 1 },
      'manual',
    )

    expect(kube.applyStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({
          phase: 'Succeeded',
          runtimeRef: { type: 'job', name: job.metadata.name, namespace: 'agents', uid: job.metadata.uid },
        }),
      }),
    )
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('refreshes a stale status write and adopts the Job without charging a second start', async () => {
    vi.useFakeTimers()
    vi.stubEnv('AGENTS_CONTROLLER_RATE_CLUSTER', '1')
    const run = makeJobRun('replayed')
    const kube = buildJobApi([run])
    kube.applyStatus.mockImplementationOnce(async (patch) => {
      expect(readNested(patch, ['metadata', 'resourceVersion'])).toBe('10')
      expect(readNested(patch, ['status', 'phase'])).toBe('Running')
      kube.revise(run, {}, false)
      throw Object.assign(new Error('resourceVersion conflict'), { code: 409 })
    })

    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', createControllerState(), defaultConcurrency, handles)
      await awaitNamespaceIdle('agents')
      expect(kube.get).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'replayed', 'agents')
      expect(kube.applyStatus).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(500)
      await awaitNamespaceIdle('agents')

      expect(kube.applyStatus.mock.calls[1]?.[0]).toMatchObject({
        metadata: { resourceVersion: '11' },
        status: {
          phase: 'Running',
          runtimeRef: { name: 'replayed-job', uid: 'uid-replayed-job' },
          specHash: hashAgentRunImmutableSpec(run),
        },
      })
      expect(kube.apply.mock.calls.filter(([resource]) => resource.kind === 'Job')).toHaveLength(1)
      expect(kube.runs.get('agents/replayed')?.status).toMatchObject({
        phase: 'Running',
        specHash: hashAgentRunImmutableSpec(run),
      })
    } finally {
      __test.stopWatchHandles(handles)
    }
  })

  it('enforces immutability after adopting a Job whose initial Running status write conflicted with a spec mutation', async () => {
    vi.useFakeTimers()
    vi.stubEnv('AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED', 'true')
    const run = makeJobRun('mutated-in-flight')
    const originalSpecHash = hashAgentRunImmutableSpec(run)
    const kube = buildJobApi([run])
    kube.applyStatus.mockImplementationOnce(async (patch) => {
      expect(readNested(patch, ['metadata', 'resourceVersion'])).toBe('10')
      expect(readNested(patch, ['status', 'phase'])).toBe('Running')
      const mutated = {
        ...run,
        metadata: { ...run.metadata, generation: 2, resourceVersion: '11' },
        spec: {
          ...run.spec,
          implementation: { inline: { text: 'tampered while job submission was in flight' } },
        },
      }
      kube.runs.set('agents/mutated-in-flight', mutated)
      throw Object.assign(new Error('resourceVersion conflict'), { code: 409 })
    })

    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', createControllerState(), defaultConcurrency, handles)
      await awaitNamespaceIdle('agents')
      await vi.advanceTimersByTimeAsync(500)
      await awaitNamespaceIdle('agents')

      expect(kube.apply.mock.calls.filter(([resource]) => resource.kind === 'Job')).toHaveLength(1)
      expect(kube.delete).toHaveBeenCalledWith('job', 'mutated-in-flight-job', 'agents', { wait: false })
      expect(kube.runs.get('agents/mutated-in-flight')?.status).toMatchObject({
        phase: 'Failed',
        specHash: originalSpecHash,
        conditions: expect.arrayContaining([
          expect.objectContaining({ type: 'Failed', status: 'True', reason: 'SpecImmutableViolation' }),
        ]),
      })
    } finally {
      __test.stopWatchHandles(handles)
    }
  })

  it('keeps a terminal phase found during conflict refresh even if an older watch update arrives', async () => {
    vi.useFakeTimers()
    const runtimeRef = { type: 'job', name: 'finishing-job', namespace: 'agents', uid: 'job-uid-finishing' }
    const run = makeJobRun('finishing', 'agents', { phase: 'Running', runtimeRef })
    const kube = buildJobApi([run])
    kube.jobs.set('agents/finishing-job', makeRunJob(run, { active: 1 }))
    kube.applyStatus.mockImplementationOnce(async (patch) => {
      expect(readNested(patch, ['metadata', 'resourceVersion'])).toBe('10')
      expect(readNested(patch, ['status', 'phase'])).toBe('Running')
      kube.revise(run, { phase: 'Cancelled', finishedAt: new Date().toISOString() }, false)
      throw Object.assign(new Error('resourceVersion conflict'), { code: 409 })
    })
    const state = createControllerState()
    state.runs.update('agents', 'finishing', run)
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', state, defaultConcurrency, handles)
      await awaitNamespaceIdle('agents')
      void getWatch(RESOURCE_MAP.AgentRun).onEvent({ type: 'MODIFIED', object: run })
      await vi.advanceTimersByTimeAsync(500)
      await awaitNamespaceIdle('agents')

      expect(kube.applyStatus).toHaveBeenCalledTimes(1)
      expect(state.runs.get('agents', 'finishing')?.status).toMatchObject({ phase: 'Cancelled' })
      expect(kube.runs.get('agents/finishing')?.status).toMatchObject({ phase: 'Cancelled' })
    } finally {
      __test.stopWatchHandles(handles)
    }
  })

  it('wakes a concurrency-blocked run in another namespace when cluster capacity frees', async () => {
    const running = makeJobRun('running', 'agents', { phase: 'Running' })
    const waiting = makeJobRun('waiting', 'agents-other')
    const kube = buildJobApi([running, waiting])
    const state = createControllerState()
    const concurrency = { ...defaultConcurrency, cluster: 1 }
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', state, concurrency, handles)
      await awaitNamespaceIdle('agents')
      await __test.startNamespaceWatches(kube as never, 'agents-other', state, concurrency, handles)
      await awaitNamespaceIdle('agents-other')
      expect(kube.runs.get('agents-other/waiting')?.status).toMatchObject({
        phase: 'Pending',
        conditions: expect.arrayContaining([expect.objectContaining({ type: 'Blocked', reason: 'ConcurrencyLimit' })]),
      })
      expect(kube.jobs.size).toBe(0)
      kube.list.mockClear()

      kube.revise(running, { phase: 'Succeeded', finishedAt: new Date().toISOString() })
      await awaitNamespaceIdle('agents-other')

      expect(kube.runs.get('agents-other/waiting')?.status).toMatchObject({ phase: 'Running' })
      expect(kube.jobs.has('agents-other/waiting-job')).toBe(true)
      expect(kube.list).not.toHaveBeenCalled()
    } finally {
      __test.stopWatchHandles(handles)
    }
  })

  it('retries a rate-blocked run at the window reset without a Job signal or resync', async () => {
    vi.useFakeTimers()
    vi.stubEnv('AGENTS_CONTROLLER_RATE_WINDOW_SECONDS', '2')
    vi.stubEnv('AGENTS_CONTROLLER_RATE_NAMESPACE', '1')
    const kube = buildJobApi([makeJobRun('first'), makeJobRun('second')])
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', createControllerState(), defaultConcurrency, handles)
      await awaitNamespaceIdle('agents')
      expect(kube.jobs.has('agents/first-job')).toBe(true)
      expect(kube.runs.get('agents/second')?.status).toMatchObject({
        phase: 'Pending',
        conditions: expect.arrayContaining([expect.objectContaining({ type: 'Blocked', reason: 'RateLimit' })]),
      })
      kube.list.mockClear()

      await vi.advanceTimersByTimeAsync(1999)
      expect(kube.jobs.has('agents/second-job')).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await awaitNamespaceIdle('agents')

      expect(kube.jobs.has('agents/second-job')).toBe(true)
      expect(kube.runs.get('agents/second')?.status).toMatchObject({ phase: 'Running' })
      expect(kube.list).not.toHaveBeenCalled()
    } finally {
      __test.stopWatchHandles(handles)
    }
  })

  it('reserves capacity during a Job create and wakes a rate-blocked run when the create fails', async () => {
    vi.useFakeTimers()
    vi.stubEnv('AGENTS_CONTROLLER_RATE_CLUSTER', '1')
    vi.stubEnv('AGENTS_CONTROLLER_RATE_NAMESPACE', '1')
    const kube = buildJobApi([makeJobRun('rejected'), makeJobRun('next', 'agents-other')])
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const apply = kube.apply.getMockImplementation()!
    kube.apply.mockImplementation(async (resource) => {
      if (resource.kind === 'Job' && readNested(resource, ['metadata', 'name']) === 'rejected-job') {
        started.resolve()
        await finish.promise
        throw new Error('Job creation rejected')
      }
      return apply(resource)
    })
    const handles: Array<{ stop: () => void }> = []
    const state = createControllerState()
    try {
      await __test.startNamespaceWatches(kube as never, 'agents', state, defaultConcurrency, handles)
      await started.promise
      await __test.startNamespaceWatches(kube as never, 'agents-other', state, defaultConcurrency, handles)
      await awaitNamespaceIdle('agents-other')
      expect(kube.runs.get('agents-other/next')?.status).toMatchObject({
        phase: 'Pending',
        conditions: expect.arrayContaining([expect.objectContaining({ type: 'Blocked', reason: 'RateLimit' })]),
      })
      expect(kube.jobs.size).toBe(0)

      finish.resolve()
      await awaitNamespaceIdle('agents')
      await awaitNamespaceIdle('agents-other')

      expect(kube.runs.get('agents/rejected')?.status).toMatchObject({ phase: 'Failed' })
      expect(kube.runs.get('agents-other/next')?.status).toMatchObject({ phase: 'Running' })
      expect([...kube.jobs.keys()]).toEqual(['agents-other/next-job'])
    } finally {
      finish.resolve()
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
        metadata: { finalizers: [], resourceVersion: '205' },
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
        metadata: { finalizers: [], resourceVersion: '2' },
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

  it('preserves terminal idempotency receipts for expired already-terminal runs seeded at startup', async () => {
    vi.stubEnv('AGENTS_CONTROLLER_IDEMPOTENCY_ENABLED', 'true')
    const markAgentRunIdempotencyKeyTerminal = vi.fn(async () => {})
    configureAgentsControllerRuntime({
      createPrimitivesStore: () =>
        ({
          ready: Promise.resolve(),
          markAgentRunIdempotencyKeyTerminal,
        }) as never,
    })

    const namespace = 'agents'
    const finishedAt = '2026-01-20T00:00:00Z'
    const expiredTerminalRun = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        namespace,
        name: 'expired-terminal-run',
        uid: 'expired-idem-uid',
        resourceVersion: '100',
        generation: 1,
      },
      spec: {
        agentRef: { name: 'agent' },
        idempotencyKey: 'startup-expired-receipt',
        ttlSecondsAfterFinished: 1,
      },
      status: { phase: 'Succeeded', observedGeneration: 1, finishedAt },
    }
    const list = vi.fn(async (resource: string) =>
      resource === RESOURCE_MAP.AgentRun
        ? { metadata: { resourceVersion: '100' }, items: [expiredTerminalRun] }
        : { items: [] },
    )
    const kube = buildKube({ list })
    const state = createControllerState()
    const handles: Array<{ stop: () => void }> = []
    try {
      state.runs.update(namespace, 'expired-terminal-run', expiredTerminalRun)
      await __test.startNamespaceWatches(kube as never, namespace, state, defaultConcurrency, handles, {
        agentRunResourceVersion: '100',
      })
      await awaitNamespaceIdle(namespace)

      expect(kube.delete).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'expired-terminal-run', namespace, {
        wait: false,
      })
      expect(markAgentRunIdempotencyKeyTerminal).toHaveBeenCalledExactlyOnceWith({
        namespace,
        agentName: 'agent',
        idempotencyKey: 'startup-expired-receipt',
        terminalPhase: 'Succeeded',
        terminalAt: finishedAt,
      })
    } finally {
      __test.stopWatchHandles(handles)
      configureAgentsControllerRuntime({ createPrimitivesStore: undefined })
      __test.getRuntimeMutableState().primitivesStoreRef = null
    }
  })

  it('reconciles Running workflow continuations observed by periodic relist even when the MODIFIED watch event is covered', async () => {
    vi.stubEnv('AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED', 'true')
    const namespace = 'agents'
    const configMaps = new Map<string, Record<string, unknown>>()
    const baseWorkflow = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        namespace,
        name: 'loop-wf',
        uid: 'wf-uid',
        resourceVersion: '200',
        generation: 1,
        finalizers: ['agents.proompteng.ai/runtime-cleanup'],
      },
      spec: {
        agentRef: { name: 'agent' },
        implementation: { inline: { text: 'run loop step' } },
        runtime: { type: 'workflow', config: { ttlSecondsAfterFinished: 0 } },
        workload: { image: 'registry.example/runner:test' },
        workflow: {
          steps: [
            {
              name: 'step-1',
              implementation: { inline: { text: 'run loop step' } },
              loop: { maxIterations: 3 },
            },
          ],
        },
      },
      status: {
        phase: 'Running',
        observedGeneration: 1,
        runtimeRef: { type: 'workflow', name: 'loop-wf', runName: 'loop-wf', namespace },
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'step-1',
              phase: 'Running',
              attempt: 1,
              jobRef: { name: 'loop-wf-step-1-job-1', namespace },
            },
          ],
        },
      },
    }
    const continuingWorkflow = {
      ...baseWorkflow,
      metadata: { ...baseWorkflow.metadata, resourceVersion: '205' },
      status: {
        ...baseWorkflow.status,
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'step-1',
              phase: 'Pending',
              attempt: 0,
              message: 'Loop continuing',
              loop: { currentIteration: 2, completedIterations: 1, maxIterations: 3 },
            },
          ],
        },
      },
    }
    const list = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { resourceVersion: '200' }, items: [baseWorkflow] })
      .mockResolvedValueOnce({ metadata: { resourceVersion: '205' }, items: [continuingWorkflow] })
    const get = vi.fn(async (kind: string, name: string) => {
      if (kind === RESOURCE_MAP.Agent) {
        return {
          metadata: { name },
          spec: { providerRef: { name: 'provider' }, defaults: { systemPrompt: 'fixture' } },
        }
      }
      if (kind === RESOURCE_MAP.AgentProvider) return { metadata: { name }, spec: { binary: '/runner' } }
      if (kind === 'configmap') return configMaps.get(name) ?? null
      return null
    })
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const name = asString(readNested(resource, ['metadata', 'name']))
      if (resource.kind === 'ConfigMap' && name) configMaps.set(name, resource)
      return resource
    })
    const kube = buildKube({ list, get, apply })
    const state = createControllerState()
    const handles: Array<{ stop: () => void }> = []
    try {
      await __test.startNamespaceWatches(kube as never, namespace, state, defaultConcurrency, handles)
      await awaitNamespaceIdle(namespace)
      apply.mockClear()
      kube.applyStatus.mockClear()
      const watch = getWatch(RESOURCE_MAP.AgentRun)

      await __test.resyncAgentRunsForNamespace(kube as never, namespace, state, defaultConcurrency, 'periodic')
      // Watch delivers the MODIFIED event already covered by listVersion=205.
      void watch.onEvent({ type: 'MODIFIED', object: continuingWorkflow })
      await awaitNamespaceIdle(namespace)

      const appliedJobs = apply.mock.calls.filter(([resource]) => resource.kind === 'Job')
      expect(appliedJobs).toHaveLength(1)
    } finally {
      __test.stopWatchHandles(handles)
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
