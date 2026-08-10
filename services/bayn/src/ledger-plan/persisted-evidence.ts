import { Result } from 'effect'

import { canonicalHashV1, stableU128, stableU64 } from '../hash'
import { Pipeable } from '../pipeable'
import type { ReconciliationResult } from '../types'
import {
  AccountCode,
  failLedgerValidation,
  LEDGER_ACCOUNT_HISTORY_FLAG,
  LEDGER_SCHEMA_VERSION,
  TransferCode,
  type LedgerAccountRecord,
  type LedgerTransferRecord,
  type LedgerValidationError,
} from './model'
import { reconcileBalances } from './verification'

const fixedAccountNames = new Map<number, string>([
  [AccountCode.cash, 'cash'],
  [AccountCode.equity, 'equity'],
  [AccountCode.realizedGain, 'realized-gain'],
  [AccountCode.cashYieldIncome, 'cash-yield-income'],
  [AccountCode.feeExpense, 'fee-expense'],
  [AccountCode.realizedLoss, 'realized-loss'],
])
const accountCodes = new Set<number>(Object.values(AccountCode))
const transferCodes = new Set<number>(Object.values(TransferCode))
const transferAccountCodes = new Map<number, readonly [number, number]>([
  [TransferCode.funding, [AccountCode.cash, AccountCode.equity]],
  [TransferCode.buy, [AccountCode.inventory, AccountCode.cash]],
  [TransferCode.sellBasis, [AccountCode.cash, AccountCode.inventory]],
  [TransferCode.realizedGain, [AccountCode.cash, AccountCode.realizedGain]],
  [TransferCode.realizedLoss, [AccountCode.realizedLoss, AccountCode.inventory]],
  [TransferCode.fee, [AccountCode.feeExpense, AccountCode.cash]],
  [TransferCode.cashYield, [AccountCode.cash, AccountCode.cashYieldIncome]],
])

const verifyPersistedAccount = (
  result: ReconciliationResult,
  ledger: number,
  runKey: bigint,
  runTag: bigint,
  account: LedgerAccountRecord,
): Result.Result<void, LedgerValidationError> => {
  const fixedName = fixedAccountNames.get(account.code)
  const expectedId = fixedName === undefined ? undefined : stableU128('bayn-account-v1', result.runId, fixedName)
  if (
    account.id === 0n ||
    account.user_data_128 !== runKey ||
    account.user_data_64 !== runTag ||
    account.user_data_32 !== LEDGER_SCHEMA_VERSION ||
    account.reserved !== 0 ||
    account.ledger !== ledger ||
    !accountCodes.has(account.code) ||
    account.flags !== LEDGER_ACCOUNT_HISTORY_FLAG ||
    account.timestamp <= 0n ||
    (expectedId !== undefined && account.id !== expectedId)
  ) {
    return failLedgerValidation({
      operation: 'check-run',
      reason: 'invalid-account-metadata',
      detail: `run ${result.runId} account ${account.id} has invalid locally verifiable metadata`,
      material: {
        runId: result.runId,
        account,
        expected: {
          runKey,
          runTag,
          schemaVersion: LEDGER_SCHEMA_VERSION,
          reserved: 0,
          ledger,
          accountCodes: [...accountCodes],
          flags: LEDGER_ACCOUNT_HISTORY_FLAG,
          positiveTimestamp: true,
          ...(expectedId === undefined ? {} : { deterministicId: expectedId }),
        },
      },
    })
  }
  return Result.succeed(undefined)
}

const verifyPersistedTransfer = (
  result: ReconciliationResult,
  ledger: number,
  runTag: bigint,
  accountsById: ReadonlyMap<bigint, LedgerAccountRecord>,
  transfer: LedgerTransferRecord,
): Result.Result<void, LedgerValidationError> => {
  const debit = accountsById.get(transfer.debit_account_id)
  const credit = accountsById.get(transfer.credit_account_id)
  const accountCodePair = transferAccountCodes.get(transfer.code)
  const fundingId = stableU128('bayn-transfer-v1', result.runId, 'funding', 'principal')
  const fundingEventId = stableU128(
    'bayn-event-v1',
    canonicalHashV1({ kind: 'funding', runId: result.runId, amountMicros: transfer.amount.toString() }),
  )
  if (
    transfer.id === 0n ||
    transfer.debit_account_id === transfer.credit_account_id ||
    transfer.amount <= 0n ||
    transfer.pending_id !== 0n ||
    transfer.user_data_128 === 0n ||
    transfer.user_data_64 !== runTag ||
    transfer.user_data_32 !== LEDGER_SCHEMA_VERSION ||
    transfer.timeout !== 0 ||
    transfer.ledger !== ledger ||
    !transferCodes.has(transfer.code) ||
    transfer.flags !== 0 ||
    transfer.timestamp <= 0n ||
    debit === undefined ||
    credit === undefined ||
    accountCodePair === undefined ||
    debit.code !== accountCodePair[0] ||
    credit.code !== accountCodePair[1] ||
    (transfer.code === TransferCode.funding && (transfer.id !== fundingId || transfer.user_data_128 !== fundingEventId))
  ) {
    return failLedgerValidation({
      operation: 'check-run',
      reason: 'invalid-transfer-metadata',
      detail: `run ${result.runId} transfer ${transfer.id} has invalid locally verifiable metadata`,
      material: {
        runId: result.runId,
        transfer,
        expected: {
          runTag,
          schemaVersion: LEDGER_SCHEMA_VERSION,
          pendingId: 0n,
          timeout: 0,
          ledger,
          transferCodes: [...transferCodes],
          flags: 0,
          positiveTimestamp: true,
          accountCodePair,
          ...(transfer.code === TransferCode.funding
            ? { deterministicId: fundingId, deterministicEventId: fundingEventId }
            : {}),
        },
      },
    })
  }
  return Result.succeed(undefined)
}

/**
 * Validates only invariants reconstructible from a persisted reconciliation receipt and TigerBeetle records.
 * Event-derived identities other than funding require the original expected plan and are verified separately.
 */
const validatePersistedRunEvidenceDataFirst = (
  result: ReconciliationResult,
  ledger: number,
  accounts: readonly LedgerAccountRecord[],
  transfers: readonly LedgerTransferRecord[],
): Result.Result<void, LedgerValidationError> =>
  Result.gen(function* () {
    if (accounts.length !== result.accountCount) {
      return yield* failLedgerValidation({
        operation: 'check-run',
        reason: 'run-count-mismatch',
        detail: `run ${result.runId} has ${accounts.length} accounts; expected ${result.accountCount}`,
        material: {
          runId: result.runId,
          kind: 'account',
          actualCount: accounts.length,
          expectedCount: result.accountCount,
        },
      })
    }
    if (transfers.length !== result.transferCount) {
      return yield* failLedgerValidation({
        operation: 'check-run',
        reason: 'run-count-mismatch',
        detail: `run ${result.runId} has ${transfers.length} transfers; expected ${result.transferCount}`,
        material: {
          runId: result.runId,
          kind: 'transfer',
          actualCount: transfers.length,
          expectedCount: result.transferCount,
        },
      })
    }

    const runKey = stableU128('bayn-run-v1', result.runId)
    const runTag = stableU64('bayn-run-v1', result.runId)
    const reconciled = yield* reconcileBalances('check-run', accounts, transfers, result.runId)
    for (const account of accounts) yield* verifyPersistedAccount(result, ledger, runKey, runTag, account)
    if (accounts.length > 0) {
      for (const [code, name] of fixedAccountNames) {
        const expectedId = stableU128('bayn-account-v1', result.runId, name)
        const persistedAccount = reconciled.accountsById.get(expectedId)
        if (persistedAccount === undefined) {
          return yield* failLedgerValidation({
            operation: 'check-run',
            reason: 'record-set-mismatch',
            detail: `run ${result.runId} is missing required ${name} account`,
            material: { runId: result.runId, kind: 'account', code, expectedId },
          })
        }
        if (persistedAccount.code !== code) {
          return yield* failLedgerValidation({
            operation: 'check-run',
            reason: 'invalid-account-metadata',
            detail: `run ${result.runId} required ${name} account has code ${persistedAccount.code}; expected ${code}`,
            material: {
              runId: result.runId,
              account: persistedAccount,
              expected: { deterministicId: expectedId, code },
            },
          })
        }
      }
    }
    for (const transfer of transfers) {
      yield* verifyPersistedTransfer(result, ledger, runTag, reconciled.accountsById, transfer)
    }
    const fundingId = stableU128('bayn-transfer-v1', result.runId, 'funding', 'principal')
    if (transfers.length > 0 && !reconciled.transfersById.has(fundingId)) {
      return yield* failLedgerValidation({
        operation: 'check-run',
        reason: 'record-set-mismatch',
        detail: `run ${result.runId} is missing its deterministic funding transfer`,
        material: { runId: result.runId, kind: 'transfer', code: TransferCode.funding, expectedId: fundingId },
      })
    }
  })

export const validatePersistedRunEvidence = Pipeable.dual(4, validatePersistedRunEvidenceDataFirst)
