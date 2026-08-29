import { describe, expect, test } from 'bun:test'

import { Data, Deferred, Effect, Exit, Fiber, Layer, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { AlpacaBrokerResourcesLive } from './broker/alpaca/composition'
import { BrokerProvider, BrokerSession, decodeBrokerConnection, type BrokerConnection } from './broker/alpaca'
import { AlpacaHttpClient } from './broker/alpaca/http'
import { BrokerEnvironment } from './broker/identity'
import type { RuntimeConfig } from './config'
import { Journal, JournalLive, type TigerBeetleClient } from './ledger'
import { config as fixtureConfig } from './testing/runtime-fixtures'
import {
  parseReplicaEndpoints,
  resolveReplicaAddresses,
  validateResolvedReplicaAddresses,
  validateResolvedReplicaEndpoint,
  type ReplicaAddressValidationError,
} from './tigerbeetle-client'

class TestFailure extends Data.TaggedError('TestFailure')<{ readonly message: string }> {}

const config: RuntimeConfig = {
  ...fixtureConfig,
  operationTimeoutMs: 20,
}

const makeTigerBeetleClient = (overrides: Partial<TigerBeetleClient> = {}): TigerBeetleClient => ({
  createAccounts: async () => [],
  createTransfers: async () => [],
  lookupAccounts: async () => [],
  lookupTransfers: async () => [],
  queryAccounts: async () => [],
  queryTransfers: async () => [],
  destroy: () => undefined,
  ...overrides,
})

const resultSuccess = <A>(decision: Result.Result<A, ReplicaAddressValidationError>): A => {
  expect(Result.isSuccess(decision)).toBeTrue()
  if (Result.isFailure(decision)) throw decision.failure
  return decision.success
}

const resultFailure = <A>(decision: Result.Result<A, ReplicaAddressValidationError>): ReplicaAddressValidationError => {
  expect(Result.isFailure(decision)).toBeTrue()
  if (Result.isSuccess(decision)) throw new Error('replica address decision unexpectedly succeeded')
  return decision.failure
}

describe('TigerBeetle replica address decisions', () => {
  test('parses configured endpoints synchronously while preserving request order', () => {
    expect(
      resultSuccess(parseReplicaEndpoints([' 3000 ', '127.0.0.1', '127.0.0.2:3001', 'replica-0.test:3002'])),
    ).toEqual([
      { _tag: 'DirectReplicaAddress', configuredAddress: ' 3000 ', address: '3000' },
      { _tag: 'DirectReplicaAddress', configuredAddress: '127.0.0.1', address: '127.0.0.1' },
      { _tag: 'DirectReplicaAddress', configuredAddress: '127.0.0.2:3001', address: '127.0.0.2:3001' },
      {
        _tag: 'ReplicaHostname',
        configuredAddress: 'replica-0.test:3002',
        hostname: 'replica-0.test',
        port: 3002,
      },
    ])

    for (const [configuredAddresses, reason] of [
      [[], 'empty-addresses'],
      [['missing-port'], 'invalid-address'],
      [['replica.test:not-a-port'], 'invalid-address'],
      [['replica.test:70000'], 'invalid-port'],
      [['::1'], 'ipv6-unsupported'],
    ] as const) {
      expect(resultFailure(parseReplicaEndpoints(configuredAddresses))).toMatchObject({ reason })
    }
  })

  test('validates DNS answers and the final exact address set synchronously', () => {
    const [endpoint] = resultSuccess(parseReplicaEndpoints(['replica-0.test:3000']))
    expect(resultSuccess(validateResolvedReplicaEndpoint(endpoint, ['::1', '10.0.0.1', 'not-an-address']))).toBe(
      '10.0.0.1:3000',
    )
    expect(resultFailure(validateResolvedReplicaEndpoint(endpoint, ['::1']))).toMatchObject({
      reason: 'no-ipv4-address',
    })
    expect(resultFailure(validateResolvedReplicaEndpoint(endpoint, ['10.0.0.1', '10.0.0.2']))).toMatchObject({
      reason: 'multiple-ipv4-addresses',
    })
    expect(resultSuccess(validateResolvedReplicaAddresses(['10.0.0.1:3000', '10.0.0.2:3000']))).toEqual([
      '10.0.0.1:3000',
      '10.0.0.2:3000',
    ])
    expect(resultFailure(validateResolvedReplicaAddresses(['10.0.0.1:3000', '10.0.0.1:3000']))).toMatchObject({
      reason: 'duplicate-address',
      material: { duplicateAddress: '10.0.0.1:3000' },
    })
  })

  test('preflights every endpoint before DNS and interrupts an in-flight lookup', async () => {
    let lookups = 0
    const invalidExit = await Effect.runPromiseExit(
      resolveReplicaAddresses(['replica-0.test:3000', 'missing-port'], () => {
        lookups += 1
        return Effect.succeed(['10.0.0.1'])
      }),
    )
    expect(Exit.isFailure(invalidExit)).toBeTrue()
    expect(lookups).toBe(0)

    let interrupted = false
    const interruptedExit = await Effect.runPromiseExit(
      resolveReplicaAddresses(['replica-0.test:3000'], () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
      ).pipe(Effect.timeout(5)),
    )
    expect(Exit.isFailure(interruptedExit)).toBeTrue()
    expect(interrupted).toBeTrue()
  })
})

describe('Bayn resource lifecycle', () => {
  test('shares one Alpaca HTTP client between the session and mutation capability and finalizes it once', async () => {
    const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
    const connectionResult = decodeBrokerConnection({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: 'https://paper-api.alpaca.markets',
      expectedAccountId: accountId,
      key: Redacted.make('paper-key'),
      secret: Redacted.make('paper-secret'),
      proxyUrl: 'http://bayn-egress-proxy:3128',
      operationTimeoutMs: 1_000,
      retryAttempts: 0,
    })
    const connection = Result.getOrThrow(connectionResult) as BrokerConnection
    let acquisitions = 0
    let finalizations = 0
    const responseHeaders = {
      'content-type': 'application/json',
      'x-request-id': 'resource-lifecycle',
      'x-ratelimit-limit': '200',
      'x-ratelimit-remaining': '199',
      'x-ratelimit-reset': '1784664000',
    }
    const accountResponse = {
      id: accountId,
      account_number: '010203ABCD',
      status: 'ACTIVE',
      currency: 'USD',
      cash: '1000',
      equity: '1000',
      last_equity: '1000',
      buying_power: '1000',
      account_blocked: false,
      trading_blocked: false,
      trade_suspended_by_user: false,
      options_buying_power: '0',
    }
    const client = HttpClient.make((request, target) => {
      const url = new URL(target)
      const body =
        url.pathname === '/v2/account'
          ? accountResponse
          : url.pathname === '/v2/account/configurations'
            ? { fractional_trading: true, no_shorting: true, suspend_trade: false }
            : url.pathname === '/v2/orders' ||
                url.pathname === '/v2/positions' ||
                url.pathname === '/v2/account/activities/FILL' ||
                url.pathname === '/v2/calendar'
              ? []
              : { code: 40410000, message: 'order not found' }
      const status =
        url.pathname.startsWith('/v2/orders/') || url.pathname === '/v2/orders:by_client_order_id' ? 404 : 200
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: responseHeaders })),
      )
    })
    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1
          return client
        }),
        () => Effect.sync(() => void (finalizations += 1)),
      ),
    )

    const services = await Effect.runPromise(
      Effect.scoped(
        Effect.all({ session: BrokerSession, httpClient: AlpacaHttpClient }).pipe(
          Effect.provide(AlpacaBrokerResourcesLive(connection, http)),
        ),
      ),
    )

    expect(services.httpClient).toBe(client)
    expect(services.session.read).toBeDefined()
    expect(acquisitions).toBe(1)
    expect(finalizations).toBe(1)
  })

  test('finalizes the shared Alpaca HTTP layer once when session acquisition is interrupted', async () => {
    const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
    const connectionResult = decodeBrokerConnection({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: 'https://paper-api.alpaca.markets',
      expectedAccountId: accountId,
      key: Redacted.make('paper-key'),
      secret: Redacted.make('paper-secret'),
      proxyUrl: 'http://bayn-egress-proxy:3128',
      operationTimeoutMs: 1_000,
      retryAttempts: 0,
    })
    const connection = Result.getOrThrow(connectionResult) as BrokerConnection
    const started = await Effect.runPromise(Deferred.make<void>())
    let acquisitions = 0
    let finalizations = 0
    let requestInterrupted = false
    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            requestInterrupted = true
          }),
        ),
      ),
    )
    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1
          return client
        }),
        () => Effect.sync(() => void (finalizations += 1)),
      ),
    )

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* BrokerSession.pipe(
            Effect.provide(AlpacaBrokerResourcesLive(connection, http)),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBeTrue()
    expect(requestInterrupted).toBeTrue()
    expect(acquisitions).toBe(1)
    expect(finalizations).toBe(1)
  })

  test('closes the TigerBeetle client exactly once when its scope exits', async () => {
    let tigerBeetleCloseCount = 0
    const tigerBeetleClient = makeTigerBeetleClient({
      destroy: () => void (tigerBeetleCloseCount += 1),
    })

    await Effect.runPromise(
      Effect.scoped(
        Journal.pipe(
          Effect.provide(
            JournalLive(config, {
              createClient: () => tigerBeetleClient,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(tigerBeetleCloseCount).toBe(1)
  })

  test('replaces a failed TigerBeetle client so the next probe recovers', async () => {
    const closeCounts = [0, 0]
    const lookupCounts = [0, 0]
    const clients = [
      makeTigerBeetleClient({
        lookupAccounts: async () => {
          lookupCounts[0] += 1
          throw new Error('Client was closed.')
        },
        destroy: () => void (closeCounts[0] += 1),
      }),
      makeTigerBeetleClient({
        lookupAccounts: async () => {
          lookupCounts[1] += 1
          return []
        },
        destroy: () => void (closeCounts[1] += 1),
      }),
    ]
    let clientIndex = 0
    const createClient = (): TigerBeetleClient => {
      const client = clients[clientIndex]
      if (client === undefined) throw new Error('unexpected TigerBeetle client acquisition')
      clientIndex += 1
      return client
    }

    const firstError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* Journal
          const error = yield* Effect.flip(journal.check)
          yield* journal.check
          return error
        }).pipe(
          Effect.provide(
            JournalLive(config, {
              createClient,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(firstError.message).toContain('Client was closed')
    expect(clientIndex).toBe(2)
    expect(lookupCounts).toEqual([1, 1])
    expect(closeCounts).toEqual([1, 1])
  })

  test('runs independent TigerBeetle reconciliation reads concurrently', async () => {
    const gate = Promise.withResolvers<void>()
    let active = 0
    let maximumConcurrency = 0
    const query = async <A>(result: A): Promise<A> => {
      active += 1
      maximumConcurrency = Math.max(maximumConcurrency, active)
      if (maximumConcurrency === 2) gate.resolve()
      await gate.promise
      active -= 1
      return result
    }
    const client = makeTigerBeetleClient({
      queryAccounts: () => query([]),
      queryTransfers: () => query([]),
      destroy: () => undefined,
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* Journal
          yield* journal.checkRun({ runId: 'a'.repeat(64), accountCount: 0, transferCount: 0, exact: true }).pipe(
            Effect.timeoutOrElse({
              duration: 250,
              orElse: () => Effect.fail(new TestFailure({ message: 'paired TigerBeetle queries were serialized' })),
            }),
          )
        }).pipe(
          Effect.provide(
            JournalLive(config, {
              createClient: () => client,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(maximumConcurrency).toBe(2)
  })

  test('invalidates an interrupted TigerBeetle client and defers replacement to the next request', async () => {
    const closeCounts = [0, 0]
    const pendingLookup = Deferred.makeUnsafe<never, TestFailure>()
    const interruptedClient = makeTigerBeetleClient({
      lookupAccounts: () => Effect.runPromise(Deferred.await(pendingLookup)),
      destroy: () => {
        closeCounts[0] += 1
        Effect.runSync(Deferred.fail(pendingLookup, new TestFailure({ message: 'client closed' })))
      },
    })
    const recoveredClient = makeTigerBeetleClient({
      lookupAccounts: async () => [],
      destroy: () => void (closeCounts[1] += 1),
    })
    let clientAcquisitions = 0
    const createClient = (): TigerBeetleClient => {
      clientAcquisitions += 1
      if (clientAcquisitions === 1) return interruptedClient
      if (clientAcquisitions === 2) throw new Error('replacement unavailable')
      if (clientAcquisitions === 3) return recoveredClient
      throw new Error('unexpected TigerBeetle client acquisition')
    }
    let acquisitionsAfterInterrupt = 0
    let acquisitionsAfterReplacementFailure = 0

    const replacementError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* Journal
          yield* journal.check.pipe(Effect.timeout(5), Effect.ignore)
          acquisitionsAfterInterrupt = clientAcquisitions
          const error = yield* Effect.flip(journal.check)
          acquisitionsAfterReplacementFailure = clientAcquisitions
          yield* journal.check
          return error
        }).pipe(
          Effect.provide(
            JournalLive(config, {
              createClient,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(acquisitionsAfterInterrupt).toBe(1)
    expect(acquisitionsAfterReplacementFailure).toBe(2)
    expect(clientAcquisitions).toBe(3)
    expect(closeCounts).toEqual([1, 1])
    expect(replacementError.message).toContain('replacement unavailable')
  })
})
