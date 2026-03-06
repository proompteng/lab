import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type InsertTracker = {
  tableCalls: string[]
  valueCalls: Array<{
    table: string
    values: unknown
  }>
  conflictWhereCalls: Array<{
    table: string
    args: unknown[]
  }>
  db: {
    insertInto: (table: string) => unknown
  }
}

const buildInsertTracker = (): InsertTracker => {
  const tableCalls: string[] = []
  const valueCalls: Array<{
    table: string
    values: unknown
  }> = []
  const conflictWhereCalls: Array<{
    table: string
    args: unknown[]
  }> = []
  const db = {
    insertInto: (table: string) => {
      tableCalls.push(table)
      const chain = {
        values: (values: unknown) => {
          valueCalls.push({ table, values })
          return chain
        },
        onConflict: (callback: unknown) => {
          if (typeof callback === 'function') {
            let whereArgs: unknown[] | null = null
            const updateBuilder: { where: (...args: unknown[]) => unknown } = {
              where: (...args: unknown[]) => {
                whereArgs = args
                return updateBuilder
              },
            }
            const conflictBuilder: {
              columns: (columns: unknown) => unknown
              doUpdateSet: (values: unknown) => unknown
            } = {
              columns: () => conflictBuilder,
              doUpdateSet: () => updateBuilder,
            }
            ;(callback as (builder: unknown) => unknown)(conflictBuilder)
            if (whereArgs) conflictWhereCalls.push({ table, args: whereArgs })
          }
          return chain
        },
        execute: async () => undefined,
      }
      return chain
    },
  }
  return { tableCalls, valueCalls, conflictWhereCalls, db }
}

describe('ingestMarketContextProviderResult', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not overwrite snapshots when runStatus is failed', async () => {
    const tracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache,
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')
    await ingestMarketContextProviderResult({
      symbol: 'AAPL',
      domain: 'news',
      runStatus: 'failed',
      error: 'upstream timeout',
    })

    expect(tracker.tableCalls).toEqual(['torghut_market_context_runs', 'torghut_market_context_run_events'])
    expect(tracker.tableCalls).not.toContain('torghut_market_context_dispatch_state')
    expect(clearMarketContextCache).not.toHaveBeenCalled()
  })

  it('does not overwrite snapshots when runStatus is missing or unknown', async () => {
    const missingStatusTracker = buildInsertTracker()
    const unknownStatusTracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()

    vi.doMock('~/server/db', () => ({
      getDb: vi.fn().mockReturnValueOnce(missingStatusTracker.db).mockReturnValueOnce(unknownStatusTracker.db),
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache,
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')

    await ingestMarketContextProviderResult({
      symbol: 'AAPL',
      domain: 'fundamentals',
      payload: { peRatio: 21.4 },
    })
    await ingestMarketContextProviderResult({
      symbol: 'AAPL',
      domain: 'fundamentals',
      runStatus: 'cancelled',
      payload: { peRatio: 22.1 },
    })

    expect(missingStatusTracker.tableCalls).toEqual([
      'torghut_market_context_runs',
      'torghut_market_context_run_events',
    ])
    expect(unknownStatusTracker.tableCalls).toEqual([
      'torghut_market_context_runs',
      'torghut_market_context_run_events',
    ])
    expect(missingStatusTracker.tableCalls).not.toContain('torghut_market_context_dispatch_state')
    expect(unknownStatusTracker.tableCalls).not.toContain('torghut_market_context_dispatch_state')
    expect(clearMarketContextCache).not.toHaveBeenCalled()
  })

  it('persists snapshots when runStatus is succeeded', async () => {
    const tracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache,
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')
    await ingestMarketContextProviderResult({
      symbol: 'AAPL',
      domain: 'fundamentals',
      runStatus: 'succeeded',
      sourceCount: 3,
      qualityScore: 0.7,
      payload: { peRatio: 21.4 },
      citations: [{ source: 'sec', publishedAt: '2026-02-26T12:00:00Z', url: null }],
      riskFlags: [],
    })

    expect(tracker.tableCalls).toEqual([
      'torghut_market_context_snapshots',
      'torghut_market_context_runs',
      'torghut_market_context_run_events',
    ])
    expect(tracker.tableCalls).not.toContain('torghut_market_context_dispatch_state')
    const snapshotValues = tracker.valueCalls.find(
      (entry) => entry.table === 'torghut_market_context_snapshots',
    )?.values
    expect(snapshotValues).toBeTruthy()
    expect(Array.isArray((snapshotValues as { citations?: unknown })?.citations)).toBe(false)
    expect(clearMarketContextCache).toHaveBeenCalledOnce()
  })

  it('guards snapshot upsert against older as_of values', async () => {
    const tracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache,
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')
    await ingestMarketContextProviderResult({
      symbol: 'AAPL',
      domain: 'fundamentals',
      runStatus: 'succeeded',
      asOfUtc: '2026-02-26T12:00:00.000Z',
      payload: { peRatio: 21.4 },
    })

    expect(tracker.conflictWhereCalls).toContainEqual({
      table: 'torghut_market_context_snapshots',
      args: ['torghut_market_context_snapshots.as_of', '<=', new Date('2026-02-26T12:00:00.000Z')],
    })
  })

  it('accepts batch ingest payloads and persists each symbol atomically', async () => {
    const tracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache,
    }))

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ market_session_open: true }) }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')
    const result = await ingestMarketContextProviderResult({
      domain: 'news',
      runStatus: 'partial',
      requestId: 'batch-req-1',
      items: [
        {
          symbol: 'AAPL',
          asOfUtc: '2026-02-26T12:00:00.000Z',
          sourceCount: 3,
          qualityScore: 0.8,
          payload: { summary: 'ok' },
          citations: [{ source: 'wire', publishedAt: '2026-02-26T11:30:00.000Z', url: null }],
          riskFlags: [],
        },
        {
          symbol: 'NVDA',
          asOfUtc: '2026-02-26T12:00:00.000Z',
          sourceCount: 2,
          qualityScore: 0.5,
          payload: { summary: 'failed' },
          citations: [],
          riskFlags: ['news_gap'],
          error: 'provider_timeout',
        },
      ],
    })

    expect(result).toMatchObject({
      ok: true,
      domain: 'news',
      runStatus: 'partial',
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
  })

  it('rejects batch payloads when items is an empty array', async () => {
    const tracker = buildInsertTracker()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache: vi.fn(),
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'fundamentals',
        runStatus: 'succeeded',
        items: [],
      }),
    ).rejects.toThrow('items must contain at least one symbol entry')
  })

  it('rejects batch payload items without a valid asOf timestamp', async () => {
    const tracker = buildInsertTracker()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache: vi.fn(),
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'news',
        runStatus: 'succeeded',
        items: [
          {
            symbol: 'AAPL',
            sourceCount: 1,
            qualityScore: 0.8,
            payload: { summary: 'ok' },
          },
        ],
      }),
    ).rejects.toThrow('items[0].asOfUtc is required and must be a valid timestamp')
  })

  it('rejects batch payload items with invalid sourceCount or qualityScore', async () => {
    const tracker = buildInsertTracker()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache: vi.fn(),
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'news',
        runStatus: 'succeeded',
        items: [
          {
            symbol: 'AAPL',
            asOfUtc: '2026-02-26T12:00:00.000Z',
            sourceCount: 1.5,
            qualityScore: 0.8,
            payload: { summary: 'ok' },
          },
        ],
      }),
    ).rejects.toThrow('items[0].sourceCount must be a non-negative integer')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'news',
        runStatus: 'succeeded',
        items: [
          {
            symbol: 'AAPL',
            asOfUtc: '2026-02-26T12:00:00.000Z',
            sourceCount: 1,
            qualityScore: 1.2,
            payload: { summary: 'ok' },
          },
        ],
      }),
    ).rejects.toThrow('items[0].qualityScore must be a number between 0 and 1')
  })

  it('rejects batch payload items with malformed payload, citations, or riskFlags', async () => {
    const tracker = buildInsertTracker()

    vi.doMock('~/server/db', () => ({
      getDb: () => tracker.db,
    }))
    vi.doMock('~/server/kysely-migrations', () => ({
      ensureMigrations: async () => undefined,
    }))
    vi.doMock('~/server/torghut-market-context', () => ({
      clearMarketContextCache: vi.fn(),
    }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'news',
        runStatus: 'succeeded',
        items: [
          {
            symbol: 'AAPL',
            asOfUtc: '2026-02-26T12:00:00.000Z',
            sourceCount: 1,
            qualityScore: 0.8,
            payload: 'invalid',
          },
        ],
      }),
    ).rejects.toThrow('items[0].payload must be an object')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'news',
        runStatus: 'succeeded',
        items: [
          {
            symbol: 'AAPL',
            asOfUtc: '2026-02-26T12:00:00.000Z',
            sourceCount: 1,
            qualityScore: 0.8,
            payload: { summary: 'ok' },
            citations: [{ source: 'wire', publishedAt: 'invalid-date' }],
          },
        ],
      }),
    ).rejects.toThrow('items[0].citations[0].publishedAt must be a valid timestamp')

    await expect(
      ingestMarketContextProviderResult({
        domain: 'news',
        runStatus: 'succeeded',
        items: [
          {
            symbol: 'AAPL',
            asOfUtc: '2026-02-26T12:00:00.000Z',
            sourceCount: 1,
            qualityScore: 0.8,
            payload: { summary: 'ok' },
            riskFlags: ['ok', ''],
          },
        ],
      }),
    ).rejects.toThrow('items[0].riskFlags[1] must be a non-empty string')
  })

  it('skips batch persistence when market session is closed', async () => {
    const tracker = buildInsertTracker()
    const clearMarketContextCache = vi.fn()
    const recordBatchRun = vi.fn()
    const recordBatchRunDurationMs = vi.fn()
    const recordBatchRunSymbols = vi.fn()

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
      recordTorghutMarketContextBatchFreshnessLagSeconds: vi.fn(),
      recordTorghutMarketContextBatchRun: recordBatchRun,
      recordTorghutMarketContextBatchRunDurationMs: recordBatchRunDurationMs,
      recordTorghutMarketContextBatchRunSymbols: recordBatchRunSymbols,
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ market_session_open: false }) }))

    const { ingestMarketContextProviderResult } = await import('../torghut-market-context-agents')
    const result = await ingestMarketContextProviderResult({
      domain: 'news',
      runStatus: 'succeeded',
      requestId: 'batch-closed-1',
      items: [
        {
          symbol: 'AAPL',
          asOfUtc: '2026-02-26T12:00:00.000Z',
          sourceCount: 0,
          qualityScore: 0,
          payload: { summary: 'noop' },
        },
      ],
    })

    expect(result).toMatchObject({
      ok: true,
      domain: 'news',
      requestId: 'batch-closed-1',
      skipped: 'market_closed',
    })
    expect(tracker.tableCalls).toEqual(['torghut_market_context_runs', 'torghut_market_context_run_events'])
    expect(clearMarketContextCache).not.toHaveBeenCalled()
    expect(recordBatchRun).toHaveBeenCalledWith({
      domain: 'news',
      outcome: 'skipped_market_closed',
    })
    expect(recordBatchRunDurationMs).toHaveBeenCalledOnce()
    expect(recordBatchRunSymbols).toHaveBeenCalledTimes(3)
  })
})
