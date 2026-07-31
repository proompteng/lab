import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  evaluateQualificationDormancy,
  validateQualificationDormancyLoaderMessage,
  type QualificationCandidatePreregistration,
} from './verify-qualification-dormancy'

const verifierPath = resolve(import.meta.dir, 'verify-qualification-dormancy.ts')
const temporaryDirectories: string[] = []
const hash = (character: string): string => character.repeat(64)
const revision = (character: string): string => character.repeat(40)
const authoritativeImports = [
  "import { candidateDevelopmentCalendarContract } from './candidate-development'",
  "import { canonicalHashV1Result } from './hash'",
].join('\n')

const moduleSource = (history: unknown, prefix = ''): string =>
  `${authoritativeImports}\n${prefix}export const frozenCandidateDevelopmentTrialHistory = ${JSON.stringify(history)} as const\n`

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const canonicalHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')

const exactMainTrialHistoryV1 = JSON.parse(
  '{"schemaVersion":"bayn.candidate-development-trial-history.v1","completedCandidateOrdinals":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],"developmentCandidateOrdinals":[17,18,19],"latestReviewedCandidateLegacyPriorTrials":{"schemaVersion":"bayn.candidate-development-prior-trials.v1","qualificationCandidateOrdinals":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],"developmentCandidateOrdinals":[17],"latestDevelopmentEvidence":{"candidateOrdinal":17,"priorTrialCount":16,"status":"DEVELOPMENT_REJECTED","evidenceContentHash":"97b9c2d6dc1d59d9b60686065bc4d595b8d1f22cdff9930b6131427b90e13f26","qualificationAttemptConsumed":false},"latestReviewedPreregistration":{"schemaVersion":"bayn.candidate-development-next-preregistration.v1","candidateOrdinal":17,"priorTrialCount":16,"strategyProtocolHash":"fa25d8c16bc4f4fde3bab99409ae60a6fd23332d295b3557231796cebb911390","modulePath":"services/bayn/src/strategy/volatility-managed-trend-overlay/candidate-17.ts","moduleSha256":"2e98bc55eae1901ccdde41978b7b32d746dc2ef6afcebbff1de0ed54574065da","marketData":{"schemaVersion":"bayn.candidate-development-market-data-source.v1","snapshotId":"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","finalizedSnapshotContentHash":"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","inputManifestHash":"b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4","boundedContentHash":"e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed"},"preregistration":{"sourceRevision":"890d8f5801cf7c7576ed7a0cee387a4e79b98877","path":"services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.json","blobOid":"c1d07233df53cc0379b1dfae9f1caffbd6b7abd6"}}},"latestReviewedCandidatePriorTrials":{"schemaVersion":"bayn.candidate-development-prior-trials.v2","qualificationCandidateOrdinals":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],"latestQualificationEvidence":{"candidateOrdinal":16,"priorTrialCount":15,"terminalStatus":"HOLD_REJECT","sourceRevision":"60a48a2e52fbafdd67a404a33a3cb22e82a98493"},"latestQualificationPreregistration":{"candidateOrdinal":16,"priorTrialCount":15,"sourceRevision":"a0dadcd2f6346968bd9df582e4673608afc04592","path":"services/bayn/candidates/ordinal-16-macro-breadth-regime-preregistration.md","blobOid":"f602e3c8fd1b85768404d5fbc439775cdcd2570b"},"developmentCandidateOrdinals":[17,18,19],"latestDevelopmentEvidence":{"candidateOrdinal":19,"priorTrialCount":18,"status":"DEVELOPMENT_REJECTED","evidenceContentHash":"6170af41ddc14c04412a1929a60c88f35062ec2440f6e4b3beb0539bd411f364","qualificationAttemptConsumed":false},"latestReviewedPreregistration":{"schemaVersion":"bayn.candidate-development-next-preregistration.v1","candidateOrdinal":19,"priorTrialCount":18,"strategyProtocolHash":"b4a2a6c65a7fa5973f7cbc1fd5031e77d529f4884562e5cc8a105fc870ced78f","strategyIdentityHash":"ccf8f03db1f0f9eb54f7ad42194c938e5a53e11573488fd31e7af871967af25a","candidateDevelopmentProtocolHash":"663b59d6c570bbe3373d6e160609e0ad6294a687f435416f2a0956888d960738","calendarHash":"4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237","priorTrialsHash":"1dfc9b6832d4841093becd2c276141110afdfce28a0a88b301cfe9959b900d62","modulePath":"services/bayn/src/strategy/inverse-volatility-risk-diversification/candidate-19.ts","moduleSha256":"90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f","marketData":{"schemaVersion":"bayn.candidate-development-market-data-source.v1","snapshotId":"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","finalizedSnapshotContentHash":"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","inputManifestHash":"b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4","boundedContentHash":"e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed"},"preregistration":{"sourceRevision":"bb24ec2ab4225b13920a2b50fb137c4134d2d75f","path":"services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-preregistration.json","blobOid":"02d9150a1f0007a644a084b3fca4cd543131374e"}}},"latestTerminalEvidence":{"candidateOrdinal":16,"priorTrialCount":15,"terminalStatus":"HOLD_REJECT","sourceRevision":"60a48a2e52fbafdd67a404a33a3cb22e82a98493"},"candidatePreregistration":{"candidateOrdinal":16,"priorTrialCount":15,"sourceRevision":"a0dadcd2f6346968bd9df582e4673608afc04592","path":"services/bayn/candidates/ordinal-16-macro-breadth-regime-preregistration.md","blobOid":"f602e3c8fd1b85768404d5fbc439775cdcd2570b"},"latestReviewedCandidatePreregistration":{"schemaVersion":"bayn.candidate-development-next-preregistration.v1","candidateOrdinal":20,"priorTrialCount":19,"strategyProtocolHash":"18b61d027e2235c7fc8ba718313ae8863650c2cb7c497dc4a7a5028829d19e0f","strategyIdentityHash":"8c99589120d8f3ed36c5286ce119d20490d42becd014e7fc2cc97b1420600278","candidateDevelopmentProtocolHash":"f7d4d78e70401c01c141fc7b63c4c1cfe9e7350b973c40ffbd7d8fe9832b332f","calendarHash":"4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237","priorTrialsHash":"dfda4c7706cdd7b2999a863ac63714c5d46894027442253f031b69bcdeaefde0","modulePath":"services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts","moduleSha256":"15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441","marketData":{"schemaVersion":"bayn.candidate-development-market-data-source.v1","snapshotId":"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","finalizedSnapshotContentHash":"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","inputManifestHash":"b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4","boundedContentHash":"e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed"},"preregistration":{"sourceRevision":"0b0a951465e1c4644bc3fd04b7b448b8701dc609","path":"services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json","blobOid":"066a4d44cd41b871cad95474eb00e411af532c76"}},"latestDevelopmentEvidence":{"candidateOrdinal":19,"priorTrialCount":18,"status":"DEVELOPMENT_REJECTED","evidenceContentHash":"6170af41ddc14c04412a1929a60c88f35062ec2440f6e4b3beb0539bd411f364","evaluatedSourceRevision":"276805b77d783db907dcb86cba934d7a4f6a0147","failureStage":"development-evaluation","developmentMetricsObserved":true,"qualificationAttemptConsumed":false},"nextCandidatePreregistration":{"schemaVersion":"bayn.candidate-development-next-preregistration.v1","candidateOrdinal":20,"priorTrialCount":19,"strategyProtocolHash":"18b61d027e2235c7fc8ba718313ae8863650c2cb7c497dc4a7a5028829d19e0f","strategyIdentityHash":"8c99589120d8f3ed36c5286ce119d20490d42becd014e7fc2cc97b1420600278","candidateDevelopmentProtocolHash":"f7d4d78e70401c01c141fc7b63c4c1cfe9e7350b973c40ffbd7d8fe9832b332f","calendarHash":"4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237","priorTrialsHash":"dfda4c7706cdd7b2999a863ac63714c5d46894027442253f031b69bcdeaefde0","modulePath":"services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts","moduleSha256":"15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441","marketData":{"schemaVersion":"bayn.candidate-development-market-data-source.v1","snapshotId":"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","finalizedSnapshotContentHash":"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","inputManifestHash":"b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4","boundedContentHash":"e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed"},"preregistration":{"sourceRevision":"0b0a951465e1c4644bc3fd04b7b448b8701dc609","path":"services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json","blobOid":"066a4d44cd41b871cad95474eb00e411af532c76"}}}',
) as Record<string, unknown>

const exactCandidate20Invalidation = JSON.parse(
  '{"schemaVersion":"bayn.candidate-development-precommit-invalidation.v1","candidateOrdinal":20,"priorTrialCount":19,"status":"PRECOMMIT_INVALID","attemptStatus":"UNATTEMPTED","metricBearingAttemptsConsumed":0,"qualificationAttemptConsumed":false,"reviewedHeadRevision":"82f58dd6bd6fc9849e779665873f934841b47ea7","mergedSourceRevision":"69d803040c8866e7703df50a645a096c54e7eca5","preregistration":{"sourceRevision":"0b0a951465e1c4644bc3fd04b7b448b8701dc609","path":"services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json","blobOid":"066a4d44cd41b871cad95474eb00e411af532c76","sha256":"e392888970d3c510e3ad20d6e982b81bf6234cd17260c8c5203013b5ce979409"},"sourceManifest":{"path":"services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json","blobOid":"def5faba5a301b8fe4daa8f0557e8d53efb4b697","sha256":"b5d9c4da95f59d4d4483fa80665de5327f4ed0b04c3afa8a94a3316b91f9e1fe"},"invalidatedModule":{"path":"services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts","blobOid":"71ae99e9303e7b79a640f185e70faa68a3048910","sha256":"15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441","lineCount":123194,"byteCount":2963738,"findings":["TYPE_CHECK_DISABLED","DOWNCOMPILED_BUNDLE","EMBEDDED_OFFICIAL_SESSIONS","EMBEDDED_MARKET_BARS","RUNTIME_INPUT_IGNORED"]},"naturalBuild":{"runId":"30657379582","imagePublished":true,"imageDigest":"sha256:28f59fb44bdb3008eecd17cf3c053098f214f3d982f26673a44a98d53f767fba","deploymentAllowed":false},"release":{"runId":"30657658256","conclusion":"CANCELLED","promotionCompleted":false,"rerunAllowed":false},"nextCandidatePreregistration":null}',
) as Record<string, unknown>

const exactCandidate20ContainmentHistoryV2: Record<string, unknown> = {
  ...exactMainTrialHistoryV1,
  schemaVersion: 'bayn.candidate-development-trial-history.v2',
  latestInvalidPrecommit: exactCandidate20Invalidation,
  nextCandidatePreregistration: null,
}

const exactCandidate19PriorTrials = JSON.parse(
  '{"schemaVersion":"bayn.candidate-development-prior-trials.v2","qualificationCandidateOrdinals":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],"latestQualificationEvidence":{"candidateOrdinal":16,"priorTrialCount":15,"terminalStatus":"HOLD_REJECT","sourceRevision":"60a48a2e52fbafdd67a404a33a3cb22e82a98493"},"latestQualificationPreregistration":{"candidateOrdinal":16,"priorTrialCount":15,"sourceRevision":"a0dadcd2f6346968bd9df582e4673608afc04592","path":"services/bayn/candidates/ordinal-16-macro-breadth-regime-preregistration.md","blobOid":"f602e3c8fd1b85768404d5fbc439775cdcd2570b"},"developmentCandidateOrdinals":[17,18],"latestDevelopmentEvidence":{"candidateOrdinal":18,"priorTrialCount":17,"status":"DEVELOPMENT_REJECTED","evidenceContentHash":"65d6f044f3f323aa87ff26a3dca011053aa3172c8a4ce422841497ccf370a5b6","qualificationAttemptConsumed":false},"latestReviewedPreregistration":{"schemaVersion":"bayn.candidate-development-next-preregistration.v1","candidateOrdinal":18,"priorTrialCount":17,"strategyProtocolHash":"7e27320b47cd170c1bc9c60ec3692593f2182af44bb48cef4d4a403b09601d75","strategyIdentityHash":"ff762a985c129055670224dca5827a65c689f6f50e1e3765e7b521a05417b1f0","candidateDevelopmentProtocolHash":"46657425873b4f766b5f49d0ebbe2ac3aa9cf53682a8508635be708406271877","calendarHash":"4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237","priorTrialsHash":"58f4e801380f35f483f998e00c82889e0cb6257e85542764e2dc8eaa4f3fd419","modulePath":"services/bayn/src/strategy/dual-momentum-global-equity/candidate-18.ts","moduleSha256":"27466a8c9a9acba475db9cd0d2916532208540a53bd1f0ece307df299e5e34e8","marketData":{"schemaVersion":"bayn.candidate-development-market-data-source.v1","snapshotId":"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","finalizedSnapshotContentHash":"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","inputManifestHash":"b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4","boundedContentHash":"e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed"},"preregistration":{"sourceRevision":"30614640c5dfa7a7d50bf053df153062ff0bbca4","path":"services/bayn/candidates/ordinal-18-global-equity-dual-momentum-preregistration.json","blobOid":"920a4afb8a7e5c1f6ef0875683ddc96a91008079"}}}',
) as Record<string, unknown>

const exactCandidate19Preregistration = JSON.parse(
  '{"schemaVersion":"bayn.candidate-development-next-preregistration.v1","candidateOrdinal":19,"priorTrialCount":18,"strategyProtocolHash":"b4a2a6c65a7fa5973f7cbc1fd5031e77d529f4884562e5cc8a105fc870ced78f","strategyIdentityHash":"ccf8f03db1f0f9eb54f7ad42194c938e5a53e11573488fd31e7af871967af25a","candidateDevelopmentProtocolHash":"663b59d6c570bbe3373d6e160609e0ad6294a687f435416f2a0956888d960738","calendarHash":"4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237","priorTrialsHash":"1dfc9b6832d4841093becd2c276141110afdfce28a0a88b301cfe9959b900d62","modulePath":"services/bayn/src/strategy/inverse-volatility-risk-diversification/candidate-19.ts","moduleSha256":"90813ab3a3d3cb000bb894309694f94588f98730a6f78b8e1418a5c38d8cb45f","marketData":{"schemaVersion":"bayn.candidate-development-market-data-source.v1","snapshotId":"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","finalizedSnapshotContentHash":"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","inputManifestHash":"b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4","boundedContentHash":"e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed"},"preregistration":{"sourceRevision":"bb24ec2ab4225b13920a2b50fb137c4134d2d75f","path":"services/bayn/candidates/ordinal-19-inverse-volatility-risk-diversification-preregistration.json","blobOid":"02d9150a1f0007a644a084b3fca4cd543131374e"}}',
) as Record<string, unknown>

const exactCandidate19DormantHistoryV1: Record<string, unknown> = {
  ...exactMainTrialHistoryV1,
  latestReviewedCandidatePriorTrials: exactCandidate19PriorTrials,
  latestReviewedCandidatePreregistration: exactCandidate19Preregistration,
  nextCandidatePreregistration: null,
}

const candidatePreregistration = (
  candidateOrdinal: number,
  completeIdentity: boolean,
  priorTrialsHash?: string,
): QualificationCandidatePreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal,
  priorTrialCount: candidateOrdinal - 1,
  strategyProtocolHash: hash('1'),
  ...(completeIdentity
    ? {
        strategyIdentityHash: hash('2'),
        candidateDevelopmentProtocolHash: hash('3'),
        calendarHash: hash('4'),
        priorTrialsHash: priorTrialsHash ?? hash('5'),
      }
    : {}),
  modulePath: `services/bayn/src/strategy/example/candidate-${candidateOrdinal}.ts`,
  moduleSha256: hash('6'),
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-source.v1',
    snapshotId: hash('7'),
    finalizedSnapshotContentHash: hash('8'),
    inputManifestHash: hash('9'),
    boundedContentHash: hash('a'),
  },
  preregistration: {
    sourceRevision: revision('b'),
    path: `services/bayn/candidates/ordinal-${candidateOrdinal}-example-preregistration.json`,
    blobOid: revision('c'),
  },
})

const historyRecords = () => {
  const completedCandidateOrdinals = [1]
  const developmentCandidateOrdinals = [2]
  const latestTerminalEvidence = {
    candidateOrdinal: 1,
    priorTrialCount: 0,
    terminalStatus: 'HOLD_REJECT',
    sourceRevision: revision('1'),
  } as const
  const candidateQualificationPreregistration = {
    candidateOrdinal: 1,
    priorTrialCount: 0,
    sourceRevision: revision('2'),
    path: 'services/bayn/candidates/ordinal-1-example-preregistration.md',
    blobOid: revision('3'),
  } as const
  const priorDevelopmentEvidence = {
    candidateOrdinal: 2,
    priorTrialCount: 1,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: hash('d'),
    qualificationAttemptConsumed: false,
  } as const
  const latestHistoricalPreregistration = candidatePreregistration(2, false)
  const latestReviewedCandidateLegacyPriorTrials = {
    schemaVersion: 'bayn.candidate-development-prior-trials.v1',
    qualificationCandidateOrdinals: completedCandidateOrdinals,
    developmentCandidateOrdinals,
    latestDevelopmentEvidence: priorDevelopmentEvidence,
    latestReviewedPreregistration: latestHistoricalPreregistration,
  } as const
  const latestReviewedCandidatePriorTrials = {
    schemaVersion: 'bayn.candidate-development-prior-trials.v2',
    qualificationCandidateOrdinals: completedCandidateOrdinals,
    latestQualificationEvidence: latestTerminalEvidence,
    latestQualificationPreregistration: candidateQualificationPreregistration,
    developmentCandidateOrdinals,
    latestDevelopmentEvidence: priorDevelopmentEvidence,
    latestReviewedPreregistration: latestHistoricalPreregistration,
  } as const
  const reviewed = candidatePreregistration(3, true, canonicalHash(latestReviewedCandidateLegacyPriorTrials))
  return {
    completedCandidateOrdinals,
    developmentCandidateOrdinals,
    latestReviewedCandidateLegacyPriorTrials,
    latestReviewedCandidatePriorTrials,
    latestTerminalEvidence,
    candidateQualificationPreregistration,
    reviewed,
    latestDevelopmentEvidence: {
      ...priorDevelopmentEvidence,
      evaluatedSourceRevision: revision('e'),
      failureStage: 'development-evaluation',
      developmentMetricsObserved: true,
    } as const,
  }
}

const reviewedPreregistration = (): QualificationCandidatePreregistration => historyRecords().reviewed

const trialHistory = (input?: {
  readonly schemaVersion?: 'bayn.candidate-development-trial-history.v1' | 'bayn.candidate-development-trial-history.v2'
  readonly next?: QualificationCandidatePreregistration | null
  readonly invalidation?: unknown
}): Record<string, unknown> => {
  const records = historyRecords()
  const reviewed = records.reviewed
  const schemaVersion = input?.schemaVersion ?? 'bayn.candidate-development-trial-history.v1'
  return {
    schemaVersion,
    completedCandidateOrdinals: records.completedCandidateOrdinals,
    developmentCandidateOrdinals: records.developmentCandidateOrdinals,
    latestReviewedCandidateLegacyPriorTrials: records.latestReviewedCandidateLegacyPriorTrials,
    latestReviewedCandidatePriorTrials: records.latestReviewedCandidatePriorTrials,
    latestTerminalEvidence: records.latestTerminalEvidence,
    candidatePreregistration: records.candidateQualificationPreregistration,
    latestReviewedCandidatePreregistration: reviewed,
    latestDevelopmentEvidence: records.latestDevelopmentEvidence,
    nextCandidatePreregistration: input?.next === undefined ? reviewed : input.next,
    ...(schemaVersion === 'bayn.candidate-development-trial-history.v2'
      ? { latestInvalidPrecommit: input?.invalidation ?? null }
      : {}),
  }
}

const invalidPrecommit = (): Record<string, unknown> => {
  const reviewed = reviewedPreregistration()
  return {
    schemaVersion: 'bayn.candidate-development-precommit-invalidation.v1',
    candidateOrdinal: reviewed.candidateOrdinal,
    priorTrialCount: reviewed.priorTrialCount,
    status: 'PRECOMMIT_INVALID',
    attemptStatus: 'UNATTEMPTED',
    metricBearingAttemptsConsumed: 0,
    qualificationAttemptConsumed: false,
    reviewedHeadRevision: revision('f'),
    mergedSourceRevision: revision('0'),
    preregistration: {
      ...reviewed.preregistration,
      sha256: hash('b'),
    },
    sourceManifest: {
      path: 'services/bayn/candidates/ordinal-3-example-source-manifest.json',
      blobOid: revision('1'),
      sha256: hash('c'),
    },
    invalidatedModule: {
      path: reviewed.modulePath,
      blobOid: revision('2'),
      sha256: reviewed.moduleSha256,
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
      runId: '1234',
      imagePublished: true,
      imageDigest: `sha256:${hash('d')}`,
      deploymentAllowed: false,
    },
    release: {
      runId: '5678',
      conclusion: 'CANCELLED',
      promotionCompleted: false,
      rerunAllowed: false,
    },
    nextCandidatePreregistration: null,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('qualification dormancy verifier', () => {
  test('decodes the exact main v1 and #13442 v2 authoritative histories', () => {
    expect(canonicalHash(exactMainTrialHistoryV1)).toBe(
      '9d78af3efcc888f07973ec88298ac6c76338edef7139942e573af5d338b4e58c',
    )
    expect(evaluateQualificationDormancy(exactMainTrialHistoryV1)).toEqual({
      status: 'ready',
      reason: 'reviewed-preregistration-present',
      candidateOrdinal: 20,
      preregistrationSourceRevision: '0b0a951465e1c4644bc3fd04b7b448b8701dc609',
      preregistrationBlobOid: '066a4d44cd41b871cad95474eb00e411af532c76',
    })

    expect(canonicalHash(exactCandidate19DormantHistoryV1)).toBe(
      '081ae8072bd3f05acf9f29554ca2ad74ea51ad5a271d7dfa42847c148ff2c2e5',
    )
    expect(evaluateQualificationDormancy(exactCandidate19DormantHistoryV1)).toEqual({
      status: 'dormant',
      reason: 'preregistration-missing',
      candidateOrdinal: null,
    })

    expect(canonicalHash(exactCandidate20ContainmentHistoryV2)).toBe(
      '097c8164f2ec3add5e23189039957d76a954a5576705090f75d6614e7f42ea00',
    )
    expect(evaluateQualificationDormancy(exactCandidate20ContainmentHistoryV2)).toEqual({
      status: 'dormant',
      reason: 'precommit-invalid-unattempted',
      candidateOrdinal: 20,
    })
  })

  test('rejects contradictory failure metadata in every exact authoritative history shape', () => {
    const exactHistories = [
      ['Candidate 19 dormant v1', exactCandidate19DormantHistoryV1],
      ['current Candidate 20 ready v1', exactMainTrialHistoryV1],
      ['#13442 Candidate 20 invalidated v2', exactCandidate20ContainmentHistoryV2],
    ] as const

    for (const [label, history] of exactHistories) {
      for (const [failureStage, developmentMetricsObserved] of [
        ['buildEvaluation-preflight', true],
        ['development-evaluation', false],
      ] as const) {
        const contradictory = structuredClone(history)
        contradictory.latestDevelopmentEvidence = {
          ...(contradictory.latestDevelopmentEvidence as Record<string, unknown>),
          failureStage,
          developmentMetricsObserved,
        }
        expect(() => evaluateQualificationDormancy(contradictory), label).toThrow()
      }

      for (const missingField of ['failureStage', 'developmentMetricsObserved'] as const) {
        const incomplete = structuredClone(history)
        const latestDevelopmentEvidence = {
          ...(incomplete.latestDevelopmentEvidence as Record<string, unknown>),
        }
        delete latestDevelopmentEvidence[missingField]
        incomplete.latestDevelopmentEvidence = latestDevelopmentEvidence
        expect(() => evaluateQualificationDormancy(incomplete), label).toThrow()
      }
    }
  })

  test('returns a clean no-op when no preregistration is authorized', () => {
    expect(evaluateQualificationDormancy(exactCandidate19DormantHistoryV1)).toEqual({
      status: 'dormant',
      reason: 'preregistration-missing',
      candidateOrdinal: null,
    })
  })

  test('returns a clean no-op for an unattempted invalid precommit', () => {
    expect(
      evaluateQualificationDormancy(
        trialHistory({
          schemaVersion: 'bayn.candidate-development-trial-history.v2',
          next: null,
          invalidation: invalidPrecommit(),
        }),
      ),
    ).toEqual({
      status: 'dormant',
      reason: 'precommit-invalid-unattempted',
      candidateOrdinal: 3,
    })
  })

  test('allows only the exact separately reviewed non-null preregistration', () => {
    expect(evaluateQualificationDormancy(trialHistory())).toEqual({
      status: 'ready',
      reason: 'reviewed-preregistration-present',
      candidateOrdinal: 3,
      preregistrationSourceRevision: revision('b'),
      preregistrationBlobOid: revision('c'),
    })
  })

  test('accepts exactly one closed authenticated IPC result', () => {
    const nonce = hash('f')
    const payload = JSON.stringify(exactCandidate19DormantHistoryV1)
    const message = { type: 'result', nonce, payload }

    expect(validateQualificationDormancyLoaderMessage(message, nonce, null)).toBe(payload)
    for (const invalid of [
      null,
      { ...message, nonce: hash('e') },
      { ...message, type: 'bootstrap' },
      { ...message, payload: 1 },
      { ...message, extra: true },
    ]) {
      expect(() => validateQualificationDormancyLoaderMessage(invalid, nonce, null)).toThrow()
    }
    expect(() => validateQualificationDormancyLoaderMessage(message, 'not-a-nonce', null)).toThrow()
    expect(() => validateQualificationDormancyLoaderMessage(message, nonce, payload)).toThrow()
    expect(() =>
      validateQualificationDormancyLoaderMessage(
        { type: 'result', nonce, payload: 'x'.repeat(1024 * 1024 + 1) },
        nonce,
        null,
      ),
    ).toThrow()
  })

  test('fails closed on malformed, mismatched, and ambiguous evidence', () => {
    const records = historyRecords()
    const reviewed = reviewedPreregistration()
    const mismatched: QualificationCandidatePreregistration = {
      ...reviewed,
      preregistration: { ...reviewed.preregistration, sourceRevision: revision('a') },
    }
    const mismatchedPriorTrialsHash: QualificationCandidatePreregistration = {
      ...reviewed,
      priorTrialsHash: hash('0'),
    }
    const invalidation = invalidPrecommit()
    invalidation.attemptStatus = 'ATTEMPTED'

    const malformed: unknown[] = [
      null,
      {},
      { ...trialHistory(), schemaVersion: 'bayn.candidate-development-trial-history.v3' },
      { ...trialHistory(), developmentCandidateOrdinals: [3] },
      { ...trialHistory(), latestTerminalEvidence: {} },
      { ...trialHistory(), candidatePreregistration: {} },
      { ...trialHistory(), latestReviewedCandidateLegacyPriorTrials: {} },
      { ...trialHistory(), latestReviewedCandidatePriorTrials: {} },
      {
        ...trialHistory(),
        latestReviewedCandidatePriorTrials: {
          ...records.latestReviewedCandidatePriorTrials,
          latestQualificationEvidence: {
            ...records.latestTerminalEvidence,
            sourceRevision: revision('f'),
          },
        },
      },
      {
        ...trialHistory(),
        latestDevelopmentEvidence: {
          ...records.latestDevelopmentEvidence,
          evidenceContentHash: hash('f'),
        },
      },
      {
        ...trialHistory(),
        latestDevelopmentEvidence: {
          ...records.latestDevelopmentEvidence,
          failureStage: 'buildEvaluation-preflight',
          developmentMetricsObserved: true,
        },
      },
      {
        ...trialHistory(),
        latestDevelopmentEvidence: {
          ...records.latestDevelopmentEvidence,
          failureStage: 'development-evaluation',
          developmentMetricsObserved: false,
        },
      },
      {
        ...trialHistory(),
        latestDevelopmentEvidence: {
          ...records.latestDevelopmentEvidence,
          developmentMetricsObserved: undefined,
        },
      },
      {
        ...trialHistory(),
        latestDevelopmentEvidence: {
          ...records.latestDevelopmentEvidence,
          failureStage: undefined,
        },
      },
      { ...trialHistory(), latestReviewedCandidatePreregistration: mismatchedPriorTrialsHash },
      { ...trialHistory(), nextCandidatePreregistration: mismatched },
      trialHistory({
        schemaVersion: 'bayn.candidate-development-trial-history.v2',
        next: null,
        invalidation,
      }),
      trialHistory({
        schemaVersion: 'bayn.candidate-development-trial-history.v2',
        next: reviewedPreregistration(),
        invalidation: invalidPrecommit(),
      }),
    ]

    for (const evidence of malformed) expect(() => evaluateQualificationDormancy(evidence)).toThrow()
  })

  test('runs against the fixed authoritative path and writes output only after a valid decision', () => {
    const cases = [
      {
        history: exactCandidate19DormantHistoryV1,
        expected: ['dormant=true', 'reason=preregistration-missing', 'candidate_ordinal='],
      },
      {
        history: trialHistory({
          schemaVersion: 'bayn.candidate-development-trial-history.v2',
          next: null,
          invalidation: invalidPrecommit(),
        }),
        expected: ['dormant=true', 'reason=precommit-invalid-unattempted', 'candidate_ordinal=3'],
      },
      {
        history: trialHistory(),
        expected: ['dormant=false', 'reason=reviewed-preregistration-present', 'candidate_ordinal=3'],
      },
    ]

    for (const { history, expected } of cases) {
      const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-test-'))
      temporaryDirectories.push(repository)
      const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
      mkdirSync(dirname(modulePath), { recursive: true })
      writeFileSync(
        modulePath,
        moduleSource(
          history,
          `if (process.env.GITHUB_OUTPUT) throw new Error('workflow output leaked into the module')\n`,
        ),
      )
      const outputPath = join(repository, 'github-output')
      writeFileSync(outputPath, '')

      const result = Bun.spawnSync([
        process.execPath,
        verifierPath,
        '--repository-root',
        repository,
        '--github-output',
        outputPath,
      ])

      if (result.exitCode !== 0) {
        throw new Error(`valid evidence failed: ${result.stderr.toString()}`)
      }
      expect(result.stderr.toString()).toBe('')
      expect(readFileSync(outputPath, 'utf8')).toBe(`${expected.join('\n')}\n`)
    }
  })

  test('leaves no runnable output for missing, throwing, imported, or ambiguous evidence', () => {
    const moduleSources = [
      { label: 'missing', source: null },
      {
        label: 'throwing',
        source: moduleSource(trialHistory(), `throw new Error('unloadable')\n`),
      },
      {
        label: 'unsupported import',
        source: `${authoritativeImports}\nimport 'node:fs'\nexport const frozenCandidateDevelopmentTrialHistory = ${JSON.stringify(trialHistory())}\n`,
      },
      {
        label: 'ambiguous state',
        source: moduleSource(
          trialHistory({
            schemaVersion: 'bayn.candidate-development-trial-history.v2',
            next: reviewedPreregistration(),
            invalidation: invalidPrecommit(),
          }),
        ),
      },
      {
        label: 'bounded output',
        source: `${authoritativeImports}
const history = ${JSON.stringify(trialHistory())}
history.latestTerminalEvidence = { padding: 'x'.repeat(1024 * 1024 + 1) }
export const frozenCandidateDevelopmentTrialHistory = history
`,
      },
    ]

    for (const { label, source } of moduleSources) {
      const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-failure-test-'))
      temporaryDirectories.push(repository)
      const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
      mkdirSync(dirname(modulePath), { recursive: true })
      if (source !== null) writeFileSync(modulePath, source)
      const outputPath = join(repository, 'github-output')
      writeFileSync(outputPath, '')

      const result = Bun.spawnSync([
        process.execPath,
        verifierPath,
        '--repository-root',
        repository,
        '--github-output',
        outputPath,
      ])

      if (result.exitCode === 0) {
        throw new Error(`${label} evidence unexpectedly succeeded: ${result.stdout.toString()}`)
      }
      expect(readFileSync(outputPath, 'utf8')).toBe('')
    }
  })

  test('stops null, invalid, and malformed run shapes before fake image or privileged input access', () => {
    const contradictoryFailureHistory = trialHistory()
    contradictoryFailureHistory.latestDevelopmentEvidence = {
      ...(contradictoryFailureHistory.latestDevelopmentEvidence as Record<string, unknown>),
      failureStage: 'buildEvaluation-preflight',
      developmentMetricsObserved: true,
    }
    const cases = [
      {
        label: 'null preregistration',
        source: moduleSource(exactCandidate19DormantHistoryV1),
        exitCode: 0,
        access: false,
      },
      {
        label: 'invalid unattempted precommit',
        source: moduleSource(
          trialHistory({
            schemaVersion: 'bayn.candidate-development-trial-history.v2',
            next: null,
            invalidation: invalidPrecommit(),
          }),
        ),
        exitCode: 0,
        access: false,
      },
      {
        label: 'malformed evidence',
        source: moduleSource({ ...trialHistory(), latestReviewedCandidatePriorTrials: {} }),
        exitCode: 1,
        access: false,
      },
      {
        label: 'contradictory failure metadata',
        source: moduleSource(contradictoryFailureHistory),
        exitCode: 1,
        access: false,
      },
      {
        label: 'reviewed preregistration',
        source: moduleSource(trialHistory()),
        exitCode: 0,
        access: true,
      },
    ]

    for (const testCase of cases) {
      const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-run-shape-test-'))
      temporaryDirectories.push(repository)
      const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
      mkdirSync(dirname(modulePath), { recursive: true })
      writeFileSync(modulePath, testCase.source)
      const outputPath = join(repository, 'github-output')
      const imageInput = join(repository, 'fake-image-input')
      const privilegedInput = join(repository, 'fake-privileged-input')
      const accessLog = join(repository, 'access-log')
      writeFileSync(outputPath, '')
      writeFileSync(imageInput, 'image\n')
      writeFileSync(privilegedInput, 'privileged\n')

      const script = `
set -euo pipefail
bun ${JSON.stringify(verifierPath)} --repository-root ${JSON.stringify(repository)} --github-output ${JSON.stringify(outputPath)}
dormant="$(sed -n 's/^dormant=//p' ${JSON.stringify(outputPath)})"
if [ "$dormant" = 'true' ]; then
  echo SAFE_NOOP
  exit 0
fi
cat ${JSON.stringify(imageInput)} ${JSON.stringify(privilegedInput)} > ${JSON.stringify(accessLog)}
echo PROCEEDED
`
      const result = Bun.spawnSync(['bash', '-c', script])

      expect(result.exitCode, testCase.label).toBe(testCase.exitCode)
      expect(existsSync(accessLog), testCase.label).toBe(testCase.access)
      if (testCase.access) {
        expect(readFileSync(accessLog, 'utf8')).toBe('image\nprivileged\n')
        expect(result.stdout.toString()).toContain('PROCEEDED')
      } else if (testCase.exitCode === 0) {
        expect(result.stdout.toString()).toContain('SAFE_NOOP')
      } else {
        expect(readFileSync(outputPath, 'utf8')).toBe('')
      }
    }
  })

  test('isolates hostile module evaluation from workflow outputs, secrets, files, and child processes', () => {
    const repository = mkdtempSync(join(tmpdir(), 'qualification-dormancy-hostile-loader-test-'))
    temporaryDirectories.push(repository)
    const modulePath = join(repository, 'services/bayn/src/candidate-development-trial-history.ts')
    const outputPath = join(repository, 'github-output')
    const sentinelPath = join(repository, 'sentinel')
    const childMarkerPath = join(repository, 'child-marker')
    mkdirSync(dirname(modulePath), { recursive: true })
    writeFileSync(outputPath, '')
    writeFileSync(sentinelPath, 'safe\n')
    const hostilePrefix = `
if (process.env.GITHUB_TOKEN || process.env.BAYN_POSTGRES_URL || process.env.GITHUB_OUTPUT) {
  throw new Error('privileged environment leaked')
}
try { process.send?.({ type: 'result', nonce: 'forged', payload: ${JSON.stringify(JSON.stringify(trialHistory()))} }) } catch {}
try { process.stdout.write('FORGED_TRIAL_HISTORY') } catch {}
try {
  const escapedProcess = globalThis.constructor.constructor('return process')()
  escapedProcess.stdout.write('FORGED_TRIAL_HISTORY')
  const fs = escapedProcess.getBuiltinModule('node:fs')
  for (const path of ${JSON.stringify([outputPath, sentinelPath])}) fs.writeFileSync(path, 'compromised\\n')
  escapedProcess.getBuiltinModule('node:child_process').spawnSync(escapedProcess.execPath, [
    '-e',
    ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childMarkerPath)}, 'spawned')`)},
  ])
} catch {}
`
    writeFileSync(modulePath, moduleSource(trialHistory(), hostilePrefix))

    const result = Bun.spawnSync(
      [process.execPath, verifierPath, '--repository-root', repository, '--github-output', outputPath],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: 'must-not-reach-loader',
          BAYN_POSTGRES_URL: 'must-not-reach-loader',
          GITHUB_OUTPUT: outputPath,
        },
      },
    )

    if (result.exitCode !== 0) throw new Error(`hostile loader fixture failed: ${result.stderr.toString()}`)
    expect(result.stderr.toString()).toBe('')
    expect(result.stdout.toString()).not.toContain('FORGED_TRIAL_HISTORY')
    expect(result.stdout.toString().match(/BAYN_QUALIFICATION_DORMANCY=/g)).toHaveLength(1)
    expect(readFileSync(sentinelPath, 'utf8')).toBe('safe\n')
    expect(existsSync(childMarkerPath)).toBe(false)
    expect(readFileSync(outputPath, 'utf8')).toBe(
      'dormant=false\nreason=reviewed-preregistration-present\ncandidate_ordinal=3\n',
    )
  })
})
