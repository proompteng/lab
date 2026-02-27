import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ingestMarketContextProviderResult = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  ingestMarketContextProviderResult,
}))

describe('POST /api/torghut/market-context/ingest', () => {
  const previousToken = process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
  const previousSaAuth = process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN

  beforeEach(() => {
    vi.resetModules()
    ingestMarketContextProviderResult.mockReset()
    delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
    delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN
  })

  afterEach(() => {
    if (previousToken == null) delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
    else process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = previousToken
    if (previousSaAuth == null) delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN
    else process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = previousSaAuth
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
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'secret-token'
    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-token',
        },
        body: 'not-json',
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(ingestMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('returns 401 when ingest token is not configured and auth header is missing', async () => {
    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'AAPL', domain: 'fundamentals' }),
      }),
    )

    expect(response.status).toBe(401)
    expect(ingestMarketContextProviderResult).not.toHaveBeenCalled()
  })

  it('ingests payload and returns 202', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'secret-token'
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
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-token',
        },
        body: JSON.stringify({ symbol: 'AAPL', domain: 'fundamentals' }),
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body.ok).toBe(true)
    expect(ingestMarketContextProviderResult).toHaveBeenCalledWith({ symbol: 'AAPL', domain: 'fundamentals' })
  })

  it('accepts a verified service-account bearer token when shared token is unset', async () => {
    ingestMarketContextProviderResult.mockResolvedValueOnce({
      ok: true,
      symbol: 'AAPL',
      domain: 'news',
      runStatus: 'succeeded',
      requestId: 'req-2',
      context: {
        asOfUtc: '2026-02-26T12:00:00.000Z',
        sourceCount: 1,
        qualityScore: 0.8,
        payload: { headline: 'x' },
        citations: [],
        riskFlags: [],
      },
    })

    const { __setIngestServiceAccountTokenVerifierForTests, postMarketContextIngestHandler } = await import('./ingest')
    __setIngestServiceAccountTokenVerifierForTests(async () => true)

    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sa-token',
        },
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news' }),
      }),
    )

    expect(response.status).toBe(202)
    expect(ingestMarketContextProviderResult).toHaveBeenCalledWith({ symbol: 'AAPL', domain: 'news' })
  })

  it('rejects service-account token when shared token is configured', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'secret-token'
    const { __setIngestServiceAccountTokenVerifierForTests, postMarketContextIngestHandler } = await import('./ingest')
    __setIngestServiceAccountTokenVerifierForTests(async () => true)

    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sa-token',
        },
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news' }),
      }),
    )

    expect(response.status).toBe(401)
    expect(ingestMarketContextProviderResult).not.toHaveBeenCalled()
  })
})
