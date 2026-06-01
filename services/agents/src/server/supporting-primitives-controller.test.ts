import { afterEach, describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from './kube-types'
import { __test__ } from './supporting-primitives-controller'
import { __test__ as scheduleRunnerTest } from './supporting-schedule-runner'

const originalSwarmPrimitiveEnabled = process.env.AGENTS_SWARM_PRIMITIVE_ENABLED

afterEach(() => {
  if (originalSwarmPrimitiveEnabled === undefined) {
    delete process.env.AGENTS_SWARM_PRIMITIVE_ENABLED
  } else {
    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = originalSwarmPrimitiveEnabled
  }
})

const createKubeMock = (resources: Record<string, Record<string, unknown> | null> = {}) => {
  const applied: Record<string, unknown>[] = []
  const statuses: Record<string, unknown>[] = []
  const deleted: Array<{ resource: string; name: string; namespace: string }> = []
  const kube: KubernetesClient = {
    apply: vi.fn(async (resource) => {
      applied.push(resource)
      return resource
    }),
    applyManifest: vi.fn(async () => ({})),
    applyStatus: vi.fn(async (resource) => {
      statuses.push(resource)
      return resource
    }),
    createManifest: vi.fn(async () => ({})),
    delete: vi.fn(async (resource, name, namespace) => {
      deleted.push({ resource, name, namespace })
      return {}
    }),
    patch: vi.fn(async (_resource, _name, _namespace, patch) => patch),
    get: vi.fn(async (resource, name, namespace) => resources[`${resource}:${namespace}:${name}`] ?? null),
    list: vi.fn(async () => ({ items: [] })),
    listEvents: vi.fn(async () => ({ items: [] })),
    logs: vi.fn(async () => ''),
  }
  return { kube, applied, statuses, deleted }
}

describe('supporting primitives controller', () => {
  it('keeps Swarm out of supporting CRD checks and watches unless explicitly enabled', () => {
    delete process.env.AGENTS_SWARM_PRIMITIVE_ENABLED
    expect(__test__.resolveRequiredCrds()).not.toContain(RESOURCE_MAP.Swarm)
    expect(__test__.resolveResourceListOrder()).not.toContain(RESOURCE_MAP.Swarm)

    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = 'true'
    expect(__test__.resolveRequiredCrds()).toContain(RESOURCE_MAP.Swarm)
    expect(__test__.resolveResourceListOrder()).toContain(RESOURCE_MAP.Swarm)
  })

  it('does not fail the supporting CRD probe when the Swarm CRD is absent and swarm primitives are disabled', async () => {
    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = 'false'
    const probeNamespacedResource = vi.fn(async (resource: string) =>
      resource === RESOURCE_MAP.Swarm ? 'missing' : 'ok',
    )

    await expect(__test__.checkCrds({ probeNamespacedResource })).resolves.toMatchObject({
      ok: true,
      missing: [],
    })
    expect(probeNamespacedResource).not.toHaveBeenCalledWith(RESOURCE_MAP.Swarm, expect.any(String))
  })

  it('requires the Swarm CRD when swarm primitives are explicitly enabled', async () => {
    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = 'true'
    const probeNamespacedResource = vi.fn(async (resource: string) =>
      resource === RESOURCE_MAP.Swarm ? 'missing' : 'ok',
    )

    await expect(__test__.checkCrds({ probeNamespacedResource })).resolves.toMatchObject({
      ok: false,
      missing: [RESOURCE_MAP.Swarm],
      forbidden: [],
    })
    expect(probeNamespacedResource).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'agents')
  })

  it('surfaces forbidden Swarm access separately from missing CRDs', async () => {
    process.env.AGENTS_SWARM_PRIMITIVE_ENABLED = 'true'
    const probeNamespacedResource = vi.fn(async (resource: string) =>
      resource === RESOURCE_MAP.Swarm ? 'forbidden' : 'ok',
    )

    await expect(__test__.checkCrds({ probeNamespacedResource })).resolves.toMatchObject({
      ok: false,
      missing: [],
      forbidden: [RESOURCE_MAP.Swarm],
    })
    expect(probeNamespacedResource).toHaveBeenCalledWith(RESOURCE_MAP.Swarm, 'agents')
  })

  it('observes Swarm resources without dispatching domain requirement signals', async () => {
    const { kube, applied, statuses } = createKubeMock()

    await __test__.reconcileSwarm(kube, {
      apiVersion: 'swarm.proompteng.ai/v1alpha1',
      kind: 'Swarm',
      metadata: { name: 'runtime-workers', namespace: 'agents', generation: 2 },
      status: {
        phase: 'Ready',
        material_reentry_clearinghouse: {
          implementer_dispatches: [
            {
              dispatch_kind: 'swarm_requirement_signal',
              signal_name: 'domain-material-reentry',
              source_swarm: 'domain-runtime',
              target_swarm: 'runtime-workers',
              target_stage: 'implement',
              channel: 'agentrun.general.requirement',
              description: 'domain repair',
              payload: { domain: 'finance' },
            },
          ],
        },
      },
    })

    expect(applied).toHaveLength(0)
    expect(statuses[0]).toMatchObject({
      kind: 'Swarm',
      metadata: { name: 'runtime-workers', namespace: 'agents' },
      status: {
        observedGeneration: 2,
        phase: 'Ready',
        conditions: [expect.objectContaining({ type: 'Ready', status: 'True', reason: 'Observed' })],
      },
    })
  })

  it('validates Tool specs and writes standard status', async () => {
    const { kube, statuses } = createKubeMock()
    await __test__.reconcileTool(kube, {
      apiVersion: 'tools.proompteng.ai/v1alpha1',
      kind: 'Tool',
      metadata: { name: 'bad-tool', namespace: 'agents', generation: 3 },
      spec: { image: 'ubuntu:24.04' },
    })

    expect(statuses[0]).toMatchObject({
      kind: 'Tool',
      metadata: { name: 'bad-tool', namespace: 'agents' },
      status: {
        observedGeneration: 3,
        phase: 'Invalid',
        conditions: [expect.objectContaining({ type: 'Ready', status: 'False', reason: 'InvalidSpec' })],
      },
    })
  })

  it('reconciles Workspace resources into owned PVCs', async () => {
    const { kube, applied, statuses } = createKubeMock()
    await __test__.reconcileWorkspace(
      kube,
      {
        apiVersion: 'workspaces.proompteng.ai/v1alpha1',
        kind: 'Workspace',
        metadata: { name: 'work-a', namespace: 'agents', uid: 'uid-a', generation: 1 },
        spec: { size: '20Gi', accessModes: ['ReadWriteOnce'] },
      },
      'agents',
    )

    expect(applied[0]).toMatchObject({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: 'work-a',
        namespace: 'agents',
        labels: { 'workspaces.proompteng.ai/workspace': 'work-a' },
      },
      spec: { resources: { requests: { storage: '20Gi' } } },
    })
    expect(statuses.at(-1)).toMatchObject({
      kind: 'Workspace',
      status: { phase: 'Pending' },
    })
  })

  it('renders Schedule resources into ConfigMap and CronJob from the Agents runner path', async () => {
    const { kube, applied, statuses } = createKubeMock({
      'agentruns.agents.proompteng.ai:agents:template-run': {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'AgentRun',
        metadata: { name: 'template-run', namespace: 'agents' },
        spec: {
          agentRef: { name: 'demo-agent' },
          runtime: { type: 'job' },
          parameters: { objective: 'ship it' },
        },
      },
    })

    await __test__.reconcileSchedule(
      kube,
      {
        apiVersion: 'schedules.proompteng.ai/v1alpha1',
        kind: 'Schedule',
        metadata: { name: 'demo-schedule', namespace: 'agents', uid: 'schedule-uid', generation: 1 },
        spec: {
          cron: '*/15 * * * *',
          targetRef: { kind: 'AgentRun', name: 'template-run' },
        },
      },
      'agents',
    )

    const configMap = applied.find((resource) => resource.kind === 'ConfigMap')
    const cronJob = applied.find((resource) => resource.kind === 'CronJob')
    expect(configMap).toBeTruthy()
    expect(cronJob).toBeTruthy()
    expect(cronJob).toMatchObject({
      spec: {
        schedule: '*/15 * * * *',
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: [
                  expect.objectContaining({
                    name: 'schedule-runner',
                    command: ['bun', 'run', '/app/services/agents/src/server/supporting-schedule-runner.ts'],
                  }),
                ],
              },
            },
          },
        },
      },
    })
    expect(statuses.at(-1)).toMatchObject({
      kind: 'Schedule',
      status: { phase: 'Active' },
    })
  })

  it('removes Schedule runner resources when a schedule is suspended', async () => {
    const { kube, applied, deleted, statuses } = createKubeMock()

    await __test__.reconcileSchedule(
      kube,
      {
        apiVersion: 'schedules.proompteng.ai/v1alpha1',
        kind: 'Schedule',
        metadata: { name: 'demo-schedule', namespace: 'agents', uid: 'schedule-uid', generation: 2 },
        spec: {
          cron: '*/15 * * * *',
          suspend: true,
          targetRef: { kind: 'AgentRun', name: 'template-run' },
        },
      },
      'agents',
    )

    expect(applied).toHaveLength(0)
    expect(deleted).toEqual([
      { resource: 'configmap', name: 'demo-schedule-template', namespace: 'agents' },
      { resource: 'cronjob', name: 'demo-schedule-cron', namespace: 'agents' },
    ])
    expect(statuses.at(-1)).toMatchObject({
      kind: 'Schedule',
      status: {
        phase: 'Suspended',
        conditions: [expect.objectContaining({ type: 'Ready', status: 'True', reason: 'Suspended' })],
      },
    })
  })

  it('materializes canonical delivery placeholders in the schedule runner', () => {
    const manifest = scheduleRunnerTest.materializeManifest(
      JSON.stringify({
        metadata: {
          labels: {
            'agents.proompteng.ai/delivery-id': '__AGENTS_DELIVERY_ID__',
          },
        },
        spec: { idempotencyKey: '__AGENTS_DELIVERY_ID__' },
      }),
    )
    const labels = manifest.metadata as { labels: Record<string, string> }
    expect(labels.labels['agents.proompteng.ai/delivery-id']).not.toContain('__AGENTS')
    expect((manifest.spec as { idempotencyKey: string }).idempotencyKey).not.toContain('__AGENTS')
  })
})
