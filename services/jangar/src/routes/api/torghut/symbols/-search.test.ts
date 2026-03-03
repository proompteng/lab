import { afterEach, describe, expect, it, vi } from 'vitest'

describe('searchTorghutSymbolsHandler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an empty list for empty queries without calling upstream', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)
    const { searchTorghutSymbolsHandler } = await import('./search')

    const response = await searchTorghutSymbolsHandler(
      new Request('http://localhost/api/torghut/symbols/search?assetClass=equity&q='),
    )

    expect(response.status).toBe(200)
    expect(upstreamFetch).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ ok: true, symbols: [] })
  })

  it('filters out invalid crypto symbols from upstream data', async () => {
    const upstreamFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          quotes: [
            { quoteType: 'CRYPTOCURRENCY', symbol: 'BTC-USD' },
            { quoteType: 'CRYPTOCURRENCY', symbol: 'DOGE28384-USD' },
            { quoteType: 'CRYPTOCURRENCY', symbol: 'ETH-USD' },
            { quoteType: 'EQUITY', symbol: 'AAPL' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', upstreamFetch)
    const { searchTorghutSymbolsHandler } = await import('./search')

    const response = await searchTorghutSymbolsHandler(
      new Request('http://localhost/api/torghut/symbols/search?assetClass=crypto&q=btc&limit=10'),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, symbols: ['BTC-USD', 'ETH-USD'] })
  })
})
