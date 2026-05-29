import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

const metricsMocks = vi.hoisted(() => ({
  recordReconcileDurationMs: vi.fn(),
  recordAgentRunOutcome: vi.fn(),
  recordAgentRunResyncAdoptions: vi.fn(),
  recordAgentRunUntouchedBacklog: vi.fn(),
  recordAgentRunUntouchedOldestAgeSeconds: vi.fn(),
  recordAgentConcurrency: vi.fn(),
  recordAgentQueueDepth: vi.fn(),
  recordAgentRateLimitRejection: vi.fn(),
}))

const featureFlagsMocks = vi.hoisted(() => ({
  resolveBooleanFeatureToggle: vi.fn(async () => true),
}))

const primitivesStoreMocks = vi.hoisted(() => {
  const now = new Date().toISOString()
  const store = {
    ready: Promise.resolve(),
    reserveAgentRunIdempotencyKey: vi.fn(async () => ({
      record: {
        id: 'idempotency-1',
        namespace: 'agents',
        agentName: 'agent-1',
        idempotencyKey: 'default-key',
        agentRunName: null,
        agentRunUid: null,
        terminalPhase: null,
        terminalAt: null,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
    })),
    assignAgentRunIdempotencyKey: vi.fn(async () => null),
    markAgentRunIdempotencyKeyTerminal: vi.fn(async () => null),
    pruneAgentRunIdempotencyKeys: vi.fn(async () => 0),
  }

  return {
    store,
    createPrimitivesStore: vi.fn(() => store),
  }
})

vi.mock('~/server/metrics', () => metricsMocks)
vi.mock('~/server/feature-flags', () => featureFlagsMocks)
vi.mock('~/server/primitives-store', () => ({
  createPrimitivesStore: primitivesStoreMocks.createPrimitivesStore,
}))

const { recordReconcileDurationMs } = metricsMocks

import {
  __test,
  configureAgentsControllerRuntime,
  startAgentsController,
  stopAgentsController,
} from '~/server/agents-controller'
import { RESOURCE_MAP } from '~/server/kube-types'

configureAgentsControllerRuntime({
  createPrimitivesStore: primitivesStoreMocks.createPrimitivesStore,
})

const finalizer = 'agents.proompteng.ai/runtime-cleanup'
const defaultRunnerImage = 'registry.ide-newton.ts.net/lab/agents-codex-runner:test'
const defaultConcurrency = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
  repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map<string, number>() },
}

const buildInFlight = (
  overrides: Partial<{ total: number; perAgent: Map<string, number>; perRepository: Map<string, number> }> = {},
) => ({
  total: 0,
  perAgent: new Map<string, number>(),
  perRepository: new Map<string, number>(),
  ...overrides,
})

const buildAgentRun = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    name: 'run-1',
    namespace: 'agents',
    generation: 1,
    finalizers: [finalizer],
  },
  spec: {
    agentRef: { name: 'agent-1' },
    implementationSpecRef: { name: 'impl-1' },
    runtime: { type: 'job', config: {} },
    workload: { image: defaultRunnerImage },
  } as Record<string, unknown>,
  status: {},
  ...overrides,
})

const buildKube = (overrides: Record<string, unknown> = {}) => ({
  apply: vi.fn(async (resource: Record<string, unknown>) => {
    const metadata = (resource.metadata ?? {}) as Record<string, unknown>
    const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
    return { ...resource, metadata: { ...metadata, uid } }
  }),
  applyStatus: vi.fn(async (resource: Record<string, unknown>) => resource),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  ...overrides,
})

const getLastStatus = (kube: { applyStatus: ReturnType<typeof vi.fn> }) => {
  const calls = kube.applyStatus.mock.calls
  const last = calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined
  return (last?.status ?? {}) as Record<string, unknown>
}

const findCondition = (status: Record<string, unknown>, type: string) => {
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  return conditions.find((condition) => (condition as Record<string, unknown>).type === type) as
    | Record<string, unknown>
    | undefined
}

const canonicalizeForJsonHash = (value: unknown): unknown => {
  if (value == null) return null
  if (Array.isArray(value)) return value.map((entry) => canonicalizeForJsonHash(entry))
  if (typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry === undefined) continue
    output[key] = canonicalizeForJsonHash(entry)
  }
  return output
}

const hashAgentRunImmutableSpec = (agentRun: Record<string, unknown>) => {
  const spec = (agentRun.spec ?? {}) as Record<string, unknown>
  const secretsRaw = Array.isArray(spec.secrets) ? spec.secrets : []
  const secrets = secretsRaw
    .filter((value) => typeof value === 'string')
    .slice()
    .sort()
  const systemPromptRaw = spec.systemPrompt
  const snapshot = {
    agentRef: (spec.agentRef as Record<string, unknown> | undefined) ?? null,
    implementationSpecRef: (spec.implementationSpecRef as Record<string, unknown> | undefined) ?? null,
    implementation: (spec.implementation as Record<string, unknown> | undefined) ?? null,
    goal: (spec.goal as Record<string, unknown> | undefined) ?? null,
    runtime: (spec.runtime as Record<string, unknown> | undefined) ?? null,
    workflow: (spec.workflow as Record<string, unknown> | undefined) ?? null,
    secrets,
    systemPrompt: typeof systemPromptRaw === 'string' ? systemPromptRaw : null,
    systemPromptRef: (spec.systemPromptRef as Record<string, unknown> | undefined) ?? null,
    vcsRef: (spec.vcsRef as Record<string, unknown> | undefined) ?? null,
    memoryRef: (spec.memoryRef as Record<string, unknown> | undefined) ?? null,
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForJsonHash(snapshot)))
    .digest('hex')
}

const buildMemory = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'Memory',
  metadata: {
    name: 'default-memory',
    namespace: 'agents',
    generation: 1,
  },
  spec: {
    type: 'postgres',
    connection: {
      secretRef: {
        name: 'memory-secret',
        key: 'url',
      },
    },
  },
  status: {},
  ...overrides,
})

const buildVcsProvider = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'VersionControlProvider',
  metadata: {
    name: 'vcs-1',
    namespace: 'agents',
    generation: 1,
  },
  spec: {
    provider: 'github',
    auth: {
      method: 'token',
      token: {
        secretRef: {
          name: 'vcs-token',
          key: 'token',
        },
        type: 'pat',
      },
    },
  },
  status: {},
  ...overrides,
})

describe('agents controller startup', () => {
  it('uses the Agents-owned startup feature flag without a domain gate', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousVitest = process.env.VITEST
    process.env.NODE_ENV = 'development'
    delete process.env.VITEST
    featureFlagsMocks.resolveBooleanFeatureToggle.mockClear()
    featureFlagsMocks.resolveBooleanFeatureToggle.mockResolvedValueOnce(true)

    try {
      await expect(__test.resolveAgentsControllerFeatureEnabled()).resolves.toBe(true)

      expect(featureFlagsMocks.resolveBooleanFeatureToggle).toHaveBeenCalledTimes(1)
      expect(featureFlagsMocks.resolveBooleanFeatureToggle).toHaveBeenCalledWith({
        key: 'agents.controller.enabled',
        keyEnvVar: 'AGENTS_CONTROLLER_ENABLED_FLAG_KEY',
        fallbackEnvVar: 'AGENTS_CONTROLLER_ENABLED',
        defaultValue: true,
      })
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousVitest === undefined) {
        delete process.env.VITEST
      } else {
        process.env.VITEST = previousVitest
      }
    }
  })

  it('avoids duplicate startup when feature flag lookup is pending', async () => {
    featureFlagsMocks.resolveBooleanFeatureToggle.mockClear()
    const previousNodeEnv = process.env.NODE_ENV
    const previousVitest = process.env.VITEST
    process.env.NODE_ENV = 'development'
    delete process.env.VITEST
    let resolveFlag!: (value: boolean) => void
    const flagPromise = new Promise<boolean>((resolve) => {
      resolveFlag = resolve
    })
    featureFlagsMocks.resolveBooleanFeatureToggle.mockReturnValueOnce(flagPromise)

    const first = startAgentsController()
    const second = startAgentsController()
    try {
      expect(featureFlagsMocks.resolveBooleanFeatureToggle).toHaveBeenCalledTimes(1)
    } finally {
      resolveFlag(false)
      await Promise.all([first, second])
      stopAgentsController()
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousVitest === undefined) {
        delete process.env.VITEST
      } else {
        process.env.VITEST = previousVitest
      }
    }
  })

  it('preserves active watch handles when initializing effect layer state', () => {
    const stopWatch = vi.fn()
    const runtimeState = __test.getRuntimeMutableState()
    runtimeState.started = true
    runtimeState.watchHandles = [{ stop: stopWatch }]

    __test.initializeRuntimeMutableStateForLayer()
    stopAgentsController()

    expect(stopWatch).toHaveBeenCalledTimes(1)
  })

  it('stops every startup watch handle that was not committed', () => {
    const stopFirst = vi.fn()
    const stopSecond = vi.fn()

    __test.stopWatchHandles([{ stop: stopFirst }, { stop: stopSecond }])

    expect(stopFirst).toHaveBeenCalledTimes(1)
    expect(stopSecond).toHaveBeenCalledTimes(1)
  })

  it('adopts untouched AgentRuns during controller resync', async () => {
    stopAgentsController()
    const state = { namespaces: new Map() }
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          return {
            items: [
              buildAgentRun({
                metadata: {
                  name: 'run-resync',
                  namespace: 'agents',
                  generation: 1,
                  creationTimestamp: '2026-01-20T00:00:00Z',
                  finalizers: [],
                },
                status: {},
              }),
            ],
          }
        }
        return { items: [] }
      }),
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')

    expect(kube.patch).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-resync', 'agents', {
      metadata: { finalizers: [finalizer] },
    })
    expect(getLastStatus(kube as never).phase).toBe('Running')
    expect(__test.getRuntimeMutableState().agentRunIngestionState.get('agents')?.untouchedRunCount).toBe(1)
  })

  it('does not count Template AgentRuns as untouched during controller resync', async () => {
    stopAgentsController()
    const state = { namespaces: new Map() }
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          return {
            items: [
              buildAgentRun({
                metadata: {
                  name: 'run-template',
                  namespace: 'agents',
                  generation: 5,
                  creationTimestamp: '2026-01-20T00:00:00Z',
                  annotations: { 'agents.proompteng.ai/template': 'true' },
                  finalizers: [],
                },
                status: {
                  observedGeneration: 5,
                  phase: 'Template',
                },
              }),
            ],
          }
        }
        return { items: [] }
      }),
    })

    await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')

    expect(kube.patch).not.toHaveBeenCalled()
    expect(kube.applyStatus).not.toHaveBeenCalled()
    expect(__test.getRuntimeMutableState().agentRunIngestionState.get('agents')?.untouchedRunCount).toBe(0)
  })

  it('adopts missed AgentRuns on watch restart resync', async () => {
    stopAgentsController()
    const state = { namespaces: new Map() }
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          return {
            items: [
              buildAgentRun({
                metadata: {
                  name: 'run-watch-restart',
                  namespace: 'agents',
                  generation: 2,
                  creationTimestamp: '2026-01-20T00:00:00Z',
                  finalizers: [],
                },
                status: {
                  observedGeneration: 1,
                },
              }),
            ],
          }
        }
        return { items: [] }
      }),
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    await __test.resyncAgentRunsForNamespace(
      kube as never,
      'agents',
      state as never,
      defaultConcurrency,
      'watch_restart',
    )

    expect(kube.patch).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-watch-restart', 'agents', {
      metadata: { finalizers: [finalizer] },
    })
    expect(getLastStatus(kube as never).phase).toBe('Running')
  })

  it('emits structured reconcile logs for successful first-touch submission', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    let messages: string[] = []
    try {
      await __test.reconcileAgentRun(
        kube as never,
        buildAgentRun(),
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )
      messages = infoSpy.mock.calls.map((call) => String(call[0]))
    } finally {
      infoSpy.mockRestore()
    }

    expect(messages.some((message) => message.includes('reconcile_started'))).toBe(true)
    expect(messages.some((message) => message.includes('reconcile_submitted'))).toBe(true)
  })

  it('keeps annotated AgentRun templates inert and clears stale runtime state', async () => {
    const kube = buildKube({
      list: vi.fn(async (resource: string, namespace: string, selector: string) => {
        if (
          resource === 'jobs.batch' &&
          namespace === 'agents' &&
          selector === 'agents.proompteng.ai/agent-run=run-template'
        ) {
          return { items: [{ metadata: { name: 'run-template-step-1-attempt-1' } }] }
        }
        return { items: [] }
      }),
    })
    const agentRun = buildAgentRun({
      metadata: {
        name: 'run-template',
        namespace: 'agents',
        generation: 7,
        finalizers: [finalizer],
        annotations: {
          'agents.proompteng.ai/template': 'true',
        },
      },
      status: {
        phase: 'Failed',
        runtimeRef: { type: 'workflow', name: 'run-template', runName: 'run-template', namespace: 'agents' },
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'stale template execution failed',
            lastTransitionTime: '2026-01-20T00:00:00.000Z',
          },
        ],
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    expect(kube.delete).toHaveBeenCalledWith('job', 'run-template-step-1-attempt-1', 'agents', {
      wait: false,
    })
    expect(kube.patch).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-template', 'agents', {
      metadata: { finalizers: [] },
    })
    expect(kube.apply).not.toHaveBeenCalled()

    const status = getLastStatus(kube as never)
    expect(status.phase).toBe('Template')
    expect(findCondition(status, 'Ready')?.status).toBe('True')
    expect(findCondition(status, 'Ready')?.reason).toBe('Template')
    expect(findCondition(status, 'Failed')?.status).not.toBe('True')
  })

  it('gates debug adoption logs behind the debug env flag', async () => {
    stopAgentsController()
    const previousDebug = process.env.AGENTS_CONTROLLER_DEBUG_LOGS
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const state = { namespaces: new Map() }
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          return {
            items: [
              buildAgentRun({
                metadata: {
                  name: 'run-debug',
                  namespace: 'agents',
                  generation: 1,
                  creationTimestamp: '2026-01-20T00:00:00Z',
                  finalizers: [],
                },
                status: {},
              }),
            ],
          }
        }
        return { items: [] }
      }),
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    try {
      delete process.env.AGENTS_CONTROLLER_DEBUG_LOGS
      await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')
      let messages = infoSpy.mock.calls.map((call) => String(call[0]))
      expect(messages.some((message) => message.includes('agentrun_resync_adopted'))).toBe(false)

      infoSpy.mockClear()
      process.env.AGENTS_CONTROLLER_DEBUG_LOGS = 'true'
      await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')
      messages = infoSpy.mock.calls.map((call) => String(call[0]))
      expect(messages.some((message) => message.includes('agentrun_resync_adopted'))).toBe(true)
    } finally {
      infoSpy.mockRestore()
      if (previousDebug === undefined) {
        delete process.env.AGENTS_CONTROLLER_DEBUG_LOGS
      } else {
        process.env.AGENTS_CONTROLLER_DEBUG_LOGS = previousDebug
      }
    }
  })

  it('dedupes repeated ingestion stall logs and emits recovery after two healthy resyncs', async () => {
    stopAgentsController()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:03:00Z'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const state = { namespaces: new Map() }
    const staleRun = buildAgentRun({
      metadata: {
        name: 'run-stale',
        namespace: 'agents',
        generation: 1,
        creationTimestamp: '2026-01-20T00:00:00Z',
        finalizers: [],
      },
      status: {},
    })
    const healthyList = { items: [] }
    const staleList = { items: [staleRun] }
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          return staleList
        }
        return { items: [] }
      }),
      get: vi.fn(async () => null),
    })

    try {
      await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')
      vi.advanceTimersByTime(1500)
      await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')

      let stallMessages = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('agentrun_ingestion_stalled'))
      expect(stallMessages).toHaveLength(1)

      ;(kube.list as ReturnType<typeof vi.fn>).mockImplementation(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          return healthyList
        }
        return { items: [] }
      })

      await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')
      let recoveryMessages = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('agentrun_ingestion_recovered'))
      expect(recoveryMessages).toHaveLength(0)

      await __test.resyncAgentRunsForNamespace(kube as never, 'agents', state as never, defaultConcurrency, 'manual')

      recoveryMessages = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('agentrun_ingestion_recovered'))
      expect(recoveryMessages).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
      infoSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('AgentRun artifacts limits', () => {
  it('trims artifacts to the max and drops oldest', () => {
    const result = __test.limitAgentRunStatusArtifacts(
      [
        { name: 'a1', url: 'https://example.com/1' },
        { name: 'a2', url: 'https://example.com/2' },
        { name: 'a3', url: 'https://example.com/3' },
        { name: 'a4', url: 'https://example.com/4' },
        { name: 'a5', url: 'https://example.com/5' },
      ],
      { maxEntries: 3, strict: false, urlMaxLength: 2048 },
    )

    expect(result.strictViolation).toBe(false)
    expect(result.trimmedCount).toBe(2)
    expect(result.artifacts.map((item) => item.name)).toEqual(['a3', 'a4', 'a5'])
  })

  it('enforces a hard cap of 50 even if max is higher', async () => {
    const kube = buildKube()
    const agentRun = buildAgentRun()

    process.env.AGENTS_AGENTRUN_ARTIFACTS_MAX = '100'

    try {
      const artifacts = Array.from({ length: 60 }, (_, index) => ({
        name: `a${index + 1}`,
        url: `https://example.com/${index + 1}`,
      }))

      await __test.setStatus(kube as never, agentRun, {
        phase: 'Succeeded',
        artifacts,
      })
    } finally {
      delete process.env.AGENTS_AGENTRUN_ARTIFACTS_MAX
    }

    const status = getLastStatus(kube as never)
    expect(Array.isArray(status.artifacts)).toBe(true)
    expect((status.artifacts as unknown[]).length).toBe(50)
    expect(findCondition(status, 'ArtifactsLimited')?.status).toBe('True')
  })

  it('strips artifact urls that exceed the limit', () => {
    const result = __test.limitAgentRunStatusArtifacts([{ name: 'a1', url: '123456' }], {
      maxEntries: 50,
      strict: false,
      urlMaxLength: 5,
    })
    expect(result.strictViolation).toBe(false)
    expect(result.strippedUrlCount).toBe(1)
    expect(result.artifacts[0]).toEqual({ name: 'a1' })
  })

  it('fails the status update in strict mode when limits are exceeded', async () => {
    const kube = buildKube()
    const agentRun = buildAgentRun()

    process.env.AGENTS_AGENTRUN_ARTIFACTS_MAX = '2'
    process.env.AGENTS_AGENTRUN_ARTIFACTS_STRICT = 'true'

    try {
      await __test.setStatus(kube as never, agentRun, {
        phase: 'Succeeded',
        artifacts: [{ name: 'a1' }, { name: 'a2' }, { name: 'a3' }],
      })
    } finally {
      delete process.env.AGENTS_AGENTRUN_ARTIFACTS_MAX
      delete process.env.AGENTS_AGENTRUN_ARTIFACTS_STRICT
    }

    const status = getLastStatus(kube as never)
    expect(status.phase).toBe('Failed')
    expect(findCondition(status, 'ArtifactsLimitExceeded')?.status).toBe('True')
  })
})

describe('agents controller reconcileAgentRun', () => {
  it('ignores NotFound when adding AgentRun finalizer', async () => {
    const patchMock = vi.fn(async () => {
      throw new Error(
        'kubernetes patch failed: Error from server (NotFound): agentruns.agents.proompteng.ai "run-1" not found',
      )
    })
    const kube = buildKube({ patch: patchMock })
    const agentRun = buildAgentRun()
    agentRun.metadata.finalizers = []

    await expect(
      __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0),
    ).resolves.toBeUndefined()

    expect(patchMock).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', {
      metadata: { finalizers: [finalizer] },
    })
  })

  it('ignores NotFound when removing AgentRun finalizer during deletion', async () => {
    const patchMock = vi.fn(async () => {
      throw new Error(
        'kubernetes patch failed: Error from server (NotFound): agentruns.agents.proompteng.ai "run-1" not found',
      )
    })
    const kube = buildKube({ patch: patchMock })
    const agentRun = buildAgentRun()
    ;(agentRun.metadata as unknown as Record<string, unknown>).deletionTimestamp = new Date().toISOString()

    await expect(
      __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0),
    ).resolves.toBeUndefined()

    expect(patchMock).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', {
      metadata: { finalizers: [] },
    })
  })

  it('continues first reconcile after adding the AgentRun finalizer', async () => {
    let lastJob: Record<string, unknown> | null = null
    const kube = buildKube({
      apply: vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') lastJob = applied
        return applied
      }),
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })
    const agentRun = buildAgentRun()
    agentRun.metadata.finalizers = []

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    expect(kube.patch).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', {
      metadata: { finalizers: [finalizer] },
    })
    expect(lastJob).toBeTruthy()

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Running')
    expect(findCondition(status, 'Accepted')?.status).toBe('True')
  })

  it('applies configured runner resource defaults when an AgentRun omits workload resources', async () => {
    const previousResources = process.env.AGENTS_AGENT_RUNNER_RESOURCES
    process.env.AGENTS_AGENT_RUNNER_RESOURCES = JSON.stringify({
      requests: {
        cpu: '1',
        memory: '2Gi',
        'ephemeral-storage': '8Gi',
      },
      limits: {
        memory: '8Gi',
        'ephemeral-storage': '16Gi',
      },
    })

    try {
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        return { ...resource, metadata: { ...metadata, uid } }
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })

      await __test.reconcileAgentRun(
        kube as never,
        buildAgentRun(),
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
      const job = appliedResources.find((resource) => resource.kind === 'Job')
      const jobSpec = (job?.spec ?? {}) as Record<string, unknown>
      const template = (jobSpec.template ?? {}) as Record<string, unknown>
      const podSpec = (template.spec ?? {}) as Record<string, unknown>
      const containers = (podSpec.containers ?? []) as Record<string, unknown>[]

      expect(containers[0]?.resources).toEqual({
        requests: {
          cpu: '1',
          memory: '2Gi',
          'ephemeral-storage': '8Gi',
        },
        limits: {
          memory: '8Gi',
          'ephemeral-storage': '16Gi',
        },
      })
    } finally {
      if (previousResources === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_RESOURCES
      } else {
        process.env.AGENTS_AGENT_RUNNER_RESOURCES = previousResources
      }
    }
  })

  it('allows immutable spec mutations before Accepted', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun()

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight({ perAgent: new Map([['agent-1', defaultConcurrency.perAgent]]) }),
      0,
    )

    const blockedStatus = getLastStatus(kube)
    expect(findCondition(blockedStatus, 'Blocked')?.status).toBe('True')
    expect(blockedStatus.specHash).toBeUndefined()

    const mutated = buildAgentRun({
      spec: {
        ...(agentRun.spec as Record<string, unknown>),
        runtime: { type: 'job', config: { mode: 'mutated' } },
      },
      status: blockedStatus,
    })

    await __test.reconcileAgentRun(kube as never, mutated, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Running')
    expect(findCondition(status, 'Accepted')?.status).toBe('True')
    expect(status.specHash).toBe(hashAgentRunImmutableSpec(mutated))
  })

  it('fails AgentRun when immutable spec fields drift after Accepted', async () => {
    const previousEnforcement = process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED
    process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED = 'true'
    try {
      const kube = buildKube({
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })

      const agentRun = buildAgentRun()
      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const acceptedStatus = getLastStatus(kube)
      expect(acceptedStatus.phase).toBe('Running')
      expect(acceptedStatus.specHash).toBe(hashAgentRunImmutableSpec(agentRun))

      const mutated = buildAgentRun({
        spec: {
          ...(agentRun.spec as Record<string, unknown>),
          runtime: { type: 'job', config: { mode: 'drift' } },
        },
        status: acceptedStatus,
      })

      await __test.reconcileAgentRun(kube as never, mutated, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const status = getLastStatus(kube)
      expect(status.phase).toBe('Failed')
      expect(findCondition(status, 'Failed')?.reason).toBe('SpecImmutableViolation')
    } finally {
      if (previousEnforcement === undefined) {
        delete process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED
      } else {
        process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED = previousEnforcement
      }
    }
  }, 15_000)

  it('does not fail terminal AgentRuns when an older stored immutable spec hash differs', async () => {
    const previousEnforcement = process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED
    process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED = 'true'
    try {
      const kube = buildKube()
      const terminalRun = buildAgentRun({
        status: {
          phase: 'Succeeded',
          finishedAt: new Date().toISOString(),
          specHash: 'legacy-hash-from-older-controller',
          conditions: [
            { type: 'Accepted', status: 'True', reason: 'Submitted' },
            { type: 'Succeeded', status: 'True', reason: 'Completed' },
          ],
        },
      })

      await __test.reconcileAgentRun(
        kube as never,
        terminalRun,
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      expect(kube.applyStatus).not.toHaveBeenCalled()
    } finally {
      if (previousEnforcement === undefined) {
        delete process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED
      } else {
        process.env.AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED = previousEnforcement
      }
    }
  })

  it('blocks AgentRun when repository concurrency limit is reached', async () => {
    const kube = buildKube()

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        parameters: {
          repository: 'proompteng/lab',
        },
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      [],
      {
        ...defaultConcurrency,
        repoConcurrency: { enabled: true, defaultLimit: 1, overrides: new Map() },
      },
      buildInFlight({ perRepository: new Map([['proompteng/lab', 1]]) }),
      0,
    )

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'Blocked')
    expect(condition?.reason).toBe('ConcurrencyLimit')
  })

  it('reclaims stale idempotency reservations when canonical runs are missing', async () => {
    const now = new Date().toISOString()
    primitivesStoreMocks.createPrimitivesStore.mockClear()
    primitivesStoreMocks.store.reserveAgentRunIdempotencyKey.mockResolvedValue({
      record: {
        id: 'idempotency-market-1',
        namespace: 'agents',
        agentName: 'agent-1',
        idempotencyKey: 'market-key',
        agentRunName: 'stale-run',
        agentRunUid: 'stale-uid',
        terminalPhase: null,
        terminalAt: null,
        createdAt: now,
        updatedAt: now,
      },
      created: false,
    } as never)
    primitivesStoreMocks.store.assignAgentRunIdempotencyKey.mockResolvedValue({
      id: 'idempotency-market-1',
      namespace: 'agents',
      agentName: 'agent-1',
      idempotencyKey: 'market-key',
      agentRunName: 'run-1',
      agentRunUid: 'uid-run-1',
      terminalPhase: null,
      terminalAt: null,
      createdAt: now,
      updatedAt: now,
    } as never)

    const kube = buildKube({
      get: vi.fn(async (resource: string, name?: string) => {
        if (resource === RESOURCE_MAP.AgentRun && name === 'stale-run') return null
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        idempotencyKey: 'market-key',
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(findCondition(status, 'Duplicate')).toBeUndefined()
    expect(primitivesStoreMocks.store.assignAgentRunIdempotencyKey).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'agents',
        agentName: 'agent-1',
        idempotencyKey: 'market-key',
        agentRunName: 'run-1',
      }),
    )
    expect(status.phase).toBe('Running')
  })

  it('marks AgentRun failed when provider is missing', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'missing-provider' } },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun()

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingProvider')
  })

  it('marks AgentRun failed when memory reference is missing', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              defaults: { systemPrompt: 'default-agent-prompt' },
              memoryRef: { name: 'default-memory' },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        memoryRef: { name: 'default-memory' },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingMemory')
  })

  it('marks AgentRun failed when required metadata keys are missing', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return {
            metadata: { name: 'impl-1' },
            spec: {
              text: 'demo',
              contract: {
                requiredKeys: ['repository', 'issueNumber'],
              },
            },
          }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun()

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingRequiredMetadata')
    const contract = status.contract as Record<string, unknown>
    expect(contract.requiredKeys).toEqual(['repository', 'issueNumber'])
    expect(contract.missingKeys).toEqual(['repository', 'issueNumber'])
  })

  it('marks AgentRun failed when contract mappings are invalid', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return {
            metadata: { name: 'impl-1' },
            spec: {
              text: 'demo',
              contract: {
                requiredKeys: ['repository'],
                mappings: [{ from: '', to: 'repository' }],
              },
            },
          }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun()

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('InvalidContract')
  })

  it('rejects top-level parameters.prompt even when AgentRun bypasses HTTP API', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        parameters: { prompt: 'forbidden override' },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('ForbiddenParameterKey')
    expect(condition?.message).toContain('spec.parameters.prompt is not allowed')
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('rejects workflow step parameters.prompt even when AgentRun bypasses HTTP API', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [
            {
              name: 'step-one',
              parameters: {
                prompt: 'forbidden override',
              },
            },
          ],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('ForbiddenParameterKey')
    expect(condition?.message).toContain('workflow step step-one')
    expect(condition?.message).toContain('spec.parameters.prompt is not allowed')
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('accepts mapped metadata keys for required contract fields', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })

    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return {
            metadata: { name: 'impl-1' },
            spec: {
              text: 'demo',
              contract: {
                requiredKeys: ['repository', 'issueNumber'],
                mappings: [
                  { from: 'linearRepo', to: 'repository' },
                  { from: 'linearIssue', to: 'issueNumber' },
                ],
              },
            },
          }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        parameters: {
          linearRepo: 'proompteng/lab',
          linearIssue: '1234',
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition).toBeUndefined()
    expect(apply).toHaveBeenCalled()
    const appliedKinds = apply.mock.calls.map((call) => (call[0] as Record<string, unknown>).kind)
    expect(appliedKinds).toContain('Job')
  })

  it('marks AgentRun failed when job runtime lacks an image', async () => {
    const previousImage = process.env.AGENTS_AGENT_RUNNER_IMAGE
    delete process.env.AGENTS_AGENT_RUNNER_IMAGE
    const kube = buildKube()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: {},
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingWorkloadImage')

    if (previousImage) process.env.AGENTS_AGENT_RUNNER_IMAGE = previousImage
  })

  it('marks AgentRun failed when temporal runtime lacks workflowType and taskQueue', async () => {
    const kube = buildKube()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'temporal', config: {} },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingTemporalConfig')
  })

  it('marks AgentRun failed when custom runtime lacks endpoint', async () => {
    const kube = buildKube()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'custom', config: {} },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingEndpoint')
  })

  it('deletes completed AgentRun after retention window', async () => {
    const previousRetention = process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '60'

    try {
      const kube = buildKube()
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        status: { phase: 'Succeeded', finishedAt },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      expect(kube.delete).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', { wait: false })
    } finally {
      if (previousRetention === undefined) {
        delete process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('respects per-run ttlSecondsAfterFinished override', async () => {
    const previousRetention = process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '3600'

    try {
      const kube = buildKube()
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
          workload: { image: defaultRunnerImage },
          ttlSecondsAfterFinished: 60,
        },
        status: { phase: 'Failed', finishedAt },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      expect(kube.delete).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', { wait: false })
    } finally {
      if (previousRetention === undefined) {
        delete process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('disables retention when per-run ttlSecondsAfterFinished is zero', async () => {
    const previousRetention = process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '60'

    try {
      const kube = buildKube()
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
          workload: { image: defaultRunnerImage },
          ttlSecondsAfterFinished: 0,
        },
        status: { phase: 'Succeeded', finishedAt },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      expect(kube.delete).not.toHaveBeenCalled()
    } finally {
      if (previousRetention === undefined) {
        delete process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('keeps completed AgentRun before retention window', async () => {
    const previousRetention = process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '3600'

    try {
      const kube = buildKube()
      const agentRun = buildAgentRun({
        status: { phase: 'Succeeded', finishedAt: new Date().toISOString() },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      expect(kube.delete).not.toHaveBeenCalled()
    } finally {
      if (previousRetention === undefined) {
        delete process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('creates job and configmaps for job runtime', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: {
              binary: '/usr/local/bin/agent-runner',
              inputFiles: [{ path: '/workspace/input.txt', content: 'hello' }],
            },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun()

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job')
    const configMaps = appliedResources.filter((resource) => resource.kind === 'ConfigMap')
    const specConfigMap = configMaps.find((resource) =>
      Boolean((resource.data as Record<string, unknown> | undefined)?.['agent-runner.json']),
    )

    expect(job).toBeTruthy()
    expect(configMaps).toHaveLength(2)
    expect(specConfigMap).toBeTruthy()

    const agentRunnerSpec = JSON.parse(
      String((specConfigMap?.data as Record<string, unknown> | undefined)?.['agent-runner.json'] ?? '{}'),
    ) as Record<string, unknown>
    const payloads = (agentRunnerSpec.payloads ?? {}) as Record<string, unknown>
    expect(agentRunnerSpec.schemaVersion).toBe('agents.proompteng.ai/runner/v1')
    expect(agentRunnerSpec.provider).toBe('provider-1')
    expect(agentRunnerSpec.adapter).toMatchObject({
      type: 'codex-app-server',
      codex: {
        model: 'gpt-5.5',
        effort: 'high',
        sandbox: 'danger-full-access',
        approval: 'never',
        threadConfig: { mcp_servers: {}, web_search: 'live' },
        prompt: 'demo',
      },
    })
    expect((agentRunnerSpec.adapter as { codex?: Record<string, unknown> }).codex?.baseInstructions).toBeUndefined()
    expect(payloads.eventFilePath).toBe('/workspace/run.json')
    expect(payloads).not.toHaveProperty('eventBodyPath')

    const jobLabels = (job?.metadata as Record<string, unknown> | undefined)?.labels as
      | Record<string, string>
      | undefined
    expect(jobLabels?.['agents.proompteng.ai/agent-run']).toBe('run-1')
    expect(jobLabels?.['agents.proompteng.ai/agent']).toBe('agent-1')
    expect(jobLabels?.['agents.proompteng.ai/provider']).toBe('provider-1')

    const jobSpec = (job?.spec as Record<string, unknown> | undefined) ?? {}
    expect(jobSpec.backoffLimit).toBe(0)
  })

  it('does not inject NATS auth env into runner jobs from controller-global settings', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name?: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              defaults: { systemPrompt: 'default-agent-prompt' },
              security: { allowedSecrets: ['codex-nats-credentials'] },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: {
              binary: '/bin/sh',
              adapter: { type: 'exec' },
            },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'secret' && name === 'codex-nats-credentials') {
          return {
            metadata: { name: 'codex-nats-credentials' },
            data: { NATS_USER: 'dXNlcg==', NATS_PASSWORD: 'cGFzcw==' },
          }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun()

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job') as Record<string, unknown> | undefined
    expect(job).toBeTruthy()
    const jobSpec = (job?.spec ?? {}) as Record<string, unknown>
    const template = (jobSpec.template ?? {}) as Record<string, unknown>
    const podSpec = (template.spec ?? {}) as Record<string, unknown>
    const containers = (podSpec.containers ?? []) as Array<Record<string, unknown>>
    const env = (containers[0]?.env ?? []) as Array<Record<string, unknown>>
    expect(env.find((entry) => entry.name === 'NATS_USER')).toBeUndefined()
    expect(env.find((entry) => entry.name === 'NATS_PASSWORD')).toBeUndefined()
  })

  it('honors runtime.config.backoffLimit for agent runner jobs', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: { backoffLimit: 2 } },
        workload: { image: defaultRunnerImage },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job')
    expect(job).toBeTruthy()
    const jobSpec = (job?.spec as Record<string, unknown> | undefined) ?? {}
    expect(jobSpec.backoffLimit).toBe(2)
  })

  it('uses Agent default inline systemPrompt in run payload and stores hash', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              defaults: { systemPrompt: 'from-agent' },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job')
    const specConfigMap = appliedResources.find(
      (resource) => resource.kind === 'ConfigMap' && Boolean((resource.data as Record<string, unknown>)?.['run.json']),
    )

    expect(job).toBeTruthy()
    expect(specConfigMap).toBeTruthy()
    const runJson = JSON.parse(
      String((specConfigMap?.data as Record<string, unknown>)?.['run.json'] ?? '{}'),
    ) as Record<string, unknown>
    const runnerJson = JSON.parse(
      String((specConfigMap?.data as Record<string, unknown>)?.['agent-runner.json'] ?? '{}'),
    ) as Record<string, unknown>
    expect(runJson.systemPrompt).toBe('from-agent')
    expect(runnerJson).toMatchObject({
      adapter: {
        type: 'codex-app-server',
        codex: {
          prompt: 'demo',
        },
      },
    })
    expect((runnerJson.adapter as { codex?: Record<string, unknown> }).codex?.baseInstructions).toBeUndefined()

    const status = getLastStatus(kube)
    expect(status.systemPromptHash).toBe(createHash('sha256').update('from-agent').digest('hex'))

    const podSpec = (job?.spec as Record<string, unknown> | undefined)?.template as Record<string, unknown> | undefined
    const podSpecSpec = (podSpec?.spec as Record<string, unknown> | undefined) ?? {}
    const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
    const container = containers[0] ?? {}
    const env = (container.env as Record<string, unknown>[] | undefined) ?? []
    expect(env.some((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_PATH')).toBe(false)
    const expectedHashVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_EXPECTED_HASH') as
      | Record<string, unknown>
      | undefined
    expect(expectedHashVar?.value).toBe(createHash('sha256').update('from-agent').digest('hex'))
    const requiredVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_REQUIRED') as
      | Record<string, unknown>
      | undefined
    expect(requiredVar?.value).toBe('true')
  })

  it('rejects AgentRun-level inline systemPrompt overrides', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              defaults: { systemPrompt: 'from-agent' },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        systemPrompt: 'from-run',
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('SystemPromptOverrideNotAllowed')
    expect(condition?.message).toContain('AgentRun-level systemPrompt/systemPromptRef overrides are not allowed')
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('mounts Agent default ConfigMap systemPromptRef and stores hash without inline prompt leakage', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              defaults: {
                systemPromptRef: {
                  kind: 'ConfigMap',
                  name: 'prompt-config',
                  key: 'prompt',
                },
              },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'configmap' && name === 'prompt-config') {
          return { data: { prompt: 'prompt-from-configmap' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job')
    const specConfigMap = appliedResources.find(
      (resource) => resource.kind === 'ConfigMap' && Boolean((resource.data as Record<string, unknown>)?.['run.json']),
    )

    expect(job).toBeTruthy()
    expect(specConfigMap).toBeTruthy()
    const runJson = JSON.parse(
      String((specConfigMap?.data as Record<string, unknown>)?.['run.json'] ?? '{}'),
    ) as Record<string, unknown>
    const runnerJson = JSON.parse(
      String((specConfigMap?.data as Record<string, unknown>)?.['agent-runner.json'] ?? '{}'),
    ) as Record<string, unknown>
    expect(runJson.systemPrompt).toBeUndefined()

    const status = getLastStatus(kube)
    expect(status.systemPromptHash).toBe(createHash('sha256').update('prompt-from-configmap').digest('hex'))
    expect(runnerJson).toMatchObject({
      adapter: {
        type: 'codex-app-server',
        codex: {
          systemPromptPath: '/workspace/.codex/system-prompt.txt',
          systemPromptExpectedHash: createHash('sha256').update('prompt-from-configmap').digest('hex'),
          prompt: 'demo',
        },
      },
    })

    const podSpec = (job?.spec as Record<string, unknown> | undefined)?.template as Record<string, unknown> | undefined
    const podSpecSpec = (podSpec?.spec as Record<string, unknown> | undefined) ?? {}
    const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
    const container = containers[0] ?? {}
    const env = (container.env as Record<string, unknown>[] | undefined) ?? []
    const volumes = (podSpecSpec.volumes as Record<string, unknown>[] | undefined) ?? []
    const volumeMounts = (container.volumeMounts as Record<string, unknown>[] | undefined) ?? []

    const envVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_PATH') as Record<string, unknown> | undefined
    expect(envVar?.value).toBe('/workspace/.codex/system-prompt.txt')

    const promptVolume = volumes.find((volume) => {
      const configMap = volume.configMap as Record<string, unknown> | undefined
      return configMap?.name === 'prompt-config'
    }) as Record<string, unknown> | undefined
    expect(promptVolume).toBeTruthy()
    const configMap = (promptVolume?.configMap as Record<string, unknown> | undefined) ?? {}
    const items = (configMap.items as Record<string, unknown>[] | undefined) ?? []
    expect(items[0]?.key).toBe('prompt')
    expect(items[0]?.path).toBe('system-prompt.txt')

    const mount = volumeMounts.find((entry) => entry.mountPath === '/workspace/.codex') as
      | Record<string, unknown>
      | undefined
    expect(mount?.readOnly).toBe(true)

    const expectedHashVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_EXPECTED_HASH') as
      | Record<string, unknown>
      | undefined
    expect(expectedHashVar?.value).toBe(createHash('sha256').update('prompt-from-configmap').digest('hex'))
    const requiredVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_REQUIRED') as
      | Record<string, unknown>
      | undefined
    expect(requiredVar?.value).toBe('true')
  })

  it('mounts Agent default Secret systemPromptRef when allowlisted and included in spec.secrets', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              security: { allowedSecrets: ['prompt-secret'] },
              defaults: {
                systemPromptRef: {
                  kind: 'Secret',
                  name: 'prompt-secret',
                  key: 'prompt',
                },
              },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'secret' && name === 'prompt-secret') {
          return { data: { prompt: Buffer.from('prompt-from-secret', 'utf8').toString('base64') } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        secrets: ['prompt-secret'],
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job')
    const specConfigMap = appliedResources.find(
      (resource) => resource.kind === 'ConfigMap' && Boolean((resource.data as Record<string, unknown>)?.['run.json']),
    )

    expect(job).toBeTruthy()
    expect(specConfigMap).toBeTruthy()
    const runJson = JSON.parse(
      String((specConfigMap?.data as Record<string, unknown>)?.['run.json'] ?? '{}'),
    ) as Record<string, unknown>
    expect(runJson.systemPrompt).toBeUndefined()

    const status = getLastStatus(kube)
    expect(status.systemPromptHash).toBe(createHash('sha256').update('prompt-from-secret').digest('hex'))

    const podSpec = (job?.spec as Record<string, unknown> | undefined)?.template as Record<string, unknown> | undefined
    const podSpecSpec = (podSpec?.spec as Record<string, unknown> | undefined) ?? {}
    const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
    const container = containers[0] ?? {}
    const env = (container.env as Record<string, unknown>[] | undefined) ?? []
    const volumes = (podSpecSpec.volumes as Record<string, unknown>[] | undefined) ?? []

    const envVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_PATH') as Record<string, unknown> | undefined
    expect(envVar?.value).toBe('/workspace/.codex/system-prompt.txt')

    const promptVolume = volumes.find((volume) => {
      const secret = volume.secret as Record<string, unknown> | undefined
      return secret?.secretName === 'prompt-secret'
    }) as Record<string, unknown> | undefined
    expect(promptVolume).toBeTruthy()
    const secret = (promptVolume?.secret as Record<string, unknown> | undefined) ?? {}
    const items = (secret.items as Record<string, unknown>[] | undefined) ?? []
    expect(items[0]?.key).toBe('prompt')
    expect(items[0]?.path).toBe('system-prompt.txt')

    const expectedHashVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_EXPECTED_HASH') as
      | Record<string, unknown>
      | undefined
    expect(expectedHashVar?.value).toBe(createHash('sha256').update('prompt-from-secret').digest('hex'))
    const requiredVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_REQUIRED') as
      | Record<string, unknown>
      | undefined
    expect(requiredVar?.value).toBe('true')
  })

  it('rejects Agent default Secret systemPromptRef when not included in spec.secrets', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              security: { allowedSecrets: ['prompt-secret'] },
              defaults: {
                systemPromptRef: {
                  kind: 'Secret',
                  name: 'prompt-secret',
                  key: 'prompt',
                },
              },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('SecretNotAllowed')
    expect(condition?.message).toContain('system prompt secret prompt-secret is not included in spec.secrets')
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('rejects Agent default Secret systemPromptRef when secret is not allowlisted by the Agent', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              security: { allowedSecrets: ['some-other-secret'] },
              defaults: {
                systemPromptRef: {
                  kind: 'Secret',
                  name: 'prompt-secret',
                  key: 'prompt',
                },
              },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        secrets: ['prompt-secret'],
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('SecretNotAllowed')
    expect(condition?.message).toContain('spec.secrets contains disallowed entries: prompt-secret')
    expect(kube.apply).not.toHaveBeenCalled()
  })

  it('injects auth secret volume and CODEX_AUTH env var', async () => {
    const previousName = process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
    const previousKey = process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
    const previousMountPath = process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
    process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME = 'codex-auth'
    process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY = 'auth.json'
    process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH = '/root/.codex'

    try {
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        return { ...resource, metadata: { ...metadata, uid } }
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })

      const agentRun = buildAgentRun()

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
      const job = appliedResources.find((resource) => resource.kind === 'Job')
      const podSpec = (job?.spec as Record<string, unknown> | undefined)?.template as
        | Record<string, unknown>
        | undefined
      const podSpecSpec = (podSpec?.spec as Record<string, unknown> | undefined) ?? {}
      const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
      const container = containers[0] ?? {}
      const env = (container.env as Record<string, unknown>[] | undefined) ?? []
      const volumes = (podSpecSpec.volumes as Record<string, unknown>[] | undefined) ?? []
      const volumeMounts = (container.volumeMounts as Record<string, unknown>[] | undefined) ?? []

      const codexHomeEnv = env.find((entry) => entry.name === 'CODEX_HOME') as Record<string, unknown> | undefined
      expect(codexHomeEnv?.value).toBe('/root/.codex')
      const codexEnv = env.find((entry) => entry.name === 'CODEX_AUTH') as Record<string, unknown> | undefined
      expect(codexEnv?.value).toBe('/root/.codex/auth.json')

      const authHomeVolume = volumes.find((volume) => volume.name === 'run-1-auth-home') as
        | Record<string, unknown>
        | undefined
      const authHomeEmptyDir = (authHomeVolume?.emptyDir as Record<string, unknown> | undefined) ?? {}
      expect(authHomeEmptyDir).toEqual({})

      const authVolume = volumes.find((volume) => volume.name === 'run-1-auth-secret') as
        | Record<string, unknown>
        | undefined
      const authSecret = (authVolume?.secret as Record<string, unknown> | undefined) ?? {}
      expect(authSecret.secretName).toBe('codex-auth')
      const items = (authSecret.items as Record<string, unknown>[] | undefined) ?? []
      expect(items[0]?.key).toBe('auth.json')

      const authHomeMount = volumeMounts.find((mount) => mount.mountPath === '/root/.codex') as
        | Record<string, unknown>
        | undefined
      expect(authHomeMount?.readOnly).toBeUndefined()

      const authMount = volumeMounts.find((mount) => mount.mountPath === '/root/.codex/auth.json') as
        | Record<string, unknown>
        | undefined
      expect(authMount?.subPath).toBe('auth.json')
      expect(authMount?.readOnly).toBe(true)
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME = previousName
      }
      if (previousKey === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_KEY = previousKey
      }
      if (previousMountPath === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH = previousMountPath
      }
    }
  })

  it('applies default scheduling config and allows per-run overrides', async () => {
    const previousEnv = {
      nodeSelector: process.env.AGENTS_AGENT_RUNNER_NODE_SELECTOR,
      affinity: process.env.AGENTS_AGENT_RUNNER_AFFINITY,
      topologySpread: process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS,
      priorityClass: process.env.AGENTS_AGENT_RUNNER_PRIORITY_CLASS,
      schedulerName: process.env.AGENTS_AGENT_RUNNER_SCHEDULER_NAME,
    }
    const defaultAffinity = {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [{ key: 'tier', operator: 'In', values: ['default'] }],
            },
          ],
        },
      },
    }
    const defaultTopology = [
      {
        maxSkew: 1,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'ScheduleAnyway',
      },
    ]
    process.env.AGENTS_AGENT_RUNNER_NODE_SELECTOR = JSON.stringify({ disktype: 'ssd' })
    process.env.AGENTS_AGENT_RUNNER_AFFINITY = JSON.stringify(defaultAffinity)
    process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS = JSON.stringify(defaultTopology)
    process.env.AGENTS_AGENT_RUNNER_PRIORITY_CLASS = 'default-priority'
    process.env.AGENTS_AGENT_RUNNER_SCHEDULER_NAME = 'default-scheduler'

    try {
      let lastJob: Record<string, unknown> | null = null
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          lastJob = applied
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })

      const agentRun = buildAgentRun()
      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const defaultTemplate = (((lastJob ?? {}) as { spec?: unknown }).spec as { template?: unknown } | undefined)
        ?.template as Record<string, unknown> | undefined
      const defaultPodSpec = (defaultTemplate?.spec as Record<string, unknown> | undefined) ?? {}
      expect(defaultPodSpec.nodeSelector).toEqual({ disktype: 'ssd' })
      expect(defaultPodSpec.affinity).toEqual(defaultAffinity)
      expect(defaultPodSpec.topologySpreadConstraints).toEqual(defaultTopology)
      expect(defaultPodSpec.priorityClassName).toBe('default-priority')
      expect(defaultPodSpec.schedulerName).toBe('default-scheduler')

      const overrideAffinity = {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 1,
              preference: { matchExpressions: [{ key: 'tier', operator: 'In', values: ['override'] }] },
            },
          ],
        },
      }
      const overrideRun = buildAgentRun()
      overrideRun.metadata = { ...overrideRun.metadata, name: 'run-2' }
      overrideRun.spec = {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: {
          type: 'job',
          config: {
            nodeSelector: { disktype: 'gpu' },
            affinity: overrideAffinity,
            topologySpreadConstraints: [
              {
                maxSkew: 1,
                topologyKey: 'kubernetes.io/hostname',
                whenUnsatisfiable: 'DoNotSchedule',
              },
            ],
            priorityClassName: 'run-priority',
            schedulerName: 'run-scheduler',
          },
        },
        workload: { image: defaultRunnerImage },
      }

      lastJob = null
      await __test.reconcileAgentRun(
        kube as never,
        overrideRun,
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const overrideTemplate = (((lastJob ?? {}) as { spec?: unknown }).spec as { template?: unknown } | undefined)
        ?.template as Record<string, unknown> | undefined
      const overridePodSpec = (overrideTemplate?.spec as Record<string, unknown> | undefined) ?? {}
      expect(overridePodSpec.nodeSelector).toEqual({ disktype: 'gpu' })
      expect(overridePodSpec.affinity).toEqual(overrideAffinity)
      expect(overridePodSpec.topologySpreadConstraints).toEqual([
        {
          maxSkew: 1,
          topologyKey: 'kubernetes.io/hostname',
          whenUnsatisfiable: 'DoNotSchedule',
        },
      ])
      expect(overridePodSpec.priorityClassName).toBe('run-priority')
      expect(overridePodSpec.schedulerName).toBe('run-scheduler')
    } finally {
      if (previousEnv.nodeSelector === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_NODE_SELECTOR
      } else {
        process.env.AGENTS_AGENT_RUNNER_NODE_SELECTOR = previousEnv.nodeSelector
      }
      if (previousEnv.affinity === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_AFFINITY
      } else {
        process.env.AGENTS_AGENT_RUNNER_AFFINITY = previousEnv.affinity
      }
      if (previousEnv.topologySpread === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS
      } else {
        process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS = previousEnv.topologySpread
      }
      if (previousEnv.priorityClass === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_PRIORITY_CLASS
      } else {
        process.env.AGENTS_AGENT_RUNNER_PRIORITY_CLASS = previousEnv.priorityClass
      }
      if (previousEnv.schedulerName === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_SCHEDULER_NAME
      } else {
        process.env.AGENTS_AGENT_RUNNER_SCHEDULER_NAME = previousEnv.schedulerName
      }
    }
  })

  it('ignores invalid topology spread env JSON with warnings', async () => {
    const previousEnv = process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS
    process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS = '{invalid'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      let lastJob: Record<string, unknown> | null = null
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          lastJob = applied
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })

      const agentRun = buildAgentRun()
      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const defaultTemplate = (((lastJob ?? {}) as { spec?: unknown }).spec as { template?: unknown } | undefined)
        ?.template as Record<string, unknown> | undefined
      const defaultPodSpec = (defaultTemplate?.spec as Record<string, unknown> | undefined) ?? {}
      expect(defaultPodSpec.topologySpreadConstraints).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS'))
    } finally {
      warnSpy.mockRestore()
      if (previousEnv === undefined) {
        delete process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS
      } else {
        process.env.AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS = previousEnv
      }
    }
  })
  it('marks AgentRun failed when controller blocks secrets', async () => {
    const previousBlocked = process.env.AGENTS_CONTROLLER_BLOCKED_SECRETS
    process.env.AGENTS_CONTROLLER_BLOCKED_SECRETS = 'blocked-secret'

    try {
      const kube = buildKube({
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })
      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
          workload: { image: defaultRunnerImage },
          secrets: ['blocked-secret'],
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const status = getLastStatus(kube)
      const condition = findCondition(status, 'InvalidSpec')
      expect(condition?.reason).toBe('SecretBlocked')
    } finally {
      if (previousBlocked === undefined) {
        delete process.env.AGENTS_CONTROLLER_BLOCKED_SECRETS
      } else {
        process.env.AGENTS_CONTROLLER_BLOCKED_SECRETS = previousBlocked
      }
    }
  })

  it('marks AgentRun failed when auth secret is not allowlisted', async () => {
    const previousName = process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
    process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME = 'codex-auth'

    try {
      const kube = buildKube({
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: {
                providerRef: { name: 'provider-1' },
                defaults: { systemPrompt: 'default-agent-prompt' },
                security: { allowedSecrets: ['some-other-secret'] },
              },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          return null
        }),
      })

      const agentRun = buildAgentRun()

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const status = getLastStatus(kube)
      const condition = findCondition(status, 'InvalidSpec')
      expect(condition?.reason).toBe('SecretNotAllowed')
    } finally {
      if (previousName === undefined) {
        delete process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME
      } else {
        process.env.AGENTS_CONTROLLER_AUTH_SECRET_NAME = previousName
      }
    }
  })

  it('mounts Agent default ConfigMap systemPromptRef for workflow step jobs and stores hash', async () => {
    let lastJob: Record<string, unknown> | null = null
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        lastJob = applied
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: {
              providerRef: { name: 'provider-1' },
              defaults: {
                systemPromptRef: { kind: 'ConfigMap', name: 'prompt-config', key: 'prompt' },
              },
            },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'configmap' && name === 'prompt-config') {
          return { data: { prompt: 'workflow-prompt' } }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: { steps: [{ name: 'step-one' }] },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    expect(lastJob).toBeTruthy()

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Running')
    expect(status.systemPromptHash).toBe(createHash('sha256').update('workflow-prompt').digest('hex'))

    const podTemplate = (((lastJob ?? {}) as { spec?: unknown }).spec as { template?: unknown } | undefined)
      ?.template as Record<string, unknown> | undefined
    const podSpecSpec = (podTemplate?.spec as Record<string, unknown> | undefined) ?? {}
    const containers = (podSpecSpec.containers as Record<string, unknown>[] | undefined) ?? []
    const container = containers[0] ?? {}
    const env = (container.env as Record<string, unknown>[] | undefined) ?? []
    const volumes = (podSpecSpec.volumes as Record<string, unknown>[] | undefined) ?? []
    const volumeMounts = (container.volumeMounts as Record<string, unknown>[] | undefined) ?? []

    const envVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_PATH') as Record<string, unknown> | undefined
    expect(envVar?.value).toBe('/workspace/.codex/system-prompt.txt')

    const promptVolume = volumes.find((volume) => {
      const configMap = volume.configMap as Record<string, unknown> | undefined
      return configMap?.name === 'prompt-config'
    }) as Record<string, unknown> | undefined
    expect(promptVolume).toBeTruthy()

    const mount = volumeMounts.find((entry) => entry.mountPath === '/workspace/.codex') as
      | Record<string, unknown>
      | undefined
    expect(mount?.readOnly).toBe(true)

    const expectedHashVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_EXPECTED_HASH') as
      | Record<string, unknown>
      | undefined
    expect(expectedHashVar?.value).toBe(createHash('sha256').update('workflow-prompt').digest('hex'))
    const requiredVar = env.find((entry) => entry.name === 'CODEX_SYSTEM_PROMPT_REQUIRED') as
      | Record<string, unknown>
      | undefined
    expect(requiredVar?.value).toBe('true')
  })

  it('advances workflow steps and completes', async () => {
    const jobStatuses = new Map<string, Record<string, unknown>>()
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          jobStatuses.set(name, applied)
        }
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return jobStatuses.get(name) ?? null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'step-one' }, { name: 'step-two' }],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const firstStatus = getLastStatus(kube)
    expect(firstStatus.phase).toBe('Running')
    const workflow = (firstStatus.workflow as Record<string, unknown> | undefined) ?? {}
    const steps = Array.isArray(workflow.steps) ? (workflow.steps as Record<string, unknown>[]) : []
    expect(steps[0]?.phase).toBe('Running')
    expect(steps[1]?.phase).toBe('Pending')

    const firstJobName = (steps[0]?.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    expect(firstJobName).toBeTruthy()

    jobStatuses.set(firstJobName ?? '', {
      ...jobStatuses.get(firstJobName ?? ''),
      status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
    })

    const secondAgentRun = { ...agentRun, status: firstStatus }
    await __test.reconcileAgentRun(
      kube as never,
      secondAgentRun,
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const secondStatus = getLastStatus(kube)
    const secondWorkflow = (secondStatus.workflow as Record<string, unknown>) ?? {}
    const secondSteps =
      (Array.isArray(secondWorkflow.steps) ? (secondWorkflow.steps as Record<string, unknown>[]) : []) ?? []
    expect(secondSteps[0]?.phase).toBe('Succeeded')
    expect(secondSteps[1]?.phase).toBe('Running')

    const secondJobName = (secondSteps[1]?.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    jobStatuses.set(secondJobName ?? '', {
      ...jobStatuses.get(secondJobName ?? ''),
      status: { succeeded: 1, startTime: '2026-01-20T00:02:00Z', completionTime: '2026-01-20T00:03:00Z' },
    })

    const thirdAgentRun = { ...agentRun, status: secondStatus }
    await __test.reconcileAgentRun(
      kube as never,
      thirdAgentRun,
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const thirdStatus = getLastStatus(kube)
    const thirdWorkflow = thirdStatus.workflow as Record<string, unknown>
    const thirdSteps = (thirdWorkflow.steps as Record<string, unknown>[]) ?? []
    expect(thirdStatus.phase).toBe('Succeeded')
    expect(thirdWorkflow.phase).toBe('Succeeded')
    expect(thirdSteps[0]?.phase).toBe('Succeeded')
    expect(thirdSteps[1]?.phase).toBe('Succeeded')
  })

  it('propagates workflow step output artifacts from runner pods', async () => {
    const runnerMessage = JSON.stringify({
      status: 'succeeded',
      adapter: 'codex-app-server',
      provider: 'torghut-health-report',
      exitCode: 0,
      artifacts: {
        outputArtifacts: [
          {
            name: 'torghut-health-report',
            path: '/workspace/.agentrun/torghut-health/report.md',
            key: 'torghut/health/run-1/report.md',
            url: 's3://agents-artifacts/torghut/health/run-1/report.md',
          },
        ],
      },
    })
    const jobStatuses = new Map<string, Record<string, unknown>>()
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          jobStatuses.set(name, applied)
        }
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return jobStatuses.get(name) ?? null
        }
        return null
      }),
      list: vi.fn(async (resource: string, _namespace: string, labelSelector?: string) => {
        if (resource === 'pods' && labelSelector?.startsWith('job-name=')) {
          return {
            items: [
              {
                metadata: { name: 'workflow-step-pod' },
                status: {
                  startTime: '2026-05-23T21:39:00Z',
                  containerStatuses: [{ name: 'agent-runner', state: { terminated: { message: runnerMessage } } }],
                },
              },
            ],
          }
        }
        return { items: [] }
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'health-report' }],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const runningStatus = getLastStatus(kube)
    const workflow = (runningStatus.workflow as Record<string, unknown>) ?? {}
    const steps = (workflow.steps as Record<string, unknown>[]) ?? []
    const jobName = (steps[0]?.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    expect(jobName).toBeTruthy()

    jobStatuses.set(jobName ?? '', {
      ...jobStatuses.get(jobName ?? ''),
      status: { succeeded: 1, startTime: '2026-05-23T21:39:00Z', completionTime: '2026-05-23T21:40:00Z' },
    })

    await __test.reconcileAgentRun(
      kube as never,
      { ...agentRun, status: runningStatus },
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Succeeded')
    expect(status.artifacts).toEqual([
      {
        name: 'torghut-health-report',
        path: '/workspace/.agentrun/torghut-health/report.md',
        key: 'torghut/health/run-1/report.md',
        url: 's3://agents-artifacts/torghut/health/run-1/report.md',
      },
    ])
  })

  it('continues and stops loop workflow steps with CEL expressions', async () => {
    const previousLoopsEnabled = process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
    process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = 'true'
    try {
      const jobStatuses = new Map<string, Record<string, unknown>>()
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
          if (name) {
            jobStatuses.set(name, applied)
          }
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string, name: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          if (resource === 'job') {
            return jobStatuses.get(name) ?? null
          }
          return null
        }),
      })

      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow', config: {} },
          workload: { image: defaultRunnerImage },
          workflow: {
            steps: [
              {
                name: 'loop-step',
                loop: {
                  maxIterations: 3,
                  condition: {
                    type: 'cel',
                    expression: 'iteration.index < iteration.maxIterations && iteration.last.control.continue == true',
                    source: {
                      type: 'file',
                      path: '/workspace/.agentrun/loop-control.json',
                      onMissing: 'stop',
                      onInvalid: 'fail',
                    },
                  },
                },
              },
            ],
          },
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const firstStatus = getLastStatus(kube)
      const firstWorkflow = firstStatus.workflow as Record<string, unknown>
      const firstStep = ((firstWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(firstJobName).toContain('iter-1')
      expect(firstStep.phase).toBe('Running')

      jobStatuses.set(firstJobName ?? '', {
        ...jobStatuses.get(firstJobName ?? ''),
        metadata: {
          ...((jobStatuses.get(firstJobName ?? '')?.metadata as Record<string, unknown> | undefined) ?? {}),
          annotations: { 'agents.proompteng.ai/loop-control': '{"continue":true}' },
        },
        status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: firstStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const secondStatus = getLastStatus(kube)
      const secondWorkflow = secondStatus.workflow as Record<string, unknown>
      const secondStep = ((secondWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(secondStep.phase).toBe('Pending')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.currentIteration).toBe(2)
      expect((secondStep.loop as Record<string, unknown> | undefined)?.completedIterations).toBe(1)

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: secondStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const thirdStatus = getLastStatus(kube)
      const thirdWorkflow = thirdStatus.workflow as Record<string, unknown>
      const thirdStep = ((thirdWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const secondJobName = (thirdStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(thirdStep.phase).toBe('Running')
      expect(secondJobName).toContain('iter-2')

      jobStatuses.set(secondJobName ?? '', {
        ...jobStatuses.get(secondJobName ?? ''),
        metadata: {
          ...((jobStatuses.get(secondJobName ?? '')?.metadata as Record<string, unknown> | undefined) ?? {}),
          annotations: { 'agents.proompteng.ai/loop-control': '{"continue":false}' },
        },
        status: { succeeded: 1, startTime: '2026-01-20T00:02:00Z', completionTime: '2026-01-20T00:03:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: thirdStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const fourthStatus = getLastStatus(kube)
      const fourthWorkflow = fourthStatus.workflow as Record<string, unknown>
      const fourthStep = ((fourthWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(fourthStatus.phase).toBe('Succeeded')
      expect(fourthWorkflow.phase).toBe('Succeeded')
      expect(fourthStep.phase).toBe('Succeeded')
      expect((fourthStep.loop as Record<string, unknown> | undefined)?.completedIterations).toBe(2)
      expect((fourthStep.loop as Record<string, unknown> | undefined)?.stopReason).toBe('LoopConditionFalse')
    } finally {
      if (previousLoopsEnabled === undefined) {
        delete process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
      } else {
        process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = previousLoopsEnabled
      }
    }
  })

  it('reads loop control payload from a custom source path', async () => {
    const previousLoopsEnabled = process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
    const loopControlPath = '/tmp/.agentrun/loop-control.json'
    process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = 'true'
    try {
      const jobStatuses = new Map<string, Record<string, unknown>>()
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
          if (name) {
            jobStatuses.set(name, applied)
          }
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string, name: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          if (resource === 'job') {
            return jobStatuses.get(name) ?? null
          }
          return null
        }),
      })

      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow', config: {} },
          workload: { image: defaultRunnerImage },
          workflow: {
            steps: [
              {
                name: 'loop-step',
                loop: {
                  maxIterations: 3,
                  condition: {
                    type: 'cel',
                    expression: 'iteration.index < iteration.maxIterations && iteration.last.control.continue == true',
                    source: {
                      type: 'file',
                      path: loopControlPath,
                      onMissing: 'stop',
                      onInvalid: 'fail',
                    },
                  },
                },
              },
            ],
          },
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      const firstStatus = getLastStatus(kube)
      const firstWorkflow = firstStatus.workflow as Record<string, unknown>
      const firstStep = ((firstWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(firstJobName).toContain('iter-1')
      expect(firstStep.phase).toBe('Running')

      jobStatuses.set(firstJobName ?? '', {
        ...jobStatuses.get(firstJobName ?? ''),
        metadata: {
          ...((jobStatuses.get(firstJobName ?? '')?.metadata as Record<string, unknown> | undefined) ?? {}),
          annotations: {
            'agents.proompteng.ai/loop-control': JSON.stringify({
              [loopControlPath]: { continue: true },
            }),
          },
        },
        status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: firstStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const secondStatus = getLastStatus(kube)
      const secondWorkflow = secondStatus.workflow as Record<string, unknown>
      const secondStep = ((secondWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(secondStep.phase).toBe('Pending')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.currentIteration).toBe(2)

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: secondStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const thirdStatus = getLastStatus(kube)
      const thirdWorkflow = thirdStatus.workflow as Record<string, unknown>
      const thirdStep = ((thirdWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const secondJobName = (thirdStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(thirdStep.phase).toBe('Running')
      expect(secondJobName).toContain('iter-2')

      jobStatuses.set(secondJobName ?? '', {
        ...jobStatuses.get(secondJobName ?? ''),
        metadata: {
          ...((jobStatuses.get(secondJobName ?? '')?.metadata as Record<string, unknown> | undefined) ?? {}),
          annotations: {
            'agents.proompteng.ai/loop-control': JSON.stringify({
              [loopControlPath]: { continue: false },
            }),
          },
        },
        status: { succeeded: 1, startTime: '2026-01-20T00:02:00Z', completionTime: '2026-01-20T00:03:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: thirdStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const fourthStatus = getLastStatus(kube)
      const fourthWorkflow = fourthStatus.workflow as Record<string, unknown>
      const fourthStep = ((fourthWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(fourthStatus.phase).toBe('Succeeded')
      expect(fourthWorkflow.phase).toBe('Succeeded')
      expect(fourthStep.phase).toBe('Succeeded')
      expect((fourthStep.loop as Record<string, unknown> | undefined)?.completedIterations).toBe(2)
      expect((fourthStep.loop as Record<string, unknown> | undefined)?.stopReason).toBe('LoopConditionFalse')
    } finally {
      if (previousLoopsEnabled === undefined) {
        delete process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
      } else {
        process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = previousLoopsEnabled
      }
    }
  })

  it('stops loop when control payload is missing and onMissing=stop', async () => {
    const previousLoopsEnabled = process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
    process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = 'true'
    try {
      const jobStatuses = new Map<string, Record<string, unknown>>()
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
          if (name) {
            jobStatuses.set(name, applied)
          }
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string, name: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          if (resource === 'job') {
            return jobStatuses.get(name) ?? null
          }
          return null
        }),
      })

      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow', config: {} },
          workload: { image: defaultRunnerImage },
          workflow: {
            steps: [
              {
                name: 'loop-step',
                loop: {
                  maxIterations: 5,
                  condition: {
                    type: 'cel',
                    expression: 'iteration.last.control.continue == true',
                    source: {
                      type: 'file',
                      onMissing: 'stop',
                      onInvalid: 'fail',
                    },
                  },
                },
              },
            ],
          },
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)
      const firstStatus = getLastStatus(kube)
      const firstWorkflow = firstStatus.workflow as Record<string, unknown>
      const firstStep = ((firstWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(firstJobName).toContain('iter-1')

      jobStatuses.set(firstJobName ?? '', {
        ...jobStatuses.get(firstJobName ?? ''),
        status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: firstStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const secondStatus = getLastStatus(kube)
      const secondWorkflow = secondStatus.workflow as Record<string, unknown>
      const secondStep = ((secondWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(secondStatus.phase).toBe('Succeeded')
      expect(secondWorkflow.phase).toBe('Succeeded')
      expect(secondStep.phase).toBe('Succeeded')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.stopReason).toBe('LoopConditionFalse')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.completedIterations).toBe(1)
    } finally {
      if (previousLoopsEnabled === undefined) {
        delete process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
      } else {
        process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = previousLoopsEnabled
      }
    }
  })

  it('fails loop when control payload is missing and onMissing=fail', async () => {
    const previousLoopsEnabled = process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
    process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = 'true'
    try {
      const jobStatuses = new Map<string, Record<string, unknown>>()
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
          if (name) {
            jobStatuses.set(name, applied)
          }
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string, name: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          if (resource === 'job') {
            return jobStatuses.get(name) ?? null
          }
          return null
        }),
      })

      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow', config: {} },
          workload: { image: defaultRunnerImage },
          workflow: {
            steps: [
              {
                name: 'loop-step',
                loop: {
                  maxIterations: 5,
                  condition: {
                    type: 'cel',
                    expression: 'iteration.last.control.continue == true',
                    source: {
                      type: 'file',
                      onMissing: 'fail',
                      onInvalid: 'fail',
                    },
                  },
                },
              },
            ],
          },
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)
      const firstStatus = getLastStatus(kube)
      const firstWorkflow = firstStatus.workflow as Record<string, unknown>
      const firstStep = ((firstWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(firstJobName).toContain('iter-1')

      jobStatuses.set(firstJobName ?? '', {
        ...jobStatuses.get(firstJobName ?? ''),
        status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: firstStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const secondStatus = getLastStatus(kube)
      const secondWorkflow = secondStatus.workflow as Record<string, unknown>
      const secondStep = ((secondWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(secondStatus.phase).toBe('Failed')
      expect(secondWorkflow.phase).toBe('Failed')
      expect(secondStep.phase).toBe('Failed')
      expect(String(secondStep.message ?? '')).toContain('loop control payload is missing')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.stopReason).toBe('LoopConditionError')
    } finally {
      if (previousLoopsEnabled === undefined) {
        delete process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
      } else {
        process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = previousLoopsEnabled
      }
    }
  })

  it('fails loop when control payload is invalid and onInvalid=fail', async () => {
    const previousLoopsEnabled = process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
    process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = 'true'
    try {
      const jobStatuses = new Map<string, Record<string, unknown>>()
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
          if (name) {
            jobStatuses.set(name, applied)
          }
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string, name: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          if (resource === 'job') {
            return jobStatuses.get(name) ?? null
          }
          return null
        }),
      })

      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow', config: {} },
          workload: { image: defaultRunnerImage },
          workflow: {
            steps: [
              {
                name: 'loop-step',
                loop: {
                  maxIterations: 5,
                  condition: {
                    type: 'cel',
                    expression: 'iteration.last.control.continue == true',
                    source: {
                      type: 'file',
                      onMissing: 'stop',
                      onInvalid: 'fail',
                    },
                  },
                },
              },
            ],
          },
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)
      const firstStatus = getLastStatus(kube)
      const firstWorkflow = firstStatus.workflow as Record<string, unknown>
      const firstStep = ((firstWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(firstJobName).toContain('iter-1')

      jobStatuses.set(firstJobName ?? '', {
        ...jobStatuses.get(firstJobName ?? ''),
        metadata: {
          ...((jobStatuses.get(firstJobName ?? '')?.metadata as Record<string, unknown> | undefined) ?? {}),
          annotations: { 'agents.proompteng.ai/loop-control': '{"continue":' },
        },
        status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: firstStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const secondStatus = getLastStatus(kube)
      const secondWorkflow = secondStatus.workflow as Record<string, unknown>
      const secondStep = ((secondWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(secondStatus.phase).toBe('Failed')
      expect(secondWorkflow.phase).toBe('Failed')
      expect(secondStep.phase).toBe('Failed')
      expect(String(secondStep.message ?? '')).toContain('invalid loop control annotation JSON')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.stopReason).toBe('LoopConditionError')
    } finally {
      if (previousLoopsEnabled === undefined) {
        delete process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
      } else {
        process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = previousLoopsEnabled
      }
    }
  })

  it('stops loop at maxIterations when no condition is provided', async () => {
    const previousLoopsEnabled = process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
    process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = 'true'
    try {
      const jobStatuses = new Map<string, Record<string, unknown>>()
      const apply = vi.fn(async (resource: Record<string, unknown>) => {
        const metadata = (resource.metadata ?? {}) as Record<string, unknown>
        const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
        const applied = { ...resource, metadata: { ...metadata, uid } }
        if (resource.kind === 'Job') {
          const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
          if (name) {
            jobStatuses.set(name, applied)
          }
        }
        return applied
      })
      const kube = buildKube({
        apply,
        get: vi.fn(async (resource: string, name: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
            }
          }
          if (resource === RESOURCE_MAP.AgentProvider) {
            return {
              metadata: { name: 'provider-1' },
              spec: { binary: '/usr/local/bin/agent-runner' },
            }
          }
          if (resource === RESOURCE_MAP.ImplementationSpec) {
            return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
          }
          if (resource === 'job') {
            return jobStatuses.get(name) ?? null
          }
          return null
        }),
      })

      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'workflow', config: {} },
          workload: { image: defaultRunnerImage },
          workflow: {
            steps: [
              {
                name: 'loop-step',
                loop: {
                  maxIterations: 2,
                },
              },
            ],
          },
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)
      const firstStatus = getLastStatus(kube)
      const firstWorkflow = firstStatus.workflow as Record<string, unknown>
      const firstStep = ((firstWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(firstJobName).toContain('iter-1')

      jobStatuses.set(firstJobName ?? '', {
        ...jobStatuses.get(firstJobName ?? ''),
        status: { succeeded: 1, startTime: '2026-01-20T00:00:00Z', completionTime: '2026-01-20T00:01:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: firstStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )
      const secondStatus = getLastStatus(kube)
      const secondWorkflow = secondStatus.workflow as Record<string, unknown>
      const secondStep = ((secondWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(secondStep.phase).toBe('Pending')
      expect((secondStep.loop as Record<string, unknown> | undefined)?.currentIteration).toBe(2)

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: secondStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )
      const thirdStatus = getLastStatus(kube)
      const thirdWorkflow = thirdStatus.workflow as Record<string, unknown>
      const thirdStep = ((thirdWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      const secondJobName = (thirdStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
      expect(secondJobName).toContain('iter-2')

      jobStatuses.set(secondJobName ?? '', {
        ...jobStatuses.get(secondJobName ?? ''),
        status: { succeeded: 1, startTime: '2026-01-20T00:02:00Z', completionTime: '2026-01-20T00:03:00Z' },
      })

      await __test.reconcileAgentRun(
        kube as never,
        { ...agentRun, status: thirdStatus },
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const fourthStatus = getLastStatus(kube)
      const fourthWorkflow = fourthStatus.workflow as Record<string, unknown>
      const fourthStep = ((fourthWorkflow.steps as Record<string, unknown>[] | undefined) ?? [])[0] ?? {}
      expect(fourthStatus.phase).toBe('Succeeded')
      expect(fourthWorkflow.phase).toBe('Succeeded')
      expect(fourthStep.phase).toBe('Succeeded')
      expect((fourthStep.loop as Record<string, unknown> | undefined)?.completedIterations).toBe(2)
      expect((fourthStep.loop as Record<string, unknown> | undefined)?.stopReason).toBe('LoopMaxIterationsReached')
    } finally {
      if (previousLoopsEnabled === undefined) {
        delete process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED
      } else {
        process.env.AGENTS_CONTROLLER_WORKFLOW_LOOPS_ENABLED = previousLoopsEnabled
      }
    }
  })

  it('waits for workflow job creation before reconciling status', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'step-one' }],
        },
      },
      status: {
        phase: 'Running',
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'step-one',
              phase: 'Running',
              attempt: 1,
              lastTransitionTime: '2026-01-20T00:00:00Z',
              jobRef: { name: 'run-1-step-1', namespace: 'agents' },
            },
          ],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const workflow = (status.workflow as Record<string, unknown> | undefined) ?? {}
    const steps = Array.isArray(workflow.steps) ? (workflow.steps as Record<string, unknown>[]) : []
    expect(steps[0]?.phase).toBe('Running')
    expect(steps[0]?.message).toBe('Waiting for job to be created')
    expect(typeof steps[0]?.jobObservedAt).toBe('string')
  })

  it('warns when workflow jobs disappear after observation', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'step-one', retries: 1 }],
        },
      },
      status: {
        phase: 'Running',
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'step-one',
              phase: 'Running',
              attempt: 1,
              lastTransitionTime: '2026-01-20T00:00:00Z',
              jobObservedAt: '2026-01-20T00:00:05Z',
              jobRef: { name: 'run-1-step-1', namespace: 'agents' },
            },
          ],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const warning = findCondition(status, 'Warning')
    expect(warning?.reason).toBe('WorkflowJobMissing')
  })

  it('retries workflow steps when mounted runtime ConfigMaps disappear', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job' && name === 'run-1-step-1-attempt-1') {
          return {
            metadata: { name: 'run-1-step-1-attempt-1', namespace: 'agents' },
            spec: {
              template: {
                spec: {
                  volumes: [
                    { name: 'run-spec', configMap: { name: 'run-1-spec-step-1-attempt-1' } },
                    { name: 'workspace', emptyDir: {} },
                  ],
                },
              },
            },
            status: {},
          }
        }
        if (resource === 'configmap' && name === 'run-1-spec-step-1-attempt-1') {
          return null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'step-one', retries: 1 }],
        },
      },
      status: {
        phase: 'Running',
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'step-one',
              phase: 'Running',
              attempt: 1,
              lastTransitionTime: '2026-01-20T00:00:00Z',
              jobObservedAt: '2026-01-20T00:00:05Z',
              jobRef: { name: 'run-1-step-1-attempt-1', namespace: 'agents' },
            },
          ],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const warning = findCondition(status, 'Warning')
    const workflow = (status.workflow as Record<string, unknown> | undefined) ?? {}
    const steps = Array.isArray(workflow.steps) ? (workflow.steps as Record<string, unknown>[]) : []
    expect(warning?.reason).toBe('WorkflowConfigMapMissing')
    expect(steps[0]?.phase).toBe('Retrying')
    expect(steps[0]?.message).toBe('Runtime ConfigMap missing; retrying')
  })

  it('retries workflow steps with backoff', async () => {
    const jobStatuses = new Map<string, Record<string, unknown>>()
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          jobStatuses.set(name, applied)
        }
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return {
            metadata: { name: 'provider-1' },
            spec: { binary: '/usr/local/bin/agent-runner' },
          }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return jobStatuses.get(name) ?? null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'retry-step', retries: 1, retryBackoffSeconds: 60 }],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const firstStatus = getLastStatus(kube)
    const firstWorkflow = firstStatus.workflow as Record<string, unknown>
    const firstSteps = (firstWorkflow.steps as Record<string, unknown>[]) ?? []
    const firstJobName = (firstSteps[0]?.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    jobStatuses.set(firstJobName ?? '', {
      ...jobStatuses.get(firstJobName ?? ''),
      status: { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] },
    })

    const secondAgentRun = { ...agentRun, status: firstStatus }
    await __test.reconcileAgentRun(
      kube as never,
      secondAgentRun,
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const secondStatus = getLastStatus(kube)
    const secondWorkflow = secondStatus.workflow as Record<string, unknown>
    const secondSteps = (secondWorkflow.steps as Record<string, unknown>[]) ?? []
    expect(secondSteps[0]?.phase).toBe('Retrying')
    expect(secondSteps[0]?.nextRetryAt).toBeTruthy()

    const retryStatus = {
      ...secondStatus,
      workflow: {
        ...(secondStatus.workflow as Record<string, unknown>),
        steps: [
          {
            ...secondSteps[0],
            nextRetryAt: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      },
    }
    const thirdAgentRun = { ...agentRun, status: retryStatus }
    await __test.reconcileAgentRun(
      kube as never,
      thirdAgentRun,
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const thirdStatus = getLastStatus(kube)
    const thirdWorkflow = thirdStatus.workflow as Record<string, unknown>
    const thirdSteps = (thirdWorkflow.steps as Record<string, unknown>[]) ?? []
    expect(thirdSteps[0]?.attempt).toBe(2)
    expect(thirdSteps[0]?.phase).toBe('Running')
  })

  it('propagates failed workflow job reason and message onto AgentRun status', async () => {
    const jobStatuses = new Map<string, Record<string, unknown>>()
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          jobStatuses.set(name, applied)
        }
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return jobStatuses.get(name) ?? null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'deploy-step', retries: 0 }],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const firstStatus = getLastStatus(kube)
    const firstWorkflow = firstStatus.workflow as Record<string, unknown>
    const firstStep = ((firstWorkflow.steps as Record<string, unknown>[]) ?? [])[0] ?? {}
    const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    jobStatuses.set(firstJobName ?? '', {
      ...jobStatuses.get(firstJobName ?? ''),
      status: {
        failed: 1,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'container exited with code 17',
          },
        ],
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      { ...agentRun, status: firstStatus },
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const failedStatus = getLastStatus(kube)
    expect(failedStatus.phase).toBe('Failed')
    expect(failedStatus.reason).toBe('BackoffLimitExceeded')
    expect(failedStatus.message).toBe('workflow step deploy-step: container exited with code 17')
    const failedWorkflow = failedStatus.workflow as Record<string, unknown>
    const failedStep = ((failedWorkflow.steps as Record<string, unknown>[]) ?? [])[0] ?? {}
    expect(failedStep.message).toBe('container exited with code 17')
  })

  it('classifies workflow job pod usage-limit logs as provider capacity exhaustion', async () => {
    const jobStatuses = new Map<string, Record<string, unknown>>()
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          jobStatuses.set(name, applied)
        }
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return jobStatuses.get(name) ?? null
        }
        return null
      }),
      list: vi.fn(async (resource: string, _namespace: string, labelSelector?: string) => {
        if (resource === 'pods' && labelSelector?.startsWith('job-name=')) {
          return {
            items: [
              {
                metadata: { name: 'run-1-step-1-attempt-1-pod' },
                spec: { containers: [{ name: 'main' }] },
              },
            ],
          }
        }
        return { items: [] }
      }),
      logs: vi.fn(async () =>
        [
          'Turn started',
          "Stream error -> You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 11:15 PM.",
        ].join('\n'),
      ),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'deploy-step', retries: 0 }],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const firstStatus = getLastStatus(kube)
    const firstWorkflow = firstStatus.workflow as Record<string, unknown>
    const firstStep = ((firstWorkflow.steps as Record<string, unknown>[]) ?? [])[0] ?? {}
    const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    jobStatuses.set(firstJobName ?? '', {
      ...jobStatuses.get(firstJobName ?? ''),
      status: {
        failed: 1,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'Job has reached the specified backoff limit',
          },
        ],
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      { ...agentRun, status: firstStatus },
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const failedStatus = getLastStatus(kube)
    expect(failedStatus.phase).toBe('Failed')
    expect(failedStatus.reason).toBe('ProviderCapacityExhausted')
    expect(failedStatus.message).toContain('workflow step deploy-step: provider capacity exhausted')
    const failedWorkflow = failedStatus.workflow as Record<string, unknown>
    const failedStep = ((failedWorkflow.steps as Record<string, unknown>[]) ?? [])[0] ?? {}
    expect(failedStep.phase).toBe('Failed')
    expect(failedStep.message).toContain('provider capacity exhausted')
  })

  it('classifies workflow job pod auth logs as non-retryable provider auth failure', async () => {
    const jobStatuses = new Map<string, Record<string, unknown>>()
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      const applied = { ...resource, metadata: { ...metadata, uid } }
      if (resource.kind === 'Job') {
        const name = (resource.metadata as Record<string, unknown> | undefined)?.name as string | undefined
        if (name) {
          jobStatuses.set(name, applied)
        }
      }
      return applied
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return jobStatuses.get(name) ?? null
        }
        return null
      }),
      list: vi.fn(async (resource: string, _namespace: string, labelSelector?: string) => {
        if (resource === 'pods' && labelSelector?.startsWith('job-name=')) {
          return {
            items: [
              {
                metadata: { name: 'run-1-step-1-attempt-1-pod' },
                spec: { containers: [{ name: 'main' }] },
              },
            ],
          }
        }
        return { items: [] }
      }),
      logs: vi.fn(async () =>
        [
          'Turn started',
          'Stream error -> Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
        ].join('\n'),
      ),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'deploy-step', retries: 2 }],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const firstStatus = getLastStatus(kube)
    const firstWorkflow = firstStatus.workflow as Record<string, unknown>
    const firstStep = ((firstWorkflow.steps as Record<string, unknown>[]) ?? [])[0] ?? {}
    const firstJobName = (firstStep.jobRef as Record<string, unknown> | undefined)?.name as string | undefined
    jobStatuses.set(firstJobName ?? '', {
      ...jobStatuses.get(firstJobName ?? ''),
      status: {
        failed: 1,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'Job has reached the specified backoff limit',
          },
        ],
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      { ...agentRun, status: firstStatus },
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    const failedStatus = getLastStatus(kube)
    expect(failedStatus.phase).toBe('Failed')
    expect(failedStatus.reason).toBe('ProviderAuthUnavailable')
    expect(failedStatus.message).toContain('workflow step deploy-step: provider auth unavailable')
    const failedWorkflow = failedStatus.workflow as Record<string, unknown>
    const failedStep = ((failedWorkflow.steps as Record<string, unknown>[]) ?? [])[0] ?? {}
    expect(failedStep.phase).toBe('Failed')
    expect(failedStep.message).toContain('provider auth unavailable')
    expect(failedStep.nextRetryAt).toBeUndefined()
  })

  it('propagates failed job reason and message onto AgentRun status', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === 'job' && name === 'job-1') {
          return {
            metadata: { name: 'job-1', namespace: 'agents' },
            status: {
              failed: 1,
              conditions: [
                {
                  type: 'Failed',
                  status: 'True',
                  reason: 'DeadlineExceeded',
                  message: 'job exceeded active deadline',
                },
              ],
            },
          }
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      status: {
        phase: 'Running',
        runtimeRef: { type: 'job', name: 'job-1', namespace: 'agents' },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    expect(status.reason).toBe('DeadlineExceeded')
    expect(status.message).toBe('job exceeded active deadline')
  })

  it('warns when a direct job runtime loses mounted ConfigMaps', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === 'job' && name === 'job-1') {
          return {
            metadata: { name: 'job-1', namespace: 'agents' },
            spec: {
              template: {
                spec: {
                  volumes: [
                    { name: 'run-spec', configMap: { name: 'run-1-spec' } },
                    { name: 'workspace', emptyDir: {} },
                  ],
                },
              },
            },
            status: {},
          }
        }
        if (resource === 'configmap' && name === 'run-1-spec') {
          return null
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      status: {
        phase: 'Running',
        runtimeRef: {
          type: 'job',
          name: 'job-1',
          namespace: 'agents',
          jobObservedAt: '2026-05-19T12:00:00Z',
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const warning = findCondition(status, 'Warning')
    expect(status.phase).toBe('Running')
    expect(warning?.reason).toBe('RuntimeConfigMapMissing')
    expect(warning?.message).toContain('run-1-spec')
  })

  it('propagates runner terminal status and output artifacts from direct job pods', async () => {
    const runnerMessage = JSON.stringify({
      status: 'succeeded',
      adapter: 'codex-app-server',
      provider: 'codex',
      exitCode: 0,
      threadId: 'thread-1',
      turnId: 'turn-1',
      artifacts: {
        outputArtifacts: [{ name: 'summary', key: 'runs/run-1/summary.json' }],
      },
    })
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === 'job' && name === 'job-1') {
          return {
            metadata: { name: 'job-1', namespace: 'agents' },
            status: { succeeded: 1, startTime: '2026-05-19T12:00:00Z', completionTime: '2026-05-19T12:01:00Z' },
          }
        }
        return null
      }),
      list: vi.fn(async (resource: string, _namespace: string, labelSelector?: string) => {
        if (resource === 'pods' && labelSelector?.startsWith('job-name=')) {
          return {
            items: [
              {
                metadata: { name: 'job-1-pod' },
                status: {
                  startTime: '2026-05-19T12:00:00Z',
                  containerStatuses: [{ name: 'agent-runner', state: { terminated: { message: runnerMessage } } }],
                },
              },
            ],
          }
        }
        return { items: [] }
      }),
    })

    const agentRun = buildAgentRun({
      status: {
        phase: 'Running',
        runtimeRef: { type: 'job', name: 'job-1', namespace: 'agents' },
        artifacts: [{ name: 'existing', path: '/workspace/existing.json' }],
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Succeeded')
    expect(status.runner).toMatchObject({
      status: 'succeeded',
      adapter: 'codex-app-server',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    expect(status.artifacts).toEqual([
      { name: 'existing', path: '/workspace/existing.json' },
      { name: 'summary', key: 'runs/run-1/summary.json' },
    ])
  })

  it('marks direct jobs cancelled when the runner terminal status is cancelled', async () => {
    const runnerMessage = JSON.stringify({
      status: 'cancelled',
      adapter: 'codex-app-server',
      exitCode: 130,
      error: 'received SIGTERM',
    })
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === 'job' && name === 'job-1') {
          return {
            metadata: { name: 'job-1', namespace: 'agents' },
            status: {
              failed: 1,
              conditions: [
                {
                  type: 'Failed',
                  status: 'True',
                  reason: 'BackoffLimitExceeded',
                  message: 'Job has reached the specified backoff limit',
                },
              ],
            },
          }
        }
        return null
      }),
      list: vi.fn(async (resource: string, _namespace: string, labelSelector?: string) => {
        if (resource === 'pods' && labelSelector?.startsWith('job-name=')) {
          return {
            items: [
              {
                metadata: { name: 'job-1-pod' },
                status: {
                  containerStatuses: [{ name: 'agent-runner', state: { terminated: { message: runnerMessage } } }],
                },
              },
            ],
          }
        }
        return { items: [] }
      }),
    })

    const agentRun = buildAgentRun({
      status: {
        phase: 'Running',
        runtimeRef: { type: 'job', name: 'job-1', namespace: 'agents' },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Cancelled')
    expect(status.reason).toBe('RunnerCancelled')
    expect(status.message).toBe('received SIGTERM')
    expect(findCondition(status, 'Cancelled')?.reason).toBe('RunnerCancelled')
    expect(status.runner).toMatchObject({ status: 'cancelled', adapter: 'codex-app-server', exitCode: 130 })
  })

  it('classifies direct job pod usage-limit logs as provider capacity exhaustion', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === 'job' && name === 'job-1') {
          return {
            metadata: { name: 'job-1', namespace: 'agents' },
            status: {
              failed: 1,
              conditions: [
                {
                  type: 'Failed',
                  status: 'True',
                  reason: 'BackoffLimitExceeded',
                  message: 'Job has reached the specified backoff limit',
                },
              ],
            },
          }
        }
        return null
      }),
      list: vi.fn(async (resource: string, _namespace: string, labelSelector?: string) => {
        if (resource === 'pods' && labelSelector?.startsWith('job-name=')) {
          return {
            items: [
              {
                metadata: { name: 'job-1-pod' },
                spec: { containers: [{ name: 'main' }] },
              },
            ],
          }
        }
        return { items: [] }
      }),
      logs: vi.fn(async () =>
        [
          'Turn started',
          "Turn failed -> You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 11:15 PM.",
        ].join('\n'),
      ),
    })

    const agentRun = buildAgentRun({
      status: {
        phase: 'Running',
        runtimeRef: { type: 'job', name: 'job-1', namespace: 'agents' },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    expect(status.phase).toBe('Failed')
    expect(status.reason).toBe('ProviderCapacityExhausted')
    expect(status.message).toContain('provider capacity exhausted')
    const failedCondition = findCondition(status, 'Failed')
    expect(failedCondition?.reason).toBe('ProviderCapacityExhausted')
  })

  it('fails workflow steps when timeout is exceeded', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return { metadata: { name }, status: { active: 1 } }
        }
        return null
      }),
    })

    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'timeout-step', timeoutSeconds: 60 }],
        },
      },
      status: {
        phase: 'Running',
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'timeout-step',
              phase: 'Running',
              attempt: 1,
              startedAt,
              jobRef: { name: 'timeout-job', namespace: 'agents' },
            },
          ],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const workflow = (status.workflow as Record<string, unknown> | undefined) ?? {}
    const steps = Array.isArray(workflow.steps) ? (workflow.steps as Record<string, unknown>[]) : []
    expect(status.phase).toBe('Failed')
    expect(workflow.phase).toBe('Failed')
    expect(steps[0]?.phase).toBe('Failed')
    expect(steps[0]?.message).toBe('Step timed out')
  })

  it('does not fail timed out workflow step when runtime job already completed', async () => {
    const apply = vi.fn(async (resource: Record<string, unknown>) => {
      const metadata = (resource.metadata ?? {}) as Record<string, unknown>
      const uid = metadata.uid ?? `uid-${String(resource.kind ?? 'resource').toLowerCase()}`
      return { ...resource, metadata: { ...metadata, uid } }
    })
    const kube = buildKube({
      apply,
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return {
            metadata: { name: 'agent-1' },
            spec: { providerRef: { name: 'provider-1' }, defaults: { systemPrompt: 'default-agent-prompt' } },
          }
        }
        if (resource === RESOURCE_MAP.AgentProvider) {
          return { metadata: { name: 'provider-1' }, spec: { binary: '/usr/local/bin/agent-runner' } }
        }
        if (resource === RESOURCE_MAP.ImplementationSpec) {
          return { metadata: { name: 'impl-1' }, spec: { text: 'demo' } }
        }
        if (resource === 'job') {
          return {
            metadata: { name },
            status: {
              succeeded: 1,
              startTime: '2026-03-02T20:01:25Z',
              completionTime: '2026-03-02T20:20:00Z',
            },
          }
        }
        return null
      }),
    })

    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'workflow', config: {} },
        workload: { image: defaultRunnerImage },
        workflow: {
          steps: [{ name: 'timeout-step', timeoutSeconds: 60 }],
        },
      },
      status: {
        phase: 'Running',
        workflow: {
          phase: 'Running',
          steps: [
            {
              name: 'timeout-step',
              phase: 'Running',
              attempt: 1,
              startedAt,
              jobRef: { name: 'timeout-job', namespace: 'agents' },
            },
          ],
        },
      },
    })

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    const status = getLastStatus(kube)
    const workflow = (status.workflow as Record<string, unknown> | undefined) ?? {}
    const steps = Array.isArray(workflow.steps) ? (workflow.steps as Record<string, unknown>[]) : []
    expect(['Failed', 'Succeeded']).toContain(status.phase)
    const workflowPhase = typeof workflow.phase === 'string' ? workflow.phase : (status.phase as string | undefined)
    const stepPhase = steps[0]?.phase
    expect(['Failed', 'Succeeded']).toContain(workflowPhase)
    expect(['Failed', 'Succeeded']).toContain(
      typeof stepPhase === 'string' ? stepPhase : (status.phase as string | undefined),
    )
    if (typeof stepPhase === 'string') {
      expect(steps[0]?.message).not.toBe('Step timed out')
    }
  })

  it('deletes completed AgentRun after retention window', async () => {
    const deleteMock = vi.fn(async () => ({}))
    const kube = buildKube({ delete: deleteMock })
    const finishedAt = new Date(Date.now() - 120_000).toISOString()
    const agentRun = buildAgentRun()
    agentRun.spec = { ...(agentRun.spec as Record<string, unknown>), ttlSecondsAfterFinished: 30 }
    agentRun.status = { phase: 'Succeeded', finishedAt }

    await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

    expect(deleteMock).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', { wait: false })
  })

  it('uses controller retention default when spec override is missing', async () => {
    const previousRetention = process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '60'

    try {
      const deleteMock = vi.fn(async () => ({}))
      const kube = buildKube({ delete: deleteMock })
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        status: { phase: 'Failed', finishedAt },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      expect(deleteMock).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents', { wait: false })
    } finally {
      if (previousRetention === undefined) {
        delete process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('records reconcile duration metrics', async () => {
    const kube = buildKube()
    recordReconcileDurationMs.mockClear()

    await __test.reconcileAgentRun(
      kube as never,
      buildAgentRun(),
      'agents',
      [],
      [],
      defaultConcurrency,
      buildInFlight(),
      0,
    )

    expect(recordReconcileDurationMs).toHaveBeenCalled()
  })
})

describe('agents controller queue and rate limits', () => {
  it('blocks AgentRun when queue limit is exceeded', async () => {
    const previousQueue = process.env.AGENTS_CONTROLLER_QUEUE_NAMESPACE
    process.env.AGENTS_CONTROLLER_QUEUE_NAMESPACE = '1'

    try {
      const kube = buildKube()
      const agentRun = buildAgentRun()
      const existingRuns = [
        buildAgentRun({
          metadata: {
            name: 'run-queued',
            namespace: 'agents',
            generation: 1,
            finalizers: [finalizer],
          },
          status: { phase: 'Pending' },
        }),
      ]

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        existingRuns,
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const status = getLastStatus(kube)
      const condition = findCondition(status, 'Blocked')
      expect(condition?.reason).toBe('QueueLimit')
      expect(condition?.message).toContain('queue limit')
    } finally {
      if (previousQueue === undefined) {
        delete process.env.AGENTS_CONTROLLER_QUEUE_NAMESPACE
      } else {
        process.env.AGENTS_CONTROLLER_QUEUE_NAMESPACE = previousQueue
      }
    }
  })

  it('clears Blocked condition when a run is admitted', async () => {
    const kube = buildKube()
    const blockedAt = new Date(Date.now() - 60_000).toISOString()
    const agentRun = buildAgentRun({
      status: {
        phase: 'Pending',
        conditions: [
          {
            type: 'Blocked',
            status: 'True',
            reason: 'QueueLimit',
            message: 'Repository proompteng/lab reached queue limit',
            lastTransitionTime: blockedAt,
          },
        ],
      },
    })

    await __test.setStatus(kube as never, agentRun, {
      phase: 'Running',
      conditions: [
        {
          type: 'Blocked',
          status: 'True',
          reason: 'QueueLimit',
          message: 'Repository proompteng/lab reached queue limit',
          lastTransitionTime: blockedAt,
        },
      ],
    })

    const status = getLastStatus(kube)
    const blocked = findCondition(status, 'Blocked')
    expect(blocked?.status).toBe('False')
    expect(blocked?.reason).toBe('NotBlocked')
  })

  it('blocks AgentRun when rate limit is exceeded', async () => {
    const previousWindow = process.env.AGENTS_CONTROLLER_RATE_WINDOW_SECONDS
    const previousNamespace = process.env.AGENTS_CONTROLLER_RATE_NAMESPACE
    const previousCluster = process.env.AGENTS_CONTROLLER_RATE_CLUSTER

    process.env.AGENTS_CONTROLLER_RATE_WINDOW_SECONDS = '60'
    process.env.AGENTS_CONTROLLER_RATE_NAMESPACE = '1'
    process.env.AGENTS_CONTROLLER_RATE_CLUSTER = '1'
    __test.resetControllerRateState()

    try {
      const kube = buildKube()
      const agentRun = buildAgentRun({
        metadata: {
          name: 'run-rate-1',
          namespace: 'agents',
          generation: 1,
          finalizers: [finalizer],
        },
      })
      const agentRunTwo = buildAgentRun({
        metadata: {
          name: 'run-rate-2',
          namespace: 'agents',
          generation: 1,
          finalizers: [finalizer],
        },
      })

      await __test.reconcileAgentRun(kube as never, agentRun, 'agents', [], [], defaultConcurrency, buildInFlight(), 0)

      await __test.reconcileAgentRun(
        kube as never,
        agentRunTwo,
        'agents',
        [],
        [],
        defaultConcurrency,
        buildInFlight(),
        0,
      )

      const status = getLastStatus(kube)
      const condition = findCondition(status, 'Blocked')
      expect(condition?.reason).toBe('RateLimit')
      expect(condition?.message).toContain('rate limit')
    } finally {
      __test.resetControllerRateState()

      if (previousWindow === undefined) {
        delete process.env.AGENTS_CONTROLLER_RATE_WINDOW_SECONDS
      } else {
        process.env.AGENTS_CONTROLLER_RATE_WINDOW_SECONDS = previousWindow
      }
      if (previousNamespace === undefined) {
        delete process.env.AGENTS_CONTROLLER_RATE_NAMESPACE
      } else {
        process.env.AGENTS_CONTROLLER_RATE_NAMESPACE = previousNamespace
      }
      if (previousCluster === undefined) {
        delete process.env.AGENTS_CONTROLLER_RATE_CLUSTER
      } else {
        process.env.AGENTS_CONTROLLER_RATE_CLUSTER = previousCluster
      }
    }
  })
})

describe('agents controller resolveVcsContext', () => {
  it('suffixes the head branch when a conflict exists', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.VersionControlProvider) {
          return buildVcsProvider({
            spec: {
              provider: 'github',
              auth: { method: 'none' },
              defaults: {
                branchTemplate: 'codex/{{issueNumber}}',
                branchConflictSuffixTemplate: '{{agentRun.name}}',
              },
            },
          })
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        vcsRef: { name: 'vcs-1' },
        parameters: {
          repository: 'proompteng/lab',
          issueNumber: '123',
        },
      },
    })

    const result = await __test.resolveVcsContext({
      kube: kube as never,
      namespace: 'agents',
      agentRun,
      agent: { metadata: { name: 'agent-1' }, spec: {} },
      implementation: {},
      parameters: {
        repository: 'proompteng/lab',
        issueNumber: '123',
      },
      allowedSecrets: [],
      existingRuns: [
        {
          metadata: { name: 'run-2' },
          status: {
            phase: 'Running',
            vcs: { repository: 'proompteng/lab', headBranch: 'codex/123' },
          },
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.context?.headBranch).toBe('codex/123-run-1')
  })

  it('falls back to the AgentRun name when an issue branch template has no issue number', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.VersionControlProvider) {
          return buildVcsProvider({
            spec: {
              provider: 'github',
              auth: { method: 'none' },
              defaults: {
                branchTemplate: 'codex/{{issueNumber}}',
                branchConflictSuffixTemplate: '{{agentRun.name}}',
              },
            },
          })
        }
        return null
      }),
    })

    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: { image: defaultRunnerImage },
        vcsRef: { name: 'vcs-1' },
        parameters: {
          repository: 'proompteng/lab',
        },
      },
    })

    const result = await __test.resolveVcsContext({
      kube: kube as never,
      namespace: 'agents',
      agentRun,
      agent: { metadata: { name: 'agent-1' }, spec: {} },
      implementation: {},
      parameters: {
        repository: 'proompteng/lab',
      },
      allowedSecrets: [],
      existingRuns: [],
    })

    expect(result.ok).toBe(true)
    expect(result.context?.headBranch).toBe('codex/run-1')
  })
})
describe('agents controller reconcileVersionControlProvider', () => {
  it('surfaces deprecation warnings for github token types', async () => {
    const kube = buildKube({
      get: vi.fn(async () => ({
        stringData: { token: 'value' },
      })),
    })
    const provider = buildVcsProvider()

    await __test.reconcileVersionControlProvider(kube as never, provider, 'agents')

    const status = getLastStatus(kube)
    const warning = findCondition(status, 'Warning')
    expect(warning?.status).toBe('True')
    expect(warning?.reason).toBe('DeprecatedAuth')
  })

  it('rejects unsupported auth methods for non-github providers', async () => {
    const kube = buildKube()
    const provider = buildVcsProvider({
      spec: {
        provider: 'gitlab',
        auth: {
          method: 'app',
          app: {
            appId: '1',
            installationId: '2',
            privateKeySecretRef: { name: 'app-secret' },
          },
        },
      },
    })

    await __test.reconcileVersionControlProvider(kube as never, provider, 'agents')

    const status = getLastStatus(kube)
    const invalid = findCondition(status, 'InvalidSpec')
    expect(invalid?.reason).toBe('UnsupportedAuth')
  })

  it('rejects token types that are not supported by the provider', async () => {
    const kube = buildKube()
    const provider = buildVcsProvider({
      spec: {
        provider: 'bitbucket',
        auth: {
          method: 'token',
          token: {
            secretRef: { name: 'bitbucket-token', key: 'token' },
            type: 'pat',
          },
        },
      },
    })

    await __test.reconcileVersionControlProvider(kube as never, provider, 'agents')

    const status = getLastStatus(kube)
    const invalid = findCondition(status, 'InvalidSpec')
    expect(invalid?.reason).toBe('UnsupportedAuth')
  })
})

describe('agents controller reconcileMemory', () => {
  it('marks Memory invalid when secret ref is missing', async () => {
    const kube = buildKube()
    const memory = buildMemory({
      spec: {
        type: 'postgres',
        connection: { secretRef: {} },
      },
    })

    await __test.reconcileMemory(kube as never, memory, 'agents')

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingSecretRef')
  })

  it('marks Memory unreachable when secret is missing', async () => {
    const kube = buildKube({
      get: vi.fn(async () => null),
    })
    const memory = buildMemory()

    await __test.reconcileMemory(kube as never, memory, 'agents')

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'Unreachable')
    expect(condition?.reason).toBe('SecretNotFound')
  })

  it('marks Memory invalid when secret key is missing', async () => {
    const kube = buildKube({
      get: vi.fn(async () => ({ data: { url: 'cG9zdGdyZXM6Ly8=' } })),
    })
    const memory = buildMemory({
      spec: {
        type: 'postgres',
        connection: {
          secretRef: {
            name: 'memory-secret',
            key: 'missing',
          },
        },
      },
    })

    await __test.reconcileMemory(kube as never, memory, 'agents')

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('SecretKeyMissing')
  })
})

// Regression: validate defensive workflow step status handling.
