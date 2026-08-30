import { describe, expect, it } from 'vitest'

import type {
  SourceServingContractActionClass,
  SourceServingContractDecision,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  StageCreditAccount,
  StageCreditLedger,
  TorghutAlphaRepairClosureBoardRef,
  TorghutAlphaReadinessSettlementConveyorRef,
  TorghutConsumerEvidenceStatus,
  TorghutExecutableAlphaRepairReceiptSet,
} from '~/server/control-plane-status-types'
import {
  buildRevenueRepairSettlementCustody,
  REVENUE_REPAIR_SETTLEMENT_CUSTODY_DESIGN_ARTIFACT,
} from '~/server/control-plane-revenue-repair-settlement-custody'
import type { ControlPlaneRolloutHealth } from '~/server/control-plane-status-types'

const now = new Date('2026-05-14T09:15:00.000Z')

const rolloutHealth = (status: ControlPlaneRolloutHealth['status'] = 'healthy'): ControlPlaneRolloutHealth => ({
  status,
  observed_deployments: 2,
  degraded_deployments: status === 'healthy' ? 0 : 1,
  deployments: [],
  message: `rollout ${status}`,
})

const stageAccount = (
  decision: StageCreditAccount['decision'] = 'allow',
  overrides: Partial<StageCreditAccount> = {},
): StageCreditAccount => ({
  account_id: 'stage-credit-account:dispatch-repair',
  stage: 'implement',
  action_class: 'dispatch_repair',
  opening_credit: 100,
  base_credit: 100,
  evidence_freshness_bonus: 0,
  torghut_repair_value_credit: 0,
  rollout_truth_deposit: 0,
  failure_debt_tax: decision === 'allow' ? 0 : 50,
  controller_witness_tax: 0,
  source_rollout_tax: 0,
  capital_safety_tax: 0,
  runner_capacity_tax: 0,
  available_credit: decision === 'allow' || decision === 'repair_only' ? 100 : 0,
  minimum_spend: 50,
  max_concurrent_runs: decision === 'allow' || decision === 'repair_only' ? 1 : 0,
  max_runtime_seconds: 1200,
  max_notional: 0,
  decision,
  reason_codes: decision === 'allow' ? [] : ['stage_credit_insufficient'],
  required_repair_actions: [],
  evidence_refs: ['stage-credit-evidence:dispatch-repair'],
  selected_repair_lot_ref: null,
  rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  ...overrides,
})

const stageCreditLedger = (
  decision: StageCreditAccount['decision'] = 'allow',
  overrides: Partial<StageCreditLedger> = {},
): StageCreditLedger => ({
  schema_version: 'jangar.stage-credit-ledger.v1',
  ledger_id: 'stage-credit-ledger:dispatch-repair',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T09:16:00.000Z',
  governing_design_refs: ['docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md'],
  observed_revision: {
    source_head_sha: 'source-sha',
    gitops_revision: 'gitops-sha',
  },
  evidence_mode: 'observe',
  credit_epoch_id: 'stage-credit-epoch:dispatch-repair',
  stage_accounts: [stageAccount(decision)],
  runner_slot_futures: [],
  retained_failure_debt_refs: decision === 'allow' ? [] : ['clearance-failure-debt:verify-timeout'],
  settlement_policy: {
    mode: 'read_model_only',
    refund_condition: 'success refunds credit',
    burn_condition: 'failure burns credit',
    conversion_condition: 'repair closes selected lot',
    rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  },
  handoff_contract: {
    value_gates: ['failed_agentrun_rate', 'ready_status_truth'],
    status: decision,
    next_implementation_milestone: 'settle Torghut stage-custody hold',
    rollback_target: 'JANGAR_STAGE_CREDIT_LEDGER_MODE=observe',
  },
  ...overrides,
})

const sourceVerdict = (decision: SourceServingContractDecision = 'allow'): SourceServingContractVerdict => ({
  schema_version: 'jangar.source-serving-contract-verdict.v1',
  verdict_id: 'source-serving-verdict:dispatch-repair',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T09:16:00.000Z',
  repository: 'proompteng/lab',
  source_sha: 'source-sha',
  source_ci_run_id: 'source-ci:1',
  source_ci_conclusion: 'success',
  manifest_sha: 'gitops-sha',
  manifest_image_digest: 'sha256:manifest',
  argo_sync_revision: 'gitops-sha',
  argo_health: 'healthy',
  serving_revision: 'runtime',
  serving_build_commit: 'source-sha',
  serving_image_digest: 'sha256:manifest',
  required_contracts: [],
  observed_contracts: [],
  missing_contracts: [],
  contract_schema_mismatches: [],
  torghut_route_warrant_ref: 'route-warrant:current',
  torghut_repair_bid_settlement_ref: 'repair-bid-settlement:current',
  action_class: 'dispatch_repair',
  decision,
  source_serving_state: decision === 'allow' ? 'converged' : 'source_ahead',
  max_notional: 0,
  value_gate_impacts: ['routeable_candidate_count'],
  required_repair_receipts: ['torghut.alpha-readiness-settlement-receipt.v1'],
  blocking_reason_codes: decision === 'allow' ? [] : ['source_rollout_truth_hold'],
  evidence_refs: ['source-serving-evidence:dispatch-repair'],
  rollback_gate: 'hold rollout widening until source and serving converge',
})

const sourceServingExchange = (
  decision: SourceServingContractDecision = 'allow',
): SourceServingContractVerdictExchange => {
  const verdict = sourceVerdict(decision)
  const actionClass = verdict.action_class as SourceServingContractActionClass
  return {
    mode: 'observe',
    design_artifact:
      'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
    exchange_id: 'source-serving-contract-verdict-exchange:settlement-custody',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T09:16:00.000Z',
    namespace: 'agents',
    status: decision,
    source_sha: 'source-sha',
    serving_build_commit: 'source-sha',
    manifest_image_digest: 'sha256:manifest',
    serving_image_digest: 'sha256:manifest',
    required_contracts: [],
    observed_contracts: [],
    missing_contracts: [],
    verdict_refs: [verdict.verdict_id],
    allowed_action_classes: decision === 'allow' ? [actionClass] : [],
    repair_only_action_classes: decision === 'repair_only' ? [actionClass] : [],
    held_action_classes: decision === 'hold' ? [actionClass] : [],
    blocked_action_classes: decision === 'block' ? [actionClass] : [],
    reason_codes: decision === 'allow' ? [] : ['source_rollout_truth_hold'],
    verdicts: [verdict],
    rollback_target: 'ignore source-serving contract verdict exchange',
  }
}

const settlementConveyor = (
  overrides: Partial<TorghutAlphaReadinessSettlementConveyorRef> = {},
): TorghutAlphaReadinessSettlementConveyorRef => ({
  schema_version: 'torghut.alpha-readiness-settlement-conveyor-ref.v1',
  conveyor_schema_version: 'torghut.alpha-readiness-settlement-conveyor.v1',
  conveyor_id: 'alpha-readiness-settlement-conveyor:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T09:30:00.000Z',
  status: 'settling',
  settlement_state: 'pending',
  reason_codes: [],
  selected_hypothesis_id: 'H-MICRO-01',
  selected_value_gate: 'routeable_candidate_count',
  routeable_candidate_count_before: 0,
  routeable_candidate_count_after: 0,
  measured_routeable_candidate_delta: 0,
  active_no_delta_lease_count: 0,
  required_receipt: 'torghut.alpha-readiness-settlement-receipt.v1',
  validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
  no_delta_release_key: 'alpha-readiness-no-delta:H-MICRO-01:window-a',
  repeat_launch_decision: 'allow',
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  rollback_target: 'stop emitting alpha_readiness_settlement_conveyor and keep Torghut max_notional=0',
  ...overrides,
})

const closureBoard = (
  overrides: Partial<TorghutAlphaRepairClosureBoardRef> = {},
): TorghutAlphaRepairClosureBoardRef => ({
  schema_version: 'torghut.alpha-repair-closure-board-ref.v1',
  board_id: 'alpha-repair-closure-board:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T09:30:00.000Z',
  status: 'selected',
  reason_codes: [],
  top_closure_id: 'alpha-repair-closure:current',
  selected_value_gate: 'routeable_candidate_count',
  required_output_receipt: 'torghut.executable-alpha-receipts.v1',
  settlement_market_id: 'alpha-closure-settlement-market:current',
  settlement_market_status: 'pending_no_delta',
  selected_hypothesis_id: 'H-MICRO-01',
  selected_repair_class: 'evidence_window_refresh',
  required_settlement_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
  active_dedupe_key: 'alpha-closure-dedupe:H-MICRO-01:window-a',
  no_delta_budget_state: 'consumed',
  no_delta_debt_count: 1,
  next_allowed_attempt_after: null,
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  release_conditions: ['evidence_window_changes', 'blocker_set_changes'],
  validation_commands: ['uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py'],
  rollback_target: 'disable alpha_repair_closure_board emission and keep Torghut max_notional=0',
  ...overrides,
})

const executableAlphaReceipts = (
  overrides: Partial<TorghutExecutableAlphaRepairReceiptSet> = {},
): TorghutExecutableAlphaRepairReceiptSet => ({
  schema_version: 'torghut.executable-alpha-repair-receipts.v1',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T09:30:00.000Z',
  source_revenue_repair_ref: 'torghut-revenue-repair-digest:current',
  status: 'selected',
  governing_design_ref:
    'docs/torghut/design-system/v6/197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md',
  selected_receipt_id: 'executable-alpha-repair-receipt:current',
  selected_receipt: {
    schema_version: 'torghut.executable-alpha-repair-receipt.v1',
    receipt_id: 'executable-alpha-repair-receipt:current',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T09:30:00.000Z',
    source_revenue_repair_ref: 'torghut-revenue-repair-digest:current',
    hypothesis_id: 'H-MICRO-01',
    repair_class: 'evidence_window_refresh',
    target_value_gate: 'routeable_candidate_count',
    reason_codes: ['hypothesis_not_promotion_eligible'],
    account_id: 'PA3SX7FYNUTF',
    window: '15m',
    trading_mode: 'paper',
    candidate_id: 'chip-paper-microbar-composite@execution-proof',
    strategy_id: 'microbar_volume_continuation_long_top2_chip_v1@paper',
    lineage_status: 'ready',
    evidence_window_status: 'stale',
    alpha_readiness_state: 'blocked',
    expected_unblock_value: 2,
    expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
    required_input_refs: ['capital-replay:current'],
    required_output_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt'],
    validation_commands: ['uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py'],
    max_notional: '0',
    capital_rule: 'zero_notional_repair_only',
    no_delta_settlement_required: true,
    jangar_reentry: {
      required_material_reentry_receipt: 'jangar.material-reentry-receipt.v1',
      action_class: 'dispatch_repair',
      max_parallelism: 1,
      max_runtime_seconds: 1200,
      value_gates: ['routeable_candidate_count'],
      rollback_target: 'keep max_notional=0 and live submit disabled',
    },
    rollback_target: 'stop emitting executable_alpha_repair_receipts and keep Torghut max_notional=0',
  },
  receipt_count: 1,
  receipts: [],
  target_value_gate: 'routeable_candidate_count',
  routeable_candidate_count_before: 0,
  max_notional: '0',
  capital_rule: 'zero_notional_repair_only',
  reason_codes: [],
  rollback_target: 'stop emitting executable_alpha_repair_receipts and keep Torghut max_notional=0',
  ...overrides,
})

const torghutEvidence = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:current',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T09:16:00.000Z',
  candidate_id: 'chip-paper-microbar-composite@execution-proof',
  dataset_snapshot_ref: 'torghut-chip-full-day',
  max_notional: '0',
  revenue_repair_business_state: 'repair_only',
  revenue_repair_ready: false,
  revenue_repair_queue: [
    {
      code: 'repair_alpha_readiness',
      reason: 'hypothesis_not_promotion_eligible',
      dimension: 'alpha_readiness',
      action: 'clear_hypothesis_blockers_before_capital',
      priority: 70,
      expected_unblock_value: 2,
      source: 'proof_floor.repair_ladder',
      value_gate: 'routeable_candidate_count',
      required_output_receipt: 'torghut.executable-alpha-receipts.v1',
      required_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt'],
      max_notional: '0',
      capital_rule: 'zero_notional_repair_only',
      observed_count: 0,
    },
  ],
  alpha_readiness_settlement_conveyor: settlementConveyor(),
  reason_codes: [],
  message: 'torghut consumer evidence receipt current',
  ...overrides,
})

const build = (
  input: {
    torghut?: Partial<TorghutConsumerEvidenceStatus>
    stageDecision?: StageCreditAccount['decision']
    sourceDecision?: SourceServingContractDecision
    rollout?: ControlPlaneRolloutHealth['status']
  } = {},
) =>
  buildRevenueRepairSettlementCustody({
    now,
    namespace: 'agents',
    rolloutHealth: rolloutHealth(input.rollout),
    sourceServingContractVerdictExchange: sourceServingExchange(input.sourceDecision),
    stageCreditLedger: stageCreditLedger(input.stageDecision),
    torghutConsumerEvidence: torghutEvidence(input.torghut),
  })

describe('buildRevenueRepairSettlementCustody', () => {
  it('allows current zero-notional alpha-readiness conveyor refs', () => {
    const custody = build()

    expect(custody).toMatchObject({
      schema_version: 'jangar.revenue-repair-settlement-custody.v1',
      decision: 'allow',
      torghut_conveyor_ref: 'alpha-readiness-settlement-conveyor:current',
      selected_hypothesis_id: 'H-MICRO-01',
      selected_value_gate: 'routeable_candidate_count',
      no_delta_release_state: 'clear',
      validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py',
    })
    expect(custody.governing_design_refs).toContain(REVENUE_REPAIR_SETTLEMENT_CUSTODY_DESIGN_ARTIFACT)
    expect(custody.reason_codes).toEqual([])
  })

  it('holds dispatch when the compact conveyor ref is missing', () => {
    const custody = build({ torghut: { alpha_readiness_settlement_conveyor: null } })

    expect(custody.decision).toBe('hold')
    expect(custody.reason_codes).toContain('alpha_readiness_settlement_conveyor_missing')
    expect(custody.no_delta_release_state).toBe('missing')
  })

  it('uses executable alpha receipts when revenue repair topline is queue-only', () => {
    const custody = build({
      torghut: {
        revenue_repair_business_state: null,
        revenue_repair_ready: null,
        alpha_readiness_settlement_conveyor: null,
        executable_alpha_repair_receipts: executableAlphaReceipts(),
      },
    })

    expect(custody.decision).toBe('allow')
    expect(custody.torghut_conveyor_ref).toBe('executable-alpha-repair-receipt:current')
    expect(custody.selected_hypothesis_id).toBe('H-MICRO-01')
    expect(custody.selected_value_gate).toBe('routeable_candidate_count')
    expect(custody.validation_command).toBe(
      'uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py',
    )
    expect(custody.reason_codes).not.toContain('business_state_missing')
    expect(custody.reason_codes).not.toContain('alpha_readiness_settlement_conveyor_missing')
    expect(custody.governing_design_refs).toContain(
      'docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md',
    )
  })

  it('denies active no-delta closure boards without reporting the alpha evidence missing', () => {
    const custody = build({
      torghut: {
        revenue_repair_business_state: null,
        revenue_repair_ready: null,
        alpha_readiness_settlement_conveyor: null,
        alpha_repair_closure_board: closureBoard(),
      },
    })

    expect(custody.decision).toBe('deny')
    expect(custody.torghut_conveyor_ref).toBe('alpha-repair-closure-board:current')
    expect(custody.no_delta_release_key).toBe('alpha-closure-dedupe:H-MICRO-01:window-a')
    expect(custody.no_delta_release_state).toBe('active')
    expect(custody.reason_codes).toEqual(
      expect.arrayContaining([
        'active_no_delta_lease',
        'alpha_closure_no_delta_budget_consumed',
        'alpha_closure_settlement_market_pending_no_delta',
        'alpha_closure_no_delta_debt_active',
      ]),
    )
    expect(custody.reason_codes).not.toContain('business_state_missing')
    expect(custody.reason_codes).not.toContain('alpha_readiness_settlement_conveyor_missing')
  })

  it('denies stale conveyor refs', () => {
    const custody = build({
      torghut: {
        alpha_readiness_settlement_conveyor: settlementConveyor({
          fresh_until: '2026-05-14T09:14:59.000Z',
        }),
      },
    })

    expect(custody.decision).toBe('deny')
    expect(custody.reason_codes).toContain('alpha_readiness_settlement_conveyor_stale')
  })

  it('denies active no-delta leases for an unchanged release key', () => {
    const custody = build({
      torghut: {
        alpha_readiness_settlement_conveyor: settlementConveyor({
          status: 'no_delta',
          settlement_state: 'no_delta',
          active_no_delta_lease_count: 1,
          repeat_launch_decision: 'deny',
        }),
      },
    })

    expect(custody.decision).toBe('deny')
    expect(custody.reason_codes).toContain('active_no_delta_lease')
    expect(custody.no_delta_release_state).toBe('active')
  })

  it('denies nonzero notional conveyor refs', () => {
    const custody = build({
      torghut: {
        alpha_readiness_settlement_conveyor: settlementConveyor({
          max_notional: '10',
        }),
      },
    })

    expect(custody.decision).toBe('deny')
    expect(custody.reason_codes).toContain('capital_notional_nonzero')
  })

  it('holds dispatch when stage credit has retained failure debt', () => {
    const custody = build({ stageDecision: 'hold' })

    expect(custody.decision).toBe('hold')
    expect(custody.reason_codes).toEqual(expect.arrayContaining(['stage_credit_hold', 'stage_credit_insufficient']))
    expect(custody.stage_health.retained_failure_debt_refs).toEqual(['clearance-failure-debt:verify-timeout'])
  })

  it('holds dispatch when rollout proof is incomplete', () => {
    const custody = build({ sourceDecision: 'hold', rollout: 'degraded' })

    expect(custody.decision).toBe('hold')
    expect(custody.reason_codes).toEqual(
      expect.arrayContaining(['source_serving_hold', 'source_rollout_truth_hold', 'rollout_health_degraded']),
    )
    expect(custody.rollout_proof.source_serving_decision).toBe('hold')
  })
})
