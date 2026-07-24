import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { NodeServices } from '@effect/platform-node'
import { Cause, Effect, Exit, Layer, Option, Ref, Result } from 'effect'
import { AuthenticationError, SqlError } from 'effect/unstable/sql/SqlError'

import {
  provenance,
  config,
  successfulJournal,
  marketDataService,
  successfulEvidenceStore,
  fixtureEvaluation,
  fixtureStrategy,
  fixtureSnapshot,
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
import { CycleObservability } from './db/cycle-observability'
import {
  DatabaseError,
  EvidenceStore,
  EvidenceStoreLive,
  makeEvidenceStoreLayer,
  type EvidenceStoreService,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { operationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { Journal, type JournalService } from './ledger'
import { MarketData } from './market-data'
import { defaultProtocolDocument, loadProtocol } from './protocol'
import { makeQualificationLock, makeQualificationResult } from './qualification'
import {
  evaluateRiskBalancedTrend,
  riskBalancedTrendCompatibilityFailure,
  summarizeEvaluation,
} from './risk-balanced-trend'
import { initialState } from './runtime-state'
import {
  decidePinnedQualification,
  decidePinnedRecovery,
  decideQualificationPath,
  decideTerminalRecovery,
  evaluateLockedSnapshot,
  qualifyEvaluation,
  renderStartupDecisionFailure,
  type StartupDecisionFailure,
} from './startup'
import type { Strategy } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const cycleObservability = {
  read: () =>
    Effect.succeed({
      current: null,
      last: null,
      unfinishedCycleCount: 0,
      authority: null,
      reconciliation: null,
      mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
    }),
}

const recoveredFixture = (runId = fixtureEvaluation.runId) => ({
  evaluation: { ...summarizeEvaluation(fixtureEvaluation), runId },
  reconciliation: {
    runId,
    accountCount: 13,
    transferCount: fixtureEvaluation.events.length,
    exact: true as const,
  },
  persistence: {
    runId,
    deduplicated: true,
    artifactCount: 17,
    eventCount: fixtureEvaluation.events.length,
    gateCount: fixtureEvaluation.verdict.gates.length,
  },
})

const verdictWithCanonicalDrift = (verdict: typeof fixtureEvaluation.verdict): typeof fixtureEvaluation.verdict => ({
  ...verdict,
  gates: verdict.gates.map((gate, index) => (index === 0 ? { ...gate, actual: `drift:${String(gate.actual)}` } : gate)),
})

const candidateQualification = {
  inspection: {
    manifest: fixtureSnapshot.manifest,
    sessionDates: [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
    signalSession: {
      calendar_version: fixtureSnapshot.manifest.finalizedSnapshot.calendarVersion,
      session_date: fixtureSnapshot.manifest.lastSession,
      close_time: '16:00',
      timezone: 'America/New_York',
    },
  },
  lock: fixtureLock,
} satisfies {
  readonly inspection: Parameters<typeof evaluateLockedSnapshot>[1]
  readonly lock: typeof fixtureLock
}

const malformedPinnedStoredEvidence = (): StoredEvaluationEvidence =>
  ({
    ...pinnedStoredEvidence,
    protocol: {
      ...pinnedStoredEvidence.protocol,
      parameters: { ...pinnedStoredEvidence.protocol.parameters, universeId: '\ud800' },
    },
  }) as unknown as StoredEvaluationEvidence

const decisionFailure = <A>(result: Result.Result<A, StartupDecisionFailure>): StartupDecisionFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) return result.failure
  throw new Error('expected startup decision failure')
}

const decisionSuccess = <A>(result: Result.Result<A, StartupDecisionFailure>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) return result.success
  throw new Error('expected startup decision success')
}

const expectRenderedFailure = (
  failure: StartupDecisionFailure,
  expected: { readonly component: string; readonly operation: string; readonly message: unknown },
): void => {
  expect(renderStartupDecisionFailure(failure)).toMatchObject({ ...expected, cause: failure })
}

describe('Bayn startup pure decisions', () => {
  test('rejects unsupported and malformed stored provenance with exact facts', () => {
    const unsupported = {
      ...pinnedStoredEvidence,
      protocol: { ...pinnedStoredEvidence.protocol, strategyName: 'unsupported-strategy' },
    } as unknown as StoredEvaluationEvidence
    const malformed = {
      ...pinnedStoredEvidence,
      run: { ...pinnedStoredEvidence.run, sourceRevision: 'invalid-source-revision' },
    } as unknown as StoredEvaluationEvidence

    for (const [stored, reason] of [
      [unsupported, 'unsupported-contract'],
      [malformed, 'malformed'],
    ] as const) {
      const failure = decisionFailure(
        decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
          stored: Option.some(stored),
          qualification: Option.some({ state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification }),
        }),
      )
      expect(failure).toMatchObject({
        _tag: 'StoredProvenanceInvalid',
        identity: {
          runId: pinnedEvaluation.runId,
          strategyName: stored.protocol.strategyName,
          schemaVersion: stored.protocol.schemaVersion,
        },
        issue: { reason },
      })
      expectRenderedFailure(failure, {
        component: 'database',
        operation: 'recover-pinned-qualification',
        message:
          reason === 'unsupported-contract'
            ? 'stored qualification provenance is invalid: stored evaluation uses an unsupported strategy contract'
            : expect.stringContaining('stored qualification provenance is invalid:'),
      })
    }
  })

  test('decides pinned recovery from immutable facts and renders a missing stored evaluation exactly', () => {
    const qualification = Option.some({ state: 'TERMINAL' as const, lock: pinnedLock, result: pinnedQualification })
    const decision = decisionSuccess(
      decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
        stored: Option.some(pinnedStoredEvidence),
        qualification,
      }),
    )
    expect(decision).toMatchObject({
      _tag: 'RecoverPinned',
      executionProvenance: pinnedExecutionProvenance,
      qualification: { result: { runId: pinnedEvaluation.runId } },
    })

    const missing = decisionFailure(
      decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
        stored: Option.none(),
        qualification,
      }),
    )
    expect(missing).toEqual({
      _tag: 'QualificationStateInvalid',
      details: {
        reason: 'evidence-missing',
        phase: 'read-pinned',
        runId: pinnedEvaluation.runId,
      },
    })
    expectRenderedFailure(missing, {
      component: 'database',
      operation: 'read-pinned-qualification',
      message: `pinned evaluation ${pinnedEvaluation.runId} is missing`,
    })
  })

  test('returns a structured pinned-recovery mismatch instead of accepting divergent durable run identities', () => {
    const decision = decisionSuccess(
      decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
        stored: Option.some(pinnedStoredEvidence),
        qualification: Option.some({ state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification }),
      }),
    )
    const wrongPersistenceRunId = '0'.repeat(64)
    const recovered = recoveredFixture()
    const mismatch = decisionFailure(
      decidePinnedRecovery(
        decision,
        Option.some({
          ...recovered,
          evaluation: summarizeEvaluation(pinnedEvaluation),
          reconciliation: { ...recovered.reconciliation, runId: pinnedEvaluation.runId },
          persistence: { ...recovered.persistence, runId: wrongPersistenceRunId },
        }),
      ),
    )
    expect(mismatch).toMatchObject({
      _tag: 'BindingMismatch',
      details: {
        binding: 'recovery',
        phase: 'pinned',
        expectedRunId: pinnedEvaluation.runId,
        recoveredRunIds: {
          evaluation: pinnedEvaluation.runId,
          reconciliation: pinnedEvaluation.runId,
          persistence: wrongPersistenceRunId,
        },
      },
    })
    expectRenderedFailure(mismatch, {
      component: 'database',
      operation: 'recover-pinned-qualification',
      message: 'pinned qualification recovery failed: recovered evidence differs from the terminal qualification',
    })
  })

  test('rejects pinned run and lock drift with exact binding facts', () => {
    const wrongRunId = '0'.repeat(64)
    const wrongSourceRevision = '0'.repeat(40)
    const cases = [
      {
        binding: 'pinned-run',
        stored: {
          ...pinnedStoredEvidence,
          run: { ...pinnedStoredEvidence.run, runId: wrongRunId },
        } as StoredEvaluationEvidence,
        lock: pinnedLock,
        message: 'pinned qualification binding failed: stored evaluation and terminal qualification run IDs differ',
      },
      {
        binding: 'pinned-lock',
        stored: pinnedStoredEvidence,
        lock: { ...pinnedLock, sourceRevision: wrongSourceRevision },
        message: 'pinned qualification binding failed: qualification lock differs from the stored execution provenance',
      },
    ] as const

    for (const testCase of cases) {
      const failure = decisionFailure(
        decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
          stored: Option.some(testCase.stored),
          qualification: Option.some({
            state: 'TERMINAL',
            lock: testCase.lock,
            result: pinnedQualification,
          }),
        }),
      )
      expect(failure).toMatchObject({
        _tag: 'BindingMismatch',
        details: { binding: testCase.binding },
      })
      expectRenderedFailure(failure, {
        component: 'database',
        operation: 'recover-pinned-qualification',
        message: testCase.message,
      })
    }
  })

  test('makes every qualification-path branch explicit and renders incomplete-lock refusal exactly', () => {
    const { lockId: _fixtureLockId, ...fixtureLockMaterial } = fixtureLock
    const driftedLock = makeQualificationLock({
      ...fixtureLockMaterial,
      sourceRevision: '0'.repeat(40),
    })
    expect(driftedLock.candidateRunId).toBe(fixtureLock.candidateRunId)

    expect(decideQualificationPath(fixtureLock, { state: 'ACQUIRED', lock: fixtureLock })).toEqual(
      Result.succeed({ _tag: 'EvaluateAcquired' }),
    )
    expect(
      decideQualificationPath(fixtureLock, {
        state: 'TERMINAL',
        lock: fixtureLock,
        result: fixtureQualification,
      }),
    ).toEqual(
      Result.succeed({
        _tag: 'RecoverTerminal',
        runId: fixtureLock.candidateRunId,
        result: fixtureQualification,
      }),
    )

    const incomplete = decisionFailure(
      decideQualificationPath(driftedLock, { state: 'OPENED_INCOMPLETE', lock: fixtureLock }),
    )
    expect(incomplete).toEqual({
      _tag: 'QualificationStateInvalid',
      details: { reason: 'opened-incomplete', lockId: fixtureLock.lockId },
    })
    expectRenderedFailure(incomplete, {
      component: 'database',
      operation: 'open-qualification',
      message: `qualification ${fixtureLock.lockId} was opened without a terminal result`,
    })

    const lockMismatch = decisionFailure(decideQualificationPath(fixtureLock, { state: 'ACQUIRED', lock: driftedLock }))
    expect(lockMismatch).toEqual({
      _tag: 'BindingMismatch',
      details: {
        binding: 'qualification-lock',
        expected: fixtureLock,
        observed: driftedLock,
      },
    })
    expectRenderedFailure(lockMismatch, {
      component: 'database',
      operation: 'open-qualification',
      message: 'qualification lock binding failed: store returned a different candidate lock',
    })

    const terminalMismatch = decisionFailure(
      decideQualificationPath(fixtureLock, {
        state: 'TERMINAL',
        lock: fixtureLock,
        result: pinnedQualification,
      }),
    )
    expect(terminalMismatch).toEqual({
      _tag: 'BindingMismatch',
      details: {
        binding: 'terminal-run',
        terminalRunId: fixtureLock.candidateRunId,
        qualificationRunId: pinnedQualification.runId,
      },
    })
    expectRenderedFailure(terminalMismatch, {
      component: 'database',
      operation: 'recover-qualification',
      message: 'qualification recovery failed: terminal lock and result run IDs differ',
    })
  })

  test('recovers only terminal evidence with the exact run binding', () => {
    const path = {
      _tag: 'RecoverTerminal' as const,
      runId: fixtureLock.candidateRunId,
      result: fixtureQualification,
    }
    const exact = decisionSuccess(
      decideTerminalRecovery(fixtureStrategy.provenance, path, Option.some(recoveredFixture())),
    )
    expect(exact).toMatchObject({
      _tag: 'TerminalRecovered',
      evidence: { startupMode: 'recovered', evaluation: { runId: fixtureEvaluation.runId } },
    })

    const missing = decisionFailure(decideTerminalRecovery(fixtureStrategy.provenance, path, Option.none()))
    expect(missing).toEqual({
      _tag: 'QualificationStateInvalid',
      details: {
        reason: 'evidence-missing',
        phase: 'recover-terminal',
        runId: fixtureQualification.runId,
      },
    })
    expectRenderedFailure(missing, {
      component: 'database',
      operation: 'recover-evaluation',
      message: `terminal qualification run ${fixtureQualification.runId} is missing`,
    })

    const forgedPath = decisionFailure(
      decideTerminalRecovery(
        fixtureStrategy.provenance,
        { ...path, runId: pinnedQualification.runId },
        Option.some(recoveredFixture()),
      ),
    )
    expect(forgedPath).toEqual({
      _tag: 'BindingMismatch',
      details: {
        binding: 'terminal-run',
        terminalRunId: pinnedQualification.runId,
        qualificationRunId: fixtureQualification.runId,
      },
    })

    const recoveredRunId = '0'.repeat(64)
    for (const field of ['evaluation', 'reconciliation', 'persistence'] as const) {
      const recovered = recoveredFixture()
      const mismatch = decisionFailure(
        decideTerminalRecovery(
          fixtureStrategy.provenance,
          path,
          Option.some({
            ...recovered,
            [field]: { ...recovered[field], runId: recoveredRunId },
          }),
        ),
      )
      expect(mismatch).toMatchObject({
        _tag: 'BindingMismatch',
        details: {
          binding: 'recovery',
          phase: 'terminal',
          expectedRunId: fixtureQualification.runId,
          recoveredRunIds: { [field]: recoveredRunId },
        },
      })
      expectRenderedFailure(mismatch, {
        component: 'database',
        operation: 'recover-qualification',
        message: 'qualification recovery failed: terminal qualification differs from the recovered evaluation',
      })
    }
  })

  test('rejects verdict-only drift for pinned and terminal recovery with unchanged run IDs', () => {
    const pinnedDecision = decisionSuccess(
      decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
        stored: Option.some(pinnedStoredEvidence),
        qualification: Option.some({ state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification }),
      }),
    )
    const pinnedRecovered = recoveredFixture(pinnedEvaluation.runId)
    const pinnedMismatch = decisionFailure(
      decidePinnedRecovery(
        pinnedDecision,
        Option.some({
          ...pinnedRecovered,
          evaluation: {
            ...summarizeEvaluation(pinnedEvaluation),
            verdict: verdictWithCanonicalDrift(pinnedEvaluation.verdict),
          },
        }),
      ),
    )
    expect(pinnedMismatch).toMatchObject({
      _tag: 'BindingMismatch',
      details: {
        binding: 'recovery',
        phase: 'pinned',
        expectedRunId: pinnedEvaluation.runId,
        recoveredRunIds: {
          evaluation: pinnedEvaluation.runId,
          reconciliation: pinnedEvaluation.runId,
          persistence: pinnedEvaluation.runId,
        },
      },
    })

    const terminalPath = {
      _tag: 'RecoverTerminal' as const,
      runId: fixtureLock.candidateRunId,
      result: fixtureQualification,
    }
    const terminalRecovered = recoveredFixture()
    const terminalMismatch = decisionFailure(
      decideTerminalRecovery(
        fixtureStrategy.provenance,
        terminalPath,
        Option.some({
          ...terminalRecovered,
          evaluation: {
            ...terminalRecovered.evaluation,
            verdict: verdictWithCanonicalDrift(fixtureEvaluation.verdict),
          },
        }),
      ),
    )
    expect(terminalMismatch).toMatchObject({
      _tag: 'BindingMismatch',
      details: {
        binding: 'recovery',
        phase: 'terminal',
        expectedRunId: fixtureEvaluation.runId,
        recoveredRunIds: {
          evaluation: fixtureEvaluation.runId,
          reconciliation: fixtureEvaluation.runId,
          persistence: fixtureEvaluation.runId,
        },
      },
    })
  })

  test('rejects a loaded manifest mismatch before evaluation with canonical fact hashes', () => {
    const loaded = {
      ...fixtureSnapshot,
      manifest: { ...fixtureSnapshot.manifest, hash: '0'.repeat(64) },
    }
    const mismatch = decisionFailure(
      evaluateLockedSnapshot(fixtureStrategy, candidateQualification.inspection, fixtureLock, loaded),
    )
    expect(mismatch).toEqual({
      _tag: 'BindingMismatch',
      details: {
        binding: 'locked-manifest',
        inspectedManifestHash: canonicalHashV1(candidateQualification.inspection.manifest),
        loadedManifestHash: canonicalHashV1(loaded.manifest),
      },
    })
    expectRenderedFailure(mismatch, {
      component: 'market-data',
      operation: 'load-locked',
      message: 'locked Signal load failed: loaded Signal manifest differs from the locked inspection',
    })
  })

  test('returns an exact evaluation-run mismatch without throwing or journaling', () => {
    const evaluationRunId = '0'.repeat(64)
    const strategy: Strategy = {
      ...fixtureStrategy,
      evaluate: () => Result.succeed({ ...fixtureEvaluation, runId: evaluationRunId }),
    }
    const mismatch = decisionFailure(
      evaluateLockedSnapshot(strategy, candidateQualification.inspection, fixtureLock, fixtureSnapshot),
    )
    expect(mismatch).toEqual({
      _tag: 'BindingMismatch',
      details: {
        binding: 'evaluation-run',
        lockedRunId: fixtureLock.candidateRunId,
        evaluationRunId,
      },
    })
    expectRenderedFailure(mismatch, {
      component: 'strategy',
      operation: 'evaluate',
      message: 'evaluation run identity differs from the qualification lock',
    })
  })

  test('renders evaluate, analyze, and qualify failures with baseline operation text', () => {
    const evaluationCause = new Error('evaluation exploded')
    const analysisCause = new Error('analysis exploded')
    const reconciliation = recoveredFixture().reconciliation
    const cases: readonly {
      readonly operation: 'evaluate' | 'analyze' | 'qualify'
      readonly message: string
      readonly decide: () => Result.Result<unknown, StartupDecisionFailure>
    }[] = [
      {
        operation: 'evaluate',
        message: `${fixtureStrategy.name} evaluation failed: ${evaluationCause.message}`,
        decide: () =>
          evaluateLockedSnapshot(
            {
              ...fixtureStrategy,
              evaluate: () => Result.fail(riskBalancedTrendCompatibilityFailure('prepare', evaluationCause)),
            },
            candidateQualification.inspection,
            fixtureLock,
            fixtureSnapshot,
          ),
      },
      {
        operation: 'analyze',
        message: `${fixtureStrategy.name} analysis failed: ${analysisCause.message}`,
        decide: () =>
          qualifyEvaluation(
            {
              ...fixtureStrategy,
              analyze: () => {
                throw analysisCause
              },
            },
            fixtureLock,
            fixtureEvaluation,
            reconciliation,
          ),
      },
      {
        operation: 'qualify',
        message: `${fixtureStrategy.name} qualification failed: qualification analysis must use the locked prior-trial lineage`,
        decide: () =>
          qualifyEvaluation(
            {
              ...fixtureStrategy,
              analyze: (evaluation, priorTrialRunIds) => ({
                ...fixtureStrategy.analyze(evaluation, priorTrialRunIds),
                priorTrialRunIds: ['0'.repeat(64)],
              }),
            },
            fixtureLock,
            fixtureEvaluation,
            reconciliation,
          ),
      },
    ]

    for (const testCase of cases) {
      const failure = decisionFailure(testCase.decide())
      expect(failure).toMatchObject({
        _tag: 'StrategyOperationFailed',
        operation: testCase.operation,
        strategyName: fixtureStrategy.name,
      })
      expectRenderedFailure(failure, {
        component: 'strategy',
        operation: testCase.operation,
        message: testCase.message,
      })
    }
  })

  test('renders hostile causes with a deterministic fallback without losing the original cause', () => {
    const hostileString = {
      toString: () => {
        throw new Error('hostile toString')
      },
    }
    const hostileMessage = new Error('hidden')
    Object.defineProperty(hostileMessage, 'message', {
      get: () => {
        throw new Error('hostile message getter')
      },
    })

    for (const cause of [hostileString, hostileMessage]) {
      const failure: StartupDecisionFailure = {
        _tag: 'StrategyOperationFailed',
        operation: 'analyze',
        strategyName: fixtureStrategy.name,
        cause,
      }
      expect(() => {
        renderStartupDecisionFailure(failure)
      }).not.toThrow()
      expectRenderedFailure(failure, {
        component: 'strategy',
        operation: 'analyze',
        message: `${fixtureStrategy.name} analysis failed: unrenderable cause`,
      })
    }
  })

  test('captures malformed persisted canonical material as data instead of a defect', () => {
    const malformed = malformedPinnedStoredEvidence()
    const decide = () =>
      decidePinnedQualification(pinnedRuntimeConfig, pinnedEvaluation.runId, {
        stored: Option.some(malformed),
        qualification: Option.some({ state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification }),
      })

    expect(decide).not.toThrow()
    const failure = decisionFailure(decide())
    expect(failure).toMatchObject({
      _tag: 'CanonicalizationFailed',
      details: {
        target: 'stored-protocol-parameters',
        side: 'stored',
      },
    })
    expect(failure._tag === 'CanonicalizationFailed' && failure.details.cause instanceof TypeError).toBe(true)
    expectRenderedFailure(failure, {
      component: 'database',
      operation: 'recover-pinned-qualification',
      message: expect.stringContaining('contains an invalid Unicode surrogate'),
    })
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
      initialize(pinnedRuntimeConfig, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, {
          check: forbidden('pinned startup must not check Signal'),
          inspect: forbidden('pinned startup must not inspect Signal'),
          inspectCyclePublications: forbidden('pinned startup must not inspect cycle publication candidates'),
          inspectPublication: () => forbidden('pinned startup must not inspect a cycle publication'),
          inspectSnapshotPublication: () => forbidden('pinned startup must not inspect a bound cycle publication'),
          loadSnapshotPublication: () => forbidden('pinned startup must not load bound cycle bars'),
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

  test('converts malformed persisted canonical material to a terminal failure without a defect', async () => {
    const state = await Effect.runPromise(Ref.make(initialState()))
    const exit = await Effect.runPromiseExit(
      initialize(pinnedRuntimeConfig, state, fixtureStrategy).pipe(
        Effect.provideService(MarketData, marketDataService(Effect.die(new Error('must not load bars')))),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, {
          ...pinnedStore(),
          read: () => Effect.succeed(Option.some(malformedPinnedStoredEvidence())),
        }),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('contains an invalid Unicode surrogate'),
    })
  })

  test('recovers a complete run without evaluating, journaling, or persisting again', async () => {
    const snapshot = makeSnapshot()
    const evaluationResult = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
    assert(Result.isSuccess(evaluationResult), 'recovery fixture evaluation must succeed')
    const evaluation = evaluationResult.success
    let evaluations = 0
    let journalWrites = 0
    let persistenceWrites = 0
    const strategy: Strategy = {
      ...fixtureStrategy,
      evaluate: () => {
        evaluations += 1
        return Result.succeed(evaluation)
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

  test('rejects an unrelated terminal qualification before recovery or publication', async () => {
    const snapshot = makeSnapshot()
    let recoverCalls = 0
    let persistenceWrites = 0
    const store: EvidenceStoreService = {
      ...successfulEvidenceStore,
      openQualification: (input) =>
        Effect.sync(() => {
          expect(input.lock).toEqual(fixtureLock)
          return { state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification }
        }),
      recover: () => {
        recoverCalls += 1
        return Effect.die(new Error('unrelated terminal qualification must not be recovered'))
      },
      persist: () => {
        persistenceWrites += 1
        return Effect.die(new Error('unrelated terminal qualification must not be persisted'))
      },
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(config, state, fixtureStrategy).pipe(
        Effect.provideService(
          MarketData,
          marketDataService(Effect.die(new Error('unrelated terminal qualification must not load bars')), snapshot),
        ),
        Effect.provideService(Journal, successfulJournal),
        Effect.provideService(EvidenceStore, store),
      ),
    )

    expect({ recoverCalls, persistenceWrites }).toEqual({ recoverCalls: 0, persistenceWrites: 0 })
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'FAILED',
      evidence: null,
      error: expect.stringContaining('qualification lock binding failed'),
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
        return Result.fail(
          riskBalancedTrendCompatibilityFailure('prepare', new Error('incomplete qualification must not evaluate')),
        )
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
        return Result.fail(
          riskBalancedTrendCompatibilityFailure(
            'prepare',
            new Error('corrupt recovery must not fall back to evaluation'),
          ),
        )
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
    expect(current.evidence).toMatchObject({
      startupMode: 'evaluated',
      evaluation: { runId: fixtureEvaluation.runId },
      reconciliation: { runId: fixtureEvaluation.runId, exact: true },
      persistence: { runId: fixtureEvaluation.runId },
      qualification: {
        runId: fixtureEvaluation.runId,
        resultHash: fixtureQualification.resultHash,
      },
    })
  })

  test('keeps dependency, lock, evaluation, journal, and persistence phases in fail-closed order', async () => {
    const calls: string[] = []
    const snapshot = makeSnapshot()
    const baseMarketData = marketDataService(Effect.succeed(snapshot), snapshot)
    const marketData = {
      ...baseMarketData,
      inspect: Effect.sync(() => calls.push('inspect')).pipe(Effect.andThen(baseMarketData.inspect)),
      load: Effect.sync(() => calls.push('load')).pipe(Effect.andThen(Effect.succeed(snapshot))),
    }
    const strategy: Strategy = {
      ...fixtureStrategy,
      prepareLock: (manifest, sessionDates, priorTrialRunIds) => {
        calls.push('prepare-lock')
        return fixtureStrategy.prepareLock(manifest, sessionDates, priorTrialRunIds)
      },
      evaluate: (bars, manifest) => {
        calls.push('evaluate')
        return fixtureStrategy.evaluate(bars, manifest)
      },
      analyze: (evaluation, priorTrialRunIds) => {
        calls.push('analyze')
        return fixtureStrategy.analyze(evaluation, priorTrialRunIds)
      },
    }
    const journal: JournalService = {
      ...successfulJournal,
      check: Effect.sync(() => calls.push('journal-check')),
      journalAndReconcile: (evaluation) =>
        Effect.sync(() => {
          calls.push('journal')
          return {
            runId: evaluation.runId,
            accountCount: evaluation.inputManifest.symbols.length + 5,
            transferCount: evaluation.events.length,
            exact: true as const,
          }
        }),
    }
    const store: EvidenceStoreService = {
      ...successfulEvidenceStore,
      check: Effect.sync(() => calls.push('database-check')),
      listPriorTrials: Effect.sync(() => {
        calls.push('list-prior-trials')
        return []
      }),
      openQualification: ({ lock }) =>
        Effect.sync(() => {
          calls.push('open-qualification')
          return { state: 'ACQUIRED' as const, lock }
        }),
      persist: ({ evaluation }) =>
        Effect.sync(() => {
          calls.push('persist')
          return {
            runId: evaluation.runId,
            deduplicated: false,
            artifactCount: 17,
            eventCount: evaluation.events.length,
            gateCount: evaluation.verdict.gates.length,
          }
        }),
    }
    const state = await Effect.runPromise(Ref.make(initialState()))

    await Effect.runPromise(
      initialize(config, state, strategy).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, store),
      ),
    )

    expect(calls).toEqual([
      'journal-check',
      'database-check',
      'inspect',
      'list-prior-trials',
      'prepare-lock',
      'open-qualification',
      'load',
      'evaluate',
      'journal',
      'analyze',
      'persist',
    ])
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
        Effect.provideService(CycleObservability, cycleObservability),
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
        Effect.provideService(CycleObservability, cycleObservability),
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
        Effect.provideService(CycleObservability, cycleObservability),
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
