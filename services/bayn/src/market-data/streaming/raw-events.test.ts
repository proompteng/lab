import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { decodeRawMarketRecord, RawMarketEventKind, type StreamingUniverse } from './raw-events'

const universe: StreamingUniverse = {
  universeId: 'timestamp-contract',
  universeSymbolHash: '0'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features' },
}
const decode = (eventTs: string, ingestTs: string) =>
  decodeRawMarketRecord(
    {
      topic: 'quotes',
      partition: 0,
      offset: '1',
      value: JSON.stringify({
        version: 2,
        provider: 'alpaca',
        feed: 'iex',
        delayClass: 'real_time_exchange_only',
        marketSession: 'regular',
        channel: 'quotes',
        symbol: 'AAPL',
        eventTs,
        ingestTs,
        payload: { t: eventTs, bp: 200, ap: 200.01, bs: 100, as: 100 },
      }),
    },
    universe,
  )

test.each([
  ['2026-09-11T14:00:02Z', '2026-09-11T14:00:02Z', '2026-09-11T14:00:02.000000000Z', '2026-09-11T14:00:02.000000000Z'],
  [
    '2026-09-11T14:00:02.123456789Z',
    '2026-09-11T14:00:02.123456789Z',
    '2026-09-11T14:00:02.123456789Z',
    '2026-09-11T14:00:02.123456789Z',
  ],
  [
    '2026-09-11T14:00:02.1Z',
    '2026-09-11T14:00:02.100000000Z',
    '2026-09-11T14:00:02.100000000Z',
    '2026-09-11T14:00:02.100000000Z',
  ],
  [
    '2026-09-11T14:00:02.123456789Z',
    '2026-09-11T14:00:02.123456790Z',
    '2026-09-11T14:00:02.123456789Z',
    '2026-09-11T14:00:02.123456790Z',
  ],
])('raw timestamps preserve equal and independent instants: %s / %s', (eventTs, ingestTs, eventAt, ingestedAt) => {
  const decoded = Result.getOrThrow(decode(eventTs, ingestTs))
  expect(decoded.kind).toBe(RawMarketEventKind.Quote)
  if (decoded.kind !== RawMarketEventKind.Quote) throw new Error('quote expected')
  expect(decoded.value.eventAt).toBe(eventAt)
  expect(decoded.value.ingestedAt).toBe(ingestedAt)
})

test.each(['invalid', '2026-02-30T14:00:02Z', '2026-09-11T14:00:02.1234567890Z', '2026-09-11T14:00:02+00:00'])(
  'raw timestamps reject invalid equal and independent ingestion values: %s',
  (invalid) => {
    expect(Result.isFailure(decode(invalid, invalid))).toBe(true)
    expect(Result.isFailure(decode('2026-09-11T14:00:02Z', invalid))).toBe(true)
  },
)
