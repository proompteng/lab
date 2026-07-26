import type { Schema } from 'effect'

import type { UnsignedRoundHalfUpFailure } from '../unsigned-round-half-up'

export type AccountingMicrosField =
  | 'fill.feeMicros'
  | 'fill.priceMicros'
  | 'fill.quantityMicros'
  | 'position.costMicros'
  | 'position.quantityMicros'

export type AccountingHashOperation = 'ledger-plan' | 'transaction-content' | 'transaction-id'

export type AccountingFailure =
  | {
      readonly _tag: 'AccountingMicrosParseFailed'
      readonly field: AccountingMicrosField
      readonly value: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'AccountingUnsignedDivisionFailed'
      readonly numerator: bigint
      readonly denominator: bigint
      readonly cause: UnsignedRoundHalfUpFailure
    }
  | {
      readonly _tag: 'AccountingNegativePositionCost'
      readonly quantityMicros: bigint
      readonly costMicros: bigint
    }
  | {
      readonly _tag: 'AccountingEmptyPositionRetainsCost'
      readonly costMicros: bigint
    }
  | {
      readonly _tag: 'AccountingFillNotionalRoundedToZero'
      readonly quantityMicros: bigint
      readonly priceMicros: bigint
    }
  | {
      readonly _tag: 'AccountingSellQuantityExceedsPosition'
      readonly saleQuantityMicros: bigint
      readonly positionQuantityMicros: bigint
    }
  | {
      readonly _tag: 'AccountingCanonicalizationFailed'
      readonly operation: AccountingHashOperation
      readonly cause: unknown
    }
  | {
      readonly _tag: 'AccountingTransactionDecodeFailed'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'AccountingTransactionContentHashMismatch'
      readonly transactionId: string
      readonly observedContentHash: string
      readonly expectedContentHash: string
    }
  | {
      readonly _tag: 'AccountingLedgerPlanHashMismatch'
      readonly transactionId: string
      readonly observedLedgerPlanHash: string
      readonly expectedLedgerPlanHash: string
    }

export const renderAccountingFailure = (failure: AccountingFailure): string => {
  switch (failure._tag) {
    case 'AccountingMicrosParseFailed':
      return `${failure.field} is not an integer micros value: ${failure.value}`
    case 'AccountingUnsignedDivisionFailed':
      return `fixed-point division rejected ${failure.numerator}/${failure.denominator}`
    case 'AccountingNegativePositionCost':
      return `position cost is negative: quantity=${failure.quantityMicros}, cost=${failure.costMicros}`
    case 'AccountingEmptyPositionRetainsCost':
      return `empty position retains cost basis ${failure.costMicros}`
    case 'AccountingFillNotionalRoundedToZero':
      return `fill notional rounds to zero: quantity=${failure.quantityMicros}, price=${failure.priceMicros}`
    case 'AccountingSellQuantityExceedsPosition':
      return `sell quantity ${failure.saleQuantityMicros} exceeds position ${failure.positionQuantityMicros}`
    case 'AccountingCanonicalizationFailed':
      return `${failure.operation} material is not canonicalizable`
    case 'AccountingTransactionDecodeFailed':
      return 'accounting transaction does not satisfy its schema'
    case 'AccountingTransactionContentHashMismatch':
      return `accounting transaction ${failure.transactionId} content hash does not match`
    case 'AccountingLedgerPlanHashMismatch':
      return `accounting transaction ${failure.transactionId} ledger plan hash does not match`
  }
}
