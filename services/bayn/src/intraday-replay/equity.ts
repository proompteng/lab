import { Result } from 'effect'

import { notionalMicros } from '../strategy/execution-model/fixed-point'
import type { IntradayReplayPosition } from './model'

const U128_MAX = (1n << 128n) - 1n
const I128_MIN = -(1n << 127n)
const I128_MAX = (1n << 127n) - 1n
const canonicalUnsigned = /^(?:0|[1-9][0-9]*)$/
const canonicalPositive = /^[1-9][0-9]*$/
const canonicalSigned = /^(?:0|-?[1-9][0-9]*)$/

export interface IntradayReplayEquityLedger {
  readonly cashMicros: string
  readonly positions: readonly IntradayReplayPosition[]
}

export interface IntradayReplayEquityLimits {
  readonly maxDailyLossMicros?: string
  readonly maxDrawdownMicros?: string
}

export interface IntradayReplayEquityInput {
  readonly ledger: IntradayReplayEquityLedger
  /** Adverse liquidation bid per held symbol, as positive price micros. */
  readonly bidPriceMicros: Readonly<Record<string, string>>
  /** The explicit session or accounting day-start equity baseline. */
  readonly dayStartEquityMicros: string
  /** The peak carried from earlier marks or sessions. */
  readonly previousPeakEquityMicros: string
  /** The maximum drawdown carried from earlier marks or sessions. */
  readonly previousMaximumObservedDrawdownMicros: string
  readonly limits?: IntradayReplayEquityLimits
}

export interface IntradayReplayEquityLimitDiagnostic {
  readonly actualMicros: string
  readonly limitMicros: string
  readonly exceeded: boolean
}

export interface IntradayReplayEquityMark {
  readonly cashMicros: string
  readonly markedPositionValueMicros: string
  readonly equityMicros: string
  readonly unrealizedPnlMicros: string
  readonly grossExposureMicros: string
  readonly netExposureMicros: string
  readonly dayLossMicros: string
  readonly peakEquityMicros: string
  readonly currentDrawdownMicros: string
  readonly maximumObservedDrawdownMicros: string
  readonly dailyLossLimit: IntradayReplayEquityLimitDiagnostic | null
  readonly drawdownLimit: IntradayReplayEquityLimitDiagnostic | null
}

export type IntradayReplayEquityFailureReason =
  | 'invalid-input'
  | 'invalid-quote'
  | 'missing-quote'
  | 'invalid-quantity'
  | 'invalid-cost-basis'
  | 'invalid-cash'
  | 'invalid-day-start-equity'
  | 'invalid-previous-peak'
  | 'invalid-previous-maximum-drawdown'
  | 'negative'
  | 'duplicate-position'
  | 'overflow'

export interface IntradayReplayEquityFailure {
  readonly _tag: 'InvalidIntradayReplayEquityInput'
  readonly field: string
  readonly value: unknown
  readonly reason: IntradayReplayEquityFailureReason
}

const failure = <A>(
  field: string,
  value: unknown,
  reason: IntradayReplayEquityFailureReason,
): Result.Result<A, IntradayReplayEquityFailure> =>
  Result.fail({ _tag: 'InvalidIntradayReplayEquityInput', field, value, reason })

const parseUnsigned = (
  value: unknown,
  field: string,
  positive: boolean,
  invalidReason: IntradayReplayEquityFailureReason,
): Result.Result<bigint, IntradayReplayEquityFailure> => {
  if (typeof value !== 'string') return failure(field, value, invalidReason)
  if (value.startsWith('-')) return failure(field, value, 'negative')
  if (!(positive ? canonicalPositive : canonicalUnsigned).test(value)) return failure(field, value, invalidReason)
  const parsed = BigInt(value)
  return parsed > U128_MAX ? failure(field, value, 'overflow') : Result.succeed(parsed)
}

const parseSigned = (
  value: unknown,
  field: string,
  invalidReason: IntradayReplayEquityFailureReason,
): Result.Result<bigint, IntradayReplayEquityFailure> => {
  if (typeof value !== 'string') return failure(field, value, invalidReason)
  if (!canonicalSigned.test(value)) return failure(field, value, invalidReason)
  const parsed = BigInt(value)
  return parsed < I128_MIN || parsed > I128_MAX ? failure(field, value, 'overflow') : Result.succeed(parsed)
}

const positiveDifference = (left: bigint, right: bigint): bigint => (left > right ? left - right : 0n)

const maximum = (left: bigint, right: bigint): bigint => (left > right ? left : right)

const checkedUnsignedSum = (
  left: bigint,
  right: bigint,
  field: string,
): Result.Result<bigint, IntradayReplayEquityFailure> => {
  const sum = left + right
  return sum > U128_MAX ? failure(field, sum.toString(), 'overflow') : Result.succeed(sum)
}

const checkedSignedSum = (
  left: bigint,
  right: bigint,
  field: string,
): Result.Result<bigint, IntradayReplayEquityFailure> => {
  const sum = left + right
  return sum < I128_MIN || sum > I128_MAX ? failure(field, sum.toString(), 'overflow') : Result.succeed(sum)
}

const limitDiagnostic = (
  actualMicros: bigint,
  limitMicros: bigint | undefined,
): IntradayReplayEquityLimitDiagnostic | null =>
  limitMicros === undefined
    ? null
    : {
        actualMicros: actualMicros.toString(),
        limitMicros: limitMicros.toString(),
        exceeded: actualMicros > limitMicros,
      }

/**
 * Mark a long-only replay ledger with adverse bid prices.
 *
 * This computes accounting and diagnostic risk metrics only. It does not approve an order, liquidate a position, or
 * assert broker, authority, reconciliation, or fill evidence.
 */
export const markIntradayReplayEquity = (
  input: IntradayReplayEquityInput,
): Result.Result<IntradayReplayEquityMark, IntradayReplayEquityFailure> => {
  if (!Array.isArray(input.ledger.positions)) {
    return failure('ledger.positions', input.ledger.positions, 'invalid-input')
  }

  const cash = parseUnsigned(input.ledger.cashMicros, 'ledger.cashMicros', false, 'invalid-cash')
  if (Result.isFailure(cash)) return Result.fail(cash.failure)
  const dayStart = parseSigned(input.dayStartEquityMicros, 'dayStartEquityMicros', 'invalid-day-start-equity')
  if (Result.isFailure(dayStart)) return Result.fail(dayStart.failure)
  const previousPeak = parseSigned(input.previousPeakEquityMicros, 'previousPeakEquityMicros', 'invalid-previous-peak')
  if (Result.isFailure(previousPeak)) return Result.fail(previousPeak.failure)
  const previousMaximum = parseUnsigned(
    input.previousMaximumObservedDrawdownMicros,
    'previousMaximumObservedDrawdownMicros',
    false,
    'invalid-previous-maximum-drawdown',
  )
  if (Result.isFailure(previousMaximum)) return Result.fail(previousMaximum.failure)

  let markedPositionValue = 0n
  let costBasis = 0n
  const seenSymbols = new Set<string>()
  for (const [index, position] of input.ledger.positions.entries()) {
    if (position === undefined || typeof position.symbol !== 'string' || position.symbol.length === 0) {
      return failure(`ledger.positions[${index}]`, position, 'invalid-input')
    }
    if (seenSymbols.has(position.symbol)) {
      return failure(`ledger.positions[${index}].symbol`, position.symbol, 'duplicate-position')
    }
    seenSymbols.add(position.symbol)

    const quantity = parseUnsigned(
      position.quantityMicros,
      `ledger.positions[${index}].quantityMicros`,
      true,
      'invalid-quantity',
    )
    if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
    const positionCostBasis = parseUnsigned(
      position.costBasisMicros,
      `ledger.positions[${index}].costBasisMicros`,
      false,
      'invalid-cost-basis',
    )
    if (Result.isFailure(positionCostBasis)) return Result.fail(positionCostBasis.failure)

    const bid = input.bidPriceMicros[position.symbol]
    if (bid === undefined) return failure(`bidPriceMicros.${position.symbol}`, undefined, 'missing-quote')
    const bidPrice = parseUnsigned(bid, `bidPriceMicros.${position.symbol}`, true, 'invalid-quote')
    if (Result.isFailure(bidPrice)) return Result.fail(bidPrice.failure)

    const positionValue = notionalMicros(quantity.success, bidPrice.success)
    if (Result.isFailure(positionValue)) {
      return failure(`bidPriceMicros.${position.symbol}`, bid, 'overflow')
    }
    if (positionValue.success > U128_MAX) {
      return failure(`ledger.positions[${index}]`, position, 'overflow')
    }
    const nextMarkedPositionValue = checkedUnsignedSum(
      markedPositionValue,
      positionValue.success,
      'markedPositionValueMicros',
    )
    if (Result.isFailure(nextMarkedPositionValue)) return Result.fail(nextMarkedPositionValue.failure)
    markedPositionValue = nextMarkedPositionValue.success

    const nextCostBasis = checkedUnsignedSum(costBasis, positionCostBasis.success, 'costBasisMicros')
    if (Result.isFailure(nextCostBasis)) return Result.fail(nextCostBasis.failure)
    costBasis = nextCostBasis.success
  }

  const equity = checkedSignedSum(cash.success, markedPositionValue, 'equityMicros')
  if (Result.isFailure(equity)) return Result.fail(equity.failure)
  const unrealizedPnl = markedPositionValue - costBasis
  if (unrealizedPnl < I128_MIN || unrealizedPnl > I128_MAX) {
    return failure('unrealizedPnlMicros', unrealizedPnl.toString(), 'overflow')
  }
  const dayLoss = positiveDifference(dayStart.success, equity.success)
  const peak = maximum(previousPeak.success, equity.success)
  const currentDrawdown = positiveDifference(peak, equity.success)
  const maximumObservedDrawdown = maximum(previousMaximum.success, currentDrawdown)
  if (dayLoss > U128_MAX || currentDrawdown > U128_MAX || maximumObservedDrawdown > U128_MAX) {
    return failure('drawdownMicros', maximumObservedDrawdown.toString(), 'overflow')
  }

  let maxDailyLossMicros: bigint | undefined
  let maxDrawdownMicros: bigint | undefined
  if (input.limits !== undefined) {
    if (input.limits.maxDailyLossMicros !== undefined) {
      const limit = parseUnsigned(input.limits.maxDailyLossMicros, 'limits.maxDailyLossMicros', false, 'invalid-input')
      if (Result.isFailure(limit)) return Result.fail(limit.failure)
      maxDailyLossMicros = limit.success
    }
    if (input.limits.maxDrawdownMicros !== undefined) {
      const limit = parseUnsigned(input.limits.maxDrawdownMicros, 'limits.maxDrawdownMicros', false, 'invalid-input')
      if (Result.isFailure(limit)) return Result.fail(limit.failure)
      maxDrawdownMicros = limit.success
    }
  }

  return Result.succeed({
    cashMicros: cash.success.toString(),
    markedPositionValueMicros: markedPositionValue.toString(),
    equityMicros: equity.success.toString(),
    unrealizedPnlMicros: unrealizedPnl.toString(),
    grossExposureMicros: markedPositionValue.toString(),
    netExposureMicros: markedPositionValue.toString(),
    dayLossMicros: dayLoss.toString(),
    peakEquityMicros: peak.toString(),
    currentDrawdownMicros: currentDrawdown.toString(),
    maximumObservedDrawdownMicros: maximumObservedDrawdown.toString(),
    dailyLossLimit: limitDiagnostic(dayLoss, maxDailyLossMicros),
    drawdownLimit: limitDiagnostic(currentDrawdown, maxDrawdownMicros),
  })
}
