import { candidateDevelopmentCalendarContract } from './candidate-development'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-decision'
import { canonicalHashV1Result } from './hash'

interface CandidateDevelopmentQualificationEvidence {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly terminalStatus: 'HOLD_REJECT'
  readonly sourceRevision: string
}

interface CandidateDevelopmentQualificationPreregistration {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly sourceRevision: string
  readonly path: string
  readonly blobOid: string
}

interface CandidateDevelopmentPriorDevelopmentEvidence {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly status: 'DEVELOPMENT_REJECTED'
  readonly evidenceContentHash: string
  readonly qualificationAttemptConsumed: false
}

export interface CandidateDevelopmentLegacyPriorTrialsMaterial {
  readonly schemaVersion: 'bayn.candidate-development-prior-trials.v1'
  readonly qualificationCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestDevelopmentEvidence: CandidateDevelopmentPriorDevelopmentEvidence
  readonly latestReviewedPreregistration: CandidateDevelopmentNextPreregistration
}

export interface CandidateDevelopmentPriorTrialsMaterial {
  readonly schemaVersion: 'bayn.candidate-development-prior-trials.v2'
  readonly qualificationCandidateOrdinals: readonly number[]
  readonly latestQualificationEvidence: CandidateDevelopmentQualificationEvidence
  readonly latestQualificationPreregistration: CandidateDevelopmentQualificationPreregistration
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestDevelopmentEvidence: CandidateDevelopmentPriorDevelopmentEvidence
  readonly latestReviewedPreregistration: CandidateDevelopmentNextPreregistration
}

export interface CandidateDevelopmentTrialHistory {
  readonly schemaVersion: 'bayn.candidate-development-trial-history.v1'
  readonly completedCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestReviewedCandidateLegacyPriorTrials: CandidateDevelopmentLegacyPriorTrialsMaterial
  readonly latestReviewedCandidatePriorTrials: CandidateDevelopmentPriorTrialsMaterial
  readonly latestTerminalEvidence: CandidateDevelopmentQualificationEvidence
  readonly candidatePreregistration: CandidateDevelopmentQualificationPreregistration
  readonly latestReviewedCandidatePreregistration: CandidateDevelopmentNextPreregistration
  readonly latestDevelopmentEvidence: {
    readonly candidateOrdinal: number
    readonly priorTrialCount: number
    readonly status: 'DEVELOPMENT_REJECTED'
    readonly evidenceContentHash: string
    readonly evaluatedSourceRevision: string
    readonly reviewedSourceRevision?: string
    readonly mergedSourceRevision?: string
    readonly failureStage?: 'buildEvaluation-preflight' | 'development-evaluation'
    readonly developmentMetricsObserved?: boolean
    readonly qualificationAttemptConsumed: false
  }
  readonly nextCandidatePreregistration: CandidateDevelopmentNextPreregistration | null
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

export const candidate17DevelopmentEvidenceExpectation = {
  bindings: {
    schemaVersion: 'bayn.candidate-development-evidence-bindings.v1',
    candidateOrdinal: 17,
    priorTrialCount: 16,
    preregistration: candidate17Preregistration.preregistration,
    reviewedSourceRevision: '9a293a7a8f7cb4ed5c8ddf41d7dbf9abecb12510',
    mergedSourceRevision: '4f39bb8ad168c3a459afdfdb30feccd49aba22d8',
    module: {
      path: candidate17Preregistration.modulePath,
      blobOid: '8d1ccbfc6bef2c1707ac85f51d1647a7a8bfd98b',
      sha256: candidate17Preregistration.moduleSha256,
    },
    sourceManifest: {
      path: 'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-source-manifest.json',
      blobOid: '23521cd435a97045adf18d1f075599fe5d22d750',
      sha256: 'ffc4d8cb6e473d660096dc18fe786d0b498adbab70bce9a3814c8bf3fdaeb954',
    },
    strategyProtocolHash: candidate17Preregistration.strategyProtocolHash,
    candidateDevelopmentProtocolHash: '72754b1178308c721a43aa1b295a374ccb82cb6c0a790187bdfc4f4ed066302a',
    marketData: candidate17Preregistration.marketData,
    calendar: candidateDevelopmentCalendarContract,
  },
  evidenceContentHash: '97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26',
  independentlyReproducedEvaluationHash: 'c7e551fc6352c4294f38e083b8743b882f2874ec4d614f46a04539d2a72d79a1',
  independentlyReproducedDecisionOutputHash: '9d76278fa34c18d38110b42980e65dd7941267968420e10fa0c0515b5075ed14',
} as const

export const candidate17DevelopmentEligibility = {
  status: 'DEVELOPMENT_REJECTED',
  evidenceContentHash: candidate17DevelopmentEvidenceExpectation.evidenceContentHash,
  nextCandidatePreregistration: null,
} as const

export const candidate18DevelopmentFailureEvidenceExpectation = {
  evidenceContentHash: '65d6f044f3f323aa87ff26a3dca011053aa3172c8a4ce422841497ccf370a5b6',
  evaluatedSourceRevision: '24465ada2b5e1e04c5058ad812b1eedd9f58b0dd',
  failureStage: 'buildEvaluation-preflight',
  developmentMetricsObserved: false,
} as const

export const candidate18DevelopmentEligibility = {
  status: 'DEVELOPMENT_REJECTED',
  evidenceContentHash: candidate18DevelopmentFailureEvidenceExpectation.evidenceContentHash,
  nextCandidatePreregistration: null,
} as const

export const candidate19DevelopmentFailureEvidenceExpectation = {
  evidenceContentHash: '6170af41ddc14c04412a1929a60c88f35062ec2440f6e4b3beb0539bd411f364',
  evaluatedSourceRevision: '276805b77d783db907dcb86cba934d7a4f6a0147',
  failureStage: 'development-evaluation',
  developmentMetricsObserved: true,
} as const

export const candidate19DevelopmentEligibility = {
  status: 'DEVELOPMENT_REJECTED',
  evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.evidenceContentHash,
  nextCandidatePreregistration: null,
} as const

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
    sourceRevision: 'ed336db4dfbd6b7e502294beb936eabb55152f25',
    path: 'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json',
    blobOid: '066a4d44cd41b871cad95474eb00e411af532c76',
  },
}

export const candidate18LegacyPriorTrialsMaterial: CandidateDevelopmentLegacyPriorTrialsMaterial = {
  schemaVersion: 'bayn.candidate-development-prior-trials.v1',
  qualificationCandidateOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  developmentCandidateOrdinals: [17],
  latestDevelopmentEvidence: {
    candidateOrdinal: 17,
    priorTrialCount: 16,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: candidate17DevelopmentEvidenceExpectation.evidenceContentHash,
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
    evidenceContentHash: candidate18DevelopmentFailureEvidenceExpectation.evidenceContentHash,
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
    evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.evidenceContentHash,
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
  schemaVersion: 'bayn.candidate-development-trial-history.v1',
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
    evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.evidenceContentHash,
    evaluatedSourceRevision: candidate19DevelopmentFailureEvidenceExpectation.evaluatedSourceRevision,
    failureStage: candidate19DevelopmentFailureEvidenceExpectation.failureStage,
    developmentMetricsObserved: candidate19DevelopmentFailureEvidenceExpectation.developmentMetricsObserved,
    qualificationAttemptConsumed: false,
  },
  nextCandidatePreregistration: candidate20Preregistration,
}
