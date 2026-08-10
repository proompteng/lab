import { Result } from 'effect'

import { stableU128, stableU64 } from '../hash'
import {
  accountMetadataMatches,
  failLedgerValidation,
  LEDGER_BATCH_MAX,
  ledgerValidationError,
  type LedgerPlan,
  type LedgerAccountRecord,
  type LedgerCreateResult,
  type LedgerQueryFilter,
  type LedgerTransferRecord,
  type LedgerValidationError,
} from '../ledger-plan'
import type { ReconciliationResult } from '../types'

const classifyCreateBatch = <Record extends { readonly id: bigint }>(
  kind: 'account' | 'transfer',
  operation: 'verify-account-results' | 'verify-transfer-results',
  records: readonly Record[],
  results: readonly LedgerCreateResult[],
): Result.Result<readonly Record[], LedgerValidationError> => {
  if (results.length !== records.length) {
    return failLedgerValidation(
      operation,
      'batch-result-count',
      `TigerBeetle returned an incomplete ${kind} result batch`,
      { kind, expectedCount: records.length, actualCount: results.length },
    )
  }

  const existing: Record[] = []
  for (const [index, result] of results.entries()) {
    const record = records[index]
    if (record === undefined) {
      return failLedgerValidation(
        operation,
        'batch-result-count',
        `TigerBeetle returned a ${kind} result without a corresponding record`,
        { kind, index, expectedCount: records.length, actualCount: results.length },
      )
    }
    if (result.outcome === 'created') continue
    if (result.outcome === 'exists') {
      existing.push(record)
      continue
    }
    return failLedgerValidation(
      operation,
      'create-rejected',
      `TigerBeetle rejected ${kind} ${record.id} with status ${result.status}`,
      { kind, id: record.id, status: result.status },
    )
  }
  return Result.succeed(existing)
}

export const classifyAccountCreateBatch = (
  accounts: readonly LedgerAccountRecord[],
  results: readonly LedgerCreateResult[],
): Result.Result<readonly LedgerAccountRecord[], LedgerValidationError> =>
  classifyCreateBatch('account', 'verify-account-results', accounts, results)

export const classifyTransferCreateBatch = (
  transfers: readonly LedgerTransferRecord[],
  results: readonly LedgerCreateResult[],
): Result.Result<readonly LedgerTransferRecord[], LedgerValidationError> =>
  classifyCreateBatch('transfer', 'verify-transfer-results', transfers, results)

const queryFilter = (ledger: number): LedgerQueryFilter => ({
  user_data_128: 0n,
  user_data_64: 0n,
  user_data_32: 0,
  ledger,
  code: 0,
  timestamp_min: 0n,
  timestamp_max: 0n,
  limit: LEDGER_BATCH_MAX,
  flags: 0,
})

export const transactionTransferQuery = (plan: LedgerPlan): Result.Result<LedgerQueryFilter, LedgerValidationError> => {
  if (plan.accounts.length === 0 || plan.transfers.length === 0) {
    return Result.fail(
      ledgerValidationError('post', 'empty-plan', 'TigerBeetle posting plan must contain accounts and transfers', {
        accountCount: plan.accounts.length,
        transferCount: plan.transfers.length,
      }),
    )
  }
  if (plan.accounts.length >= LEDGER_BATCH_MAX || plan.transfers.length >= LEDGER_BATCH_MAX) {
    return Result.fail(
      ledgerValidationError('post', 'batch-limit', 'TigerBeetle posting plan exceeds batch limits', {
        accountCount: plan.accounts.length,
        transferCount: plan.transfers.length,
        limit: LEDGER_BATCH_MAX,
      }),
    )
  }

  const first = plan.transfers[0]
  if (
    first === undefined ||
    first.user_data_128 === 0n ||
    plan.transfers.some(
      (transfer) => transfer.ledger !== first.ledger || transfer.user_data_128 !== first.user_data_128,
    )
  ) {
    return failLedgerValidation(
      'build-transaction-transfer-query',
      'invalid-transaction',
      first === undefined
        ? 'accounting plan contains no transfers'
        : 'accounting transfers do not share one nonzero transaction tag and ledger',
      {
        transferCount: plan.transfers.length,
        transactionTag: first?.user_data_128,
        ledger: first?.ledger,
      },
    )
  }
  return Result.succeed({
    ...queryFilter(first.ledger),
    user_data_128: first.user_data_128,
    limit: plan.transfers.length + 1,
  })
}

export interface LedgerQueries {
  readonly accounts: LedgerQueryFilter
  readonly transfers: LedgerQueryFilter
}

export const persistedRunQueries = (
  result: ReconciliationResult,
  ledger: number,
): Result.Result<LedgerQueries, LedgerValidationError> => {
  if (result.accountCount >= LEDGER_BATCH_MAX || result.transferCount >= LEDGER_BATCH_MAX) {
    return Result.fail(
      ledgerValidationError('check-run', 'batch-limit', 'persisted TigerBeetle counts exceed the exact query limit', {
        accountCount: result.accountCount,
        transferCount: result.transferCount,
        limit: LEDGER_BATCH_MAX,
      }),
    )
  }
  return Result.succeed({
    accounts: {
      ...queryFilter(ledger),
      user_data_128: stableU128('bayn-run-v1', result.runId),
      limit: result.accountCount + 1,
    },
    transfers: {
      ...queryFilter(ledger),
      user_data_64: stableU64('bayn-run-v1', result.runId),
      limit: result.transferCount + 1,
    },
  })
}

export const accountReconciliationQueries = (
  plan: LedgerPlan,
  ledger: number,
): Result.Result<LedgerQueries, LedgerValidationError> => {
  if (plan.accounts.length >= LEDGER_BATCH_MAX || plan.transfers.length >= LEDGER_BATCH_MAX) {
    return Result.fail(
      ledgerValidationError('verify-account', 'batch-limit', 'paper account exceeds the exact reconciliation limit', {
        accountCount: plan.accounts.length,
        transferCount: plan.transfers.length,
        limit: LEDGER_BATCH_MAX,
      }),
    )
  }
  return Result.succeed({
    accounts: {
      ...queryFilter(ledger),
      user_data_128: plan.runKey,
      limit: plan.accounts.length + 1,
    },
    transfers: {
      ...queryFilter(ledger),
      user_data_64: plan.runTag,
      limit: plan.transfers.length + 1,
    },
  })
}

export const runPlanQueries = (plan: LedgerPlan, ledger: number): LedgerQueries => ({
  accounts: { ...queryFilter(ledger), user_data_128: plan.runKey, limit: plan.accounts.length + 1 },
  transfers: { ...queryFilter(ledger), user_data_64: plan.runTag, limit: plan.transfers.length + 1 },
})

export const assembleAccountPlan = (
  accountId: string,
  plans: readonly LedgerPlan[],
): Result.Result<LedgerPlan, LedgerValidationError> => {
  const runKey = stableU128('bayn-paper-account-v1', accountId)
  const runTag = stableU64('bayn-paper-account-v1', accountId)
  const accounts = new Map<bigint, LedgerAccountRecord>()
  const transfers = new Map<bigint, LedgerTransferRecord>()
  for (const plan of plans) {
    if (plan.runKey !== runKey || plan.runTag !== runTag) {
      return failLedgerValidation(
        'build-account-reconciliation',
        'wrong-account',
        `accounting plan does not belong to paper account ${accountId}`,
        { accountId, planRunKey: plan.runKey, planRunTag: plan.runTag, expectedRunKey: runKey, expectedRunTag: runTag },
      )
    }
    for (const account of plan.accounts) {
      const existing = accounts.get(account.id)
      if (existing !== undefined && !accountMetadataMatches(account, existing)) {
        return failLedgerValidation(
          'build-account-reconciliation',
          'record-mismatch',
          `accounting account ${account.id} does not match its plan`,
          { kind: 'accounting account', id: account.id, actual: account, expected: existing },
        )
      }
      if (existing === undefined) accounts.set(account.id, account)
    }
    for (const transfer of plan.transfers) {
      if (transfers.has(transfer.id)) {
        return failLedgerValidation(
          'build-account-reconciliation',
          'duplicate-transfer',
          `duplicate accounting transfer ${transfer.id}`,
          { accountId, transferId: transfer.id },
        )
      }
      transfers.set(transfer.id, transfer)
    }
  }
  return Result.succeed({
    runKey,
    runTag,
    accounts: [...accounts.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    transfers: [...transfers.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
  })
}
