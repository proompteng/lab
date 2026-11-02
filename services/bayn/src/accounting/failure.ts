import type { Schema } from 'effect'

import type { CanonicalHashFailure } from '../hash'
import type { UnsignedRoundHalfUpFailure } from '../unsigned-round-half-up'

export type AccountingMicrosField =
  | 'fill.feeMicros'
  | 'fill.priceAtoms'
  | 'fill.quantityAtoms'
  | 'position.costMicros'
  | 'position.quantityAtoms'

export type AccountingHashOperation = 'ledger-plan' | 'transaction-content' | 'transaction-id'

export type AccountingFailure =
  | {
      readonly _tag: 'AccountingMicrosParseFailed'
      readonly field: AccountingMicrosField
      readonly value: string
    }
  | {
      readonly _tag: 'AccountingUnsignedDivisionFailed'
      readonly numerator: bigint
      readonly denominator: bigint
      readonly cause: UnsignedRoundHalfUpFailure
    }
  | {
      readonly _tag: 'AccountingNegativePositionCost'
      readonly quantityAtoms: bigint
      readonly costMicros: bigint
    }
  | {
      readonly _tag: 'AccountingEmptyPositionRetainsCost'
      readonly costMicros: bigint
    }
  | {
      readonly _tag: 'AccountingFillNotionalRoundedToZero'
      readonly quantityAtoms: bigint
      readonly priceAtoms: bigint
    }
  | {
      readonly _tag: 'AccountingSellQuantityExceedsPosition'
      readonly saleQuantityAtoms: bigint
      readonly positionQuantityAtoms: bigint
    }
  | {
      readonly _tag: 'AccountingCanonicalizationFailed'
      readonly operation: Exclude<AccountingHashOperation, 'ledger-plan'>
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'AccountingCanonicalizationFailed'
      readonly operation: 'ledger-plan'
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
      return `position cost is negative: quantity=${failure.quantityAtoms}, cost=${failure.costMicros}`
    case 'AccountingEmptyPositionRetainsCost':
      return `empty position retains cost basis ${failure.costMicros}`
    case 'AccountingFillNotionalRoundedToZero':
      return `fill notional rounds to zero: quantity=${failure.quantityAtoms}, price=${failure.priceAtoms}`
    case 'AccountingSellQuantityExceedsPosition':
      return `sell quantity ${failure.saleQuantityAtoms} exceeds position ${failure.positionQuantityAtoms}`
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
