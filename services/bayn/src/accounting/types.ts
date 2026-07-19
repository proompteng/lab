import type { Account, Transfer } from 'tigerbeetle-node'

import type { BaynAccountCode, BaynLedger, BaynTransferCode } from './model'

export type EvaluationTradeSide = 'BUY' | 'SELL'
export type EvaluationCashDirection = 'DEPOSIT' | 'WITHDRAWAL'

export interface EvaluationTrade {
  /** Stable within the evaluation across retries. */
  readonly eventId: string
  /** Unique economic event ordering across trades, fees, and cash entries. */
  readonly sequence: number
  readonly symbol: string
  readonly side: EvaluationTradeSide
  /** SHARE_E8 units. */
  readonly quantity: bigint
  /** USD_MICRO units, excluding fees. */
  readonly grossAmount: bigint
}

export interface EvaluationFee {
  /** Stable within the evaluation across retries. */
  readonly eventId: string
  readonly sequence: number
  /** USD_MICRO units. */
  readonly amount: bigint
  readonly tradeEventId?: string
}

export interface EvaluationCashEntry {
  /** Stable within the evaluation across retries. */
  readonly eventId: string
  readonly sequence: number
  readonly direction: EvaluationCashDirection
  /** USD_MICRO units. */
  readonly amount: bigint
}

export interface EvaluationEndingPosition {
  readonly symbol: string
  /** SHARE_E8 units. Zero positions must be omitted. */
  readonly quantity: bigint
  /** USD_MICRO units at the evaluator's declared ending mark. */
  readonly marketValue: bigint
}

export interface BaynEvaluationEconomicsV1 {
  readonly schemaVersion: 'bayn.evaluation-economics.v1'
  /** Stable evaluation identity; changing inputs requires a new identity. */
  readonly evaluationId: string
  /** USD_MICRO units. */
  readonly initialCash: bigint
  readonly cashEntries: readonly EvaluationCashEntry[]
  readonly trades: readonly EvaluationTrade[]
  readonly fees: readonly EvaluationFee[]
  readonly ending: {
    /** USD_MICRO units. */
    readonly cash: bigint
    /** Sum of fee events in USD_MICRO units. */
    readonly totalFees: bigint
    /** Cash plus all ending position market values in USD_MICRO units. */
    readonly equity: bigint
    readonly positions: readonly EvaluationEndingPosition[]
  }
}

export type PlannedAccountKind =
  | 'cash'
  | 'capital'
  | 'trade-settlement'
  | 'fee-expense'
  | 'ending-valuation'
  | 'ending-valuation-offset'
  | 'security-position'
  | 'security-market'

export interface PlannedAccount {
  readonly semanticKey: string
  readonly kind: PlannedAccountKind
  readonly symbol?: string
  readonly ledger: BaynLedger
  readonly code: BaynAccountCode
  readonly account: Account
  readonly expectedDebitsPosted: bigint
  readonly expectedCreditsPosted: bigint
}

export type PlannedTransferKind =
  | 'initial-cash'
  | 'cash-entry'
  | 'trade-cash'
  | 'trade-quantity'
  | 'fee'
  | 'ending-valuation'

export interface PlannedTransfer {
  readonly stableEventIdentity: string
  readonly kind: PlannedTransferKind
  readonly sourceEventId: string
  readonly symbol?: string
  readonly ledger: BaynLedger
  readonly code: BaynTransferCode
  readonly transfer: Transfer
}

export interface BaynJournalPlanV1 {
  readonly schemaVersion: 'bayn.tigerbeetle-journal-plan.v1'
  readonly accountingModelVersion: 1
  readonly evaluationId: string
  readonly evaluationFingerprint: bigint
  readonly accounts: readonly PlannedAccount[]
  readonly transfers: readonly PlannedTransfer[]
  readonly expected: {
    readonly endingCash: bigint
    readonly endingEquity: bigint
    readonly totalFees: bigint
    readonly positions: Readonly<Record<string, { readonly quantity: bigint; readonly marketValue: bigint }>>
  }
}
