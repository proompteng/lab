import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveTorghutConsumerEvidence } from '~/server/control-plane-torghut-consumer-evidence'

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
      profit_freshness_frontier_id: 'profit-freshness-frontier:test',
      profit_freshness_state: 'repair_only',
      profit_freshness_repair_lot_ids: ['profit-freshness-repair-lot:market'],
      profit_freshness_selected_repair_ids: ['profit-freshness-repair-lot:market'],
      profit_freshness_blocking_reason_codes: ['market_context_news_stale'],
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
    const manifest = readFileSync(
      resolve(process.cwd(), '..', '..', 'argocd/applications/jangar/deployment.yaml'),
      'utf8',
    )

    expect(manifest).toContain('name: JANGAR_TORGHUT_STATUS_URL')
    expect(manifest).toContain('value: http://torghut.torghut.svc.cluster.local/trading/consumer-evidence')
    expect(manifest).not.toContain(
      'name: JANGAR_TORGHUT_STATUS_URL\n              value: http://torghut.torghut.svc.cluster.local/trading/status',
    )
  })
})
