import { describe, expect, it } from 'vitest'

import { buildControlPlaneStatus } from '~/server/control-plane-status'

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-01-20T00:00:00Z',
}
const now = () => new Date('2026-01-20T00:00:00Z')

const makeMigrationConsistency = (overrides: Record<string, unknown> = {}) => ({
  status: 'healthy' as const,
  migration_table: 'kysely_migration',
  registered_count: 18,
  applied_count: 18,
  unapplied_count: 0,
  unexpected_count: 0,
  latest_registered: '20260304_jangar_github_worktree_refresh_state',
  latest_applied: '20260304_jangar_github_worktree_refresh_state',
  missing_migrations: [] as string[],
  unexpected_migrations: [] as string[],
  message: 'migration registry and database are synchronized',
  ...overrides,
})

const createKubeMap = (resources: {
  jobs?: unknown[]
  deployments?: unknown[]
  schedules?: unknown[]
  cronjobs?: unknown[]
}) => ({
  list: async (resource?: string) =>
    ({
      items:
        resource === 'deployments'
          ? (resources.deployments ?? [])
          : resource === 'jobs'
            ? (resources.jobs ?? [])
            : resource === 'schedules.schedules.proompteng.ai'
              ? (resources.schedules ?? [])
              : resource === 'cronjob'
                ? (resources.cronjobs ?? [])
                : [],
    }) as Record<string, unknown>,
})

const createKubeList = (
  jobs: unknown[] = [],
  schedules: unknown[] = [],
  cronjobs: unknown[] = [],
  deployments: unknown[] = [],
) => createKubeMap({ jobs, schedules, cronjobs, deployments })

type DeploymentFixtureOverrides = {
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

const createDeployment = (overrides: DeploymentFixtureOverrides = {}) => ({
  metadata: {
    name: 'agents',
    generation: 3,
    ...(overrides.metadata ?? {}),
  },
  spec: { replicas: 1, ...(overrides.spec ?? {}) },
  status: {
    readyReplicas: 1,
    availableReplicas: 1,
    updatedReplicas: 1,
    unavailableReplicas: 0,
    observedGeneration: 3,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True' },
    ],
    ...(overrides.status ?? {}),
  },
  ...overrides,
})

const failingKubeList = {
  list: async (_: string) => {
    throw new Error('kube unavailable')
  },
}

const createActiveJob = () => ({
  metadata: {
    name: 'jangar-control-plane-implement-sched-abc-step-1-attempt-1',
    creationTimestamp: now().toISOString(),
  },
  status: {
    active: 1,
  },
})

const createDeploymentWith = (name: string, overrides: DeploymentFixtureOverrides = {}) =>
  createDeployment({
    ...overrides,
    metadata: {
      ...overrides.metadata,
      name,
    },
  })

const createBackoffJob = (name: string, reason: string, at: string) => ({
  metadata: { name, creationTimestamp: at },
  status: {
    failed: 1,
    conditions: [
      {
        type: 'Failed',
        status: 'True',
        reason,
        lastTransitionTime: at,
      },
    ],
  },
})

const createRolloutSchedule = (
  name: string,
  phase: string,
  lastRunTime: string,
  swarm = 'jangar-control-plane',
  stage = 'implement',
) => ({
  metadata: {
    name,
    namespace: 'agents',
    labels: {
      'swarm.proompteng.ai/name': swarm,
      'swarm.proompteng.ai/stage': stage,
    },
  },
  status: {
    phase,
    lastRunTime,
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        lastTransitionTime: lastRunTime,
      },
    ],
  },
})

const createRolloutCron = (scheduleName: string, lastScheduleTime: string, lastSuccessfulTime: string) => ({
  metadata: {
    labels: {
      'schedules.proompteng.ai/schedule': scheduleName,
    },
  },
  status: {
    lastScheduleTime,
    lastSuccessfulTime,
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        lastTransitionTime: lastSuccessfulTime,
      },
    ],
  },
})

const healthyRolloutKubeState = {
  schedules: [createRolloutSchedule('jangar-control-plane-implement-sched', 'Active', '2026-01-20T00:00:00Z')],
  cronjobs: [createRolloutCron('jangar-control-plane-implement-sched', '2026-01-20T00:00:00Z', '2026-01-20T00:00:00Z')],
}

const watchReliabilityHealthy = {
  status: 'healthy' as const,
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

const watchReliabilityDegraded = {
  status: 'degraded' as const,
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

describe('control-plane status', () => {
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
        now,
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        kube: createKubeMap({
          jobs: [createActiveJob()],
          deployments: [createDeploymentWith('agents')],
          schedules: healthyRolloutKubeState.schedules,
          cronjobs: healthyRolloutKubeState.cronjobs,
        }),
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
          migration_consistency: makeMigrationConsistency(),
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
      },
    )

    expect(status.service).toBe('jangar')
    expect(status.controllers).toHaveLength(3)
    expect(status.runtime_adapters).toHaveLength(4)
    expect(status.namespaces).toHaveLength(1)
    expect(status.workflows).toBeDefined()
    expect(status.workflows.status).toBe('healthy')
    expect(status.workflows.active_job_runs).toBe(1)
    expect(status.rollout.status).toBe('healthy')
    expect(status.rollout.observed_schedules).toBe(1)
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components).toHaveLength(0)
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
        now,
        getAgentsControllerHealth: () => degradedController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        kube: createKubeMap({
          jobs: [createActiveJob()],
          deployments: [createDeploymentWith('agents')],
          schedules: healthyRolloutKubeState.schedules,
          cronjobs: healthyRolloutKubeState.cronjobs,
        }),
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
          migration_consistency: makeMigrationConsistency({
            status: 'degraded',
            migration_table: null,
            registered_count: 0,
            applied_count: 0,
            unapplied_count: 0,
            unexpected_count: 0,
            latest_registered: null,
            latest_applied: null,
            message: 'DATABASE_URL not set',
          }),
        }),
        getWatchReliabilitySummary: () => watchReliabilityDegraded,
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

  it('flags workflows as degraded when backoff limit failures exceed threshold', async () => {
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
        now,
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
          migration_consistency: makeMigrationConsistency(),
        }),
        kube: createKubeMap({
          jobs: [
            createBackoffJob(
              'jangar-control-plane-implement-sched-abc-step-1-attempt-1',
              'BackoffLimitExceeded',
              '2026-01-20T00:00:10Z',
            ),
            createBackoffJob(
              'torghut-quant-implement-sched-xyz-step-1-attempt-2',
              'BackoffLimitExceeded',
              '2026-01-20T00:00:20Z',
            ),
          ],
          schedules: healthyRolloutKubeState.schedules,
          cronjobs: healthyRolloutKubeState.cronjobs,
          deployments: [createDeploymentWith('agents')],
        }),
      },
    )

    expect(status.workflows.status).toBe('degraded')
    expect(status.workflows.backoff_limit_exceeded_jobs).toBe(2)
    expect(status.namespaces[0]?.degraded_components).toContain('workflows')
    expect(status.rollout.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components).not.toContain('rollout')
  })

  it('reports reliability surfaces as unknown when kube listing fails', async () => {
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
        now,
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
          migration_consistency: makeMigrationConsistency(),
        }),
        kube: failingKubeList,
      },
    )

    expect(status.workflows.status).toBe('unknown')
    expect(status.rollout.status).toBe('unknown')
    expect(status.workflows.message).toContain('kubernetes query failed')
    expect(status.namespaces[0]?.degraded_components).not.toContain('workflows')
    expect(status.namespaces[0]?.degraded_components).not.toContain('rollout')
    expect(status.rollout_health.status).toBe('unknown')
    expect(status.namespaces[0]?.degraded_components).not.toContain('rollout_health')
  })

  it('reports rollout health from deployment status', async () => {
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
        now,
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
          migration_consistency: makeMigrationConsistency(),
        }),
        kube: createKubeMap({
          jobs: [createActiveJob()],
          schedules: healthyRolloutKubeState.schedules,
          cronjobs: healthyRolloutKubeState.cronjobs,
          deployments: [createDeploymentWith('agents')],
        }),
      },
    )

    expect(status.rollout_health.status).toBe('healthy')
    expect(status.rollout_health.observed_deployments).toBe(1)
    expect(status.rollout_health.degraded_deployments).toBe(0)
    expect(status.namespaces[0]?.degraded_components).not.toContain('rollout_health')
  })

  it('marks rollout component degraded when deployment is unavailable', async () => {
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
        now,
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
          migration_consistency: makeMigrationConsistency(),
        }),
        kube: createKubeMap({
          jobs: [createActiveJob()],
          deployments: [
            createDeployment({
              metadata: { name: 'agents' },
              spec: { replicas: 1 },
              status: {
                readyReplicas: 0,
                availableReplicas: 0,
                updatedReplicas: 0,
                unavailableReplicas: 1,
                observedGeneration: 2,
                conditions: [
                  { type: 'Available', status: 'False' },
                  { type: 'Progressing', status: 'True' },
                ],
              },
            }),
          ],
        }),
      },
    )

    expect(status.rollout_health.status).toBe('degraded')
    expect(status.rollout_health.degraded_deployments).toBe(1)
    expect(status.namespaces[0]?.degraded_components).toContain('rollout_health')
  })

  it('marks database component as degraded when migration drift is detected', async () => {
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
        now,
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
          status: 'degraded',
          message: '2 registered migrations not applied',
          latency_ms: 4,
          migration_consistency: makeMigrationConsistency({
            status: 'degraded',
            message: '2 registered migrations not applied',
            unapplied_count: 2,
            missing_migrations: ['20260305_new_migration', '20260306_followup_migration'],
            unexpected_count: 0,
            unexpected_migrations: [],
          }),
        }),
        kube: createKubeMap({
          jobs: [createActiveJob()],
          deployments: [createDeploymentWith('agents')],
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
      },
    )

    expect(status.namespaces[0]?.degraded_components).toContain('database')
    expect(status.database.status).toBe('degraded')
    expect(status.database.migration_consistency.unapplied_count).toBe(2)
  })

  it('marks rollout as degraded when schedule health is stale', async () => {
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
        now,
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
          migration_consistency: makeMigrationConsistency(),
        }),
        kube: createKubeList(
          [createActiveJob()],
          [createRolloutSchedule('jangar-control-plane-implement-sched', 'Active', '2026-01-19T20:00:00Z')],
          [createRolloutCron('jangar-control-plane-implement-sched', '2026-01-19T20:00:00Z', '2026-01-19T20:00:00Z')],
          [createDeploymentWith('agents')],
        ),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
      },
    )

    expect(status.rollout.status).toBe('degraded')
    expect(status.rollout.stale_schedules).toBe(1)
    expect(status.namespaces[0]?.degraded_components).toContain('rollout')
  })

  it('surfaces failed-run and backoff metrics for rollout schedules', async () => {
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
        now,
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
          migration_consistency: makeMigrationConsistency(),
        }),
        kube: createKubeList(
          [
            createBackoffJob(
              'jangar-control-plane-implement-sched-step-1-attempt-1',
              'BackoffLimitExceeded',
              now().toISOString(),
            ),
            createBackoffJob(
              'jangar-control-plane-implement-sched-step-1-attempt-2',
              'ImagePullBackOff',
              now().toISOString(),
            ),
          ],
          [createRolloutSchedule('jangar-control-plane-implement-sched', 'Active', now().toISOString())],
          [createRolloutCron('jangar-control-plane-implement-sched', now().toISOString(), now().toISOString())],
          [createDeploymentWith('agents')],
        ),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
      },
    )

    expect(status.rollout.status).toBe('healthy')
    const rolloutStage = status.rollout.stages.find((item) => item.name === 'jangar-control-plane-implement-sched')
    expect(rolloutStage).toBeDefined()
    expect(rolloutStage?.failed_runs_last_window).toBe(2)
    expect(rolloutStage?.backoff_failures_last_window).toBe(1)
    expect(rolloutStage?.top_failure_reasons).toEqual([
      { reason: 'BackoffLimitExceeded', count: 1 },
      { reason: 'ImagePullBackOff', count: 1 },
    ])
  })
})
