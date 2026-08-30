import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { loadIntradayArchivePages } from './program'
import type { IntradayArchivePageCursor } from './queries'
import { decodeIntradayQuoteRows } from './rows'

const quoteRow = (eventAt: string, sourceOffset: string) => ({
  provider: 'alpaca',
  universe_id: 'opening-drive-v1',
  universe_symbol_hash: 'a'.repeat(64),
  feed: 'iex',
  market_session: 'regular',
  delay_class: 'real_time_exchange_only',
  symbol: 'AMD',
  event_at: eventAt,
  ingested_at: eventAt,
  source_topic: 'quotes',
  source_partition: '0',
  source_offset: sourceOffset,
  latest_payload_variants: '1',
  bid_price: '100',
  bid_size: '1',
  ask_price: '100.01',
  ask_size: '1',
  schema_version: '1',
})

describe('intraday archive pagination', () => {
  test('loads complete bounded pages with an advancing canonical cursor', async () => {
    const pages = [
      [quoteRow('2026-08-18T13:30:00.000000001Z', '1'), quoteRow('2026-08-18T13:30:00.000000002Z', '2')],
      [quoteRow('2026-08-18T13:30:00.000000003Z', '3'), quoteRow('2026-08-18T13:30:00.000000004Z', '4')],
      [quoteRow('2026-08-18T13:30:00.000000005Z', '5')],
    ] as const
    const cursors: Array<IntradayArchivePageCursor | undefined> = []
    let index = 0

    const rows = await Effect.runPromise(
      loadIntradayArchivePages(
        (after) => {
          cursors.push(after)
          return Effect.succeed(pages[index++] ?? [])
        },
        decodeIntradayQuoteRows,
        5,
        2,
      ),
    )

    expect(rows).toHaveLength(5)
    expect(cursors).toEqual([
      undefined,
      {
        eventAt: '2026-08-18T13:30:00.000000002Z',
        symbol: 'AMD',
        sourceTopic: 'quotes',
        sourcePartition: 0,
        sourceOffset: '2',
      },
      {
        eventAt: '2026-08-18T13:30:00.000000004Z',
        symbol: 'AMD',
        sourceTopic: 'quotes',
        sourcePartition: 0,
        sourceOffset: '4',
      },
    ])
  })

  test('fails closed when a full page does not advance', async () => {
    const page = [quoteRow('2026-08-18T13:30:00.000000001Z', '1')]
    const exit = await Effect.runPromiseExit(
      loadIntradayArchivePages(() => Effect.succeed(page), decodeIntradayQuoteRows, 2, 1),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('fails closed before retaining rows beyond the aggregate process budget', async () => {
    const page = [quoteRow('2026-08-18T13:30:00.000000001Z', '1'), quoteRow('2026-08-18T13:30:00.000000002Z', '2')]
    const exit = await Effect.runPromiseExit(
      loadIntradayArchivePages(() => Effect.succeed(page), decodeIntradayQuoteRows, 1, 2),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
