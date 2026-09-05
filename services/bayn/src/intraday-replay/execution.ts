import { Result, Schema } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from '../broker/alpaca-price'
import { OrderSide } from '../execution/contracts'
import { MICROS, notionalMicros, numberToMicros } from '../execution-model'
import { IntradaySnapshotPurpose, type ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import { PositiveMicrosSchema, SymbolSchema, UtcInstantSchema } from '../schemas'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'

const BPS = 10_000n
const PPM = 1_000_000n
const U128_MAX = (1n << 128n) - 1n

const isSymbol = Schema.is(SymbolSchema)
const isPositiveMicros = Schema.is(PositiveMicrosSchema)
const isUtcInstant = Schema.is(UtcInstantSchema)

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

type CancelReason = 'adverse-price-exceeds-limit' | 'no-displayed-liquidity' | 'zero-after-whole-share-rounding'

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
const utcMilliseconds = (value: string): number => (isUtcInstant(value) ? Date.parse(value) : Number.NaN)

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
  const submittedAtMs = utcMilliseconds(order.submittedAt)
  if (!Number.isFinite(submittedAtMs)) {
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
  const observedAtMs = utcMilliseconds(manifest.observedAt)
  const session = manifest.calendar.sessions.find(({ date }) => date === manifest.sessionDate)
  const sessionOpenMs = session === undefined ? Number.NaN : utcMilliseconds(session.openAt)
  const sessionCloseMs = session === undefined ? Number.NaN : utcMilliseconds(session.closeAt)
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(sessionOpenMs) || !Number.isFinite(sessionCloseMs)) {
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
    submittedAtMs < sessionOpenMs ||
    submittedAtMs > sessionCloseMs
  ) {
    return Result.fail(invalidOrder('order.submittedAt', order.submittedAt, 'outside-session'))
  }
  if (observedAtMs < sessionOpenMs || observedAtMs > sessionCloseMs) {
    return Result.fail(
      failure(
        'InvalidIntradayReplaySnapshot',
        'arrivalSnapshot.manifest.observedAt',
        manifest.observedAt,
        'invalid-time',
      ),
    )
  }
  if (submittedAtMs > observedAtMs)
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
  const quoteEventAtMs = utcMilliseconds(quote.eventAt)
  const quoteIngestedAtMs = utcMilliseconds(quote.ingestedAt)
  if (!Number.isFinite(quoteEventAtMs) || !Number.isFinite(quoteIngestedAtMs)) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'invalid-quote'))
  }
  if (quote.eventAt.slice(0, 10) !== manifest.sessionDate) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'invalid-identity'))
  }
  if (quoteEventAtMs > observedAtMs) {
    return Result.fail(invalidSnapshot(`${quoteField}.eventAt`, quote.eventAt, 'future-quote'))
  }
  if (
    quoteIngestedAtMs < quoteEventAtMs ||
    quoteIngestedAtMs > observedAtMs ||
    observedAtMs - quoteEventAtMs > manifest.maximumQuoteAgeMs
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

  const quotePrice = order.side === OrderSide.Buy ? ask : bid
  const slippage = BigInt(assumptions.slippageBps)
  const adverseNumerator = quotePrice * (order.side === OrderSide.Buy ? BPS + slippage : BPS - slippage)
  const adversePrice =
    order.side === OrderSide.Buy
      ? quantizeAlpacaLimitPriceMicros((adverseNumerator + BPS - 1n) / BPS, 'UP')
      : quantizeAlpacaLimitPriceMicros(adverseNumerator / BPS, 'DOWN')
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
  const cancel = (reason: CancelReason): Result.Result<IntradayReplayIocOutcome, IntradayReplayIocFailure> =>
    Result.succeed({
      ...evidence,
      status: 'canceled',
      reason,
      filledQuantityMicros: '0',
      unfilledRemainder: 'canceled',
    })
  if (
    (order.side === OrderSide.Buy && adversePrice > limitPrice) ||
    (order.side === OrderSide.Sell && adversePrice < limitPrice)
  ) {
    return cancel('adverse-price-exceeds-limit')
  }
  const liquidity = (displayed * BigInt(assumptions.availableLiquidityPpm)) / PPM
  const fillQuantity = (liquidity / quantityIncrement) * quantityIncrement
  const requestedOrAvailable = fillQuantity < requestedQuantity ? fillQuantity : requestedQuantity
  if (requestedOrAvailable === 0n)
    return cancel(liquidity === 0n ? 'no-displayed-liquidity' : 'zero-after-whole-share-rounding')
  return notionalMicros(requestedOrAvailable, adversePrice).pipe(
    Result.mapError((cause) => invalidSnapshot(quoteField, cause, 'invalid-fill-notional')),
    Result.map(
      (notional): IntradayReplayIocOutcome => ({
        ...evidence,
        status: 'filled',
        filledQuantityMicros: requestedOrAvailable.toString(),
        fillPriceMicros: adversePrice.toString(),
        fillNotionalMicros: notional.toString(),
        unfilledRemainder: requestedOrAvailable < requestedQuantity ? 'canceled' : 'none',
      }),
    ),
  )
}
