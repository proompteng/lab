import { Result } from 'effect'

import type {
  CandidateDevelopmentActiveTrial,
  CandidateDevelopmentAttemptConsumption,
  CandidateDevelopmentClosedTrial,
  CandidateDevelopmentDevelopmentTerminalEvidence,
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentQualificationAttempt,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
  CandidateDevelopmentTrialStateIssueReason,
} from './model'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isHex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const stateIssue = (
  path: string,
  reason: CandidateDevelopmentTrialStateIssueReason,
  observed?: unknown,
  expected?: unknown,
): CandidateDevelopmentTrialStateIssue => ({
  _tag: 'CandidateDevelopmentTrialStateInvalid',
  reason,
  path,
  ...(expected === undefined ? {} : { expected }),
  ...(observed === undefined ? {} : { observed }),
})

const failure = (
  path: string,
  reason: CandidateDevelopmentTrialStateIssueReason,
  observed?: unknown,
  expected?: unknown,
): Result.Result<never, CandidateDevelopmentTrialStateIssue> =>
  Result.fail(stateIssue(path, reason, observed, expected))

export const equalOrdinalSequence = (observed: readonly number[], start: number): number | null => {
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index] !== start + index) return start + index
  }
  return null
}

const isStrictlyIncreasing = (ordinals: readonly number[]): boolean =>
  ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]!)

const sameOrdinals = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((ordinal, index) => ordinal === right[index])

const validateOrdinalAndPriorCount = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isPositiveInteger(value.candidateOrdinal)) return stateIssue(`${path}.candidateOrdinal`, 'ORDINAL_NOT_POSITIVE')
  if (value.priorTrialCount !== value.candidateOrdinal - 1) {
    return stateIssue(
      `${path}.priorTrialCount`,
      'PRIOR_TRIAL_COUNT_MISMATCH',
      value.priorTrialCount,
      value.candidateOrdinal - 1,
    )
  }
  return undefined
}

export const validateNextPreregistration = (
  value: unknown,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-next-preregistration.v1') {
    return stateIssue(
      `${path}.schemaVersion`,
      'SCHEMA_VERSION_MISMATCH',
      value.schemaVersion,
      'bayn.candidate-development-next-preregistration.v1',
    )
  }
  const identityIssue = validateOrdinalAndPriorCount(value, path)
  if (identityIssue !== undefined) return identityIssue
  if (!isHex(value.strategyProtocolHash, 64) || !isNonEmptyString(value.modulePath) || !isHex(value.moduleSha256, 64)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  for (const [field, observed] of [
    ['strategyIdentityHash', value.strategyIdentityHash],
    ['candidateDevelopmentProtocolHash', value.candidateDevelopmentProtocolHash],
    ['calendarHash', value.calendarHash],
    ['priorTrialsHash', value.priorTrialsHash],
  ] as const) {
    if (observed !== undefined && !isHex(observed, 64))
      return stateIssue(`${path}.${field}`, 'MALFORMED_HISTORY', observed)
  }
  if (!isRecord(value.marketData) || !isRecord(value.preregistration)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  if (
    value.marketData.schemaVersion !== 'bayn.candidate-development-market-data-source.v1' ||
    !isHex(value.marketData.snapshotId, 64) ||
    !isHex(value.marketData.finalizedSnapshotContentHash, 64) ||
    !isHex(value.marketData.inputManifestHash, 64) ||
    !isHex(value.marketData.boundedContentHash, 64)
  ) {
    return stateIssue(`${path}.marketData`, 'MALFORMED_HISTORY', value.marketData)
  }
  if (
    !isHex(value.preregistration.sourceRevision, 40) ||
    !isNonEmptyString(value.preregistration.path) ||
    !isHex(value.preregistration.blobOid, 40)
  ) {
    return stateIssue(`${path}.preregistration`, 'MALFORMED_HISTORY', value.preregistration)
  }
  return undefined
}

const hasInvalidationFindings = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 5 &&
  value[0] === 'TYPE_CHECK_DISABLED' &&
  value[1] === 'DOWNCOMPILED_BUNDLE' &&
  value[2] === 'EMBEDDED_OFFICIAL_SESSIONS' &&
  value[3] === 'EMBEDDED_MARKET_BARS' &&
  value[4] === 'RUNTIME_INPUT_IGNORED'

export const validateInvalidation = (value: unknown, path: string): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-precommit-invalidation.v1') {
    return stateIssue(`${path}.schemaVersion`, 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  if (
    value.status !== 'PRECOMMIT_INVALID' ||
    value.attemptStatus !== 'UNATTEMPTED' ||
    value.metricBearingAttemptsConsumed !== 0 ||
    value.qualificationAttemptConsumed !== false ||
    value.nextCandidatePreregistration !== null
  ) {
    return stateIssue(path, 'INVALIDATION_NOT_IMMUTABLE', value)
  }
  const identityIssue = validateOrdinalAndPriorCount(value, path)
  if (identityIssue !== undefined) return identityIssue
  if (!isNonEmptyString(value.reviewedHeadRevision) || !isNonEmptyString(value.mergedSourceRevision)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  const preregistration = isRecord(value.preregistration) ? value.preregistration : undefined
  const sourceManifest = isRecord(value.sourceManifest) ? value.sourceManifest : undefined
  const invalidatedModule = isRecord(value.invalidatedModule) ? value.invalidatedModule : undefined
  const naturalBuild = isRecord(value.naturalBuild) ? value.naturalBuild : undefined
  const release = isRecord(value.release) ? value.release : undefined
  if (
    preregistration === undefined ||
    sourceManifest === undefined ||
    invalidatedModule === undefined ||
    naturalBuild === undefined ||
    release === undefined
  ) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  if (
    !isHex(preregistration.sourceRevision, 40) ||
    !isNonEmptyString(preregistration.path) ||
    !isHex(preregistration.blobOid, 40) ||
    !isHex(preregistration.sha256, 64) ||
    !isNonEmptyString(sourceManifest.path) ||
    !isHex(sourceManifest.blobOid, 40) ||
    !isHex(sourceManifest.sha256, 64) ||
    !isNonEmptyString(invalidatedModule.path) ||
    !isHex(invalidatedModule.blobOid, 40) ||
    !isHex(invalidatedModule.sha256, 64)
  ) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  if (
    naturalBuild.imagePublished !== true ||
    naturalBuild.deploymentAllowed !== false ||
    !isNonEmptyString(naturalBuild.runId) ||
    typeof naturalBuild.imageDigest !== 'string' ||
    !naturalBuild.imageDigest.startsWith('sha256:') ||
    !isHex(naturalBuild.imageDigest.slice('sha256:'.length), 64) ||
    !isNonNegativeInteger(invalidatedModule.lineCount) ||
    !isNonNegativeInteger(invalidatedModule.byteCount) ||
    !hasInvalidationFindings(invalidatedModule.findings) ||
    release.conclusion !== 'CANCELLED' ||
    release.promotionCompleted !== false ||
    release.rerunAllowed !== false ||
    !isNonEmptyString(release.runId)
  ) {
    return stateIssue(path, 'INVALIDATION_NOT_IMMUTABLE', value)
  }
  return undefined
}

/** Validates the old attempt facade for existing type-only callers. */
export const validateAttempt = (value: unknown, path: string): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  switch (value._tag) {
    case 'UNATTEMPTED':
      return value.attemptCount === 0 &&
        value.metricBearingAttemptsConsumed === 0 &&
        value.qualificationAttemptConsumed === false
        ? undefined
        : stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
    case 'DEVELOPMENT_ONLY_ATTEMPT':
      return value.attemptCount === 1 &&
        (value.metricBearingAttemptsConsumed === null ||
          value.metricBearingAttemptsConsumed === 0 ||
          value.metricBearingAttemptsConsumed === 1) &&
        value.qualificationAttemptConsumed === false
        ? undefined
        : stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
    case 'QUALIFICATION_ATTEMPT':
      return value.attemptCount === 1 &&
        value.metricBearingAttemptsConsumed === 1 &&
        value.qualificationAttemptConsumed === true
        ? undefined
        : stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
    default:
      return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
}

export const validateDevelopmentTerminalEvidence = (
  value: unknown,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'TERMINAL_STATE_MISMATCH', value)
  if (
    !isNonEmptyString(value.evidenceContentHash) ||
    (value.evaluatedSourceRevision !== undefined && !isNonEmptyString(value.evaluatedSourceRevision)) ||
    (value.failureStage !== undefined &&
      value.failureStage !== 'buildEvaluation-preflight' &&
      value.failureStage !== 'development-evaluation') ||
    (value.developmentMetricsObserved !== undefined && typeof value.developmentMetricsObserved !== 'boolean')
  ) {
    return stateIssue(path, 'TERMINAL_STATE_MISMATCH', value)
  }
  return undefined
}

export const validateQualificationTerminalEvidence = (
  value: unknown,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value) || value.terminalStatus !== 'HOLD_REJECT' || !isNonEmptyString(value.sourceRevision)) {
    return stateIssue(path, 'TERMINAL_STATE_MISMATCH', value)
  }
  return undefined
}

const validateQualificationEvidence = (
  value: unknown,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (
    !isPositiveInteger(value.candidateOrdinal) ||
    value.priorTrialCount !== value.candidateOrdinal - 1 ||
    value.terminalStatus !== 'HOLD_REJECT' ||
    !isNonEmptyString(value.sourceRevision)
  ) {
    return stateIssue(path, 'LATEST_EVIDENCE_MISMATCH', value)
  }
  return undefined
}

const validateQualificationPreregistration = (
  value: unknown,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (
    !isPositiveInteger(value.candidateOrdinal) ||
    value.priorTrialCount !== value.candidateOrdinal - 1 ||
    !isNonEmptyString(value.sourceRevision) ||
    !isNonEmptyString(value.path) ||
    !isNonEmptyString(value.blobOid)
  ) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  return undefined
}

const validateHistoryDevelopmentEvidence = (
  value: unknown,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (
    !isPositiveInteger(value.candidateOrdinal) ||
    value.priorTrialCount !== value.candidateOrdinal - 1 ||
    value.status !== 'DEVELOPMENT_REJECTED' ||
    !isNonEmptyString(value.evidenceContentHash) ||
    !isNonEmptyString(value.evaluatedSourceRevision) ||
    (value.reviewedSourceRevision !== undefined && !isNonEmptyString(value.reviewedSourceRevision)) ||
    (value.mergedSourceRevision !== undefined && !isNonEmptyString(value.mergedSourceRevision)) ||
    (value.failureStage !== undefined &&
      value.failureStage !== 'buildEvaluation-preflight' &&
      value.failureStage !== 'development-evaluation') ||
    (value.developmentMetricsObserved !== undefined && typeof value.developmentMetricsObserved !== 'boolean') ||
    value.qualificationAttemptConsumed !== false
  ) {
    return stateIssue(path, 'LATEST_EVIDENCE_MISMATCH', value)
  }
  return undefined
}

const validateHistoryOrdinals = (
  history: CandidateDevelopmentTrialHistory,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const { completedCandidateOrdinals: completed, developmentCandidateOrdinals: development } = history
  if (
    !completed.every(isPositiveInteger) ||
    !development.every(isPositiveInteger) ||
    !isStrictlyIncreasing(completed) ||
    !isStrictlyIncreasing(development)
  ) {
    return stateIssue('history.ordinals', 'ORDINAL_SEQUENCE_GAP', { completed, development })
  }
  const invalidOrdinal = history.latestInvalidPrecommit?.candidateOrdinal ?? null
  const allClosed = [...completed, ...development, ...(invalidOrdinal === null ? [] : [invalidOrdinal])]
  const seen = new Set<number>()
  for (const ordinal of allClosed) {
    if (seen.has(ordinal)) return stateIssue('history.ordinals', 'ORDINAL_OVERLAP', allClosed)
    seen.add(ordinal)
  }
  const sorted = [...allClosed].sort((left, right) => left - right)
  const sequenceIssue = equalOrdinalSequence(sorted, 1)
  if (sequenceIssue !== null) return stateIssue('history.ordinals', 'ORDINAL_SEQUENCE_GAP', sorted, '1..n')
  return undefined
}

const validateMaterial = (
  value: unknown,
  path: string,
  schemaVersion: 'bayn.candidate-development-prior-trials.v1' | 'bayn.candidate-development-prior-trials.v2',
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value) || value.schemaVersion !== schemaVersion) {
    return stateIssue(`${path}.schemaVersion`, 'SCHEMA_VERSION_MISMATCH', isRecord(value) ? value.schemaVersion : value)
  }
  if (
    !Array.isArray(value.qualificationCandidateOrdinals) ||
    !Array.isArray(value.developmentCandidateOrdinals) ||
    !value.qualificationCandidateOrdinals.every(isPositiveInteger) ||
    !value.developmentCandidateOrdinals.every(isPositiveInteger) ||
    !isStrictlyIncreasing(value.qualificationCandidateOrdinals as number[]) ||
    !isStrictlyIncreasing(value.developmentCandidateOrdinals as number[])
  ) {
    return stateIssue(`${path}.ordinals`, 'ORDINAL_SEQUENCE_GAP', value)
  }
  const qualificationOrdinals = value.qualificationCandidateOrdinals as number[]
  const developmentOrdinals = value.developmentCandidateOrdinals as number[]
  if (qualificationOrdinals.some((ordinal) => developmentOrdinals.includes(ordinal))) {
    return stateIssue(`${path}.ordinals`, 'ORDINAL_OVERLAP', value)
  }
  if (
    !isRecord(value.latestDevelopmentEvidence) ||
    validateNextPreregistration(value.latestReviewedPreregistration, `${path}.latestReviewedPreregistration`) !==
      undefined
  ) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  const development = value.latestDevelopmentEvidence
  if (
    !isPositiveInteger(development.candidateOrdinal) ||
    development.priorTrialCount !== development.candidateOrdinal - 1 ||
    development.status !== 'DEVELOPMENT_REJECTED' ||
    !isNonEmptyString(development.evidenceContentHash) ||
    development.qualificationAttemptConsumed !== false
  ) {
    return stateIssue(`${path}.latestDevelopmentEvidence`, 'LATEST_EVIDENCE_MISMATCH', development)
  }
  if (
    !isRecord(value.latestReviewedPreregistration) ||
    value.latestReviewedPreregistration.candidateOrdinal !== development.candidateOrdinal
  ) {
    return stateIssue(
      `${path}.latestReviewedPreregistration`,
      'LATEST_EVIDENCE_MISMATCH',
      value.latestReviewedPreregistration,
    )
  }
  if (schemaVersion === 'bayn.candidate-development-prior-trials.v2') {
    const qualificationEvidence = value.latestQualificationEvidence
    const qualificationPreregistration = value.latestQualificationPreregistration
    if (
      validateQualificationEvidence(qualificationEvidence, `${path}.latestQualificationEvidence`) !== undefined ||
      validateQualificationPreregistration(
        qualificationPreregistration,
        `${path}.latestQualificationPreregistration`,
      ) !== undefined ||
      !isRecord(qualificationEvidence) ||
      !isRecord(qualificationPreregistration) ||
      qualificationEvidence.candidateOrdinal !== qualificationPreregistration.candidateOrdinal
    ) {
      return stateIssue(`${path}.latestQualificationEvidence`, 'LATEST_EVIDENCE_MISMATCH', qualificationEvidence)
    }
  }
  return undefined
}

const sameNextPreregistration = (
  left: CandidateDevelopmentNextPreregistration,
  right: CandidateDevelopmentNextPreregistration,
): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.candidateOrdinal === right.candidateOrdinal &&
  left.priorTrialCount === right.priorTrialCount &&
  left.strategyProtocolHash === right.strategyProtocolHash &&
  left.strategyIdentityHash === right.strategyIdentityHash &&
  left.candidateDevelopmentProtocolHash === right.candidateDevelopmentProtocolHash &&
  left.calendarHash === right.calendarHash &&
  left.priorTrialsHash === right.priorTrialsHash &&
  left.modulePath === right.modulePath &&
  left.moduleSha256 === right.moduleSha256 &&
  left.marketData.schemaVersion === right.marketData.schemaVersion &&
  left.marketData.snapshotId === right.marketData.snapshotId &&
  left.marketData.finalizedSnapshotContentHash === right.marketData.finalizedSnapshotContentHash &&
  left.marketData.inputManifestHash === right.marketData.inputManifestHash &&
  left.marketData.boundedContentHash === right.marketData.boundedContentHash &&
  left.preregistration.sourceRevision === right.preregistration.sourceRevision &&
  left.preregistration.path === right.preregistration.path &&
  left.preregistration.blobOid === right.preregistration.blobOid

const validateHistoryEnvelope = (
  value: unknown,
): Result.Result<CandidateDevelopmentTrialHistory, CandidateDevelopmentTrialStateIssue> => {
  if (!isRecord(value)) return failure('history', 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-trial-history.v2') {
    return failure('history.schemaVersion', 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  if (
    !Array.isArray(value.completedCandidateOrdinals) ||
    !Array.isArray(value.developmentCandidateOrdinals) ||
    !isRecord(value.latestReviewedCandidateLegacyPriorTrials) ||
    !isRecord(value.latestReviewedCandidatePriorTrials) ||
    !isRecord(value.latestTerminalEvidence) ||
    !isRecord(value.candidatePreregistration) ||
    !isRecord(value.latestReviewedCandidatePreregistration) ||
    !isRecord(value.latestDevelopmentEvidence) ||
    (value.latestInvalidPrecommit !== null && !isRecord(value.latestInvalidPrecommit)) ||
    (value.nextCandidatePreregistration !== null && !isRecord(value.nextCandidatePreregistration))
  ) {
    return failure('history', 'MALFORMED_HISTORY', value)
  }
  const qualificationEvidenceIssue = validateQualificationEvidence(
    value.latestTerminalEvidence,
    'history.latestTerminalEvidence',
  )
  if (qualificationEvidenceIssue !== undefined) return Result.fail(qualificationEvidenceIssue)
  const qualificationPreregistrationIssue = validateQualificationPreregistration(
    value.candidatePreregistration,
    'history.candidatePreregistration',
  )
  if (qualificationPreregistrationIssue !== undefined) return Result.fail(qualificationPreregistrationIssue)
  const reviewedIssue = validateNextPreregistration(
    value.latestReviewedCandidatePreregistration,
    'history.latestReviewedCandidatePreregistration',
  )
  if (reviewedIssue !== undefined) return Result.fail(reviewedIssue)
  const developmentEvidenceIssue = validateHistoryDevelopmentEvidence(
    value.latestDevelopmentEvidence,
    'history.latestDevelopmentEvidence',
  )
  if (developmentEvidenceIssue !== undefined) return Result.fail(developmentEvidenceIssue)
  const invalidationIssue =
    value.latestInvalidPrecommit === null
      ? undefined
      : validateInvalidation(value.latestInvalidPrecommit, 'history.latestInvalidPrecommit')
  if (invalidationIssue !== undefined) return Result.fail(invalidationIssue)
  const nextIssue =
    value.nextCandidatePreregistration === null
      ? undefined
      : validateNextPreregistration(value.nextCandidatePreregistration, 'history.nextCandidatePreregistration')
  if (nextIssue !== undefined) return Result.fail(nextIssue)
  const legacyMaterialIssue = validateMaterial(
    value.latestReviewedCandidateLegacyPriorTrials,
    'history.latestReviewedCandidateLegacyPriorTrials',
    'bayn.candidate-development-prior-trials.v1',
  )
  if (legacyMaterialIssue !== undefined) return Result.fail(legacyMaterialIssue)
  const priorMaterialIssue = validateMaterial(
    value.latestReviewedCandidatePriorTrials,
    'history.latestReviewedCandidatePriorTrials',
    'bayn.candidate-development-prior-trials.v2',
  )
  if (priorMaterialIssue !== undefined) return Result.fail(priorMaterialIssue)
  return Result.succeed(value as unknown as CandidateDevelopmentTrialHistory)
}

const validateHistoryRelations = (
  history: CandidateDevelopmentTrialHistory,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const ordinalIssue = validateHistoryOrdinals(history)
  if (ordinalIssue !== undefined) return ordinalIssue
  const latestCompleted = history.completedCandidateOrdinals.at(-1)
  const latestDevelopment = history.developmentCandidateOrdinals.at(-1)
  if (latestCompleted === undefined || latestDevelopment === undefined) {
    return stateIssue('history.ordinals', 'LATEST_EVIDENCE_MISMATCH')
  }
  if (
    history.latestTerminalEvidence.candidateOrdinal !== latestCompleted ||
    history.candidatePreregistration.candidateOrdinal !== latestCompleted
  ) {
    return stateIssue('history.latestTerminalEvidence', 'LATEST_EVIDENCE_MISMATCH', history.latestTerminalEvidence)
  }
  if (history.latestDevelopmentEvidence.candidateOrdinal !== latestDevelopment) {
    return stateIssue(
      'history.latestDevelopmentEvidence',
      'LATEST_EVIDENCE_MISMATCH',
      history.latestDevelopmentEvidence,
    )
  }
  const legacy = history.latestReviewedCandidateLegacyPriorTrials
  if (
    !sameOrdinals(legacy.qualificationCandidateOrdinals, history.completedCandidateOrdinals) ||
    !legacy.developmentCandidateOrdinals.every(
      (ordinal, index) => ordinal === history.developmentCandidateOrdinals[index],
    ) ||
    legacy.developmentCandidateOrdinals.length === 0 ||
    legacy.latestDevelopmentEvidence.candidateOrdinal !== legacy.developmentCandidateOrdinals.at(-1) ||
    legacy.latestReviewedPreregistration.candidateOrdinal !== legacy.latestDevelopmentEvidence.candidateOrdinal
  ) {
    return stateIssue('history.latestReviewedCandidateLegacyPriorTrials', 'LATEST_EVIDENCE_MISMATCH', legacy)
  }
  const prior = history.latestReviewedCandidatePriorTrials
  if (
    !sameOrdinals(prior.qualificationCandidateOrdinals, history.completedCandidateOrdinals) ||
    !sameOrdinals(prior.developmentCandidateOrdinals, history.developmentCandidateOrdinals) ||
    prior.latestQualificationEvidence.candidateOrdinal !== history.latestTerminalEvidence.candidateOrdinal ||
    prior.latestQualificationEvidence.sourceRevision !== history.latestTerminalEvidence.sourceRevision ||
    prior.latestQualificationPreregistration.candidateOrdinal !== history.candidatePreregistration.candidateOrdinal ||
    prior.latestQualificationPreregistration.sourceRevision !== history.candidatePreregistration.sourceRevision ||
    prior.latestQualificationPreregistration.path !== history.candidatePreregistration.path ||
    prior.latestQualificationPreregistration.blobOid !== history.candidatePreregistration.blobOid ||
    prior.latestDevelopmentEvidence.candidateOrdinal !== latestDevelopment ||
    prior.latestDevelopmentEvidence.evidenceContentHash !== history.latestDevelopmentEvidence.evidenceContentHash ||
    prior.latestReviewedPreregistration.candidateOrdinal !== latestDevelopment
  ) {
    return stateIssue('history.latestReviewedCandidatePriorTrials', 'LATEST_EVIDENCE_MISMATCH', prior)
  }
  const invalidation = history.latestInvalidPrecommit
  const closedOrdinals = [
    ...history.completedCandidateOrdinals,
    ...history.developmentCandidateOrdinals,
    ...(invalidation === null ? [] : [invalidation.candidateOrdinal]),
  ]
  const highestClosed = Math.max(...closedOrdinals)
  const invalidationIsLatest = invalidation?.candidateOrdinal === highestClosed
  if (invalidation !== null && invalidationIsLatest && history.nextCandidatePreregistration === null) {
    if (
      invalidation.candidateOrdinal !== history.latestReviewedCandidatePreregistration.candidateOrdinal ||
      invalidation.invalidatedModule.path !== history.latestReviewedCandidatePreregistration.modulePath ||
      invalidation.invalidatedModule.sha256 !== history.latestReviewedCandidatePreregistration.moduleSha256 ||
      invalidation.preregistration.sourceRevision !==
        history.latestReviewedCandidatePreregistration.preregistration.sourceRevision ||
      invalidation.preregistration.path !== history.latestReviewedCandidatePreregistration.preregistration.path ||
      invalidation.preregistration.blobOid !== history.latestReviewedCandidatePreregistration.preregistration.blobOid
    ) {
      return stateIssue(
        'history.latestReviewedCandidatePreregistration',
        'INVALIDATION_BINDING_MISMATCH',
        history.latestReviewedCandidatePreregistration,
      )
    }
  }
  if (history.nextCandidatePreregistration !== null) {
    if (
      history.nextCandidatePreregistration.candidateOrdinal !== highestClosed + 1 ||
      history.nextCandidatePreregistration.priorTrialCount !== highestClosed ||
      !sameNextPreregistration(history.nextCandidatePreregistration, history.latestReviewedCandidatePreregistration)
    ) {
      return stateIssue(
        'history.nextCandidatePreregistration',
        'SUCCESSOR_BINDING_MISMATCH',
        history.nextCandidatePreregistration,
        { candidateOrdinal: highestClosed + 1, priorTrialCount: highestClosed },
      )
    }
  } else {
    const expectedReviewedOrdinal = invalidationIsLatest ? invalidation.candidateOrdinal : latestDevelopment
    if (history.latestReviewedCandidatePreregistration.candidateOrdinal !== expectedReviewedOrdinal) {
      return stateIssue(
        'history.latestReviewedCandidatePreregistration',
        'SUCCESSOR_BINDING_MISMATCH',
        history.latestReviewedCandidatePreregistration,
        expectedReviewedOrdinal,
      )
    }
  }
  return undefined
}

export const validateCandidateDevelopmentTrialHistory = (
  value: unknown,
): Result.Result<void, CandidateDevelopmentTrialStateIssue> => {
  const envelope = validateHistoryEnvelope(value)
  if (Result.isFailure(envelope)) return Result.fail(envelope.failure)
  const relationIssue = validateHistoryRelations(envelope.success)
  return relationIssue === undefined ? Result.succeed(undefined) : Result.fail(relationIssue)
}

const validateDevelopmentAttempt = (
  value: unknown,
  path: string,
  active: boolean,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (value._tag === 'DEVELOPMENT_UNATTEMPTED') {
    return value.attemptCount === 0 ? undefined : stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
  }
  if (value._tag === 'DEVELOPMENT_ATTEMPTED') {
    if (value.attemptCount !== 1 || (value.metricBearing !== null && typeof value.metricBearing !== 'boolean')) {
      return stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
    }
    if (active && typeof value.metricBearing !== 'boolean') {
      return stateIssue(`${path}.metricBearing`, 'TERMINAL_STATE_MISMATCH', value.metricBearing, 'boolean')
    }
    return undefined
  }
  return stateIssue(path, 'MALFORMED_HISTORY', value)
}

const validateQualificationAttempt = (
  value: unknown,
  path: string,
  expected: CandidateDevelopmentQualificationAttempt['_tag'],
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (value._tag !== expected) return stateIssue(path, 'ATTEMPT_KIND_MISMATCH', value, expected)
  if (expected === 'QUALIFICATION_ATTEMPTED' && value.attemptCount !== 1) {
    return stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
  }
  if (expected !== 'QUALIFICATION_ATTEMPTED' && value.attemptCount !== 0) {
    return stateIssue(path, 'ATTEMPT_ALREADY_CONSUMED', value)
  }
  return undefined
}

const validateEvidenceMetrics = (
  attempt: { readonly metricBearing: boolean | null },
  evidence: CandidateDevelopmentDevelopmentTerminalEvidence | null,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (evidence === null || evidence.developmentMetricsObserved === undefined || attempt.metricBearing === null) {
    return undefined
  }
  return evidence.developmentMetricsObserved === attempt.metricBearing
    ? undefined
    : stateIssue(
        `${path}.developmentMetricsObserved`,
        'DEVELOPMENT_OUTCOME_MISMATCH',
        evidence.developmentMetricsObserved,
        attempt.metricBearing,
      )
}

const validateClosedTrial = (trial: unknown, index: number): CandidateDevelopmentTrialStateIssue | undefined => {
  const path = `state.closedTrials[${index}]`
  if (!isRecord(trial)) return stateIssue(path, 'MALFORMED_HISTORY', trial)
  const identityIssue = validateOrdinalAndPriorCount(trial, path)
  if (identityIssue !== undefined) return identityIssue
  const closedTrial = trial as unknown as CandidateDevelopmentClosedTrial
  switch (closedTrial._tag) {
    case 'PRECOMMIT_INVALIDATED': {
      const invalidationIssue = validateInvalidation(closedTrial.invalidation, `${path}.invalidation`)
      if (invalidationIssue !== undefined) return invalidationIssue
      if (closedTrial.invalidation.candidateOrdinal !== closedTrial.candidateOrdinal) {
        return stateIssue(`${path}.invalidation.candidateOrdinal`, 'INVALIDATION_BINDING_MISMATCH')
      }
      return undefined
    }
    case 'DEVELOPMENT_REJECTED': {
      if (closedTrial.preregistration !== null) {
        const preregistrationIssue = validateNextPreregistration(closedTrial.preregistration, `${path}.preregistration`)
        if (preregistrationIssue !== undefined) return preregistrationIssue
        if (closedTrial.preregistration.candidateOrdinal !== closedTrial.candidateOrdinal) {
          return stateIssue(`${path}.preregistration`, 'SUCCESSOR_BINDING_MISMATCH')
        }
      }
      const attemptIssue = validateDevelopmentAttempt(
        closedTrial.developmentAttempt,
        `${path}.developmentAttempt`,
        false,
      )
      if (attemptIssue !== undefined || closedTrial.developmentAttempt._tag !== 'DEVELOPMENT_ATTEMPTED') {
        return attemptIssue ?? stateIssue(`${path}.developmentAttempt`, 'ATTEMPT_KIND_MISMATCH')
      }
      if (closedTrial.developmentEvidence !== null) {
        const evidenceIssue = validateDevelopmentTerminalEvidence(
          closedTrial.developmentEvidence,
          `${path}.developmentEvidence`,
        )
        if (evidenceIssue !== undefined) return evidenceIssue
      }
      return validateEvidenceMetrics(
        closedTrial.developmentAttempt,
        closedTrial.developmentEvidence,
        `${path}.developmentEvidence`,
      )
    }
    case 'QUALIFICATION_TERMINAL': {
      if (closedTrial.preregistration !== null) {
        const preregistrationIssue = validateNextPreregistration(closedTrial.preregistration, `${path}.preregistration`)
        if (preregistrationIssue !== undefined) return preregistrationIssue
        if (closedTrial.preregistration.candidateOrdinal !== closedTrial.candidateOrdinal) {
          return stateIssue(`${path}.preregistration`, 'SUCCESSOR_BINDING_MISMATCH')
        }
      }
      const attemptIssue = validateDevelopmentAttempt(
        closedTrial.developmentAttempt,
        `${path}.developmentAttempt`,
        false,
      )
      if (attemptIssue !== undefined || closedTrial.developmentAttempt._tag !== 'DEVELOPMENT_ATTEMPTED') {
        return attemptIssue ?? stateIssue(`${path}.developmentAttempt`, 'ATTEMPT_KIND_MISMATCH')
      }
      const qualificationIssue = validateQualificationAttempt(
        closedTrial.qualificationAttempt,
        `${path}.qualificationAttempt`,
        'QUALIFICATION_ATTEMPTED',
      )
      if (qualificationIssue !== undefined) return qualificationIssue
      if (closedTrial.developmentEvidence !== null) {
        const evidenceIssue = validateDevelopmentTerminalEvidence(
          closedTrial.developmentEvidence,
          `${path}.developmentEvidence`,
        )
        if (evidenceIssue !== undefined) return evidenceIssue
      }
      const metricsIssue = validateEvidenceMetrics(
        closedTrial.developmentAttempt,
        closedTrial.developmentEvidence,
        `${path}.developmentEvidence`,
      )
      if (metricsIssue !== undefined) return metricsIssue
      if (closedTrial.terminalEvidence !== null) {
        const terminalIssue = validateQualificationTerminalEvidence(
          closedTrial.terminalEvidence,
          `${path}.terminalEvidence`,
        )
        if (terminalIssue !== undefined) return terminalIssue
      }
      return undefined
    }
    default:
      return stateIssue(path, 'MALFORMED_HISTORY', trial)
  }
}

const validateActiveTrial = (trial: unknown): CandidateDevelopmentTrialStateIssue | undefined => {
  if (trial === null) return undefined
  if (!isRecord(trial)) return stateIssue('state.activeTrial', 'MALFORMED_HISTORY', trial)
  const identityIssue = validateOrdinalAndPriorCount(trial, 'state.activeTrial')
  if (identityIssue !== undefined) return identityIssue
  const preregistrationIssue = validateNextPreregistration(trial.preregistration, 'state.activeTrial.preregistration')
  if (preregistrationIssue !== undefined) return preregistrationIssue
  const activeTrial = trial as unknown as CandidateDevelopmentActiveTrial
  if (
    activeTrial.preregistration.candidateOrdinal !== activeTrial.candidateOrdinal ||
    activeTrial.preregistration.priorTrialCount !== activeTrial.priorTrialCount
  ) {
    return stateIssue('state.activeTrial.preregistration', 'SUCCESSOR_BINDING_MISMATCH', activeTrial.preregistration, {
      candidateOrdinal: activeTrial.candidateOrdinal,
      priorTrialCount: activeTrial.priorTrialCount,
    })
  }
  switch (activeTrial._tag) {
    case 'DEVELOPMENT_PENDING': {
      const attemptIssue = validateDevelopmentAttempt(
        activeTrial.developmentAttempt,
        'state.activeTrial.developmentAttempt',
        true,
      )
      if (attemptIssue !== undefined) return attemptIssue
      return activeTrial.developmentAttempt._tag === 'DEVELOPMENT_UNATTEMPTED'
        ? undefined
        : stateIssue('state.activeTrial.developmentAttempt', 'ATTEMPT_KIND_MISMATCH')
    }
    case 'DEVELOPMENT_OUTCOME_PENDING': {
      const attemptIssue = validateDevelopmentAttempt(
        activeTrial.developmentAttempt,
        'state.activeTrial.developmentAttempt',
        true,
      )
      if (attemptIssue !== undefined) return attemptIssue
      return activeTrial.developmentAttempt._tag === 'DEVELOPMENT_ATTEMPTED'
        ? undefined
        : stateIssue('state.activeTrial.developmentAttempt', 'ATTEMPT_KIND_MISMATCH')
    }
    case 'QUALIFICATION_ELIGIBLE': {
      const attemptIssue = validateDevelopmentAttempt(
        activeTrial.developmentAttempt,
        'state.activeTrial.developmentAttempt',
        true,
      )
      if (attemptIssue !== undefined) return attemptIssue
      if (activeTrial.developmentAttempt._tag !== 'DEVELOPMENT_ATTEMPTED') {
        return stateIssue('state.activeTrial.developmentAttempt', 'ATTEMPT_KIND_MISMATCH')
      }
      const evidenceIssue = validateDevelopmentTerminalEvidence(
        activeTrial.developmentEvidence,
        'state.activeTrial.developmentEvidence',
      )
      if (evidenceIssue !== undefined) return evidenceIssue
      const metricsIssue = validateEvidenceMetrics(
        activeTrial.developmentAttempt,
        activeTrial.developmentEvidence,
        'state.activeTrial.developmentEvidence',
      )
      if (metricsIssue !== undefined) return metricsIssue
      return validateQualificationAttempt(
        activeTrial.qualificationAttempt,
        'state.activeTrial.qualificationAttempt',
        'QUALIFICATION_UNATTEMPTED',
      )
    }
    case 'QUALIFICATION_ATTEMPTED': {
      const attemptIssue = validateDevelopmentAttempt(
        activeTrial.developmentAttempt,
        'state.activeTrial.developmentAttempt',
        true,
      )
      if (attemptIssue !== undefined) return attemptIssue
      if (activeTrial.developmentAttempt._tag !== 'DEVELOPMENT_ATTEMPTED') {
        return stateIssue('state.activeTrial.developmentAttempt', 'ATTEMPT_KIND_MISMATCH')
      }
      const evidenceIssue = validateDevelopmentTerminalEvidence(
        activeTrial.developmentEvidence,
        'state.activeTrial.developmentEvidence',
      )
      if (evidenceIssue !== undefined) return evidenceIssue
      const metricsIssue = validateEvidenceMetrics(
        activeTrial.developmentAttempt,
        activeTrial.developmentEvidence,
        'state.activeTrial.developmentEvidence',
      )
      if (metricsIssue !== undefined) return metricsIssue
      return validateQualificationAttempt(
        activeTrial.qualificationAttempt,
        'state.activeTrial.qualificationAttempt',
        'QUALIFICATION_ATTEMPTED',
      )
    }
    default:
      return stateIssue('state.activeTrial', 'MALFORMED_HISTORY', trial)
  }
}

export const expectedNextOrdinal = (state: CandidateDevelopmentTrialState): number => {
  const closedOrdinals = state.closedTrials.map((trial) => trial.candidateOrdinal)
  return closedOrdinals.length === 0 ? 1 : Math.max(...closedOrdinals) + 1
}

const validateStateOrdinals = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const ordinals = state.closedTrials.map((trial) => trial.candidateOrdinal)
  if (!isStrictlyIncreasing(ordinals)) return stateIssue('state.closedTrials', 'ORDINAL_OVERLAP', ordinals)
  const sequenceIssue = equalOrdinalSequence(ordinals, 1)
  if (sequenceIssue !== null) return stateIssue('state.closedTrials', 'ORDINAL_SEQUENCE_GAP', ordinals, '1..n')
  const expected = expectedNextOrdinal(state)
  if (state.nextOrdinal !== expected)
    return stateIssue('state.nextOrdinal', 'NEXT_ORDINAL_MISMATCH', state.nextOrdinal, expected)
  if (state.activeTrial !== null) {
    if (state.activeTrial.candidateOrdinal !== state.nextOrdinal) {
      return stateIssue(
        'state.activeTrial.candidateOrdinal',
        'NEXT_ORDINAL_MISMATCH',
        state.activeTrial.candidateOrdinal,
        state.nextOrdinal,
      )
    }
    if (ordinals.includes(state.activeTrial.candidateOrdinal)) {
      return stateIssue('state.activeTrial', 'ORDINAL_REUSE', state.activeTrial.candidateOrdinal)
    }
  }
  return undefined
}

const validateStateEnvelope = (
  value: unknown,
): Result.Result<CandidateDevelopmentTrialState, CandidateDevelopmentTrialStateIssue> => {
  if (!isRecord(value)) return failure('state', 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-trial-state.v1') {
    return failure('state.schemaVersion', 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  if (
    !Array.isArray(value.closedTrials) ||
    (value.activeTrial !== null && !isRecord(value.activeTrial)) ||
    !isPositiveInteger(value.nextOrdinal)
  ) {
    return failure('state', 'MALFORMED_HISTORY', value)
  }
  return Result.succeed(value as unknown as CandidateDevelopmentTrialState)
}

export const validateCandidateDevelopmentTrialState = (
  value: unknown,
): Result.Result<void, CandidateDevelopmentTrialStateIssue> => {
  const envelope = validateStateEnvelope(value)
  if (Result.isFailure(envelope)) return Result.fail(envelope.failure)
  for (const [index, trial] of envelope.success.closedTrials.entries()) {
    const issue = validateClosedTrial(trial, index)
    if (issue !== undefined) return Result.fail(issue)
  }
  const activeIssue = validateActiveTrial(envelope.success.activeTrial)
  if (activeIssue !== undefined) return Result.fail(activeIssue)
  const ordinalIssue = validateStateOrdinals(envelope.success)
  return ordinalIssue === undefined ? Result.succeed(undefined) : Result.fail(ordinalIssue)
}

export type { CandidateDevelopmentAttemptConsumption }
