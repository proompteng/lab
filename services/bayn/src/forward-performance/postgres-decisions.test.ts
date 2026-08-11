import { describe, expect, test } from 'bun:test'

import { intentExecutionKey, uniqueRows } from './postgres-decisions'

describe('forward-performance postgres decisions', () => {
  test('marks duplicate decoded rows as ambiguous instead of choosing one', () => {
    const rows = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'a', value: 3 },
    ] as const

    const indexed = uniqueRows(rows, (row) => row.id)

    expect(indexed.get('a')).toBeNull()
    expect(indexed.get('b')).toEqual({ id: 'b', value: 2 })
  })

  test('canonically includes absent replan generations as null in intent keys', () => {
    const base = {
      cycleId: 'cycle',
      decisionHash: 'decision',
      accountId: 'account',
      symbol: 'NVDA',
      side: 'BUY' as const,
      quantityMicros: '1000000',
      createdAt: '2026-08-12T13:00:00.000Z',
    }

    expect(intentExecutionKey(base)).toContain(',null,')
    expect(intentExecutionKey(base)).not.toBe(intentExecutionKey({ ...base, replanGenerationHash: 'generation' }))
  })
})
