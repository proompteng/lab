import { Data, Result, Schema } from 'effect'
import { Sha256Schema } from '../../schemas'
import { intradayInstantNanos } from '../intraday/time'
import type { HistoricalMarketArrival } from '../streaming/historical'
import type { StreamingUniverse } from '../streaming/raw-events'
import type { StoredHistoricalCapture, VendorHistoricalRow } from './model'

export class RestArrivalFailure extends Data.TaggedError('RestArrivalFailure')<{
  readonly message: string
}> {}

/** REST has no original stream arrival. These are explicitly modeled ingestion times and virtual coordinates. */
export const restCaptureArrivals = (input: {
  readonly datasetId: string
  readonly capture: StoredHistoricalCapture
  readonly topics: StreamingUniverse['topics']
  readonly sessionOpenAt: string
  readonly sessionCloseAt: string
  readonly rawDeliveryDelayMs: number
  readonly barFinalizationDelayMs: number
}) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(Sha256Schema)(input.datasetId)
    for (const delay of [input.rawDeliveryDelayMs, input.barFinalizationDelayMs]) {
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000)
        return yield* Result.fail(
          new RestArrivalFailure({ message: 'REST delivery delays must be whole milliseconds from zero to 60000' }),
        )
    }
    const openMs = Date.parse(input.sessionOpenAt)
    const closeMs = Date.parse(input.sessionCloseAt)
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || openMs >= closeMs)
      return yield* Result.fail(
        new RestArrivalFailure({ message: 'REST arrival normalization requires a valid session interval' }),
      )
    const capture = input.capture
    const pending: { readonly availableAtMs: number; readonly ordinal: number; readonly row: VendorHistoricalRow }[] =
      []
    for (const [ordinal, row] of capture.rows.entries()) {
      const nanos = intradayInstantNanos(row.eventAt)
      if (nanos < BigInt(openMs) * 1_000_000n || nanos >= BigInt(closeMs) * 1_000_000n) continue
      if (capture.kind === 'bars' && nanos % 60_000_000_000n !== 0n)
        return yield* Result.fail(
          new RestArrivalFailure({ message: 'REST bars must start on exact minute boundaries' }),
        )
      const availableAtMs =
        Number((nanos + 999_999n) / 1_000_000n) +
        (capture.kind === 'bars' ? 60_000 + input.barFinalizationDelayMs : input.rawDeliveryDelayMs)
      pending.push({ availableAtMs, ordinal, row })
    }
    pending.sort(
      (a, b) =>
        a.availableAtMs - b.availableAtMs ||
        a.row.eventAt.localeCompare(b.row.eventAt) ||
        a.row.symbol.localeCompare(b.row.symbol) ||
        a.ordinal - b.ordinal,
    )
    return {
      count: pending.length,
      arrivals: {
        *[Symbol.iterator](): Generator<HistoricalMarketArrival> {
          for (const [offset, { row, ordinal, availableAtMs }] of pending.entries()) {
            const payload =
              'open' in row
                ? {
                    o: row.open,
                    h: row.high,
                    l: row.low,
                    c: row.close,
                    v: row.volume,
                    vw: row.vwap,
                    n: row.tradeCount,
                    t: row.eventAt,
                  }
                : 'bidPrice' in row
                  ? {
                      bp: row.bidPrice,
                      bs: row.bidSize,
                      ap: row.askPrice,
                      as: row.askSize,
                      bx: row.bidExchange,
                      ax: row.askExchange,
                      c: row.conditions,
                      z: row.tape,
                      t: row.eventAt,
                    }
                  : {
                      p: row.price,
                      s: row.size,
                      i: row.providerTradeId,
                      x: row.exchange,
                      c: row.conditions,
                      z: row.tape,
                      t: row.eventAt,
                    }
            const envelope = {
              provider: 'alpaca',
              feed: capture.provenance.feed,
              delayClass: 'real_time_exchange_only',
              marketSession: 'regular',
              channel: capture.kind,
              symbol: row.symbol,
              eventTs: row.eventAt,
              ingestTs: new Date(availableAtMs).toISOString(),
              version: 2,
              seq: ordinal,
              ...(capture.kind === 'bars' ? { isFinal: true } : {}),
              payload,
              provenance: {
                transport: 'historical-rest',
                normalization: 'bayn.alpaca-rest-arrivals.v1',
                datasetId: input.datasetId,
                queryHash: capture.provenance.queryHash,
                retrievedAt: capture.provenance.retrievedAt,
                rowOrdinal: ordinal,
                ingestionTime: 'MODELED',
                originalStreamAvailability: 'NOT_OBSERVED',
              },
            }
            yield {
              availableAtMs,
              record: {
                topic: input.topics[capture.kind],
                partition: 0,
                offset: String(offset),
                value: JSON.stringify(envelope),
              },
            }
          }
        },
      },
    }
  })
