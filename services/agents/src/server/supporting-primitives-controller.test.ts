import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from './kube-types'
import { __test__ } from './supporting-primitives-controller'
import { __test__ as scheduleRunnerTest } from './supporting-schedule-runner'

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

  it('renders Schedule resources into ConfigMap and CronJob without Jangar runner paths', async () => {
    const { kube, applied, statuses } = createKubeMock({
      'agentruns.agents.proompteng.ai:agents:template-run': {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'AgentRun',
        metadata: { name: 'template-run', namespace: 'agents' },
        spec: {
          agentRef: { name: 'demo-agent' },
          runtime: { type: 'job' },
          parameters: { prompt: 'ship it' },
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
    expect(JSON.stringify(configMap)).not.toContain('JANGAR')
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
