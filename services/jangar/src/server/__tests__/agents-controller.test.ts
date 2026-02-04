import { describe, expect, it, vi } from 'vitest'

import { __test } from '~/server/agents-controller'
import { RESOURCE_MAP } from '~/server/primitives-kube'

const finalizer = 'agents.proompteng.ai/runtime-cleanup'

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
    workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
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

describe('agents controller reconcileAgentRun', () => {
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

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

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
            spec: { providerRef: { name: 'provider-1' }, memoryRef: { name: 'default-memory' } },
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
        workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
        memoryRef: { name: 'default-memory' },
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

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
            spec: { providerRef: { name: 'provider-1' } },
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

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingRequiredMetadata')
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
            spec: { providerRef: { name: 'provider-1' } },
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
        workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
        parameters: {
          linearRepo: 'proompteng/lab',
          linearIssue: '1234',
        },
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition).toBeUndefined()
    expect(apply).toHaveBeenCalled()
    const appliedKinds = apply.mock.calls.map((call) => (call[0] as Record<string, unknown>).kind)
    expect(appliedKinds).toContain('Job')
  })

  it('marks AgentRun failed when job runtime lacks an image', async () => {
    const previousImage = process.env.JANGAR_AGENT_RUNNER_IMAGE
    const previousAgentImage = process.env.JANGAR_AGENT_IMAGE
    delete process.env.JANGAR_AGENT_RUNNER_IMAGE
    delete process.env.JANGAR_AGENT_IMAGE
    const kube = buildKube()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'job', config: {} },
        workload: {},
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingWorkloadImage')

    if (previousImage) process.env.JANGAR_AGENT_RUNNER_IMAGE = previousImage
    if (previousAgentImage) process.env.JANGAR_AGENT_IMAGE = previousAgentImage
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

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

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

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('MissingEndpoint')
  })

  it('deletes completed AgentRun after retention window', async () => {
    const previousRetention = process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '60'

    try {
      const kube = buildKube()
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        status: { phase: 'Succeeded', finishedAt },
      })

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      expect(kube.delete).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents')
    } finally {
      if (previousRetention === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('respects per-run ttlSecondsAfterFinished override', async () => {
    const previousRetention = process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '3600'

    try {
      const kube = buildKube()
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
          workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
          ttlSecondsAfterFinished: 60,
        },
        status: { phase: 'Failed', finishedAt },
      })

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      expect(kube.delete).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents')
    } finally {
      if (previousRetention === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('disables retention when per-run ttlSecondsAfterFinished is zero', async () => {
    const previousRetention = process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '60'

    try {
      const kube = buildKube()
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        spec: {
          agentRef: { name: 'agent-1' },
          implementationSpecRef: { name: 'impl-1' },
          runtime: { type: 'job', config: {} },
          workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
          ttlSecondsAfterFinished: 0,
        },
        status: { phase: 'Succeeded', finishedAt },
      })

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      expect(kube.delete).not.toHaveBeenCalled()
    } finally {
      if (previousRetention === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })

  it('keeps completed AgentRun before retention window', async () => {
    const previousRetention = process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '3600'

    try {
      const kube = buildKube()
      const agentRun = buildAgentRun({
        status: { phase: 'Succeeded', finishedAt: new Date().toISOString() },
      })

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      expect(kube.delete).not.toHaveBeenCalled()
    } finally {
      if (previousRetention === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
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
          return { metadata: { name: 'agent-1' }, spec: { providerRef: { name: 'provider-1' } } }
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

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const appliedResources = apply.mock.calls.map((call) => call[0]) as Record<string, unknown>[]
    const job = appliedResources.find((resource) => resource.kind === 'Job')
    const configMaps = appliedResources.filter((resource) => resource.kind === 'ConfigMap')

    expect(job).toBeTruthy()
    expect(configMaps).toHaveLength(2)

    const jobLabels = (job?.metadata as Record<string, unknown> | undefined)?.labels as
      | Record<string, string>
      | undefined
    expect(jobLabels?.['agents.proompteng.ai/agent-run']).toBe('run-1')
    expect(jobLabels?.['agents.proompteng.ai/agent']).toBe('agent-1')
    expect(jobLabels?.['agents.proompteng.ai/provider']).toBe('provider-1')
  })

  it('injects auth secret volume and CODEX_AUTH env var', async () => {
    const previousName = process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME
    const previousKey = process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY
    const previousMountPath = process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
    process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME = 'codex-auth'
    process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY = 'auth.json'
    process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH = '/root/.codex'

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
            return { metadata: { name: 'agent-1' }, spec: { providerRef: { name: 'provider-1' } } }
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

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

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
        delete process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME = previousName
      }
      if (previousKey === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_KEY = previousKey
      }
      if (previousMountPath === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH = previousMountPath
      }
    }
  })

  it('marks AgentRun failed when controller blocks secrets', async () => {
    const previousBlocked = process.env.JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS
    process.env.JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS = 'blocked-secret'

    try {
      const kube = buildKube({
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return { metadata: { name: 'agent-1' }, spec: { providerRef: { name: 'provider-1' } } }
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
          workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
          secrets: ['blocked-secret'],
        },
      })

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      const status = getLastStatus(kube)
      const condition = findCondition(status, 'InvalidSpec')
      expect(condition?.reason).toBe('SecretBlocked')
    } finally {
      if (previousBlocked === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_BLOCKED_SECRETS = previousBlocked
      }
    }
  })

  it('marks AgentRun failed when auth secret is not allowlisted', async () => {
    const previousName = process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME
    process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME = 'codex-auth'

    try {
      const kube = buildKube({
        get: vi.fn(async (resource: string) => {
          if (resource === RESOURCE_MAP.Agent) {
            return {
              metadata: { name: 'agent-1' },
              spec: {
                providerRef: { name: 'provider-1' },
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

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      const status = getLastStatus(kube)
      const condition = findCondition(status, 'InvalidSpec')
      expect(condition?.reason).toBe('SecretNotAllowed')
    } finally {
      if (previousName === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_NAME = previousName
      }
    }
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
          return { metadata: { name: 'agent-1' }, spec: { providerRef: { name: 'provider-1' } } }
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
        workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
        workflow: {
          steps: [{ name: 'step-one' }, { name: 'step-two' }],
        },
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const firstStatus = getLastStatus(kube)
    expect(firstStatus.phase).toBe('Running')
    const workflow = firstStatus.workflow as Record<string, unknown>
    const steps = (workflow.steps as Record<string, unknown>[]) ?? []
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
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const secondStatus = getLastStatus(kube)
    const secondWorkflow = secondStatus.workflow as Record<string, unknown>
    const secondSteps = (secondWorkflow.steps as Record<string, unknown>[]) ?? []
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
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
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
          return { metadata: { name: 'agent-1' }, spec: { providerRef: { name: 'provider-1' } } }
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
        workload: { image: 'registry.ide-newton.ts.net/lab/codex-universal:latest' },
        workflow: {
          steps: [{ name: 'retry-step', retries: 1, retryBackoffSeconds: 60 }],
        },
      },
    })

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

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
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
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
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    const thirdStatus = getLastStatus(kube)
    const thirdWorkflow = thirdStatus.workflow as Record<string, unknown>
    const thirdSteps = (thirdWorkflow.steps as Record<string, unknown>[]) ?? []
    expect(thirdSteps[0]?.attempt).toBe(2)
    expect(thirdSteps[0]?.phase).toBe('Running')
  })

  it('deletes completed AgentRun after retention window', async () => {
    const deleteMock = vi.fn(async () => ({}))
    const kube = buildKube({ delete: deleteMock })
    const finishedAt = new Date(Date.now() - 120_000).toISOString()
    const agentRun = buildAgentRun()
    agentRun.spec = { ...(agentRun.spec as Record<string, unknown>), ttlSecondsAfterFinished: 30 }
    agentRun.status = { phase: 'Succeeded', finishedAt }

    await __test.reconcileAgentRun(
      kube as never,
      agentRun,
      'agents',
      [],
      { perNamespace: 10, perAgent: 5, cluster: 100 },
      { total: 0, perAgent: new Map() },
      0,
    )

    expect(deleteMock).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents')
  })

  it('uses controller retention default when spec override is missing', async () => {
    const previousRetention = process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
    process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = '60'

    try {
      const deleteMock = vi.fn(async () => ({}))
      const kube = buildKube({ delete: deleteMock })
      const finishedAt = new Date(Date.now() - 120_000).toISOString()
      const agentRun = buildAgentRun({
        status: { phase: 'Failed', finishedAt },
      })

      await __test.reconcileAgentRun(
        kube as never,
        agentRun,
        'agents',
        [],
        { perNamespace: 10, perAgent: 5, cluster: 100 },
        { total: 0, perAgent: new Map() },
        0,
      )

      expect(deleteMock).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'run-1', 'agents')
    } finally {
      if (previousRetention === undefined) {
        delete process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS
      } else {
        process.env.JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS = previousRetention
      }
    }
  })
})

describe('agents controller reconcileVersionControlProvider', () => {
  const buildProvider = (overrides: Record<string, unknown> = {}) => ({
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'VersionControlProvider',
    metadata: {
      name: 'github',
      namespace: 'agents',
      generation: 1,
    },
    spec: {
      provider: 'github',
      auth: {
        method: 'token',
        token: {
          secretRef: { name: 'github-token', key: 'token' },
          type: 'pat',
        },
      },
    },
    status: {},
    ...overrides,
  })

  it('warns when a deprecated token type is used', async () => {
    const kube = buildKube({
      get: vi.fn(async (resource: string, name: string) => {
        if (resource === 'secret' && name === 'github-token') {
          return { data: { token: Buffer.from('token').toString('base64') } }
        }
        return null
      }),
    })

    await __test.reconcileVersionControlProvider(kube as never, buildProvider(), 'agents')

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'AuthDeprecated')
    expect(condition?.status).toBe('True')
    expect(condition?.reason).toBe('DeprecatedTokenType')
  })

  it('rejects unsupported auth methods per provider', async () => {
    const kube = buildKube()
    const provider = buildProvider({
      metadata: { name: 'gitlab', namespace: 'agents', generation: 1 },
      spec: {
        provider: 'gitlab',
        auth: {
          method: 'app',
          app: {
            appId: '1',
            installationId: '2',
            privateKeySecretRef: { name: 'gitlab-app', key: 'key' },
          },
        },
      },
    })

    await __test.reconcileVersionControlProvider(kube as never, provider, 'agents')

    const status = getLastStatus(kube)
    const condition = findCondition(status, 'InvalidSpec')
    expect(condition?.reason).toBe('UnsupportedAuth')
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
