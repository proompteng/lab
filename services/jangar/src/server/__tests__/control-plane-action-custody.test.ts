import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  RouteStabilityEscrow,
  RouteStabilityMaterialActionContract,
  SourceRolloutTruthExchange,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { ACTION_CUSTODY_DESIGN_ARTIFACT, buildActionCustodyProjection } from '~/server/control-plane-action-custody'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

const now = new Date('2026-05-08T16:24:00.000Z')
const freshUntil = '2026-05-08T16:29:00.000Z'

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
  message: 'workflow evidence healthy',
  ...overrides,
})

const controllerWitness = (
  overrides: Partial<ControlPlaneControllerWitnessQuorum> = {},
): ControlPlaneControllerWitnessQuorum => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
  quorum_id: 'controller-witness:current',
  generated_at: now.toISOString(),
  expires_at: freshUntil,
  namespace: 'agents',
  decision: 'allow',
  reason_codes: [],
  message: 'controller self-report current',
  witness_refs: ['controller-witness:controller-process'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [
    {
      witness_id: 'controller-witness:controller-process',
      generated_at: now.toISOString(),
      expires_at: freshUntil,
      namespace: 'agents',
      controller_surface: 'controller_process',
      deployment_ref: 'deployment/agents/agents-controllers',
      pod_uid: 'agents-controllers-0',
      image_ref: 'jangar:current',
      leader_identity: 'agents-controllers-0',
      controller_started: true,
      deployment_available: null,
      watch_epoch_id: 'watch:current',
      ingestion_epoch_id: 'ingestion:current',
      last_watch_event_at: now.toISOString(),
      last_resync_at: now.toISOString(),
      observed_run_count: 20,
      untouched_run_count: 0,
      decision: 'allow',
      reason_codes: [],
    },
  ],
  rollback_target: null,
  ...overrides,
})

const materialVerdict = (
  actionClass: ActionSloBudgetActionClass,
  overrides: Partial<MaterialActionVerdict> = {},
): MaterialActionVerdict => ({
  verdict_id: `material-action-verdict:${actionClass}:allow`,
  epoch_id: 'material-action-verdict:epoch:current',
  action_class: actionClass,
  decision: 'allow',
  decision_rank: 0,
  confidence: 'high',
  allowed_until: freshUntil,
  max_dispatches: actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? null : 1,
  max_runtime_seconds: actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? null : 1800,
  max_notional:
    actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale' ? 1000 : 0,
  blocking_reason_codes: [],
  downgrade_reason_codes: [],
  required_repair_actions: [],
  rollback_target: null,
  evidence_refs: [`evidence:${actionClass}`],
  contradiction_refs: [],
  ...overrides,
})

const materialEpoch = (
  overrides: Partial<Record<ActionSloBudgetActionClass, Partial<MaterialActionVerdict>>> = {},
): MaterialActionVerdictEpoch => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md',
  epoch_id: 'material-action-verdict:epoch:current',
  generated_at: now.toISOString(),
  expires_at: freshUntil,
  namespace: 'agents',
  producer_revision: 'test',
  dependency_quorum_ref: 'dependency:allow',
  negative_evidence_router_epoch_ref: 'negative-evidence-router:current',
  action_slo_budget_refs: [],
  action_clock_refs: [],
  rollout_health_ref: 'rollout:healthy',
  controller_witness_ref: 'controller-witness:current',
  watch_reliability_ref: 'watch:healthy',
  database_projection_ref: 'database:healthy',
  empirical_services_ref: 'empirical:healthy',
  torghut_capital_ref: 'torghut:capital',
  contradiction_refs: [],
  final_verdicts: actionClasses.map((actionClass) => materialVerdict(actionClass, overrides[actionClass])),
})

const routeContract = (
  actionClass: ActionSloBudgetActionClass,
  overrides: Partial<RouteStabilityMaterialActionContract> = {},
): RouteStabilityMaterialActionContract => ({
  action_class: actionClass,
  route_requirement: actionClass === 'serve_readonly' ? 'none' : 'live_required',
  controller_requirement:
    actionClass === 'dispatch_repair'
      ? 'rollout_ok_for_repair'
      : actionClass === 'serve_readonly' || actionClass === 'torghut_observe'
        ? 'none'
        : 'heartbeat_required',
  decision: 'allow',
  max_dispatches: actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? null : 1,
  max_runtime_seconds: actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? null : 1800,
  max_notional:
    actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale' ? 1000 : 0,
  required_repairs: [],
  snapshot_ref: 'control-plane-status:agents:current',
  live_route_ref: 'route-attempt:current',
  rollback_target: null,
  ...overrides,
})

const routeEscrow = (
  contractOverrides: Partial<Record<ActionSloBudgetActionClass, Partial<RouteStabilityMaterialActionContract>>> = {},
): RouteStabilityEscrow => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md',
  escrow_id: 'route-stability-escrow:current',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  status_snapshot_ref: 'control-plane-status:agents:current',
  status_snapshot_hash: 'current',
  status_producer_revision: 'test',
  live_route_attempts: [
    {
      attempt_id: 'route-attempt:current',
      attempted_at: now.toISOString(),
      url: 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents',
      result: 'success',
      status_code: 200,
      latency_ms: 20,
      message: 'route probe succeeded',
    },
  ],
  last_live_route_success_at: now.toISOString(),
  last_live_route_error: null,
  route_stability_window: {
    state: 'stable',
    started_at: now.toISOString(),
    stable_after: now.toISOString(),
    expires_at: freshUntil,
    live_route_success_count: 1,
    required_success_count: 1,
    controller_authority_mode: 'heartbeat',
    allowed_action_classes: actionClasses,
    held_action_classes: [],
    blocked_action_classes: [],
    reason_codes: [],
  },
  controller_witness_ref: 'controller-witness:current',
  database_projection_ref: 'database:healthy',
  watch_reliability_ref: 'watch:healthy',
  material_action_contracts: actionClasses.map((actionClass) =>
    routeContract(actionClass, contractOverrides[actionClass]),
  ),
  rollback_target: null,
})

const sourceRolloutTruth = (): SourceRolloutTruthExchange => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md',
  exchange_id: 'source-rollout-truth:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  namespace: 'agents',
  source_head_sha: '99470fcfa0000000000000000000000000000000',
  gitops_revision: '99470fcfa0000000000000000000000000000000',
  desired_images: [],
  live_images: [],
  controller_heartbeats: [],
  route_statuses: [],
  database_projection_ref: 'database:healthy',
  watch_cache_ref: 'watch:healthy',
  torghut_proof_floor: {
    proof_floor_ref: 'torghut-proof-floor:current',
    state: 'closed',
    capital_state: 'paper',
    fresh_until: freshUntil,
    blockers: [],
    evidence_refs: [],
  },
  receipts: actionClasses.map((actionClass) => ({
    receipt_id: `source-rollout-truth:${actionClass}:allow`,
    action_class: actionClass,
    settlement_state: 'converged',
    source_head_sha: '99470fcfa0000000000000000000000000000000',
    gitops_revision: '99470fcfa0000000000000000000000000000000',
    desired_image_ref: null,
    desired_image_digest: null,
    live_image_ref: null,
    live_image_digest: null,
    controller_heartbeat_ref: 'controller-witness:current',
    database_projection_ref: 'database:healthy',
    watch_cache_ref: 'watch:healthy',
    route_status_ref: 'route:healthy',
    torghut_proof_floor_ref: 'torghut-proof-floor:current',
    fresh_until: freshUntil,
    action_decision: 'allow',
    blocking_reasons: [],
    rollback_target: null,
  })),
  deployer_summary: {
    settlement_state: 'converged',
    freshest_blocking_reason: null,
    rollback_target: null,
    held_action_classes: [],
    receipt_refs: actionClasses.map((actionClass) => `source-rollout-truth:${actionClass}:allow`),
  },
  rollback_target: null,
})

const torghutConsumerEvidence = (
  overrides: Partial<TorghutConsumerEvidenceStatus> = {},
): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
  receipt_id: 'torghut-route-proven-profit:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  candidate_id: 'chip-paper-microbar-composite@execution-proof',
  dataset_snapshot_ref: 'dataset:current',
  max_notional: '1000',
  decision: 'allow',
  capital_reentry_cohort_ledger_id: 'capital-reentry:current',
  capital_reentry_aggregate_state: 'allow',
  capital_reentry_cohort_ids: ['cohort:current'],
  profit_repair_settlement_ledger_id: 'profit-window:current',
  profit_repair_aggregate_state: 'allow',
  profit_repair_lot_ids: ['lot:current'],
  reason_codes: [],
  message: 'torghut consumer evidence current',
  ...overrides,
})

const build = (overrides: Partial<Parameters<typeof buildActionCustodyProjection>[0]> = {}) =>
  buildActionCustodyProjection({
    now,
    namespace: 'agents',
    workflows: workflows(),
    controllerWitness: controllerWitness(),
    sourceRolloutTruthExchange: sourceRolloutTruth(),
    routeStabilityEscrow: routeEscrow(),
    materialActionVerdictEpoch: materialEpoch(),
    torghutConsumerEvidence: torghutConsumerEvidence(),
    ...overrides,
  })

const receipt = (projection: ReturnType<typeof build>, actionClass: ActionSloBudgetActionClass) => {
  const found = projection.actionCustodyReceipts.find((entry) => entry.action_class === actionClass)
  expect(found).toBeTruthy()
  return found!
}

describe('control-plane action custody', () => {
  it('keeps serving allowed while controller and Torghut custody hold material actions', () => {
    const projection = build({
      controllerWitness: controllerWitness({
        decision: 'repair_only',
        reason_codes: ['controller_heartbeat_not_current'],
        message: 'controller deployment is available but self-report is missing',
        controller_self_report_current: false,
        rollback_target: 'allow bounded repair until controller heartbeat is current',
      }),
      torghutConsumerEvidence: torghutConsumerEvidence({
        max_notional: '0',
        decision: 'repair',
        profit_repair_aggregate_state: 'blocked',
        reason_codes: ['simple_submit_disabled', 'market_context_stale'],
      }),
    })

    expect(projection.readyActionExchange.design_artifact).toBe(ACTION_CUSTODY_DESIGN_ARTIFACT)
    expect(receipt(projection, 'serve_readonly')).toMatchObject({
      decision: 'allow',
      allowed_scope: 'serve_readonly',
    })
    expect(receipt(projection, 'dispatch_repair')).toMatchObject({
      decision: 'repair_only',
      allowed_scope: 'bounded_repair',
      max_dispatches: 1,
      max_notional: 0,
    })
    expect(receipt(projection, 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      blocking_debt_classes: expect.arrayContaining([
        'controller_heartbeat_not_current',
        'controller_self_report_not_current',
      ]),
    })
    expect(receipt(projection, 'deploy_widen').decision).toBe('hold')
    expect(receipt(projection, 'merge_ready').decision).toBe('hold')
    expect(receipt(projection, 'torghut_observe').decision).toBe('allow')
    expect(receipt(projection, 'paper_canary')).toMatchObject({
      decision: 'hold',
      max_notional: 0,
    })
    expect(receipt(projection, 'live_micro_canary').decision).toBe('block')
    expect(receipt(projection, 'live_scale').decision).toBe('block')
    expect(projection.readyActionExchange).toMatchObject({
      status: 'block',
      allowed_action_classes: ['serve_readonly', 'torghut_observe'],
      repair_only_action_classes: ['dispatch_repair'],
      held_action_classes: ['dispatch_normal', 'deploy_widen', 'merge_ready', 'paper_canary'],
      blocked_action_classes: ['live_micro_canary', 'live_scale'],
    })
  })

  it('does not allow rollout or merge custody to outrun retained failure debt', () => {
    const projection = build({
      workflows: workflows({
        recent_failed_jobs: 2,
        backoff_limit_exceeded_jobs: 1,
        top_failure_reasons: [{ reason: 'BackoffLimitExceeded', count: 1 }],
      }),
    })

    expect(receipt(projection, 'serve_readonly').decision).toBe('allow')
    expect(receipt(projection, 'dispatch_repair').decision).toBe('allow')
    expect(receipt(projection, 'deploy_widen')).toMatchObject({
      decision: 'hold',
      blocking_debt_classes: [
        'retained_recent_failed_jobs',
        'retained_backoff_limit_exceeded_jobs',
        'workflow_failure:BackoffLimitExceeded',
      ],
    })
    expect(receipt(projection, 'merge_ready').decision).toBe('hold')
    expect(receipt(projection, 'paper_canary').decision).toBe('hold')
    expect(receipt(projection, 'live_scale').decision).toBe('block')
  })

  it('allows all action classes when custody inputs are current and Torghut profit-window notional is positive', () => {
    const projection = build()

    expect(projection.actionCustodyReceipts).toHaveLength(actionClasses.length)
    for (const actionClass of actionClasses) {
      expect(receipt(projection, actionClass).decision).toBe('allow')
    }
    expect(receipt(projection, 'paper_canary')).toMatchObject({
      allowed_scope: 'paper_canary',
      max_notional: 1000,
      torghut_profit_window_ref: 'profit-window:current',
    })
    expect(receipt(projection, 'serve_readonly')).toMatchObject({
      max_dispatches: null,
      max_runtime_seconds: null,
      max_notional: 0,
    })
    expect(receipt(projection, 'torghut_observe')).toMatchObject({
      max_dispatches: null,
      max_runtime_seconds: null,
      max_notional: 0,
    })
    expect(projection.readyActionExchange).toMatchObject({
      mode: 'observe',
      status: 'allow',
      held_action_classes: [],
      blocked_action_classes: [],
    })
  })

  it('does not advertise runnable authority for repair-only non-repair actions', () => {
    const projection = build({
      materialActionVerdictEpoch: materialEpoch({
        dispatch_normal: {
          decision: 'repair_only',
          downgrade_reason_codes: ['controller_witness_split'],
          required_repair_actions: ['restore controller witness before normal dispatch'],
          max_dispatches: 1,
          max_runtime_seconds: 1200,
          max_notional: 0,
        },
        deploy_widen: {
          decision: 'repair_only',
          downgrade_reason_codes: ['deploy_requires_current_custody'],
          required_repair_actions: ['restore deploy custody before widening'],
          max_dispatches: 1,
          max_runtime_seconds: 900,
          max_notional: 0,
        },
      }),
    })

    expect(receipt(projection, 'dispatch_normal')).toMatchObject({
      decision: 'repair_only',
      allowed_scope: 'none',
      max_dispatches: 0,
      max_runtime_seconds: 0,
      max_notional: 0,
    })
    expect(receipt(projection, 'deploy_widen')).toMatchObject({
      decision: 'repair_only',
      allowed_scope: 'none',
      max_dispatches: 0,
      max_runtime_seconds: 0,
      max_notional: 0,
    })
    expect(projection.readyActionExchange.repair_only_action_classes).toEqual(['dispatch_normal', 'deploy_widen'])
  })

  it('uses the tightest allow caps across material, route, and Torghut custody inputs', () => {
    const projection = build({
      materialActionVerdictEpoch: materialEpoch({
        paper_canary: {
          max_dispatches: 3,
          max_runtime_seconds: 1800,
          max_notional: 1000,
        },
      }),
      routeStabilityEscrow: routeEscrow({
        paper_canary: {
          max_dispatches: 2,
          max_runtime_seconds: 900,
          max_notional: 750,
        },
      }),
      torghutConsumerEvidence: torghutConsumerEvidence({ max_notional: '100' }),
    })

    expect(receipt(projection, 'paper_canary')).toMatchObject({
      decision: 'allow',
      max_dispatches: 1,
      max_runtime_seconds: 900,
      max_notional: 100,
    })
  })
})
