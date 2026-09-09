import { describe, expect, it } from 'vitest'

import type { RepairBidAdmissionState } from '~/server/control-plane-status-types'
import { buildMaterialGateDigest } from '~/server/control-plane-material-gate-digest'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

const now = new Date('2026-05-14T08:24:00.000Z')

const baseRepairBidAdmission = (overrides: Partial<RepairBidAdmissionState> = {}): RepairBidAdmissionState => ({
  schema_version: 'jangar.repair-bid-admission-state.v1',
  mode: 'observe',
  design_artifact: 'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T08:25:00.000Z',
  status: 'allow',
  torghut_settlement_ledger_ref: 'repair-bid-settlement-ledger:test',
  receipts: [],
  dispatch_tickets: [
    {
      schema_version: 'jangar.repair-lot-dispatch-ticket.v1',
      ticket_id: 'repair-lot-dispatch-ticket:test',
      admission_receipt_id: 'repair-bid-admission:test',
      torghut_lot_id: 'compacted-repair-lot:test',
      lot_class: 'promotion_custody',
      target_value_gate: 'routeable_candidate_count',
      dedupe_key: 'PA3SX7FYNUTF:15m:promotion_custody',
      required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
      launch_allowed: true,
      launch_reason: 'current_zero_notional_compacted_lot',
      stop_conditions: ['fresh_until_expired'],
      max_runtime_seconds: 1200,
      max_notional: 0,
      expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
      rollback_target: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
    },
  ],
  admitted_lot_ids: ['compacted-repair-lot:test'],
  held_lot_ids: [],
  active_dedupe_keys: [],
  reason_codes: [],
  rollback_target: 'disable repair-bid admission enforcement',
  ...overrides,
})

const baseConsumerEvidence = (
  overrides: Partial<TorghutConsumerEvidenceStatus> = {},
): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-14T08:25:00.000Z',
  candidate_id: 'candidate:test',
  dataset_snapshot_ref: 'dataset:test',
  max_notional: '0',
  revenue_repair_business_state: 'repair_only',
  revenue_repair_ready: false,
  alpha_repair_closure_board: {
    schema_version: 'torghut.alpha-repair-closure-board-ref.v1',
    board_id: 'alpha-repair-closure-board:test',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T08:39:00.000Z',
    status: 'selected',
    reason_codes: [],
    top_closure_id: 'alpha-repair-closure:test',
    selected_value_gate: 'routeable_candidate_count',
    required_output_receipt: 'torghut.executable-alpha-receipts.v1',
    settlement_market_id: 'alpha-closure-settlement-market:test',
    settlement_market_status: 'pending_no_delta',
    selected_hypothesis_id: 'H-MICRO-01',
    selected_repair_class: 'feature_replay_closure',
    required_settlement_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
    active_dedupe_key: 'alpha-window:test',
    no_delta_budget_state: 'consumed',
    no_delta_debt_count: 1,
    next_allowed_attempt_after: '2026-05-14T08:39:00.000Z',
    max_notional: '0',
    capital_rule: 'zero_notional_repair_only',
    release_conditions: ['evidence_window_changes'],
    validation_commands: ['uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py'],
    rollback_target: 'disable alpha_repair_closure_board emission and keep Torghut max_notional=0',
  },
  alpha_evidence_foundry: {
    schema_version: 'torghut.alpha-evidence-foundry-ref.v1',
    foundry_id: 'alpha-evidence-foundry:test',
    generated_at: now.toISOString(),
    fresh_until: '2026-05-14T08:39:00.000Z',
    status: 'selected',
    reason_codes: [],
    selected_queue_code: 'repair_alpha_readiness',
    selected_value_gate: 'routeable_candidate_count',
    required_output_receipt: 'torghut.alpha-evidence-window-receipt.v1',
    receipt_count: 3,
    selected_receipt_id: 'alpha-evidence-window-receipt:test',
    selected_hypothesis_id: 'H-MICRO-01',
    hypothesis_ids: ['H-MICRO-01'],
    no_delta_debt_count: 3,
    routeable_candidate_count_before: 0,
    max_notional: '0',
    capital_state: 'zero_notional',
    capital_rule: 'zero_notional_repair_only',
    rollback_target: 'stop emitting alpha_evidence_foundry and keep Torghut max_notional=0',
  },
  reason_codes: [],
  message: 'current',
  ...overrides,
})

describe('control-plane material gate digest', () => {
  it('uses the alpha closure dividend SLO as the dispatch repair custody source', () => {
    const digest = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_closure_dividend_slo: {
          schema_version: 'torghut.alpha-closure-dividend-slo.v1',
          slo_id: 'alpha-closure-dividend-slo:test',
          generated_at: now.toISOString(),
          fresh_until: '2026-05-14T08:39:00.000Z',
          source_revenue_repair_ref: 'torghut-revenue-repair-digest:test',
          source_board_ref: 'alpha-repair-closure-board:test',
          source_settlement_market_ref: 'alpha-closure-settlement-market:test',
          selected_hypothesis_id: 'H-MICRO-01',
          selected_value_gate: 'routeable_candidate_count',
          selected_repair_class: 'feature_replay_closure',
          required_settlement_receipt: 'torghut.alpha-closure-settlement-receipt.v1',
          active_dedupe_key: 'alpha-window:test',
          routeable_candidate_count_before: 0,
          routeable_candidate_count_after: 0,
          measured_delta: 0,
          dividend_state: 'no_delta',
          retired_reason_codes: [],
          preserved_reason_codes: ['route_universe_empty'],
          introduced_reason_codes: [],
          no_delta_budget_state: 'consumed',
          no_delta_debt_count: 1,
          release_conditions: ['evidence_window_changes'],
          next_allowed_attempt_after: '2026-05-14T08:39:00.000Z',
          validation_commands: ['uv run --frozen pytest services/torghut/tests/test_alpha_closure_dividend_slo.py'],
          enforcement_mode: 'observe',
          max_notional: '0',
          capital_rule: 'zero_notional_repair_only',
          reason_codes: ['alpha_closure_no_delta_active'],
          rollback_target: 'disable alpha_closure_dividend_slo emission and keep Torghut max_notional=0',
        },
      }),
      repairBidAdmission: baseRepairBidAdmission(),
      fullStatusAvailable: false,
    })

    expect(digest.alpha_closure_carry).toMatchObject({
      slo_id: 'alpha-closure-dividend-slo:test',
      dividend_state: 'no_delta',
      board_id: 'alpha-repair-closure-board:test',
      settlement_market_id: 'alpha-closure-settlement-market:test',
      routeable_candidate_count_before: 0,
      routeable_candidate_count_after: 0,
      measured_delta: 0,
      decision: 'deny',
      reason_codes: expect.arrayContaining([
        'alpha_closure_no_delta_active',
        'alpha_closure_no_delta_budget_consumed',
        'alpha_closure_no_delta_debt_active',
      ]),
      validation_refs: ['uv run --frozen pytest services/torghut/tests/test_alpha_closure_dividend_slo.py'],
    })
    expect(digest.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          source_refs: expect.arrayContaining([
            'alpha-closure-dividend-slo:test',
            'torghut-revenue-repair-digest:test',
          ]),
        }),
      ]),
    )
  })

  it('denies repair dispatch when alpha closure no-delta budget is consumed', () => {
    const digest = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence(),
      repairBidAdmission: baseRepairBidAdmission(),
      fullStatusAvailable: false,
      producerRevision: 'test-revision',
    })

    expect(digest.material_readiness).toBe('repair_only')
    expect(digest.alpha_closure_carry).toMatchObject({
      board_id: 'alpha-repair-closure-board:test',
      settlement_market_id: 'alpha-closure-settlement-market:test',
      selected_hypothesis_id: 'H-MICRO-01',
      no_delta_budget_state: 'consumed',
      no_delta_debt_count: 1,
      decision: 'deny',
      reason_codes: expect.arrayContaining([
        'alpha_closure_no_delta_budget_consumed',
        'alpha_closure_no_delta_debt_active',
      ]),
    })
    expect(digest.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'deny',
          source_refs: expect.arrayContaining([
            'torghut-route-proven-profit:test',
            'alpha-repair-closure-board:test',
            'repair-lot-dispatch-ticket:test',
          ]),
        }),
        expect.objectContaining({
          action_class: 'merge_ready',
          decision: 'hold',
          reason_codes: expect.arrayContaining(['full_status_unavailable', 'revenue_ready_false']),
        }),
      ]),
    )
  })

  it('allows one zero-notional repair only when closure carry is fresh and no-delta budget remains', () => {
    const digest = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_repair_closure_board: {
          ...baseConsumerEvidence().alpha_repair_closure_board!,
          no_delta_budget_state: 'available',
          no_delta_debt_count: 0,
        },
      }),
      repairBidAdmission: baseRepairBidAdmission(),
      fullStatusAvailable: true,
    })

    expect(digest.alpha_closure_carry.decision).toBe('allow')
    expect(digest.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'allow',
          reason_codes: [],
        }),
        expect.objectContaining({
          action_class: 'live_micro_canary',
          decision: 'block',
          reason_codes: expect.arrayContaining(['business_state_repair_only', 'revenue_ready_false']),
        }),
      ]),
    )
  })

  it('denies duplicate repair dispatch when the closure dedupe key is already active', () => {
    const digest = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_repair_closure_board: {
          ...baseConsumerEvidence().alpha_repair_closure_board!,
          no_delta_budget_state: 'available',
          no_delta_debt_count: 0,
        },
      }),
      repairBidAdmission: baseRepairBidAdmission({ active_dedupe_keys: ['alpha-window:test'] }),
      fullStatusAvailable: true,
    })

    expect(digest.alpha_closure_carry).toMatchObject({
      decision: 'deny',
      reason_codes: expect.arrayContaining(['alpha_closure_dedupe_active']),
    })
    expect(digest.action_class_decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_class: 'dispatch_repair',
          decision: 'deny',
        }),
      ]),
    )
  })

  it('holds repair dispatch when closure carry is missing, stale, wrong-gate, or missing notional safety', () => {
    const stale = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_repair_closure_board: {
          ...baseConsumerEvidence().alpha_repair_closure_board!,
          fresh_until: '2026-05-14T08:23:00.000Z',
          no_delta_budget_state: 'available',
          no_delta_debt_count: 0,
        },
      }),
      repairBidAdmission: baseRepairBidAdmission(),
    })
    const wrongGate = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'capital_gate_safety',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_repair_closure_board: {
          ...baseConsumerEvidence().alpha_repair_closure_board!,
          selected_value_gate: 'capital_gate_safety',
          no_delta_budget_state: 'available',
          no_delta_debt_count: 0,
        },
      }),
      repairBidAdmission: baseRepairBidAdmission(),
    })
    const nonzero = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_repair_closure_board: {
          ...baseConsumerEvidence().alpha_repair_closure_board!,
          max_notional: '10',
          no_delta_budget_state: 'available',
          no_delta_debt_count: 0,
        },
      }),
      repairBidAdmission: baseRepairBidAdmission(),
    })
    const missing = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({ alpha_repair_closure_board: null }),
      repairBidAdmission: baseRepairBidAdmission(),
    })
    const noTicket = buildMaterialGateDigest({
      now,
      namespace: 'agents',
      servingReadiness: 'ok',
      businessState: 'repair_only',
      revenueReady: false,
      affectedValueGate: 'routeable_candidate_count',
      torghutConsumerEvidence: baseConsumerEvidence({
        alpha_repair_closure_board: {
          ...baseConsumerEvidence().alpha_repair_closure_board!,
          no_delta_budget_state: 'available',
          no_delta_debt_count: 0,
        },
      }),
      repairBidAdmission: baseRepairBidAdmission({ dispatch_tickets: [], admitted_lot_ids: [] }),
    })

    expect(stale.alpha_closure_carry).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['alpha_closure_carry_stale']),
    })
    expect(wrongGate.alpha_closure_carry).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['alpha_closure_wrong_value_gate']),
    })
    expect(nonzero.alpha_closure_carry).toMatchObject({
      decision: 'block',
      reason_codes: expect.arrayContaining(['alpha_closure_notional_nonzero']),
    })
    expect(missing.alpha_closure_carry).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['alpha_closure_carry_missing']),
    })
    expect(noTicket.alpha_closure_carry).toMatchObject({
      decision: 'hold',
      reason_codes: expect.arrayContaining(['repair_bid_dispatch_ticket_missing']),
    })
  })
})
