import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

import { type Client, type ClientInitArgs, createClient } from 'tigerbeetle-node'
import { Effect, Option, ScopedRef, Semaphore } from 'effect'

import type { RuntimeConfig } from './config'
import { operationalError, retryableOperationalError, type OperationalError } from './errors'

type ResolveHostname = (hostname: string) => Effect.Effect<readonly string[], OperationalError>

const lookupIpv4: ResolveHostname = (hostname) =>
  Effect.suspend(() => {
    const resolver = new Resolver()
    return Effect.tryPromise({
      try: () => resolver.resolve4(hostname),
      catch: (cause) =>
        retryableOperationalError(
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
    if (ipv4Addresses.length !== 1) {
      return yield* Effect.fail(
        operationalError(
          'journal',
          'resolve-replica-addresses',
          `TigerBeetle replica hostname must resolve to exactly one IPv4 address: ${hostname}`,
        ),
      )
    }
    return [`${ipv4Addresses[0]}:${port}`]
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
      }).pipe(
        Effect.flatMap((resolved) => {
          const addresses = resolved.flat()
          if (new Set(addresses).size !== addresses.length) {
            return Effect.fail(
              operationalError(
                'journal',
                'resolve-replica-addresses',
                'TigerBeetle replica hostnames resolved to duplicate IPv4 addresses',
              ),
            )
          }
          return Effect.succeed(addresses)
        }),
      )

export interface JournalDependencies {
  readonly createClient: (options: ClientInitArgs) => TigerBeetleClient
  readonly resolveReplicaAddresses: (
    configuredAddresses: readonly string[],
  ) => Effect.Effect<string[], OperationalError>
}

export type TigerBeetleClient = Pick<
  Client,
  | 'createAccounts'
  | 'createTransfers'
  | 'lookupAccounts'
  | 'lookupTransfers'
  | 'queryAccounts'
  | 'queryTransfers'
  | 'destroy'
>

const defaultDependencies: JournalDependencies = { createClient, resolveReplicaAddresses }

export interface TigerBeetleRequestClient {
  readonly request: <A>(
    operation: string,
    execute: (client: TigerBeetleClient) => Promise<A>,
  ) => Effect.Effect<A, OperationalError>
}

export const makeTigerBeetleRequestClient = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  dependencies: JournalDependencies = defaultDependencies,
) =>
  Effect.gen(function* () {
    const acquireClient = Effect.acquireRelease(
      dependencies.resolveReplicaAddresses(config.tigerBeetle.replicaAddresses).pipe(
        Effect.flatMap((replicaAddresses) =>
          Effect.try({
            try: () =>
              dependencies.createClient({
                cluster_id: config.tigerBeetle.clusterId,
                replica_addresses: replicaAddresses,
              }),
            catch: (cause) =>
              retryableOperationalError('journal', 'connect', 'failed to create TigerBeetle client', cause),
          }),
        ),
        Effect.timeoutOrElse({
          duration: config.operationTimeoutMs,
          orElse: () =>
            Effect.fail(
              retryableOperationalError(
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
    )
    const clients = yield* ScopedRef.fromAcquire(acquireClient.pipe(Effect.map(Option.some)))
    const clientState = yield* Semaphore.make(1)
    const installClient = ScopedRef.set(clients, acquireClient.pipe(Effect.map(Option.some)))
    const getInstalledClient = ScopedRef.get(clients).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(retryableOperationalError('journal', 'connect', 'TigerBeetle client is unavailable')),
        }),
      ),
    )
    const getClient = ScopedRef.get(clients).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            clientState.withPermit(
              ScopedRef.get(clients).pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () => installClient.pipe(Effect.andThen(getInstalledClient)),
                  }),
                ),
              ),
            ),
        }),
      ),
    )
    const invalidateClient = (active: TigerBeetleClient, trigger: string): Effect.Effect<void> =>
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
    const client: TigerBeetleRequestClient = {
      request: <A>(operation: string, execute: (active: TigerBeetleClient) => Promise<A>) =>
        getClient.pipe(
          Effect.flatMap((active) =>
            Effect.tryPromise({
              try: () => execute(active),
              catch: (cause) =>
                retryableOperationalError('journal', operation, `TigerBeetle ${operation} failed`, cause),
            }).pipe(
              Effect.onInterrupt(() => invalidateClient(active, `interrupted:${operation}`)),
              Effect.catch((error) =>
                invalidateClient(active, `failed:${operation}`).pipe(Effect.andThen(Effect.fail(error))),
              ),
            ),
          ),
        ),
    }
    return client
  })
