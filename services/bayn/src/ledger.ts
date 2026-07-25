import {
  type Account,
  type CreateAccountResult,
  CreateAccountStatus,
  type CreateTransferResult,
  CreateTransferStatus,
  type QueryFilter,
  type Transfer,
} from 'tigerbeetle-node'
import { Context, Effect, Layer, Result } from 'effect'

import type { RuntimeConfig } from './config'
import { OperationalError } from './errors'
import { stableU128, stableU64 } from './hash'
import {
  accountMetadataMatches,
  buildLedgerPlan,
  failLedgerValidation as failedValidation,
  LEDGER_BATCH_MAX as BATCH_MAX,
  ledgerValidationError as validationError,
  LedgerValidationError,
  preflightTransfers,
  reconcileLedgerPlan,
  validatePersistedRunEvidence,
  verifyExactAccounts,
  verifyExactTransfers,
  verifyLedgerPlanRecords,
  type LedgerInput,
  type LedgerPlan,
} from './ledger-plan'
import {
  makeTigerBeetleRequestClient,
  type JournalDependencies,
  type TigerBeetleRequestClient,
} from './tigerbeetle-client'
import type { ReconciliationResult } from './types'

export interface JournalService {
  readonly post: (plan: LedgerPlan) => Effect.Effect<void, OperationalError>
  readonly verifyAccount: (accountId: string, plans: readonly LedgerPlan[]) => Effect.Effect<boolean, OperationalError>
  readonly journalAndReconcile: (result: LedgerInput) => Effect.Effect<ReconciliationResult, OperationalError>
  readonly check: Effect.Effect<void, OperationalError>
  readonly checkRun: (result: ReconciliationResult) => Effect.Effect<void, OperationalError>
}

export class Journal extends Context.Service<Journal, JournalService>()('bayn/Journal') {}

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const validationBoundary = <A>(decision: Result.Result<A, LedgerValidationError>): Effect.Effect<A, OperationalError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError(
      (error) =>
        new OperationalError({
          component: 'journal',
          operation: error.operation,
          message: error.message,
          retryable: false,
          cause: error,
        }),
    ),
  )

type CreateResult = CreateAccountResult | CreateTransferResult

const classifyCreateBatch = <Record extends { readonly id: bigint }>(
  kind: 'account' | 'transfer',
  operation: 'verify-account-results' | 'verify-transfer-results',
  records: readonly Record[],
  results: readonly CreateResult[],
  created: number,
  exists: number,
): Result.Result<readonly Record[], LedgerValidationError> => {
  if (results.length !== records.length) {
    return failedValidation(
      operation,
      'batch-result-count',
      `TigerBeetle returned an incomplete ${kind} result batch`,
      { kind, expectedCount: records.length, actualCount: results.length },
    )
  }

  const existing: Record[] = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const record = records[index]
    if (result.status === created) continue
    if (result.status === exists) {
      existing.push(record)
      continue
    }
    return failedValidation(
      operation,
      'create-rejected',
      `TigerBeetle rejected ${kind} ${record.id} with status ${result.status}`,
      {
        kind,
        id: record.id,
        status: result.status,
      },
    )
  }
  return Result.succeed(existing)
}

export const classifyAccountCreateBatch = (
  accounts: readonly Account[],
  results: readonly CreateAccountResult[],
): Result.Result<readonly Account[], LedgerValidationError> =>
  classifyCreateBatch(
    'account',
    'verify-account-results',
    accounts,
    results,
    CreateAccountStatus.created,
    CreateAccountStatus.exists,
  )

export const classifyTransferCreateBatch = (
  transfers: readonly Transfer[],
  results: readonly CreateTransferResult[],
): Result.Result<readonly Transfer[], LedgerValidationError> =>
  classifyCreateBatch(
    'transfer',
    'verify-transfer-results',
    transfers,
    results,
    CreateTransferStatus.created,
    CreateTransferStatus.exists,
  )

const createAndVerifyAccounts = (
  client: TigerBeetleRequestClient,
  accounts: readonly Account[],
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const results = yield* client.request('create-accounts', (active) => active.createAccounts([...accounts]))
    const existingExpected = yield* validationBoundary(classifyAccountCreateBatch(accounts, results))
    if (existingExpected.length === 0) return

    const existing = yield* client.request('lookup-existing-accounts', (active) =>
      active.lookupAccounts(existingExpected.map((account) => account.id)),
    )
    yield* validationBoundary(
      verifyExactAccounts('verify-existing-accounts', 'existing account', existing, existingExpected),
    )
  })

const createAndVerifyTransfers = (
  client: TigerBeetleRequestClient,
  transfers: readonly Transfer[],
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const existing = yield* client.request('lookup-preflight-transfers', (active) =>
      active.lookupTransfers(transfers.map((transfer) => transfer.id)),
    )
    const missing = yield* validationBoundary(preflightTransfers(transfers, existing))
    if (missing.length === 0) return

    const results = yield* client.request('create-transfers', (active) => active.createTransfers([...missing]))
    const existingExpected = yield* validationBoundary(classifyTransferCreateBatch(missing, results))
    if (existingExpected.length === 0) return

    const racedExisting = yield* client.request('lookup-existing-transfers', (active) =>
      active.lookupTransfers(existingExpected.map((transfer) => transfer.id)),
    )
    yield* validationBoundary(
      verifyExactTransfers('verify-existing-transfers', 'existing transfer', racedExisting, existingExpected),
    )
  })

const queryFilter = (ledger: number): QueryFilter => ({
  user_data_128: 0n,
  user_data_64: 0n,
  user_data_32: 0,
  ledger,
  code: 0,
  timestamp_min: 0n,
  timestamp_max: 0n,
  limit: BATCH_MAX,
  flags: 0,
})

export const transactionTransferQuery = (plan: LedgerPlan): Result.Result<QueryFilter, LedgerValidationError> => {
  if (plan.accounts.length === 0 || plan.transfers.length === 0) {
    return Result.fail(
      validationError('post', 'empty-plan', 'TigerBeetle posting plan must contain accounts and transfers', {
        accountCount: plan.accounts.length,
        transferCount: plan.transfers.length,
      }),
    )
  }
  if (plan.accounts.length >= BATCH_MAX || plan.transfers.length >= BATCH_MAX) {
    return Result.fail(
      validationError('post', 'batch-limit', 'TigerBeetle posting plan exceeds batch limits', {
        accountCount: plan.accounts.length,
        transferCount: plan.transfers.length,
        limit: BATCH_MAX,
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
    return failedValidation(
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

interface LedgerQueries {
  readonly accounts: QueryFilter
  readonly transfers: QueryFilter
}

const persistedRunQueries = (
  result: ReconciliationResult,
  ledger: number,
): Result.Result<LedgerQueries, LedgerValidationError> => {
  if (result.accountCount >= BATCH_MAX || result.transferCount >= BATCH_MAX) {
    return Result.fail(
      validationError('check-run', 'batch-limit', 'persisted TigerBeetle counts exceed the exact query limit', {
        accountCount: result.accountCount,
        transferCount: result.transferCount,
        limit: BATCH_MAX,
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

const accountReconciliationQueries = (
  plan: LedgerPlan,
  ledger: number,
): Result.Result<LedgerQueries, LedgerValidationError> => {
  if (plan.accounts.length >= BATCH_MAX || plan.transfers.length >= BATCH_MAX) {
    return Result.fail(
      validationError('verify-account', 'batch-limit', 'paper account exceeds the exact reconciliation limit', {
        accountCount: plan.accounts.length,
        transferCount: plan.transfers.length,
        limit: BATCH_MAX,
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

const checkRun = (
  client: TigerBeetleRequestClient,
  ledger: number,
  result: ReconciliationResult,
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const queries = yield* validationBoundary(persistedRunQueries(result, ledger))
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('check-run-accounts', (active) => active.queryAccounts(queries.accounts)),
        client.request('check-run-transfers', (active) => active.queryTransfers(queries.transfers)),
      ],
      { concurrency: 'unbounded' },
    )
    yield* validationBoundary(validatePersistedRunEvidence(result, ledger, accounts, transfers))
  })

const buildJournalPlan = (result: LedgerInput, ledger: number): Result.Result<LedgerPlan, LedgerValidationError> =>
  Result.try({
    try: () => buildLedgerPlan(result, ledger),
    catch: (cause) =>
      validationError(
        'build-plan',
        'ledger-plan-failure',
        `TigerBeetle build-plan failed: ${causeMessage(cause)}`,
        { ledger },
        cause,
      ),
  })

const journalAndReconcile = (
  client: TigerBeetleRequestClient,
  ledger: number,
  result: LedgerInput,
): Effect.Effect<ReconciliationResult, OperationalError> =>
  Effect.gen(function* () {
    const plan = yield* validationBoundary(buildJournalPlan(result, ledger))
    yield* createAndVerifyAccounts(client, plan.accounts)
    yield* createAndVerifyTransfers(client, plan.transfers)
    const accountQuery = { ...queryFilter(ledger), user_data_128: plan.runKey, limit: plan.accounts.length + 1 }
    const transferQuery = { ...queryFilter(ledger), user_data_64: plan.runTag, limit: plan.transfers.length + 1 }
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('query-accounts', (active) => active.queryAccounts(accountQuery)),
        client.request('query-transfers', (active) => active.queryTransfers(transferQuery)),
      ],
      { concurrency: 'unbounded' },
    )
    yield* validationBoundary(reconcileLedgerPlan(plan, accounts, transfers))
    return { runId: result.runId, accountCount: accounts.length, transferCount: transfers.length, exact: true }
  })

const post = (client: TigerBeetleRequestClient, plan: LedgerPlan): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const transferQuery = yield* validationBoundary(transactionTransferQuery(plan))
    yield* createAndVerifyAccounts(client, plan.accounts)
    yield* createAndVerifyTransfers(client, plan.transfers)
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('verify-posted-accounts', (active) =>
          active.lookupAccounts(plan.accounts.map((account) => account.id)),
        ),
        client.request('verify-posted-transfers', (active) => active.queryTransfers(transferQuery)),
      ],
      { concurrency: 'unbounded' },
    )
    yield* validationBoundary(
      verifyLedgerPlanRecords('verify-posted-plan', 'posted account', 'posted transfer', plan, accounts, transfers),
    )
  })

export const assembleAccountPlan = (
  accountId: string,
  plans: readonly LedgerPlan[],
): Result.Result<LedgerPlan, LedgerValidationError> => {
  const runKey = stableU128('bayn-paper-account-v1', accountId)
  const runTag = stableU64('bayn-paper-account-v1', accountId)
  const accounts = new Map<bigint, Account>()
  const transfers = new Map<bigint, Transfer>()
  for (const plan of plans) {
    if (plan.runKey !== runKey || plan.runTag !== runTag) {
      return failedValidation(
        'build-account-reconciliation',
        'wrong-account',
        `accounting plan does not belong to paper account ${accountId}`,
        { accountId, planRunKey: plan.runKey, planRunTag: plan.runTag, expectedRunKey: runKey, expectedRunTag: runTag },
      )
    }
    for (const account of plan.accounts) {
      const existing = accounts.get(account.id)
      if (existing !== undefined && !accountMetadataMatches(account, existing)) {
        return failedValidation(
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
        return failedValidation(
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

const verifyAccount = (
  client: TigerBeetleRequestClient,
  ledger: number,
  accountId: string,
  plans: readonly LedgerPlan[],
): Effect.Effect<boolean, OperationalError> =>
  Effect.gen(function* () {
    const expected = yield* validationBoundary(assembleAccountPlan(accountId, plans))
    const queries = yield* validationBoundary(accountReconciliationQueries(expected, ledger))
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('verify-account-accounts', (active) => active.queryAccounts(queries.accounts)),
        client.request('verify-account-transfers', (active) => active.queryTransfers(queries.transfers)),
      ],
      { concurrency: 'unbounded' },
    )
    return Result.isSuccess(reconcileLedgerPlan(expected, accounts, transfers, 'verify-account'))
  })

export const JournalLive = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  dependencies?: JournalDependencies,
): Layer.Layer<Journal, OperationalError> =>
  Layer.effect(
    Journal,
    makeTigerBeetleRequestClient(config, dependencies).pipe(
      Effect.map(
        (client): JournalService => ({
          post: (plan) => post(client, plan),
          verifyAccount: (accountId, plans) => verifyAccount(client, config.tigerBeetle.ledger, accountId, plans),
          check: client
            .request('connectivity-check', (active) => active.lookupAccounts([stableU128('bayn-connectivity-probe')]))
            .pipe(Effect.asVoid),
          checkRun: (result) => checkRun(client, config.tigerBeetle.ledger, result),
          journalAndReconcile: (result) => journalAndReconcile(client, config.tigerBeetle.ledger, result),
        }),
      ),
    ),
  )
export {
  buildLedgerPlan,
  hashLedgerPlan,
  LedgerValidationError,
  reconcileLedgerPlan,
  validatePersistedRunEvidence,
  type LedgerInput,
  type LedgerPlan,
  type LedgerValidationOperation,
  type LedgerValidationReason,
} from './ledger-plan'
export { resolveReplicaAddresses, type JournalDependencies, type TigerBeetleClient } from './tigerbeetle-client'
