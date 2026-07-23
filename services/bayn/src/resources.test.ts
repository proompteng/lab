import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Exit, Option, Redacted, Ref } from 'effect'
import { AuthorizationError, SqlError } from 'effect/unstable/sql/SqlError'

import { initialize } from './app'
import type { RuntimeConfig } from './config'
import { EvidenceStore, type EvidenceStoreService } from './db/evidence-store'
import { operationalError } from './errors'
import { Journal, JournalLive, type JournalService, type TigerBeetleClient } from './ledger'
import { MarketData, marketDataOperationError, type MarketDataService } from './market-data'
import { Authority } from './paper'
import { initialState } from './runtime-state'
import { makeStrategy } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const provenance = makeTestProvenance()
const fixtureStrategy = makeStrategy(fixtureProtocol, provenance)

const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  maximumAuthority: Authority.Observe,
  build: {
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyBehaviorHash: provenance.strategy.behaviorHash,
    strategyParameterHash: provenance.strategy.parameterHash,
    verification: 'embedded',
  },
  healthIntervalMs: 100,
  operationTimeoutMs: 20,
  clickhouse: {
    url: 'http://clickhouse.test:8123',
    username: 'bayn',
    password: Redacted.make('secret'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-07-17',
    calendarVersion: 'fixture-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2018-01-02',
      dataEnd: '2026-07-17',
      lookbackStart: '2018-01-02',
      evaluationStart: '2019-01-02',
      evaluationEnd: '2026-07-17',
    },
  },
  postgres: {
    url: Redacted.make('postgresql://bayn:secret@postgres.test:5432/bayn'),
    tls: false,
    caPath: '/tmp/test-postgres-ca.crt',
  },
  tigerBeetle: { clusterId: 2001n, replicaAddresses: ['3000'], ledger: 7001 },
}

const successfulJournal: JournalService = {
  post: () => Effect.void,
  verifyAccount: () => Effect.succeed(true),
  check: Effect.void,
  checkRun: () => Effect.void,
  journalAndReconcile: (evaluation) =>
    Effect.succeed({ runId: evaluation.runId, accountCount: 1, transferCount: 1, exact: true }),
}

const marketDataService = (load: MarketDataService['load']): MarketDataService => ({
  check: Effect.sync(() => makeSnapshot().manifest.finalizedSnapshot),
  inspect: Effect.sync(() => {
    const snapshot = makeSnapshot()
    return {
      manifest: snapshot.manifest,
      sessionDates: [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort(),
      signalSession: {
        calendar_version: snapshot.manifest.finalizedSnapshot.calendarVersion,
        session_date: snapshot.manifest.lastSession,
        close_time: '16:00',
        timezone: 'America/New_York',
      },
    }
  }),
  inspectPublication: () => Effect.die(new Error('resource lifecycle must not inspect cycle publications')),
  inspectSnapshotPublication: () =>
    Effect.die(new Error('resource lifecycle must not inspect bound cycle publications')),
  load,
})

const successfulEvidenceStore: EvidenceStoreService = {
  check: Effect.void,
  read: () => Effect.succeed(Option.none()),
  readArtifactItems: () => Effect.succeed(Option.none()),
  recover: () => Effect.succeed(Option.none()),
  listPriorTrials: Effect.succeed([]),
  openQualification: ({ lock }) => Effect.succeed({ state: 'ACQUIRED', lock }),
  readQualification: () => Effect.succeed(Option.none()),
  persist: ({ evaluation }) =>
    Effect.succeed({
      runId: evaluation.runId,
      deduplicated: false,
      artifactCount: 17,
      eventCount: evaluation.events.length,
      gateCount: evaluation.verdict.gates.length,
    }),
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

describe('Bayn resource lifecycle', () => {
  test('closes the TigerBeetle client exactly once when its scope exits', async () => {
    let tigerBeetleCloseCount = 0
    const tigerBeetleClient = makeTigerBeetleClient({
      destroy: () => void (tigerBeetleCloseCount += 1),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Journal
        }).pipe(
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
    const clients = [
      makeTigerBeetleClient({
        lookupAccounts: async () => {
          throw new Error('Client was closed.')
        },
        destroy: () => void (closeCounts[0] += 1),
      }),
      makeTigerBeetleClient({
        lookupAccounts: async () => [],
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
              orElse: () => Effect.fail(new Error('paired TigerBeetle queries were serialized')),
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
    let rejectLookup: ((cause: Error) => void) | undefined
    const interruptedClient = makeTigerBeetleClient({
      lookupAccounts: () =>
        new Promise<never>((_, reject) => {
          rejectLookup = reject
        }),
      destroy: () => {
        closeCounts[0] += 1
        rejectLookup?.(new Error('client closed'))
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

    const replacementError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* Journal
          yield* journal.check.pipe(Effect.timeout(5), Effect.ignore)
          acquisitionsAfterInterrupt = clientAcquisitions
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

    expect(acquisitionsAfterInterrupt).toBe(1)
    expect(clientAcquisitions).toBe(3)
    expect(closeCounts).toEqual([1, 1])
    expect(replacementError.message).toContain('replacement unavailable')
  })

  test('interrupts an in-flight market-data read when the startup deadline expires', async () => {
    let interrupted = false
    const marketData = marketDataService(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    )
    const state = await Effect.runPromise(Ref.make(initialState()))

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        initialize(config, state, fixtureStrategy).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provideService(MarketData, marketData),
        ),
      ),
    )

    expect(interrupted).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('load timed out')
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'STARTING', error: null })
  })

  test('fails closed when ClickHouse returns a malformed row', async () => {
    const marketData = marketDataService(
      Effect.fail(
        operationalError('market-data', 'verify', 'Signal snapshot verification failed', new Error('malformed row')),
      ),
    )
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      Effect.scoped(
        initialize(config, state, fixtureStrategy).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provideService(MarketData, marketData),
        ),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('market-data.verify'),
    })
  })

  test('keeps ClickHouse authorization failures observable as terminal startup failures', async () => {
    const authorization = new SqlError({
      reason: new AuthorizationError({ cause: new Error('SELECT denied'), operation: 'query' }),
    })
    const marketData = marketDataService(
      Effect.fail(marketDataOperationError('load', 'failed to load finalized Signal snapshot', authorization)),
    )
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      Effect.scoped(
        initialize(config, state, fixtureStrategy).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provideService(MarketData, marketData),
        ),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('market-data.load'),
    })
  })

  test('destroys TigerBeetle to cancel its indefinite retry when the startup deadline expires', async () => {
    let destroyed = false
    let rejectLookup: ((cause: Error) => void) | undefined
    const tigerBeetleClient = makeTigerBeetleClient({
      lookupAccounts: () =>
        new Promise<never>((_, reject) => {
          rejectLookup = reject
        }),
      destroy: () => {
        if (destroyed) return
        destroyed = true
        rejectLookup?.(new Error('client closed'))
      },
    })
    const marketData = marketDataService(Effect.succeed(makeSnapshot()))
    const state = await Effect.runPromise(Ref.make(initialState()))

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        initialize(config, state, fixtureStrategy).pipe(
          Effect.provideService(MarketData, marketData),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provide(
            JournalLive(config, {
              createClient: () => tigerBeetleClient,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(destroyed).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('connectivity-check timed out')
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'STARTING', error: null })
  })
})
