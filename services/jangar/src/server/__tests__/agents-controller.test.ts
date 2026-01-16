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
  apply: vi.fn(async (resource: Record<string, unknown>) => resource),
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
})
