import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '~/server/primitives-kube'
import { __test } from '~/server/supporting-primitives-controller'

const createKubeMock = (): KubernetesClient => ({
  apply: vi.fn(async (resource) => resource),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  listEvents: vi.fn(async () => ({ items: [] })),
})

describe('supporting primitives controller schedules', () => {
  it('triggers an AgentRun for due schedules', async () => {
    const kube = createKubeMock()
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: { name: 'demo-schedule', namespace: 'jangar', uid: 'schedule-uid', generation: 1 },
      spec: {
        cron: '* * * * *',
        timezone: 'UTC',
        targetRef: { kind: 'Agent', name: 'demo-agent' },
        parameters: { stage: 'nightly' },
      },
      status: { lastTriggeredAt: '2026-01-20T11:59:00.000Z' },
    }

    const now = new Date('2026-01-20T12:00:00.000Z')
    await __test.reconcileSchedule(kube, schedule, 'jangar', now)

    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'AgentRun',
        metadata: expect.objectContaining({
          namespace: 'jangar',
          labels: expect.objectContaining({
            [__test.SCHEDULE_LABELS.scheduleName]: 'demo-schedule',
            [__test.SCHEDULE_LABELS.scheduleUid]: 'schedule-uid',
          }),
        }),
        spec: expect.objectContaining({ agentRef: { name: 'demo-agent' } }),
      }),
    )
  })

  it('triggers an OrchestrationRun for due schedules', async () => {
    const kube = createKubeMock()
    const schedule = {
      apiVersion: 'schedules.proompteng.ai/v1alpha1',
      kind: 'Schedule',
      metadata: { name: 'orch-schedule', namespace: 'jangar', uid: 'schedule-uid-2', generation: 1 },
      spec: {
        cron: '* * * * *',
        timezone: 'UTC',
        targetRef: { kind: 'Orchestration', name: 'demo-orchestration' },
        parameters: { stage: 'nightly' },
      },
      status: { lastTriggeredAt: '2026-01-20T11:59:00.000Z' },
    }

    const now = new Date('2026-01-20T12:00:00.000Z')
    await __test.reconcileSchedule(kube, schedule, 'jangar', now)

    expect(kube.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'OrchestrationRun',
        metadata: expect.objectContaining({
          namespace: 'jangar',
          labels: expect.objectContaining({
            [__test.SCHEDULE_LABELS.scheduleName]: 'orch-schedule',
            [__test.SCHEDULE_LABELS.scheduleUid]: 'schedule-uid-2',
          }),
        }),
        spec: expect.objectContaining({ orchestrationRef: { name: 'demo-orchestration' } }),
      }),
    )
  })
})
