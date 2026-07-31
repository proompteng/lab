import { candidateDevelopmentCalendarContract } from './candidate-development'
import type { CandidateDevelopmentNextPreregistration } from './candidate-development-decision'

export interface CandidateDevelopmentTrialHistory {
  readonly schemaVersion: 'bayn.candidate-development-trial-history.v1'
  readonly completedCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly priorTrialsHash: string
  readonly latestTerminalEvidence: {
    readonly candidateOrdinal: number
    readonly priorTrialCount: number
    readonly terminalStatus: 'HOLD_REJECT'
    readonly sourceRevision: string
  }
  readonly candidatePreregistration: {
    readonly candidateOrdinal: number
    readonly priorTrialCount: number
    readonly sourceRevision: string
    readonly path: string
    readonly blobOid: string
  }
  readonly latestReviewedCandidatePreregistration: CandidateDevelopmentNextPreregistration
  readonly latestDevelopmentEvidence: {
    readonly candidateOrdinal: number
    readonly priorTrialCount: number
    readonly status: 'DEVELOPMENT_REJECTED'
    readonly evidenceContentHash: string
    readonly reviewedSourceRevision: string
    readonly mergedSourceRevision: string
    readonly qualificationAttemptConsumed: false
  }
  readonly nextCandidatePreregistration: CandidateDevelopmentNextPreregistration | null
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

export const frozenCandidateDevelopmentTrialHistory: CandidateDevelopmentTrialHistory = {
  schemaVersion: 'bayn.candidate-development-trial-history.v1',
  completedCandidateOrdinals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  developmentCandidateOrdinals: [17],
  priorTrialsHash: candidate18Preregistration.priorTrialsHash!,
  latestTerminalEvidence: {
    candidateOrdinal: 16,
    priorTrialCount: 15,
    terminalStatus: 'HOLD_REJECT',
    sourceRevision: '60a48a2e52fbafdd67a404a33a3cb22e82a98493',
  },
  candidatePreregistration: {
    candidateOrdinal: 16,
    priorTrialCount: 15,
    sourceRevision: 'a0dadcd2f6346968bd9df582e4673608afc04592',
    path: 'services/bayn/candidates/ordinal-16-macro-breadth-regime-preregistration.md',
    blobOid: 'f602e3c8fd1b85768404d5fbc439775cdcd2570b',
  },
  latestReviewedCandidatePreregistration: candidate18Preregistration,
  latestDevelopmentEvidence: {
    candidateOrdinal: 17,
    priorTrialCount: 16,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: candidate17DevelopmentEvidenceExpectation.evidenceContentHash,
    reviewedSourceRevision: candidate17DevelopmentEvidenceExpectation.bindings.reviewedSourceRevision,
    mergedSourceRevision: candidate17DevelopmentEvidenceExpectation.bindings.mergedSourceRevision,
    qualificationAttemptConsumed: false,
  },
  nextCandidatePreregistration: candidate18Preregistration,
}
