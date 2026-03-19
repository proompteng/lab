import { describe, expect, it, vi } from 'vitest'

import {
  computeFallbackRange,
  formatClickHouseDateTime64,
  parseClickHouseDateTime64,
  queryLatestTaTableEventTs,
} from '../torghut-ta'

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

describe('queryLatestTaTableEventTs', () => {
  it('scopes latest lookups to the newest active partition when metadata is available', async () => {
    const queryJson = vi
      .fn()
      .mockResolvedValueOnce([{ as_of_ms: 1772834348000 }])
      .mockResolvedValueOnce([{ latest: '2026-03-06T21:59:08.000Z' }])

    const latest = await queryLatestTaTableEventTs({
      client: { queryJson },
      table: 'ta_signals',
      symbol: 'NVDA',
    })

    expect(latest).toBe('2026-03-06T21:59:08.000Z')
    expect(queryJson).toHaveBeenCalledTimes(2)
    expect(queryJson.mock.calls[0]?.[0]).toContain("table = 'ta_signals'")
    expect(queryJson.mock.calls[1]?.[0]).toContain('WHERE symbol = {symbol:String}')
    expect(queryJson.mock.calls[1]?.[0]).toContain('AND event_ts >= {partition_start:DateTime}')
    expect(queryJson.mock.calls[1]?.[1]).toEqual({
      symbol: 'NVDA',
      partition_start: new Date('2026-03-06T00:00:00.000Z'),
      partition_end: new Date('2026-03-07T00:00:00.000Z'),
    })
  })

  it('falls back to the symbol-scoped aggregate when metadata lookup fails', async () => {
    const queryJson = vi
      .fn()
      .mockRejectedValueOnce(new Error('memory limit exceeded'))
      .mockResolvedValueOnce([{ latest: '2026-03-06T21:59:08.000Z' }])

    const latest = await queryLatestTaTableEventTs({
      client: { queryJson },
      table: 'ta_microbars',
      symbol: 'AAPL',
    })

    expect(latest).toBe('2026-03-06T21:59:08.000Z')
    expect(queryJson).toHaveBeenCalledTimes(2)
    expect(queryJson.mock.calls[1]?.[0]).toContain('SELECT max(event_ts) as latest')
    expect(queryJson.mock.calls[1]?.[0]).toContain('FROM ta_microbars')
    expect(queryJson.mock.calls[1]?.[1]).toEqual({ symbol: 'AAPL' })
  })
})
