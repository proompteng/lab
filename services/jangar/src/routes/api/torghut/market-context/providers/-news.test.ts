import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMarketContextProviderResult = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  getMarketContextProviderResult,
}))

describe('getNewsProviderHandler', () => {
  beforeEach(() => {
    getMarketContextProviderResult.mockReset()
  })

  it('returns 400 when symbol is missing', async () => {
    const { getNewsProviderHandler } = await import('./news')
    const response = await getNewsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/news'),
    )

    expect(response.status).toBe(400)
    expect(getMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('returns provider payload for valid symbol', async () => {
    getMarketContextProviderResult.mockResolvedValueOnce({
      symbol: 'NVDA',
      domain: 'news',
      snapshotState: 'fresh',
      context: {
        asOfUtc: '2026-02-27T00:01:00.000Z',
        sourceCount: 4,
        qualityScore: 0.82,
        payload: { sentimentScore: 0.2 },
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

    const { getNewsProviderHandler } = await import('./news')
    const response = await getNewsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/news?symbol=nvda'),
    )

    expect(response.status).toBe(200)
    expect(getMarketContextProviderResult).toHaveBeenCalledWith({
      domain: 'news',
      symbolInput: 'nvda',
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.symbol).toBe('NVDA')
    expect(body.domain).toBe('news')
  })
})
