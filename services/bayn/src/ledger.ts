import { Context, Effect, Layer, Result } from 'effect'

import type { RuntimeConfig } from './config'
import { OperationalError } from './errors'
import { stableU128 } from './hash'
import {
  buildLedgerPlan,
  LedgerValidationError,
  preflightTransfers,
  reconcileLedgerPlan,
  validatePersistedRunEvidence,
  verifyExactAccounts,
  verifyExactTransfers,
  verifyLedgerPlanRecords,
  type LedgerInput,
  type LedgerAccountRecord,
  type LedgerPlan,
  type LedgerTransferRecord,
} from './ledger-plan'
import {
  accountReconciliationQueries,
  assembleAccountPlan,
  classifyAccountCreateBatch,
  classifyTransferCreateBatch,
  persistedRunQueries,
  runPlanQueries,
  transactionTransferQuery,
} from './ledger/decisions'
import {
  makeTigerBeetleRequestClient,
  type JournalDependencies,
  type TigerBeetleRequestClient,
} from './tigerbeetle-client'
import type { ReconciliationResult } from './types'
import { Pipeable } from './pipeable'

export class JournalValidationError extends OperationalError {
  readonly validation: LedgerValidationError

  constructor(validation: LedgerValidationError) {
    super({
      component: 'journal',
      operation: validation.operation,
      message: validation.message,
      retryable: false,
      cause: validation,
    })
    this.validation = validation
  }
}

export type JournalError = OperationalError

export interface JournalService {
  readonly post: (plan: LedgerPlan) => Effect.Effect<void, JournalError>
  readonly verifyAccount: (accountId: string, plans: readonly LedgerPlan[]) => Effect.Effect<boolean, JournalError>
  readonly journalAndReconcile: (result: LedgerInput) => Effect.Effect<ReconciliationResult, JournalError>
  readonly check: Effect.Effect<void, OperationalError>
  readonly checkRun: (result: ReconciliationResult) => Effect.Effect<void, JournalError>
}

export class Journal extends Context.Service<Journal, JournalService>()('bayn/Journal') {}

const validationBoundary = <A>(decision: Result.Result<A, LedgerValidationError>) =>
  Effect.fromResult(decision).pipe(Effect.mapError((validation) => new JournalValidationError(validation)))

const createAndVerifyAccounts = (
  client: TigerBeetleRequestClient,
  accounts: readonly LedgerAccountRecord[],
): Effect.Effect<void, JournalError> =>
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
  transfers: readonly LedgerTransferRecord[],
): Effect.Effect<void, JournalError> =>
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

const checkRun = (
  client: TigerBeetleRequestClient,
  ledger: number,
  result: ReconciliationResult,
): Effect.Effect<void, JournalError> =>
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

const journalAndReconcile = (
  client: TigerBeetleRequestClient,
  ledger: number,
  result: LedgerInput,
): Effect.Effect<ReconciliationResult, JournalError> =>
  Effect.gen(function* () {
    const plan = yield* validationBoundary(buildLedgerPlan(result, ledger))
    yield* createAndVerifyAccounts(client, plan.accounts)
    yield* createAndVerifyTransfers(client, plan.transfers)
    const queries = runPlanQueries(plan, ledger)
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('query-accounts', (active) => active.queryAccounts(queries.accounts)),
        client.request('query-transfers', (active) => active.queryTransfers(queries.transfers)),
      ],
      { concurrency: 'unbounded' },
    )
    yield* validationBoundary(reconcileLedgerPlan(plan, accounts, transfers))
    return { runId: plan.runId, accountCount: accounts.length, transferCount: transfers.length, exact: true }
  })

const post = (client: TigerBeetleRequestClient, plan: LedgerPlan): Effect.Effect<void, JournalError> =>
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

const verifyAccount = (
  client: TigerBeetleRequestClient,
  ledger: number,
  accountId: string,
  plans: readonly LedgerPlan[],
): Effect.Effect<boolean, JournalError> =>
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

const JournalLiveDataFirst = (
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

export const JournalLive = Pipeable.by<
  (
    dependencies?: JournalDependencies,
  ) => (config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>) => ReturnType<typeof JournalLiveDataFirst>,
  typeof JournalLiveDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'tigerBeetle' in arguments_[0],
  JournalLiveDataFirst,
)

export {
  assembleAccountPlan,
  classifyAccountCreateBatch,
  classifyTransferCreateBatch,
  transactionTransferQuery,
} from './ledger/decisions'
export {
  buildLedgerPlan,
  hashLedgerPlanResult,
  LedgerValidationError,
  reconcileLedgerPlan,
  validatePersistedRunEvidence,
  type LedgerCreateResult,
  type EvaluationLedgerPlan,
  type LedgerInput,
  type LedgerPlan,
  type LedgerPlanFailure,
  type LedgerValidationOperation,
  type LedgerValidationReason,
} from './ledger-plan'
export {
  ReplicaAddressOperationalError,
  ReplicaAddressValidationError,
  resolveReplicaAddresses,
  TigerBeetleTransportError,
  type JournalDependencies,
  type TigerBeetleClient,
} from './tigerbeetle-client'
