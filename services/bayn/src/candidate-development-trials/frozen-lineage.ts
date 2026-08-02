import {
  candidate17ArchiveReceipt,
  candidate18ArchiveReceipt,
  candidate19ArchiveReceipt,
} from '../candidate-archive/legacy-candidate-receipts'
import type {
  CandidateDevelopmentInvalidPrecommit,
  CandidateDevelopmentLegacyPriorTrialsMaterial,
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentPriorTrialsMaterial,
  CandidateDevelopmentQualificationEvidence,
  CandidateDevelopmentQualificationPreregistration,
  CandidateDevelopmentTrialHistory,
} from './model'
import { canonicalHashV1Result } from '../hash'

const archivedStringFact = (receipt: { readonly facts: Readonly<Record<string, unknown>> }, key: string): string => {
  const value = receipt.facts[key]
  if (typeof value !== 'string') throw new Error(`archived candidate fact ${key} is not a string`)
  return value
}

const archivedBooleanFact = (receipt: { readonly facts: Readonly<Record<string, unknown>> }, key: string): boolean => {
  const value = receipt.facts[key]
  if (typeof value !== 'boolean') throw new Error(`archived candidate fact ${key} is not a boolean`)
  return value
}

export const candidate16TerminalEvidence: CandidateDevelopmentQualificationEvidence = {
  candidateOrdinal: 16,
  priorTrialCount: 15,
  terminalStatus: 'HOLD_REJECT',
  sourceRevision: '60a48a2e52fbafdd67a404a33a3cb22e82a98493',
}

export const candidate16Preregistration: CandidateDevelopmentQualificationPreregistration = {
  candidateOrdinal: 16,
  priorTrialCount: 15,
  sourceRevision: 'a0dadcd2f6346968bd9df582e4673608afc04592',
  path: 'services/bayn/candidates/ordinal-16-macro-breadth-regime-preregistration.md',
  blobOid: 'f602e3c8fd1b85768404d5fbc439775cdcd2570b',
}

export const candidate17Preregistration: CandidateDevelopmentNextPreregistration = {
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 17,
  priorTrialCount: 16,
  strategyProtocolHash: 'fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390',
  modulePath: 'services/bayn/src/strategy/volatility-managed-trend-overlay/candidate-17.ts',
  moduleSha256: '2e98bc55eae1901ccdde41978b7b32d746dc2ef6afcebbff1de0ed54574065da',
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
    finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
    inputManifestHash: 'b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4',
    boundedContentHash: 'e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed',
  },
  preregistration: {
    sourceRevision: '890d8f5801cf7c7576ed7a0cee387a4e79b98877',
    path: 'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.json',
    blobOid: 'c1d07233df53cc0379b1dfae9f1caffbd6b7abd6',
  },
}

/** The frozen archive records these metric-bearing observations for normalized historical trials. */
export const frozenDevelopmentMetricObservations: Readonly<Partial<Record<number, boolean>>> = Object.freeze({
  17: archivedBooleanFact(candidate17ArchiveReceipt, 'developmentMetricsObserved'),
  18: archivedBooleanFact(candidate18ArchiveReceipt, 'developmentMetricsObserved'),
  19: archivedBooleanFact(candidate19ArchiveReceipt, 'developmentMetricsObserved'),
})

export const candidate18Preregistration: CandidateDevelopmentNextPreregistration = {
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 18,
  priorTrialCount: 17,
  strategyProtocolHash: '7e27320b47cd170c1bc9c60ec3692593f2182af44bb48cef4d4a403b09601d75',
  strategyIdentityHash: 'ff762a985c129055670224dca5827a65c689f6f50e1e3765e7b521a05417b1f0',
  candidateDevelopmentProtocolHash: '46657425873b4f766b5f49d0ebbe2ac3aa9cf53682a8508635be708406271877',
  calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
  priorTrialsHash: '58f4e801380f35f483f998e00c82889e0cb6257e85542764e2dc8eaa4f3fd419',
  modulePath: 'services/bayn/src/strategy/dual-momentum-global-equity/candidate-18.ts',
  moduleSha256: '27466a8c9a9acba475db9cd0d2916532208540a53bd1f0ece307df299e5e34e8',
  marketData: candidate17Preregistration.marketData,
  preregistration: {
    sourceRevision: '30614640c5dfa7a7d50bf053df153062ff0bbca4',
    path: 'services/bayn/candidates/ordinal-18-global-equity-dual-momentum-preregistration.json',
    blobOid: '920a4afb8a7e5c1f6ef0875683ddc96a91008079',
  },
}

export const candidate19Preregistration: CandidateDevelopmentNextPreregistration = {
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 19,
  priorTrialCount: 18,
  strategyProtocolHash: 'b4a2a6c65a7fa5973f7cbc1fd5031e77d529f4884562e5cc8a105fc870ced78f',
  strategyIdentityHash: 'ccf8f03db1f0f9eb54f7ad42194c938e5a53e11573488fd31e7af871967af25a',
  candidateDevelopmentProtocolHash: '663b59d6c570bbe3373d6e160609e0ad6294a687f435416f2a0956888d960738',
  calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
  priorTrialsHash: '1dfc9b6832d4841093becd2c276141110afdfce28a0a88b301cfe9959b900d62',
  modulePath: 'services/bayn/src/strategy/inverse-volatility-risk-diversification/candidate-19.ts',
  moduleSha256: '90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f',
  marketData: candidate18Preregistration.marketData,
  preregistration: {
    sourceRevision: 'bb24ec2ab4225b13920a2b50fb137c4134d2d75f',
    path: 'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-preregistration.json',
    blobOid: '02d9150a1f0007a644a084b3fca4cd543131374e',
  },
}

export const candidate20Preregistration: CandidateDevelopmentNextPreregistration = {
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: 20,
  priorTrialCount: 19,
  strategyProtocolHash: '18b61d027e2235c7fc8ba718313ae8863650c2cb7c497dc4a7a5028829d19e0f',
  strategyIdentityHash: '8c99589120d8f3ed36c5286ce119d20490d42becd014e7fc2cc97b1420600278',
  candidateDevelopmentProtocolHash: 'f7d4d78e70401c01c141fc7b63c4c1cfe9e7350b973c40ffbd7d8fe9832b332f',
  calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
  priorTrialsHash: 'dfda4c7706cdd7b2999a863ac63714c5d46894027442253f031b69bcdeaefde0',
  modulePath: 'services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts',
  moduleSha256: '15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441',
  marketData: candidate19Preregistration.marketData,
  preregistration: {
    sourceRevision: '0b0a951465e1c4644bc3fd04b7b448b8701dc609',
    path: 'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json',
    blobOid: '066a4d44cd41b871cad95474eb00e411af532c76',
  },
}

export const candidate20PrecommitInvalidation: CandidateDevelopmentInvalidPrecommit = {
  schemaVersion: 'bayn.candidate-development-precommit-invalidation.v1',
  candidateOrdinal: 20,
  priorTrialCount: 19,
  status: 'PRECOMMIT_INVALID',
  attemptStatus: 'UNATTEMPTED',
  metricBearingAttemptsConsumed: 0,
  qualificationAttemptConsumed: false,
  reviewedHeadRevision: '82f58dd6bd6fc9849e779665873f934841b47ea7',
  mergedSourceRevision: '69d803040c8866e7703df50a645a096c54e7eca5',
  preregistration: {
    sourceRevision: candidate20Preregistration.preregistration.sourceRevision,
    path: candidate20Preregistration.preregistration.path,
    blobOid: candidate20Preregistration.preregistration.blobOid,
    sha256: 'e392888970d3c510e3ad20d6e982b81bf6234cd17260c8c5203013b5ce979409',
  },
  sourceManifest: {
    path: 'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json',
    blobOid: 'def5faba5a301b8fe4daa8f0557e8d53efb4b697',
    sha256: 'b5d9c4da95f59d4d4483fa80665de5327f4ed0b04c3afa8a94a3316b91f9e1fe',
  },
  invalidatedModule: {
    path: candidate20Preregistration.modulePath,
    blobOid: '71ae99e9303e7b79a640f185e70faa68a3048910',
    sha256: candidate20Preregistration.moduleSha256,
    lineCount: 123_194,
    byteCount: 2_963_738,
    findings: [
      'TYPE_CHECK_DISABLED',
      'DOWNCOMPILED_BUNDLE',
      'EMBEDDED_OFFICIAL_SESSIONS',
      'EMBEDDED_MARKET_BARS',
      'RUNTIME_INPUT_IGNORED',
    ],
  },
  naturalBuild: {
    runId: '30657379582',
    imagePublished: true,
    imageDigest: 'sha256:28f59fb44bdb3008eecd17cf3c053098f214f3d982f26673a44a98d53f767fba',
    deploymentAllowed: false,
  },
  release: {
    runId: '30657658256',
    conclusion: 'CANCELLED',
    promotionCompleted: false,
    rerunAllowed: false,
  },
  nextCandidatePreregistration: null,
}

export const candidate18LegacyPriorTrialsMaterial: CandidateDevelopmentLegacyPriorTrialsMaterial = {
  schemaVersion: 'bayn.candidate-development-prior-trials.v1',
  qualificationCandidateOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  developmentCandidateOrdinals: [17],
  latestDevelopmentEvidence: {
    candidateOrdinal: 17,
    priorTrialCount: 16,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: archivedStringFact(candidate17ArchiveReceipt, 'evidenceContentHash'),
    qualificationAttemptConsumed: false,
  },
  latestReviewedPreregistration: candidate17Preregistration,
}

export const candidate18PriorTrialsMaterial: CandidateDevelopmentPriorTrialsMaterial = {
  schemaVersion: 'bayn.candidate-development-prior-trials.v2',
  qualificationCandidateOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  latestQualificationEvidence: candidate16TerminalEvidence,
  latestQualificationPreregistration: candidate16Preregistration,
  developmentCandidateOrdinals: candidate18LegacyPriorTrialsMaterial.developmentCandidateOrdinals,
  latestDevelopmentEvidence: candidate18LegacyPriorTrialsMaterial.latestDevelopmentEvidence,
  latestReviewedPreregistration: candidate18LegacyPriorTrialsMaterial.latestReviewedPreregistration,
}

export const candidate19PriorTrialsMaterial: CandidateDevelopmentPriorTrialsMaterial = {
  schemaVersion: 'bayn.candidate-development-prior-trials.v2',
  qualificationCandidateOrdinals: candidate18PriorTrialsMaterial.qualificationCandidateOrdinals,
  latestQualificationEvidence: candidate16TerminalEvidence,
  latestQualificationPreregistration: candidate16Preregistration,
  developmentCandidateOrdinals: [17, 18],
  latestDevelopmentEvidence: {
    candidateOrdinal: 18,
    priorTrialCount: 17,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: archivedStringFact(candidate18ArchiveReceipt, 'evidenceContentHash'),
    qualificationAttemptConsumed: false,
  },
  latestReviewedPreregistration: candidate18Preregistration,
}

export const candidate20PriorTrialsMaterial: CandidateDevelopmentPriorTrialsMaterial = {
  schemaVersion: 'bayn.candidate-development-prior-trials.v2',
  qualificationCandidateOrdinals: candidate19PriorTrialsMaterial.qualificationCandidateOrdinals,
  latestQualificationEvidence: candidate16TerminalEvidence,
  latestQualificationPreregistration: candidate16Preregistration,
  developmentCandidateOrdinals: [17, 18, 19],
  latestDevelopmentEvidence: {
    candidateOrdinal: 19,
    priorTrialCount: 18,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: archivedStringFact(candidate19ArchiveReceipt, 'evidenceContentHash'),
    qualificationAttemptConsumed: false,
  },
  latestReviewedPreregistration: candidate19Preregistration,
}

export const deriveCandidateDevelopmentLegacyPriorTrialsHash = (
  material: CandidateDevelopmentLegacyPriorTrialsMaterial,
) => canonicalHashV1Result(material)

export const deriveCandidateDevelopmentPriorTrialsHash = (material: CandidateDevelopmentPriorTrialsMaterial) =>
  canonicalHashV1Result(material)

export const frozenCandidateDevelopmentTrialHistory: CandidateDevelopmentTrialHistory = {
  schemaVersion: 'bayn.candidate-development-trial-history.v2',
  completedCandidateOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  developmentCandidateOrdinals: [17, 18, 19],
  latestReviewedCandidateLegacyPriorTrials: candidate18LegacyPriorTrialsMaterial,
  latestReviewedCandidatePriorTrials: candidate20PriorTrialsMaterial,
  latestTerminalEvidence: candidate16TerminalEvidence,
  candidatePreregistration: candidate16Preregistration,
  latestReviewedCandidatePreregistration: candidate20Preregistration,
  latestDevelopmentEvidence: {
    candidateOrdinal: 19,
    priorTrialCount: 18,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: archivedStringFact(candidate19ArchiveReceipt, 'evidenceContentHash'),
    evaluatedSourceRevision: archivedStringFact(candidate19ArchiveReceipt, 'sourceRevision'),
    failureStage: 'development-evaluation',
    developmentMetricsObserved: archivedBooleanFact(candidate19ArchiveReceipt, 'developmentMetricsObserved'),
    qualificationAttemptConsumed: false,
  },
  latestInvalidPrecommit: candidate20PrecommitInvalidation,
  nextCandidatePreregistration: null,
}
