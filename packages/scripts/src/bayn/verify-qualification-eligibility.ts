#!/usr/bin/env bun

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
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
      readonly trustedRepository: string
      readonly repositoryHash: string
      readonly sourceSha: string
      readonly imageRepository: string
      readonly imageDigest: string
      readonly publicationDate: string
      readonly snapshotId: string
      readonly eligibilityHash: string
    }

export interface QualificationGit {
  readonly text: (repositoryRoot: string, args: readonly string[], signal: AbortSignal) => Promise<string>
}

export interface QualificationEligibilityOptions {
  readonly repositoryRoot: string
  readonly trustedRepository: string
  readonly gitTimeoutMs?: number
  readonly maximumHistoryCommits?: number
  readonly signal?: AbortSignal
  readonly git?: QualificationGit
}

const sha40 = /^[0-9a-f]{40}$/
const sha64 = /^[0-9a-f]{64}$/
const digest = /^sha256:[0-9a-f]{64}$/
const isoDate = /^\d{4}-\d{2}-\d{2}$/
const repositoryIdentity = /^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9_.-]+$/
const defaultGitTimeoutMs = 10_000
const defaultMaximumHistoryCommits = 50_000
const maximumGitOutputBytes = 16 * 1024 * 1024
const maximumCommitParents = 256

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

class QualificationGitVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

const qualificationGitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

const gitText = (repositoryRoot: string, args: readonly string[], signal: AbortSignal): Promise<string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding: 'utf8',
        env: qualificationGitEnvironment(),
        maxBuffer: maximumGitOutputBytes,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout.trim())
        else rejectGit(error)
      },
    )
  })

const defaultQualificationGit: QualificationGit = { text: gitText }

const canonicalRepository = (value: string): string => {
  const trimmed = value.trim()
  if (!repositoryIdentity.test(trimmed) || trimmed.endsWith('.git')) {
    throw new QualificationGitVerificationError(
      'repository-identity-invalid',
      'trusted repository identity must be an explicit owner/repository value',
    )
  }
  const [owner, name] = trimmed.split('/')
  if (owner === undefined || name === undefined || owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new QualificationGitVerificationError('repository-identity-invalid', 'trusted repository identity is invalid')
  }
  return `${owner.toLowerCase()}/${name.toLowerCase()}`
}

const repositoryFromOriginUrl = (value: string): string => {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    )
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new QualificationGitVerificationError(
      'repository-identity-invalid',
      'origin must be an explicit GitHub repository URL',
    )
  }
  return canonicalRepository(`${match[1]}/${match[2]}`)
}

const activeMetadataLines = (value: string, commentsAllowed: boolean): readonly string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && (!commentsAllowed || !line.startsWith('#')))

const readOptionalMetadata = async (path: string, signal: AbortSignal): Promise<string> => {
  try {
    return await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  }
}

const verifyRepositoryIntegrity = async (
  repositoryRoot: string,
  git: QualificationGit,
  signal: AbortSignal,
): Promise<void> => {
  const shallow = await git.text(repositoryRoot, ['rev-parse', '--is-shallow-repository'], signal)
  if (shallow !== 'false') {
    throw new QualificationGitVerificationError(
      'repository-integrity-invalid',
      'qualification requires complete non-shallow Git history',
    )
  }

  const replacementRefs = await git.text(
    repositoryRoot,
    ['for-each-ref', '--format=%(refname)', 'refs/replace'],
    signal,
  )
  if (replacementRefs.length > 0) {
    throw new QualificationGitVerificationError(
      'repository-integrity-invalid',
      'replacement refs are forbidden during qualification history verification',
    )
  }

  const configuration = await git.text(repositoryRoot, ['config', '--list'], signal)
  const replacementConfiguration = configuration
    .split('\n')
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((key) => key.toLowerCase().startsWith('replace.'))
  if (replacementConfiguration.length > 0) {
    throw new QualificationGitVerificationError(
      'repository-integrity-invalid',
      'replacement configuration is forbidden during qualification history verification',
    )
  }

  for (const metadata of [
    { name: 'grafts', path: 'info/grafts', commentsAllowed: true },
    { name: 'alternates', path: 'objects/info/alternates', commentsAllowed: false },
    { name: 'http alternates', path: 'objects/info/http-alternates', commentsAllowed: false },
  ] as const) {
    const gitPath = await git.text(repositoryRoot, ['rev-parse', '--git-path', metadata.path], signal)
    const contents = await readOptionalMetadata(resolve(repositoryRoot, gitPath), signal)
    if (activeMetadataLines(contents, metadata.commentsAllowed).length > 0) {
      throw new QualificationGitVerificationError(
        'repository-integrity-invalid',
        `${metadata.name} are forbidden during qualification history verification`,
      )
    }
  }
}

const parseRawCommitParents = (oid: string, value: string): readonly string[] => {
  const parents: string[] = []
  let sawTree = false
  for (const line of value.split('\n')) {
    if (line.length === 0) break
    if (line.startsWith('tree ')) {
      if (sawTree || !sha40.test(line.slice(5))) {
        throw new QualificationGitVerificationError('preregistration-lineage-invalid', `commit ${oid} is malformed`)
      }
      sawTree = true
      continue
    }
    if (line.startsWith('parent ')) {
      const parent = line.slice(7)
      if (!sha40.test(parent) || parents.length >= maximumCommitParents) {
        throw new QualificationGitVerificationError('preregistration-lineage-invalid', `commit ${oid} is malformed`)
      }
      parents.push(parent)
    }
  }
  if (!sawTree) {
    throw new QualificationGitVerificationError('preregistration-lineage-invalid', `commit ${oid} has no tree`)
  }
  return parents
}

const requireRawProperAncestor = async (
  repositoryRoot: string,
  preregistrationRevision: string,
  sourceRevision: string,
  maximumHistoryCommits: number,
  git: QualificationGit,
  signal: AbortSignal,
): Promise<void> => {
  if (preregistrationRevision === sourceRevision) {
    throw new QualificationGitVerificationError(
      'preregistration-lineage-invalid',
      'preregistration source revision must be a strict proper ancestor of current source',
    )
  }

  try {
    parseRawCommitParents(
      preregistrationRevision,
      await git.text(repositoryRoot, ['cat-file', 'commit', preregistrationRevision], signal),
    )
  } catch (error) {
    if (error instanceof QualificationGitVerificationError) throw error
    throw new QualificationGitVerificationError(
      'preregistration-lineage-invalid',
      'preregistration source revision is missing or is not a commit',
      error,
    )
  }

  const pending = [sourceRevision]
  const visited = new Set<string>()
  while (pending.length > 0) {
    if (visited.size >= maximumHistoryCommits) {
      throw new QualificationGitVerificationError(
        'preregistration-lineage-invalid',
        'qualification history exceeds the configured commit bound',
      )
    }
    const oid = pending.pop()
    if (oid === undefined || visited.has(oid)) continue
    let content: string
    try {
      content = await git.text(repositoryRoot, ['cat-file', 'commit', oid], signal)
    } catch (error) {
      throw new QualificationGitVerificationError(
        'preregistration-lineage-invalid',
        `qualification source history contains a missing or non-commit object: ${oid}`,
        error,
      )
    }
    visited.add(oid)
    for (const parent of parseRawCommitParents(oid, content)) {
      if (parent === preregistrationRevision) return
      if (!visited.has(parent)) pending.push(parent)
    }
  }
  throw new QualificationGitVerificationError(
    'preregistration-lineage-invalid',
    'preregistration source revision is not a proper ancestor of current source',
  )
}

const verifyRepositoryAndLineage = async (
  input: QualificationEligibilityInput,
  registration: QualificationPreregistration,
  options: QualificationEligibilityOptions,
  signal: AbortSignal,
): Promise<{ readonly trustedRepository: string; readonly repositoryHash: string }> => {
  const git = options.git ?? defaultQualificationGit
  const trustedRepository = canonicalRepository(options.trustedRepository)
  const observedRepository = canonicalRepository(input.repository)
  if (observedRepository !== trustedRepository) {
    throw new QualificationGitVerificationError(
      'repository-identity-invalid',
      'eligibility evidence repository differs from the explicitly trusted repository',
    )
  }

  const [root, topLevel] = await Promise.all([
    realpath(options.repositoryRoot),
    git.text(options.repositoryRoot, ['rev-parse', '--show-toplevel'], signal).then((path) => realpath(path)),
  ])
  if (root !== topLevel) {
    throw new QualificationGitVerificationError(
      'repository-identity-invalid',
      'repository root does not match the checked-out Git worktree',
    )
  }

  await verifyRepositoryIntegrity(root, git, signal)
  const [headSha, originMainSha, originUrl] = await Promise.all([
    git.text(root, ['rev-parse', 'HEAD'], signal),
    git.text(root, ['rev-parse', 'refs/remotes/origin/main'], signal),
    git.text(root, ['remote', 'get-url', 'origin'], signal),
  ])
  if (headSha !== input.currentMainSha || originMainSha !== input.currentMainSha) {
    throw new QualificationGitVerificationError(
      'source-head-mismatch',
      'checked-out HEAD and immutable origin/main must equal the declared current main source',
    )
  }
  if (repositoryFromOriginUrl(originUrl) !== trustedRepository) {
    throw new QualificationGitVerificationError(
      'repository-identity-invalid',
      'checked-out origin differs from the explicitly trusted repository',
    )
  }

  const maximumHistoryCommits = options.maximumHistoryCommits ?? defaultMaximumHistoryCommits
  if (!Number.isSafeInteger(maximumHistoryCommits) || maximumHistoryCommits < 1) {
    throw new QualificationGitVerificationError('git-verification-invalid', 'history commit bound is invalid')
  }
  await requireRawProperAncestor(
    root,
    registration.preregistration.sourceRevision,
    input.sourceSha,
    maximumHistoryCommits,
    git,
    signal,
  )

  // Re-read all mutable Git metadata and repository bindings after the raw object walk so a concurrent graft,
  // replacement, alternate-object, origin, or main-ref change cannot authorize eligibility.
  await verifyRepositoryIntegrity(root, git, signal)
  const [finalHeadSha, finalOriginMainSha, finalOriginUrl] = await Promise.all([
    git.text(root, ['rev-parse', 'HEAD'], signal),
    git.text(root, ['rev-parse', 'refs/remotes/origin/main'], signal),
    git.text(root, ['remote', 'get-url', 'origin'], signal),
  ])
  if (
    finalHeadSha !== input.currentMainSha ||
    finalOriginMainSha !== input.currentMainSha ||
    repositoryFromOriginUrl(finalOriginUrl) !== trustedRepository
  ) {
    throw new QualificationGitVerificationError(
      'repository-identity-invalid',
      'repository identity or current main changed during immutable Git verification',
    )
  }

  return {
    trustedRepository,
    repositoryHash: createHash('sha256').update(`github.repository.v1:${trustedRepository}`).digest('hex'),
  }
}

const preliminaryEligibility = (
  input: QualificationEligibilityInput,
): QualificationEligibilityResult | QualificationPreregistration => {
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
    input.preregistrationBlobOid !== registration.preregistration.blobOid
  ) {
    return hold('preregistration-invalid', 'preregistration identity or immutable blob binding is invalid')
  }
  return registration
}

const finishEligibility = (
  input: QualificationEligibilityInput,
  registration: QualificationPreregistration,
  repository: { readonly trustedRepository: string; readonly repositoryHash: string },
): QualificationEligibilityResult => {
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
    repository: repository.trustedRepository,
    repositoryHash: repository.repositoryHash,
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
    trustedRepository: repository.trustedRepository,
    repositoryHash: repository.repositoryHash,
    sourceSha: input.sourceSha,
    imageRepository: input.imageRepository,
    imageDigest: input.imageDigest,
    publicationDate: publication.publicationDate,
    snapshotId: publication.snapshotId,
    eligibilityHash: createHash('sha256').update(canonical(subject)).digest('hex'),
  }
}

export const verifyQualificationEligibility = async (
  input: QualificationEligibilityInput,
  options: QualificationEligibilityOptions,
): Promise<QualificationEligibilityResult> => {
  const preliminary = preliminaryEligibility(input)
  if ('status' in preliminary) return preliminary

  const gitTimeoutMs = options.gitTimeoutMs ?? defaultGitTimeoutMs
  if (!Number.isSafeInteger(gitTimeoutMs) || gitTimeoutMs < 1) {
    return hold('git-verification-invalid', 'Git verification timeout is invalid')
  }

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('qualification Git verification timed out'))
  }, gitTimeoutMs)
  const abort = () => controller.abort(options.signal?.reason ?? new Error('qualification Git verification cancelled'))
  if (options.signal?.aborted === true) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const repository = await verifyRepositoryAndLineage(input, preliminary, options, controller.signal)
    return finishEligibility(input, preliminary, repository)
  } catch (error) {
    if (controller.signal.aborted) {
      return hold(
        timedOut ? 'git-verification-timeout' : 'git-verification-cancelled',
        timedOut ? 'bounded Git verification timed out' : 'Git verification was cancelled',
      )
    }
    if (error instanceof QualificationGitVerificationError) return hold(error.code, error.message)
    return hold('git-verification-failed', 'immutable Git verification failed')
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

const parsePositiveInteger = (name: string, value: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

const argument = (name: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const parseArgs = (): {
  readonly input: string
  readonly repositoryRoot: string
  readonly trustedRepository: string
  readonly gitTimeoutMs: number
} => ({
  input: argument('--input'),
  repositoryRoot: argument('--repository-root'),
  trustedRepository: argument('--trusted-repository'),
  gitTimeoutMs: process.argv.includes('--git-timeout-ms')
    ? parsePositiveInteger('--git-timeout-ms', argument('--git-timeout-ms'))
    : defaultGitTimeoutMs,
})

if (import.meta.main) {
  try {
    const args = parseArgs()
    const input = JSON.parse(await readFile(args.input, 'utf8')) as QualificationEligibilityInput
    const result = await verifyQualificationEligibility(input, args)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status === 'hold') process.exitCode = 1
  } catch (error) {
    process.stderr.write(
      `qualification eligibility verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
