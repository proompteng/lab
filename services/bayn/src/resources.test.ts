import { describe, expect, test } from 'bun:test'

import { createClient as createClickHouseClient, type ClickHouseClient } from '@clickhouse/client'
import { Effect, Layer, Redacted, Ref } from 'effect'
import { createClient as createTigerBeetleClient, type Client } from 'tigerbeetle-node'

import { initialize, type RuntimeState } from './app'
import type { RuntimeConfig } from './config'
import { EvidenceStore, type EvidenceStoreService } from './db/evidence-store'
import { Journal, JournalLive, type JournalService } from './ledger'
import { MarketData, MarketDataLive, type MarketDataService } from './market-data'
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
  runOnStartup: true,
  operationTimeoutMs: 20,
  clickhouse: {
    url: 'http://clickhouse.test:8123',
    username: 'bayn',
    password: Redacted.make('secret'),
    database: 'signal',
    table: 'adjusted_daily_bars_v1',
    datasetVersion: 'fixture-v1',
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
  journalAndReconcile: (evaluation) =>
    Effect.succeed({ runId: evaluation.runId, accountCount: 1, transferCount: 1, exact: true }),
}

const successfulEvidenceStore: EvidenceStoreService = {
  check: Effect.void,
  persist: ({ evaluation }) =>
    Effect.succeed({
      runId: evaluation.runId,
      deduplicated: false,
      artifactCount: 5,
      eventCount: evaluation.events.length,
      gateCount: evaluation.verdict.gates.length,
    }),
}

describe('Bayn resource lifecycle', () => {
  test('closes ClickHouse and TigerBeetle clients exactly once when their scope exits', async () => {
    let clickHouseCloseCount = 0
    let tigerBeetleCloseCount = 0
    const clickHouseClient = {
      close: async () => void (clickHouseCloseCount += 1),
    } as unknown as ClickHouseClient
    const tigerBeetleClient = {
      destroy: () => void (tigerBeetleCloseCount += 1),
    } as unknown as Client

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* MarketData
          yield* Journal
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              MarketDataLive(config, fixtureProtocol.universe, {
                createClient: (() => clickHouseClient) as unknown as typeof createClickHouseClient,
              }),
              JournalLive(config, {
                createClient: (() => tigerBeetleClient) as unknown as typeof createTigerBeetleClient,
                resolveReplicaAddresses: () => Effect.succeed(['3000']),
              }),
            ),
          ),
        ),
      ),
    )

    expect(clickHouseCloseCount).toBe(1)
    expect(tigerBeetleCloseCount).toBe(1)
  })

  test('aborts an in-flight ClickHouse query when the startup deadline expires', async () => {
    let aborted = false
    let closed = false
    const clickHouseClient = {
      query: ({ abort_signal: signal }: { abort_signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('query aborted'))
            },
            { once: true },
          )
        }),
      close: async () => void (closed = true),
    } as unknown as ClickHouseClient
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))

    await Effect.runPromise(
      Effect.scoped(
        initialize(config, state).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
          Effect.provide(
            MarketDataLive(config, fixtureProtocol.universe, {
              createClient: (() => clickHouseClient) as unknown as typeof createClickHouseClient,
            }),
          ),
        ),
      ),
    )

    expect(aborted).toBe(true)
    expect(closed).toBe(true)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAIL_CLOSED',
      error: expect.stringContaining('market-data.load: load timed out'),
    })
  })

  test('fails closed when ClickHouse returns a malformed row', async () => {
    let closed = false
    const clickHouseClient = {
      query: async () => ({ json: async () => [{ symbol: 42 }] }),
      close: async () => void (closed = true),
    } as unknown as ClickHouseClient
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))

    await Effect.runPromise(
      Effect.scoped(
        initialize(config, state).pipe(
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, successfulEvidenceStore),
          Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
          Effect.provide(
            MarketDataLive(config, fixtureProtocol.universe, {
              createClient: (() => clickHouseClient) as unknown as typeof createClickHouseClient,
            }),
          ),
        ),
      ),
    )

    expect(closed).toBe(true)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAIL_CLOSED',
      error: expect.stringContaining('market-data.load'),
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
    const marketData: MarketDataService = { load: Effect.succeed(makeSnapshot()) }
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))

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
      status: 'FAIL_CLOSED',
      error: expect.stringContaining('journal.connectivity-check: connectivity-check timed out'),
    })
  })
})
