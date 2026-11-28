import { reportedCashMicros } from '../broker/alpaca/cash-reporting'
import { Data, Effect, Result, Scope } from 'effect'

import type { RuntimeConfig } from '../config/model'
import { assembleAccountPlan } from '../ledger/decisions'
import { readAccountLedger } from '../ledger/account-read'
import {
  AccountCode,
  ledgerValidationError,
  reconcileLedgerPlan,
  type LedgerPlan,
  type LedgerAccountRecord,
  type LedgerValidationError,
} from '../ledger-plan'
import { makeTigerBeetleRequestClient, type JournalDependencies } from '../tigerbeetle-client'
import type { OperationalError } from '../errors'
import type {
  ForwardPerformanceCashYieldBinding,
  ForwardPerformanceCashYieldEvidence,
  ForwardPerformanceLedgerTotals,
} from './model'

export class ForwardPerformanceLedgerError extends Data.TaggedError('ForwardPerformanceLedgerError')<{
  readonly operation: 'read'
  readonly message: string
  readonly cause: OperationalError | LedgerValidationError
}> {}

export interface ForwardPerformanceLedgerEvidence {
  readonly totals: ForwardPerformanceLedgerTotals
  readonly ledgerExact: boolean
  readonly missingLedgerAccountCount: number
  readonly openPositionCount: number
  readonly cashYieldEvidenceRequired: boolean
  readonly cashYieldEvidence?: ForwardPerformanceCashYieldBinding
}

const ledgerError = (cause: OperationalError | LedgerValidationError): ForwardPerformanceLedgerError =>
  new ForwardPerformanceLedgerError({
    operation: 'read',
    message: 'forward-performance TigerBeetle read failed',
    cause,
  })

const planAmount = (plan: LedgerPlan, code: number, side: 'debit' | 'credit'): bigint => {
  const accounts = new Map(plan.accounts.map((account) => [account.id, account.code]))
  return plan.transfers.reduce((total, transfer) => {
    const accountId = side === 'debit' ? transfer.debit_account_id : transfer.credit_account_id
    return accounts.get(accountId) === code ? total + transfer.amount : total
  }, 0n)
}

const generationLedgerTotals = (plan: LedgerPlan): ForwardPerformanceLedgerTotals => ({
  cashSettlementRoundingMicros: (
    planAmount(plan, AccountCode.cashRoundingIncome, 'credit') -
    planAmount(plan, AccountCode.cashRoundingExpense, 'debit')
  ).toString(),
  realizedGainMicros: planAmount(plan, AccountCode.realizedGain, 'credit').toString(),
  realizedLossMicros: planAmount(plan, AccountCode.realizedLoss, 'debit').toString(),
  brokerExecutionFeesMicros: (
    planAmount(plan, AccountCode.feeExpense, 'debit') - planAmount(plan, AccountCode.feeExpense, 'credit')
  ).toString(),
  // Trading transfers contain no inference or operating-expense coverage; exactness cannot prove those costs zero.
  otherChargedCostsMicros: null,
  cashYieldMicros: '0',
})

const openInventoryCount = (accounts: readonly LedgerAccountRecord[]): number =>
  accounts.filter(
    (account) => account.code === AccountCode.inventory && account.debits_posted !== account.credits_posted,
  ).length

const SIGNED_I128_MIN = -(1n << 127n)
const SIGNED_I128_MAX = (1n << 127n) - 1n
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/

const cashYieldFailure = (detail: string, material: Readonly<Record<string, unknown>>): LedgerValidationError =>
  ledgerValidationError({ operation: 'verify-account', reason: 'invalid-transaction', message: detail, material })

const parseSignedI128 = (value: string, field: string): Result.Result<bigint, LedgerValidationError> => {
  if (!INTEGER_PATTERN.test(value)) {
    return Result.fail(cashYieldFailure('cash-yield evidence contains a noncanonical integer', { field, value }))
  }
  const parsed = BigInt(value)
  return parsed < SIGNED_I128_MIN || parsed > SIGNED_I128_MAX
    ? Result.fail(cashYieldFailure('cash-yield evidence exceeds signed int128', { field, value }))
    : Result.succeed(parsed)
}

const validateCashYieldEvidence = (
  evidence: ForwardPerformanceCashYieldEvidence | undefined,
): Result.Result<bigint, LedgerValidationError> =>
  Result.gen(function* () {
    if (evidence === undefined) return 0n
    if (
      evidence.schemaVersion !== 'bayn.forward-performance-cash-yield-evidence.v3' ||
      !SHA256_PATTERN.test(evidence.reconciliationId) ||
      !SHA256_PATTERN.test(evidence.reconciliationContentHash) ||
      !SHA256_PATTERN.test(evidence.baselineAccountEventId) ||
      !SHA256_PATTERN.test(evidence.openingAccountEventId) ||
      !SHA256_PATTERN.test(evidence.closingAccountEventId)
    ) {
      return yield* Result.fail(
        cashYieldFailure('cash-yield evidence identity is invalid', {
          schemaVersion: evidence.schemaVersion,
          reconciliationId: evidence.reconciliationId,
          reconciliationContentHash: evidence.reconciliationContentHash,
          baselineAccountEventId: evidence.baselineAccountEventId,
          openingAccountEventId: evidence.openingAccountEventId,
          closingAccountEventId: evidence.closingAccountEventId,
        }),
      )
    }

    const reconciledAt = Date.parse(evidence.reconciledAt)
    const baselineObservedAt = Date.parse(evidence.baselineObservedAt)
    const openingObservedAt = Date.parse(evidence.openingObservedAt)
    const closingObservedAt = Date.parse(evidence.closingObservedAt)
    if (
      !Number.isFinite(reconciledAt) ||
      !Number.isFinite(baselineObservedAt) ||
      !Number.isFinite(openingObservedAt) ||
      !Number.isFinite(closingObservedAt) ||
      baselineObservedAt > openingObservedAt ||
      openingObservedAt > closingObservedAt ||
      closingObservedAt > reconciledAt
    ) {
      return yield* Result.fail(
        cashYieldFailure('cash-yield evidence chronology is invalid', {
          reconciledAt: evidence.reconciledAt,
          baselineObservedAt: evidence.baselineObservedAt,
          openingObservedAt: evidence.openingObservedAt,
          closingObservedAt: evidence.closingObservedAt,
        }),
      )
    }

    const baselineCash = yield* parseSignedI128(evidence.baselineCashMicros, 'baselineCashMicros')
    const openingCash = yield* parseSignedI128(evidence.openingCashMicros, 'openingCashMicros')
    const baselineOffset = yield* parseSignedI128(
      evidence.baselineCashReportingOffsetMicros,
      'baselineCashReportingOffsetMicros',
    )
    const openingOffset = yield* parseSignedI128(
      evidence.openingCashReportingOffsetMicros,
      'openingCashReportingOffsetMicros',
    )
    const closingOffset = yield* parseSignedI128(
      evidence.closingCashReportingOffsetMicros,
      'closingCashReportingOffsetMicros',
    )
    const preWindowCashDelta = yield* parseSignedI128(
      evidence.preWindowAccountedCashDeltaMicros,
      'preWindowAccountedCashDeltaMicros',
    )
    const preWindowResidual = yield* parseSignedI128(
      evidence.preWindowCashResidualMicros,
      'preWindowCashResidualMicros',
    )
    const closingCash = yield* parseSignedI128(evidence.closingCashMicros, 'closingCashMicros')
    const accountedCashDelta = yield* parseSignedI128(evidence.accountedCashDeltaMicros, 'accountedCashDeltaMicros')
    const cashYieldAmount = yield* parseSignedI128(evidence.cashYieldMicros, 'cashYieldMicros')
    const derivedPreWindowResidual =
      openingCash -
      BigInt(
        reportedCashMicros(
          (baselineCash + preWindowCashDelta + openingOffset - baselineOffset).toString(),
          evidence.openingCashReportingQuantumMicros,
        ),
      )
    const derivedCashYield =
      closingCash -
      BigInt(
        reportedCashMicros(
          (openingCash + accountedCashDelta + closingOffset - openingOffset).toString(),
          evidence.closingCashReportingQuantumMicros,
        ),
      )
    if (
      (openingOffset < 0n ? -openingOffset : openingOffset) * 2n > BigInt(evidence.openingCashReportingQuantumMicros) ||
      (closingOffset < 0n ? -closingOffset : closingOffset) * 2n > BigInt(evidence.closingCashReportingQuantumMicros) ||
      (evidence.baselineAccountEventId === evidence.openingAccountEventId && baselineOffset !== openingOffset) ||
      preWindowResidual !== 0n ||
      derivedPreWindowResidual !== preWindowResidual ||
      derivedCashYield < 0n ||
      derivedCashYield > SIGNED_I128_MAX ||
      cashYieldAmount !== derivedCashYield
    ) {
      return yield* Result.fail(
        cashYieldFailure('cash-yield evidence does not reconcile durable cash snapshots', {
          baselineCashMicros: evidence.baselineCashMicros,
          openingCashMicros: evidence.openingCashMicros,
          preWindowAccountedCashDeltaMicros: evidence.preWindowAccountedCashDeltaMicros,
          preWindowCashResidualMicros: evidence.preWindowCashResidualMicros,
          derivedPreWindowCashResidualMicros: derivedPreWindowResidual.toString(),
          closingCashMicros: evidence.closingCashMicros,
          accountedCashDeltaMicros: evidence.accountedCashDeltaMicros,
          cashYieldMicros: evidence.cashYieldMicros,
          derivedCashYieldMicros: derivedCashYield.toString(),
        }),
      )
    }
    return cashYieldAmount
  })

export const readForwardPerformanceLedger = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  accountId: string,
  accountPlans: readonly LedgerPlan[],
  cashYieldEvidence?: ForwardPerformanceCashYieldEvidence,
  dependencies?: JournalDependencies,
  generationPlans: readonly LedgerPlan[] = accountPlans,
): Effect.Effect<ForwardPerformanceLedgerEvidence, ForwardPerformanceLedgerError, Scope.Scope> =>
  Effect.gen(function* () {
    const cashYieldResidual = yield* Effect.fromResult(validateCashYieldEvidence(cashYieldEvidence))
    const accountPlan = yield* Effect.fromResult(assembleAccountPlan(accountId, accountPlans))
    const generationPlan = yield* Effect.fromResult(assembleAccountPlan(accountId, generationPlans))
    const client = yield* makeTigerBeetleRequestClient(config, dependencies)
    const { accounts, transfers } = yield* readAccountLedger(client, accountPlan, config.tigerBeetle.ledger)

    const expectedAccountIds = new Set(accountPlan.accounts.map((account) => account.id))
    const actualAccountIds = new Set(accounts.map((account) => account.id))
    const missingLedgerAccountCount = [...expectedAccountIds].filter((id) => !actualAccountIds.has(id)).length
    const reconciliation = reconcileLedgerPlan(accountPlan, accounts, transfers, 'verify-account')

    return {
      totals: {
        ...generationLedgerTotals(generationPlan),
      },
      ledgerExact: Result.isSuccess(reconciliation),
      missingLedgerAccountCount,
      openPositionCount: openInventoryCount(accounts),
      cashYieldEvidenceRequired: cashYieldResidual > 0n,
    }
  }).pipe(Effect.mapError(ledgerError))
