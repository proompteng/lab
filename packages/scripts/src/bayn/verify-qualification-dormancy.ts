#!/usr/bin/env bun

import { fork } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const trialHistoryRelativePath = 'services/bayn/src/candidate-development-trial-history.ts'
const trialHistoryExport = 'frozenCandidateDevelopmentTrialHistory'
const maximumLoaderOutputBytes = 1024 * 1024
const maximumTrialHistorySourceBytes = 512 * 1024
const loaderTimeoutMs = 5_000

const sha40 = /^[0-9a-f]{40}$/
const sha64 = /^[0-9a-f]{64}$/
const imageDigest = /^sha256:[0-9a-f]{64}$/
const candidateModulePath = /^services\/bayn\/src\/strategy\/[A-Za-z0-9._/-]+\.ts$/
const candidatePreregistrationPath = /^services\/bayn\/candidates\/[A-Za-z0-9._/-]+\.json$/
const qualificationPreregistrationPath = /^services\/bayn\/candidates\/[A-Za-z0-9._/-]+\.(?:json|md)$/

export interface QualificationCandidatePreregistration {
  readonly schemaVersion: 'bayn.candidate-development-next-preregistration.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyIdentityHash?: string
  readonly candidateDevelopmentProtocolHash?: string
  readonly calendarHash?: string
  readonly priorTrialsHash?: string
  readonly modulePath: string
  readonly moduleSha256: string
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-source.v1'
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
  readonly preregistration: {
    readonly sourceRevision: string
    readonly path: string
    readonly blobOid: string
  }
}

export type QualificationDormancyDecision =
  | {
      readonly status: 'dormant'
      readonly reason: 'preregistration-missing'
      readonly candidateOrdinal: null
    }
  | {
      readonly status: 'dormant'
      readonly reason: 'precommit-invalid-unattempted'
      readonly candidateOrdinal: number
    }
  | {
      readonly status: 'ready'
      readonly reason: 'reviewed-preregistration-present'
      readonly candidateOrdinal: number
      readonly preregistrationSourceRevision: string
      readonly preregistrationBlobOid: string
    }

const exactKeys = (record: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const observed = Object.keys(record).sort()
  const required = [...expected].sort()
  if (observed.length !== required.length || observed.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has an unsupported or incomplete schema`)
  }
}

const exactOptionalKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void => {
  const observed = Object.keys(record)
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.hasOwn(record, key)) || observed.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has an unsupported or incomplete schema`)
  }
}

const dataRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`)
  const output: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} must not contain symbol properties`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.enumerable !== true || !('value' in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property`)
    }
    output[key] = descriptor.value
  }
  return output
}

export const validateQualificationDormancyLoaderMessage = (
  message: unknown,
  expectedNonce: string,
  priorPayload: string | null,
): string => {
  if (!sha64.test(expectedNonce)) throw new Error('qualification dormancy loader nonce is malformed')
  if (priorPayload !== null) throw new Error('qualification dormancy loader emitted duplicate results')
  const record = dataRecord(message, 'qualification dormancy loader message')
  exactKeys(record, ['type', 'nonce', 'payload'], 'qualification dormancy loader message')
  if (record.type !== 'result' || record.nonce !== expectedNonce || typeof record.payload !== 'string') {
    throw new Error('qualification dormancy loader message is unauthenticated')
  }
  if (Buffer.byteLength(record.payload, 'utf8') > maximumLoaderOutputBytes) {
    throw new Error('qualification dormancy loader result exceeded the bound')
  }
  return record.payload
}

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} must be a non-empty single-line string`)
  }
  return value
}

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

const nonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value
}

const hash = (value: unknown, pattern: RegExp, label: string): string => {
  const decoded = nonEmptyString(value, label)
  if (!pattern.test(decoded)) throw new Error(`${label} is malformed`)
  return decoded
}

const ordinalList = (value: unknown, label: string): readonly number[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const output = value.map((entry, index) => positiveInteger(entry, `${label}[${index}]`))
  if (output.some((entry, index) => index > 0 && entry <= (output[index - 1] ?? 0))) {
    throw new Error(`${label} must be strictly increasing`)
  }
  return output
}

const decodePreregistration = (
  value: unknown,
  label: string,
  requireCompleteIdentity = false,
): QualificationCandidatePreregistration => {
  const record = dataRecord(value, label)
  const identityKeys = [
    'strategyIdentityHash',
    'candidateDevelopmentProtocolHash',
    'calendarHash',
    'priorTrialsHash',
  ] as const
  exactOptionalKeys(
    record,
    [
      'schemaVersion',
      'candidateOrdinal',
      'priorTrialCount',
      'strategyProtocolHash',
      'modulePath',
      'moduleSha256',
      'marketData',
      'preregistration',
    ],
    identityKeys,
    label,
  )
  if (requireCompleteIdentity && identityKeys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} is missing the complete reviewed identity`)
  }
  if (record.schemaVersion !== 'bayn.candidate-development-next-preregistration.v1') {
    throw new Error(`${label}.schemaVersion is unsupported`)
  }
  const candidateOrdinal = positiveInteger(record.candidateOrdinal, `${label}.candidateOrdinal`)
  const priorTrialCount = nonNegativeInteger(record.priorTrialCount, `${label}.priorTrialCount`)
  if (candidateOrdinal !== priorTrialCount + 1) throw new Error(`${label} ordinal lineage is invalid`)

  const modulePath = nonEmptyString(record.modulePath, `${label}.modulePath`)
  if (!candidateModulePath.test(modulePath) || modulePath.includes('..'))
    throw new Error(`${label}.modulePath is invalid`)

  const marketData = dataRecord(record.marketData, `${label}.marketData`)
  exactKeys(
    marketData,
    ['schemaVersion', 'snapshotId', 'finalizedSnapshotContentHash', 'inputManifestHash', 'boundedContentHash'],
    `${label}.marketData`,
  )
  if (marketData.schemaVersion !== 'bayn.candidate-development-market-data-source.v1') {
    throw new Error(`${label}.marketData.schemaVersion is unsupported`)
  }

  const preregistration = dataRecord(record.preregistration, `${label}.preregistration`)
  exactKeys(preregistration, ['sourceRevision', 'path', 'blobOid'], `${label}.preregistration`)
  const preregistrationPath = nonEmptyString(preregistration.path, `${label}.preregistration.path`)
  if (!candidatePreregistrationPath.test(preregistrationPath) || preregistrationPath.includes('..')) {
    throw new Error(`${label}.preregistration.path is invalid`)
  }

  const strategyIdentityHash = Object.hasOwn(record, 'strategyIdentityHash')
    ? hash(record.strategyIdentityHash, sha64, `${label}.strategyIdentityHash`)
    : undefined
  const candidateDevelopmentProtocolHash = Object.hasOwn(record, 'candidateDevelopmentProtocolHash')
    ? hash(record.candidateDevelopmentProtocolHash, sha64, `${label}.candidateDevelopmentProtocolHash`)
    : undefined
  const calendarHash = Object.hasOwn(record, 'calendarHash')
    ? hash(record.calendarHash, sha64, `${label}.calendarHash`)
    : undefined
  const priorTrialsHash = Object.hasOwn(record, 'priorTrialsHash')
    ? hash(record.priorTrialsHash, sha64, `${label}.priorTrialsHash`)
    : undefined

  return {
    schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
    candidateOrdinal,
    priorTrialCount,
    strategyProtocolHash: hash(record.strategyProtocolHash, sha64, `${label}.strategyProtocolHash`),
    ...(strategyIdentityHash === undefined ? {} : { strategyIdentityHash }),
    ...(candidateDevelopmentProtocolHash === undefined ? {} : { candidateDevelopmentProtocolHash }),
    ...(calendarHash === undefined ? {} : { calendarHash }),
    ...(priorTrialsHash === undefined ? {} : { priorTrialsHash }),
    modulePath,
    moduleSha256: hash(record.moduleSha256, sha64, `${label}.moduleSha256`),
    marketData: {
      schemaVersion: 'bayn.candidate-development-market-data-source.v1',
      snapshotId: hash(marketData.snapshotId, sha64, `${label}.marketData.snapshotId`),
      finalizedSnapshotContentHash: hash(
        marketData.finalizedSnapshotContentHash,
        sha64,
        `${label}.marketData.finalizedSnapshotContentHash`,
      ),
      inputManifestHash: hash(marketData.inputManifestHash, sha64, `${label}.marketData.inputManifestHash`),
      boundedContentHash: hash(marketData.boundedContentHash, sha64, `${label}.marketData.boundedContentHash`),
    },
    preregistration: {
      sourceRevision: hash(preregistration.sourceRevision, sha40, `${label}.preregistration.sourceRevision`),
      path: preregistrationPath,
      blobOid: hash(preregistration.blobOid, sha40, `${label}.preregistration.blobOid`),
    },
  }
}

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

interface QualificationEvidence {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly terminalStatus: 'HOLD_REJECT'
  readonly sourceRevision: string
}

interface QualificationPreregistration {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly sourceRevision: string
  readonly path: string
  readonly blobOid: string
}

interface PriorDevelopmentEvidence {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly status: 'DEVELOPMENT_REJECTED'
  readonly evidenceContentHash: string
  readonly qualificationAttemptConsumed: false
}

interface LatestDevelopmentEvidence extends PriorDevelopmentEvidence {
  readonly evaluatedSourceRevision: string
  readonly reviewedSourceRevision?: string
  readonly mergedSourceRevision?: string
  readonly failureStage?: 'buildEvaluation-preflight' | 'development-evaluation'
  readonly developmentMetricsObserved?: boolean
}

interface LegacyPriorTrialsMaterial {
  readonly schemaVersion: 'bayn.candidate-development-prior-trials.v1'
  readonly qualificationCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestDevelopmentEvidence: PriorDevelopmentEvidence
  readonly latestReviewedPreregistration: QualificationCandidatePreregistration
}

interface PriorTrialsMaterial {
  readonly schemaVersion: 'bayn.candidate-development-prior-trials.v2'
  readonly qualificationCandidateOrdinals: readonly number[]
  readonly latestQualificationEvidence: QualificationEvidence
  readonly latestQualificationPreregistration: QualificationPreregistration
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestDevelopmentEvidence: PriorDevelopmentEvidence
  readonly latestReviewedPreregistration: QualificationCandidatePreregistration
}

const assertSameCanonical = (left: unknown, right: unknown, label: string): void => {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${label} is inconsistent`)
}

const assertOrdinalRange = (ordinals: readonly number[], start: number, label: string): void => {
  if (ordinals.length === 0 || ordinals.some((ordinal, index) => ordinal !== start + index)) {
    throw new Error(`${label} is not a contiguous ordinal range`)
  }
}

const decodeQualificationEvidence = (value: unknown, label: string): QualificationEvidence => {
  const record = dataRecord(value, label)
  exactKeys(record, ['candidateOrdinal', 'priorTrialCount', 'terminalStatus', 'sourceRevision'], label)
  const candidateOrdinal = positiveInteger(record.candidateOrdinal, `${label}.candidateOrdinal`)
  const priorTrialCount = nonNegativeInteger(record.priorTrialCount, `${label}.priorTrialCount`)
  if (candidateOrdinal !== priorTrialCount + 1 || record.terminalStatus !== 'HOLD_REJECT') {
    throw new Error(`${label} has invalid qualification lineage`)
  }
  return {
    candidateOrdinal,
    priorTrialCount,
    terminalStatus: 'HOLD_REJECT',
    sourceRevision: hash(record.sourceRevision, sha40, `${label}.sourceRevision`),
  }
}

const decodeQualificationPreregistration = (value: unknown, label: string): QualificationPreregistration => {
  const record = dataRecord(value, label)
  exactKeys(record, ['candidateOrdinal', 'priorTrialCount', 'sourceRevision', 'path', 'blobOid'], label)
  const candidateOrdinal = positiveInteger(record.candidateOrdinal, `${label}.candidateOrdinal`)
  const priorTrialCount = nonNegativeInteger(record.priorTrialCount, `${label}.priorTrialCount`)
  if (candidateOrdinal !== priorTrialCount + 1) throw new Error(`${label} has invalid qualification lineage`)
  const path = nonEmptyString(record.path, `${label}.path`)
  if (!qualificationPreregistrationPath.test(path) || path.includes('..')) throw new Error(`${label}.path is invalid`)
  return {
    candidateOrdinal,
    priorTrialCount,
    sourceRevision: hash(record.sourceRevision, sha40, `${label}.sourceRevision`),
    path,
    blobOid: hash(record.blobOid, sha40, `${label}.blobOid`),
  }
}

const decodePriorDevelopmentEvidence = (value: unknown, label: string): PriorDevelopmentEvidence => {
  const record = dataRecord(value, label)
  exactKeys(
    record,
    ['candidateOrdinal', 'priorTrialCount', 'status', 'evidenceContentHash', 'qualificationAttemptConsumed'],
    label,
  )
  const candidateOrdinal = positiveInteger(record.candidateOrdinal, `${label}.candidateOrdinal`)
  const priorTrialCount = nonNegativeInteger(record.priorTrialCount, `${label}.priorTrialCount`)
  if (
    candidateOrdinal !== priorTrialCount + 1 ||
    record.status !== 'DEVELOPMENT_REJECTED' ||
    record.qualificationAttemptConsumed !== false
  ) {
    throw new Error(`${label} has invalid development lineage`)
  }
  return {
    candidateOrdinal,
    priorTrialCount,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: hash(record.evidenceContentHash, sha64, `${label}.evidenceContentHash`),
    qualificationAttemptConsumed: false,
  }
}

const decodeLatestDevelopmentEvidence = (value: unknown, label: string): LatestDevelopmentEvidence => {
  const record = dataRecord(value, label)
  exactOptionalKeys(
    record,
    [
      'candidateOrdinal',
      'priorTrialCount',
      'status',
      'evidenceContentHash',
      'evaluatedSourceRevision',
      'qualificationAttemptConsumed',
    ],
    ['reviewedSourceRevision', 'mergedSourceRevision', 'failureStage', 'developmentMetricsObserved'],
    label,
  )
  const prior = decodePriorDevelopmentEvidence(
    {
      candidateOrdinal: record.candidateOrdinal,
      priorTrialCount: record.priorTrialCount,
      status: record.status,
      evidenceContentHash: record.evidenceContentHash,
      qualificationAttemptConsumed: record.qualificationAttemptConsumed,
    },
    label,
  )
  const reviewedSourceRevision = Object.hasOwn(record, 'reviewedSourceRevision')
    ? hash(record.reviewedSourceRevision, sha40, `${label}.reviewedSourceRevision`)
    : undefined
  const mergedSourceRevision = Object.hasOwn(record, 'mergedSourceRevision')
    ? hash(record.mergedSourceRevision, sha40, `${label}.mergedSourceRevision`)
    : undefined
  const hasFailureStage = Object.hasOwn(record, 'failureStage')
  const hasDevelopmentMetricsObserved = Object.hasOwn(record, 'developmentMetricsObserved')
  if (hasFailureStage !== hasDevelopmentMetricsObserved) {
    throw new Error(`${label} failure stage and metric observation must be recorded together`)
  }
  const failureStage = hasFailureStage
    ? record.failureStage === 'buildEvaluation-preflight' || record.failureStage === 'development-evaluation'
      ? record.failureStage
      : (() => {
          throw new Error(`${label}.failureStage is unsupported`)
        })()
    : undefined
  const developmentMetricsObserved = hasDevelopmentMetricsObserved
    ? typeof record.developmentMetricsObserved === 'boolean'
      ? record.developmentMetricsObserved
      : (() => {
          throw new Error(`${label}.developmentMetricsObserved must be boolean`)
        })()
    : undefined
  if (
    (failureStage === 'buildEvaluation-preflight' && developmentMetricsObserved !== false) ||
    (failureStage === 'development-evaluation' && developmentMetricsObserved !== true)
  ) {
    throw new Error(`${label} failure stage contradicts metric observation`)
  }
  return {
    ...prior,
    evaluatedSourceRevision: hash(record.evaluatedSourceRevision, sha40, `${label}.evaluatedSourceRevision`),
    ...(reviewedSourceRevision === undefined ? {} : { reviewedSourceRevision }),
    ...(mergedSourceRevision === undefined ? {} : { mergedSourceRevision }),
    ...(failureStage === undefined ? {} : { failureStage }),
    ...(developmentMetricsObserved === undefined ? {} : { developmentMetricsObserved }),
  }
}

const decodeLegacyPriorTrials = (
  value: unknown,
  completed: readonly number[],
  development: readonly number[],
): LegacyPriorTrialsMaterial => {
  const label = 'trialHistory.latestReviewedCandidateLegacyPriorTrials'
  const record = dataRecord(value, label)
  exactKeys(
    record,
    [
      'schemaVersion',
      'qualificationCandidateOrdinals',
      'developmentCandidateOrdinals',
      'latestDevelopmentEvidence',
      'latestReviewedPreregistration',
    ],
    label,
  )
  if (record.schemaVersion !== 'bayn.candidate-development-prior-trials.v1') {
    throw new Error(`${label}.schemaVersion is unsupported`)
  }
  const qualificationCandidateOrdinals = ordinalList(
    record.qualificationCandidateOrdinals,
    `${label}.qualificationCandidateOrdinals`,
  )
  assertSameCanonical(qualificationCandidateOrdinals, completed, `${label}.qualificationCandidateOrdinals`)
  const developmentCandidateOrdinals = ordinalList(
    record.developmentCandidateOrdinals,
    `${label}.developmentCandidateOrdinals`,
  )
  assertOrdinalRange(developmentCandidateOrdinals, completed.length + 1, `${label}.developmentCandidateOrdinals`)
  if (
    developmentCandidateOrdinals.length > development.length ||
    developmentCandidateOrdinals.some((ordinal, index) => ordinal !== development[index])
  ) {
    throw new Error(`${label}.developmentCandidateOrdinals is not a current-history prefix`)
  }
  const latestDevelopmentEvidence = decodePriorDevelopmentEvidence(
    record.latestDevelopmentEvidence,
    `${label}.latestDevelopmentEvidence`,
  )
  const latestReviewedPreregistration = decodePreregistration(
    record.latestReviewedPreregistration,
    `${label}.latestReviewedPreregistration`,
  )
  const latestOrdinal = developmentCandidateOrdinals.at(-1)
  if (
    latestOrdinal === undefined ||
    latestDevelopmentEvidence.candidateOrdinal !== latestOrdinal ||
    latestReviewedPreregistration.candidateOrdinal !== latestOrdinal
  ) {
    throw new Error(`${label} does not bind its latest development ordinal`)
  }
  return {
    schemaVersion: 'bayn.candidate-development-prior-trials.v1',
    qualificationCandidateOrdinals,
    developmentCandidateOrdinals,
    latestDevelopmentEvidence,
    latestReviewedPreregistration,
  }
}

const decodePriorTrials = (
  value: unknown,
  completed: readonly number[],
  development: readonly number[],
  latestQualificationEvidence: QualificationEvidence,
  latestQualificationPreregistration: QualificationPreregistration,
): PriorTrialsMaterial => {
  const label = 'trialHistory.latestReviewedCandidatePriorTrials'
  const record = dataRecord(value, label)
  exactKeys(
    record,
    [
      'schemaVersion',
      'qualificationCandidateOrdinals',
      'latestQualificationEvidence',
      'latestQualificationPreregistration',
      'developmentCandidateOrdinals',
      'latestDevelopmentEvidence',
      'latestReviewedPreregistration',
    ],
    label,
  )
  if (record.schemaVersion !== 'bayn.candidate-development-prior-trials.v2') {
    throw new Error(`${label}.schemaVersion is unsupported`)
  }
  const qualificationCandidateOrdinals = ordinalList(
    record.qualificationCandidateOrdinals,
    `${label}.qualificationCandidateOrdinals`,
  )
  assertSameCanonical(qualificationCandidateOrdinals, completed, `${label}.qualificationCandidateOrdinals`)
  const decodedQualificationEvidence = decodeQualificationEvidence(
    record.latestQualificationEvidence,
    `${label}.latestQualificationEvidence`,
  )
  const decodedQualificationPreregistration = decodeQualificationPreregistration(
    record.latestQualificationPreregistration,
    `${label}.latestQualificationPreregistration`,
  )
  assertSameCanonical(decodedQualificationEvidence, latestQualificationEvidence, `${label}.latestQualificationEvidence`)
  assertSameCanonical(
    decodedQualificationPreregistration,
    latestQualificationPreregistration,
    `${label}.latestQualificationPreregistration`,
  )
  const developmentCandidateOrdinals = ordinalList(
    record.developmentCandidateOrdinals,
    `${label}.developmentCandidateOrdinals`,
  )
  assertOrdinalRange(developmentCandidateOrdinals, completed.length + 1, `${label}.developmentCandidateOrdinals`)
  if (
    developmentCandidateOrdinals.length > development.length ||
    developmentCandidateOrdinals.some((ordinal, index) => ordinal !== development[index])
  ) {
    throw new Error(`${label}.developmentCandidateOrdinals is not a current-history prefix`)
  }
  const decodedLatestDevelopmentEvidence = decodePriorDevelopmentEvidence(
    record.latestDevelopmentEvidence,
    `${label}.latestDevelopmentEvidence`,
  )
  const latestReviewedPreregistration = decodePreregistration(
    record.latestReviewedPreregistration,
    `${label}.latestReviewedPreregistration`,
  )
  const latestOrdinal = developmentCandidateOrdinals.at(-1)
  if (
    latestOrdinal === undefined ||
    decodedLatestDevelopmentEvidence.candidateOrdinal !== latestOrdinal ||
    latestReviewedPreregistration.candidateOrdinal !== latestOrdinal
  ) {
    throw new Error(`${label} does not bind its latest development ordinal`)
  }
  return {
    schemaVersion: 'bayn.candidate-development-prior-trials.v2',
    qualificationCandidateOrdinals,
    latestQualificationEvidence: decodedQualificationEvidence,
    latestQualificationPreregistration: decodedQualificationPreregistration,
    developmentCandidateOrdinals,
    latestDevelopmentEvidence: decodedLatestDevelopmentEvidence,
    latestReviewedPreregistration,
  }
}

const decodeInvalidPrecommit = (value: unknown, reviewed: QualificationCandidatePreregistration): number => {
  const record = dataRecord(value, 'trialHistory.latestInvalidPrecommit')
  exactKeys(
    record,
    [
      'schemaVersion',
      'candidateOrdinal',
      'priorTrialCount',
      'status',
      'attemptStatus',
      'metricBearingAttemptsConsumed',
      'qualificationAttemptConsumed',
      'reviewedHeadRevision',
      'mergedSourceRevision',
      'preregistration',
      'sourceManifest',
      'invalidatedModule',
      'naturalBuild',
      'release',
      'nextCandidatePreregistration',
    ],
    'trialHistory.latestInvalidPrecommit',
  )
  if (
    record.schemaVersion !== 'bayn.candidate-development-precommit-invalidation.v1' ||
    record.status !== 'PRECOMMIT_INVALID' ||
    record.attemptStatus !== 'UNATTEMPTED' ||
    record.metricBearingAttemptsConsumed !== 0 ||
    record.qualificationAttemptConsumed !== false ||
    record.nextCandidatePreregistration !== null
  ) {
    throw new Error('trialHistory.latestInvalidPrecommit is not an unattempted fail-closed invalidation')
  }
  const candidateOrdinal = positiveInteger(
    record.candidateOrdinal,
    'trialHistory.latestInvalidPrecommit.candidateOrdinal',
  )
  const priorTrialCount = nonNegativeInteger(
    record.priorTrialCount,
    'trialHistory.latestInvalidPrecommit.priorTrialCount',
  )
  if (
    candidateOrdinal !== priorTrialCount + 1 ||
    candidateOrdinal !== reviewed.candidateOrdinal ||
    priorTrialCount !== reviewed.priorTrialCount
  ) {
    throw new Error('trialHistory.latestInvalidPrecommit ordinal lineage is invalid')
  }
  hash(record.reviewedHeadRevision, sha40, 'trialHistory.latestInvalidPrecommit.reviewedHeadRevision')
  hash(record.mergedSourceRevision, sha40, 'trialHistory.latestInvalidPrecommit.mergedSourceRevision')

  const preregistration = dataRecord(record.preregistration, 'trialHistory.latestInvalidPrecommit.preregistration')
  exactKeys(
    preregistration,
    ['sourceRevision', 'path', 'blobOid', 'sha256'],
    'trialHistory.latestInvalidPrecommit.preregistration',
  )
  const invalidatedModule = dataRecord(
    record.invalidatedModule,
    'trialHistory.latestInvalidPrecommit.invalidatedModule',
  )
  exactKeys(
    invalidatedModule,
    ['path', 'blobOid', 'sha256', 'lineCount', 'byteCount', 'findings'],
    'trialHistory.latestInvalidPrecommit.invalidatedModule',
  )
  const sourceManifest = dataRecord(record.sourceManifest, 'trialHistory.latestInvalidPrecommit.sourceManifest')
  exactKeys(sourceManifest, ['path', 'blobOid', 'sha256'], 'trialHistory.latestInvalidPrecommit.sourceManifest')
  const naturalBuild = dataRecord(record.naturalBuild, 'trialHistory.latestInvalidPrecommit.naturalBuild')
  exactKeys(
    naturalBuild,
    ['runId', 'imagePublished', 'imageDigest', 'deploymentAllowed'],
    'trialHistory.latestInvalidPrecommit.naturalBuild',
  )
  const release = dataRecord(record.release, 'trialHistory.latestInvalidPrecommit.release')
  exactKeys(
    release,
    ['runId', 'conclusion', 'promotionCompleted', 'rerunAllowed'],
    'trialHistory.latestInvalidPrecommit.release',
  )

  const findings = [
    'TYPE_CHECK_DISABLED',
    'DOWNCOMPILED_BUNDLE',
    'EMBEDDED_OFFICIAL_SESSIONS',
    'EMBEDDED_MARKET_BARS',
    'RUNTIME_INPUT_IGNORED',
  ] as const
  if (
    !Array.isArray(invalidatedModule.findings) ||
    canonicalJson(invalidatedModule.findings) !== canonicalJson(findings)
  ) {
    throw new Error('trialHistory.latestInvalidPrecommit.invalidatedModule.findings is invalid')
  }
  positiveInteger(invalidatedModule.lineCount, 'trialHistory.latestInvalidPrecommit.invalidatedModule.lineCount')
  positiveInteger(invalidatedModule.byteCount, 'trialHistory.latestInvalidPrecommit.invalidatedModule.byteCount')
  hash(invalidatedModule.blobOid, sha40, 'trialHistory.latestInvalidPrecommit.invalidatedModule.blobOid')
  hash(invalidatedModule.sha256, sha64, 'trialHistory.latestInvalidPrecommit.invalidatedModule.sha256')
  hash(sourceManifest.blobOid, sha40, 'trialHistory.latestInvalidPrecommit.sourceManifest.blobOid')
  hash(sourceManifest.sha256, sha64, 'trialHistory.latestInvalidPrecommit.sourceManifest.sha256')
  nonEmptyString(sourceManifest.path, 'trialHistory.latestInvalidPrecommit.sourceManifest.path')
  hash(preregistration.sourceRevision, sha40, 'trialHistory.latestInvalidPrecommit.preregistration.sourceRevision')
  hash(preregistration.blobOid, sha40, 'trialHistory.latestInvalidPrecommit.preregistration.blobOid')
  hash(preregistration.sha256, sha64, 'trialHistory.latestInvalidPrecommit.preregistration.sha256')
  nonEmptyString(preregistration.path, 'trialHistory.latestInvalidPrecommit.preregistration.path')
  nonEmptyString(naturalBuild.runId, 'trialHistory.latestInvalidPrecommit.naturalBuild.runId')
  hash(naturalBuild.imageDigest, imageDigest, 'trialHistory.latestInvalidPrecommit.naturalBuild.imageDigest')
  if (naturalBuild.imagePublished !== true || naturalBuild.deploymentAllowed !== false) {
    throw new Error('trialHistory.latestInvalidPrecommit.naturalBuild is not contained')
  }
  nonEmptyString(release.runId, 'trialHistory.latestInvalidPrecommit.release.runId')
  if (release.conclusion !== 'CANCELLED' || release.promotionCompleted !== false || release.rerunAllowed !== false) {
    throw new Error('trialHistory.latestInvalidPrecommit.release is not terminally contained')
  }

  if (
    preregistration.sourceRevision !== reviewed.preregistration.sourceRevision ||
    preregistration.path !== reviewed.preregistration.path ||
    preregistration.blobOid !== reviewed.preregistration.blobOid ||
    invalidatedModule.path !== reviewed.modulePath ||
    invalidatedModule.sha256 !== reviewed.moduleSha256
  ) {
    throw new Error('trialHistory.latestInvalidPrecommit does not bind the reviewed preregistration')
  }
  return candidateOrdinal
}

const readBoundedText = async (
  stream: NodeJS.ReadableStream,
  maximumBytes: number,
  onLimit: () => void,
): Promise<string> =>
  new Promise((resolveText, rejectText) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const reject = (error: Error) => {
      if (settled) return
      settled = true
      rejectText(error)
    }
    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > maximumBytes) {
        onLimit()
        reject(new Error('authoritative trial-history module output exceeded the bound'))
        return
      }
      chunks.push(bytes)
    })
    stream.once('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
    stream.once('end', () => {
      if (settled) return
      settled = true
      resolveText(Buffer.concat(chunks, totalBytes).toString('utf8'))
    })
  })

export const evaluateQualificationDormancy = (value: unknown): QualificationDormancyDecision => {
  const history = dataRecord(value, 'trialHistory')
  const schemaVersion = history.schemaVersion
  const commonKeys = [
    'schemaVersion',
    'completedCandidateOrdinals',
    'developmentCandidateOrdinals',
    'latestReviewedCandidateLegacyPriorTrials',
    'latestReviewedCandidatePriorTrials',
    'latestTerminalEvidence',
    'candidatePreregistration',
    'latestReviewedCandidatePreregistration',
    'latestDevelopmentEvidence',
    'nextCandidatePreregistration',
  ] as const
  if (schemaVersion === 'bayn.candidate-development-trial-history.v1') exactKeys(history, commonKeys, 'trialHistory')
  else if (schemaVersion === 'bayn.candidate-development-trial-history.v2') {
    exactKeys(history, [...commonKeys, 'latestInvalidPrecommit'], 'trialHistory')
  } else throw new Error('trialHistory.schemaVersion is unsupported')

  const completed = ordinalList(history.completedCandidateOrdinals, 'trialHistory.completedCandidateOrdinals')
  const development = ordinalList(history.developmentCandidateOrdinals, 'trialHistory.developmentCandidateOrdinals')
  assertOrdinalRange(completed, 1, 'trialHistory.completedCandidateOrdinals')
  assertOrdinalRange(development, completed.length + 1, 'trialHistory.developmentCandidateOrdinals')

  const latestQualificationEvidence = decodeQualificationEvidence(
    history.latestTerminalEvidence,
    'trialHistory.latestTerminalEvidence',
  )
  const latestQualificationPreregistration = decodeQualificationPreregistration(
    history.candidatePreregistration,
    'trialHistory.candidatePreregistration',
  )
  const latestCompletedOrdinal = completed.at(-1)
  if (
    latestCompletedOrdinal === undefined ||
    latestQualificationEvidence.candidateOrdinal !== latestCompletedOrdinal ||
    latestQualificationPreregistration.candidateOrdinal !== latestCompletedOrdinal
  ) {
    throw new Error('trialHistory qualification records do not bind the latest completed ordinal')
  }

  const latestDevelopment = decodeLatestDevelopmentEvidence(
    history.latestDevelopmentEvidence,
    'trialHistory.latestDevelopmentEvidence',
  )
  const latestDevelopmentOrdinal = development.at(-1)
  if (latestDevelopmentOrdinal === undefined || latestDevelopment.candidateOrdinal !== latestDevelopmentOrdinal) {
    throw new Error('trialHistory.latestDevelopmentEvidence does not bind the latest development ordinal')
  }

  const legacyPriorTrials = decodeLegacyPriorTrials(
    history.latestReviewedCandidateLegacyPriorTrials,
    completed,
    development,
  )
  const latestPriorTrials = decodePriorTrials(
    history.latestReviewedCandidatePriorTrials,
    completed,
    development,
    latestQualificationEvidence,
    latestQualificationPreregistration,
  )

  const reviewed = decodePreregistration(
    history.latestReviewedCandidatePreregistration,
    'trialHistory.latestReviewedCandidatePreregistration',
    true,
  )
  const hasInvalidPrecommit =
    schemaVersion === 'bayn.candidate-development-trial-history.v2' && history.latestInvalidPrecommit !== null
  const expectedReviewedOrdinal =
    history.nextCandidatePreregistration === null && !hasInvalidPrecommit
      ? latestDevelopmentOrdinal
      : latestDevelopmentOrdinal + 1
  if (
    reviewed.candidateOrdinal !== expectedReviewedOrdinal ||
    reviewed.priorTrialCount !== expectedReviewedOrdinal - 1
  ) {
    throw new Error('trialHistory.latestReviewedCandidatePreregistration does not bind the reviewed ordinal')
  }
  const selectedPriorTrials = reviewed.candidateOrdinal >= 19 ? latestPriorTrials : legacyPriorTrials
  const expectedPriorDevelopmentOrdinals = development.filter((ordinal) => ordinal < reviewed.candidateOrdinal)
  assertSameCanonical(
    selectedPriorTrials.developmentCandidateOrdinals,
    expectedPriorDevelopmentOrdinals,
    'trialHistory reviewed prior-trials development ordinals',
  )
  if (reviewed.priorTrialsHash !== canonicalHash(selectedPriorTrials)) {
    throw new Error('trialHistory.latestReviewedCandidatePreregistration does not bind the decoded prior trials')
  }
  if (reviewed.candidateOrdinal === latestDevelopmentOrdinal + 1) {
    const latestDevelopmentPrior: PriorDevelopmentEvidence = {
      candidateOrdinal: latestDevelopment.candidateOrdinal,
      priorTrialCount: latestDevelopment.priorTrialCount,
      status: latestDevelopment.status,
      evidenceContentHash: latestDevelopment.evidenceContentHash,
      qualificationAttemptConsumed: false,
    }
    assertSameCanonical(
      selectedPriorTrials.latestDevelopmentEvidence,
      latestDevelopmentPrior,
      'trialHistory reviewed prior-trials latest development evidence',
    )
  }

  const invalidOrdinal = hasInvalidPrecommit ? decodeInvalidPrecommit(history.latestInvalidPrecommit, reviewed) : null

  if (history.nextCandidatePreregistration === null) {
    return invalidOrdinal === null
      ? { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null }
      : { status: 'dormant', reason: 'precommit-invalid-unattempted', candidateOrdinal: invalidOrdinal }
  }

  const next = decodePreregistration(
    history.nextCandidatePreregistration,
    'trialHistory.nextCandidatePreregistration',
    true,
  )
  if (canonicalJson(next) !== canonicalJson(reviewed)) {
    throw new Error('trialHistory.nextCandidatePreregistration is not the separately reviewed preregistration')
  }
  if (invalidOrdinal !== null && invalidOrdinal >= next.candidateOrdinal) {
    throw new Error('trialHistory contains an ambiguous runnable and invalidated candidate state')
  }
  return {
    status: 'ready',
    reason: 'reviewed-preregistration-present',
    candidateOrdinal: next.candidateOrdinal,
    preregistrationSourceRevision: next.preregistration.sourceRevision,
    preregistrationBlobOid: next.preregistration.blobOid,
  }
}

const loadTrialHistoryExport = async (modulePath: string): Promise<unknown> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'bayn-qualification-dormancy-'))
  try {
    const source = await readFile(modulePath, 'utf8')
    if (Buffer.byteLength(source, 'utf8') > maximumTrialHistorySourceBytes) {
      throw new Error('authoritative trial-history source exceeded the bound')
    }
    const imports = new Bun.Transpiler({ loader: 'ts' })
      .scanImports(source)
      .map(({ kind, path }) => ({ kind, path }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
    const allowedImports = [
      { kind: 'import-statement', path: './candidate-development' },
      { kind: 'import-statement', path: './hash' },
    ]
    if (canonicalJson(imports) !== canonicalJson(allowedImports)) {
      throw new Error('authoritative trial-history module has unsupported runtime imports')
    }
    const build = await Bun.build({
      entrypoints: [modulePath],
      outdir: temporaryDirectory,
      target: 'node',
      format: 'cjs',
      sourcemap: 'none',
      splitting: false,
      plugins: [
        {
          name: 'bayn-qualification-trial-history-isolation',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (argument) => {
              if (resolve(argument.importer) !== modulePath) return undefined
              if (argument.path === './candidate-development') {
                return { path: 'candidate-development', namespace: 'qualification-trial-history-stub' }
              }
              if (argument.path === './hash') return { path: 'hash', namespace: 'qualification-trial-history-stub' }
              throw new Error(`trial-history module has an unsupported runtime import: ${argument.path}`)
            })
            builder.onLoad({ filter: /.*/, namespace: 'qualification-trial-history-stub' }, ({ path }) => ({
              loader: 'js',
              contents:
                path === 'candidate-development'
                  ? 'export const candidateDevelopmentCalendarContract = Object.freeze({})'
                  : 'export const canonicalHashV1Result = () => { throw new Error("hashing is unavailable during dormancy verification") }',
            }))
          },
        },
      ],
    })
    if (!build.success || build.outputs.length !== 1) {
      throw new Error('authoritative trial-history module could not be isolated')
    }
    const builtModule = build.outputs[0]?.path
    if (builtModule === undefined) throw new Error('authoritative trial-history bundle is missing')
    const runner = join(temporaryDirectory, 'read-trial-history.cjs')
    await writeFile(
      runner,
      [
        "'use strict'",
        'const originalSend = process.send?.bind(process)',
        'const originalDisconnect = process.disconnect.bind(process)',
        'const stringify = JSON.stringify.bind(JSON)',
        'const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty)',
        'const receiveBootstrap = new Promise((resolve, reject) => {',
        "  process.once('message', resolve)",
        "  process.once('disconnect', () => reject(new Error('loader IPC disconnected before bootstrap')))",
        '})',
        ';(async () => {',
        "  if (originalSend === undefined) throw new Error('loader IPC is unavailable')",
        '  const bootstrap = await receiveBootstrap',
        "  if (typeof bootstrap !== 'object' || bootstrap === null || Array.isArray(bootstrap) || Object.keys(bootstrap).length !== 2 || bootstrap.type !== 'bootstrap' || typeof bootstrap.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(bootstrap.nonce)) throw new Error('loader IPC bootstrap is invalid')",
        '  const nonce = bootstrap.nonce',
        "  process.removeAllListeners('message')",
        "  Object.defineProperty(process, 'send', { value: () => { throw new Error('module IPC is unavailable') }, writable: false, configurable: false })",
        `  const loaded = require(${JSON.stringify(builtModule)})`,
        `  if (!hasOwn(loaded, ${JSON.stringify(trialHistoryExport)})) throw new Error('trial-history export is missing')`,
        `  const payload = stringify(loaded[${JSON.stringify(trialHistoryExport)}])`,
        "  if (typeof payload !== 'string') throw new Error('trial-history export is not JSON serializable')",
        "  originalSend({ type: 'result', nonce, payload }, (error) => {",
        '    if (error) process.exitCode = 1',
        '    originalDisconnect()',
        '  })',
        '})().catch(() => {',
        "  process.stderr.write('qualification trial-history loader failed\\n')",
        '  process.exitCode = 1',
        '  if (process.connected) originalDisconnect()',
        '})',
      ].join('\n'),
      'utf8',
    )
    const nodeBinary = Bun.which('node')
    if (nodeBinary === null) throw new Error('Node.js is unavailable for isolated trial-history evaluation')
    const nonce = randomBytes(32).toString('hex')
    let resultPayload: string | null = null
    let messageFailure: Error | null = null
    const child = fork(runner, [], {
      cwd: temporaryDirectory,
      env: {
        HOME: temporaryDirectory,
        TMPDIR: temporaryDirectory,
        NO_COLOR: '1',
      },
      execPath: nodeBinary,
      execArgv: ['--max-old-space-size=64', '--permission', `--allow-fs-read=${temporaryDirectory}`],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    child.on('message', (message) => {
      try {
        resultPayload = validateQualificationDormancyLoaderMessage(message, nonce, resultPayload)
      } catch (error) {
        messageFailure = error instanceof Error ? error : new Error(String(error))
        child.kill('SIGKILL')
      }
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, loaderTimeoutMs)
    const terminateForLimit = () => child.kill('SIGKILL')
    const sendBootstrap = new Promise<void>((resolveSend, rejectSend) => {
      child.send({ type: 'bootstrap', nonce }, (error) => {
        if (error) rejectSend(error)
        else resolveSend()
      })
    })
    const childExit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolveExit) => child.once('close', (code, signal) => resolveExit({ code, signal })),
    )
    const stderr = child.stderr
    if (stderr === null) throw new Error('authoritative trial-history loader stderr is unavailable')
    const [exitResult, stderrResult, sendResult] = await Promise.allSettled([
      childExit,
      readBoundedText(stderr, maximumLoaderOutputBytes, terminateForLimit),
      sendBootstrap,
    ])
    clearTimeout(timeout)
    if (timedOut) throw new Error('authoritative trial-history module evaluation timed out')
    if (exitResult.status === 'rejected' || stderrResult.status === 'rejected' || sendResult.status === 'rejected') {
      throw new Error('authoritative trial-history module output could not be read safely')
    }
    if (
      exitResult.value.code !== 0 ||
      exitResult.value.signal !== null ||
      stderrResult.value.length !== 0 ||
      messageFailure !== null ||
      resultPayload === null
    ) {
      throw new Error('authoritative trial-history module was unloadable')
    }
    return JSON.parse(resultPayload) as unknown
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export const verifyQualificationDormancy = async (repositoryRoot: string): Promise<QualificationDormancyDecision> => {
  const root = await realpath(repositoryRoot)
  const expectedModulePath = resolve(root, trialHistoryRelativePath)
  const modulePath = await realpath(expectedModulePath)
  if (modulePath !== expectedModulePath || dirname(modulePath) !== resolve(root, 'services/bayn/src')) {
    throw new Error('authoritative trial-history path is not a regular confined repository path')
  }
  return evaluateQualificationDormancy(await loadTrialHistoryExport(modulePath))
}

const argument = (name: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

if (import.meta.main) {
  try {
    const repositoryRoot = argument('--repository-root')
    const githubOutput = argument('--github-output')
    const decision = await verifyQualificationDormancy(repositoryRoot)
    await appendFile(
      githubOutput,
      [
        `dormant=${decision.status === 'dormant' ? 'true' : 'false'}`,
        `reason=${decision.reason}`,
        `candidate_ordinal=${decision.candidateOrdinal ?? ''}`,
        '',
      ].join('\n'),
      'utf8',
    )
    process.stdout.write(`BAYN_QUALIFICATION_DORMANCY=${JSON.stringify(decision)}\n`)
  } catch (error) {
    process.stderr.write(
      `qualification dormancy verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
