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
