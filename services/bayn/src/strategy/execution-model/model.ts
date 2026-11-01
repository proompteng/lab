import type { UnsignedRoundHalfUpFailure } from '../../unsigned-round-half-up'

export const MICROS = 1_000_000n
export const BPS = 10_000n
export const WEIGHT_SCALE = 1_000_000_000_000n

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
      readonly _tag: 'InvalidFeeCostMultiplier'
      readonly costMultiplierMicros: bigint
      readonly minimum: 1n
    }
  | {
      readonly _tag: 'InvalidSaleCostBasis'
      readonly positionCostBasisMicros: bigint
      readonly soldQuantityAtoms: bigint
      readonly positionQuantityAtoms: bigint
      readonly reason: 'invalid-position' | 'quantity-exceeds-position'
    }
