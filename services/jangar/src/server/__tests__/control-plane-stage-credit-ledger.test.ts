import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  ClearanceMarketLedger,
  ClearanceMarketRepairLot,
  ControlPlaneControllerWitnessQuorum,
  DatabaseStatus,
  StageClearancePacket,
  StageClearanceStage,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { buildStageCreditLedger, STAGE_CREDIT_LEDGER_DESIGN_ARTIFACT } from '~/server/control-plane-stage-credit-ledger'
import type { AgentRunIngestionStatus } from '~/server/control-plane-status-types'

const now = new Date('2026-05-13T04:30:00.000Z')
const freshUntil = '2026-05-13T04:32:00.000Z'

const database: DatabaseStatus = {
  configured: true,
  connected: true,
  status: 'healthy',
  message: '',
  latency_ms: 7,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 29,
    applied_count: 29,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260508_torghut_quant_pipeline_health_account_window_created_at_index',
    latest_applied: '20260508_torghut_quant_pipeline_health_account_window_created_at_index',
    missing_migrations: [],
    unexpected_migrations: [],
    message: '',
  },
}

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

const agentRunIngestion = (overrides: Partial<AgentRunIngestionStatus> = {}): AgentRunIngestionStatus => ({
  namespace: 'agents',
  status: 'healthy',
  message: 'AgentRun ingestion current',
  last_watch_event_at: now.toISOString(),
  last_resync_at: now.toISOString(),
  untouched_run_count: 0,
  oldest_untouched_age_seconds: null,
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
  message: 'controller witness current',
  witness_refs: ['controller-witness:agentrun-ingestion'],
  deployment_available: true,
  watch_epoch_current: true,
  controller_self_report_current: true,
  witnesses: [],
  rollback_target: null,
  ...overrides,
})

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  candidate_id: 'chip-paper-microbar-composite@execution-proof',
  dataset_snapshot_ref: 'dataset:current',
  max_notional: '0',
  route_repair_value: 14,
  decision: 'repair',
  route_warrant_id: 'route-warrant:repair',
  route_warrant_state: 'repair_only',
  route_warrant_repair_packet_ids: ['route-warrant-repair:tca'],
  reason_codes: ['empirical_jobs_degraded', 'forecast_registry_degraded'],
  message: 'torghut consumer evidence repair-only',
  ...overrides,
})

const packet = (
  stage: StageClearanceStage,
  actionClass: ActionSloBudgetActionClass,
  decision: StageClearancePacket['decision'],
  reasonCodes: string[] = [],
): StageClearancePacket => ({
  schema_version: 'jangar.stage-clearance-packet.v1',
  packet_id: `stage-clearance:${stage}:${actionClass}:test`,
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  namespace: 'agents',
  swarm_name: 'jangar-control-plane',
  stage,
  action_class: actionClass,
  governing_requirement_refs: ['swarm-validation-contract:every-run-cites-governing-requirement'],
  source_rollout_truth_ref: 'source-rollout-truth:current',
  controller_witness_ref: 'controller-witness:current',
  agentrun_ingestion_ref: 'agentrun-ingestion:current',
  execution_trust_ref: 'execution-trust:current',
  material_action_verdict_ref: `material-action-verdict:${actionClass}`,
  route_stability_ref: 'route-stability:current',
  torghut_consumer_evidence_ref: 'torghut-route-proven-profit:current',
  failure_domain_leases: [],
  provider_capacity_ref: null,
  decision,
  max_launches: decision === 'allow' || decision === 'repair_only' ? 1 : 0,
  max_notional: actionClass === 'paper_canary' || actionClass === 'live_micro_canary' ? 0 : 0,
  ttl_seconds: 120,
  reason_codes: reasonCodes,
  required_repair_action: reasonCodes[0] ? `repair ${reasonCodes[0]}` : null,
  rollback_target: 'JANGAR_STAGE_CLEARANCE_ENFORCEMENT=observe',
})

const repairLot: ClearanceMarketRepairLot = {
  lot_id: 'clearance-repair-lot:empirical',
  warrant_id: 'repair-warrant:empirical',
  value_gate: 'failed_agentrun_rate',
  failure_mode: 'empirical_jobs',
  action_class: 'dispatch_repair',
  decision: 'repair_only',
  score: 90,
  expected_unblock_value: 4,
  max_dispatches: 1,
  max_runtime_seconds: 1800,
  max_notional: 0,
  reason_codes: ['empirical_jobs_degraded'],
  evidence_refs: ['repair-warrant:empirical'],
  rollback_target: 'hold repair dispatch',
}

const clearanceLedger = (
  stageAdmissions: ClearanceMarketLedger['stage_admission'],
  overrides: Partial<ClearanceMarketLedger> = {},
): ClearanceMarketLedger => ({
  schema_version: 'jangar.clearance-market.v1',
  ledger_id: 'clearance-market:agents:test',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  governing_design_refs: ['docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md'],
  observed_revision: {
    source_head_sha: 'source:current',
    gitops_revision: 'gitops:current',
  },
  evidence_mode: 'shadow',
  authority_splits: [],
  retained_failure_debt: [
    {
      debt_id: 'clearance-failure-debt:7d:test',
      window: '7d',
      state: 'projection_limited',
      failed_count: null,
      backoff_count: null,
      running_count: null,
      data_confidence: 'low',
      reason_codes: ['retained_failure_7d_projection_not_collected'],
      evidence_refs: ['agents_control_plane.resources_current:retained:7d'],
    },
  ],
  rollout_truth_settlement: {
    settlement_id: 'clearance-rollout-settlement:allow',
    source_head_sha: 'source:current',
    gitops_revision: 'gitops:current',
    desired_image_refs: [],
    live_image_refs: [],
    deployment_availability: [],
    route_health: [],
    database_projection: {
      mode: 'status_projection',
      status: 'healthy',
      evidence_ref: 'database:healthy',
    },
    downstream_evidence_refs: [],
    pr_to_rollout_latency_seconds: null,
    decision: 'allow',
    blockers: [],
  },
  action_clearance: [],
  repair_lots: [repairLot],
  stage_admission: stageAdmissions,
  handoff_contract: {
    value_gates: ['failed_agentrun_rate', 'pr_to_rollout_latency', 'ready_status_truth'],
    rollback_target: 'JANGAR_CLEARANCE_MARKET_ENABLED=false',
    status: 'hold',
  },
  ...overrides,
})

const stageAdmission = (
  stage: StageClearanceStage,
  actionClass: ActionSloBudgetActionClass,
  decision: 'allow' | 'repair_only' | 'hold' | 'block',
  selectedRepairLotRef: string | null = null,
  reasonCodes: string[] = [],
): ClearanceMarketLedger['stage_admission'][number] => ({
  admission_id: `clearance-stage:${stage}:${actionClass}:test`,
  stage,
  action_class: actionClass,
  decision,
  packet_ref: `stage-clearance:${stage}:${actionClass}:test`,
  selected_repair_lot_ref: selectedRepairLotRef,
  reason_codes: reasonCodes,
  evidence_refs: [`stage-clearance:${stage}:${actionClass}:test`],
})

const account = (
  ledger: ReturnType<typeof buildStageCreditLedger>,
  stage: StageClearanceStage,
  actionClass: ActionSloBudgetActionClass,
) => {
  const found = ledger.stage_accounts.find((entry) => entry.stage === stage && entry.action_class === actionClass)
  expect(found).toBeTruthy()
  return found!
}

describe('control-plane stage credit ledger', () => {
  it('gives held normal stages zero spendable credit and no runner future', () => {
    const packets = [
      packet('plan', 'dispatch_normal', 'hold', [
        'controller_witness_split',
        'agentrun_ingestion_not_current',
        'source_rollout_truth_hold',
      ]),
    ]
    const ledger = buildStageCreditLedger({
      now,
      namespace: 'agents',
      database,
      workflows: workflows({ recent_failed_jobs: 1 }),
      agentRunIngestion: agentRunIngestion({ status: 'unknown', message: 'agents controller not started' }),
      controllerWitness: controllerWitness({ decision: 'repair_only', controller_self_report_current: false }),
      stageClearancePackets: packets,
      clearanceMarketLedger: clearanceLedger([
        stageAdmission('plan', 'dispatch_normal', 'hold', null, ['source_rollout_truth_hold']),
      ]),
      torghutConsumerEvidence: torghutEvidence(),
    })

    const plan = account(ledger, 'plan', 'dispatch_normal')
    expect(plan).toMatchObject({
      decision: 'hold',
      available_credit: 0,
      minimum_spend: 50,
      max_concurrent_runs: 0,
      source_rollout_tax: 45,
      reason_codes: expect.arrayContaining(['stage_credit_insufficient', 'source_rollout_truth_hold']),
    })
    expect(ledger.runner_slot_futures).toEqual([])
  })

  it('opens one bounded runner future for a settled zero-notional repair lot', () => {
    const packets = [packet('repair', 'dispatch_repair', 'repair_only', ['empirical_jobs_degraded'])]
    const ledger = buildStageCreditLedger({
      now,
      namespace: 'agents',
      database,
      workflows: workflows(),
      agentRunIngestion: agentRunIngestion(),
      controllerWitness: controllerWitness(),
      stageClearancePackets: packets,
      clearanceMarketLedger: clearanceLedger([
        stageAdmission('repair', 'dispatch_repair', 'repair_only', 'clearance-repair-lot:empirical', [
          'empirical_jobs_degraded',
        ]),
      ]),
      torghutConsumerEvidence: torghutEvidence(),
    })

    const repair = account(ledger, 'repair', 'dispatch_repair')
    expect(repair).toMatchObject({
      decision: 'repair_only',
      selected_repair_lot_ref: 'clearance-repair-lot:empirical',
      max_concurrent_runs: 1,
      max_notional: 0,
    })
    expect(ledger.runner_slot_futures).toHaveLength(1)
    expect(ledger.runner_slot_futures[0]).toMatchObject({
      account_id: repair.account_id,
      action_class: 'dispatch_repair',
      max_dispatches: 1,
      max_notional: 0,
      settlement_state: 'open',
      required_receipts: expect.arrayContaining(['clearance-repair-lot:empirical', 'route-warrant:repair']),
    })
  })

  it('keeps live capital blocked when Torghut has zero notional or stale proof debt', () => {
    const packets = [packet('torghut', 'live_micro_canary', 'allow', [])]
    const ledger = buildStageCreditLedger({
      now,
      namespace: 'agents',
      database,
      workflows: workflows(),
      agentRunIngestion: agentRunIngestion(),
      controllerWitness: controllerWitness(),
      stageClearancePackets: packets,
      clearanceMarketLedger: clearanceLedger([stageAdmission('torghut', 'live_micro_canary', 'allow')]),
      torghutConsumerEvidence: torghutEvidence({
        max_notional: '0',
        decision: 'repair',
        reason_codes: ['evidence_clock_split', 'routeability_acceptance_blocked'],
      }),
    })

    const live = account(ledger, 'torghut', 'live_micro_canary')
    expect(live).toMatchObject({
      decision: 'block',
      base_credit: 0,
      available_credit: 0,
      capital_safety_tax: 100,
      max_concurrent_runs: 0,
    })
    expect(ledger.governing_design_refs).toContain(STAGE_CREDIT_LEDGER_DESIGN_ARTIFACT)
    expect(ledger.handoff_contract.status).toBe('block')
    expect(ledger.handoff_contract.value_gates).toEqual(
      expect.arrayContaining(['failed_agentrun_rate', 'pr_to_rollout_latency', 'ready_status_truth']),
    )
  })
})
