import { describe, expect, it, vi } from 'vitest'

import type { ClickHouseClient } from '~/server/clickhouse'
import { computeFallbackRange, queryLatestTaTableEventTs } from '~/server/torghut-ta'

describe('queryLatestTaTableEventTs', () => {
  it('scopes the aggregate to the latest active partition day before falling back to a full-table scan', async () => {
    const queryJson = vi
      .fn<ClickHouseClient['queryJson']>()
      .mockResolvedValueOnce([{ as_of_ms: 1_742_342_400_000 }])
      .mockResolvedValueOnce([{ latest: '2025-03-19 12:34:56.789' }])

    const latest = await queryLatestTaTableEventTs({
      client: { queryJson },
      table: 'ta_signals',
      symbol: 'BTC-USD',
    })

    expect(latest).toBe('2025-03-19 12:34:56.789')
    expect(queryJson).toHaveBeenCalledTimes(2)
    expect(queryJson.mock.calls[0]?.[0]).toContain('FROM system.parts')
    expect(queryJson.mock.calls[1]?.[0]).toContain('FROM ta_signals')
    expect(queryJson.mock.calls[1]?.[0]).toContain('event_ts >= {partition_start:DateTime}')
    expect(queryJson.mock.calls[1]?.[0]).toContain('event_ts < {partition_end:DateTime}')
    expect(queryJson.mock.calls[1]?.[1]).toMatchObject({
      symbol: 'BTC-USD',
      partition_start: new Date('2025-03-19T00:00:00.000Z'),
      partition_end: new Date('2025-03-20T00:00:00.000Z'),
    })
  })

  it('falls back to the symbol-scoped aggregate when partition metadata is unavailable', async () => {
    const queryJson = vi
      .fn<ClickHouseClient['queryJson']>()
      .mockRejectedValueOnce(new Error('system.parts unavailable'))
      .mockResolvedValueOnce([{ latest: '2025-03-18 23:59:59.999' }])

    const latest = await queryLatestTaTableEventTs({
      client: { queryJson },
      table: 'ta_microbars',
      symbol: 'ETH-USD',
    })

    expect(latest).toBe('2025-03-18 23:59:59.999')
    expect(queryJson).toHaveBeenCalledTimes(2)
    expect(queryJson.mock.calls[1]?.[0]).toContain('SELECT max(event_ts) as latest')
    expect(queryJson.mock.calls[1]?.[0]).not.toContain('partition_start')
    expect(queryJson.mock.calls[1]?.[1]).toEqual({ symbol: 'ETH-USD' })
  })
})

describe('computeFallbackRange', () => {
  it('re-centers the requested window around the latest event when the requested range is stale', () => {
    expect(
      computeFallbackRange({
        from: '2025-03-18T00:00:00.000',
        to: '2025-03-18T01:00:00.000',
        latest: '2025-03-19 12:00:00.000',
      }),
    ).toEqual({
      from: '2025-03-19T11:00:00.000',
      to: '2025-03-19T12:00:00.000',
    })
  })

  it('returns null when the requested range already includes the latest event', () => {
    expect(
      computeFallbackRange({
        from: '2025-03-19T11:00:00.000',
        to: '2025-03-19T13:00:00.000',
        latest: '2025-03-19 12:00:00.000',
      }),
    ).toBeNull()
  })
})
