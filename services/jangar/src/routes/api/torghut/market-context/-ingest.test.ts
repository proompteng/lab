import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ingestMarketContextProviderResult = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  ingestMarketContextProviderResult,
}))

describe('POST /api/torghut/market-context/ingest', () => {
  const previousToken = process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN

  beforeEach(() => {
    ingestMarketContextProviderResult.mockReset()
    delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
  })

  afterEach(() => {
    if (previousToken == null) delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
    else process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = previousToken
  })

  it('returns 401 when ingest token is configured and auth header is missing', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'secret-token'
    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news' }),
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.ok).toBe(false)
    expect(ingestMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid JSON payload', async () => {
    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(ingestMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('ingests payload and returns 202', async () => {
    ingestMarketContextProviderResult.mockResolvedValueOnce({
      ok: true,
      symbol: 'AAPL',
      domain: 'fundamentals',
      runStatus: 'succeeded',
      requestId: 'req-1',
      context: {
        asOfUtc: '2026-02-26T12:00:00.000Z',
        sourceCount: 2,
        qualityScore: 0.9,
        payload: { marketCap: 1 },
        citations: [],
        riskFlags: [],
      },
    })
    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'AAPL', domain: 'fundamentals' }),
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body.ok).toBe(true)
    expect(ingestMarketContextProviderResult).toHaveBeenCalledWith({ symbol: 'AAPL', domain: 'fundamentals' })
  })
})
