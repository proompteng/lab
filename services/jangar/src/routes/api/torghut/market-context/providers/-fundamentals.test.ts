import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMarketContextProviderResult = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  getMarketContextProviderResult,
}))

describe('GET /api/torghut/market-context/providers/fundamentals', () => {
  beforeEach(() => {
    getMarketContextProviderResult.mockReset()
  })

  it('returns 400 when symbol is missing', async () => {
    const { getFundamentalsProviderHandler } = await import('./fundamentals')
    const response = await getFundamentalsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/fundamentals'),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(getMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('returns provider payload for a symbol', async () => {
    getMarketContextProviderResult.mockResolvedValueOnce({
      symbol: 'AAPL',
      domain: 'fundamentals',
      snapshotState: 'fresh',
      context: {
        asOfUtc: '2026-02-26T12:00:00.000Z',
        sourceCount: 3,
        qualityScore: 0.9,
        payload: { peRatio: 32.1 },
        citations: [],
        riskFlags: [],
      },
      dispatch: {
        attempted: false,
        dispatched: false,
        reason: null,
        runName: null,
        error: null,
      },
    })
    const { getFundamentalsProviderHandler } = await import('./fundamentals')
    const response = await getFundamentalsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/fundamentals?symbol=AAPL'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.domain).toBe('fundamentals')
    expect(getMarketContextProviderResult).toHaveBeenCalledWith({ domain: 'fundamentals', symbolInput: 'AAPL' })
  })
})
