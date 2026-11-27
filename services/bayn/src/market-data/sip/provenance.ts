import { Data, Result, Schema } from 'effect'

import {
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  UnsignedMicrosSchema,
  UtcSourceTimestampSchema,
  strictParseOptions,
} from '../../schemas'
import { compareIntradayInstants, intradayAgeNanos, millisecondsAsNanos } from '../intraday/time'
import { SipSymbolSchema, sipUniverse } from './universe'

export const sipTopics = Object.freeze({
  bars: 'bayn.market-data.sip.bars.1m.v1',
  quotes: 'bayn.market-data.sip.quotes.v1',
  trades: 'bayn.market-data.sip.trades.v1',
} as const)

export enum SipMarketSession {
  Regular = 'regular',
  Pre = 'pre',
  Post = 'post',
}

const sipFeed = 'sip'
const EquityCutFeedSchema = Schema.Literals(['iex', sipFeed])
type EquityCutFeed = typeof EquityCutFeedSchema.Type
const isEquityCutFeed = Schema.is(EquityCutFeedSchema)

// This boundary reads normalized raw records. The caller must supply source coordinates from trusted transport metadata.
const identity = {
  provider: Schema.Literal('alpaca'),
  feed: Schema.Literal(sipFeed),
  delay_class: Schema.Literal('real_time_consolidated'),
  universe_id: Schema.Literal(sipUniverse.id),
  universe_symbol_hash: Schema.Literal(sipUniverse.symbolHash),
  symbol: SipSymbolSchema,
  market_session: Schema.Enum(SipMarketSession),
  event_at: UtcSourceTimestampSchema,
  ingested_at: UtcSourceTimestampSchema,
  source_partition: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(2_147_483_647)),
  source_offset: UnsignedMicrosSchema,
  schema_version: Schema.Literal(1),
}

const SipBarSchema = Schema.Struct({
  ...identity,
  source_topic: Schema.Literal(sipTopics.bars),
  channel: Schema.Literals(['bars', 'updatedBars']),
  is_final: Schema.Literals([0, 1]),
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeFiniteSchema,
  vwap: Schema.NullOr(PositiveFiniteSchema),
  trade_count: Schema.NullOr(UnsignedMicrosSchema),
}).check(
  Schema.makeFilter(({ low, high, open, close }) => low <= Math.min(open, close) && high >= Math.max(open, close), {
    expected: 'consistent OHLC bounds',
  }),
)

const SipQuoteSchema = Schema.Struct({
  ...identity,
  source_topic: Schema.Literal(sipTopics.quotes),
  bid_price: PositiveFiniteSchema,
  bid_size: PositiveFiniteSchema,
  ask_price: PositiveFiniteSchema,
  ask_size: PositiveFiniteSchema,
}).check(Schema.makeFilter((quote) => quote.bid_price <= quote.ask_price, { expected: 'an uncrossed quote' }))

const SipTradeSchema = Schema.Struct({
  ...identity,
  source_topic: Schema.Literal(sipTopics.trades),
  price: PositiveFiniteSchema,
  size: PositiveFiniteSchema,
})

export type SipBar = typeof SipBarSchema.Type
export type SipQuote = typeof SipQuoteSchema.Type
export type SipTrade = typeof SipTradeSchema.Type
export type SipNbboQuote = SipQuote & { readonly market_session: SipMarketSession.Regular }

const SipQuoteCutSchema = Schema.Struct({
  observedAt: UtcSourceTimestampSchema,
  // Provider calendar bounds, not fixed wall-clock hours (e.g. an early close).
  regularOpenAt: UtcSourceTimestampSchema,
  regularCloseAt: UtcSourceTimestampSchema,
  maximumQuoteAgeMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
})
export type SipQuoteCut = typeof SipQuoteCutSchema.Type

export class SipAdmissionFailure extends Data.TaggedError('SipAdmissionFailure')<{
  readonly reason: 'schema' | 'feed' | 'quote-session' | 'quote-time' | 'quote-stale'
  readonly message: string
  readonly cause?: Schema.SchemaError
}> {}

const makeDecoder = <S extends Schema.Decoder<unknown>>(schema: S, label: string) => {
  const decode = Schema.decodeUnknownResult(schema, strictParseOptions)
  return (value: unknown) =>
    decode(value).pipe(
      Result.mapError((cause) => new SipAdmissionFailure({ reason: 'schema', message: `invalid ${label}`, cause })),
    )
}
export const decodeSipBar = makeDecoder(SipBarSchema, 'raw SIP bar')
export const decodeSipTrade = makeDecoder(SipTradeSchema, 'raw SIP trade')
/** Raw quote sanity and session label only; use validateSipNbboQuote for RTH pricing. */
export const decodeSipQuote = makeDecoder(SipQuoteSchema, 'raw SIP quote')
const decodeQuoteCut = makeDecoder(SipQuoteCutSchema, 'SIP quote cut')

export const validateSipNbboQuote = (
  value: unknown,
  cut: SipQuoteCut,
): Result.Result<SipNbboQuote, SipAdmissionFailure> =>
  Result.gen(function* () {
    const quote = yield* decodeSipQuote(value)
    const { observedAt, regularOpenAt, regularCloseAt, maximumQuoteAgeMs } = yield* decodeQuoteCut(cut)
    const inRegularSession = (instant: string) =>
      compareIntradayInstants(instant, regularOpenAt) >= 0 && compareIntradayInstants(instant, regularCloseAt) < 0
    if (
      quote.market_session !== SipMarketSession.Regular ||
      !inRegularSession(quote.event_at) ||
      !inRegularSession(observedAt)
    )
      return yield* Result.fail(
        new SipAdmissionFailure({
          reason: 'quote-session',
          message: 'SIP NBBO requires a quote and cut in the same RTH session',
        }),
      )
    const age = intradayAgeNanos(observedAt, quote.event_at)
    if (age < 0n || compareIntradayInstants(quote.ingested_at, observedAt) > 0)
      return yield* Result.fail(
        new SipAdmissionFailure({ reason: 'quote-time', message: 'SIP quote was not available at the cut' }),
      )
    if (age > millisecondsAsNanos(maximumQuoteAgeMs))
      return yield* Result.fail(
        new SipAdmissionFailure({ reason: 'quote-stale', message: 'SIP quote exceeds the cut age limit' }),
      )
    return { ...quote, market_session: SipMarketSession.Regular }
  })

/** After per-record admission, bind the whole projection, bar history or RVOL cut to its declared feed. */
export const assertHomogeneousFeedCut = (
  observations: readonly { readonly feed: unknown }[],
  expectedFeed: EquityCutFeed,
): Result.Result<void, SipAdmissionFailure> => {
  if (!isEquityCutFeed(expectedFeed))
    return Result.fail(new SipAdmissionFailure({ reason: 'feed', message: 'unsupported equity cut feed' }))
  for (const [index, observation] of observations.entries()) {
    if (observation?.feed !== expectedFeed)
      return Result.fail(
        new SipAdmissionFailure({
          reason: 'feed',
          message: `observation ${index} does not match the ${expectedFeed} cut`,
        }),
      )
  }
  return Result.succeed(undefined)
}
