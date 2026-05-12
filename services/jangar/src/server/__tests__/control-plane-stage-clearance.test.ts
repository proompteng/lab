import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStage,
  ExecutionTrustStatus,
  ExecutionTrustSwarm,
  FailureDomainLeaseSet,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  RouteStabilityEscrow,
  RouteStabilityMaterialActionContract,
  SourceRolloutTruthExchange,
  StageClearancePacket,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { buildStageClearancePackets, STAGE_CLEARANCE_DESIGN_ARTIFACT } from '~/server/control-plane-stage-clearance'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

const now = new Date('2026-05-12T16:44:09.227Z')
const freshUntil = '2026-05-12T16:46:09.227Z'

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

const healthyExecutionTrust: ExecutionTrustStatus = {
  status: 'healthy',
  reason: 'execution trust is healthy',
  last_evaluated_at: now.toISOString(),
  blocking_windows: [],
  evidence_summary: [],
}

const frozenExecutionTrust: ExecutionTrustStatus = {
  status: 'degraded',
  reason: 'execution trust degraded: swarm freeze active (StageStaleness)',
  last_evaluated_at: now.toISOString(),
  blocking_windows: [
    {
      type: 'swarms',
      scope: 'agents/jangar-control-plane',
      name: 'jangar-control-plane',
      reason: 'swarm freeze active (StageStaleness)',
      class: 'degraded',
    },
  ],
  evidence_summary: ['jangar-control-plane frozen for StageStaleness'],
}

const frozenSwarm: ExecutionTrustSwarm = {
  name: 'jangar-control-plane',
  namespace: 'agents',
  phase: 'Frozen',
  ready: false,
  updated_at: now.toISOString(),
  observed_generation: 7,
  freeze: {
    reason: 'StageStaleness',
    until: '2026-05-12T17:00:39.529Z',
  },
  requirements_pending: 2,
  requirements_pending_class: 'blocked',
  last_discover_at: '2026-05-12T15:10:00.000Z',
  last_plan_at: '2026-05-12T15:10:00.000Z',
  last_implement_at: '2026-05-12T15:10:00.000Z',
  last_verify_at: '2026-05-12T15:10:00.000Z',
}

const frozenStage = (stage: ExecutionTrustStage['stage']): ExecutionTrustStage => ({
  swarm: 'jangar-control-plane',
  namespace: 'agents',
  stage,
  phase: 'Frozen',
  last_run_at: '2026-05-12T15:10:00.000Z',
  next_expected_at: '2026-05-12T15:12:00.000Z',
  configured_every_ms: 60000,
  age_ms: 5649227,
  stale_after_ms: 120000,
  stale: true,
  recent_failed_jobs: 1,
  recent_backoff_limit_exceeded_jobs: 0,
  last_failure_reason: `${stage} blocked by swarm freeze`,
  data_confidence: 'high',
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
  message: 'controller witness current',
  witness_refs: ['controller-witness:agentrun-ingestion'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [
    {
      witness_id: 'controller-witness:agentrun-ingestion',
      generated_at: now.toISOString(),
      expires_at: freshUntil,
      namespace: 'agents',
      controller_surface: 'agentrun_ingestion',
      deployment_ref: 'deployment/agents/agents-controllers',
      pod_uid: 'agents-controllers-0',
      image_ref: 'jangar:current',
      leader_identity: 'agents-controllers-0',
      controller_started: true,
      deployment_available: true,
      watch_epoch_id: 'watch:current',
      ingestion_epoch_id: 'ingestion:current',
      last_watch_event_at: now.toISOString(),
      last_resync_at: now.toISOString(),
      observed_run_count: 600,
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
  route_requirement: actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? 'none' : 'live_required',
  controller_requirement:
    actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? 'none' : 'heartbeat_required',
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

const routeEscrow = (): RouteStabilityEscrow => ({
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
  live_route_attempts: [],
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
  material_action_contracts: actionClasses.map((actionClass) => routeContract(actionClass)),
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
  source_head_sha: '32564cef018d608a7928c80240a70d35f75c5b25',
  gitops_revision: '32564cef018d608a7928c80240a70d35f75c5b25',
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
    source_head_sha: '32564cef018d608a7928c80240a70d35f75c5b25',
    gitops_revision: '32564cef018d608a7928c80240a70d35f75c5b25',
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

const failureDomainLeases = (): FailureDomainLeaseSet => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md',
  lease_set_digest: 'lease-set:healthy',
  generated_at: now.toISOString(),
  leases: [],
  holdbacks: [],
})

const failureDomainHoldbackLeases = (): FailureDomainLeaseSet => ({
  mode: 'shadow',
  design_artifact:
    'docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md',
  lease_set_digest: 'lease-set:missing-database',
  generated_at: now.toISOString(),
  leases: [],
  holdbacks: [
    {
      action_class: 'dispatch_normal',
      decision: 'unknown',
      lease_ids: [],
      reason_codes: ['database.lease_missing'],
      message: 'dispatch_normal is held by database.lease_missing.',
    },
  ],
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

const build = (overrides: Partial<Parameters<typeof buildStageClearancePackets>[0]> = {}): StageClearancePacket[] =>
  buildStageClearancePackets({
    now,
    namespace: 'agents',
    workflows: workflows(),
    executionTrust: healthyExecutionTrust,
    swarms: [],
    stages: [],
    controllerWitness: controllerWitness(),
    sourceRolloutTruthExchange: sourceRolloutTruth(),
    routeStabilityEscrow: routeEscrow(),
    materialActionVerdictEpoch: materialEpoch(),
    failureDomainLeases: failureDomainLeases(),
    torghutConsumerEvidence: torghutConsumerEvidence(),
    ...overrides,
  })

const packet = (
  packets: StageClearancePacket[],
  stage: StageClearancePacket['stage'],
  actionClass: ActionSloBudgetActionClass,
) => {
  const found = packets.find((entry) => entry.stage === stage && entry.action_class === actionClass)
  expect(found).toBeTruthy()
  return found!
}

describe('control-plane stage clearance', () => {
  it('holds normal scheduled launches when the swarm is frozen', () => {
    const packets = build({
      executionTrust: frozenExecutionTrust,
      swarms: [frozenSwarm],
      stages: [frozenStage('discover'), frozenStage('plan'), frozenStage('implement'), frozenStage('verify')],
      materialActionVerdictEpoch: materialEpoch({
        dispatch_normal: {
          decision: 'hold',
          blocking_reason_codes: ['source_rollout_truth_hold'],
          required_repair_actions: ['clear stage freshness debt'],
        },
      }),
    })

    const discover = packet(packets, 'discover', 'dispatch_normal')
    expect(discover).toMatchObject({
      decision: 'hold',
      max_launches: 0,
      governing_requirement_refs: expect.arrayContaining([STAGE_CLEARANCE_DESIGN_ARTIFACT]),
      reason_codes: expect.arrayContaining(['swarm_freeze_active', 'stage_discover_stale']),
      required_repair_action: 'clear stage freshness debt',
    })
    expect(discover.packet_id).toContain('stage-clearance:discover:dispatch_normal:')
  })

  it('allows zero-notional Torghut observe without opening paper or live packets', () => {
    const packets = build({
      torghutConsumerEvidence: torghutConsumerEvidence({
        max_notional: '0',
        decision: 'repair',
        profit_repair_aggregate_state: 'blocked',
        reason_codes: ['simple_submit_disabled', 'market_context_stale'],
      }),
    })

    expect(packet(packets, 'torghut', 'torghut_observe')).toMatchObject({
      decision: 'allow',
      max_launches: null,
      max_notional: 0,
      torghut_consumer_evidence_ref: 'torghut-route-proven-profit:current',
    })
    expect(packet(packets, 'torghut', 'paper_canary')).toMatchObject({
      decision: 'hold',
      max_launches: 0,
      max_notional: 0,
      reason_codes: expect.arrayContaining(['torghut_max_notional_zero', 'market_context_stale']),
    })
    expect(packet(packets, 'torghut', 'live_micro_canary')).toMatchObject({
      decision: 'block',
      max_launches: 0,
      max_notional: 0,
    })
  })

  it('admits bounded repair when stale market-context evidence names the repair class', () => {
    const packets = build({
      torghutConsumerEvidence: torghutConsumerEvidence({
        max_notional: '0',
        decision: 'repair',
        reason_codes: ['market_context_stale', 'empirical_jobs_degraded'],
      }),
    })

    expect(packet(packets, 'repair', 'dispatch_repair')).toMatchObject({
      decision: 'repair_only',
      max_launches: 1,
      max_notional: 0,
      reason_codes: expect.arrayContaining(['market_context_stale', 'empirical_jobs_degraded']),
      required_repair_action: 'refresh Torghut market-context evidence',
    })
  })

  it('allows launch packets when runtime, source, controller, route, and Torghut evidence are current', () => {
    const packets = build()

    expect(packet(packets, 'plan', 'dispatch_normal')).toMatchObject({
      decision: 'allow',
      max_launches: 1,
      reason_codes: [],
    })
    expect(packet(packets, 'deployer', 'deploy_widen').decision).toBe('allow')
    expect(packet(packets, 'verify', 'merge_ready').decision).toBe('allow')
    expect(packet(packets, 'torghut', 'live_scale')).toMatchObject({
      decision: 'allow',
      max_notional: 1000,
    })
  })

  it('holds normal stage launch when failure-domain holdbacks report missing lease authority', () => {
    const packets = build({
      failureDomainLeases: failureDomainHoldbackLeases(),
    })

    expect(packet(packets, 'plan', 'dispatch_normal')).toMatchObject({
      decision: 'hold',
      failure_domain_leases: ['lease-set:missing-database'],
      max_launches: 0,
      reason_codes: expect.arrayContaining(['database.lease_missing']),
    })
    expect(packet(packets, 'repair', 'dispatch_repair')).toMatchObject({
      decision: 'allow',
      reason_codes: [],
    })
  })
})
