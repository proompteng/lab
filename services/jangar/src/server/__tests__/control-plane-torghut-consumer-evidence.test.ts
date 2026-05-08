import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveTorghutConsumerEvidence } from '~/server/control-plane-torghut-consumer-evidence'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

const buildJsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('control-plane Torghut consumer evidence', () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('maps a current Torghut receipt into precise negative-evidence blockers', async () => {
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/status',
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        buildJsonResponse({
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
          market_context: {
            health: { status: 'healthy' },
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch

    const result = await resolveTorghutConsumerEvidence(new Date('2026-05-08T02:30:10.000Z'))

    expect(result.status).toMatchObject({
      status: 'current',
      receipt_id: 'torghut-consumer-evidence:test',
      candidate_id: 'candidate-a',
      dataset_snapshot_ref: 'dataset-a',
      max_notional: '0',
      reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
    })
    expect(result.negativeEvidence).toMatchObject({
      readiness_status: 'degraded',
      paper_settlement_clean: false,
      consumer_evidence_receipt_id: 'torghut-consumer-evidence:test',
      consumer_evidence_status: 'current',
      consumer_evidence_reason_codes: ['forecast_registry_degraded', 'execution_tca_route_universe_incomplete'],
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
