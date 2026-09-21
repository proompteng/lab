import { Result, Schema } from 'effect'

import type { ExecutionModel } from '../execution-model-contract'
import { saleCostBasisMicros } from '../strategy/execution-model/cash'
import { calculateSessionFees, type FeeInput } from '../strategy/execution-model/fees'
import { notionalMicros } from '../strategy/execution-model/fixed-point'
import { type ExecutionModelFailure } from '../strategy/execution-model/model'
import { UtcInstantSchema } from '../schemas'

const MAX_U128 = (1n << 128n) - 1n
const canonicalUnsigned = /^(?:0|[1-9][0-9]*)$/
const canonicalPositive = /^[1-9][0-9]*$/
const feeMultiplierMinimumPpm = 1_000_000
const feeMultiplierMaximumPpm = 10_000_000

type InvalidReason =
  | 'invalid-initial-cash'
  | 'invalid-micros'
  | 'invalid-side'
  | 'invalid-status'
  | 'invalid-fee-multiplier'
  | 'invalid-price'
  | 'invalid-notional'
  | 'notional-mismatch'
  | 'quantity-exceeds-requested'
  | 'inconsistent-fees'
  | 'invalid-observed-at'

export type IntradayReplayLedgerFailure =
  | {
      readonly _tag: 'InvalidIntradayReplayLedger'
      readonly field: string
      readonly value: unknown
      readonly reason: InvalidReason
    }
  | {
      readonly _tag: 'IntradayReplayLedgerOversell'
      readonly symbol: string
      readonly requestedQuantityMicros: string
      readonly positionQuantityMicros: string
    }
  | {
      readonly _tag: 'IntradayReplayLedgerInsufficientCash'
      readonly cashMicros: string
      readonly requiredCashMicros: string
    }
  | {
      readonly _tag: 'IntradayReplayLedgerAccountingFailure'
      readonly cause: ExecutionModelFailure
    }

export interface EconomicReplayFill {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly observedAt: string
  readonly quantityMicros: string
  readonly priceMicros: string
  readonly notionalMicros: string
}

export interface ReplayPosition {
  readonly symbol: string
  readonly quantityMicros: string
  readonly costBasisMicros: string
}

/** Cash and cost basis retain the caller's independently verified fill provenance. */
export interface ReplayLedger<Fill extends EconomicReplayFill> {
  readonly openingCashMicros: string
  readonly cashMicros: string
  readonly executionFeesMicros: string
  readonly positions: readonly ReplayPosition[]
  readonly fills: readonly Fill[]
  /** Net realized PnL is available only after all positions are flat. */
  readonly netRealizedPnlAfterCostsMicros: string | null
}

const invalid = <A>(
  field: string,
  value: unknown,
  reason: InvalidReason,
): Result.Result<A, IntradayReplayLedgerFailure> =>
  Result.fail({ _tag: 'InvalidIntradayReplayLedger', field, value, reason })

const accountingFailure = <A>(cause: ExecutionModelFailure): Result.Result<A, IntradayReplayLedgerFailure> =>
  Result.fail({ _tag: 'IntradayReplayLedgerAccountingFailure', cause })

const parseUnsigned = (
  value: unknown,
  field: string,
  positive: boolean,
): Result.Result<bigint, IntradayReplayLedgerFailure> => {
  if (typeof value !== 'string' || !(positive ? canonicalPositive : canonicalUnsigned).test(value)) {
    return invalid(field, value, 'invalid-micros')
  }
  const parsed = BigInt(value)
  return parsed > MAX_U128 || (positive && parsed === 0n)
    ? invalid(field, value, 'invalid-micros')
    : Result.succeed(parsed)
}

const parseFeeMultiplier = (value: number): Result.Result<bigint, IntradayReplayLedgerFailure> =>
  Number.isSafeInteger(value) && value >= feeMultiplierMinimumPpm && value <= feeMultiplierMaximumPpm
    ? Result.succeed(BigInt(value))
    : invalid('feeMultiplierPpm', value, 'invalid-fee-multiplier')

const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
const cumulativeFees = (fills: readonly EconomicReplayFill[], model: ExecutionModel, multiplier: bigint) =>
  Result.gen(function* () {
    const sessions = new Map<string, FeeInput[]>()
    for (const fill of fills) {
      if (Result.isFailure(Schema.decodeUnknownResult(UtcInstantSchema)(fill.observedAt)))
        return yield* invalid<bigint>('fill.observedAt', fill.observedAt, 'invalid-observed-at')
      const date = sessionDate.format(Date.parse(fill.observedAt))
      const inputs = sessions.get(date) ?? []
      inputs.push({
        side: fill.side,
        quantityMicros: BigInt(fill.quantityMicros),
        notionalMicros: BigInt(fill.notionalMicros),
      })
      sessions.set(date, inputs)
    }
    let total = 0n
    for (const inputs of sessions.values()) {
      const fees = calculateSessionFees(inputs, model, multiplier)
      if (Result.isFailure(fees)) return yield* accountingFailure<bigint>(fees.failure)
      total += fees.success.totalMicros
    }
    return total
  })

const makeLedger = <Fill extends EconomicReplayFill>(
  openingCashMicros: bigint,
  cashMicros: bigint,
  executionFeesMicros: bigint,
  positions: readonly ReplayPosition[],
  fills: readonly Fill[],
): ReplayLedger<Fill> => ({
  openingCashMicros: openingCashMicros.toString(),
  cashMicros: cashMicros.toString(),
  executionFeesMicros: executionFeesMicros.toString(),
  positions: Object.freeze(positions.map((position) => Object.freeze({ ...position }))),
  fills: Object.freeze(fills.map((fill) => Object.freeze({ ...fill }))),
  netRealizedPnlAfterCostsMicros: positions.length === 0 ? (cashMicros - openingCashMicros).toString() : null,
})

/** Create an empty replay ledger with no positions or fills. */
export const createReplayLedger = <Fill extends EconomicReplayFill = EconomicReplayFill>(
  initialCashMicros: string,
): Result.Result<ReplayLedger<Fill>, IntradayReplayLedgerFailure> => {
  const cash = parseUnsigned(initialCashMicros, 'initialCashMicros', false)
  if (Result.isFailure(cash)) return invalid('initialCashMicros', initialCashMicros, 'invalid-initial-cash')
  return Result.succeed(makeLedger<Fill>(cash.success, cash.success, 0n, [], []))
}

/** Apply the economic fill after the owning data boundary has established its provenance. */
export const applyReplayFill = <Fill extends EconomicReplayFill>(
  ledger: ReplayLedger<Fill>,
  fill: Fill,
  requestedQuantityMicros: string,
  executionModel: ExecutionModel,
  feeMultiplierPpm: number,
): Result.Result<ReplayLedger<Fill>, IntradayReplayLedgerFailure> => {
  const feeMultiplier = parseFeeMultiplier(feeMultiplierPpm)
  if (Result.isFailure(feeMultiplier)) return Result.fail(feeMultiplier.failure)
  const side = fill.side
  if (side !== 'buy' && side !== 'sell') return invalid('fill.side', side, 'invalid-side')
  const requestedQuantity = parseUnsigned(requestedQuantityMicros, 'requestedQuantityMicros', true)
  if (Result.isFailure(requestedQuantity)) return Result.fail(requestedQuantity.failure)
  const filledQuantity = parseUnsigned(fill.quantityMicros, 'fill.quantityMicros', true)
  if (Result.isFailure(filledQuantity)) return Result.fail(filledQuantity.failure)
  if (filledQuantity.success > requestedQuantity.success) {
    return invalid('fill.quantityMicros', fill.quantityMicros, 'quantity-exceeds-requested')
  }
  const price = parseUnsigned(fill.priceMicros, 'fill.priceMicros', true)
  if (Result.isFailure(price)) return invalid('fill.priceMicros', fill.priceMicros, 'invalid-price')
  const fillNotional = parseUnsigned(fill.notionalMicros, 'fill.notionalMicros', true)
  if (Result.isFailure(fillNotional)) return invalid('fill.notionalMicros', fill.notionalMicros, 'invalid-notional')
  const expectedNotional = notionalMicros(filledQuantity.success, price.success)
  if (Result.isFailure(expectedNotional)) return invalid('fill.notionalMicros', fill.notionalMicros, 'invalid-notional')
  if (expectedNotional.success !== fillNotional.success) {
    return invalid('fill.notionalMicros', fill.notionalMicros, 'notional-mismatch')
  }
  const nextFills = [...ledger.fills, fill]
  const nextFees = cumulativeFees(nextFills, executionModel, feeMultiplier.success)
  if (Result.isFailure(nextFees)) return Result.fail(nextFees.failure)
  const priorFees = parseUnsigned(ledger.executionFeesMicros, 'ledger.executionFeesMicros', false)
  if (Result.isFailure(priorFees)) return Result.fail(priorFees.failure)
  const feeDelta = nextFees.success - priorFees.success
  if (feeDelta < 0n) return invalid('ledger.executionFeesMicros', ledger.executionFeesMicros, 'inconsistent-fees')

  const existingIndex = ledger.positions.findIndex((position) => position.symbol === fill.symbol)
  const existing = existingIndex < 0 ? undefined : ledger.positions[existingIndex]
  let nextPositions: readonly ReplayPosition[]
  if (side === 'buy') {
    const quantity = (existing === undefined ? 0n : BigInt(existing.quantityMicros)) + filledQuantity.success
    const costBasis = (existing === undefined ? 0n : BigInt(existing.costBasisMicros)) + fillNotional.success
    const nextPosition: ReplayPosition = {
      symbol: fill.symbol,
      quantityMicros: quantity.toString(),
      costBasisMicros: costBasis.toString(),
    }
    nextPositions =
      existing === undefined
        ? [...ledger.positions, nextPosition].toSorted((left, right) => (left.symbol < right.symbol ? -1 : 1))
        : ledger.positions.map((position, index) => (index === existingIndex ? nextPosition : position))
  } else {
    if (existing === undefined) {
      return Result.fail({
        _tag: 'IntradayReplayLedgerOversell',
        symbol: fill.symbol,
        requestedQuantityMicros: filledQuantity.success.toString(),
        positionQuantityMicros: '0',
      })
    }
    const positionQuantity = BigInt(existing.quantityMicros)
    if (filledQuantity.success > positionQuantity) {
      return Result.fail({
        _tag: 'IntradayReplayLedgerOversell',
        symbol: fill.symbol,
        requestedQuantityMicros: filledQuantity.success.toString(),
        positionQuantityMicros: existing.quantityMicros,
      })
    }
    const soldCostBasis = saleCostBasisMicros(
      BigInt(existing.costBasisMicros),
      filledQuantity.success,
      positionQuantity,
    )
    if (Result.isFailure(soldCostBasis)) return accountingFailure(soldCostBasis.failure)
    const remainingQuantity = positionQuantity - filledQuantity.success
    const remainingCostBasis = BigInt(existing.costBasisMicros) - soldCostBasis.success
    nextPositions =
      remainingQuantity === 0n
        ? ledger.positions.filter((_position, index) => index !== existingIndex)
        : ledger.positions.map((position, index) =>
            index === existingIndex
              ? {
                  ...position,
                  quantityMicros: remainingQuantity.toString(),
                  costBasisMicros: remainingCostBasis.toString(),
                }
              : position,
          )
  }

  const cash = parseUnsigned(ledger.cashMicros, 'ledger.cashMicros', false)
  const openingCash = parseUnsigned(ledger.openingCashMicros, 'ledger.openingCashMicros', false)
  if (Result.isFailure(cash)) return Result.fail(cash.failure)
  if (Result.isFailure(openingCash)) return Result.fail(openingCash.failure)
  const cashBeforeFees = cash.success + (side === 'buy' ? -fillNotional.success : fillNotional.success)
  const nextCash = cashBeforeFees - feeDelta
  if (nextCash < 0n) {
    return Result.fail({
      _tag: 'IntradayReplayLedgerInsufficientCash',
      cashMicros: cash.success.toString(),
      requiredCashMicros: (fillNotional.success + feeDelta).toString(),
    })
  }
  return Result.succeed(makeLedger(openingCash.success, nextCash, nextFees.success, nextPositions, nextFills))
}
