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
    workload: { image: 'ghcr.io/proompteng/codex-agent:latest' },
  },
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
        workload: { image: 'ghcr.io/proompteng/codex-agent:latest' },
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

  it('marks AgentRun failed when argo runtime lacks workflowTemplate', async () => {
    const kube = buildKube()
    const agentRun = buildAgentRun({
      spec: {
        agentRef: { name: 'agent-1' },
        implementationSpecRef: { name: 'impl-1' },
        runtime: { type: 'argo', config: {} },
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
    expect(condition?.reason).toBe('MissingWorkflowTemplate')
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
