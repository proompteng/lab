import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { frozenCandidateDevelopmentSessions } from './candidate-development-calendar'
import {
  buildCandidateDevelopmentCommandReport,
  candidateDevelopmentExecutableProgramSchemaVersion,
  executeCandidateDevelopmentProgram,
  renderCandidateDevelopmentCommandReport,
  validateCandidateDevelopmentExecutableProgram,
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

const reportFixture = (annualizedReturnDifferenceLowerBound: number): CandidateDevelopmentReport =>
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
          dailyMarks: [{ positions: [{ quantityMicros: '0' }] }],
        },
      },
    },
  }) as unknown as CandidateDevelopmentReport

const baselineFixture = (status: 'PASS' | 'FAIL_CLOSED' = 'PASS'): EvaluationResult =>
  ({
    verdict: { status },
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
    const { contentHash, ...material } = passing

    expect(passing.decision.status).toBe('PASS')
    expect(rejected.decision.status).toBe('HOLD_REJECT')
    expect(economicallyRejected.decision.status).toBe('HOLD_REJECT')
    expect(contentHash).toBe(successOf(canonicalHashV1Result(material)))
    expect(buildCandidateDevelopmentCommandReport(reportFixture(0.01), baselineFixture())).toEqual(
      Result.succeed(passing),
    )
    const rendered = renderCandidateDevelopmentCommandReport(passing)
    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(rendered)).toEqual(passing)
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
  })
})
