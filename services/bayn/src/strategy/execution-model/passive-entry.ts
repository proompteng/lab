import { Data, Redacted, Result, Schema } from 'effect'

import {
  AssetClass,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus as BrokerStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
  type Order as BrokerOrder,
} from '../../broker/alpaca/model'
import { alpacaLimitPriceIncrementMicros, quantizeInstrumentPriceMicros } from '../../broker/alpaca-price'
import { OrderSide } from '../../execution/contracts'
import { compareIntradayInstants, intradayAgeNanos, millisecondsAsNanos } from '../../market-data/intraday/time'
import { type SipQuoteCut, validateSipNbboQuote } from '../../market-data/sip/provenance'
import { strictParseOptions, UtcSourceTimestampSchema } from '../../schemas'
import { ensureUnsigned, scaledNumber } from './fixed-point'
import { BPS } from './model'

export enum EntryPricingMode {
  PassiveNbbo = 'PASSIVE_NBBO',
}

export const PassiveEntryPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.passive-entry-execution.v1'),
  mode: Schema.Enum(EntryPricingMode),
  maximumQuoteAgeMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_000 })),
  minimumDwellMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  reanchorDeadbandBpsOfSpread: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number(BPS) })),
})
export type PassiveEntryPolicy = typeof PassiveEntryPolicySchema.Type

export class PassiveEntryExecutionError extends Data.TaggedError('PassiveEntryExecutionError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const executionError = (message: string, cause?: unknown) =>
  new PassiveEntryExecutionError({ message, ...(cause === undefined ? {} : { cause: Redacted.make(cause) }) })

export const decodePassiveEntryPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    PassiveEntryPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => executionError('Invalid passive entry policy', cause)),
    Result.map((policy) => Object.freeze(policy)),
  )

export interface PassiveEntryMarket {
  readonly cut: Omit<SipQuoteCut, 'maximumQuoteAgeMs'>
  readonly quote?: unknown
  /** Last available SIP quote in each completed regular minute before the pricing quote's minute, oldest first. */
  readonly completedMinuteQuotes: readonly unknown[]
}

type PassivePricing =
  | { readonly _tag: 'Price'; readonly limitPriceMicros: bigint; readonly spreadMicros: bigint }
  | { readonly _tag: 'Defer'; readonly reason: 'MissingNbbo' | 'SpreadWarmup' | 'AbnormalSpread' | 'NoPassiveTick' }

const minuteMs = 60_000
const spreadWindowMinutes = 5
const isUtc = Schema.is(UtcSourceTimestampSchema)
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const max = (a: bigint, b: bigint) => (a > b ? a : b)

const invalid = (message: string) => Result.fail(executionError(message))

const readQuote = (value: unknown, cut: SipQuoteCut, symbol: string) =>
  Result.gen(function* () {
    const quote = yield* validateSipNbboQuote(value, cut).pipe(
      Result.mapError((cause) => executionError('Invalid SIP execution quote', cause)),
    )
    if (quote.symbol !== symbol || compareIntradayInstants(quote.ingested_at, quote.event_at) < 0) {
      return yield* invalid('SIP execution quote has the wrong symbol or precedes its own event')
    }
    const pricesAndSizes = yield* Result.all({
      bid: scaledNumber(quote.bid_price, 'bid price'),
      ask: scaledNumber(quote.ask_price, 'ask price'),
      bidSize: scaledNumber(quote.bid_size, 'bid size'),
      askSize: scaledNumber(quote.ask_size, 'ask size'),
    }).pipe(Result.mapError((cause) => executionError('Invalid SIP quote precision', cause)))
    const { bid, ask, bidSize, askSize } = pricesAndSizes
    if (bid <= 0n || ask < bid || bidSize <= 0n || askSize <= 0n) return yield* invalid('Invalid SIP quote economics')
    return { ...pricesAndSizes, eventAt: quote.event_at, spread: ask - bid, twiceMidpoint: ask + bid }
  })

interface PassiveEntryInput {
  readonly policy: PassiveEntryPolicy
  readonly symbol: string
  readonly side: OrderSide
  readonly adverseLimitMicros: bigint
  readonly market: PassiveEntryMarket
}

/** Prices exposure-increasing limits only. It never widens the caller's buy ceiling or short-sale floor. */
export const pricePassiveEntry = (
  input: PassiveEntryInput,
): Result.Result<PassivePricing, PassiveEntryExecutionError> =>
  Result.gen(function* () {
    const { policy, symbol, side, adverseLimitMicros, market } = input
    if (adverseLimitMicros <= 0n) return yield* invalid('Passive entry requires a positive adverse price bound')
    if (market.quote === undefined) return { _tag: 'Defer', reason: 'MissingNbbo' } as const
    const current = yield* readQuote(
      market.quote,
      { ...market.cut, maximumQuoteAgeMs: policy.maximumQuoteAgeMs },
      symbol,
    )
    const regularOpen = Date.parse(market.cut.regularOpenAt)
    const currentMinute = Math.floor(Date.parse(current.eventAt) / minuteMs) * minuteMs
    const oldestMinute = currentMinute - spreadWindowMinutes * minuteMs
    if (market.completedMinuteQuotes.length > spreadWindowMinutes) return yield* invalid('Excess SIP spread samples')
    if (oldestMinute < regularOpen || market.completedMinuteQuotes.length < spreadWindowMinutes) {
      return { _tag: 'Defer', reason: 'SpreadWarmup' } as const
    }

    const history = []
    for (const [index, value] of market.completedMinuteQuotes.entries()) {
      const start = oldestMinute + index * minuteMs
      const end = start + minuteMs
      const endAt = new Date(end).toISOString()
      const sample = yield* readQuote(value, { ...market.cut, observedAt: endAt, maximumQuoteAgeMs: minuteMs }, symbol)
      const event = Date.parse(sample.eventAt)
      if (event < start || event >= end) return yield* invalid('SIP spread sample is outside its preceding minute')
      history.push(sample)
    }
    // Compare spreads as a fraction of midpoint; common factors cancel. Keep an exact strict 2.5× boundary.
    history.sort((a, b) => {
      const delta = a.spread * b.twiceMidpoint - b.spread * a.twiceMidpoint
      return delta < 0n ? -1 : delta > 0n ? 1 : 0
    })
    const median = history[2]
    if (median === undefined) return yield* invalid('Missing SIP spread median')
    if (2n * current.spread * median.twiceMidpoint > 5n * median.spread * current.twiceMidpoint) {
      return { _tag: 'Defer', reason: 'AbnormalSpread' } as const
    }

    const isBuy = side === OrderSide.Buy
    const low = quantizeInstrumentPriceMicros(
      symbol,
      isBuy ? current.bid : max(current.bid + 1n, adverseLimitMicros),
      'UP',
    )
    const high = quantizeInstrumentPriceMicros(
      symbol,
      isBuy ? min(current.ask - 1n, adverseLimitMicros) : current.ask,
      'DOWN',
    )
    if (low > high) return { _tag: 'Defer', reason: 'NoPassiveTick' } as const

    // Weight each price by opposite-side depth. Round toward the passive side, joining the same-side touch
    // if tick rounding or the original collar leaves no strictly interior price for that side.
    const numerator = current.ask * current.bidSize + current.bid * current.askSize
    const depth = current.bidSize + current.askSize
    const microprice = isBuy ? numerator / depth : (numerator + depth - 1n) / depth
    const tick = quantizeInstrumentPriceMicros(symbol, microprice, isBuy ? 'DOWN' : 'UP')
    return { _tag: 'Price', limitPriceMicros: max(low, min(high, tick)), spreadMicros: current.spread } as const
  })

/**
 * Discretionary repricing of a fresh, exactly reconciled, owned exposure-increasing order only. The owner must
 * resolve pending mutations before calling, then establish terminality/residual and replan before replacing.
 * Expiry, risk stops, and reducing orders must not go through this guard.
 */
export const planPassiveEntryReanchor = (input: PassiveEntryInput & { readonly order: BrokerOrder }) =>
  Result.gen(function* () {
    const { policy, symbol, side, market, order } = input
    const { observedAt } = market.cut
    const keep = { _tag: 'Keep' } as const
    const workingSince = order.updatedAt
    if (
      order.symbol !== symbol ||
      order.assetClass !== AssetClass.UsEquity ||
      order.side !== (side === OrderSide.Buy ? BrokerSide.Buy : BrokerSide.Sell) ||
      order.orderType !== BrokerOrderType.Limit ||
      order.timeInForce !== BrokerTimeInForce.Day ||
      order.extendedHours ||
      order.orderClass !== OrderClass.Simple ||
      order.parentBrokerOrderId !== undefined ||
      (order.legs?.length ?? 0) !== 0 ||
      order.replacedBy !== undefined ||
      order.status !== BrokerStatus.New ||
      order.filledQuantityAtoms !== '0' ||
      order.limitPriceMicros === undefined ||
      order.submittedAt === undefined ||
      workingSince === undefined ||
      !isUtc(workingSince) ||
      !isUtc(order.submittedAt) ||
      !isUtc(order.observedAt) ||
      !isUtc(observedAt) ||
      compareIntradayInstants(workingSince, order.submittedAt) < 0 ||
      compareIntradayInstants(order.observedAt, workingSince) < 0 ||
      compareIntradayInstants(observedAt, order.observedAt) < 0 ||
      intradayAgeNanos(observedAt, workingSince) < millisecondsAsNanos(policy.minimumDwellMs)
    )
      return keep

    const working = yield* ensureUnsigned(order.limitPriceMicros, 'working price', 1n).pipe(
      Result.mapError((cause) => executionError('Invalid working entry price', cause)),
    )
    const proposed = yield* pricePassiveEntry(input)
    if (proposed._tag === 'Defer') return keep
    const delta = max(working, proposed.limitPriceMicros) - min(working, proposed.limitPriceMicros)
    const tick = alpacaLimitPriceIncrementMicros(proposed.limitPriceMicros)
    return delta > tick && delta * BPS > proposed.spreadMicros * BigInt(policy.reanchorDeadbandBpsOfSpread)
      ? ({ _tag: 'CancelForReanchor', brokerOrderId: order.brokerOrderId } as const)
      : keep
  })
