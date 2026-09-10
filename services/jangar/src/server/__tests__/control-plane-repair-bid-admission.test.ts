import { describe, expect, it } from 'vitest'

import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'
import {
  buildRepairBidAdmissionState,
  REPAIR_BID_ADMISSION_DESIGN_ARTIFACT,
} from '~/server/control-plane-repair-bid-admission'

const now = new Date('2026-05-13T05:20:00.000Z')

const baseConsumerEvidence = (
  overrides: Partial<TorghutConsumerEvidenceStatus> = {},
): TorghutConsumerEvidenceStatus => ({
  status: 'current',
  endpoint: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
  receipt_id: 'torghut-route-proven-profit:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T05:21:00.000Z',
  candidate_id: null,
  dataset_snapshot_ref: null,
  max_notional: '0',
  reason_codes: [],
  message: 'current',
  repair_bid_settlement_ledger_id: 'repair-bid-settlement-ledger:test',
  repair_bid_settlement_status: 'current',
  repair_bid_settlement_generated_at: now.toISOString(),
  repair_bid_settlement_fresh_until: '2026-05-13T05:21:00.000Z',
  repair_bid_settlement_capital_decision: 'repair_only',
  repair_bid_settlement_max_notional: '0',
  repair_bid_settlement_routeable_candidate_count: 0,
  repair_bid_settlement_selected_lot_ids: ['compacted-repair-lot:quant'],
  repair_bid_settlement_dispatchable_lot_ids: ['compacted-repair-lot:quant'],
  repair_bid_settlement_held_lot_ids: [],
  repair_bid_settlement_active_dedupe_keys: [],
  repair_bid_settlement_compacted_lots: [
    {
      lot_id: 'compacted-repair-lot:quant',
      lot_class: 'quant_pipeline',
      target_value_gate: 'zero_notional_or_stale_evidence_rate',
      priority: 100,
      expected_gate_delta: 'retire_jangar_quant_ingestion_degraded',
      raw_reason_codes: ['jangar_quant_ingestion_degraded'],
      root_cause_hypothesis: 'scoped quant ingestion proof is degraded',
      required_input_refs: ['route-evidence-clearinghouse:test'],
      required_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
      required_output_receipt_count: 1,
      validation_commands: ['pytest services/torghut/tests/test_repair_bid_settlement.py -k quant_pipeline'],
      dedupe_key: 'PA3SX7FYNUTF:15m:quant_pipeline',
      ttl_seconds: 900,
      max_runtime_seconds: 1200,
      max_parallelism: 1,
      max_notional: '0',
      state: 'selected',
      dispatchable: true,
      hold_reason_codes: [],
      source_bid_ids: ['route-evidence-repair-bid:quant'],
    },
  ],
  repair_bid_settlement_reason_codes: ['jangar_quant_ingestion_degraded'],
  ...overrides,
})

const alphaStrikeLedger = (
  overrides: NonNullable<TorghutConsumerEvidenceStatus['alpha_readiness_strike_ledger']>['strike_slots'][number] = {
    slot_id: 'alpha-readiness-strike-slot:test',
    lot_id: 'compacted-repair-lot:promotion',
    source_repair_bid_ids: ['route-evidence-repair-bid:promotion'],
    lot_class: 'promotion_custody',
    target_value_gate: 'routeable_candidate_count',
    admission_reason: 'revenue_queue_top_gate',
    preempted_lot_class: 'lower_revenue_priority_repair',
    dedupe_key: 'PA3SX7FYNUTF:15m:promotion_custody',
    ttl_seconds: 900,
    max_runtime_seconds: 1200,
    state: 'dispatchable',
    required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
    capital_rule: 'zero_notional_repair_only',
    max_notional: '0',
    hold_reason_codes: [],
  },
): NonNullable<TorghutConsumerEvidenceStatus['alpha_readiness_strike_ledger']> => ({
  schema_version: 'torghut.alpha-readiness-strike-ledger.v1',
  ledger_id: 'alpha-readiness-strike-ledger:test',
  generated_at: now.toISOString(),
  fresh_until: '2026-05-13T05:21:00.000Z',
  account_id: 'PA3SX7FYNUTF',
  window: '15m',
  trading_mode: 'live',
  capital_stage: 'shadow',
  max_notional: '0',
  status: 'dispatchable',
  revenue_repair_digest_ref: 'torghut-revenue-repair-digest:test',
  selected_business_blocker: {
    code: 'repair_alpha_readiness',
    reason: 'hypothesis_not_promotion_eligible',
    value_gate: 'routeable_candidate_count',
    required_output_receipt: 'torghut.executable-alpha-receipts.v1',
  },
  routeable_candidate_count_before: 0,
  zero_notional_or_stale_evidence_rate_before: 1,
  promotion_custody_lot_ref: 'compacted-repair-lot:promotion',
  strike_slots: [overrides],
  required_after_receipts: ['torghut.promotion-custody-decision-receipt.v1', 'alpha_readiness_receipt'],
  guarded_action_classes: ['paper_canary', 'live_micro_canary', 'live_scale'],
  reason_codes: [],
  rollback_target: 'disable alpha-readiness strike ledger and keep Torghut max_notional=0',
})

const buildAdmission = (overrides: Partial<TorghutConsumerEvidenceStatus> = {}) =>
  buildRepairBidAdmissionState({
    now,
    namespace: 'agents',
    repository: 'proompteng/lab',
    branch: 'codex/swarm-torghut-quant',
    swarmName: 'torghut-quant',
    stage: 'implement',
    torghutConsumerEvidence: baseConsumerEvidence(overrides),
  })

describe('control-plane repair bid admission', () => {
  it('admits only current zero-notional compacted Torghut lots for repair dispatch', () => {
    const admission = buildAdmission()
    const byAction = new Map(admission.receipts.map((receipt) => [receipt.action_class, receipt]))

    expect(admission.design_artifact).toBe(REPAIR_BID_ADMISSION_DESIGN_ARTIFACT)
    expect(byAction.get('serve_readonly')).toMatchObject({ decision: 'allow', max_notional: 0 })
    expect(byAction.get('dispatch_repair')).toMatchObject({
      decision: 'allow',
      admitted_lot_ids: ['compacted-repair-lot:quant'],
      max_parallelism: 1,
      max_runtime_seconds: 1200,
      max_notional: 0,
    })
    expect(byAction.get('dispatch_normal')).toMatchObject({
      decision: 'hold',
      denied_reason_codes: expect.arrayContaining([
        'torghut_repair_lots_unsettled',
        'torghut_repair_bid_settlement_repair_only',
      ]),
    })
    expect(byAction.get('live_scale')).toMatchObject({
      decision: 'block',
      max_notional: 0,
    })
    expect(admission.dispatch_tickets).toEqual([
      expect.objectContaining({
        torghut_lot_id: 'compacted-repair-lot:quant',
        dedupe_key: 'PA3SX7FYNUTF:15m:quant_pipeline',
        required_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
        launch_allowed: true,
        max_notional: 0,
      }),
    ])
  })

  it('holds repair dispatch when the settlement ledger is stale', () => {
    const admission = buildAdmission({
      repair_bid_settlement_status: 'stale',
      repair_bid_settlement_fresh_until: '2026-05-13T05:19:00.000Z',
    })
    const repairReceipt = admission.receipts.find((receipt) => receipt.action_class === 'dispatch_repair')

    expect(repairReceipt).toMatchObject({
      decision: 'hold',
      admitted_lot_ids: [],
      denied_reason_codes: expect.arrayContaining(['torghut_repair_bid_settlement_stale']),
    })
    expect(admission.dispatch_tickets[0]).toMatchObject({
      launch_allowed: false,
      stop_conditions: expect.arrayContaining(['torghut_repair_bid_settlement_not_current']),
    })
  })

  it('denies duplicate or malformed lots without widening notional', () => {
    const admission = buildAdmission({
      repair_bid_settlement_active_dedupe_keys: ['PA3SX7FYNUTF:15m:quant_pipeline'],
      repair_bid_settlement_compacted_lots: [
        {
          ...baseConsumerEvidence().repair_bid_settlement_compacted_lots![0]!,
          required_output_receipt_count: 2,
          max_notional: '25',
        },
      ],
    })
    const repairReceipt = admission.receipts.find((receipt) => receipt.action_class === 'dispatch_repair')

    expect(repairReceipt).toMatchObject({
      decision: 'hold',
      admitted_lot_ids: [],
      denied_reason_codes: expect.arrayContaining(['no_admissible_compacted_repair_lot']),
      max_notional: 0,
    })
    expect(admission.dispatch_tickets[0]).toMatchObject({
      launch_allowed: false,
      stop_conditions: expect.arrayContaining([
        'repair_lot_notional_nonzero',
        'repair_lot_dedupe_key_active',
        'repair_lot_output_receipt_count_invalid',
      ]),
      max_notional: 0,
    })
  })

  it('reserves one revenue-ranked alpha-readiness strike ahead of static repair lots', () => {
    const admission = buildAdmission({
      alpha_readiness_strike_ledger: alphaStrikeLedger(),
      repair_bid_settlement_compacted_lots: [
        baseConsumerEvidence().repair_bid_settlement_compacted_lots![0]!,
        {
          ...baseConsumerEvidence().repair_bid_settlement_compacted_lots![0]!,
          lot_id: 'compacted-repair-lot:promotion',
          lot_class: 'promotion_custody',
          target_value_gate: 'routeable_candidate_count',
          priority: 60,
          expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
          required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
          dedupe_key: 'PA3SX7FYNUTF:15m:promotion_custody',
          state: 'held',
          dispatchable: false,
          hold_reason_codes: ['selection_limit_exceeded'],
        },
      ],
    })

    const repairReceipt = admission.receipts.find((receipt) => receipt.action_class === 'dispatch_repair')

    expect(repairReceipt).toMatchObject({
      decision: 'allow',
      admitted_lot_ids: ['compacted-repair-lot:promotion'],
      max_parallelism: 1,
      max_notional: 0,
    })
    expect(admission.dispatch_tickets).toEqual([
      expect.objectContaining({
        torghut_lot_id: 'compacted-repair-lot:promotion',
        lot_class: 'promotion_custody',
        target_value_gate: 'routeable_candidate_count',
        dedupe_key: 'PA3SX7FYNUTF:15m:promotion_custody',
        required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
        launch_allowed: true,
        max_notional: 0,
      }),
    ])
  })

  it('keeps selected profit-freshness repair tickets available during alpha-readiness strike admission', () => {
    const profitFreshnessLot = {
      ...baseConsumerEvidence().repair_bid_settlement_compacted_lots![0]!,
      lot_id: 'profit-freshness-repair-lot:market-context',
      lot_class: 'market_context_refresh',
      target_value_gate: 'zero_notional_or_stale_evidence_rate',
      priority: 99,
      expected_gate_delta: 'retire_market_context_stale',
      required_output_receipt: 'torghut.market-context-freshness-receipt.v1',
      validation_commands: ['pytest services/torghut/tests/test_zero_notional_repair_executor.py -k dispatch_ticket'],
      dedupe_key: 'PA3SX7FYNUTF:15m:profit_freshness:refresh_stale_market_context_domains:market_context',
      state: 'selected',
      dispatchable: true,
      hold_reason_codes: [],
    }
    const admission = buildAdmission({
      alpha_readiness_strike_ledger: alphaStrikeLedger(),
      repair_bid_settlement_selected_lot_ids: [
        'compacted-repair-lot:quant',
        'profit-freshness-repair-lot:market-context',
      ],
      repair_bid_settlement_dispatchable_lot_ids: [
        'compacted-repair-lot:quant',
        'profit-freshness-repair-lot:market-context',
      ],
      repair_bid_settlement_compacted_lots: [
        baseConsumerEvidence().repair_bid_settlement_compacted_lots![0]!,
        profitFreshnessLot,
      ],
    })

    const repairReceipt = admission.receipts.find((receipt) => receipt.action_class === 'dispatch_repair')

    expect(repairReceipt).toMatchObject({
      decision: 'allow',
      admitted_lot_ids: ['compacted-repair-lot:promotion', 'profit-freshness-repair-lot:market-context'],
      max_parallelism: 2,
      max_notional: 0,
    })
    expect(admission.dispatch_tickets).toEqual([
      expect.objectContaining({
        torghut_lot_id: 'compacted-repair-lot:promotion',
        lot_class: 'promotion_custody',
        target_value_gate: 'routeable_candidate_count',
        launch_allowed: true,
      }),
      expect.objectContaining({
        torghut_lot_id: 'profit-freshness-repair-lot:market-context',
        lot_class: 'market_context_refresh',
        target_value_gate: 'zero_notional_or_stale_evidence_rate',
        dedupe_key: 'PA3SX7FYNUTF:15m:profit_freshness:refresh_stale_market_context_domains:market_context',
        required_output_receipt: 'torghut.market-context-freshness-receipt.v1',
        launch_allowed: true,
        max_notional: 0,
      }),
    ])
  })

  it('holds alpha-readiness strike admission when the revenue ledger is stale', () => {
    const admission = buildAdmission({
      alpha_readiness_strike_ledger: {
        ...alphaStrikeLedger(),
        fresh_until: '2026-05-13T05:19:00.000Z',
      },
    })
    const repairReceipt = admission.receipts.find((receipt) => receipt.action_class === 'dispatch_repair')

    expect(repairReceipt).toMatchObject({
      decision: 'hold',
      admitted_lot_ids: [],
      denied_reason_codes: expect.arrayContaining(['alpha_readiness_strike_unavailable']),
      max_notional: 0,
    })
    expect(admission.dispatch_tickets).toEqual([])
  })

  it('holds alpha-readiness strike admission when guarded action holds are missing', () => {
    const admission = buildAdmission({
      alpha_readiness_strike_ledger: {
        ...alphaStrikeLedger(),
        guarded_action_classes: ['paper_canary', 'live_micro_canary'],
      },
    })
    const repairReceipt = admission.receipts.find((receipt) => receipt.action_class === 'dispatch_repair')

    expect(repairReceipt).toMatchObject({
      decision: 'hold',
      admitted_lot_ids: [],
      denied_reason_codes: expect.arrayContaining(['alpha_readiness_strike_unavailable']),
      max_notional: 0,
    })
    expect(admission.dispatch_tickets).toEqual([])
  })

  it('does not preempt static repair lots when the revenue top gate changes', () => {
    const admission = buildAdmission({
      alpha_readiness_strike_ledger: {
        ...alphaStrikeLedger(),
        selected_business_blocker: {
          code: 'repair_execution_tca',
          reason: 'execution_tca_stale',
          value_gate: 'fill_tca_or_slippage_quality',
          required_output_receipt: 'torghut.execution-tca-current-receipt.v1',
        },
      },
    })

    expect(admission.admitted_lot_ids).toEqual(['compacted-repair-lot:quant'])
    expect(admission.dispatch_tickets[0]).toMatchObject({
      torghut_lot_id: 'compacted-repair-lot:quant',
      lot_class: 'quant_pipeline',
    })
  })
})
