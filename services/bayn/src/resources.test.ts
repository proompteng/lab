import { describe, expect, test } from 'bun:test'

import { Effect, Option, Redacted, Ref } from 'effect'
import { createClient as createTigerBeetleClient, type Client } from 'tigerbeetle-node'

import { initialState, initialize } from './app'
import type { RuntimeConfig } from './config'
import { EvidenceStore, type EvidenceStoreService } from './db/evidence-store'
import { operationalError } from './errors'
import { Journal, JournalLive, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { TsmomStrategyLayer } from './strategy-service'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const provenance = makeTestProvenance()

const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  build: {
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyBehaviorHash: provenance.strategy.behaviorHash,
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
  check: Effect.void,
  checkRun: () => Effect.void,
  journalAndReconcile: (evaluation) =>
    Effect.succeed({ runId: evaluation.runId, accountCount: 1, transferCount: 1, exact: true }),
}

const marketDataService = (load: MarketDataService['load']): MarketDataService => ({
  check: Effect.sync(() => makeSnapshot().manifest.finalizedSnapshot),
  load,
})

const successfulEvidenceStore: EvidenceStoreService = {
  check: Effect.void,
  read: () => Effect.succeed(Option.none()),
  recover: () => Effect.succeed(Option.none()),
  persist: ({ evaluation }) =>
    Effect.succeed({
      runId: evaluation.runId,
      deduplicated: false,
      artifactCount: 12,
      eventCount: evaluation.events.length,
      gateCount: evaluation.verdict.gates.length,
    }),
}

describe('Bayn resource lifecycle', () => {
  test('closes the TigerBeetle client exactly once when its scope exits', async () => {
    let tigerBeetleCloseCount = 0
    const tigerBeetleClient = {
      destroy: () => void (tigerBeetleCloseCount += 1),
    } as unknown as Client

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Journal
        }).pipe(
          Effect.provide(
            JournalLive(config, {
              createClient: (() => tigerBeetleClient) as unknown as typeof createTigerBeetleClient,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(tigerBeetleCloseCount).toBe(1)
  })

  test('interrupts an in-flight market-data read when the startup deadline expires', async () => {
    let interrupted = false
    const marketData = marketDataService(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    )
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      Effect.scoped(
        initialize(config, state).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provideService(MarketData, marketData),
          Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
        ),
      ),
    )

    expect(interrupted).toBe(true)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('market-data.load: load timed out'),
    })
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
        initialize(config, state).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provideService(MarketData, marketData),
          Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
        ),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('market-data.verify'),
    })
  })

  test('destroys TigerBeetle to cancel its indefinite retry when the startup deadline expires', async () => {
    let destroyed = false
    let rejectLookup: ((cause: Error) => void) | undefined
    const tigerBeetleClient = {
      lookupAccounts: () =>
        new Promise<never>((_, reject) => {
          rejectLookup = reject
        }),
      destroy: () => {
        if (destroyed) return
        destroyed = true
        rejectLookup?.(new Error('client closed'))
      },
    } as unknown as Client
    const marketData = marketDataService(Effect.succeed(makeSnapshot()))
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      Effect.scoped(
        initialize(config, state).pipe(
          Effect.provideService(MarketData, marketData),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
          Effect.provide(
            JournalLive(config, {
              createClient: (() => tigerBeetleClient) as unknown as typeof createTigerBeetleClient,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      ),
    )

    expect(destroyed).toBe(true)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('journal.connectivity-check: connectivity-check timed out'),
    })
  })
})
