import {
  type Account,
  CreateAccountStatus,
  CreateTransferStatus,
  type QueryFilter,
  type Transfer,
} from 'tigerbeetle-node'
import { Context, Effect, Layer } from 'effect'

import type { RuntimeConfig } from './config'
import { operationalError, type OperationalError } from './errors'
import { stableU128, stableU64 } from './hash'
import {
  assertAccountsMatch,
  assertReconciled,
  assertTransfersMatch,
  buildLedgerPlan,
  LEDGER_BATCH_MAX as BATCH_MAX,
  LEDGER_SCHEMA_VERSION as SCHEMA_VERSION,
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

const validate = <A>(operation: string, evaluate: () => A): Effect.Effect<A, OperationalError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => operationalError('journal', operation, `TigerBeetle ${operation} failed`, cause),
  })

const createAndVerifyAccounts = (
  client: TigerBeetleRequestClient,
  accounts: readonly Account[],
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const results = yield* client.request('create-accounts', (active) => active.createAccounts([...accounts]))
    const existingIds = yield* validate('verify-account-results', () => {
      if (results.length !== accounts.length) {
        throw new Error('TigerBeetle returned an incomplete account result batch')
      }
      const ids: bigint[] = []
      for (let index = 0; index < results.length; index += 1) {
        const status = results[index].status
        if (status === CreateAccountStatus.created) continue
        if (status === CreateAccountStatus.exists) {
          ids.push(accounts[index].id)
          continue
        }
        throw new Error(`TigerBeetle rejected account ${accounts[index].id} with status ${status}`)
      }
      return ids
    })
    if (existingIds.length === 0) return

    const existing = yield* client.request('lookup-existing-accounts', (active) => active.lookupAccounts(existingIds))
    const expected = accounts.filter((value) => existingIds.includes(value.id))
    yield* validate('verify-existing-accounts', () => assertAccountsMatch('existing account', existing, expected))
  })

const createAndVerifyTransfers = (
  client: TigerBeetleRequestClient,
  transfers: readonly Transfer[],
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const results = yield* client.request('create-transfers', (active) => active.createTransfers([...transfers]))
    const existingIds = yield* validate('verify-transfer-results', () => {
      if (results.length !== transfers.length) {
        throw new Error('TigerBeetle returned an incomplete transfer result batch')
      }
      const ids: bigint[] = []
      for (let index = 0; index < results.length; index += 1) {
        const status = results[index].status
        if (status === CreateTransferStatus.created) continue
        if (status === CreateTransferStatus.exists) {
          ids.push(transfers[index].id)
          continue
        }
        throw new Error(`TigerBeetle rejected transfer ${transfers[index].id} with status ${status}`)
      }
      return ids
    })
    if (existingIds.length === 0) return

    const existing = yield* client.request('lookup-existing-transfers', (active) => active.lookupTransfers(existingIds))
    const expected = transfers.filter((value) => existingIds.includes(value.id))
    yield* validate('verify-existing-transfers', () => assertTransfersMatch('existing transfer', existing, expected))
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

const transactionTransferQuery = (plan: LedgerPlan): QueryFilter => {
  const first = plan.transfers[0]
  if (first === undefined) throw new Error('accounting plan contains no transfers')
  if (
    first.user_data_128 === 0n ||
    plan.transfers.some(
      (transfer) => transfer.ledger !== first.ledger || transfer.user_data_128 !== first.user_data_128,
    )
  ) {
    throw new Error('accounting transfers do not share one nonzero transaction tag and ledger')
  }
  return {
    ...queryFilter(first.ledger),
    user_data_128: first.user_data_128,
    limit: plan.transfers.length + 1,
  }
}

const assertPersistedRun = (
  result: ReconciliationResult,
  ledger: number,
  accounts: readonly Account[],
  transfers: readonly Transfer[],
): void => {
  if (accounts.length !== result.accountCount) {
    throw new Error(`run ${result.runId} has ${accounts.length} accounts; expected ${result.accountCount}`)
  }
  if (transfers.length !== result.transferCount) {
    throw new Error(`run ${result.runId} has ${transfers.length} transfers; expected ${result.transferCount}`)
  }

  const runKey = stableU128('bayn-run-v1', result.runId)
  const runTag = stableU64('bayn-run-v1', result.runId)
  const accountIds = new Set<bigint>()
  const balances = new Map<bigint, { debits: bigint; credits: bigint }>()
  for (const value of accounts) {
    if (accountIds.has(value.id)) throw new Error(`run ${result.runId} contains duplicate account ${value.id}`)
    if (
      value.user_data_128 !== runKey ||
      value.user_data_64 !== runTag ||
      value.user_data_32 !== SCHEMA_VERSION ||
      value.ledger !== ledger
    ) {
      throw new Error(`run ${result.runId} account ${value.id} has invalid metadata`)
    }
    accountIds.add(value.id)
    balances.set(value.id, { debits: 0n, credits: 0n })
  }

  const transferIds = new Set<bigint>()
  for (const value of transfers) {
    if (transferIds.has(value.id)) throw new Error(`run ${result.runId} contains duplicate transfer ${value.id}`)
    if (
      value.user_data_64 !== runTag ||
      value.user_data_32 !== SCHEMA_VERSION ||
      value.ledger !== ledger ||
      value.amount <= 0n
    ) {
      throw new Error(`run ${result.runId} transfer ${value.id} has invalid metadata`)
    }
    const debit = balances.get(value.debit_account_id)
    const credit = balances.get(value.credit_account_id)
    if (debit === undefined || credit === undefined) {
      throw new Error(`run ${result.runId} transfer ${value.id} references an account outside the run`)
    }
    transferIds.add(value.id)
    debit.debits += value.amount
    credit.credits += value.amount
  }

  for (const value of accounts) {
    const balance = balances.get(value.id)
    if (balance === undefined) throw new Error(`run ${result.runId} has no balance for account ${value.id}`)
    if (
      value.debits_pending !== 0n ||
      value.credits_pending !== 0n ||
      value.debits_posted !== balance.debits ||
      value.credits_posted !== balance.credits
    ) {
      throw new Error(`run ${result.runId} account ${value.id} balance does not reconcile exactly`)
    }
  }
}

const checkRun = (
  client: TigerBeetleRequestClient,
  ledger: number,
  result: ReconciliationResult,
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    if (result.accountCount >= BATCH_MAX || result.transferCount >= BATCH_MAX) {
      return yield* Effect.fail(
        operationalError('journal', 'check-run', 'persisted TigerBeetle counts exceed the exact query limit'),
      )
    }
    const runKey = stableU128('bayn-run-v1', result.runId)
    const runTag = stableU64('bayn-run-v1', result.runId)
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('check-run-accounts', (active) =>
          active.queryAccounts({ ...queryFilter(ledger), user_data_128: runKey, limit: result.accountCount + 1 }),
        ),
        client.request('check-run-transfers', (active) =>
          active.queryTransfers({ ...queryFilter(ledger), user_data_64: runTag, limit: result.transferCount + 1 }),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    yield* validate('check-run', () => assertPersistedRun(result, ledger, accounts, transfers))
  })

const journalAndReconcile = (
  client: TigerBeetleRequestClient,
  ledger: number,
  result: LedgerInput,
): Effect.Effect<ReconciliationResult, OperationalError> =>
  Effect.gen(function* () {
    const plan = yield* validate('build-plan', () => buildLedgerPlan(result, ledger))
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
    yield* validate('reconcile', () => assertReconciled(plan, accounts, transfers))
    return { runId: result.runId, accountCount: accounts.length, transferCount: transfers.length, exact: true }
  })

const post = (client: TigerBeetleRequestClient, plan: LedgerPlan): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    if (plan.accounts.length === 0 || plan.transfers.length === 0) {
      return yield* Effect.fail(
        operationalError('journal', 'post', 'TigerBeetle posting plan must contain accounts and transfers'),
      )
    }
    if (plan.accounts.length >= BATCH_MAX || plan.transfers.length >= BATCH_MAX) {
      return yield* Effect.fail(operationalError('journal', 'post', 'TigerBeetle posting plan exceeds batch limits'))
    }
    const transferQuery = yield* validate('build-transaction-transfer-query', () => transactionTransferQuery(plan))
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
    yield* validate('verify-posted-plan', () => {
      assertAccountsMatch('posted account', accounts, plan.accounts)
      assertTransfersMatch('posted transfer', transfers, plan.transfers)
    })
  })

const accountPlan = (accountId: string, plans: readonly LedgerPlan[]): LedgerPlan => {
  const runKey = stableU128('bayn-paper-account-v1', accountId)
  const runTag = stableU64('bayn-paper-account-v1', accountId)
  const accounts = new Map<bigint, Account>()
  const transfers = new Map<bigint, Transfer>()
  for (const plan of plans) {
    if (plan.runKey !== runKey || plan.runTag !== runTag) {
      throw new Error(`accounting plan does not belong to paper account ${accountId}`)
    }
    for (const account of plan.accounts) {
      const existing = accounts.get(account.id)
      if (existing !== undefined) assertAccountsMatch('accounting account', [account], [existing])
      else accounts.set(account.id, account)
    }
    for (const transfer of plan.transfers) {
      if (transfers.has(transfer.id)) throw new Error(`duplicate accounting transfer ${transfer.id}`)
      transfers.set(transfer.id, transfer)
    }
  }
  return {
    runKey,
    runTag,
    accounts: [...accounts.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    transfers: [...transfers.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
  }
}

const verifyAccount = (
  client: TigerBeetleRequestClient,
  ledger: number,
  accountId: string,
  plans: readonly LedgerPlan[],
): Effect.Effect<boolean, OperationalError> =>
  Effect.gen(function* () {
    const expected = yield* validate('build-account-reconciliation', () => accountPlan(accountId, plans))
    if (expected.accounts.length >= BATCH_MAX || expected.transfers.length >= BATCH_MAX) {
      return yield* Effect.fail(
        operationalError('journal', 'verify-account', 'paper account exceeds the exact reconciliation limit'),
      )
    }
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('verify-account-accounts', (active) =>
          active.queryAccounts({
            ...queryFilter(ledger),
            user_data_128: expected.runKey,
            limit: expected.accounts.length + 1,
          }),
        ),
        client.request('verify-account-transfers', (active) =>
          active.queryTransfers({
            ...queryFilter(ledger),
            user_data_64: expected.runTag,
            limit: expected.transfers.length + 1,
          }),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    return yield* Effect.sync(() => {
      try {
        assertReconciled(expected, accounts, transfers)
        return true
      } catch {
        return false
      }
    })
  })

export const JournalLive = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  dependencies?: JournalDependencies,
): Layer.Layer<Journal, OperationalError> =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const client = yield* makeTigerBeetleRequestClient(config, dependencies)
      return {
        post: (plan) => post(client, plan),
        verifyAccount: (accountId, plans) => verifyAccount(client, config.tigerBeetle.ledger, accountId, plans),
        check: client
          .request('connectivity-check', (active) => active.lookupAccounts([stableU128('bayn-connectivity-probe')]))
          .pipe(Effect.asVoid),
        checkRun: (result) => checkRun(client, config.tigerBeetle.ledger, result),
        journalAndReconcile: (result) => journalAndReconcile(client, config.tigerBeetle.ledger, result),
      }
    }),
  )
export { assertReconciled, buildLedgerPlan, hashLedgerPlan, type LedgerInput, type LedgerPlan } from './ledger-plan'
export { resolveReplicaAddresses, type JournalDependencies, type TigerBeetleClient } from './tigerbeetle-client'
