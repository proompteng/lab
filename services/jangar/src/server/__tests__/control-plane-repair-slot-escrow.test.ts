import { describe, expect, it } from 'vitest'

import type {
  EvidencePressureLedger,
  MaterialReentryClearinghouse,
  MaterialReentryReceipt,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
  TorghutExecutableAlphaRepairReceipt,
} from '~/server/control-plane-status-types'
import {
  buildRepairSlotEscrow,
  REPAIR_SLOT_ESCROW_DESIGN_ARTIFACT,
  REPAIR_SLOT_ESCROW_TORGHUT_DESIGN_ARTIFACT,
} from '~/server/control-plane-repair-slot-escrow'

const now = new Date('2026-05-14T00:10:00.000Z')
const freshUntil = '2026-05-14T00:11:00.000Z'

const executableAlphaReceipt = (
  overrides: Partial<TorghutExecutableAlphaRepairReceipt> = {},
): TorghutExecutableAlphaRepairReceipt => ({
  schema_version: 'torghut.executable-alpha-repair-receipt.v1',
  receipt_id: 'executable-alpha-repair-receipt:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  source_revenue_repair_ref: 'torghut-revenue-repair-digest:current',
  hypothesis_id: 'H-MICRO-01',
  repair_class: 'capital_replay_board_refresh',
  target_value_gate: 'routeable_candidate_count',
  reason_codes: ['hypothesis_not_promotion_eligible'],
  account_id: 'PA3SX7FYNUTF',
  window: '15m',
  trading_mode: 'live',
  candidate_id: 'chip-paper-microbar-composite@execution-proof',
  strategy_id: 'microbar_volume_continuation_long_top2_chip_v1@paper',
  lineage_status: 'ready',
  evidence_window_status: 'current',
  alpha_readiness_state: 'blocked',
  expected_unblock_value: 3,
  expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
  required_input_refs: ['capital-replay:current'],
  required_output_receipts: [
    'alpha_readiness_receipt',
    'hypothesis_promotion_receipt',
    'capital_replay_board',
    'torghut.executable-alpha-receipts.v1',
  ],
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
  rollback_target: 'stop emitting executable alpha repair receipts',
  ...overrides,
})

const torghutEvidence = (
  receiptOverrides: Partial<TorghutExecutableAlphaRepairReceipt> = {},
  overrides: Partial<TorghutConsumerEvidenceStatus> = {},
): TorghutConsumerEvidenceStatus => {
  const selectedReceipt = executableAlphaReceipt(receiptOverrides)
  return {
    status: 'current',
    endpoint: 'http://torghut/trading/consumer-evidence',
    receipt_id: 'torghut-route-proven-profit:current',
    generated_at: now.toISOString(),
    fresh_until: freshUntil,
    candidate_id: 'chip-paper-microbar-composite@execution-proof',
    dataset_snapshot_ref: 'torghut-chip-full-day-20260505',
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
        expected_unblock_value: 3,
        source: 'proof_floor.repair_ladder',
        value_gate: 'routeable_candidate_count',
        required_output_receipt: 'torghut.executable-alpha-receipts.v1',
        required_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt', 'capital_replay_board'],
        max_notional: '0',
        capital_rule: 'zero_notional_repair_only',
        observed_count: 1,
      },
    ],
    serving_revision: 'torghut-00394',
    build_commit: 'c9d34c004373e65aca89dfc6cf5608170fb91bee',
    alpha_readiness_strike_ledger: {
      schema_version: 'torghut.alpha-readiness-strike-ledger.v1',
      ledger_id: 'alpha-readiness-strike-ledger:current',
      generated_at: now.toISOString(),
      fresh_until: freshUntil,
      account_id: 'PA3SX7FYNUTF',
      window: '15m',
      trading_mode: 'live',
      capital_stage: 'shadow',
      max_notional: '0',
      status: 'dispatchable',
      revenue_repair_digest_ref: 'torghut-revenue-repair-digest:current',
      selected_business_blocker: {
        code: 'repair_alpha_readiness',
        reason: 'hypothesis_not_promotion_eligible',
        value_gate: 'routeable_candidate_count',
        required_output_receipt: 'torghut.executable-alpha-receipts.v1',
      },
      routeable_candidate_count_before: 0,
      zero_notional_or_stale_evidence_rate_before: 1,
      promotion_custody_lot_ref: 'compacted-repair-lot:promotion',
      strike_slots: [],
      required_after_receipts: ['alpha_readiness_receipt', 'hypothesis_promotion_receipt', 'capital_replay_board'],
      guarded_action_classes: ['paper_canary', 'live_micro_canary', 'live_scale'],
      reason_codes: [],
      rollback_target: 'disable alpha-readiness strike ledger and keep Torghut max_notional=0',
    },
    executable_alpha_repair_receipts: {
      schema_version: 'torghut.executable-alpha-repair-receipts.v1',
      generated_at: now.toISOString(),
      fresh_until: freshUntil,
      source_revenue_repair_ref: 'torghut-revenue-repair-digest:current',
      status: 'selected',
      governing_design_ref:
        'docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md',
      selected_receipt_id: selectedReceipt.receipt_id,
      selected_receipt: selectedReceipt,
      receipt_count: 1,
      receipts: [selectedReceipt],
      target_value_gate: 'routeable_candidate_count',
      routeable_candidate_count_before: 0,
      max_notional: '0',
      capital_rule: 'zero_notional_repair_only',
      reason_codes: ['hypothesis_not_promotion_eligible'],
      rollback_target: 'stop emitting executable alpha repair receipts',
    },
    reason_codes: ['hypothesis_not_promotion_eligible'],
    message: 'current',
    ...overrides,
  }
}

const materialReceipt = (selectedReceiptId = 'executable-alpha-repair-receipt:current'): MaterialReentryReceipt => ({
  schema_version: 'jangar.material-reentry-receipt.v1',
  receipt_id: 'material-reentry-receipt:dispatch-repair',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  namespace: 'agents',
  action_class: 'dispatch_repair',
  stage: 'implement',
  decision: 'repair_only',
  status: 'repair_required',
  receipt_class: 'torghut_executable_alpha_repair',
  source_hold_refs: ['torghut-revenue-repair-digest:current', selectedReceiptId],
  required_output_receipt: 'torghut.executable-alpha-receipts.v1',
  required_validation_commands: [
    'uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py',
  ],
  value_gates: ['routeable_candidate_count'],
  expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
  max_parallelism: 1,
  max_runtime_seconds: 1200,
  max_notional: 0,
  evidence_refs: ['torghut-route-proven-profit:current', selectedReceiptId],
  reason_codes: ['hypothesis_not_promotion_eligible'],
  rollback_target: 'disable material reentry clearinghouse emission and keep Torghut max_notional=0',
  implementer_dispatch: null,
})

const materialClearinghouse = (receipt = materialReceipt()): MaterialReentryClearinghouse => ({
  schema_version: 'jangar.material-reentry-clearinghouse.v1',
  mode: 'observe',
  design_artifact:
    'docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md',
  clearinghouse_id: 'material-reentry-clearinghouse:current',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  namespace: 'agents',
  status: 'repair_required',
  material_readiness: 'hold',
  action_receipts: [receipt],
  open_action_classes: [],
  repair_required_action_classes: ['dispatch_repair'],
  blocked_action_classes: [],
  primary_reentry_receipt_refs: [receipt.receipt_id],
  top_repair_receipt_id: receipt.receipt_id,
  implementer_dispatches: [],
  top_implementer_dispatch: null,
  rollback_target: 'disable material reentry clearinghouse emission',
})

const stageCreditLedger = (): StageCreditLedger => ({
  schema_version: 'jangar.stage-credit-ledger.v1',
  ledger_id: 'stage-credit-ledger:current',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  governing_design_refs: [
    'docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md',
  ],
  observed_revision: {
    source_head_sha: 'source-sha',
    gitops_revision: 'source-sha',
  },
  evidence_mode: 'observe',
  credit_epoch_id: 'stage-credit-epoch:current',
  stage_accounts: [
    {
      account_id: 'stage-credit-account:dispatch-repair',
      stage: 'implement',
      action_class: 'dispatch_repair',
      opening_credit: 1,
      base_credit: 1,
      evidence_freshness_bonus: 0,
      torghut_repair_value_credit: 1,
      rollout_truth_deposit: 0,
      failure_debt_tax: 0,
      controller_witness_tax: 0,
      source_rollout_tax: 0,
      capital_safety_tax: 0,
      runner_capacity_tax: 0,
      available_credit: 1,
      minimum_spend: 1,
      max_concurrent_runs: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
      decision: 'hold',
      reason_codes: ['stage_credit_insufficient'],
      required_repair_actions: ['settle selected executable alpha receipt'],
      evidence_refs: ['stage-credit-evidence:current'],
      selected_repair_lot_ref: 'compacted-repair-lot:promotion',
      rollback_target: 'set stage credit mode to observe',
    },
  ],
  runner_slot_futures: [],
  retained_failure_debt_refs: [],
  settlement_policy: {
    mode: 'read_model_only',
    refund_condition: 'terminal success',
    burn_condition: 'terminal no-delta',
    conversion_condition: 'repair-only run closes the selected repair lot and unlocks normal stage credit',
    rollback_target: 'disable stage credit emission',
  },
  handoff_contract: {
    value_gates: ['failed_agentrun_rate', 'handoff_evidence_quality', 'routeable_candidate_count'],
    status: 'hold',
    next_implementation_milestone: 'settle selected executable alpha repair receipt',
    rollback_target: 'set stage credit mode to observe',
  },
})

const evidencePressureLedger = (): EvidencePressureLedger => ({
  schema_version: 'jangar.evidence-pressure-ledger.v1',
  ledger_id: 'evidence-pressure-ledger:current',
  namespace: 'agents',
  generated_at: now.toISOString(),
  fresh_until: freshUntil,
  governing_design_refs: [
    'docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md',
  ],
  observed_revision: {
    source_head_sha: 'source-sha',
    gitops_revision: 'source-sha',
  },
  evidence_mode: 'observe',
  pressure_sources: [],
  watch_backoff_policy: {
    state: 'calm',
    max_new_list_requests_per_minute: 10,
    max_new_agent_runs_per_stage: 1,
    jitter_seconds: 5,
    retry_after_seconds: 30,
    stop_retry_reason_codes: [],
    open_repair_reason_codes: [],
  },
  action_pressure_budget: [
    {
      action_class: 'dispatch_repair',
      decision: 'repair_only',
      pressure_tax: 0,
      max_dispatches: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
      required_repair_receipts: ['torghut.executable-alpha-receipts.v1'],
      reason_codes: [],
      rollback_target: 'disable evidence pressure ledger enforcement',
    },
  ],
  scheduler_handoff: {
    status: 'repair_only',
    ledger_ref: 'evidence-pressure-ledger:current',
    held_action_classes: [],
    repair_action_classes: ['dispatch_repair'],
    reason_codes: [],
  },
  deployer_handoff: {
    status: 'repair_only',
    ledger_ref: 'evidence-pressure-ledger:current',
    held_action_classes: [],
    reason_codes: [],
  },
  rollback_target: 'disable evidence pressure ledger emission',
})

const buildEscrow = (
  receiptOverrides: Partial<TorghutExecutableAlphaRepairReceipt> = {},
  evidenceOverrides: Partial<TorghutConsumerEvidenceStatus> = {},
) => {
  const evidence = torghutEvidence(receiptOverrides, evidenceOverrides)
  const selectedReceiptId = evidence.executable_alpha_repair_receipts?.selected_receipt_id ?? 'missing'
  return buildRepairSlotEscrow({
    now,
    namespace: 'agents',
    torghutConsumerEvidence: evidence,
    materialReentryClearinghouse: materialClearinghouse(materialReceipt(selectedReceiptId)),
    stageCreditLedger: stageCreditLedger(),
    evidencePressureLedger: evidencePressureLedger(),
  })
}

describe('control-plane repair slot escrow', () => {
  it('opens one observe-only dispatch_repair slot for a current zero-notional executable-alpha receipt', () => {
    const escrow = buildEscrow()

    expect(escrow.schema_version).toBe('jangar.repair-slot-escrow.v1')
    expect(escrow.governing_design_refs).toEqual([
      REPAIR_SLOT_ESCROW_DESIGN_ARTIFACT,
      REPAIR_SLOT_ESCROW_TORGHUT_DESIGN_ARTIFACT,
    ])
    expect(escrow.status).toBe('observe_only')
    expect(escrow.selected_slot_id).toBe(escrow.slots[0]?.slot_id)
    expect(escrow.blocked_slots).toEqual([])
    expect(escrow.no_delta_debt).toEqual([])
    expect(escrow.slots).toEqual([
      expect.objectContaining({
        action_class: 'dispatch_repair',
        state: 'observe_only',
        torghut_selected_receipt_id: 'executable-alpha-repair-receipt:current',
        material_reentry_receipt_id: 'material-reentry-receipt:dispatch-repair',
        stage_credit_ledger_id: 'stage-credit-ledger:current',
        stage_credit_account_id: 'stage-credit-account:dispatch-repair',
        evidence_pressure_ledger_id: 'evidence-pressure-ledger:current',
        target_value_gate: 'routeable_candidate_count',
        required_output_receipts: expect.arrayContaining(['torghut.executable-alpha-receipts.v1']),
        max_parallelism: 1,
        max_runtime_seconds: 1200,
        max_notional: 0,
        settlement_state: 'pending',
        reason_codes: [],
      }),
    ])
    expect(escrow.scheduler_handoff).toMatchObject({
      status: 'observe_only',
      selected_slot_id: escrow.selected_slot_id,
      action_class: 'dispatch_repair',
      max_parallelism: 1,
      max_notional: 0,
    })
  })

  it('blocks the slot when the selected executable-alpha receipt is stale', () => {
    const escrow = buildEscrow({ fresh_until: '2026-05-14T00:09:59.000Z' })

    expect(escrow.status).toBe('block')
    expect(escrow.selected_slot_id).toBeNull()
    expect(escrow.slots).toEqual([])
    expect(escrow.blocked_slots[0]?.reason_codes).toEqual(
      expect.arrayContaining(['selected_executable_alpha_receipt_stale']),
    )
  })

  it('blocks the slot when selected repair evidence is not zero-notional', () => {
    const escrow = buildEscrow({ max_notional: '25' })

    expect(escrow.status).toBe('block')
    expect(escrow.blocked_slots[0]?.reason_codes).toEqual(
      expect.arrayContaining(['selected_receipt_not_zero_notional']),
    )
    expect(escrow.scheduler_handoff.max_notional).toBe(0)
  })

  it('blocks the slot when selected repair evidence lacks an explicit zero-notional cap', () => {
    const escrow = buildEscrow({ max_notional: null })

    expect(escrow.status).toBe('block')
    expect(escrow.blocked_slots[0]?.reason_codes).toEqual(
      expect.arrayContaining(['selected_receipt_not_zero_notional']),
    )
  })

  it('blocks the slot when pressure accounting has no dispatch-repair budget left', () => {
    const evidence = torghutEvidence()
    const selectedReceiptId = evidence.executable_alpha_repair_receipts?.selected_receipt_id ?? 'missing'
    const pressureLedger = evidencePressureLedger()
    pressureLedger.action_pressure_budget = [
      {
        ...pressureLedger.action_pressure_budget[0]!,
        max_dispatches: 0,
      },
    ]

    const escrow = buildRepairSlotEscrow({
      now,
      namespace: 'agents',
      torghutConsumerEvidence: evidence,
      materialReentryClearinghouse: materialClearinghouse(materialReceipt(selectedReceiptId)),
      stageCreditLedger: stageCreditLedger(),
      evidencePressureLedger: pressureLedger,
    })

    expect(escrow.status).toBe('block')
    expect(escrow.blocked_slots[0]?.reason_codes).toContain('evidence_pressure_dispatch_repair_budget_zero')
  })

  it('blocks relaunch while matching no-delta debt is active for the same selected repair', () => {
    const escrow = buildEscrow(
      {},
      {
        alpha_repair_dividend_ledger: {
          schema_version: 'torghut.alpha-repair-dividend-ledger-ref.v1',
          ledger_schema_version: 'torghut.alpha-repair-dividend-ledger.v1',
          ledger_id: 'alpha-repair-dividend-ledger:current',
          generated_at: now.toISOString(),
          fresh_until: freshUntil,
          status: 'no_delta',
          dividend_state: 'no_delta',
          reason_codes: ['active_no_delta_release_key'],
          selected_hypothesis_id: 'H-MICRO-01',
          selected_value_gate: 'routeable_candidate_count',
          routeable_candidate_count_before: 0,
          routeable_candidate_count_after: 0,
          measured_delta: 0,
          no_delta_release_key: 'no-delta-release:H-MICRO-01',
          launch_decision: 'deny',
          required_recorder_schema: 'jangar.material-action-custody-flight-recorder.v1',
          validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_repair_dividend_ledger.py',
          enforcement_mode: 'observe',
          max_notional: '0',
          capital_rule: 'zero_notional_repair_only',
          rollback_target: 'stop emitting alpha_repair_dividend_ledger and keep Torghut max_notional=0',
        },
      },
    )

    expect(escrow.status).toBe('block')
    expect(escrow.no_delta_debt).toEqual([
      expect.objectContaining({
        source: 'alpha_repair_dividend_ledger',
        source_ref: 'alpha-repair-dividend-ledger:current',
        selected_hypothesis_id: 'H-MICRO-01',
        selected_value_gate: 'routeable_candidate_count',
        measured_delta: 0,
        repeat_launch_decision: 'deny',
      }),
    ])
    expect(escrow.blocked_slots[0]?.reason_codes).toContain('active_no_delta_debt_for_repair_slot')
  })

  it('reopens the lane when the selected repair input no longer matches active no-delta debt', () => {
    const escrow = buildEscrow(
      { receipt_id: 'executable-alpha-repair-receipt:new', hypothesis_id: 'H-NEW-01' },
      {
        alpha_repair_dividend_ledger: {
          schema_version: 'torghut.alpha-repair-dividend-ledger-ref.v1',
          ledger_schema_version: 'torghut.alpha-repair-dividend-ledger.v1',
          ledger_id: 'alpha-repair-dividend-ledger:old',
          generated_at: now.toISOString(),
          fresh_until: freshUntil,
          status: 'no_delta',
          dividend_state: 'no_delta',
          reason_codes: ['active_no_delta_release_key'],
          selected_hypothesis_id: 'H-MICRO-01',
          selected_value_gate: 'routeable_candidate_count',
          routeable_candidate_count_before: 0,
          routeable_candidate_count_after: 0,
          measured_delta: 0,
          no_delta_release_key: 'no-delta-release:H-MICRO-01',
          launch_decision: 'deny',
          required_recorder_schema: 'jangar.material-action-custody-flight-recorder.v1',
          validation_command: 'uv run --frozen pytest services/torghut/tests/test_alpha_repair_dividend_ledger.py',
          enforcement_mode: 'observe',
          max_notional: '0',
          capital_rule: 'zero_notional_repair_only',
          rollback_target: 'stop emitting alpha_repair_dividend_ledger and keep Torghut max_notional=0',
        },
      },
    )

    expect(escrow.status).toBe('observe_only')
    expect(escrow.no_delta_debt).toEqual([])
    expect(escrow.slots[0]).toMatchObject({
      torghut_selected_receipt_id: 'executable-alpha-repair-receipt:new',
      state: 'observe_only',
    })
  })
})
