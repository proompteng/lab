import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

import {
  type Client,
  type ClientInitArgs,
  CreateAccountStatus,
  type CreateAccountResult,
  createClient,
  CreateTransferStatus,
  type CreateTransferResult,
} from 'tigerbeetle-node'
import { Data, Effect, Option, Result, Scope, ScopedRef, Semaphore } from 'effect'

import type { RuntimeConfig } from './config'
import { OperationalError, operationalError } from './errors'
import type {
  LedgerAccountRecord,
  LedgerCreateResult,
  LedgerQueryFilter,
  LedgerTransferRecord,
} from './ledger-plan/model'
import { Pipeable } from './pipeable'

type ResolveHostname = (hostname: string) => Effect.Effect<readonly string[], OperationalError>

export type ReplicaAddressValidationReason =
  | 'duplicate-address'
  | 'empty-addresses'
  | 'invalid-address'
  | 'invalid-port'
  | 'ipv6-unsupported'
  | 'multiple-ipv4-addresses'
  | 'no-ipv4-address'

export class ReplicaAddressValidationError extends Data.TaggedError('ReplicaAddressValidationError')<{
  readonly reason: ReplicaAddressValidationReason
  readonly message: string
  readonly material: Readonly<Record<string, unknown>>
}> {}

export class ReplicaAddressOperationalError extends OperationalError {
  readonly validation: ReplicaAddressValidationError

  constructor(validation: ReplicaAddressValidationError) {
    super({
      component: 'journal',
      operation: 'resolve-replica-addresses',
      message: validation.message,
      retryable: false,
      cause: validation,
    })
    this.validation = validation
  }
}

const renderTransportCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export class TigerBeetleTransportError extends OperationalError {
  readonly transportOperation: string

  constructor(operation: string, message: string, cause?: unknown) {
    super({
      component: 'journal',
      operation,
      message: cause === undefined ? message : `${message}: ${renderTransportCause(cause)}`,
      retryable: true,
      cause,
    })
    this.transportOperation = operation
  }
}

export type ReplicaEndpoint =
  | {
      readonly _tag: 'DirectReplicaAddress'
      readonly configuredAddress: string
      readonly address: string
    }
  | {
      readonly _tag: 'ReplicaHostname'
      readonly configuredAddress: string
      readonly hostname: string
      readonly port: number
    }

const failReplicaAddressValidation = (
  reason: ReplicaAddressValidationReason,
  message: string,
  material: Readonly<Record<string, unknown>>,
): Result.Result<never, ReplicaAddressValidationError> =>
  Result.fail(new ReplicaAddressValidationError({ reason, message, material }))

const replicaAddressBoundary = <A>(
  decision: Result.Result<A, ReplicaAddressValidationError>,
): Effect.Effect<A, OperationalError> =>
  Effect.fromResult(decision).pipe(Effect.mapError((validation) => new ReplicaAddressOperationalError(validation)))

const lookupIpv4: ResolveHostname = (hostname) =>
  Effect.suspend(() => {
    const resolver = new Resolver()
    return Effect.tryPromise({
      try: () => resolver.resolve4(hostname),
      catch: (cause) =>
        new TigerBeetleTransportError(
          'resolve-replica-addresses',
          `failed to resolve TigerBeetle hostname ${hostname}`,
          cause,
        ),
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => resolver.cancel())))
  })

const parsePort = (value: string, address: string): Result.Result<number, ReplicaAddressValidationError> => {
  if (!/^\d+$/.test(value)) {
    return failReplicaAddressValidation('invalid-address', `invalid TigerBeetle replica address: ${address}`, {
      address,
      port: value,
    })
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return failReplicaAddressValidation('invalid-port', `invalid TigerBeetle replica port: ${address}`, {
      address,
      port: value,
    })
  }
  return Result.succeed(port)
}

const parseReplicaEndpoint = (
  configuredAddress: string,
): Result.Result<ReplicaEndpoint, ReplicaAddressValidationError> => {
  const address = configuredAddress.trim()
  const addressFamily = isIP(address)
  if (addressFamily === 4) {
    return Result.succeed({ _tag: 'DirectReplicaAddress', configuredAddress, address })
  }
  if (addressFamily === 6) {
    return failReplicaAddressValidation(
      'ipv6-unsupported',
      `IPv6 TigerBeetle replica addresses are not supported: ${address}`,
      { configuredAddress, address },
    )
  }
  if (/^\d+$/.test(address)) {
    return Result.map(parsePort(address, address), () => ({
      _tag: 'DirectReplicaAddress' as const,
      configuredAddress,
      address,
    }))
  }

  const separator = address.lastIndexOf(':')
  if (separator <= 0 || separator !== address.indexOf(':')) {
    return failReplicaAddressValidation(
      'invalid-address',
      `invalid TigerBeetle replica address: ${configuredAddress}`,
      { configuredAddress, address },
    )
  }
  const hostname = address.slice(0, separator)
  const hostnameFamily = isIP(hostname)
  if (hostnameFamily === 6) {
    return failReplicaAddressValidation(
      'ipv6-unsupported',
      `IPv6 TigerBeetle replica addresses are not supported: ${address}`,
      { configuredAddress, address, hostname },
    )
  }
  return Result.map(parsePort(address.slice(separator + 1), address), (port): ReplicaEndpoint => {
    if (hostnameFamily === 4) {
      return {
        _tag: 'DirectReplicaAddress',
        configuredAddress,
        address: `${hostname}:${port}`,
      }
    }
    return { _tag: 'ReplicaHostname', configuredAddress, hostname, port }
  })
}

export const parseReplicaEndpoints = (
  configuredAddresses: readonly string[],
): Result.Result<readonly ReplicaEndpoint[], ReplicaAddressValidationError> =>
  configuredAddresses.length === 0
    ? failReplicaAddressValidation('empty-addresses', 'at least one TigerBeetle replica address is required', {
        configuredAddresses,
      })
    : Result.all(configuredAddresses.map(parseReplicaEndpoint))

const validateResolvedReplicaEndpointDataFirst = (
  endpoint: ReplicaEndpoint,
  resolvedAddresses: readonly string[],
): Result.Result<string, ReplicaAddressValidationError> => {
  if (endpoint._tag === 'DirectReplicaAddress') return Result.succeed(endpoint.address)

  const ipv4Addresses = resolvedAddresses.filter((value) => isIP(value) === 4)
  if (ipv4Addresses.length === 0) {
    return failReplicaAddressValidation(
      'no-ipv4-address',
      `TigerBeetle replica hostname has no IPv4 address: ${endpoint.hostname}`,
      { endpoint, resolvedAddresses },
    )
  }
  if (ipv4Addresses.length !== 1) {
    return failReplicaAddressValidation(
      'multiple-ipv4-addresses',
      `TigerBeetle replica hostname must resolve to exactly one IPv4 address: ${endpoint.hostname}`,
      { endpoint, resolvedAddresses, ipv4Addresses },
    )
  }
  return Result.succeed(`${ipv4Addresses[0]}:${endpoint.port}`)
}

export const validateResolvedReplicaEndpoint = Pipeable.dual(2, validateResolvedReplicaEndpointDataFirst)

export const validateResolvedReplicaAddresses = (
  addresses: readonly string[],
): Result.Result<string[], ReplicaAddressValidationError> => {
  if (addresses.length === 0) {
    return failReplicaAddressValidation('empty-addresses', 'at least one TigerBeetle replica address is required', {
      addresses,
    })
  }
  const duplicateAddress = addresses.find((address, index) => addresses.indexOf(address) !== index)
  if (duplicateAddress !== undefined) {
    return failReplicaAddressValidation(
      'duplicate-address',
      'TigerBeetle replica hostnames resolved to duplicate IPv4 addresses',
      { addresses, duplicateAddress },
    )
  }
  return Result.succeed([...addresses])
}

const resolveReplicaEndpoint = (
  endpoint: ReplicaEndpoint,
  resolveHostname: ResolveHostname,
): Effect.Effect<string, OperationalError> =>
  endpoint._tag === 'DirectReplicaAddress'
    ? replicaAddressBoundary(validateResolvedReplicaEndpoint(endpoint, []))
    : resolveHostname(endpoint.hostname).pipe(
        Effect.flatMap((addresses) => replicaAddressBoundary(validateResolvedReplicaEndpoint(endpoint, addresses))),
      )

const resolveReplicaAddressesDataFirst = (
  configuredAddresses: readonly string[],
  resolveHostname: ResolveHostname = lookupIpv4,
): Effect.Effect<string[], OperationalError> =>
  replicaAddressBoundary(parseReplicaEndpoints(configuredAddresses)).pipe(
    Effect.flatMap((endpoints) =>
      Effect.forEach(endpoints, (endpoint) => resolveReplicaEndpoint(endpoint, resolveHostname), {
        concurrency: 'unbounded',
      }),
    ),
    Effect.flatMap((addresses) => replicaAddressBoundary(validateResolvedReplicaAddresses(addresses))),
  )

export const resolveReplicaAddresses = Pipeable.by<
  (
    resolveHostname?: ResolveHostname,
  ) => (configuredAddresses: readonly string[]) => ReturnType<typeof resolveReplicaAddressesDataFirst>,
  typeof resolveReplicaAddressesDataFirst
>((arguments_) => Array.isArray(arguments_[0]), resolveReplicaAddressesDataFirst)

export interface JournalDependencies {
  readonly createClient: (options: ClientInitArgs) => TigerBeetleClient
  readonly resolveReplicaAddresses: (
    configuredAddresses: readonly string[],
  ) => Effect.Effect<string[], OperationalError>
}

type TigerBeetleNodeClient = Pick<
  Client,
  | 'createAccounts'
  | 'createTransfers'
  | 'lookupAccounts'
  | 'lookupTransfers'
  | 'queryAccounts'
  | 'queryTransfers'
  | 'destroy'
>

export interface TigerBeetleClient {
  readonly createAccounts: (accounts: readonly LedgerAccountRecord[]) => Promise<readonly LedgerCreateResult[]>
  readonly createTransfers: (transfers: readonly LedgerTransferRecord[]) => Promise<readonly LedgerCreateResult[]>
  readonly lookupAccounts: (ids: readonly bigint[]) => Promise<readonly LedgerAccountRecord[]>
  readonly lookupTransfers: (ids: readonly bigint[]) => Promise<readonly LedgerTransferRecord[]>
  readonly queryAccounts: (filter: LedgerQueryFilter) => Promise<readonly LedgerAccountRecord[]>
  readonly queryTransfers: (filter: LedgerQueryFilter) => Promise<readonly LedgerTransferRecord[]>
  readonly destroy: () => void
}

const normalizeCreateResult = (
  result: CreateAccountResult | CreateTransferResult,
  created: number,
  exists: number,
): LedgerCreateResult => ({
  timestamp: result.timestamp,
  outcome: result.status === created ? 'created' : result.status === exists ? 'exists' : 'rejected',
  status: result.status,
})

const adaptTigerBeetleClient = (client: TigerBeetleNodeClient): TigerBeetleClient => ({
  createAccounts: async (accounts) =>
    (await client.createAccounts([...accounts])).map((result) =>
      normalizeCreateResult(result, CreateAccountStatus.created, CreateAccountStatus.exists),
    ),
  createTransfers: async (transfers) =>
    (await client.createTransfers([...transfers])).map((result) =>
      normalizeCreateResult(result, CreateTransferStatus.created, CreateTransferStatus.exists),
    ),
  lookupAccounts: async (ids) => client.lookupAccounts([...ids]),
  lookupTransfers: async (ids) => client.lookupTransfers([...ids]),
  queryAccounts: async (filter) => client.queryAccounts(filter),
  queryTransfers: async (filter) => client.queryTransfers(filter),
  destroy: () => client.destroy(),
})

const defaultDependencies: JournalDependencies = {
  createClient: (options) => adaptTigerBeetleClient(createClient(options)),
  resolveReplicaAddresses,
}

export interface TigerBeetleRequestClient {
  readonly request: <A>(
    operation: string,
    execute: (client: TigerBeetleClient) => Promise<A>,
  ) => Effect.Effect<A, OperationalError>
}

type AcquireTigerBeetleClient = Effect.Effect<TigerBeetleClient, OperationalError, Scope.Scope>
type TigerBeetleClientRef = ScopedRef.ScopedRef<Option.Option<TigerBeetleClient>>

const closeTigerBeetleClient = (client: TigerBeetleClient): Effect.Effect<void> =>
  Effect.try({
    try: () => client.destroy(),
    catch: (cause) =>
      operationalError({
        component: 'journal',
        operation: 'close',
        message: 'failed to close TigerBeetle client',
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning('TigerBeetle client close failed').pipe(
        Effect.annotateLogs({ component: error.component, operation: error.operation, error: error.message }),
      ),
    ),
  )

const connectTigerBeetleClient = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  dependencies: JournalDependencies,
): Effect.Effect<TigerBeetleClient, OperationalError> =>
  dependencies.resolveReplicaAddresses(config.tigerBeetle.replicaAddresses).pipe(
    Effect.flatMap((replicaAddresses) =>
      Effect.try({
        try: () =>
          dependencies.createClient({
            cluster_id: config.tigerBeetle.clusterId,
            replica_addresses: replicaAddresses,
          }),
        catch: (cause) => new TigerBeetleTransportError('connect', 'failed to create TigerBeetle client', cause),
      }),
    ),
    Effect.timeoutOrElse({
      duration: config.operationTimeoutMs,
      orElse: () =>
        Effect.fail(
          new TigerBeetleTransportError(
            'connect',
            `TigerBeetle client creation timed out after ${config.operationTimeoutMs}ms`,
          ),
        ),
    }),
  )

const acquireTigerBeetleClient = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  dependencies: JournalDependencies,
): AcquireTigerBeetleClient =>
  Effect.acquireRelease(connectTigerBeetleClient(config, dependencies), closeTigerBeetleClient)

const requireInstalledTigerBeetleClient = (
  clients: TigerBeetleClientRef,
): Effect.Effect<TigerBeetleClient, OperationalError> =>
  ScopedRef.get(clients).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (client) => Effect.succeed(client),
        onNone: () => Effect.fail(new TigerBeetleTransportError('connect', 'TigerBeetle client is unavailable')),
      }),
    ),
  )

const installMissingTigerBeetleClient = (
  clients: TigerBeetleClientRef,
  acquireClient: AcquireTigerBeetleClient,
): Effect.Effect<TigerBeetleClient, OperationalError> =>
  ScopedRef.get(clients).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (client) => Effect.succeed(client),
        onNone: () =>
          ScopedRef.set(clients, acquireClient.pipe(Effect.map(Option.some))).pipe(
            Effect.andThen(requireInstalledTigerBeetleClient(clients)),
          ),
      }),
    ),
  )

const getTigerBeetleClient = (
  clients: TigerBeetleClientRef,
  clientState: Semaphore.Semaphore,
  acquireClient: AcquireTigerBeetleClient,
): Effect.Effect<TigerBeetleClient, OperationalError> =>
  ScopedRef.get(clients).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (client) => Effect.succeed(client),
        onNone: () => clientState.withPermit(installMissingTigerBeetleClient(clients, acquireClient)),
      }),
    ),
  )

const invalidateTigerBeetleClient = (
  clients: TigerBeetleClientRef,
  clientState: Semaphore.Semaphore,
  active: TigerBeetleClient,
  trigger: string,
): Effect.Effect<void> =>
  clientState
    .withPermitsIfAvailable(1)(
      ScopedRef.get(clients).pipe(
        Effect.flatMap((current) =>
          Option.isSome(current) && current.value === active
            ? ScopedRef.set(clients, Effect.succeed(Option.none<TigerBeetleClient>())).pipe(
                Effect.andThen(
                  Effect.logWarning('TigerBeetle client invalidated').pipe(Effect.annotateLogs({ trigger })),
                ),
              )
            : Effect.void,
        ),
      ),
    )
    .pipe(Effect.asVoid)

const tigerBeetleRequest = <A>(
  getClient: Effect.Effect<TigerBeetleClient, OperationalError>,
  invalidateClient: (active: TigerBeetleClient, trigger: string) => Effect.Effect<void>,
  operation: string,
  execute: (active: TigerBeetleClient) => Promise<A>,
): Effect.Effect<A, OperationalError> =>
  getClient.pipe(
    Effect.flatMap((active) =>
      Effect.tryPromise({
        try: () => execute(active),
        catch: (cause) => new TigerBeetleTransportError(operation, `TigerBeetle ${operation} failed`, cause),
      }).pipe(
        Effect.onInterrupt(() => invalidateClient(active, `interrupted:${operation}`)),
        Effect.tapError(() => invalidateClient(active, `failed:${operation}`)),
      ),
    ),
  )

const makeTigerBeetleRequestClientDataFirst = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  dependencies: JournalDependencies = defaultDependencies,
) =>
  Effect.gen(function* () {
    const acquireClient = acquireTigerBeetleClient(config, dependencies)
    const clients = yield* ScopedRef.fromAcquire(acquireClient.pipe(Effect.map(Option.some)))
    const clientState = yield* Semaphore.make(1)
    const getClient = getTigerBeetleClient(clients, clientState, acquireClient)
    const invalidateClient = (active: TigerBeetleClient, trigger: string) =>
      invalidateTigerBeetleClient(clients, clientState, active, trigger)
    const client: TigerBeetleRequestClient = {
      request: <A>(operation: string, execute: (active: TigerBeetleClient) => Promise<A>) =>
        tigerBeetleRequest(getClient, invalidateClient, operation, execute),
    }
    return client
  })

export const makeTigerBeetleRequestClient = Pipeable.by<
  (
    dependencies?: JournalDependencies,
  ) => (
    config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  ) => ReturnType<typeof makeTigerBeetleRequestClientDataFirst>,
  typeof makeTigerBeetleRequestClientDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'tigerBeetle' in arguments_[0],
  makeTigerBeetleRequestClientDataFirst,
)
