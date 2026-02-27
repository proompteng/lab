import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMarketContextProviderResult = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  getMarketContextProviderResult,
}))

describe('getFundamentalsProviderHandler', () => {
  beforeEach(() => {
    getMarketContextProviderResult.mockReset()
  })

  it('returns 400 when symbol is missing', async () => {
    const { getFundamentalsProviderHandler } = await import('./fundamentals')
    const response = await getFundamentalsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/fundamentals'),
    )

    expect(response.status).toBe(400)
    expect(getMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('returns provider payload for valid symbol', async () => {
    getMarketContextProviderResult.mockResolvedValueOnce({
      symbol: 'AAPL',
      domain: 'fundamentals',
      snapshotState: 'stale',
      context: {
        asOfUtc: '2026-02-27T00:00:00.000Z',
        sourceCount: 1,
        qualityScore: 0.75,
        payload: { peRatio: 31.2 },
        citations: [],
        riskFlags: ['fundamentals_stale'],
      },
      dispatch: {
        attempted: true,
        dispatched: true,
        reason: null,
        runName: 'torghut-market-context-fundamentals-abcd',
        error: null,
      },
    })

    const { getFundamentalsProviderHandler } = await import('./fundamentals')
    const response = await getFundamentalsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/fundamentals?symbol=aapl'),
    )

    expect(response.status).toBe(200)
    expect(getMarketContextProviderResult).toHaveBeenCalledWith({
      domain: 'fundamentals',
      symbolInput: 'aapl',
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.domain).toBe('fundamentals')
  })
})
