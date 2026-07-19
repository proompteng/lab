import { Context, Effect, Layer } from 'effect'
import {
  CreateAccountStatus,
  CreateTransferStatus,
  createClient,
  type Account,
  type Client,
  type CreateAccountResult,
  type CreateTransferResult,
  type Transfer,
} from 'tigerbeetle-node'

import {
  TigerBeetleConfigurationError,
  TigerBeetleConnectionError,
  TigerBeetleCreateError,
  TigerBeetleDuplicateConflictError,
  TigerBeetleRequestError,
} from './errors'
import { MAX_U128 } from './model'

export type TigerBeetleServiceError =
  | TigerBeetleRequestError
  | TigerBeetleCreateError
  | TigerBeetleDuplicateConflictError

export interface TigerBeetleWriteSummary {
  readonly created: number
  readonly existing: number
}

export interface TigerBeetleClientShape {
  readonly ensureAccounts: (
    accounts: readonly Account[],
  ) => Effect.Effect<TigerBeetleWriteSummary, TigerBeetleServiceError>
  readonly ensureTransfers: (
    transfers: readonly Transfer[],
  ) => Effect.Effect<TigerBeetleWriteSummary, TigerBeetleServiceError>
  readonly lookupAccounts: (ids: readonly bigint[]) => Effect.Effect<readonly Account[], TigerBeetleRequestError>
  readonly lookupTransfers: (ids: readonly bigint[]) => Effect.Effect<readonly Transfer[], TigerBeetleRequestError>
}

export class TigerBeetleClient extends Context.Tag('@proompteng/bayn/TigerBeetleClient')<
  TigerBeetleClient,
  TigerBeetleClientShape
>() {}

export interface TigerBeetleClientConfig {
  readonly clusterId: bigint
  readonly replicaAddresses: readonly string[]
}

export type TigerBeetleRawClient = Pick<
  Client,
  'createAccounts' | 'createTransfers' | 'lookupAccounts' | 'lookupTransfers' | 'destroy'
>

export const TIGERBEETLE_MAX_BATCH_SIZE = 8_189

const chunks = <A>(values: readonly A[]): readonly (readonly A[])[] => {
  const output: A[][] = []
  for (let index = 0; index < values.length; index += TIGERBEETLE_MAX_BATCH_SIZE) {
    output.push(values.slice(index, index + TIGERBEETLE_MAX_BATCH_SIZE))
  }
  return output
}

const accountImmutableFields = [
  'id',
  'user_data_128',
  'user_data_64',
  'user_data_32',
  'reserved',
  'ledger',
  'code',
  'flags',
] as const satisfies readonly (keyof Account)[]

const transferImmutableFields = [
  'id',
  'debit_account_id',
  'credit_account_id',
  'amount',
  'pending_id',
  'user_data_128',
  'user_data_64',
  'user_data_32',
  'timeout',
  'ledger',
  'code',
  'flags',
] as const satisfies readonly (keyof Transfer)[]

const valueString = (value: bigint | number): string => value.toString()

const request = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, TigerBeetleRequestError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new TigerBeetleRequestError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })

const resultCountError = (entity: 'account' | 'transfer', expected: number, actual: number) =>
  new TigerBeetleRequestError({
    operation: entity === 'account' ? 'createAccounts' : 'createTransfers',
    message: `TigerBeetle returned ${actual} results for ${expected} ${entity} events`,
    cause: { expected, actual },
  })

const duplicateConflict = (
  entity: 'account' | 'transfer',
  id: bigint,
  field: string,
  expected: bigint | number,
  actual: bigint | number,
) =>
  new TigerBeetleDuplicateConflictError({
    entity,
    id,
    field,
    expected: valueString(expected),
    actual: valueString(actual),
  })

const verifyExistingAccounts = (
  expectedAccounts: readonly Account[],
  actualAccounts: readonly Account[],
): Effect.Effect<void, TigerBeetleDuplicateConflictError> => {
  const actualById = new Map(actualAccounts.map((account) => [account.id, account]))
  for (const expected of expectedAccounts) {
    const actual = actualById.get(expected.id)
    if (actual === undefined) {
      return Effect.fail(duplicateConflict('account', expected.id, 'lookup', 1, 0))
    }
    for (const field of accountImmutableFields) {
      if (actual[field] !== expected[field]) {
        return Effect.fail(duplicateConflict('account', expected.id, field, expected[field], actual[field]))
      }
    }
  }
  return Effect.void
}

const verifyExistingTransfers = (
  expectedTransfers: readonly Transfer[],
  actualTransfers: readonly Transfer[],
): Effect.Effect<void, TigerBeetleDuplicateConflictError> => {
  const actualById = new Map(actualTransfers.map((transfer) => [transfer.id, transfer]))
  for (const expected of expectedTransfers) {
    const actual = actualById.get(expected.id)
    if (actual === undefined) {
      return Effect.fail(duplicateConflict('transfer', expected.id, 'lookup', 1, 0))
    }
    for (const field of transferImmutableFields) {
      if (actual[field] !== expected[field]) {
        return Effect.fail(duplicateConflict('transfer', expected.id, field, expected[field], actual[field]))
      }
    }
  }
  return Effect.void
}

const accountStatusName = (status: CreateAccountStatus): string => CreateAccountStatus[status] ?? String(status)
const transferStatusName = (status: CreateTransferStatus): string => CreateTransferStatus[status] ?? String(status)

const isAccountExistingStatus = (status: CreateAccountStatus): boolean =>
  status === CreateAccountStatus.exists || accountStatusName(status).startsWith('exists_with_different_')

const isTransferExistingStatus = (status: CreateTransferStatus): boolean =>
  status === CreateTransferStatus.exists || transferStatusName(status).startsWith('exists_with_different_')

const accountWriteSummary = (
  accounts: readonly Account[],
  results: readonly CreateAccountResult[],
): Effect.Effect<TigerBeetleWriteSummary, TigerBeetleCreateError | TigerBeetleRequestError> => {
  if (results.length !== accounts.length) {
    return Effect.fail(resultCountError('account', accounts.length, results.length))
  }
  let created = 0
  let existing = 0
  for (const [index, result] of results.entries()) {
    if (result.status === CreateAccountStatus.created) {
      created += 1
      continue
    }
    if (isAccountExistingStatus(result.status)) {
      existing += 1
      continue
    }
    return Effect.fail(
      new TigerBeetleCreateError({
        entity: 'account',
        index,
        id: accounts[index]!.id,
        status: accountStatusName(result.status),
      }),
    )
  }
  return Effect.succeed({ created, existing })
}

const transferWriteSummary = (
  transfers: readonly Transfer[],
  results: readonly CreateTransferResult[],
): Effect.Effect<TigerBeetleWriteSummary, TigerBeetleCreateError | TigerBeetleRequestError> => {
  if (results.length !== transfers.length) {
    return Effect.fail(resultCountError('transfer', transfers.length, results.length))
  }
  let created = 0
  let existing = 0
  for (const [index, result] of results.entries()) {
    if (result.status === CreateTransferStatus.created) {
      created += 1
      continue
    }
    if (isTransferExistingStatus(result.status)) {
      existing += 1
      continue
    }
    return Effect.fail(
      new TigerBeetleCreateError({
        entity: 'transfer',
        index,
        id: transfers[index]!.id,
        status: transferStatusName(result.status),
      }),
    )
  }
  return Effect.succeed({ created, existing })
}

export const makeTigerBeetleClientService = (rawClient: TigerBeetleRawClient): TigerBeetleClientShape => ({
  ensureAccounts: (accounts) => {
    if (accounts.length === 0) return Effect.succeed({ created: 0, existing: 0 })
    return Effect.gen(function* () {
      let created = 0
      let existingCount = 0
      for (const batch of chunks(accounts)) {
        const results = yield* request('createAccounts', () => rawClient.createAccounts([...batch]))
        const summary = yield* accountWriteSummary(batch, results)
        created += summary.created
        existingCount += summary.existing
        const existing = results.flatMap((result, index) =>
          isAccountExistingStatus(result.status) ? [batch[index]!] : [],
        )
        if (existing.length > 0) {
          const actual = yield* request('lookupAccounts', () => rawClient.lookupAccounts(existing.map(({ id }) => id)))
          yield* verifyExistingAccounts(existing, actual)
        }
      }
      return { created, existing: existingCount }
    })
  },
  ensureTransfers: (transfers) => {
    if (transfers.length === 0) return Effect.succeed({ created: 0, existing: 0 })
    return Effect.gen(function* () {
      let created = 0
      let existingCount = 0
      for (const batch of chunks(transfers)) {
        const results = yield* request('createTransfers', () => rawClient.createTransfers([...batch]))
        const summary = yield* transferWriteSummary(batch, results)
        created += summary.created
        existingCount += summary.existing
        const existing = results.flatMap((result, index) =>
          isTransferExistingStatus(result.status) ? [batch[index]!] : [],
        )
        if (existing.length > 0) {
          const actual = yield* request('lookupTransfers', () =>
            rawClient.lookupTransfers(existing.map(({ id }) => id)),
          )
          yield* verifyExistingTransfers(existing, actual)
        }
      }
      return { created, existing: existingCount }
    })
  },
  lookupAccounts: (ids) =>
    ids.length === 0
      ? Effect.succeed([])
      : Effect.forEach(chunks(ids), (batch) => request('lookupAccounts', () => rawClient.lookupAccounts([...batch])), {
          concurrency: 1,
        }).pipe(Effect.map((batches) => batches.flat())),
  lookupTransfers: (ids) =>
    ids.length === 0
      ? Effect.succeed([])
      : Effect.forEach(
          chunks(ids),
          (batch) => request('lookupTransfers', () => rawClient.lookupTransfers([...batch])),
          { concurrency: 1 },
        ).pipe(Effect.map((batches) => batches.flat())),
})

const validateConfig = (config: TigerBeetleClientConfig): TigerBeetleConfigurationError | undefined => {
  if (typeof config.clusterId !== 'bigint' || config.clusterId < 0n || config.clusterId > MAX_U128) {
    return new TigerBeetleConfigurationError({ message: 'TigerBeetle clusterId must be an unsigned u128 value' })
  }
  if (
    !Array.isArray(config.replicaAddresses) ||
    config.replicaAddresses.length === 0 ||
    config.replicaAddresses.some((address) => typeof address !== 'string' || address.trim().length === 0)
  ) {
    return new TigerBeetleConfigurationError({
      message: 'TigerBeetle replicaAddresses must contain at least one non-empty address',
    })
  }
  return undefined
}

export const makeTigerBeetleClientLayer = (
  config: TigerBeetleClientConfig,
): Layer.Layer<TigerBeetleClient, TigerBeetleConfigurationError | TigerBeetleConnectionError> => {
  const configurationError = validateConfig(config)
  if (configurationError !== undefined) {
    return Layer.fail(configurationError)
  }
  return Layer.scoped(
    TigerBeetleClient,
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          createClient({
            cluster_id: config.clusterId,
            replica_addresses: [...config.replicaAddresses],
          }),
        catch: (cause) =>
          new TigerBeetleConnectionError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
      (client) => Effect.sync(() => client.destroy()),
    ).pipe(Effect.map(makeTigerBeetleClientService)),
  )
}

export const makeTigerBeetleTestLayer = (rawClient: TigerBeetleRawClient): Layer.Layer<TigerBeetleClient> =>
  Layer.succeed(TigerBeetleClient, makeTigerBeetleClientService(rawClient))
