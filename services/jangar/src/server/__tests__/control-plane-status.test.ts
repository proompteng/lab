import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildControlPlaneStatus,
  type DatabaseStatus as ControlPlaneDatabaseStatus,
} from '~/server/control-plane-status'
import type {
  ControlPlaneHeartbeatRow,
  ControlPlaneHeartbeatStoreGetInput,
} from '~/server/control-plane-heartbeat-store'
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

const healthyAgentsControllersRolloutDeployment = {
  metadata: { name: 'agents-controllers' },
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
  agentRunIngestion: [
    {
      namespace: 'agents',
      lastWatchEventAt: '2026-01-20T00:00:00Z',
      lastResyncAt: '2026-01-20T00:00:00Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
    },
  ],
}

type HeartbeatComponent =
  | 'agents-controller'
  | 'supporting-controller'
  | 'orchestration-controller'
  | 'workflow-runtime'

const buildHeartbeatRows = (
  overrides: Partial<Record<HeartbeatComponent, Partial<ControlPlaneHeartbeatRow>>> = {},
): ControlPlaneHeartbeatRow[] =>
  (
    [
      'agents-controller',
      'supporting-controller',
      'orchestration-controller',
      'workflow-runtime',
    ] as const satisfies HeartbeatComponent[]
  ).map((component) => {
    const override = overrides[component] ?? {}
    return {
      namespace: 'agents',
      component,
      workload_role: 'controllers',
      pod_name: 'agents-controllers-0',
      deployment_name: 'agents-controllers',
      enabled: true,
      status: 'healthy',
      message: '',
      leadership_state: 'leader',
      observed_at: '2026-01-20T00:00:00Z',
      expires_at: '2026-01-21T00:00:00Z',
      ...override,
    }
  })

const createHeartbeatResolver =
  (rows: ControlPlaneHeartbeatRow[] = buildHeartbeatRows()) =>
  async (input: ControlPlaneHeartbeatStoreGetInput) =>
    rows.find(
      (row) =>
        row.namespace === input.namespace &&
        row.component === input.component &&
        (input.workloadRole == null || row.workload_role === input.workloadRole),
    ) ?? null

const buildTemporalAdapter = (
  overrides: Partial<{
    available: boolean
    status: 'healthy' | 'configured' | 'degraded' | 'disabled' | 'unknown'
    message: string
    endpoint: string
  }> = {},
) => ({
  name: 'temporal' as const,
  available: true,
  status: 'configured' as const,
  message: '',
  endpoint: 'temporal:7233',
  authority: {
    mode: 'local' as const,
    namespace: 'agents',
    source_deployment: '',
    source_pod: '',
    observed_at: '2026-01-20T00:00:00Z',
    fresh: true,
    message: 'using local controller state',
  },
  ...overrides,
})

const buildWorkflowsReliabilityStatus = (
  overrides: Partial<WorkflowsReliabilityStatus> = {},
): WorkflowsReliabilityStatus => ({
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: 15,
  top_failure_reasons: [],
  data_confidence: 'high',
  collection_errors: 0,
  collected_namespaces: 1,
  target_namespaces: 1,
  message: '',
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
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => ({
          ...buildDatabaseStatus(),
          latency_ms: 4,
        }),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'healthy',
            endpoint: 'http://torghut-forecast/readyz',
            message: 'forecast service ready',
            authoritative: true,
            calibration_status: 'ready',
            eligible_models: ['chronos'],
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut-lean-runner/readyz',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest', 'shadow_replay'],
          },
          jobs: {
            status: 'healthy',
            endpoint: 'http://torghut/trading/empirical-jobs',
            message: 'empirical jobs fresh',
            authoritative: true,
            eligible_jobs: ['benchmark_parity', 'foundation_router_parity', 'janus_event_car', 'janus_hgrm_reward'],
            stale_jobs: [],
          },
        }),
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
      data_confidence: 'high',
      collection_errors: 0,
      collected_namespaces: 1,
      target_namespaces: 1,
      message: '',
    })
    expect(status.dependency_quorum).toEqual({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
    expect(status.namespaces).toHaveLength(1)
    expect(status.namespaces[0]?.status).toBe('healthy')
    expect(status.namespaces[0]?.degraded_components ?? []).toHaveLength(0)
    expect(status.watch_reliability).toEqual(watchReliabilityHealthy)
    expect(status.watch_reliability.streams).toHaveLength(2)
    expect(status.agentrun_ingestion).toEqual({
      namespace: 'agents',
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      last_watch_event_at: '2026-01-20T00:00:00Z',
      last_resync_at: '2026-01-20T00:00:00Z',
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    })
    expect(status.rollout_health.status).toBe('healthy')
    expect(status.rollout_health.observed_deployments).toBe(2)
    expect(status.rollout_health.degraded_deployments).toBe(0)
    expect(status.database.migration_consistency).toEqual(healthyMigrationConsistency)
    expect(status.empirical_services.forecast.authoritative).toBe(true)
    expect(status.empirical_services.lean.authoritative).toBe(true)
    expect(status.empirical_services.jobs.authoritative).toBe(true)
  })

  it('marks degraded components when controllers or database fail', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])
    const degradedController = {
      enabled: true,
      started: false,
      namespaces: ['agents'],
      crdsReady: false,
      missingCrds: ['agents.agents.proompteng.ai'],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [
        {
          namespace: 'agents',
          lastWatchEventAt: '2026-01-20T00:00:00Z',
          lastResyncAt: '2026-01-20T00:00:00Z',
          untouchedRunCount: 3,
          oldestUntouchedAgeSeconds: 180,
        },
      ],
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
        getHeartbeat: createHeartbeatResolver(
          buildHeartbeatRows({
            'agents-controller': {
              status: 'degraded',
              message: 'agents controller not started',
            },
            'workflow-runtime': {
              status: 'degraded',
              message: 'workflow runtime not started',
            },
          }),
        ),
        getAgentsControllerHealth: () => degradedController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            available: false,
            status: 'degraded',
            message: 'missing config',
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
        resolveEmpiricalServices: async () => ({
          forecast: {
            status: 'degraded',
            endpoint: 'http://torghut-forecast/readyz',
            message: 'forecast service readiness failed',
            authoritative: false,
          },
          lean: {
            status: 'healthy',
            endpoint: 'http://torghut-lean-runner/readyz',
            message: 'LEAN runner ready',
            authoritative: true,
            authoritative_modes: ['research_backtest'],
          },
          jobs: {
            status: 'degraded',
            endpoint: 'http://torghut/trading/empirical-jobs',
            message: 'stale empirical jobs: benchmark_parity',
            authoritative: false,
            eligible_jobs: ['foundation_router_parity'],
            stale_jobs: ['benchmark_parity'],
          },
        }),
      },
    )

    const degraded = status.namespaces[0]?.degraded_components ?? []
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(degraded).toContain('agents-controller')
    expect(degraded).toContain('runtime:temporal')
    expect(degraded).toContain('database')
    expect(degraded).toContain('watch_reliability')
    expect(degraded).toContain('agentrun_ingestion')
    expect(degraded).toContain('empirical:forecast')
    expect(degraded).toContain('empirical:jobs')
    expect(degraded).not.toContain('grpc')
    expect(status.watch_reliability.status).toBe('degraded')
    expect(status.watch_reliability.total_errors).toBe(2)
    expect(status.agentrun_ingestion.status).toBe('degraded')
    expect(status.agentrun_ingestion.untouched_run_count).toBe(3)
    expect(status.agentrun_ingestion.oldest_untouched_age_seconds).toBe(180)
    expect(status.dependency_quorum.reasons).toContain('forecast_service_unhealthy')
    expect(status.empirical_services.jobs.status).toBe('degraded')
  })

  it('marks workflows as degraded when backoff count crosses warning threshold', async () => {
    process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD = '2'
    process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD = '3'
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
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
            top_failure_reasons: [
              { reason: 'BackoffLimitExceeded', count: 3 },
              { reason: 'DeadlineExceeded', count: 1 },
            ],
          }),
      },
    )

    expect(status.workflows.active_job_runs).toBe(2)
    expect(status.workflows.recent_failed_jobs).toBe(4)
    expect(status.workflows.backoff_limit_exceeded_jobs).toBe(2)
    expect(status.workflows.top_failure_reasons).toEqual([
      { reason: 'BackoffLimitExceeded', count: 3 },
      { reason: 'DeadlineExceeded', count: 1 },
    ])
    expect(status.dependency_quorum).toEqual({
      decision: 'delay',
      reasons: ['workflow_backoff_warning'],
      message:
        'Control-plane dependency quorum is degraded; delay capital promotion. recent workflow reasons: BackoffLimitExceeded, DeadlineExceeded',
    })
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('workflows')
    expect(status.namespaces[0]?.degraded_components ?? []).not.toContain('runtime:workflows')
  })

  it('marks workflow confidence unknown when workflow list lookup fails', async () => {
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
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
      data_confidence: 'unknown',
      collection_errors: 1,
      collected_namespaces: 0,
      target_namespaces: 1,
      message:
        'workflow reliability unavailable (1/1 namespace queries failed); sample errors: agents: simulated kubernetes failure',
    })
    expect(status.dependency_quorum).toEqual({
      decision: 'block',
      reasons: ['workflows_data_unknown'],
      message:
        'Control-plane dependency quorum is blocked. workflow reliability unavailable (1/1 namespace queries failed); sample errors: agents: simulated kubernetes failure',
    })
    expect(status.namespaces[0]?.status).toBe('degraded')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('workflows')
    expect(status.namespaces[0]?.degraded_components ?? []).toContain('runtime:workflows')
  })

  it('throws when kubernetes client creation fails', async () => {
    kubeClientMocks.createKubernetesClient.mockImplementation(() => {
      throw new Error('simulated kube client creation failure')
    })
    await expect(
      buildControlPlaneStatus(
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
          getHeartbeat: createHeartbeatResolver(),
          getAgentsControllerHealth: () => healthyController,
          getSupportingControllerHealth: () => healthyController,
          getOrchestrationControllerHealth: () => healthyController,
          resolveTemporalAdapter: async () =>
            buildTemporalAdapter({
              message: 'temporal configuration resolved',
            }),
          checkDatabase: async () => buildDatabaseStatus(),
        },
      ),
    ).rejects.toThrow('simulated kube client creation failure')
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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () =>
          buildTemporalAdapter({
            message: 'temporal configuration resolved',
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

  it('uses authoritative heartbeat rows when the serving pod has controllers disabled locally', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const locallyDisabledController = {
      enabled: false,
      started: false,
      namespaces: ['agents'],
      crdsReady: null,
      missingCrds: [],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [],
    }

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
        getHeartbeat: createHeartbeatResolver(),
        getAgentsControllerHealth: () => locallyDisabledController,
        getSupportingControllerHealth: () => locallyDisabledController,
        getOrchestrationControllerHealth: () => locallyDisabledController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.every((controller) => controller.status === 'healthy')).toBe(true)
    expect(status.controllers.every((controller) => controller.authority.mode === 'heartbeat')).toBe(true)
    expect(status.controllers[0]?.authority.source_deployment).toBe('agents-controllers')
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')?.authority.mode).toBe('heartbeat')
    expect(status.dependency_quorum).toEqual({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
  })

  it('uses healthy agents-controllers rollout when split-topology heartbeats report disabled controllers', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment, healthyAgentsControllersRolloutDeployment])

    const locallyDisabledController = {
      enabled: false,
      started: false,
      namespaces: ['agents'],
      crdsReady: null,
      missingCrds: [],
      lastCheckedAt: '2026-01-20T00:00:00Z',
      agentRunIngestion: [],
    }

    const splitTopologyRows = buildHeartbeatRows({
      'agents-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'agents controller disabled',
      },
      'supporting-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'supporting controller disabled',
      },
      'orchestration-controller': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'orchestration controller disabled',
      },
      'workflow-runtime': {
        pod_name: 'jangar-web-0',
        deployment_name: 'jangar-web',
        enabled: false,
        status: 'disabled',
        message: 'workflow runtime disabled',
      },
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
        getHeartbeat: createHeartbeatResolver(splitTopologyRows),
        getAgentsControllerHealth: () => locallyDisabledController,
        getSupportingControllerHealth: () => locallyDisabledController,
        getOrchestrationControllerHealth: () => locallyDisabledController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.every((controller) => controller.status === 'healthy')).toBe(true)
    expect(status.controllers.every((controller) => controller.authority.mode === 'rollout')).toBe(true)
    expect(status.controllers[0]?.authority.source_deployment).toBe('agents-controllers')
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')).toMatchObject({
      available: true,
      status: 'configured',
      authority: {
        mode: 'rollout',
        source_deployment: 'agents-controllers',
      },
    })
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'job')).toMatchObject({
      available: true,
      status: 'configured',
      authority: {
        mode: 'rollout',
        source_deployment: 'agents-controllers',
      },
    })
    expect(status.dependency_quorum).toEqual({
      decision: 'allow',
      reasons: [],
      message: 'Control-plane admission dependencies are healthy.',
    })
  })

  it('fails closed to unknown authority when a controller heartbeat is missing', async () => {
    setRolloutDeploymentList([healthyRolloutDeployment])

    const rows = buildHeartbeatRows().filter(
      (row) => row.component !== 'agents-controller' && row.component !== 'workflow-runtime',
    )

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
        getHeartbeat: createHeartbeatResolver(rows),
        getAgentsControllerHealth: () => healthyController,
        getSupportingControllerHealth: () => healthyController,
        getOrchestrationControllerHealth: () => healthyController,
        resolveTemporalAdapter: async () => buildTemporalAdapter(),
        checkDatabase: async () => buildDatabaseStatus(),
        getWatchReliabilitySummary: () => watchReliabilityHealthy,
        getWorkflowsReliabilityStatus: async () => buildWorkflowsReliabilityStatus(),
      },
    )

    expect(status.controllers.find((controller) => controller.name === 'agents-controller')).toMatchObject({
      status: 'unknown',
      authority: {
        mode: 'unknown',
      },
    })
    expect(status.runtime_adapters.find((adapter) => adapter.name === 'workflow')).toMatchObject({
      status: 'unknown',
      authority: {
        mode: 'unknown',
      },
    })
    expect(status.dependency_quorum.decision).toBe('block')
    expect(status.dependency_quorum.reasons).toContain('agents_controller_status_unknown')
    expect(status.dependency_quorum.reasons).toContain('workflow_runtime_status_unknown')
    expect(status.dependency_quorum.reasons).not.toContain('agents_controller_unavailable')
  })
})
