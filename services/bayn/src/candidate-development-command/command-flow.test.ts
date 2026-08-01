import { describe, expect, test } from 'bun:test'
import {
  candidateDevelopmentExecutableProgramSchemaVersion,
  executeCandidateDevelopmentProgram,
  frozenCandidateDevelopmentSessions,
  officialMonthEndSignalDates,
  type CandidateDevelopmentExecutableProgram,
} from './test-api'
import { Effect, join, mkdtemp, pathToFileURL, rm, writeFile } from './test-runtime'
import {
  execFileResultPromise,
  fixtureStrategyProtocol,
  fixtureStrategyProtocolHash,
  fixtureVerifiedSource,
} from './test-support'

describe('candidate development command flow', () => {
  test('calls no effects when preflight rejects the ordinal lineage', async () => {
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const program: CandidateDevelopmentExecutableProgram<string, string, string, never> = {
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 14,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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

    const failure = await Effect.runPromise(
      Effect.flip(executeCandidateDevelopmentProgram(program, fixtureVerifiedSource)),
    )

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
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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

    expect(
      await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(program, fixtureVerifiedSource))),
    ).toBe('evaluation-stop')
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })

  test('renders the exact typed command failure to stderr before a nonzero exit', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.candidate-development-cli-failure-'))
    const scriptPath = join(directory, 'reproduce.ts')
    const commandUrl = pathToFileURL(join(import.meta.dir, '..', 'candidate-development-command.ts')).href
    const script = `
import { Data, Effect } from 'effect'
import { runCandidateDevelopmentCommandMain } from ${JSON.stringify(commandUrl)}

class CandidateDevelopmentEvaluationStageError extends Data.TaggedError('CandidateDevelopmentEvaluationStageError') {}

runCandidateDevelopmentCommandMain(
  Effect.fail({
    _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
    cause: new CandidateDevelopmentEvaluationStageError({
      stage: 'development-metrics',
      cause: {
        _tag: 'CandidateDevelopmentMetricsFailed',
        reason: 'metric-boundary-crossed',
        token: 'must-not-render',
        stack: '/workspace/private/stack.ts:1:1',
      },
      secret: 'must-not-render',
    }),
  }),
)
`

    try {
      await writeFile(scriptPath, script)
      const result = await execFileResultPromise(process.execPath, [scriptPath], import.meta.dir)
      const expected = `${JSON.stringify({
        schemaVersion: 'bayn.candidate-development-command-failure.v1',
        error: {
          _tag: 'CandidateDevelopmentCommandError',
          failure: {
            _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
            cause: {
              _tag: 'CandidateDevelopmentEvaluationStageError',
              stage: 'development-metrics',
              cause: {
                _tag: 'CandidateDevelopmentMetricsFailed',
                reason: 'metric-boundary-crossed',
              },
            },
          },
        },
      })}\n`

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
