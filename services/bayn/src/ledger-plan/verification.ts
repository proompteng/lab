import { Result } from 'effect'

import {
  failLedgerValidation,
  type LedgerAccountRecord,
  type LedgerPlan,
  type LedgerTransferRecord,
  type LedgerValidationError,
  type LedgerValidationOperation,
} from './model'

export const accountMetadataMatches = (actual: LedgerAccountRecord, expected: LedgerAccountRecord): boolean =>
  actual.id === expected.id &&
  actual.user_data_128 === expected.user_data_128 &&
  actual.user_data_64 === expected.user_data_64 &&
  actual.user_data_32 === expected.user_data_32 &&
  actual.reserved === expected.reserved &&
  actual.ledger === expected.ledger &&
  actual.code === expected.code &&
  actual.flags === expected.flags

export const transferMetadataMatches = (actual: LedgerTransferRecord, expected: LedgerTransferRecord): boolean =>
  actual.id === expected.id &&
  actual.debit_account_id === expected.debit_account_id &&
  actual.credit_account_id === expected.credit_account_id &&
  actual.amount === expected.amount &&
  actual.pending_id === expected.pending_id &&
  actual.user_data_128 === expected.user_data_128 &&
  actual.user_data_64 === expected.user_data_64 &&
  actual.user_data_32 === expected.user_data_32 &&
  actual.timeout === expected.timeout &&
  actual.ledger === expected.ledger &&
  actual.code === expected.code &&
  actual.flags === expected.flags

const duplicateRecordId = <Record extends { readonly id: bigint }>(records: readonly Record[]): bigint | undefined => {
  const ids = new Set<bigint>()
  for (const record of records) {
    if (ids.has(record.id)) return record.id
    ids.add(record.id)
  }
  return undefined
}

const verifyUniqueExact = <Record extends { readonly id: bigint }>(
  operation: LedgerValidationOperation,
  kind: string,
  actual: readonly Record[],
  expected: readonly Record[],
  matches: (actualValue: Record, expectedValue: Record) => boolean,
): Result.Result<void, LedgerValidationError> => {
  const actualDuplicateId = duplicateRecordId(actual)
  const expectedDuplicateId = duplicateRecordId(expected)
  if (actual.length !== expected.length || actualDuplicateId !== undefined || expectedDuplicateId !== undefined) {
    return failLedgerValidation(
      operation,
      'record-set-mismatch',
      `${kind} set mismatch: expected ${expected.length}, received ${actual.length}`,
      {
        kind,
        expectedCount: expected.length,
        actualCount: actual.length,
        ...(actualDuplicateId === undefined ? {} : { duplicateId: actualDuplicateId }),
        ...(expectedDuplicateId === undefined ? {} : { duplicateExpectedId: expectedDuplicateId }),
      },
    )
  }

  const expectedById = new Map(expected.map((value) => [value.id, value]))
  for (const value of actual) {
    const expectedValue = expectedById.get(value.id)
    if (expectedValue === undefined || !matches(value, expectedValue)) {
      return failLedgerValidation(operation, 'record-mismatch', `${kind} ${value.id} does not match its plan`, {
        kind,
        id: value.id,
        actual: value,
        expected: expectedValue,
      })
    }
  }
  return Result.succeed(undefined)
}

export const verifyExactAccounts = (
  operation: LedgerValidationOperation,
  kind: string,
  actual: readonly LedgerAccountRecord[],
  expected: readonly LedgerAccountRecord[],
): Result.Result<void, LedgerValidationError> =>
  verifyUniqueExact(operation, kind, actual, expected, accountMetadataMatches)

export const verifyExactTransfers = (
  operation: LedgerValidationOperation,
  kind: string,
  actual: readonly LedgerTransferRecord[],
  expected: readonly LedgerTransferRecord[],
): Result.Result<void, LedgerValidationError> =>
  verifyUniqueExact(operation, kind, actual, expected, transferMetadataMatches)

export const verifyLedgerPlanRecords = (
  operation: LedgerValidationOperation,
  accountKind: string,
  transferKind: string,
  plan: LedgerPlan,
  actualAccounts: readonly LedgerAccountRecord[],
  actualTransfers: readonly LedgerTransferRecord[],
): Result.Result<void, LedgerValidationError> =>
  Result.gen(function* () {
    yield* verifyExactAccounts(operation, accountKind, actualAccounts, plan.accounts)
    yield* verifyExactTransfers(operation, transferKind, actualTransfers, plan.transfers)
  })

export const preflightTransfers = (
  expected: readonly LedgerTransferRecord[],
  existing: readonly LedgerTransferRecord[],
): Result.Result<readonly LedgerTransferRecord[], LedgerValidationError> => {
  const expectedDuplicateId = duplicateRecordId(expected)
  const existingDuplicateId = duplicateRecordId(existing)
  if (expectedDuplicateId !== undefined || existingDuplicateId !== undefined) {
    return failLedgerValidation(
      'preflight-transfers',
      'record-set-mismatch',
      'transfer preflight contains duplicate deterministic IDs',
      {
        expectedCount: expected.length,
        actualCount: existing.length,
        ...(expectedDuplicateId === undefined ? {} : { duplicateExpectedId: expectedDuplicateId }),
        ...(existingDuplicateId === undefined ? {} : { duplicateId: existingDuplicateId }),
      },
    )
  }

  const expectedById = new Map(expected.map((transfer) => [transfer.id, transfer]))
  const existingIds = new Set<bigint>()
  for (const transfer of existing) {
    const expectedTransfer = expectedById.get(transfer.id)
    if (expectedTransfer === undefined || !transferMetadataMatches(transfer, expectedTransfer)) {
      return failLedgerValidation(
        'preflight-transfers',
        'record-mismatch',
        `existing transfer ${transfer.id} does not match its plan`,
        {
          kind: 'existing transfer',
          id: transfer.id,
          actual: transfer,
          expected: expectedTransfer,
        },
      )
    }
    existingIds.add(transfer.id)
  }
  return Result.succeed(expected.filter((transfer) => !existingIds.has(transfer.id)))
}

export interface LedgerBalances {
  readonly accountsById: ReadonlyMap<bigint, LedgerAccountRecord>
  readonly transfersById: ReadonlyMap<bigint, LedgerTransferRecord>
}

export const reconcileBalances = (
  operation: 'check-run' | 'reconcile' | 'verify-account',
  accounts: readonly LedgerAccountRecord[],
  transfers: readonly LedgerTransferRecord[],
  runId?: string,
): Result.Result<LedgerBalances, LedgerValidationError> => {
  const accountDuplicateId = duplicateRecordId(accounts)
  if (accountDuplicateId !== undefined) {
    return failLedgerValidation(
      operation,
      'duplicate-account',
      runId === undefined
        ? `ledger contains duplicate account ${accountDuplicateId}`
        : `run ${runId} contains duplicate account ${accountDuplicateId}`,
      { ...(runId === undefined ? {} : { runId }), accountId: accountDuplicateId },
    )
  }
  const transferDuplicateId = duplicateRecordId(transfers)
  if (transferDuplicateId !== undefined) {
    return failLedgerValidation(
      operation,
      'duplicate-transfer',
      runId === undefined
        ? `ledger contains duplicate transfer ${transferDuplicateId}`
        : `run ${runId} contains duplicate transfer ${transferDuplicateId}`,
      { ...(runId === undefined ? {} : { runId }), transferId: transferDuplicateId },
    )
  }

  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const transfersById = new Map(transfers.map((transfer) => [transfer.id, transfer]))
  const balances = new Map(accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  for (const transfer of transfers) {
    const debit = balances.get(transfer.debit_account_id)
    const credit = balances.get(transfer.credit_account_id)
    if (debit === undefined || credit === undefined) {
      return failLedgerValidation(
        operation,
        'unknown-account-reference',
        runId === undefined
          ? `transfer ${transfer.id} references an unknown account`
          : `run ${runId} transfer ${transfer.id} references an account outside the run`,
        {
          ...(runId === undefined ? {} : { runId }),
          transferId: transfer.id,
          debitAccountId: transfer.debit_account_id,
          creditAccountId: transfer.credit_account_id,
        },
      )
    }
    if (transfer.debit_account_id === transfer.credit_account_id) {
      balances.set(transfer.debit_account_id, {
        debits: debit.debits + transfer.amount,
        credits: debit.credits + transfer.amount,
      })
    } else {
      balances.set(transfer.debit_account_id, { debits: debit.debits + transfer.amount, credits: debit.credits })
      balances.set(transfer.credit_account_id, { debits: credit.debits, credits: credit.credits + transfer.amount })
    }
  }

  for (const account of accounts) {
    const balance = balances.get(account.id)
    if (balance === undefined) {
      return failLedgerValidation(
        operation,
        'missing-balance',
        runId === undefined
          ? `unexpected account ${account.id}`
          : `run ${runId} has no balance for account ${account.id}`,
        { ...(runId === undefined ? {} : { runId }), accountId: account.id },
      )
    }
    if (
      account.debits_pending !== 0n ||
      account.credits_pending !== 0n ||
      account.debits_posted !== balance.debits ||
      account.credits_posted !== balance.credits
    ) {
      return failLedgerValidation(
        operation,
        'invalid-balance',
        runId === undefined
          ? `account ${account.id} balance does not reconcile exactly`
          : `run ${runId} account ${account.id} balance does not reconcile locally`,
        { ...(runId === undefined ? {} : { runId }), account, expected: balance },
      )
    }
  }
  return Result.succeed({ accountsById, transfersById })
}

export const reconcileLedgerPlan = (
  plan: LedgerPlan,
  actualAccounts: readonly LedgerAccountRecord[],
  actualTransfers: readonly LedgerTransferRecord[],
  operation: 'reconcile' | 'verify-account' = 'reconcile',
): Result.Result<void, LedgerValidationError> =>
  Result.gen(function* () {
    yield* verifyLedgerPlanRecords(operation, 'account', 'transfer', plan, actualAccounts, actualTransfers)
    yield* reconcileBalances(operation, actualAccounts, actualTransfers)
  })
