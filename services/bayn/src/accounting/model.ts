import type { LedgerPlan } from '../ledger-plan'
import type { AccountingTransaction } from './schema'

export interface PositionCost {
  readonly quantityMicros: string
  readonly costMicros: string
}

export interface PreparedAccounting {
  readonly transaction: AccountingTransaction
  readonly ledger: LedgerPlan
}
