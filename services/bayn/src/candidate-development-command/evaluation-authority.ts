import { pipe, Result } from 'effect'
import {
  candidateDevelopmentDoubledCostContract,
  type CandidateDevelopmentPreflightInput,
} from '../candidate-development'
import {
  candidate20PrecommitInvalidation,
  deriveCandidateDevelopmentLegacyPriorTrialsHash,
  deriveCandidateDevelopmentPriorTrialsHash,
  frozenCandidateDevelopmentTrialHistory,
  type CandidateDevelopmentTrialHistory,
} from '../candidate-development-trial-history'
import { type CandidateDevelopmentNextPreregistration } from '../candidate-development-decision'
import { canonicalHashV1Result } from '../hash'
import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentSourceManifest,
  CandidateDevelopmentVerifiedSource,
  CandidateDevelopmentVerifiedSourceFiles,
} from './contracts'
import { sourceVerificationFailure } from './evaluation-metrics'

export const expectedCandidateDevelopmentOrdinals = (
  completedCandidateCount: number,
  developmentCandidateCount: number,
  invalidPrecommitOrdinal: number | null,
): readonly number[] => {
  const ordinals: number[] = []
  let candidateOrdinal = completedCandidateCount + 1
  for (let index = 0; index < developmentCandidateCount; index += 1) {
    if (candidateOrdinal === invalidPrecommitOrdinal) candidateOrdinal += 1
    ordinals.push(candidateOrdinal)
    candidateOrdinal += 1
  }
  return ordinals
}

export const validateCandidateDevelopmentTrialHistoryClosure = (
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const invalidPrecommit = history.latestInvalidPrecommit
  if (invalidPrecommit === null) return Result.succeed(undefined)

  const expectedInvalidationHash = canonicalHashV1Result(candidate20PrecommitInvalidation)
  if (Result.isFailure(expectedInvalidationHash)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: expectedInvalidationHash.failure })
  }
  const observedInvalidationHash = canonicalHashV1Result(invalidPrecommit)
  if (Result.isFailure(observedInvalidationHash)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: observedInvalidationHash.failure })
  }
  if (expectedInvalidationHash.success !== observedInvalidationHash.success) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.latestInvalidPrecommit',
        expected: expectedInvalidationHash.success,
        observed: observedInvalidationHash.success,
      }),
    )
  }
  const expectedDevelopmentOrdinals = expectedCandidateDevelopmentOrdinals(
    history.completedCandidateOrdinals.length,
    history.developmentCandidateOrdinals.length,
    invalidPrecommit.candidateOrdinal,
  )
  for (let index = 0; index < expectedDevelopmentOrdinals.length; index += 1) {
    if (history.developmentCandidateOrdinals[index] !== expectedDevelopmentOrdinals[index]) {
      return Result.fail(
        sourceVerificationFailure('verify-attempt-authorization', {
          field: 'trialHistory.developmentCandidateOrdinals',
          index,
          expected: expectedDevelopmentOrdinals[index],
          observed: history.developmentCandidateOrdinals[index],
        }),
      )
    }
  }
  const latestDevelopmentOrdinal = history.developmentCandidateOrdinals.at(-1)
  if (latestDevelopmentOrdinal === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.developmentCandidateOrdinals',
        expected: 'at least one completed development-only candidate',
        observed: history.developmentCandidateOrdinals,
      }),
    )
  }
  if (
    history.latestDevelopmentEvidence.candidateOrdinal !== latestDevelopmentOrdinal ||
    history.latestDevelopmentEvidence.priorTrialCount !== latestDevelopmentOrdinal - 1 ||
    history.latestDevelopmentEvidence.qualificationAttemptConsumed
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.latestDevelopmentEvidence',
        expected: {
          candidateOrdinal: latestDevelopmentOrdinal,
          priorTrialCount: latestDevelopmentOrdinal - 1,
          qualificationAttemptConsumed: false,
        },
        observed: history.latestDevelopmentEvidence,
      }),
    )
  }
  const reviewed = history.latestReviewedCandidatePreregistration
  const next = history.nextCandidatePreregistration
  const latestClosedOrdinal = Math.max(latestDevelopmentOrdinal, invalidPrecommit.candidateOrdinal)
  if (next === null) {
    if (latestClosedOrdinal !== invalidPrecommit.candidateOrdinal) {
      if (reviewed.candidateOrdinal !== latestClosedOrdinal || reviewed.priorTrialCount !== latestClosedOrdinal - 1) {
        return Result.fail(
          sourceVerificationFailure('verify-attempt-authorization', {
            field: 'trialHistory.latestReviewedCandidatePreregistration.lineage',
            expected: {
              candidateOrdinal: latestClosedOrdinal,
              priorTrialCount: latestClosedOrdinal - 1,
            },
            observed: {
              candidateOrdinal: reviewed.candidateOrdinal,
              priorTrialCount: reviewed.priorTrialCount,
            },
          }),
        )
      }
      return Result.succeed(undefined)
    }
    const bindings = [
      ['candidateOrdinal', invalidPrecommit.candidateOrdinal, reviewed.candidateOrdinal],
      ['priorTrialCount', invalidPrecommit.priorTrialCount, reviewed.priorTrialCount],
      ['modulePath', invalidPrecommit.invalidatedModule.path, reviewed.modulePath],
      ['moduleSha256', invalidPrecommit.invalidatedModule.sha256, reviewed.moduleSha256],
      [
        'preregistration.sourceRevision',
        invalidPrecommit.preregistration.sourceRevision,
        reviewed.preregistration.sourceRevision,
      ],
      ['preregistration.path', invalidPrecommit.preregistration.path, reviewed.preregistration.path],
      ['preregistration.blobOid', invalidPrecommit.preregistration.blobOid, reviewed.preregistration.blobOid],
    ] as const
    for (const [field, expected, observed] of bindings) {
      if (expected !== observed) {
        return Result.fail(
          sourceVerificationFailure('verify-attempt-authorization', {
            field: `trialHistory.latestReviewedCandidatePreregistration.${field}`,
            expected,
            observed,
          }),
        )
      }
    }
    return Result.succeed(undefined)
  }
  const expectedNextOrdinal = latestClosedOrdinal + 1
  if (next.candidateOrdinal !== expectedNextOrdinal || next.priorTrialCount !== latestClosedOrdinal) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.nextCandidatePreregistration.lineage',
        expected: {
          candidateOrdinal: expectedNextOrdinal,
          priorTrialCount: latestClosedOrdinal,
        },
        observed: {
          candidateOrdinal: next.candidateOrdinal,
          priorTrialCount: next.priorTrialCount,
        },
      }),
    )
  }
  const reviewedHash = canonicalHashV1Result(reviewed)
  if (Result.isFailure(reviewedHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandHashFailed',
      cause: reviewedHash.failure,
    })
  }
  const nextHash = canonicalHashV1Result(next)
  if (Result.isFailure(nextHash)) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandHashFailed', cause: nextHash.failure })
  }
  if (reviewedHash.success !== nextHash.success) {
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        field: 'trialHistory.latestReviewedCandidatePreregistration',
        expected: nextHash.success,
        observed: reviewedHash.success,
      }),
    )
  }
  return Result.succeed(undefined)
}

export const authorizeCandidateDevelopmentAttempt = (
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<CandidateDevelopmentNextPreregistration, CandidateDevelopmentCommandFailure> => {
  const closure = validateCandidateDevelopmentTrialHistoryClosure(history)
  if (Result.isFailure(closure)) return Result.fail(closure.failure)
  if (history.nextCandidatePreregistration === null) {
    const invalid = history.latestInvalidPrecommit
    const latestDevelopmentOrdinal = history.developmentCandidateOrdinals.at(-1)
    if (
      invalid === null ||
      latestDevelopmentOrdinal === undefined ||
      latestDevelopmentOrdinal > invalid.candidateOrdinal
    ) {
      return Result.fail(
        sourceVerificationFailure('verify-attempt-authorization', {
          field: 'trialHistory.nextCandidatePreregistration',
          expected: 'a separately reviewed valid preregistration',
          observed: null,
          latestDevelopmentEvidence: history.latestDevelopmentEvidence,
        }),
      )
    }
    return Result.fail(
      sourceVerificationFailure('verify-attempt-authorization', {
        candidateOrdinal: invalid.candidateOrdinal,
        status: invalid.status,
        attemptStatus: invalid.attemptStatus,
        metricBearingAttemptsConsumed: invalid.metricBearingAttemptsConsumed,
        qualificationAttemptConsumed: invalid.qualificationAttemptConsumed,
        nextCandidatePreregistration: null,
      }),
    )
  }
  return Result.succeed(history.nextCandidatePreregistration)
}

export const validateCandidateDevelopmentPreregisteredMarketData = (
  expected: CandidateDevelopmentSourceManifest['marketData'],
  observed: CandidateDevelopmentSourceManifest['marketData'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const bindings = [
    ['schemaVersion', expected.schemaVersion, observed.schemaVersion],
    ['snapshotId', expected.snapshotId, observed.snapshotId],
    ['finalizedSnapshotContentHash', expected.finalizedSnapshotContentHash, observed.finalizedSnapshotContentHash],
    ['inputManifestHash', expected.inputManifestHash, observed.inputManifestHash],
    ['boundedContentHash', expected.boundedContentHash, observed.boundedContentHash],
  ] as const
  for (const [field, expectedValue, observedValue] of bindings) {
    if (expectedValue !== observedValue) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `trialHistory.nextCandidatePreregistration.marketData.${field}`,
          expected: expectedValue,
          observed: observedValue,
        }),
      )
    }
  }
  return Result.succeed(undefined)
}

export const bindCandidateDevelopmentVerifiedSource = (
  files: CandidateDevelopmentVerifiedSourceFiles,
  input: CandidateDevelopmentPreflightInput,
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<CandidateDevelopmentVerifiedSource, CandidateDevelopmentCommandFailure> => {
  const completedCandidateOrdinals = history.completedCandidateOrdinals
  for (let index = 0; index < completedCandidateOrdinals.length; index += 1) {
    if (completedCandidateOrdinals[index] !== index + 1) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: 'trialHistory.completedCandidateOrdinals',
          expected: index + 1,
          observed: completedCandidateOrdinals[index],
        }),
      )
    }
  }
  const latestTerminalEvidence = history.latestTerminalEvidence
  if (
    latestTerminalEvidence.candidateOrdinal !== completedCandidateOrdinals.length ||
    latestTerminalEvidence.priorTrialCount !== latestTerminalEvidence.candidateOrdinal - 1
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.latestTerminalEvidence',
        expected: {
          candidateOrdinal: completedCandidateOrdinals.length,
          priorTrialCount: completedCandidateOrdinals.length - 1,
        },
        observed: latestTerminalEvidence,
      }),
    )
  }
  const developmentCandidateOrdinals = history.developmentCandidateOrdinals
  const expectedDevelopmentOrdinals = expectedCandidateDevelopmentOrdinals(
    completedCandidateOrdinals.length,
    developmentCandidateOrdinals.length,
    history.latestInvalidPrecommit?.candidateOrdinal ?? null,
  )
  for (let index = 0; index < developmentCandidateOrdinals.length; index += 1) {
    const expected = expectedDevelopmentOrdinals[index]
    if (developmentCandidateOrdinals[index] !== expected) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: 'trialHistory.developmentCandidateOrdinals',
          expected,
          observed: developmentCandidateOrdinals[index],
        }),
      )
    }
  }
  const latestDevelopmentEvidence = history.latestDevelopmentEvidence
  const latestDevelopmentOrdinal = developmentCandidateOrdinals.at(-1)
  if (
    latestDevelopmentOrdinal === undefined ||
    latestDevelopmentEvidence.candidateOrdinal !== latestDevelopmentOrdinal ||
    latestDevelopmentEvidence.priorTrialCount !== latestDevelopmentOrdinal - 1 ||
    latestDevelopmentEvidence.qualificationAttemptConsumed !== false
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.latestDevelopmentEvidence',
        expected: {
          candidateOrdinal: latestDevelopmentOrdinal,
          priorTrialCount: latestDevelopmentOrdinal === undefined ? undefined : latestDevelopmentOrdinal - 1,
          qualificationAttemptConsumed: false,
        },
        observed: latestDevelopmentEvidence,
      }),
    )
  }
  const closure = validateCandidateDevelopmentTrialHistoryClosure(history)
  if (Result.isFailure(closure)) return Result.fail(closure.failure)
  const candidatePreregistration = history.latestReviewedCandidatePreregistration
  const priorTrialsHash =
    candidatePreregistration.candidateOrdinal >= 19
      ? deriveCandidateDevelopmentPriorTrialsHash(history.latestReviewedCandidatePriorTrials)
      : deriveCandidateDevelopmentLegacyPriorTrialsHash(history.latestReviewedCandidateLegacyPriorTrials)
  if (Result.isFailure(priorTrialsHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandHashFailed',
      cause: priorTrialsHash.failure,
    })
  }
  const expectedReviewedCandidateOrdinal =
    history.nextCandidatePreregistration?.candidateOrdinal ??
    (history.latestInvalidPrecommit === null
      ? latestDevelopmentOrdinal + 1
      : Math.max(latestDevelopmentOrdinal, history.latestInvalidPrecommit.candidateOrdinal))
  const expectedPriorTrialCount = expectedReviewedCandidateOrdinal - 1
  const reviewedBindings = [
    ['candidateOrdinal', expectedReviewedCandidateOrdinal, candidatePreregistration.candidateOrdinal],
    ['priorTrialCount', expectedPriorTrialCount, candidatePreregistration.priorTrialCount],
    ['input.candidateOrdinal', candidatePreregistration.candidateOrdinal, input.candidateOrdinal],
    ['input.priorTrialCount', candidatePreregistration.priorTrialCount, input.priorTrialCount],
    ['strategyProtocolHash', candidatePreregistration.strategyProtocolHash, input.expectedStrategyProtocolHash],
    ['priorTrialsHash', priorTrialsHash.success, candidatePreregistration.priorTrialsHash],
    ['modulePath', candidatePreregistration.modulePath, files.modulePath],
    ['moduleSha256', candidatePreregistration.moduleSha256, files.moduleSha256],
  ] as const
  for (const [field, expected, observed] of reviewedBindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `trialHistory.latestReviewedCandidatePreregistration.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  const marketDataBinding = validateCandidateDevelopmentPreregisteredMarketData(
    candidatePreregistration.marketData,
    files.sourceManifest.marketData,
  )
  if (Result.isFailure(marketDataBinding)) return Result.fail(marketDataBinding.failure)
  if (
    input.candidateOrdinal !== candidatePreregistration.candidateOrdinal ||
    input.priorTrialCount !== candidatePreregistration.priorTrialCount
  ) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.candidatePreregistration',
        expected: candidatePreregistration,
        observed: {
          candidateOrdinal: input.candidateOrdinal,
          priorTrialCount: input.priorTrialCount,
        },
      }),
    )
  }
  const manifest = files.sourceManifest
  const mismatches = [
    ['candidateOrdinal', input.candidateOrdinal, manifest.candidateOrdinal],
    ['priorTrialCount', input.priorTrialCount, manifest.priorTrialCount],
    ['strategyProtocolHash', input.expectedStrategyProtocolHash, manifest.strategyProtocolHash],
    ['strategyIdentityHash', candidatePreregistration.strategyIdentityHash, manifest.strategyIdentityHash],
    [
      'candidateDevelopmentProtocolHash',
      candidatePreregistration.candidateDevelopmentProtocolHash,
      manifest.candidateDevelopmentProtocolHash,
    ],
    ['calendarHash', candidatePreregistration.calendarHash, manifest.calendarHash],
    ['priorTrialsHash', candidatePreregistration.priorTrialsHash, manifest.priorTrialsHash],
    ['modulePath', files.modulePath, manifest.modulePath],
  ] as const
  for (const [field, expected, observed] of mismatches) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field,
          expected,
          observed,
        }),
      )
    }
  }
  return pipe(
    canonicalHashV1Result({
      schemaVersion: 'bayn.candidate-development-verified-run.v1',
      sourceRevision: files.sourceRevision,
      module: {
        path: files.modulePath,
        blobOid: files.moduleBlobOid,
        sha256: files.moduleSha256,
      },
      sourceManifest: {
        path: files.sourceManifestPath,
        blobOid: files.sourceManifestBlobOid,
        sha256: files.sourceManifestSha256,
      },
      trialHistory: frozenCandidateDevelopmentTrialHistory,
      input,
    }),
    Result.mapError((cause) => sourceVerificationFailure('derive-run-identity', cause)),
    Result.flatMap((baselineRunId) =>
      pipe(
        canonicalHashV1Result({
          schemaVersion: 'bayn.candidate-development-verified-stressed-run.v1',
          baselineRunId,
          costMultiplierMicros: candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
        }),
        Result.mapError((cause) => sourceVerificationFailure('derive-run-identity', cause)),
        Result.map(
          (stressedRunId): CandidateDevelopmentVerifiedSource => ({
            schemaVersion: 'bayn.candidate-development-verified-source.v1',
            sourceRevision: files.sourceRevision,
            modulePath: files.modulePath,
            moduleBlobOid: files.moduleBlobOid,
            moduleSha256: files.moduleSha256,
            sourceManifestPath: files.sourceManifestPath,
            sourceManifestBlobOid: files.sourceManifestBlobOid,
            sourceManifestSha256: files.sourceManifestSha256,
            sourceManifest: files.sourceManifest,
            baselineRunId,
            stressedRunId,
          }),
        ),
      ),
    ),
  )
}

export const preregisterCandidateDevelopmentAttempt = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  history: CandidateDevelopmentTrialHistory = frozenCandidateDevelopmentTrialHistory,
): Result.Result<string, CandidateDevelopmentCommandFailure> => {
  const authorization = authorizeCandidateDevelopmentAttempt(history)
  if (Result.isFailure(authorization)) return Result.fail(authorization.failure)
  const nextCandidatePreregistration = authorization.success
  const latestDevelopmentOrdinal = history.developmentCandidateOrdinals.at(-1)
  if (latestDevelopmentOrdinal === undefined) {
    return Result.fail(
      sourceVerificationFailure('verify-program-binding', {
        field: 'trialHistory.developmentCandidateOrdinals',
        expected: 'at least one completed development-only candidate after qualification ordinal 16',
        observed: history.developmentCandidateOrdinals,
      }),
    )
  }
  const priorTrialsHash = deriveCandidateDevelopmentPriorTrialsHash(history.latestReviewedCandidatePriorTrials)
  if (Result.isFailure(priorTrialsHash)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandHashFailed',
      cause: priorTrialsHash.failure,
    })
  }
  const sourceManifest = verifiedSource.sourceManifest
  const expectedCandidateOrdinal =
    Math.max(latestDevelopmentOrdinal, history.latestInvalidPrecommit?.candidateOrdinal ?? latestDevelopmentOrdinal) + 1
  const bindings = [
    ['candidateOrdinal', expectedCandidateOrdinal, nextCandidatePreregistration.candidateOrdinal],
    ['priorTrialCount', expectedCandidateOrdinal - 1, nextCandidatePreregistration.priorTrialCount],
    ['priorTrialsHash', priorTrialsHash.success, nextCandidatePreregistration.priorTrialsHash],
    ['source.candidateOrdinal', nextCandidatePreregistration.candidateOrdinal, sourceManifest.candidateOrdinal],
    ['source.priorTrialCount', nextCandidatePreregistration.priorTrialCount, sourceManifest.priorTrialCount],
    [
      'source.strategyProtocolHash',
      nextCandidatePreregistration.strategyProtocolHash,
      sourceManifest.strategyProtocolHash,
    ],
    [
      'source.strategyIdentityHash',
      nextCandidatePreregistration.strategyIdentityHash,
      sourceManifest.strategyIdentityHash,
    ],
    [
      'source.candidateDevelopmentProtocolHash',
      nextCandidatePreregistration.candidateDevelopmentProtocolHash,
      sourceManifest.candidateDevelopmentProtocolHash,
    ],
    ['source.calendarHash', nextCandidatePreregistration.calendarHash, sourceManifest.calendarHash],
    ['source.priorTrialsHash', nextCandidatePreregistration.priorTrialsHash, sourceManifest.priorTrialsHash],
    ['source.modulePath', nextCandidatePreregistration.modulePath, verifiedSource.modulePath],
    ['source.moduleSha256', nextCandidatePreregistration.moduleSha256, verifiedSource.moduleSha256],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(
        sourceVerificationFailure('verify-program-binding', {
          field: `trialHistory.nextCandidatePreregistration.${field}`,
          expected,
          observed,
        }),
      )
    }
  }
  const marketDataBinding = validateCandidateDevelopmentPreregisteredMarketData(
    nextCandidatePreregistration.marketData,
    sourceManifest.marketData,
  )
  if (Result.isFailure(marketDataBinding)) return Result.fail(marketDataBinding.failure)
  return Result.succeed(verifiedSource.sourceManifestSha256)
}
