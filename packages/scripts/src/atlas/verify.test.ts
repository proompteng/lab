import { describe, expect, it } from 'bun:test'

import { __private } from './verify'

describe('atlas verify', () => {
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
})
