import { Result, Schema } from 'effect'

import { OrderSide } from '../execution/contracts'
import { MICROS, numberToMicros } from '../execution-model'
import { IntradaySnapshotPurpose, type ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import { intradayInstantNanos, millisecondsAsNanos } from '../market-data/intraday/time'
import { PositiveMicrosSchema, SymbolSchema, UtcInstantSchema, UtcOrderTimestampSchema } from '../schemas'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import { simulateIntradayReplayIocCore } from './execution-core'

const U128_MAX = (1n << 128n) - 1n

const isSymbol = Schema.is(SymbolSchema)
const isPositiveMicros = Schema.is(PositiveMicrosSchema)
const isIntradayTimestamp = Schema.is(Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema]))

export interface IntradayReplayIocOrder {
  readonly symbol: string
  readonly side: OrderSide
  readonly quantityMicros: string
  readonly limitPriceMicros: string
  readonly submittedAt: string
}

export interface IntradayReplayIocAssumptions {
  readonly slippageBps: number
  readonly availableLiquidityPpm: number
}

export interface IntradayReplayIocInput {
  readonly order: IntradayReplayIocOrder
  readonly arrivalSnapshot: ArchiveVerifiedIntradayMarketSnapshot
  readonly executionModel: IntradayMomentumProtocol['executionModel']
  readonly assumptions: IntradayReplayIocAssumptions
}

interface IntradayReplayIocEvidence {
  readonly symbol: string
  readonly side: OrderSide
  readonly limitPriceMicros: string
  readonly submittedAt: string
  readonly requestedQuantityMicros: string
  readonly filledQuantityMicros: string
  readonly snapshotId: string
  readonly snapshotContentHash: string
  readonly observedAt: string
}

export type IntradayReplayIocOutcome =
  | (IntradayReplayIocEvidence & {
      readonly status: 'filled'
      readonly fillPriceMicros: string
      readonly fillNotionalMicros: string
      readonly unfilledRemainder: 'none' | 'canceled'
    })
  | (IntradayReplayIocEvidence & {
      readonly status: 'canceled'
      readonly reason: 'adverse-price-exceeds-limit' | 'no-displayed-liquidity' | 'zero-after-whole-share-rounding'
      readonly unfilledRemainder: 'canceled'
    })

export interface IntradayReplayIocFailure {
  readonly _tag:
    | 'InvalidIntradayReplayOrder'
    | 'InvalidIntradayReplayAssumptions'
    | 'InvalidIntradayReplaySnapshot'
    | 'InvalidIntradayReplayExecutionModel'
  readonly field: string
  readonly value: unknown
  readonly reason: string
}

const failure = (
  _tag: IntradayReplayIocFailure['_tag'],
  field: string,
  value: unknown,
  reason: string,
): IntradayReplayIocFailure => ({ _tag, field, value, reason })
const invalidOrder = (field: string, value: unknown, reason: string) =>
  failure('InvalidIntradayReplayOrder', field, value, reason)
const invalidSnapshot = (field: string, value: unknown, reason: string) =>
  failure('InvalidIntradayReplaySnapshot', field, value, reason)
const invalidModel = (field: string, value: unknown, reason: string) =>
  failure('InvalidIntradayReplayExecutionModel', field, value, reason)
const positiveMicros = (value: string): bigint | undefined => {
  if (!isPositiveMicros(value)) return undefined
  const parsed = BigInt(value)
  return parsed <= U128_MAX ? parsed : undefined
}
const timestampNanos = (value: string): bigint | undefined =>
  isIntradayTimestamp(value) ? intradayInstantNanos(value) : undefined

export const simulateIntradayReplayIoc = (
  input: IntradayReplayIocInput,
): Result.Result<IntradayReplayIocOutcome, IntradayReplayIocFailure> => {
  const { order, assumptions, executionModel: model, arrivalSnapshot: snapshot } = input
  if (!isSymbol(order.symbol)) return Result.fail(invalidOrder('order.symbol', order.symbol, 'invalid-symbol'))
  if (order.side !== OrderSide.Buy && order.side !== OrderSide.Sell) {
    return Result.fail(invalidOrder('order.side', order.side, 'invalid-side'))
  }
  const requestedQuantity = positiveMicros(order.quantityMicros)
  const limitPrice = positiveMicros(order.limitPriceMicros)
  if (requestedQuantity === undefined)
    return Result.fail(invalidOrder('order.quantityMicros', order.quantityMicros, 'invalid-micros'))
  if (limitPrice === undefined)
    return Result.fail(invalidOrder('order.limitPriceMicros', order.limitPriceMicros, 'invalid-micros'))
  if (requestedQuantity % MICROS !== 0n) {
    return Result.fail(invalidOrder('order.quantityMicros', order.quantityMicros, 'fractional-quantity'))
  }
  const submittedAtNanos = timestampNanos(order.submittedAt)
  if (submittedAtNanos === undefined) {
    return Result.fail(invalidOrder('order.submittedAt', order.submittedAt, 'invalid-submitted-at'))
  }
  if (
    !Number.isSafeInteger(assumptions.slippageBps) ||
    assumptions.slippageBps < 0 ||
    assumptions.slippageBps > 10_000
  ) {
    return Result.fail(
      failure(
        'InvalidIntradayReplayAssumptions',
        'slippageBps',
        assumptions.slippageBps,
        'must-be-non-negative-integer',
      ),
    )
  }
  if (
    !Number.isSafeInteger(assumptions.availableLiquidityPpm) ||
    assumptions.availableLiquidityPpm <= 0 ||
    assumptions.availableLiquidityPpm > 1_000_000
  ) {
    return Result.fail(
      failure(
        'InvalidIntradayReplayAssumptions',
        'availableLiquidityPpm',
        assumptions.availableLiquidityPpm,
        'must-be-positive-integer',
      ),
    )
  }
  if (
    model.schemaVersion !== 'bayn.execution-model.v5' ||
    model.venue !== 'alpaca-us-equity' ||
    model.assetClass !== 'us-equity' ||
    model.order.type !== 'limit' ||
    model.order.timeInForce !== 'ioc' ||
    model.order.extendedHours !== false
  ) {
    return Result.fail(invalidModel('executionModel', model.schemaVersion, 'unsupported-order'))
  }
  const quantityIncrement = positiveMicros(model.precision.quantityIncrementMicros)
  if (quantityIncrement !== MICROS || model.precision.priceIncrementMicros !== '100') {
    return Result.fail(invalidModel('executionModel.precision', model.precision, 'invalid-precision'))
  }

  const { manifest } = snapshot
  if (
    manifest.purpose !== IntradaySnapshotPurpose.EntryPricing &&
    manifest.purpose !== IntradaySnapshotPurpose.Liquidation
  ) {
    return Result.fail(invalidSnapshot('arrivalSnapshot.manifest.purpose', manifest.purpose, 'not-quote-only'))
  }
  const observedAtNanos = timestampNanos(manifest.observedAt)
  const session = manifest.calendar.sessions.find(({ date }) => date === manifest.sessionDate)
  const sessionOpenNanos = session === undefined ? undefined : timestampNanos(session.openAt)
  const sessionCloseNanos = session === undefined ? undefined : timestampNanos(session.closeAt)
  const maximumQuoteAgeNanos = Number.isSafeInteger(manifest.maximumQuoteAgeMs)
    ? millisecondsAsNanos(manifest.maximumQuoteAgeMs)
    : undefined
  if (
    observedAtNanos === undefined ||
    sessionOpenNanos === undefined ||
    sessionCloseNanos === undefined ||
    maximumQuoteAgeNanos === undefined
  ) {
    return Result.fail(
      failure(
        'InvalidIntradayReplaySnapshot',
        'arrivalSnapshot.manifest.observedAt',
        manifest.observedAt,
        'invalid-time',
      ),
    )
  }
  if (
    order.submittedAt.slice(0, 10) !== manifest.sessionDate ||
    submittedAtNanos < sessionOpenNanos ||
    submittedAtNanos > sessionCloseNanos
  ) {
    return Result.fail(invalidOrder('order.submittedAt', order.submittedAt, 'outside-session'))
  }
  if (observedAtNanos < sessionOpenNanos || observedAtNanos > sessionCloseNanos) {
    return Result.fail(
      failure(
        'InvalidIntradayReplaySnapshot',
        'arrivalSnapshot.manifest.observedAt',
        manifest.observedAt,
        'invalid-time',
      ),
    )
  }
  if (submittedAtNanos > observedAtNanos)
    return Result.fail(invalidOrder('order.submittedAt', order.submittedAt, 'after-arrival'))
  if (!manifest.symbols.includes(order.symbol)) {
    return Result.fail(invalidSnapshot('arrivalSnapshot.manifest.symbols', order.symbol, 'missing-quote'))
  }
  const quote = snapshot.latestQuotes[order.symbol]
  if (quote === undefined) {
    return Result.fail(
      failure(
        'InvalidIntradayReplaySnapshot',
        `arrivalSnapshot.latestQuotes.${order.symbol}`,
        undefined,
        'missing-quote',
      ),
    )
  }
  const quoteField = `arrivalSnapshot.latestQuotes.${order.symbol}`
  if (
    quote.symbol !== order.symbol ||
    quote.marketSession !== 'regular' ||
    quote.universeId !== manifest.universeId ||
    quote.universeSymbolHash !== manifest.universeSymbolHash ||
    quote.feed !== manifest.feed ||
    quote.delayClass !== manifest.delayClass
  ) {
    return Result.fail(invalidSnapshot(quoteField, quote, 'invalid-identity'))
  }
  const quoteEventAtNanos = timestampNanos(quote.eventAt)
  const quoteIngestedAtNanos = timestampNanos(quote.ingestedAt)
  if (quoteEventAtNanos === undefined || quoteIngestedAtNanos === undefined) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'invalid-quote'))
  }
  if (quote.eventAt.slice(0, 10) !== manifest.sessionDate) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'invalid-identity'))
  }
  if (quoteEventAtNanos > observedAtNanos) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'future-quote'))
  }
  if (
    quoteIngestedAtNanos < quoteEventAtNanos ||
    quoteIngestedAtNanos > observedAtNanos ||
    observedAtNanos - quoteEventAtNanos > maximumQuoteAgeNanos
  ) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'stale-quote'))
  }
  const amounts = Result.all({
    bid: numberToMicros(quote.bidPrice, `${quoteField}.bidPrice`),
    ask: numberToMicros(quote.askPrice, `${quoteField}.askPrice`),
    displayed: numberToMicros(order.side === OrderSide.Buy ? quote.askSize : quote.bidSize, `${quoteField}.size`),
  })
  if (Result.isFailure(amounts)) {
    return Result.fail(invalidSnapshot(quoteField, quote, 'invalid-quote'))
  }
  const { bid, ask, displayed } = amounts.success
  if (bid <= 0n || ask <= 0n || bid > ask || displayed < 0n) {
    return Result.fail(invalidSnapshot(quoteField, quote, 'invalid-quote'))
  }

  const evidence = {
    symbol: order.symbol,
    side: order.side,
    limitPriceMicros: order.limitPriceMicros,
    submittedAt: order.submittedAt,
    requestedQuantityMicros: order.quantityMicros,
    snapshotId: manifest.snapshotId,
    snapshotContentHash: manifest.contentHash,
    observedAt: manifest.observedAt,
  }
  return simulateIntradayReplayIocCore({
    order: { side: order.side, quantityMicros: requestedQuantity, limitPriceMicros: limitPrice },
    quote: {
      priceMicros: order.side === OrderSide.Buy ? ask : bid,
      displayedQuantityMicros: displayed,
    },
    executionModel: model,
    assumptions,
  }).pipe(
    Result.mapError((cause) => invalidSnapshot(quoteField, cause, 'invalid-fill-notional')),
    Result.map((coreOutcome): IntradayReplayIocOutcome => {
      if (coreOutcome.status === 'canceled') {
        return {
          ...evidence,
          status: 'canceled',
          reason: coreOutcome.reason,
          filledQuantityMicros: coreOutcome.filledQuantityMicros.toString(),
          unfilledRemainder: coreOutcome.unfilledRemainder,
        }
      }
      return {
        ...evidence,
        status: 'filled',
        filledQuantityMicros: coreOutcome.filledQuantityMicros.toString(),
        fillPriceMicros: coreOutcome.fillPriceMicros.toString(),
        fillNotionalMicros: coreOutcome.fillNotionalMicros.toString(),
        unfilledRemainder: coreOutcome.unfilledRemainder,
      }
    }),
  )
}
