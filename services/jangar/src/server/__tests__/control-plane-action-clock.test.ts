import { describe, expect, it } from 'vitest'

import { buildReconciledActionClocks } from '~/server/control-plane-action-clock'
import {
  buildFailureDomainLeaseSet,
  emptyFailureDomainKubernetesEvidence,
  type FailureDomainRouteProbe,
} from '~/server/control-plane-failure-domain-leases'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'
import type {
  EmpiricalServicesStatus,
  FailureDomainLeaseSet,
  RuntimeKitStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'

const now = new Date('2026-05-06T13:00:00.000Z')

const database = (overrides: Partial<DatabaseStatus> = {}): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: '',
  latency_ms: 4,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 25,
    applied_count: 25,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260418_embedding_dimension_4096',
    latest_applied: '20260418_embedding_dimension_4096',
    missing_migrations: [],
    unexpected_migrations: [],
    message: '',
  },
  ...overrides,
})

const routeProbe = (overrides: Partial<FailureDomainRouteProbe> = {}): FailureDomainRouteProbe => ({
  status: 'healthy',
  reachable: true,
  url: 'http://jangar.jangar.svc.cluster.local/health',
  status_code: 200,
  latency_ms: 5,
  message: 'route probe succeeded',
  observed_at: now.toISOString(),
  ...overrides,
})

const rolloutHealth = (overrides: Partial<ControlPlaneRolloutHealth> = {}): ControlPlaneRolloutHealth => ({
  status: 'healthy',
  observed_deployments: 1,
  degraded_deployments: 0,
  deployments: [
    {
      name: 'agents-controllers',
      namespace: 'agents',
      status: 'healthy',
      desired_replicas: 2,
      ready_replicas: 2,
      available_replicas: 2,
      updated_replicas: 2,
      unavailable_replicas: 0,
      message: 'deployment rollout healthy',
    },
  ],
  message: '1 configured deployment(s) healthy',
  ...overrides,
})

const workflows = (overrides: Partial<WorkflowsReliabilityStatus> = {}): WorkflowsReliabilityStatus => ({
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

const watchReliability = (overrides: Partial<ControlPlaneWatchReliability> = {}): ControlPlaneWatchReliability => ({
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 8,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
  ...overrides,
})

const empiricalServices = (overrides: Partial<EmpiricalServicesStatus> = {}): EmpiricalServicesStatus => ({
  forecast: {
    status: 'healthy',
    endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
    message: 'forecast ready',
    authoritative: true,
  },
  lean: {
    status: 'healthy',
    endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
    message: 'lean ready',
    authoritative: true,
  },
  jobs: {
    status: 'healthy',
    endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
    message: 'empirical jobs fresh',
    authoritative: true,
    eligible_jobs: ['benchmark_parity'],
    stale_jobs: [],
  },
  ...overrides,
})

const runtimeKit = (overrides: Partial<RuntimeKitStatus> = {}): RuntimeKitStatus => ({
  runtime_kit_id: 'runtime-kit:collaboration:test',
  kit_class: 'collaboration',
  subject_ref: 'jangar:codex:nats-collaboration',
  image_ref: 'runtime:local',
  workspace_contract_version: 'shadow-v1',
  component_digest: 'digest-collaboration',
  decision: 'healthy',
  observed_at: now.toISOString(),
  fresh_until: '2026-05-06T13:05:00.000Z',
  producer_revision: 'shadow-v1',
  reason_codes: [],
  components: [],
  ...overrides,
})

const leaseSet = (overrides: Partial<Parameters<typeof buildFailureDomainLeaseSet>[0]> = {}) =>
  buildFailureDomainLeaseSet({
    now,
    namespace: 'agents',
    service: 'jangar',
    database: database(),
    routeProbe: routeProbe(),
    rolloutHealth: rolloutHealth(),
    workflows: workflows(),
    runtimeKits: [runtimeKit()],
    kubernetesEvidence: emptyFailureDomainKubernetesEvidence(),
    ...overrides,
  })

const withSourceSchemaConflict = (leases: FailureDomainLeaseSet): FailureDomainLeaseSet => ({
  ...leases,
  leases: leases.leases.map((lease) =>
    lease.domain === 'source_schema'
      ? {
          ...lease,
          status: 'unknown',
          expires_at: now.toISOString(),
          reason_codes: ['source_schema.database_unroutable'],
          rollback_target: 'restore database routability before treating source schema as authoritative',
        }
      : lease,
  ),
})

const findClock = (clocks: ReturnType<typeof buildReconciledActionClocks>, actionClass: string) =>
  clocks.find((clock) => clock.action_class === actionClass)

describe('control-plane action clock', () => {
  it('keeps serving and repair open while source-schema conflict holds material actions', () => {
    const failureDomainLeases = withSourceSchemaConflict(leaseSet())
    const clocks = buildReconciledActionClocks({
      now,
      namespace: 'agents',
      failureDomainLeases,
      database: database(),
      rolloutHealth: rolloutHealth(),
      workflows: workflows(),
      watchReliability: watchReliability(),
      empiricalServices: empiricalServices(),
    })

    expect(findClock(clocks, 'serve_readonly')).toMatchObject({
      decision: 'allow',
      conflict_class: 'none',
      fresh_until: '2026-05-06T13:01:00.000Z',
    })
    expect(findClock(clocks, 'dispatch_repair')).toMatchObject({
      decision: 'allow',
      conflict_class: 'none',
    })

    for (const actionClass of ['dispatch_normal', 'deploy_widen', 'merge_ready', 'torghut_capital']) {
      expect(findClock(clocks, actionClass)).toMatchObject({
        decision: 'hold',
        conflict_class: 'contradictory_positive_negative',
        confidence: 'high',
        blocking_reason_codes: ['source_schema.database_unroutable'],
        required_repair_actions: ['align source and applied schema projections'],
      })
    }
  })

  it('holds Torghut capital on stale empirical jobs while leaving observe and normal dispatch alone', () => {
    const clocks = buildReconciledActionClocks({
      now,
      namespace: 'agents',
      failureDomainLeases: leaseSet(),
      database: database(),
      rolloutHealth: rolloutHealth(),
      workflows: workflows(),
      watchReliability: watchReliability(),
      empiricalServices: empiricalServices({
        jobs: {
          status: 'degraded',
          endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
          message: 'stale empirical jobs: benchmark_parity',
          authoritative: false,
          eligible_jobs: [],
          stale_jobs: ['benchmark_parity'],
        },
      }),
    })

    expect(findClock(clocks, 'torghut_observe')).toMatchObject({
      decision: 'allow',
      conflict_class: 'none',
    })
    expect(findClock(clocks, 'dispatch_normal')).toMatchObject({
      decision: 'allow',
      conflict_class: 'none',
    })
    expect(findClock(clocks, 'torghut_capital')).toMatchObject({
      decision: 'hold',
      conflict_class: 'consumer_debt',
      blocking_reason_codes: ['empirical_jobs_degraded', 'empirical_jobs_stale:benchmark_parity'],
    })
  })
})
