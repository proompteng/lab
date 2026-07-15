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
      { query: 'conceptual search', expectedPaths: ['src/concept.ts'] },
    ]

    const performanceQueries = __private.buildColdPerformanceQueries(queries, 3, 'proof')

    expect(performanceQueries).toHaveLength(6)
    expect(new Set(performanceQueries).size).toBe(6)
    expect(performanceQueries.filter((query) => query.startsWith('exact identifier\n'))).toHaveLength(3)
    expect(performanceQueries.every((query) => query.includes('Atlas latency probe proof-'))).toBe(true)
  })

  it('requires every absent-path search to return zero results', () => {
    expect(__private.absentPathSearchError('src/deleted.ts', [])).toBeUndefined()
    expect(__private.absentPathSearchError('src/deleted.ts', ['src/live.ts'])).toBe(
      'deleted path search returned 1 result(s) for src/deleted.ts: src/live.ts',
    )
  })
})
