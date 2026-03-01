import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/feature-flags', () => ({
  resolveBooleanFeatureToggle: vi.fn(async () => true),
}))

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
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
    }
    expect(deleteFn).not.toHaveBeenCalled()
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Active')
    expect(status.activeMissions).toBe(0)
    expect(status.stageStates).toBeTruthy()
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
})
