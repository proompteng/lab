import { describe, expect, test } from 'bun:test'
import {
  candidateDevelopmentExecutableProgramSchemaVersion,
  evaluateCandidateDevelopmentArtifact,
  executeCandidateDevelopmentProgram,
  frozenCandidateDevelopmentSessions,
  officialMonthEndSignalDates,
  type CandidateDevelopmentNextPreregistration,
  validateCandidateDevelopmentCommandEvaluation,
  validateCandidateDevelopmentExecutableProgram,
  validateCandidateDevelopmentPreregisteredMarketData,
  validateCandidateDevelopmentPreregistrationDocument,
} from './test-api'
import { Effect, Result } from './test-runtime'
import {
  baselineFixture,
  commandEvaluationFixture,
  fixtureOfficialSessions,
  fixtureSignalDecisions,
  fixtureSourceManifest,
  fixtureStrategyProtocol,
  fixtureStrategyProtocolHash,
  fixtureVerifiedSource,
  fixtureVerifiedSourceFiles,
  reportFixture,
  successOf,
} from './test-support'

describe('candidate development authorization policy', () => {
  test('rejects colluding trial counts before preregistration', async () => {
    const input = {
      candidateOrdinal: 1,
      priorTrialCount: 0,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions: fixtureOfficialSessions,
      signalSessionDates: fixtureSignalDecisions.map(({ signalDate }) => signalDate),
      featureLookbackSessions: 126,
    }
    const sourceManifest = {
      ...fixtureSourceManifest,
      candidateOrdinal: input.candidateOrdinal,
      priorTrialCount: input.priorTrialCount,
    }
    const verifiedFiles = { ...fixtureVerifiedSourceFiles, sourceManifest }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: (verifiedSource) => {
          if (
            verifiedSource.sourceRevision === '' ||
            verifiedSource.baselineRunId === '' ||
            verifiedSource.stressedRunId === ''
          ) return {}
          throw new Error('must not evaluate')
        },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, verifiedFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.latestReviewedCandidatePreregistration.input.candidateOrdinal',
          expected: 20,
          observed: 1,
        },
      },
    })
  })

  test('binds every preregistered market-data commitment to the source manifest', () => {
    expect(
      validateCandidateDevelopmentPreregisteredMarketData(
        fixtureSourceManifest.marketData,
        fixtureSourceManifest.marketData,
      ),
    ).toEqual(Result.succeed(undefined))

    for (const [field, observed] of [
      ['snapshotId', 'a'.repeat(64)],
      ['finalizedSnapshotContentHash', 'b'.repeat(64)],
      ['inputManifestHash', 'c'.repeat(64)],
      ['boundedContentHash', 'd'.repeat(64)],
    ] as const) {
      expect(
        validateCandidateDevelopmentPreregisteredMarketData(fixtureSourceManifest.marketData, {
          ...fixtureSourceManifest.marketData,
          [field]: observed,
        }),
      ).toMatchObject({
        failure: {
          _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
          operation: 'verify-program-binding',
          cause: {
            field: `trialHistory.nextCandidatePreregistration.marketData.${field}`,
            expected: fixtureSourceManifest.marketData[field],
            observed,
          },
        },
      })
    }
  })

  test('binds authorization to the exact preregistration document bytes', () => {
    const preregistration: CandidateDevelopmentNextPreregistration = {
      schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
      candidateOrdinal: 16,
      priorTrialCount: 15,
      strategyProtocolHash: fixtureStrategyProtocolHash,
      modulePath: fixtureSourceManifest.modulePath,
      moduleSha256: fixtureVerifiedSourceFiles.moduleSha256,
      marketData: fixtureSourceManifest.marketData,
      preregistration: {
        sourceRevision: '1'.repeat(40),
        path: 'candidate/preregistration.json',
        blobOid: '2'.repeat(40),
      },
    }
    const document = {
      schemaVersion: preregistration.schemaVersion,
      candidateOrdinal: preregistration.candidateOrdinal,
      priorTrialCount: preregistration.priorTrialCount,
      strategyProtocolHash: preregistration.strategyProtocolHash,
      modulePath: preregistration.modulePath,
      moduleSha256: preregistration.moduleSha256,
      marketData: preregistration.marketData,
    }

    expect(validateCandidateDevelopmentPreregistrationDocument(preregistration, document)).toEqual(
      Result.succeed(undefined),
    )
    expect(
      validateCandidateDevelopmentPreregistrationDocument(preregistration, {
        ...document,
        marketData: { ...document.marketData, boundedContentHash: 'f'.repeat(64) },
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-blob',
        cause: {
          field: 'marketData.boundedContentHash',
          expected: preregistration.marketData.boundedContentHash,
          observed: 'f'.repeat(64),
        },
      },
    })

    expect(
      validateCandidateDevelopmentPreregistrationDocument(preregistration, {
        ...document,
        moduleSha256: 'e'.repeat(64),
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-preregistration-blob',
        cause: {
          field: 'moduleSha256',
          expected: preregistration.moduleSha256,
          observed: 'e'.repeat(64),
        },
      },
    })
  })

  test('rejects consumed Candidate 16 before development evaluation', async () => {
    const officialSessions = frozenCandidateDevelopmentSessions()
    const input = {
      candidateOrdinal: 16,
      priorTrialCount: 15,
      expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
      officialSessions,
      signalSessionDates: officialMonthEndSignalDates(officialSessions),
      featureLookbackSessions: 126,
    }
    const source = `
      export const candidateDevelopmentArtifact = {
        schemaVersion: 'bayn.candidate-development-artifact.v1',
        input: ${JSON.stringify(input)},
        strategyProtocol: ${JSON.stringify(fixtureStrategyProtocol)},
        buildEvaluation: (verifiedSource) => {
          if (
            verifiedSource.sourceRevision === '' ||
            verifiedSource.baselineRunId === '' ||
            verifiedSource.stressedRunId === ''
          ) return {}
          throw new Error('consumed Candidate 16 must not evaluate')
        },
      }
    `
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

    expect(
      await Effect.runPromise(Effect.flip(evaluateCandidateDevelopmentArtifact(moduleUrl, fixtureVerifiedSourceFiles))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      cause: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.latestReviewedCandidatePreregistration.input.candidateOrdinal',
          expected: 20,
          observed: 16,
        },
      },
    })
  })

  test('preserves the protocol-valid zero-session feature lookback', () => {
    const program = validateCandidateDevelopmentExecutableProgram({
      schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
      strategyProtocol: fixtureStrategyProtocol,
      input: {
        candidateOrdinal: 16,
        priorTrialCount: 15,
        expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.succeed({ baseline: {} }),
        },
      }),
    )

    expect(
      await Effect.runPromise(Effect.flip(executeCandidateDevelopmentProgram(validated, fixtureVerifiedSource))),
    ).toMatchObject({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'evaluation-invalid',
    })
  })

  test('runtime-decodes the complete command evaluation witness', async () => {
    const sessions = frozenCandidateDevelopmentSessions()
    const report = reportFixture(0.01)
    const evaluation = commandEvaluationFixture(report, baselineFixture())
    const validated = successOf(
      validateCandidateDevelopmentExecutableProgram({
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
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () => Effect.succeed(evaluation),
        },
      }),
    )

    const direct = validateCandidateDevelopmentCommandEvaluation(evaluation)
    if (Result.isFailure(direct)) {
      const cause =
        direct.failure._tag === 'CandidateDevelopmentCommandProgramInvalid' ? direct.failure.cause : direct.failure
      throw new Error(`complete evaluation decode failed: ${String(cause)}`)
    }

    const decoded = await Effect.runPromise(
      validated.effects.evaluateDevelopment(undefined, undefined as never, fixtureVerifiedSource),
    )

    expect(decoded.accounting.schemaVersion).toBe('bayn.candidate-development-accounting-evidence.v2')
    expect(decoded.accounting.runId).toBe(evaluation.baseline.runId)
    expect(decoded.accounting.baselineSimulation.dailyMarks).toHaveLength(505)
  })
})
