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
  makeEvidenceStoreRuntimeLayer,
  type EvidenceStoreService,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { operationalError } from './errors'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { makeQualificationResult } from './qualification'
import { evaluateTsmom, summarizeEvaluation } from './strategy'
import {
  Strategy,
  TsmomStrategyLayer,
  makeRiskBalancedTrendStrategy,
  makeTsmomStrategy,
  type StrategyService,
} from './strategy-service'
import {
  fixtureProtocol,
  makeRiskBalancedTrendTestProvenance,
  makeSnapshot,
  makeTestProvenance,
  riskBalancedTrendFixtureProtocol,
} from './test-fixtures'

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

const marketDataService = (load: MarketDataService['load'], inspectedSnapshot = makeSnapshot()): MarketDataService => ({
  check: Effect.sync(() => inspectedSnapshot.manifest.finalizedSnapshot),
  inspect: Effect.sync(() => ({
    manifest: inspectedSnapshot.manifest,
    sessionDates: [...new Set(inspectedSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
  })),
  load,
})

const successfulEvidenceStore: EvidenceStoreService = {
  check: Effect.void,
  read: (runId) => Effect.succeed(runId === historicalRunId ? Option.some(historicalEvidence) : Option.none()),
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

const fixtureSnapshot = makeSnapshot()
const fixtureStrategy = makeTsmomStrategy(fixtureProtocol, provenance)
const fixtureEvaluation = fixtureStrategy.evaluate(fixtureSnapshot.bars, fixtureSnapshot.manifest)
const fixtureLock = fixtureStrategy.prepareLock(
  fixtureSnapshot.manifest,
  [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
  [],
)
const fixtureQualification = makeQualificationResult(
  fixtureLock,
  fixtureEvaluation.verdict,
  fixtureStrategy.analyze(fixtureEvaluation, []),
)
const pinnedExecutionProvenance = {
  ...provenance,
  sourceRevision: 'e'.repeat(40),
  image: { repository: provenance.image.repository, digest: `sha256:${'f'.repeat(64)}` },
}
const pinnedStrategy = makeTsmomStrategy(fixtureProtocol, pinnedExecutionProvenance)
const pinnedEvaluation = pinnedStrategy.evaluate(fixtureSnapshot.bars, fixtureSnapshot.manifest)
const pinnedLock = pinnedStrategy.prepareLock(
  fixtureSnapshot.manifest,
  [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
  [],
)
const pinnedQualification = makeQualificationResult(
  pinnedLock,
  pinnedEvaluation.verdict,
  pinnedStrategy.analyze(pinnedEvaluation, []),
)
const pinnedStoredEvidence: StoredEvaluationEvidence = {
  protocol: {
    protocolHash: pinnedEvaluation.protocolHash,
    schemaVersion: fixtureProtocol.schemaVersion,
    strategyName: pinnedExecutionProvenance.strategy.name,
    behaviorHash: pinnedExecutionProvenance.strategy.behaviorHash,
    parameterHash: pinnedExecutionProvenance.strategy.parameterHash,
    parameters: fixtureProtocol,
  },
  run: {
    runId: pinnedEvaluation.runId,
    protocolHash: pinnedEvaluation.protocolHash,
    snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
    evaluationSchemaVersion: 'bayn.evaluation.v4',
    sourceRevision: pinnedExecutionProvenance.sourceRevision,
    imageRepository: pinnedExecutionProvenance.image.repository,
    imageDigest: pinnedExecutionProvenance.image.digest,
    strategyName: pinnedExecutionProvenance.strategy.name,
    initialCapitalMicros: pinnedEvaluation.initialCapitalMicros,
    artifactCount: 17,
    eventCount: pinnedEvaluation.events.length,
    gateCount: pinnedEvaluation.verdict.gates.length,
  },
  artifacts: [],
  events: [],
  gates: [],
  statuses: [],
}
const pinnedRuntimeConfig: RuntimeConfig = {
  ...config,
  qualificationRunId: pinnedEvaluation.runId,
  clickhouse: {
    ...config.clickhouse,
    snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
    publicationAsOf: fixtureSnapshot.manifest.finalizedSnapshot.asOfSession,
    calendarVersion: fixtureSnapshot.manifest.finalizedSnapshot.calendarVersion,
    bounds: fixtureSnapshot.manifest.bounds,
  },
}

const pinnedStore = (): EvidenceStoreService => ({
  ...successfulEvidenceStore,
  read: (runId) => Effect.succeed(runId === pinnedEvaluation.runId ? Option.some(pinnedStoredEvidence) : Option.none()),
  readQualification: (runId) =>
    Effect.succeed(
      runId === pinnedEvaluation.runId
        ? Option.some({ state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification })
        : Option.none(),
    ),
  recover: (runId, recoveredProvenance) =>
    Effect.sync(() => {
      expect(runId).toBe(pinnedEvaluation.runId)
      expect(recoveredProvenance).toEqual(pinnedExecutionProvenance)
      return Option.some({
        evaluation: summarizeEvaluation(pinnedEvaluation),
        reconciliation: {
          runId: pinnedEvaluation.runId,
          accountCount: 13,
          transferCount: pinnedEvaluation.events.length,
          exact: true,
        },
        persistence: {
          runId: pinnedEvaluation.runId,
          deduplicated: true,
          artifactCount: 17,
          eventCount: pinnedEvaluation.events.length,
          gateCount: pinnedEvaluation.verdict.gates.length,
        },
      })
    }),
})

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
  const evaluation = fixtureEvaluation
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
      qualification: fixtureQualification,
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
    readQualification: () =>
      Effect.succeed(Option.some({ state: 'TERMINAL', lock: fixtureLock, result: state.evidence!.qualification })),
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
              qualification: {
                status: 'REJECTED',
                executable: false,
                lockId: fixtureQualification.lockId,
                resultHash: fixtureQualification.resultHash,
                executionProvenance: provenance,
              },
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
      inspect: Effect.die(new Error('health probes must not inspect sessions')),
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
      inspect: Effect.die(new Error('health monitor must not inspect sessions')),
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
      inspect: Effect.die(new Error('health monitor must not inspect sessions')),
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
  test('recovers a pinned terminal qualification without inspecting data or writing state', async () => {
    let forbiddenCalls = 0
    const forbidden = (message: string) =>
      Effect.sync(() => {
        forbiddenCalls += 1
        throw new Error(message)
      })
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(pinnedRuntimeConfig, state).pipe(
        Effect.provideService(MarketData, {
          check: forbidden('pinned startup must not check Signal'),
          inspect: forbidden('pinned startup must not inspect Signal'),
          load: forbidden('pinned startup must not load Signal bars'),
        }),
        Effect.provideService(Journal, {
          check: forbidden('pinned startup must not check TigerBeetle'),
          checkRun: () => forbidden('pinned startup must not check a TigerBeetle run'),
          journalAndReconcile: () => forbidden('pinned startup must not write TigerBeetle'),
        }),
        Effect.provideService(EvidenceStore, {
          ...pinnedStore(),
          check: forbidden('pinned startup must not run a separate database check'),
          listPriorTrials: forbidden('pinned startup must not list or create trials'),
          openQualification: () => forbidden('pinned startup must not open a qualification lock'),
          persist: () => forbidden('pinned startup must not persist evidence'),
        }),
        Effect.provideService(Strategy, fixtureStrategy),
      ),
    )

    expect(forbiddenCalls).toBe(0)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'STARTING',
      evidence: {
        startupMode: 'pinned',
        provenance: pinnedExecutionProvenance,
        evaluation: { runId: pinnedEvaluation.runId },
        qualification: { verdict: 'REJECTED', resultHash: pinnedQualification.resultHash },
      },
    })
  })

  test('rejects a pinned TSMOM qualification under the candidate-composed runtime before dependency mutation', async () => {
    let forbiddenCalls = 0
    const forbidden = (message: string) =>
      Effect.sync(() => {
        forbiddenCalls += 1
        throw new Error(message)
      })
    const state = await Effect.runPromise(Ref.make(initialState()))
    const candidate = makeRiskBalancedTrendStrategy(
      riskBalancedTrendFixtureProtocol,
      makeRiskBalancedTrendTestProvenance(),
    )

    await Effect.runPromise(
      initialize(pinnedRuntimeConfig, state).pipe(
        Effect.provideService(MarketData, {
          check: forbidden('strategy mismatch must not check Signal'),
          inspect: forbidden('strategy mismatch must not inspect Signal'),
          load: forbidden('strategy mismatch must not load Signal bars'),
        }),
        Effect.provideService(Journal, {
          check: forbidden('strategy mismatch must not check TigerBeetle'),
          checkRun: () => forbidden('strategy mismatch must not check a TigerBeetle run'),
          journalAndReconcile: () => forbidden('strategy mismatch must not write TigerBeetle'),
        }),
        Effect.provideService(EvidenceStore, {
          ...pinnedStore(),
          recover: () => forbidden('strategy mismatch must not recover or mutate evidence'),
          check: forbidden('strategy mismatch must not run a separate database check'),
          listPriorTrials: forbidden('strategy mismatch must not list or create trials'),
          openQualification: () => forbidden('strategy mismatch must not open a qualification lock'),
          persist: () => forbidden('strategy mismatch must not persist evidence'),
        }),
        Effect.provideService(Strategy, candidate),
      ),
    )

    expect(forbiddenCalls).toBe(0)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('compiled strategy differs from the pinned qualification protocol'),
    })
  })

  test('fails pinned recovery closed on strategy, snapshot, terminal-result, and durable-evidence drift', async () => {
    const cases = [
      {
        name: 'strategy',
        config: pinnedRuntimeConfig,
        strategy: {
          ...fixtureStrategy,
          provenance: {
            ...fixtureStrategy.provenance,
            strategy: { ...fixtureStrategy.provenance.strategy, behaviorHash: '0'.repeat(64) },
          },
        },
        store: pinnedStore(),
      },
      {
        name: 'snapshot',
        config: {
          ...pinnedRuntimeConfig,
          clickhouse: { ...pinnedRuntimeConfig.clickhouse, snapshotId: '0'.repeat(64) },
        },
        strategy: fixtureStrategy,
        store: pinnedStore(),
      },
      {
        name: 'terminal result',
        config: pinnedRuntimeConfig,
        strategy: fixtureStrategy,
        store: { ...pinnedStore(), readQualification: () => Effect.succeed(Option.none()) },
      },
      {
        name: 'durable evidence',
        config: pinnedRuntimeConfig,
        strategy: fixtureStrategy,
        store: { ...pinnedStore(), recover: () => Effect.succeed(Option.none()) },
      },
    ]

    for (const testCase of cases) {
      const state = await Effect.runPromise(Ref.make(initialState()))
      await Effect.runPromise(
        initialize(testCase.config, state).pipe(
          Effect.provideService(MarketData, marketDataService(Effect.die(new Error('must not load bars')))),
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, testCase.store),
          Effect.provideService(Strategy, testCase.strategy),
        ),
      )
      expect(await Effect.runPromise(Ref.get(state)), testCase.name).toMatchObject({
        status: 'FAILED',
        evidence: null,
        error: expect.stringContaining('pinned'),
      })
    }
  })

  test('recovers a complete run without evaluating, journaling, or persisting again', async () => {
    const snapshot = makeSnapshot()
    const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    let evaluations = 0
    let journalWrites = 0
    let persistenceWrites = 0
    const strategy: StrategyService = {
      ...fixtureStrategy,
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
      openQualification: () => Effect.succeed({ state: 'TERMINAL', lock: fixtureLock, result: fixtureQualification }),
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
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('terminal recovery must not load bars')), snapshot),
        ),
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

  test('fails closed on an opened qualification without reading bars or mutating evidence', async () => {
    const snapshot = makeSnapshot()
    let evaluations = 0
    let journalWrites = 0
    let persistenceWrites = 0
    const strategy: StrategyService = {
      ...fixtureStrategy,
      evaluate: () => {
        evaluations += 1
        throw new Error('incomplete qualification must not evaluate')
      },
    }
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        journalWrites += 1
        return Effect.die(new Error('incomplete qualification must not journal'))
      },
    }
    const store: EvidenceStoreService = {
      ...successfulEvidenceStore,
      openQualification: () => Effect.succeed({ state: 'OPENED_INCOMPLETE', lock: fixtureLock }),
      persist: () => {
        persistenceWrites += 1
        return Effect.die(new Error('incomplete qualification must not persist'))
      },
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(config, state).pipe(
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('incomplete qualification must not load bars')), snapshot),
        ),
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
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('database.open-qualification'),
    })
  })

  test('fails closed instead of re-evaluating a corrupt matching durable run', async () => {
    const snapshot = makeSnapshot()
    let evaluations = 0
    let journalWrites = 0
    const strategy: StrategyService = {
      ...fixtureStrategy,
      evaluate: () => {
        evaluations += 1
        throw new Error('corrupt recovery must not fall back to evaluation')
      },
    }
    const store: EvidenceStoreService = {
      ...successfulEvidenceStore,
      openQualification: () => Effect.succeed({ state: 'TERMINAL', lock: fixtureLock, result: fixtureQualification }),
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
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('corrupt recovery must not load bars')), snapshot),
        ),
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
      ...fixtureStrategy,
      name: 'test-strategy',
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

  test('rejects an underpowered calendar before opening a qualification lock', async () => {
    const state = await Effect.runPromise(Ref.make(initialState()))
    const shortSnapshot = makeSnapshot(700)
    const marketData = marketDataService(Effect.succeed(shortSnapshot), shortSnapshot)

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
      error: expect.stringContaining('strategy.prepare-lock'),
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
      listPriorTrials: Effect.succeed([]),
      openQualification: ({ lock }) => Effect.succeed({ state: 'ACQUIRED', lock }),
      readQualification: () => Effect.succeed(Option.none()),
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

  test('keeps HTTP live and interrupts a migration that exceeds the operation deadline', async () => {
    let interrupted = false
    const port = await unusedPort()
    const timedOutDatabase = {
      ...config,
      port,
      operationTimeoutMs: 10,
    }
    const stalledMigration = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))))
    const dependencies = Layer.mergeAll(
      Layer.succeed(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
      Layer.succeed(Journal, successfulJournal),
      makeEvidenceStoreRuntimeLayer(timedOutDatabase, stalledMigration, Effect.succeed(successfulEvidenceStore)),
      TsmomStrategyLayer(fixtureProtocol, provenance),
    )
    const fiber = Effect.runFork(run(timedOutDatabase).pipe(Effect.provide(dependencies)))

    try {
      const status = await waitForStatus(port, 'FAILED')
      expect(interrupted).toBe(true)
      expect(status).toMatchObject({
        status: 200,
        body: {
          operational: { status: 'FAILED' },
          error: expect.stringContaining('PostgreSQL migration timed out after 10ms'),
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
