import { pipe, Result } from 'effect'

import { canonicalHashV1 } from './hash'
import type { ExecutionModel, IsoDate, OrderRejectionReason, OrderStatus } from './types'
import { roundUnsignedHalfUp, type UnsignedRoundHalfUpFailure } from './unsigned-round-half-up'

export const MICROS = 1_000_000n
const PPM = 1_000_000n
const BPS = 10_000n
const WEIGHT_SCALE = 1_000_000_000_000n

export const defaultExecutionModel: ExecutionModel = {
  schemaVersion: 'bayn.execution-model.v2',
  venue: 'alpaca-paper',
  assetClass: 'us-equity',
  order: {
    type: 'market',
    timeInForce: 'day',
    extendedHours: false,
    planAfter: 'signal-session-finalized',
    submitAfter: 'plan-committed',
    submitBefore: 'fixed-pre-open-cutoff',
    planningPriceReference: 'signal-session-close',
    planningBrokerStateReference: 'reconciled-pre-plan-broker-state',
    fillPriceReference: 'next-session-open',
    buyingPowerPolicy: 'pre-submit-cash-without-sell-proceeds',
    submissionCutoffLeadMinutes: 15,
  },
  precision: {
    quantityIncrementMicros: '1',
    priceIncrementMicros: '100',
    minimumBuyNotionalMicros: '1000000',
  },
  priceImpact: {
    halfSpreadBps: 2.5,
    slippageBps: 2.5,
  },
  fees: {
    scheduleVersion: 'alpaca-brokerage-2026-07-01',
    commissionBps: 0,
    secSellBps: 0.206,
    tafSellPerShareMicros: '195',
    tafMaximumPerOrderMicros: '9790000',
    catPerShareMicros: '3',
    aggregation: 'session-by-fee-type',
    roundingIncrementMicros: '10000',
  },
  cash: {
    annualYieldBps: 0,
    dayCount: 'actual-365',
    accrual: 'session-open',
  },
  partialFills: {
    policy: 'deterministic-hash',
    probabilityPpm: 100_000,
    filledFractionPpm: 500_000,
    remainder: 'cancel',
  },
  doubleCostMultiplier: 2,
}

type FixedPointFailureReason = 'negative' | 'not-finite' | 'precision-exceeded'

export type ExecutionModelFailure =
  | {
      readonly _tag: 'InvalidUnsignedInteger'
      readonly field: string
      readonly value: string
      readonly minimum: bigint
    }
  | {
      readonly _tag: 'InvalidFixedPointNumber'
      readonly field: string
      readonly value: number
      readonly scale: number
      readonly reason: FixedPointFailureReason
    }
  | {
      readonly _tag: 'InvalidIntegerNumber'
      readonly field: string
      readonly value: number
      readonly minimum: number
      readonly maximum: number
    }
  | {
      readonly _tag: 'InvalidCeilingDivision'
      readonly numerator: bigint
      readonly denominator: bigint
      readonly minimumNumerator: 0n
      readonly minimumDenominator: 1n
    }
  | UnsignedRoundHalfUpFailure
  | {
      readonly _tag: 'InvalidQuantization'
      readonly operation: 'down'
      readonly value: bigint
      readonly increment: bigint
      readonly minimumValue: 0n
      readonly minimumIncrement: 1n
    }
  | {
      readonly _tag: 'InvalidReferencePrice'
      readonly price: number
      readonly reason: 'not-positive' | 'rounded-to-zero'
    }
  | {
      readonly _tag: 'InvalidDesiredQuantity'
      readonly equityMicros: bigint
      readonly weight: number
      readonly priceMicros: bigint
      readonly reason: 'invalid-equity-or-price' | 'weight-exceeds-one'
    }
  | {
      readonly _tag: 'InvalidFillTerms'
      readonly side: 'buy' | 'sell'
      readonly quantityMicros: bigint
      readonly referencePriceMicros: bigint
      readonly costMultiplierMicros: bigint
      readonly reason: 'invalid-quantity-or-price' | 'invalid-cost-multiplier' | 'costs-consume-reference-price'
    }
  | {
      readonly _tag: 'OrderOutcomeCanonicalizationFailed'
      readonly identity: unknown
      readonly cause: unknown
    }
  | {
      readonly _tag: 'InvalidFeeCostMultiplier'
      readonly costMultiplierMicros: bigint
      readonly minimum: 1n
    }
  | {
      readonly _tag: 'InvalidCashYield'
      readonly cashMicros: bigint
      readonly elapsedDays: number
      readonly reason: 'negative-cash' | 'invalid-elapsed-days'
    }
  | {
      readonly _tag: 'InvalidCashAccrualPeriod'
      readonly from: IsoDate
      readonly to: IsoDate
    }
  | {
      readonly _tag: 'InvalidSaleCostBasis'
      readonly positionCostBasisMicros: bigint
      readonly soldQuantityMicros: bigint
      readonly positionQuantityMicros: bigint
      readonly reason: 'invalid-position' | 'quantity-exceeds-position'
    }
  | {
      readonly _tag: 'InvalidQuantityScale'
      readonly quantityMicros: bigint
      readonly scalePpm: bigint
      readonly minimumScalePpm: 0n
      readonly maximumScalePpm: 1_000_000n
    }

type ExecutionResult<A> = Result.Result<A, ExecutionModelFailure>

const fail = <A>(failure: ExecutionModelFailure): ExecutionResult<A> => Result.fail(failure)

const ensureUnsigned = (value: string, field: string, minimum = 0n): ExecutionResult<bigint> => {
  if (!/^[0-9]+$/.test(value)) {
    return fail({ _tag: 'InvalidUnsignedInteger', field, value, minimum })
  }
  const parsed = BigInt(value)
  return parsed < minimum ? fail({ _tag: 'InvalidUnsignedInteger', field, value, minimum }) : Result.succeed(parsed)
}

const scaledNumber = (value: number, field: string, scale = Number(MICROS)): ExecutionResult<bigint> => {
  if (!Number.isFinite(value)) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'not-finite' })
  }
  if (value < 0) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'negative' })
  }
  const scaled = value * scale
  const rounded = Math.round(scaled)
  const floatingPointTolerance = Math.max(1e-9, Number.EPSILON * Math.abs(scaled) * 4)
  return !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > floatingPointTolerance
    ? fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'precision-exceeded' })
    : Result.succeed(BigInt(rounded))
}

const integerNumber = (value: number, field: string, minimum: number, maximum: number): ExecutionResult<bigint> =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? Result.succeed(BigInt(value))
    : fail({ _tag: 'InvalidIntegerNumber', field, value, minimum, maximum })

const ceilDiv = (numerator: bigint, denominator: bigint): ExecutionResult<bigint> => {
  if (numerator < 0n || denominator <= 0n) {
    return fail({
      _tag: 'InvalidCeilingDivision',
      numerator,
      denominator,
      minimumNumerator: 0n,
      minimumDenominator: 1n,
    })
  }
  return Result.succeed(numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n)
}

const roundDiv = (numerator: bigint, denominator: bigint): ExecutionResult<bigint> =>
  roundUnsignedHalfUp(numerator, denominator)

const quantizeDown = (value: bigint, increment: bigint): ExecutionResult<bigint> =>
  value < 0n || increment <= 0n
    ? fail({
        _tag: 'InvalidQuantization',
        operation: 'down',
        value,
        increment,
        minimumValue: 0n,
        minimumIncrement: 1n,
      })
    : Result.succeed((value / increment) * increment)

const quantizeUp = (value: bigint, increment: bigint): ExecutionResult<bigint> =>
  pipe(
    ceilDiv(value, increment),
    Result.map((quotient) => quotient * increment),
  )

const quantizeNearest = (value: bigint, increment: bigint): ExecutionResult<bigint> =>
  pipe(
    roundDiv(value, increment),
    Result.map((quotient) => quotient * increment),
  )

export const numberToMicros = (value: number, field = 'value'): ExecutionResult<bigint> => {
  const scale = Number(MICROS)
  if (!Number.isFinite(value)) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'not-finite' })
  }
  if (value < 0) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'negative' })
  }
  const scaled = Math.round(value * scale)
  return Number.isSafeInteger(scaled)
    ? Result.succeed(BigInt(scaled))
    : fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'precision-exceeded' })
}

export const microsToNumber = (value: bigint): number => Number(value) / Number(MICROS)

export const referencePriceMicros = (price: number, model: ExecutionModel): ExecutionResult<bigint> => {
  if (!Number.isFinite(price) || price <= 0) {
    return fail({ _tag: 'InvalidReferencePrice', price, reason: 'not-positive' })
  }
  return pipe(
    Result.all({
      increment: ensureUnsigned(model.precision.priceIncrementMicros, 'price increment', 1n),
      priceMicros: numberToMicros(price, 'reference price'),
    }),
    Result.flatMap(({ increment, priceMicros }) => quantizeNearest(priceMicros, increment)),
    Result.flatMap((quantized) =>
      quantized === 0n
        ? fail({ _tag: 'InvalidReferencePrice', price, reason: 'rounded-to-zero' })
        : Result.succeed(quantized),
    ),
  )
}

export const notionalMicros = (quantityMicros: bigint, priceMicros: bigint): ExecutionResult<bigint> =>
  roundDiv(quantityMicros * priceMicros, MICROS)

export const desiredQuantityMicros = (
  equityMicros: bigint,
  weight: number,
  priceMicros: bigint,
  model: Pick<ExecutionModel, 'precision'>,
): ExecutionResult<bigint> => {
  if (equityMicros < 0n || priceMicros <= 0n) {
    return fail({
      _tag: 'InvalidDesiredQuantity',
      equityMicros,
      weight,
      priceMicros,
      reason: 'invalid-equity-or-price',
    })
  }
  return pipe(
    scaledNumber(weight, 'target weight', Number(WEIGHT_SCALE)),
    Result.flatMap((weightUnits) => {
      if (weightUnits > WEIGHT_SCALE) {
        return fail({
          _tag: 'InvalidDesiredQuantity',
          equityMicros,
          weight,
          priceMicros,
          reason: 'weight-exceeds-one',
        })
      }
      return pipe(
        ensureUnsigned(model.precision.quantityIncrementMicros, 'quantity increment', 1n),
        Result.flatMap((increment) => {
          const raw = (equityMicros * weightUnits * MICROS) / (WEIGHT_SCALE * priceMicros)
          return quantizeDown(raw, increment)
        }),
      )
    }),
  )
}

const impactedDelta = (
  referencePriceMicros: bigint,
  basisPoints: number,
  costMultiplierMicros: bigint,
): ExecutionResult<bigint> =>
  pipe(
    scaledNumber(basisPoints, 'execution cost basis points'),
    Result.flatMap((basisPointMicros) =>
      ceilDiv(referencePriceMicros * basisPointMicros * costMultiplierMicros, BPS * MICROS * MICROS),
    ),
  )

export interface FillTerms {
  readonly referencePriceMicros: bigint
  readonly fillPriceMicros: bigint
  readonly notionalMicros: bigint
  readonly spreadCostMicros: bigint
  readonly slippageCostMicros: bigint
}

export const makeFillTerms = (
  side: 'buy' | 'sell',
  quantityMicros: bigint,
  referencePrice: bigint,
  model: ExecutionModel,
  costMultiplierMicros: bigint,
): ExecutionResult<FillTerms> => {
  const invalid = <A>(
    reason: Extract<ExecutionModelFailure, { readonly _tag: 'InvalidFillTerms' }>['reason'],
  ): ExecutionResult<A> =>
    fail({
      _tag: 'InvalidFillTerms',
      side,
      quantityMicros,
      referencePriceMicros: referencePrice,
      costMultiplierMicros,
      reason,
    })
  if (quantityMicros <= 0n || referencePrice <= 0n) return invalid('invalid-quantity-or-price')
  if (costMultiplierMicros <= 0n) return invalid('invalid-cost-multiplier')

  return pipe(
    Result.all({
      increment: ensureUnsigned(model.precision.priceIncrementMicros, 'price increment', 1n),
      spreadDelta: impactedDelta(referencePrice, model.priceImpact.halfSpreadBps, costMultiplierMicros),
      slippageDelta: impactedDelta(referencePrice, model.priceImpact.slippageBps, costMultiplierMicros),
    }),
    Result.flatMap(({ increment, spreadDelta, slippageDelta }) => {
      const spreadPrice = pipe(
        side === 'buy'
          ? quantizeUp(referencePrice + spreadDelta, increment)
          : quantizeDown(referencePrice > spreadDelta ? referencePrice - spreadDelta : 0n, increment),
        Result.flatMap((price) => {
          if (price <= 0n) return invalid<bigint>('costs-consume-reference-price')
          return Result.succeed(price)
        }),
      )
      return pipe(
        spreadPrice,
        Result.flatMap((quantizedSpreadPrice) =>
          pipe(
            side === 'buy'
              ? quantizeUp(referencePrice + spreadDelta + slippageDelta, increment)
              : quantizeDown(
                  referencePrice > spreadDelta + slippageDelta ? referencePrice - spreadDelta - slippageDelta : 0n,
                  increment,
                ),
            Result.flatMap((fillPrice) => {
              if (fillPrice <= 0n) return invalid<FillTerms>('costs-consume-reference-price')
              return pipe(
                Result.all({
                  notional: notionalMicros(quantityMicros, fillPrice),
                  spreadCost: notionalMicros(
                    quantityMicros,
                    quantizedSpreadPrice > referencePrice
                      ? quantizedSpreadPrice - referencePrice
                      : referencePrice - quantizedSpreadPrice,
                  ),
                  slippageCost: notionalMicros(
                    quantityMicros,
                    fillPrice > quantizedSpreadPrice
                      ? fillPrice - quantizedSpreadPrice
                      : quantizedSpreadPrice - fillPrice,
                  ),
                }),
                Result.map(
                  ({ notional, spreadCost, slippageCost }): FillTerms => ({
                    referencePriceMicros: referencePrice,
                    fillPriceMicros: fillPrice,
                    notionalMicros: notional,
                    spreadCostMicros: spreadCost,
                    slippageCostMicros: slippageCost,
                  }),
                ),
              )
            }),
          ),
        ),
      )
    }),
  )
}

export interface OrderOutcome {
  readonly requestedQuantityMicros: bigint
  readonly filledQuantityMicros: bigint
  readonly status: OrderStatus
  readonly rejectionReason: OrderRejectionReason | null
  readonly unfilledRemainder: 'none' | 'canceled'
}

export interface OrderOutcomeInput {
  readonly identity: unknown
  readonly side: 'buy' | 'sell'
  readonly requestedQuantityMicros: bigint
  readonly referencePriceMicros: bigint
  readonly model: ExecutionModel
}

export const makeOrderOutcome = (input: OrderOutcomeInput): ExecutionResult<OrderOutcome> =>
  pipe(
    ensureUnsigned(input.model.precision.quantityIncrementMicros, 'quantity increment', 1n),
    Result.flatMap((quantityIncrement) =>
      pipe(
        quantizeDown(input.requestedQuantityMicros, quantityIncrement),
        Result.map((requested) => ({ quantityIncrement, requested })),
      ),
    ),
    Result.flatMap(({ quantityIncrement, requested }) => {
      const reject = (reason: OrderRejectionReason): OrderOutcome => ({
        requestedQuantityMicros: requested,
        filledQuantityMicros: 0n,
        status: 'rejected',
        rejectionReason: reason,
        unfilledRemainder: 'canceled',
      })
      if (requested === 0n) return Result.succeed(reject('zero-after-rounding'))

      const belowMinimumBuyNotional =
        input.side === 'sell'
          ? Result.succeed(false)
          : pipe(
              notionalMicros(requested, input.referencePriceMicros),
              Result.flatMap((requestedNotional) =>
                pipe(
                  ensureUnsigned(input.model.precision.minimumBuyNotionalMicros, 'minimum buy notional'),
                  Result.map((minimumBuyNotional) => requestedNotional < minimumBuyNotional),
                ),
              ),
            )
      return pipe(
        belowMinimumBuyNotional,
        Result.flatMap((belowMinimum) => {
          if (belowMinimum) {
            return Result.succeed(reject('below-minimum-buy-notional'))
          }
          return pipe(
            integerNumber(input.model.partialFills.probabilityPpm, 'partial fill probability', 0, Number(PPM)),
            Result.flatMap((probability) =>
              pipe(
                Result.try({
                  try: () => canonicalHashV1(input.identity),
                  catch: (cause): ExecutionModelFailure => ({
                    _tag: 'OrderOutcomeCanonicalizationFailed',
                    identity: input.identity,
                    cause,
                  }),
                }),
                Result.flatMap((identityHash) => {
                  const bucket = BigInt(`0x${identityHash.slice(0, 16)}`) % PPM
                  if (bucket >= probability) {
                    return Result.succeed({
                      requestedQuantityMicros: requested,
                      filledQuantityMicros: requested,
                      status: 'filled',
                      rejectionReason: null,
                      unfilledRemainder: 'none',
                    })
                  }
                  return pipe(
                    integerNumber(input.model.partialFills.filledFractionPpm, 'partial fill fraction', 0, Number(PPM)),
                    Result.flatMap((filledFraction) =>
                      quantizeDown((requested * filledFraction) / PPM, quantityIncrement),
                    ),
                    Result.map(
                      (filled): OrderOutcome =>
                        filled === 0n
                          ? reject('zero-after-rounding')
                          : {
                              requestedQuantityMicros: requested,
                              filledQuantityMicros: filled,
                              status: 'partially-filled',
                              rejectionReason: null,
                              unfilledRemainder: 'canceled',
                            },
                    ),
                  )
                }),
              ),
            ),
          )
        }),
      )
    }),
  )

export interface FeeInput {
  readonly side: 'buy' | 'sell'
  readonly quantityMicros: bigint
  readonly notionalMicros: bigint
}

export interface FeeBreakdown {
  readonly commissionMicros: bigint
  readonly secMicros: bigint
  readonly tafMicros: bigint
  readonly catMicros: bigint
  readonly totalMicros: bigint
}

const roundedFee = (numerator: bigint, denominator: bigint, increment: bigint): ExecutionResult<bigint> =>
  numerator === 0n
    ? Result.succeed(0n)
    : pipe(
        ceilDiv(numerator, denominator * increment),
        Result.map((quotient) => quotient * increment),
      )

export const calculateSessionFees = (
  fills: readonly FeeInput[],
  model: ExecutionModel,
  costMultiplierMicros: bigint,
): ExecutionResult<FeeBreakdown> => {
  if (costMultiplierMicros <= 0n) {
    return fail({ _tag: 'InvalidFeeCostMultiplier', costMultiplierMicros, minimum: 1n })
  }
  const totalNotional = fills.reduce((sum, fill) => sum + fill.notionalMicros, 0n)
  const sellNotional = fills.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.notionalMicros : 0n), 0n)
  const totalQuantity = fills.reduce((sum, fill) => sum + fill.quantityMicros, 0n)

  return pipe(
    Result.all({
      rounding: ensureUnsigned(model.fees.roundingIncrementMicros, 'fee rounding increment', 1n),
      commissionRate: scaledNumber(model.fees.commissionBps, 'commission basis points'),
      secRate: scaledNumber(model.fees.secSellBps, 'SEC basis points'),
      tafRate: ensureUnsigned(model.fees.tafSellPerShareMicros, 'TAF share rate'),
      tafCap: ensureUnsigned(model.fees.tafMaximumPerOrderMicros, 'TAF order cap'),
      catRate: ensureUnsigned(model.fees.catPerShareMicros, 'CAT share rate'),
    }),
    Result.flatMap(({ rounding, commissionRate, secRate, tafRate, tafCap, catRate }) => {
      const tafNumerator = fills.reduce(
        (sum, fill) =>
          fill.side === 'sell'
            ? sum + (fill.quantityMicros * tafRate < tafCap * MICROS ? fill.quantityMicros * tafRate : tafCap * MICROS)
            : sum,
        0n,
      )
      return pipe(
        Result.all({
          commission: roundedFee(
            totalNotional * commissionRate * costMultiplierMicros,
            BPS * MICROS * MICROS,
            rounding,
          ),
          sec: roundedFee(sellNotional * secRate * costMultiplierMicros, BPS * MICROS * MICROS, rounding),
          taf: roundedFee(tafNumerator * costMultiplierMicros, MICROS * MICROS, rounding),
          cat: roundedFee(totalQuantity * catRate * costMultiplierMicros, MICROS * MICROS, rounding),
        }),
        Result.map(
          ({ commission, sec, taf, cat }): FeeBreakdown => ({
            commissionMicros: commission,
            secMicros: sec,
            tafMicros: taf,
            catMicros: cat,
            totalMicros: commission + sec + taf + cat,
          }),
        ),
      )
    }),
  )
}

export const accrueCashYield = (
  cashMicros: bigint,
  elapsedDays: number,
  model: ExecutionModel,
): ExecutionResult<bigint> => {
  if (cashMicros < 0n) {
    return fail({ _tag: 'InvalidCashYield', cashMicros, elapsedDays, reason: 'negative-cash' })
  }
  if (!Number.isInteger(elapsedDays) || elapsedDays < 0) {
    return fail({ _tag: 'InvalidCashYield', cashMicros, elapsedDays, reason: 'invalid-elapsed-days' })
  }
  return pipe(
    scaledNumber(model.cash.annualYieldBps, 'annual cash yield basis points'),
    Result.map((annualYieldBps) => (cashMicros * annualYieldBps * BigInt(elapsedDays)) / (BPS * MICROS * 365n)),
  )
}

export const elapsedCalendarDays = (from: IsoDate, to: IsoDate): ExecutionResult<number> => {
  const fromTime = Date.parse(`${from}T00:00:00Z`)
  const toTime = Date.parse(`${to}T00:00:00Z`)
  return !Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime
    ? fail({ _tag: 'InvalidCashAccrualPeriod', from, to })
    : Result.succeed((toTime - fromTime) / 86_400_000)
}

export const saleCostBasisMicros = (
  positionCostBasisMicros: bigint,
  soldQuantityMicros: bigint,
  positionQuantityMicros: bigint,
): ExecutionResult<bigint> => {
  if (positionCostBasisMicros < 0n || soldQuantityMicros < 0n || positionQuantityMicros <= 0n) {
    return fail({
      _tag: 'InvalidSaleCostBasis',
      positionCostBasisMicros,
      soldQuantityMicros,
      positionQuantityMicros,
      reason: 'invalid-position',
    })
  }
  if (soldQuantityMicros > positionQuantityMicros) {
    return fail({
      _tag: 'InvalidSaleCostBasis',
      positionCostBasisMicros,
      soldQuantityMicros,
      positionQuantityMicros,
      reason: 'quantity-exceeds-position',
    })
  }
  return roundDiv(positionCostBasisMicros * soldQuantityMicros, positionQuantityMicros)
}

export const scaleQuantityMicros = (
  quantityMicros: bigint,
  scalePpm: bigint,
  model: ExecutionModel,
): ExecutionResult<bigint> => {
  if (scalePpm < 0n || scalePpm > PPM) {
    return fail({
      _tag: 'InvalidQuantityScale',
      quantityMicros,
      scalePpm,
      minimumScalePpm: 0n,
      maximumScalePpm: PPM,
    })
  }
  return pipe(
    ensureUnsigned(model.precision.quantityIncrementMicros, 'quantity increment'),
    Result.flatMap((increment) => quantizeDown((quantityMicros * scalePpm) / PPM, increment)),
  )
}

export const ppm = PPM
