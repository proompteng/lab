import { describe, expect, test } from 'bun:test'
import {
  authorizeCandidateDevelopmentAttempt,
  bindCandidateDevelopmentVerifiedSource,
  candidateDevelopmentExecutableProgramSchemaVersion,
  canonicalHashV1,
  frozenCandidateDevelopmentTrialHistory,
  makeCandidateDevelopmentCommandReportWriter,
  preregisterCandidateDevelopmentAttempt,
  type CandidateDevelopmentNextPreregistration,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentTrialHistory,
  type CandidateDevelopmentVerifiedSourceFiles,
  validateCandidateDevelopmentExecutableProgram,
  validateCandidateDevelopmentTrialHistoryClosure,
  writeCandidateDevelopmentCommandReport,
} from './test-api'
import { Effect, Fiber, Result } from './test-runtime'
import {
  baselineFixture,
  buildFixtureReport,
  fixtureStrategyProtocol,
  fixtureStrategyProtocolHash,
  frozenSourceInput,
  frozenSourceModuleSha256,
  frozenSourceSourceManifest,
  frozenSourceVerifiedSourceFiles,
  reportFixture,
  successOf,
} from './test-support'

describe('candidate development runtime boundary', () => {
  test('cancels a blocked report output write on interruption', async () => {
    const report = successOf(buildFixtureReport(reportFixture(0.01), baselineFixture()))
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let completion: ((error?: Error | null) => void) | undefined
    let destroyed = false
    const writer = makeCandidateDevelopmentCommandReportWriter({
      write: (_renderedReport, callback) => {
        completion = callback
        resolveStarted?.()
        return false
      },
      destroy: (error) => {
        destroyed = true
        completion?.(error)
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* writeCandidateDevelopmentCommandReport(report, writer).pipe(Effect.forkChild)
        yield* Effect.promise(() => started)
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout('1 second'))
      }),
    )
    expect(destroyed).toBe(true)
  })

  test('requires the exact executable program shape before execution', () => {
    expect(validateCandidateDevelopmentExecutableProgram({})).toEqual(
      Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' }),
    )
    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        strategyProtocol: fixtureStrategyProtocol,
        input: {},
        effects: {},
      }),
    ).toEqual(Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' }))

    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        strategyProtocol: fixtureStrategyProtocol,
        input: {
          candidateOrdinal: 16,
          priorTrialCount: 15,
          expectedStrategyProtocolHash: fixtureStrategyProtocolHash,
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

  test('rejects strategy protocol bytes that disagree with the preregistered hash', () => {
    const changedProtocol = { ...fixtureStrategyProtocol, initialCapitalMicros: '1000001' }

    expect(
      validateCandidateDevelopmentExecutableProgram({
        schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
        strategyProtocol: changedProtocol,
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
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandProgramInvalid',
        reason: 'strategy-protocol-hash-mismatch',
        cause: {
          expected: fixtureStrategyProtocolHash,
          observed: canonicalHashV1(changedProtocol),
        },
      },
    })
  })

  test('derives baseline and stressed run identities from verified Git provenance', () => {
    const verified = successOf(
      bindCandidateDevelopmentVerifiedSource(frozenSourceVerifiedSourceFiles, frozenSourceInput),
    )
    const revisionDrift = successOf(
      bindCandidateDevelopmentVerifiedSource(
        { ...frozenSourceVerifiedSourceFiles, sourceRevision: 'e'.repeat(40) },
        frozenSourceInput,
      ),
    )

    expect(verified.baselineRunId).not.toBe(verified.stressedRunId)
    expect(revisionDrift.baselineRunId).not.toBe(verified.baselineRunId)
    expect(
      bindCandidateDevelopmentVerifiedSource(
        { ...frozenSourceVerifiedSourceFiles, moduleSha256: 'f'.repeat(64) },
        frozenSourceInput,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: {
          field: 'trialHistory.latestReviewedCandidatePreregistration.moduleSha256',
          expected: frozenSourceModuleSha256,
          observed: 'f'.repeat(64),
        },
      },
    })
    expect(
      bindCandidateDevelopmentVerifiedSource(
        {
          ...frozenSourceVerifiedSourceFiles,
          sourceManifest: { ...frozenSourceSourceManifest, candidateOrdinal: 21 },
        },
        frozenSourceInput,
      ),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-program-binding',
        cause: { field: 'candidateOrdinal', expected: 20, observed: 21 },
      },
    })
  })

  test('advances reviewed lineage past an unattempted invalid precommit without consuming an attempt', () => {
    const successorPreregistration: CandidateDevelopmentNextPreregistration = {
      ...frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      modulePath: 'services/bayn/src/strategy/synthetic-reviewed-successor/candidate-21.ts',
      moduleSha256: 'a'.repeat(64),
      preregistration: {
        sourceRevision: 'b'.repeat(40),
        path: 'services/bayn/candidates/ordinal-21-synthetic-reviewed-successor-preregistration.json',
        blobOid: 'c'.repeat(40),
      },
    }
    const successorHistory: CandidateDevelopmentTrialHistory = {
      ...frozenCandidateDevelopmentTrialHistory,
      latestReviewedCandidatePreregistration: successorPreregistration,
      nextCandidatePreregistration: successorPreregistration,
    }
    expect(validateCandidateDevelopmentTrialHistoryClosure(successorHistory)).toEqual(Result.succeed(undefined))
    expect(authorizeCandidateDevelopmentAttempt(successorHistory)).toEqual(Result.succeed(successorPreregistration))

    const successorInput: CandidateDevelopmentPreflightInput = {
      ...frozenSourceInput,
      candidateOrdinal: 21,
      priorTrialCount: 20,
    }
    const successorSourceManifest: CandidateDevelopmentSourceManifest = {
      ...frozenSourceSourceManifest,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      modulePath: successorPreregistration.modulePath,
      moduleSha256: successorPreregistration.moduleSha256,
    }
    const successorFiles: CandidateDevelopmentVerifiedSourceFiles = {
      ...frozenSourceVerifiedSourceFiles,
      modulePath: successorPreregistration.modulePath,
      moduleSha256: successorPreregistration.moduleSha256,
      sourceManifest: successorSourceManifest,
    }
    const verifiedSuccessor = successOf(
      bindCandidateDevelopmentVerifiedSource(successorFiles, successorInput, successorHistory),
    )
    expect(preregisterCandidateDevelopmentAttempt(verifiedSuccessor, successorHistory)).toEqual(
      Result.succeed(successorFiles.sourceManifestSha256),
    )
    expect(successorHistory.latestInvalidPrecommit).toMatchObject({
      candidateOrdinal: 20,
      status: 'PRECOMMIT_INVALID',
      attemptStatus: 'UNATTEMPTED',
      metricBearingAttemptsConsumed: 0,
      qualificationAttemptConsumed: false,
    })
    expect(successorHistory.developmentCandidateOrdinals).toEqual([17, 18, 19])

    expect(
      validateCandidateDevelopmentTrialHistoryClosure({
        ...successorHistory,
        nextCandidatePreregistration: { ...successorPreregistration, candidateOrdinal: 22 },
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-attempt-authorization',
        cause: {
          field: 'trialHistory.nextCandidatePreregistration.lineage',
          expected: { candidateOrdinal: 21, priorTrialCount: 20 },
          observed: { candidateOrdinal: 22, priorTrialCount: 20 },
        },
      },
    })

    const completedSuccessorEvidence = {
      ...successorHistory.latestDevelopmentEvidence,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      evidenceContentHash: 'd'.repeat(64),
      evaluatedSourceRevision: 'e'.repeat(40),
      failureStage: 'development-evaluation' as const,
      developmentMetricsObserved: true,
    }
    const completedSuccessorHistory: CandidateDevelopmentTrialHistory = {
      ...successorHistory,
      developmentCandidateOrdinals: [17, 18, 19, 21],
      latestDevelopmentEvidence: completedSuccessorEvidence,
      nextCandidatePreregistration: null,
    }
    expect(validateCandidateDevelopmentTrialHistoryClosure(completedSuccessorHistory)).toEqual(
      Result.succeed(undefined),
    )
    expect(authorizeCandidateDevelopmentAttempt(completedSuccessorHistory)).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-attempt-authorization',
        cause: {
          field: 'trialHistory.nextCandidatePreregistration',
          observed: null,
          latestDevelopmentEvidence: { candidateOrdinal: 21, priorTrialCount: 20 },
        },
      },
    })
    expect(
      validateCandidateDevelopmentTrialHistoryClosure({
        ...completedSuccessorHistory,
        developmentCandidateOrdinals: [17, 18, 19, 20, 21],
      }),
    ).toMatchObject({
      failure: {
        _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
        operation: 'verify-attempt-authorization',
        cause: {
          field: 'trialHistory.developmentCandidateOrdinals',
          index: 3,
          expected: 21,
          observed: 20,
        },
      },
    })

    const successorPriorTrials = {
      ...completedSuccessorHistory.latestReviewedCandidatePriorTrials,
      developmentCandidateOrdinals: [17, 18, 19, 21],
      latestDevelopmentEvidence: {
        candidateOrdinal: 21,
        priorTrialCount: 20,
        status: 'DEVELOPMENT_REJECTED' as const,
        evidenceContentHash: completedSuccessorEvidence.evidenceContentHash,
        qualificationAttemptConsumed: false as const,
      },
      latestReviewedPreregistration: successorPreregistration,
    }
    const candidate22Preregistration: CandidateDevelopmentNextPreregistration = {
      ...successorPreregistration,
      candidateOrdinal: 22,
      priorTrialCount: 21,
      priorTrialsHash: canonicalHashV1(successorPriorTrials),
      modulePath: 'services/bayn/src/strategy/synthetic-reviewed-successor/candidate-22.ts',
      moduleSha256: 'f'.repeat(64),
      preregistration: {
        sourceRevision: '1'.repeat(40),
        path: 'services/bayn/candidates/ordinal-22-synthetic-reviewed-successor-preregistration.json',
        blobOid: '2'.repeat(40),
      },
    }
    const candidate22History: CandidateDevelopmentTrialHistory = {
      ...completedSuccessorHistory,
      latestReviewedCandidatePriorTrials: successorPriorTrials,
      latestReviewedCandidatePreregistration: candidate22Preregistration,
      nextCandidatePreregistration: candidate22Preregistration,
    }
    expect(validateCandidateDevelopmentTrialHistoryClosure(candidate22History)).toEqual(Result.succeed(undefined))
    expect(authorizeCandidateDevelopmentAttempt(candidate22History)).toEqual(Result.succeed(candidate22Preregistration))
    const candidate22Input: CandidateDevelopmentPreflightInput = {
      ...frozenSourceInput,
      candidateOrdinal: 22,
      priorTrialCount: 21,
    }
    const candidate22SourceManifest: CandidateDevelopmentSourceManifest = {
      ...frozenSourceSourceManifest,
      candidateOrdinal: 22,
      priorTrialCount: 21,
      priorTrialsHash: candidate22Preregistration.priorTrialsHash,
      modulePath: candidate22Preregistration.modulePath,
      moduleSha256: candidate22Preregistration.moduleSha256,
    }
    const candidate22Files: CandidateDevelopmentVerifiedSourceFiles = {
      ...frozenSourceVerifiedSourceFiles,
      modulePath: candidate22Preregistration.modulePath,
      moduleSha256: candidate22Preregistration.moduleSha256,
      sourceManifest: candidate22SourceManifest,
    }
    const verifiedCandidate22 = successOf(
      bindCandidateDevelopmentVerifiedSource(candidate22Files, candidate22Input, candidate22History),
    )
    expect(preregisterCandidateDevelopmentAttempt(verifiedCandidate22, candidate22History)).toEqual(
      Result.succeed(candidate22Files.sourceManifestSha256),
    )
    expect(candidate22History.developmentCandidateOrdinals).toEqual([17, 18, 19, 21])
    expect(candidate22History.latestInvalidPrecommit).toMatchObject({
      candidateOrdinal: 20,
      metricBearingAttemptsConsumed: 0,
      qualificationAttemptConsumed: false,
    })
  })
})
