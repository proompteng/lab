import { Result, Schema } from 'effect'

import { MarketFeatureFailure } from '../features/contract'
import { normalizeBar, normalizeQuote, normalizeTrade } from '../intraday/verification'
import { decodeIntradayBarRows, decodeIntradayQuoteRows, decodeIntradayTradeRows } from '../intraday/rows'
import type { IntradayBar, IntradayQuote, IntradayTrade } from '../intraday/model'

export enum RawMarketEventKind {
  Bar = 'bar',
  Quote = 'quote',
  Trade = 'trade',
  Ignored = 'ignored',
}
export type RawMarketEvent =
  | { readonly kind: RawMarketEventKind.Bar; readonly value: IntradayBar }
  | { readonly kind: RawMarketEventKind.Quote; readonly value: IntradayQuote }
  | { readonly kind: RawMarketEventKind.Trade; readonly value: IntradayTrade }
  | { readonly kind: RawMarketEventKind.Ignored }

export interface KafkaMarketRecord {
  readonly timestampMs?: number
  readonly topic: string
  readonly partition: number
  readonly offset: string
  readonly value: string
}
export interface StreamingUniverse {
  readonly universeId: string
  readonly universeSymbolHash: string
  readonly symbols: readonly string[]
  readonly topics: {
    readonly bars: string
    readonly quotes: string
    readonly trades: string
    readonly features: string
  }
}

const EnvelopeSchema = Schema.Struct({
  provider: Schema.Literal('alpaca'),
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  marketSession: Schema.Literals(['regular', 'pre', 'post', 'overnight']),
  channel: Schema.Literals(['bars', 'updatedBars', 'quotes', 'trades']),
  symbol: Schema.String,
  eventTs: Schema.String,
  ingestTs: Schema.String,
  version: Schema.Literal(2),
  isFinal: Schema.optional(Schema.Boolean),
  payload: Schema.Unknown,
})
const BarPayloadSchema = Schema.Struct({
  o: Schema.Finite,
  h: Schema.Finite,
  l: Schema.Finite,
  c: Schema.Finite,
  v: Schema.Finite,
  vw: Schema.optional(Schema.NullOr(Schema.Finite)),
  n: Schema.optional(
    Schema.NullOr(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    ),
  ),
  t: Schema.String,
})
const QuotePayloadSchema = Schema.Struct({
  bp: Schema.Finite,
  bs: Schema.Finite,
  ap: Schema.Finite,
  as: Schema.Finite,
  t: Schema.String,
})
const TradePayloadSchema = Schema.Struct({ p: Schema.Finite, s: Schema.Finite, t: Schema.String })
const fail = (message: string, cause?: unknown) =>
  new MarketFeatureFailure({ reason: 'schema', message, ...(cause === undefined ? {} : { cause }) })

export const canonicalRawTimestamp = (value: string): Result.Result<string, MarketFeatureFailure> => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  const seconds = match?.[1]
  if (seconds === undefined) return Result.fail(fail('raw market timestamp must be a UTC instant'))
  const epoch = Date.parse(`${seconds}.000Z`)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 19) !== seconds)
    return Result.fail(fail('invalid raw market timestamp'))
  return Result.succeed(`${seconds}.${(match?.[2] ?? '').padEnd(9, '0')}Z`)
}

export const decodeRawMarketRecord = (
  record: KafkaMarketRecord,
  universe: StreamingUniverse,
): Result.Result<RawMarketEvent, MarketFeatureFailure> =>
  Result.gen(function* () {
    const json: unknown = yield* Result.try({
      try: () => JSON.parse(record.value),
      catch: (cause) => fail('raw market message is not JSON', cause),
    })
    const envelope = yield* Schema.decodeUnknownResult(EnvelopeSchema)(json).pipe(
      Result.mapError((cause) => fail('invalid raw market envelope', cause)),
    )
    if (!universe.symbols.includes(envelope.symbol))
      return yield* Result.fail(fail('raw market symbol is outside the configured universe'))
    const expectedTopic =
      envelope.channel === 'bars' || envelope.channel === 'updatedBars'
        ? universe.topics.bars
        : envelope.channel === 'quotes'
          ? universe.topics.quotes
          : universe.topics.trades
    if (record.topic !== expectedTopic) return yield* Result.fail(fail('raw market topic does not match its channel'))
    const eventAt = yield* canonicalRawTimestamp(envelope.eventTs)
    const ingestedAt = yield* canonicalRawTimestamp(envelope.ingestTs)
    if (
      record.timestampMs !== undefined &&
      (!Number.isSafeInteger(record.timestampMs) || Math.abs(record.timestampMs - Date.parse(ingestedAt)) > 5000)
    )
      return yield* Result.fail(fail('Kafka timestamp violates the producer clock contract'))
    const identity = {
      provider: envelope.provider,
      universe_id: universe.universeId,
      universe_symbol_hash: universe.universeSymbolHash,
      feed: envelope.feed,
      market_session: envelope.marketSession,
      delay_class: envelope.delayClass,
      symbol: envelope.symbol,
      event_at: eventAt,
      ingested_at: ingestedAt,
      source_topic: record.topic,
      source_partition: record.partition,
      source_offset: record.offset,
      schema_version: 1,
    }
    switch (envelope.channel) {
      case 'bars':
      case 'updatedBars': {
        const payload = yield* Schema.decodeUnknownResult(BarPayloadSchema)(envelope.payload).pipe(
          Result.mapError((cause) => fail('invalid raw bar', cause)),
        )
        if ((yield* canonicalRawTimestamp(payload.t)) !== eventAt)
          return yield* Result.fail(fail('bar payload timestamp differs from envelope'))
        if (envelope.marketSession !== 'regular') return { kind: RawMarketEventKind.Ignored }
        const decoded = yield* decodeIntradayBarRows([
          {
            ...identity,
            channel: envelope.channel,
            is_final: envelope.isFinal === false ? 0 : 1,
            open: payload.o,
            high: payload.h,
            low: payload.l,
            close: payload.c,
            volume: payload.v,
            vwap: payload.vw ?? null,
            trade_count: payload.n === undefined || payload.n === null ? null : String(payload.n),
          },
        ]).pipe(Result.mapError((cause) => fail('invalid raw bar row', cause)))
        const row = decoded[0]
        if (row === undefined) return yield* Result.fail(fail('decoded bar is missing'))
        const value = yield* normalizeBar(row).pipe(Result.mapError((cause) => fail('invalid normalized bar', cause)))
        return { kind: RawMarketEventKind.Bar, value }
      }
      case 'quotes': {
        const payload = yield* Schema.decodeUnknownResult(QuotePayloadSchema)(envelope.payload).pipe(
          Result.mapError((cause) => fail('invalid raw quote', cause)),
        )
        if ((yield* canonicalRawTimestamp(payload.t)) !== eventAt)
          return yield* Result.fail(fail('quote payload timestamp differs from envelope'))
        if (envelope.marketSession !== 'regular') return { kind: RawMarketEventKind.Ignored }
        const decoded = yield* decodeIntradayQuoteRows([
          { ...identity, bid_price: payload.bp, bid_size: payload.bs, ask_price: payload.ap, ask_size: payload.as },
        ]).pipe(Result.mapError((cause) => fail('invalid raw quote row', cause)))
        const row = decoded[0]
        if (row === undefined) return yield* Result.fail(fail('decoded quote is missing'))
        const value = yield* normalizeQuote(row).pipe(
          Result.mapError((cause) => fail('invalid normalized quote', cause)),
        )
        return { kind: RawMarketEventKind.Quote, value }
      }
      case 'trades': {
        const payload = yield* Schema.decodeUnknownResult(TradePayloadSchema)(envelope.payload).pipe(
          Result.mapError((cause) => fail('invalid raw trade', cause)),
        )
        if ((yield* canonicalRawTimestamp(payload.t)) !== eventAt)
          return yield* Result.fail(fail('trade payload timestamp differs from envelope'))
        if (envelope.marketSession !== 'regular') return { kind: RawMarketEventKind.Ignored }
        const decoded = yield* decodeIntradayTradeRows([{ ...identity, price: payload.p, size: payload.s }]).pipe(
          Result.mapError((cause) => fail('invalid raw trade row', cause)),
        )
        const row = decoded[0]
        if (row === undefined) return yield* Result.fail(fail('decoded trade is missing'))
        const value = yield* normalizeTrade(row).pipe(
          Result.mapError((cause) => fail('invalid normalized trade', cause)),
        )
        return { kind: RawMarketEventKind.Trade, value }
      }
    }
  })
