import type {
  CandidateDevelopmentInvalidPrecommit,
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentTrialHistory,
} from './state-machine'

const hex = (seed: string, length: number): string =>
  Array.from({ length }, (_, index) => '0123456789abcdef'[(seed.charCodeAt(index % seed.length) + index) % 16]).join('')

const marketData = {
  schemaVersion: 'bayn.candidate-development-market-data-source.v1' as const,
  snapshotId: hex('snapshot-1', 64),
  finalizedSnapshotContentHash: hex('finalized-content-1', 64),
  inputManifestHash: hex('manifest-1', 64),
  boundedContentHash: hex('bounded-content-1', 64),
}

export const buildCandidateDevelopmentPreregistration = (
  candidateOrdinal: number,
): CandidateDevelopmentNextPreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal,
  priorTrialCount: candidateOrdinal - 1,
  strategyProtocolHash: hex(`strategy-${candidateOrdinal}`, 64),
  strategyIdentityHash: hex(`identity-${candidateOrdinal}`, 64),
  candidateDevelopmentProtocolHash: hex(`development-${candidateOrdinal}`, 64),
  calendarHash: hex('calendar-1', 64),
  priorTrialsHash: hex(`prior-trials-${candidateOrdinal}`, 64),
  modulePath: `services/bayn/src/strategy/test/candidate-${candidateOrdinal}.ts`,
  moduleSha256: hex(`module-${candidateOrdinal}`, 64),
  marketData,
  preregistration: {
    sourceRevision: hex(`source-${candidateOrdinal}`, 40),
    path: `services/bayn/candidates/ordinal-${candidateOrdinal}-preregistration.json`,
    blobOid: hex(`blob-${candidateOrdinal}`, 40),
  },
})

export const buildCandidateDevelopmentInvalidPrecommit = (
  preregistration: CandidateDevelopmentNextPreregistration,
): CandidateDevelopmentInvalidPrecommit => ({
  schemaVersion: 'bayn.candidate-development-precommit-invalidation.v1',
  candidateOrdinal: preregistration.candidateOrdinal,
  priorTrialCount: preregistration.priorTrialCount,
  status: 'PRECOMMIT_INVALID',
  attemptStatus: 'UNATTEMPTED',
  metricBearingAttemptsConsumed: 0,
  qualificationAttemptConsumed: false,
  reviewedHeadRevision: hex('reviewed-head', 40),
  mergedSourceRevision: hex('merged-source', 40),
  preregistration: {
    ...preregistration.preregistration,
    sha256: hex(`preregistration-${preregistration.candidateOrdinal}`, 64),
  },
  sourceManifest: {
    path: `services/bayn/candidates/ordinal-${preregistration.candidateOrdinal}-source-manifest.json`,
    blobOid: hex(`manifest-blob-${preregistration.candidateOrdinal}`, 40),
    sha256: hex(`manifest-${preregistration.candidateOrdinal}`, 64),
  },
  invalidatedModule: {
    path: preregistration.modulePath,
    blobOid: hex(`module-blob-${preregistration.candidateOrdinal}`, 40),
    sha256: preregistration.moduleSha256,
    lineCount: 10,
    byteCount: 100,
    findings: [
      'TYPE_CHECK_DISABLED',
      'DOWNCOMPILED_BUNDLE',
      'EMBEDDED_OFFICIAL_SESSIONS',
      'EMBEDDED_MARKET_BARS',
      'RUNTIME_INPUT_IGNORED',
    ],
  },
  naturalBuild: {
    runId: 'natural-build',
    imagePublished: true,
    imageDigest: `sha256:${hex('natural-build', 64)}`,
    deploymentAllowed: false,
  },
  release: {
    runId: 'release',
    conclusion: 'CANCELLED',
    promotionCompleted: false,
    rerunAllowed: false,
  },
  nextCandidatePreregistration: null,
})

export const buildCandidateDevelopmentTrialHistory = (
  options: {
    readonly nextCandidatePreregistration?: CandidateDevelopmentNextPreregistration | null
    readonly latestInvalidPrecommit?: CandidateDevelopmentInvalidPrecommit | null
  } = {},
): CandidateDevelopmentTrialHistory => {
  const latestDevelopmentPreregistration = buildCandidateDevelopmentPreregistration(3)
  const latestInvalidPrecommit = options.latestInvalidPrecommit ?? null
  const nextCandidatePreregistration = options.nextCandidatePreregistration ?? null
  const latestReviewed =
    nextCandidatePreregistration ??
    (latestInvalidPrecommit === null
      ? latestDevelopmentPreregistration
      : {
          ...latestDevelopmentPreregistration,
          candidateOrdinal: latestInvalidPrecommit.candidateOrdinal,
          priorTrialCount: latestInvalidPrecommit.priorTrialCount,
          modulePath: latestInvalidPrecommit.invalidatedModule.path,
          moduleSha256: latestInvalidPrecommit.invalidatedModule.sha256,
          preregistration: {
            sourceRevision: latestInvalidPrecommit.preregistration.sourceRevision,
            path: latestInvalidPrecommit.preregistration.path,
            blobOid: latestInvalidPrecommit.preregistration.blobOid,
          },
        })
  const latestTerminalEvidence = {
    candidateOrdinal: 2,
    priorTrialCount: 1,
    terminalStatus: 'HOLD_REJECT' as const,
    sourceRevision: 'qualification-source',
  }
  const latestDevelopmentEvidence = {
    candidateOrdinal: 3,
    priorTrialCount: 2,
    status: 'DEVELOPMENT_REJECTED' as const,
    evidenceContentHash: 'development-evidence-3',
    evaluatedSourceRevision: 'development-source-3',
    failureStage: 'development-evaluation' as const,
    developmentMetricsObserved: true,
    qualificationAttemptConsumed: false as const,
  }
  const latestReviewedCandidatePriorTrials = {
    schemaVersion: 'bayn.candidate-development-prior-trials.v2' as const,
    qualificationCandidateOrdinals: [1, 2],
    latestQualificationEvidence: latestTerminalEvidence,
    latestQualificationPreregistration: {
      candidateOrdinal: 2,
      priorTrialCount: 1,
      sourceRevision: 'qualification-preregistration',
      path: 'candidate-2-preregistration.json',
      blobOid: 'candidate-2-blob',
    },
    developmentCandidateOrdinals: [3],
    latestDevelopmentEvidence: {
      candidateOrdinal: 3,
      priorTrialCount: 2,
      status: 'DEVELOPMENT_REJECTED' as const,
      evidenceContentHash: latestDevelopmentEvidence.evidenceContentHash,
      qualificationAttemptConsumed: false as const,
    },
    latestReviewedPreregistration: latestDevelopmentPreregistration,
  }
  return {
    schemaVersion: 'bayn.candidate-development-trial-history.v2',
    completedCandidateOrdinals: [1, 2],
    developmentCandidateOrdinals: [3],
    latestReviewedCandidateLegacyPriorTrials: {
      schemaVersion: 'bayn.candidate-development-prior-trials.v1',
      qualificationCandidateOrdinals: [1, 2],
      developmentCandidateOrdinals: [3],
      latestDevelopmentEvidence: latestReviewedCandidatePriorTrials.latestDevelopmentEvidence,
      latestReviewedPreregistration: latestDevelopmentPreregistration,
    },
    latestReviewedCandidatePriorTrials,
    latestTerminalEvidence,
    candidatePreregistration: {
      candidateOrdinal: 2,
      priorTrialCount: 1,
      sourceRevision: 'qualification-preregistration',
      path: 'candidate-2-preregistration.json',
      blobOid: 'candidate-2-blob',
    },
    latestReviewedCandidatePreregistration: latestReviewed,
    latestDevelopmentEvidence,
    latestInvalidPrecommit,
    nextCandidatePreregistration,
  }
}
