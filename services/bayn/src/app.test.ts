import { describe, expect, test } from 'bun:test'

import { Cause, Context, Effect, Exit, Layer, Redacted, Ref } from 'effect'
import { HttpServer } from 'effect/unstable/http'

import { initialize, makeHttpLayer, run, type RuntimeState } from './app'
import type { RuntimeConfig } from './config'
import { DatabaseError, EvidenceStore, type EvidenceStoreService } from './db/evidence-store'
import { operationalError } from './errors'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { evaluateTsmom } from './strategy'
import { Strategy, TsmomStrategyLayer, type StrategyService } from './strategy-service'
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
  operationTimeoutMs: 250,
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
    Effect.succeed({
      runId: evaluation.runId,
      accountCount: evaluation.inputManifest.symbols.length + 5,
      transferCount: evaluation.events.length,
      exact: true,
    }),
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

const fetchJson = async (port: number, path: string, method = 'GET') => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method })
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    body: (await response.json()) as Record<string, unknown>,
  }
}

const readyState = (): RuntimeState => {
  const snapshot = makeSnapshot()
  const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
  const { events, ...evaluationWithoutEvents } = evaluation
  return {
    status: 'READY',
    evidence: {
      provenance,
      evaluation: { ...evaluationWithoutEvents, eventCount: events.length },
      reconciliation: { runId: evaluation.runId, accountCount: 13, transferCount: events.length, exact: true },
      persistence: {
        runId: evaluation.runId,
        deduplicated: false,
        artifactCount: 5,
        eventCount: events.length,
        gateCount: evaluation.verdict.gates.length,
      },
    },
    error: null,
  }
}

describe('Bayn HTTP probes', () => {
  test('serves every route from the current runtime state and closes its socket', async () => {
    let port = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
          const context = yield* Layer.build(
            makeHttpLayer({ host: '127.0.0.1', port: 0 }, state, provenance, 'embedded'),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')
          port = address.port

          expect(yield* Effect.promise(() => fetchJson(port, '/livez'))).toEqual({
            status: 200,
            allow: null,
            body: { service: 'bayn', live: true },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 503,
            body: { ready: false, status: 'STARTING' },
          })

          yield* Ref.set(state, readyState())
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 200,
            body: { ready: true, status: 'READY' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/status'))).toMatchObject({
            status: 200,
            body: {
              service: 'bayn',
              status: 'READY',
              authority: { brokerOrders: false, capitalPromotion: false },
              provenanceVerification: 'embedded',
              provenance,
              evidence: { provenance },
            },
          })
          yield* Ref.set(state, { status: 'FAIL_CLOSED', evidence: null, error: 'test failure' })
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 503,
            body: { ready: false, status: 'FAIL_CLOSED' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/status'))).toMatchObject({
            status: 200,
            body: { status: 'FAIL_CLOSED', error: 'test failure' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/evidence/latest'))).toMatchObject({
            status: 404,
            body: { error: 'not_found' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/livez', 'POST'))).toEqual({
            status: 405,
            allow: 'GET',
            body: { error: 'method_not_allowed' },
          })
        }),
      ),
    )

    let rejected = false
    try {
      await fetch(`http://127.0.0.1:${port}/livez`)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})

describe('Bayn startup lifecycle', () => {
  test('evaluates through the provided strategy capability', async () => {
    let calls = 0
    const snapshot = makeSnapshot()
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))
    const strategy: StrategyService = {
      name: 'test-strategy',
      universe: fixtureProtocol.universe,
      parameters: fixtureProtocol,
      provenance,
      evaluate: (bars, manifest) => {
        calls += 1
        return evaluateTsmom(bars, manifest, fixtureProtocol, provenance)
      },
    }

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, { load: Effect.succeed(snapshot) }),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provideService(Strategy, strategy),
      ),
    )

    expect(calls).toBe(1)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'READY' })
  })

  test('transitions from STARTING to READY after evaluation and reconciliation', async () => {
    const snapshot = makeSnapshot()
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))
    const marketData: MarketDataService = { load: Effect.succeed(snapshot) }

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    const current = await Effect.runPromise(Ref.get(state))
    expect(current.status).toBe('READY')
    if (current.status === 'READY') {
      expect(current.evidence.reconciliation.exact).toBe(true)
      expect(current.evidence.evaluation.eventCount).toBeGreaterThan(0)
    }
  })

  test('turns strategy exceptions into an operational FAIL_CLOSED result', async () => {
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))
    const marketData: MarketDataService = { load: Effect.succeed(makeSnapshot(700)) }

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAIL_CLOSED',
      error: expect.stringContaining('strategy.evaluate'),
    })
  })

  test('keeps readiness closed when startup evaluation is explicitly disabled', async () => {
    let journaled = false
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))
    const marketData: MarketDataService = { load: Effect.succeed(makeSnapshot()) }
    const journal: JournalService = {
      check: Effect.void,
      journalAndReconcile: () => {
        journaled = true
        return Effect.die(new Error('journal should not run'))
      },
    }

    await Effect.runPromise(
      initialize({ ...config, runOnStartup: false }, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    expect(journaled).toBe(false)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAIL_CLOSED',
      error: expect.stringContaining('BAYN_RUN_ON_STARTUP=false'),
    })
  })

  test('interrupts a stalled dependency and fails closed within the configured deadline', async () => {
    let interrupted = false
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))
    const marketData: MarketDataService = {
      load: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    }

    await Effect.runPromise(
      initialize({ ...config, operationTimeoutMs: 10 }, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    expect(interrupted).toBe(true)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAIL_CLOSED',
      error: expect.stringContaining('market-data.load: load timed out'),
    })
  })

  test('propagates an unexpected defect instead of leaving a detached STARTING worker', async () => {
    const marketData: MarketDataService = { load: Effect.die(new Error('unexpected startup defect')) }
    const exit = await Effect.runPromiseExit(
      run(config).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
        Effect.timeoutOrElse({
          duration: 250,
          orElse: () =>
            Effect.fail(operationalError('http', 'test', 'run remained alive after its startup worker died')),
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('unexpected startup defect')
      expect(Cause.pretty(exit.cause)).not.toContain('remained alive')
    }
  })

  test('keeps readiness closed when durable evidence cannot be committed', async () => {
    const state = await Effect.runPromise(Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null }))
    const unavailable: EvidenceStoreService = {
      check: Effect.void,
      persist: () =>
        Effect.fail(
          new DatabaseError({
            failure: 'unavailable',
            operation: 'persist',
            message: 'database unavailable',
          }),
        ),
    }

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, { load: Effect.succeed(makeSnapshot()) }),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, unavailable),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAIL_CLOSED',
      evidence: null,
      error: expect.stringContaining('database.persist-evaluation'),
    })
  })
})
