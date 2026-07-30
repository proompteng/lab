import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Result } from 'effect'

import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import {
  buildCandidateDevelopmentCommandReport,
  candidateDevelopmentExecutableProgramSchemaVersion,
  executeCandidateDevelopmentProgram,
  loadCandidateDevelopmentExecutableProgram,
  renderCandidateDevelopmentCommandReport,
  validateCandidateDevelopmentExecutableProgram,
  writeCandidateDevelopmentCommandReport,
  type CandidateDevelopmentExecutableProgram,
} from './candidate-development-command'
import { officialMonthEndSignalDates, type CandidateDevelopmentReport } from './candidate-development'
import { canonicalHashV1Result } from './hash'
import type { EvaluationResult } from './types'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected Result success')
  return result.success
}

const doubledCostAnnualizedReturn = (endingEquityMicros: string): number =>
  Math.pow(Number(endingEquityMicros) / 1_000_000, 252 / 2) - 1

const reportFixture = (
  annualizedReturnDifferenceLowerBound: number,
  stressedEndingEquityMicros = '1010000',
): CandidateDevelopmentReport =>
  ({
    schemaVersion: 'bayn.candidate-development-report.v2',
    protocolIdentity: {
      schemaVersion: 'bayn.candidate-development-protocol-identity.v2',
      candidateOrdinal: 16,
      priorTrialCount: 15,
      featureLookbackSessions: 126,
      candidateDevelopmentProtocolHash: 'a'.repeat(64),
    },
    comparisonSemantics: {
      strategyProtocolHash: 'b'.repeat(64),
      analysis: {
        power: { sufficient: true },
        bootstrap: {
          selectedBenchmark: 'buy-and-hold',
          tailResolutionSufficient: true,
          tailSampleCount: 31,
          minimumTailSamples: 20,
          annualizedReturnDifferenceLowerBound,
          sharpeDifferenceLowerBound: 0.01,
        },
        walkForward: {
          folds: [{ maximumDrawdown: 0.1, drawdownWithinLimit: true }],
          requiredFolds: 1,
          positiveFoldFraction: 1,
          requiredPositiveFoldFraction: 0.6,
          allDrawdownsWithinLimit: true,
          maximumFoldDrawdown: 0.1,
          sufficient: true,
        },
      },
    },
    doubledCost: {
      stressed: {
        simulation: {
          dailyMarks: [
            { equityMicros: '1000000', positions: [{ quantityMicros: '0' }] },
            { equityMicros: stressedEndingEquityMicros, positions: [{ quantityMicros: '0' }] },
          ],
        },
      },
    },
  }) as unknown as CandidateDevelopmentReport

const baselineFixture = (
  status: 'PASS' | 'FAIL_CLOSED' = 'PASS',
  stressedEndingEquityMicros = '1010000',
): EvaluationResult =>
  ({
    initialCapitalMicros: '1000000',
    doubleCostStrategy: {
      annualizedReturn: doubledCostAnnualizedReturn(stressedEndingEquityMicros),
    },
    verdict: {
      status,
      gates: [
        {
          name: 'economic-fixture',
          passed: status === 'PASS',
          actual: status === 'PASS',
          required: true,
        },
      ],
    },
    simulation: {
      dailyMarks: [{ positions: [{ quantityMicros: '0' }] }],
    },
  }) as unknown as EvaluationResult

describe('candidate development command', () => {
  test('calls no effects when preflight rejects the ordinal lineage', async () => {
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const program: CandidateDevelopmentExecutableProgram<string, string, string, never> = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 14,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => {
          preregistrations += 1
          return Effect.succeed('registration')
        },
        loadDevelopmentData: () => {
          loads += 1
          return Effect.succeed('data')
        },
        evaluateDevelopment: () => {
          evaluations += 1
          return Effect.fail('unexpected-evaluation')
        },
      },
    }

    const failure = await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program)))

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentPreflightInvalid',
      cause: {
        _tag: 'CandidateDevelopmentAttemptLineageMismatch',
        candidateOrdinal: 16,
        priorTrialCount: 14,
        expectedCandidateOrdinal: 15,
      },
    })
    expect(preregistrations).toBe(0)
    expect(loads).toBe(0)
    expect(evaluations).toBe(0)
  })

  test('calls preregistration, loading, and evaluation exactly once after passing preflight', async () => {
    const sessions = frozenCandidateDevelopmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const program: CandidateDevelopmentExecutableProgram<string, string, string, never> = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: sessions,
        signalSessionDates: officialMonthEndSignalDates(sessions),
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => {
          preregistrations += 1
          return Effect.succeed('registration')
        },
        loadDevelopmentData: () => {
          loads += 1
          return Effect.succeed('data')
        },
        evaluateDevelopment: () => {
          evaluations += 1
          return Effect.fail('evaluation-stop')
        },
      },
    }

    expect(await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program)))).toBe('evaluation-stop')
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })

  test('derives the disposition and hashes the complete governed report', () => {
    const passing = successOf(buildCandidateDevelopmentCommandReport(reportFixture(0.01), baselineFixture()))
    const rejected = successOf(buildCandidateDevelopmentCommandReport(reportFixture(-0.01), baselineFixture()))
    const economicallyRejected = successOf(
      buildCandidateDevelopmentCommandReport(reportFixture(0.01), baselineFixture('FAIL_CLOSED')),
    )
    const doubledCostRejected = successOf(
      buildCandidateDevelopmentCommandReport(reportFixture(0.01, '1000000'), baselineFixture('PASS', '1000000')),
    )
    const { contentHash, ...material } = passing

    expect(passing.decision.status).toBe('PASS')
    expect(rejected.decision.status).toBe('HOLD_REJECT')
    expect(economicallyRejected.decision.status).toBe('HOLD_REJECT')
    expect(doubledCostRejected.decision.status).toBe('HOLD_REJECT')
    expect(doubledCostRejected.decision.gates).toContainEqual({
      name: 'double_cost_return',
      passed: false,
      actual: 0,
      required: 0,
    })
    expect(passing.decision.gates.map(({ name }) => name)).toContain('annualized_excess_return_lower_bound')
    expect(passing.decision.gates.map(({ name }) => name)).not.toContain('annualized_return_difference_lower_bound')
    expect(contentHash).toBe(successOf(canonicalHashV1Result(material)))
    expect(buildCandidateDevelopmentCommandReport(reportFixture(0.01), baselineFixture())).toEqual(
      Result.succeed(passing),
    )
    const rendered = renderCandidateDevelopmentCommandReport(passing)
    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(rendered)).toEqual(passing)
  })

  test('rejects detached doubled-cost summary metrics', () => {
    const baseline = baselineFixture()
    const detached = {
      ...baseline,
      doubleCostStrategy: { ...baseline.doubleCostStrategy, annualizedReturn: 0.5 },
    }

    expect(buildCandidateDevelopmentCommandReport(reportFixture(0.01), detached)).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentCommandDoubledCostSeriesInvalid',
        reason: 'baseline-summary-mismatch',
        observed: 0.5,
      },
    })
  })

  test('rejects an economic summary status that disagrees with its gates', () => {
    const baseline = baselineFixture()
    const inconsistent = {
      ...baseline,
      verdict: {
        status: 'PASS' as const,
        gates: [{ name: 'failed-economic-gate', passed: false, actual: false, required: true }],
      },
    }

    expect(buildCandidateDevelopmentCommandReport(reportFixture(0.01), inconsistent)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid',
        expectedStatus: 'FAIL_CLOSED',
        observedStatus: 'PASS',
        failedGateNames: ['failed-economic-gate'],
      }),
    )
  })

  test('keeps the sole report write attached through interruption', async () => {
    const report = successOf(buildCandidateDevelopmentCommandReport(reportFixture(0.01), baselineFixture()))

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let completed = false
        const fiber = yield* writeCandidateDevelopmentCommandReport(report, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
          ),
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(interruption.pollUnsafe()).toBeUndefined()
        expect(completed).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interruption)

        expect(completed).toBe(true)
      }),
    )
  })

  test('requires the exact executable program shape before execution', () => {
    expect(validateCandidateDevelopmentExecutableProgram({})).toEqual(
      Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' }),
    )
    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {},
        effects: {},
      }),
    ).toEqual(Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' }))

    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: 'a'.repeat(64),
          signalSessionDates: [],
          featureLookbackSessions: 126,
        },
        effects: {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.fail('not-executed'),
        },
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'input-invalid',
      },
    })
  })

  test('preserves the protocol-valid zero-session feature lookback', () => {
    const program = validateCandidateDevelopmentExecutableProgram({
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 0,
      },
      effects: {
        preregisterCandidate: () => Effect.succeed('registration'),
        loadDevelopmentData: () => Effect.succeed('data'),
        evaluateDevelopment: () => Effect.fail('not-executed'),
      },
    })

    expect(program).toMatchObject({
      _tag: 'Success',
      success: { input: { featureLookbackSessions: 0 } },
    })
  })

  test('rejects malformed loaded evaluation output through the typed command channel', async () => {
    const sessions = frozenCandidateDevelopmentSessions()
    const validated = successOf(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: 'a'.repeat(64),
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: 126,
        },
        effects: {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.succeed({ baseline: {} }),
        },
      }),
    )

    expect(await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(validated)))).toMatchObject({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'evaluation-invalid',
    })
  })

  test('keeps dynamic module evaluation attached through interruption', async () => {
    const program = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: 'a'.repeat(64),
        officialSessions: [],
        signalSessionDates: [],
        featureLookbackSessions: 126,
      },
      effects: {
        preregisterCandidate: () => Effect.succeed('registration'),
        loadDevelopmentData: () => Effect.succeed('data'),
        evaluateDevelopment: () => Effect.fail('not-executed'),
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let completed = false
        const fiber = yield* loadCandidateDevelopmentExecutableProgram('/tmp/candidate-development-program.ts', () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
            Effect.as({ candidateDevelopmentProgram: program }),
          ),
        ).pipe(Effect.forkChild)

        yield* Deferred.await(started)
        const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(interruption.pollUnsafe()).toBeUndefined()
        expect(completed).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interruption)

        expect(completed).toBe(true)
      }),
    )
  })
})
