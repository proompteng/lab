import type { LedgerPlan } from '../ledger-plan'
import type { AccountingTransaction } from './schema'

export interface PositionCost {
  readonly quantityAtoms: string
  readonly costMicros: string
}

export interface PreparedAccounting {
  readonly transaction: AccountingTransaction
  readonly ledger: LedgerPlan
}
