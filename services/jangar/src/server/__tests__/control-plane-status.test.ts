import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildControlPlaneStatus } from '~/server/control-plane-status'
import type { ControlPlaneWatchReliability, WorkflowsReliabilityStatus } from '~/data/agents-control-plane'

const kubeClientMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

vi.mock('~/server/primitives-kube', async () => {
  const actual = await vi.importActual<typeof import('~/server/primitives-kube')>('~/server/primitives-kube')
  return {
    ...actual,
    createKubernetesClient: kubeClientMocks.createKubernetesClient,
  }
})

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-01-20T00:00:00Z',
}

const buildWorkflowsReliabilityStatus = (
  overrides: Partial<WorkflowsReliabilityStatus> = {},
): WorkflowsReliabilityStatus => ({
  status: 'healthy',
  message: '',
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 15,
  top_failure_reasons: [],
  ...overrides,
})

const buildDatabaseMigrationConsistency = () => ({
  status: 'healthy' as const,
  migration_table: null,
  registered_count: 0,
  applied_count: 0,
  unapplied_count: 0,
  unexpected_count: 0,
  latest_registered: null,
  latest_applied: null,
  missing_migrations: [],
  unexpected_migrations: [],
  message: '',
})
const watchReliabilityHealthy: ControlPlaneWatchReliability = {
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 14,
  total_errors: 0,
  total_restarts: 0,
  streams: [
    {
      resource: 'agents',
      namespace: 'agents',
      events: 10,
      errors: 0,
      restarts: 0,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
    {
      resource: 'agentruns',
      namespace: 'agents',
      events: 4,
      errors: 0,
      restarts: 0,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
  ],
}

const watchReliabilityDegraded: ControlPlaneWatchReliability = {
  status: 'degraded',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 3,
  total_errors: 2,
  total_restarts: 1,
  streams: [
    {
      resource: 'agents',
      namespace: 'agents',
      events: 2,
      errors: 1,
      restarts: 1,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
    {
      resource: 'jobs',
      namespace: 'agents',
      events: 1,
      errors: 1,
      restarts: 0,
      last_seen_at: '2026-01-20T00:00:00Z',
    },
  ],
}

const scheduleMetadataLabels = {
  'swarm.proompteng.ai/name': 'jangar-control-plane',
}

const buildRolloutSchedule = ({
  name,
  stage,
  phase = 'Active',
  namespace = 'agents',
  lastRunAt = '2026-01-20T00:15:00Z',
  lastSuccessfulRunAt,
  labels = {},
  reason,
}: {
  name: string
  stage: string
  phase?: string
  namespace?: string
  lastRunAt?: string
  lastSuccessfulRunAt?: string | null
  labels?: Record<string, string>
  reason?: string
}) => ({
  apiVersion: 'schedules.proompteng.ai/v1alpha1',
  kind: 'Schedule',
  metadata: {
    name,
    namespace,
    labels: {
      ...scheduleMetadataLabels,
      'swarm.proompteng.ai/stage': stage,
      ...labels,
    },
  },
  status: {
    phase,
    lastRunTime: lastRunAt,
    ...(lastSuccessfulRunAt === undefined ? {} : { lastSuccessfulRunAt: lastSuccessfulRunAt }),
    ...(reason == null
      ? {}
      : { conditions: [{ type: 'Ready', status: 'False', reason, lastTransitionTime: lastRunAt }] }),
  },
})

const buildRolloutCronJob = ({
  scheduleName,
  namespace = 'agents',
  suspended = false,
  lastScheduleTime,
  lastSuccessfulTime,
}: {
  scheduleName: string
  namespace?: string
  suspended?: boolean
  lastScheduleTime?: string
  lastSuccessfulTime?: string
}) => ({
  apiVersion: 'batch/v1',
  kind: 'CronJob',
  metadata: {
    name: `${scheduleName}-cron`,
    namespace,
    labels: {
      'schedules.proompteng.ai/schedule': scheduleName,
    },
  },
  spec: { suspend: suspended },
  status: {
    ...(lastScheduleTime == null ? {} : { lastScheduleTime }),
    ...(lastSuccessfulTime == null ? {} : { lastSuccessfulTime }),
  },
})

describe('control-plane status', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD
    delete process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD
    delete process.env.JANGAR_WORKFLOWS_WINDOW_MINUTES
    delete process.env.JANGAR_WORKFLOWS_SWARMS
    delete process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_WINDOW_MINUTES
    delete process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITORS
    delete process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_SWARMS
    delete process.env.JANGAR_CONTROL_PLANE_WORKFLOW_SWARMS
  })

  it('returns healthy summary when components are healthy', async () => {
    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:00:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: '',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 4,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.service).toBe('jangar')
    expect(status.controllers).toHaveLength(3)
    expect(status.runtime_adapters).toHaveLength(4)
    expect(status.workflows).toEqual({
      status: 'healthy',
      message: '',
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 15,
      top_failure_reasons: [],
    })
    expect(status.namespaces).toHaveLength(1)
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
    expect(status.watch_reliability).toEqual(watchReliabilityHealthy)
    expect(status.watch_reliability.streams).toHaveLength(2)
  })

  it('marks degraded components when controllers or database fail', async () => {
    const degradedController = {
      enabled: true,
      started: false,
      namespaces: ['agents'],
      crdsReady: false,
      missingCrds: ['agents.agents.proompteng.ai'],
      lastCheckedAt: '2026-01-20T00:00:00Z',
    }

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: false,
          address: '',
          status: 'disabled',
          message: 'gRPC disabled',
        },
      },
      {
        now: () => new Date('2026-01-20T00:00:00Z'),
        getAgentsControllerHealth: () => degradedController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: false,
          status: 'degraded',
          message: 'missing config',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: false,
          connected: false,
          status: 'disabled',
          message: 'DATABASE_URL not set',
          latency_ms: 0,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
        getWatchReliabilitySummary: () => watchReliabilityDegraded,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    const degraded = status.namespaces[0]?.degraded_components ?? []
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(degraded).toContain('agents-controller')
    expect(degraded).toContain('runtime:temporal')
    expect(degraded).toContain('database')
    expect(degraded).toContain('watch_reliability')
    expect(degraded).not.toContain('grpc')
    expect(status.watch_reliability.status).toBe('degraded')
    expect(status.watch_reliability.total_errors).toBe(2)
  })

  it('marks workflows as degraded when backoff count crosses warning threshold', async () => {
    process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD = '2'
    process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD = '3'

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:20:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: 'temporal configuration resolved',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 1,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
        getWorkflowsReliabilityStatus: async () =>
          buildWorkflowsReliabilityStatus({
            active_job_runs: 2,
            recent_failed_jobs: 4,
            backoff_limit_exceeded_jobs: 2,
            top_failure_reasons: ['BackoffLimitExceeded', 'DeadlineExceeded'],
          }),
      },
    )

    expect(status.workflows.active_job_runs).toBe(2)
    expect(status.workflows.recent_failed_jobs).toBe(4)
    expect(status.workflows.backoff_limit_exceeded_jobs).toBe(2)
    expect(status.workflows.status).toBe('degraded')
    expect(status.workflows.message).toContain('backoff-limited jobs')
    expect(status.workflows.top_failure_reasons).toEqual(['BackoffLimitExceeded', 'DeadlineExceeded'])
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('workflows')
    expect(status.namespaces[0]?.degraded_components ?? []).not.toContain('runtime:workflows')
  })

  it('builds healthy rollout summary from schedule and cronjob status', async () => {
    kubeClientMocks.createKubernetesClient.mockReturnValue({
      list: vi.fn(async (resource: string) => {
        if (resource === 'schedules.schedules.proompteng.ai') {
          return {
            items: [
              buildRolloutSchedule({
                name: 'jangar-control-plane-discover-sched',
                stage: 'discover',
                lastRunAt: '2026-01-20T00:15:00Z',
              }),
              buildRolloutSchedule({
                name: 'jangar-control-plane-implement-sched',
                stage: 'implement',
                lastRunAt: '2026-01-20T00:12:00Z',
              }),
            ],
          }
        }
        if (resource === 'cronjob') {
          return {
            items: [
              buildRolloutCronJob({
                scheduleName: 'jangar-control-plane-discover-sched',
                lastScheduleTime: '2026-01-20T00:16:00Z',
                lastSuccessfulTime: '2026-01-20T00:16:00Z',
              }),
              buildRolloutCronJob({
                scheduleName: 'jangar-control-plane-implement-sched',
                lastScheduleTime: '2026-01-20T00:13:00Z',
                lastSuccessfulTime: '2026-01-20T00:13:00Z',
              }),
            ],
          }
        }
        return { items: [] }
      }),
    })

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:20:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: 'temporal configuration resolved',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 1,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.rollout.status).toBe('healthy')
    expect(status.rollout.observed_schedules).toBe(2)
    expect(status.rollout.inactive_schedules).toBe(0)
    expect(status.rollout.stale_schedules).toBe(0)
    expect(status.namespaces[0]?.degraded_components ?? []).not.toContain('rollout')
  })

  it('marks rollout as degraded when schedules are stale or missing cronjobs', async () => {
    process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_WINDOW_MINUTES = '10'
    kubeClientMocks.createKubernetesClient.mockReturnValue({
      list: vi.fn(async (resource: string) => {
        if (resource === 'schedules.schedules.proompteng.ai') {
          return {
            items: [
              buildRolloutSchedule({
                name: 'jangar-control-plane-discover-sched',
                stage: 'discover',
                lastRunAt: '2026-01-20T00:20:00Z',
              }),
              buildRolloutSchedule({
                name: 'jangar-control-plane-implement-sched',
                stage: 'implement',
                lastRunAt: '2026-01-20T00:05:00Z',
              }),
            ],
          }
        }
        if (resource === 'cronjob') {
          return {
            items: [
              buildRolloutCronJob({
                scheduleName: 'jangar-control-plane-implement-sched',
                lastScheduleTime: '2026-01-20T00:12:00Z',
                lastSuccessfulTime: '2026-01-20T00:12:00Z',
              }),
            ],
          }
        }
        return { items: [] }
      }),
    })

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:30:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: 'temporal configuration resolved',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 1,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.rollout.status).toBe('degraded')
    expect(status.rollout.inactive_schedules).toBe(1)
    expect(status.rollout.stale_schedules).toBe(1)
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('rollout')
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.rollout.stages).toHaveLength(2)
    expect(status.rollout.stages.find((stage) => stage.name === 'jangar-control-plane-discover-sched')?.is_active).toBe(
      false,
    )
    expect(status.rollout.stages.find((stage) => stage.name === 'jangar-control-plane-implement-sched')?.is_stale).toBe(
      true,
    )
  })

  it('keeps control-plane status healthy when workflow list lookup fails', async () => {
    kubeClientMocks.createKubernetesClient.mockReturnValue({
      list: vi.fn(async () => {
        throw new Error('simulated kubernetes failure')
      }),
    })

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:00:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: 'temporal configuration resolved',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 1,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
      },
    )

    expect(status.workflows).toEqual({
      status: 'unknown',
      message: 'kubernetes query failed for one or more workflow namespaces',
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 15,
      top_failure_reasons: [],
    })
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
  })

  it('keeps control-plane status healthy when kubernetes client creation fails', async () => {
    kubeClientMocks.createKubernetesClient.mockImplementation(() => {
      throw new Error('simulated kube client creation failure')
    })

    const status = await buildControlPlaneStatus(
      {
        namespace: 'agents',
        grpc: {
          enabled: true,
          address: '127.0.0.1:50051',
          status: 'healthy',
          message: '',
        },
      },
      {
        now: () => new Date('2026-01-20T00:00:00Z'),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => ({
          name: 'temporal',
          available: true,
          status: 'configured',
          message: 'temporal configuration resolved',
          endpoint: 'temporal:7233',
        }),
        checkDatabase: async () => ({
          configured: true,
          connected: true,
          status: 'healthy',
          message: '',
          latency_ms: 1,
          migration_consistency: buildDatabaseMigrationConsistency(),
        }),
      },
    )

    expect(status.workflows).toEqual({
      status: 'unknown',
      message: 'kubernetes query failed: simulated kube client creation failure',
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 15,
      top_failure_reasons: [],
    })
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
  })
})
