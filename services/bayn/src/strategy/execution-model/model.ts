import type { CanonicalHashFailure } from '../../hash'
import type { ExecutionModel } from '../../execution-model-contract'
import type { IsoDate } from '../../schemas'
import type { UnsignedRoundHalfUpFailure } from '../../unsigned-round-half-up'

export const MICROS = 1_000_000n
export const PPM = 1_000_000n
export const BPS = 10_000n
export const WEIGHT_SCALE = 1_000_000_000_000n

export const defaultExecutionModel: Extract<ExecutionModel, { readonly schemaVersion: 'bayn.execution-model.v3' }> = {
  schemaVersion: 'bayn.execution-model.v3',
  venue: 'alpaca-us-equity',
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
      readonly cause: CanonicalHashFailure
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
