import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { NodeServices } from '@effect/platform-node'
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Redacted, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpServer } from 'effect/unstable/http'

import { initialState, initialize, makeHttpLayer, monitor, probe, run, type RuntimeState } from './app'
import type { RuntimeConfig } from './config'
import {
  DatabaseError,
  EvidenceStore,
  EvidenceStoreRuntimeLive,
  type EvidenceStoreService,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { operationalError } from './errors'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { evaluateTsmom, identifyTsmomRun, summarizeEvaluation } from './strategy'
import { Strategy, TsmomStrategyLayer, type StrategyService } from './strategy-service'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const provenance = makeTestProvenance()
const historicalRunId = '9'.repeat(64)
const historicalEvidence: StoredEvaluationEvidence = {
  protocol: {
    protocolHash: '8'.repeat(64),
    schemaVersion: fixtureProtocol.schemaVersion,
    strategyName: 'tsmom',
    behaviorHash: provenance.strategy.behaviorHash,
    parameterHash: provenance.strategy.parameterHash,
    parameters: fixtureProtocol,
  },
  run: {
    runId: historicalRunId,
    protocolHash: '8'.repeat(64),
    snapshotId: '7'.repeat(64),
    evaluationSchemaVersion: 'bayn.evaluation.v2',
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyName: 'tsmom',
    initialCapitalMicros: '1000000000000',
    artifactCount: 0,
    eventCount: 0,
    gateCount: 0,
  },
  artifacts: [],
  events: [],
  gates: [],
  statuses: [],
}

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
  operationTimeoutMs: 250,
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
    Effect.succeed({
      runId: evaluation.runId,
      accountCount: evaluation.inputManifest.symbols.length + 5,
      transferCount: evaluation.events.length,
      exact: true,
    }),
}

const marketDataService = (load: MarketDataService['load']): MarketDataService => ({
  check: Effect.sync(() => makeSnapshot().manifest.finalizedSnapshot),
  load,
})

const successfulEvidenceStore: EvidenceStoreService = {
  check: Effect.void,
  read: (runId) => Effect.succeed(runId === historicalRunId ? Option.some(historicalEvidence) : Option.none()),
  readArtifactItems: () => Effect.succeed(Option.none()),
  recover: () => Effect.succeed(Option.none()),
  persist: ({ evaluation }) =>
    Effect.succeed({
      runId: evaluation.runId,
      deduplicated: false,
      artifactCount: 17,
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

const unusedPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('test server did not bind a TCP port'))
        return
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
    })
  })

const waitForStatus = async (port: number, expectedStatus: string) => {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetchJson(port, '/v1/status')
      const operational = response.body.operational as { readonly status?: string } | undefined
      if (operational?.status === expectedStatus) return response
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(20)
  }
  throw new Error(`Bayn did not reach ${expectedStatus}`, { cause: lastError })
}

const readyState = (): RuntimeState => {
  const snapshot = makeSnapshot()
  const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
  return {
    status: 'READY',
    evidence: {
      startupMode: 'evaluated',
      provenance,
      evaluation: summarizeEvaluation(evaluation),
      reconciliation: {
        runId: evaluation.runId,
        accountCount: 13,
        transferCount: evaluation.events.length,
        exact: true,
      },
      persistence: {
        runId: evaluation.runId,
        deduplicated: false,
        artifactCount: 17,
        eventCount: evaluation.events.length,
        gateCount: evaluation.verdict.gates.length,
      },
    },
    health: {
      sequence: 1,
      checkedAt: '2026-07-20T00:00:00.000Z',
      dependencies: {
        postgresql: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        signal: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        tigerBeetle: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        evidence: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
      },
    },
    error: null,
  }
}

const recoveringStore = (state: RuntimeState): EvidenceStoreService => {
  if (state.evidence === null) throw new Error('test state must contain evidence')
  return {
    ...successfulEvidenceStore,
    recover: () =>
      Effect.succeed(
        Option.some({
          evaluation: state.evidence!.evaluation,
          reconciliation: state.evidence!.reconciliation,
          persistence: { ...state.evidence!.persistence, deduplicated: true },
        }),
      ),
    persist: () => Effect.die(new Error('health probes must not persist')),
  }
}

describe('Bayn HTTP probes', () => {
  test('serves every route from the current runtime state and closes its socket', async () => {
    let port = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(initialState())
          const context = yield* Layer.build(
            makeHttpLayer(
              { host: '127.0.0.1', operationTimeoutMs: 250, port: 0 },
              state,
              provenance,
              'embedded',
              successfulEvidenceStore,
            ),
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
              operational: { status: 'READY', ready: true, probeSequence: 1 },
              authority: { maximum: 'observe', brokerOrders: false, capitalPromotion: false },
              build: { sourceRevision: provenance.sourceRevision, verification: 'embedded' },
              data: { status: 'CURRENT' },
              evidence: { status: 'CURRENT' },
              economic: { status: 'REJECTED' },
              accounting: { status: 'EXACT' },
            },
          })
          expect(yield* Effect.promise(() => fetchJson(port, `/v1/evaluations/${historicalRunId}`))).toMatchObject({
            status: 200,
            body: { run: { runId: historicalRunId } },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/evaluations/not-a-run'))).toMatchObject({
            status: 400,
            body: { error: 'invalid_run_id' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, `/v1/evaluations/${'f'.repeat(64)}`))).toMatchObject({
            status: 404,
            body: { error: 'evaluation_not_found' },
          })
          yield* Ref.set(state, { ...initialState(), status: 'FAILED', error: 'test failure' })
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 503,
            body: { ready: false, status: 'FAILED' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/status'))).toMatchObject({
            status: 200,
            body: { operational: { status: 'FAILED' }, error: 'test failure' },
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

  test('returns service unavailable when durable evidence cannot be read', async () => {
    const unavailableStore: EvidenceStoreService = {
      ...successfulEvidenceStore,
      read: () =>
        Effect.fail(
          new DatabaseError({
            failure: 'unavailable',
            operation: 'read-evidence',
            message: 'database unavailable',
          }),
        ),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(initialState())
          const context = yield* Layer.build(
            makeHttpLayer(
              { host: '127.0.0.1', operationTimeoutMs: 250, port: 0 },
              state,
              provenance,
              'embedded',
              unavailableStore,
            ),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')

          expect(
            yield* Effect.promise(() => fetchJson(address.port, `/v1/evaluations/${historicalRunId}`)),
          ).toMatchObject({ status: 503, body: { error: 'evidence_unavailable' } })
        }),
      ),
    )
  })
})

describe('Bayn continuous health', () => {
  test('degrades on a probe defect, preserves evidence, and recovers only after a complete success', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    let signalAvailable = false
    let accountingChecks = 0
    const marketData: MarketDataService = {
      check: Effect.suspend(() =>
        signalAvailable
          ? Effect.succeed(makeSnapshot().manifest.finalizedSnapshot)
          : Effect.die(new Error('Signal connection defect')),
      ),
      load: Effect.die(new Error('health probes must not load bars')),
    }
    const journal: JournalService = {
      check: Effect.die(new Error('a durable run must use checkRun')),
      checkRun: () => Effect.sync(() => void (accountingChecks += 1)),
      journalAndReconcile: () => Effect.die(new Error('health probes must not write TigerBeetle')),
    }
    const dependencies = (effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore>) =>
      effect.pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
      )

    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      evidence: { evaluation: { runId: initial.evidence!.evaluation.runId } },
      health: {
        sequence: 2,
        dependencies: {
          postgresql: { status: 'AVAILABLE' },
          signal: { status: 'UNAVAILABLE', error: 'Signal connection defect' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })

    signalAvailable = true
    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'READY',
      error: null,
      health: {
        sequence: 3,
        dependencies: {
          postgresql: { status: 'AVAILABLE' },
          signal: { status: 'AVAILABLE' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })
    expect(accountingChecks).toBe(2)
  })

  test('runs immediately and then on the configured Effect schedule', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    let checks = 0
    const marketData: MarketDataService = {
      check: Effect.sync(() => {
        checks += 1
        return makeSnapshot().manifest.finalizedSnapshot
      }),
      load: Effect.die(new Error('health monitor must not load bars')),
    }
    const journal: JournalService = { ...successfulJournal, checkRun: () => Effect.void }
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* monitor({ ...config, healthIntervalMs: 100 }, state).pipe(
          Effect.provideService(MarketData, marketData),
          Effect.provideService(Journal, journal),
          Effect.provideService(EvidenceStore, recoveringStore(initial)),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        expect(checks).toBe(1)
        yield* TestClock.adjust(99)
        expect(checks).toBe(1)
        yield* TestClock.adjust(1)
        expect(checks).toBe(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('interrupts an in-flight probe when its scope closes', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    let interrupted = false
    const marketData: MarketDataService = {
      check: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
      load: Effect.die(new Error('health monitor must not load bars')),
    }
    const fiber = Effect.runFork(
      monitor(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
      ),
    )
    await Bun.sleep(10)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(interrupted).toBe(true)
  })
})

describe('Bayn startup lifecycle', () => {
  test('recovers a complete run without evaluating, journaling, or persisting again', async () => {
    const snapshot = makeSnapshot()
    const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    let evaluations = 0
    let journalWrites = 0
    let persistenceWrites = 0
    const strategy: StrategyService = {
      name: 'tsmom',
      universe: fixtureProtocol.universe,
      parameters: fixtureProtocol,
      provenance,
      identify: () => evaluation.runId,
      evaluate: () => {
        evaluations += 1
        return evaluation
      },
    }
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        journalWrites += 1
        return Effect.die(new Error('recovered startup must not journal'))
      },
    }
    const store: EvidenceStoreService = {
      ...successfulEvidenceStore,
      recover: () =>
        Effect.succeed(
          Option.some({
            evaluation: summarizeEvaluation(evaluation),
            reconciliation: { runId: evaluation.runId, accountCount: 13, transferCount: 321, exact: true },
            persistence: {
              runId: evaluation.runId,
              deduplicated: true,
              artifactCount: 17,
              eventCount: evaluation.events.length,
              gateCount: evaluation.verdict.gates.length,
            },
          }),
        ),
      persist: () => {
        persistenceWrites += 1
        return Effect.die(new Error('recovered startup must not persist'))
      },
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(snapshot))),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, store),
        Effect.provideService(Strategy, strategy),
      ),
    )

    expect({ evaluations, journalWrites, persistenceWrites }).toEqual({
      evaluations: 0,
      journalWrites: 0,
      persistenceWrites: 0,
    })
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'STARTING',
      evidence: {
        startupMode: 'recovered',
        evaluation: { runId: evaluation.runId },
        persistence: { deduplicated: true },
      },
    })
  })

  test('fails closed instead of re-evaluating a corrupt matching durable run', async () => {
    const snapshot = makeSnapshot()
    let evaluations = 0
    let journalWrites = 0
    const strategy: StrategyService = {
      name: 'tsmom',
      universe: fixtureProtocol.universe,
      parameters: fixtureProtocol,
      provenance,
      identify: (manifest) => identifyTsmomRun(manifest, fixtureProtocol, provenance),
      evaluate: () => {
        evaluations += 1
        throw new Error('corrupt recovery must not fall back to evaluation')
      },
    }
    const store: EvidenceStoreService = {
      ...successfulEvidenceStore,
      recover: () =>
        Effect.fail(
          new DatabaseError({
            failure: 'invariant',
            operation: 'recover-evidence',
            message: 'stored artifact hash diverged',
          }),
        ),
    }
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        journalWrites += 1
        return Effect.die(new Error('corrupt recovery must not journal'))
      },
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(snapshot))),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, store),
        Effect.provideService(Strategy, strategy),
      ),
    )

    expect({ evaluations, journalWrites }).toEqual({ evaluations: 0, journalWrites: 0 })
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('database.recover-evaluation'),
    })
  })

  test('evaluates through the provided strategy capability', async () => {
    let calls = 0
    const snapshot = makeSnapshot()
    const state = await Effect.runPromise(Ref.make(initialState()))
    const strategy: StrategyService = {
      name: 'test-strategy',
      universe: fixtureProtocol.universe,
      parameters: fixtureProtocol,
      provenance,
      identify: (manifest) => identifyTsmomRun(manifest, fixtureProtocol, provenance),
      evaluate: (bars, manifest) => {
        calls += 1
        return evaluateTsmom(bars, manifest, fixtureProtocol, provenance)
      },
    }

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(snapshot))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provideService(Strategy, strategy),
      ),
    )

    expect(calls).toBe(1)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'STARTING' })
  })

  test('records durable evaluation and reconciliation before health opens readiness', async () => {
    const snapshot = makeSnapshot()
    const state = await Effect.runPromise(Ref.make(initialState()))
    const marketData = marketDataService(Effect.succeed(snapshot))

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    const current = await Effect.runPromise(Ref.get(state))
    expect(current.status).toBe('STARTING')
    if (current.evidence !== null) {
      expect(current.evidence.reconciliation.exact).toBe(true)
      expect(current.evidence.evaluation.eventCount).toBeGreaterThan(0)
    }
  })

  test('turns strategy exceptions into an operational failure', async () => {
    const state = await Effect.runPromise(Ref.make(initialState()))
    const marketData = marketDataService(Effect.succeed(makeSnapshot(700)))

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('strategy.evaluate'),
    })
  })

  test('interrupts a stalled dependency and fails closed within the configured deadline', async () => {
    let interrupted = false
    const state = await Effect.runPromise(Ref.make(initialState()))
    const marketData = marketDataService(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    )

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
      status: 'FAILED',
      error: expect.stringContaining('market-data.load: load timed out'),
    })
  })

  test('propagates an unexpected defect instead of leaving a detached STARTING worker', async () => {
    const marketData = marketDataService(Effect.die(new Error('unexpected startup defect')))
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
    const state = await Effect.runPromise(Ref.make(initialState()))
    const unavailable: EvidenceStoreService = {
      check: Effect.void,
      read: () => Effect.succeed(Option.none()),
      readArtifactItems: () => Effect.succeed(Option.none()),
      recover: () => Effect.succeed(Option.none()),
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
        Effect.provideService(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, unavailable),
        Effect.provide(TsmomStrategyLayer(fixtureProtocol, provenance)),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('database.persist-evaluation'),
    })
  })

  test('keeps HTTP live and readiness closed when database layer setup fails', async () => {
    const port = await unusedPort()
    const unavailableDatabase = {
      ...config,
      port,
      postgres: {
        ...config.postgres,
        tls: true,
        caPath: `/tmp/bayn-missing-ca-${randomUUID()}.crt`,
      },
    }
    const dependencies = Layer.mergeAll(
      Layer.succeed(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
      Layer.succeed(Journal, successfulJournal),
      EvidenceStoreRuntimeLive(unavailableDatabase).pipe(Layer.provide(NodeServices.layer)),
      TsmomStrategyLayer(fixtureProtocol, provenance),
    )
    const fiber = Effect.runFork(run(unavailableDatabase).pipe(Effect.provide(dependencies)))

    try {
      const status = await waitForStatus(port, 'FAILED')
      expect(status).toMatchObject({
        status: 200,
        body: {
          operational: { status: 'FAILED' },
          error: expect.stringContaining('database.health-check'),
        },
      })
      expect(await fetchJson(port, '/livez')).toMatchObject({ status: 200, body: { live: true } })
      expect(await fetchJson(port, '/readyz')).toMatchObject({
        status: 503,
        body: { ready: false, status: 'FAILED' },
      })
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  })
})
