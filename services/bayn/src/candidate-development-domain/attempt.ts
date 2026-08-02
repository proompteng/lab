import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import { qualificationTailCapacityForOrdinal } from '../qualification-statistics'
import {
  candidateDevelopmentAttemptHorizon,
  candidateDevelopmentProtocol,
  candidateDevelopmentStatisticsPolicy,
} from './protocol'

export interface CandidateDevelopmentProtocolIdentity {
  readonly schemaVersion: 'bayn.candidate-development-protocol-identity.v2'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly featureLookbackSessions: number
  readonly candidateDevelopmentProtocolHash: string
}

export interface CandidateDevelopmentBootstrapTailCapacity {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly bootstrapSamples: number
  readonly adjustedOneSidedAlpha: number
  readonly tailSampleCount: number
  readonly minimumTailSamples: number
  readonly maximumCandidateOrdinal: number
}

export type CandidateDevelopmentAttemptIssue =
  | {
      readonly _tag: 'CandidateDevelopmentCandidateOrdinalInvalid'
      readonly candidateOrdinal: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentPriorTrialCountInvalid'
      readonly priorTrialCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentAttemptLineageMismatch'
      readonly candidateOrdinal: number
      readonly priorTrialCount: number
      readonly expectedCandidateOrdinal: number
    }
  | ({
      readonly _tag: 'CandidateDevelopmentBootstrapTailInfeasible'
    } & CandidateDevelopmentBootstrapTailCapacity)

export const bindCandidateDevelopmentAttempt = (
  candidateOrdinal: number,
  priorTrialCount: number,
): Result.Result<CandidateDevelopmentBootstrapTailCapacity, CandidateDevelopmentAttemptIssue> => {
  if (!Number.isSafeInteger(candidateOrdinal) || candidateOrdinal <= 0) {
    return Result.fail({ _tag: 'CandidateDevelopmentCandidateOrdinalInvalid', candidateOrdinal })
  }
  if (!Number.isSafeInteger(priorTrialCount) || priorTrialCount < 0) {
    return Result.fail({ _tag: 'CandidateDevelopmentPriorTrialCountInvalid', priorTrialCount })
  }

  const expectedCandidateOrdinal = priorTrialCount + 1
  if (candidateOrdinal !== expectedCandidateOrdinal) {
    return Result.fail({
      _tag: 'CandidateDevelopmentAttemptLineageMismatch',
      candidateOrdinal,
      priorTrialCount,
      expectedCandidateOrdinal,
    })
  }

  const tailCapacity = qualificationTailCapacityForOrdinal(candidateDevelopmentStatisticsPolicy, candidateOrdinal)
  const capacity = {
    candidateOrdinal,
    priorTrialCount,
    bootstrapSamples: candidateDevelopmentStatisticsPolicy.bootstrap.samples,
    adjustedOneSidedAlpha: tailCapacity.adjustedOneSidedAlpha,
    tailSampleCount: tailCapacity.tailSampleCount,
    minimumTailSamples: tailCapacity.minimumTailSamples,
    maximumCandidateOrdinal: candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal,
  }

  return candidateOrdinal <= candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal &&
    tailCapacity.tailSampleCount >= candidateDevelopmentStatisticsPolicy.confidence.minimumTailSamples
    ? Result.succeed(capacity)
    : Result.fail({ _tag: 'CandidateDevelopmentBootstrapTailInfeasible', ...capacity })
}

export const identifyCandidateDevelopmentProtocol = (
  attempt: CandidateDevelopmentBootstrapTailCapacity,
  featureLookbackSessions: number,
  expectedStrategyProtocolHash: string,
): Result.Result<CandidateDevelopmentProtocolIdentity, CanonicalHashFailure> => {
  const binding = {
    schemaVersion: 'bayn.candidate-development-protocol-binding.v2',
    protocol: candidateDevelopmentProtocol,
    attempt,
    featureLookbackSessions,
    expectedStrategyProtocolHash,
  }
  return canonicalHashV1Result(binding).pipe(
    Result.map((candidateDevelopmentProtocolHash) => ({
      schemaVersion: 'bayn.candidate-development-protocol-identity.v2' as const,
      candidateOrdinal: attempt.candidateOrdinal,
      priorTrialCount: attempt.priorTrialCount,
      featureLookbackSessions,
      candidateDevelopmentProtocolHash,
    })),
  )
}
