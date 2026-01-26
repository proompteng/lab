import { describe, expect, it } from 'vitest'

import { computeFallbackRange, formatClickHouseDateTime64, parseClickHouseDateTime64 } from '../torghut-ta'

describe('computeFallbackRange', () => {
  it('returns null when latest timestamp is within the requested range', () => {
    const result = computeFallbackRange({
      from: '2026-01-10T00:00:00.000',
      to: '2026-01-11T00:00:00.000',
      latest: '2026-01-10 12:00:00.000',
    })
    expect(result).toBeNull()
  })

  it('anchors the window to the latest timestamp when the range has no data', () => {
    const latest = '2026-01-12 14:30:55.000'
    const latestDate = parseClickHouseDateTime64(latest)
    if (!latestDate) {
      throw new Error('Expected latest timestamp to parse')
    }
    const expectedFrom = formatClickHouseDateTime64(new Date(latestDate.getTime() - 24 * 60 * 60 * 1000))
    const expectedTo = formatClickHouseDateTime64(latestDate)

    const result = computeFallbackRange({
      from: '2026-01-25T00:00:00.000',
      to: '2026-01-26T00:00:00.000',
      latest,
    })

    expect(result).toEqual({ from: expectedFrom, to: expectedTo })
  })
})
