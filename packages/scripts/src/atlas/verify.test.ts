import { describe, expect, it } from 'bun:test'

import { __private } from './verify'

describe('atlas verify', () => {
  it('observes Atlas queries by relation lock instead of truncated activity text', async () => {
    let statement = ''
    const db = ((strings: TemplateStringsArray) => {
      statement = strings.join('')
      return Promise.resolve([{ active: 2n }])
    }) as Parameters<typeof __private.activeAtlasQueryCount>[0]

    expect(await __private.activeAtlasQueryCount(db)).toBe(2)
    expect(statement).toContain('INNER JOIN pg_locks AS relation_lock')
    expect(statement).toContain("relation_lock.relation = 'atlas.chunk_embeddings'::regclass")
    expect(statement).not.toContain('activity.query')
  })

  it('uses a unique cold query for every performance request', () => {
    const queries = [
      { query: 'exact identifier', expectedPaths: ['src/exact.ts'] },
      {
        query: 'conceptual search',
        expectedPaths: ['src/concept.ts'],
        language: 'typescript',
        minimumResults: 10,
      },
    ]

    const performanceQueries = __private.buildColdPerformanceQueries(queries, 3, 'proof')

    expect(performanceQueries).toHaveLength(6)
    expect(new Set(performanceQueries.map((query) => query.query)).size).toBe(6)
    expect(performanceQueries.filter((query) => query.query.startsWith('exact identifier\n'))).toHaveLength(3)
    expect(performanceQueries.every((query) => query.query.includes('Atlas latency probe proof-'))).toBe(true)
    expect(
      performanceQueries
        .filter((query) => query.query.startsWith('conceptual search\n'))
        .every((query) => query.language === 'typescript' && query.minimumResults === 10),
    ).toBe(true)
  })

  it('requires canceled queries to drain before the statement-timeout fallback', async () => {
    let now = 0
    const lingering = await __private.waitForAtlasQueryDrain({
      activeQueryCount: async () => 2,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    })

    expect(lingering).toBe(2)
    expect(now).toBe(__private.cancellationDrainDeadlineMs)
    expect(now).toBeLessThan(750)
  })

  it('accepts client cancellation that drains blocked queries promptly', async () => {
    let now = 0
    const activeCounts = [2, 1, 0]
    const lingering = await __private.waitForAtlasQueryDrain({
      activeQueryCount: async () => activeCounts.shift() ?? 0,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    })

    expect(lingering).toBe(0)
    expect(now).toBeLessThan(__private.cancellationDrainDeadlineMs)
  })

  it('requires every absent-path search to return zero results', () => {
    expect(__private.absentPathSearchError('src/deleted.ts', [])).toBeUndefined()
    expect(__private.absentPathSearchError('src/deleted.ts', ['src/live.ts'])).toBe(
      'deleted path search returned 1 result(s) for src/deleted.ts: src/live.ts',
    )
  })
})
