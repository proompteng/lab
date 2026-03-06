import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('~/server/feature-flags', () => ({
  resolveBooleanFeatureToggle: vi.fn(async () => true),
}))

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

const kubeWatchMocks = vi.hoisted(() => ({
  startResourceWatch: vi.fn(() => ({ stop: vi.fn() })),
}))

const primitivesKubeMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

vi.mock('node:child_process', () => childProcessMocks)
vi.mock('~/server/kube-watch', () => kubeWatchMocks)
vi.mock('~/server/primitives-kube', async () => {
  const actual = await vi.importActual<typeof import('~/server/primitives-kube')>('~/server/primitives-kube')
  return {
    ...actual,
    createKubernetesClient: primitivesKubeMocks.createKubernetesClient,
  }
})

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import { asString } from '~/server/primitives-http'
import type { KubernetesClient } from '~/server/primitives-kube'
import { RESOURCE_MAP } from '~/server/primitives-kube'
import {
  __test__,
  startSupportingPrimitivesController,
  stopSupportingPrimitivesController,
} from '~/server/supporting-primitives-controller'

const createMockKubectlProcess = (code: number, stderr = '') => {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  const stderrStream = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  stdout.setEncoding = () => {}
  stderrStream.setEncoding = () => {}

  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderrStream
    kill: () => void
  }
  child.stdout = stdout
  child.stderr = stderrStream
  child.kill = () => {}

  queueMicrotask(() => {
    if (stderr) {
      stderrStream.emit('data', stderr)
    }
    child.emit('close', code)
  })

  return child
}

const requirementIdForSignal = (signalNamespace: string, signalName: string) => {
  const value = `${signalNamespace}/${signalName}`
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36).padStart(8, '0').slice(0, 8)
}

describe('supporting primitives controller', () => {
  let resolveSwarmAvailability: (resource: string, call: number) => { code: number; stderr?: string } = () => ({
    code: 0,
  })
  let kubectlCalls = new Map<string, number>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
    kubectlCalls = new Map()
    resolveSwarmAvailability = (resource, call) => {
      if (resource === 'swarms' && call === 1) {
        return {
          code: 1,
          stderr: 'error: the server does not have a resource type "swarms.swarm.proompteng.ai"',
        }
      }
      return { code: 0 }
    }
    childProcessMocks.spawn.mockImplementation((_, args: string[] = []) => {
      const resource = typeof args[1] === 'string' ? args[1] : ''
      const normalizedResource = resource.split('.').at(0) ?? resource
      const count = (kubectlCalls.get(resource) ?? 0) + 1
      kubectlCalls.set(resource, count)
      const result = resolveSwarmAvailability(normalizedResource, count)
      return createMockKubectlProcess(result.code, result.stderr ?? '')
    })
    primitivesKubeMocks.createKubernetesClient.mockReturnValue({
      list: vi.fn(async () => ({ items: [] })),
    })
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED
    delete process.env.JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY
  })

  afterEach(() => {
    stopSupportingPrimitivesController()
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

  it('builds schedule runner command with runtime delivery id substitution', () => {
    const command = __test__.buildScheduleRunnerCommand()

    expect(command).toContain('DELIVERY_ID=$(cat /proc/sys/kernel/random/uuid);')
    expect(command).toContain('s/__JANGAR_DELIVERY_ID__/${DELIVERY_ID}/g')
    expect(command).not.toContain('\\${DELIVERY_ID}')
  })

  it('staggers hourly stage cadence deterministically per stage', () => {
    const discoverCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'discover' })
    const planCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'plan' })
    const implementCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'implement' })
    const verifyCron = __test__.cadenceToCron('1h', { swarmName: 'jangar-control-plane', stage: 'verify' })

    expect(discoverCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(planCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(implementCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(verifyCron).toMatch(/^\d{1,2} \* \* \* \*$/)
    expect(new Set([discoverCron, planCron, implementCron, verifyCron]).size).toBe(4)
  })

  it('normalizes requirement priority from payload and labels', () => {
    expect(
      __test__.resolveRequirementPriorityScore({
        spec: { payload: { priority: 'critical' } },
      } as Record<string, unknown>),
    ).toBe(0)
    expect(
      __test__.resolveRequirementPriorityScore({
        spec: { payload: { priority: 'low' } },
      } as Record<string, unknown>),
    ).toBe(3)
    expect(
      __test__.resolveRequirementPriorityScore({
        metadata: { labels: { priority: 'high' } },
        spec: {},
      } as Record<string, unknown>),
    ).toBe(1)
  })

  it('strips global huly-api secret when building schedule run templates', () => {
    const schedule = {
      metadata: {
        name: 'torghut-quant-discover-sched',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/name': 'torghut-quant',
        },
        annotations: {
          'swarm.proompteng.ai/huly-secret': 'huly-api-torghut',
        },
      },
    } as Record<string, unknown>
    const target = {
      kind: 'AgentRun',
      metadata: { namespace: 'agents' },
      spec: {
        agentRef: { name: 'codex-spark-agent' },
        runtime: { type: 'job' },
        secrets: ['codex-auth', 'huly-api'],
      },
    } as Record<string, unknown>

    const template = __test__.buildScheduleRunTemplate(schedule, target, '__DELIVERY__')
    const spec = (template as { spec?: Record<string, unknown> }).spec ?? {}
    const secrets = Array.isArray(spec.secrets) ? (spec.secrets as string[]) : []
    expect(secrets).toContain('codex-auth')
    expect(secrets).toContain('huly-api-torghut')
    expect(secrets).not.toContain('huly-api')
  })

  it('skips apply for equivalent schedule resources', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
        annotations: { 'swarm.proompteng.ai/worker-id': 'worker-123' },
        resourceVersion: '123',
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
        },
      },
      status: { phase: 'Active' },
    })
    const kube = { apply, get } as unknown as KubernetesClient

    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
        annotations: { 'swarm.proompteng.ai/worker-id': 'worker-123' },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
        },
      },
    }

    await __test__.applyResourceIfChanged(kube, schedule)

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.Schedule, 'jangar-control-plane-discover-sched', 'agents')
    expect(apply).not.toHaveBeenCalled()
  })

  it('skips apply when live resource has extra defaulted fields outside desired spec', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: {
          'swarm.proompteng.ai/name': 'jangar-control-plane',
          'controller-runtime': 'defaulted',
        },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
          uid: 'defaulted-uid',
        },
      },
    })
    const kube = { apply, get } as unknown as KubernetesClient

    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
        targetRef: {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'agentrun-sample',
          namespace: 'agents',
        },
      },
    }

    await __test__.applyResourceIfChanged(kube, schedule)

    expect(apply).not.toHaveBeenCalled()
  })

  it('applies schedule when desired spec differs from live resource', async () => {
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
      },
      spec: {
        cron: '*/10 * * * *',
        timezone: 'UTC',
      },
    })
    const kube = { apply, get } as unknown as KubernetesClient

    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: {
        name: 'jangar-control-plane-discover-sched',
        namespace: 'agents',
        labels: { 'swarm.proompteng.ai/name': 'jangar-control-plane' },
      },
      spec: {
        cron: '*/5 * * * *',
        timezone: 'UTC',
      },
    }

    await __test__.applyResourceIfChanged(kube, schedule)

    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('resolves watched resources only for controller-managed kinds', () => {
    expect(__test__.resolveWatchedResourceForKind('Swarm')).toBe(RESOURCE_MAP.Swarm)
    expect(__test__.resolveWatchedResourceForKind('Schedule')).toBe(RESOURCE_MAP.Schedule)
    expect(__test__.resolveWatchedResourceForKind('Artifact')).toBe(RESOURCE_MAP.Artifact)
    expect(__test__.resolveWatchedResourceForKind('ConfigMap')).toBeNull()
  })

  it('identifies swarm status-only modified events', () => {
    const swarm = {
      kind: 'Swarm',
      metadata: { generation: 7 },
      status: { observedGeneration: 7 },
    }

    expect(__test__.isSwarmStatusOnlyEvent('MODIFIED', swarm)).toBe(true)
    expect(__test__.isSwarmStatusOnlyEvent('ADDED', swarm)).toBe(false)
    expect(__test__.isSwarmStatusOnlyEvent('MODIFIED', { ...swarm, status: { observedGeneration: 6 } })).toBe(false)
  })

  it('throttles swarm status-only reconciles within the guard interval', () => {
    const key = 'agents/Swarm/jangar-control-plane'
    const startMs = 1_000

    expect(__test__.shouldThrottleSwarmStatusReconcile(key, startMs)).toBe(false)
    expect(
      __test__.shouldThrottleSwarmStatusReconcile(key, startMs + __test__.SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS - 1),
    ).toBe(true)
    expect(
      __test__.shouldThrottleSwarmStatusReconcile(key, startMs + __test__.SWARM_STATUS_ONLY_RECONCILE_INTERVAL_MS),
    ).toBe(false)
  })

  it('throttles schedule runner status reconciles within the guard interval', () => {
    const key = 'agents/Schedule/jangar-control-plane-plan-sched'
    const startMs = 1_000

    expect(__test__.shouldThrottleScheduleRunnerStatusReconcile(key, startMs)).toBe(false)
    expect(
      __test__.shouldThrottleScheduleRunnerStatusReconcile(
        key,
        startMs + __test__.SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS - 1,
      ),
    ).toBe(true)
    expect(
      __test__.shouldThrottleScheduleRunnerStatusReconcile(
        key,
        startMs + __test__.SCHEDULE_RUNNER_STATUS_RECONCILE_INTERVAL_MS,
      ),
    ).toBe(false)
  })

  it('reconciles schedule runner status without full schedule apply path', async () => {
    const get = vi.fn(async (resource: string) => {
      if (resource === 'cronjob') {
        return { status: { lastScheduleTime: '2026-01-20T00:10:00Z' } }
      }
      return null
    })
    const applyStatus = vi.fn().mockResolvedValue({})
    const kube = { get, applyStatus } as unknown as KubernetesClient
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: { name: 'schedule-a', namespace: 'agents', generation: 3 },
      status: { conditions: [] },
    }

    await __test__.reconcileScheduleRunnerStatus(kube, schedule, 'agents')

    expect(get).toHaveBeenCalledWith('cronjob', 'schedule-a-cron', 'agents')
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const payload = applyStatus.mock.calls[0]?.[0] as { status?: Record<string, unknown> }
    expect(payload.status?.phase).toBe('Active')
    expect(payload.status?.lastRunTime).toBe('2026-01-20T00:10:00Z')
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

  it('starts swarm watches when optional swarm CRD appears after startup', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await startSupportingPrimitivesController()

      const watchCalls = vi.mocked(kubeWatchMocks.startResourceWatch).mock.calls as unknown[][]
      const initialSwarmWatchCalls = watchCalls.filter((call) => {
        const options = (call[0] ?? {}) as Record<string, unknown>
        return options.resource === RESOURCE_MAP.Swarm
      })
      expect(initialSwarmWatchCalls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(__test__.SWARM_CRD_REFRESH_INTERVAL_MS)

      expect(vi.mocked(kubeWatchMocks.startResourceWatch)).toHaveBeenCalledWith(
        expect.objectContaining({ resource: RESOURCE_MAP.Swarm, namespace: 'agents' }),
      )
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
        integrations: {
          huly: {
            baseUrl: 'https://huly.proompteng.ai',
            workspace: 'virtual-workers',
            project: 'jangar-control-plane',
            authSecretRef: {
              name: 'swarm-huly-access',
            },
            skillRef: 'skills/huly-api/SKILL.md',
          },
        },
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
      expect(payload.apiVersion).toBe('schedules.proompteng.ai/v1alpha1')
      const labels =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).labels
          : undefined
      expect(labels).toBeTruthy()
      expect(labels).toMatchObject({
        'swarm.proompteng.ai/uid': 'swarm-uid',
      })
      const labelsRecord = (labels ?? {}) as Record<string, unknown>
      expect(typeof labelsRecord['swarm.proompteng.ai/worker-id']).toBe('string')

      const annotations =
        payload?.metadata && typeof payload.metadata === 'object'
          ? (payload.metadata as Record<string, unknown>).annotations
          : undefined
      expect(annotations).toMatchObject({
        'swarm.proompteng.ai/huly-base-url': 'https://huly.proompteng.ai',
        'swarm.proompteng.ai/huly-workspace': 'virtual-workers',
        'swarm.proompteng.ai/huly-project': 'jangar-control-plane',
        'swarm.proompteng.ai/huly-secret': 'swarm-huly-access',
        'swarm.proompteng.ai/huly-skill-ref': 'skills/huly-api/SKILL.md',
      })
      expect(typeof (annotations as Record<string, unknown>)['swarm.proompteng.ai/worker-id']).toBe('string')
      expect(typeof (annotations as Record<string, unknown>)['swarm.proompteng.ai/agent-identity']).toBe('string')
    }
    expect(deleteFn).not.toHaveBeenCalled()
    expect(applyStatus).toHaveBeenCalledTimes(1)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Active')
    expect(status.activeMissions).toBe(0)
    expect(status.stageStates).toBeTruthy()
  })

  it('does not derive huly api base url from owner channel transport-like values', async () => {
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
        owner: { id: 'platform-owner', channel: 'http://front.huly.svc.cluster.local' },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const schedulePayload = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((payload) => payload.kind === 'Schedule') as { metadata?: Record<string, unknown> } | undefined
    expect(schedulePayload).toBeDefined()
    const annotations = (schedulePayload?.metadata?.annotations ?? {}) as Record<string, string>
    expect(annotations['swarm.proompteng.ai/huly-base-url']).toBe('https://huly.proompteng.ai')
  })

  it('dispatches Huly requirement signals into implement runs', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
            secrets: ['huly-api', 'keep-me'],
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-1',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-123',
                description: 'Raise risk budget guardrails for market-open volatility',
                payload: {
                  priority: 'high',
                  acceptance: 'deploy and verify policy',
                  context: {
                    source: 'torghut-quant',
                    deadline: '2026-01-25T00:00:00Z',
                  },
                },
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const runLabels = (requirementRun.metadata.labels ?? {}) as Record<string, string>
    expect(runLabels['swarm.proompteng.ai/requirement-channel']).toBe('huly')
    expect(runLabels['swarm.proompteng.ai/from']).toBe('torghut-quant')
    expect(runLabels['swarm.proompteng.ai/to']).toBe('jangar-control-plane')
    expect(runLabels['swarm.proompteng.ai/worker-id']).toMatch(/^worker-/)
    expect(runLabels['swarm.proompteng.ai/requirement-attempt']).toBe('1')

    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.staticKey).toBe('static-value')
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-1')
    expect(parameters.swarmRequirementChannel).toBe('huly://swarm-bridge/issues/TOR-123')
    expect(parameters.swarmRequirementSource).toBe('torghut-quant')
    expect(parameters.swarmRequirementTarget).toBe('jangar-control-plane')
    expect(parameters.swarmRequirementDescription).toBe('Raise risk budget guardrails for market-open volatility')
    const payload = parameters.swarmRequirementPayload ? JSON.parse(parameters.swarmRequirementPayload) : null
    expect(payload).toEqual({
      priority: 'high',
      acceptance: 'deploy and verify policy',
      context: {
        source: 'torghut-quant',
        deadline: '2026-01-25T00:00:00Z',
      },
    })
    expect(parameters.objective).toBe(
      'Raise risk budget guardrails for market-open volatility\n\nacceptance: deploy and verify policy',
    )
    expect(parameters.swarmAgentWorkerId).toMatch(/^worker-/)
    expect(parameters.swarmAgentIdentity).toMatch(/^vw-/)
    expect(parameters.swarmAgentRole).toBe('engineer')
    expect(parameters.hulyApiBaseUrl).toBe('https://huly.proompteng.ai')
    expect(parameters.hulySkillRef).toBe('skills/huly-api/SKILL.md')
    const runSecrets = Array.isArray(requirementRun.spec.secrets) ? (requirementRun.spec.secrets as string[]) : []
    expect(runSecrets).not.toContain('huly-api')
    expect(runSecrets).toContain('keep-me')
    expect(runSecrets).toHaveLength(1)

    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(1)
    expect(requirements.invalidChannel).toBe(0)
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge')
    expect(bridge?.status).toBe('True')
  })

  it('dispatches higher-priority requirement signals before lower-priority signals', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
            secrets: ['keep-me'],
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-low-priority',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-LOW',
                description: 'Low priority scope',
                payload: {
                  priority: 'low',
                },
              },
            },
            {
              metadata: {
                name: 'torghut-critical-priority',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:10:00Z',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-HIGH',
                description: 'Critical priority scope',
                payload: {
                  priority: 'critical',
                },
              },
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
      metadata: { name: 'jangar-control-plane', namespace: 'agents', generation: 2, uid: 'swarm-uid' },
      spec: {
        owner: { id: 'platform-owner', channel: 'swarm://owner/platform' },
        mode: 'lights-out',
        timezone: 'UTC',
        cadence: {
          discoverEvery: '5m',
          planEvery: '10m',
          implementEvery: '10m',
          verifyEvery: '5m',
        },
        execution: {
          discover: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          plan: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(2)
    const firstParameters = (requirementRunPayloads[0]?.spec as Record<string, unknown> | undefined)?.parameters as
      | Record<string, string>
      | undefined
    const secondParameters = (requirementRunPayloads[1]?.spec as Record<string, unknown> | undefined)?.parameters as
      | Record<string, string>
      | undefined
    expect(firstParameters?.swarmRequirementSignal).toBe('torghut-critical-priority')
    expect(secondParameters?.swarmRequirementSignal).toBe('torghut-low-priority')
  })

  it('uses requirement payload as primary objective when description is missing', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const payloadForObjective = {
      priority: 'critical',
      constraints: ['do not touch auth'],
      acceptance: ['add guardrail', 'run chaos test'],
    }
    const payloadForObjectiveString = JSON.stringify(payloadForObjective)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-2',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-222',
                payload: payloadForObjective,
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-2')
    expect(parameters.swarmRequirementDescription).toBeUndefined()
    expect(parameters.swarmRequirementPayload).toBe(payloadForObjectiveString)
    expect(parameters.objective).toBe('acceptance: add guardrail, run chaos test')
    expect(parameters.swarmRequirementPayloadBytes).toBe('107')
  })

  it('uses mission from payload as objective when objective and acceptance are missing', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const payloadForObjective = {
      mission: 'stabilize requirement handoff latency',
      scope: 'handoff',
      acceptanceCriteria: ['publish handoff artifacts'],
    }
    const payloadForObjectiveString = JSON.stringify(payloadForObjective)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-mission',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-444',
                payload: payloadForObjective,
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      spec: Record<string, unknown>
    }
    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-mission')
    expect(parameters.swarmRequirementDescription).toBeUndefined()
    expect(parameters.swarmRequirementPayload).toBe(payloadForObjectiveString)
    expect(parameters.objective).toBe('mission: stabilize requirement handoff latency')
    expect(parameters.swarmRequirementPayloadBytes).toBe(
      String(new TextEncoder().encode(payloadForObjectiveString).length),
    )
  })

  it('extracts objective from payload object when present', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const payloadForObjective = {
      objective: 'Align platform handoff policy and rollback checks',
      acceptance: ['add feature gate', 'run canary check'],
      scope: 'reliability',
    }
    const payloadForObjectiveString = JSON.stringify(payloadForObjective)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-3',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-333',
                payload: payloadForObjective,
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const parameters = (requirementRun.spec.parameters ?? {}) as Record<string, string>
    expect(parameters.swarmRequirementSignal).toBe('torghut-risk-handoff-3')
    expect(parameters.swarmRequirementDescription).toBeUndefined()
    expect(parameters.swarmRequirementPayload).toBe(payloadForObjectiveString)
    expect(parameters.objective).toBe(payloadForObjective.objective)
    expect(parameters.swarmRequirementPayloadBytes).toBe(
      String(new TextEncoder().encode(payloadForObjectiveString).length),
    )
  })

  it('uses objective payload truncation metadata when payload exceeds transfer cap', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
            parameters: {
              staticKey: 'static-value',
            },
          },
        }
      }
      return null
    })
    const largePayload = { riskMode: 'critical', details: 'x'.repeat(18_000) }
    const largePayloadString = JSON.stringify(largePayload)
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-4',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-444',
                description: 'Long payload truncation validation run',
                payload: largePayload,
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const truncatedRun = requirementRunPayloads.find((requirement) => {
      const spec = (requirement as { spec: Record<string, unknown> }).spec
      const payload = (spec.parameters as Record<string, string> | undefined)?.swarmRequirementPayload
      return typeof payload === 'string' && payload.length === 16_384
    })
    expect(truncatedRun).toBeTruthy()
    const parameters = ((truncatedRun as { spec: Record<string, unknown> }).spec.parameters ?? {}) as Record<
      string,
      string
    >
    const payload = parameters.swarmRequirementPayload
    expect(parameters.swarmRequirementPayloadBytes).toBeDefined()
    expect(Number(parameters.swarmRequirementPayloadBytes)).toBeGreaterThan(16_384)
    expect(parameters.swarmRequirementPayloadTruncated).toBe('true')
    expect(payload.length).toBe(16_384)
    expect(payload).toBe(largePayloadString.slice(0, 16_384))
  })

  it('rejects non-Huly requirement channels for cross-swarm implementation', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn().mockResolvedValue({
      status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' },
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: 'torghut-risk-handoff-2',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'slack://swarm-bridge/TOR-456',
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.pending).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.invalidChannel).toBe(1)
    const conditions = Array.isArray(status.conditions) ? status.conditions : []
    const bridge = conditions.find((condition) => condition.type === 'RequirementsBridge')
    expect(bridge?.status).toBe('False')
    expect((bridge as { reason?: string } | undefined)?.reason).toBe('InvalidRequirementChannel')
  })

  it('does not re-dispatch requirement signals that already completed', async () => {
    const requirementSignalName = 'torghut-risk-handoff-3'
    const requirementId = requirementIdForSignal('agents', requirementSignalName)
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
              kind: 'AgentRun',
              metadata: {
                name: 'completed-requirement-run',
                namespace: 'agents',
                creationTimestamp: '2026-01-20T00:00:00Z',
                labels: {
                  'swarm.proompteng.ai/name': 'jangar-control-plane',
                  'swarm.proompteng.ai/stage': 'implement',
                  'swarm.proompteng.ai/requirement-id': requirementId,
                },
              },
              status: { phase: 'Succeeded' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: requirementSignalName,
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-789',
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(4)
    const statusCall = applyStatus.mock.calls.at(-1)
    const status = (statusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    const requirements = (status.requirements ?? {}) as Record<string, unknown>
    expect(requirements.completed).toBe(1)
    expect(requirements.dispatched).toBe(0)
    expect(requirements.pending).toBe(0)
  })

  it('re-dispatches requirement signals after failed attempts until max retry count', async () => {
    const requirementSignalName = 'torghut-risk-handoff-4'
    const requirementId = requirementIdForSignal('agents', requirementSignalName)
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Schedule) {
        return { status: { phase: 'Active', lastRunTime: '2026-01-20T00:00:00Z' } }
      }
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          kind: 'AgentRun',
          metadata: { name: 'agentrun-implement-template', namespace: 'agents' },
          spec: {
            agentRef: { name: 'codex-spark-agent' },
            runtime: { type: 'job' },
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun) {
        return {
          items: [
            {
              kind: 'AgentRun',
              metadata: {
                name: 'failed-requirement-run',
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/name': 'jangar-control-plane',
                  'swarm.proompteng.ai/stage': 'implement',
                  'swarm.proompteng.ai/requirement-id': requirementId,
                },
              },
              status: { phase: 'Failed' },
            },
          ],
        }
      }
      if (resource === RESOURCE_MAP.Signal) {
        return {
          items: [
            {
              metadata: {
                name: requirementSignalName,
                namespace: 'agents',
                labels: {
                  'swarm.proompteng.ai/type': 'requirement',
                  'swarm.proompteng.ai/from': 'torghut-quant',
                  'swarm.proompteng.ai/to': 'jangar-control-plane',
                },
              },
              spec: {
                channel: 'huly://swarm-bridge/issues/TOR-654',
              },
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
          implement: { targetRef: { kind: 'AgentRun', name: 'agentrun-implement-template' } },
          verify: { targetRef: { kind: 'AgentRun', name: 'agentrun-sample' } },
        },
      },
    }

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    const requirementRunPayloads = apply.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.kind === 'AgentRun' && typeof payload.metadata === 'object')
      .filter((payload) => {
        const metadata = payload.metadata as Record<string, unknown>
        return typeof metadata.generateName === 'string' && (metadata.generateName as string).includes('req')
      })
    expect(requirementRunPayloads).toHaveLength(1)
    const requirementRun = requirementRunPayloads[0] as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    const runLabels = (requirementRun.metadata.labels ?? {}) as Record<string, string>
    expect(runLabels['swarm.proompteng.ai/requirement-attempt']).toBe('2')
    expect((requirementRun.spec.idempotencyKey as string) ?? '').toContain('-attempt-2')
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

  it('includes nested workflow failure detail in freeze evidence when top-level status is empty', async () => {
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
              status: {
                phase: 'Failed',
                workflow: {
                  steps: [
                    {
                      name: 'deploy-step',
                      phase: 'Failed',
                      message: 'workflow step deploy-step: container exited with code 17',
                    },
                  ],
                },
              },
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
              status: {
                phase: 'Failed',
                workflow: {
                  steps: [
                    {
                      name: 'deploy-step',
                      phase: 'Failed',
                      message: 'workflow step deploy-step: container exited with code 17',
                    },
                  ],
                },
              },
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

    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.freeze).toMatchObject({
      reason: 'ConsecutiveFailures',
      evidence: {
        triggeringRuns: expect.arrayContaining([
          expect.objectContaining({ reason: 'workflow step deploy-step: container exited with code 17' }),
        ]),
      },
    })
  })

  it('freezes when consecutive timed-out implement failures remain active', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (resource: string, name: string) => {
      if (resource === 'job' && (name === 'timeout-job-1' || name === 'timeout-job-2')) {
        return {
          metadata: { name, namespace: 'agents' },
          status: {
            succeeded: 1,
            startTime: '2026-01-20T00:00:00Z',
            completionTime: '2026-01-20T00:10:00Z',
          },
        }
      }
      return null
    })
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
              status: {
                phase: 'Failed',
                runtimeRef: { type: 'workflow', name: 'timeout-job-2', namespace: 'agents' },
                conditions: [{ type: 'Failed', status: 'True', reason: 'WorkflowStepTimedOut' }],
              },
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
              status: {
                phase: 'Failed',
                runtimeRef: { type: 'workflow', name: 'timeout-job-1', namespace: 'agents' },
                conditions: [{ type: 'Failed', status: 'True', reason: 'WorkflowStepTimedOut' }],
              },
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
    expect(status.freeze).toMatchObject({
      reason: 'ConsecutiveFailures',
    })
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

  it('re-freezes when stale stage cadence indicates liveness loss after freeze expiry', async () => {
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

    expect(apply).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledTimes(4)
    const firstStatusCall = applyStatus.mock.calls[0]
    const status = (firstStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(status.phase).toBe('Frozen')
    expect(status.freeze).toMatchObject({
      reason: 'StageStaleness',
    })
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
    expect(finalStatus.freeze).toMatchObject({
      reason: 'NotFrozen',
      threshold: 2,
      durationMs: 60 * 60 * 1000,
      evidence: {
        triggeringRuns: [],
        stageStaleness: [],
        triggers: [],
      },
    })
    expect(finalStatus.freeze).toHaveProperty('until')
    expect(finalStatus.freeze).toHaveProperty('enteredAt')
  })

  it('chunks unfreeze timers so long freeze durations wait the full expiry time', async () => {
    const applyStatus = vi.fn().mockResolvedValue({})
    const apply = vi.fn().mockResolvedValue({})
    const longFreezeMs = 2_500_000_000
    const freezeUntil = new Date(Date.now() + longFreezeMs).toISOString()
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
          until: freezeUntil,
        },
      },
    }
    const get = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.Swarm) return swarm
      if (resource === RESOURCE_MAP.Schedule) {
        return {
          status: {
            phase: 'Active',
            lastRunTime: freezeUntil,
          },
        }
      }
      return null
    })
    const list = vi.fn(async (resource: string) => {
      if (resource === RESOURCE_MAP.AgentRun || resource === RESOURCE_MAP.OrchestrationRun) return { items: [] }
      return { items: [] }
    })
    const deleteFn = vi.fn().mockResolvedValue(null)
    const kube = { applyStatus, apply, get, list, delete: deleteFn } as unknown as KubernetesClient

    await __test__.reconcileSwarm(kube, swarm, 'agents')

    expect(apply).toHaveBeenCalledTimes(0)
    const initialStatusCall = applyStatus.mock.calls[0]
    const initialStatus = (initialStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(initialStatus.phase).toBe('Frozen')

    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(get).not.toHaveBeenCalled()

    const remainingDelay = 2_500_000_000 - 2_147_483_647
    await vi.advanceTimersByTimeAsync(remainingDelay)

    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'torghut-quant', 'agents')
    const finalStatusCall = applyStatus.mock.calls.at(-1)
    const finalStatus = (finalStatusCall?.[0] as { status?: Record<string, unknown> } | undefined)?.status ?? {}
    expect(finalStatus.phase).toBe('Active')
    expect(finalStatus.freeze).toMatchObject({
      reason: 'NotFrozen',
      threshold: 2,
      durationMs: 60 * 60 * 1000,
      evidence: {
        triggeringRuns: [],
        stageStaleness: [],
        triggers: [],
      },
    })
    expect(finalStatus.freeze).toHaveProperty('until')
    expect(finalStatus.freeze).toHaveProperty('enteredAt')
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
