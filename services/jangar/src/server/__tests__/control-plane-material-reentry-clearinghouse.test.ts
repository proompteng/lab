import { describe, expect, it } from 'vitest'

import type {
  ActionSloBudgetActionClass,
  MaterialReentryReceipt,
  ReadyTruthArbiter,
  RepairBidAdmissionState,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
} from '~/data/agents-control-plane'
import {
  buildMaterialReentryClearinghouse,
  MATERIAL_REENTRY_CLEARINGHOUSE_DESIGN_ARTIFACT,
} from '~/server/control-plane-material-reentry-clearinghouse'
import type { ControlPlaneWatchReliability, DatabaseStatus } from '~/server/control-plane-status-types'

const now = new Date('2026-05-14T00:10:00.000Z')

const healthyDatabase = (): DatabaseStatus => ({
  configured: true,
  connected: true,
  status: 'healthy',
  message: 'database healthy',
  latency_ms: 4,
  migration_consistency: {
    status: 'healthy',
    migration_table: 'kysely_migration',
    registered_count: 1,
    applied_count: 1,
    unapplied_count: 0,
    unexpected_count: 0,
    latest_registered: '20260513_material_reentry',
    latest_applied: '20260513_material_reentry',
    missing_migrations: [],
    unexpected_migrations: [],
    message: 'migrations current',
  },
})

const watchReliability = (overrides: Partial<ControlPlaneWatchReliability> = {}): ControlPlaneWatchReliability => ({
  status: 'healthy',
  window_minutes: 15,
  observed_streams: 1,
  total_events: 12,
  total_errors: 0,
  total_restarts: 0,
  streams: [
    {
      resource: 'agentruns.agents.proompteng.ai',
      namespace: 'agents',
      events: 12,
      errors: 0,
      restarts: 0,
      last_seen_at: now.toISOString(),
      error_reasons: {},
      restart_reasons: {},
    },
  ],
  ...overrides,
})

const readyTruth = (overrides: Partial<ReadyTruthArbiter> = {}): ReadyTruthArbiter => ({
  schema_version: 'jangar.ready-truth-arbiter.v1',
  mode: 'observe',
  verdict_id: 'ready-truth:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T00:11:00.000Z',
  namespace: 'agents',
  governing_design_refs: ['docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md'],
  serving_readiness: 'ok',
  material_readiness: 'hold',
  argo_revision: 'main',
  argo_health: 'healthy',
  workload_rollout_ref: 'rollout:agents',
  controller_witness_ref: 'controller-witness:test',
  runtime_adapter_refs: ['runtime:job'],
  stage_credit_ledger_ref: 'stage-credit-ledger:test',
  source_serving_verdict_ref: 'source-serving:test',
  torghut_repair_receipt_ref: 'repair-bid-admission:dispatch',
  retained_failure_debt_refs: [],
  projection_foreclosure_notary_ref: null,
  projection_authority_decision: null,
  projection_claim_totals_by_state: null,
  projection_required_repair_actions: [],
  ready_status_truth_reasons: ['source_rollout_truth_hold'],
  allowed_action_classes: ['serve_readonly', 'torghut_observe'],
  repair_only_action_classes: [],
  held_action_classes: ['dispatch_repair', 'dispatch_normal', 'deploy_widen', 'merge_ready', 'paper_canary'],
  blocked_action_classes: ['live_micro_canary', 'live_scale'],
  merge_gate_receipt: {
    receipt_id: 'ready-truth-merge:test',
    action_class: 'merge_ready',
    decision: 'hold',
    required_evidence_refs: ['source-rollout:test'],
    reason_codes: ['source_rollout_truth_hold'],
  },
  deployer_receipt: {
    receipt_id: 'ready-truth-deploy:test',
    action_class: 'deploy_widen',
    decision: 'hold',
    required_evidence_refs: ['source-rollout:test'],
    reason_codes: ['source_rollout_truth_hold'],
  },
  rollback_target: 'set ready truth mode to observe and keep material actions held by existing gates',
  ...overrides,
})

const sourceVerdict = (
  actionClass: SourceServingContractVerdict['action_class'],
  decision: SourceServingContractVerdict['decision'] = 'allow',
  overrides: Partial<SourceServingContractVerdict> = {},
): SourceServingContractVerdict => ({
  schema_version: 'jangar.source-serving-contract-verdict.v1',
  verdict_id: `source-serving-verdict:${actionClass}`,
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T00:11:00.000Z',
  repository: 'proompteng/lab',
  source_sha: 'source-sha',
  source_ci_run_id: 'ci:1',
  source_ci_conclusion: 'success',
  manifest_sha: 'manifest-sha',
  manifest_image_digest: 'sha256:manifest',
  argo_sync_revision: 'source-sha',
  argo_health: 'healthy',
  serving_revision: 'jangar-1',
  serving_build_commit: 'source-sha',
  serving_image_digest: 'sha256:manifest',
  required_contracts: ['route_warrant_exchange', 'repair_bid_settlement_ledger'],
  observed_contracts: ['route_warrant_exchange', 'repair_bid_settlement_ledger'],
  missing_contracts: [],
  contract_schema_mismatches: [],
  torghut_route_warrant_ref: 'route-warrant:test',
  torghut_repair_bid_settlement_ref: 'repair-bid-settlement-ledger:test',
  action_class: actionClass,
  decision,
  source_serving_state: decision === 'allow' ? 'converged' : 'source_ahead',
  max_notional: 0,
  value_gate_impacts: ['pr_to_rollout_latency'],
  required_repair_receipts: decision === 'allow' ? [] : ['jangar.source-rollout-receipt.v1'],
  blocking_reason_codes: decision === 'allow' ? [] : ['manifest_image_digest_missing'],
  evidence_refs: ['source-rollout:test'],
  rollback_gate: 'roll back to the last image with source-to-serving digest parity',
  ...overrides,
})

const sourceExchange = (
  verdicts: SourceServingContractVerdict[] = [
    sourceVerdict('serve_readonly'),
    sourceVerdict('dispatch_repair'),
    sourceVerdict('dispatch_normal'),
    sourceVerdict('deploy_widen'),
    sourceVerdict('merge_ready'),
    sourceVerdict('paper_support'),
    sourceVerdict('live_support'),
  ],
): SourceServingContractVerdictExchange => ({
  mode: 'observe',
  design_artifact: 'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
  exchange_id: 'source-serving-exchange:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T00:11:00.000Z',
  namespace: 'agents',
  status: verdicts.some((verdict) => verdict.decision === 'block')
    ? 'block'
    : verdicts.some((verdict) => verdict.decision === 'hold')
      ? 'hold'
      : 'allow',
  source_sha: 'source-sha',
  serving_build_commit: 'source-sha',
  manifest_image_digest: 'sha256:manifest',
  serving_image_digest: 'sha256:manifest',
  required_contracts: ['route_warrant_exchange', 'repair_bid_settlement_ledger'],
  observed_contracts: ['route_warrant_exchange', 'repair_bid_settlement_ledger'],
  missing_contracts: [],
  verdict_refs: verdicts.map((verdict) => verdict.verdict_id),
  allowed_action_classes: verdicts
    .filter((verdict) => verdict.decision === 'allow')
    .map((verdict) => verdict.action_class),
  repair_only_action_classes: [],
  held_action_classes: verdicts.filter((verdict) => verdict.decision === 'hold').map((verdict) => verdict.action_class),
  blocked_action_classes: verdicts
    .filter((verdict) => verdict.decision === 'block')
    .map((verdict) => verdict.action_class),
  reason_codes: [...new Set(verdicts.flatMap((verdict) => verdict.blocking_reason_codes))],
  verdicts,
  rollback_target: 'fall back to source rollout truth exchange',
})

const stageCreditLedger = (
  actionClass: ActionSloBudgetActionClass,
  decision: StageCreditLedger['stage_accounts'][number]['decision'] = 'allow',
): StageCreditLedger => ({
  schema_version: 'jangar.stage-credit-ledger.v1',
  ledger_id: 'stage-credit-ledger:test',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T00:11:00.000Z',
  governing_design_refs: [
    'docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md',
  ],
  observed_revision: {
    source_head_sha: 'source-sha',
    gitops_revision: 'source-sha',
  },
  evidence_mode: 'observe',
  credit_epoch_id: 'stage-credit-epoch:test',
  stage_accounts: [
    {
      account_id: `stage-credit-account:${actionClass}`,
      stage: actionClass === 'deploy_widen' || actionClass === 'merge_ready' ? 'verify' : 'implement',
      action_class: actionClass,
      opening_credit: 1,
      base_credit: 1,
      evidence_freshness_bonus: 0,
      torghut_repair_value_credit: 0,
      rollout_truth_deposit: 0,
      failure_debt_tax: 0,
      controller_witness_tax: 0,
      source_rollout_tax: 0,
      capital_safety_tax: 0,
      runner_capacity_tax: 0,
      available_credit: decision === 'allow' ? 1 : 0,
      minimum_spend: 1,
      max_concurrent_runs: decision === 'allow' ? 1 : 0,
      max_runtime_seconds: 1200,
      max_notional: 0,
      decision,
      reason_codes: decision === 'allow' ? [] : ['stage_credit_insufficient'],
      required_repair_actions: decision === 'allow' ? [] : ['restore stage credit'],
      evidence_refs: ['stage-credit-evidence:test'],
      selected_repair_lot_ref: null,
      rollback_target: 'set stage credit mode to observe',
    },
  ],
  runner_slot_futures: [],
  retained_failure_debt_refs: [],
  settlement_policy: {
    mode: 'read_model_only',
    refund_condition: 'terminal success',
    burn_condition: 'terminal no-delta',
    conversion_condition: 'receipt accepted',
    rollback_target: 'disable stage credit emission',
  },
  handoff_contract: {
    value_gates: ['failed_agentrun_rate', 'pr_to_rollout_latency', 'ready_status_truth'],
    status: decision,
    next_implementation_milestone: 'restore stage credit',
    rollback_target: 'set stage credit mode to observe',
  },
})

const repairAdmission = (overrides: Partial<RepairBidAdmissionState> = {}): RepairBidAdmissionState => ({
  schema_version: 'jangar.repair-bid-admission-state.v1',
  mode: 'observe',
  design_artifact: 'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T00:11:00.000Z',
  status: 'block',
  torghut_settlement_ledger_ref: 'repair-bid-settlement-ledger:test',
  receipts: [
    {
      schema_version: 'jangar.repair-bid-admission-receipt.v1',
      receipt_id: 'repair-bid-admission:dispatch',
      generated_at: now.toISOString(),
      fresh_until: '2026-05-14T00:11:00.000Z',
      repository: 'proompteng/lab',
      branch: 'codex/swarm-jangar-control-plane',
      swarm_name: 'torghut-quant',
      stage: 'implement',
      action_class: 'dispatch_repair',
      decision: 'allow',
      torghut_settlement_ledger_ref: 'repair-bid-settlement-ledger:test',
      torghut_compacted_lot_refs: ['compacted-repair-lot:promotion'],
      active_dedupe_keys: [],
      admitted_lot_ids: ['compacted-repair-lot:promotion'],
      held_lot_ids: [],
      denied_reason_codes: [],
      max_parallelism: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
      validation_commands: ['pytest services/torghut/tests/test_repair_bid_settlement.py -k promotion_custody'],
      rollback_gate: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
    },
    {
      schema_version: 'jangar.repair-bid-admission-receipt.v1',
      receipt_id: 'repair-bid-admission:live-scale',
      generated_at: now.toISOString(),
      fresh_until: '2026-05-14T00:11:00.000Z',
      repository: 'proompteng/lab',
      branch: 'codex/swarm-jangar-control-plane',
      swarm_name: 'torghut-quant',
      stage: 'implement',
      action_class: 'live_scale',
      decision: 'block',
      torghut_settlement_ledger_ref: 'repair-bid-settlement-ledger:test',
      torghut_compacted_lot_refs: ['compacted-repair-lot:promotion'],
      active_dedupe_keys: [],
      admitted_lot_ids: [],
      held_lot_ids: ['compacted-repair-lot:promotion'],
      denied_reason_codes: ['torghut_repair_bid_settlement_repair_only'],
      max_parallelism: 0,
      max_runtime_seconds: 0,
      max_notional: 0,
      validation_commands: [],
      rollback_gate: 'keep live submission disabled',
    },
  ],
  dispatch_tickets: [
    {
      schema_version: 'jangar.repair-lot-dispatch-ticket.v1',
      ticket_id: 'repair-lot-dispatch-ticket:promotion',
      admission_receipt_id: 'repair-bid-admission:dispatch',
      torghut_lot_id: 'compacted-repair-lot:promotion',
      lot_class: 'promotion_custody',
      target_value_gate: 'routeable_candidate_count',
      dedupe_key: 'PA3SX7FYNUTF:15m:promotion_custody',
      required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
      launch_allowed: true,
      launch_reason: 'current_zero_notional_compacted_lot',
      stop_conditions: ['fresh_until_expired'],
      max_runtime_seconds: 1200,
      max_notional: 0,
      expected_gate_delta: 'retire_alpha_readiness_not_promotion_eligible',
      rollback_target: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
    },
  ],
  admitted_lot_ids: ['compacted-repair-lot:promotion'],
  held_lot_ids: [],
  active_dedupe_keys: [],
  reason_codes: ['torghut_repair_bid_settlement_repair_only'],
  rollback_target: 'disable repair-bid admission enforcement and fall back to route evidence summaries',
  ...overrides,
})

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T00:11:00.000Z',
  candidate_id: null,
  dataset_snapshot_ref: null,
  max_notional: '0',
  reason_codes: ['alpha_readiness_not_promotion_eligible'],
  message: 'current',
  repair_bid_settlement_ledger_id: 'repair-bid-settlement-ledger:test',
  repair_bid_settlement_status: 'current',
  repair_bid_settlement_capital_decision: 'repair_only',
  repair_bid_settlement_max_notional: '0',
  repair_bid_settlement_selected_lot_ids: ['compacted-repair-lot:promotion'],
  repair_bid_settlement_dispatchable_lot_ids: ['compacted-repair-lot:promotion'],
  repair_bid_settlement_held_lot_ids: [],
  repair_bid_settlement_active_dedupe_keys: [],
  repair_bid_settlement_compacted_lots: [],
  alpha_readiness_strike_ledger: {
    schema_version: 'torghut.alpha-readiness-strike-ledger.v1',
    ledger_id: 'alpha-readiness-strike-ledger:test',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T00:11:00.000Z',
    account_id: 'PA3SX7FYNUTF',
    window: '15m',
    trading_mode: 'live',
    capital_stage: 'shadow',
    max_notional: '0',
    status: 'dispatchable',
    revenue_repair_digest_ref: 'torghut-revenue-repair-digest:test',
    selected_business_blocker: {
      code: 'repair_alpha_readiness',
      reason: 'alpha_readiness_not_promotion_eligible',
      value_gate: 'routeable_candidate_count',
      required_output_receipt: 'torghut.executable-alpha-receipts.v1',
    },
    routeable_candidate_count_before: 0,
    zero_notional_or_stale_evidence_rate_before: 1,
    promotion_custody_lot_ref: 'compacted-repair-lot:promotion',
    strike_slots: [],
    required_after_receipts: ['torghut.promotion-custody-decision-receipt.v1'],
    guarded_action_classes: ['paper_canary', 'live_micro_canary', 'live_scale'],
    reason_codes: [],
    rollback_target: 'disable alpha-readiness strike ledger and keep Torghut max_notional=0',
  },
  ...overrides,
})

const torghutEvidenceWithExecutableAlphaRepair = (): TorghutConsumerEvidenceStatus => {
  const selectedReceipt = {
    schema_version: 'torghut.executable-alpha-repair-receipt.v1' as const,
    receipt_id: 'executable-alpha-repair-receipt:current',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T00:11:00.000Z',
    source_revenue_repair_ref: 'torghut-revenue-repair-digest:test',
    hypothesis_id: 'H-CONT-01',
    repair_class: 'alpha_readiness',
    target_value_gate: 'routeable_candidate_count',
    reason_codes: ['alpha_readiness_not_promotion_eligible'],
    account_id: 'PA3SX7FYNUTF',
    window: '15m',
    trading_mode: 'live',
    candidate_id: 'chip-paper-microbar-composite@execution-proof',
    strategy_id: 'intraday_tsmom_v1@paper',
    lineage_status: 'ready',
    evidence_window_status: 'stale',
    alpha_readiness_state: 'blocked',
    expected_unblock_value: 4,
    expected_gate_delta: 'retire_post_cost_expectancy_non_positive',
    required_input_refs: ['capital-replay:current'],
    required_output_receipts: ['alpha_readiness_receipt', 'torghut.executable-alpha-receipts.v1'],
    validation_commands: ['uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py'],
    max_notional: '0',
    capital_rule: 'zero_notional_repair_only',
    no_delta_settlement_required: true,
    jangar_reentry: {
      required_material_reentry_receipt: 'jangar.material-reentry-receipt.v1',
      action_class: 'torghut_observe',
      max_parallelism: 1,
      max_runtime_seconds: 1200,
      value_gates: ['routeable_candidate_count'],
      rollback_target: 'keep max_notional=0 and live submit disabled',
    },
    rollback_target: 'stop emitting executable alpha repair receipts',
  }

  return torghutEvidence({
    executable_alpha_repair_receipts: {
      schema_version: 'torghut.executable-alpha-repair-receipts.v1',
      generated_at: now.toISOString(),
      fresh_until: '2026-05-14T00:11:00.000Z',
      source_revenue_repair_ref: 'torghut-revenue-repair-digest:test',
      status: 'selected',
      governing_design_ref:
        'docs/torghut/design-system/v6/197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md',
      selected_receipt_id: selectedReceipt.receipt_id,
      selected_receipt: selectedReceipt,
      receipt_count: 1,
      receipts: [selectedReceipt],
      target_value_gate: 'routeable_candidate_count',
      routeable_candidate_count_before: 0,
      max_notional: '0',
      capital_rule: 'zero_notional_repair_only',
      reason_codes: ['alpha_readiness_not_promotion_eligible'],
      rollback_target: 'stop emitting executable alpha repair receipts',
    },
  })
}

const receiptFor = (receipts: MaterialReentryReceipt[], actionClass: ActionSloBudgetActionClass) => {
  const receipt = receipts.find((entry) => entry.action_class === actionClass)
  expect(receipt).toBeDefined()
  return receipt!
}

describe('control-plane material reentry clearinghouse', () => {
  it('turns degraded AgentRun watch reliability into one required repair receipt per held action', () => {
    const clearinghouse = buildMaterialReentryClearinghouse({
      now,
      namespace: 'agents',
      database: healthyDatabase(),
      watchReliability: watchReliability({ status: 'degraded', total_errors: 2 }),
      readyTruthArbiter: readyTruth({
        allowed_action_classes: ['serve_readonly'],
        held_action_classes: ['dispatch_normal'],
        blocked_action_classes: [],
      }),
      sourceServingContractVerdictExchange: sourceExchange(),
      stageCreditLedger: stageCreditLedger('dispatch_normal', 'allow'),
      repairBidAdmission: repairAdmission(),
      torghutConsumerEvidence: torghutEvidence(),
    })

    const dispatchNormal = receiptFor(clearinghouse.action_receipts, 'dispatch_normal')

    expect(clearinghouse.design_artifact).toBe(MATERIAL_REENTRY_CLEARINGHOUSE_DESIGN_ARTIFACT)
    expect(dispatchNormal).toMatchObject({
      status: 'repair_required',
      receipt_class: 'watch_reliability_repair',
      required_output_receipt: 'jangar.watch-reliability-repair-receipt.v1',
      value_gates: expect.arrayContaining(['failed_agentrun_rate']),
    })
    expect(clearinghouse.primary_reentry_receipt_refs).toEqual([dispatchNormal.receipt_id])
  })

  it('selects a source rollout receipt before broad stage-credit reasons for deploy widening', () => {
    const clearinghouse = buildMaterialReentryClearinghouse({
      now,
      namespace: 'agents',
      database: healthyDatabase(),
      watchReliability: watchReliability(),
      readyTruthArbiter: readyTruth({
        allowed_action_classes: ['serve_readonly'],
        held_action_classes: ['deploy_widen'],
        blocked_action_classes: [],
      }),
      sourceServingContractVerdictExchange: sourceExchange([sourceVerdict('deploy_widen', 'hold')]),
      stageCreditLedger: stageCreditLedger('deploy_widen', 'hold'),
      repairBidAdmission: repairAdmission(),
      torghutConsumerEvidence: torghutEvidence(),
    })

    const deployWiden = receiptFor(clearinghouse.action_receipts, 'deploy_widen')

    expect(deployWiden).toMatchObject({
      receipt_class: 'source_rollout_receipt',
      required_output_receipt: 'jangar.source-rollout-receipt.v1',
      reason_codes: ['manifest_image_digest_missing'],
      source_hold_refs: ['source-serving-exchange:test', 'source-serving-verdict:deploy_widen'],
    })
  })

  it('surfaces the top alpha-readiness repair receipt while live capital remains blocked', () => {
    const clearinghouse = buildMaterialReentryClearinghouse({
      now,
      namespace: 'agents',
      database: healthyDatabase(),
      watchReliability: watchReliability(),
      readyTruthArbiter: readyTruth({
        material_readiness: 'hold',
        allowed_action_classes: ['serve_readonly', 'torghut_observe'],
        held_action_classes: [],
        blocked_action_classes: ['live_scale'],
      }),
      sourceServingContractVerdictExchange: sourceExchange([sourceVerdict('live_support')]),
      stageCreditLedger: null,
      repairBidAdmission: repairAdmission(),
      torghutConsumerEvidence: torghutEvidence(),
    })

    const observe = receiptFor(clearinghouse.action_receipts, 'torghut_observe')
    const liveScale = receiptFor(clearinghouse.action_receipts, 'live_scale')

    expect(observe).toMatchObject({
      decision: 'repair_only',
      status: 'repair_required',
      receipt_class: 'torghut_executable_alpha_repair',
      required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
      value_gates: ['routeable_candidate_count'],
      max_notional: 0,
      max_parallelism: 1,
    })
    expect(observe.reason_codes).toContain('top_revenue_required_output:torghut.executable-alpha-receipts.v1')
    expect(liveScale).toMatchObject({
      status: 'blocked',
      receipt_class: 'torghut_executable_alpha_repair',
      max_notional: 0,
    })
    expect(clearinghouse.blocked_action_classes).toContain('live_scale')
    expect(clearinghouse.top_repair_receipt_id).toBe(observe.receipt_id)
  })

  it('uses Torghut executable-alpha repair receipts for zero-notional reentry', () => {
    const clearinghouse = buildMaterialReentryClearinghouse({
      now,
      namespace: 'agents',
      database: healthyDatabase(),
      watchReliability: watchReliability(),
      readyTruthArbiter: readyTruth({
        material_readiness: 'hold',
        allowed_action_classes: ['serve_readonly', 'torghut_observe'],
        held_action_classes: [],
        blocked_action_classes: ['paper_canary'],
      }),
      sourceServingContractVerdictExchange: sourceExchange([sourceVerdict('paper_support')]),
      stageCreditLedger: null,
      repairBidAdmission: repairAdmission({ receipts: [], dispatch_tickets: [] }),
      torghutConsumerEvidence: torghutEvidenceWithExecutableAlphaRepair(),
    })

    const observe = receiptFor(clearinghouse.action_receipts, 'torghut_observe')
    const paperCanary = receiptFor(clearinghouse.action_receipts, 'paper_canary')

    expect(observe).toMatchObject({
      decision: 'repair_only',
      status: 'repair_required',
      receipt_class: 'torghut_executable_alpha_repair',
      required_output_receipt: 'torghut.executable-alpha-receipts.v1',
      value_gates: ['routeable_candidate_count'],
      max_parallelism: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
    })
    expect(observe.source_hold_refs).toContain('executable-alpha-repair-receipt:current')
    expect(paperCanary).toMatchObject({
      decision: 'block',
      status: 'blocked',
      receipt_class: 'torghut_executable_alpha_repair',
      max_notional: 0,
    })
    expect(paperCanary.reason_codes).toContain('torghut_alpha_repair_blocks_capital_reentry')
  })
})
