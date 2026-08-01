import { Result } from 'effect'

import type {
  CandidateDevelopmentAttemptConsumption,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
  CandidateDevelopmentTrialStateIssueReason,
} from './model'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isHex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

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

const validateOrdinalAndPriorCount = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isPositiveInteger(value.candidateOrdinal)) return stateIssue(`${path}.candidateOrdinal`, 'ORDINAL_NOT_POSITIVE')
  if (
    typeof value.priorTrialCount !== 'number' ||
    !Number.isInteger(value.priorTrialCount) ||
    value.priorTrialCount !== value.candidateOrdinal - 1
  ) {
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
  const ordinalIssue = validateOrdinalAndPriorCount(value, path)
  if (ordinalIssue !== undefined) return ordinalIssue
  if (!isHex(value.strategyProtocolHash, 64) || !isNonEmptyString(value.modulePath) || !isHex(value.moduleSha256, 64)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  const optionalHashIssue = validateOptionalHashes(value, path)
  if (optionalHashIssue !== undefined) return optionalHashIssue
  if (!isRecord(value.marketData) || !isRecord(value.preregistration)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  const marketDataIssue = validateMarketData(value.marketData, `${path}.marketData`)
  if (marketDataIssue !== undefined) return marketDataIssue
  return validatePreregistrationSource(value.preregistration, `${path}.preregistration`)
}

const validateOptionalHashes = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  for (const [field, observed] of [
    ['strategyIdentityHash', value.strategyIdentityHash],
    ['candidateDevelopmentProtocolHash', value.candidateDevelopmentProtocolHash],
    ['calendarHash', value.calendarHash],
    ['priorTrialsHash', value.priorTrialsHash],
  ] as const) {
    if (observed !== undefined && !isHex(observed, 64))
      return stateIssue(`${path}.${field}`, 'MALFORMED_HISTORY', observed)
  }
  return undefined
}

const validateMarketData = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (
    value.schemaVersion !== 'bayn.candidate-development-market-data-source.v1' ||
    !isHex(value.snapshotId, 64) ||
    !isHex(value.finalizedSnapshotContentHash, 64) ||
    !isHex(value.inputManifestHash, 64) ||
    !isHex(value.boundedContentHash, 64)
  ) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  return undefined
}

const validatePreregistrationSource = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isHex(value.sourceRevision, 40) || !isNonEmptyString(value.path) || !isHex(value.blobOid, 40)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  return undefined
}

export const validateInvalidation = (value: unknown, path: string): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue(path, 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-precommit-invalidation.v1') {
    return stateIssue(`${path}.schemaVersion`, 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  const immutableIssue = validateImmutableFlags(value, path)
  if (immutableIssue !== undefined) return immutableIssue
  const identityIssue = validateOrdinalAndPriorCount(value, path)
  if (identityIssue !== undefined) return identityIssue
  if (!isNonEmptyString(value.reviewedHeadRevision) || !isNonEmptyString(value.mergedSourceRevision)) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  const nested = readInvalidationParts(value)
  if (nested === undefined) return stateIssue(path, 'MALFORMED_HISTORY', value)
  const sourceIssue = validateInvalidationSources(nested, path)
  if (sourceIssue !== undefined) return sourceIssue
  return validateInvalidationOutcomes(value, nested, path)
}

const validateImmutableFlags = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (
    value.status !== 'PRECOMMIT_INVALID' ||
    value.attemptStatus !== 'UNATTEMPTED' ||
    value.metricBearingAttemptsConsumed !== 0 ||
    value.qualificationAttemptConsumed !== false ||
    value.nextCandidatePreregistration !== null
  ) {
    return stateIssue(path, 'INVALIDATION_NOT_IMMUTABLE', value)
  }
  return undefined
}

type InvalidationParts = {
  readonly preregistration: Record<string, unknown>
  readonly sourceManifest: Record<string, unknown>
  readonly invalidatedModule: Record<string, unknown>
  readonly naturalBuild: Record<string, unknown>
  readonly release: Record<string, unknown>
}

const readInvalidationParts = (value: Record<string, unknown>): InvalidationParts | undefined => {
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
    return undefined
  }
  return { preregistration, sourceManifest, invalidatedModule, naturalBuild, release }
}

const validateInvalidationSources = (
  parts: InvalidationParts,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const { preregistration, sourceManifest, invalidatedModule } = parts
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
    return stateIssue(path, 'MALFORMED_HISTORY', parts)
  }
  return undefined
}

const validateInvalidationOutcomes = (
  value: Record<string, unknown>,
  parts: InvalidationParts,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const { invalidatedModule, naturalBuild, release } = parts
  if (
    naturalBuild.imagePublished !== true ||
    naturalBuild.deploymentAllowed !== false ||
    !isNonEmptyString(naturalBuild.runId) ||
    !isHex(
      typeof naturalBuild.imageDigest === 'string' ? naturalBuild.imageDigest.slice('sha256:'.length) : undefined,
      64,
    ) ||
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

const hasInvalidationFindings = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 5 &&
  value[0] === 'TYPE_CHECK_DISABLED' &&
  value[1] === 'DOWNCOMPILED_BUNDLE' &&
  value[2] === 'EMBEDDED_OFFICIAL_SESSIONS' &&
  value[3] === 'EMBEDDED_MARKET_BARS' &&
  value[4] === 'RUNTIME_INPUT_IGNORED'

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
        (value.metricBearingAttemptsConsumed === 0 || value.metricBearingAttemptsConsumed === 1) &&
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

const validateLegacyHistoryShape = (value: unknown): CandidateDevelopmentTrialStateIssue | undefined => {
  if (!isRecord(value)) return stateIssue('history', 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-trial-history.v2') {
    return stateIssue('history.schemaVersion', 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  if (!Array.isArray(value.completedCandidateOrdinals) || !Array.isArray(value.developmentCandidateOrdinals)) {
    return stateIssue('history.ordinals', 'MALFORMED_HISTORY', value)
  }
  if (
    !isRecord(value.latestTerminalEvidence) ||
    !isRecord(value.candidatePreregistration) ||
    !isRecord(value.latestDevelopmentEvidence) ||
    !isRecord(value.latestReviewedCandidatePriorTrials) ||
    !isRecord(value.latestReviewedCandidateLegacyPriorTrials)
  ) {
    return stateIssue('history.evidence', 'MALFORMED_HISTORY', value)
  }
  const terminalEvidenceIssue = validateQualificationEvidence(
    value.latestTerminalEvidence,
    'history.latestTerminalEvidence',
  )
  if (terminalEvidenceIssue !== undefined) return terminalEvidenceIssue
  const candidatePreregistrationIssue = validateQualificationPreregistration(
    value.candidatePreregistration,
    'history.candidatePreregistration',
  )
  if (candidatePreregistrationIssue !== undefined) return candidatePreregistrationIssue
  const developmentEvidenceIssue = validateDevelopmentEvidence(
    value.latestDevelopmentEvidence,
    'history.latestDevelopmentEvidence',
  )
  if (developmentEvidenceIssue !== undefined) return developmentEvidenceIssue
  const legacyMaterialIssue = validateLegacyPriorTrialsMaterial(
    value.latestReviewedCandidateLegacyPriorTrials,
    'history.latestReviewedCandidateLegacyPriorTrials',
  )
  if (legacyMaterialIssue !== undefined) return legacyMaterialIssue
  const priorMaterialIssue = validatePriorTrialsMaterial(
    value.latestReviewedCandidatePriorTrials,
    'history.latestReviewedCandidatePriorTrials',
  )
  if (priorMaterialIssue !== undefined) return priorMaterialIssue
  const reviewedIssue = validateNextPreregistration(
    value.latestReviewedCandidatePreregistration,
    'history.latestReviewedCandidatePreregistration',
  )
  if (reviewedIssue !== undefined) return reviewedIssue
  const nextIssue =
    value.nextCandidatePreregistration === null
      ? undefined
      : validateNextPreregistration(value.nextCandidatePreregistration, 'history.nextCandidatePreregistration')
  if (nextIssue !== undefined) return nextIssue
  return value.latestInvalidPrecommit === null
    ? undefined
    : validateInvalidation(value.latestInvalidPrecommit, 'history.latestInvalidPrecommit')
}

const validateQualificationEvidence = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
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
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
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

const validateDevelopmentEvidence = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
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

const validateLegacyPriorTrialsMaterial = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (value.schemaVersion !== 'bayn.candidate-development-prior-trials.v1') {
    return stateIssue(`${path}.schemaVersion`, 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  const ordinalsIssue = validatePriorTrialOrdinals(value, path)
  if (ordinalsIssue !== undefined) return ordinalsIssue
  const latestEvidence = isRecord(value.latestDevelopmentEvidence) ? value.latestDevelopmentEvidence : undefined
  const latestPreregistration = isRecord(value.latestReviewedPreregistration)
    ? value.latestReviewedPreregistration
    : undefined
  if (latestEvidence === undefined || latestPreregistration === undefined) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  return validatePriorDevelopmentMaterialRelations(latestEvidence, latestPreregistration, path)
}

const validatePriorTrialsMaterial = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (value.schemaVersion !== 'bayn.candidate-development-prior-trials.v2') {
    return stateIssue(`${path}.schemaVersion`, 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  const ordinalsIssue = validatePriorTrialOrdinals(value, path)
  if (ordinalsIssue !== undefined) return ordinalsIssue
  const qualificationEvidence = isRecord(value.latestQualificationEvidence)
    ? value.latestQualificationEvidence
    : undefined
  const qualificationPreregistration = isRecord(value.latestQualificationPreregistration)
    ? value.latestQualificationPreregistration
    : undefined
  const latestEvidence = isRecord(value.latestDevelopmentEvidence) ? value.latestDevelopmentEvidence : undefined
  const latestPreregistration = isRecord(value.latestReviewedPreregistration)
    ? value.latestReviewedPreregistration
    : undefined
  if (
    qualificationEvidence === undefined ||
    qualificationPreregistration === undefined ||
    latestEvidence === undefined ||
    latestPreregistration === undefined
  ) {
    return stateIssue(path, 'MALFORMED_HISTORY', value)
  }
  if (
    !isPositiveInteger(qualificationEvidence.candidateOrdinal) ||
    qualificationEvidence.priorTrialCount !== qualificationEvidence.candidateOrdinal - 1 ||
    !isNonEmptyString(qualificationEvidence.sourceRevision) ||
    !isPositiveInteger(qualificationPreregistration.candidateOrdinal) ||
    qualificationPreregistration.priorTrialCount !== qualificationPreregistration.candidateOrdinal - 1 ||
    !isNonEmptyString(qualificationPreregistration.sourceRevision) ||
    !isNonEmptyString(qualificationPreregistration.path) ||
    !isNonEmptyString(qualificationPreregistration.blobOid) ||
    qualificationEvidence.candidateOrdinal !== qualificationPreregistration.candidateOrdinal ||
    qualificationEvidence.priorTrialCount !== qualificationPreregistration.priorTrialCount ||
    qualificationEvidence.terminalStatus !== 'HOLD_REJECT'
  ) {
    return stateIssue(`${path}.latestQualificationEvidence`, 'LATEST_EVIDENCE_MISMATCH', qualificationEvidence)
  }
  const developmentIssue = validatePriorDevelopmentMaterialRelations(latestEvidence, latestPreregistration, path)
  if (developmentIssue !== undefined) return developmentIssue
  return undefined
}

const validatePriorTrialOrdinals = (
  value: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const qualification = value.qualificationCandidateOrdinals
  const development = value.developmentCandidateOrdinals
  if (!Array.isArray(qualification) || !Array.isArray(development)) {
    return stateIssue(`${path}.ordinals`, 'MALFORMED_HISTORY', value)
  }
  if (!qualification.every(isPositiveInteger) || equalOrdinalSequence(qualification as number[], 1) !== null) {
    return stateIssue(`${path}.qualificationCandidateOrdinals`, 'ORDINAL_SEQUENCE_GAP', qualification, '1..n')
  }
  const expectedDevelopment = development.map((_, index) => qualification.length + index + 1)
  if (!development.every(isPositiveInteger) || !sameOrdinals(development as number[], expectedDevelopment)) {
    return stateIssue(`${path}.developmentCandidateOrdinals`, 'ORDINAL_SEQUENCE_GAP', development, expectedDevelopment)
  }
  return undefined
}

const validatePriorDevelopmentMaterialRelations = (
  evidence: Record<string, unknown>,
  preregistration: Record<string, unknown>,
  path: string,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const evidenceOrdinal = evidence.candidateOrdinal
  if (
    !isPositiveInteger(evidenceOrdinal) ||
    evidence.priorTrialCount !== evidenceOrdinal - 1 ||
    evidence.status !== 'DEVELOPMENT_REJECTED' ||
    !isNonEmptyString(evidence.evidenceContentHash) ||
    evidence.qualificationAttemptConsumed !== false
  ) {
    return stateIssue(`${path}.latestDevelopmentEvidence`, 'LATEST_EVIDENCE_MISMATCH', evidence)
  }
  const preregistrationIssue = validateNextPreregistration(preregistration, `${path}.latestReviewedPreregistration`)
  if (preregistrationIssue !== undefined) return preregistrationIssue
  if (preregistration.candidateOrdinal !== evidenceOrdinal || preregistration.priorTrialCount !== evidenceOrdinal - 1) {
    return stateIssue(`${path}.latestReviewedPreregistration`, 'LATEST_EVIDENCE_MISMATCH', preregistration, {
      candidateOrdinal: evidenceOrdinal,
      priorTrialCount: evidenceOrdinal - 1,
    })
  }
  return undefined
}

const validateLegacyHistoryRelations = (
  history: CandidateDevelopmentTrialHistory,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const completedIssue = equalOrdinalSequence(history.completedCandidateOrdinals, 1)
  if (completedIssue !== null) {
    return stateIssue(
      'history.completedCandidateOrdinals',
      'ORDINAL_SEQUENCE_GAP',
      history.completedCandidateOrdinals,
      '1..n',
    )
  }
  const completedCount = history.completedCandidateOrdinals.length
  const invalidOrdinal = history.latestInvalidPrecommit?.candidateOrdinal ?? null
  const expectedDevelopment = expectedDevelopmentOrdinals(
    history.developmentCandidateOrdinals.length,
    completedCount,
    invalidOrdinal,
  )
  if (!sameOrdinals(history.developmentCandidateOrdinals, expectedDevelopment)) {
    return stateIssue(
      'history.developmentCandidateOrdinals',
      'ORDINAL_SEQUENCE_GAP',
      history.developmentCandidateOrdinals,
      expectedDevelopment,
    )
  }
  const ordinalIssue = validateClosedOrdinals(history, invalidOrdinal)
  if (ordinalIssue !== undefined) return ordinalIssue
  const latestCompleted = history.completedCandidateOrdinals.at(-1)
  if (!latestCompleted || !matchesLatestQualification(history, latestCompleted)) {
    return stateIssue('history.latestTerminalEvidence', 'LATEST_EVIDENCE_MISMATCH', history.latestTerminalEvidence)
  }
  const latestDevelopment = history.developmentCandidateOrdinals.at(-1)
  if (!latestDevelopment || !matchesLatestDevelopment(history, latestDevelopment)) {
    return stateIssue(
      'history.latestDevelopmentEvidence',
      'LATEST_EVIDENCE_MISMATCH',
      history.latestDevelopmentEvidence,
    )
  }
  const materialIssue = validateHistoryPriorMaterialRelations(history, latestDevelopment)
  if (materialIssue !== undefined) return materialIssue
  const invalidationIssue = validateHistoryInvalidationBinding(history, latestDevelopment)
  if (invalidationIssue !== undefined) return invalidationIssue
  return validateHistorySuccessorBinding(history, latestDevelopment, invalidOrdinal)
}

const validateHistoryPriorMaterialRelations = (
  history: CandidateDevelopmentTrialHistory,
  latestDevelopment: number,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const legacy = history.latestReviewedCandidateLegacyPriorTrials
  if (
    !sameOrdinals(legacy.qualificationCandidateOrdinals, history.completedCandidateOrdinals) ||
    legacy.developmentCandidateOrdinals.some(
      (ordinal, index) => ordinal !== history.developmentCandidateOrdinals[index],
    ) ||
    legacy.developmentCandidateOrdinals.at(-1) !== legacy.latestDevelopmentEvidence.candidateOrdinal ||
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
  return undefined
}

const expectedDevelopmentOrdinals = (
  count: number,
  completedCount: number,
  invalidOrdinal: number | null,
): number[] => {
  const expected: number[] = []
  let nextOrdinal = completedCount + 1
  for (let index = 0; index < count; index += 1) {
    if (nextOrdinal === invalidOrdinal) nextOrdinal += 1
    expected.push(nextOrdinal)
    nextOrdinal += 1
  }
  return expected
}

const sameOrdinals = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((ordinal, index) => ordinal === right[index])

const validateClosedOrdinals = (
  history: CandidateDevelopmentTrialHistory,
  invalidOrdinal: number | null,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const allClosed = [...history.completedCandidateOrdinals, ...history.developmentCandidateOrdinals]
  if (invalidOrdinal !== null) allClosed.push(invalidOrdinal)
  const seen = new Set<number>()
  for (const ordinal of allClosed) {
    if (seen.has(ordinal)) return stateIssue('history.ordinals', 'ORDINAL_OVERLAP', allClosed)
    seen.add(ordinal)
  }
  return undefined
}

const matchesLatestQualification = (history: CandidateDevelopmentTrialHistory, ordinal: number): boolean =>
  history.latestTerminalEvidence.candidateOrdinal === ordinal &&
  history.latestTerminalEvidence.priorTrialCount === ordinal - 1 &&
  history.latestTerminalEvidence.terminalStatus === 'HOLD_REJECT' &&
  history.candidatePreregistration.candidateOrdinal === ordinal &&
  history.candidatePreregistration.priorTrialCount === ordinal - 1

const matchesLatestDevelopment = (history: CandidateDevelopmentTrialHistory, ordinal: number): boolean =>
  history.latestDevelopmentEvidence.candidateOrdinal === ordinal &&
  history.latestDevelopmentEvidence.priorTrialCount === ordinal - 1 &&
  history.latestDevelopmentEvidence.status === 'DEVELOPMENT_REJECTED' &&
  history.latestDevelopmentEvidence.qualificationAttemptConsumed === false

const validateHistoryInvalidationBinding = (
  history: CandidateDevelopmentTrialHistory,
  latestDevelopment: number,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const invalidation = history.latestInvalidPrecommit
  if (invalidation === null) return undefined
  if (invalidation.candidateOrdinal <= latestDevelopment) {
    return stateIssue(
      'history.latestInvalidPrecommit.candidateOrdinal',
      'ORDINAL_OVERLAP',
      invalidation.candidateOrdinal,
    )
  }
  const reviewed = history.latestReviewedCandidatePreregistration
  if (
    history.nextCandidatePreregistration === null &&
    (reviewed.candidateOrdinal !== invalidation.candidateOrdinal ||
      reviewed.priorTrialCount !== invalidation.priorTrialCount ||
      reviewed.modulePath !== invalidation.invalidatedModule.path ||
      reviewed.moduleSha256 !== invalidation.invalidatedModule.sha256 ||
      reviewed.preregistration.sourceRevision !== invalidation.preregistration.sourceRevision ||
      reviewed.preregistration.path !== invalidation.preregistration.path ||
      reviewed.preregistration.blobOid !== invalidation.preregistration.blobOid)
  ) {
    return stateIssue('history.latestReviewedCandidatePreregistration', 'INVALIDATION_BINDING_MISMATCH', reviewed)
  }
  return undefined
}

const validateHistorySuccessorBinding = (
  history: CandidateDevelopmentTrialHistory,
  latestDevelopment: number,
  invalidOrdinal: number | null,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const latestClosedOrdinal = Math.max(latestDevelopment, invalidOrdinal ?? latestDevelopment)
  if (history.nextCandidatePreregistration === null) {
    if (
      invalidOrdinal === null &&
      history.latestReviewedCandidatePreregistration.candidateOrdinal !== latestClosedOrdinal
    ) {
      return stateIssue('history.latestReviewedCandidatePreregistration', 'SUCCESSOR_BINDING_MISMATCH')
    }
    return undefined
  }
  if (
    history.nextCandidatePreregistration.candidateOrdinal !== latestClosedOrdinal + 1 ||
    history.nextCandidatePreregistration.priorTrialCount !== latestClosedOrdinal
  ) {
    return stateIssue(
      'history.nextCandidatePreregistration',
      'NEXT_ORDINAL_MISMATCH',
      history.nextCandidatePreregistration,
      { candidateOrdinal: latestClosedOrdinal + 1, priorTrialCount: latestClosedOrdinal },
    )
  }
  return undefined
}

export const validateCandidateDevelopmentTrialHistory = (
  value: unknown,
): Result.Result<void, CandidateDevelopmentTrialStateIssue> => {
  const shapeIssue = validateLegacyHistoryShape(value)
  if (shapeIssue !== undefined) return Result.fail(shapeIssue)
  const relationIssue = validateLegacyHistoryRelations(value as CandidateDevelopmentTrialHistory)
  return relationIssue === undefined ? Result.succeed(undefined) : Result.fail(relationIssue)
}

export const expectedNextOrdinal = (state: CandidateDevelopmentTrialState): number => {
  const closedOrdinals = [
    ...state.historicalQualificationTrials.map((trial) => trial.candidateOrdinal),
    ...state.developmentOnlyTrials.map((trial) => trial.candidateOrdinal),
    ...state.invalidatedPrecommits.map((trial) => trial.invalidation.candidateOrdinal),
  ]
  const highestClosed = closedOrdinals.length === 0 ? 0 : Math.max(...closedOrdinals)
  return state.currentSuccessor === null ? highestClosed + 1 : state.currentSuccessor.preregistration.candidateOrdinal
}

const validateStateEnvelope = (
  value: unknown,
): Result.Result<CandidateDevelopmentTrialState, CandidateDevelopmentTrialStateIssue> => {
  if (!isRecord(value)) return failure('state', 'MALFORMED_HISTORY', value)
  if (value.schemaVersion !== 'bayn.candidate-development-trial-state.v1') {
    return failure('state.schemaVersion', 'SCHEMA_VERSION_MISMATCH', value.schemaVersion)
  }
  if (
    !Array.isArray(value.historicalQualificationTrials) ||
    !Array.isArray(value.developmentOnlyTrials) ||
    !Array.isArray(value.invalidatedPrecommits) ||
    (value.currentSuccessor !== null && !isRecord(value.currentSuccessor)) ||
    !isPositiveInteger(value.nextOrdinal)
  ) {
    return failure('state', 'MALFORMED_HISTORY', value)
  }
  return Result.succeed(value as unknown as CandidateDevelopmentTrialState)
}

const validateHistoricalQualificationTrials = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentTrialStateIssue | undefined => {
  for (const [index, trial] of state.historicalQualificationTrials.entries()) {
    if (!isRecord(trial)) return stateIssue(`state.historicalQualificationTrials[${index}]`, 'MALFORMED_HISTORY', trial)
  }
  const sequenceIssue = equalOrdinalSequence(
    state.historicalQualificationTrials.map((trial) => trial.candidateOrdinal),
    1,
  )
  if (sequenceIssue !== null) return stateIssue('state.historicalQualificationTrials', 'ORDINAL_SEQUENCE_GAP')
  for (const [index, trial] of state.historicalQualificationTrials.entries()) {
    if (
      trial._tag !== 'HISTORICAL_QUALIFICATION' ||
      !isPositiveInteger(trial.candidateOrdinal) ||
      trial.priorTrialCount !== trial.candidateOrdinal - 1 ||
      trial.terminalStatus !== 'HOLD_REJECT' ||
      !isRecord(trial.attempt) ||
      trial.attempt._tag !== 'QUALIFICATION_ATTEMPT'
    ) {
      return stateIssue(`state.historicalQualificationTrials[${index}]`, 'TERMINAL_STATE_MISMATCH', trial)
    }
    const attemptIssue = validateAttempt(trial.attempt, `state.historicalQualificationTrials[${index}].attempt`)
    if (attemptIssue !== undefined) return attemptIssue
  }
  return undefined
}

const validateDevelopmentOnlyTrials = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentTrialStateIssue | undefined => {
  for (const [index, trial] of state.developmentOnlyTrials.entries()) {
    if (!isRecord(trial)) return stateIssue(`state.developmentOnlyTrials[${index}]`, 'MALFORMED_HISTORY', trial)
    if (
      trial._tag !== 'DEVELOPMENT_ONLY' ||
      !isPositiveInteger(trial.candidateOrdinal) ||
      trial.priorTrialCount !== trial.candidateOrdinal - 1 ||
      trial.status !== 'DEVELOPMENT_REJECTED' ||
      !isRecord(trial.attempt) ||
      trial.attempt._tag !== 'DEVELOPMENT_ONLY_ATTEMPT' ||
      trial.attempt.qualificationAttemptConsumed !== false
    ) {
      return stateIssue(`state.developmentOnlyTrials[${index}]`, 'TERMINAL_STATE_MISMATCH', trial)
    }
    const attemptIssue = validateAttempt(trial.attempt, `state.developmentOnlyTrials[${index}].attempt`)
    if (attemptIssue !== undefined) return attemptIssue
  }
  return undefined
}

const validateInvalidatedPrecommits = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentTrialStateIssue | undefined => {
  for (const [index, invalidated] of state.invalidatedPrecommits.entries()) {
    if (!isRecord(invalidated) || invalidated._tag !== 'IMMUTABLE_INVALIDATION' || !isRecord(invalidated.attempt)) {
      return stateIssue(`state.invalidatedPrecommits[${index}]`, 'INVALIDATION_NOT_IMMUTABLE', invalidated)
    }
    const invalidationIssue = validateInvalidation(
      invalidated.invalidation,
      `state.invalidatedPrecommits[${index}].invalidation`,
    )
    if (invalidationIssue !== undefined) return invalidationIssue
    if (invalidated.attempt._tag !== 'UNATTEMPTED') {
      return stateIssue(
        `state.invalidatedPrecommits[${index}].attempt`,
        'INVALIDATION_NOT_IMMUTABLE',
        invalidated.attempt,
      )
    }
    const attemptIssue = validateAttempt(invalidated.attempt, `state.invalidatedPrecommits[${index}].attempt`)
    if (attemptIssue !== undefined) return attemptIssue
  }
  return undefined
}

const validateCurrentSuccessor = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const successor = state.currentSuccessor
  if (successor === null) return undefined
  if (!isRecord(successor) || successor._tag !== 'CURRENT_SUCCESSOR' || !isRecord(successor.attempt)) {
    return stateIssue('state.currentSuccessor', 'MALFORMED_HISTORY', successor)
  }
  const preregistrationIssue = validateNextPreregistration(
    successor.preregistration,
    'state.currentSuccessor.preregistration',
  )
  if (preregistrationIssue !== undefined) return preregistrationIssue
  if (successor.preregistration.candidateOrdinal !== state.nextOrdinal) {
    return stateIssue(
      'state.currentSuccessor.preregistration.candidateOrdinal',
      'NEXT_ORDINAL_MISMATCH',
      successor.preregistration.candidateOrdinal,
      state.nextOrdinal,
    )
  }
  return validateAttempt(successor.attempt, 'state.currentSuccessor.attempt')
}

const validateStateOrdinals = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentTrialStateIssue | undefined => {
  if (state.nextOrdinal !== expectedNextOrdinal(state)) {
    return stateIssue('state.nextOrdinal', 'NEXT_ORDINAL_MISMATCH', state.nextOrdinal, expectedNextOrdinal(state))
  }
  const allOrdinals = [
    ...state.historicalQualificationTrials.map((trial) => trial.candidateOrdinal),
    ...state.developmentOnlyTrials.map((trial) => trial.candidateOrdinal),
    ...state.invalidatedPrecommits.map((trial) => trial.invalidation.candidateOrdinal),
  ].sort((left, right) => left - right)
  for (let index = 0; index < allOrdinals.length; index += 1) {
    if (allOrdinals[index] !== index + 1) return stateIssue('state.trials', 'ORDINAL_SEQUENCE_GAP', allOrdinals, '1..n')
  }
  if (
    state.currentSuccessor !== null &&
    allOrdinals.includes(state.currentSuccessor.preregistration.candidateOrdinal)
  ) {
    return stateIssue(
      'state.currentSuccessor',
      'ORDINAL_OVERLAP',
      state.currentSuccessor.preregistration.candidateOrdinal,
    )
  }
  return undefined
}

export const validateCandidateDevelopmentTrialState = (
  value: unknown,
): Result.Result<void, CandidateDevelopmentTrialStateIssue> => {
  const envelope = validateStateEnvelope(value)
  if (Result.isFailure(envelope)) return Result.fail(envelope.failure)
  const checks = [
    validateHistoricalQualificationTrials,
    validateDevelopmentOnlyTrials,
    validateInvalidatedPrecommits,
    validateCurrentSuccessor,
    validateStateOrdinals,
  ] as const
  for (const check of checks) {
    const checkIssue = check(envelope.success)
    if (checkIssue !== undefined) return Result.fail(checkIssue)
  }
  return Result.succeed(undefined)
}

export type { CandidateDevelopmentAttemptConsumption }
