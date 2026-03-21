import { describe, expect, it, vi } from 'vitest'

import type { ClickHouseClient, ClickHouseParams } from '~/server/clickhouse'
import { computeFallbackRange, queryLatestTaTableEventTs } from '~/server/torghut-ta'

const mockClickHouseClient = (queryJson: ReturnType<typeof vi.fn>): ClickHouseClient => ({
  queryJson: async <T = Record<string, unknown>>(query: string, params?: ClickHouseParams) =>
    (await (queryJson as unknown as (query: string, params?: ClickHouseParams) => Promise<T[]>)(query, params)) as T[],
})

describe('queryLatestTaTableEventTs', () => {
  it('uses a symbol-scoped latest-row query for ta_signals', async () => {
    const queryJson = vi.fn<ClickHouseClient['queryJson']>().mockResolvedValueOnce([{ latest: '2025-03-19 12:34:56.789' }])

    const latest = await queryLatestTaTableEventTs({
      client: mockClickHouseClient(queryJson),
      table: 'ta_signals',
      symbol: 'BTC-USD',
    })

    expect(latest).toBe('2025-03-19 12:34:56.789')
    expect(queryJson).toHaveBeenCalledTimes(1)
    expect(queryJson.mock.calls[0]?.[0]).toContain('SELECT event_ts as latest')
    expect(queryJson.mock.calls[0]?.[0]).toContain('FROM ta_signals')
    expect(queryJson.mock.calls[0]?.[0]).toContain('WHERE symbol = {symbol:String}')
    expect(queryJson.mock.calls[0]?.[0]).toContain('ORDER BY event_ts DESC, symbol DESC, seq DESC')
    expect(queryJson.mock.calls[0]?.[0]).toContain('LIMIT 1')
    expect(queryJson.mock.calls[0]?.[1]).toMatchObject({
      symbol: 'BTC-USD',
    })
  })

  it('uses a symbol-scoped latest-row query for ta_microbars', async () => {
    const queryJson = vi.fn<ClickHouseClient['queryJson']>().mockResolvedValueOnce([{ latest: '2025-03-18 23:59:59.999' }])

    const latest = await queryLatestTaTableEventTs({
      client: mockClickHouseClient(queryJson),
      table: 'ta_microbars',
      symbol: 'ETH-USD',
    })

    expect(latest).toBe('2025-03-18 23:59:59.999')
    expect(queryJson).toHaveBeenCalledTimes(1)
    expect(queryJson.mock.calls[0]?.[0]).toContain('SELECT event_ts as latest')
    expect(queryJson.mock.calls[0]?.[0]).toContain('FROM ta_microbars')
    expect(queryJson.mock.calls[0]?.[0]).toContain('WHERE symbol = {symbol:String}')
    expect(queryJson.mock.calls[0]?.[0]).toContain('ORDER BY event_ts DESC, symbol DESC')
    expect(queryJson.mock.calls[0]?.[0]).toContain('LIMIT 1')
    expect(queryJson.mock.calls[0]?.[1]).toEqual({ symbol: 'ETH-USD' })
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
