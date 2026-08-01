import { pipe, Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'

export type LegacyCandidateArchiveArtifactKind =
  | 'development-evidence'
  | 'precommit-invalidation'
  | 'attempt-output'
  | 'strategy-module'
  | 'source-manifest'
  | 'preregistration'

export interface LegacyCandidateArchiveArtifact {
  readonly schemaVersion: 'bayn.candidate-archive-artifact.v1'
  readonly kind: LegacyCandidateArchiveArtifactKind
  readonly path: string
  readonly blobOid: string
  readonly sha256: string
  readonly byteCount: number
  readonly lineCount: number
}

interface LegacyCandidateArchiveCommon {
  readonly schemaVersion: 'bayn.candidate-archive-receipt.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly status: 'DEVELOPMENT_REJECTED' | 'PRECOMMIT_INVALID'
  readonly qualificationAttemptConsumed: false
  readonly nextCandidatePreregistration: null
  readonly historicalArtifacts: readonly LegacyCandidateArchiveArtifact[]
  readonly facts: Readonly<Record<string, unknown>>
  readonly receiptHash: string
}

export type LegacyCandidateArchiveReceipt = LegacyCandidateArchiveCommon

export type LegacyCandidateArchiveReceiptIssue =
  | { readonly _tag: 'LegacyCandidateArchiveReceiptHashFailed'; readonly cause: CanonicalHashFailure }
  | {
      readonly _tag: 'LegacyCandidateArchiveReceiptHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'LegacyCandidateArchiveReceiptLineageMismatch'
      readonly candidateOrdinal: number
      readonly priorTrialCount: number
    }
  | { readonly _tag: 'LegacyCandidateArchiveReceiptQualificationAttemptConsumed' }
  | { readonly _tag: 'LegacyCandidateArchiveReceiptArtifactInvalid'; readonly path: string }

const historicalArtifact = (
  kind: LegacyCandidateArchiveArtifactKind,
  path: string,
  blobOid: string,
  sha256: string,
  byteCount: number,
  lineCount: number,
): LegacyCandidateArchiveArtifact => ({
  schemaVersion: 'bayn.candidate-archive-artifact.v1',
  kind,
  path,
  blobOid,
  sha256,
  byteCount,
  lineCount,
})

const candidate17ArchiveReceiptMaterial = {
  schemaVersion: 'bayn.candidate-archive-receipt.v1' as const,
  candidateOrdinal: 17,
  priorTrialCount: 16,
  status: 'DEVELOPMENT_REJECTED' as const,
  qualificationAttemptConsumed: false as const,
  nextCandidatePreregistration: null,
  historicalArtifacts: [
    historicalArtifact(
      'development-evidence',
      'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-development-evidence.json',
      '222890183c2db10cb8af81c6967901a12f4c1b7b',
      'dcadb0fe73f5edc7068399e981e4a480580fbc8946a0d864e8ee0d92315f119d',
      22_229_178,
      606_182,
    ),
    historicalArtifact(
      'strategy-module',
      'services/bayn/src/strategy/volatility-managed-trend-overlay/candidate-17.ts',
      '8d1ccbfc6bef2c1707ac85f51d1647a7a8bfd98b',
      '2e98bc55eae1901ccdde41978b7b32d746dc2ef6afcebbff1de0ed54574065da',
      2_961_718,
      122_955,
    ),
    historicalArtifact(
      'source-manifest',
      'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-source-manifest.json',
      '23521cd435a97045adf18d1f075599fe5d22d750',
      'ffc4d8cb6e473d660096dc18fe786d0b498adbab70bce9a3814c8bf3fdaeb954',
      826,
      15,
    ),
    historicalArtifact(
      'preregistration',
      'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.json',
      'c1d07233df53cc0379b1dfae9f1caffbd6b7abd6',
      '5e783a4f4e3a29cc2ee2ed1687b73c91bd2d1a82b4a71118a86531bc3fdd10ca',
      874,
      15,
    ),
  ],
  facts: {
    reviewedSourceRevision: '9a293a7a8f7cb4ed5c8ddf41d7dbf9abecb12510',
    mergedSourceRevision: '4f39bb8ad168c3a459afdfdb30feccd49aba22d8',
    baselineRunId: 'e732903a6e9fcbe64069030e8e37dfe4d85c9e616c10676d6cd8c7e1bbbfb82f',
    stressedRunId: 'c584ee026929901b7fa38d136fd51d463faf9f552f450b0fe25c75cc3c5ecf4d',
    evidenceContentHash: '97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26',
    independentlyReproducedEvaluationHash: 'c7e551fc6352c4294f38e083b8743b882f2874ec4d614f46a04539d2a72d79a1',
    independentlyReproducedDecisionOutputHash: '9d76278fa34c18d38110b42980e65dd7941267968420e10fa0c0515b5075ed14',
    developmentMetricsObserved: true,
    terminalVerdict: 'FAIL_CLOSED',
    strategyAnnualizedReturn: 0.08847,
    buyAndHoldAnnualizedReturn: 0.121446,
    annualizedReturnDifferenceLowerBound: -0.089139,
    sharpeDifferenceLowerBound: -0.191,
    marketData: {
      snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
      finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
      inputManifestHash: 'b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4',
      boundedContentHash: 'e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed',
    },
    calendar: {
      calendarVersion: 'alpaca-us-equity-calendar-v1',
      start: '2016-01-04',
      end: '2022-12-30',
      sessionCount: 1_762,
      sessionsHash: 'a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1',
    },
  },
} as const

export const candidate17ArchiveReceipt = {
  ...candidate17ArchiveReceiptMaterial,
  receiptHash: 'fd1b4b81a5b51eadcddd1e2ec88f3b54e397cbf7310bb3c9dc6fc3a099556326',
} satisfies LegacyCandidateArchiveReceipt

const candidate18ArchiveReceiptMaterial = {
  schemaVersion: 'bayn.candidate-archive-receipt.v1' as const,
  candidateOrdinal: 18,
  priorTrialCount: 17,
  status: 'DEVELOPMENT_REJECTED' as const,
  qualificationAttemptConsumed: false as const,
  nextCandidatePreregistration: null,
  historicalArtifacts: [
    historicalArtifact(
      'development-evidence',
      'services/bayn/candidates/ordinal-18-global-equity-dual-momentum-development-evidence.json',
      '1b7b07ca6e611d2b602686f537fe8e0f762f43d3',
      'a56d5a79dad336219fd6210cb1349c75330b609fc891b3f4f38023f893de7c1e',
      3_956,
      69,
    ),
    historicalArtifact(
      'strategy-module',
      'services/bayn/src/strategy/dual-momentum-global-equity/candidate-18.ts',
      '44357f3d98315e7d241e4f0184f7812f5a27e930',
      '27466a8c9a9acba475db9cd0d2916532208540a53bd1f0ece307df299e5e34e8',
      2_960_908,
      122_932,
    ),
    historicalArtifact(
      'source-manifest',
      'services/bayn/candidates/ordinal-18-global-equity-dual-momentum-source-manifest.json',
      '3007c3e088f1a83228d5be672c232645fa2effa4',
      '636ca2e6280523eb18c06dea84f3c0d738f6995ba2eaa8bb97ca0b922e7d1f73',
      1_196,
      19,
    ),
    historicalArtifact(
      'preregistration',
      'services/bayn/candidates/ordinal-18-global-equity-dual-momentum-preregistration.json',
      '920a4afb8a7e5c1f6ef0875683ddc96a91008079',
      'b15b3edcbd7d01fe84bb94520159c4772e893774087512d2d081c07c04e9f84b',
      1_244,
      19,
    ),
  ],
  facts: {
    recordedAt: '2026-07-31T14:59:03.363Z',
    sourceRevision: '24465ada2b5e1e04c5058ad812b1eedd9f58b0dd',
    preregistrationSourceRevision: '30614640c5dfa7a7d50bf053df153062ff0bbca4',
    baselineRunId: '8b326d204d0c0cabbddcd477cd2c2c8b0adfc1d3ccd1b60bfaa4c5bfa1eccb2b',
    stressedRunId: 'cfe9c71f6cb0d0badf95f850c2194dc3ed57f5b8ca2f45383127863e6dd0060b',
    evidenceContentHash: '65d6f044f3f323aa87ff26a3dca011053aa3172c8a4ce422841497ccf370a5b6',
    stage: 'buildEvaluation-preflight',
    developmentMetricsObserved: false,
    developmentReportWritten: false,
    evaluationRerunAuthorized: false,
    failureTag: 'CandidateDevelopmentCommandProgramExecutionFailed',
    failureCauseTag: 'Candidate18InvalidInput',
    failureOperation: 'preflight',
    failureReason:
      'strategy protocol hash fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390 differs from Candidate 18',
    strategyProtocolHash: '7e27320b47cd170c1bc9c60ec3692593f2182af44bb48cef4d4a403b09601d75',
    strategyIdentityHash: 'ff762a985c129055670224dca5827a65c689f6f50e1e3765e7b521a05417b1f0',
    candidateDevelopmentProtocolHash: '46657425873b4f766b5f49d0ebbe2ac3aa9cf53682a8508635be708406271877',
    calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
    priorTrialsHash: '58f4e801380f35f483f998e00c82889e0cb6257e85542764e2dc8eaa4f3fd419',
    embeddedEvaluationProtocolHash: 'fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390',
    marketData: {
      snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
      finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
      inputManifestHash: 'b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4',
      boundedContentHash: 'e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed',
    },
  },
} as const

export const candidate18ArchiveReceipt = {
  ...candidate18ArchiveReceiptMaterial,
  receiptHash: '23370ab89857195e7a7755c3960650a0de9179e7725d10ca86e7f37906afe916',
} satisfies LegacyCandidateArchiveReceipt

const candidate19ArchiveReceiptMaterial = {
  schemaVersion: 'bayn.candidate-archive-receipt.v1' as const,
  candidateOrdinal: 19,
  priorTrialCount: 18,
  status: 'DEVELOPMENT_REJECTED' as const,
  qualificationAttemptConsumed: false as const,
  nextCandidatePreregistration: null,
  historicalArtifacts: [
    historicalArtifact(
      'development-evidence',
      'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-development-evidence.json',
      'f6011d7491c2d0962f113bedb4f6e15e18416b5c',
      'e38376223d952b2ae868160d3947adc4b16f6f624e6a0ed367489f623cca4ee6',
      4_573,
      78,
    ),
    historicalArtifact(
      'attempt-output',
      'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-development-attempt.log',
      'f94dc4925c3768b35ed8f84e56047beada49c57b',
      '702aed20f08899cf84500e67321cce42b24d1425595f3fa9f313aea46224d3c1',
      1_268,
      9,
    ),
    historicalArtifact(
      'strategy-module',
      'services/bayn/src/strategy/inverse-volatility-risk-diversification/candidate-19.ts',
      'cc06d8506ba408aa8e24436a6b60faeadfb96d23',
      '90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f',
      2_962_439,
      122_969,
    ),
    historicalArtifact(
      'source-manifest',
      'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-source-manifest.json',
      '4c34e00d3b9e695cf5b7977ddc635b522fc14e31',
      'e6c1556e16d31df727929fd883899debfad43c31ad21e964f5da33820429a6bc',
      1_294,
      20,
    ),
    historicalArtifact(
      'preregistration',
      'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-preregistration.json',
      '02d9150a1f0007a644a084b3fca4cd543131374e',
      '979786fc5b199bcb79a5e1d9bf17e70f86080f56ff288f266ea4edd8380a627a',
      1_256,
      19,
    ),
  ],
  facts: {
    recordedAt: '2026-07-31T17:24:03.530Z',
    attemptedAt: '2026-07-31T17:23:55.178Z',
    sourceRevision: '276805b77d783db907dcb86cba934d7a4f6a0147',
    preregistrationSourceRevision: 'bb24ec2ab4225b13920a2b50fb137c4134d2d75f',
    baselineRunId: '28b3e80d0d817a2883e86c448851da9ef5b7d6bacd601cca0d314e7fc366bfab',
    stressedRunId: '8ee52762be3fe38b71dcef30f8b07a123eeb79ca155c8919b67f42239dffa07f',
    evidenceContentHash: '6170af41ddc14c04412a1929a60c88f35062ec2440f6e4b3beb0539bd411f364',
    stage: 'development-evaluation',
    developmentMetricsObserved: true,
    developmentReportWritten: false,
    evaluationRerunAuthorized: false,
    exitCode: 1,
    failureTag: 'CandidateDevelopmentCommandError',
    failureStructuredOutputRendered: false,
    failureDisposition: 'DEFAULT_CLI_RENDERER_OMITTED_STRUCTURED_FAILURE',
    capturedOutputPath:
      'services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-development-attempt.log',
    capturedOutputSha256: '702aed20f08899cf84500e67321cce42b24d1425595f3fa9f313aea46224d3c1',
    capturedOutputBytes: 1_268,
    exactSourceLoadSha256: '4d3274ac428093ecc52a17669af5d1c677a05f25052065fe1a9a58f821e4dd3e',
    preMetricDiagnosticSha256: 'fd3682f152ed1c72e7e3aea0ba20f0694ae98f9857fa117ff8626815b0e533a8',
    registrationSourceManifestSha256: 'e6c1556e16d31df727929fd883899debfad43c31ad21e964f5da33820429a6bc',
    strategyProtocolHash: 'b4a2a6c65a7fa5973f7cbc1fd5031e77d529f4884562e5cc8a105fc870ced78f',
    strategyIdentityHash: 'ccf8f03db1f0f9eb54f7ad42194c938e5a53e11573488fd31e7af871967af25a',
    candidateDevelopmentProtocolHash: '663b59d6c570bbe3373d6e160609e0ad6294a687f435416f2a0956888d960738',
    calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
    priorTrialsHash: '1dfc9b6832d4841093becd2c276141110afdfce28a0a88b301cfe9959b900d62',
    preflightStatus: 'PASS',
    registrationStatus: 'PASS',
    marketData: {
      snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
      finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
      inputManifestHash: 'b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4',
      boundedContentHash: 'e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed',
    },
  },
} as const

export const candidate19ArchiveReceipt = {
  ...candidate19ArchiveReceiptMaterial,
  receiptHash: '73b39a7c70b6cdba7d030e1405d6d4151829177087a56868464f730fc9dbcdcc',
} satisfies LegacyCandidateArchiveReceipt

const candidate20ArchiveReceiptMaterial = {
  schemaVersion: 'bayn.candidate-archive-receipt.v1' as const,
  candidateOrdinal: 20,
  priorTrialCount: 19,
  status: 'PRECOMMIT_INVALID' as const,
  qualificationAttemptConsumed: false as const,
  nextCandidatePreregistration: null,
  historicalArtifacts: [
    historicalArtifact(
      'precommit-invalidation',
      'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-invalidation.json',
      '660a05860b133ead5242416635973cd82ed6c470',
      '4cf14feff76bef2d135a78f663cd61990b660cf8a0679166994fbeeb7a73aba3',
      1_910,
      49,
    ),
    historicalArtifact(
      'strategy-module',
      'services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts',
      '71ae99e9303e7b79a640f185e70faa68a3048910',
      '15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441',
      2_963_738,
      123_194,
    ),
    historicalArtifact(
      'source-manifest',
      'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json',
      'def5faba5a301b8fe4daa8f0557e8d53efb4b697',
      'b5d9c4da95f59d4d4483fa80665de5327f4ed0b04c3afa8a94a3316b91f9e1fe',
      1_290,
      20,
    ),
    historicalArtifact(
      'preregistration',
      'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json',
      '066a4d44cd41b871cad95474eb00e411af532c76',
      'e392888970d3c510e3ad20d6e982b81bf6234cd17260c8c5203013b5ce979409',
      1_252,
      19,
    ),
  ],
  facts: {
    reviewedHeadRevision: '82f58dd6bd6fc9849e779665873f934841b47ea7',
    mergedSourceRevision: '69d803040c8866e7703df50a645a096c54e7eca5',
    attemptStatus: 'UNATTEMPTED',
    metricBearingAttemptsConsumed: 0,
    invalidatedModule: {
      path: 'services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts',
      blobOid: '71ae99e9303e7b79a640f185e70faa68a3048910',
      sha256: '15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441',
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
  },
} as const

export const candidate20ArchiveReceipt = {
  ...candidate20ArchiveReceiptMaterial,
  receiptHash: 'd16c1dcbb3332cd5d490b110e9e8527525c79c05684f67cf2647df2492e2a0cd',
} satisfies LegacyCandidateArchiveReceipt

export const legacyCandidateArchiveReceipts = [
  candidate17ArchiveReceipt,
  candidate18ArchiveReceipt,
  candidate19ArchiveReceipt,
  candidate20ArchiveReceipt,
] as const

const isHex = (value: string, length: number): boolean => new RegExp(`^[0-9a-f]{${length}}$`).test(value)

export const validateLegacyCandidateArchiveReceipt = (
  receipt: LegacyCandidateArchiveReceipt,
): Result.Result<LegacyCandidateArchiveReceipt, LegacyCandidateArchiveReceiptIssue> => {
  if (receipt.candidateOrdinal !== receipt.priorTrialCount + 1) {
    return Result.fail({
      _tag: 'LegacyCandidateArchiveReceiptLineageMismatch',
      candidateOrdinal: receipt.candidateOrdinal,
      priorTrialCount: receipt.priorTrialCount,
    })
  }
  if (receipt.qualificationAttemptConsumed) {
    return Result.fail({ _tag: 'LegacyCandidateArchiveReceiptQualificationAttemptConsumed' })
  }
  for (const artifact of receipt.historicalArtifacts) {
    if (
      !isHex(artifact.blobOid, 40) ||
      !isHex(artifact.sha256, 64) ||
      artifact.byteCount <= 0 ||
      artifact.lineCount <= 0
    ) {
      return Result.fail({ _tag: 'LegacyCandidateArchiveReceiptArtifactInvalid', path: artifact.path })
    }
  }

  const { receiptHash: _, ...material } = receipt
  return pipe(
    canonicalHashV1Result(material),
    Result.mapError((cause) => ({ _tag: 'LegacyCandidateArchiveReceiptHashFailed' as const, cause })),
    Result.flatMap((observed) =>
      observed === receipt.receiptHash
        ? Result.succeed(receipt)
        : Result.fail({
            _tag: 'LegacyCandidateArchiveReceiptHashMismatch' as const,
            expected: receipt.receiptHash,
            observed,
          }),
    ),
  )
}
