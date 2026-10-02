import { Schema } from 'effect'
import type { IntradayQuote, IntradaySnapshotQuery } from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import type { ObservedMarketValue } from '../market-data/streaming/projection'
import {
  NonNegativeIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
} from '../schemas'
import type { IntradayReplayIocCoreOutcome } from './execution-core'

export enum ReplayQuoteRejection {
  Missing = 'missing-arrival-quote',
  Identity = 'arrival-quote-identity-mismatch',
  Price = 'invalid-arrival-quote-price',
  Unavailable = 'arrival-quote-not-yet-available',
  Future = 'arrival-quote-event-in-future',
  Stale = 'stale-arrival-quote',
}

export type ReplayQuoteProtocol = Pick<IntradaySnapshotQuery, 'feed' | 'delayClass'> & {
  readonly maximumQuoteAgeMs: number
}

export const replayQuoteRejection = (
  quote: ObservedMarketValue<IntradayQuote> | undefined,
  symbol: string,
  nowMs: number,
  protocol: ReplayQuoteProtocol,
): ReplayQuoteRejection | null => {
  if (quote === undefined) return ReplayQuoteRejection.Missing
  if (
    quote.value.symbol !== symbol ||
    quote.value.feed !== protocol.feed ||
    quote.value.delayClass !== protocol.delayClass ||
    quote.value.marketSession !== 'regular'
  )
    return ReplayQuoteRejection.Identity
  if (
    !(quote.value.bidPrice > 0 && quote.value.askPrice >= quote.value.bidPrice && Number.isFinite(quote.value.askPrice))
  )
    return ReplayQuoteRejection.Price
  if (quote.availableAtMs > nowMs) return ReplayQuoteRejection.Unavailable
  const age = BigInt(nowMs) * 1_000_000n - intradayInstantNanos(quote.value.eventAt)
  if (age < 0n) return ReplayQuoteRejection.Future
  if (age > BigInt(protocol.maximumQuoteAgeMs) * 1_000_000n) return ReplayQuoteRejection.Stale
  return null
}

const ArrivalQuoteSchema = Schema.Struct({
  symbol: StrictNonEmptyStringSchema,
  feed: StrictNonEmptyStringSchema,
  delayClass: StrictNonEmptyStringSchema,
  marketSession: StrictNonEmptyStringSchema,
  eventAt: StrictNonEmptyStringSchema,
  ingestedAt: StrictNonEmptyStringSchema,
  sourceTopic: StrictNonEmptyStringSchema,
  sourcePartition: NonNegativeIntegerSchema,
  sourceOffset: UnsignedMicrosSchema,
  recordHash: Sha256Schema,
  availableAtMs: NonNegativeIntegerSchema,
  ageNanos: SignedMicrosSchema,
  bidPrice: Schema.Finite,
  askPrice: Schema.Finite,
  bidSize: Schema.Finite,
  askSize: Schema.Finite,
})

export const ReplayOrderExecutionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulated-order-execution.v1'),
  submittedAt: UtcInstantSchema,
  arrivedAt: UtcInstantSchema,
  maximumQuoteAgeMs: NonNegativeIntegerSchema,
  quote: Schema.NullOr(ArrivalQuoteSchema),
  outcome: Schema.Union([
    Schema.Struct({
      status: Schema.Literal('filled'),
      filledQuantityMicros: UnsignedMicrosSchema,
      fillPriceMicros: UnsignedMicrosSchema,
      fillNotionalMicros: UnsignedMicrosSchema,
      unfilledRemainder: Schema.Literals(['none', 'canceled']),
    }),
    Schema.Struct({
      status: Schema.Literal('canceled'),
      reason: Schema.Union([
        Schema.Enum(ReplayQuoteRejection),
        Schema.Literals([
          'outside-regular-session',
          'adverse-price-exceeds-limit',
          'no-displayed-liquidity',
          'zero-after-whole-share-rounding',
        ]),
      ]),
      adversePriceMicros: Schema.NullOr(UnsignedMicrosSchema),
    }),
    Schema.Struct({
      status: Schema.Literal('rejected'),
      reason: Schema.Literals(['insufficient-cash', 'oversell']),
    }),
  ]),
})
export type ReplayOrderExecution = typeof ReplayOrderExecutionSchema.Type

export const makeReplayOrderExecution = (input: {
  readonly submittedAt: string
  readonly arrivedAt: string
  readonly maximumQuoteAgeMs: number
  readonly quote: ObservedMarketValue<IntradayQuote> | undefined
  readonly outcome:
    | IntradayReplayIocCoreOutcome
    | {
        readonly status: 'unavailable'
        readonly reason: ReplayQuoteRejection | 'outside-regular-session'
      }
}): ReplayOrderExecution => {
  const { quote, outcome } = input
  return {
    schemaVersion: 'bayn.simulated-order-execution.v1',
    submittedAt: input.submittedAt,
    arrivedAt: input.arrivedAt,
    maximumQuoteAgeMs: input.maximumQuoteAgeMs,
    quote:
      quote === undefined
        ? null
        : {
            symbol: quote.value.symbol,
            feed: quote.value.feed,
            delayClass: quote.value.delayClass,
            marketSession: quote.value.marketSession,
            eventAt: quote.value.eventAt,
            ingestedAt: quote.value.ingestedAt,
            sourceTopic: quote.value.sourceTopic,
            sourcePartition: quote.value.sourcePartition,
            sourceOffset: quote.value.sourceOffset,
            recordHash: quote.recordHash,
            availableAtMs: quote.availableAtMs,
            ageNanos: (
              BigInt(Date.parse(input.arrivedAt)) * 1_000_000n -
              intradayInstantNanos(quote.value.eventAt)
            ).toString(),
            bidPrice: quote.value.bidPrice,
            askPrice: quote.value.askPrice,
            bidSize: quote.value.bidSize,
            askSize: quote.value.askSize,
          },
    outcome:
      outcome.status === 'unavailable'
        ? {
            status: 'canceled',
            reason: outcome.reason,
            adversePriceMicros: null,
          }
        : outcome.status === 'canceled'
          ? {
              status: 'canceled',
              reason: outcome.reason,
              adversePriceMicros: outcome.adversePriceMicros.toString(),
            }
          : {
              status: 'filled',
              filledQuantityMicros: outcome.filledQuantityMicros.toString(),
              fillPriceMicros: outcome.fillPriceMicros.toString(),
              fillNotionalMicros: outcome.fillNotionalMicros.toString(),
              unfilledRemainder: outcome.unfilledRemainder,
            },
  }
}
