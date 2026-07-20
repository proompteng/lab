import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

import {
  AccountFlags,
  type Account,
  type Client,
  CreateAccountStatus,
  CreateTransferStatus,
  type QueryFilter,
  type Transfer,
  createClient,
} from 'tigerbeetle-node'
import { Context, Effect, Layer } from 'effect'

import type { RuntimeConfig } from './config'
import { operationalError, type OperationalError } from './errors'
import { hashObject, stableU128, stableU64 } from './hash'
import type { EvaluationResult, FillEvent, ReconciliationResult } from './types'

const SCHEMA_VERSION = 1
const BATCH_MAX = 8_189

type ResolveHostname = (hostname: string) => Effect.Effect<readonly string[], OperationalError>

const lookupIpv4: ResolveHostname = (hostname) =>
  Effect.suspend(() => {
    const resolver = new Resolver()
    return Effect.tryPromise({
      try: () => resolver.resolve4(hostname),
      catch: (cause) =>
        operationalError(
          'journal',
          'resolve-replica-addresses',
          `failed to resolve TigerBeetle hostname ${hostname}`,
          cause,
        ),
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => resolver.cancel())))
  })

const parsePort = (value: string, address: string): Effect.Effect<number, OperationalError> => {
  if (!/^\d+$/.test(value)) {
    return Effect.fail(
      operationalError('journal', 'resolve-replica-addresses', `invalid TigerBeetle replica address: ${address}`),
    )
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Effect.fail(
      operationalError('journal', 'resolve-replica-addresses', `invalid TigerBeetle replica port: ${address}`),
    )
  }
  return Effect.succeed(port)
}

const resolveReplicaAddress = (
  configuredAddress: string,
  resolveHostname: ResolveHostname,
): Effect.Effect<readonly string[], OperationalError> =>
  Effect.gen(function* () {
    const address = configuredAddress.trim()
    const addressFamily = isIP(address)
    if (addressFamily === 4) return [address]
    if (addressFamily === 6) {
      return yield* Effect.fail(
        operationalError(
          'journal',
          'resolve-replica-addresses',
          `IPv6 TigerBeetle replica addresses are not supported: ${address}`,
        ),
      )
    }
    if (/^\d+$/.test(address)) {
      yield* parsePort(address, address)
      return [address]
    }

    const separator = address.lastIndexOf(':')
    if (separator <= 0 || separator !== address.indexOf(':')) {
      return yield* Effect.fail(
        operationalError(
          'journal',
          'resolve-replica-addresses',
          `invalid TigerBeetle replica address: ${configuredAddress}`,
        ),
      )
    }
    const hostname = address.slice(0, separator)
    const port = yield* parsePort(address.slice(separator + 1), address)
    const hostnameFamily = isIP(hostname)
    if (hostnameFamily === 4) return [`${hostname}:${port}`]
    if (hostnameFamily === 6) {
      return yield* Effect.fail(
        operationalError(
          'journal',
          'resolve-replica-addresses',
          `IPv6 TigerBeetle replica addresses are not supported: ${address}`,
        ),
      )
    }

    const ipv4Addresses = (yield* resolveHostname(hostname)).filter((value) => isIP(value) === 4)
    if (ipv4Addresses.length === 0) {
      return yield* Effect.fail(
        operationalError(
          'journal',
          'resolve-replica-addresses',
          `TigerBeetle replica hostname has no IPv4 address: ${hostname}`,
        ),
      )
    }
    return ipv4Addresses.map((ipv4Address) => `${ipv4Address}:${port}`)
  })

export const resolveReplicaAddresses = (
  configuredAddresses: readonly string[],
  resolveHostname: ResolveHostname = lookupIpv4,
): Effect.Effect<string[], OperationalError> =>
  configuredAddresses.length === 0
    ? Effect.fail(
        operationalError(
          'journal',
          'resolve-replica-addresses',
          'at least one TigerBeetle replica address is required',
        ),
      )
    : Effect.forEach(configuredAddresses, (address) => resolveReplicaAddress(address, resolveHostname), {
        concurrency: 'unbounded',
      }).pipe(Effect.map((resolved) => [...new Set(resolved.flat())]))

const AccountCode = {
  cash: 110,
  inventory: 120,
  equity: 310,
  realizedGain: 410,
  feeExpense: 510,
  realizedLoss: 520,
} as const

const TransferCode = {
  funding: 1,
  buy: 2,
  sellBasis: 3,
  realizedGain: 4,
  realizedLoss: 5,
  fee: 6,
} as const

export interface LedgerPlan {
  readonly runKey: bigint
  readonly runTag: bigint
  readonly accounts: readonly Account[]
  readonly transfers: readonly Transfer[]
}

export interface JournalService {
  readonly journalAndReconcile: (result: EvaluationResult) => Effect.Effect<ReconciliationResult, OperationalError>
  readonly check: Effect.Effect<void, OperationalError>
}

export class Journal extends Context.Service<Journal, JournalService>()('bayn/Journal') {}

const account = (
  runId: string,
  runKey: bigint,
  runTag: bigint,
  ledger: number,
  name: string,
  code: number,
): Account => ({
  id: stableU128('bayn-account-v1', runId, name),
  debits_pending: 0n,
  debits_posted: 0n,
  credits_pending: 0n,
  credits_posted: 0n,
  user_data_128: runKey,
  user_data_64: runTag,
  user_data_32: SCHEMA_VERSION,
  reserved: 0,
  ledger,
  code,
  flags: AccountFlags.history,
  timestamp: 0n,
})

const transfer = (
  runId: string,
  runTag: bigint,
  ledger: number,
  eventId: string,
  leg: string,
  debitAccountId: bigint,
  creditAccountId: bigint,
  amount: bigint,
  code: number,
  event: unknown,
): Transfer => ({
  id: stableU128('bayn-transfer-v1', runId, eventId, leg),
  debit_account_id: debitAccountId,
  credit_account_id: creditAccountId,
  amount,
  pending_id: 0n,
  user_data_128: stableU128('bayn-event-v1', hashObject(event)),
  user_data_64: runTag,
  user_data_32: SCHEMA_VERSION,
  timeout: 0,
  ledger,
  code,
  flags: 0,
  timestamp: 0n,
})

const positiveAmount = (value: string, name: string): bigint => {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error(`${name} must not be negative`)
  return parsed
}

export const buildLedgerPlan = (result: EvaluationResult, ledger: number): LedgerPlan => {
  const runKey = stableU128('bayn-run-v1', result.runId)
  const runTag = stableU64('bayn-run-v1', result.runId)
  const accountsByName = new Map<string, Account>()
  const addAccount = (name: string, code: number): Account => {
    const created = account(result.runId, runKey, runTag, ledger, name, code)
    accountsByName.set(name, created)
    return created
  }
  const cash = addAccount('cash', AccountCode.cash)
  const equity = addAccount('equity', AccountCode.equity)
  const fees = addAccount('fee-expense', AccountCode.feeExpense)
  const realizedGain = addAccount('realized-gain', AccountCode.realizedGain)
  const realizedLoss = addAccount('realized-loss', AccountCode.realizedLoss)
  for (const symbol of result.inputManifest.symbols.map((coverage) => coverage.symbol).sort()) {
    addAccount(`inventory:${symbol}`, AccountCode.inventory)
  }

  const transfers: Transfer[] = []
  const fillEvents = result.events.filter((event): event is FillEvent => event.kind === 'fill')
  if (fillEvents.length === 0) throw new Error('evaluation produced no fill events to journal')
  const startingCapital = BigInt(result.initialCapitalMicros)
  if (startingCapital <= 0n) throw new Error('initial capital must be positive')
  transfers.push(
    transfer(
      result.runId,
      runTag,
      ledger,
      'funding',
      'principal',
      cash.id,
      equity.id,
      startingCapital,
      TransferCode.funding,
      { kind: 'funding', runId: result.runId, amountMicros: startingCapital.toString() },
    ),
  )

  for (const fill of fillEvents) {
    const inventory = accountsByName.get(`inventory:${fill.symbol}`)
    if (!inventory) throw new Error(`missing inventory account for ${fill.symbol}`)
    const notional = positiveAmount(fill.notionalMicros, 'fill notional')
    const costBasis = positiveAmount(fill.costBasisMicros, 'fill cost basis')
    const fee = positiveAmount(fill.feeMicros, 'fill fee')
    if (notional === 0n) continue

    if (fill.side === 'buy') {
      transfers.push(
        transfer(result.runId, runTag, ledger, fill.id, 'buy', inventory.id, cash.id, notional, TransferCode.buy, fill),
      )
    } else if (notional >= costBasis) {
      if (costBasis > 0n) {
        transfers.push(
          transfer(
            result.runId,
            runTag,
            ledger,
            fill.id,
            'sell-basis',
            cash.id,
            inventory.id,
            costBasis,
            TransferCode.sellBasis,
            fill,
          ),
        )
      }
      if (notional > costBasis) {
        transfers.push(
          transfer(
            result.runId,
            runTag,
            ledger,
            fill.id,
            'realized-gain',
            cash.id,
            realizedGain.id,
            notional - costBasis,
            TransferCode.realizedGain,
            fill,
          ),
        )
      }
    } else {
      transfers.push(
        transfer(
          result.runId,
          runTag,
          ledger,
          fill.id,
          'sell-proceeds',
          cash.id,
          inventory.id,
          notional,
          TransferCode.sellBasis,
          fill,
        ),
      )
      transfers.push(
        transfer(
          result.runId,
          runTag,
          ledger,
          fill.id,
          'realized-loss',
          realizedLoss.id,
          inventory.id,
          costBasis - notional,
          TransferCode.realizedLoss,
          fill,
        ),
      )
    }
    if (fee > 0n) {
      transfers.push(
        transfer(result.runId, runTag, ledger, fill.id, 'fee', fees.id, cash.id, fee, TransferCode.fee, fill),
      )
    }
  }

  if (accountsByName.size >= BATCH_MAX || transfers.length >= BATCH_MAX) {
    throw new Error('Bayn ledger run exceeds the exact single-query reconciliation limit')
  }
  return {
    runKey,
    runTag,
    accounts: [...accountsByName.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    transfers: transfers.sort((left, right) => (left.id < right.id ? -1 : 1)),
  }
}

const accountMetadataMatches = (actual: Account, expected: Account): boolean =>
  actual.id === expected.id &&
  actual.user_data_128 === expected.user_data_128 &&
  actual.user_data_64 === expected.user_data_64 &&
  actual.user_data_32 === expected.user_data_32 &&
  actual.ledger === expected.ledger &&
  actual.code === expected.code &&
  actual.flags === expected.flags

const transferMatches = (actual: Transfer, expected: Transfer): boolean =>
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

const assertUniqueExact = <T extends { readonly id: bigint }>(
  kind: string,
  actual: readonly T[],
  expected: readonly T[],
  matches: (actualValue: T, expectedValue: T) => boolean,
): void => {
  const expectedById = new Map(expected.map((value) => [value.id, value]))
  if (actual.length !== expected.length || new Set(actual.map((value) => value.id)).size !== actual.length) {
    throw new Error(`${kind} set mismatch: expected ${expected.length}, received ${actual.length}`)
  }
  for (const value of actual) {
    const expectedValue = expectedById.get(value.id)
    if (!expectedValue || !matches(value, expectedValue)) throw new Error(`${kind} ${value.id} does not match its plan`)
  }
}

export const assertReconciled = (
  plan: LedgerPlan,
  actualAccounts: readonly Account[],
  actualTransfers: readonly Transfer[],
): void => {
  assertUniqueExact('account', actualAccounts, plan.accounts, accountMetadataMatches)
  assertUniqueExact('transfer', actualTransfers, plan.transfers, transferMatches)

  const expectedBalances = new Map(plan.accounts.map((value) => [value.id, { debits: 0n, credits: 0n }]))
  for (const value of plan.transfers) {
    expectedBalances.get(value.debit_account_id)!.debits += value.amount
    expectedBalances.get(value.credit_account_id)!.credits += value.amount
  }
  for (const value of actualAccounts) {
    const balance = expectedBalances.get(value.id)!
    if (
      value.debits_pending !== 0n ||
      value.credits_pending !== 0n ||
      value.debits_posted !== balance.debits ||
      value.credits_posted !== balance.credits
    ) {
      throw new Error(`account ${value.id} balance does not reconcile exactly`)
    }
  }
}

const request = <A>(client: Client, operation: string, execute: () => Promise<A>): Effect.Effect<A, OperationalError> =>
  Effect.tryPromise({
    try: execute,
    catch: (cause) => operationalError('journal', operation, `TigerBeetle ${operation} failed`, cause),
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => client.destroy())))

const validate = <A>(operation: string, evaluate: () => A): Effect.Effect<A, OperationalError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => operationalError('journal', operation, `TigerBeetle ${operation} failed`, cause),
  })

const createAndVerifyAccounts = (client: Client, accounts: readonly Account[]): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const results = yield* request(client, 'create-accounts', () => client.createAccounts([...accounts]))
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

    const existing = yield* request(client, 'lookup-existing-accounts', () => client.lookupAccounts(existingIds))
    const expected = accounts.filter((value) => existingIds.includes(value.id))
    yield* validate('verify-existing-accounts', () =>
      assertUniqueExact('existing account', existing, expected, accountMetadataMatches),
    )
  })

const createAndVerifyTransfers = (
  client: Client,
  transfers: readonly Transfer[],
): Effect.Effect<void, OperationalError> =>
  Effect.gen(function* () {
    const results = yield* request(client, 'create-transfers', () => client.createTransfers([...transfers]))
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

    const existing = yield* request(client, 'lookup-existing-transfers', () => client.lookupTransfers(existingIds))
    const expected = transfers.filter((value) => existingIds.includes(value.id))
    yield* validate('verify-existing-transfers', () =>
      assertUniqueExact('existing transfer', existing, expected, transferMatches),
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

const journalAndReconcile = (
  client: Client,
  ledger: number,
  result: EvaluationResult,
): Effect.Effect<ReconciliationResult, OperationalError> =>
  Effect.gen(function* () {
    const plan = yield* validate('build-plan', () => buildLedgerPlan(result, ledger))
    yield* createAndVerifyAccounts(client, plan.accounts)
    yield* createAndVerifyTransfers(client, plan.transfers)
    const accountQuery = { ...queryFilter(ledger), user_data_128: plan.runKey, limit: plan.accounts.length + 1 }
    const transferQuery = { ...queryFilter(ledger), user_data_64: plan.runTag, limit: plan.transfers.length + 1 }
    const [accounts, transfers] = yield* Effect.all(
      [
        request(client, 'query-accounts', () => client.queryAccounts(accountQuery)),
        request(client, 'query-transfers', () => client.queryTransfers(transferQuery)),
      ],
      { concurrency: 'unbounded' },
    )
    yield* validate('reconcile', () => assertReconciled(plan, accounts, transfers))
    return { runId: result.runId, accountCount: accounts.length, transferCount: transfers.length, exact: true }
  })

export interface JournalDependencies {
  readonly createClient: typeof createClient
  readonly resolveReplicaAddresses: (
    configuredAddresses: readonly string[],
  ) => Effect.Effect<string[], OperationalError>
}

const defaultDependencies: JournalDependencies = { createClient, resolveReplicaAddresses }

export const JournalLive = (
  config: RuntimeConfig,
  dependencies: JournalDependencies = defaultDependencies,
): Layer.Layer<Journal, OperationalError> =>
  Layer.effect(
    Journal,
    Effect.acquireRelease(
      dependencies.resolveReplicaAddresses(config.tigerBeetle.replicaAddresses).pipe(
        Effect.flatMap((replicaAddresses) =>
          Effect.try({
            try: () =>
              dependencies.createClient({
                cluster_id: config.tigerBeetle.clusterId,
                replica_addresses: replicaAddresses,
              }),
            catch: (cause) => operationalError('journal', 'connect', 'failed to create TigerBeetle client', cause),
          }),
        ),
        Effect.timeoutOrElse({
          duration: config.operationTimeoutMs,
          orElse: () =>
            Effect.fail(
              operationalError(
                'journal',
                'connect',
                `TigerBeetle client creation timed out after ${config.operationTimeoutMs}ms`,
              ),
            ),
        }),
      ),
      (client) =>
        Effect.try({
          try: () => client.destroy(),
          catch: (cause) => operationalError('journal', 'close', 'failed to close TigerBeetle client', cause),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning('TigerBeetle client close failed').pipe(
              Effect.annotateLogs({ component: error.component, operation: error.operation, error: error.message }),
            ),
          ),
        ),
    ).pipe(
      Effect.map((client) => ({
        check: request(client, 'connectivity-check', () =>
          client.lookupAccounts([stableU128('bayn-connectivity-probe')]),
        ).pipe(Effect.asVoid),
        journalAndReconcile: (result) => journalAndReconcile(client, config.tigerBeetle.ledger, result),
      })),
    ),
  )
