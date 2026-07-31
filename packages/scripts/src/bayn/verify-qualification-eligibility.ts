#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

export interface QualificationPreregistration {
  readonly schemaVersion: 'bayn.candidate-development-next-preregistration.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
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

export interface QualificationEligibilityInput {
  readonly eventName: string
  readonly repository: string
  readonly currentMainSha: string
  readonly workflowSha: string
  readonly sourceSha: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly preregistration: QualificationPreregistration | null
  readonly preregistrationBlobOid: string | null
  readonly publication: null | {
    readonly natural: boolean
    readonly completed: boolean
    readonly publicationDate: string
    readonly sourceSha: string
    readonly imageDigest: string
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
  readonly attempts: readonly {
    readonly candidateOrdinal: number
    readonly status: 'queued' | 'in_progress' | 'completed'
    readonly conclusion: string | null
  }[]
  readonly database: {
    readonly lockCount: number
    readonly resultCount: number
    readonly trialCount: number
  }
}

export type QualificationEligibilityResult =
  | { readonly status: 'dormant'; readonly code: 'preregistration-missing' }
  | { readonly status: 'hold'; readonly code: string; readonly message: string }
  | {
      readonly status: 'eligible'
      readonly candidateOrdinal: number
      readonly sourceSha: string
      readonly imageRepository: string
      readonly imageDigest: string
      readonly publicationDate: string
      readonly snapshotId: string
      readonly eligibilityHash: string
    }

const sha40 = /^[0-9a-f]{40}$/
const sha64 = /^[0-9a-f]{64}$/
const digest = /^sha256:[0-9a-f]{64}$/
const isoDate = /^\d{4}-\d{2}-\d{2}$/

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const hold = (code: string, message: string): QualificationEligibilityResult => ({ status: 'hold', code, message })

export const evaluateQualificationEligibility = (
  input: QualificationEligibilityInput,
): QualificationEligibilityResult => {
  if (input.preregistration === null) return { status: 'dormant', code: 'preregistration-missing' }
  if (input.eventName === 'workflow_dispatch') return hold('manual-dispatch-rejected', 'manual dispatch is forbidden')
  if (input.eventName !== 'schedule') return hold('event-not-trusted', `unexpected event ${input.eventName}`)
  if (
    !sha40.test(input.currentMainSha) ||
    input.currentMainSha !== input.workflowSha ||
    input.currentMainSha !== input.sourceSha
  ) {
    return hold('source-head-mismatch', 'workflow, source, and current main must be the same exact revision')
  }
  if (!digest.test(input.imageDigest) || input.imageRepository.length === 0) {
    return hold('image-binding-invalid', 'image repository and digest must be immutable')
  }
  if (!sha64.test(input.strategyBehaviorHash) || !sha64.test(input.strategyParameterHash)) {
    return hold('strategy-binding-invalid', 'strategy hashes must be lowercase SHA-256 values')
  }
  const registration = input.preregistration
  if (
    registration.schemaVersion !== 'bayn.candidate-development-next-preregistration.v1' ||
    registration.candidateOrdinal !== registration.priorTrialCount + 1 ||
    registration.candidateOrdinal < 1 ||
    !sha64.test(registration.strategyProtocolHash) ||
    !sha64.test(registration.moduleSha256) ||
    !sha40.test(registration.preregistration.sourceRevision) ||
    !sha40.test(registration.preregistration.blobOid) ||
    registration.preregistration.sourceRevision === input.currentMainSha ||
    input.preregistrationBlobOid !== registration.preregistration.blobOid
  ) {
    return hold('preregistration-invalid', 'preregistration identity or immutable blob binding is invalid')
  }
  if (input.publication === null)
    return hold('publication-missing', 'no post-preregistration natural publication exists')
  const publication = input.publication
  if (!publication.natural || !publication.completed || !isoDate.test(publication.publicationDate)) {
    return hold('publication-not-natural', 'publication must be a completed natural scheduled publication')
  }
  if (publication.sourceSha !== input.currentMainSha || publication.imageDigest !== input.imageDigest) {
    return hold('publication-source-mismatch', 'publication does not bind exact current source and image')
  }
  if (
    publication.snapshotId !== registration.marketData.snapshotId ||
    publication.finalizedSnapshotContentHash !== registration.marketData.finalizedSnapshotContentHash ||
    publication.inputManifestHash !== registration.marketData.inputManifestHash ||
    publication.boundedContentHash !== registration.marketData.boundedContentHash
  ) {
    return hold('publication-data-mismatch', 'publication data hashes differ from preregistration')
  }
  if (
    !sha64.test(publication.snapshotId) ||
    !sha64.test(publication.finalizedSnapshotContentHash) ||
    !sha64.test(publication.inputManifestHash) ||
    !sha64.test(publication.boundedContentHash)
  ) {
    return hold('publication-evidence-invalid', 'publication evidence is malformed')
  }
  const matchingAttempts = input.attempts.filter(
    (attempt) => attempt.candidateOrdinal === registration.candidateOrdinal,
  )
  if (matchingAttempts.length !== 0) {
    return hold('prior-or-inflight-attempt', 'candidate ordinal already has a queued, in-flight, or terminal attempt')
  }
  if (
    input.database.lockCount !== 0 ||
    input.database.resultCount !== 0 ||
    input.database.trialCount !== registration.priorTrialCount
  ) {
    return hold(
      'database-state-not-pristine',
      'qualification database state is not the exact preregistered zero-attempt state',
    )
  }
  const subject = {
    candidateOrdinal: registration.candidateOrdinal,
    sourceSha: input.sourceSha,
    imageRepository: input.imageRepository,
    imageDigest: input.imageDigest,
    strategyBehaviorHash: input.strategyBehaviorHash,
    strategyParameterHash: input.strategyParameterHash,
    strategyProtocolHash: registration.strategyProtocolHash,
    modulePath: registration.modulePath,
    moduleSha256: registration.moduleSha256,
    preregistration: registration.preregistration,
    publication,
  }
  return {
    status: 'eligible',
    candidateOrdinal: registration.candidateOrdinal,
    sourceSha: input.sourceSha,
    imageRepository: input.imageRepository,
    imageDigest: input.imageDigest,
    publicationDate: publication.publicationDate,
    snapshotId: publication.snapshotId,
    eligibilityHash: createHash('sha256').update(canonical(subject)).digest('hex'),
  }
}

const parseArgs = (): { input: string } => {
  const index = process.argv.indexOf('--input')
  if (index < 0 || !process.argv[index + 1]) throw new Error('--input is required')
  return { input: process.argv[index + 1]! }
}

if (import.meta.main) {
  try {
    const args = parseArgs()
    const input = JSON.parse(await readFile(args.input, 'utf8')) as QualificationEligibilityInput
    const result = evaluateQualificationEligibility(input)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status === 'hold') process.exitCode = 1
  } catch (error) {
    process.stderr.write(
      `qualification eligibility verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
