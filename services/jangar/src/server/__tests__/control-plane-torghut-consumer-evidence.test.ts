import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { StageClearancePacket } from '~/data/agents-control-plane'
import { resolveTorghutConsumerEvidence } from '~/server/control-plane-torghut-consumer-evidence'
import { attachStageClearanceCustodyToTorghutEvidence } from '~/server/control-plane-torghut-stage-custody'

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

const buildJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('control-plane Torghut consumer evidence', () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('maps a current route-proven Torghut receipt into precise negative-evidence blockers', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:test',
            generated_at: '2026-05-08T02:30:00.000Z',
            fresh_until: '2026-05-08T02:31:00.000Z',
            candidate_id: 'candidate-a',
            dataset_snapshot_ref: 'dataset-a',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            route_canary_id: 'torghut-consumer-evidence-canary:test',
            jangar_parity_escrow_ref: 'jangar-source-serving-parity:test',
            serving_revision: 'torghut-00301',
            image_digest: 'sha256:test',
            route_repair_value: 14,
            decision: 'repair',
            reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
          },
          torghut_consumer_evidence_receipt: {
            receipt_id: 'torghut-consumer-evidence:test',
            generated_at: '2026-05-08T02:30:00.000Z',
            fresh_until: '2026-05-08T02:31:00.000Z',
            candidate_id: 'candidate-a',
            dataset_snapshot_ref: 'dataset-a',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
          },
          build: {
            commit: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
            version: 'v0.570.0-1-g4dfa7c707',
            active_revision: 'torghut-00340',
            image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          capital_reentry_cohort_ledger: {
            schema_version: 'torghut.capital-reentry-cohort-ledger.v1',
            ledger_id: 'capital-reentry-ledger:test',
            aggregate_state: 'repair',
            aggregate_blocking_reason_codes: ['forecast_registry_degraded'],
            cohorts: [
              {
                cohort_id: 'capital-reentry-cohort:aapl',
                cohort_class: 'receipt_settlement',
                current_state: 'repair',
                blocking_reason_codes: ['forecast_registry_degraded'],
                max_notional: '0',
              },
            ],
          },
          profit_repair_settlement_ledger: {
            schema_version: 'torghut.profit-repair-settlement-ledger.v1',
            ledger_id: 'profit-repair-settlement-ledger:test',
            aggregate_state: 'repair',
            aggregate_blocking_reason_codes: ['quant_pipeline_degraded'],
            repair_lots: [
              {
                lot_id: 'profit-repair-lot:quant',
                lot_class: 'quant_freshness',
                current_state: 'repair',
                blocking_reason_codes: ['quant_pipeline_degraded'],
                paper_notional_limit: '0',
                live_notional_limit: '0',
              },
            ],
          },
          routeability_repair_acceptance_ledger: {
            schema_version: 'torghut.routeability-repair-acceptance-ledger.v1',
            ledger_id: 'routeability-acceptance-ledger:test',
            aggregate_state: 'blocked',
            accepted_routeable_candidate_count: 0,
            aggregate_blocking_reason_codes: ['proof_floor_repair_only'],
            lots: [
              {
                lot_id: 'routeability-repair-lot:submit',
                lot_type: 'submit_gate_hold',
                current_state: 'blocked',
                blocking_reason_codes: ['simple_submit_disabled'],
              },
            ],
          },
          route_warrant_exchange: {
            schema_version: 'torghut.route-warrant-exchange.v1',
            warrant_id: 'torghut-route-warrant:test',
            generated_at: '2026-05-08T02:30:00.000Z',
            fresh_until: '2026-05-08T02:31:00.000Z',
            warrant_state: 'repair_only',
            accepted_routeable_candidate_count: 0,
            zero_notional_or_stale_evidence_rate: 0.75,
            fill_tca_or_slippage_quality: 'hold',
            capital_gate_safety: 'hold',
            post_cost_daily_net_pnl_state: 'blocked',
            max_notional: '0',
            blocking_reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
            blocking_dependency_names: ['forecast_registry', 'active_tca'],
            repair_packets: [
              {
                packet_id: 'route-warrant-repair:tca',
                target_value_gate: 'fill_tca_or_slippage_quality',
                target_dependency: 'active_tca',
                expected_output_receipt: 'execution-tca:current',
                max_notional: '0',
              },
            ],
          },
          repair_bid_settlement_ledger: {
            schema_version: 'torghut.repair-bid-settlement-ledger.v1',
            ledger_id: 'repair-bid-settlement-ledger:test',
            generated_at: '2026-05-08T02:30:00.000Z',
            fresh_until: '2026-05-08T02:31:00.000Z',
            capital_decision: 'repair_only',
            max_notional: '0',
            routeable_candidate_count: 0,
            selected_lot_ids: ['compacted-repair-lot:quant'],
            dispatchable_lot_ids: ['compacted-repair-lot:quant'],
            held_lot_ids: ['compacted-repair-lot:tca'],
            active_dedupe_keys: ['PA3SX7FYNUTF:15m:execution_tca'],
            raw_reason_codes_preserved: ['jangar_quant_ingestion_degraded'],
            compacted_lots: [
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
          },
          alpha_readiness_strike_ledger: {
            schema_version: 'torghut.alpha-readiness-strike-ledger.v1',
            ledger_id: 'alpha-readiness-strike-ledger:test',
            generated_at: '2026-05-08T02:30:00.000Z',
            fresh_until: '2026-05-08T02:31:00.000Z',
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
            strike_slots: [
              {
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
            ],
            required_after_receipts: ['torghut.promotion-custody-decision-receipt.v1'],
            guarded_action_classes: ['paper_canary', 'live_micro_canary', 'live_scale'],
            reason_codes: [],
            rollback_target: 'disable alpha-readiness strike ledger and keep Torghut max_notional=0',
          },
          repair_outcome_dividend_ledger: {
            schema_version: 'torghut.repair-outcome-dividend-ledger.v1',
            ledger_id: 'repair-outcome-dividend-ledger:test',
            generated_at: '2026-05-08T02:30:00.000Z',
            fresh_until: '2026-05-08T02:31:00.000Z',
            max_notional: '0',
            outcome_receipts: [
              {
                receipt_id: 'repair-outcome-receipt:quant',
                repair_lot_id: 'compacted-repair-lot:quant',
                terminal_state: 'pending',
                outcome: 'pending',
                receipt_schema: 'torghut.quant-pipeline-current-receipt.v1',
                preserved_reason_codes: ['jangar_quant_ingestion_degraded'],
              },
            ],
            open_escrows: [
              {
                escrow_id: 'repair-outcome-escrow:quant',
                dispatch_ticket_id: 'repair-outcome-dispatch-ticket:quant',
                repair_lot_id: 'compacted-repair-lot:quant',
                expected_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
                expected_reason_code_delta: ['jangar_quant_ingestion_degraded'],
                terminal_state: 'pending',
                outcome: 'pending',
                preserved_reason_codes: ['jangar_quant_ingestion_degraded'],
                next_action: 'hold',
              },
            ],
            no_delta_lots: [],
            retired_reason_codes: [],
            preserved_reason_codes: ['jangar_quant_ingestion_degraded'],
          },
          profit_freshness_frontier: {
            schema_version: 'torghut.profit-freshness-frontier.v1',
            frontier_id: 'profit-freshness-frontier:test',
            frontier_state: 'repair_only',
            aggregate_blocking_reason_codes: ['market_context_news_stale'],
            repair_lots: [
              {
                lot_id: 'profit-freshness-repair-lot:market',
                blocked_dimension: 'market_context',
                state: 'selected_zero_notional_repair',
                guardrail_failures: [],
              },
            ],
            selected_zero_notional_repairs: [
              {
                lot_id: 'profit-freshness-repair-lot:market',
                blocked_dimension: 'market_context',
                state: 'selected_zero_notional_repair',
              },
            ],
          },
          market_context: {
            health: { status: 'healthy' },
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-08T02:30:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'current',
      receipt_id: 'torghut-route-proven-profit:test',
      candidate_id: 'candidate-a',
      dataset_snapshot_ref: 'dataset-a',
      max_notional: '0',
      route_canary_id: 'torghut-consumer-evidence-canary:test',
      jangar_parity_escrow_ref: 'jangar-source-serving-parity:test',
      serving_revision: 'torghut-00301',
      image_digest: 'sha256:test',
      build_commit: '4dfa7c70771f3f8d6f3884c52a77c41e5e851638',
      build_version: 'v0.570.0-1-g4dfa7c707',
      serving_image_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      observed_contracts: expect.arrayContaining([
        'route_warrant_exchange',
        'repair_bid_settlement_ledger',
        'repair_outcome_dividend_ledger',
      ]),
      contract_schema_mismatches: [],
      route_repair_value: 14,
      decision: 'repair',
      capital_reentry_cohort_ledger_id: 'capital-reentry-ledger:test',
      capital_reentry_aggregate_state: 'repair',
      capital_reentry_cohort_ids: ['capital-reentry-cohort:aapl'],
      profit_repair_settlement_ledger_id: 'profit-repair-settlement-ledger:test',
      profit_repair_aggregate_state: 'repair',
      profit_repair_lot_ids: ['profit-repair-lot:quant'],
      routeability_repair_acceptance_ledger_id: 'routeability-acceptance-ledger:test',
      routeability_aggregate_state: 'blocked',
      routeability_lot_ids: ['routeability-repair-lot:submit'],
      accepted_routeable_candidate_count: 0,
      route_warrant_id: 'torghut-route-warrant:test',
      route_warrant_state: 'repair_only',
      route_warrant_fresh_until: '2026-05-08T02:31:00.000Z',
      route_warrant_repair_packet_ids: ['route-warrant-repair:tca'],
      route_warrant_repair_target_value_gates: ['fill_tca_or_slippage_quality'],
      route_warrant_blocking_dependency_names: ['forecast_registry', 'active_tca'],
      route_warrant_blocking_reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
      route_warrant_zero_notional_or_stale_evidence_rate: 0.75,
      route_warrant_fill_tca_or_slippage_quality: 'hold',
      route_warrant_capital_gate_safety: 'hold',
      route_warrant_post_cost_daily_net_pnl_state: 'blocked',
      repair_bid_settlement_ledger_id: 'repair-bid-settlement-ledger:test',
      repair_bid_settlement_status: 'current',
      repair_bid_settlement_capital_decision: 'repair_only',
      repair_bid_settlement_selected_lot_ids: ['compacted-repair-lot:quant'],
      repair_bid_settlement_dispatchable_lot_ids: ['compacted-repair-lot:quant'],
      repair_bid_settlement_held_lot_ids: ['compacted-repair-lot:tca'],
      repair_bid_settlement_active_dedupe_keys: ['PA3SX7FYNUTF:15m:execution_tca'],
      repair_bid_settlement_compacted_lots: [
        expect.objectContaining({
          lot_id: 'compacted-repair-lot:quant',
          required_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
          required_output_receipt_count: 1,
          max_notional: '0',
        }),
      ],
      alpha_readiness_strike_ledger: expect.objectContaining({
        ledger_id: 'alpha-readiness-strike-ledger:test',
        status: 'dispatchable',
        selected_business_blocker: expect.objectContaining({
          code: 'repair_alpha_readiness',
          value_gate: 'routeable_candidate_count',
        }),
        strike_slots: [
          expect.objectContaining({
            lot_id: 'compacted-repair-lot:promotion',
            lot_class: 'promotion_custody',
            required_output_receipt: 'torghut.promotion-custody-decision-receipt.v1',
            max_notional: '0',
          }),
        ],
      }),
      repair_outcome_dividend_ledger_id: 'repair-outcome-dividend-ledger:test',
      repair_outcome_receipt_ids: ['repair-outcome-receipt:quant'],
      repair_outcome_open_escrow_ids: ['repair-outcome-escrow:quant'],
      repair_outcome_preserved_reason_codes: ['jangar_quant_ingestion_degraded'],
      repair_outcome_escrows: [
        expect.objectContaining({
          escrow_id: 'repair-outcome-escrow:quant',
          dispatch_ticket_id: 'repair-outcome-dispatch-ticket:quant',
          repair_lot_id: 'compacted-repair-lot:quant',
          expected_output_receipt: 'torghut.quant-pipeline-current-receipt.v1',
          terminal_state: 'pending',
          outcome: 'pending',
          next_action: 'hold',
        }),
      ],
      profit_freshness_frontier_id: 'profit-freshness-frontier:test',
      profit_freshness_state: 'repair_only',
      profit_freshness_repair_lot_ids: ['profit-freshness-repair-lot:market'],
      profit_freshness_selected_repair_ids: ['profit-freshness-repair-lot:market'],
      reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
    })
    expect(result.negativeEvidence).toMatchObject({
      readiness_status: 'degraded',
      paper_settlement_clean: false,
      consumer_evidence_receipt_id: 'torghut-route-proven-profit:test',
      consumer_evidence_status: 'current',
      consumer_evidence_reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
      capital_reentry_cohort_ledger_id: 'capital-reentry-ledger:test',
      capital_reentry_aggregate_state: 'repair',
      capital_reentry_cohort_ids: ['capital-reentry-cohort:aapl'],
      capital_reentry_blocking_reason_codes: ['forecast_registry_degraded'],
      profit_repair_settlement_ledger_id: 'profit-repair-settlement-ledger:test',
      profit_repair_aggregate_state: 'repair',
      profit_repair_lot_ids: ['profit-repair-lot:quant'],
      profit_repair_blocking_reason_codes: ['quant_pipeline_degraded'],
      routeability_repair_acceptance_ledger_id: 'routeability-acceptance-ledger:test',
      routeability_aggregate_state: 'blocked',
      routeability_lot_ids: ['routeability-repair-lot:submit'],
      routeability_blocking_reason_codes: ['proof_floor_repair_only', 'simple_submit_disabled'],
      accepted_routeable_candidate_count: 0,
      route_warrant_id: 'torghut-route-warrant:test',
      route_warrant_state: 'repair_only',
      route_warrant_repair_packet_ids: ['route-warrant-repair:tca'],
      route_warrant_blocking_dependency_names: ['forecast_registry', 'active_tca'],
      route_warrant_blocking_reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
      repair_bid_settlement_ledger_id: 'repair-bid-settlement-ledger:test',
      repair_bid_settlement_status: 'current',
      repair_bid_settlement_dispatchable_lot_ids: ['compacted-repair-lot:quant'],
      repair_bid_settlement_blocking_reason_codes: ['jangar_quant_ingestion_degraded'],
      profit_freshness_frontier_id: 'profit-freshness-frontier:test',
      profit_freshness_state: 'repair_only',
      profit_freshness_repair_lot_ids: ['profit-freshness-repair-lot:market'],
      profit_freshness_selected_repair_ids: ['profit-freshness-repair-lot:market'],
      profit_freshness_blocking_reason_codes: ['market_context_news_stale'],
    })
  })

  it('hydrates executable alpha repair receipts from revenue-repair for material reentry', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:repair',
            generated_at: '2026-05-14T00:23:00.000Z',
            fresh_until: '2026-05-14T00:38:00.000Z',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        buildJsonResponse({
          schema_version: 'torghut.revenue-repair-digest.v1',
          executable_alpha_repair_receipts: {
            schema_version: 'torghut.executable-alpha-repair-receipts.v1',
            generated_at: '2026-05-14T00:23:00.000Z',
            fresh_until: '2026-05-14T00:38:00.000Z',
            source_revenue_repair_ref: 'torghut-revenue-repair-digest:current',
            status: 'selected',
            selected_receipt_id: 'executable-alpha-repair-receipt:current',
            receipt_count: 1,
            target_value_gate: 'routeable_candidate_count',
            routeable_candidate_count_before: 0,
            max_notional: '0',
            capital_rule: 'zero_notional_repair_only',
            selected_receipt: {
              schema_version: 'torghut.executable-alpha-repair-receipt.v1',
              receipt_id: 'executable-alpha-repair-receipt:current',
              generated_at: '2026-05-14T00:23:00.000Z',
              fresh_until: '2026-05-14T00:38:00.000Z',
              source_revenue_repair_ref: 'torghut-revenue-repair-digest:current',
              hypothesis_id: 'H-CONT-01',
              repair_class: 'evidence_window_refresh',
              target_value_gate: 'routeable_candidate_count',
              reason_codes: ['post_cost_expectancy_non_positive'],
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
              validation_commands: [
                'uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py',
              ],
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
            },
            receipts: [],
          },
        }),
      ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-14T00:23:10.000Z'))

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(result.status.executable_alpha_repair_receipts).toMatchObject({
      schema_version: 'torghut.executable-alpha-repair-receipts.v1',
      selected_receipt_id: 'executable-alpha-repair-receipt:current',
      receipt_count: 1,
      target_value_gate: 'routeable_candidate_count',
      routeable_candidate_count_before: 0,
      selected_receipt: expect.objectContaining({
        receipt_id: 'executable-alpha-repair-receipt:current',
        repair_class: 'evidence_window_refresh',
        required_output_receipts: ['alpha_readiness_receipt', 'torghut.executable-alpha-receipts.v1'],
        jangar_reentry: expect.objectContaining({
          required_material_reentry_receipt: 'jangar.material-reentry-receipt.v1',
          action_class: 'dispatch_repair',
        }),
      }),
    })
  })

  it('maps Torghut evidence-clock splits and missing custody into action-boundary evidence', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:clock-split',
            generated_at: '2026-05-12T16:45:00.000Z',
            fresh_until: '2026-05-12T16:46:00.000Z',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: [],
          },
          evidence_clock_arbiter: {
            schema_version: 'torghut.evidence-clock-arbiter.v1',
            arbiter_id: 'evidence-clock-arbiter:test',
            routeable_candidate_count: 0,
            required_jangar_custody_ref: {
              decision: 'allow',
              state: 'current',
              source: 'dependency_quorum_proxy',
              fresh_until: '2026-05-12T16:46:00.000Z',
            },
            clock_splits: [
              {
                clock: 'rollout',
                state: 'split',
                affected_value_gates: ['capital_gate_safety'],
                reason_codes: ['route_adjacent_workloads_degraded'],
                next_repair_class: 'image_digest_reconcile',
              },
              {
                clock: 'postgres_tca',
                state: 'stale',
                affected_value_gates: ['fill_tca_or_slippage_quality'],
                reason_codes: ['execution_tca_stale'],
                next_repair_class: 'execution_tca_refresh',
              },
            ],
          },
          routeable_profit_candidate_exchange: {
            schema_version: 'torghut.routeable-profit-candidate-exchange.v1',
            exchange_id: 'routeable-profit-candidate-exchange:test',
            zero_notional_repair_lots: [
              {
                lot_id: 'evidence-clock-repair-lot:rollout',
                target_value_gate: 'capital_gate_safety',
                repair_class: 'image_digest_reconcile',
                max_notional: '0',
              },
            ],
            rejected_candidates: [{ candidate_id: 'candidate-a' }],
            summary: {
              routeable_candidate_count: 0,
              rejected_candidate_count: 1,
            },
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-12T16:45:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'current',
      evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
      evidence_clock_state: 'split',
      evidence_clock_split_clock_names: ['rollout', 'postgres_tca'],
      evidence_clock_blocking_reason_codes: ['route_adjacent_workloads_degraded', 'execution_tca_stale'],
      evidence_clock_custody_status: 'missing',
      evidence_clock_custody_ref: null,
      routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:test',
      routeable_exchange_routeable_candidate_count: 0,
      routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:rollout'],
      routeable_exchange_rejected_candidate_count: 1,
      operator_summary: {
        top_clock_split: 'rollout',
        selected_repair_lot_id: 'evidence-clock-repair-lot:rollout',
        expected_value_gate: 'capital_gate_safety',
        next_validation_command:
          "curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.evidence_clock_arbiter.summary'",
      },
    })
    expect(result.negativeEvidence).toMatchObject({
      evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
      evidence_clock_status: 'split',
      evidence_clock_split_clock_names: ['rollout', 'postgres_tca'],
      evidence_clock_blocking_reason_codes: ['route_adjacent_workloads_degraded', 'execution_tca_stale'],
      evidence_clock_custody_status: 'missing',
      evidence_clock_custody_reason_codes: ['evidence_clock_custody_receipt_missing'],
      routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:test',
      routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:rollout'],
      routeable_exchange_routeable_candidate_count: 0,
      routeable_exchange_rejected_candidate_count: 1,
    })
  })

  it('maps freshness carry pressure refs for Jangar pressure pricing', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:freshness',
            generated_at: '2026-05-13T09:15:00.000Z',
            fresh_until: '2026-05-13T09:16:00.000Z',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: [],
          },
          freshness_carry_ledger: {
            schema_version: 'torghut.freshness-carry-ledger.v1',
            ledger_id: 'freshness-carry-ledger:test',
            capital_posture: {
              decision: 'repair_only',
              reason_codes: ['tca_computed_at_stale'],
              max_notional: '0',
            },
            dimensions: [
              {
                dimension_id: 'tca',
                state: 'stale',
                stale_reason_codes: ['tca_computed_at_stale'],
              },
            ],
            jangar_pressure_refs: [
              {
                schema_version: 'torghut.jangar-pressure-ref.v1',
                pressure_ref_id: 'freshness-pressure-ref:tca',
                target_dimension_id: 'tca',
                target_value_gate: 'fill_tca_or_slippage_quality',
                required_output_receipts: ['torghut.execution-tca-refresh-receipt.v1'],
                reason_codes: ['tca_computed_at_stale'],
                max_notional: '0',
                ttl_seconds: 60,
                dispatchable: true,
              },
            ],
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-13T09:15:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'current',
      receipt_id: 'torghut-route-proven-profit:freshness',
      freshness_carry_ledger_id: 'freshness-carry-ledger:test',
      freshness_carry_state: 'repair_only',
      freshness_carry_pressure_ref_ids: ['freshness-pressure-ref:tca'],
      freshness_carry_dispatchable_pressure_ref_ids: ['freshness-pressure-ref:tca'],
      freshness_carry_required_output_receipts: ['torghut.execution-tca-refresh-receipt.v1'],
      freshness_carry_target_value_gates: ['fill_tca_or_slippage_quality'],
      freshness_carry_reason_codes: ['tca_computed_at_stale'],
      reason_codes: ['tca_computed_at_stale'],
    })
  })

  it('maps route 404 to route_missing evidence instead of generic unavailable', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(buildJsonResponse({ detail: 'not found' }, 404)),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-08T02:30:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'route_missing',
      reason_codes: ['torghut_consumer_evidence_route_missing'],
    })
    expect(result.negativeEvidence).toMatchObject({
      consumer_evidence_status: 'route_missing',
      consumer_evidence_reason_codes: ['torghut_consumer_evidence_route_missing'],
      paper_settlement_clean: false,
    })
  })

  it('attaches a local Torghut stage-clearance packet as typed custody evidence', () => {
    const packet: StageClearancePacket = {
      schema_version: 'jangar.stage-clearance-packet.v1',
      packet_id: 'stage-clearance:torghut:paper_canary:fresh-hold',
      generated_at: '2026-05-13T06:00:00.000Z',
      fresh_until: '2026-05-13T06:02:00.000Z',
      namespace: 'agents',
      swarm_name: 'jangar-control-plane',
      stage: 'torghut',
      action_class: 'paper_canary',
      governing_requirement_refs: [
        'docs/agents/designs/188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md',
      ],
      source_rollout_truth_ref: 'source-rollout-truth-exchange:test',
      controller_witness_ref: 'controller-witness:test',
      agentrun_ingestion_ref: 'agentrun-ingestion:test',
      execution_trust_ref: 'execution-trust:test',
      material_action_verdict_ref: 'material-action-verdict:paper_canary:test',
      route_stability_ref: 'route-stability:test',
      torghut_consumer_evidence_ref: 'torghut-route-proven-profit:test',
      dependency_verdict_ref: null,
      dependency_verdict_decision: null,
      failure_domain_leases: [],
      provider_capacity_ref: null,
      decision: 'hold',
      max_launches: 0,
      max_notional: 0,
      ttl_seconds: 120,
      reason_codes: ['torghut_max_notional_zero'],
      required_repair_action: 'close Torghut zero-notional repair blockers',
      rollback_target:
        'set JANGAR_STAGE_CLEARANCE_ENFORCEMENT=shadow and fall back to material action verdicts plus runtime admission passports',
    }

    const result = attachStageClearanceCustodyToTorghutEvidence(
      {
        status: {
          status: 'current',
          endpoint: 'http://torghut/trading/consumer-evidence',
          receipt_id: 'torghut-route-proven-profit:test',
          generated_at: '2026-05-13T06:00:00.000Z',
          fresh_until: '2026-05-13T06:02:00.000Z',
          candidate_id: null,
          dataset_snapshot_ref: null,
          max_notional: '0',
          reason_codes: [],
          message: 'current',
          evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
          evidence_clock_custody_status: 'missing',
          evidence_clock_custody_ref: null,
        },
        negativeEvidence: {
          readiness_status: 'degraded',
          paper_settlement_clean: false,
          consumer_evidence_receipt_id: 'torghut-route-proven-profit:test',
          consumer_evidence_status: 'current',
          consumer_evidence_fresh_until: '2026-05-13T06:02:00.000Z',
          consumer_evidence_reason_codes: [],
          evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
          evidence_clock_status: 'current',
          evidence_clock_custody_status: 'missing',
          evidence_clock_custody_ref: null,
          evidence_clock_custody_reason_codes: ['evidence_clock_custody_receipt_missing'],
        },
      },
      [packet],
      new Date('2026-05-13T06:00:30.000Z'),
    )

    expect(result.attached).toBe(true)
    expect(result.resolution.status).toMatchObject({
      evidence_clock_custody_status: 'blocked',
      evidence_clock_custody_ref: 'stage-clearance:torghut:paper_canary:fresh-hold',
    })
    expect(result.resolution.negativeEvidence).toMatchObject({
      evidence_clock_custody_status: 'blocked',
      evidence_clock_custody_ref: 'stage-clearance:torghut:paper_canary:fresh-hold',
      evidence_clock_custody_reason_codes: ['evidence_clock_custody_stage_clearance_hold'],
    })
  })

  it('maps Torghut evidence-clock splits and missing custody into action-boundary evidence', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:clock-split',
            generated_at: '2026-05-12T16:45:00.000Z',
            fresh_until: '2026-05-12T16:46:00.000Z',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: [],
          },
          evidence_clock_arbiter: {
            schema_version: 'torghut.evidence-clock-arbiter.v1',
            arbiter_id: 'evidence-clock-arbiter:test',
            routeable_candidate_count: 0,
            required_jangar_custody_ref: {
              decision: 'allow',
              state: 'current',
              source: 'dependency_quorum_proxy',
              fresh_until: '2026-05-12T16:46:00.000Z',
            },
            clock_splits: [
              {
                clock: 'rollout',
                state: 'split',
                affected_value_gates: ['capital_gate_safety'],
                reason_codes: ['route_adjacent_workloads_degraded'],
                next_repair_class: 'image_digest_reconcile',
              },
              {
                clock: 'postgres_tca',
                state: 'stale',
                affected_value_gates: ['fill_tca_or_slippage_quality'],
                reason_codes: ['execution_tca_stale'],
                next_repair_class: 'execution_tca_refresh',
              },
            ],
          },
          routeable_profit_candidate_exchange: {
            schema_version: 'torghut.routeable-profit-candidate-exchange.v1',
            exchange_id: 'routeable-profit-candidate-exchange:test',
            zero_notional_repair_lots: [
              {
                lot_id: 'evidence-clock-repair-lot:rollout',
                target_value_gate: 'capital_gate_safety',
                repair_class: 'image_digest_reconcile',
                max_notional: '0',
              },
            ],
            rejected_candidates: [{ candidate_id: 'candidate-a' }],
            summary: {
              routeable_candidate_count: 0,
              rejected_candidate_count: 1,
            },
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-12T16:45:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'current',
      evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
      evidence_clock_state: 'split',
      evidence_clock_split_clock_names: ['rollout', 'postgres_tca'],
      evidence_clock_blocking_reason_codes: ['route_adjacent_workloads_degraded', 'execution_tca_stale'],
      evidence_clock_custody_status: 'missing',
      evidence_clock_custody_ref: null,
      routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:test',
      routeable_exchange_routeable_candidate_count: 0,
      routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:rollout'],
      routeable_exchange_rejected_candidate_count: 1,
      operator_summary: {
        top_clock_split: 'rollout',
        selected_repair_lot_id: 'evidence-clock-repair-lot:rollout',
        expected_value_gate: 'capital_gate_safety',
        next_validation_command:
          "curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.evidence_clock_arbiter.summary'",
      },
    })
    expect(result.negativeEvidence).toMatchObject({
      evidence_clock_arbiter_id: 'evidence-clock-arbiter:test',
      evidence_clock_status: 'split',
      evidence_clock_split_clock_names: ['rollout', 'postgres_tca'],
      evidence_clock_blocking_reason_codes: ['route_adjacent_workloads_degraded', 'execution_tca_stale'],
      evidence_clock_custody_status: 'missing',
      evidence_clock_custody_reason_codes: ['evidence_clock_custody_receipt_missing'],
      routeable_profit_candidate_exchange_id: 'routeable-profit-candidate-exchange:test',
      routeable_exchange_zero_notional_repair_lot_ids: ['evidence-clock-repair-lot:rollout'],
      routeable_exchange_routeable_candidate_count: 0,
      routeable_exchange_rejected_candidate_count: 1,
    })
  })

  it('maps status schema mismatch to schema_mismatch evidence', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v0',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:test',
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-08T02:30:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'schema_mismatch',
      reason_codes: ['torghut_consumer_evidence_schema_mismatch'],
    })
    expect(result.negativeEvidence).toMatchObject({
      consumer_evidence_status: 'schema_mismatch',
      consumer_evidence_reason_codes: ['torghut_consumer_evidence_schema_mismatch'],
    })
  })

  it('maps stale route-proven receipts to stale evidence', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
          schema_version: 'torghut.consumer-evidence-status.v1',
          route_proven_profit_receipt: {
            schema_version: 'torghut.route-proven-profit-receipt.v1',
            receipt_id: 'torghut-route-proven-profit:stale',
            generated_at: '2026-05-08T02:29:00.000Z',
            fresh_until: '2026-05-08T02:29:30.000Z',
            paper_readiness_state: 'blocked',
            live_readiness_state: 'blocked',
            max_notional: '0',
            reason_codes: [],
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-08T02:30:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'stale',
      receipt_id: 'torghut-route-proven-profit:stale',
      reason_codes: ['torghut_consumer_evidence_stale'],
    })
    expect(result.negativeEvidence).toMatchObject({
      consumer_evidence_status: 'stale',
      consumer_evidence_reason_codes: ['torghut_consumer_evidence_stale'],
    })
  })

  it('keeps consumer evidence missing when Torghut does not publish a receipt', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/status',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(buildJsonResponse({ status: 'ok' })),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-08T02:30:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'missing',
      reason_codes: ['torghut_consumer_evidence_missing'],
    })
    expect(result.negativeEvidence).toBeUndefined()
  })

  it('configures Jangar to read the non-recursive Torghut consumer evidence endpoint', () => {
    const manifest = readFileSync(resolve(REPO_ROOT, 'argocd/applications/agents/values.yaml'), 'utf8')

    expect(manifest).toContain(
      'JANGAR_TORGHUT_STATUS_URL: http://torghut.torghut.svc.cluster.local/trading/consumer-evidence',
    )
    expect(manifest).not.toContain(
      'JANGAR_TORGHUT_STATUS_URL: http://torghut.torghut.svc.cluster.local/trading/autonomy',
    )
  })
})
