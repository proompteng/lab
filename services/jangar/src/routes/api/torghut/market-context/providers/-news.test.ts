import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMarketContextProviderResult = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  getMarketContextProviderResult,
}))

describe('GET /api/torghut/market-context/providers/news', () => {
  beforeEach(() => {
    getMarketContextProviderResult.mockReset()
  })

  it('returns 400 when symbol is missing', async () => {
    const { getNewsProviderHandler } = await import('./news')
    const response = await getNewsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/news'),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(getMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('returns provider payload for a symbol', async () => {
    getMarketContextProviderResult.mockResolvedValueOnce({
      symbol: 'MSFT',
      domain: 'news',
      snapshotState: 'stale',
      context: {
        asOfUtc: '2026-02-26T12:00:00.000Z',
        sourceCount: 5,
        qualityScore: 0.7,
        payload: { topHeadline: 'Sample headline' },
        citations: [],
        riskFlags: ['news_stale'],
      },
      dispatch: {
        attempted: true,
        dispatched: true,
        reason: null,
        runName: 'torghut-market-context-news-abcde',
        error: null,
      },
    })
    const { getNewsProviderHandler } = await import('./news')
    const response = await getNewsProviderHandler(
      new Request('http://localhost/api/torghut/market-context/providers/news?symbol=MSFT'),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.domain).toBe('news')
    expect(getMarketContextProviderResult).toHaveBeenCalledWith({ domain: 'news', symbolInput: 'MSFT' })
  })
})
