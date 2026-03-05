import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InsertTracker = {
  tableCalls: string[]
  db: {
    insertInto: (table: string) => unknown
    transaction: () => { execute: (fn: (trx: unknown) => Promise<unknown>) => Promise<unknown> }
  }
}

const buildInsertTracker = (): InsertTracker => {
  const tableCalls: string[] = []
  const db = {
    insertInto: (table: string) => {
      tableCalls.push(table)
      const chain = {
        values: () => chain,
        onConflict: (callback: unknown) => {
          if (typeof callback === 'function') {
            const updateBuilder = {
              where: () => updateBuilder,
            }
            const conflictBuilder = {
              columns: () => conflictBuilder,
              doUpdateSet: () => updateBuilder,
            }
            ;(callback as (builder: unknown) => unknown)(conflictBuilder)
          }
          return chain
        },
        execute: async () => undefined,
      }
      return chain
    },
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(db),
    }),
  }

  return { tableCalls, db }
}

describe('market-context finalize route integration', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'market-context-secret'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'false'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unmock('~/server/db')
    vi.unmock('~/server/kysely-migrations')
    vi.unmock('~/server/torghut-market-context')
    vi.unmock('~/server/metrics')
    delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
    delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN
  })

  it('persists batch finalize payloads through the public route without on-demand dispatch', async () => {
    const tracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()
    const recordTorghutMarketContextRunEvent = vi.fn()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache,
    }))
    vi.doMock('~/server/metrics', () => ({
      recordTorghutMarketContextRunEvent,
      recordTorghutMarketContextBatchFreshnessLagSeconds: vi.fn(),
      recordTorghutMarketContextBatchRun: vi.fn(),
      recordTorghutMarketContextBatchRunDurationMs: vi.fn(),
      recordTorghutMarketContextBatchRunSymbols: vi.fn(),
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ market_session_open: true }) }))

    const { postMarketContextRunFinalizeHandler } = await import('./finalize')
    const response = await postMarketContextRunFinalizeHandler(
      new Request('http://localhost/api/torghut/market-context/runs/finalize', {
        method: 'POST',
        headers: {
          authorization: 'Bearer market-context-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          domain: 'news',
          runStatus: 'partial',
          requestId: 'integration-finalize-batch-1',
          items: [
            {
              symbol: 'AAPL',
              asOfUtc: '2026-03-04T15:35:00.000Z',
              sourceCount: 3,
              qualityScore: 0.9,
              payload: { headlineCount: 3 },
              citations: [{ source: 'wire', publishedAt: '2026-03-04T15:30:00.000Z', url: null }],
              riskFlags: [],
            },
            {
              symbol: 'NVDA',
              asOfUtc: '2026-03-04T15:35:00.000Z',
              sourceCount: 0,
              qualityScore: 0.4,
              payload: { headlineCount: 0 },
              citations: [],
              riskFlags: ['news_gap'],
              error: 'provider_timeout',
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      domain: 'news',
      runStatus: 'partial',
      requestId: 'integration-finalize-batch-1',
      batch: {
        processedSymbols: 2,
        updatedSymbols: 1,
        failedSymbols: 1,
      },
    })

    expect(tracker.tableCalls.filter((table) => table === 'torghut_market_context_snapshots')).toHaveLength(1)
    expect(tracker.tableCalls).not.toContain('torghut_market_context_dispatch_state')
    expect(tracker.tableCalls).toContain('torghut_market_context_runs')
    expect(tracker.tableCalls).toContain('torghut_market_context_run_events')
    expect(clearMarketContextCache).toHaveBeenCalledOnce()
    expect(recordTorghutMarketContextRunEvent).toHaveBeenCalledWith({
      endpoint: 'finalize',
      outcome: 'accepted',
      domain: 'news',
    })
  })
})
