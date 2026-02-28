import { beforeEach, describe, expect, it, vi } from 'vitest'

const isMarketContextIngestAuthorized = vi.fn()
const startMarketContextProviderRun = vi.fn()
const recordMarketContextProviderRunProgress = vi.fn()
const recordMarketContextProviderEvidence = vi.fn()
const ingestMarketContextProviderResult = vi.fn()
const getMarketContextProviderRunStatus = vi.fn()
const recordTorghutMarketContextRunEvent = vi.fn()

vi.mock('~/server/torghut-market-context-agents', () => ({
  isMarketContextIngestAuthorized,
  startMarketContextProviderRun,
  recordMarketContextProviderRunProgress,
  recordMarketContextProviderEvidence,
  ingestMarketContextProviderResult,
  getMarketContextProviderRunStatus,
}))

vi.mock('~/server/metrics', () => ({
  recordTorghutMarketContextRunEvent,
}))

describe('market-context run lifecycle routes', () => {
  beforeEach(() => {
    isMarketContextIngestAuthorized.mockReset()
    startMarketContextProviderRun.mockReset()
    recordMarketContextProviderRunProgress.mockReset()
    recordMarketContextProviderEvidence.mockReset()
    ingestMarketContextProviderResult.mockReset()
    getMarketContextProviderRunStatus.mockReset()
    recordTorghutMarketContextRunEvent.mockReset()
  })

  it('start returns 401 when unauthorized', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(false)

    const { postMarketContextRunStartHandler } = await import('./start')
    const response = await postMarketContextRunStartHandler(
      new Request('http://localhost/api/torghut/market-context/runs/start', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news' }),
      }),
    )

    expect(response.status).toBe(401)
    expect(startMarketContextProviderRun).not.toHaveBeenCalled()
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({ endpoint: 'start', outcome: 'unauthorized' })
  })

  it('start returns accepted response', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    startMarketContextProviderRun.mockResolvedValueOnce({
      ok: true,
      requestId: 'req-1',
      symbol: 'AAPL',
      domain: 'fundamentals',
      status: 'started',
    })

    const { postMarketContextRunStartHandler } = await import('./start')
    const response = await postMarketContextRunStartHandler(
      new Request('http://localhost/api/torghut/market-context/runs/start', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL', domain: 'fundamentals' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'start',
      outcome: 'accepted',
      domain: 'fundamentals',
    })
  })

  it('progress returns 404 when run is not found', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    recordMarketContextProviderRunProgress.mockRejectedValueOnce(new Error('run not found for requestId req-x'))

    const { postMarketContextRunProgressHandler } = await import('./progress')
    const response = await postMarketContextRunProgressHandler(
      new Request('http://localhost/api/torghut/market-context/runs/progress', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'req-x', seq: 1 }),
      }),
    )

    expect(response.status).toBe(404)
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({ endpoint: 'progress', outcome: 'not_found' })
  })

  it('evidence returns accepted response', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    recordMarketContextProviderEvidence.mockResolvedValueOnce({
      ok: true,
      requestId: 'req-2',
      symbol: 'NVDA',
      domain: 'news',
      evidenceCount: 2,
      insertedEvidence: 2,
      inserted: true,
    })

    const { postMarketContextRunEvidenceHandler } = await import('./evidence')
    const response = await postMarketContextRunEvidenceHandler(
      new Request('http://localhost/api/torghut/market-context/runs/evidence', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'req-2', seq: 2, evidence: [{ source: 'x' }, { source: 'y' }] }),
      }),
    )

    expect(response.status).toBe(200)
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'evidence',
      outcome: 'accepted',
      domain: 'news',
    })
  })

  it('finalize returns accepted response', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    ingestMarketContextProviderResult.mockResolvedValueOnce({
      ok: true,
      symbol: 'AAPL',
      domain: 'news',
      runStatus: 'succeeded',
      requestId: 'req-3',
      context: {
        asOfUtc: '2026-02-28T00:00:00.000Z',
        sourceCount: 2,
        qualityScore: 0.8,
        payload: {},
        citations: [],
        riskFlags: [],
      },
    })

    const { postMarketContextRunFinalizeHandler } = await import('./finalize')
    const response = await postMarketContextRunFinalizeHandler(
      new Request('http://localhost/api/torghut/market-context/runs/finalize', {
        method: 'POST',
        body: JSON.stringify({ symbol: 'AAPL', domain: 'news', runStatus: 'succeeded' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'finalize',
      outcome: 'accepted',
      domain: 'news',
    })
  })

  it('status returns 404 when run is not found', async () => {
    isMarketContextIngestAuthorized.mockResolvedValueOnce(true)
    getMarketContextProviderRunStatus.mockRejectedValueOnce(new Error('run not found for requestId req-missing'))

    const { getMarketContextRunStatusHandler } = await import('./$requestId')
    const response = await getMarketContextRunStatusHandler(
      'req-missing',
      new Request('http://localhost/api/torghut/market-context/runs/req-missing', {
        method: 'GET',
      }),
    )

    expect(response.status).toBe(404)
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({ endpoint: 'status', outcome: 'not_found' })
  })
})
