import { Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import type { ExecutionModel } from '../execution-model-contract'
import { saleCostBasisMicros } from '../strategy/execution-model/cash'
import { calculateSessionFees, type FeeInput } from '../strategy/execution-model/fees'
import { notionalMicros } from '../strategy/execution-model/fixed-point'
import { MICROS, type ExecutionModelFailure } from '../strategy/execution-model/model'
import type { IntradayReplayIocOutcome } from './execution'
import type { IntradayReplayFill, IntradayReplayPosition } from './model'

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
  | 'non-whole-share-quantity'
  | 'inconsistent-fees'

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

export type EconomicReplayFill = Pick<
  IntradayReplayFill,
  'symbol' | 'side' | 'observedAt' | 'quantityMicros' | 'priceMicros' | 'notionalMicros'
>

/** Cash and cost basis retain the caller's independently verified fill provenance. */
export interface ReplayLedger<Fill extends EconomicReplayFill> {
  readonly openingCashMicros: string
  readonly cashMicros: string
  readonly executionFeesMicros: string
  readonly positions: readonly IntradayReplayPosition[]
  readonly fills: readonly Fill[]
  /** Net realized PnL is available only after all positions are flat. */
  readonly netRealizedPnlAfterCostsMicros: string | null
}

export type IntradayReplayLedger = ReplayLedger<IntradayReplayFill>

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

const parseWholeQuantity = (value: unknown, field: string): Result.Result<bigint, IntradayReplayLedgerFailure> => {
  const parsed = parseUnsigned(value, field, true)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  return parsed.success % MICROS === 0n ? parsed : invalid(field, value, 'non-whole-share-quantity')
}

const parseFeeMultiplier = (value: number): Result.Result<bigint, IntradayReplayLedgerFailure> =>
  Number.isSafeInteger(value) && value >= feeMultiplierMinimumPpm && value <= feeMultiplierMaximumPpm
    ? Result.succeed(BigInt(value))
    : invalid('feeMultiplierPpm', value, 'invalid-fee-multiplier')

const feeInputsFromFills = (fills: readonly EconomicReplayFill[]): readonly FeeInput[] =>
  fills.map((fill) => ({
    side: fill.side,
    quantityMicros: BigInt(fill.quantityMicros),
    notionalMicros: BigInt(fill.notionalMicros),
  }))

const makeLedger = <Fill extends EconomicReplayFill>(
  openingCashMicros: bigint,
  cashMicros: bigint,
  executionFeesMicros: bigint,
  positions: readonly IntradayReplayPosition[],
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
export const createReplayLedger = <Fill extends EconomicReplayFill = IntradayReplayFill>(
  initialCashMicros: string,
): Result.Result<ReplayLedger<Fill>, IntradayReplayLedgerFailure> => {
  const cash = parseUnsigned(initialCashMicros, 'initialCashMicros', false)
  if (Result.isFailure(cash)) return invalid('initialCashMicros', initialCashMicros, 'invalid-initial-cash')
  return Result.succeed(makeLedger<Fill>(cash.success, cash.success, 0n, [], []))
}

const archiveFillErrorFields: Readonly<Record<string, string>> = {
  requestedQuantityMicros: 'outcome.requestedQuantityMicros',
  'fill.quantityMicros': 'outcome.filledQuantityMicros',
  'fill.priceMicros': 'outcome.fillPriceMicros',
  'fill.notionalMicros': 'outcome.fillNotionalMicros',
}

/** The archive wrapper retains its source-specific evidence without lending that identity to other datasets. */
export const applyReplayIoc = (
  ledger: IntradayReplayLedger,
  outcome: IntradayReplayIocOutcome,
  executionModel: ExecutionModel,
  feeMultiplierPpm: number,
): Result.Result<IntradayReplayLedger, IntradayReplayLedgerFailure> => {
  const feeMultiplier = parseFeeMultiplier(feeMultiplierPpm)
  if (Result.isFailure(feeMultiplier)) return Result.fail(feeMultiplier.failure)
  if (outcome.status === 'canceled') return Result.succeed(ledger)
  const side = outcome.side === OrderSide.Buy ? 'buy' : outcome.side === OrderSide.Sell ? 'sell' : undefined
  if (side === undefined) return invalid('outcome.side', outcome.side, 'invalid-side')
  return applyReplayFill(
    ledger,
    {
      symbol: outcome.symbol,
      side,
      observedAt: outcome.observedAt,
      quantityMicros: outcome.filledQuantityMicros,
      priceMicros: outcome.fillPriceMicros,
      notionalMicros: outcome.fillNotionalMicros,
      snapshotId: outcome.snapshotId,
    },
    outcome.requestedQuantityMicros,
    executionModel,
    feeMultiplierPpm,
  ).pipe(
    Result.mapError((failure) =>
      failure._tag === 'InvalidIntradayReplayLedger'
        ? { ...failure, field: archiveFillErrorFields[failure.field] ?? failure.field }
        : failure,
    ),
  )
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
  const requestedQuantity = parseWholeQuantity(requestedQuantityMicros, 'requestedQuantityMicros')
  if (Result.isFailure(requestedQuantity)) return Result.fail(requestedQuantity.failure)
  const filledQuantity = parseWholeQuantity(fill.quantityMicros, 'fill.quantityMicros')
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
  const nextFees = calculateSessionFees(feeInputsFromFills(nextFills), executionModel, feeMultiplier.success)
  if (Result.isFailure(nextFees)) return accountingFailure(nextFees.failure)
  const priorFees = parseUnsigned(ledger.executionFeesMicros, 'ledger.executionFeesMicros', false)
  if (Result.isFailure(priorFees)) return Result.fail(priorFees.failure)
  const feeDelta = nextFees.success.totalMicros - priorFees.success
  if (feeDelta < 0n) return invalid('ledger.executionFeesMicros', ledger.executionFeesMicros, 'inconsistent-fees')

  const existingIndex = ledger.positions.findIndex((position) => position.symbol === fill.symbol)
  const existing = existingIndex < 0 ? undefined : ledger.positions[existingIndex]
  let nextPositions: readonly IntradayReplayPosition[]
  if (side === 'buy') {
    const quantity = (existing === undefined ? 0n : BigInt(existing.quantityMicros)) + filledQuantity.success
    const costBasis = (existing === undefined ? 0n : BigInt(existing.costBasisMicros)) + fillNotional.success
    const nextPosition: IntradayReplayPosition = {
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
  return Result.succeed(
    makeLedger(openingCash.success, nextCash, nextFees.success.totalMicros, nextPositions, nextFills),
  )
}
