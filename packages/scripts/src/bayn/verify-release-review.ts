#!/usr/bin/env bun

import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const githubApiVersion = '2022-11-28'
const githubApiBase = 'https://api.github.com'
const githubGraphqlUrl = 'https://api.github.com/graphql'
const maximumPages = 20
const maximumPublishRunPages = 3
const maximumReleaseRangeCommits = 100
const githubWorkflowPath = '.github/workflows/bayn-ci.yml'
const baynBuildWorkflowPath = '.github/workflows/bayn-build-push.yml'
export const baynReleaseGateName = 'Bayn release gate'
export const baynImagePublishJobName = 'image / publish-index'
export const migrationCheckpointPath = 'packages/scripts/src/bayn/bayn-release-review-baseline.json'
export const baynReleaseGateRunTitle = (pullRequestNumber: number, baseSha: string): string =>
  `${baynReleaseGateName} #${pullRequestNumber} base=${baseSha}`

export const baynCodexReviewer = 'chatgpt-codex-connector'
export const baynCodexBotLogin = 'chatgpt-codex-connector[bot]'

const migrationCheckpointStartSha = 'b0b66eac86bbd7fc28df8025b796ec5221b92906'
const migrationCheckpointEndSha = '8cfdab1bafb0a2f2650c9e0340a3157b75cfb648'
const migrationCheckpointPullRequestNumber = 13488
const migrationCheckpointPullRequestHeadSha = '63ff05092123b9f0372a5a94a7d54bdfa06c5ddc'
const migrationCheckpointGateRunId = 30773173470

export interface PullRequestReview {
  readonly authorLogin: string | null
  readonly commitSha: string | null
  readonly submittedAt: string | null
  readonly state: string
}

export interface PullRequestReviewThread {
  readonly id: string
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly path: string | null
  readonly url: string | null
}

export interface PullRequestReaction {
  readonly userLogin: string | null
  readonly content: string
  readonly createdAt: string
}

export interface PullRequestReviewState {
  readonly number: number
  readonly baseRefName: string
  readonly baseSha: string
  readonly headBranch: string
  readonly headSha: string
  readonly mergeCommitSha: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly mergedAt: string | null
  readonly headCommittedAt: string | null
  readonly reviews: readonly PullRequestReview[]
  readonly threads: readonly PullRequestReviewThread[]
  readonly commitShas: readonly string[]
  readonly reactions: readonly PullRequestReaction[]
}

export interface ReviewGateEvidence {
  readonly prNumber: number
  readonly headSha: string
  readonly reviewSubmittedAt: string
}

export type ReviewGateHoldCode =
  | 'source-pr-metadata-mismatch'
  | 'source-pr-commit-history-mismatch'
  | 'exact-head-review-missing'
  | 'exact-head-review-pending'
  | 'exact-head-review-changes-requested'
  | 'active-unresolved-review-threads'

export type ReviewGateEvaluation =
  | ({ readonly status: 'eligible' } & ReviewGateEvidence)
  | {
      readonly status: 'hold'
      readonly code: ReviewGateHoldCode
      readonly message: string
    }

export interface CommitFileChange {
  readonly path: string
  readonly previousPath: string | null
}

export interface MainCommitEvidence {
  readonly sha: string
  readonly parents: readonly string[]
  readonly files: readonly CommitFileChange[]
  readonly sourcePullRequest: SourcePullRequestEvidence | null
  readonly gateRun: TrustedBaynGateRun | null
}

export interface SourcePullRequestEvidence {
  readonly number: number
  readonly repository: string
  readonly baseRefName: string
  readonly baseSha: string
  readonly headBranch: string
  readonly headSha: string
  readonly mergeCommitSha: string | null
  readonly mergedAt: string | null
}

export interface BaynWorkflowRun {
  readonly id: number
  readonly workflowPath: string
  readonly repository: string
  readonly event: string
  readonly headBranch: string
  readonly headSha: string
  readonly displayTitle: string
  readonly status: string
  readonly conclusion: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly runAttempt: number
}

export interface BaynWorkflowJob {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly completedAt: string | null
}

export interface TrustedBaynGateRun {
  readonly run: BaynWorkflowRun
  readonly job: BaynWorkflowJob
}

export interface SuccessfulPublishRun {
  readonly id: number
  readonly headSha: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly runAttempt: number
}

export interface MigrationCheckpoint {
  readonly schemaVersion: 'bayn.release-review-baseline.v1'
  readonly repository: string
  readonly startCommitSha: string
  readonly endCommitSha: string
  readonly sourcePullRequestNumber: number
  readonly sourcePullRequestHeadSha: string
  readonly sourcePullRequestMergeCommitSha: string
  readonly sourceGateRunId: number
  readonly sourceGateWorkflowPath: string
  readonly sourceGateName: string
}

export type PublicationHoldCode =
  | 'non-single-commit-main-push'
  | 'last-published-revision-missing'
  | 'last-published-revision-not-ancestor'
  | 'release-range-not-loaded'
  | 'migration-checkpoint-invalid'
  | 'no-associated-source-pr'
  | 'ambiguous-associated-source-prs'
  | 'associated-source-pr-merge-mismatch'
  | 'source-pr-metadata-mismatch'
  | 'bayn-release-gate-missing'
  | 'bayn-release-gate-failed'

export type PublicationEvaluation =
  | {
      readonly status: 'eligible'
      readonly sourceSha: string
      readonly checkedCommitCount: number
      readonly baynAffectingCommitCount: number
      readonly publishedRevision: string
    }
  | {
      readonly status: 'hold'
      readonly code: PublicationHoldCode
      readonly message: string
    }

export interface ReleaseRangeInput {
  readonly mainCommitSha: string
  readonly pushBeforeSha: string | null
  readonly publishedRevision: string
  readonly commits: readonly MainCommitEvidence[]
  readonly migrationCheckpoint: MigrationCheckpoint
  readonly repository: string
}

export interface PullRequestGateInput {
  readonly pullRequest: PullRequestReviewState
  readonly expectedNumber: number
  readonly expectedBaseRefName: string
  readonly expectedHeadSha: string
  readonly nowMs: number
}

export class GitHubReleaseReviewError extends Error {
  readonly code:
    | 'github-api-error'
    | 'github-api-timeout'
    | 'github-api-invalid-response'
    | 'github-api-pagination-limit'
  readonly status: number | null

  constructor(
    code: GitHubReleaseReviewError['code'],
    operation: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(`${code}: ${operation}`, { cause: options.cause })
    this.name = 'GitHubReleaseReviewError'
    this.code = code
    this.status = options.status ?? null
  }
}

const exactBaynReleasePaths = new Set([
  'packages/scripts/src/bayn/update-manifests.ts',
  'packages/scripts/src/bayn/verify-release-review.ts',
  migrationCheckpointPath,
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
  'bun.lock',
  'package.json',
  '.npmrc',
  'bunfig.toml',
  'tsconfig.base.json',
  '.github/workflows/nix-oci-build-common.yml',
])

export const isBaynReleaseAffectingPath = (path: string): boolean =>
  path.startsWith('services/bayn/') ||
  path.startsWith('packages/scripts/src/bayn/') ||
  path.startsWith('patches/') ||
  path.startsWith('.github/actions/setup-nix-toolchain/') ||
  /^\.github\/workflows\/bayn-[^/]+\.yml$/.test(path) ||
  path.endsWith('/package.json') ||
  exactBaynReleasePaths.has(path)

const shortSha = (sha: string): string => sha.slice(0, 12)

const holdReview = (
  code: ReviewGateHoldCode,
  message: string,
): Extract<ReviewGateEvaluation, { readonly status: 'hold' }> => ({
  status: 'hold',
  code,
  message,
})

const holdPublication = (
  code: PublicationHoldCode,
  message: string,
): Extract<PublicationEvaluation, { readonly status: 'hold' }> => ({
  status: 'hold',
  code,
  message,
})

const isTrustedCodexAuthor = (login: string | null): boolean =>
  login === baynCodexReviewer || login === baynCodexBotLogin

const isSubmittedReview = (review: PullRequestReview): boolean =>
  review.submittedAt !== null && (review.state === 'APPROVED' || review.state === 'COMMENTED')

const hasUniqueFinalCommitHistory = (pullRequest: PullRequestReviewState): boolean =>
  pullRequest.commitShas.length > 0 &&
  pullRequest.commitShas.at(-1) === pullRequest.headSha &&
  new Set(pullRequest.commitShas).size === pullRequest.commitShas.length

export const selectExactHeadReviewEvidence = (input: PullRequestGateInput): ReviewGateEvaluation => {
  const { pullRequest } = input
  if (
    pullRequest.number !== input.expectedNumber ||
    pullRequest.baseRefName !== input.expectedBaseRefName ||
    pullRequest.headSha !== input.expectedHeadSha
  ) {
    return holdReview(
      'source-pr-metadata-mismatch',
      `pull request metadata does not bind #${input.expectedNumber} to ${shortSha(input.expectedHeadSha)} on ${input.expectedBaseRefName}`,
    )
  }
  if (!hasUniqueFinalCommitHistory(pullRequest)) {
    return holdReview(
      'source-pr-commit-history-mismatch',
      `pull request #${pullRequest.number} commit history does not uniquely terminate at final head ${shortSha(pullRequest.headSha)}`,
    )
  }

  if (pullRequest.reviews.some((review) => review.state === 'CHANGES_REQUESTED')) {
    return holdReview(
      'exact-head-review-changes-requested',
      `pull request #${pullRequest.number} has a changes-requested review`,
    )
  }

  const exactReviews = pullRequest.reviews.filter(
    (review) => isTrustedCodexAuthor(review.authorLogin) && review.commitSha === pullRequest.headSha,
  )
  if (exactReviews.some((review) => review.state === 'PENDING' || review.submittedAt === null)) {
    return holdReview(
      'exact-head-review-pending',
      `pull request #${pullRequest.number} has a pending trusted Codex review on final head ${shortSha(pullRequest.headSha)}`,
    )
  }

  let reviewSubmittedAt: string | null = null
  if (exactReviews.length > 0) {
    const submittedReviews = exactReviews.filter(isSubmittedReview)
    if (submittedReviews.length === 0) {
      return holdReview(
        'exact-head-review-missing',
        `pull request #${pullRequest.number} has no submitted trusted Codex review on final head ${shortSha(pullRequest.headSha)}`,
      )
    }
    const parsedReviews = submittedReviews.map((review) => ({
      review,
      submittedAtMs: Date.parse(review.submittedAt as string),
    }))
    if (parsedReviews.some(({ submittedAtMs }) => !Number.isFinite(submittedAtMs) || submittedAtMs > input.nowMs)) {
      return holdReview(
        'source-pr-metadata-mismatch',
        `pull request #${pullRequest.number} has an invalid or future exact-head review timestamp`,
      )
    }
    const latestSubmittedAtMs = Math.max(...parsedReviews.map(({ submittedAtMs }) => submittedAtMs))
    const latestReviews = parsedReviews.filter(({ submittedAtMs }) => submittedAtMs === latestSubmittedAtMs)
    if (latestReviews.length !== 1 || latestReviews[0] === undefined) {
      return holdReview(
        'source-pr-metadata-mismatch',
        `pull request #${pullRequest.number} has ambiguous exact-head trusted Codex review evidence`,
      )
    }
    reviewSubmittedAt = latestReviews[0].review.submittedAt
  } else {
    const reaction = pullRequest.reactions[0]
    if (
      pullRequest.reactions.length !== 1 ||
      reaction === undefined ||
      !isTrustedCodexAuthor(reaction.userLogin) ||
      reaction.content !== '+1'
    ) {
      return holdReview(
        'exact-head-review-missing',
        `pull request #${pullRequest.number} has no unique trusted final-head review or +1 attestation`,
      )
    }
    const reactionAtMs = Date.parse(reaction.createdAt)
    const createdAtMs = Date.parse(pullRequest.createdAt)
    const updatedAtMs = Date.parse(pullRequest.updatedAt)
    const headCommittedAtMs =
      pullRequest.headCommittedAt === null ? Number.NaN : Date.parse(pullRequest.headCommittedAt)
    if (
      !Number.isFinite(reactionAtMs) ||
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(updatedAtMs) ||
      !Number.isFinite(headCommittedAtMs) ||
      reactionAtMs <= headCommittedAtMs ||
      reactionAtMs < createdAtMs ||
      reactionAtMs <= updatedAtMs ||
      reactionAtMs > input.nowMs
    ) {
      return holdReview(
        'exact-head-review-missing',
        `pull request #${pullRequest.number} trusted +1 is not strictly after the final head commit and before gate evaluation`,
      )
    }
    reviewSubmittedAt = reaction.createdAt
  }

  if (pullRequest.threads.some((thread) => !thread.isResolved)) {
    const unresolved = pullRequest.threads.filter((thread) => !thread.isResolved)
    const examples = unresolved
      .slice(0, 3)
      .map((thread) => thread.url ?? thread.path ?? thread.id)
      .join(', ')
    return holdReview(
      'active-unresolved-review-threads',
      `pull request #${pullRequest.number} has ${unresolved.length} unresolved review thread(s): ${examples}`,
    )
  }

  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    reviewSubmittedAt: reviewSubmittedAt as string,
  }
}

export const evaluateBaynReleaseReview = selectExactHeadReviewEvidence

const checkpointMatchesConstants = (checkpoint: MigrationCheckpoint): boolean =>
  checkpoint.schemaVersion === 'bayn.release-review-baseline.v1' &&
  checkpoint.repository === 'proompteng/lab' &&
  checkpoint.startCommitSha === migrationCheckpointStartSha &&
  checkpoint.endCommitSha === migrationCheckpointEndSha &&
  checkpoint.sourcePullRequestNumber === migrationCheckpointPullRequestNumber &&
  checkpoint.sourcePullRequestHeadSha === migrationCheckpointPullRequestHeadSha &&
  checkpoint.sourcePullRequestMergeCommitSha === migrationCheckpointEndSha &&
  checkpoint.sourceGateRunId === migrationCheckpointGateRunId &&
  checkpoint.sourceGateWorkflowPath === githubWorkflowPath &&
  checkpoint.sourceGateName === baynReleaseGateName

const isBaselineCovered = (input: ReleaseRangeInput): boolean => {
  if (input.publishedRevision !== input.migrationCheckpoint.startCommitSha) return false
  const checkpointIndex = input.commits.findIndex((commit) => commit.sha === input.migrationCheckpoint.endCommitSha)
  return checkpointIndex >= 0
}

export const selectTrustedBaynGateRun = (input: {
  readonly runs: readonly BaynWorkflowRun[]
  readonly jobsByRunId: ReadonlyMap<number, readonly BaynWorkflowJob[]>
  readonly repository: string
  readonly pullRequestNumber: number
  readonly pullRequestBaseSha: string
  readonly pullRequestHeadSha: string
  readonly pullRequestHeadBranch: string
  readonly mergedAt: string
  readonly requireRunTitle?: boolean
}): TrustedBaynGateRun | undefined => {
  const mergedAtMs = Date.parse(input.mergedAt)
  if (!Number.isFinite(mergedAtMs)) return undefined

  const matchingRuns = input.runs
    .filter(
      (run) =>
        run.workflowPath === githubWorkflowPath &&
        run.repository === input.repository &&
        run.event === 'pull_request' &&
        (input.requireRunTitle === false ||
          run.displayTitle === baynReleaseGateRunTitle(input.pullRequestNumber, input.pullRequestBaseSha)) &&
        run.headSha === input.pullRequestHeadSha &&
        run.headBranch === input.pullRequestHeadBranch &&
        Number.isFinite(Date.parse(run.createdAt)) &&
        Date.parse(run.createdAt) < mergedAtMs,
    )
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id)

  const latestRun = matchingRuns[0]
  if (latestRun === undefined) return undefined
  const gateJob = input.jobsByRunId
    .get(latestRun.id)
    ?.filter((job) => job.name === baynReleaseGateName)
    .toSorted((left, right) => right.id - left.id)[0]
  if (
    latestRun.status !== 'completed' ||
    latestRun.conclusion !== 'success' ||
    gateJob === undefined ||
    gateJob.status !== 'completed' ||
    gateJob.conclusion !== 'success' ||
    gateJob.completedAt === null ||
    !Number.isFinite(Date.parse(gateJob.completedAt)) ||
    Date.parse(gateJob.completedAt) > mergedAtMs
  ) {
    return undefined
  }
  return { run: latestRun, job: gateJob }
}

export const evaluateBaynPublication = (input: ReleaseRangeInput): PublicationEvaluation => {
  if (
    input.pushBeforeSha !== null &&
    (input.commits.at(-1)?.sha !== input.mainCommitSha ||
      input.commits.at(-1)?.parents.length !== 1 ||
      input.commits.at(-1)?.parents[0] !== input.pushBeforeSha)
  ) {
    return holdPublication(
      'non-single-commit-main-push',
      `main push ${shortSha(input.pushBeforeSha)}..${shortSha(input.mainCommitSha)} is not one direct-parent commit`,
    )
  }
  if (
    !checkpointMatchesConstants(input.migrationCheckpoint) ||
    input.repository !== input.migrationCheckpoint.repository
  ) {
    return holdPublication(
      'migration-checkpoint-invalid',
      'migration checkpoint is not the immutable reviewed Bayn baseline',
    )
  }
  if (input.commits.length === 0 || input.commits.at(-1)?.sha !== input.mainCommitSha) {
    return holdPublication('release-range-not-loaded', 'release range does not terminate at current main')
  }
  if (input.publishedRevision === input.mainCommitSha) {
    return {
      status: 'eligible',
      sourceSha: input.mainCommitSha,
      checkedCommitCount: 0,
      baynAffectingCommitCount: 0,
      publishedRevision: input.publishedRevision,
    }
  }

  const baselineCovered = isBaselineCovered(input)
  if (input.publishedRevision === input.migrationCheckpoint.startCommitSha && !baselineCovered) {
    return holdPublication(
      'migration-checkpoint-invalid',
      `unpublished range does not contain immutable migration checkpoint ${shortSha(input.migrationCheckpoint.endCommitSha)}`,
    )
  }

  const checkpointIndex = input.commits.findIndex((commit) => commit.sha === input.migrationCheckpoint.endCommitSha)
  const baynCommits = input.commits.filter((commit) =>
    commit.files.some((file) => isBaynReleaseAffectingPath(file.path)),
  )
  for (const commit of baynCommits) {
    const commitIndex = input.commits.indexOf(commit)
    if (baselineCovered && commitIndex <= checkpointIndex) continue
    if (commit.sourcePullRequest === null) {
      return holdPublication(
        'no-associated-source-pr',
        `Bayn-affecting commit ${shortSha(commit.sha)} has no uniquely associated merged source PR`,
      )
    }
    if (
      commit.sourcePullRequest.repository !== input.repository ||
      commit.sourcePullRequest.baseRefName !== 'main' ||
      commit.sourcePullRequest.mergeCommitSha !== commit.sha ||
      commit.sourcePullRequest.mergedAt === null
    ) {
      return holdPublication(
        'source-pr-metadata-mismatch',
        `source PR metadata does not bind Bayn-affecting commit ${shortSha(commit.sha)} to its merged main PR`,
      )
    }
    if (commit.gateRun === null) {
      return holdPublication(
        'bayn-release-gate-missing',
        `source PR #${commit.sourcePullRequest.number} final head ${shortSha(commit.sourcePullRequest.headSha)} has no successful trusted ${baynReleaseGateName} run before merge`,
      )
    }
  }

  return {
    status: 'eligible',
    sourceSha: input.mainCommitSha,
    checkedCommitCount: input.commits.length,
    baynAffectingCommitCount: baynCommits.length,
    publishedRevision: input.publishedRevision,
  }
}

interface GitHubJsonResponse {
  readonly value: unknown
  readonly headers: Headers
}

interface GitHubRequestOptions {
  readonly url: string
  readonly operation: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
}

const requestGitHubJson = async (options: GitHubRequestOptions): Promise<GitHubJsonResponse> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs)
  try {
    const response = await options.fetchFn(options.url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'User-Agent': 'bayn-release-review-gate',
        'X-GitHub-Api-Version': githubApiVersion,
      },
    })
    if (!response.ok) {
      throw new GitHubReleaseReviewError('github-api-error', options.operation, { status: response.status })
    }
    try {
      return { value: await response.json(), headers: response.headers }
    } catch (error) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', options.operation, { cause: error })
    }
  } catch (error) {
    if (error instanceof GitHubReleaseReviewError) throw error
    if (controller.signal.aborted) {
      throw new GitHubReleaseReviewError('github-api-timeout', options.operation, { cause: error })
    }
    throw new GitHubReleaseReviewError('github-api-error', options.operation, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

const requestGraphql = async (options: {
  readonly query: string
  readonly variables: Record<string, unknown>
  readonly operation: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
}): Promise<Record<string, unknown>> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs)
  try {
    const response = await options.fetchFn(githubGraphqlUrl, {
      method: 'POST',
      body: JSON.stringify({ query: options.query, variables: options.variables }),
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'bayn-release-review-gate',
        'X-GitHub-Api-Version': githubApiVersion,
      },
    })
    if (!response.ok) {
      throw new GitHubReleaseReviewError('github-api-error', options.operation, { status: response.status })
    }
    const payload = expectRecord(await response.json(), options.operation)
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new GitHubReleaseReviewError('github-api-error', options.operation)
    }
    return expectRecord(payload.data, options.operation)
  } catch (error) {
    if (error instanceof GitHubReleaseReviewError) throw error
    if (controller.signal.aborted) {
      throw new GitHubReleaseReviewError('github-api-timeout', options.operation, { cause: error })
    }
    throw new GitHubReleaseReviewError('github-api-error', options.operation, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

const expectRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value as Record<string, unknown>
}

const expectString = (value: unknown, context: string): string => {
  if (typeof value !== 'string') throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return value
}

const expectNullableString = (value: unknown, context: string): string | null => {
  if (value !== null && typeof value !== 'string') {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value
}

const expectNumber = (value: unknown, context: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value
}

const expectSha = (value: unknown, context: string): string => {
  const sha = expectString(value, context)
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return sha
}

const parsePageInfo = (
  value: unknown,
  context: string,
): { readonly hasNextPage: boolean; readonly endCursor: string | null } => {
  const pageInfo = expectRecord(value, context)
  const hasNextPage = pageInfo.hasNextPage
  if (typeof hasNextPage !== 'boolean') throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return { hasNextPage, endCursor: expectNullableString(pageInfo.endCursor, `${context} cursor`) }
}

const pullRequestEvidenceQuery = `
  query BaynPullRequestEvidence(
    $owner: String!
    $name: String!
    $number: Int!
    $commitCursor: String
    $reviewCursor: String
    $threadCursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        createdAt
        updatedAt
        mergedAt
        mergeCommit { oid }
        commits(first: 100, after: $commitCursor) {
          nodes { commit { oid committedDate } }
          pageInfo { hasNextPage endCursor }
        }
        reviews(first: 100, after: $reviewCursor) {
          nodes {
            author { login }
            commit { oid }
            submittedAt
            state
          }
          pageInfo { hasNextPage endCursor }
        }
        reviewThreads(first: 100, after: $threadCursor) {
          nodes { id isResolved isOutdated path }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

export interface PullRequestEvidencePageInfo {
  readonly hasNextPage: boolean
  readonly endCursor: string | null
}

export interface PullRequestEvidencePage {
  readonly metadata: PullRequestReviewState
  readonly commits: readonly string[]
  readonly headCommittedAt: string | null
  readonly reviews: readonly PullRequestReview[]
  readonly threads: readonly PullRequestReviewThread[]
  readonly commitPageInfo: PullRequestEvidencePageInfo
  readonly reviewPageInfo: PullRequestEvidencePageInfo
  readonly threadPageInfo: PullRequestEvidencePageInfo
}

export interface PullRequestEvidenceAccumulator {
  readonly commits: readonly string[]
  readonly headCommittedAt: string | null
  readonly reviews: readonly PullRequestReview[]
  readonly threads: readonly PullRequestReviewThread[]
  readonly commitsComplete: boolean
  readonly reviewsComplete: boolean
  readonly threadsComplete: boolean
}

const mergePullRequestConnection = <T>(
  complete: boolean,
  current: readonly T[],
  incoming: readonly T[],
  hasNextPage: boolean,
): { readonly values: readonly T[]; readonly complete: boolean } => ({
  values: complete ? current : [...current, ...incoming],
  complete: complete || !hasNextPage,
})

export const mergePullRequestEvidencePage = (
  accumulator: PullRequestEvidenceAccumulator,
  page: PullRequestEvidencePage,
): PullRequestEvidenceAccumulator => {
  const commits = mergePullRequestConnection(
    accumulator.commitsComplete,
    accumulator.commits,
    page.commits,
    page.commitPageInfo.hasNextPage,
  )
  const reviews = mergePullRequestConnection(
    accumulator.reviewsComplete,
    accumulator.reviews,
    page.reviews,
    page.reviewPageInfo.hasNextPage,
  )
  const threads = mergePullRequestConnection(
    accumulator.threadsComplete,
    accumulator.threads,
    page.threads,
    page.threadPageInfo.hasNextPage,
  )
  return {
    commits: commits.values,
    headCommittedAt: accumulator.commitsComplete
      ? accumulator.headCommittedAt
      : (page.headCommittedAt ?? accumulator.headCommittedAt),
    reviews: reviews.values,
    threads: threads.values,
    commitsComplete: commits.complete,
    reviewsComplete: reviews.complete,
    threadsComplete: threads.complete,
  }
}

const parsePullRequestPage = (value: Record<string, unknown>, operation: string): PullRequestEvidencePage => {
  const repository = expectRecord(value.repository, operation)
  const pullRequestValue = repository.pullRequest
  if (pullRequestValue === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  const pullRequest = expectRecord(pullRequestValue, operation)
  const mergeCommit = pullRequest.mergeCommit === null ? null : expectRecord(pullRequest.mergeCommit, operation)
  const metadata: PullRequestReviewState = {
    number: expectNumber(pullRequest.number, `${operation} number`),
    baseRefName: expectString(pullRequest.baseRefName, `${operation} base ref`),
    baseSha: expectSha(pullRequest.baseRefOid, `${operation} base SHA`),
    headBranch: expectString(pullRequest.headRefName, `${operation} head branch`),
    headSha: expectSha(pullRequest.headRefOid, `${operation} head SHA`),
    mergeCommitSha: mergeCommit === null ? null : expectSha(mergeCommit.oid, `${operation} merge SHA`),
    createdAt: expectString(pullRequest.createdAt, `${operation} created at`),
    updatedAt: expectString(pullRequest.updatedAt, `${operation} updated at`),
    mergedAt: expectNullableString(pullRequest.mergedAt, `${operation} merged at`),
    headCommittedAt: null,
    reviews: [],
    threads: [],
    commitShas: [],
    reactions: [],
  }

  const parseNodes = (key: 'commits' | 'reviews' | 'reviewThreads'): readonly unknown[] => {
    const connection = expectRecord(pullRequest[key], `${operation} ${key}`)
    if (!Array.isArray(connection.nodes)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    return connection.nodes
  }
  const parsedCommits = parseNodes('commits').map((item, index) => {
    const node = expectRecord(item, `${operation} commit ${index}`)
    const commit = expectRecord(node.commit, `${operation} commit ${index}`)
    return {
      sha: expectSha(commit.oid, `${operation} commit ${index} SHA`),
      committedAt: expectString(commit.committedDate, `${operation} commit ${index} committed at`),
    }
  })
  const commits = parsedCommits.map(({ sha }) => sha)
  const reviews = parseNodes('reviews').map((item, index) => {
    const review = expectRecord(item, `${operation} review ${index}`)
    const author = review.author === null ? null : expectRecord(review.author, `${operation} review ${index} author`)
    const commit = review.commit === null ? null : expectRecord(review.commit, `${operation} review ${index} commit`)
    return {
      authorLogin: author === null ? null : expectString(author.login, `${operation} review ${index} author login`),
      commitSha: commit === null ? null : expectSha(commit.oid, `${operation} review ${index} commit SHA`),
      submittedAt: expectNullableString(review.submittedAt, `${operation} review ${index} submitted at`),
      state: expectString(review.state, `${operation} review ${index} state`),
    }
  })
  const threads = parseNodes('reviewThreads').map((item, index) => {
    const thread = expectRecord(item, `${operation} thread ${index}`)
    const url = thread.url === undefined ? null : expectNullableString(thread.url, `${operation} thread ${index} URL`)
    const path =
      thread.path === undefined ? null : expectNullableString(thread.path, `${operation} thread ${index} path`)
    const isResolved = thread.isResolved
    const isOutdated = thread.isOutdated
    if (typeof isResolved !== 'boolean' || typeof isOutdated !== 'boolean') {
      throw new GitHubReleaseReviewError('github-api-invalid-response', `${operation} thread ${index}`)
    }
    return {
      id: expectString(thread.id, `${operation} thread ${index} ID`),
      isResolved,
      isOutdated,
      path,
      url,
    }
  })
  return {
    metadata,
    commits,
    headCommittedAt: parsedCommits.at(-1)?.committedAt ?? null,
    reviews,
    threads,
    commitPageInfo: parsePageInfo(expectRecord(pullRequest.commits, operation).pageInfo, `${operation} commits page`),
    reviewPageInfo: parsePageInfo(expectRecord(pullRequest.reviews, operation).pageInfo, `${operation} reviews page`),
    threadPageInfo: parsePageInfo(
      expectRecord(pullRequest.reviewThreads, operation).pageInfo,
      `${operation} review threads page`,
    ),
  }
}

const fetchPullRequestReactions = async (
  options: GitHubLoaderOptions,
  number: number,
): Promise<readonly PullRequestReaction[]> => {
  const operation = `read pull request #${number} reactions`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/issues/${number}/reactions?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  if (!Array.isArray(response.value)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  return response.value.map((item, index) => {
    const reaction = expectRecord(item, `${operation} reaction ${index}`)
    const user = reaction.user === null ? null : expectRecord(reaction.user, `${operation} reaction ${index} user`)
    return {
      userLogin: user === null ? null : expectString(user.login, `${operation} reaction ${index} user login`),
      content: expectString(reaction.content, `${operation} reaction ${index} content`),
      createdAt: expectString(reaction.created_at, `${operation} reaction ${index} created at`),
    }
  })
}

const fetchPullRequestReviewState = async (
  options: GitHubLoaderOptions,
  number: number,
): Promise<PullRequestReviewState> => {
  let commitCursor: string | null = null
  let reviewCursor: string | null = null
  let threadCursor: string | null = null
  let metadata: PullRequestReviewState | null = null
  let accumulator: PullRequestEvidenceAccumulator = {
    commits: [],
    headCommittedAt: null,
    reviews: [],
    threads: [],
    commitsComplete: false,
    reviewsComplete: false,
    threadsComplete: false,
  }
  for (let page = 0; page < maximumPages; page += 1) {
    const operation = `read pull request #${number} evidence page ${page + 1}`
    const data = await requestGraphql({
      query: pullRequestEvidenceQuery,
      variables: {
        owner: options.owner,
        name: options.name,
        number,
        commitCursor,
        reviewCursor,
        threadCursor,
      },
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    const pageEvidence = parsePullRequestPage(data, operation)
    if (metadata === null) metadata = pageEvidence.metadata
    else if (
      metadata.number !== pageEvidence.metadata.number ||
      metadata.headSha !== pageEvidence.metadata.headSha ||
      metadata.baseSha !== pageEvidence.metadata.baseSha
    ) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', `${operation} metadata changed`)
    }
    accumulator = mergePullRequestEvidencePage(accumulator, pageEvidence)
    commitCursor = accumulator.commitsComplete ? null : pageEvidence.commitPageInfo.endCursor
    reviewCursor = accumulator.reviewsComplete ? null : pageEvidence.reviewPageInfo.endCursor
    threadCursor = accumulator.threadsComplete ? null : pageEvidence.threadPageInfo.endCursor
    if (
      (pageEvidence.commitPageInfo.hasNextPage && commitCursor === null) ||
      (pageEvidence.reviewPageInfo.hasNextPage && reviewCursor === null) ||
      (pageEvidence.threadPageInfo.hasNextPage && threadCursor === null)
    ) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    }
    if (accumulator.commitsComplete && accumulator.reviewsComplete && accumulator.threadsComplete) {
      if (metadata === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
      const reactions = await fetchPullRequestReactions(options, number)
      return {
        ...metadata,
        headCommittedAt: accumulator.headCommittedAt,
        reviews: accumulator.reviews,
        threads: accumulator.threads,
        commitShas: accumulator.commits,
        reactions,
      }
    }
  }
  throw new GitHubReleaseReviewError('github-api-pagination-limit', `read pull request #${number} evidence`)
}

interface GitHubLoaderOptions {
  readonly owner: string
  readonly name: string
  readonly repository: string
  readonly mainCommitSha: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
  readonly repositoryRoot: string
}

const parseCommitDetail = (
  value: unknown,
  expectedSha: string,
): { readonly sha: string; readonly parents: readonly string[]; readonly files: readonly CommitFileChange[] } => {
  const commit = expectRecord(value, `read commit ${shortSha(expectedSha)}`)
  const sha = expectSha(commit.sha, `read commit ${shortSha(expectedSha)} SHA`)
  if (sha !== expectedSha || !Array.isArray(commit.parents) || !Array.isArray(commit.files)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `read commit ${shortSha(expectedSha)} detail`)
  }
  const parents = commit.parents.map((item, index) => {
    const parent = expectRecord(item, `read commit ${shortSha(expectedSha)} parent ${index}`)
    return expectSha(parent.sha, `read commit ${shortSha(expectedSha)} parent ${index}`)
  })
  const files = commit.files.map((item, index) => {
    const file = expectRecord(item, `read commit ${shortSha(expectedSha)} file ${index}`)
    return {
      path: expectString(file.filename, `read commit ${shortSha(expectedSha)} file ${index} path`),
      previousPath:
        file.previous_filename === undefined || file.previous_filename === null
          ? null
          : expectString(file.previous_filename, `read commit ${shortSha(expectedSha)} file ${index} previous path`),
    }
  })
  return { sha, parents, files }
}

const fetchCommitDetail = async (
  options: GitHubLoaderOptions,
  sha: string,
): Promise<{
  readonly sha: string
  readonly parents: readonly string[]
  readonly files: readonly CommitFileChange[]
}> => {
  const operation = `read commit ${shortSha(sha)} detail`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(sha)}?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', `${operation} files`)
  }
  return parseCommitDetail(response.value, sha)
}

const parseSourcePullRequest = (value: unknown, context: string): SourcePullRequestEvidence => {
  const pullRequest = expectRecord(value, context)
  const base = expectRecord(pullRequest.base, `${context} base`)
  const baseRepository = expectRecord(base.repo, `${context} base repository`)
  const head = expectRecord(pullRequest.head, `${context} head`)
  return {
    number: expectNumber(pullRequest.number, `${context} number`),
    repository: expectString(baseRepository.full_name, `${context} base repository name`),
    baseRefName: expectString(base.ref, `${context} base ref`),
    baseSha: expectSha(base.sha, `${context} base SHA`),
    headBranch: expectString(head.ref, `${context} head branch`),
    headSha: expectSha(head.sha, `${context} head SHA`),
    mergeCommitSha: expectNullableString(pullRequest.merge_commit_sha, `${context} merge commit SHA`),
    mergedAt: expectNullableString(pullRequest.merged_at, `${context} merged at`),
  }
}

const fetchSourcePullRequest = async (
  options: GitHubLoaderOptions,
  number: number,
): Promise<SourcePullRequestEvidence> => {
  const operation = `read source pull request #${number}`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/pulls/${number}`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const pullRequest = expectRecord(response.value, operation)
  const base = expectRecord(pullRequest.base, `${operation} base`)
  if (base.repo === null || base.repo === undefined)
    throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  const parsed = parseSourcePullRequest(pullRequest, operation)
  if (parsed.repository !== options.repository) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `${operation} repository binding`)
  }
  return parsed
}

const fetchAssociatedSourcePullRequests = async (
  options: GitHubLoaderOptions,
  commitSha: string,
): Promise<readonly SourcePullRequestEvidence[]> => {
  const operation = `list pull requests associated with ${shortSha(commitSha)}`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(commitSha)}/pulls?per_page=100`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  if (!Array.isArray(response.value)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  const associated = response.value.map((item, index) => parseSourcePullRequest(item, `${operation} PR ${index}`))
  return associated.filter(
    (pullRequest) =>
      pullRequest.baseRefName === 'main' && pullRequest.mergeCommitSha === commitSha && pullRequest.mergedAt !== null,
  )
}

const parseWorkflowRun = (value: unknown, context: string): BaynWorkflowRun => {
  const run = expectRecord(value, context)
  const repository = run.repository === null ? null : expectRecord(run.repository, `${context} repository`)
  return {
    id: expectNumber(run.id, `${context} ID`),
    workflowPath: expectString(run.path, `${context} workflow path`),
    repository: repository === null ? '' : expectString(repository.full_name, `${context} repository name`),
    event: expectString(run.event, `${context} event`),
    headBranch: expectString(run.head_branch, `${context} head branch`),
    headSha: expectSha(run.head_sha, `${context} head SHA`),
    displayTitle: expectString(run.display_title, `${context} display title`),
    status: expectString(run.status, `${context} status`),
    conclusion: expectNullableString(run.conclusion, `${context} conclusion`),
    createdAt: expectString(run.created_at, `${context} created at`),
    updatedAt: expectString(run.updated_at, `${context} updated at`),
    runAttempt: expectNumber(run.run_attempt, `${context} attempt`),
  }
}

const parseWorkflowRuns = (value: unknown, context: string): readonly BaynWorkflowRun[] => {
  const payload = expectRecord(value, context)
  if (!Array.isArray(payload.workflow_runs)) throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return payload.workflow_runs.map((item, index) => parseWorkflowRun(item, `${context} run ${index}`))
}

const parseWorkflowJob = (value: unknown, context: string): BaynWorkflowJob => {
  const job = expectRecord(value, context)
  return {
    id: expectNumber(job.id, `${context} ID`),
    name: expectString(job.name, `${context} name`),
    status: expectString(job.status, `${context} status`),
    conclusion: expectNullableString(job.conclusion, `${context} conclusion`),
    completedAt: expectNullableString(job.completed_at, `${context} completed at`),
  }
}

const fetchWorkflowRunsForHead = async (
  options: GitHubLoaderOptions,
  headSha: string,
): Promise<readonly BaynWorkflowRun[]> => {
  const operation = `read trusted Bayn CI runs for ${shortSha(headSha)}`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=pull_request&per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  return parseWorkflowRuns(response.value, operation)
}

const fetchWorkflowRun = async (options: GitHubLoaderOptions, runId: number): Promise<BaynWorkflowRun> => {
  const operation = `read trusted Bayn workflow run ${runId}`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/runs/${runId}`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  return parseWorkflowRun(response.value, operation)
}

const fetchWorkflowJobs = async (options: GitHubLoaderOptions, runId: number): Promise<readonly BaynWorkflowJob[]> => {
  const operation = `read jobs for trusted Bayn workflow run ${runId}`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/runs/${runId}/jobs?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  const payload = expectRecord(response.value, operation)
  if (!Array.isArray(payload.jobs)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  return payload.jobs.map((item, index) => parseWorkflowJob(item, `${operation} job ${index}`))
}

const fetchTrustedGateRun = async (
  options: GitHubLoaderOptions,
  pullRequest: SourcePullRequestEvidence,
): Promise<TrustedBaynGateRun | null> => {
  if (pullRequest.mergedAt === null) return null
  const runs = await fetchWorkflowRunsForHead(options, pullRequest.headSha)
  const jobsByRunId = new Map<number, readonly BaynWorkflowJob[]>()
  for (const run of runs) {
    if (
      run.workflowPath === githubWorkflowPath &&
      run.repository === options.repository &&
      run.event === 'pull_request' &&
      run.headSha === pullRequest.headSha &&
      run.headBranch === pullRequest.headBranch
    ) {
      jobsByRunId.set(run.id, await fetchWorkflowJobs(options, run.id))
    }
  }
  return (
    selectTrustedBaynGateRun({
      runs,
      jobsByRunId,
      repository: options.repository,
      pullRequestNumber: pullRequest.number,
      pullRequestBaseSha: pullRequest.baseSha,
      pullRequestHeadSha: pullRequest.headSha,
      pullRequestHeadBranch: pullRequest.headBranch,
      mergedAt: pullRequest.mergedAt,
    }) ?? null
  )
}

const fetchPublishRuns = async (options: GitHubLoaderOptions): Promise<readonly BaynWorkflowRun[]> => {
  const operation = 'read successful Bayn image publication runs'
  const runs: BaynWorkflowRun[] = []
  for (let page = 1; page <= maximumPublishRunPages; page += 1) {
    const response = await requestGitHubJson({
      url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/workflows/${encodeURIComponent(baynBuildWorkflowPath.split('/').at(-1) as string)}/runs?branch=main&event=push&per_page=30&page=${page}`,
      operation: `${operation} page ${page}`,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    runs.push(...parseWorkflowRuns(response.value, `${operation} page ${page}`))
    if (response.headers.get('link')?.includes('rel="next"') !== true) break
    if (page === maximumPublishRunPages) break
  }
  return runs.filter(
    (run) =>
      run.workflowPath === baynBuildWorkflowPath &&
      run.repository === options.repository &&
      run.event === 'push' &&
      run.headBranch === 'main',
  )
}

export const selectLatestSuccessfulPublishRun = (input: {
  readonly runs: readonly BaynWorkflowRun[]
  readonly jobsByRunId: ReadonlyMap<number, readonly BaynWorkflowJob[]>
}): SuccessfulPublishRun | undefined => {
  const candidates = input.runs
    .filter((run) => run.status === 'completed' && run.conclusion === 'success')
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id - left.id)
  for (const run of candidates) {
    const imageJob = input.jobsByRunId
      .get(run.id)
      ?.filter(
        (job) => job.name === baynImagePublishJobName && job.status === 'completed' && job.conclusion === 'success',
      )
      .toSorted((left, right) => right.id - left.id)[0]
    if (imageJob !== undefined) {
      return {
        id: run.id,
        headSha: run.headSha,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        runAttempt: run.runAttempt,
      }
    }
  }
  return undefined
}

const fetchLatestSuccessfulPublishRun = async (
  options: GitHubLoaderOptions,
): Promise<SuccessfulPublishRun | undefined> => {
  const runs = await fetchPublishRuns(options)
  const candidates = runs
    .filter((run) => run.status === 'completed' && run.conclusion === 'success')
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id - left.id)
  for (const run of candidates) {
    const selected = selectLatestSuccessfulPublishRun({
      runs: [run],
      jobsByRunId: new Map([[run.id, await fetchWorkflowJobs(options, run.id)]]),
    })
    if (selected !== undefined) return selected
  }
  return undefined
}

interface ComparisonEvidence {
  readonly baseSha: string
  readonly headSha: string
  readonly mergeBaseSha: string
  readonly aheadBy: number
  readonly commitShas: readonly string[]
  readonly truncated: boolean
}

const fetchComparison = async (
  options: GitHubLoaderOptions,
  baseSha: string,
  headSha: string,
): Promise<ComparisonEvidence> => {
  const operation = `compare published ${shortSha(baseSha)} to current ${shortSha(headSha)}`
  const response = await requestGitHubJson({
    url: `${githubApiBase}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}?per_page=${maximumReleaseRangeCommits}&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const value = expectRecord(response.value, operation)
  const baseCommit = expectRecord(value.base_commit, `${operation} base`)
  const mergeBaseCommit = expectRecord(value.merge_base_commit, `${operation} merge base`)
  const status = expectString(value.status, `${operation} status`)
  if (status !== 'ahead' && status !== 'identical') {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `${operation} status ${status}`)
  }
  if (!Array.isArray(value.commits)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  const commitShas = value.commits.map((item, index) =>
    expectSha(expectRecord(item, `${operation} commit ${index}`).sha, `${operation} commit ${index}`),
  )
  return {
    baseSha: expectSha(baseCommit.sha, `${operation} base SHA`),
    headSha,
    mergeBaseSha: expectSha(mergeBaseCommit.sha, `${operation} merge base SHA`),
    aheadBy: expectNumber(value.ahead_by, `${operation} ahead by`),
    commitShas,
    truncated:
      response.headers.get('link')?.includes('rel="next"') === true || commitShas.length > maximumReleaseRangeCommits,
  }
}

const parseMigrationCheckpoint = (value: unknown): MigrationCheckpoint => {
  const record = expectRecord(value, 'migration checkpoint')
  return {
    schemaVersion: expectString(
      record.schemaVersion,
      'migration checkpoint schema',
    ) as MigrationCheckpoint['schemaVersion'],
    repository: expectString(record.repository, 'migration checkpoint repository'),
    startCommitSha: expectSha(record.startCommitSha, 'migration checkpoint start SHA'),
    endCommitSha: expectSha(record.endCommitSha, 'migration checkpoint end SHA'),
    sourcePullRequestNumber: expectNumber(record.sourcePullRequestNumber, 'migration checkpoint PR number'),
    sourcePullRequestHeadSha: expectSha(record.sourcePullRequestHeadSha, 'migration checkpoint PR head SHA'),
    sourcePullRequestMergeCommitSha: expectSha(
      record.sourcePullRequestMergeCommitSha,
      'migration checkpoint merge SHA',
    ),
    sourceGateRunId: expectNumber(record.sourceGateRunId, 'migration checkpoint gate run ID'),
    sourceGateWorkflowPath: expectString(record.sourceGateWorkflowPath, 'migration checkpoint workflow path'),
    sourceGateName: expectString(record.sourceGateName, 'migration checkpoint gate name'),
  }
}

const loadMigrationCheckpoint = async (repositoryRoot: string): Promise<MigrationCheckpoint> => {
  try {
    const value = JSON.parse(await readFile(resolve(repositoryRoot, migrationCheckpointPath), 'utf8')) as unknown
    return parseMigrationCheckpoint(value)
  } catch (error) {
    if (error instanceof GitHubReleaseReviewError) throw error
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'read migration checkpoint', { cause: error })
  }
}

const buildMainCommitEvidence = async (
  options: GitHubLoaderOptions,
  commitSha: string,
  needsGate: boolean,
): Promise<MainCommitEvidence> => {
  const detail = await fetchCommitDetail(options, commitSha)
  const baynAffecting = detail.files.some((file) => isBaynReleaseAffectingPath(file.path))
  if (!baynAffecting || !needsGate) {
    return { ...detail, sourcePullRequest: null, gateRun: null }
  }
  const associated = await fetchAssociatedSourcePullRequests(options, commitSha)
  if (associated.length !== 1) {
    return {
      ...detail,
      sourcePullRequest: null,
      gateRun: null,
    }
  }
  const sourcePullRequest = await fetchSourcePullRequest(options, associated[0].number)
  const gateRun = await fetchTrustedGateRun(options, sourcePullRequest)
  return { ...detail, sourcePullRequest, gateRun: gateRun ?? null }
}

const loadPublicationInput = async (
  options: GitHubLoaderOptions,
  pushBeforeSha: string | null,
): Promise<ReleaseRangeInput> => {
  const [checkpoint, currentCommit, latestPublished] = await Promise.all([
    loadMigrationCheckpoint(options.repositoryRoot),
    fetchCommitDetail(options, options.mainCommitSha),
    fetchLatestSuccessfulPublishRun(options),
  ])
  if (latestPublished === undefined) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'resolve last successful Bayn image publication')
  }
  const comparison = await fetchComparison(options, latestPublished.headSha, options.mainCommitSha)
  if (
    comparison.baseSha !== latestPublished.headSha ||
    comparison.headSha !== options.mainCommitSha ||
    comparison.mergeBaseSha !== latestPublished.headSha ||
    comparison.truncated
  ) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'load bounded first-parent publication range')
  }
  const checkpointIndex = comparison.commitShas.indexOf(checkpoint.endCommitSha)
  const baselineCovered = latestPublished.headSha === checkpoint.startCommitSha && checkpointIndex >= 0
  const commits = await Promise.all(
    comparison.commitShas.map((sha, index) =>
      buildMainCommitEvidence(options, sha, !(baselineCovered && index <= checkpointIndex)),
    ),
  )
  // Preserve the exact current-push parent binding even when the API compare
  // response has a stale or reordered commit list.
  if (commits.at(-1)?.sha !== currentCommit.sha) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'current publication commit identity')
  }
  return {
    mainCommitSha: options.mainCommitSha,
    pushBeforeSha,
    publishedRevision: latestPublished.headSha,
    commits,
    migrationCheckpoint: checkpoint,
    repository: options.repository,
  }
}

const verifyMigrationCheckpointGate = async (
  options: GitHubLoaderOptions,
  checkpoint: MigrationCheckpoint,
): Promise<boolean> => {
  const sourcePullRequest = await fetchSourcePullRequest(options, checkpoint.sourcePullRequestNumber)
  if (
    sourcePullRequest.headSha !== checkpoint.sourcePullRequestHeadSha ||
    sourcePullRequest.mergeCommitSha !== checkpoint.sourcePullRequestMergeCommitSha ||
    sourcePullRequest.number !== checkpoint.sourcePullRequestNumber ||
    sourcePullRequest.baseRefName !== 'main' ||
    sourcePullRequest.mergedAt === null
  ) {
    return false
  }
  const run = await fetchWorkflowRun(options, checkpoint.sourceGateRunId)
  const jobs = await fetchWorkflowJobs(options, checkpoint.sourceGateRunId)
  return (
    selectTrustedBaynGateRun({
      runs: [run],
      jobsByRunId: new Map([[run.id, jobs]]),
      repository: options.repository,
      pullRequestNumber: sourcePullRequest.number,
      pullRequestBaseSha: sourcePullRequest.baseSha,
      pullRequestHeadSha: sourcePullRequest.headSha,
      pullRequestHeadBranch: sourcePullRequest.headBranch,
      mergedAt: sourcePullRequest.mergedAt,
      requireRunTitle: false,
    }) !== undefined
  )
}

const appendGitHubOutputs = async (
  path: string | null,
  values: Readonly<Record<string, string | number | boolean>>,
): Promise<void> => {
  if (path === null) return
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`)
  await appendFile(path, `${lines.join('\n')}\n`)
}

interface CliOptions {
  readonly mode: 'pull-request' | 'publish'
  readonly repository: string
  readonly repositoryRoot: string
  readonly token: string
  readonly commitSha: string
  readonly pushBeforeSha: string | null
  readonly pullRequestNumber: number | null
  readonly pullRequestBase: string | null
  readonly pullRequestHead: string | null
  readonly githubOutputPath: string | null
  readonly requestTimeoutMs: number
}

const requiredOption = (args: ReadonlyMap<string, string>, name: string): string => {
  const value = args.get(name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const parseCliOptions = (argv: readonly string[]): CliOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined || !argument.startsWith('--')) throw new Error('all arguments must be named options')
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    values.set(argument, value)
    index += 1
  }
  const mode = requiredOption(values, '--mode')
  if (mode !== 'pull-request' && mode !== 'publish') throw new Error('--mode must be pull-request or publish')
  const repository = requiredOption(values, '--repository')
  const commitSha = requiredOption(values, '--commit')
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('--commit must be a full SHA')
  const requestTimeoutMs = Number(values.get('--request-timeout-ms') ?? '10000')
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 250)
    throw new Error('--request-timeout-ms must be at least 250')
  const pullRequestNumberValue = values.get('--pull-request-number')
  const pullRequestNumber = pullRequestNumberValue === undefined ? null : Number(pullRequestNumberValue)
  if (pullRequestNumberValue !== undefined) {
    const parsedPullRequestNumber = Number(pullRequestNumberValue)
    if (!Number.isInteger(parsedPullRequestNumber) || parsedPullRequestNumber < 1) {
      throw new Error('--pull-request-number must be a positive integer')
    }
  }
  return {
    mode,
    repository,
    repositoryRoot: values.get('--repository-root') ?? process.cwd(),
    token: process.env.GITHUB_TOKEN ?? '',
    commitSha,
    pushBeforeSha: values.get('--push-before') ?? null,
    pullRequestNumber,
    pullRequestBase: values.get('--pull-request-base') ?? null,
    pullRequestHead: values.get('--pull-request-head') ?? null,
    githubOutputPath: values.get('--github-output') ?? null,
    requestTimeoutMs,
  }
}

const createLoaderOptions = (options: CliOptions): GitHubLoaderOptions => {
  const [owner, name, extra] = options.repository.split('/')
  if (owner === undefined || name === undefined || extra !== undefined || owner.length === 0 || name.length === 0) {
    throw new Error('--repository must be owner/name')
  }
  if (options.token.length === 0) throw new Error('GITHUB_TOKEN is required')
  return {
    owner,
    name,
    repository: options.repository,
    mainCommitSha: options.commitSha,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: fetch,
    repositoryRoot: options.repositoryRoot,
  }
}

export const run = async (argv = process.argv.slice(2)): Promise<void> => {
  const options = parseCliOptions(argv)
  const loaderOptions = createLoaderOptions(options)
  if (options.mode === 'pull-request') {
    const pullRequestNumber = options.pullRequestNumber
    const pullRequestBase = options.pullRequestBase
    const pullRequestHead = options.pullRequestHead
    if (pullRequestNumber === null || pullRequestBase === null || pullRequestHead === null) {
      throw new Error('pull-request mode requires --pull-request-number, --pull-request-base, and --pull-request-head')
    }
    const pullRequest = await fetchPullRequestReviewState(loaderOptions, pullRequestNumber)
    const result = selectExactHeadReviewEvidence({
      pullRequest,
      expectedNumber: pullRequestNumber,
      expectedBaseRefName: pullRequestBase,
      expectedHeadSha: pullRequestHead,
      nowMs: Date.now(),
    })
    if (result.status === 'hold') {
      await appendGitHubOutputs(options.githubOutputPath, { eligible: false, review_code: result.code })
      console.error(`BAYN_RELEASE_REVIEW_HOLD ${result.code}: ${result.message}`)
      process.exitCode = 1
      return
    }
    await appendGitHubOutputs(options.githubOutputPath, {
      eligible: true,
      pr_number: result.prNumber,
      head_sha: result.headSha,
    })
    console.log(
      `BAYN_RELEASE_GATE_ELIGIBLE pr=#${result.prNumber} head=${shortSha(result.headSha)} review=${result.reviewSubmittedAt}`,
    )
    return
  }

  const checkpoint = await loadMigrationCheckpoint(loaderOptions.repositoryRoot)
  const checkpointIsValid = checkpointMatchesConstants(checkpoint)
  const checkpointGateIsValid = checkpointIsValid
    ? await verifyMigrationCheckpointGate(loaderOptions, checkpoint)
    : false
  if (!checkpointGateIsValid) {
    const result = holdPublication(
      'migration-checkpoint-invalid',
      'immutable reviewed migration checkpoint is missing or invalid',
    )
    await appendGitHubOutputs(options.githubOutputPath, { publish: false, review_code: result.code })
    console.error(`BAYN_RELEASE_REVIEW_HOLD ${result.code}: ${result.message}`)
    process.exitCode = 1
    return
  }
  const input = await loadPublicationInput(loaderOptions, options.pushBeforeSha)
  const result = evaluateBaynPublication(input)
  if (result.status === 'hold') {
    await appendGitHubOutputs(options.githubOutputPath, { publish: false, review_code: result.code })
    console.error(`BAYN_RELEASE_REVIEW_HOLD ${result.code}: ${result.message}`)
    process.exitCode = 1
    return
  }
  await appendGitHubOutputs(options.githubOutputPath, { publish: true, source_sha: result.sourceSha })
  console.log(
    `BAYN_RELEASE_REVIEW_ELIGIBLE published=${shortSha(result.publishedRevision)} current=${shortSha(result.sourceSha)} checked_commits=${result.checkedCommitCount} bayn_affecting_commits=${result.baynAffectingCommitCount}`,
  )
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error
    console.error(`BAYN_RELEASE_REVIEW_HOLD verifier-startup-error: ${name}`)
    process.exitCode = 1
  })
}
