import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
} from '~/data/agents-control-plane'
import type { FailureDomainRouteProbe } from '~/server/control-plane-failure-domain-leases'
import {
  buildRouteStabilityEscrow,
  ROUTE_STABILITY_ESCROW_DESIGN_ARTIFACT,
} from '~/server/control-plane-route-stability-escrow'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

const now = new Date('2026-05-07T12:00:00.000Z')

const actionClasses: ActionSloBudgetActionClass[] = [
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

const verdict = (
  actionClass: ActionSloBudgetActionClass,
  overrides: Partial<MaterialActionVerdict> = {},
): MaterialActionVerdict => ({
  verdict_id: `material-action-verdict:${actionClass}:allow`,
  epoch_id: 'material-action-verdict:epoch:test',
  action_class: actionClass,
  decision: 'allow',
  decision_rank: 0,
  confidence: 'high',
  allowed_until: '2026-05-07T12:05:00.000Z',
  max_dispatches: 2,
  max_runtime_seconds: 900,
  max_notional: actionClass === 'paper_canary' ? 100 : 0,
  blocking_reason_codes: [],
  downgrade_reason_codes: [],
  required_repair_actions: [],
  rollback_target: null,
  evidence_refs: [`evidence:${actionClass}`],
  contradiction_refs: [],
  ...overrides,
})

const epoch = (
  expiresAt = '2026-05-07T12:05:00.000Z',
  verdictOverrides: Partial<Record<ActionSloBudgetActionClass, Partial<MaterialActionVerdict>>> = {},
): MaterialActionVerdictEpoch => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md',
  epoch_id: 'material-action-verdict:epoch:test',
  generated_at: now.toISOString(),
  expires_at: expiresAt,
  namespace: 'agents',
  producer_revision: 'test',
  dependency_quorum_ref: 'dependency_quorum:allow:none',
  negative_evidence_router_epoch_ref: 'negative-evidence-router:test',
  action_slo_budget_refs: [],
  action_clock_refs: [],
  rollout_health_ref: 'rollout:healthy',
  controller_witness_ref: 'controller-witness:test',
  watch_reliability_ref: 'watch:healthy',
  database_projection_ref: 'database:healthy',
  empirical_services_ref: 'empirical:healthy',
  torghut_capital_ref: 'clock:torghut_capital:allow',
  contradiction_refs: [],
  final_verdicts: actionClasses.map((actionClass) => verdict(actionClass, verdictOverrides[actionClass])),
})

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:test',
  generated_at: now.toISOString(),
  expires_at: '2026-05-07T12:05:00.000Z',
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller heartbeat is current',
  witness_refs: ['witness:controller-process:test'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [
    {
      witness_id: 'witness:controller-process:test',
      generated_at: now.toISOString(),
      expires_at: '2026-05-07T12:05:00.000Z',
      namespace: 'agents',
      controller_surface: 'controller_process',
      deployment_ref: 'deployment/agents/agents-controllers',
      pod_uid: 'agents-controllers-0',
      image_ref: null,
      leader_identity: 'agents-controllers-0',
      controller_started: true,
      deployment_available: null,
      watch_epoch_id: null,
      ingestion_epoch_id: null,
      last_watch_event_at: null,
      last_resync_at: null,
      observed_run_count: null,
      untouched_run_count: null,
      decision: 'allow',
      reason_codes: [],
    },
  ],
  rollback_target: null,
  ...overrides,
})

const routeProbe = (reachable: boolean): FailureDomainRouteProbe => ({
  status: reachable ? 'healthy' : 'degraded',
  reachable,
  url: 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents',
  status_code: reachable ? 200 : null,
  latency_ms: reachable ? 21 : 2000,
  message: reachable ? 'route probe succeeded' : 'connect ECONNREFUSED 10.0.0.10:80',
  observed_at: now.toISOString(),
})

const database = (status: DatabaseStatus['status'] = 'healthy'): DatabaseStatus => ({
  configured: true,
  connected: status === 'healthy',
  status,
  message: status === 'healthy' ? 'database healthy' : 'database unavailable',
  latency_ms: status === 'healthy' ? 4 : 0,
  migration_consistency: {
    status: status === 'healthy' ? 'healthy' : 'unknown',
    migration_table: 'kysely_migration',
    registered_count: 28,
    applied_count: status === 'healthy' ? 28 : 0,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260505_torghut_quant_pipeline_health_window_index',
    latest_applied: status === 'healthy' ? '20260505_torghut_quant_pipeline_health_window_index' : null,
    missing_migrations: [],
    unexpected_migrations: [],
    message: '',
  },
})

const rollout = (status: ControlPlaneRolloutHealth['status'] = 'healthy'): ControlPlaneRolloutHealth => ({
  status,
  observed_deployments: 2,
  degraded_deployments: status === 'healthy' ? 0 : 1,
  deployments: [],
  message: `rollout ${status}`,
})

const watch = (): ControlPlaneWatchReliability => ({
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 2,
  total_events: 100,
  total_errors: 0,
  total_restarts: 0,
  streams: [],
})

const build = (overrides: Partial<Parameters<typeof buildRouteStabilityEscrow>[0]> = {}) =>
  buildRouteStabilityEscrow({
    now,
    namespace: 'agents',
    service: 'agents',
    routeProbe: routeProbe(true),
    database: database(),
    rolloutHealth: rollout(),
    watchReliability: watch(),
    controllerWitness: controllerWitness(),
    materialActionVerdictEpoch: epoch(),
    ...overrides,
  })

const contract = (escrow: ReturnType<typeof build>, actionClass: ActionSloBudgetActionClass) => {
  const result = escrow.material_action_contracts.find((entry) => entry.action_class === actionClass)
  expect(result).toBeTruthy()
  return result!
}

describe('route stability escrow', () => {
  it('uses fresh snapshot authority only for read, observe, and bounded repair when the live route is refused', () => {
    const escrow = build({
      routeProbe: routeProbe(false),
      materialActionVerdictEpoch: epoch(undefined, {
        dispatch_repair: { max_notional: 25_000 },
        torghut_observe: { max_notional: 25_000 },
      }),
    })

    expect(escrow.design_artifact).toBe(ROUTE_STABILITY_ESCROW_DESIGN_ARTIFACT)
    expect(escrow.route_stability_window).toMatchObject({
      state: 'escrow_repair_only',
      live_route_success_count: 0,
      controller_authority_mode: 'heartbeat',
      reason_codes: ['live_status_route_unreachable'],
    })
    expect(escrow.live_route_attempts[0]).toMatchObject({
      result: 'failure',
      message: 'connect ECONNREFUSED 10.0.0.10:80',
    })
    expect(contract(escrow, 'serve_readonly').decision).toBe('allow')
    expect(contract(escrow, 'dispatch_repair')).toMatchObject({ decision: 'allow', max_notional: 0 })
    expect(contract(escrow, 'torghut_observe')).toMatchObject({ decision: 'allow', max_notional: 0 })
    expect(contract(escrow, 'dispatch_normal')).toMatchObject({
      decision: 'repair_only',
      max_dispatches: 1,
      max_notional: 0,
    })
    expect(contract(escrow, 'merge_ready').decision).toBe('hold')
    expect(contract(escrow, 'paper_canary').decision).toBe('hold')
    expect(contract(escrow, 'live_scale').decision).toBe('block')
  })

  it('refuses snapshot fallback for non-serving actions when the snapshot has expired', () => {
    const escrow = build({
      routeProbe: routeProbe(false),
      materialActionVerdictEpoch: epoch('2026-05-07T11:59:00.000Z'),
    })

    expect(escrow.route_stability_window).toMatchObject({
      state: 'unstable',
      reason_codes: ['live_status_route_unreachable', 'status_snapshot_expired'],
    })
    expect(contract(escrow, 'serve_readonly').decision).toBe('allow')
    expect(contract(escrow, 'dispatch_repair').decision).toBe('hold')
    expect(contract(escrow, 'torghut_observe').decision).toBe('hold')
    expect(contract(escrow, 'dispatch_normal').decision).toBe('hold')
    expect(contract(escrow, 'live_scale').decision).toBe('block')
  })

  it('keeps normal dispatch repair-only when authority is rollout-derived', () => {
    const escrow = build({
      controllerWitness: controllerWitness({
        decision: 'repair_only',
        reason_codes: ['controller_witness_split'],
        message: 'deployment and watch are current but controller heartbeat is missing',
        controller_self_report_current: false,
        witnesses: [
          {
            witness_id: 'witness:kubernetes-deployment:test',
            generated_at: now.toISOString(),
            expires_at: '2026-05-07T12:05:00.000Z',
            namespace: 'agents',
            controller_surface: 'kubernetes_deployment',
            deployment_ref: 'deployment/agents/agents-controllers',
            pod_uid: null,
            image_ref: null,
            leader_identity: null,
            controller_started: null,
            deployment_available: true,
            watch_epoch_id: null,
            ingestion_epoch_id: null,
            last_watch_event_at: null,
            last_resync_at: null,
            observed_run_count: 2,
            untouched_run_count: null,
            decision: 'allow',
            reason_codes: [],
          },
        ],
        rollback_target: 'allow bounded repair until controller heartbeat is current',
      }),
    })

    expect(escrow.route_stability_window).toMatchObject({
      state: 'escrow_repair_only',
      live_route_success_count: 1,
      controller_authority_mode: 'rollout',
      reason_codes: ['controller_witness_split'],
    })
    expect(contract(escrow, 'dispatch_repair').decision).toBe('allow')
    expect(contract(escrow, 'dispatch_normal').decision).toBe('repair_only')
    expect(contract(escrow, 'deploy_widen').decision).toBe('hold')
    expect(contract(escrow, 'merge_ready').decision).toBe('hold')
  })

  it('graduates normal material actions when live route and controller heartbeat authority are current', () => {
    const escrow = build()

    expect(escrow.route_stability_window).toMatchObject({
      state: 'stable',
      live_route_success_count: 1,
      controller_authority_mode: 'heartbeat',
    })
    expect(contract(escrow, 'dispatch_normal').decision).toBe('allow')
    expect(contract(escrow, 'deploy_widen').decision).toBe('allow')
    expect(contract(escrow, 'merge_ready').decision).toBe('allow')
    expect(contract(escrow, 'paper_canary').decision).toBe('allow')
  })
})
