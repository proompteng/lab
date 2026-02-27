import { beforeEach, describe, expect, it, vi } from 'vitest'

type InsertTracker = {
  tableCalls: string[]
  db: {
    insertInto: (table: string) => {
      values: (value: unknown) => unknown
      onConflict: (value: unknown) => unknown
      execute: () => Promise<void>
    }
  }
}

const buildInsertTracker = (): InsertTracker => {
  const tableCalls: string[] = []
  const db = {
    insertInto: (table: string) => {
      tableCalls.push(table)
      const chain = {
        values: () => chain,
        onConflict: () => chain,
        execute: async () => undefined,
      }
      return chain
    },
  }
  return { tableCalls, db }
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
})
