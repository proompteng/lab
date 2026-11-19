import { Data, Result, Schema } from 'effect'
import { OrderSide } from '../broker/alpaca/model'
import { equityClockSession } from '../equity-hours'
import { canonicalHashV1Result, sha256 } from '../hash'
import type { IntradayQuote } from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import type { ObservedMarketValue, ObservedQuoteSource } from '../market-data/streaming/projection'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, UtcSourceTimestampSchema, strictParseOptions } from '../schemas'
import { replayQuoteRejection } from './broker-execution-evidence'

export const sipExecutionFeed = {
  feed: 'sip',
  delayClass: 'real_time_consolidated',
} as const

export const EquityExecutionTapeReferenceSchema = Schema.Struct({
  sha256: Sha256Schema,
  startAt: UtcInstantSchema,
  endAt: UtcInstantSchema,
})
export type EquityExecutionTapeReference = typeof EquityExecutionTapeReferenceSchema.Type

const PositivePrice = Schema.Finite.check(Schema.isGreaterThan(0))
const Size = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const MarketEvent = {
  symbol: SymbolSchema,
  at: UtcSourceTimestampSchema,
}
const TapeSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.historical-sip-execution-tape.v1'),
  startAt: UtcInstantSchema,
  endAt: UtcInstantSchema,
  events: Schema.NonEmptyArray(
    Schema.Union([
      Schema.Struct({
        ...MarketEvent,
        kind: Schema.Literal('quote'),
        bid: Size,
        ask: Size,
        bidSize: Size,
        askSize: Size,
      }),
      Schema.Struct({ ...MarketEvent, kind: Schema.Literal('trade'), price: PositivePrice }),
    ]),
  ),
})

export class EquityExecutionTapeFailure extends Data.TaggedError('EquityExecutionTapeFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

type Quote = ObservedMarketValue<IntradayQuote>
type Entry =
  | { readonly kind: 'quote'; readonly atMs: number; readonly quote: Quote }
  | {
      readonly kind: 'trade'
      readonly atMs: number
      readonly symbol: string
      readonly price: number
      readonly quote: Quote | undefined
    }

const topic = 'bayn.research.alpaca-sip.quotes.v1'

/** Historical SIP uses event time as modeled availability. The strategy's native source is acquired separately. */
export const decodeEquityExecutionTape = (
  text: string,
  reference: EquityExecutionTapeReference,
  universe: { readonly universeId: string; readonly universeSymbolHash: string; readonly symbols: readonly string[] },
) =>
  Result.gen(function* () {
    if (sha256(text) !== reference.sha256)
      return yield* Result.fail(new EquityExecutionTapeFailure({ message: 'Equity execution tape digest differs' }))
    const decoded = yield* Schema.decodeUnknownResult(Schema.fromJsonString(TapeSchema), strictParseOptions)(text)
    const startNs = intradayInstantNanos(reference.startAt)
    const endNs = intradayInstantNanos(reference.endAt)
    if (decoded.startAt !== reference.startAt || decoded.endAt !== reference.endAt || startNs >= endNs)
      return yield* Result.fail(new EquityExecutionTapeFailure({ message: 'Equity execution tape interval differs' }))

    const allowed = new Set(universe.symbols)
    const quotes = new Map<string, Quote[]>()
    const latest = new Map<string, Quote>()
    const entries: Entry[] = []
    let previousNs = startNs
    for (const [index, event] of decoded.events.entries()) {
      const ns = intradayInstantNanos(event.at)
      if (!allowed.has(event.symbol) || ns < previousNs || ns > endNs)
        return yield* Result.fail(
          new EquityExecutionTapeFailure({ message: 'Equity execution tape order or scope differs' }),
        )
      previousNs = ns
      const atMs = Number((ns + 999_999n) / 1_000_000n)
      if (event.kind === 'trade') {
        const quote = latest.get(event.symbol)
        entries.push({
          kind: 'trade',
          atMs,
          symbol: event.symbol,
          price: event.price,
          quote: quote !== undefined && intradayInstantNanos(quote.value.eventAt) < ns ? quote : undefined,
        })
        continue
      }
      const marketSession = equityClockSession(event.at)
      if (marketSession === null)
        return yield* Result.fail(
          new EquityExecutionTapeFailure({ message: 'Equity execution tape quote is outside the SIP session' }),
        )
      const quote: Quote = {
        value: {
          provider: 'alpaca',
          ...sipExecutionFeed,
          universeId: universe.universeId,
          universeSymbolHash: universe.universeSymbolHash,
          marketSession,
          symbol: event.symbol,
          eventAt: event.at,
          ingestedAt: new Date(atMs).toISOString(),
          sourceTopic: topic,
          sourcePartition: 0,
          sourceOffset: String(index),
          schemaVersion: 1,
          bidPrice: event.bid,
          askPrice: event.ask,
          bidSize: event.bidSize,
          askSize: event.askSize,
        },
        availableAtMs: atMs,
        recordHash: yield* canonicalHashV1Result(event),
        sequence: index,
      }
      const series = quotes.get(event.symbol) ?? []
      series.push(quote)
      quotes.set(event.symbol, series)
      latest.set(event.symbol, quote)
      entries.push({ kind: 'quote', atMs, quote })
    }
    if (quotes.size !== allowed.size)
      return yield* Result.fail(
        new EquityExecutionTapeFailure({ message: 'Equity execution tape has missing symbol quotes' }),
      )

    return {
      hash: reference.sha256,
      startAt: reference.startAt,
      endAt: reference.endAt,
      universeId: universe.universeId,
      universeSymbolHash: universe.universeSymbolHash,
      entry: (index: number): Entry | undefined => entries[index],
      quoteAt: (symbol: string, nowMs: number, source: ObservedQuoteSource | null): Quote | undefined => {
        if (source !== null) {
          const entry = entries[Number(source.offset)]
          return entry?.kind === 'quote' &&
            entry.quote.value.sourceOffset === source.offset &&
            source.topic === topic &&
            source.partition === 0 &&
            entry.quote.value.symbol === symbol &&
            entry.atMs === source.availableAtMs &&
            entry.atMs <= nowMs
            ? entry.quote
            : undefined
        }
        const series = quotes.get(symbol)
        if (series === undefined) return
        let low = 0
        let high = series.length
        while (low < high) {
          const mid = Math.floor((low + high) / 2)
          if ((series[mid]?.availableAtMs ?? Infinity) <= nowMs) low = mid + 1
          else high = mid
        }
        return series[low - 1]
      },
    }
  }).pipe(
    Result.mapError((cause) => new EquityExecutionTapeFailure({ message: 'Invalid equity execution tape', cause })),
  )

export type EquityExecutionTape = Result.Result.Success<ReturnType<typeof decodeEquityExecutionTape>>

export const equityStopTradeQuote = (input: {
  readonly tape: EquityExecutionTape
  readonly index: number
  readonly symbol: string
  readonly side: OrderSide
  readonly stopMicros: string
  readonly atMs: number
  readonly maximumQuoteAgeMs: number
}): Quote | undefined => {
  const event = input.tape.entry(input.index)
  if (
    event?.kind !== 'trade' ||
    event.atMs !== input.atMs ||
    event.symbol !== input.symbol ||
    event.quote === undefined
  )
    return
  const { quote, price } = event
  const stopPrice = Number(input.stopMicros) / 1_000_000
  return replayQuoteRejection(quote, event.symbol, event.atMs, {
    ...sipExecutionFeed,
    maximumQuoteAgeMs: input.maximumQuoteAgeMs,
  }) === null &&
    price >= quote.value.bidPrice &&
    price <= quote.value.askPrice &&
    (input.side === OrderSide.Buy ? price >= stopPrice : price <= stopPrice)
    ? quote
    : undefined
}
