import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/feature-flags', () => ({
  resolveBooleanFeatureToggle: vi.fn(async () => true),
}))

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { asString } from '~/server/primitives-http'
import type { KubernetesClient } from '~/server/primitives-kube'
import { RESOURCE_MAP } from '~/server/primitives-kube'
import { __test__ } from '~/server/supporting-primitives-controller'

describe('supporting primitives controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets standard conditions and updatedAt for invalid tools', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { applyStatus } as unknown as KubernetesClient

    const tool = {
      apiVersion: 'tools.proompteng.ai/v1alpha1',
      kind: 'Tool',
      metadata: { name: 'bad-tool', namespace: 'agents', generation: 1 },
      spec: {},
    }

    await __test__.reconcileTool(kube, tool)

    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    const status = payload.status ?? {}

    expect(status.updatedAt).toBe('2026-01-20T00:00:00.000Z')

    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    const progressing = conditions.find((condition) => condition.type === 'Progressing')
    const degraded = conditions.find((condition) => condition.type === 'Degraded')

    expect(ready?.status).toBe('False')
    expect(progressing?.status).toBe('False')
    expect(degraded?.status).toBe('True')
  })

  it('resolves startup gate from feature flags with env fallback default', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED = 'false'
      const resolveBooleanFeatureToggleMock = vi.mocked(resolveBooleanFeatureToggle)
      resolveBooleanFeatureToggleMock.mockResolvedValueOnce(true)

      const enabled = await __test__.shouldStartWithFeatureFlag()

      expect(enabled).toBe(true)
      expect(resolveBooleanFeatureToggleMock).toHaveBeenCalledWith({
        key: 'jangar.supporting_controller.enabled',
        keyEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY',
        fallbackEnvVar: 'JANGAR_SUPPORTING_CONTROLLER_ENABLED',
        defaultValue: false,
      })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('reconciles a valid swarm by creating stage schedules and active status', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    for (const call of apply.mock.calls) {
      const payload = call[0] as Record<string, unknown>
      expect(payload.kind).toBe('Schedule')
      expect(payload.apiVersion).toBe('schedules.schedules.proompteng.ai/v1alpha1')
      const labels =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).labels
          : undefined
      expect(labels).toBeTruthy()
      expect(labels).toMatchObject({
        'swarm.proompteng.ai/uid': 'swarm-uid',
      })
    }
    expect(deleteFn).not.toHaveBeenCalled()
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Active')
    expect(status.activeMissions).toBe(0)
    expect(status.stageStates).toBeTruthy()
  })

  it('normalizes long swarm names into valid label values for schedules', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const longName = `${'a'.repeat(62)}-b`
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: longName, namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    for (const call of apply.mock.calls) {
      const payload = call[0] as Record<string, unknown>
      const labels =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).labels
          : undefined
      expect(labels).toBeTruthy()
      expect(labels).toMatchObject({
        'swarm.proompteng.ai/uid': 'swarm-uid',
      })
      const labelsRecord = (labels ?? {}) as Record<string, unknown>
      const swarmLabel = labelsRecord['swarm.proompteng.ai/name']
      expect(typeof swarmLabel).toBe('string')
      const normalizedLabel = String(swarmLabel)
      expect(normalizedLabel.length).toBeLessThanOrEqual(63)
      expect(normalizedLabel).toBe('a'.repeat(62))
      expect(normalizedLabel).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    }
  })

  it('creates unique schedules for each stage even when swarm name is long', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const longName = `${'a'.repeat(90)}`
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: longName, namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    const scheduleNames = apply.mock.calls.map((call) => {
      const payload = call[0] as Record<string, unknown>
      return asString(payload?.metadata ? (payload.metadata as Record<string, unknown>).name : undefined)
    })
    const uniqueNames = new Set(scheduleNames)
    expect(scheduleNames.filter((name): name is string => typeof name === 'string')).toHaveLength(4)
    expect(uniqueNames.size).toBe(4)
  })

  it('freezes swarm when implement stage has consecutive failures over threshold', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              metadata: {
                name: 'run-2',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
            {
              metadata: {
                name: 'run-1',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(4)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toBeTruthy()
  })

  it('counts implement failures from configured target namespaces when deciding freeze', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (_resource: string, namespace: string) => {
      if (namespace === 'agents-implement') {
        return {
          items: [
            {
              metadata: {
                name: 'run-2',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
            {
              metadata: {
                name: 'run-1',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample', namespace: 'agents-implement' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample', namespace: 'agents-implement' } },
          implement: {
            targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample', namespace: 'agents-implement' },
          },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample', namespace: 'agents-implement' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(list).toHaveBeenCalledWith(
      RESOURCE_MAP.AgentRun,
      'agents-implement',
      'swarm.proompteng.ai/name=torghut-quant,swarm.proompteng.ai/uid=swarm-uid',
    )
    expect(list).toHaveBeenCalledWith(
      RESOURCE_MAP.OrchestrationRun,
      'agents-implement',
      'swarm.proompteng.ai/name=torghut-quant,swarm.proompteng.ai/uid=swarm-uid',
    )
    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(4)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toBeTruthy()
  })

  it('does not deduplicate runs that share name across different run kinds', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              kind: 'AgentRun',
              metadata: {
                name: 'shared-run',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:01:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return {
          items: [
            {
              kind: 'OrchestrationRun',
              metadata: {
                name: 'shared-run',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(4)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toBeTruthy()
  })

  it('does not immediately re-freeze from failures that occurred before freeze expiry', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              metadata: {
                name: 'old-run-2',
                creationTimestamp: '2026-01-19T22:59:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
            {
              metadata: {
                name: 'old-run-1',
                creationTimestamp: '2026-01-19T22:58:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'torghut-quant',
                  'swarm.proompteng.ai/stage': 'implement',
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
      status: {
        freeze: {
          reason: 'ConsecutiveFailures',
          until: '2026-01-19T23:00:00Z',
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    expect(deleteFn).not.toHaveBeenCalled()
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Active')
    expect(status.freeze).toBeUndefined()
  })

  it('reconciles again after freeze expiry to resume schedules automatically', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'torghut-quant', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'trading-owner', channel: 'swarm://owner/trading' },
        domains: ['autonomous-trading'],
        objectives: ['improve risk-adjusted return'],
        mode: 'lights-out',
        cadence: {
          discoverEvery: '1m',
          planEvery: '5m',
          implementEvery: '15m',
          verifyEvery: '1m',
        },
        discovery: { sources: [{ name: 'market-feed' }] },
        delivery: { deploymentTargets: ['torghut'] },
        risk: { freezeAfterFailures: 2, freezeDuration: '60m' },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
      status: {
        freeze: {
          reason: 'ConsecutiveFailures',
          until: '2026-01-20T00:00:05Z',
        },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Swarm) return swarm
      if (resource === RESOURCE_MAP.Schedule) {
        return {
          status: {
            phase: 'Active',
            lastRunTime: '2026-01-20T00:00:05Z',
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    const initialStatusCall = applyStatus.mock.calls[0]
    const initialStatus = (initialStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(initialStatus.phase).toBe('Frozen')

    await vi.advanceTimersByTimeAsync(5000)

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'torghut-quant', 'agents')
    expect(apply).toHaveBeenCalledTimes(4)
    const finalStatusCall = applyStatus.mock.calls.at(-1)
    const finalStatus = (finalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(finalStatus.phase).toBe('Active')
    expect(finalStatus.freeze).toBeUndefined()
  })

  it('uses different schedule names for long swarms with identical prefixes', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) {
        return { items: [] }
      }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    const makeSwarm = (suffix: string) => ({
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm' as const,
      metadata: { name: `${'a'.repeat(90)}-${suffix}`, namespace: 'agents', generation: 1, uid: `swarm-${suffix}` },
      spec: {
        owner: { id: `platform-owner-${suffix}`, channel: `swarm://owner/platform-${suffix}` },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        discovery: { sources: [{ name: 'github-issues' }] },
        delivery: { deploymentTargets: ['agents'] },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: `agentrun-${suffix}` } },
          plan: { targetRef: { kind: 'AgentRun', name: `agentrun-${suffix}` } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: `orchestrationrun-${suffix}` } },
          verify: { targetRef: { kind: 'AgentRun', name: `agentrun-${suffix}` } },
        },
      },
    })

    await __test__.reconcileSwarm(kube, makeSwarm('one'), 'agents')
    await __test__.reconcileSwarm(kube, makeSwarm('two'), 'agents')

    const scheduleNames = apply.mock.calls.map((call) => {
      const payload = call[0] as Record<string, unknown>
      return asString(payload?.metadata ? (payload.metadata as Record<string, unknown>).name : undefined)
    })
    const uniqueNames = new Set(scheduleNames)
    expect(scheduleNames.filter((name): name is string => typeof name === 'string')).toHaveLength(8)
    expect(uniqueNames.size).toBe(8)
  })

  it('deletes managed schedules when swarm spec is invalid', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue(null)
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, delete: deleteFn } as unknown as KubernetesClient

    const swarm = {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'invalid-swarm', namespace: 'agents', generation: 1, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner' },
        domains: ['platform-reliability'],
        objectives: ['improve reliability'],
        mode: 'lights-out',
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'OrchestrationRun', name: 'orchestrationrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(4)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Invalid')
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const ready = conditions.find((condition) => condition.type === 'Ready')
    expect(ready?.status).toBe('False')
    expect((ready as { reason?: string } | undefined)?.reason).toBe('InvalidSpec')
  })
})
