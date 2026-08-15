#!/usr/bin/env bun

import { inflateRawSync } from 'node:zlib'
import process from 'node:process'

import { validateNativeBaynDeployment } from './native-runtime-manifest'

const githubApiVersion = '2022-11-28'
const githubGraphqlUrl = 'https://api.github.com/graphql'
const maximumGraphqlPages = 20
const maximumRestPages = 10
const maximumArtifactBytes = 2 * 1024 * 1024
const maximumContractBytes = 128 * 1024
const maximumRunLogEntries = 100
const maximumRunLogEntryBytes = 1024 * 1024
const maximumReleaseTriggerDelayMs = 24 * 60 * 60 * 1_000
const releaseTriggerClockSkewMs = 5 * 60 * 1_000
const minimumExactReviewAgeMs = 30_000
const promotionBranch = 'codex/bayn-release-current'
const buildWorkflow = 'bayn-build-push.yml'
const releaseWorkflow = 'bayn-release.yml'
const releaseContractArtifact = 'bayn-release-contract'
const expectedImage = 'registry.ide-newton.ts.net/lab/bayn'
const expectedPackageAttr = 'bayn-image'

export const baynPromotionCodexReviewer = 'chatgpt-codex-connector'
export const baynPromotionCodexBotLogin = 'chatgpt-codex-connector[bot]'

export const baynPromotionManifestPaths = [
  'argocd/applications/bayn/deployment.yaml',
  'argocd/applications/bayn/kustomization.yaml',
  'argocd/applicationsets/product.yaml',
] as const

const deploymentPath = baynPromotionManifestPaths[0]
const kustomizationPath = baynPromotionManifestPaths[1]
const applicationSetPath = baynPromotionManifestPaths[2]
const promotionPathSet = new Set<string>(baynPromotionManifestPaths)

const exactBaynBuildInputPaths = new Set([
  'packages/scripts/src/bayn/native-runtime-manifest.ts',
  'packages/scripts/src/bayn/update-manifests.ts',
  'nix/images/bayn.nix',
  'nix/images/bayn-runtime-root.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/images/bun-workspace-deps-source.nix',
  'nix/packages.nix',
  'nix/cache-push.sh',
  'nix/ci-nix-oci-summary.sh',
  'nix/ci-run-timed.sh',
  'nix/oci-inspect-archive.sh',
  'nix/oci-push.sh',
  'nix/oci-release-contract.sh',
  'nix/verify-bayn-image-command.sh',
  'flake.nix',
  'flake.lock',
  'package.json',
  'bun.lock',
  '.npmrc',
  'bunfig.toml',
  'tsconfig.base.json',
])

export const isBaynPromotionSourceAffectingPath = (path: string): boolean =>
  path.startsWith('services/bayn/') ||
  path.startsWith('patches/') ||
  path.startsWith('.github/actions/setup-nix-toolchain/') ||
  /^\.github\/workflows\/bayn-[^/]+\.yml$/.test(path) ||
  path.endsWith('/package.json') ||
  exactBaynBuildInputPaths.has(path) ||
  path === '.github/workflows/nix-oci-build-common.yml'

const mutableDeploymentEnvironmentNames = [
  'BAYN_CODE_REVISION',
  'BAYN_IMAGE_DIGEST',
  'BAYN_STRATEGY_BEHAVIOR_HASH',
  'BAYN_STRATEGY_PARAMETER_HASH',
  'BAYN_SIGNAL_SNAPSHOT_ID',
  'BAYN_SIGNAL_PUBLICATION_ASOF',
  'BAYN_SIGNAL_CALENDAR_VERSION',
  'BAYN_SIGNAL_DATA_START',
  'BAYN_SIGNAL_DATA_END',
  'BAYN_SIGNAL_LOOKBACK_START',
  'BAYN_SIGNAL_EVALUATION_START',
  'BAYN_SIGNAL_EVALUATION_END',
  'BAYN_TIGERBEETLE_CLUSTER_ID',
  'BAYN_TIGERBEETLE_ADDRESSES',
  'BAYN_TIGERBEETLE_LEDGER',
] as const

export interface BaynPromotionPullRequestFile {
  readonly path: string
  readonly status: string
  readonly previousPath: string | null
}

export interface BaynPromotionHeadForcePush {
  readonly beforeSha: string
  readonly afterSha: string
  readonly createdAt: string
}

export interface BaynPromotionPullRequest {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly baseRefName: string
  readonly headRefName: string
  readonly baseSha: string
  readonly headSha: string
  readonly headRepository: string
  readonly createdAt: string
  readonly headCommittedAt: string
  readonly commitCount: number
  readonly headForcePushes: readonly BaynPromotionHeadForcePush[]
  readonly files: readonly BaynPromotionPullRequestFile[]
}

export interface BaynPromotionReview {
  readonly authorLogin: string | null
  readonly commitSha: string | null
  readonly submittedAt: string | null
  readonly state: string
}

export interface BaynPromotionReviewThread {
  readonly id: string
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly path: string | null
  readonly url: string | null
}

export interface BaynPromotionIssueComment {
  readonly authorLogin: string | null
  readonly body: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface BaynPromotionReaction {
  readonly userLogin: string | null
  readonly content: string
  readonly createdAt: string
}

export interface BaynPromotionManifestContents {
  readonly deployment: string
  readonly kustomization: string
  readonly applicationSet: string
}

export interface BaynReleaseContract {
  readonly service: string
  readonly image: string
  readonly tag: string
  readonly digest: string
  readonly reference: string
  readonly sourceSha: string
  readonly packageAttr: string
  readonly platforms: readonly string[]
}

export type BaynPromotionProvenance =
  | {
      readonly status: 'resolved'
      readonly buildRunId: number
      readonly releaseRunId: number
      readonly promotionPullNumber: number
      readonly promotionHeadSha: string
      readonly contract: BaynReleaseContract
    }
  | { readonly status: 'missing'; readonly reason: string }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'ambiguous'; readonly reason: string }

export type BaynPromotionSourceFreshness =
  | { readonly status: 'fresh' }
  | { readonly status: 'stale'; readonly reason: string }

export interface BaynPromotionEligibilitySnapshot {
  readonly repository: string
  readonly pullRequest: BaynPromotionPullRequest
  readonly baseManifests: BaynPromotionManifestContents
  readonly headManifests: BaynPromotionManifestContents
  readonly reviews: readonly BaynPromotionReview[]
  readonly threads: readonly BaynPromotionReviewThread[]
  readonly issueComments: readonly BaynPromotionIssueComment[]
  readonly reactions: readonly BaynPromotionReaction[]
  readonly sourceFreshness: BaynPromotionSourceFreshness
  readonly provenance: BaynPromotionProvenance
}

export type BaynPromotionHoldCode =
  | 'promotion-pr-metadata-mismatch'
  | 'promotion-paths-not-permitted'
  | 'promotion-manifest-shape-mismatch'
  | 'promotion-pin-inconsistent'
  | 'promotion-source-not-advanced'
  | 'promotion-source-stale'
  | 'exact-head-review-missing'
  | 'exact-head-review-stale'
  | 'exact-head-review-pending'
  | 'exact-head-review-changes-requested'
  | 'exact-head-review-settling'
  | 'active-unresolved-review-threads'
  | 'release-provenance-missing'
  | 'release-provenance-stale'
  | 'release-provenance-ambiguous'
  | 'release-contract-mismatch'
  | 'github-api-error'
  | 'github-api-timeout'
  | 'github-api-invalid-response'
  | 'github-api-pagination-limit'
  | 'unexpected-verifier-error'

export interface BaynPromotionEligible {
  readonly status: 'eligible'
  readonly prNumber: number
  readonly headSha: string
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
  readonly reviewSubmittedAt: string
  readonly buildRunId: number
  readonly releaseRunId: number
}

export interface BaynPromotionNotApplicable {
  readonly status: 'not-applicable'
  readonly prNumber: number
  readonly headSha: string
}

export interface BaynPromotionHold {
  readonly status: 'hold'
  readonly code: BaynPromotionHoldCode
  readonly message: string
  readonly retryable: boolean
}

export type BaynPromotionEvaluation = BaynPromotionEligible | BaynPromotionNotApplicable | BaynPromotionHold

export const isBaynPromotionCliFailure = (result: BaynPromotionEvaluation, requireApplicable: boolean): boolean =>
  result.status === 'hold' || (requireApplicable && result.status === 'not-applicable')

export type BaynPromotionPollResult = BaynPromotionEvaluation & {
  readonly attempts: number
  readonly timedOut: boolean
}

export interface BaynPromotionBaseAdvance {
  readonly status: string
  readonly baseSha: string
  readonly headSha: string
  readonly mergeBaseSha: string
  readonly aheadBy: number
  readonly totalCommits: number
  readonly commitShas: readonly string[]
  readonly changedPaths: readonly string[]
}

export interface BaynPromotionReleaseRunState {
  readonly id: number
  readonly runAttempt: number
  readonly headSha: string
  readonly headBranch: string
  readonly event: string
  readonly status: string
  readonly conclusion: string | null
}

export interface BaynPromotionCurrentBaseRefreshSnapshot {
  readonly promotion: BaynPromotionEligibilitySnapshot
  readonly repositoryDefaultBranch: string
  readonly currentDefaultBranchSha: string
  readonly currentSourceFreshness: BaynPromotionSourceFreshness
  readonly baseAdvance: BaynPromotionBaseAdvance | null
  readonly currentManifests: BaynPromotionManifestContents
  readonly releaseRun: BaynPromotionReleaseRunState | null
}

export type BaynPromotionCurrentBaseRefreshDecision =
  | {
      readonly status: 'refresh'
      readonly prNumber: number
      readonly headSha: string
      readonly sourceSha: string
      readonly digest: string
      readonly buildRunId: number
      readonly releaseRunId: number
      readonly releaseRunAttempt: number
      readonly currentBaseSha: string
      readonly targetBaseSha: string
    }
  | { readonly status: 'noop'; readonly code: 'already-current' | 'refresh-in-flight'; readonly message: string }
  | { readonly status: 'hold'; readonly code: string; readonly message: string }

export class GitHubPromotionEligibilityError extends Error {
  readonly code:
    | 'github-api-error'
    | 'github-api-timeout'
    | 'github-api-invalid-response'
    | 'github-api-pagination-limit'
  readonly operation: string
  readonly status: number | null

  constructor(
    code: GitHubPromotionEligibilityError['code'],
    operation: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(`${code} during ${operation}`, { cause: options.cause })
    this.name = 'GitHubPromotionEligibilityError'
    this.code = code
    this.operation = operation
    this.status = options.status ?? null
  }
}

interface BaynPromotionPins {
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
  readonly deploymentRepository: string
  readonly kustomizationName: string
  readonly kustomizationNewName: string
  readonly rolloutTimestamp: string
  readonly applicationEnabled: boolean
}

const shortSha = (sha: string): string => sha.slice(0, 12)

const hold = (code: BaynPromotionHoldCode, message: string, retryable: boolean): BaynPromotionHold => ({
  status: 'hold',
  code,
  message,
  retryable,
})

const cleanCodexCommentPattern =
  /^Codex Review: Didn't find any (?:major )?issues\.[^\n]*\n\n\*\*Reviewed commit:\*\* `([0-9a-f]{10,40})`(?:\n|$)/

const timestampWithinOpenPullRequest = (timestamp: string, createdAt: string, nowMs: number): boolean => {
  const timestampMs = Date.parse(timestamp)
  const createdAtMs = Date.parse(createdAt)
  return (
    Number.isFinite(timestampMs) && Number.isFinite(createdAtMs) && timestampMs >= createdAtMs && timestampMs <= nowMs
  )
}

const exactHeadEstablishedAt = (pullRequest: BaynPromotionPullRequest, nowMs: number): number | null => {
  const pullRequestCreatedAtMs = Date.parse(pullRequest.createdAt)
  const headCommittedAtMs = Date.parse(pullRequest.headCommittedAt)
  if (!Number.isFinite(pullRequestCreatedAtMs) || !Number.isFinite(headCommittedAtMs)) return null

  const forcePushes = pullRequest.headForcePushes.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )
  let previous: BaynPromotionHeadForcePush | undefined
  let previousCreatedAtMs: number | undefined
  for (const forcePush of forcePushes) {
    const createdAtMs = Date.parse(forcePush.createdAt)
    if (
      !Number.isFinite(createdAtMs) ||
      createdAtMs < pullRequestCreatedAtMs ||
      createdAtMs > nowMs ||
      forcePush.beforeSha === forcePush.afterSha ||
      (previous !== undefined && previous.afterSha !== forcePush.beforeSha) ||
      (previousCreatedAtMs !== undefined && createdAtMs <= previousCreatedAtMs)
    ) {
      return null
    }
    previous = forcePush
    previousCreatedAtMs = createdAtMs
  }

  if (previous !== undefined && previous.afterSha !== pullRequest.headSha) return null
  return Math.max(pullRequestCreatedAtMs, headCommittedAtMs, previousCreatedAtMs ?? Number.NEGATIVE_INFINITY)
}

const exactHeadCodexAttestation = (
  snapshot: BaynPromotionEligibilitySnapshot,
  nowMs: number,
): BaynPromotionReview | undefined => {
  const pullRequest = snapshot.pullRequest
  const comments = snapshot.issueComments
    .filter((candidate) => {
      if (
        candidate.authorLogin !== baynPromotionCodexBotLogin ||
        candidate.createdAt !== candidate.updatedAt ||
        !timestampWithinOpenPullRequest(candidate.createdAt, pullRequest.createdAt, nowMs)
      ) {
        return false
      }
      const reviewedHead = cleanCodexCommentPattern.exec(candidate.body)?.[1]
      return reviewedHead !== undefined && pullRequest.headSha.startsWith(reviewedHead)
    })
    .map((comment) => comment.createdAt)

  const headEstablishedAtMs = pullRequest.commitCount === 1 ? exactHeadEstablishedAt(pullRequest, nowMs) : null
  const reactions =
    headEstablishedAtMs === null
      ? []
      : snapshot.reactions
          .filter((candidate) => {
            if (
              candidate.userLogin !== baynPromotionCodexBotLogin ||
              candidate.content !== '+1' ||
              !timestampWithinOpenPullRequest(candidate.createdAt, pullRequest.createdAt, nowMs)
            ) {
              return false
            }
            const reactionCreatedAtMs = Date.parse(candidate.createdAt)
            return Number.isFinite(reactionCreatedAtMs) && reactionCreatedAtMs > headEstablishedAtMs
          })
          .map((reaction) => reaction.createdAt)

  const attestations = [...comments, ...reactions]
  if (attestations.length !== 1) return undefined
  return {
    authorLogin: baynPromotionCodexReviewer,
    commitSha: pullRequest.headSha,
    submittedAt: attestations[0] as string,
    state: 'COMMENTED',
  }
}

const expectRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return value as Record<string, unknown>
}

const expectString = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return value
}

const expectAnyString = (value: unknown, context: string): string => {
  if (typeof value !== 'string') {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return value
}

const expectNullableString = (value: unknown, context: string): string | null => {
  if (value === null) return null
  return expectString(value, context)
}

const expectBoolean = (value: unknown, context: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return value
}

const expectInteger = (value: unknown, context: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return value
}

const expectSha = (value: unknown, context: string): string => {
  const sha = expectString(value, context)
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return sha
}

const expectTimestamp = (value: unknown, context: string): string => {
  const timestamp = expectString(value, context)
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', context)
  }
  return timestamp
}

const replaceExactlyOnce = (source: string, pattern: RegExp, replacement: string, name: string): string => {
  const flags = pattern.flags.replace('g', '')
  const matches = [...source.matchAll(new RegExp(pattern.source, `${flags}g`))]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name}`)
  return source.replace(pattern, replacement)
}

const scalarValue = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'string') throw new Error('expected string YAML scalar')
    return parsed
  }
  return trimmed
}

const environmentValue = (deployment: string, name: string): string => {
  const pattern = new RegExp(`            - name: ${name}\\n              value: ([^\\n]+)\\n`, 'g')
  const matches = [...deployment.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name} value`)
  const value = matches[0]?.[1]
  if (value === undefined) throw new Error(`missing ${name} value`)
  return scalarValue(value)
}

const rolloutTimestamp = (deployment: string): string => {
  const matches = [...deployment.matchAll(/        kubectl\.kubernetes\.io\/restartedAt: ([^\n]+)\n/g)]
  if (matches.length !== 1) throw new Error('expected exactly one Bayn rollout annotation')
  const value = matches[0]?.[1]
  if (value === undefined) throw new Error('missing Bayn rollout annotation')
  return scalarValue(value)
}

const kustomizationImage = (kustomization: string) => {
  const pattern = /  - name: ([^\n]+)\n    newName: ([^\n]+)\n    newTag: ([^\n]+)\n    digest: ([^\n]+)\n/g
  const matches = [...kustomization.matchAll(pattern)].filter((match) => match[1]?.trim() === 'bayn-main')
  if (matches.length !== 1) throw new Error('expected exactly one Bayn kustomization image block')
  const [match] = matches
  if (
    match === undefined ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    throw new Error('missing Bayn kustomization image value')
  }
  return {
    name: scalarValue(match[1]),
    newName: scalarValue(match[2]),
    tag: scalarValue(match[3]),
    digest: scalarValue(match[4]),
  }
}

const applicationEnabled = (applicationSet: string): boolean => {
  const pattern = /(^ {14}- name: bayn\n(?:(?!^ {14}- name:)[\s\S])*?^ {16}enabled: )"(false|true)"/gm
  const matches = [...applicationSet.matchAll(pattern)]
  if (matches.length !== 1) throw new Error('expected exactly one Bayn ApplicationSet enabled state')
  return matches[0]?.[2] === 'true'
}

export const parseBaynPromotionPins = (manifests: BaynPromotionManifestContents): BaynPromotionPins => {
  validateNativeBaynDeployment(manifests.deployment)
  const image = kustomizationImage(manifests.kustomization)
  return {
    sourceSha: environmentValue(manifests.deployment, 'BAYN_CODE_REVISION'),
    tag: image.tag,
    digest: environmentValue(manifests.deployment, 'BAYN_IMAGE_DIGEST'),
    deploymentRepository: environmentValue(manifests.deployment, 'BAYN_IMAGE_REPOSITORY'),
    kustomizationName: image.name,
    kustomizationNewName: image.newName,
    rolloutTimestamp: rolloutTimestamp(manifests.deployment),
    applicationEnabled: applicationEnabled(manifests.applicationSet),
  }
}

const normalizeDeployment = (deployment: string): string => {
  let normalized = replaceExactlyOnce(
    deployment,
    /(        kubectl\.kubernetes\.io\/restartedAt: )[^\n]+/,
    '$1"__BAYN_ROLLOUT_TIMESTAMP__"',
    'Bayn rollout annotation',
  )
  for (const name of mutableDeploymentEnvironmentNames) {
    normalized = replaceExactlyOnce(
      normalized,
      new RegExp(`(            - name: ${name}\\n              value: )[^\\n]+`),
      `$1"__${name}__"`,
      `${name} value`,
    )
  }
  const qualificationPattern = /            - name: BAYN_QUALIFICATION_RUN_ID\n              value: [^\n]+\n/g
  const qualifications = [...normalized.matchAll(qualificationPattern)]
  if (qualifications.length > 1) throw new Error('expected at most one BAYN_QUALIFICATION_RUN_ID value')
  return normalized.replace(qualificationPattern, '')
}

const normalizeKustomization = (kustomization: string): string =>
  replaceExactlyOnce(
    kustomization,
    /(  - name: bayn-main\n    newName: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newTag: )[^\n]+\n    digest: [^\n]+/,
    '$1"__BAYN_IMAGE_TAG__"\n    digest: __BAYN_IMAGE_DIGEST__',
    'Bayn image block',
  )

const normalizeApplicationSet = (applicationSet: string): string =>
  replaceExactlyOnce(
    applicationSet,
    /(^ {14}- name: bayn\n(?:(?!^ {14}- name:)[\s\S])*?^ {16}enabled: )"(?:false|true)"/m,
    '$1"__BAYN_ENABLED__"',
    'Bayn ApplicationSet enabled state',
  )

const validateManifestShape = (
  base: BaynPromotionManifestContents,
  head: BaynPromotionManifestContents,
): string | null => {
  try {
    if (normalizeDeployment(base.deployment) !== normalizeDeployment(head.deployment)) {
      return `${deploymentPath} contains changes outside the release-owned promotion fields`
    }
    if (normalizeKustomization(base.kustomization) !== normalizeKustomization(head.kustomization)) {
      return `${kustomizationPath} contains changes outside the release-owned Bayn image block`
    }
    if (normalizeApplicationSet(base.applicationSet) !== normalizeApplicationSet(head.applicationSet)) {
      return `${applicationSetPath} contains changes outside the Bayn enabled state`
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'promotion manifest normalization failed'
  }
}

const validatePins = (pins: BaynPromotionPins, requireApplicationEnabled: boolean): string | null => {
  if (!/^[0-9a-f]{40}$/.test(pins.sourceSha)) return `invalid source revision ${pins.sourceSha}`
  if (pins.tag !== `sha-${pins.sourceSha}`) {
    return `image tag ${pins.tag} does not bind source revision ${shortSha(pins.sourceSha)}`
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(pins.digest)) return `invalid image digest ${pins.digest}`
  if (
    pins.deploymentRepository !== expectedImage ||
    pins.kustomizationName !== 'bayn-main' ||
    pins.kustomizationNewName !== expectedImage
  ) {
    return 'Bayn image repository is not internally consistent'
  }
  if (!Number.isFinite(Date.parse(pins.rolloutTimestamp))) return 'Bayn rollout timestamp is invalid'
  if (requireApplicationEnabled && !pins.applicationEnabled) {
    return 'Bayn ApplicationSet entry must be enabled after promotion'
  }
  return null
}

const validateContract = (contract: BaynReleaseContract, pins: BaynPromotionPins): string | null => {
  if (contract.service !== 'bayn') return `release contract service is ${contract.service}`
  if (contract.image !== expectedImage) return `release contract image is ${contract.image}`
  if (contract.packageAttr !== expectedPackageAttr) {
    return `release contract package is ${contract.packageAttr}`
  }
  if (contract.sourceSha !== pins.sourceSha) return 'release contract source revision does not match manifests'
  if (contract.tag !== pins.tag) return 'release contract tag does not match manifests'
  if (contract.digest !== pins.digest) return 'release contract digest does not match manifests'
  if (contract.reference !== `${expectedImage}@${pins.digest}`) {
    return 'release contract immutable reference does not match manifests'
  }
  const platforms = [...contract.platforms].toSorted()
  if (platforms.length !== 2 || platforms[0] !== 'linux/amd64' || platforms[1] !== 'linux/arm64') {
    return `release contract platforms are ${platforms.join(',')}`
  }
  return null
}

export const evaluateBaynPromotionEligibility = (input: {
  readonly expectedRepository: string
  readonly expectedPullNumber: number
  readonly expectedHeadSha: string
  readonly snapshot: BaynPromotionEligibilitySnapshot
  readonly nowMs: number
}): BaynPromotionEvaluation => {
  const pullRequest = input.snapshot.pullRequest
  if (pullRequest.headRefName !== promotionBranch) {
    return { status: 'not-applicable', prNumber: pullRequest.number, headSha: pullRequest.headSha }
  }
  if (
    input.snapshot.repository !== input.expectedRepository ||
    pullRequest.number !== input.expectedPullNumber ||
    pullRequest.headSha !== input.expectedHeadSha ||
    pullRequest.baseRefName !== 'main' ||
    pullRequest.state !== 'open' ||
    pullRequest.headRepository !== input.expectedRepository ||
    pullRequest.commitCount !== 1
  ) {
    return hold(
      'promotion-pr-metadata-mismatch',
      `promotion PR metadata does not bind #${input.expectedPullNumber} exact head ${shortSha(input.expectedHeadSha)} to ${input.expectedRepository}:main`,
      false,
    )
  }

  const invalidFile = pullRequest.files.find(
    (file) => !promotionPathSet.has(file.path) || file.status !== 'modified' || file.previousPath !== null,
  )
  if (invalidFile !== undefined) {
    return hold(
      'promotion-paths-not-permitted',
      `promotion PR #${pullRequest.number} changes non-permitted or non-modified path ${invalidFile.path}`,
      false,
    )
  }
  const changedPaths = new Set(pullRequest.files.map((file) => file.path))
  if (!changedPaths.has(deploymentPath) || !changedPaths.has(kustomizationPath)) {
    return hold(
      'promotion-paths-not-permitted',
      `promotion PR #${pullRequest.number} must change ${deploymentPath} and ${kustomizationPath}`,
      false,
    )
  }

  const shapeFailure = validateManifestShape(input.snapshot.baseManifests, input.snapshot.headManifests)
  if (shapeFailure !== null) {
    return hold('promotion-manifest-shape-mismatch', shapeFailure, false)
  }

  let basePins: BaynPromotionPins
  let headPins: BaynPromotionPins
  try {
    basePins = parseBaynPromotionPins(input.snapshot.baseManifests)
    headPins = parseBaynPromotionPins(input.snapshot.headManifests)
  } catch (error) {
    return hold(
      'promotion-manifest-shape-mismatch',
      error instanceof Error ? error.message : 'failed to parse promotion manifests',
      false,
    )
  }
  const basePinFailure = validatePins(basePins, false)
  if (basePinFailure !== null) {
    return hold('promotion-pin-inconsistent', `base manifests are inconsistent: ${basePinFailure}`, false)
  }
  const headPinFailure = validatePins(headPins, true)
  if (headPinFailure !== null) {
    return hold('promotion-pin-inconsistent', `head manifests are inconsistent: ${headPinFailure}`, false)
  }
  if (
    basePins.sourceSha === headPins.sourceSha ||
    basePins.tag === headPins.tag ||
    basePins.digest === headPins.digest ||
    basePins.rolloutTimestamp === headPins.rolloutTimestamp
  ) {
    return hold(
      'promotion-source-not-advanced',
      `promotion PR #${pullRequest.number} does not atomically advance source, tag, digest, and rollout timestamp`,
      false,
    )
  }
  if (pullRequest.title !== `chore(bayn): promote image ${headPins.tag}`) {
    return hold('promotion-pr-metadata-mismatch', `promotion PR title does not bind image tag ${headPins.tag}`, false)
  }

  if (input.snapshot.sourceFreshness.status === 'stale') {
    return hold('promotion-source-stale', input.snapshot.sourceFreshness.reason, false)
  }

  const codexReviews = input.snapshot.reviews.filter((review) => review.authorLogin === baynPromotionCodexReviewer)
  const exactHeadReviews = codexReviews.filter((review) => review.commitSha === pullRequest.headSha)
  if (exactHeadReviews.some((review) => review.submittedAt === null || review.state === 'PENDING')) {
    return hold(
      'exact-head-review-pending',
      `promotion PR #${pullRequest.number} has a pending Codex review for exact head ${shortSha(pullRequest.headSha)}`,
      true,
    )
  }
  const exactSubmittedReview = exactHeadReviews
    .filter((review) => review.submittedAt !== null)
    .toSorted((left, right) => (right.submittedAt as string).localeCompare(left.submittedAt as string))[0]
  const reviewEvidence = exactSubmittedReview ?? exactHeadCodexAttestation(input.snapshot, input.nowMs)
  if (reviewEvidence === undefined) {
    const staleHeads = [
      ...new Set(
        codexReviews
          .filter((review) => review.commitSha !== null && review.submittedAt !== null)
          .map((review) => shortSha(review.commitSha as string)),
      ),
    ]
    if (staleHeads.length > 0) {
      return hold(
        'exact-head-review-stale',
        `promotion PR #${pullRequest.number} exact head ${shortSha(pullRequest.headSha)} is unreviewed; Codex reviewed stale head(s) ${staleHeads.join(', ')}`,
        true,
      )
    }
    return hold(
      'exact-head-review-missing',
      `promotion PR #${pullRequest.number} lacks a submitted Codex review for exact head ${shortSha(pullRequest.headSha)}`,
      true,
    )
  }
  if (reviewEvidence.state === 'CHANGES_REQUESTED') {
    return hold(
      'exact-head-review-changes-requested',
      `promotion PR #${pullRequest.number} exact-head Codex review requests changes`,
      false,
    )
  }
  if (reviewEvidence.state !== 'COMMENTED' && reviewEvidence.state !== 'APPROVED') {
    return hold(
      'exact-head-review-missing',
      `promotion PR #${pullRequest.number} exact-head Codex review state ${reviewEvidence.state} is not eligible`,
      false,
    )
  }
  const submittedAtMs = Date.parse(reviewEvidence.submittedAt as string)
  if (!Number.isFinite(submittedAtMs)) {
    return hold('promotion-pr-metadata-mismatch', 'exact-head review timestamp is invalid', false)
  }
  const reviewAgeMs = input.nowMs - submittedAtMs
  if (reviewAgeMs < minimumExactReviewAgeMs) {
    return hold(
      'exact-head-review-settling',
      `promotion PR #${pullRequest.number} exact-head review is ${Math.max(0, Math.floor(reviewAgeMs / 1_000))}s old; review threads are still settling`,
      true,
    )
  }
  const unresolvedThreads = input.snapshot.threads.filter((thread) => !thread.isResolved && !thread.isOutdated)
  if (unresolvedThreads.length > 0) {
    const examples = unresolvedThreads
      .slice(0, 3)
      .map((thread) => thread.url ?? thread.path ?? thread.id)
      .join(', ')
    return hold(
      'active-unresolved-review-threads',
      `promotion PR #${pullRequest.number} has ${unresolvedThreads.length} actionable unresolved review thread(s): ${examples}`,
      true,
    )
  }

  const provenance = input.snapshot.provenance
  if (provenance.status === 'missing') {
    return hold('release-provenance-missing', provenance.reason, true)
  }
  if (provenance.status === 'stale') {
    return hold('release-provenance-stale', provenance.reason, false)
  }
  if (provenance.status === 'ambiguous') {
    return hold('release-provenance-ambiguous', provenance.reason, false)
  }
  if (provenance.promotionPullNumber !== pullRequest.number || provenance.promotionHeadSha !== pullRequest.headSha) {
    return hold(
      'release-provenance-stale',
      `release provenance does not bind promotion PR #${pullRequest.number} exact head ${shortSha(pullRequest.headSha)}`,
      false,
    )
  }
  const contractFailure = validateContract(provenance.contract, headPins)
  if (contractFailure !== null) {
    return hold('release-contract-mismatch', contractFailure, false)
  }

  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    sourceSha: headPins.sourceSha,
    tag: headPins.tag,
    digest: headPins.digest,
    reviewSubmittedAt: reviewEvidence.submittedAt as string,
    buildRunId: provenance.buildRunId,
    releaseRunId: provenance.releaseRunId,
  }
}

const manifestsEqual = (left: BaynPromotionManifestContents, right: BaynPromotionManifestContents): boolean =>
  left.deployment === right.deployment &&
  left.kustomization === right.kustomization &&
  left.applicationSet === right.applicationSet

export const evaluateBaynPromotionCurrentBaseRefresh = (input: {
  readonly expectedRepository: string
  readonly expectedPullNumber: number
  readonly expectedHeadSha: string
  readonly expectedDefaultBranchSha: string
  readonly snapshot: BaynPromotionCurrentBaseRefreshSnapshot
  readonly nowMs: number
}): BaynPromotionCurrentBaseRefreshDecision => {
  const eligibility = evaluateBaynPromotionEligibility({
    expectedRepository: input.expectedRepository,
    expectedPullNumber: input.expectedPullNumber,
    expectedHeadSha: input.expectedHeadSha,
    snapshot: input.snapshot.promotion,
    nowMs: input.nowMs,
  })
  if (eligibility.status !== 'eligible') {
    return {
      status: 'hold',
      code: eligibility.status === 'hold' ? eligibility.code : 'promotion-not-applicable',
      message:
        eligibility.status === 'hold'
          ? eligibility.message
          : `PR #${eligibility.prNumber} is not an applicable Bayn promotion`,
    }
  }

  if (
    input.snapshot.repositoryDefaultBranch !== 'main' ||
    input.snapshot.currentDefaultBranchSha !== input.expectedDefaultBranchSha
  ) {
    return {
      status: 'hold',
      code: 'default-branch-identity-mismatch',
      message: `repository default branch ${input.snapshot.repositoryDefaultBranch} at ${shortSha(input.snapshot.currentDefaultBranchSha)} does not bind expected main ${shortSha(input.expectedDefaultBranchSha)}`,
    }
  }

  const pullRequest = input.snapshot.promotion.pullRequest
  if (pullRequest.baseSha === input.snapshot.currentDefaultBranchSha) {
    return {
      status: 'noop',
      code: 'already-current',
      message: `promotion PR #${pullRequest.number} already targets current main ${shortSha(pullRequest.baseSha)}`,
    }
  }

  const advance = input.snapshot.baseAdvance
  if (
    advance === null ||
    advance.status !== 'ahead' ||
    advance.baseSha !== pullRequest.baseSha ||
    advance.headSha !== input.snapshot.currentDefaultBranchSha ||
    advance.mergeBaseSha !== pullRequest.baseSha ||
    advance.aheadBy <= 0 ||
    advance.aheadBy !== advance.totalCommits ||
    advance.commitShas.length !== advance.aheadBy ||
    advance.commitShas.at(-1) !== input.snapshot.currentDefaultBranchSha ||
    new Set(advance.commitShas).size !== advance.commitShas.length
  ) {
    return {
      status: 'hold',
      code: 'promotion-base-history-mismatch',
      message: `promotion PR #${pullRequest.number} base ${shortSha(pullRequest.baseSha)} does not advance linearly to current main ${shortSha(input.snapshot.currentDefaultBranchSha)}`,
    }
  }

  const sourceAffectingPaths = [...new Set(advance.changedPaths.filter(isBaynPromotionSourceAffectingPath))].toSorted()
  if (sourceAffectingPaths.length > 0 || input.snapshot.currentSourceFreshness.status !== 'fresh') {
    return {
      status: 'hold',
      code: 'newer-bayn-source-exists',
      message:
        input.snapshot.currentSourceFreshness.status === 'stale'
          ? input.snapshot.currentSourceFreshness.reason
          : `current main contains newer Bayn source input(s): ${sourceAffectingPaths.slice(0, 5).join(', ')}`,
    }
  }

  if (!manifestsEqual(input.snapshot.promotion.baseManifests, input.snapshot.currentManifests)) {
    return {
      status: 'hold',
      code: 'promotion-would-downgrade-current-manifests',
      message: `current main manifests differ from promotion PR #${pullRequest.number} base manifests`,
    }
  }

  const releaseRun = input.snapshot.releaseRun
  if (releaseRun === null) {
    return {
      status: 'hold',
      code: 'release-run-missing',
      message: `verified release run ${eligibility.releaseRunId} could not be loaded`,
    }
  }
  if (
    releaseRun.id !== eligibility.releaseRunId ||
    releaseRun.event !== 'workflow_run' ||
    releaseRun.headBranch !== 'main' ||
    releaseRun.headSha !== eligibility.sourceSha
  ) {
    return {
      status: 'hold',
      code: 'release-run-identity-mismatch',
      message: `release run ${releaseRun.id} does not bind verified source ${shortSha(eligibility.sourceSha)} on main`,
    }
  }
  if (releaseRun.status !== 'completed') {
    return {
      status: 'noop',
      code: 'refresh-in-flight',
      message: `release run ${releaseRun.id} attempt ${releaseRun.runAttempt} is ${releaseRun.status}`,
    }
  }
  if (releaseRun.conclusion !== 'success') {
    return {
      status: 'hold',
      code: 'release-run-not-successful',
      message: `release run ${releaseRun.id} attempt ${releaseRun.runAttempt} concluded ${releaseRun.conclusion ?? 'without a conclusion'}`,
    }
  }

  return {
    status: 'refresh',
    prNumber: eligibility.prNumber,
    headSha: eligibility.headSha,
    sourceSha: eligibility.sourceSha,
    digest: eligibility.digest,
    buildRunId: eligibility.buildRunId,
    releaseRunId: eligibility.releaseRunId,
    releaseRunAttempt: releaseRun.runAttempt,
    currentBaseSha: pullRequest.baseSha,
    targetBaseSha: input.snapshot.currentDefaultBranchSha,
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const apiErrorHold = (error: unknown): BaynPromotionHold => {
  if (error instanceof GitHubPromotionEligibilityError) {
    const status = error.status === null ? '' : ` (HTTP ${error.status})`
    return hold(error.code, `${error.code} while ${error.operation}${status}`, true)
  }
  const name = error instanceof Error ? error.name : typeof error
  return hold('unexpected-verifier-error', `unexpected verifier failure of type ${name}`, true)
}

export const pollBaynPromotionEligibility = async (options: {
  readonly expectedRepository: string
  readonly expectedPullNumber: number
  readonly expectedHeadSha: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly loadSnapshot: () => Promise<BaynPromotionEligibilitySnapshot>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
}): Promise<BaynPromotionPollResult> => {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  let lastHold: BaynPromotionHold | null = null
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let evaluation: BaynPromotionEvaluation
    try {
      evaluation = evaluateBaynPromotionEligibility({
        expectedRepository: options.expectedRepository,
        expectedPullNumber: options.expectedPullNumber,
        expectedHeadSha: options.expectedHeadSha,
        snapshot: await options.loadSnapshot(),
        nowMs: now(),
      })
    } catch (error) {
      evaluation = apiErrorHold(error)
    }
    if (evaluation.status !== 'hold') return { ...evaluation, attempts: attempt, timedOut: false }
    lastHold = evaluation
    if (!evaluation.retryable) return { ...evaluation, attempts: attempt, timedOut: false }
    if (attempt < options.maxAttempts) await sleep(options.pollIntervalMs)
  }
  if (lastHold === null) throw new Error('promotion eligibility poll completed without an evaluation')
  return {
    ...lastHold,
    message: `${lastHold.message}; bounded wait exhausted after ${options.maxAttempts} attempt(s)`,
    attempts: options.maxAttempts,
    timedOut: true,
  }
}

interface GitHubRequestOptions {
  readonly token: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
}

interface GitHubResponse<T> {
  readonly value: T
  readonly headers: Headers
}

const requestGitHub = async <T>(
  options: GitHubRequestOptions & {
    readonly url: string
    readonly operation: string
    readonly parse: (response: Response) => Promise<T>
    readonly method?: 'GET' | 'POST'
    readonly body?: string
  },
): Promise<GitHubResponse<T>> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs)
  try {
    const response = await options.fetchFn(options.url, {
      method: options.method ?? 'GET',
      body: options.body,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'bayn-promotion-eligibility-gate',
        'X-GitHub-Api-Version': githubApiVersion,
      },
    })
    if (!response.ok) {
      throw new GitHubPromotionEligibilityError('github-api-error', options.operation, {
        status: response.status,
      })
    }
    try {
      return { value: await options.parse(response), headers: response.headers }
    } catch (error) {
      if (error instanceof GitHubPromotionEligibilityError) throw error
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', options.operation, {
        cause: error,
      })
    }
  } catch (error) {
    if (error instanceof GitHubPromotionEligibilityError) throw error
    if (controller.signal.aborted) {
      throw new GitHubPromotionEligibilityError('github-api-timeout', options.operation, { cause: error })
    }
    throw new GitHubPromotionEligibilityError('github-api-error', options.operation, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

const requestJson = async (
  options: GitHubRequestOptions & {
    readonly url: string
    readonly operation: string
    readonly method?: 'GET' | 'POST'
    readonly body?: string
  },
): Promise<GitHubResponse<unknown>> =>
  requestGitHub({
    ...options,
    parse: async (response) => response.json(),
  })

const requestBytes = async (
  options: GitHubRequestOptions & {
    readonly url: string
    readonly operation: string
    readonly maximumBytes?: number
  },
): Promise<GitHubResponse<Uint8Array>> =>
  requestGitHub({
    ...options,
    parse: async (response) => {
      const maximumBytes = options.maximumBytes ?? maximumArtifactBytes
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new GitHubPromotionEligibilityError('github-api-invalid-response', options.operation)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maximumBytes) {
        throw new GitHubPromotionEligibilityError('github-api-invalid-response', options.operation)
      }
      return bytes
    },
  })

const requestGraphql = async (
  options: GitHubRequestOptions & {
    readonly query: string
    readonly variables: Record<string, unknown>
    readonly operation: string
  },
): Promise<Record<string, unknown>> => {
  const response = await requestJson({
    ...options,
    url: githubGraphqlUrl,
    method: 'POST',
    body: JSON.stringify({ query: options.query, variables: options.variables }),
  })
  const payload = expectRecord(response.value, options.operation)
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new GitHubPromotionEligibilityError('github-api-error', options.operation)
  }
  return expectRecord(payload.data, options.operation)
}

const hasNextPage = (headers: Headers): boolean => headers.get('link')?.includes('rel="next"') === true

const repositoryParts = (repository: string): readonly [string, string] => {
  const [owner, name, extra] = repository.split('/')
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0 || extra !== undefined) {
    throw new Error('repository must be in owner/name form')
  }
  return [owner, name]
}

const apiRepository = (repository: string): string => {
  const [owner, name] = repositoryParts(repository)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

const fetchPullRequest = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<Omit<BaynPromotionPullRequest, 'files' | 'headForcePushes' | 'headCommittedAt'>> => {
  const operation = `read promotion PR #${options.pullNumber}`
  const response = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/pulls/${options.pullNumber}`,
    operation,
  })
  const pullRequest = expectRecord(response.value, operation)
  const base = expectRecord(pullRequest.base, `${operation} base`)
  const head = expectRecord(pullRequest.head, `${operation} head`)
  const headRepository = expectRecord(head.repo, `${operation} head repository`)
  const parsed = {
    number: expectInteger(pullRequest.number, `${operation} number`),
    title: expectString(pullRequest.title, `${operation} title`),
    state: expectString(pullRequest.state, `${operation} state`),
    baseRefName: expectString(base.ref, `${operation} base ref`),
    headRefName: expectString(head.ref, `${operation} head ref`),
    baseSha: expectSha(base.sha, `${operation} base SHA`),
    headSha: expectSha(head.sha, `${operation} head SHA`),
    headRepository: expectString(headRepository.full_name, `${operation} head repository name`),
    createdAt: expectTimestamp(pullRequest.created_at, `${operation} created at`),
    commitCount: expectInteger(pullRequest.commits, `${operation} commit count`),
  }
  return parsed
}

const fetchCommitCommittedAt = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly sha: string },
): Promise<string> => {
  const operation = `read promotion head ${shortSha(options.sha)} commit timestamp`
  const response = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/commits/${encodeURIComponent(options.sha)}`,
    operation,
  })
  const commit = expectRecord(response.value, operation)
  const gitCommit = expectRecord(commit.commit, `${operation} commit`)
  const committer = expectRecord(gitCommit.committer, `${operation} committer`)
  return expectTimestamp(committer.date, `${operation} committed at`)
}

const fetchPullRequestFiles = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<readonly BaynPromotionPullRequestFile[]> => {
  const files: BaynPromotionPullRequestFile[] = []
  for (let page = 1; page <= maximumRestPages; page += 1) {
    const operation = `read promotion PR #${options.pullNumber} files page ${page}`
    const response = await requestJson({
      ...options,
      url: `https://api.github.com/repos/${apiRepository(options.repository)}/pulls/${options.pullNumber}/files?per_page=100&page=${page}`,
      operation,
    })
    if (!Array.isArray(response.value)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [index, item] of response.value.entries()) {
      const file = expectRecord(item, `${operation} file ${index}`)
      files.push({
        path: expectString(file.filename, `${operation} file ${index} path`),
        status: expectString(file.status, `${operation} file ${index} status`),
        previousPath:
          file.previous_filename === undefined
            ? null
            : expectString(file.previous_filename, `${operation} file ${index} previous path`),
      })
    }
    if (!hasNextPage(response.headers)) return files
  }
  throw new GitHubPromotionEligibilityError(
    'github-api-pagination-limit',
    `read promotion PR #${options.pullNumber} files`,
  )
}

const fetchFileContent = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly path: string
    readonly ref: string
  },
): Promise<string> => {
  const operation = `read ${options.path} at ${shortSha(options.ref)}`
  const encodedPath = options.path.split('/').map(encodeURIComponent).join('/')
  const response = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/contents/${encodedPath}?ref=${encodeURIComponent(options.ref)}`,
    operation,
  })
  const file = expectRecord(response.value, operation)
  if (file.type !== 'file' || file.encoding !== 'base64') {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
  }
  const content = expectString(file.content, `${operation} content`).replaceAll('\n', '')
  try {
    return Buffer.from(content, 'base64').toString('utf8')
  } catch (error) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation, { cause: error })
  }
}

const fetchManifests = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly ref: string },
): Promise<BaynPromotionManifestContents> => {
  const [deployment, kustomization, applicationSet] = await Promise.all(
    baynPromotionManifestPaths.map((path) => fetchFileContent({ ...options, path })),
  )
  return { deployment, kustomization, applicationSet }
}

const fetchSourceFreshness = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly sourceSha: string
    readonly baseSha: string
  },
): Promise<BaynPromotionSourceFreshness> => {
  if (options.sourceSha === options.baseSha) return { status: 'fresh' }

  const operation = `compare promotion source ${shortSha(options.sourceSha)} to base ${shortSha(options.baseSha)}`
  const response = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/compare/${encodeURIComponent(options.sourceSha)}...${encodeURIComponent(options.baseSha)}?per_page=100&page=1`,
    operation,
  })
  if (hasNextPage(response.headers)) {
    throw new GitHubPromotionEligibilityError('github-api-pagination-limit', operation)
  }
  const comparison = expectRecord(response.value, operation)
  const baseCommit = expectRecord(comparison.base_commit, `${operation} base commit`)
  const mergeBaseCommit = expectRecord(comparison.merge_base_commit, `${operation} merge base commit`)
  const status = expectString(comparison.status, `${operation} status`)
  const aheadBy = expectInteger(comparison.ahead_by, `${operation} ahead count`)
  const totalCommits = expectInteger(comparison.total_commits, `${operation} total commits`)
  if (!Array.isArray(comparison.commits) || !Array.isArray(comparison.files)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
  }
  const comparisonBaseSha = expectSha(baseCommit.sha, `${operation} base commit SHA`)
  const mergeBaseSha = expectSha(mergeBaseCommit.sha, `${operation} merge base commit SHA`)
  if (comparisonBaseSha !== options.sourceSha) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', `${operation} source identity`)
  }
  if (status !== 'ahead' || mergeBaseSha !== options.sourceSha) {
    return {
      status: 'stale',
      reason: `promotion source ${shortSha(options.sourceSha)} is not an ancestor of base ${shortSha(options.baseSha)}; comparison status is ${status}`,
    }
  }
  if (aheadBy > 100 || aheadBy !== totalCommits || comparison.commits.length !== aheadBy) {
    throw new GitHubPromotionEligibilityError('github-api-pagination-limit', operation)
  }
  const comparisonCommitShas = comparison.commits.map((item, index) => {
    const commit = expectRecord(item, `${operation} commit ${index}`)
    return expectSha(commit.sha, `${operation} commit ${index} SHA`)
  })
  if (comparisonCommitShas.at(-1) !== options.baseSha) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', `${operation} base identity`)
  }
  if (comparison.files.length >= 300) {
    throw new GitHubPromotionEligibilityError('github-api-pagination-limit', `${operation} files`)
  }
  const changedPaths = comparison.files.flatMap((item, index) => {
    const file = expectRecord(item, `${operation} file ${index}`)
    const filename = expectString(file.filename, `${operation} file ${index} path`)
    if (file.previous_filename === undefined) return [filename]
    return [filename, expectString(file.previous_filename, `${operation} file ${index} previous path`)]
  })
  const stalePaths = [...new Set(changedPaths.filter(isBaynPromotionSourceAffectingPath))].toSorted()
  if (stalePaths.length > 0) {
    return {
      status: 'stale',
      reason: `promotion base ${shortSha(options.baseSha)} contains newer Bayn build input(s) after source ${shortSha(options.sourceSha)}: ${stalePaths.slice(0, 5).join(', ')}`,
    }
  }
  return { status: 'fresh' }
}

const fetchBaseAdvance = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly baseSha: string
    readonly headSha: string
  },
): Promise<BaynPromotionBaseAdvance | null> => {
  if (options.baseSha === options.headSha) return null
  const operation = `compare promotion base ${shortSha(options.baseSha)} to current main ${shortSha(options.headSha)}`
  const response = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/compare/${encodeURIComponent(options.baseSha)}...${encodeURIComponent(options.headSha)}?per_page=100&page=1`,
    operation,
  })
  if (hasNextPage(response.headers)) {
    throw new GitHubPromotionEligibilityError('github-api-pagination-limit', operation)
  }
  const comparison = expectRecord(response.value, operation)
  const baseCommit = expectRecord(comparison.base_commit, `${operation} base commit`)
  const mergeBaseCommit = expectRecord(comparison.merge_base_commit, `${operation} merge base commit`)
  if (!Array.isArray(comparison.commits) || !Array.isArray(comparison.files)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
  }
  const aheadBy = expectInteger(comparison.ahead_by, `${operation} ahead count`)
  const totalCommits = expectInteger(comparison.total_commits, `${operation} total commits`)
  if (aheadBy > 100 || comparison.commits.length > 100 || comparison.files.length >= 300) {
    throw new GitHubPromotionEligibilityError('github-api-pagination-limit', operation)
  }
  const commitShas = comparison.commits.map((item, index) =>
    expectSha(expectRecord(item, `${operation} commit ${index}`).sha, `${operation} commit ${index} SHA`),
  )
  const changedPaths = comparison.files.flatMap((item, index) => {
    const file = expectRecord(item, `${operation} file ${index}`)
    const filename = expectString(file.filename, `${operation} file ${index} path`)
    return file.previous_filename === undefined
      ? [filename]
      : [filename, expectString(file.previous_filename, `${operation} file ${index} previous path`)]
  })
  return {
    status: expectString(comparison.status, `${operation} status`),
    baseSha: expectSha(baseCommit.sha, `${operation} base commit SHA`),
    headSha: options.headSha,
    mergeBaseSha: expectSha(mergeBaseCommit.sha, `${operation} merge base SHA`),
    aheadBy,
    totalCommits,
    commitShas,
    changedPaths,
  }
}

const fetchDefaultBranchIdentity = async (
  options: GitHubRequestOptions & { readonly repository: string },
): Promise<{ readonly defaultBranch: string; readonly sha: string }> => {
  const repositoryOperation = `read ${options.repository} default branch`
  const repositoryResponse = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}`,
    operation: repositoryOperation,
  })
  const repository = expectRecord(repositoryResponse.value, repositoryOperation)
  const defaultBranch = expectString(repository.default_branch, `${repositoryOperation} name`)
  const branchOperation = `read ${options.repository} ${defaultBranch} branch`
  const branchResponse = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/branches/${encodeURIComponent(defaultBranch)}`,
    operation: branchOperation,
  })
  const branch = expectRecord(branchResponse.value, branchOperation)
  const commit = expectRecord(branch.commit, `${branchOperation} commit`)
  return { defaultBranch, sha: expectSha(commit.sha, `${branchOperation} SHA`) }
}

const reviewsQuery = `
  query BaynPromotionReviews($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $cursor) {
          nodes { author { login } commit { oid } submittedAt state }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const threadsQuery = `
  query BaynPromotionThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            path
            comments(first: 1) { nodes { url } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const headForcePushQuery = `
  query BaynPromotionHeadForcePushes($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        timelineItems(first: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            __typename
            ... on HeadRefForcePushedEvent {
              createdAt
              beforeCommit { oid }
              afterCommit { oid }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const graphqlConnection = (
  data: Record<string, unknown>,
  connectionName: string,
  operation: string,
): Record<string, unknown> => {
  const repository = expectRecord(data.repository, operation)
  const pullRequest = expectRecord(repository.pullRequest, operation)
  return expectRecord(pullRequest[connectionName], operation)
}

const pageInfo = (
  connection: Record<string, unknown>,
  operation: string,
): { readonly hasNextPage: boolean; readonly endCursor: string | null } => {
  const value = expectRecord(connection.pageInfo, `${operation} page info`)
  return {
    hasNextPage: expectBoolean(value.hasNextPage, `${operation} has next page`),
    endCursor: expectNullableString(value.endCursor, `${operation} end cursor`),
  }
}

const fetchReviews = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<readonly BaynPromotionReview[]> => {
  const [owner, name] = repositoryParts(options.repository)
  const reviews: BaynPromotionReview[] = []
  let cursor: string | null = null
  for (let page = 1; page <= maximumGraphqlPages; page += 1) {
    const operation = `read promotion PR #${options.pullNumber} reviews page ${page}`
    const data = await requestGraphql({
      ...options,
      query: reviewsQuery,
      variables: { owner, name, number: options.pullNumber, cursor },
      operation,
    })
    const connection = graphqlConnection(data, 'reviews', operation)
    if (!Array.isArray(connection.nodes)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [index, item] of connection.nodes.entries()) {
      const review = expectRecord(item, `${operation} review ${index}`)
      const author = review.author === null ? null : expectRecord(review.author, `${operation} author ${index}`)
      const commit = review.commit === null ? null : expectRecord(review.commit, `${operation} commit ${index}`)
      reviews.push({
        authorLogin: author === null ? null : expectString(author.login, `${operation} author login ${index}`),
        commitSha: commit === null ? null : expectSha(commit.oid, `${operation} commit SHA ${index}`),
        submittedAt: expectNullableString(review.submittedAt, `${operation} submitted at ${index}`),
        state: expectString(review.state, `${operation} state ${index}`),
      })
    }
    const pagination = pageInfo(connection, operation)
    if (!pagination.hasNextPage) return reviews
    if (pagination.endCursor === null) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    cursor = pagination.endCursor
  }
  throw new GitHubPromotionEligibilityError(
    'github-api-pagination-limit',
    `read promotion PR #${options.pullNumber} reviews`,
  )
}

const fetchThreads = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<readonly BaynPromotionReviewThread[]> => {
  const [owner, name] = repositoryParts(options.repository)
  const threads: BaynPromotionReviewThread[] = []
  let cursor: string | null = null
  for (let page = 1; page <= maximumGraphqlPages; page += 1) {
    const operation = `read promotion PR #${options.pullNumber} review threads page ${page}`
    const data = await requestGraphql({
      ...options,
      query: threadsQuery,
      variables: { owner, name, number: options.pullNumber, cursor },
      operation,
    })
    const connection = graphqlConnection(data, 'reviewThreads', operation)
    if (!Array.isArray(connection.nodes)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }

    for (const [index, item] of connection.nodes.entries()) {
      const thread = expectRecord(item, `${operation} thread ${index}`)
      const comments = expectRecord(thread.comments, `${operation} comments ${index}`)
      if (!Array.isArray(comments.nodes)) {
        throw new GitHubPromotionEligibilityError('github-api-invalid-response', `${operation} comments ${index}`)
      }
      const firstComment = comments.nodes[0]
      const url =
        firstComment === undefined
          ? null
          : expectString(
              expectRecord(firstComment, `${operation} first comment ${index}`).url,
              `${operation} URL ${index}`,
            )
      threads.push({
        id: expectString(thread.id, `${operation} thread ID ${index}`),
        isResolved: expectBoolean(thread.isResolved, `${operation} resolved ${index}`),
        isOutdated: expectBoolean(thread.isOutdated, `${operation} outdated ${index}`),
        path: expectNullableString(thread.path, `${operation} path ${index}`),
        url,
      })
    }
    const pagination = pageInfo(connection, operation)
    if (!pagination.hasNextPage) return threads
    if (pagination.endCursor === null) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    cursor = pagination.endCursor
  }
  throw new GitHubPromotionEligibilityError(
    'github-api-pagination-limit',
    `read promotion PR #${options.pullNumber} review threads`,
  )
}

const fetchHeadForcePushes = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<readonly BaynPromotionHeadForcePush[]> => {
  const [owner, name] = repositoryParts(options.repository)
  const operation = `read promotion PR #${options.pullNumber} head-force-push history`
  const data = await requestGraphql({
    ...options,
    query: headForcePushQuery,
    variables: { owner, name, number: options.pullNumber },
    operation,
  })
  const connection = graphqlConnection(data, 'timelineItems', operation)
  if (!Array.isArray(connection.nodes)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
  }
  const pagination = pageInfo(connection, operation)
  if (pagination.hasNextPage) {
    throw new GitHubPromotionEligibilityError('github-api-pagination-limit', operation)
  }
  const forcePushes: BaynPromotionHeadForcePush[] = []
  for (const [index, item] of connection.nodes.entries()) {
    const event = expectRecord(item, `${operation} event ${index}`)
    if (event.__typename !== 'HeadRefForcePushedEvent') {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', `${operation} event ${index}`)
    }
    const beforeCommit = expectRecord(event.beforeCommit, `${operation} event ${index} before commit`)
    const afterCommit = expectRecord(event.afterCommit, `${operation} event ${index} after commit`)
    forcePushes.push({
      beforeSha: expectSha(beforeCommit.oid, `${operation} event ${index} before SHA`),
      afterSha: expectSha(afterCommit.oid, `${operation} event ${index} after SHA`),
      createdAt: expectTimestamp(event.createdAt, `${operation} event ${index} created at`),
    })
  }
  return forcePushes
}

const fetchIssueComments = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<readonly BaynPromotionIssueComment[]> => {
  const comments: BaynPromotionIssueComment[] = []
  for (let page = 1; page <= maximumRestPages; page += 1) {
    const operation = `read promotion PR #${options.pullNumber} issue comments page ${page}`
    const response = await requestJson({
      ...options,
      url: `https://api.github.com/repos/${apiRepository(options.repository)}/issues/${options.pullNumber}/comments?per_page=100&page=${page}`,
      operation,
    })
    if (!Array.isArray(response.value)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [index, item] of response.value.entries()) {
      const comment = expectRecord(item, `${operation} comment ${index}`)
      const user = comment.user === null ? null : expectRecord(comment.user, `${operation} user ${index}`)
      comments.push({
        authorLogin: user === null ? null : expectString(user.login, `${operation} user login ${index}`),
        body: expectAnyString(comment.body, `${operation} body ${index}`),
        createdAt: expectTimestamp(comment.created_at, `${operation} created at ${index}`),
        updatedAt: expectTimestamp(comment.updated_at, `${operation} updated at ${index}`),
      })
    }
    if (!hasNextPage(response.headers)) return comments
  }
  throw new GitHubPromotionEligibilityError(
    'github-api-pagination-limit',
    `read promotion PR #${options.pullNumber} issue comments`,
  )
}

const fetchReactions = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly pullNumber: number },
): Promise<readonly BaynPromotionReaction[]> => {
  const reactions: BaynPromotionReaction[] = []
  for (let page = 1; page <= maximumRestPages; page += 1) {
    const operation = `read promotion PR #${options.pullNumber} reactions page ${page}`
    const response = await requestJson({
      ...options,
      url: `https://api.github.com/repos/${apiRepository(options.repository)}/issues/${options.pullNumber}/reactions?per_page=100&page=${page}`,
      operation,
    })
    if (!Array.isArray(response.value)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [index, item] of response.value.entries()) {
      const reaction = expectRecord(item, `${operation} reaction ${index}`)
      const user = reaction.user === null ? null : expectRecord(reaction.user, `${operation} user ${index}`)
      reactions.push({
        userLogin: user === null ? null : expectString(user.login, `${operation} user login ${index}`),
        content: expectString(reaction.content, `${operation} content ${index}`),
        createdAt: expectTimestamp(reaction.created_at, `${operation} created at ${index}`),
      })
    }
    if (!hasNextPage(response.headers)) return reactions
  }
  throw new GitHubPromotionEligibilityError(
    'github-api-pagination-limit',
    `read promotion PR #${options.pullNumber} reactions`,
  )
}

interface WorkflowRun {
  readonly id: number
  readonly runNumber: number
  readonly runAttempt: number
  readonly headSha: string
  readonly headBranch: string
  readonly event: string
  readonly status: string
  readonly conclusion: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

const fetchReleaseRunState = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly runId: number },
): Promise<BaynPromotionReleaseRunState> => {
  const operation = `read verified Bayn release run ${options.runId}`
  const response = await requestJson({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/actions/runs/${options.runId}`,
    operation,
  })
  const run = expectRecord(response.value, operation)
  return {
    id: expectInteger(run.id, `${operation} ID`),
    runAttempt: expectInteger(run.run_attempt, `${operation} attempt`),
    headSha: expectSha(run.head_sha, `${operation} head SHA`),
    headBranch: expectString(run.head_branch, `${operation} head branch`),
    event: expectString(run.event, `${operation} event`),
    status: expectString(run.status, `${operation} status`),
    conclusion: expectNullableString(run.conclusion, `${operation} conclusion`),
  }
}

export const isBaynPromotionBuildRunCandidate = (
  run: Pick<WorkflowRun, 'headSha' | 'headBranch' | 'event' | 'status' | 'conclusion'>,
  sourceSha: string,
): boolean =>
  run.headBranch === 'main' &&
  run.event === 'push' &&
  run.headSha === sourceSha &&
  run.status === 'completed' &&
  run.conclusion === 'success'

interface WorkflowRunsQuery {
  readonly repository: string
  readonly workflow: string
  readonly page: number
  readonly headSha?: string
  readonly event?: 'push' | 'workflow_run'
  readonly status?: 'success'
  readonly createdAfter?: string
  readonly createdBefore?: string
}

export const baynWorkflowRunsUrl = (query: WorkflowRunsQuery): string => {
  const parameters = new URLSearchParams({
    branch: 'main',
    per_page: '100',
    page: String(query.page),
  })
  if (query.headSha !== undefined) parameters.set('head_sha', query.headSha)
  if (query.event !== undefined) parameters.set('event', query.event)
  if (query.status !== undefined) parameters.set('status', query.status)
  if (query.createdAfter !== undefined && query.createdBefore !== undefined) {
    parameters.set('created', `${query.createdAfter}..${query.createdBefore}`)
  } else if (query.createdAfter !== undefined) {
    parameters.set('created', `>=${query.createdAfter}`)
  } else if (query.createdBefore !== undefined) {
    parameters.set('created', `<=${query.createdBefore}`)
  }

  return `https://api.github.com/repos/${apiRepository(query.repository)}/actions/workflows/${encodeURIComponent(query.workflow)}/runs?${parameters.toString()}`
}

export const baynReleaseSearchRange = (
  buildUpdatedAt: string,
): { readonly createdAfter: string; readonly createdBefore: string } => {
  const buildUpdatedAtMs = Date.parse(buildUpdatedAt)
  if (!Number.isFinite(buildUpdatedAtMs)) throw new Error('build run timestamp is invalid')
  return {
    createdAfter: new Date(buildUpdatedAtMs - releaseTriggerClockSkewMs).toISOString(),
    createdBefore: new Date(buildUpdatedAtMs + maximumReleaseTriggerDelayMs).toISOString(),
  }
}

const fetchWorkflowRuns = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly workflow: string
    readonly headSha?: string
    readonly event?: WorkflowRunsQuery['event']
    readonly status?: 'success'
    readonly createdAfter?: string
    readonly createdBefore?: string
  },
): Promise<readonly WorkflowRun[]> => {
  const runs: WorkflowRun[] = []
  for (let page = 1; page <= maximumRestPages; page += 1) {
    const scope = [options.event, options.headSha === undefined ? null : shortSha(options.headSha)]
      .filter((value) => value !== null && value !== undefined)
      .join(' ')
    const operation = `list ${options.workflow} ${scope.length === 0 ? '' : `${scope} `}runs page ${page}`
    const response = await requestJson({
      ...options,
      url: baynWorkflowRunsUrl({
        repository: options.repository,
        workflow: options.workflow,
        page,
        ...(options.headSha === undefined ? {} : { headSha: options.headSha }),
        ...(options.event === undefined ? {} : { event: options.event }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.createdAfter === undefined ? {} : { createdAfter: options.createdAfter }),
        ...(options.createdBefore === undefined ? {} : { createdBefore: options.createdBefore }),
      }),
      operation,
    })
    const payload = expectRecord(response.value, operation)
    if (!Array.isArray(payload.workflow_runs)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [index, item] of payload.workflow_runs.entries()) {
      const run = expectRecord(item, `${operation} run ${index}`)
      runs.push({
        id: expectInteger(run.id, `${operation} run ${index} ID`),
        runNumber: expectInteger(run.run_number, `${operation} run ${index} number`),
        runAttempt: expectInteger(run.run_attempt, `${operation} run ${index} attempt`),
        headSha: expectSha(run.head_sha, `${operation} run ${index} head SHA`),
        headBranch: expectString(run.head_branch, `${operation} run ${index} head branch`),
        event: expectString(run.event, `${operation} run ${index} event`),
        status: expectString(run.status, `${operation} run ${index} status`),
        conclusion: expectNullableString(run.conclusion, `${operation} run ${index} conclusion`),
        createdAt: expectTimestamp(run.created_at, `${operation} run ${index} created at`),
        updatedAt: expectTimestamp(run.updated_at, `${operation} run ${index} updated at`),
      })
    }
    if (!hasNextPage(response.headers)) return runs
  }
  throw new GitHubPromotionEligibilityError('github-api-pagination-limit', `list ${options.workflow} runs`)
}

interface Artifact {
  readonly id: number
  readonly name: string
  readonly expired: boolean
}

const fetchArtifacts = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly runId: number },
): Promise<readonly Artifact[]> => {
  const artifacts: Artifact[] = []
  for (let page = 1; page <= maximumRestPages; page += 1) {
    const operation = `list artifacts for workflow run ${options.runId} page ${page}`
    const response = await requestJson({
      ...options,
      url: `https://api.github.com/repos/${apiRepository(options.repository)}/actions/runs/${options.runId}/artifacts?per_page=100&page=${page}`,
      operation,
    })
    const payload = expectRecord(response.value, operation)
    if (!Array.isArray(payload.artifacts)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [index, item] of payload.artifacts.entries()) {
      const artifact = expectRecord(item, `${operation} artifact ${index}`)
      artifacts.push({
        id: expectInteger(artifact.id, `${operation} artifact ${index} ID`),
        name: expectString(artifact.name, `${operation} artifact ${index} name`),
        expired: expectBoolean(artifact.expired, `${operation} artifact ${index} expired`),
      })
    }
    if (!hasNextPage(response.headers)) return artifacts
  }
  throw new GitHubPromotionEligibilityError(
    'github-api-pagination-limit',
    `list artifacts for workflow run ${options.runId}`,
  )
}

const u16 = (bytes: Uint8Array, offset: number): number => bytes[offset]! | (bytes[offset + 1]! << 8)

const u32 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0

interface ZipTextEntry {
  readonly name: string
  readonly content: string
}

const extractZipTextEntries = (
  bytes: Uint8Array,
  options: {
    readonly label: string
    readonly maximumEntries: number
    readonly maximumEntryBytes: number
  },
): readonly ZipTextEntry[] => {
  const minimumEndOffset = Math.max(0, bytes.byteLength - 65_557)
  let endOffset = -1
  for (let offset = bytes.byteLength - 22; offset >= minimumEndOffset; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error(`${options.label} ZIP end record is missing`)
  const entryCount = u16(bytes, endOffset + 10)
  const centralSize = u32(bytes, endOffset + 12)
  const centralOffset = u32(bytes, endOffset + 16)
  if (entryCount <= 0 || entryCount > options.maximumEntries || centralOffset + centralSize > bytes.byteLength) {
    throw new Error(`${options.label} ZIP directory is invalid`)
  }
  const entries: ZipTextEntry[] = []
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || u32(bytes, offset) !== 0x02014b50) {
      throw new Error(`${options.label} ZIP entry is invalid`)
    }
    const flags = u16(bytes, offset + 8)
    const compression = u16(bytes, offset + 10)
    const compressedSize = u32(bytes, offset + 20)
    const uncompressedSize = u32(bytes, offset + 24)
    const nameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    const localOffset = u32(bytes, offset + 42)
    const name = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if ((flags & 1) !== 0 || (compression !== 0 && compression !== 8)) {
      throw new Error(`${options.label} ZIP entry uses unsupported encoding`)
    }
    if (
      uncompressedSize > options.maximumEntryBytes ||
      localOffset + 30 > bytes.byteLength ||
      u32(bytes, localOffset) !== 0x04034b50
    ) {
      throw new Error(`${options.label} ZIP entry is invalid`)
    }
    const localNameLength = u16(bytes, localOffset + 26)
    const localExtraLength = u16(bytes, localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > bytes.byteLength) {
      throw new Error(`${options.label} ZIP entry is invalid`)
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize)
    const content = compression === 0 ? compressed : new Uint8Array(inflateRawSync(compressed))
    if (content.byteLength !== uncompressedSize || content.byteLength > options.maximumEntryBytes) {
      throw new Error(`${options.label} ZIP size is invalid`)
    }
    entries.push({ name, content: Buffer.from(content).toString('utf8') })
  }
  return entries
}

export const extractReleaseContractFromZip = (bytes: Uint8Array): string => {
  const entries = extractZipTextEntries(bytes, {
    label: 'release artifact',
    maximumEntries: 10,
    maximumEntryBytes: maximumContractBytes,
  })
  const contracts = entries.filter((entry) => entry.name === 'release-contract.json')
  if (contracts.length !== 1) throw new Error('release-contract.json is missing from artifact ZIP')
  return contracts[0]!.content
}

const parseReleaseContract = (content: string): BaynReleaseContract => {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', 'parse Bayn release contract', {
      cause: error,
    })
  }
  const contract = expectRecord(value, 'parse Bayn release contract')
  if (!Array.isArray(contract.platforms)) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', 'parse Bayn release contract platforms')
  }
  return {
    service: expectString(contract.service, 'release contract service'),
    image: expectString(contract.image, 'release contract image'),
    tag: expectString(contract.tag, 'release contract tag'),
    digest: expectString(contract.digest, 'release contract digest'),
    reference: expectString(contract.reference, 'release contract reference'),
    sourceSha: expectSha(contract.sourceSha, 'release contract source SHA'),
    packageAttr: expectString(contract.packageAttr, 'release contract package'),
    platforms: contract.platforms.map((platform, index) =>
      expectString(platform, `release contract platform ${index}`),
    ),
  }
}

const downloadReleaseContract = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly artifactId: number },
): Promise<BaynReleaseContract> => {
  const operation = `download Bayn release contract artifact ${options.artifactId}`
  const response = await requestBytes({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/actions/artifacts/${options.artifactId}/zip`,
    operation,
  })
  try {
    return parseReleaseContract(extractReleaseContractFromZip(response.value))
  } catch (error) {
    if (error instanceof GitHubPromotionEligibilityError) throw error
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation, { cause: error })
  }
}

export interface BaynReleasePromotionEvidence {
  readonly sourceSha: string
  readonly pullNumber: number
  readonly headSha: string
  readonly branch: string
  readonly baseRefName: string
  readonly repository: string
  readonly operation: 'created' | 'updated'
}

const uniqueLogValue = (content: string, name: string, pattern: RegExp): string => {
  const matches = [...content.matchAll(pattern)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`release run log must contain exactly one ${name}`)
  }
  return matches[0][1]
}

export const extractReleasePromotionEvidenceFromZip = (bytes: Uint8Array): BaynReleasePromotionEvidence => {
  const entries = extractZipTextEntries(bytes, {
    label: 'release run logs',
    maximumEntries: maximumRunLogEntries,
    maximumEntryBytes: maximumRunLogEntryBytes,
  })
  const createPullRequestLogs = entries.filter((entry) => entry.name.endsWith('_Create deploy pull request.txt'))
  const validateContractLogs = entries.filter((entry) => entry.name.endsWith('_Validate release contract.txt'))
  const combinedPromoteLogs = entries.filter((entry) => /^\d+_promote\.txt$/.test(entry.name))
  const usesStepLogs = createPullRequestLogs.length === 1 && validateContractLogs.length === 1
  const usesCombinedLog =
    createPullRequestLogs.length === 0 && validateContractLogs.length === 0 && combinedPromoteLogs.length === 1
  if (!usesStepLogs && !usesCombinedLog) {
    if (createPullRequestLogs.length !== 1) {
      throw new Error('release run logs must contain exactly one Create deploy pull request step')
    }
    throw new Error('release run logs must contain exactly one Validate release contract step')
  }
  const content = usesStepLogs ? createPullRequestLogs[0]!.content : combinedPromoteLogs[0]!.content
  const validationContent = usesStepLogs ? validateContractLogs[0]!.content : combinedPromoteLogs[0]!.content
  const sourceSha = uniqueLogValue(
    validationContent,
    'WORKFLOW_SHA environment binding',
    /^.*WORKFLOW_SHA: ([0-9a-f]{40})\r?$/gm,
  )
  const pullNumberText = uniqueLogValue(
    content,
    'pull-request-number output',
    /^.*pull-request-number = ([0-9]+)\r?$/gm,
  )
  const pullNumber = Number(pullNumberText)
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('release run pull-request-number output is invalid')
  }
  const headSha = uniqueLogValue(
    content,
    'pull-request-head-sha output',
    /^.*pull-request-head-sha = ([0-9a-f]{40})\r?$/gm,
  )
  const branch = uniqueLogValue(content, 'pull-request-branch output', /^.*pull-request-branch = ([^\r\n]+)\r?$/gm)
  const operation = uniqueLogValue(
    content,
    'pull-request-operation output',
    /^.*pull-request-operation = (created|updated)\r?$/gm,
  )
  const pullRequestUrl = uniqueLogValue(
    content,
    'pull-request-url output',
    /^.*pull-request-url = (https:\/\/github\.com\/[^\s]+)\r?$/gm,
  )
  const baseRefName = uniqueLogValue(content, 'base input', /^.*Z   base: ([^\r\n]+)\r?$/gm)
  const urlMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([0-9]+)$/.exec(pullRequestUrl)
  if (urlMatch === null || Number(urlMatch[2]) !== pullNumber) {
    throw new Error('release run pull-request-url output is inconsistent')
  }
  return {
    sourceSha,
    pullNumber,
    headSha,
    branch,
    baseRefName,
    repository: urlMatch[1]!,
    operation: operation as 'created' | 'updated',
  }
}

const downloadReleasePromotionEvidence = async (
  options: GitHubRequestOptions & { readonly repository: string; readonly runId: number; readonly runAttempt: number },
): Promise<BaynReleasePromotionEvidence> => {
  const operation = `download Bayn release run ${options.runId} attempt ${options.runAttempt} logs`
  const response = await requestBytes({
    ...options,
    url: `https://api.github.com/repos/${apiRepository(options.repository)}/actions/runs/${options.runId}/attempts/${options.runAttempt}/logs`,
    operation,
  })
  try {
    return extractReleasePromotionEvidenceFromZip(response.value)
  } catch (error) {
    throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation, { cause: error })
  }
}

interface WorkflowJobStep {
  readonly name: string
  readonly conclusion: string
}

interface WorkflowJob {
  readonly name: string
  readonly conclusion: string
  readonly steps: readonly WorkflowJobStep[]
}

const fetchWorkflowJobs = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly runId: number
    readonly runAttempt?: number
  },
): Promise<readonly WorkflowJob[]> => {
  const jobs: WorkflowJob[] = []
  for (let page = 1; page <= maximumRestPages; page += 1) {
    const attempt = options.runAttempt === undefined ? '' : ` attempt ${options.runAttempt}`
    const operation = `read workflow run ${options.runId}${attempt} jobs page ${page}`
    const runPath =
      options.runAttempt === undefined
        ? `actions/runs/${options.runId}`
        : `actions/runs/${options.runId}/attempts/${options.runAttempt}`
    const response = await requestJson({
      ...options,
      url: `https://api.github.com/repos/${apiRepository(options.repository)}/${runPath}/jobs?per_page=100&page=${page}`,
      operation,
    })
    const payload = expectRecord(response.value, operation)
    if (!Array.isArray(payload.jobs)) {
      throw new GitHubPromotionEligibilityError('github-api-invalid-response', operation)
    }
    for (const [jobIndex, item] of payload.jobs.entries()) {
      const job = expectRecord(item, `${operation} job ${jobIndex}`)
      if (!Array.isArray(job.steps)) {
        throw new GitHubPromotionEligibilityError('github-api-invalid-response', `${operation} job steps`)
      }
      const steps = job.steps.map((step, stepIndex) => {
        const parsed = expectRecord(step, `${operation} step ${stepIndex}`)
        return {
          name: expectString(parsed.name, `${operation} step ${stepIndex} name`),
          conclusion: expectString(parsed.conclusion, `${operation} step ${stepIndex} conclusion`),
        }
      })
      jobs.push({
        name: expectString(job.name, `${operation} job ${jobIndex} name`),
        conclusion: expectString(job.conclusion, `${operation} job ${jobIndex} conclusion`),
        steps,
      })
    }
    if (!hasNextPage(response.headers)) return jobs
  }
  throw new GitHubPromotionEligibilityError('github-api-pagination-limit', `read workflow run ${options.runId} jobs`)
}

type BaynReleaseRunPromotionInspection =
  | { readonly status: 'created'; readonly evidence: BaynReleasePromotionEvidence }
  | { readonly status: 'held' | 'failed' | 'settling' | 'invalid'; readonly evidence: null }

const inspectReleaseRunPromotion = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly runId: number
    readonly runAttempt: number
  },
): Promise<BaynReleaseRunPromotionInspection> => {
  const promote = (await fetchWorkflowJobs(options)).find((job) => job.name === 'promote')
  if (promote === undefined) return { status: 'settling', evidence: null }
  if (promote.conclusion !== 'success') return { status: 'failed', evidence: null }
  const create = promote.steps.find((step) => step.name === 'Create deploy pull request')
  const held = promote.steps.find((step) => step.name === 'Record held candidate')
  if (create === undefined || held === undefined) return { status: 'settling', evidence: null }
  if (create.conclusion === 'success' && held.conclusion === 'skipped') {
    return { status: 'created', evidence: await downloadReleasePromotionEvidence(options) }
  }
  if (create.conclusion === 'skipped' && held.conclusion === 'success') {
    return { status: 'held', evidence: null }
  }
  return { status: 'invalid', evidence: null }
}

export interface BaynPromotionReleaseRunSnapshot {
  readonly runId: number
  readonly status: string
  readonly conclusion: string | null
  readonly promotionStatus: BaynReleaseRunPromotionInspection['status']
  readonly evidence: BaynReleasePromotionEvidence | null
}

export type BaynPromotionReleaseRunResolution =
  | { readonly status: 'resolved'; readonly runId: number; readonly evidence: BaynReleasePromotionEvidence }
  | { readonly status: 'missing'; readonly reason: string }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'ambiguous'; readonly reason: string }

export const resolveBaynPromotionReleaseRun = (input: {
  readonly repository: string
  readonly sourceSha: string
  readonly pullNumber: number
  readonly headSha: string
  readonly runs: readonly BaynPromotionReleaseRunSnapshot[]
}): BaynPromotionReleaseRunResolution => {
  if (input.runs.length === 0) {
    return {
      status: 'missing',
      reason: `${releaseWorkflow} run for reviewed source ${shortSha(input.sourceSha)} is not indexed yet`,
    }
  }
  const allCreated = input.runs.filter(
    ({ status, conclusion, promotionStatus, evidence }) =>
      status === 'completed' && conclusion === 'success' && promotionStatus === 'created' && evidence !== null,
  )
  const created = allCreated.filter(({ evidence }) => evidence?.sourceSha === input.sourceSha)
  const exact = created.filter(
    ({ evidence }) =>
      evidence !== null &&
      evidence.repository === input.repository &&
      evidence.baseRefName === 'main' &&
      evidence.branch === promotionBranch &&
      evidence.pullNumber === input.pullNumber &&
      evidence.headSha === input.headSha,
  )
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      reason: `${exact.length} successful ${releaseWorkflow} promotion jobs match source ${shortSha(input.sourceSha)}`,
    }
  }
  const selected = exact[0]
  if (selected !== undefined && selected.evidence !== null) {
    return { status: 'resolved', runId: selected.runId, evidence: selected.evidence }
  }
  if (
    allCreated.some(
      ({ evidence }) =>
        evidence !== null &&
        evidence.repository === input.repository &&
        evidence.baseRefName === 'main' &&
        evidence.branch === promotionBranch &&
        evidence.pullNumber === input.pullNumber &&
        evidence.headSha === input.headSha &&
        evidence.sourceSha !== input.sourceSha,
    )
  ) {
    return {
      status: 'stale',
      reason: `release promotion PR #${input.pullNumber} exact head ${shortSha(input.headSha)} is bound to a different triggering source`,
    }
  }
  if (input.runs.some((run) => run.promotionStatus === 'settling')) {
    return {
      status: 'missing',
      reason: `${releaseWorkflow} run for promotion PR #${input.pullNumber} exact head ${shortSha(input.headSha)} has not settled with immutable promotion evidence yet`,
    }
  }
  if (input.runs.some((run) => run.promotionStatus === 'invalid')) {
    return {
      status: 'stale',
      reason: `a completed ${releaseWorkflow} run has an invalid promotion-step outcome for source ${shortSha(input.sourceSha)}`,
    }
  }
  if (created.length === 0) {
    return {
      status: 'missing',
      reason: `no settled ${releaseWorkflow} run has created promotion PR #${input.pullNumber} exact head ${shortSha(input.headSha)} yet`,
    }
  }
  return {
    status: 'stale',
    reason: `successful ${releaseWorkflow} promotion evidence does not bind PR #${input.pullNumber} exact head ${shortSha(input.headSha)}`,
  }
}

const resolveProvenance = async (
  options: GitHubRequestOptions & {
    readonly repository: string
    readonly sourceSha: string
    readonly pullNumber: number
    readonly headSha: string
  },
): Promise<BaynPromotionProvenance> => {
  const requestOptions: GitHubRequestOptions = {
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  }
  const successfulPushRuns = await fetchWorkflowRuns({
    ...requestOptions,
    repository: options.repository,
    workflow: buildWorkflow,
    headSha: options.sourceSha,
    event: 'push',
    status: 'success',
  })
  const successfulBuildRuns = [
    ...new Map(
      successfulPushRuns
        .filter((run) => isBaynPromotionBuildRunCandidate(run, options.sourceSha))
        .map((run) => [run.id, run]),
    ).values(),
  ]
  if (successfulBuildRuns.length === 0) {
    return {
      status: 'missing',
      reason: `no successful ${buildWorkflow} main push exists for ${shortSha(options.sourceSha)}`,
    }
  }

  const contractCandidates: Array<{ readonly run: WorkflowRun; readonly contract: BaynReleaseContract }> = []
  let missingArtifact = false
  let staleArtifact = false
  for (const run of successfulBuildRuns) {
    const matchingArtifacts = (await fetchArtifacts({ ...options, runId: run.id })).filter(
      (artifact) => artifact.name === releaseContractArtifact,
    )
    if (matchingArtifacts.length !== 1) {
      if (matchingArtifacts.length > 1) {
        return {
          status: 'ambiguous',
          reason: `build run ${run.id} has ${matchingArtifacts.length} ${releaseContractArtifact} artifacts`,
        }
      }
      missingArtifact = true
      continue
    }
    const artifact = matchingArtifacts[0]
    if (artifact === undefined) throw new Error('artifact selection was unexpectedly empty')
    if (artifact.expired) {
      staleArtifact = true
      continue
    }
    const contract = await downloadReleaseContract({ ...options, artifactId: artifact.id })
    if (contract.sourceSha !== options.sourceSha) {
      if (run.event === 'push') staleArtifact = true
      continue
    }
    contractCandidates.push({ run, contract })
  }
  if (contractCandidates.length === 0) {
    if (missingArtifact) {
      return {
        status: 'missing',
        reason: `successful ${buildWorkflow} run(s) for ${shortSha(options.sourceSha)} do not yet expose a unique release contract artifact`,
      }
    }
    return {
      status: 'stale',
      reason: staleArtifact
        ? `successful ${buildWorkflow} run(s) for ${shortSha(options.sourceSha)} lack a live unique release contract artifact`
        : `no release contract was resolved for ${shortSha(options.sourceSha)}`,
    }
  }
  const contractIdentities = new Map<string, typeof contractCandidates>()
  for (const candidate of contractCandidates) {
    const identity = JSON.stringify({
      sourceSha: candidate.contract.sourceSha,
      tag: candidate.contract.tag,
      digest: candidate.contract.digest,
      reference: candidate.contract.reference,
    })
    contractIdentities.set(identity, [...(contractIdentities.get(identity) ?? []), candidate])
  }
  if (contractIdentities.size !== 1) {
    return {
      status: 'ambiguous',
      reason: `successful ${buildWorkflow} runs for ${shortSha(options.sourceSha)} expose ${contractIdentities.size} distinct release contracts`,
    }
  }
  const selectedCandidates = [...contractIdentities.values()][0]
  if (selectedCandidates === undefined || selectedCandidates.length === 0) {
    throw new Error('release contract selection was unexpectedly empty')
  }
  const releaseRunGroups = await Promise.all(
    selectedCandidates.map((candidate) =>
      fetchWorkflowRuns({
        ...requestOptions,
        repository: options.repository,
        workflow: releaseWorkflow,
        event: 'workflow_run',
        ...baynReleaseSearchRange(candidate.run.updatedAt),
      }),
    ),
  )
  const causalReleaseRuns = [...new Map(releaseRunGroups.flat().map((run) => [run.id, run])).values()].filter(
    (run) =>
      run.headBranch === 'main' &&
      run.event === 'workflow_run' &&
      selectedCandidates.some((candidate) => {
        const range = baynReleaseSearchRange(candidate.run.updatedAt)
        const runCreatedAtMs = Date.parse(run.createdAt)
        return Date.parse(range.createdAfter) <= runCreatedAtMs && runCreatedAtMs <= Date.parse(range.createdBefore)
      }),
  )
  const releaseRunSnapshots: BaynPromotionReleaseRunSnapshot[] = []
  for (const run of causalReleaseRuns) {
    const inspection: BaynReleaseRunPromotionInspection =
      run.status === 'completed' && run.conclusion === 'success'
        ? await inspectReleaseRunPromotion({ ...options, runId: run.id, runAttempt: run.runAttempt })
        : run.status === 'completed'
          ? { status: 'failed', evidence: null }
          : { status: 'settling', evidence: null }
    releaseRunSnapshots.push({
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      promotionStatus: inspection.status,
      evidence: inspection.evidence,
    })
  }
  const promotionResolution = resolveBaynPromotionReleaseRun({
    repository: options.repository,
    sourceSha: options.sourceSha,
    pullNumber: options.pullNumber,
    headSha: options.headSha,
    runs: releaseRunSnapshots,
  })
  if (promotionResolution.status !== 'resolved') return promotionResolution
  const promotionRun = causalReleaseRuns.find((run) => run.id === promotionResolution.runId)
  if (promotionRun === undefined) throw new Error('release run selection was unexpectedly empty')
  const causalBuilds = selectedCandidates.filter(
    (candidate) => Date.parse(candidate.run.updatedAt) <= Date.parse(promotionRun.createdAt),
  )
  const selectedBuild = causalBuilds.toSorted(
    (left, right) => right.run.runNumber - left.run.runNumber || right.run.runAttempt - left.run.runAttempt,
  )[0]
  if (selectedBuild === undefined) throw new Error('causal build run selection was unexpectedly empty')
  return {
    status: 'resolved',
    buildRunId: selectedBuild.run.id,
    releaseRunId: promotionRun.id,
    promotionPullNumber: promotionResolution.evidence.pullNumber,
    promotionHeadSha: promotionResolution.evidence.headSha,
    contract: selectedBuild.contract,
  }
}

interface StaticSnapshot {
  readonly repository: string
  readonly pullRequest: BaynPromotionPullRequest
  readonly baseManifests: BaynPromotionManifestContents
  readonly headManifests: BaynPromotionManifestContents
  readonly sourceFreshness: BaynPromotionSourceFreshness
  readonly sourceSha: string | null
}

export const createRefreshableBaynPromotionProvenanceLoader = (
  load: () => Promise<BaynPromotionProvenance>,
): (() => Promise<BaynPromotionProvenance>) => {
  let cached: BaynPromotionProvenance | null = null
  return async () => {
    if (cached !== null) return cached
    const provenance = await load()
    if (provenance.status !== 'missing') cached = provenance
    return provenance
  }
}

export const createGitHubPromotionEligibilityLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly pullNumber: number
  readonly headSha: string
  readonly requestTimeoutMs: number
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynPromotionEligibilitySnapshot>) => {
  repositoryParts(options.repository)
  const requestOptions: GitHubRequestOptions = {
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn ?? fetch,
  }
  let headManifestCache: { readonly headSha: string; readonly manifests: BaynPromotionManifestContents } | null = null
  let headCommittedAtCache: { readonly headSha: string; readonly committedAt: string } | null = null
  let loadProvenance: (() => Promise<BaynPromotionProvenance>) | null = null

  const loadStatic = async (): Promise<StaticSnapshot> => {
    const [pullRequestWithoutFiles, files] = await Promise.all([
      fetchPullRequest({ ...requestOptions, repository: options.repository, pullNumber: options.pullNumber }),
      fetchPullRequestFiles({ ...requestOptions, repository: options.repository, pullNumber: options.pullNumber }),
    ])
    const headForcePushes =
      pullRequestWithoutFiles.headRefName === promotionBranch
        ? await fetchHeadForcePushes({
            ...requestOptions,
            repository: options.repository,
            pullNumber: options.pullNumber,
          })
        : []
    const headCommittedAt =
      pullRequestWithoutFiles.headRefName === promotionBranch && pullRequestWithoutFiles.headSha === options.headSha
        ? headCommittedAtCache?.headSha === pullRequestWithoutFiles.headSha
          ? headCommittedAtCache.committedAt
          : await fetchCommitCommittedAt({
              ...requestOptions,
              repository: options.repository,
              sha: pullRequestWithoutFiles.headSha,
            })
        : pullRequestWithoutFiles.createdAt
    headCommittedAtCache = { headSha: pullRequestWithoutFiles.headSha, committedAt: headCommittedAt }
    const pullRequest = { ...pullRequestWithoutFiles, headCommittedAt, headForcePushes, files }
    if (pullRequest.headSha !== options.headSha) {
      return {
        repository: options.repository,
        pullRequest,
        baseManifests: {
          deployment: '',
          kustomization: '',
          applicationSet: '',
        },
        headManifests: {
          deployment: '',
          kustomization: '',
          applicationSet: '',
        },
        sourceFreshness: { status: 'stale', reason: 'exact promotion head changed before verification' },
        sourceSha: null,
      }
    }
    if (pullRequest.headRefName !== promotionBranch) {
      return {
        repository: options.repository,
        pullRequest,
        baseManifests: {
          deployment: '',
          kustomization: '',
          applicationSet: '',
        },
        headManifests: {
          deployment: '',
          kustomization: '',
          applicationSet: '',
        },
        sourceFreshness: { status: 'fresh' },
        sourceSha: null,
      }
    }
    const baseManifestsPromise = fetchManifests({
      ...requestOptions,
      repository: options.repository,
      ref: pullRequest.baseSha,
    })
    const headManifests =
      headManifestCache?.headSha === pullRequest.headSha
        ? headManifestCache.manifests
        : await fetchManifests({
            ...requestOptions,
            repository: options.repository,
            ref: pullRequest.headSha,
          })
    headManifestCache = { headSha: pullRequest.headSha, manifests: headManifests }
    const baseManifests = await baseManifestsPromise
    let sourceSha: string | null = null
    try {
      const pins = parseBaynPromotionPins(headManifests)
      if (/^[0-9a-f]{40}$/.test(pins.sourceSha)) sourceSha = pins.sourceSha
    } catch {
      // The pure evaluator reports the precise manifest error without widening API work.
    }
    const sourceFreshness: BaynPromotionSourceFreshness =
      sourceSha === null
        ? { status: 'stale', reason: 'promotion source could not be parsed' }
        : await fetchSourceFreshness({
            ...requestOptions,
            repository: options.repository,
            sourceSha,
            baseSha: pullRequest.baseSha,
          })
    return {
      repository: options.repository,
      pullRequest,
      baseManifests,
      headManifests,
      sourceFreshness,
      sourceSha,
    }
  }

  return async () => {
    // PR base identity, diff scope, force-push history, base manifests, and
    // source freshness are mutable while a gate polls. Reload them on every
    // attempt so a new main commit cannot create a stale-green merge window.
    const loaded = await loadStatic()
    if (loaded.pullRequest.headRefName !== promotionBranch) {
      return {
        ...loaded,
        provenance: { status: 'missing', reason: 'not a Bayn promotion branch' },
        reviews: [],
        threads: [],
        issueComments: [],
        reactions: [],
      }
    }
    const provenance: BaynPromotionProvenance =
      loaded.sourceSha === null
        ? { status: 'missing', reason: 'promotion source could not be parsed' }
        : loaded.sourceFreshness.status === 'stale'
          ? { status: 'stale', reason: loaded.sourceFreshness.reason }
          : await (loadProvenance ??= createRefreshableBaynPromotionProvenanceLoader(() =>
              resolveProvenance({
                ...requestOptions,
                repository: options.repository,
                sourceSha: loaded.sourceSha as string,
                pullNumber: loaded.pullRequest.number,
                headSha: loaded.pullRequest.headSha,
              }),
            ))()
    const [reviews, threads, issueComments, reactions] = await Promise.all([
      fetchReviews({ ...requestOptions, repository: options.repository, pullNumber: options.pullNumber }),
      fetchThreads({ ...requestOptions, repository: options.repository, pullNumber: options.pullNumber }),
      fetchIssueComments({ ...requestOptions, repository: options.repository, pullNumber: options.pullNumber }),
      fetchReactions({ ...requestOptions, repository: options.repository, pullNumber: options.pullNumber }),
    ])
    return { ...loaded, provenance, reviews, threads, issueComments, reactions }
  }
}

export const createGitHubPromotionCurrentBaseRefreshLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly pullNumber: number
  readonly headSha: string
  readonly requestTimeoutMs: number
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynPromotionCurrentBaseRefreshSnapshot>) => {
  const requestOptions: GitHubRequestOptions = {
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn ?? fetch,
  }
  const loadPromotion = createGitHubPromotionEligibilityLoader(options)
  return async () => {
    const [promotion, defaultBranchIdentity] = await Promise.all([
      loadPromotion(),
      fetchDefaultBranchIdentity({ ...requestOptions, repository: options.repository }),
    ])
    let sourceSha: string | null = null
    try {
      sourceSha = parseBaynPromotionPins(promotion.headManifests).sourceSha
    } catch {
      // The eligibility evaluator will retain the precise manifest failure.
    }
    const [currentManifests, baseAdvance, currentSourceFreshness, releaseRun] = await Promise.all([
      fetchManifests({
        ...requestOptions,
        repository: options.repository,
        ref: defaultBranchIdentity.sha,
      }),
      fetchBaseAdvance({
        ...requestOptions,
        repository: options.repository,
        baseSha: promotion.pullRequest.baseSha,
        headSha: defaultBranchIdentity.sha,
      }),
      sourceSha === null
        ? Promise.resolve<BaynPromotionSourceFreshness>({
            status: 'stale',
            reason: 'promotion source could not be parsed for current-main refresh',
          })
        : fetchSourceFreshness({
            ...requestOptions,
            repository: options.repository,
            sourceSha,
            baseSha: defaultBranchIdentity.sha,
          }),
      promotion.provenance.status === 'resolved'
        ? fetchReleaseRunState({
            ...requestOptions,
            repository: options.repository,
            runId: promotion.provenance.releaseRunId,
          })
        : Promise.resolve(null),
    ])
    return {
      promotion,
      repositoryDefaultBranch: defaultBranchIdentity.defaultBranch,
      currentDefaultBranchSha: defaultBranchIdentity.sha,
      currentSourceFreshness,
      baseAdvance,
      currentManifests,
      releaseRun,
    }
  }
}

interface CliOptions {
  readonly mode: 'verify' | 'current-base-refresh'
  readonly repository: string
  readonly pullNumber: number
  readonly headSha: string
  readonly defaultBranchSha: string | null
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
  readonly requireApplicable: boolean
}

const parsePositiveInteger = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export const parseVerifyPromotionArguments = (
  arguments_: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): CliOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('arguments must be provided as --name value pairs')
    }
    if (values.has(name)) throw new Error(`duplicate argument ${name}`)
    values.set(name, value)
  }
  const allowed = new Set([
    '--mode',
    '--repository',
    '--pull-number',
    '--head-sha',
    '--default-branch-sha',
    '--max-attempts',
    '--poll-interval-ms',
    '--request-timeout-ms',
    '--require-applicable',
  ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown argument ${name}`)
  }
  const repository = values.get('--repository') ?? environment.GITHUB_REPOSITORY
  const headSha = values.get('--head-sha')
  const modeValue = values.get('--mode') ?? 'verify'
  if (modeValue !== 'verify' && modeValue !== 'current-base-refresh') {
    throw new Error('--mode must be verify or current-base-refresh')
  }
  if (repository === undefined || repository.length === 0) {
    throw new Error('--repository or GITHUB_REPOSITORY is required')
  }
  repositoryParts(repository)
  if (headSha === undefined || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('--head-sha must be a lowercase 40-character commit SHA')
  }
  const defaultBranchSha = values.get('--default-branch-sha') ?? null
  if (
    (modeValue === 'current-base-refresh' && (defaultBranchSha === null || !/^[0-9a-f]{40}$/.test(defaultBranchSha))) ||
    (defaultBranchSha !== null && !/^[0-9a-f]{40}$/.test(defaultBranchSha))
  ) {
    throw new Error('--default-branch-sha must be a lowercase 40-character commit SHA in current-base-refresh mode')
  }
  const requireApplicableValue = values.get('--require-applicable') ?? 'false'
  if (requireApplicableValue !== 'true' && requireApplicableValue !== 'false') {
    throw new Error('--require-applicable must be true or false')
  }
  return {
    mode: modeValue,
    repository,
    pullNumber: parsePositiveInteger(values.get('--pull-number') ?? '', '--pull-number'),
    headSha,
    defaultBranchSha,
    maxAttempts: parsePositiveInteger(values.get('--max-attempts') ?? '10', '--max-attempts'),
    pollIntervalMs: parsePositiveInteger(values.get('--poll-interval-ms') ?? '10000', '--poll-interval-ms'),
    requestTimeoutMs: parsePositiveInteger(values.get('--request-timeout-ms') ?? '10000', '--request-timeout-ms'),
    requireApplicable: requireApplicableValue === 'true',
  }
}

const run = async (): Promise<void> => {
  const options = parseVerifyPromotionArguments(process.argv.slice(2))
  const token = process.env.BAYN_PROMOTION_GITHUB_TOKEN
  if (token === undefined || token.length === 0) throw new Error('BAYN_PROMOTION_GITHUB_TOKEN is required')
  if (options.mode === 'current-base-refresh') {
    const snapshot = await createGitHubPromotionCurrentBaseRefreshLoader({
      repository: options.repository,
      token,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      requestTimeoutMs: options.requestTimeoutMs,
    })()
    const decision = evaluateBaynPromotionCurrentBaseRefresh({
      expectedRepository: options.repository,
      expectedPullNumber: options.pullNumber,
      expectedHeadSha: options.headSha,
      expectedDefaultBranchSha: options.defaultBranchSha as string,
      snapshot,
      nowMs: Date.now(),
    })
    if (decision.status === 'hold') {
      console.error(`BAYN_PROMOTION_BASE_REFRESH_HOLD ${decision.code}: ${decision.message}`)
      process.exitCode = 1
      return
    }
    if (decision.status === 'noop') {
      console.log(`BAYN_PROMOTION_BASE_REFRESH_NOOP ${decision.code}: ${decision.message}`)
      return
    }
    console.log(
      `BAYN_PROMOTION_BASE_REFRESH pr=#${decision.prNumber} head=${decision.headSha} source=${decision.sourceSha} digest=${decision.digest} build_run=${decision.buildRunId} release_run=${decision.releaseRunId} release_attempt=${decision.releaseRunAttempt} current_base=${decision.currentBaseSha} target_base=${decision.targetBaseSha}`,
    )
    return
  }
  const result = await pollBaynPromotionEligibility({
    expectedRepository: options.repository,
    expectedPullNumber: options.pullNumber,
    expectedHeadSha: options.headSha,
    maxAttempts: options.maxAttempts,
    pollIntervalMs: options.pollIntervalMs,
    loadSnapshot: createGitHubPromotionEligibilityLoader({
      repository: options.repository,
      token,
      pullNumber: options.pullNumber,
      headSha: options.headSha,
      requestTimeoutMs: options.requestTimeoutMs,
    }),
  })
  if (result.status === 'hold') {
    console.error(`BAYN_PROMOTION_HOLD ${result.code}: ${result.message}`)
    process.exitCode = 1
    return
  }
  if (result.status === 'not-applicable') {
    const message = `BAYN_PROMOTION_NOT_APPLICABLE pr=#${result.prNumber} head=${shortSha(result.headSha)}`
    if (isBaynPromotionCliFailure(result, options.requireApplicable)) {
      console.error(message)
      process.exitCode = 1
    } else {
      console.log(message)
    }
    return
  }
  console.log(
    `BAYN_PROMOTION_ELIGIBLE pr=#${result.prNumber} head=${shortSha(result.headSha)} source=${shortSha(result.sourceSha)} tag=${result.tag} digest=${result.digest} build_run=${result.buildRunId} release_run=${result.releaseRunId} attempts=${result.attempts}`,
  )
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error
    console.error(`BAYN_PROMOTION_HOLD verifier-startup-error: ${name}`)
    process.exitCode = 1
  })
}
