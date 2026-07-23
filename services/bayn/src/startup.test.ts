import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { NodeServices } from '@effect/platform-node'
import { Cause, Effect, Exit, Layer, Option, Ref } from 'effect'
import { AuthenticationError, SqlError } from 'effect/unstable/sql/SqlError'

import {
  provenance,
  config,
  successfulJournal,
  marketDataService,
  successfulEvidenceStore,
  fixtureStrategy,
  fixtureLock,
  fixtureQualification,
  pinnedExecutionProvenance,
  pinnedEvaluation,
  pinnedLock,
  pinnedQualification,
  pinnedRuntimeConfig,
  pinnedStoredEvidence,
  pinnedStrategy,
  pinnedStore,
} from './app-test-support'
import { initialize, run } from './app'
import { makeStrategyProtocolHash } from './contracts'
import {
  DatabaseError,
  EvidenceStore,
  EvidenceStoreLive,
  makeEvidenceStoreLayer,
  type EvidenceStoreService,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { operationalError } from './errors'
import { Journal, type JournalService } from './ledger'
import { MarketData } from './market-data'
import { defaultProtocolDocument, loadProtocol } from './protocol'
import { makeQualificationLock, makeQualificationResult } from './qualification'
import { evaluateRiskBalancedTrend, summarizeEvaluation } from './risk-balanced-trend'
import { initialState } from './runtime-state'
import type { Strategy } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

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
      initialize(pinnedRuntimeConfig, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, {
          check: forbidden('pinned startup must not check Signal'),
          inspect: forbidden('pinned startup must not inspect Signal'),
          load: forbidden('pinned startup must not load Signal bars'),
        }),
        Effect.provideService(Journal, {
          post: () => forbidden('pinned startup must not write TigerBeetle'),
          verifyAccount: () => forbidden('pinned startup must not reconcile paper accounting'),
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

  test('recovers immutable protocol v2 evidence independently of the compiled v3 strategy', async () => {
    const historicalProtocol = Effect.runSync(
      loadProtocol({
        ...defaultProtocolDocument,
        schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
        executionModel: {
          ...defaultProtocolDocument.executionModel,
          schemaVersion: 'bayn.execution-model.v1',
          order: {
            type: 'market',
            timeInForce: 'day',
            extendedHours: false,
            submitAfter: 'signal-session-close',
            submitBefore: 'next-session-open',
            priceReference: 'next-session-open',
          },
        },
      }),
    )
    const historicalProvenance = makeTestProvenance(historicalProtocol, {
      sourceRevision: pinnedExecutionProvenance.sourceRevision,
      imageDigest: pinnedExecutionProvenance.image.digest,
      behaviorHash: 'c'.repeat(64),
    })
    const historicalProtocolHash = makeStrategyProtocolHash(historicalProvenance.strategy)
    const historicalStoredEvidence: StoredEvaluationEvidence = {
      ...pinnedStoredEvidence,
      protocol: {
        protocolHash: historicalProtocolHash,
        schemaVersion: historicalProtocol.schemaVersion,
        strategyName: historicalProvenance.strategy.name,
        behaviorHash: historicalProvenance.strategy.behaviorHash,
        parameterHash: historicalProvenance.strategy.parameterHash,
        parameters: historicalProtocol,
      },
      run: {
        ...pinnedStoredEvidence.run,
        protocolHash: historicalProtocolHash,
        sourceRevision: historicalProvenance.sourceRevision,
        imageRepository: historicalProvenance.image.repository,
        imageDigest: historicalProvenance.image.digest,
      },
    }
    const { lockId: _, ...pinnedLockMaterial } = pinnedLock
    const historicalLock = makeQualificationLock({
      ...pinnedLockMaterial,
      protocolHash: historicalProtocolHash,
      sourceRevision: historicalProvenance.sourceRevision,
      image: historicalProvenance.image,
    })
    const historicalQualification = makeQualificationResult(
      historicalLock,
      pinnedEvaluation.verdict,
      pinnedStrategy.analyze(pinnedEvaluation, []),
    )
    const store: EvidenceStoreService = {
      ...pinnedStore(),
      read: () => Effect.succeed(Option.some(historicalStoredEvidence)),
      readQualification: () =>
        Effect.succeed(Option.some({ state: 'TERMINAL', lock: historicalLock, result: historicalQualification })),
      recover: (runId, recoveredProvenance) =>
        Effect.sync(() => {
          expect(runId).toBe(pinnedEvaluation.runId)
          expect(recoveredProvenance).toEqual(historicalProvenance)
          return Option.some({
            evaluation: summarizeEvaluation(pinnedEvaluation),
            reconciliation: {
              runId,
              accountCount: 13,
              transferCount: pinnedEvaluation.events.length,
              exact: true,
            },
            persistence: {
              runId,
              deduplicated: true,
              artifactCount: 17,
              eventCount: pinnedEvaluation.events.length,
              gateCount: pinnedEvaluation.verdict.gates.length,
            },
          })
        }),
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(pinnedRuntimeConfig, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.die(new Error('must not load bars')))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, store),
      ),
    )

    expect(fixtureStrategy.provenance.strategy.parameterSchemaVersion).toBe('bayn.risk-balanced-trend.protocol.v3')
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'STARTING',
      evidence: {
        startupMode: 'pinned',
        provenance: historicalProvenance,
        qualification: { verdict: 'REJECTED' },
      },
    })
  })

  test('fails pinned recovery closed on stored-protocol, snapshot, terminal-result, and durable-evidence drift', async () => {
    const cases = [
      {
        name: 'stored protocol',
        config: pinnedRuntimeConfig,
        strategy: fixtureStrategy,
        store: {
          ...pinnedStore(),
          read: () =>
            Effect.succeed(
              Option.some({
                ...pinnedStoredEvidence,
                protocol: { ...pinnedStoredEvidence.protocol, parameterHash: '0'.repeat(64) },
              }),
            ),
        },
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
        initialize(testCase.config, state, testCase.strategy).pipe(
          Effect.provideService(MarketData, marketDataService(Effect.die(new Error('must not load bars')))),
          Effect.provideService(Journal, successfulJournal),
          Effect.provideService(EvidenceStore, testCase.store),
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
    const evaluation = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    let evaluations = 0
    let journalWrites = 0
    let persistenceWrites = 0
    const strategy: Strategy = {
      ...fixtureStrategy,
      evaluate: () => {
        evaluations += 1
        return evaluation
      },
    }
    const journal: JournalService = {
      post: () => Effect.void,
      verifyAccount: () => Effect.succeed(true),
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
      initialize(config, state, strategy).pipe(
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('terminal recovery must not load bars')), snapshot),
        ),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, store),
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
    const strategy: Strategy = {
      ...fixtureStrategy,
      evaluate: () => {
        evaluations += 1
        throw new Error('incomplete qualification must not evaluate')
      },
    }
    const journal: JournalService = {
      post: () => Effect.void,
      verifyAccount: () => Effect.succeed(true),
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
      initialize(config, state, strategy).pipe(
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('incomplete qualification must not load bars')), snapshot),
        ),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, store),
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
    const strategy: Strategy = {
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
      post: () => Effect.void,
      verifyAccount: () => Effect.succeed(true),
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        journalWrites += 1
        return Effect.die(new Error('corrupt recovery must not journal'))
      },
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(config, state, strategy).pipe(
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('corrupt recovery must not load bars')), snapshot),
        ),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, store),
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
    const strategy: Strategy = {
      ...fixtureStrategy,
      name: 'test-strategy',
      evaluate: (bars, manifest) => {
        calls += 1
        return evaluateRiskBalancedTrend(bars, manifest, fixtureProtocol, provenance)
      },
    }

    await Effect.runPromise(
      initialize(config, state, strategy).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(snapshot))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
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
      initialize(config, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
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
      initialize(config, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('strategy.prepare-lock'),
    })
  })

  test('interrupts a stalled dependency and returns a retryable startup failure', async () => {
    let interrupted = false
    const state = await Effect.runPromise(Ref.make(initialState()))
    const marketData = marketDataService(
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    )

    const exit = await Effect.runPromiseExit(
      initialize({ ...config, operationTimeoutMs: 10 }, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
      ),
    )

    expect(interrupted).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('load timed out')
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'STARTING', evidence: null, error: null })
  })

  test('propagates an unexpected defect instead of leaving a detached STARTING worker', async () => {
    const marketData = marketDataService(Effect.die(new Error('unexpected startup defect')))
    const exit = await Effect.runPromiseExit(
      run(config, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
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

  test('terminates the runtime when continuous reconciliation dies', async () => {
    const exit = await Effect.runPromiseExit(
      run(config, fixtureStrategy, Effect.die(new Error('unexpected reconciliation defect'))).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.timeoutOrElse({
          duration: 250,
          orElse: () => Effect.fail(operationalError('http', 'test', 'run remained alive after reconciliation died')),
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('unexpected reconciliation defect')
      expect(Cause.pretty(exit.cause)).not.toContain('remained alive')
    }
  })

  test('exits the scoped runtime on a retryable startup dependency failure', async () => {
    let interrupted = false
    const journal: JournalService = {
      ...successfulJournal,
      check: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    }
    const exit = await Effect.runPromiseExit(
      run({ ...config, operationTimeoutMs: 10 }, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, successfulEvidenceStore),
        Effect.timeoutOrElse({
          duration: 250,
          orElse: () =>
            Effect.fail(operationalError('http', 'test', 'run remained live after a retryable startup failure')),
        }),
      ),
    )

    expect(interrupted).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('connectivity-check timed out')
      expect(Cause.pretty(exit.cause)).not.toContain('remained live')
    }
  })

  test('returns a retryable startup failure when durable evidence cannot be committed', async () => {
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

    const exit = await Effect.runPromiseExit(
      initialize(config, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, unavailable),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('database unavailable')
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({ status: 'STARTING', evidence: null, error: null })
  })

  test('keeps PostgreSQL authentication failures observable as terminal startup failures', async () => {
    const state = await Effect.runPromise(Ref.make(initialState()))
    const authentication = new SqlError({
      reason: new AuthenticationError({ cause: new Error('invalid credentials'), operation: 'persist' }),
    })
    const unauthorized: EvidenceStoreService = {
      ...successfulEvidenceStore,
      persist: () =>
        Effect.fail(
          new DatabaseError({
            failure: 'unavailable',
            operation: 'persist',
            message: 'database authentication failed',
            cause: authentication,
          }),
        ),
    }

    await Effect.runPromise(
      initialize(config, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.succeed(makeSnapshot()))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, unauthorized),
      ),
    )

    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('database authentication failed'),
    })
  })

  test('fails layer construction when database setup fails', async () => {
    const unavailableDatabase = {
      ...config,
      postgres: {
        ...config.postgres,
        tls: true,
        caPath: `/tmp/bayn-missing-ca-${randomUUID()}.crt`,
      },
    }
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(EvidenceStoreLive(unavailableDatabase).pipe(Layer.provide(NodeServices.layer)))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('failed to read PostgreSQL CA certificate')
  })

  test('interrupts and fails layer construction when a migration exceeds the operation deadline', async () => {
    let interrupted = false
    const timedOutDatabase = {
      ...config,
      operationTimeoutMs: 10,
    }
    const stalledMigration = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))))
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Layer.build(
          makeEvidenceStoreLayer(timedOutDatabase, stalledMigration, Effect.succeed(successfulEvidenceStore)),
        ),
      ),
    )

    expect(interrupted).toBe(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('PostgreSQL migration timed out after 10ms')
  })
})
