import { beforeEach, describe, expect, it, vi } from 'vitest'

import { submitSimulationCampaignHandler } from '~/routes/api/torghut/simulation/campaigns'
import { cancelSimulationRunHandler } from '~/routes/api/torghut/simulation/runs/$id'
import { submitSimulationRunHandler } from '~/routes/api/torghut/simulation/runs'

const leaderElectionMocks = vi.hoisted(() => ({
  requireLeaderForMutationHttp: vi.fn(),
}))

vi.mock('~/server/leader-election', () => leaderElectionMocks)
vi.mock('~/server/torghut-simulation-control-plane', () => ({
  listTorghutSimulationRuns: vi.fn(),
  parseTorghutSimulationRunRequest: vi.fn(() => ({
    ok: true,
    value: {
      manifest: {
        dataset_id: 'dataset-a',
        window: { start: '2026-03-06T14:30:00Z', end: '2026-03-06T15:30:00Z' },
      },
    },
  })),
  submitTorghutSimulationRun: vi.fn(),
  syncTorghutSimulationRun: vi.fn(),
  cancelTorghutSimulationRun: vi.fn(),
  listTorghutSimulationCampaigns: vi.fn(),
  parseTorghutSimulationCampaignRequest: vi.fn(() => ({
    ok: true,
    value: {
      manifest: {
        dataset_id: 'dataset-a',
      },
      windows: [{ start: '2026-03-06T14:30:00Z', end: '2026-03-06T15:30:00Z' }],
      candidateRefs: ['intraday_tsmom_v1@candidate'],
    },
  })),
  submitTorghutSimulationCampaign: vi.fn(),
}))

describe('Torghut simulation mutation routes', () => {
  beforeEach(() => {
    leaderElectionMocks.requireLeaderForMutationHttp.mockReset()
  })

  it('rejects run submission when this Jangar replica is not leader', async () => {
    leaderElectionMocks.requireLeaderForMutationHttp.mockReturnValue(
      new Response(JSON.stringify({ error: 'Not leader' }), { status: 503 }),
    )

    const response = await submitSimulationRunHandler(
      new Request('http://localhost/api/torghut/simulation/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: { dataset_id: 'dataset-a' } }),
      }),
    )

    expect(response.status).toBe(503)
  })

  it('rejects campaign submission when this Jangar replica is not leader', async () => {
    leaderElectionMocks.requireLeaderForMutationHttp.mockReturnValue(
      new Response(JSON.stringify({ error: 'Not leader' }), { status: 503 }),
    )

    const response = await submitSimulationCampaignHandler(
      new Request('http://localhost/api/torghut/simulation/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: { dataset_id: 'dataset-a' }, windows: [] }),
      }),
    )

    expect(response.status).toBe(503)
  })

  it('rejects run cancellation when this Jangar replica is not leader', async () => {
    leaderElectionMocks.requireLeaderForMutationHttp.mockReturnValue(
      new Response(JSON.stringify({ error: 'Not leader' }), { status: 503 }),
    )

    const response = await cancelSimulationRunHandler('sim-1')
    expect(response.status).toBe(503)
  })
})
