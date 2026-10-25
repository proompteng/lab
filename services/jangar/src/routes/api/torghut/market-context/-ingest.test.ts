import { beforeEach, describe, expect, it, vi } from 'vitest'

const ingestMarketContextProviderResult = vi.fn()
const isMarketContextIngestAuthorized = vi.fn()
const recordTorghutMarketContextIngestRequest = vi.fn()
const recordTorghutMarketContextRunEvent = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  ingestMarketContextProviderResult,
  isMarketContextIngestAuthorized,
}))

vi.mock('~/server/metrics', () => ({
  recordTorghutMarketContextIngestRequest,
  recordTorghutMarketContextRunEvent,
}))

describe('postMarketContextIngestHandler', () => {
  beforeEach(() => {
    ingestMarketContextProviderResult.mockReset()
    isMarketContextIngestAuthorized.mockReset()
    recordTorghutMarketContextIngestRequest.mockReset()
    recordTorghutMarketContextRunEvent.mockReset()
  })

  it('returns 401 when ingest auth fails', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(false)

    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news' }),
      }),
    )

    expect(response.status).toBe(401)
    expect(ingestMarketContextProviderResult).not.toHaveBeenCalled()
    expect(recordTorghutMarketContextIngestRequest).toHaveBeenCalledWith({ outcome: 'unauthorized' })
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({ endpoint: 'finalize', outcome: 'unauthorized' })
  })

  it('returns 400 when payload is invalid json object', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)

    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        body: '"not-object"',
      }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.message).toContain('invalid JSON payload')
    expect(recordTorghutMarketContextIngestRequest).toHaveBeenCalledWith({ outcome: 'invalid_payload' })
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'finalize',
      outcome: 'invalid_payload',
    })
  })

  it('returns 200 and persisted payload on success', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    ingestMarketContextProviderResult.mockResolvedValueOnce({
      ok: true,
      symbol: 'AAPL',
      domain: 'news',
      runStatus: 'succeeded',
      requestId: 'req-1',
      context: {
        asOfUtc: '2026-02-27T00:00:00.000Z',
        sourceCount: 3,
        qualityScore: 0.8,
        payload: { sentiment: 0.1 },
        citations: [],
        riskFlags: [],
      },
    })

    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news', runStatus: 'succeeded' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(ingestMarketContextProviderResult).toHaveBeenCalledWith({
      symbol: 'AAPL',
      domain: 'news',
      runStatus: 'succeeded',
    })
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.domain).toBe('news')
    expect(recordTorghutMarketContextIngestRequest).toHaveBeenCalledWith({
      outcome: 'accepted',
      domain: 'news',
      runStatus: 'succeeded',
    })
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'finalize',
      outcome: 'accepted',
      domain: 'news',
    })
  })

  it('records ingest_error metrics on persistence failures', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    ingestMarketContextProviderResult.mockRejectedValueOnce(new Error('database write failed'))

    const { postMarketContextIngestHandler } = await import('./ingest')
    const response = await postMarketContextIngestHandler(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news' }),
      }),
    )

    expect(response.status).toBe(400)
    expect(recordTorghutMarketContextIngestRequest).toHaveBeenCalledWith({
      outcome: 'ingest_error',
      domain: 'news',
    })
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'finalize',
      outcome: 'error',
      domain: 'news',
    })
  })
})
