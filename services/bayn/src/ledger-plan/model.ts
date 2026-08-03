import { Data, Result } from 'effect'

import { renderCanonicalJsonFailure, type CanonicalJsonFailure } from '../hash'
import type { EvaluationEvent, ReconciliationResult } from '../types'

export const LEDGER_SCHEMA_VERSION = 2
export const LEDGER_BATCH_MAX = 8_189
export const LEDGER_ACCOUNT_HISTORY_FLAG = 1 << 3

/** Domain-owned record shapes; the TigerBeetle SDK is confined to transport adapters. */
export interface LedgerAccountRecord {
  readonly id: bigint
  readonly debits_pending: bigint
  readonly debits_posted: bigint
  readonly credits_pending: bigint
  readonly credits_posted: bigint
  readonly user_data_128: bigint
  readonly user_data_64: bigint
  readonly user_data_32: number
  readonly reserved: number
  readonly ledger: number
  readonly code: number
  readonly flags: number
  readonly timestamp: bigint
}

export interface LedgerTransferRecord {
  readonly id: bigint
  readonly debit_account_id: bigint
  readonly credit_account_id: bigint
  readonly amount: bigint
  readonly pending_id: bigint
  readonly user_data_128: bigint
  readonly user_data_64: bigint
  readonly user_data_32: number
  readonly timeout: number
  readonly ledger: number
  readonly code: number
  readonly flags: number
  readonly timestamp: bigint
}

export const AccountCode = {
  cash: 110,
  inventory: 120,
  equity: 310,
  realizedGain: 410,
  cashYieldIncome: 420,
  feeExpense: 510,
  realizedLoss: 520,
} as const

export const TransferCode = {
  funding: 1,
  buy: 2,
  sellBasis: 3,
  realizedGain: 4,
  realizedLoss: 5,
  fee: 6,
  cashYield: 7,
} as const

export interface LedgerInput {
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly inputManifest: {
    readonly symbols: readonly { readonly symbol: string }[]
  }
  readonly events: readonly EvaluationEvent[]
}

export type LedgerPlanInputField =
  | 'cashYield.amountMicros'
  | 'cashYield.id'
  | 'event.kind'
  | 'events'
  | 'fee.id'
  | 'fee.totalMicros'
  | 'fill.costBasisMicros'
  | 'fill.id'
  | 'fill.notionalMicros'
  | 'fill.side'
  | 'fill.symbol'
  | 'initialCapitalMicros'
  | 'inputManifest.symbol'
  | 'inputManifest.symbols'
  | 'runId'

export type LedgerValidationOperation =
  | 'build-account-reconciliation'
  | 'build-plan'
  | 'build-transaction-transfer-query'
  | 'check-run'
  | 'post'
  | 'preflight-transfers'
  | 'reconcile'
  | 'verify-account'
  | 'verify-account-results'
  | 'verify-existing-accounts'
  | 'verify-existing-transfers'
  | 'verify-posted-plan'
  | 'verify-transfer-results'

export type LedgerValidationReason =
  | 'batch-limit'
  | 'batch-result-count'
  | 'create-rejected'
  | 'duplicate-account'
  | 'duplicate-transfer'
  | 'empty-plan'
  | 'invalid-account-metadata'
  | 'invalid-balance'
  | 'invalid-transaction'
  | 'invalid-transfer-metadata'
  | 'ledger-plan-failure'
  | 'missing-balance'
  | 'record-mismatch'
  | 'record-set-mismatch'
  | 'run-count-mismatch'
  | 'unknown-account-reference'
  | 'wrong-account'

export class LedgerValidationError extends Data.TaggedError('LedgerValidationError')<{
  readonly operation: LedgerValidationOperation
  readonly reason: LedgerValidationReason
  readonly message: string
  readonly material: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}

export const ledgerValidationError = (
  operation: LedgerValidationOperation,
  reason: LedgerValidationReason,
  message: string,
  material: Readonly<Record<string, unknown>>,
  cause?: unknown,
): LedgerValidationError => new LedgerValidationError({ operation, reason, message, material, cause })

export const failLedgerValidation = (
  operation: LedgerValidationOperation,
  reason: LedgerValidationReason,
  detail: string,
  material: Readonly<Record<string, unknown>>,
  cause?: unknown,
): Result.Result<never, LedgerValidationError> =>
  Result.fail(ledgerValidationError(operation, reason, `TigerBeetle ${operation} failed: ${detail}`, material, cause))

export interface LedgerPlan {
  readonly runKey: bigint
  readonly runTag: bigint
  readonly accounts: readonly LedgerAccountRecord[]
  readonly transfers: readonly LedgerTransferRecord[]
}

export interface EvaluationLedgerPlan extends LedgerPlan {
  readonly runId: string
}

export type LedgerPlanAmountField =
  | 'cashYield.amountMicros'
  | 'fee.totalMicros'
  | 'fill.costBasisMicros'
  | 'fill.notionalMicros'
  | 'initialCapitalMicros'

type LedgerPlanInputExpectation = 'evaluation-event-kind' | 'fill-side' | 'string'

export type LedgerPlanFailureDetail =
  | {
      readonly kind: 'no-fill-events'
      readonly runId: string
      readonly eventCount: number
    }
  | {
      readonly kind: 'amount-parse-failed'
      readonly field: LedgerPlanAmountField
      readonly actualType: string
      readonly value?: string
      readonly eventId?: string
      readonly cause: unknown
    }
  | {
      readonly kind: 'negative-amount'
      readonly field: Exclude<LedgerPlanAmountField, 'initialCapitalMicros'>
      readonly value: bigint
      readonly eventId: string
    }
  | {
      readonly kind: 'initial-capital-not-positive'
      readonly value: bigint
    }
  | {
      readonly kind: 'inventory-account-missing'
      readonly runId: string
      readonly eventId: string
      readonly symbol: string
    }
  | {
      readonly kind: 'canonicalization-failed'
      readonly canonicalizationOperation: 'event-transfer'
      readonly eventId: string
      readonly leg: string
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly kind: 'input-access-failed'
      readonly field: LedgerPlanInputField
      readonly eventIndex?: number
      readonly eventKind?: 'decision' | 'fill' | 'fee' | 'cash-yield'
      readonly cause: unknown
    }
  | {
      readonly kind: 'input-value-invalid'
      readonly field: LedgerPlanInputField
      readonly expected: LedgerPlanInputExpectation
      readonly actualType: string
      readonly value?: string
      readonly index?: number
      readonly eventKind?: 'decision' | 'fill' | 'fee' | 'cash-yield'
    }
  | {
      readonly kind: 'single-query-limit-exceeded'
      readonly runId: string
      readonly accountCount: number
      readonly transferCount: number
      readonly limit: number
    }

export type LedgerPlanFailure = LedgerValidationError & {
  readonly kind: LedgerPlanFailureDetail['kind']
  readonly detail: LedgerPlanFailureDetail
}

export type LedgerPlanHashFailure = {
  readonly _tag: 'LedgerPlanHashCanonicalizationFailed'
  readonly cause: CanonicalJsonFailure
}

export type PersistedReconciliation = Pick<ReconciliationResult, 'runId' | 'accountCount' | 'transferCount' | 'exact'>

export const renderLedgerPlanFailure = (failure: LedgerPlanFailureDetail): string => {
  switch (failure.kind) {
    case 'no-fill-events':
      return 'evaluation produced no fill events to journal'
    case 'amount-parse-failed':
      return failure.value === undefined
        ? `${failure.field} is not an integer micros value (${failure.actualType})`
        : `${failure.field} is not an integer micros value: ${failure.value}`
    case 'negative-amount':
      return `${failure.field} must not be negative`
    case 'initial-capital-not-positive':
      return 'initial capital must be positive'
    case 'inventory-account-missing':
      return `missing inventory account for ${failure.symbol}`
    case 'canonicalization-failed':
      return `event ${failure.eventId} ${failure.leg} material is not canonicalizable: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'input-access-failed':
      return `${failure.field} is unavailable`
    case 'input-value-invalid':
      return `${failure.field} is not a valid ${failure.expected}`
    case 'single-query-limit-exceeded':
      return 'Bayn ledger run exceeds the exact single-query reconciliation limit'
  }
}

const ledgerPlanCause = (failure: LedgerPlanFailureDetail): unknown => {
  switch (failure.kind) {
    case 'amount-parse-failed':
    case 'canonicalization-failed':
    case 'input-access-failed':
      return failure.cause
    default:
      return failure
  }
}

export const makeLedgerPlanFailure = (ledger: number, detail: LedgerPlanFailureDetail): LedgerPlanFailure =>
  Object.assign(
    ledgerValidationError(
      'build-plan',
      'ledger-plan-failure',
      `TigerBeetle build-plan failed: ${renderLedgerPlanFailure(detail)}`,
      { ledger, failure: detail },
      ledgerPlanCause(detail),
    ),
    { kind: detail.kind, detail },
  ) as LedgerPlanFailure

export const failLedgerPlan = (failure: LedgerPlanFailureDetail): Result.Result<never, LedgerPlanFailureDetail> =>
  Result.fail(failure)
