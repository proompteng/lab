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

export enum ExecutionPricingStage {
  Passive = 'PASSIVE',
  Marketable = 'MARKETABLE',
}

export enum PassiveReanchorReason {
  QuoteDrift = 'QUOTE_DRIFT',
  TimeDecayEscalation = 'TIME_DECAY_ESCALATION',
}

export enum PassiveDeferReason {
  MissingNbbo = 'MissingNbbo',
  SpreadWarmup = 'SpreadWarmup',
  AbnormalSpread = 'AbnormalSpread',
  NoPassiveTick = 'NoPassiveTick',
  ExceedsAdverseBound = 'ExceedsAdverseBound',
}

export const PassiveEntryPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.passive-entry-execution.v1'),
  mode: Schema.Enum(EntryPricingMode),
  maximumQuoteAgeMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_000 })),
  minimumDwellMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  reanchorDeadbandBpsOfSpread: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number(BPS) })),
  escalateToMarketableAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 59_000 }))),
  marketablePaddingBps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25 }))),
  maximumSpreadBps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  minimumReanchorTicks: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  maximumReanchors: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
}).check(
  Schema.makeFilter((policy) => {
    const issues: Schema.FilterIssue[] = []
    if (
      policy.escalateToMarketableAfterMs !== undefined &&
      policy.escalateToMarketableAfterMs < policy.minimumDwellMs
    ) {
      issues.push({
        path: ['escalateToMarketableAfterMs'],
        issue: 'escalation delay must be at least minimumDwellMs',
      })
    }
    if (policy.marketablePaddingBps !== undefined && policy.escalateToMarketableAfterMs === undefined) {
      issues.push({
        path: ['marketablePaddingBps'],
        issue: 'marketablePaddingBps requires escalateToMarketableAfterMs',
      })
    }
    return issues
  }),
)
export type PassiveEntryPolicy = typeof PassiveEntryPolicySchema.Type

export const PassiveExitPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.passive-exit-execution.v1'),
  mode: Schema.Enum(EntryPricingMode),
  maximumQuoteAgeMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_000 })),
  minimumDwellMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  reanchorDeadbandBpsOfSpread: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number(BPS) })),
  escalateToMarketableAfterMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 115_000 })),
  mandatoryEscalationLeadMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60_000 })),
  marketableSlippageBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  minimumReanchorTicks: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  maximumReanchors: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
}).check(
  Schema.makeFilter((policy) =>
    policy.escalateToMarketableAfterMs < policy.minimumDwellMs
      ? [{ path: ['escalateToMarketableAfterMs'], issue: 'escalation delay must be at least minimumDwellMs' }]
      : [],
  ),
)
export type PassiveExitPolicy = typeof PassiveExitPolicySchema.Type

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

export const decodePassiveExitPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    PassiveExitPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => executionError('Invalid passive exit policy', cause)),
    Result.map((policy) => Object.freeze(policy)),
  )

export interface PassiveEntryMarket {
  readonly cut: Omit<SipQuoteCut, 'maximumQuoteAgeMs'>
  readonly quote?: unknown
  /** Last available SIP quote in each completed regular minute before the pricing quote's minute, oldest first. */
  readonly completedMinuteQuotes: readonly unknown[]
}

export type PassivePricing =
  | {
      readonly _tag: 'Price'
      readonly stage: ExecutionPricingStage
      readonly limitPriceMicros: bigint
      readonly spreadMicros: bigint
      readonly marketableTouchPriceMicros: bigint
    }
  | { readonly _tag: 'Defer'; readonly reason: PassiveDeferReason }

export type PassiveExitPricing = {
  readonly _tag: 'Price'
  readonly stage: ExecutionPricingStage
  readonly limitPriceMicros: bigint
  readonly spreadMicros: bigint
  readonly marketableTouchPriceMicros: bigint
}

export type PassiveReanchorDecision =
  | { readonly _tag: 'Keep' }
  | {
      readonly _tag: 'CancelForReanchor'
      readonly brokerOrderId: string
      readonly reason: PassiveReanchorReason
      readonly targetStage: ExecutionPricingStage
      readonly proposedLimitPriceMicros: bigint
    }

const minuteMs = 60_000
const spreadWindowMinutes = 5
const defaultMinimumReanchorTicks = 2
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

const passiveMicropriceLimit = (
  symbol: string,
  side: OrderSide,
  current: {
    readonly bid: bigint
    readonly ask: bigint
    readonly bidSize: bigint
    readonly askSize: bigint
  },
  adverseLimitMicros?: bigint,
): bigint | null => {
  const isBuy = side === OrderSide.Buy
  const low = quantizeInstrumentPriceMicros(
    symbol,
    isBuy
      ? current.bid
      : adverseLimitMicros === undefined
        ? current.bid + 1n
        : max(current.bid + 1n, adverseLimitMicros),
    'UP',
  )
  const high = quantizeInstrumentPriceMicros(
    symbol,
    isBuy
      ? adverseLimitMicros === undefined
        ? current.ask - 1n
        : min(current.ask - 1n, adverseLimitMicros)
      : current.ask,
    'DOWN',
  )
  if (low > high) return null
  // Weight each price by opposite-side depth. Round toward the passive side, joining the same-side touch
  // if tick rounding or the original collar leaves no strictly interior price for that side.
  const numerator = current.ask * current.bidSize + current.bid * current.askSize
  const depth = current.bidSize + current.askSize
  const microprice = isBuy ? numerator / depth : (numerator + depth - 1n) / depth
  const tick = quantizeInstrumentPriceMicros(symbol, microprice, isBuy ? 'DOWN' : 'UP')
  return max(low, min(high, tick))
}

interface PassiveEntryInput {
  readonly policy: PassiveEntryPolicy
  readonly symbol: string
  readonly side: OrderSide
  readonly adverseLimitMicros: bigint
  readonly market: PassiveEntryMarket
  /** Causal start of the entry checkpoint lease; required when time-decay escalation is enabled. */
  readonly windowStartedAt?: string
}

/** Prices exposure-increasing limits only. It never widens the caller's buy ceiling or short-sale floor. */
export const pricePassiveEntry = (
  input: PassiveEntryInput,
): Result.Result<PassivePricing, PassiveEntryExecutionError> =>
  Result.gen(function* () {
    const { policy, symbol, side, adverseLimitMicros, market, windowStartedAt } = input
    if (adverseLimitMicros <= 0n) return yield* invalid('Passive entry requires a positive adverse price bound')
    let stage = ExecutionPricingStage.Passive
    if (policy.escalateToMarketableAfterMs !== undefined) {
      if (
        windowStartedAt === undefined ||
        !isUtc(windowStartedAt) ||
        !isUtc(market.cut.observedAt) ||
        compareIntradayInstants(market.cut.observedAt, windowStartedAt) < 0
      ) {
        return yield* invalid('Time-decay passive entry escalation requires a causal window start')
      }
      if (
        intradayAgeNanos(market.cut.observedAt, windowStartedAt) >=
        millisecondsAsNanos(policy.escalateToMarketableAfterMs)
      ) {
        stage = ExecutionPricingStage.Marketable
      }
    }
    if (market.quote === undefined) return { _tag: 'Defer', reason: PassiveDeferReason.MissingNbbo } as const
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
      return { _tag: 'Defer', reason: PassiveDeferReason.SpreadWarmup } as const
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
      return { _tag: 'Defer', reason: PassiveDeferReason.AbnormalSpread } as const
    }
    if (
      policy.maximumSpreadBps !== undefined &&
      2n * current.spread * BPS > BigInt(policy.maximumSpreadBps) * current.twiceMidpoint
    ) {
      return { _tag: 'Defer', reason: PassiveDeferReason.AbnormalSpread } as const
    }

    const isBuy = side === OrderSide.Buy
    const marketableTouchPriceMicros = isBuy ? current.ask : current.bid
    if (stage === ExecutionPricingStage.Marketable) {
      const paddingBps = BigInt(policy.marketablePaddingBps ?? 0)
      if (isBuy) {
        const touch = quantizeInstrumentPriceMicros(symbol, current.ask, 'UP')
        const collar = quantizeInstrumentPriceMicros(symbol, adverseLimitMicros, 'DOWN')
        if (touch > collar) return { _tag: 'Defer', reason: PassiveDeferReason.ExceedsAdverseBound } as const
        const padded = quantizeInstrumentPriceMicros(symbol, (current.ask * (BPS + paddingBps)) / BPS, 'DOWN')
        return {
          _tag: 'Price',
          stage,
          limitPriceMicros: max(touch, min(collar, padded)),
          spreadMicros: current.spread,
          marketableTouchPriceMicros,
        } as const
      }
      const touch = quantizeInstrumentPriceMicros(symbol, current.bid, 'DOWN')
      const collar = quantizeInstrumentPriceMicros(symbol, adverseLimitMicros, 'UP')
      if (touch < collar) return { _tag: 'Defer', reason: PassiveDeferReason.ExceedsAdverseBound } as const
      const padded = quantizeInstrumentPriceMicros(symbol, (current.bid * (BPS - paddingBps) + BPS - 1n) / BPS, 'UP')
      return {
        _tag: 'Price',
        stage,
        limitPriceMicros: min(touch, max(collar, padded)),
        spreadMicros: current.spread,
        marketableTouchPriceMicros,
      } as const
    }

    const limitPriceMicros = passiveMicropriceLimit(symbol, side, current, adverseLimitMicros)
    if (limitPriceMicros === null) return { _tag: 'Defer', reason: PassiveDeferReason.NoPassiveTick } as const
    return {
      _tag: 'Price',
      stage,
      limitPriceMicros,
      spreadMicros: current.spread,
      marketableTouchPriceMicros,
    } as const
  })

const isUntouchedWorkingLimitOrder = (
  order: BrokerOrder,
  symbol: string,
  side: OrderSide,
  observedAt: string,
): { readonly workingSince: string; readonly limitPriceMicros: string } | null => {
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
    compareIntradayInstants(observedAt, order.observedAt) < 0
  ) {
    return null
  }
  return { workingSince, limitPriceMicros: order.limitPriceMicros }
}

const decideReanchorFromProposal = (input: {
  readonly order: BrokerOrder
  readonly side: OrderSide
  readonly working: bigint
  readonly proposed: {
    readonly stage: ExecutionPricingStage
    readonly limitPriceMicros: bigint
    readonly spreadMicros: bigint
    readonly marketableTouchPriceMicros: bigint
  }
  readonly reanchorDeadbandBpsOfSpread: number
  readonly minimumReanchorTicks?: number
  readonly maximumReanchors?: number
  readonly reanchorCount: number
}): PassiveReanchorDecision => {
  const {
    order,
    side,
    working,
    proposed,
    reanchorDeadbandBpsOfSpread,
    minimumReanchorTicks,
    maximumReanchors,
    reanchorCount,
  } = input
  const isBuy = side === OrderSide.Buy
  if (proposed.stage === ExecutionPricingStage.Marketable) {
    // Retain working orders that still cross the current NBBO touch even when the padded proposal moves further.
    const alreadyMarketable = isBuy
      ? working >= proposed.marketableTouchPriceMicros
      : working <= proposed.marketableTouchPriceMicros
    return alreadyMarketable
      ? ({ _tag: 'Keep' } as const)
      : ({
          _tag: 'CancelForReanchor',
          brokerOrderId: order.brokerOrderId,
          reason: PassiveReanchorReason.TimeDecayEscalation,
          targetStage: ExecutionPricingStage.Marketable,
          proposedLimitPriceMicros: proposed.limitPriceMicros,
        } as const)
  }
  if (maximumReanchors !== undefined && reanchorCount >= maximumReanchors) return { _tag: 'Keep' } as const
  const delta = max(working, proposed.limitPriceMicros) - min(working, proposed.limitPriceMicros)
  const tick = alpacaLimitPriceIncrementMicros(proposed.limitPriceMicros)
  const minDelta = BigInt(minimumReanchorTicks ?? defaultMinimumReanchorTicks) * tick
  return delta >= minDelta && delta * BPS > proposed.spreadMicros * BigInt(reanchorDeadbandBpsOfSpread)
    ? ({
        _tag: 'CancelForReanchor',
        brokerOrderId: order.brokerOrderId,
        reason: PassiveReanchorReason.QuoteDrift,
        targetStage: ExecutionPricingStage.Passive,
        proposedLimitPriceMicros: proposed.limitPriceMicros,
      } as const)
    : ({ _tag: 'Keep' } as const)
}

/**
 * Discretionary repricing of a fresh, exactly reconciled, owned exposure-increasing order only. The owner must
 * resolve pending mutations before calling, then establish terminality/residual and replan before replacing.
 * Expiry, risk stops, and reducing orders must not go through this guard.
 */
export const planPassiveEntryReanchor = (
  input: PassiveEntryInput & { readonly order: BrokerOrder; readonly reanchorCount?: number },
): Result.Result<PassiveReanchorDecision, PassiveEntryExecutionError> =>
  Result.gen(function* () {
    const { policy, symbol, side, market, order, reanchorCount = 0 } = input
    if (!Number.isSafeInteger(reanchorCount) || reanchorCount < 0) {
      return yield* invalid('Reanchor count must be a nonnegative safe integer')
    }
    const { observedAt } = market.cut
    const keep = { _tag: 'Keep' } as const
    const workingOrder = isUntouchedWorkingLimitOrder(order, symbol, side, observedAt)
    if (
      workingOrder === null ||
      intradayAgeNanos(observedAt, workingOrder.workingSince) < millisecondsAsNanos(policy.minimumDwellMs)
    ) {
      return keep
    }

    const working = yield* ensureUnsigned(workingOrder.limitPriceMicros, 'working price', 1n).pipe(
      Result.mapError((cause) => executionError('Invalid working entry price', cause)),
    )
    const proposed = yield* pricePassiveEntry(input)
    if (proposed._tag === 'Defer') return keep
    return decideReanchorFromProposal({
      order,
      side,
      working,
      proposed,
      reanchorDeadbandBpsOfSpread: policy.reanchorDeadbandBpsOfSpread,
      ...(policy.minimumReanchorTicks === undefined ? {} : { minimumReanchorTicks: policy.minimumReanchorTicks }),
      ...(policy.maximumReanchors === undefined ? {} : { maximumReanchors: policy.maximumReanchors }),
      reanchorCount,
    })
  })

export interface PassiveExitInput {
  readonly policy: PassiveExitPolicy
  readonly symbol: string
  readonly side: OrderSide
  readonly market: Pick<PassiveEntryMarket, 'cut' | 'quote'>
  /** Causal start of the exit window (e.g. 15:58 flatten start or opposite-band checkpoint). */
  readonly windowStartedAt: string
  /** Hard submission cutoff before market close (e.g. 15:59 or regularCloseAt). */
  readonly deadlineAt: string
}

/**
 * Prices reduce-only timed/signal exits with passive NBBO microprice capture during early dwell and
 * guaranteed time-decay escalation to a marketable touch limit before the close deadline.
 */
export const pricePassiveExit = (
  input: PassiveExitInput,
): Result.Result<PassiveExitPricing, PassiveEntryExecutionError> =>
  Result.gen(function* () {
    const { policy, symbol, side, market, windowStartedAt, deadlineAt } = input
    const { observedAt, regularOpenAt, regularCloseAt } = market.cut
    if (
      !isUtc(windowStartedAt) ||
      !isUtc(deadlineAt) ||
      !isUtc(observedAt) ||
      !isUtc(regularOpenAt) ||
      !isUtc(regularCloseAt) ||
      compareIntradayInstants(windowStartedAt, regularOpenAt) < 0 ||
      compareIntradayInstants(deadlineAt, windowStartedAt) <= 0 ||
      compareIntradayInstants(deadlineAt, regularCloseAt) > 0 ||
      compareIntradayInstants(observedAt, windowStartedAt) < 0 ||
      compareIntradayInstants(observedAt, deadlineAt) >= 0
    ) {
      return yield* invalid('Passive exit requires a causal RTH exit window before its close deadline')
    }
    if (market.quote === undefined) return yield* invalid('Passive exit requires a verified SIP NBBO quote')
    const current = yield* readQuote(
      market.quote,
      { ...market.cut, maximumQuoteAgeMs: policy.maximumQuoteAgeMs },
      symbol,
    )
    const elapsedNanos = intradayAgeNanos(observedAt, windowStartedAt)
    const remainingNanos = intradayAgeNanos(deadlineAt, observedAt)
    const mustEscalate =
      elapsedNanos >= millisecondsAsNanos(policy.escalateToMarketableAfterMs) ||
      remainingNanos <= millisecondsAsNanos(policy.mandatoryEscalationLeadMs)

    const isBuy = side === OrderSide.Buy
    const marketableTouchPriceMicros = isBuy ? current.ask : current.bid
    if (!mustEscalate) {
      const passiveLimit = passiveMicropriceLimit(symbol, side, current)
      if (passiveLimit !== null) {
        return {
          _tag: 'Price',
          stage: ExecutionPricingStage.Passive,
          limitPriceMicros: passiveLimit,
          spreadMicros: current.spread,
          marketableTouchPriceMicros,
        } as const
      }
    }

    const slippageBps = BigInt(policy.marketableSlippageBps)
    const rawMarketable = isBuy
      ? (current.ask * (BPS + slippageBps)) / BPS
      : (current.bid * (BPS - slippageBps) + BPS - 1n) / BPS
    const quantized = quantizeInstrumentPriceMicros(symbol, rawMarketable, isBuy ? 'DOWN' : 'UP')
    const touch = quantizeInstrumentPriceMicros(symbol, marketableTouchPriceMicros, isBuy ? 'UP' : 'DOWN')
    const limitPriceMicros = isBuy ? max(touch, quantized) : min(touch, quantized)
    if (limitPriceMicros <= 0n) return yield* invalid('Passive exit marketable limit is outside positive price domain')
    return {
      _tag: 'Price',
      stage: ExecutionPricingStage.Marketable,
      limitPriceMicros,
      spreadMicros: current.spread,
      marketableTouchPriceMicros,
    } as const
  })

/**
 * Reanchor and time-decay escalation planner for an untouched working reduce-only exit limit order.
 * Respects minimumDwellMs during passive resting, but never allows dwell to block mandatory pre-deadline escalation.
 */
export const planPassiveExitReanchor = (
  input: PassiveExitInput & { readonly order: BrokerOrder; readonly reanchorCount?: number },
): Result.Result<PassiveReanchorDecision, PassiveEntryExecutionError> =>
  Result.gen(function* () {
    const { policy, symbol, side, market, order, deadlineAt, reanchorCount = 0 } = input
    if (!Number.isSafeInteger(reanchorCount) || reanchorCount < 0) {
      return yield* invalid('Reanchor count must be a nonnegative safe integer')
    }
    const { observedAt } = market.cut
    const keep = { _tag: 'Keep' } as const
    const workingOrder = isUntouchedWorkingLimitOrder(order, symbol, side, observedAt)
    if (workingOrder === null) return keep

    const proposed = yield* pricePassiveExit(input)
    const urgentDeadline =
      intradayAgeNanos(deadlineAt, observedAt) <= millisecondsAsNanos(policy.mandatoryEscalationLeadMs)
    if (
      !urgentDeadline &&
      intradayAgeNanos(observedAt, workingOrder.workingSince) < millisecondsAsNanos(policy.minimumDwellMs)
    ) {
      return keep
    }
    const working = yield* ensureUnsigned(workingOrder.limitPriceMicros, 'working exit price', 1n).pipe(
      Result.mapError((cause) => executionError('Invalid working exit price', cause)),
    )
    return decideReanchorFromProposal({
      order,
      side,
      working,
      proposed,
      reanchorDeadbandBpsOfSpread: policy.reanchorDeadbandBpsOfSpread,
      ...(policy.minimumReanchorTicks === undefined ? {} : { minimumReanchorTicks: policy.minimumReanchorTicks }),
      ...(policy.maximumReanchors === undefined ? {} : { maximumReanchors: policy.maximumReanchors }),
      reanchorCount,
    })
  })
