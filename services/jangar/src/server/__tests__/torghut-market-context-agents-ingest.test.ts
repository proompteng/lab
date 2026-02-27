import { beforeEach, describe, expect, it, vi } from 'vitest'

type InsertTracker = {
  tableCalls: string[]
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
  const conflictWhereCalls: Array<{
    table: string
    args: unknown[]
  }> = []
  const db = {
    insertInto: (table: string) => {
      tableCalls.push(table)
      const chain = {
        values: () => chain,
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
  return { tableCalls, conflictWhereCalls, db }
}

describe('ingestMarketContextProviderResult', () => {
  beforeEach(() => {
    vi.resetModules()
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

    expect(tracker.tableCalls).toEqual(['torghut_market_context_dispatch_state'])
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

    expect(missingStatusTracker.tableCalls).toEqual(['torghut_market_context_dispatch_state'])
    expect(unknownStatusTracker.tableCalls).toEqual(['torghut_market_context_dispatch_state'])
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

    expect(tracker.tableCalls).toEqual(['torghut_market_context_snapshots', 'torghut_market_context_dispatch_state'])
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
})
