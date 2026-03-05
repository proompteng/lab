import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildControlPlaneStatus,
  type DatabaseStatus as ControlPlaneDatabaseStatus,
} from '~/server/control-plane-status'
import type {
  ControlPlaneWatchReliability,
  DatabaseMigrationConsistency,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { getRegisteredMigrationNames } from '~/server/kysely-migrations'

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

const setRolloutDeploymentList = (items: unknown[] = []) => {
  kubeClientMocks.createKubernetesClient.mockReturnValue({
    list: vi.fn(async () => ({ items })),
  })
}

const healthyRolloutDeployment = {
  metadata: { name: 'agents' },
  spec: { replicas: 1 },
  status: {
    readyReplicas: 1,
    availableReplicas: 1,
    updatedReplicas: 1,
    unavailableReplicas: 0,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True' },
    ],
  },
}

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
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 15,
  top_failure_reasons: [],
  ...overrides,
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

const registeredMigrations = getRegisteredMigrationNames()
const latestMigration = registeredMigrations.at(-1) ?? null

const healthyMigrationConsistency: DatabaseMigrationConsistency = {
  status: 'healthy',
  migration_table: 'kysely_migration',
  registered_count: registeredMigrations.length,
  applied_count: registeredMigrations.length,
  unapplied_count: 0,
  unexpected_count: 0,
  latest_registered: latestMigration,
  latest_applied: latestMigration,
  missing_migrations: [],
  unexpected_migrations: [],
  message: '',
}

const buildDatabaseStatus = (
  overrides: Partial<ControlPlaneDatabaseStatus> = {},
  migrationOverrides: Partial<DatabaseMigrationConsistency> = {},
): ControlPlaneDatabaseStatus => {
  const { migration_consistency: explicitMigrationConsistency, ...databaseOverrides } = overrides
  return {
    configured: true,
    connected: true,
    status: 'healthy',
    message: '',
    latency_ms: 1,
    migration_consistency: {
      ...healthyMigrationConsistency,
      ...migrationOverrides,
      ...explicitMigrationConsistency,
    },
    ...databaseOverrides,
  }
}

describe('control-plane status', () => {
  afterEach(() => {
    kubeClientMocks.createKubernetesClient.mockReset()
    vi.clearAllMocks()
    delete process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD
    delete process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD
    delete process.env.JANGAR_WORKFLOWS_WINDOW_MINUTES
    delete process.env.JANGAR_WORKFLOWS_SWARMS
  })

  it('returns healthy summary when components are healthy', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment])
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
          ...buildDatabaseStatus(),
          latency_ms: 4,
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.service).toBe('jangar')
    expect(status.controllers).toHaveLength(3)
    expect(status.runtime_adapters).toHaveLength(4)
    expect(status.workflows).toEqual({
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
    expect(status.rollout_health.status).toBe('healthy')
    expect(status.rollout_health.observed_deployments).toBe(1)
    expect(status.rollout_health.degraded_deployments).toBe(0)
    expect(status.database.migration_consistency).toEqual(healthyMigrationConsistency)
  })

  it('marks degraded components when controllers or database fail', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment])
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
          ...buildDatabaseStatus({
            configured: false,
            connected: false,
            status: 'disabled',
            message: 'DATABASE_URL not set',
            latency_ms: 0,
          }),
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
    setRolloutDeploymentList([healthyRolloutDeployment])

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
          ...buildDatabaseStatus({
            latency_ms: 1,
          }),
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
    expect(status.workflows.top_failure_reasons).toEqual(['BackoffLimitExceeded', 'DeadlineExceeded'])
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('workflows')
    expect(status.namespaces[0]?.degraded_components ?? []).not.toContain('runtime:workflows')
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
          ...buildDatabaseStatus({
            latency_ms: 1,
          }),
        }),
      },
    )

    expect(status.workflows).toEqual({
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 15,
      top_failure_reasons: [],
    })
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
  })

  it('marks namespace degraded when migration consistency reports drift', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment])

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
        checkDatabase: async () =>
          buildDatabaseStatus(
            {
              status: 'degraded',
              message: 'migration drift detected',
            },
            {
              status: 'degraded',
              unapplied_count: 1,
              unexpected_count: 0,
              missing_migrations: ['20260305_future_migration'],
              unexpected_migrations: [],
              message: 'migration drift detected',
            },
          ),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.database.migration_consistency.status).toBe('degraded')
    expect(status.database.migration_consistency.unapplied_count).toBe(1)
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('database')
    expect(status.namespaces[0]?.status).toBe('degraded')
  })
})
