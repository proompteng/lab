import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  ConsumerEvidenceActionLease,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
} from '~/server/control-plane-status-types'
import {
  buildConsumerEvidenceLeaseSet,
  CONSUMER_EVIDENCE_LEASES_DESIGN_ARTIFACT,
  type ConsumerEvidenceLeaseInput,
} from '~/server/control-plane-consumer-evidence-leases'

const now = new Date('2026-05-13T04:00:00.000Z')

const ACTION_CLASSES: ActionSloBudgetActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
]

const materialVerdict = (
  actionClass: ActionSloBudgetActionClass,
  overrides: Partial<MaterialActionVerdict> = {},
): MaterialActionVerdict => ({
  verdict_id: `material-action-verdict:${actionClass}:test`,
  epoch_id: 'material-action-verdict-epoch:test',
  action_class: actionClass,
  decision: 'allow',
  decision_rank: 0,
  confidence: 'high',
  allowed_until: '2026-05-13T04:01:00.000Z',
  max_dispatches: null,
  max_runtime_seconds: null,
  max_notional:
    actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale' ? 0 : null,
  blocking_reason_codes: [],
  downgrade_reason_codes: [],
  required_repair_actions: [],
  rollback_target: null,
  evidence_refs: [`evidence:${actionClass}:test`],
  contradiction_refs: [],
  ...overrides,
})

const materialEpoch = (overrides: Partial<MaterialActionVerdictEpoch> = {}): MaterialActionVerdictEpoch => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md',
  epoch_id: 'material-action-verdict-epoch:test',
  generated_at: now.toISOString(),
  expires_at: '2026-05-13T04:01:00.000Z',
  namespace: 'agents',
  producer_revision: 'test',
  dependency_quorum_ref: 'dependency-quorum:allow',
  negative_evidence_router_epoch_ref: 'negative-evidence-router:test',
  action_slo_budget_refs: [],
  action_clock_refs: [],
  rollout_health_ref: 'rollout:healthy',
  controller_witness_ref: 'controller-witness:allow',
  watch_reliability_ref: 'watch:healthy',
  database_projection_ref: 'database:healthy:healthy',
  empirical_services_ref: 'empirical:forecast=healthy:lean=healthy:jobs=healthy',
  torghut_capital_ref: null,
  contradiction_refs: [],
  final_verdicts: ACTION_CLASSES.map((actionClass) => materialVerdict(actionClass)),
  ...overrides,
})

const baseInput = (overrides: Partial<ConsumerEvidenceLeaseInput> = {}): ConsumerEvidenceLeaseInput => ({
  now,
  namespace: 'agents',
  database: {
    configured: true,
    connected: true,
    status: 'healthy',
    message: 'ok',
    latency_ms: 3,
    migration_consistency: {
      status: 'healthy',
      migration_table: 'kysely_migration',
      registered_count: 28,
      applied_count: 28,
      unapplied_count: 0,
      unexpected_count: 0,
      latest_registered: '20260505_torghut_quant_pipeline_health_window_index',
      latest_applied: '20260505_torghut_quant_pipeline_health_window_index',
      missing_migrations: [],
      unexpected_migrations: [],
      message: 'schema current',
    },
  },
  rolloutHealth: {
    status: 'healthy',
    observed_deployments: 2,
    degraded_deployments: 0,
    deployments: [],
    message: 'rollout healthy',
  },
  watchReliability: {
    status: 'healthy',
    window_minutes: 15,
    observed_streams: 2,
    total_events: 100,
    total_errors: 0,
    total_restarts: 0,
    streams: [],
  },
  controllerWitness: {
    mode: 'shadow',
    design_artifact:
      'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
    quorum_id: 'controller-witness:allow',
    generated_at: now.toISOString(),
    expires_at: '2026-05-13T04:01:00.000Z',
    namespace: 'agents',
    decision: 'allow',
    reason_codes: [],
    message: 'controller witness current',
    witness_refs: ['controller-witness-row:agents-controller'],
    deployment_available: true,
    watch_epoch_current: true,
    controller_self_report_current: true,
    witnesses: [],
    rollback_target: null,
  },
  materialActionVerdictEpoch: materialEpoch(),
  empiricalServices: {
    forecast: {
      status: 'healthy',
      endpoint: 'http://torghut/trading/status',
      message: 'forecast service ready',
      authoritative: true,
    },
    lean: {
      status: 'healthy',
      endpoint: 'http://torghut/trading/status',
      message: 'LEAN runner ready',
      authoritative: true,
    },
    jobs: {
      status: 'healthy',
      endpoint: 'http://torghut/trading/empirical-jobs',
      message: 'empirical jobs fresh',
      authoritative: true,
      stale_jobs: [],
    },
  },
  ...overrides,
})

const leaseByAction = (leases: ConsumerEvidenceActionLease[], actionClass: ActionSloBudgetActionClass) => {
  const lease = leases.find((entry) => entry.action_class === actionClass)
  expect(lease).toBeTruthy()
  return lease as ConsumerEvidenceActionLease
}

describe('control-plane consumer evidence leases', () => {
  it('keeps service and repair available while missing controller witness makes normal dispatch repair-only', () => {
    const leaseSet = buildConsumerEvidenceLeaseSet(
      baseInput({
        controllerWitness: {
          ...baseInput().controllerWitness,
          quorum_id: 'controller-witness:split',
          decision: 'allow_with_split',
          reason_codes: ['controller_ingestion_unknown'],
          message: 'serving route is healthy but controller-process ingestion is unknown',
          controller_self_report_current: false,
        },
      }),
    )

    expect(leaseSet.design_artifact).toBe(CONSUMER_EVIDENCE_LEASES_DESIGN_ARTIFACT)
    expect(leaseSet.schema_version).toBe('jangar.consumer-evidence-lease-set.v1')
    expect(leaseByAction(leaseSet.action_leases, 'serve_readonly')).toMatchObject({ decision: 'allow' })
    expect(leaseByAction(leaseSet.action_leases, 'dispatch_repair')).toMatchObject({ decision: 'allow' })
    expect(leaseByAction(leaseSet.action_leases, 'dispatch_normal')).toMatchObject({
      decision: 'repair_only',
      max_dispatches: 1,
      max_notional: 0,
      reason_codes: expect.arrayContaining(['controller_ingestion_unknown', 'controller_witness_allow_with_split']),
    })
  })

  it('blocks deploy widening and merge readiness when database schema projection is stale', () => {
    const leaseSet = buildConsumerEvidenceLeaseSet(
      baseInput({
        database: {
          ...baseInput().database,
          status: 'degraded',
          migration_consistency: {
            ...baseInput().database.migration_consistency,
            status: 'degraded',
            unapplied_count: 1,
            missing_migrations: ['20260513_consumer_evidence_leases'],
          },
        },
      }),
    )

    expect(leaseByAction(leaseSet.action_leases, 'deploy_widen')).toMatchObject({
      decision: 'block',
      reason_codes: expect.arrayContaining(['database_degraded', 'database_schema_degraded']),
      rollback_target: 'hold consumer lease enforcement until Jangar database and schema projections are healthy',
    })
    expect(leaseByAction(leaseSet.action_leases, 'merge_ready')).toMatchObject({
      decision: 'block',
      reason_codes: expect.arrayContaining(['database_degraded', 'database_schema_degraded']),
    })
  })

  it('holds paper and live capital on forecast debt without blocking Torghut observe', () => {
    const leaseSet = buildConsumerEvidenceLeaseSet(
      baseInput({
        empiricalServices: {
          ...baseInput().empiricalServices,
          forecast: {
            ...baseInput().empiricalServices.forecast,
            status: 'degraded',
            message: 'forecast registry is empty',
          },
        },
      }),
    )

    expect(leaseByAction(leaseSet.action_leases, 'torghut_observe')).toMatchObject({ decision: 'allow' })
    for (const actionClass of ['paper_canary', 'live_micro_canary', 'live_scale'] as const) {
      expect(leaseByAction(leaseSet.action_leases, actionClass)).toMatchObject({
        decision: 'hold',
        max_notional: 0,
        reason_codes: expect.arrayContaining(['forecast_service_degraded']),
      })
    }
  })
})
