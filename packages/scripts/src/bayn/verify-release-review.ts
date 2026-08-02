import { createHash } from 'node:crypto'
import { appendFile, lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

const githubApiVersion = '2022-11-28'
const githubGraphqlUrl = 'https://api.github.com/graphql'
const maximumGraphqlPages = 20
const minimumExactReviewAgeMs = 30_000
const maximumReleaseRangeCommits = 100
const maximumReleaseReviewJobLogBytes = 1_048_576
const maximumRemediationRecordBytes = 1_048_576
const maximumRemediationRecords = 20
const githubWorkflowFile = 'bayn-build-push.yml'
const remediationDirectory = 'services/bayn/release-review-remediations'

export const baynCodexReviewer = 'chatgpt-codex-connector'
export const baynCodexBotLogin = 'chatgpt-codex-connector[bot]'

export interface AssociatedPullRequest {
  readonly number: number
  readonly baseRefName: string
  readonly headSha: string
  readonly mergeCommitSha: string | null
  readonly mergedAt: string | null
}

export interface PullRequestReview {
  readonly authorLogin: string | null
  readonly commitSha: string | null
  readonly submittedAt: string | null
  readonly state: string
}

export interface PullRequestIssueComment {
  readonly authorLogin: string | null
  readonly body: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PullRequestReaction {
  readonly userLogin: string | null
  readonly content: string
  readonly createdAt: string
}

export interface PullRequestForcePush {
  readonly actorLogin: string | null
  readonly beforeCommitSha: string
  readonly afterCommitSha: string
  readonly createdAt: string
}

export interface PullRequestReviewThreadComment {
  readonly authorLogin: string | null
  readonly authorAssociation: string
  readonly body: string
  readonly createdAt: string
  readonly commitSha: string | null
  readonly reviewCommitSha: string | null
  readonly reviewAuthorLogin: string | null
  readonly reviewSubmittedAt: string | null
  readonly reviewState: string | null
  readonly url: string
}

export interface PullRequestReviewThread {
  readonly id: string
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly path: string | null
  readonly url: string | null
  readonly comments: readonly PullRequestReviewThreadComment[]
}

export interface PullRequestReviewState {
  readonly number: number
  readonly baseRefName: string
  readonly headSha: string
  readonly mergeCommitSha: string | null
  readonly createdAt: string
  readonly mergedAt: string | null
  readonly reviews: readonly PullRequestReview[]
  readonly threads: readonly PullRequestReviewThread[]
  readonly commitShas: readonly string[]
  readonly issueComments: readonly PullRequestIssueComment[]
  readonly reactions: readonly PullRequestReaction[]
  readonly headForcePushes: readonly PullRequestForcePush[]
  readonly headForcePushCount: number
}

export interface BaynReleaseReviewSnapshot {
  readonly mainCommitParents: readonly string[]
  readonly associatedPullRequests: readonly AssociatedPullRequest[]
  readonly pullRequest: PullRequestReviewState | null
}

export interface SuccessfulPublishRun {
  readonly id: number
  readonly runNumber: number
  readonly runAttempt: number
  readonly headSha: string
  readonly headBranch: string
  readonly event: string
  readonly status: string
  readonly conclusion: string
}

export interface BaynBuildWorkflowRun {
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

export interface BaynBuildWorkflowJob {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly completedAt: string | null
}

export interface FailedReviewThreadBlock {
  readonly commitShaPrefix: string
  readonly prNumber: number
}

export interface FailedBaynReleaseReviewRun {
  readonly run: BaynBuildWorkflowRun
  readonly jobs: readonly BaynBuildWorkflowJob[]
  readonly reviewThreadBlock: FailedReviewThreadBlock | null
}

export type LastPublishedRevisionResolution =
  | {
      readonly status: 'resolved'
      readonly revision: string
      readonly runId: number
      readonly runNumber: number
      readonly runAttempt: number
    }
  | { readonly status: 'missing' }
  | { readonly status: 'ambiguous'; readonly runNumber: number; readonly revisions: readonly string[] }

export interface BaynReleaseRangeCommit {
  readonly sha: string
  readonly parents: readonly string[]
  readonly files: readonly string[]
  readonly treeSha?: string
  readonly fileChanges?: readonly BaynReleaseCommitFileChange[]
  readonly reviewSnapshot: BaynReleaseReviewSnapshot | null
}

export interface BaynReleaseCommitFileChange {
  readonly path: string
  readonly previousPath: string | null
  readonly status: string
  readonly blobSha: string | null
}

export interface BaynReleaseReviewRemediationPath {
  readonly path: string
  readonly reviewedBlobSha: string
  readonly finalBlobSha: string
  readonly blockedBlobSha: string
}

export interface BaynReleaseReviewRemediationReconstructionHead {
  readonly headSha: string
  readonly parentSha: string
  readonly treeSha: string
  readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
}

export interface BaynReleaseReviewRemediationCommitPath {
  readonly path: string
  readonly previousPath: string | null
  readonly status: string
  readonly blobSha: string
}

export interface BaynReleaseReviewRemediationForcePush {
  readonly beforeHeadSha: string
  readonly afterHeadSha: string
  readonly actorLogin: string
  readonly createdAt: string
}

export interface BaynReleaseReviewRemediationFeedback {
  readonly reviewedHeadSha: string
  readonly fixedHeadSha: string
  readonly threadId: string
  readonly path: string
  readonly findingUrl: string
  readonly findingBodySha256: string
  readonly fixReplyUrl: string
  readonly fixReplyBodySha256: string
}

export interface BaynReleaseReviewRemediationReconstruction {
  readonly heads: readonly BaynReleaseReviewRemediationReconstructionHead[]
  readonly forcePushes: readonly BaynReleaseReviewRemediationForcePush[]
  readonly feedback: readonly BaynReleaseReviewRemediationFeedback[]
}

export interface BaynReleaseReviewRemediationDescendant {
  readonly mergeCommitSha: string
  readonly sourcePullRequestNumber: number
  readonly finalHeadSha: string
  readonly sourcePullRequestEvidenceSha256: string
  readonly mergeTreeSha: string
  readonly finalHeadTreeSha: string
  readonly affectedPaths: readonly {
    readonly path: string
    readonly mergeBlobSha: string
    readonly finalHeadBlobSha: string
  }[]
}

export interface BaynReleaseReviewRemediationIntroduction {
  readonly mergeCommitSha: string
  readonly sourcePullRequestNumber: number
  readonly finalHeadSha: string
  readonly sourcePullRequestEvidenceSha256: string
  readonly introducedRecordBlobSha: string
}

interface BaynReleaseReviewRemediationLegacyRecord {
  readonly schemaVersion:
    | 'bayn.release-review-remediation.v1'
    | 'bayn.release-review-remediation.v2'
    | 'bayn.release-review-remediation.v3'
  readonly remediationId: string
  readonly blocked: {
    readonly mergeCommitSha: string
    readonly mergeParentSha: string
    readonly mergeTreeSha: string
    readonly sourcePullRequestNumber: number
    readonly reviewedHeadSha: string
    readonly reviewedHeadTreeSha: string
    readonly finalHeadSha: string
    readonly finalHeadTreeSha: string
    readonly sourcePullRequestEvidenceSha256: string
    readonly feedback: {
      readonly threadId: string
      readonly path: string
      readonly findingUrl: string
      readonly findingBodySha256: string
      readonly fixReplyUrl: string
      readonly fixReplyBodySha256: string
    }
    readonly affectedPaths: readonly BaynReleaseReviewRemediationPath[]
    readonly reconstruction?: BaynReleaseReviewRemediationReconstruction
  }
  readonly requiredDescendants: readonly BaynReleaseReviewRemediationDescendant[]
  readonly requiredSuccessors?: readonly BaynReleaseReviewRemediationDescendant[]
  readonly introduction?: BaynReleaseReviewRemediationIntroduction
}

interface BaynReleaseReviewRemediationContinuousSourceRecord {
  readonly schemaVersion: 'bayn.release-review-remediation.v4'
  readonly remediationId: string
  readonly blocked: {
    readonly mergeCommitSha: string
    readonly mergeParentSha: string
    readonly mergeTreeSha: string
    readonly sourcePullRequestNumber: number
    readonly finalHeadSha: string
    readonly finalHeadParentSha: string
    readonly finalHeadTreeSha: string
    readonly sourcePullRequestEvidenceSha256: string
    readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
  }
  readonly requiredDescendants: readonly []
  readonly requiredSuccessors?: undefined
  readonly introduction?: undefined
}

interface BaynReleaseReviewRemediationContinuousSourceIntroduction {
  readonly mergeCommitSha: string
  readonly mergeParentSha: string
  readonly mergeTreeSha: string
  readonly sourcePullRequestNumber: number
  readonly finalHeadSha: string
  readonly finalHeadParentSha: string
  readonly finalHeadTreeSha: string
  readonly sourcePullRequestEvidenceSha256: string
  readonly introducedRecordBlobSha: string
  readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
}

interface BaynReleaseReviewRemediationCompletedContinuousSourceRecord {
  readonly schemaVersion: 'bayn.release-review-remediation.v5'
  readonly remediationId: string
  readonly blocked: BaynReleaseReviewRemediationContinuousSourceRecord['blocked']
  readonly requiredDescendants: readonly []
  readonly requiredSuccessors?: undefined
  readonly introduction: BaynReleaseReviewRemediationContinuousSourceIntroduction
}

interface BaynReleaseReviewRemediationContinuousSourceCompletion {
  readonly mergeCommitSha: string
  readonly mergeParentSha: string
  readonly mergeTreeSha: string
  readonly sourcePullRequestNumber: number
  readonly finalHeadSha: string
  readonly finalHeadParentSha: string
  readonly finalHeadTreeSha: string
  readonly sourcePullRequestEvidenceSha256: string
  readonly completedRecordBlobSha: string
  readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
}

interface BaynReleaseReviewRemediationContinuousSourceSuccessor {
  readonly mergeCommitSha: string
  readonly mergeParentSha: string
  readonly mergeTreeSha: string
  readonly sourcePullRequestNumber: number
  readonly finalHeadSha: string
  readonly finalHeadParentSha: string
  readonly finalHeadTreeSha: string
  readonly sourcePullRequestEvidenceSha256: string
  readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
  readonly protectedPathTransitions: readonly {
    readonly path: string
    readonly beforeBlobSha: string
    readonly afterBlobSha: string
  }[]
}

interface BaynReleaseReviewRemediationReviewedLineage {
  readonly reviewedHeadSha: string
  readonly reviewedHeadParentSha: string
  readonly reviewedHeadTreeSha: string
  readonly reviewSubmittedAt: string
  readonly forcePush: BaynReleaseReviewRemediationForcePush
  readonly feedback: BaynReleaseReviewRemediationFeedback
  readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
}

interface BaynReleaseReviewRemediationSuccessorBoundContinuousSourceRecord {
  readonly schemaVersion: 'bayn.release-review-remediation.v6'
  readonly remediationId: string
  readonly blocked: BaynReleaseReviewRemediationContinuousSourceRecord['blocked']
  readonly requiredDescendants: readonly []
  readonly requiredSuccessors: readonly [BaynReleaseReviewRemediationContinuousSourceSuccessor]
  readonly introduction: BaynReleaseReviewRemediationContinuousSourceIntroduction
  readonly completion: BaynReleaseReviewRemediationContinuousSourceCompletion
}

interface BaynReleaseReviewRemediationSingleStageSuccessorRecord {
  readonly schemaVersion: 'bayn.release-review-remediation.v7'
  readonly remediationId: string
  readonly blocked: BaynReleaseReviewRemediationContinuousSourceRecord['blocked'] & {
    readonly reviewedLineage: BaynReleaseReviewRemediationReviewedLineage
  }
  readonly requiredDescendants: readonly []
  readonly requiredSuccessors: readonly [BaynReleaseReviewRemediationContinuousSourceSuccessor]
}

interface BaynReleaseReviewRemediationCompletedSingleStageSuccessorRecord {
  readonly schemaVersion: 'bayn.release-review-remediation.v8'
  readonly remediationId: string
  readonly blocked: BaynReleaseReviewRemediationSingleStageSuccessorRecord['blocked']
  readonly requiredDescendants: readonly []
  readonly requiredSuccessors: readonly [BaynReleaseReviewRemediationContinuousSourceSuccessor]
  readonly introduction: BaynReleaseReviewRemediationContinuousSourceIntroduction
}

interface BaynReleaseReviewRemediationReviewedCompletionSingleStageSuccessorRecord {
  readonly schemaVersion: 'bayn.release-review-remediation.v9'
  readonly remediationId: string
  readonly blocked: BaynReleaseReviewRemediationSingleStageSuccessorRecord['blocked']
  readonly requiredDescendants: readonly []
  readonly requiredSuccessors: readonly [BaynReleaseReviewRemediationContinuousSourceSuccessor]
  readonly introduction: BaynReleaseReviewRemediationContinuousSourceIntroduction
  readonly completion: BaynReleaseReviewRemediationContinuousSourceCompletion
}

export type BaynReleaseReviewRemediationRecord =
  | BaynReleaseReviewRemediationLegacyRecord
  | BaynReleaseReviewRemediationContinuousSourceRecord
  | BaynReleaseReviewRemediationCompletedContinuousSourceRecord
  | BaynReleaseReviewRemediationSuccessorBoundContinuousSourceRecord
  | BaynReleaseReviewRemediationSingleStageSuccessorRecord
  | BaynReleaseReviewRemediationCompletedSingleStageSuccessorRecord
  | BaynReleaseReviewRemediationReviewedCompletionSingleStageSuccessorRecord

interface RemediationCommitObject {
  readonly sha: string
  readonly parents: readonly string[]
  readonly treeSha: string
  readonly files: readonly string[]
  readonly fileChanges: readonly BaynReleaseCommitFileChange[]
  readonly pathBlobs: readonly { readonly path: string; readonly blobSha: string }[]
}

export interface BaynReleaseReviewRemediationEvidence {
  readonly recordPath: string
  readonly recordBlobSha: string
  readonly record: BaynReleaseReviewRemediationRecord
  readonly referencedCommits: readonly RemediationCommitObject[]
  readonly currentPathBlobs: readonly { readonly path: string; readonly blobSha: string }[]
}

export interface BaynReleaseComparison {
  readonly status: string
  readonly baseSha: string
  readonly headSha: string
  readonly mergeBaseSha: string
  readonly aheadBy: number
  readonly totalCommits: number
  readonly commits: readonly BaynReleaseRangeCommit[]
  readonly truncated: boolean
}

export interface BaynReleaseEligibilitySnapshot {
  readonly currentCommitParents: readonly string[]
  readonly lastPublishedRevision: LastPublishedRevisionResolution
  readonly comparison: BaynReleaseComparison | null
  readonly remediations?: readonly BaynReleaseReviewRemediationEvidence[]
}

export interface BaynReleaseRetrySnapshot extends BaynReleaseEligibilitySnapshot {
  readonly defaultBranchSha: string
  readonly failedReviewRun: FailedBaynReleaseReviewRun | null
  readonly publicationSucceeded: boolean
  readonly retryInProgress: boolean
}

export type BaynReleaseReviewHoldCode =
  | 'last-published-revision-missing'
  | 'last-published-revision-ambiguous'
  | 'last-published-revision-not-ancestor'
  | 'release-range-too-large'
  | 'release-range-metadata-mismatch'
  | 'no-associated-source-pr'
  | 'ambiguous-associated-source-prs'
  | 'non-single-commit-main-push'
  | 'associated-source-pr-merge-mismatch'
  | 'source-pr-metadata-mismatch'
  | 'source-pr-commit-history-mismatch'
  | 'exact-head-review-pending'
  | 'exact-head-review-missing'
  | 'exact-head-review-changes-requested'
  | 'exact-head-review-settling'
  | 'feedback-fix-attestation-missing'
  | 'active-unresolved-review-threads'
  | 'release-review-remediation-invalid'
  | 'release-review-remediation-missing'
  | 'retry-default-branch-mismatch'
  | 'retry-source-pr-force-pushed'
  | 'retry-failed-run-missing'
  | 'retry-failed-run-mismatch'
  | 'retry-attestation-not-delayed'
  | 'retry-delayed-source-ambiguous'
  | 'retry-trigger-mismatch'
  | 'github-api-error'
  | 'github-api-timeout'
  | 'github-api-invalid-response'
  | 'github-api-pagination-limit'
  | 'unexpected-verifier-error'

export interface BaynReleaseReviewEligible {
  readonly status: 'eligible'
  readonly prNumber: number
  readonly headSha: string
  readonly reviewSubmittedAt: string
  readonly eligibleAt: string
}

export interface BaynReleaseEligibilityEligible {
  readonly status: 'eligible'
  readonly lastPublishedRevision: string
  readonly checkedCommitCount: number
  readonly baynAffectingCommitCount: number
  readonly reviewedPullRequests: readonly {
    readonly commitSha: string
    readonly prNumber: number
    readonly headSha: string
    readonly reviewSubmittedAt: string
    readonly eligibleAt: string
  }[]
}

export interface BaynReleaseReviewHold {
  readonly status: 'hold'
  readonly code: BaynReleaseReviewHoldCode
  readonly message: string
  readonly retryable: boolean
}

export type BaynReleaseReviewEvaluation = BaynReleaseReviewEligible | BaynReleaseReviewHold

export type BaynReleaseEligibilityEvaluation = BaynReleaseEligibilityEligible | BaynReleaseReviewHold

export type BaynReleaseRetryTrigger =
  | { readonly type: 'schedule' }
  | { readonly type: 'issue-comment'; readonly prNumber: number; readonly actorLogin: string }
  | {
      readonly type: 'workflow-dispatch'
      readonly sourceCommitSha: string
      readonly prNumber: number
      readonly headSha: string
      readonly failedRunId: number
    }

export type BaynReleaseRetryEvaluation =
  | {
      readonly status: 'dispatch'
      readonly currentMainSha: string
      readonly sourceCommitSha: string
      readonly prNumber: number
      readonly headSha: string
      readonly failedRunId: number
    }
  | {
      readonly status: 'noop'
      readonly code: 'retry-already-published' | 'retry-attestation-not-ready' | 'retry-in-progress'
      readonly message: string
    }
  | BaynReleaseReviewHold

export type BaynReleaseReviewPollResult = BaynReleaseReviewEvaluation & {
  readonly attempts: number
  readonly timedOut: boolean
}

export type BaynReleaseEligibilityPollResult = BaynReleaseEligibilityEvaluation & {
  readonly attempts: number
  readonly timedOut: boolean
}

export class GitHubReleaseReviewError extends Error {
  readonly code:
    | 'github-api-error'
    | 'github-api-timeout'
    | 'github-api-invalid-response'
    | 'github-api-pagination-limit'
  readonly operation: string
  readonly status: number | null

  constructor(
    code: GitHubReleaseReviewError['code'],
    operation: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(`${code} during ${operation}`, { cause: options.cause })
    this.name = 'GitHubReleaseReviewError'
    this.code = code
    this.operation = operation
    this.status = options.status ?? null
  }
}

const shortSha = (sha: string): string => sha.slice(0, 12)

const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex')

const gitBlobSha = (bytes: Uint8Array): string =>
  createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('canonical JSON values must be JSON-compatible')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

const normalizePullRequestReviewEvidence = (pullRequest: PullRequestReviewState) => ({
  number: pullRequest.number,
  baseRefName: pullRequest.baseRefName,
  headSha: pullRequest.headSha,
  mergeCommitSha: pullRequest.mergeCommitSha,
  createdAt: pullRequest.createdAt,
  mergedAt: pullRequest.mergedAt,
  commitShas: [...pullRequest.commitShas],
  reviews: [...pullRequest.reviews]
    .map((review) => ({ ...review }))
    .toSorted((left, right) =>
      `${left.submittedAt ?? ''}/${left.authorLogin ?? ''}/${left.commitSha ?? ''}/${left.state}`.localeCompare(
        `${right.submittedAt ?? ''}/${right.authorLogin ?? ''}/${right.commitSha ?? ''}/${right.state}`,
      ),
    ),
  issueComments: [...pullRequest.issueComments]
    .map((comment) => ({
      authorLogin: comment.authorLogin,
      bodySha256: sha256Text(comment.body),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }))
    .toSorted((left, right) =>
      `${left.createdAt}/${left.authorLogin ?? ''}/${left.bodySha256}`.localeCompare(
        `${right.createdAt}/${right.authorLogin ?? ''}/${right.bodySha256}`,
      ),
    ),
  reactions: [...pullRequest.reactions]
    .map((reaction) => ({ ...reaction }))
    .toSorted((left, right) =>
      `${left.createdAt}/${left.userLogin ?? ''}/${left.content}`.localeCompare(
        `${right.createdAt}/${right.userLogin ?? ''}/${right.content}`,
      ),
    ),
  headForcePushes: [...pullRequest.headForcePushes]
    .map((forcePush) => ({ ...forcePush }))
    .toSorted((left, right) =>
      `${left.createdAt}/${left.beforeCommitSha}/${left.afterCommitSha}/${left.actorLogin ?? ''}`.localeCompare(
        `${right.createdAt}/${right.beforeCommitSha}/${right.afterCommitSha}/${right.actorLogin ?? ''}`,
      ),
    ),
  threads: [...pullRequest.threads]
    .map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      url: thread.url,
      comments: [...thread.comments]
        .map((comment) => ({
          authorLogin: comment.authorLogin,
          authorAssociation: comment.authorAssociation,
          bodySha256: sha256Text(comment.body),
          createdAt: comment.createdAt,
          commitSha: comment.commitSha,
          reviewCommitSha: comment.reviewCommitSha,
          reviewAuthorLogin: comment.reviewAuthorLogin,
          reviewSubmittedAt: comment.reviewSubmittedAt,
          reviewState: comment.reviewState,
          url: comment.url,
        }))
        .toSorted((left, right) => `${left.createdAt}/${left.url}`.localeCompare(`${right.createdAt}/${right.url}`)),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id)),
})

export const pullRequestReviewEvidenceSha256 = (pullRequest: PullRequestReviewState): string =>
  sha256Text(canonicalJson(normalizePullRequestReviewEvidence(pullRequest)))

const strictRecord = (value: unknown, keys: readonly string[], context: string): Record<string, unknown> => {
  const record = expectRecord(value, context)
  const observed = Object.keys(record).toSorted()
  const expected = [...keys].toSorted()
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} must contain exactly: ${expected.join(', ')}`)
  }
  return record
}

const expectSha256 = (value: unknown, context: string): string => {
  const sha = expectString(value, context)
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`${context} must be a lowercase SHA-256`)
  return sha
}

const expectPositiveIntegerRecord = (value: unknown, context: string): number => {
  const parsed = expectInteger(value, context)
  if (parsed < 1) throw new Error(`${context} must be positive`)
  return parsed
}

const parseRemediationPath = (value: unknown, context: string): BaynReleaseReviewRemediationPath => {
  const record = strictRecord(value, ['path', 'reviewedBlobSha', 'finalBlobSha', 'blockedBlobSha'], context)
  return {
    path: expectString(record.path, `${context} path`),
    reviewedBlobSha: expectSha(record.reviewedBlobSha, `${context} reviewed blob SHA`),
    finalBlobSha: expectSha(record.finalBlobSha, `${context} final blob SHA`),
    blockedBlobSha: expectSha(record.blockedBlobSha, `${context} blocked blob SHA`),
  }
}

const parseRemediationCommitPath = (value: unknown, context: string): BaynReleaseReviewRemediationCommitPath => {
  const path = strictRecord(value, ['path', 'previousPath', 'status', 'blobSha'], context)
  return {
    path: expectString(path.path, `${context} path`),
    previousPath: expectNullableString(path.previousPath, `${context} previous path`),
    status: expectString(path.status, `${context} status`),
    blobSha: expectSha(path.blobSha, `${context} blob SHA`),
  }
}

const parseRemediationDescendant = (value: unknown, context: string): BaynReleaseReviewRemediationDescendant => {
  const record = strictRecord(
    value,
    [
      'mergeCommitSha',
      'sourcePullRequestNumber',
      'finalHeadSha',
      'sourcePullRequestEvidenceSha256',
      'mergeTreeSha',
      'finalHeadTreeSha',
      'affectedPaths',
    ],
    context,
  )
  if (!Array.isArray(record.affectedPaths)) throw new Error(`${context} affectedPaths must be an array`)
  const affectedPaths = record.affectedPaths.map((item, index) => {
    const path = strictRecord(item, ['path', 'mergeBlobSha', 'finalHeadBlobSha'], `${context} affected path ${index}`)
    return {
      path: expectString(path.path, `${context} affected path ${index} path`),
      mergeBlobSha: expectSha(path.mergeBlobSha, `${context} affected path ${index} merge blob SHA`),
      finalHeadBlobSha: expectSha(path.finalHeadBlobSha, `${context} affected path ${index} final blob SHA`),
    }
  })
  return {
    mergeCommitSha: expectSha(record.mergeCommitSha, `${context} merge commit SHA`),
    sourcePullRequestNumber: expectPositiveIntegerRecord(
      record.sourcePullRequestNumber,
      `${context} source pull request number`,
    ),
    finalHeadSha: expectSha(record.finalHeadSha, `${context} final head SHA`),
    sourcePullRequestEvidenceSha256: expectSha256(
      record.sourcePullRequestEvidenceSha256,
      `${context} source pull request evidence hash`,
    ),
    mergeTreeSha: expectSha(record.mergeTreeSha, `${context} merge tree SHA`),
    finalHeadTreeSha: expectSha(record.finalHeadTreeSha, `${context} final head tree SHA`),
    affectedPaths,
  }
}

const parseRemediationReconstructionHead = (
  value: unknown,
  context: string,
): BaynReleaseReviewRemediationReconstructionHead => {
  const record = strictRecord(value, ['headSha', 'parentSha', 'treeSha', 'affectedPaths'], context)
  if (!Array.isArray(record.affectedPaths)) throw new Error(`${context} affectedPaths must be an array`)
  return {
    headSha: expectSha(record.headSha, `${context} head SHA`),
    parentSha: expectSha(record.parentSha, `${context} parent SHA`),
    treeSha: expectSha(record.treeSha, `${context} tree SHA`),
    affectedPaths: record.affectedPaths.map((item, index) =>
      parseRemediationCommitPath(item, `${context} affected path ${index}`),
    ),
  }
}

const parseRemediationReconstruction = (value: unknown): BaynReleaseReviewRemediationReconstruction => {
  const record = strictRecord(value, ['heads', 'forcePushes', 'feedback'], 'remediation reconstruction')
  if (!Array.isArray(record.heads)) throw new Error('remediation reconstruction heads must be an array')
  if (!Array.isArray(record.forcePushes)) throw new Error('remediation reconstruction forcePushes must be an array')
  if (!Array.isArray(record.feedback)) throw new Error('remediation reconstruction feedback must be an array')
  return {
    heads: record.heads.map((item, index) =>
      parseRemediationReconstructionHead(item, `remediation reconstruction head ${index}`),
    ),
    forcePushes: record.forcePushes.map((item, index) => {
      const forcePush = strictRecord(
        item,
        ['beforeHeadSha', 'afterHeadSha', 'actorLogin', 'createdAt'],
        `remediation reconstruction force push ${index}`,
      )
      return {
        beforeHeadSha: expectSha(
          forcePush.beforeHeadSha,
          `remediation reconstruction force push ${index} before head SHA`,
        ),
        afterHeadSha: expectSha(
          forcePush.afterHeadSha,
          `remediation reconstruction force push ${index} after head SHA`,
        ),
        actorLogin: expectString(forcePush.actorLogin, `remediation reconstruction force push ${index} actor login`),
        createdAt: expectString(forcePush.createdAt, `remediation reconstruction force push ${index} created at`),
      }
    }),
    feedback: record.feedback.map((item, index) => {
      const feedback = strictRecord(
        item,
        [
          'reviewedHeadSha',
          'fixedHeadSha',
          'threadId',
          'path',
          'findingUrl',
          'findingBodySha256',
          'fixReplyUrl',
          'fixReplyBodySha256',
        ],
        `remediation reconstruction feedback ${index}`,
      )
      return {
        reviewedHeadSha: expectSha(
          feedback.reviewedHeadSha,
          `remediation reconstruction feedback ${index} reviewed head SHA`,
        ),
        fixedHeadSha: expectSha(feedback.fixedHeadSha, `remediation reconstruction feedback ${index} fixed head SHA`),
        threadId: expectString(feedback.threadId, `remediation reconstruction feedback ${index} thread ID`),
        path: expectString(feedback.path, `remediation reconstruction feedback ${index} path`),
        findingUrl: expectString(feedback.findingUrl, `remediation reconstruction feedback ${index} finding URL`),
        findingBodySha256: expectSha256(
          feedback.findingBodySha256,
          `remediation reconstruction feedback ${index} finding body hash`,
        ),
        fixReplyUrl: expectString(feedback.fixReplyUrl, `remediation reconstruction feedback ${index} fix reply URL`),
        fixReplyBodySha256: expectSha256(
          feedback.fixReplyBodySha256,
          `remediation reconstruction feedback ${index} fix reply body hash`,
        ),
      }
    }),
  }
}

const parseReviewedLineage = (value: unknown): BaynReleaseReviewRemediationReviewedLineage => {
  const lineage = strictRecord(
    value,
    [
      'reviewedHeadSha',
      'reviewedHeadParentSha',
      'reviewedHeadTreeSha',
      'reviewSubmittedAt',
      'forcePush',
      'feedback',
      'affectedPaths',
    ],
    'remediation reviewed lineage',
  )
  const forcePush = strictRecord(
    lineage.forcePush,
    ['beforeHeadSha', 'afterHeadSha', 'actorLogin', 'createdAt'],
    'remediation reviewed lineage force push',
  )
  const feedback = strictRecord(
    lineage.feedback,
    [
      'reviewedHeadSha',
      'fixedHeadSha',
      'threadId',
      'path',
      'findingUrl',
      'findingBodySha256',
      'fixReplyUrl',
      'fixReplyBodySha256',
    ],
    'remediation reviewed lineage feedback',
  )
  if (!Array.isArray(lineage.affectedPaths) || lineage.affectedPaths.length === 0) {
    throw new Error('remediation reviewed lineage affectedPaths must be a non-empty array')
  }
  return {
    reviewedHeadSha: expectSha(lineage.reviewedHeadSha, 'remediation reviewed lineage head SHA'),
    reviewedHeadParentSha: expectSha(lineage.reviewedHeadParentSha, 'remediation reviewed lineage parent SHA'),
    reviewedHeadTreeSha: expectSha(lineage.reviewedHeadTreeSha, 'remediation reviewed lineage tree SHA'),
    reviewSubmittedAt: expectString(lineage.reviewSubmittedAt, 'remediation reviewed lineage review submitted at'),
    forcePush: {
      beforeHeadSha: expectSha(forcePush.beforeHeadSha, 'remediation reviewed lineage force push before head SHA'),
      afterHeadSha: expectSha(forcePush.afterHeadSha, 'remediation reviewed lineage force push after head SHA'),
      actorLogin: expectString(forcePush.actorLogin, 'remediation reviewed lineage force push actor login'),
      createdAt: expectString(forcePush.createdAt, 'remediation reviewed lineage force push created at'),
    },
    feedback: {
      reviewedHeadSha: expectSha(feedback.reviewedHeadSha, 'remediation reviewed lineage feedback reviewed head SHA'),
      fixedHeadSha: expectSha(feedback.fixedHeadSha, 'remediation reviewed lineage feedback fixed head SHA'),
      threadId: expectString(feedback.threadId, 'remediation reviewed lineage feedback thread ID'),
      path: expectString(feedback.path, 'remediation reviewed lineage feedback path'),
      findingUrl: expectString(feedback.findingUrl, 'remediation reviewed lineage feedback finding URL'),
      findingBodySha256: expectSha256(
        feedback.findingBodySha256,
        'remediation reviewed lineage feedback finding body hash',
      ),
      fixReplyUrl: expectString(feedback.fixReplyUrl, 'remediation reviewed lineage feedback fix reply URL'),
      fixReplyBodySha256: expectSha256(
        feedback.fixReplyBodySha256,
        'remediation reviewed lineage feedback fix reply body hash',
      ),
    },
    affectedPaths: lineage.affectedPaths.map((item, index) =>
      parseRemediationCommitPath(item, `remediation reviewed lineage affected path ${index}`),
    ),
  }
}

const parseContinuousSourceSuccessor = (value: unknown): BaynReleaseReviewRemediationContinuousSourceSuccessor => {
  const successor = strictRecord(
    value,
    [
      'mergeCommitSha',
      'mergeParentSha',
      'mergeTreeSha',
      'sourcePullRequestNumber',
      'finalHeadSha',
      'finalHeadParentSha',
      'finalHeadTreeSha',
      'sourcePullRequestEvidenceSha256',
      'affectedPaths',
      'protectedPathTransitions',
    ],
    'remediation successor',
  )
  if (!Array.isArray(successor.affectedPaths)) {
    throw new Error('remediation successor affectedPaths must be an array')
  }
  if (!Array.isArray(successor.protectedPathTransitions) || successor.protectedPathTransitions.length === 0) {
    throw new Error('remediation successor protectedPathTransitions must be a non-empty array')
  }
  const protectedPathTransitions = successor.protectedPathTransitions.map((item, index) => {
    const transition = strictRecord(
      item,
      ['path', 'beforeBlobSha', 'afterBlobSha'],
      `remediation successor protected path transition ${index}`,
    )
    return {
      path: expectString(transition.path, `remediation successor protected path transition ${index} path`),
      beforeBlobSha: expectSha(
        transition.beforeBlobSha,
        `remediation successor protected path transition ${index} before blob SHA`,
      ),
      afterBlobSha: expectSha(
        transition.afterBlobSha,
        `remediation successor protected path transition ${index} after blob SHA`,
      ),
    }
  })
  if (new Set(protectedPathTransitions.map((transition) => transition.path)).size !== protectedPathTransitions.length) {
    throw new Error('remediation successor protected path transitions contain duplicate paths')
  }
  return {
    mergeCommitSha: expectSha(successor.mergeCommitSha, 'remediation successor merge commit SHA'),
    mergeParentSha: expectSha(successor.mergeParentSha, 'remediation successor merge parent SHA'),
    mergeTreeSha: expectSha(successor.mergeTreeSha, 'remediation successor merge tree SHA'),
    sourcePullRequestNumber: expectPositiveIntegerRecord(
      successor.sourcePullRequestNumber,
      'remediation successor source pull request number',
    ),
    finalHeadSha: expectSha(successor.finalHeadSha, 'remediation successor final head SHA'),
    finalHeadParentSha: expectSha(successor.finalHeadParentSha, 'remediation successor final head parent SHA'),
    finalHeadTreeSha: expectSha(successor.finalHeadTreeSha, 'remediation successor final head tree SHA'),
    sourcePullRequestEvidenceSha256: expectSha256(
      successor.sourcePullRequestEvidenceSha256,
      'remediation successor source pull request evidence hash',
    ),
    affectedPaths: successor.affectedPaths.map((item, index) =>
      parseRemediationCommitPath(item, `remediation successor affected path ${index}`),
    ),
    protectedPathTransitions,
  }
}

export const parseBaynReleaseReviewRemediationRecord = (value: unknown): BaynReleaseReviewRemediationRecord => {
  const rawRecord = expectRecord(value, 'remediation')
  const rawSchemaVersion = rawRecord.schemaVersion
  if (
    rawSchemaVersion !== 'bayn.release-review-remediation.v1' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v2' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v3' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v4' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v5' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v6' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v7' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v8' &&
    rawSchemaVersion !== 'bayn.release-review-remediation.v9'
  ) {
    throw new Error('remediation schemaVersion is invalid')
  }
  const schemaVersion = rawSchemaVersion
  if (
    schemaVersion === 'bayn.release-review-remediation.v4' ||
    schemaVersion === 'bayn.release-review-remediation.v5' ||
    schemaVersion === 'bayn.release-review-remediation.v6' ||
    schemaVersion === 'bayn.release-review-remediation.v7' ||
    schemaVersion === 'bayn.release-review-remediation.v8' ||
    schemaVersion === 'bayn.release-review-remediation.v9'
  ) {
    const record = strictRecord(
      value,
      schemaVersion === 'bayn.release-review-remediation.v4'
        ? ['schemaVersion', 'remediationId', 'blocked', 'requiredDescendants']
        : schemaVersion === 'bayn.release-review-remediation.v5'
          ? ['schemaVersion', 'remediationId', 'blocked', 'requiredDescendants', 'introduction']
          : schemaVersion === 'bayn.release-review-remediation.v7'
            ? ['schemaVersion', 'remediationId', 'blocked', 'requiredDescendants', 'requiredSuccessors']
            : schemaVersion === 'bayn.release-review-remediation.v8'
              ? [
                  'schemaVersion',
                  'remediationId',
                  'blocked',
                  'requiredDescendants',
                  'requiredSuccessors',
                  'introduction',
                ]
              : [
                  'schemaVersion',
                  'remediationId',
                  'blocked',
                  'requiredDescendants',
                  'requiredSuccessors',
                  'introduction',
                  'completion',
                ],
      'remediation',
    )
    const remediationId = expectString(record.remediationId, 'remediation ID')
    if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(remediationId)) throw new Error('remediation ID is invalid')
    const blocked = strictRecord(
      record.blocked,
      [
        'mergeCommitSha',
        'mergeParentSha',
        'mergeTreeSha',
        'sourcePullRequestNumber',
        'finalHeadSha',
        'finalHeadParentSha',
        'finalHeadTreeSha',
        'sourcePullRequestEvidenceSha256',
        'affectedPaths',
        ...(schemaVersion === 'bayn.release-review-remediation.v7' ||
        schemaVersion === 'bayn.release-review-remediation.v8' ||
        schemaVersion === 'bayn.release-review-remediation.v9'
          ? ['reviewedLineage']
          : []),
      ],
      'remediation blocked source',
    )
    if (!Array.isArray(blocked.affectedPaths)) throw new Error('remediation blocked affectedPaths must be an array')
    if (!Array.isArray(record.requiredDescendants) || record.requiredDescendants.length !== 0) {
      throw new Error('continuous-source remediation requiredDescendants must be an empty array')
    }
    const parsedBlocked = {
      mergeCommitSha: expectSha(blocked.mergeCommitSha, 'remediation blocked merge commit SHA'),
      mergeParentSha: expectSha(blocked.mergeParentSha, 'remediation blocked merge parent SHA'),
      mergeTreeSha: expectSha(blocked.mergeTreeSha, 'remediation blocked merge tree SHA'),
      sourcePullRequestNumber: expectPositiveIntegerRecord(
        blocked.sourcePullRequestNumber,
        'remediation blocked source pull request number',
      ),
      finalHeadSha: expectSha(blocked.finalHeadSha, 'remediation final head SHA'),
      finalHeadParentSha: expectSha(blocked.finalHeadParentSha, 'remediation final head parent SHA'),
      finalHeadTreeSha: expectSha(blocked.finalHeadTreeSha, 'remediation final head tree SHA'),
      sourcePullRequestEvidenceSha256: expectSha256(
        blocked.sourcePullRequestEvidenceSha256,
        'remediation source pull request evidence hash',
      ),
      affectedPaths: blocked.affectedPaths.map((item, index) =>
        parseRemediationCommitPath(item, `remediation blocked affected path ${index}`),
      ),
    }
    if (schemaVersion === 'bayn.release-review-remediation.v4') {
      return { schemaVersion, remediationId, blocked: parsedBlocked, requiredDescendants: [] }
    }
    if (schemaVersion === 'bayn.release-review-remediation.v7') {
      if (!Array.isArray(record.requiredSuccessors) || record.requiredSuccessors.length !== 1) {
        throw new Error('continuous-source remediation requiredSuccessors must contain exactly one successor')
      }
      return {
        schemaVersion,
        remediationId,
        blocked: { ...parsedBlocked, reviewedLineage: parseReviewedLineage(blocked.reviewedLineage) },
        requiredDescendants: [],
        requiredSuccessors: [parseContinuousSourceSuccessor(record.requiredSuccessors[0])],
      }
    }
    const introduction = strictRecord(
      record.introduction,
      [
        'mergeCommitSha',
        'mergeParentSha',
        'mergeTreeSha',
        'sourcePullRequestNumber',
        'finalHeadSha',
        'finalHeadParentSha',
        'finalHeadTreeSha',
        'sourcePullRequestEvidenceSha256',
        'introducedRecordBlobSha',
        'affectedPaths',
      ],
      'remediation introduction',
    )
    if (!Array.isArray(introduction.affectedPaths)) {
      throw new Error('remediation introduction affectedPaths must be an array')
    }
    const parsedIntroduction = {
      mergeCommitSha: expectSha(introduction.mergeCommitSha, 'remediation introduction merge commit SHA'),
      mergeParentSha: expectSha(introduction.mergeParentSha, 'remediation introduction merge parent SHA'),
      mergeTreeSha: expectSha(introduction.mergeTreeSha, 'remediation introduction merge tree SHA'),
      sourcePullRequestNumber: expectPositiveIntegerRecord(
        introduction.sourcePullRequestNumber,
        'remediation introduction source pull request number',
      ),
      finalHeadSha: expectSha(introduction.finalHeadSha, 'remediation introduction final head SHA'),
      finalHeadParentSha: expectSha(introduction.finalHeadParentSha, 'remediation introduction final head parent SHA'),
      finalHeadTreeSha: expectSha(introduction.finalHeadTreeSha, 'remediation introduction final head tree SHA'),
      sourcePullRequestEvidenceSha256: expectSha256(
        introduction.sourcePullRequestEvidenceSha256,
        'remediation introduction source pull request evidence hash',
      ),
      introducedRecordBlobSha: expectSha(
        introduction.introducedRecordBlobSha,
        'remediation introduction record blob SHA',
      ),
      affectedPaths: introduction.affectedPaths.map((item, index) =>
        parseRemediationCommitPath(item, `remediation introduction affected path ${index}`),
      ),
    }
    if (schemaVersion === 'bayn.release-review-remediation.v5') {
      return {
        schemaVersion,
        remediationId,
        blocked: parsedBlocked,
        requiredDescendants: [],
        introduction: parsedIntroduction,
      }
    }
    if (schemaVersion === 'bayn.release-review-remediation.v8') {
      if (!Array.isArray(record.requiredSuccessors) || record.requiredSuccessors.length !== 1) {
        throw new Error('continuous-source remediation requiredSuccessors must contain exactly one successor')
      }
      return {
        schemaVersion,
        remediationId,
        blocked: { ...parsedBlocked, reviewedLineage: parseReviewedLineage(blocked.reviewedLineage) },
        requiredDescendants: [],
        requiredSuccessors: [parseContinuousSourceSuccessor(record.requiredSuccessors[0])],
        introduction: parsedIntroduction,
      }
    }
    const completion = strictRecord(
      record.completion,
      [
        'mergeCommitSha',
        'mergeParentSha',
        'mergeTreeSha',
        'sourcePullRequestNumber',
        'finalHeadSha',
        'finalHeadParentSha',
        'finalHeadTreeSha',
        'sourcePullRequestEvidenceSha256',
        'completedRecordBlobSha',
        'affectedPaths',
      ],
      'remediation completion',
    )
    if (!Array.isArray(completion.affectedPaths)) {
      throw new Error('remediation completion affectedPaths must be an array')
    }
    if (!Array.isArray(record.requiredSuccessors) || record.requiredSuccessors.length !== 1) {
      throw new Error('continuous-source remediation requiredSuccessors must contain exactly one successor')
    }
    const parsedCompletion = {
      mergeCommitSha: expectSha(completion.mergeCommitSha, 'remediation completion merge commit SHA'),
      mergeParentSha: expectSha(completion.mergeParentSha, 'remediation completion merge parent SHA'),
      mergeTreeSha: expectSha(completion.mergeTreeSha, 'remediation completion merge tree SHA'),
      sourcePullRequestNumber: expectPositiveIntegerRecord(
        completion.sourcePullRequestNumber,
        'remediation completion source pull request number',
      ),
      finalHeadSha: expectSha(completion.finalHeadSha, 'remediation completion final head SHA'),
      finalHeadParentSha: expectSha(completion.finalHeadParentSha, 'remediation completion final head parent SHA'),
      finalHeadTreeSha: expectSha(completion.finalHeadTreeSha, 'remediation completion final head tree SHA'),
      sourcePullRequestEvidenceSha256: expectSha256(
        completion.sourcePullRequestEvidenceSha256,
        'remediation completion source pull request evidence hash',
      ),
      completedRecordBlobSha: expectSha(completion.completedRecordBlobSha, 'remediation completion record blob SHA'),
      affectedPaths: completion.affectedPaths.map((item, index) =>
        parseRemediationCommitPath(item, `remediation completion affected path ${index}`),
      ),
    }
    const parsedSuccessor = parseContinuousSourceSuccessor(record.requiredSuccessors[0])
    if (schemaVersion === 'bayn.release-review-remediation.v9') {
      return {
        schemaVersion,
        remediationId,
        blocked: { ...parsedBlocked, reviewedLineage: parseReviewedLineage(blocked.reviewedLineage) },
        requiredDescendants: [],
        requiredSuccessors: [parsedSuccessor],
        introduction: parsedIntroduction,
        completion: parsedCompletion,
      }
    }
    return {
      schemaVersion,
      remediationId,
      blocked: parsedBlocked,
      requiredDescendants: [],
      requiredSuccessors: [parsedSuccessor],
      introduction: parsedIntroduction,
      completion: parsedCompletion,
    }
  }
  const record = strictRecord(
    value,
    schemaVersion === 'bayn.release-review-remediation.v3'
      ? ['schemaVersion', 'remediationId', 'blocked', 'requiredDescendants', 'requiredSuccessors', 'introduction']
      : ['schemaVersion', 'remediationId', 'blocked', 'requiredDescendants'],
    'remediation',
  )
  const remediationId = expectString(record.remediationId, 'remediation ID')
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(remediationId)) throw new Error('remediation ID is invalid')
  const blocked = strictRecord(
    record.blocked,
    schemaVersion === 'bayn.release-review-remediation.v2' || schemaVersion === 'bayn.release-review-remediation.v3'
      ? [
          'mergeCommitSha',
          'mergeParentSha',
          'mergeTreeSha',
          'sourcePullRequestNumber',
          'reviewedHeadSha',
          'reviewedHeadTreeSha',
          'finalHeadSha',
          'finalHeadTreeSha',
          'sourcePullRequestEvidenceSha256',
          'feedback',
          'affectedPaths',
          'reconstruction',
        ]
      : [
          'mergeCommitSha',
          'mergeParentSha',
          'mergeTreeSha',
          'sourcePullRequestNumber',
          'reviewedHeadSha',
          'reviewedHeadTreeSha',
          'finalHeadSha',
          'finalHeadTreeSha',
          'sourcePullRequestEvidenceSha256',
          'feedback',
          'affectedPaths',
        ],
    'remediation blocked source',
  )
  const feedback = strictRecord(
    blocked.feedback,
    ['threadId', 'path', 'findingUrl', 'findingBodySha256', 'fixReplyUrl', 'fixReplyBodySha256'],
    'remediation feedback',
  )
  if (!Array.isArray(blocked.affectedPaths)) throw new Error('remediation blocked affectedPaths must be an array')
  if (!Array.isArray(record.requiredDescendants)) throw new Error('remediation requiredDescendants must be an array')
  if (schemaVersion === 'bayn.release-review-remediation.v3' && !Array.isArray(record.requiredSuccessors)) {
    throw new Error('remediation requiredSuccessors must be an array')
  }
  return {
    schemaVersion,
    remediationId,
    blocked: {
      mergeCommitSha: expectSha(blocked.mergeCommitSha, 'remediation blocked merge commit SHA'),
      mergeParentSha: expectSha(blocked.mergeParentSha, 'remediation blocked merge parent SHA'),
      mergeTreeSha: expectSha(blocked.mergeTreeSha, 'remediation blocked merge tree SHA'),
      sourcePullRequestNumber: expectPositiveIntegerRecord(
        blocked.sourcePullRequestNumber,
        'remediation blocked source pull request number',
      ),
      reviewedHeadSha: expectSha(blocked.reviewedHeadSha, 'remediation reviewed head SHA'),
      reviewedHeadTreeSha: expectSha(blocked.reviewedHeadTreeSha, 'remediation reviewed head tree SHA'),
      finalHeadSha: expectSha(blocked.finalHeadSha, 'remediation final head SHA'),
      finalHeadTreeSha: expectSha(blocked.finalHeadTreeSha, 'remediation final head tree SHA'),
      sourcePullRequestEvidenceSha256: expectSha256(
        blocked.sourcePullRequestEvidenceSha256,
        'remediation source pull request evidence hash',
      ),
      feedback: {
        threadId: expectString(feedback.threadId, 'remediation feedback thread ID'),
        path: expectString(feedback.path, 'remediation feedback path'),
        findingUrl: expectString(feedback.findingUrl, 'remediation feedback finding URL'),
        findingBodySha256: expectSha256(feedback.findingBodySha256, 'remediation feedback finding body hash'),
        fixReplyUrl: expectString(feedback.fixReplyUrl, 'remediation feedback fix reply URL'),
        fixReplyBodySha256: expectSha256(feedback.fixReplyBodySha256, 'remediation feedback fix reply body hash'),
      },
      affectedPaths: blocked.affectedPaths.map((item, index) =>
        parseRemediationPath(item, `remediation blocked affected path ${index}`),
      ),
      ...(schemaVersion === 'bayn.release-review-remediation.v2' ||
      schemaVersion === 'bayn.release-review-remediation.v3'
        ? { reconstruction: parseRemediationReconstruction(blocked.reconstruction) }
        : {}),
    },
    requiredDescendants: record.requiredDescendants.map((item, index) =>
      parseRemediationDescendant(item, `remediation descendant ${index}`),
    ),
    ...(schemaVersion === 'bayn.release-review-remediation.v3'
      ? {
          requiredSuccessors: (record.requiredSuccessors as unknown[]).map((item, index) =>
            parseRemediationDescendant(item, `remediation successor ${index}`),
          ),
        }
      : {}),
    ...(schemaVersion === 'bayn.release-review-remediation.v3'
      ? {
          introduction: (() => {
            const introduction = strictRecord(
              record.introduction,
              [
                'mergeCommitSha',
                'sourcePullRequestNumber',
                'finalHeadSha',
                'sourcePullRequestEvidenceSha256',
                'introducedRecordBlobSha',
              ],
              'remediation introduction',
            )
            return {
              mergeCommitSha: expectSha(introduction.mergeCommitSha, 'remediation introduction merge commit SHA'),
              sourcePullRequestNumber: expectPositiveIntegerRecord(
                introduction.sourcePullRequestNumber,
                'remediation introduction source pull request number',
              ),
              finalHeadSha: expectSha(introduction.finalHeadSha, 'remediation introduction final head SHA'),
              sourcePullRequestEvidenceSha256: expectSha256(
                introduction.sourcePullRequestEvidenceSha256,
                'remediation introduction source pull request evidence hash',
              ),
              introducedRecordBlobSha: expectSha(
                introduction.introducedRecordBlobSha,
                'remediation introduction record blob SHA',
              ),
            }
          })(),
        }
      : {}),
  }
}

const sourcePullCandidates = (
  pullRequests: readonly AssociatedPullRequest[],
  baseRefName: string,
): readonly AssociatedPullRequest[] =>
  pullRequests.filter((pullRequest) => pullRequest.baseRefName === baseRefName && pullRequest.mergedAt !== null)

const hold = (code: BaynReleaseReviewHoldCode, message: string, retryable: boolean): BaynReleaseReviewHold => ({
  status: 'hold',
  code,
  message,
  retryable,
})

export const resolveLastPublishedRevision = (
  runs: readonly SuccessfulPublishRun[],
): LastPublishedRevisionResolution => {
  if (runs.length === 0) return { status: 'missing' }

  const highestRunNumber = Math.max(...runs.map((run) => run.runNumber))
  const latestRuns = runs.filter((run) => run.runNumber === highestRunNumber)
  const revisions = [...new Set(latestRuns.map((run) => run.headSha))].toSorted()
  if (revisions.length !== 1) {
    return { status: 'ambiguous', runNumber: highestRunNumber, revisions }
  }

  const revision = revisions[0]
  if (revision === undefined) return { status: 'missing' }
  const selectedRun = latestRuns
    .filter((run) => run.headSha === revision)
    .toSorted((left, right) => right.runAttempt - left.runAttempt || right.id - left.id)[0]
  if (selectedRun === undefined) return { status: 'missing' }
  return {
    status: 'resolved',
    revision,
    runId: selectedRun.id,
    runNumber: selectedRun.runNumber,
    runAttempt: selectedRun.runAttempt,
  }
}

const exactBaynReleasePaths = new Set([
  'packages/scripts/src/bayn/update-manifests.ts',
  'packages/scripts/src/bayn/verify-release-review.ts',
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
  path.startsWith(`${remediationDirectory}/`) ||
  path.startsWith('patches/') ||
  path.startsWith('.github/actions/setup-nix-toolchain/') ||
  /^\.github\/workflows\/bayn-[^/]+\.yml$/.test(path) ||
  path.endsWith('/package.json') ||
  exactBaynReleasePaths.has(path)

const eligibleReviewStates = new Set(['APPROVED', 'COMMENTED'])
const trustedFeedbackAssociations = new Set(['MEMBER', 'OWNER', 'COLLABORATOR'])
const cleanCodexCommentPattern =
  /^Codex Review: Didn't find any (?:major )?issues\.[^\n]*\n\n\*\*Reviewed commit:\*\* `([0-9a-f]{10,40})`(?:\n|$)/

const cleanCodexCommentHead = (body: string): string | null => cleanCodexCommentPattern.exec(body)?.[1] ?? null

const timestampWithinPullRequest = (
  timestamp: string,
  createdAtMs: number,
  mergedAtMs: number,
  allowAfterMerge: boolean,
): boolean => {
  const timestampMs = Date.parse(timestamp)
  return Number.isFinite(timestampMs) && timestampMs >= createdAtMs && (timestampMs <= mergedAtMs || allowAfterMerge)
}

const hasUniqueFinalCommitHistory = (pullRequest: PullRequestReviewState): boolean =>
  pullRequest.commitShas.length > 0 &&
  pullRequest.commitShas.at(-1) === pullRequest.headSha &&
  new Set(pullRequest.commitShas).size === pullRequest.commitShas.length

const selectLatestForcePush = (
  pullRequest: PullRequestReviewState,
  createdAtMs: number,
  mergedAtMs: number,
): { readonly forcePush: PullRequestForcePush; readonly createdAtMs: number } | null | undefined => {
  if (pullRequest.headForcePushCount !== pullRequest.headForcePushes.length) return undefined
  if (pullRequest.headForcePushes.length === 0) return null

  const forcePushes = pullRequest.headForcePushes
    .map((forcePush) => ({ forcePush, createdAtMs: Date.parse(forcePush.createdAt) }))
    .toSorted((left, right) => left.createdAtMs - right.createdAtMs)
  const forcePushKeys = forcePushes.map(
    ({ forcePush }) =>
      `${forcePush.createdAt}/${forcePush.beforeCommitSha}/${forcePush.afterCommitSha}/${forcePush.actorLogin ?? ''}`,
  )
  if (
    new Set(forcePushKeys).size !== forcePushKeys.length ||
    forcePushes.some(
      ({ forcePush, createdAtMs: forcePushAtMs }, index) =>
        !Number.isFinite(forcePushAtMs) ||
        forcePushAtMs < createdAtMs ||
        forcePushAtMs > mergedAtMs ||
        forcePush.beforeCommitSha === forcePush.afterCommitSha ||
        (index > 0 && forcePushAtMs <= (forcePushes[index - 1]?.createdAtMs ?? Number.NaN)) ||
        (index > 0 && forcePush.beforeCommitSha !== forcePushes[index - 1]?.forcePush.afterCommitSha),
    )
  ) {
    return undefined
  }

  const latest = forcePushes.at(-1)
  if (latest === undefined || latest.forcePush.afterCommitSha !== pullRequest.headSha) return undefined
  return latest
}

const hasOnlySupersededCodexReviews = (
  pullRequest: PullRequestReviewState,
  latestForcePush: { readonly forcePush: PullRequestForcePush; readonly createdAtMs: number } | null,
): boolean => {
  const codexReviews = pullRequest.reviews.filter((review) => review.authorLogin === baynCodexReviewer)
  const exactHeadReviews = codexReviews.filter((review) => review.commitSha === pullRequest.headSha)
  if (
    exactHeadReviews.some(
      (review) => review.submittedAt === null || review.state === 'PENDING' || review.state === 'CHANGES_REQUESTED',
    )
  ) {
    return false
  }
  const priorReviews = codexReviews.filter((review) => review.commitSha !== pullRequest.headSha)
  if (priorReviews.length === 0) return true
  if (latestForcePush === null) return false

  return priorReviews.every((review) => {
    const submittedAtMs = review.submittedAt === null ? Number.NaN : Date.parse(review.submittedAt)
    return (
      review.commitSha !== null &&
      !pullRequest.commitShas.includes(review.commitSha) &&
      Number.isFinite(submittedAtMs) &&
      submittedAtMs < latestForcePush.createdAtMs
    )
  })
}

const selectExactHeadCodexAttestation = (
  pullRequest: PullRequestReviewState,
  createdAtMs: number,
  mergedAtMs: number,
): PullRequestReview | undefined => {
  const comment = pullRequest.issueComments
    .filter((candidate) => {
      if (
        candidate.authorLogin !== baynCodexBotLogin ||
        candidate.createdAt !== candidate.updatedAt ||
        !timestampWithinPullRequest(candidate.createdAt, createdAtMs, mergedAtMs, pullRequest.headForcePushCount === 0)
      ) {
        return false
      }
      const reviewedHead = cleanCodexCommentHead(candidate.body)
      return reviewedHead !== null && pullRequest.headSha.startsWith(reviewedHead)
    })
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  if (comment !== undefined) {
    return {
      authorLogin: baynCodexReviewer,
      commitSha: pullRequest.headSha,
      submittedAt: comment.createdAt,
      state: 'COMMENTED',
    }
  }

  if (!hasUniqueFinalCommitHistory(pullRequest)) return undefined
  const latestForcePush = selectLatestForcePush(pullRequest, createdAtMs, mergedAtMs)
  if (latestForcePush === undefined) return undefined
  if (latestForcePush === null && pullRequest.commitShas.length !== 1) return undefined
  if (!hasOnlySupersededCodexReviews(pullRequest, latestForcePush)) return undefined

  const reactions = pullRequest.reactions.filter(
    (candidate) => candidate.userLogin === baynCodexBotLogin && candidate.content === '+1',
  )
  if (reactions.length !== 1) return undefined
  const reaction = reactions[0]
  if (reaction === undefined) return undefined
  const reactionAtMs = Date.parse(reaction.createdAt)
  if (
    !Number.isFinite(reactionAtMs) ||
    reactionAtMs < createdAtMs ||
    (latestForcePush !== null && reactionAtMs > mergedAtMs) ||
    (latestForcePush !== null && reactionAtMs <= latestForcePush.createdAtMs)
  ) {
    return undefined
  }
  return {
    authorLogin: baynCodexReviewer,
    commitSha: pullRequest.headSha,
    submittedAt: reaction.createdAt,
    state: 'COMMENTED',
  }
}

export const evaluateBaynReleaseReview = (input: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly snapshot: BaynReleaseReviewSnapshot
  readonly nowMs: number
  readonly pushBeforeSha: string | null
}): BaynReleaseReviewEvaluation => {
  if (
    input.pushBeforeSha !== null &&
    (input.snapshot.mainCommitParents.length !== 1 || input.snapshot.mainCommitParents[0] !== input.pushBeforeSha)
  ) {
    const parents =
      input.snapshot.mainCommitParents.length === 0
        ? 'no parents'
        : input.snapshot.mainCommitParents.map(shortSha).join(', ')
    return hold(
      'non-single-commit-main-push',
      `main push ${shortSha(input.pushBeforeSha)}..${shortSha(input.mainCommitSha)} is not one direct-parent commit; observed parent(s): ${parents}`,
      false,
    )
  }

  const sourcePulls = sourcePullCandidates(input.snapshot.associatedPullRequests, input.baseRefName)
  if (sourcePulls.length === 0) {
    return hold(
      'no-associated-source-pr',
      `main commit ${shortSha(input.mainCommitSha)} has no associated merged pull request targeting ${input.baseRefName}`,
      true,
    )
  }
  if (sourcePulls.length > 1) {
    const numbers = sourcePulls.map(({ number }) => `#${number}`).join(', ')
    return hold(
      'ambiguous-associated-source-prs',
      `main commit ${shortSha(input.mainCommitSha)} is associated with multiple merged source pull requests: ${numbers}`,
      false,
    )
  }

  const sourcePull = sourcePulls[0]
  if (sourcePull === undefined) throw new Error('source pull selection was unexpectedly empty')
  if (sourcePull.mergeCommitSha !== input.mainCommitSha) {
    return hold(
      'associated-source-pr-merge-mismatch',
      `associated source PR #${sourcePull.number} does not identify ${shortSha(input.mainCommitSha)} as its merge commit`,
      false,
    )
  }

  const pullRequest = input.snapshot.pullRequest
  if (
    pullRequest === null ||
    pullRequest.number !== sourcePull.number ||
    pullRequest.baseRefName !== input.baseRefName ||
    pullRequest.mergedAt === null ||
    pullRequest.mergeCommitSha !== input.mainCommitSha ||
    pullRequest.headSha !== sourcePull.headSha
  ) {
    return hold(
      'source-pr-metadata-mismatch',
      `source PR #${sourcePull.number} metadata does not exactly bind main commit ${shortSha(input.mainCommitSha)} to final head ${shortSha(sourcePull.headSha)}`,
      false,
    )
  }

  const pullRequestCreatedAtMs = Date.parse(pullRequest.createdAt)
  const pullRequestMergedAtMs = Date.parse(pullRequest.mergedAt)
  if (
    !Number.isFinite(pullRequestCreatedAtMs) ||
    !Number.isFinite(pullRequestMergedAtMs) ||
    pullRequestCreatedAtMs > pullRequestMergedAtMs
  ) {
    return hold(
      'source-pr-metadata-mismatch',
      `source PR #${pullRequest.number} has invalid created/merged timestamps`,
      false,
    )
  }

  const codexReviews = pullRequest.reviews.filter((review) => review.authorLogin === baynCodexReviewer)
  const exactHeadReviews = codexReviews.filter((review) => review.commitSha === pullRequest.headSha)
  const hasPendingExactHeadReview = exactHeadReviews.some(
    (review) => review.submittedAt === null || review.state === 'PENDING',
  )
  if (hasPendingExactHeadReview) {
    return hold(
      'exact-head-review-pending',
      `source PR #${pullRequest.number} has a pending ${baynCodexReviewer} review for final head ${shortSha(pullRequest.headSha)}`,
      true,
    )
  }
  const exactSubmittedReview = exactHeadReviews
    .filter((review) => review.submittedAt !== null)
    .toSorted((left, right) => (right.submittedAt as string).localeCompare(left.submittedAt as string))[0]

  let reviewEvidence =
    exactSubmittedReview ?? selectExactHeadCodexAttestation(pullRequest, pullRequestCreatedAtMs, pullRequestMergedAtMs)
  let feedbackFixCommitShas: readonly string[] = []
  if (reviewEvidence === undefined) {
    if (!hasUniqueFinalCommitHistory(pullRequest)) {
      return hold(
        'source-pr-commit-history-mismatch',
        `source PR #${pullRequest.number} commit history does not uniquely terminate at final head ${shortSha(pullRequest.headSha)}`,
        false,
      )
    }

    const priorSubmittedReviews = codexReviews
      .filter(
        (review) =>
          review.commitSha !== null &&
          review.commitSha !== pullRequest.headSha &&
          review.submittedAt !== null &&
          pullRequest.commitShas.includes(review.commitSha),
      )
      .toSorted((left, right) => (right.submittedAt as string).localeCompare(left.submittedAt as string))
    reviewEvidence = priorSubmittedReviews[0]
    if (reviewEvidence === undefined) {
      const olderReviewedHeads = [
        ...new Set(
          codexReviews
            .filter((review) => review.commitSha !== null && review.submittedAt !== null)
            .map((review) => shortSha(review.commitSha as string)),
        ),
      ]
      const olderReviewDetail =
        olderReviewedHeads.length === 0
          ? 'no submitted Codex review exists'
          : `reviewed head(s) outside the final PR history: ${olderReviewedHeads.join(', ')}`
      return hold(
        'exact-head-review-missing',
        `source PR #${pullRequest.number} final head ${shortSha(pullRequest.headSha)} lacks exact-head or auditable feedback-fix review evidence; ${olderReviewDetail}`,
        true,
      )
    }

    const reviewedCommitIndex = pullRequest.commitShas.indexOf(reviewEvidence.commitSha as string)
    if (reviewedCommitIndex < 0 || reviewedCommitIndex >= pullRequest.commitShas.length - 1) {
      return hold(
        'source-pr-commit-history-mismatch',
        `source PR #${pullRequest.number} reviewed head ${shortSha(reviewEvidence.commitSha as string)} does not precede final head ${shortSha(pullRequest.headSha)}`,
        false,
      )
    }
    feedbackFixCommitShas = pullRequest.commitShas.slice(reviewedCommitIndex + 1)
  }

  if (reviewEvidence.state === 'CHANGES_REQUESTED') {
    return hold(
      'exact-head-review-changes-requested',
      `source PR #${pullRequest.number} latest applicable ${baynCodexReviewer} review requests changes`,
      false,
    )
  }
  if (!eligibleReviewStates.has(reviewEvidence.state)) {
    return hold(
      'exact-head-review-missing',
      `source PR #${pullRequest.number} latest applicable ${baynCodexReviewer} review state ${reviewEvidence.state} is not release-eligible`,
      false,
    )
  }

  const reviewSubmittedAtMs = Date.parse(reviewEvidence.submittedAt as string)
  if (!Number.isFinite(reviewSubmittedAtMs)) {
    return hold(
      'source-pr-metadata-mismatch',
      `source PR #${pullRequest.number} applicable review has an invalid submitted-at timestamp`,
      false,
    )
  }
  const reviewAgeMs = input.nowMs - reviewSubmittedAtMs
  if (reviewAgeMs < minimumExactReviewAgeMs) {
    return hold(
      'exact-head-review-settling',
      `source PR #${pullRequest.number} exact-head review is ${Math.max(0, Math.floor(reviewAgeMs / 1_000))}s old; waiting for review threads to settle`,
      true,
    )
  }
  let eligibleAtMs = reviewSubmittedAtMs + minimumExactReviewAgeMs

  if (feedbackFixCommitShas.length > 0) {
    const reviewedHeadSha = reviewEvidence.commitSha as string
    for (const fixCommitSha of feedbackFixCommitShas) {
      const trustedAttestationTimes = pullRequest.threads.flatMap((thread) => {
        if (!thread.isResolved) return []
        const belongsToReviewedHead = thread.comments.some(
          (comment) =>
            comment.reviewAuthorLogin === baynCodexReviewer &&
            comment.reviewCommitSha === reviewedHeadSha &&
            comment.reviewSubmittedAt === reviewEvidence.submittedAt,
        )
        if (!belongsToReviewedHead) return []
        return thread.comments.flatMap((comment) => {
          if (
            comment.authorLogin === null ||
            comment.authorLogin === baynCodexReviewer ||
            !trustedFeedbackAssociations.has(comment.authorAssociation) ||
            comment.reviewCommitSha !== fixCommitSha ||
            comment.reviewSubmittedAt === null
          ) {
            return []
          }
          const attestationTime = Date.parse(comment.reviewSubmittedAt)
          return Number.isFinite(attestationTime) && attestationTime >= reviewSubmittedAtMs ? [attestationTime] : []
        })
      })
      if (trustedAttestationTimes.length === 0) {
        return hold(
          'feedback-fix-attestation-missing',
          `source PR #${pullRequest.number} final head ${shortSha(pullRequest.headSha)} carries review from ${shortSha(reviewedHeadSha)}, but post-review commit ${shortSha(fixCommitSha)} lacks a trusted member reply on a resolved Codex thread from that review`,
          true,
        )
      }
      eligibleAtMs = Math.max(eligibleAtMs, Math.min(...trustedAttestationTimes))
    }
  }

  const unresolvedThreads = pullRequest.threads.filter((thread) => !thread.isResolved)
  if (unresolvedThreads.length > 0) {
    const examples = unresolvedThreads
      .slice(0, 3)
      .map((thread) => thread.url ?? thread.path ?? thread.id)
      .join(', ')
    return hold(
      'active-unresolved-review-threads',
      `source PR #${pullRequest.number} has ${unresolvedThreads.length} unresolved review thread(s): ${examples}`,
      false,
    )
  }

  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    reviewSubmittedAt: reviewEvidence.submittedAt as string,
    eligibleAt: new Date(eligibleAtMs).toISOString(),
  }
}

const sortedUnique = (values: readonly string[]): readonly string[] => [...new Set(values)].toSorted()

const exactStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = sortedUnique(left)
  const normalizedRight = sortedUnique(right)
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  )
}

const commitFileMap = (
  changes: readonly BaynReleaseCommitFileChange[] | undefined,
): ReadonlyMap<string, BaynReleaseCommitFileChange> | null => {
  if (changes === undefined) return null
  const map = new Map<string, BaynReleaseCommitFileChange>()
  for (const change of changes) {
    if (map.has(change.path)) return null
    map.set(change.path, change)
  }
  return map
}

const pathBlobMap = (
  values: readonly { readonly path: string; readonly blobSha: string }[],
): ReadonlyMap<string, string> | null => {
  const map = new Map<string, string>()
  for (const value of values) {
    if (map.has(value.path)) return null
    map.set(value.path, value.blobSha)
  }
  return map
}

const remediationInvalid = (message: string): BaynReleaseReviewHold =>
  hold('release-review-remediation-invalid', message, false)

interface BoundRemediationReviewIdentity {
  readonly mergeCommitSha: string
  readonly sourcePullRequestNumber: number
  readonly finalHeadSha: string
  readonly sourcePullRequestEvidenceSha256: string
}

interface ExactBoundRemediationReviewEvidence {
  readonly status: 'exact'
  readonly pullRequest: PullRequestReviewState
}

const validateBoundRemediationReviewEvidence = (input: {
  readonly remediationId: string
  readonly commit: BaynReleaseRangeCommit
  readonly identity: BoundRemediationReviewIdentity
}): ExactBoundRemediationReviewEvidence | BaynReleaseReviewHold => {
  const pullRequest = input.commit.reviewSnapshot?.pullRequest
  if (
    pullRequest === null ||
    pullRequest === undefined ||
    input.commit.sha !== input.identity.mergeCommitSha ||
    pullRequest.number !== input.identity.sourcePullRequestNumber ||
    pullRequest.mergeCommitSha !== input.identity.mergeCommitSha ||
    pullRequest.headSha !== input.identity.finalHeadSha ||
    pullRequestReviewEvidenceSha256(pullRequest) !== input.identity.sourcePullRequestEvidenceSha256
  ) {
    return remediationInvalid(`remediation ${input.remediationId} bound source PR evidence is not exact`)
  }
  if (pullRequest.threads.some((thread) => !thread.isResolved)) {
    return remediationInvalid(`remediation ${input.remediationId} bound source PR has an unresolved review thread`)
  }
  const blockingReviews = pullRequest.reviews.filter(
    (review) =>
      review.authorLogin === baynCodexReviewer &&
      (review.submittedAt === null || review.state === 'PENDING' || review.state === 'CHANGES_REQUESTED'),
  )
  if (blockingReviews.length > 0) {
    return remediationInvalid(`remediation ${input.remediationId} bound source PR has a blocking Codex review`)
  }
  return { status: 'exact', pullRequest }
}

const evaluateBoundRemediationReview = (input: {
  readonly remediationId: string
  readonly commit: BaynReleaseRangeCommit
  readonly identity: BoundRemediationReviewIdentity
  readonly normalReview: BaynReleaseReviewEvaluation
  readonly nowMs: number
}): BaynReleaseReviewEligible | BaynReleaseReviewHold => {
  const evidence = validateBoundRemediationReviewEvidence(input)
  if (evidence.status === 'hold') return evidence
  const { pullRequest } = evidence
  if (input.normalReview.status === 'eligible') return input.normalReview
  if (input.normalReview.code !== 'exact-head-review-missing') return input.normalReview
  if (
    pullRequest.commitShas.length !== 1 ||
    pullRequest.commitShas[0] !== pullRequest.headSha ||
    pullRequest.headForcePushCount < 1 ||
    pullRequest.headForcePushCount !== pullRequest.headForcePushes.length
  ) {
    return remediationInvalid(`remediation ${input.remediationId} final source history is not immutable`)
  }
  const createdAtMs = Date.parse(pullRequest.createdAt)
  const mergedAtMs = pullRequest.mergedAt === null ? Number.NaN : Date.parse(pullRequest.mergedAt)
  const forcePushKeys = pullRequest.headForcePushes.map(
    (forcePush) =>
      `${forcePush.createdAt}/${forcePush.beforeCommitSha}/${forcePush.afterCommitSha}/${forcePush.actorLogin ?? ''}`,
  )
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(mergedAtMs) ||
    createdAtMs > mergedAtMs ||
    new Set(forcePushKeys).size !== forcePushKeys.length ||
    pullRequest.headForcePushes.some((forcePush) => {
      const createdAt = Date.parse(forcePush.createdAt)
      return !Number.isFinite(createdAt) || createdAt < createdAtMs || createdAt > mergedAtMs
    })
  ) {
    return remediationInvalid(`remediation ${input.remediationId} force-push evidence is malformed or ambiguous`)
  }
  const latestForcePush = pullRequest.headForcePushes.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0]
  if (latestForcePush === undefined || latestForcePush.afterCommitSha !== pullRequest.headSha) {
    return remediationInvalid(`remediation ${input.remediationId} latest force push does not install the final head`)
  }
  const reactions = pullRequest.reactions.filter(
    (reaction) => reaction.userLogin === baynCodexBotLogin && reaction.content === '+1',
  )
  if (reactions.length !== 1 || reactions[0] === undefined) {
    return remediationInvalid(`remediation ${input.remediationId} exact final-head reaction is missing or ambiguous`)
  }
  const reactionAtMs = Date.parse(reactions[0].createdAt)
  const latestForcePushAtMs = Date.parse(latestForcePush.createdAt)
  if (
    !Number.isFinite(reactionAtMs) ||
    reactionAtMs <= latestForcePushAtMs ||
    reactionAtMs < createdAtMs ||
    reactionAtMs > mergedAtMs
  ) {
    return remediationInvalid(`remediation ${input.remediationId} exact final-head reaction is stale or pre-head`)
  }
  const eligibleAtMs = reactionAtMs + minimumExactReviewAgeMs
  if (input.nowMs < eligibleAtMs) {
    return hold(
      'exact-head-review-settling',
      `remediation ${input.remediationId} exact final-head reaction is still settling`,
      true,
    )
  }
  return {
    status: 'eligible',
    prNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    reviewSubmittedAt: reactions[0].createdAt,
    eligibleAt: new Date(eligibleAtMs).toISOString(),
  }
}

const findReferencedCommit = (
  evidence: BaynReleaseReviewRemediationEvidence,
  sha: string,
): RemediationCommitObject | null => {
  const matches = evidence.referencedCommits.filter((commit) => commit.sha === sha)
  return matches.length === 1 ? (matches[0] ?? null) : null
}

const validateRemediationFeedback = (
  record: BaynReleaseReviewRemediationLegacyRecord,
  pullRequest: PullRequestReviewState,
): BaynReleaseReviewHold | null => {
  if (
    record.schemaVersion === 'bayn.release-review-remediation.v2' ||
    record.schemaVersion === 'bayn.release-review-remediation.v3'
  ) {
    const reconstruction = record.blocked.reconstruction
    if (reconstruction === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} reconstruction is missing`)
    }
    if (pullRequestReviewEvidenceSha256(pullRequest) !== record.blocked.sourcePullRequestEvidenceSha256) {
      return remediationInvalid(
        `remediation ${record.remediationId} source PR #${pullRequest.number} review/reaction/thread evidence changed`,
      )
    }
    if (
      pullRequest.number !== record.blocked.sourcePullRequestNumber ||
      pullRequest.headSha !== record.blocked.finalHeadSha ||
      pullRequest.mergeCommitSha !== record.blocked.mergeCommitSha ||
      pullRequest.headForcePushCount !== reconstruction.forcePushes.length ||
      pullRequest.headForcePushes.length !== reconstruction.forcePushes.length
    ) {
      return remediationInvalid(`remediation ${record.remediationId} source PR metadata is not exact`)
    }
    if (pullRequest.threads.some((thread) => !thread.isResolved)) {
      return remediationInvalid(`remediation ${record.remediationId} source PR contains an unresolved review thread`)
    }
    const blockingReviews = pullRequest.reviews.filter(
      (review) =>
        review.authorLogin === baynCodexReviewer &&
        (review.submittedAt === null || review.state === 'PENDING' || review.state === 'CHANGES_REQUESTED'),
    )
    if (blockingReviews.length > 0) {
      return remediationInvalid(`remediation ${record.remediationId} contains a blocking Codex review`)
    }
    for (let index = 0; index < reconstruction.forcePushes.length; index += 1) {
      const expected = reconstruction.forcePushes[index]
      const observed = pullRequest.headForcePushes[index]
      if (
        expected === undefined ||
        observed === undefined ||
        observed.beforeCommitSha !== expected.beforeHeadSha ||
        observed.afterCommitSha !== expected.afterHeadSha ||
        observed.actorLogin !== expected.actorLogin ||
        observed.createdAt !== expected.createdAt
      ) {
        return remediationInvalid(`remediation ${record.remediationId} force-push transformation ${index} is not exact`)
      }
    }
    const feedbackThreadIds = reconstruction.feedback.map((feedback) => feedback.threadId)
    if (
      new Set(feedbackThreadIds).size !== feedbackThreadIds.length ||
      !exactStringSet(
        pullRequest.threads.map((thread) => thread.id),
        feedbackThreadIds,
      )
    ) {
      return remediationInvalid(`remediation ${record.remediationId} feedback thread set is incomplete`)
    }
    for (const feedback of reconstruction.feedback) {
      const reviewMatches = pullRequest.reviews.filter(
        (review) =>
          review.authorLogin === baynCodexReviewer &&
          review.commitSha === feedback.reviewedHeadSha &&
          review.submittedAt !== null &&
          eligibleReviewStates.has(review.state),
      )
      if (reviewMatches.length !== 1) {
        return remediationInvalid(
          `remediation ${record.remediationId} reviewed evidence for ${shortSha(feedback.reviewedHeadSha)} is incomplete`,
        )
      }
      const thread = pullRequest.threads.find((candidate) => candidate.id === feedback.threadId)
      if (thread === undefined || !thread.isResolved || thread.path !== feedback.path) {
        return remediationInvalid(`remediation ${record.remediationId} feedback thread ${feedback.threadId} is missing`)
      }
      const finding = thread.comments.filter(
        (comment) =>
          comment.url === feedback.findingUrl &&
          sha256Text(comment.body) === feedback.findingBodySha256 &&
          comment.authorLogin === baynCodexReviewer &&
          comment.reviewAuthorLogin === baynCodexReviewer &&
          comment.reviewCommitSha === feedback.reviewedHeadSha,
      )
      const reply = thread.comments.filter(
        (comment) =>
          comment.url === feedback.fixReplyUrl &&
          sha256Text(comment.body) === feedback.fixReplyBodySha256 &&
          comment.authorLogin !== null &&
          comment.authorLogin !== baynCodexReviewer &&
          trustedFeedbackAssociations.has(comment.authorAssociation) &&
          comment.reviewCommitSha === feedback.fixedHeadSha,
      )
      if (finding.length !== 1 || reply.length !== 1) {
        return remediationInvalid(
          `remediation ${record.remediationId} exact feedback/fix evidence for ${feedback.threadId} is missing`,
        )
      }
    }
    const reactions = pullRequest.reactions.filter(
      (reaction) => reaction.userLogin === baynCodexBotLogin && reaction.content === '+1',
    )
    const latestForcePush = reconstruction.forcePushes.at(-1)
    if (
      reactions.length !== 1 ||
      reactions[0] === undefined ||
      latestForcePush === undefined ||
      reactions[0].createdAt <= latestForcePush.createdAt
    ) {
      return remediationInvalid(`remediation ${record.remediationId} exact final-head reaction evidence is missing`)
    }
    return null
  }
  if (pullRequestReviewEvidenceSha256(pullRequest) !== record.blocked.sourcePullRequestEvidenceSha256) {
    return remediationInvalid(
      `remediation ${record.remediationId} source PR #${pullRequest.number} review/reaction/thread evidence changed`,
    )
  }
  if (
    pullRequest.number !== record.blocked.sourcePullRequestNumber ||
    pullRequest.headSha !== record.blocked.finalHeadSha ||
    pullRequest.mergeCommitSha !== record.blocked.mergeCommitSha ||
    pullRequest.headForcePushCount !== 1 ||
    pullRequest.headForcePushes.length !== 1
  ) {
    return remediationInvalid(`remediation ${record.remediationId} source PR metadata is not exact`)
  }
  if (pullRequest.threads.some((thread) => !thread.isResolved)) {
    return remediationInvalid(`remediation ${record.remediationId} source PR contains an unresolved review thread`)
  }
  const forcePush = pullRequest.headForcePushes[0]
  if (
    forcePush === undefined ||
    forcePush.beforeCommitSha !== record.blocked.reviewedHeadSha ||
    forcePush.afterCommitSha !== record.blocked.finalHeadSha
  ) {
    return remediationInvalid(`remediation ${record.remediationId} force-push transformation is not exact`)
  }
  const blockingReviews = pullRequest.reviews.filter(
    (review) =>
      review.authorLogin === baynCodexReviewer &&
      (review.submittedAt === null || review.state === 'PENDING' || review.state === 'CHANGES_REQUESTED'),
  )
  if (blockingReviews.length > 0) {
    return remediationInvalid(`remediation ${record.remediationId} contains a blocking Codex review`)
  }
  const reviewMatches = pullRequest.reviews.filter(
    (review) =>
      review.authorLogin === baynCodexReviewer &&
      review.commitSha === record.blocked.reviewedHeadSha &&
      review.submittedAt !== null &&
      eligibleReviewStates.has(review.state),
  )
  if (reviewMatches.length !== 1) {
    return remediationInvalid(`remediation ${record.remediationId} reviewed ancestor evidence is incomplete`)
  }
  const thread = pullRequest.threads.find((candidate) => candidate.id === record.blocked.feedback.threadId)
  if (
    thread === undefined ||
    !thread.isResolved ||
    !thread.isOutdated ||
    thread.path !== record.blocked.feedback.path
  ) {
    return remediationInvalid(`remediation ${record.remediationId} feedback thread is missing or actionable`)
  }
  const finding = thread.comments.filter(
    (comment) =>
      comment.url === record.blocked.feedback.findingUrl &&
      sha256Text(comment.body) === record.blocked.feedback.findingBodySha256 &&
      comment.authorLogin === baynCodexReviewer &&
      comment.reviewAuthorLogin === baynCodexReviewer &&
      comment.reviewCommitSha === record.blocked.reviewedHeadSha,
  )
  const reply = thread.comments.filter(
    (comment) =>
      comment.url === record.blocked.feedback.fixReplyUrl &&
      sha256Text(comment.body) === record.blocked.feedback.fixReplyBodySha256 &&
      comment.authorLogin !== null &&
      comment.authorLogin !== baynCodexReviewer &&
      trustedFeedbackAssociations.has(comment.authorAssociation) &&
      comment.commitSha === record.blocked.reviewedHeadSha &&
      comment.reviewCommitSha === record.blocked.finalHeadSha,
  )
  if (finding.length !== 1 || reply.length !== 1) {
    return remediationInvalid(`remediation ${record.remediationId} exact feedback/fix reply evidence is missing`)
  }
  const reactions = pullRequest.reactions.filter(
    (reaction) => reaction.userLogin === baynCodexBotLogin && reaction.content === '+1',
  )
  if (reactions.length !== 1 || reactions[0] === undefined || reactions[0].createdAt <= forcePush.createdAt) {
    return remediationInvalid(`remediation ${record.remediationId} exact final-head reaction evidence is missing`)
  }
  return null
}

const validateRemediationCommitPaths = (input: {
  readonly remediationId: string
  readonly mergeCommit: BaynReleaseRangeCommit
  readonly mergeTreeSha: string
  readonly mergePathBlobs: readonly { readonly path: string; readonly blobSha: string }[]
  readonly finalHead: RemediationCommitObject
  readonly finalHeadSha: string
  readonly finalHeadTreeSha: string
  readonly finalHeadPathBlobs: readonly { readonly path: string; readonly blobSha: string }[]
}): BaynReleaseReviewHold | null => {
  if (input.mergeCommit.treeSha !== input.mergeTreeSha || input.finalHead.treeSha !== input.finalHeadTreeSha) {
    return remediationInvalid(`remediation ${input.remediationId} commit tree identity changed`)
  }
  if (input.finalHead.sha !== input.finalHeadSha || input.mergeTreeSha !== input.finalHeadTreeSha) {
    return remediationInvalid(`remediation ${input.remediationId} merge/head tree binding is invalid`)
  }
  if (
    input.mergeCommit.parents.length !== input.finalHead.parents.length ||
    input.mergeCommit.parents.some((parent, index) => parent !== input.finalHead.parents[index])
  ) {
    return remediationInvalid(`remediation ${input.remediationId} merge/head parent binding is invalid`)
  }
  const changes = commitFileMap(input.mergeCommit.fileChanges)
  const finalBlobs = pathBlobMap(input.finalHead.pathBlobs)
  if (changes === null || finalBlobs === null) {
    return remediationInvalid(`remediation ${input.remediationId} path/blob evidence is ambiguous`)
  }
  const expectedPaths = input.mergePathBlobs.map((path) => path.path)
  if (!exactStringSet([...changes.keys()], expectedPaths)) {
    return remediationInvalid(`remediation ${input.remediationId} affected path set changed`)
  }
  if (
    !exactStringSet(
      input.finalHeadPathBlobs.map((path) => path.path),
      expectedPaths,
    )
  ) {
    return remediationInvalid(`remediation ${input.remediationId} final-head path set is incomplete`)
  }
  for (const expected of input.mergePathBlobs) {
    const change = changes.get(expected.path)
    const expectedFinal = input.finalHeadPathBlobs.find((path) => path.path === expected.path)
    if (
      change === undefined ||
      change.blobSha !== expected.blobSha ||
      expectedFinal === undefined ||
      finalBlobs.get(expected.path) !== expectedFinal.blobSha
    ) {
      return remediationInvalid(`remediation ${input.remediationId} blob identity changed at ${expected.path}`)
    }
  }
  return null
}

const validateRemediationReconstructionHead = (input: {
  readonly remediationId: string
  readonly expected: BaynReleaseReviewRemediationReconstructionHead
  readonly observed: RemediationCommitObject
}): BaynReleaseReviewHold | null => {
  const { expected, observed } = input
  if (
    observed.sha !== expected.headSha ||
    observed.parents.length !== 1 ||
    observed.parents[0] !== expected.parentSha ||
    observed.treeSha !== expected.treeSha
  ) {
    return remediationInvalid(
      `remediation ${input.remediationId} reconstructed head ${shortSha(expected.headSha)} identity changed`,
    )
  }
  const changes = commitFileMap(observed.fileChanges)
  const blobs = pathBlobMap(observed.pathBlobs)
  const expectedPaths = expected.affectedPaths.map((path) => path.path)
  if (
    changes === null ||
    blobs === null ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    !exactStringSet([...changes.keys()], expectedPaths) ||
    !exactStringSet([...blobs.keys()], expectedPaths)
  ) {
    return remediationInvalid(
      `remediation ${input.remediationId} reconstructed head ${shortSha(expected.headSha)} path set changed`,
    )
  }
  for (const path of expected.affectedPaths) {
    const change = changes.get(path.path)
    if (
      change === undefined ||
      change.previousPath !== path.previousPath ||
      change.status !== path.status ||
      change.blobSha !== path.blobSha ||
      blobs.get(path.path) !== path.blobSha
    ) {
      return remediationInvalid(
        `remediation ${input.remediationId} reconstructed head ${shortSha(expected.headSha)} blob changed at ${path.path}`,
      )
    }
  }
  return null
}

const validateRemediationDescendantPathsV2 = (input: {
  readonly remediationId: string
  readonly mergeCommit: BaynReleaseRangeCommit
  readonly descendant: BaynReleaseReviewRemediationDescendant
  readonly finalHead: RemediationCommitObject
}): BaynReleaseReviewHold | null => {
  const { descendant, finalHead, mergeCommit } = input
  if (
    mergeCommit.treeSha !== descendant.mergeTreeSha ||
    finalHead.sha !== descendant.finalHeadSha ||
    finalHead.treeSha !== descendant.finalHeadTreeSha ||
    descendant.mergeTreeSha !== descendant.finalHeadTreeSha
  ) {
    return remediationInvalid(`remediation ${input.remediationId} descendant commit tree identity changed`)
  }
  const mergeChanges = commitFileMap(mergeCommit.fileChanges)
  const finalBlobs = pathBlobMap(finalHead.pathBlobs)
  const expectedPaths = descendant.affectedPaths.map((path) => path.path)
  if (
    mergeChanges === null ||
    finalBlobs === null ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    !exactStringSet([...mergeChanges.keys()], expectedPaths) ||
    !exactStringSet([...finalBlobs.keys()], expectedPaths)
  ) {
    return remediationInvalid(`remediation ${input.remediationId} descendant path/blob evidence is incomplete`)
  }
  for (const path of descendant.affectedPaths) {
    if (
      mergeChanges.get(path.path)?.blobSha !== path.mergeBlobSha ||
      finalBlobs.get(path.path) !== path.finalHeadBlobSha ||
      path.mergeBlobSha !== path.finalHeadBlobSha
    ) {
      return remediationInvalid(`remediation ${input.remediationId} descendant blob changed at ${path.path}`)
    }
  }
  return null
}

const validateReleaseReviewRemediationV2 = (input: {
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly blockedCommit: BaynReleaseRangeCommit
  readonly comparison: BaynReleaseComparison
  readonly normalReviews: ReadonlyMap<string, BaynReleaseReviewEvaluation>
  readonly introduction: BaynReleaseRangeCommit
  readonly blockedIndex: number
  readonly nowMs: number
}): BaynReleaseReviewHold | null => {
  const { evidence, blockedCommit, comparison } = input
  const record = evidence.record
  if (
    record.schemaVersion !== 'bayn.release-review-remediation.v2' &&
    record.schemaVersion !== 'bayn.release-review-remediation.v3'
  ) {
    return remediationInvalid(`remediation ${record.remediationId} v2 reconstruction is missing`)
  }
  const reconstruction = record.blocked.reconstruction
  if (reconstruction === undefined) {
    return remediationInvalid(`remediation ${record.remediationId} v2 reconstruction is missing`)
  }
  if (
    reconstruction.heads.length < 2 ||
    reconstruction.forcePushes.length !== reconstruction.heads.length - 1 ||
    new Set(reconstruction.heads.map((head) => head.headSha)).size !== reconstruction.heads.length
  ) {
    return remediationInvalid(`remediation ${record.remediationId} reconstruction chain is malformed`)
  }
  const firstHead = reconstruction.heads[0]
  const finalHeadRecord = reconstruction.heads.at(-1)
  if (
    firstHead === undefined ||
    finalHeadRecord === undefined ||
    firstHead.headSha !== record.blocked.reviewedHeadSha ||
    firstHead.treeSha !== record.blocked.reviewedHeadTreeSha ||
    finalHeadRecord.headSha !== record.blocked.finalHeadSha ||
    finalHeadRecord.treeSha !== record.blocked.finalHeadTreeSha ||
    finalHeadRecord.parentSha !== record.blocked.mergeParentSha ||
    finalHeadRecord.treeSha !== record.blocked.mergeTreeSha
  ) {
    return remediationInvalid(`remediation ${record.remediationId} reconstruction endpoints are invalid`)
  }
  for (let index = 0; index < reconstruction.heads.length; index += 1) {
    const expected = reconstruction.heads[index]
    if (expected === undefined) return remediationInvalid(`remediation ${record.remediationId} head is missing`)
    const observed = findReferencedCommit(evidence, expected.headSha)
    if (observed === null) {
      return remediationInvalid(
        `remediation ${record.remediationId} reconstructed head ${shortSha(expected.headSha)} is missing`,
      )
    }
    const headHold = validateRemediationReconstructionHead({ remediationId: record.remediationId, expected, observed })
    if (headHold !== null) return headHold
    if (index > 0) {
      const previous = reconstruction.heads[index - 1]
      const forcePush = reconstruction.forcePushes[index - 1]
      if (
        previous === undefined ||
        forcePush === undefined ||
        forcePush.beforeHeadSha !== previous.headSha ||
        forcePush.afterHeadSha !== expected.headSha
      ) {
        return remediationInvalid(`remediation ${record.remediationId} reconstruction force-push chain is incomplete`)
      }
    }
  }
  for (const feedback of reconstruction.feedback) {
    const reviewedIndex = reconstruction.heads.findIndex((head) => head.headSha === feedback.reviewedHeadSha)
    const fixedIndex = reconstruction.heads.findIndex((head) => head.headSha === feedback.fixedHeadSha)
    if (reviewedIndex < 0 || fixedIndex <= reviewedIndex) {
      return remediationInvalid(`remediation ${record.remediationId} feedback transformation is not forward-only`)
    }
  }

  const finalHead = findReferencedCommit(evidence, record.blocked.finalHeadSha)
  const finalChanges = finalHead === null ? null : commitFileMap(finalHead.fileChanges)
  const blockedChanges = commitFileMap(blockedCommit.fileChanges)
  const finalPaths = finalHeadRecord.affectedPaths.map((path) => path.path)
  if (
    finalHead === null ||
    finalChanges === null ||
    blockedChanges === null ||
    blockedCommit.treeSha !== finalHead.treeSha ||
    !exactStringSet(blockedCommit.files, finalPaths) ||
    !exactStringSet([...blockedChanges.keys()], finalPaths)
  ) {
    return remediationInvalid(`remediation ${record.remediationId} final head/blocked merge binding changed`)
  }
  for (const path of finalHeadRecord.affectedPaths) {
    if (
      finalChanges.get(path.path)?.blobSha !== path.blobSha ||
      blockedChanges.get(path.path)?.blobSha !== path.blobSha
    ) {
      return remediationInvalid(`remediation ${record.remediationId} blocked merge blob changed at ${path.path}`)
    }
  }

  const expectedCurrentBlobs = new Map(finalHeadRecord.affectedPaths.map((path) => [path.path, path.blobSha] as const))
  let expectedParent = blockedCommit.sha
  let cursor = input.blockedIndex + 1
  const nextBaynCommit = (): BaynReleaseRangeCommit | BaynReleaseReviewHold | null => {
    while (cursor < comparison.commits.length) {
      const commit = comparison.commits[cursor]
      if (commit === undefined || commit.parents.length !== 1 || commit.parents[0] !== expectedParent) {
        return remediationInvalid(`remediation ${record.remediationId} source ancestry is not a direct-parent chain`)
      }
      expectedParent = commit.sha
      cursor += 1
      if (commit.files.some(isBaynReleaseAffectingPath)) return commit
    }
    return null
  }
  for (const descendant of record.requiredDescendants) {
    const next = nextBaynCommit()
    if (next === null || 'status' in next) {
      return next ?? remediationInvalid(`remediation ${record.remediationId} descendant chain is incomplete`)
    }
    const mergeCommit = next
    if (mergeCommit.sha !== descendant.mergeCommitSha) {
      return remediationInvalid(`remediation ${record.remediationId} descendant ancestry is incomplete or downgraded`)
    }
    const normalDescendantReview = input.normalReviews.get(mergeCommit.sha)
    if (normalDescendantReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} descendant exact-head review is missing`)
    }
    if (record.schemaVersion === 'bayn.release-review-remediation.v3') {
      const boundReview = evaluateBoundRemediationReview({
        remediationId: record.remediationId,
        commit: mergeCommit,
        identity: descendant,
        normalReview: normalDescendantReview,
        nowMs: input.nowMs,
      })
      if (boundReview.status === 'hold') return boundReview
    } else if (normalDescendantReview.status !== 'eligible') {
      return normalDescendantReview
    }
    const descendantPull = mergeCommit.reviewSnapshot?.pullRequest
    if (
      descendantPull === null ||
      descendantPull === undefined ||
      descendantPull.number !== descendant.sourcePullRequestNumber ||
      descendantPull.headSha !== descendant.finalHeadSha ||
      descendantPull.mergeCommitSha !== descendant.mergeCommitSha ||
      pullRequestReviewEvidenceSha256(descendantPull) !== descendant.sourcePullRequestEvidenceSha256 ||
      descendantPull.threads.some((thread) => !thread.isResolved)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} descendant review chain is incomplete`)
    }
    const finalDescendantHead = findReferencedCommit(evidence, descendant.finalHeadSha)
    if (finalDescendantHead === null) {
      return remediationInvalid(`remediation ${record.remediationId} descendant head evidence is missing`)
    }
    const pathsHold = validateRemediationDescendantPathsV2({
      remediationId: record.remediationId,
      mergeCommit,
      descendant,
      finalHead: finalDescendantHead,
    })
    if (pathsHold !== null) return pathsHold
    for (const path of descendant.affectedPaths) {
      if (expectedCurrentBlobs.has(path.path)) expectedCurrentBlobs.set(path.path, path.mergeBlobSha)
    }
  }
  const introduction = nextBaynCommit()
  if (introduction === null || 'status' in introduction || introduction.sha !== input.introduction.sha) {
    return 'status' in (introduction ?? {})
      ? (introduction as BaynReleaseReviewHold)
      : remediationInvalid(`remediation ${record.remediationId} is stale or omits a newer source commit`)
  }
  for (const successor of record.requiredSuccessors ?? []) {
    const next = nextBaynCommit()
    if (next === null || 'status' in next) {
      return next ?? remediationInvalid(`remediation ${record.remediationId} successor chain is incomplete`)
    }
    const mergeCommit = next
    if (mergeCommit.sha !== successor.mergeCommitSha) {
      return remediationInvalid(`remediation ${record.remediationId} successor ancestry is incomplete or downgraded`)
    }
    const normalSuccessorReview = input.normalReviews.get(mergeCommit.sha)
    if (normalSuccessorReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} successor exact-head review is missing`)
    }
    const boundReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: mergeCommit,
      identity: successor,
      normalReview: normalSuccessorReview,
      nowMs: input.nowMs,
    })
    if (boundReview.status === 'hold') return boundReview
    const finalSuccessorHead = findReferencedCommit(evidence, successor.finalHeadSha)
    if (finalSuccessorHead === null) {
      return remediationInvalid(`remediation ${record.remediationId} successor head evidence is missing`)
    }
    const pathsHold = validateRemediationDescendantPathsV2({
      remediationId: record.remediationId,
      mergeCommit,
      descendant: successor,
      finalHead: finalSuccessorHead,
    })
    if (pathsHold !== null) return pathsHold
    for (const path of successor.affectedPaths) {
      if (expectedCurrentBlobs.has(path.path)) expectedCurrentBlobs.set(path.path, path.mergeBlobSha)
    }
  }
  const completionCommit =
    record.schemaVersion === 'bayn.release-review-remediation.v3'
      ? comparison.commits.find(
          (commit) =>
            commit.sha !== input.introduction.sha &&
            commit.fileChanges?.some(
              (change) =>
                change.path === evidence.recordPath &&
                change.status === 'modified' &&
                change.blobSha === evidence.recordBlobSha,
            ),
        )
      : undefined
  while (cursor < comparison.commits.length) {
    const commit = comparison.commits[cursor]
    if (commit === undefined || commit.parents.length !== 1 || commit.parents[0] !== expectedParent) {
      return remediationInvalid(`remediation ${record.remediationId} source ancestry is not a direct-parent chain`)
    }
    if (record.schemaVersion !== 'bayn.release-review-remediation.v3') {
      if (commit.files.some(isBaynReleaseAffectingPath)) {
        return remediationInvalid(`remediation ${record.remediationId} omits a newer Bayn source commit`)
      }
    } else {
      if (
        commit.sha !== completionCommit?.sha &&
        commit.fileChanges?.some((change) => change.path === evidence.recordPath)
      ) {
        return remediationInvalid(`remediation ${record.remediationId} receipt changed after completion`)
      }
      if (commit.files.some((path) => expectedCurrentBlobs.has(path))) {
        return remediationInvalid(`remediation ${record.remediationId} protected source changed after completion`)
      }
      if (commit.files.some(isBaynReleaseAffectingPath)) {
        const laterReview = input.normalReviews.get(commit.sha)
        if (laterReview?.status !== 'eligible') {
          return laterReview ?? remediationInvalid(`remediation ${record.remediationId} newer source review is missing`)
        }
      }
    }
    expectedParent = commit.sha
    cursor += 1
  }
  if (expectedParent !== comparison.headSha) {
    return remediationInvalid(`remediation ${record.remediationId} does not reach the current source head`)
  }
  const currentBlobs = pathBlobMap(evidence.currentPathBlobs)
  if (
    currentBlobs === null ||
    !exactStringSet([...currentBlobs.keys()], [...expectedCurrentBlobs.keys()]) ||
    [...expectedCurrentBlobs].some(([path, blobSha]) => currentBlobs.get(path) !== blobSha)
  ) {
    return remediationInvalid(`remediation ${record.remediationId} current source blobs diverged`)
  }
  return null
}

const validateContinuousSourceCommitIdentity = (input: {
  readonly remediationId: string
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly commit: BaynReleaseRangeCommit
  readonly identity: {
    readonly mergeCommitSha: string
    readonly mergeParentSha: string
    readonly mergeTreeSha: string
    readonly finalHeadSha: string
    readonly finalHeadParentSha: string
    readonly finalHeadTreeSha: string
    readonly affectedPaths: readonly BaynReleaseReviewRemediationCommitPath[]
  }
  readonly label: string
}): BaynReleaseReviewHold | null => {
  const finalHead = findReferencedCommit(input.evidence, input.identity.finalHeadSha)
  const mergeChanges = commitFileMap(input.commit.fileChanges)
  const finalChanges = finalHead === null ? null : commitFileMap(finalHead.fileChanges)
  const finalBlobs = finalHead === null ? null : pathBlobMap(finalHead.pathBlobs)
  const expectedPaths = input.identity.affectedPaths.map((path) => path.path)
  if (
    finalHead === null ||
    mergeChanges === null ||
    finalChanges === null ||
    finalBlobs === null ||
    input.commit.sha !== input.identity.mergeCommitSha ||
    input.commit.parents.length !== 1 ||
    input.commit.parents[0] !== input.identity.mergeParentSha ||
    input.commit.treeSha !== input.identity.mergeTreeSha ||
    finalHead.sha !== input.identity.finalHeadSha ||
    finalHead.parents.length !== 1 ||
    finalHead.parents[0] !== input.identity.finalHeadParentSha ||
    input.identity.finalHeadParentSha !== input.identity.mergeParentSha ||
    finalHead.treeSha !== input.identity.finalHeadTreeSha ||
    input.identity.finalHeadTreeSha !== input.identity.mergeTreeSha ||
    input.commit.treeSha !== finalHead.treeSha
  ) {
    return remediationInvalid(`remediation ${input.remediationId} ${input.label} source identity is not exact`)
  }
  if (
    !exactStringSet(expectedPaths, input.commit.files) ||
    !exactStringSet(expectedPaths, finalHead.files) ||
    !exactStringSet(expectedPaths, [...mergeChanges.keys()]) ||
    !exactStringSet(expectedPaths, [...finalChanges.keys()]) ||
    !exactStringSet(expectedPaths, [...finalBlobs.keys()])
  ) {
    return remediationInvalid(`remediation ${input.remediationId} ${input.label} path set is incomplete`)
  }
  for (const expected of input.identity.affectedPaths) {
    const mergeChange = mergeChanges.get(expected.path)
    const finalChange = finalChanges.get(expected.path)
    if (
      mergeChange === undefined ||
      finalChange === undefined ||
      mergeChange.previousPath !== expected.previousPath ||
      finalChange.previousPath !== expected.previousPath ||
      mergeChange.status !== expected.status ||
      finalChange.status !== expected.status ||
      mergeChange.blobSha !== expected.blobSha ||
      finalChange.blobSha !== expected.blobSha ||
      finalBlobs.get(expected.path) !== expected.blobSha
    ) {
      return remediationInvalid(`remediation ${input.remediationId} ${input.label} blob changed at ${expected.path}`)
    }
  }
  return null
}

const validateContinuousSourceIntroductionIdentity = (input: {
  readonly remediationId: string
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly introduction: BaynReleaseRangeCommit
  readonly identity: BaynReleaseReviewRemediationContinuousSourceIntroduction
}): BaynReleaseReviewHold | null => {
  const identityHold = validateContinuousSourceCommitIdentity({
    remediationId: input.remediationId,
    evidence: input.evidence,
    commit: input.introduction,
    identity: input.identity,
    label: 'introduction',
  })
  if (identityHold !== null) return identityHold
  const recordPath = input.identity.affectedPaths.find((path) => path.path === input.evidence.recordPath)
  if (
    recordPath === undefined ||
    recordPath.status !== 'added' ||
    recordPath.previousPath !== null ||
    recordPath.blobSha !== input.identity.introducedRecordBlobSha
  ) {
    return remediationInvalid(`remediation ${input.remediationId} introduced receipt blob is not exact`)
  }
  return null
}

const validateContinuousSourceCompletionIdentity = (input: {
  readonly remediationId: string
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly completion: BaynReleaseRangeCommit
  readonly identity: BaynReleaseReviewRemediationContinuousSourceCompletion
}): BaynReleaseReviewHold | null => {
  const identityHold = validateContinuousSourceCommitIdentity({
    remediationId: input.remediationId,
    evidence: input.evidence,
    commit: input.completion,
    identity: input.identity,
    label: 'completion',
  })
  if (identityHold !== null) return identityHold
  const recordPath = input.identity.affectedPaths.find((path) => path.path === input.evidence.recordPath)
  if (
    recordPath === undefined ||
    recordPath.status !== 'modified' ||
    recordPath.previousPath !== null ||
    recordPath.blobSha !== input.identity.completedRecordBlobSha
  ) {
    return remediationInvalid(`remediation ${input.remediationId} completed receipt blob is not exact`)
  }
  return null
}

const validateContinuousReviewedLineage = (input: {
  readonly record:
    | BaynReleaseReviewRemediationSingleStageSuccessorRecord
    | BaynReleaseReviewRemediationCompletedSingleStageSuccessorRecord
    | BaynReleaseReviewRemediationReviewedCompletionSingleStageSuccessorRecord
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly pullRequest: PullRequestReviewState
}): BaynReleaseReviewHold | null => {
  const { blocked, remediationId } = input.record
  const { reviewedLineage } = blocked
  const reviewedHead = findReferencedCommit(input.evidence, reviewedLineage.reviewedHeadSha)
  const expectedPaths = blocked.affectedPaths.map((path) => path.path)
  if (
    reviewedHead === null ||
    reviewedLineage.reviewedHeadParentSha !== blocked.mergeParentSha ||
    reviewedLineage.forcePush.beforeHeadSha !== reviewedLineage.reviewedHeadSha ||
    reviewedLineage.forcePush.afterHeadSha !== blocked.finalHeadSha ||
    reviewedLineage.feedback.reviewedHeadSha !== reviewedLineage.reviewedHeadSha ||
    reviewedLineage.feedback.fixedHeadSha !== blocked.finalHeadSha ||
    !exactStringSet(
      reviewedLineage.affectedPaths.map((path) => path.path),
      expectedPaths,
    )
  ) {
    return remediationInvalid(`remediation ${remediationId} reviewed lineage endpoints are not exact`)
  }
  const reviewedHeadHold = validateRemediationReconstructionHead({
    remediationId,
    expected: {
      headSha: reviewedLineage.reviewedHeadSha,
      parentSha: reviewedLineage.reviewedHeadParentSha,
      treeSha: reviewedLineage.reviewedHeadTreeSha,
      affectedPaths: reviewedLineage.affectedPaths,
    },
    observed: reviewedHead,
  })
  if (reviewedHeadHold !== null) return reviewedHeadHold
  for (const reviewedPath of reviewedLineage.affectedPaths) {
    const finalPath = blocked.affectedPaths.find((path) => path.path === reviewedPath.path)
    if (
      finalPath === undefined ||
      finalPath.previousPath !== reviewedPath.previousPath ||
      finalPath.status !== reviewedPath.status
    ) {
      return remediationInvalid(`remediation ${remediationId} reviewed lineage changed at ${reviewedPath.path}`)
    }
  }
  const feedbackReviewedPath = reviewedLineage.affectedPaths.find((path) => path.path === reviewedLineage.feedback.path)
  const feedbackFinalPath = blocked.affectedPaths.find((path) => path.path === reviewedLineage.feedback.path)
  if (
    feedbackReviewedPath === undefined ||
    feedbackFinalPath === undefined ||
    feedbackReviewedPath.blobSha === feedbackFinalPath.blobSha
  ) {
    return remediationInvalid(`remediation ${remediationId} reviewed feedback transformation is not exact`)
  }

  const reviewSubmittedAtMs = Date.parse(reviewedLineage.reviewSubmittedAt)
  const forcePushAtMs = Date.parse(reviewedLineage.forcePush.createdAt)
  const mergedAtMs = Date.parse(input.pullRequest.mergedAt ?? '')
  const codexReviews = input.pullRequest.reviews
    .filter(
      (review) =>
        review.authorLogin === baynCodexReviewer &&
        review.submittedAt !== null &&
        eligibleReviewStates.has(review.state),
    )
    .toSorted((left, right) => (left.submittedAt ?? '').localeCompare(right.submittedAt ?? ''))
  const latestCodexReview = codexReviews.at(-1)
  const exactReviews = codexReviews.filter(
    (review) =>
      review.commitSha === reviewedLineage.reviewedHeadSha && review.submittedAt === reviewedLineage.reviewSubmittedAt,
  )
  const forcePushes = input.pullRequest.headForcePushes.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )
  const latestForcePush = forcePushes.at(-1)
  if (
    !Number.isFinite(reviewSubmittedAtMs) ||
    !Number.isFinite(forcePushAtMs) ||
    !Number.isFinite(mergedAtMs) ||
    reviewSubmittedAtMs >= forcePushAtMs ||
    forcePushAtMs >= mergedAtMs ||
    input.pullRequest.headForcePushCount !== input.pullRequest.headForcePushes.length ||
    exactReviews.length !== 1 ||
    latestCodexReview !== exactReviews[0] ||
    latestForcePush === undefined ||
    latestForcePush.beforeCommitSha !== reviewedLineage.forcePush.beforeHeadSha ||
    latestForcePush.afterCommitSha !== reviewedLineage.forcePush.afterHeadSha ||
    latestForcePush.actorLogin !== reviewedLineage.forcePush.actorLogin ||
    latestForcePush.createdAt !== reviewedLineage.forcePush.createdAt
  ) {
    return remediationInvalid(`remediation ${remediationId} latest reviewed-head transition is not exact`)
  }

  const threadMatches = input.pullRequest.threads.filter((thread) => thread.id === reviewedLineage.feedback.threadId)
  const feedbackThread = threadMatches[0]
  if (
    threadMatches.length !== 1 ||
    feedbackThread === undefined ||
    !feedbackThread.isResolved ||
    !feedbackThread.isOutdated ||
    feedbackThread.path !== reviewedLineage.feedback.path
  ) {
    return remediationInvalid(`remediation ${remediationId} reviewed feedback thread is missing or actionable`)
  }
  const findings = feedbackThread.comments.filter(
    (comment) =>
      comment.url === reviewedLineage.feedback.findingUrl &&
      sha256Text(comment.body) === reviewedLineage.feedback.findingBodySha256 &&
      comment.authorLogin === baynCodexReviewer &&
      comment.reviewAuthorLogin === baynCodexReviewer &&
      comment.reviewCommitSha === reviewedLineage.reviewedHeadSha &&
      comment.reviewSubmittedAt === reviewedLineage.reviewSubmittedAt,
  )
  const replies = feedbackThread.comments.filter(
    (comment) =>
      comment.url === reviewedLineage.feedback.fixReplyUrl &&
      sha256Text(comment.body) === reviewedLineage.feedback.fixReplyBodySha256 &&
      comment.authorLogin !== null &&
      comment.authorLogin !== baynCodexReviewer &&
      trustedFeedbackAssociations.has(comment.authorAssociation) &&
      comment.reviewCommitSha === blocked.finalHeadSha,
  )
  const findingAtMs = Date.parse(findings[0]?.createdAt ?? '')
  const replyAtMs = Date.parse(replies[0]?.createdAt ?? '')
  if (
    findings.length !== 1 ||
    replies.length !== 1 ||
    !Number.isFinite(findingAtMs) ||
    !Number.isFinite(replyAtMs) ||
    findingAtMs < reviewSubmittedAtMs ||
    replyAtMs <= forcePushAtMs ||
    replyAtMs >= mergedAtMs
  ) {
    return remediationInvalid(`remediation ${remediationId} exact reviewed feedback/fix evidence is missing`)
  }
  const reactions = input.pullRequest.reactions.filter(
    (reaction) => reaction.userLogin === baynCodexBotLogin && reaction.content === '+1',
  )
  const reactionAtMs = Date.parse(reactions[0]?.createdAt ?? '')
  if (
    reactions.length !== 1 ||
    !Number.isFinite(reactionAtMs) ||
    reactionAtMs <= replyAtMs ||
    reactionAtMs >= mergedAtMs
  ) {
    return remediationInvalid(`remediation ${remediationId} reviewed lineage final-head reaction is missing`)
  }
  return null
}

const validateContinuousSourceRemediation = (input: {
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly blockedCommit: BaynReleaseRangeCommit
  readonly comparison: BaynReleaseComparison
  readonly normalReviews: ReadonlyMap<string, BaynReleaseReviewEvaluation>
  readonly introduction: BaynReleaseRangeCommit
  readonly blockedIndex: number
  readonly nowMs: number
}): BaynReleaseReviewHold | null => {
  const { evidence, blockedCommit, comparison } = input
  const record = evidence.record
  if (
    record.schemaVersion !== 'bayn.release-review-remediation.v4' &&
    record.schemaVersion !== 'bayn.release-review-remediation.v5' &&
    record.schemaVersion !== 'bayn.release-review-remediation.v6' &&
    record.schemaVersion !== 'bayn.release-review-remediation.v7' &&
    record.schemaVersion !== 'bayn.release-review-remediation.v8' &&
    record.schemaVersion !== 'bayn.release-review-remediation.v9'
  ) {
    return remediationInvalid(`remediation ${record.remediationId} continuous source record is missing`)
  }

  const finalHead = findReferencedCommit(evidence, record.blocked.finalHeadSha)
  const mergeChanges = commitFileMap(blockedCommit.fileChanges)
  const finalChanges = finalHead === null ? null : commitFileMap(finalHead.fileChanges)
  const finalBlobs = finalHead === null ? null : pathBlobMap(finalHead.pathBlobs)
  const expectedPaths = record.blocked.affectedPaths.map((path) => path.path)
  if (
    finalHead === null ||
    mergeChanges === null ||
    finalChanges === null ||
    finalBlobs === null ||
    finalHead.sha !== record.blocked.finalHeadSha ||
    finalHead.parents.length !== 1 ||
    finalHead.parents[0] !== record.blocked.finalHeadParentSha ||
    record.blocked.finalHeadParentSha !== record.blocked.mergeParentSha ||
    finalHead.treeSha !== record.blocked.finalHeadTreeSha ||
    record.blocked.finalHeadTreeSha !== record.blocked.mergeTreeSha ||
    blockedCommit.treeSha !== finalHead.treeSha
  ) {
    return remediationInvalid(`remediation ${record.remediationId} continuous source identity is not exact`)
  }
  if (
    !exactStringSet(expectedPaths, blockedCommit.files) ||
    !exactStringSet(expectedPaths, finalHead.files) ||
    !exactStringSet(expectedPaths, [...mergeChanges.keys()]) ||
    !exactStringSet(expectedPaths, [...finalChanges.keys()]) ||
    !exactStringSet(expectedPaths, [...finalBlobs.keys()])
  ) {
    return remediationInvalid(`remediation ${record.remediationId} continuous source path set is incomplete`)
  }
  for (const expected of record.blocked.affectedPaths) {
    const mergeChange = mergeChanges.get(expected.path)
    const finalChange = finalChanges.get(expected.path)
    if (
      mergeChange === undefined ||
      finalChange === undefined ||
      mergeChange.previousPath !== expected.previousPath ||
      finalChange.previousPath !== expected.previousPath ||
      mergeChange.status !== expected.status ||
      finalChange.status !== expected.status ||
      mergeChange.blobSha !== expected.blobSha ||
      finalChange.blobSha !== expected.blobSha ||
      finalBlobs.get(expected.path) !== expected.blobSha
    ) {
      return remediationInvalid(
        `remediation ${record.remediationId} continuous source blob changed at ${expected.path}`,
      )
    }
  }

  const blockedReviewInput = {
    remediationId: record.remediationId,
    commit: blockedCommit,
    identity: {
      mergeCommitSha: record.blocked.mergeCommitSha,
      sourcePullRequestNumber: record.blocked.sourcePullRequestNumber,
      finalHeadSha: record.blocked.finalHeadSha,
      sourcePullRequestEvidenceSha256: record.blocked.sourcePullRequestEvidenceSha256,
    },
  }
  if (
    record.schemaVersion === 'bayn.release-review-remediation.v7' ||
    record.schemaVersion === 'bayn.release-review-remediation.v8' ||
    record.schemaVersion === 'bayn.release-review-remediation.v9'
  ) {
    const reviewEvidence = validateBoundRemediationReviewEvidence(blockedReviewInput)
    if (reviewEvidence.status === 'hold') return reviewEvidence
    const lineageHold = validateContinuousReviewedLineage({
      record,
      evidence,
      pullRequest: reviewEvidence.pullRequest,
    })
    if (lineageHold !== null) return lineageHold
  } else {
    const blockedReview = input.normalReviews.get(blockedCommit.sha)
    if (blockedReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} blocked source review snapshot is missing`)
    }
    const boundReview = evaluateBoundRemediationReview({
      ...blockedReviewInput,
      normalReview: blockedReview,
      nowMs: input.nowMs,
    })
    if (boundReview.status === 'hold') return boundReview
  }

  const protectedPaths = new Set(expectedPaths)
  const expectedCurrentBlobs = new Map(record.blocked.affectedPaths.map((path) => [path.path, path.blobSha]))
  let successorCommit: BaynReleaseRangeCommit | undefined
  let protectedTransitions: ReadonlyMap<
    string,
    BaynReleaseReviewRemediationContinuousSourceSuccessor['protectedPathTransitions'][number]
  > = new Map()
  if (
    record.schemaVersion === 'bayn.release-review-remediation.v6' ||
    record.schemaVersion === 'bayn.release-review-remediation.v7' ||
    record.schemaVersion === 'bayn.release-review-remediation.v8' ||
    record.schemaVersion === 'bayn.release-review-remediation.v9'
  ) {
    const successor = record.requiredSuccessors[0]
    const successorMatches = comparison.commits.filter((commit) => commit.sha === successor.mergeCommitSha)
    const transitionPaths = successor.protectedPathTransitions.map((transition) => transition.path)
    const transitionMap = new Map(successor.protectedPathTransitions.map((transition) => [transition.path, transition]))
    if (
      successorMatches.length !== 1 ||
      transitionMap.size !== successor.protectedPathTransitions.length ||
      !exactStringSet(
        transitionPaths,
        successor.affectedPaths.filter((path) => protectedPaths.has(path.path)).map((path) => path.path),
      )
    ) {
      return remediationInvalid(`remediation ${record.remediationId} successor declaration is ambiguous`)
    }
    if (
      (record.schemaVersion === 'bayn.release-review-remediation.v7' ||
        record.schemaVersion === 'bayn.release-review-remediation.v8' ||
        record.schemaVersion === 'bayn.release-review-remediation.v9') &&
      !exactStringSet(transitionPaths, expectedPaths)
    ) {
      return remediationInvalid(
        `remediation ${record.remediationId} reviewed successor does not replace every blocked source path`,
      )
    }
    successorCommit = successorMatches[0]
    if (successorCommit === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} successor commit is missing`)
    }
    const successorIdentityHold = validateContinuousSourceCommitIdentity({
      remediationId: record.remediationId,
      evidence,
      commit: successorCommit,
      identity: successor,
      label: 'successor',
    })
    if (successorIdentityHold !== null) return successorIdentityHold
    for (const transition of successor.protectedPathTransitions) {
      const blockedPath = record.blocked.affectedPaths.find((path) => path.path === transition.path)
      const successorPath = successor.affectedPaths.find((path) => path.path === transition.path)
      if (
        blockedPath === undefined ||
        successorPath === undefined ||
        successor.mergeParentSha !== blockedCommit.sha ||
        transition.beforeBlobSha !== blockedPath.blobSha ||
        transition.afterBlobSha !== successorPath.blobSha ||
        successorPath.status !== 'modified' ||
        successorPath.previousPath !== null ||
        transition.beforeBlobSha === transition.afterBlobSha
      ) {
        return remediationInvalid(`remediation ${record.remediationId} successor protected transition is not exact`)
      }
      expectedCurrentBlobs.set(transition.path, transition.afterBlobSha)
    }
    const successorReview = input.normalReviews.get(successorCommit.sha)
    if (successorReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} successor review snapshot is missing`)
    }
    const reviewedSuccessor = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: successorCommit,
      identity: successor,
      normalReview: successorReview,
      nowMs: input.nowMs,
    })
    if (reviewedSuccessor.status === 'hold') return reviewedSuccessor
    protectedTransitions = transitionMap
  }
  let expectedParent = blockedCommit.sha
  for (const commit of comparison.commits.slice(input.blockedIndex + 1)) {
    if (commit.parents.length !== 1 || commit.parents[0] !== expectedParent) {
      return remediationInvalid(`remediation ${record.remediationId} source ancestry is not a direct-parent chain`)
    }
    const protectedChanges = (commit.fileChanges ?? []).filter(
      (change) =>
        protectedPaths.has(change.path) || (change.previousPath !== null && protectedPaths.has(change.previousPath)),
    )
    if (commit.sha === successorCommit?.sha) {
      if (
        !exactStringSet(
          protectedChanges.map((change) => change.path),
          [...protectedTransitions.keys()],
        ) ||
        protectedChanges.some((change) => {
          const transition = protectedTransitions.get(change.path)
          return (
            transition === undefined ||
            change.previousPath !== null ||
            change.status !== 'modified' ||
            change.blobSha !== transition.afterBlobSha
          )
        })
      ) {
        return remediationInvalid(`remediation ${record.remediationId} successor protected mutation is not exact`)
      }
    } else if (commit.files.some((path) => protectedPaths.has(path)) || protectedChanges.length > 0) {
      return remediationInvalid(`remediation ${record.remediationId} continuous source changed after the blocked merge`)
    }
    // The bound successor, introduction, and completion reviews are validated before this ancestry walk. Other
    // Bayn-affecting commits are deliberately left to the top-level publication loop, where each commit can apply
    // its own exact remediation instead of being rejected again by an earlier continuous-source receipt.
    expectedParent = commit.sha
  }
  if (expectedParent !== comparison.headSha) {
    return remediationInvalid(`remediation ${record.remediationId} is stale or does not reach the current source head`)
  }

  const currentBlobs = pathBlobMap(evidence.currentPathBlobs)
  if (
    currentBlobs === null ||
    !exactStringSet(expectedPaths, [...currentBlobs.keys()]) ||
    [...expectedCurrentBlobs].some(([path, blobSha]) => currentBlobs.get(path) !== blobSha)
  ) {
    return remediationInvalid(`remediation ${record.remediationId} current continuous source blobs diverged`)
  }
  return null
}

const validateReleaseReviewRemediation = (input: {
  readonly evidence: BaynReleaseReviewRemediationEvidence
  readonly blockedCommit: BaynReleaseRangeCommit
  readonly comparison: BaynReleaseComparison
  readonly normalReviews: ReadonlyMap<string, BaynReleaseReviewEvaluation>
  readonly nowMs: number
}): BaynReleaseReviewHold | null => {
  const { evidence, blockedCommit, comparison } = input
  const record = evidence.record
  const expectedRecordPath = `${remediationDirectory}/${record.blocked.mergeCommitSha}.json`
  if (evidence.recordPath !== expectedRecordPath) {
    return remediationInvalid(`remediation ${record.remediationId} record path is not canonical`)
  }
  const recordCommits = comparison.commits.filter((commit) =>
    commit.fileChanges?.some((change) => change.path === evidence.recordPath),
  )
  let introduction: BaynReleaseRangeCommit | undefined
  if (record.schemaVersion === 'bayn.release-review-remediation.v6') {
    if (recordCommits.length !== 3) {
      return remediationInvalid(`remediation ${record.remediationId} successor-bound history is not exact`)
    }
    introduction = recordCommits.find((commit) => commit.sha === record.introduction.mergeCommitSha)
    const completion = recordCommits.find((commit) => commit.sha === record.completion.mergeCommitSha)
    const update = recordCommits.find(
      (commit) => commit.sha !== record.introduction.mergeCommitSha && commit.sha !== record.completion.mergeCommitSha,
    )
    const updateChange = update?.fileChanges?.find((change) => change.path === evidence.recordPath)
    if (
      introduction === undefined ||
      completion === undefined ||
      update === undefined ||
      update.parents.length !== 1 ||
      updateChange?.status !== 'modified' ||
      updateChange.previousPath !== null ||
      updateChange.blobSha !== evidence.recordBlobSha ||
      comparison.commits.indexOf(introduction) >= comparison.commits.indexOf(completion) ||
      comparison.commits.indexOf(completion) >= comparison.commits.indexOf(update)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} successor-bound record mutation is not exact`)
    }
    const introductionIdentityHold = validateContinuousSourceIntroductionIdentity({
      remediationId: record.remediationId,
      evidence,
      introduction,
      identity: record.introduction,
    })
    if (introductionIdentityHold !== null) return introductionIdentityHold
    const completionIdentityHold = validateContinuousSourceCompletionIdentity({
      remediationId: record.remediationId,
      evidence,
      completion,
      identity: record.completion,
    })
    if (completionIdentityHold !== null) return completionIdentityHold
    const updateReview = input.normalReviews.get(update.sha)
    if (updateReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} update commit lacks exact-head review`)
    }
    if (updateReview.status === 'hold') {
      if (updateReview.retryable) return updateReview
      return remediationInvalid(`remediation ${record.remediationId} update commit lacks exact-head review`)
    }
    const completionNormalReview = input.normalReviews.get(completion.sha)
    if (completionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} completion review snapshot is missing`)
    }
    const completionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: completion,
      identity: record.completion,
      normalReview: completionNormalReview,
      nowMs: input.nowMs,
    })
    if (completionReview.status === 'hold') return completionReview
    const introductionNormalReview = input.normalReviews.get(introduction.sha)
    if (introductionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} introduction review snapshot is missing`)
    }
    const introductionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: introduction,
      identity: record.introduction,
      normalReview: introductionNormalReview,
      nowMs: input.nowMs,
    })
    if (introductionReview.status === 'hold') return introductionReview
  } else if (record.schemaVersion === 'bayn.release-review-remediation.v9') {
    if (recordCommits.length !== 3) {
      return remediationInvalid(`remediation ${record.remediationId} reviewed completion history is not exact`)
    }
    introduction = recordCommits.find((commit) => commit.sha === record.introduction.mergeCommitSha)
    const completion = recordCommits.find((commit) => commit.sha === record.completion.mergeCommitSha)
    const update = recordCommits.find(
      (commit) => commit.sha !== record.introduction.mergeCommitSha && commit.sha !== record.completion.mergeCommitSha,
    )
    const updateChange = update?.fileChanges?.find((change) => change.path === evidence.recordPath)
    if (
      introduction === undefined ||
      completion === undefined ||
      update === undefined ||
      update.parents.length !== 1 ||
      update.parents[0] !== completion.sha ||
      updateChange?.status !== 'modified' ||
      updateChange.previousPath !== null ||
      updateChange.blobSha !== evidence.recordBlobSha ||
      comparison.commits.indexOf(introduction) >= comparison.commits.indexOf(completion) ||
      comparison.commits.indexOf(completion) >= comparison.commits.indexOf(update)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} reviewed completion mutation is not exact`)
    }
    const introductionIdentityHold = validateContinuousSourceIntroductionIdentity({
      remediationId: record.remediationId,
      evidence,
      introduction,
      identity: record.introduction,
    })
    if (introductionIdentityHold !== null) return introductionIdentityHold
    const completionIdentityHold = validateContinuousSourceCompletionIdentity({
      remediationId: record.remediationId,
      evidence,
      completion,
      identity: record.completion,
    })
    if (completionIdentityHold !== null) return completionIdentityHold
    const updateReview = input.normalReviews.get(update.sha)
    if (updateReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} update commit lacks exact-head review`)
    }
    if (updateReview.status === 'hold') {
      if (updateReview.retryable) return updateReview
      return remediationInvalid(`remediation ${record.remediationId} update commit lacks exact-head review`)
    }
    const completionNormalReview = input.normalReviews.get(completion.sha)
    if (completionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} completion review snapshot is missing`)
    }
    const completionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: completion,
      identity: record.completion,
      normalReview: completionNormalReview,
      nowMs: input.nowMs,
    })
    if (completionReview.status === 'hold') return completionReview
    const introductionNormalReview = input.normalReviews.get(introduction.sha)
    if (introductionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} introduction review snapshot is missing`)
    }
    const introductionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: introduction,
      identity: record.introduction,
      normalReview: introductionNormalReview,
      nowMs: input.nowMs,
    })
    if (introductionReview.status === 'hold') return introductionReview
  } else if (record.schemaVersion === 'bayn.release-review-remediation.v8') {
    const identity = record.introduction
    if (recordCommits.length !== 2) {
      return remediationInvalid(`remediation ${record.remediationId} completion history is not exact`)
    }
    introduction = recordCommits.find((commit) => commit.sha === identity.mergeCommitSha)
    const completion = recordCommits.find((commit) => commit.sha !== identity.mergeCommitSha)
    const completionChange = completion?.fileChanges?.find((change) => change.path === evidence.recordPath)
    if (
      introduction === undefined ||
      completion === undefined ||
      completion.parents.length !== 1 ||
      completion.parents[0] !== introduction.sha ||
      completionChange?.status !== 'modified' ||
      completionChange.previousPath !== null ||
      completionChange.blobSha !== evidence.recordBlobSha ||
      comparison.commits.indexOf(completion) <= comparison.commits.indexOf(introduction)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} completion record mutation is not exact`)
    }
    const introductionIdentityHold = validateContinuousSourceIntroductionIdentity({
      remediationId: record.remediationId,
      evidence,
      introduction,
      identity,
    })
    if (introductionIdentityHold !== null) return introductionIdentityHold
    const completionReview = input.normalReviews.get(completion.sha)
    if (completionReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} completion commit lacks exact-head review`)
    }
    if (completionReview.status === 'hold') {
      if (completionReview.retryable) return completionReview
      return remediationInvalid(`remediation ${record.remediationId} completion commit lacks exact-head review`)
    }
    const introductionNormalReview = input.normalReviews.get(introduction.sha)
    if (introductionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} introduction review snapshot is missing`)
    }
    const introductionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: introduction,
      identity,
      normalReview: introductionNormalReview,
      nowMs: input.nowMs,
    })
    if (introductionReview.status === 'hold') return introductionReview
  } else if (record.schemaVersion === 'bayn.release-review-remediation.v5') {
    const identity = record.introduction
    if (recordCommits.length !== 2) {
      return remediationInvalid(`remediation ${record.remediationId} completion history is not exact`)
    }
    introduction = recordCommits.find((commit) => commit.sha === identity.mergeCommitSha)
    const completion = recordCommits.find((commit) => commit.sha !== identity.mergeCommitSha)
    const completionChange = completion?.fileChanges?.find((change) => change.path === evidence.recordPath)
    if (
      introduction === undefined ||
      completion === undefined ||
      completion.parents.length !== 1 ||
      completion.parents[0] !== introduction.sha ||
      completionChange?.status !== 'modified' ||
      completionChange.previousPath !== null ||
      completionChange.blobSha !== evidence.recordBlobSha ||
      comparison.commits.indexOf(completion) <= comparison.commits.indexOf(introduction)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} completion record mutation is not exact`)
    }
    const introductionIdentityHold = validateContinuousSourceIntroductionIdentity({
      remediationId: record.remediationId,
      evidence,
      introduction,
      identity,
    })
    if (introductionIdentityHold !== null) return introductionIdentityHold
    const completionReview = input.normalReviews.get(completion.sha)
    if (completionReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} completion commit lacks exact-head review`)
    }
    if (completionReview.status === 'hold') {
      if (completionReview.retryable) return completionReview
      return remediationInvalid(`remediation ${record.remediationId} completion commit lacks exact-head review`)
    }
    const introductionNormalReview = input.normalReviews.get(introduction.sha)
    if (introductionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} introduction review snapshot is missing`)
    }
    const introductionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: introduction,
      identity,
      normalReview: introductionNormalReview,
      nowMs: input.nowMs,
    })
    if (introductionReview.status === 'hold') return introductionReview
  } else if (record.schemaVersion === 'bayn.release-review-remediation.v3') {
    const identity = record.introduction
    if (identity === undefined || recordCommits.length !== 2) {
      return remediationInvalid(`remediation ${record.remediationId} completion history is not exact`)
    }
    introduction = recordCommits.find((commit) => commit.sha === identity.mergeCommitSha)
    const completion = recordCommits.find((commit) => commit.sha !== identity.mergeCommitSha)
    const introductionChange = introduction?.fileChanges?.find((change) => change.path === evidence.recordPath)
    const completionChange = completion?.fileChanges?.find((change) => change.path === evidence.recordPath)
    if (
      introduction === undefined ||
      completion === undefined ||
      introductionChange?.status !== 'added' ||
      introductionChange.blobSha !== identity.introducedRecordBlobSha ||
      completionChange?.status !== 'modified' ||
      completionChange.blobSha !== evidence.recordBlobSha ||
      comparison.commits.indexOf(completion) <= comparison.commits.indexOf(introduction)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} completion record mutation is not exact`)
    }
    const completionReview = input.normalReviews.get(completion.sha)
    if (completionReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} completion commit lacks exact-head review`)
    }
    if (completionReview.status === 'hold') {
      if (completionReview.retryable) return completionReview
      return remediationInvalid(`remediation ${record.remediationId} completion commit lacks exact-head review`)
    }
    const introductionNormalReview = input.normalReviews.get(introduction.sha)
    if (introductionNormalReview === undefined) {
      return remediationInvalid(`remediation ${record.remediationId} introduction review snapshot is missing`)
    }
    const introductionReview = evaluateBoundRemediationReview({
      remediationId: record.remediationId,
      commit: introduction,
      identity,
      normalReview: introductionNormalReview,
      nowMs: input.nowMs,
    })
    if (introductionReview.status === 'hold') return introductionReview
  } else {
    if (recordCommits.length !== 1) {
      return remediationInvalid(`remediation ${record.remediationId} record was not added exactly once`)
    }
    introduction = recordCommits[0]
    if (introduction === undefined)
      return remediationInvalid(`remediation ${record.remediationId} introduction is missing`)
    const introductionChange = introduction.fileChanges?.find((change) => change.path === evidence.recordPath)
    if (
      introductionChange === undefined ||
      introductionChange.status !== 'added' ||
      introductionChange.blobSha !== evidence.recordBlobSha
    ) {
      return remediationInvalid(`remediation ${record.remediationId} record blob/introduction changed`)
    }
    const introductionReview = input.normalReviews.get(introduction.sha)
    if (introductionReview?.status !== 'eligible') {
      return remediationInvalid(`remediation ${record.remediationId} introducing commit lacks exact-head review`)
    }
  }
  if (introduction === undefined)
    return remediationInvalid(`remediation ${record.remediationId} introduction is missing`)
  const blockedIndex = comparison.commits.findIndex((commit) => commit.sha === blockedCommit.sha)
  const introductionIndex = comparison.commits.findIndex((commit) => commit.sha === introduction.sha)
  if (
    blockedIndex < 0 ||
    introductionIndex <= blockedIndex ||
    record.blocked.mergeCommitSha !== blockedCommit.sha ||
    record.blocked.mergeParentSha !== blockedCommit.parents[0] ||
    blockedCommit.parents.length !== 1 ||
    blockedCommit.treeSha !== record.blocked.mergeTreeSha
  ) {
    return remediationInvalid(`remediation ${record.remediationId} blocked merge ancestry is invalid`)
  }
  const blockedPull = blockedCommit.reviewSnapshot?.pullRequest
  if (blockedPull === null || blockedPull === undefined) {
    return remediationInvalid(`remediation ${record.remediationId} blocked source PR snapshot is missing`)
  }
  if (
    record.schemaVersion === 'bayn.release-review-remediation.v4' ||
    record.schemaVersion === 'bayn.release-review-remediation.v5' ||
    record.schemaVersion === 'bayn.release-review-remediation.v6' ||
    record.schemaVersion === 'bayn.release-review-remediation.v7' ||
    record.schemaVersion === 'bayn.release-review-remediation.v8' ||
    record.schemaVersion === 'bayn.release-review-remediation.v9'
  ) {
    return validateContinuousSourceRemediation({
      evidence,
      blockedCommit,
      comparison,
      normalReviews: input.normalReviews,
      introduction,
      blockedIndex,
      nowMs: input.nowMs,
    })
  }
  const feedbackHold = validateRemediationFeedback(record, blockedPull)
  if (feedbackHold !== null) return feedbackHold

  if (
    record.schemaVersion === 'bayn.release-review-remediation.v2' ||
    record.schemaVersion === 'bayn.release-review-remediation.v3'
  ) {
    return validateReleaseReviewRemediationV2({
      evidence,
      blockedCommit,
      comparison,
      normalReviews: input.normalReviews,
      introduction,
      blockedIndex,
      nowMs: input.nowMs,
    })
  }

  const reviewedHead = findReferencedCommit(evidence, record.blocked.reviewedHeadSha)
  const finalHead = findReferencedCommit(evidence, record.blocked.finalHeadSha)
  if (reviewedHead === null || finalHead === null) {
    return remediationInvalid(`remediation ${record.remediationId} reviewed/final commit evidence is incomplete`)
  }
  if (
    reviewedHead.parents.length !== 1 ||
    finalHead.parents.length !== 1 ||
    reviewedHead.parents[0] !== record.blocked.mergeParentSha ||
    finalHead.parents[0] !== record.blocked.mergeParentSha ||
    reviewedHead.treeSha !== record.blocked.reviewedHeadTreeSha ||
    finalHead.treeSha !== record.blocked.finalHeadTreeSha ||
    blockedCommit.treeSha !== finalHead.treeSha
  ) {
    return remediationInvalid(`remediation ${record.remediationId} reconstructed head/tree ancestry changed`)
  }
  const reviewedChanges = commitFileMap(reviewedHead.fileChanges)
  const finalChanges = commitFileMap(finalHead.fileChanges)
  const reviewedBlobs = pathBlobMap(reviewedHead.pathBlobs)
  const finalBlobs = pathBlobMap(finalHead.pathBlobs)
  const currentBlobs = pathBlobMap(evidence.currentPathBlobs)
  const affectedPaths = record.blocked.affectedPaths.map((path) => path.path)
  if (
    reviewedChanges === null ||
    finalChanges === null ||
    reviewedBlobs === null ||
    finalBlobs === null ||
    currentBlobs === null ||
    !exactStringSet([...reviewedChanges.keys()], affectedPaths) ||
    !exactStringSet([...finalChanges.keys()], affectedPaths) ||
    !exactStringSet([...currentBlobs.keys()], affectedPaths) ||
    !exactStringSet(blockedCommit.files, affectedPaths)
  ) {
    return remediationInvalid(`remediation ${record.remediationId} transformation path set changed`)
  }
  const blockedChanges = commitFileMap(blockedCommit.fileChanges)
  if (blockedChanges === null)
    return remediationInvalid(`remediation ${record.remediationId} blocked blobs are missing`)
  for (const path of record.blocked.affectedPaths) {
    if (
      reviewedBlobs.get(path.path) !== path.reviewedBlobSha ||
      finalBlobs.get(path.path) !== path.finalBlobSha ||
      blockedChanges.get(path.path)?.blobSha !== path.blockedBlobSha ||
      path.finalBlobSha !== path.blockedBlobSha ||
      currentBlobs.get(path.path) !== path.finalBlobSha
    ) {
      return remediationInvalid(`remediation ${record.remediationId} transformation blob changed at ${path.path}`)
    }
  }
  const laterMutations = comparison.commits
    .slice(blockedIndex + 1)
    .filter((commit) => commit.sha !== introduction.sha)
    .flatMap((commit) => commit.files.filter((path) => affectedPaths.includes(path)))
  if (laterMutations.length > 0) {
    return remediationInvalid(
      `remediation ${record.remediationId} affected source paths changed after the blocked merge`,
    )
  }

  let expectedParent = blockedCommit.sha
  let cursor = blockedIndex + 1
  const nextBaynCommit = (): BaynReleaseRangeCommit | BaynReleaseReviewHold | null => {
    while (cursor < comparison.commits.length) {
      const commit = comparison.commits[cursor]
      if (commit === undefined || commit.parents.length !== 1 || commit.parents[0] !== expectedParent) {
        return remediationInvalid(`remediation ${record.remediationId} source ancestry is not a direct-parent chain`)
      }
      expectedParent = commit.sha
      cursor += 1
      if (commit.files.some(isBaynReleaseAffectingPath)) return commit
    }
    return null
  }
  for (const descendant of record.requiredDescendants) {
    const next = nextBaynCommit()
    if (next === null || 'status' in next) {
      return next ?? remediationInvalid(`remediation ${record.remediationId} descendant chain is incomplete`)
    }
    const mergeCommit = next
    if (mergeCommit.sha !== descendant.mergeCommitSha) {
      return remediationInvalid(`remediation ${record.remediationId} descendant ancestry is incomplete or downgraded`)
    }
    const normalDescendantReview = input.normalReviews.get(mergeCommit.sha)
    if (normalDescendantReview?.status === 'hold' && normalDescendantReview.code !== 'exact-head-review-missing') {
      return normalDescendantReview
    }
    const descendantPull = mergeCommit.reviewSnapshot?.pullRequest
    const descendantReactions = descendantPull?.reactions.filter(
      (reaction) => reaction.userLogin === baynCodexBotLogin && reaction.content === '+1',
    )
    const descendantBlockingReviews = descendantPull?.reviews.filter(
      (review) =>
        review.authorLogin === baynCodexReviewer &&
        (review.submittedAt === null || review.state === 'PENDING' || review.state === 'CHANGES_REQUESTED'),
    )
    const latestForcePush = descendantPull?.headForcePushes.toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0]
    if (
      descendantPull === null ||
      descendantPull === undefined ||
      descendantPull.number !== descendant.sourcePullRequestNumber ||
      descendantPull.headSha !== descendant.finalHeadSha ||
      descendantPull.mergeCommitSha !== descendant.mergeCommitSha ||
      pullRequestReviewEvidenceSha256(descendantPull) !== descendant.sourcePullRequestEvidenceSha256 ||
      descendantPull.threads.some((thread) => !thread.isResolved) ||
      descendantBlockingReviews?.length !== 0 ||
      !descendantPull.reviews.some(
        (review) =>
          review.authorLogin === baynCodexReviewer &&
          review.commitSha !== null &&
          review.submittedAt !== null &&
          eligibleReviewStates.has(review.state),
      ) ||
      descendantPull.headForcePushCount !== descendantPull.headForcePushes.length ||
      (latestForcePush !== undefined && latestForcePush.afterCommitSha !== descendantPull.headSha) ||
      descendantReactions?.length !== 1 ||
      (latestForcePush !== undefined && (descendantReactions[0]?.createdAt ?? '') <= latestForcePush.createdAt)
    ) {
      return remediationInvalid(`remediation ${record.remediationId} descendant review chain is incomplete`)
    }
    const finalDescendantHead = findReferencedCommit(evidence, descendant.finalHeadSha)
    if (finalDescendantHead === null) {
      return remediationInvalid(`remediation ${record.remediationId} descendant head evidence is missing`)
    }
    const pathsHold = validateRemediationCommitPaths({
      remediationId: record.remediationId,
      mergeCommit,
      mergeTreeSha: descendant.mergeTreeSha,
      mergePathBlobs: descendant.affectedPaths.map((path) => ({ path: path.path, blobSha: path.mergeBlobSha })),
      finalHead: finalDescendantHead,
      finalHeadSha: descendant.finalHeadSha,
      finalHeadTreeSha: descendant.finalHeadTreeSha,
      finalHeadPathBlobs: descendant.affectedPaths.map((path) => ({
        path: path.path,
        blobSha: path.finalHeadBlobSha,
      })),
    })
    if (pathsHold !== null) return pathsHold
  }
  const next = nextBaynCommit()
  if (next === null || 'status' in next) {
    return (
      next ?? remediationInvalid(`remediation ${record.remediationId} introduction is missing from source ancestry`)
    )
  }
  if (next.sha !== introduction.sha || comparison.commits[cursor - 1]?.sha !== introduction.sha) {
    return remediationInvalid(`remediation ${record.remediationId} is stale or omits a newer source commit`)
  }
  while (cursor < comparison.commits.length) {
    const commit = comparison.commits[cursor]
    if (commit === undefined || commit.parents.length !== 1 || commit.parents[0] !== expectedParent) {
      return remediationInvalid(`remediation ${record.remediationId} source ancestry is not a direct-parent chain`)
    }
    if (commit.files.some(isBaynReleaseAffectingPath)) {
      return remediationInvalid(`remediation ${record.remediationId} omits a newer Bayn source commit`)
    }
    expectedParent = commit.sha
    cursor += 1
  }
  if (expectedParent !== comparison.headSha) {
    return remediationInvalid(`remediation ${record.remediationId} does not reach the current source head`)
  }
  return null
}

export const evaluateBaynReleaseEligibility = (input: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly nowMs: number
  readonly pushBeforeSha: string | null
}): BaynReleaseEligibilityEvaluation => {
  if (
    input.pushBeforeSha !== null &&
    (input.snapshot.currentCommitParents.length !== 1 || input.snapshot.currentCommitParents[0] !== input.pushBeforeSha)
  ) {
    const parents =
      input.snapshot.currentCommitParents.length === 0
        ? 'no parents'
        : input.snapshot.currentCommitParents.map(shortSha).join(', ')
    return hold(
      'non-single-commit-main-push',
      `main push ${shortSha(input.pushBeforeSha)}..${shortSha(input.mainCommitSha)} is not one direct-parent commit; observed parent(s): ${parents}`,
      false,
    )
  }

  const published = input.snapshot.lastPublishedRevision
  if (published.status === 'missing') {
    return hold(
      'last-published-revision-missing',
      `no successful ${githubWorkflowFile} main push identifies the last published Bayn revision`,
      true,
    )
  }
  if (published.status === 'ambiguous') {
    return hold(
      'last-published-revision-ambiguous',
      `successful ${githubWorkflowFile} run number ${published.runNumber} identifies multiple published revisions: ${published.revisions.map(shortSha).join(', ')}`,
      false,
    )
  }

  const comparison = input.snapshot.comparison
  if (comparison === null) {
    return hold(
      'release-range-metadata-mismatch',
      `release range ${shortSha(published.revision)}..${shortSha(input.mainCommitSha)} was not loaded`,
      false,
    )
  }
  if (comparison.baseSha !== published.revision || comparison.headSha !== input.mainCommitSha) {
    return hold(
      'release-range-metadata-mismatch',
      `release range metadata does not bind published ${shortSha(published.revision)} to current ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }
  if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
    return hold(
      'last-published-revision-not-ancestor',
      `last published Bayn revision ${shortSha(published.revision)} is not an ancestor of current ${shortSha(input.mainCommitSha)}; GitHub comparison status is ${comparison.status}`,
      false,
    )
  }
  if (comparison.mergeBaseSha !== published.revision) {
    return hold(
      'last-published-revision-not-ancestor',
      `last published Bayn revision ${shortSha(published.revision)} is not the exact merge base of current ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }
  if (comparison.truncated || comparison.aheadBy > maximumReleaseRangeCommits) {
    return hold(
      'release-range-too-large',
      `release range ${shortSha(published.revision)}..${shortSha(input.mainCommitSha)} contains ${comparison.aheadBy} commit(s), exceeding the bounded limit of ${maximumReleaseRangeCommits}`,
      false,
    )
  }
  if (
    comparison.aheadBy !== comparison.totalCommits ||
    comparison.aheadBy !== comparison.commits.length ||
    (comparison.status === 'identical' && comparison.aheadBy !== 0) ||
    (comparison.status === 'ahead' && comparison.aheadBy === 0)
  ) {
    return hold(
      'release-range-metadata-mismatch',
      `release range reports aheadBy=${comparison.aheadBy}, totalCommits=${comparison.totalCommits}, loadedCommits=${comparison.commits.length}, status=${comparison.status}`,
      false,
    )
  }

  const commitShas = comparison.commits.map((commit) => commit.sha)
  if (new Set(commitShas).size !== commitShas.length) {
    return hold('release-range-metadata-mismatch', 'release range contains duplicate commit identities', false)
  }
  if (comparison.commits.length > 0 && comparison.commits.at(-1)?.sha !== input.mainCommitSha) {
    return hold(
      'release-range-metadata-mismatch',
      `release range does not end at current main commit ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }

  const affectingCommits = comparison.commits.filter((commit) => commit.files.some(isBaynReleaseAffectingPath))
  if (comparison.aheadBy > 0 && affectingCommits.length === 0) {
    return {
      status: 'eligible',
      lastPublishedRevision: published.revision,
      checkedCommitCount: comparison.commits.length,
      baynAffectingCommitCount: 0,
      reviewedPullRequests: [],
    }
  }

  const remediations = input.snapshot.remediations ?? []
  const normalReviews = new Map<string, BaynReleaseReviewEvaluation>()
  for (const commit of affectingCommits) {
    if (commit.reviewSnapshot === null) {
      return hold(
        'release-range-metadata-mismatch',
        `Bayn-affecting commit ${shortSha(commit.sha)} has no source review snapshot`,
        false,
      )
    }
    const review = evaluateBaynReleaseReview({
      mainCommitSha: commit.sha,
      baseRefName: input.baseRefName,
      snapshot: commit.reviewSnapshot,
      nowMs: input.nowMs,
      pushBeforeSha: null,
    })
    normalReviews.set(commit.sha, review)
  }

  const remediationIds = remediations.map((remediation) => remediation.record.remediationId)
  const blockedRemediationShas = remediations.map((remediation) => remediation.record.blocked.mergeCommitSha)
  const recordPaths = remediations.map((remediation) => remediation.recordPath)
  if (
    new Set(remediationIds).size !== remediationIds.length ||
    new Set(blockedRemediationShas).size !== blockedRemediationShas.length ||
    new Set(recordPaths).size !== recordPaths.length
  ) {
    return remediationInvalid('release review remediations contain duplicate identities or blocked commits')
  }

  const usedRemediationIds = new Set<string>()
  const coveredDescendantShas = new Set<string>()
  const reviewedPullRequests: BaynReleaseEligibilityEligible['reviewedPullRequests'][number][] = []
  for (const commit of affectingCommits) {
    const review = normalReviews.get(commit.sha)
    if (review === undefined) throw new Error(`missing normal review evaluation for ${commit.sha}`)
    const remediation = remediations.filter((candidate) => candidate.record.blocked.mergeCommitSha === commit.sha)
    if (review.status === 'hold' || remediation.length > 0) {
      if (review.status === 'hold') {
        if (coveredDescendantShas.has(commit.sha) && review.code === 'exact-head-review-missing') {
          const sourcePull = commit.reviewSnapshot?.pullRequest
          const reviewedAncestor = sourcePull?.reviews
            .filter(
              (candidate) =>
                candidate.authorLogin === baynCodexReviewer &&
                candidate.commitSha !== null &&
                candidate.submittedAt !== null &&
                eligibleReviewStates.has(candidate.state),
            )
            .toSorted((left, right) => (right.submittedAt as string).localeCompare(left.submittedAt as string))[0]
          if (
            sourcePull === null ||
            sourcePull === undefined ||
            reviewedAncestor?.submittedAt === null ||
            reviewedAncestor?.submittedAt === undefined
          ) {
            return remediationInvalid(`covered descendant ${shortSha(commit.sha)} review evidence is incomplete`)
          }
          reviewedPullRequests.push({
            commitSha: commit.sha,
            prNumber: sourcePull.number,
            headSha: sourcePull.headSha,
            reviewSubmittedAt: reviewedAncestor.submittedAt,
            eligibleAt: reviewedAncestor.submittedAt,
          })
          continue
        }
        if (review.code !== 'exact-head-review-missing') {
          return {
            ...review,
            message: `Bayn-affecting commit ${shortSha(commit.sha)} after last published ${shortSha(published.revision)} is not release-eligible: ${review.message}`,
          }
        }
      }
      if (remediation.length === 0) {
        const sourcePull = commit.reviewSnapshot?.pullRequest
        const reviewedAncestorDropped =
          sourcePull !== null &&
          sourcePull !== undefined &&
          sourcePull.headForcePushCount > 0 &&
          sourcePull.reviews.some(
            (candidate) =>
              candidate.authorLogin === baynCodexReviewer &&
              candidate.commitSha !== null &&
              !sourcePull.commitShas.includes(candidate.commitSha),
          )
        if (reviewedAncestorDropped) {
          return hold(
            'release-review-remediation-missing',
            `Bayn-affecting commit ${shortSha(commit.sha)} after last published ${shortSha(published.revision)} dropped its reviewed ancestor and has no reviewed remediation receipt`,
            false,
          )
        }
        return {
          ...review,
          message: `Bayn-affecting commit ${shortSha(commit.sha)} after last published ${shortSha(published.revision)} is not release-eligible: ${review.message}`,
        }
      }
      if (remediation.length !== 1 || remediation[0] === undefined) {
        return remediationInvalid(`Bayn-affecting commit ${shortSha(commit.sha)} has ambiguous remediation receipts`)
      }
      const remediationHold = validateReleaseReviewRemediation({
        evidence: remediation[0],
        blockedCommit: commit,
        comparison,
        normalReviews,
        nowMs: input.nowMs,
      })
      if (remediationHold !== null) return remediationHold
      usedRemediationIds.add(remediation[0].record.remediationId)
      for (const descendant of remediation[0].record.requiredDescendants) {
        coveredDescendantShas.add(descendant.mergeCommitSha)
      }
      for (const successor of remediation[0].record.requiredSuccessors ?? []) {
        coveredDescendantShas.add(successor.mergeCommitSha)
      }
      if (remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v3') {
        for (const descendant of [
          ...remediation[0].record.requiredDescendants,
          ...(remediation[0].record.requiredSuccessors ?? []),
        ]) {
          const descendantCommit = comparison.commits.find((candidate) => candidate.sha === descendant.mergeCommitSha)
          const descendantNormalReview = normalReviews.get(descendant.mergeCommitSha)
          if (descendantCommit === undefined || descendantNormalReview === undefined) {
            return remediationInvalid(
              `remediation ${remediation[0].record.remediationId} descendant review snapshot is missing`,
            )
          }
          const boundReview = evaluateBoundRemediationReview({
            remediationId: remediation[0].record.remediationId,
            commit: descendantCommit,
            identity: descendant,
            normalReview: descendantNormalReview,
            nowMs: input.nowMs,
          })
          if (boundReview.status === 'hold') return boundReview
          normalReviews.set(descendant.mergeCommitSha, boundReview)
        }
        const introductionIdentity = remediation[0].record.introduction
        const introductionCommit = comparison.commits.find(
          (candidate) => candidate.sha === introductionIdentity?.mergeCommitSha,
        )
        const introductionNormalReview =
          introductionIdentity === undefined ? undefined : normalReviews.get(introductionIdentity.mergeCommitSha)
        if (
          introductionIdentity === undefined ||
          introductionCommit === undefined ||
          introductionNormalReview === undefined
        ) {
          return remediationInvalid(
            `remediation ${remediation[0].record.remediationId} introduction review snapshot is missing`,
          )
        }
        const introductionReview = evaluateBoundRemediationReview({
          remediationId: remediation[0].record.remediationId,
          commit: introductionCommit,
          identity: introductionIdentity,
          normalReview: introductionNormalReview,
          nowMs: input.nowMs,
        })
        if (introductionReview.status === 'hold') return introductionReview
        normalReviews.set(introductionIdentity.mergeCommitSha, introductionReview)
        coveredDescendantShas.add(introductionIdentity.mergeCommitSha)
      }
      if (
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v6' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v7' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v8' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v9'
      ) {
        const successorIdentity = remediation[0].record.requiredSuccessors[0]
        const successorCommit = comparison.commits.find(
          (candidate) => candidate.sha === successorIdentity.mergeCommitSha,
        )
        const successorNormalReview = normalReviews.get(successorIdentity.mergeCommitSha)
        if (successorCommit === undefined || successorNormalReview === undefined) {
          return remediationInvalid(
            `remediation ${remediation[0].record.remediationId} successor review snapshot is missing`,
          )
        }
        const successorReview = evaluateBoundRemediationReview({
          remediationId: remediation[0].record.remediationId,
          commit: successorCommit,
          identity: successorIdentity,
          normalReview: successorNormalReview,
          nowMs: input.nowMs,
        })
        if (successorReview.status === 'hold') return successorReview
        normalReviews.set(successorIdentity.mergeCommitSha, successorReview)
        coveredDescendantShas.add(successorIdentity.mergeCommitSha)
      }

      if (
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v5' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v6' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v8' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v9'
      ) {
        const introductionIdentity = remediation[0].record.introduction
        const introductionCommit = comparison.commits.find(
          (candidate) => candidate.sha === introductionIdentity.mergeCommitSha,
        )
        const introductionNormalReview = normalReviews.get(introductionIdentity.mergeCommitSha)
        if (introductionCommit === undefined || introductionNormalReview === undefined) {
          return remediationInvalid(
            `remediation ${remediation[0].record.remediationId} introduction review snapshot is missing`,
          )
        }
        const introductionReview = evaluateBoundRemediationReview({
          remediationId: remediation[0].record.remediationId,
          commit: introductionCommit,
          identity: introductionIdentity,
          normalReview: introductionNormalReview,
          nowMs: input.nowMs,
        })
        if (introductionReview.status === 'hold') return introductionReview
        normalReviews.set(introductionIdentity.mergeCommitSha, introductionReview)
        coveredDescendantShas.add(introductionIdentity.mergeCommitSha)

        if (
          remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v6' ||
          remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v9'
        ) {
          const completionIdentity = remediation[0].record.completion
          const completionCommit = comparison.commits.find(
            (candidate) => candidate.sha === completionIdentity.mergeCommitSha,
          )
          const completionNormalReview = normalReviews.get(completionIdentity.mergeCommitSha)
          if (completionCommit === undefined || completionNormalReview === undefined) {
            return remediationInvalid(
              `remediation ${remediation[0].record.remediationId} completion review snapshot is missing`,
            )
          }
          const completionReview = evaluateBoundRemediationReview({
            remediationId: remediation[0].record.remediationId,
            commit: completionCommit,
            identity: completionIdentity,
            normalReview: completionNormalReview,
            nowMs: input.nowMs,
          })
          if (completionReview.status === 'hold') return completionReview
          normalReviews.set(completionIdentity.mergeCommitSha, completionReview)
          coveredDescendantShas.add(completionIdentity.mergeCommitSha)
        }
      }
      if (
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v4' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v5' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v6' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v7' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v8' ||
        remediation[0].record.schemaVersion === 'bayn.release-review-remediation.v9'
      ) {
        const record = remediation[0].record
        if (
          record.schemaVersion === 'bayn.release-review-remediation.v7' ||
          record.schemaVersion === 'bayn.release-review-remediation.v8' ||
          record.schemaVersion === 'bayn.release-review-remediation.v9'
        ) {
          const successorReview = normalReviews.get(record.requiredSuccessors[0].mergeCommitSha)
          if (successorReview?.status !== 'eligible') {
            return remediationInvalid(`remediation ${record.remediationId} reviewed successor is not eligible`)
          }
          reviewedPullRequests.push({
            commitSha: commit.sha,
            prNumber: successorReview.prNumber,
            headSha: successorReview.headSha,
            reviewSubmittedAt: successorReview.reviewSubmittedAt,
            eligibleAt: successorReview.eligibleAt,
          })
          continue
        }
        const continuousReview = evaluateBoundRemediationReview({
          remediationId: record.remediationId,
          commit,
          identity: {
            mergeCommitSha: record.blocked.mergeCommitSha,
            sourcePullRequestNumber: record.blocked.sourcePullRequestNumber,
            finalHeadSha: record.blocked.finalHeadSha,
            sourcePullRequestEvidenceSha256: record.blocked.sourcePullRequestEvidenceSha256,
          },
          normalReview: review,
          nowMs: input.nowMs,
        })
        if (continuousReview.status === 'hold') return continuousReview
        reviewedPullRequests.push({
          commitSha: commit.sha,
          prNumber: continuousReview.prNumber,
          headSha: continuousReview.headSha,
          reviewSubmittedAt: continuousReview.reviewSubmittedAt,
          eligibleAt: continuousReview.eligibleAt,
        })
        continue
      }
      const legacyRecord = remediation[0].record
      const sourcePull = commit.reviewSnapshot?.pullRequest
      if (sourcePull === null || sourcePull === undefined) {
        return remediationInvalid(`remediated commit ${shortSha(commit.sha)} source PR metadata is missing`)
      }
      const reviewedAncestor = sourcePull.reviews.find(
        (candidate) =>
          candidate.authorLogin === baynCodexReviewer &&
          candidate.commitSha === legacyRecord.blocked.reviewedHeadSha &&
          candidate.submittedAt !== null,
      )
      if (reviewedAncestor?.submittedAt === null || reviewedAncestor?.submittedAt === undefined) {
        return remediationInvalid(`remediated commit ${shortSha(commit.sha)} reviewed ancestor timestamp is missing`)
      }
      reviewedPullRequests.push({
        commitSha: commit.sha,
        prNumber: sourcePull.number,
        headSha: sourcePull.headSha,
        reviewSubmittedAt: reviewedAncestor.submittedAt,
        eligibleAt: reviewedAncestor.submittedAt,
      })
      continue
    }
    reviewedPullRequests.push({
      commitSha: commit.sha,
      prNumber: review.prNumber,
      headSha: review.headSha,
      reviewSubmittedAt: review.reviewSubmittedAt,
      eligibleAt: review.eligibleAt,
    })
  }
  if (usedRemediationIds.size !== remediations.length) {
    return remediationInvalid('release review range contains unused, stale, or cyclic remediation receipts')
  }

  return {
    status: 'eligible',
    lastPublishedRevision: published.revision,
    checkedCommitCount: comparison.commits.length,
    baynAffectingCommitCount: affectingCommits.length,
    reviewedPullRequests,
  }
}

const baynAffectingCommits = (snapshot: BaynReleaseEligibilitySnapshot): readonly BaynReleaseRangeCommit[] =>
  snapshot.comparison?.commits.filter((commit) => commit.files.some(isBaynReleaseAffectingPath)) ?? []

const failedReviewRunMatches = (evidence: FailedBaynReleaseReviewRun, sourceCommitSha: string): boolean => {
  const { run, jobs } = evidence
  const reviewJobs = jobs.filter((job) => job.name === 'Verify exact-head Codex review')
  const imageJobs = jobs.filter((job) => job.name === 'image')
  return (
    run.headSha === sourceCommitSha &&
    run.headBranch === 'main' &&
    run.event === 'push' &&
    run.status === 'completed' &&
    run.conclusion === 'failure' &&
    reviewJobs.length === 1 &&
    reviewJobs[0]?.status === 'completed' &&
    reviewJobs[0]?.conclusion === 'failure' &&
    imageJobs.length === 1 &&
    imageJobs[0]?.status === 'completed' &&
    imageJobs[0]?.conclusion === 'skipped'
  )
}

export const evaluateBaynReleaseRetry = (input: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly snapshot: BaynReleaseRetrySnapshot
  readonly trigger: BaynReleaseRetryTrigger
  readonly nowMs: number
}): BaynReleaseRetryEvaluation => {
  if (input.snapshot.defaultBranchSha !== input.mainCommitSha) {
    return hold(
      'retry-default-branch-mismatch',
      `trusted default branch is ${shortSha(input.snapshot.defaultBranchSha)}, not requested retry main ${shortSha(input.mainCommitSha)}`,
      true,
    )
  }

  if (
    input.snapshot.publicationSucceeded ||
    (input.snapshot.lastPublishedRevision.status === 'resolved' &&
      input.snapshot.lastPublishedRevision.revision === input.mainCommitSha)
  ) {
    return {
      status: 'noop',
      code: 'retry-already-published',
      message: `current main ${shortSha(input.mainCommitSha)} already has a successful Bayn publication`,
    }
  }
  if (
    input.snapshot.lastPublishedRevision.status === 'resolved' &&
    input.snapshot.comparison !== null &&
    (input.snapshot.comparison.status === 'ahead' || input.snapshot.comparison.status === 'identical') &&
    input.snapshot.comparison.commits.every((commit) => !commit.files.some(isBaynReleaseAffectingPath))
  ) {
    return {
      status: 'noop',
      code: 'retry-already-published',
      message: `no Bayn-affecting commit exists after successful publication ${shortSha(input.snapshot.lastPublishedRevision.revision)}`,
    }
  }

  const eligibility = evaluateBaynReleaseEligibility({
    mainCommitSha: input.mainCommitSha,
    baseRefName: input.baseRefName,
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    pushBeforeSha: null,
  })
  if (eligibility.status === 'hold') {
    return eligibility.retryable
      ? {
          status: 'noop',
          code: 'retry-attestation-not-ready',
          message: eligibility.message,
        }
      : eligibility
  }

  const failedReviewRun = input.snapshot.failedReviewRun
  if (failedReviewRun === null) {
    return hold(
      'retry-failed-run-missing',
      `current main ${shortSha(input.mainCommitSha)} has no completed failed Bayn push run to retry`,
      true,
    )
  }
  if (!failedReviewRunMatches(failedReviewRun, input.mainCommitSha)) {
    return hold(
      'retry-failed-run-mismatch',
      `Bayn run ${failedReviewRun.run.id} does not prove an exact failed review gate with a skipped image for current main ${shortSha(input.mainCommitSha)}`,
      false,
    )
  }
  const failedReviewJob = failedReviewRun.jobs.find((job) => job.name === 'Verify exact-head Codex review')
  const failedAtMs = Date.parse(failedReviewJob?.completedAt ?? '')
  if (!Number.isFinite(failedAtMs)) {
    return hold(
      'retry-failed-run-mismatch',
      `Bayn run ${failedReviewRun.run.id} review gate has an invalid completion timestamp`,
      false,
    )
  }

  const affectingCommits = baynAffectingCommits(input.snapshot)
  const reviewThreadBlock = failedReviewRun.reviewThreadBlock
  let resolvedThreadCommitSha: string | null = null
  if (reviewThreadBlock !== null) {
    const blockedCommits = affectingCommits.filter(
      (commit) =>
        commit.sha.startsWith(reviewThreadBlock.commitShaPrefix) &&
        commit.reviewSnapshot?.pullRequest?.number === reviewThreadBlock.prNumber,
    )
    if (blockedCommits.length !== 1) {
      return hold(
        'retry-failed-run-mismatch',
        `failed run ${failedReviewRun.run.id} review-thread evidence does not uniquely bind current range commit ${reviewThreadBlock.commitShaPrefix}/#${reviewThreadBlock.prNumber}`,
        false,
      )
    }
    resolvedThreadCommitSha = blockedCommits[0]?.sha ?? null
  }
  const delayedCandidates = eligibility.reviewedPullRequests.flatMap((reviewed) => {
    const eligibleAtMs = Date.parse(reviewed.eligibleAt)
    const delayedByEligibilityTime = Number.isFinite(eligibleAtMs) && eligibleAtMs >= failedAtMs
    const delayedByResolvedThread =
      reviewed.commitSha === resolvedThreadCommitSha && Number.isFinite(input.nowMs) && input.nowMs >= failedAtMs
    if (!delayedByEligibilityTime && !delayedByResolvedThread) return []
    const commit = affectingCommits.find((candidate) => candidate.sha === reviewed.commitSha)
    const pullRequest = commit?.reviewSnapshot?.pullRequest
    if (
      commit === undefined ||
      pullRequest === null ||
      pullRequest === undefined ||
      pullRequest.number !== reviewed.prNumber ||
      pullRequest.headSha !== reviewed.headSha
    ) {
      return []
    }
    return [{ commit, pullRequest, reviewed }]
  })

  let triggerCandidates = delayedCandidates
  if (input.trigger.type === 'issue-comment') {
    const triggerPrNumber = input.trigger.prNumber
    triggerCandidates = delayedCandidates.filter((candidate) => candidate.pullRequest.number === triggerPrNumber)
  } else if (input.trigger.type === 'workflow-dispatch') {
    const trigger = input.trigger
    triggerCandidates = delayedCandidates.filter(
      (candidate) =>
        candidate.commit.sha === trigger.sourceCommitSha &&
        candidate.pullRequest.number === trigger.prNumber &&
        candidate.pullRequest.headSha === trigger.headSha,
    )
  }
  if (triggerCandidates.length === 0) {
    return hold(
      'retry-attestation-not-delayed',
      `no exact Bayn source attestation matching the retry trigger is newer than failed run ${failedReviewRun.run.id}`,
      true,
    )
  }
  if (triggerCandidates.length > 1) {
    return hold(
      'retry-delayed-source-ambiguous',
      `failed run ${failedReviewRun.run.id} has multiple delayed Bayn source attestations matching the retry trigger: ${triggerCandidates.map(({ commit, pullRequest }) => `${shortSha(commit.sha)}/#${pullRequest.number}`).join(', ')}`,
      false,
    )
  }
  const selected = triggerCandidates[0]
  if (selected === undefined) throw new Error('delayed retry candidate selection was unexpectedly empty')
  const sourceCommit = selected.commit
  const sourcePull = selected.pullRequest
  if (sourcePull.headForcePushCount !== 0) {
    return hold(
      'retry-source-pr-force-pushed',
      `source PR #${sourcePull.number} final head ${shortSha(sourcePull.headSha)} has ${sourcePull.headForcePushCount} force-push event(s) and is ineligible for unattended retry`,
      false,
    )
  }

  if (input.trigger.type === 'issue-comment') {
    if (input.trigger.actorLogin !== baynCodexBotLogin) {
      return hold(
        'retry-trigger-mismatch',
        `issue-comment retry trigger does not match connector identity and source PR #${sourcePull.number}`,
        false,
      )
    }
  } else if (input.trigger.type === 'workflow-dispatch') {
    if (
      input.trigger.sourceCommitSha !== sourceCommit.sha ||
      input.trigger.prNumber !== sourcePull.number ||
      input.trigger.headSha !== sourcePull.headSha ||
      input.trigger.failedRunId !== failedReviewRun.run.id
    ) {
      return hold(
        'retry-trigger-mismatch',
        `workflow dispatch binding does not match source ${shortSha(sourceCommit.sha)}, PR #${sourcePull.number}, head ${shortSha(sourcePull.headSha)}, and failed run ${failedReviewRun.run.id}`,
        false,
      )
    }
  }

  if (input.trigger.type !== 'workflow-dispatch' && input.snapshot.retryInProgress) {
    return {
      status: 'noop',
      code: 'retry-in-progress',
      message: `a Bayn workflow-dispatch retry is already queued or running for current main ${shortSha(input.mainCommitSha)}`,
    }
  }

  return {
    status: 'dispatch',
    currentMainSha: input.mainCommitSha,
    sourceCommitSha: sourceCommit.sha,
    prNumber: sourcePull.number,
    headSha: sourcePull.headSha,
    failedRunId: failedReviewRun.run.id,
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const apiErrorHold = (error: unknown): BaynReleaseReviewHold => {
  if (error instanceof GitHubReleaseReviewError) {
    const status = error.status === null ? '' : ` (HTTP ${error.status})`
    return hold(error.code, `${error.code} while ${error.operation}${status}`, true)
  }
  const name = error instanceof Error ? error.name : typeof error
  return hold('unexpected-verifier-error', `unexpected verifier failure of type ${name}`, true)
}

export const pollBaynReleaseReview = async (options: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly loadSnapshot: () => Promise<BaynReleaseReviewSnapshot>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
  readonly pushBeforeSha?: string | null
}): Promise<BaynReleaseReviewPollResult> => {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  let lastHold: BaynReleaseReviewHold | null = null

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let evaluation: BaynReleaseReviewEvaluation
    try {
      evaluation = evaluateBaynReleaseReview({
        mainCommitSha: options.mainCommitSha,
        baseRefName: options.baseRefName,
        snapshot: await options.loadSnapshot(),
        nowMs: now(),
        pushBeforeSha: options.pushBeforeSha ?? null,
      })
    } catch (error) {
      evaluation = apiErrorHold(error)
    }

    if (evaluation.status === 'eligible') return { ...evaluation, attempts: attempt, timedOut: false }
    lastHold = evaluation
    if (!evaluation.retryable) return { ...evaluation, attempts: attempt, timedOut: false }
    if (attempt < options.maxAttempts) await sleep(options.pollIntervalMs)
  }

  if (lastHold === null) throw new Error('release review poll completed without an evaluation')
  return {
    ...lastHold,
    message: `${lastHold.message}; bounded wait exhausted after ${options.maxAttempts} attempt(s)`,
    attempts: options.maxAttempts,
    timedOut: true,
  }
}

export const pollBaynReleaseEligibility = async (options: {
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly pushBeforeSha: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly loadSnapshot: () => Promise<BaynReleaseEligibilitySnapshot>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
}): Promise<BaynReleaseEligibilityPollResult> => {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  let lastHold: BaynReleaseReviewHold | null = null

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    let evaluation: BaynReleaseEligibilityEvaluation
    try {
      evaluation = evaluateBaynReleaseEligibility({
        mainCommitSha: options.mainCommitSha,
        baseRefName: options.baseRefName,
        snapshot: await options.loadSnapshot(),
        nowMs: now(),
        pushBeforeSha: options.pushBeforeSha,
      })
    } catch (error) {
      evaluation = apiErrorHold(error)
    }

    if (evaluation.status === 'eligible') return { ...evaluation, attempts: attempt, timedOut: false }
    lastHold = evaluation
    if (!evaluation.retryable) return { ...evaluation, attempts: attempt, timedOut: false }
    if (attempt < options.maxAttempts) await sleep(options.pollIntervalMs)
  }

  if (lastHold === null) throw new Error('release eligibility poll completed without an evaluation')
  return {
    ...lastHold,
    message: `${lastHold.message}; bounded wait exhausted after ${options.maxAttempts} attempt(s)`,
    attempts: options.maxAttempts,
    timedOut: true,
  }
}

const expectRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value as Record<string, unknown>
}

const expectString = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value
}

const expectAnyString = (value: unknown, context: string): string => {
  if (typeof value !== 'string') throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return value
}

const expectSha = (value: unknown, context: string): string => {
  const sha = expectString(value, context)
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return sha
}

const expectNullableString = (value: unknown, context: string): string | null => {
  if (value === null) return null
  return expectString(value, context)
}

const expectBoolean = (value: unknown, context: string): boolean => {
  if (typeof value !== 'boolean') throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  return value
}

const expectInteger = (value: unknown, context: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', context)
  }
  return value
}

interface GitHubJsonResponse {
  readonly value: unknown
  readonly headers: Headers
}

const requestGitHubJson = async (options: {
  readonly url: string
  readonly operation: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly method?: 'GET' | 'POST'
  readonly body?: string
  readonly fetchFn: typeof fetch
}): Promise<GitHubJsonResponse> => {
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

const requestGitHubText = async (options: {
  readonly url: string
  readonly operation: string
  readonly token: string
  readonly requestTimeoutMs: number
  readonly maximumBytes: number
  readonly fetchFn: typeof fetch
}): Promise<string> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs)
  const readBoundedText = async (response: Response): Promise<string> => {
    const declaredLength = response.headers.get('content-length')
    const parsedLength = declaredLength === null ? null : Number(declaredLength)
    if (parsedLength !== null && (!Number.isFinite(parsedLength) || parsedLength > options.maximumBytes)) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', `${options.operation} size`)
    }
    if (response.body === null) {
      throw new GitHubReleaseReviewError('github-api-invalid-response', `${options.operation} body`)
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > options.maximumBytes) {
        await reader.cancel()
        throw new GitHubReleaseReviewError('github-api-invalid-response', `${options.operation} size`)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  }
  try {
    const response = await options.fetchFn(options.url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'User-Agent': 'bayn-release-review-gate',
        'X-GitHub-Api-Version': githubApiVersion,
      },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) {
        throw new GitHubReleaseReviewError('github-api-invalid-response', `${options.operation} redirect`)
      }
      let downloadUrl: URL
      try {
        downloadUrl = new URL(location)
      } catch (error) {
        throw new GitHubReleaseReviewError('github-api-invalid-response', `${options.operation} redirect`, {
          cause: error,
        })
      }
      if (
        downloadUrl.protocol !== 'https:' ||
        (!downloadUrl.hostname.endsWith('.blob.core.windows.net') &&
          downloadUrl.hostname !== 'pipelines.actions.githubusercontent.com')
      ) {
        throw new GitHubReleaseReviewError('github-api-invalid-response', `${options.operation} redirect host`)
      }
      const download = await options.fetchFn(downloadUrl, {
        signal: controller.signal,
        redirect: 'error',
      })
      if (!download.ok) {
        throw new GitHubReleaseReviewError('github-api-error', options.operation, { status: download.status })
      }
      return await readBoundedText(download)
    }
    if (!response.ok) {
      throw new GitHubReleaseReviewError('github-api-error', options.operation, { status: response.status })
    }
    return await readBoundedText(response)
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
  const response = await requestGitHubJson({
    url: githubGraphqlUrl,
    operation: options.operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
    method: 'POST',
    body: JSON.stringify({ query: options.query, variables: options.variables }),
  })
  const payload = expectRecord(response.value, options.operation)
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new GitHubReleaseReviewError('github-api-error', options.operation)
  }
  return expectRecord(payload.data, options.operation)
}

const parseAssociatedPullRequests = (value: unknown): readonly AssociatedPullRequest[] => {
  if (!Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list associated pull requests')
  }
  return value.map((item, index) => {
    const pullRequest = expectRecord(item, `associated pull request ${index}`)
    const base = expectRecord(pullRequest.base, `associated pull request ${index} base`)
    const head = expectRecord(pullRequest.head, `associated pull request ${index} head`)
    return {
      number: expectInteger(pullRequest.number, `associated pull request ${index} number`),
      baseRefName: expectString(base.ref, `associated pull request ${index} base ref`),
      headSha: expectString(head.sha, `associated pull request ${index} head SHA`),
      mergeCommitSha: expectNullableString(
        pullRequest.merge_commit_sha,
        `associated pull request ${index} merge commit SHA`,
      ),
      mergedAt: expectNullableString(pullRequest.merged_at, `associated pull request ${index} merged at`),
    }
  })
}

const parsePullRequestIssueComments = (value: unknown): readonly PullRequestIssueComment[] => {
  if (!Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list source PR issue comments')
  }
  return value.map((item, index) => {
    const comment = expectRecord(item, `source PR issue comment ${index}`)
    const user = comment.user === null ? null : expectRecord(comment.user, `source PR issue comment ${index} user`)
    return {
      authorLogin: user === null ? null : expectString(user.login, `source PR issue comment ${index} user login`),
      body: expectAnyString(comment.body, `source PR issue comment ${index} body`),
      createdAt: expectString(comment.created_at, `source PR issue comment ${index} created at`),
      updatedAt: expectString(comment.updated_at, `source PR issue comment ${index} updated at`),
    }
  })
}

const parsePullRequestReactions = (value: unknown): readonly PullRequestReaction[] => {
  if (!Array.isArray(value)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list source PR reactions')
  }
  return value.map((item, index) => {
    const reaction = expectRecord(item, `source PR reaction ${index}`)
    const user = reaction.user === null ? null : expectRecord(reaction.user, `source PR reaction ${index} user`)
    return {
      userLogin: user === null ? null : expectString(user.login, `source PR reaction ${index} user login`),
      content: expectString(reaction.content, `source PR reaction ${index} content`),
      createdAt: expectString(reaction.created_at, `source PR reaction ${index} created at`),
    }
  })
}

const parseSuccessfulPublishRuns = (value: unknown): readonly SuccessfulPublishRun[] => {
  const payload = expectRecord(value, 'list successful Bayn publish runs')
  if (!Array.isArray(payload.workflow_runs)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list successful Bayn publish runs')
  }
  return payload.workflow_runs.flatMap((item, index) => {
    const run = expectRecord(item, `successful Bayn publish run ${index}`)
    const parsed: SuccessfulPublishRun = {
      id: expectInteger(run.id, `successful Bayn publish run ${index} ID`),
      runNumber: expectInteger(run.run_number, `successful Bayn publish run ${index} number`),
      runAttempt: expectInteger(run.run_attempt, `successful Bayn publish run ${index} attempt`),
      headSha: expectSha(run.head_sha, `successful Bayn publish run ${index} head SHA`),
      headBranch: expectString(run.head_branch, `successful Bayn publish run ${index} head branch`),
      event: expectString(run.event, `successful Bayn publish run ${index} event`),
      status: expectString(run.status, `successful Bayn publish run ${index} status`),
      conclusion: expectString(run.conclusion, `successful Bayn publish run ${index} conclusion`),
    }
    return parsed.headBranch === 'main' &&
      (parsed.event === 'push' || parsed.event === 'workflow_dispatch') &&
      parsed.status === 'completed' &&
      parsed.conclusion === 'success'
      ? [parsed]
      : []
  })
}

const parseBaynBuildWorkflowRuns = (value: unknown): readonly BaynBuildWorkflowRun[] => {
  const payload = expectRecord(value, 'list Bayn build workflow runs')
  if (!Array.isArray(payload.workflow_runs)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list Bayn build workflow runs')
  }
  return payload.workflow_runs.map((item, index) => {
    const run = expectRecord(item, `Bayn build workflow run ${index}`)
    return {
      id: expectInteger(run.id, `Bayn build workflow run ${index} ID`),
      runNumber: expectInteger(run.run_number, `Bayn build workflow run ${index} number`),
      runAttempt: expectInteger(run.run_attempt, `Bayn build workflow run ${index} attempt`),
      headSha: expectSha(run.head_sha, `Bayn build workflow run ${index} head SHA`),
      headBranch: expectString(run.head_branch, `Bayn build workflow run ${index} head branch`),
      event: expectString(run.event, `Bayn build workflow run ${index} event`),
      status: expectString(run.status, `Bayn build workflow run ${index} status`),
      conclusion: expectNullableString(run.conclusion, `Bayn build workflow run ${index} conclusion`),
      createdAt: expectString(run.created_at, `Bayn build workflow run ${index} created at`),
      updatedAt: expectString(run.updated_at, `Bayn build workflow run ${index} updated at`),
    }
  })
}

const parseBaynBuildWorkflowJobs = (value: unknown): readonly BaynBuildWorkflowJob[] => {
  const payload = expectRecord(value, 'list Bayn build workflow jobs')
  if (!Array.isArray(payload.jobs)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'list Bayn build workflow jobs')
  }
  return payload.jobs.map((item, index) => {
    const job = expectRecord(item, `Bayn build workflow job ${index}`)
    return {
      id: expectInteger(job.id, `Bayn build workflow job ${index} ID`),
      name: expectString(job.name, `Bayn build workflow job ${index} name`),
      status: expectString(job.status, `Bayn build workflow job ${index} status`),
      conclusion: expectNullableString(job.conclusion, `Bayn build workflow job ${index} conclusion`),
      completedAt: expectNullableString(job.completed_at, `Bayn build workflow job ${index} completed at`),
    }
  })
}

export const parseFailedReviewThreadBlock = (log: string): FailedReviewThreadBlock | null => {
  const patterns = [
    /BAYN_RELEASE_REVIEW_HOLD active-unresolved-review-threads: Bayn-affecting commit ([0-9a-f]{12}) .*? source PR #(\d+) has \d+ unresolved review thread\(s\):/g,
    /BAYN_RELEASE_REVIEW_HOLD feedback-fix-attestation-missing: Bayn-affecting commit ([0-9a-f]{12}) .*? source PR #(\d+) final head [0-9a-f]{12} carries review from [0-9a-f]{12}, but post-review commit [0-9a-f]{12} lacks a trusted member reply on a resolved Codex thread from that review/g,
  ]
  const matches = patterns.flatMap((pattern) =>
    [...log.matchAll(pattern)].map((match) => ({
      commitShaPrefix: match[1] as string,
      prNumber: Number(match[2]),
    })),
  )
  if (matches.length === 0) return null
  const unique = new Map(matches.map((match) => [`${match.commitShaPrefix}/#${match.prNumber}`, match]))
  if (unique.size !== 1) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'parse failed Bayn review-gate log')
  }
  return unique.values().next().value ?? null
}

export const loadOptionalFailedReviewThreadBlock = async (
  loadLog: () => Promise<string>,
): Promise<FailedReviewThreadBlock | null> => {
  try {
    return parseFailedReviewThreadBlock(await loadLog())
  } catch (error) {
    if (error instanceof GitHubReleaseReviewError && (error.status === 404 || error.status === 410)) return null
    throw error
  }
}

interface ParsedComparison {
  readonly status: string
  readonly baseSha: string
  readonly mergeBaseSha: string
  readonly aheadBy: number
  readonly totalCommits: number
  readonly commitShas: readonly string[]
}

const parseComparison = (value: unknown): ParsedComparison => {
  const comparison = expectRecord(value, 'compare last published Bayn revision to current main')
  const baseCommit = expectRecord(comparison.base_commit, 'comparison base commit')
  const mergeBaseCommit = expectRecord(comparison.merge_base_commit, 'comparison merge base commit')
  if (!Array.isArray(comparison.commits)) {
    throw new GitHubReleaseReviewError(
      'github-api-invalid-response',
      'compare last published Bayn revision to current main commits',
    )
  }
  return {
    status: expectString(comparison.status, 'comparison status'),
    baseSha: expectSha(baseCommit.sha, 'comparison base commit SHA'),
    mergeBaseSha: expectSha(mergeBaseCommit.sha, 'comparison merge base commit SHA'),
    aheadBy: expectInteger(comparison.ahead_by, 'comparison ahead count'),
    totalCommits: expectInteger(comparison.total_commits, 'comparison total commit count'),
    commitShas: comparison.commits.map((item, index) => {
      const commit = expectRecord(item, `comparison commit ${index}`)
      return expectSha(commit.sha, `comparison commit ${index} SHA`)
    }),
  }
}

interface CommitDetail {
  readonly sha: string
  readonly parents: readonly string[]
  readonly treeSha: string
  readonly files: readonly string[]
  readonly fileChanges: readonly BaynReleaseCommitFileChange[]
}

const parseCommitDetail = (value: unknown, expectedSha: string): CommitDetail => {
  const commit = expectRecord(value, `read commit ${shortSha(expectedSha)}`)
  const sha = expectSha(commit.sha, `commit ${shortSha(expectedSha)} SHA`)
  if (sha !== expectedSha) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `read commit ${shortSha(expectedSha)} identity`)
  }
  if (!Array.isArray(commit.parents) || !Array.isArray(commit.files)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', `read commit ${shortSha(expectedSha)} detail`)
  }
  const commitMetadata =
    commit.commit === undefined ? null : expectRecord(commit.commit, `commit ${shortSha(expectedSha)} metadata`)
  const tree =
    commitMetadata === null || commitMetadata.tree === undefined
      ? null
      : expectRecord(commitMetadata.tree, `commit ${shortSha(expectedSha)} tree`)
  const fileChanges = commit.files.map((item, index): BaynReleaseCommitFileChange => {
    const file = expectRecord(item, `commit ${shortSha(expectedSha)} file ${index}`)
    return {
      path: expectString(file.filename, `commit ${shortSha(expectedSha)} file ${index} path`),
      previousPath:
        file.previous_filename === undefined
          ? null
          : expectString(file.previous_filename, `commit ${shortSha(expectedSha)} file ${index} previous path`),
      status:
        file.status === undefined
          ? 'unknown'
          : expectString(file.status, `commit ${shortSha(expectedSha)} file ${index} status`),
      blobSha:
        file.sha === undefined || file.sha === null
          ? null
          : expectSha(file.sha, `commit ${shortSha(expectedSha)} file ${index} blob SHA`),
    }
  })
  return {
    sha,
    treeSha: tree === null ? '' : expectSha(tree.sha, `commit ${shortSha(expectedSha)} tree SHA`),
    parents: commit.parents.map((item, index) => {
      const parent = expectRecord(item, `commit ${shortSha(expectedSha)} parent ${index}`)
      return expectSha(parent.sha, `commit ${shortSha(expectedSha)} parent ${index} SHA`)
    }),
    files: fileChanges.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath])),
    fileChanges,
  }
}

const mapWithConcurrency = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> => {
  const output: Output[] = Array.from({ length: values.length })
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value === undefined) throw new Error(`missing concurrency input ${index}`)
      output[index] = await map(value, index)
    }
  })
  await Promise.all(workers)
  return output
}

const pullRequestMetadataQuery = `
  query BaynReleasePullRequestMetadata($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        baseRefName
        headRefOid
        createdAt
        mergedAt
        mergeCommit { oid }
        timelineItems(first: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            __typename
            ... on HeadRefForcePushedEvent {
              createdAt
              actor { login }
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

const pullRequestReviewsQuery = `
  query BaynReleasePullRequestReviews($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $cursor) {
          nodes {
            author { login }
            commit { oid }
            submittedAt
            state
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const pullRequestThreadsQuery = `
  query BaynReleasePullRequestThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            path
            comments(first: 100) {
              nodes {
                author { login }
                authorAssociation
                body
                createdAt
                commit { oid }
                pullRequestReview {
                  author { login }
                  commit { oid }
                  submittedAt
                  state
                }
                url
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const pullRequestCommitsQuery = `
  query BaynReleasePullRequestCommits($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        commits(first: 100, after: $cursor) {
          nodes { commit { oid } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`

const graphqlPullRequest = (data: Record<string, unknown>, operation: string): Record<string, unknown> => {
  const repository = expectRecord(data.repository, operation)
  return expectRecord(repository.pullRequest, operation)
}

const parsePageInfo = (
  connection: Record<string, unknown>,
  operation: string,
): { readonly hasNextPage: boolean; readonly endCursor: string | null } => {
  const pageInfo = expectRecord(connection.pageInfo, `${operation} page info`)
  return {
    hasNextPage: expectBoolean(pageInfo.hasNextPage, `${operation} has next page`),
    endCursor: expectNullableString(pageInfo.endCursor, `${operation} end cursor`),
  }
}

const fetchPullRequestMetadata = async (options: GitHubLoaderOptions, pullNumber: number) => {
  const data = await requestGraphql({
    query: pullRequestMetadataQuery,
    variables: { owner: options.owner, name: options.name, number: pullNumber },
    operation: `read source PR #${pullNumber} metadata`,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const pullRequest = graphqlPullRequest(data, `read source PR #${pullNumber} metadata`)
  const mergeCommit = pullRequest.mergeCommit === null ? null : expectRecord(pullRequest.mergeCommit, 'merge commit')
  const timelineItems = expectRecord(pullRequest.timelineItems, 'source PR head-force-push history')
  if (!Array.isArray(timelineItems.nodes)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', 'source PR head-force-push history')
  }
  const timelinePageInfo = parsePageInfo(timelineItems, 'source PR head-force-push history')
  if (timelinePageInfo.hasNextPage) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', 'source PR head-force-push history')
  }
  const headForcePushes = timelineItems.nodes.map((item, index): PullRequestForcePush => {
    const event = expectRecord(item, `source PR head-force-push event ${index}`)
    if (event.__typename !== 'HeadRefForcePushedEvent') {
      throw new GitHubReleaseReviewError('github-api-invalid-response', `source PR head-force-push event ${index}`)
    }
    const actor = event.actor === null ? null : expectRecord(event.actor, `source PR force-push actor ${index}`)
    const beforeCommit = expectRecord(event.beforeCommit, `source PR force-push before commit ${index}`)
    const afterCommit = expectRecord(event.afterCommit, `source PR force-push after commit ${index}`)
    return {
      actorLogin: actor === null ? null : expectString(actor.login, `source PR force-push actor login ${index}`),
      beforeCommitSha: expectSha(beforeCommit.oid, `source PR force-push before SHA ${index}`),
      afterCommitSha: expectSha(afterCommit.oid, `source PR force-push after SHA ${index}`),
      createdAt: expectString(event.createdAt, `source PR force-push created at ${index}`),
    }
  })
  return {
    number: expectInteger(pullRequest.number, 'source PR number'),
    baseRefName: expectString(pullRequest.baseRefName, 'source PR base ref'),
    headSha: expectString(pullRequest.headRefOid, 'source PR head SHA'),
    createdAt: expectString(pullRequest.createdAt, 'source PR created at'),
    mergedAt: expectNullableString(pullRequest.mergedAt, 'source PR merged at'),
    mergeCommitSha: mergeCommit === null ? null : expectString(mergeCommit.oid, 'source PR merge commit SHA'),
    headForcePushes,
    headForcePushCount: headForcePushes.length,
  }
}

const fetchPullRequestIssueComments = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly PullRequestIssueComment[]> => {
  const operation = `list source PR #${pullNumber} issue comments`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/issues/${pullNumber}/comments?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  return parsePullRequestIssueComments(response.value)
}

const fetchPullRequestReactions = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly PullRequestReaction[]> => {
  const operation = `list source PR #${pullNumber} reactions`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/issues/${pullNumber}/reactions?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  return parsePullRequestReactions(response.value)
}

const fetchPullRequestReviews = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly PullRequestReview[]> => {
  const reviews: PullRequestReview[] = []
  let cursor: string | null = null
  for (let page = 0; page < maximumGraphqlPages; page += 1) {
    const operation = `read source PR #${pullNumber} reviews page ${page + 1}`
    const data = await requestGraphql({
      query: pullRequestReviewsQuery,
      variables: { owner: options.owner, name: options.name, number: pullNumber, cursor },
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    const connection = expectRecord(graphqlPullRequest(data, operation).reviews, operation)
    if (!Array.isArray(connection.nodes)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    for (const [index, item] of connection.nodes.entries()) {
      const review = expectRecord(item, `${operation} review ${index}`)
      const author = review.author === null ? null : expectRecord(review.author, `${operation} review author ${index}`)
      const commit = review.commit === null ? null : expectRecord(review.commit, `${operation} review commit ${index}`)
      reviews.push({
        authorLogin: author === null ? null : expectString(author.login, `${operation} author login ${index}`),
        commitSha: commit === null ? null : expectString(commit.oid, `${operation} commit SHA ${index}`),
        submittedAt: expectNullableString(review.submittedAt, `${operation} submitted at ${index}`),
        state: expectString(review.state, `${operation} state ${index}`),
      })
    }
    const pageInfo = parsePageInfo(connection, operation)
    if (!pageInfo.hasNextPage) return reviews
    if (pageInfo.endCursor === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    cursor = pageInfo.endCursor
  }
  throw new GitHubReleaseReviewError('github-api-pagination-limit', `read source PR #${pullNumber} reviews`)
}

const fetchPullRequestThreads = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly PullRequestReviewThread[]> => {
  const threads: PullRequestReviewThread[] = []
  let cursor: string | null = null
  for (let page = 0; page < maximumGraphqlPages; page += 1) {
    const operation = `read source PR #${pullNumber} review threads page ${page + 1}`
    const data = await requestGraphql({
      query: pullRequestThreadsQuery,
      variables: { owner: options.owner, name: options.name, number: pullNumber, cursor },
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    const connection = expectRecord(graphqlPullRequest(data, operation).reviewThreads, operation)
    if (!Array.isArray(connection.nodes)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    for (const [index, item] of connection.nodes.entries()) {
      const thread = expectRecord(item, `${operation} thread ${index}`)
      const comments = expectRecord(thread.comments, `${operation} thread comments ${index}`)
      if (!Array.isArray(comments.nodes)) {
        throw new GitHubReleaseReviewError('github-api-invalid-response', `${operation} thread comments ${index}`)
      }
      const commentPageInfo = parsePageInfo(comments, `${operation} thread comments ${index}`)
      if (commentPageInfo.hasNextPage) {
        throw new GitHubReleaseReviewError('github-api-pagination-limit', `${operation} thread comments ${index}`)
      }
      const parsedComments = comments.nodes.map((commentItem, commentIndex): PullRequestReviewThreadComment => {
        const comment = expectRecord(commentItem, `${operation} thread ${index} comment ${commentIndex}`)
        const author =
          comment.author === null
            ? null
            : expectRecord(comment.author, `${operation} thread ${index} comment ${commentIndex} author`)
        const commit =
          comment.commit === null
            ? null
            : expectRecord(comment.commit, `${operation} thread ${index} comment ${commentIndex} commit`)
        const review =
          comment.pullRequestReview === null
            ? null
            : expectRecord(comment.pullRequestReview, `${operation} thread ${index} comment ${commentIndex} review`)
        const reviewAuthor =
          review === null || review.author === null
            ? null
            : expectRecord(review.author, `${operation} thread ${index} comment ${commentIndex} review author`)
        const reviewCommit =
          review === null || review.commit === null
            ? null
            : expectRecord(review.commit, `${operation} thread ${index} comment ${commentIndex} review commit`)
        return {
          authorLogin:
            author === null
              ? null
              : expectString(author.login, `${operation} thread ${index} comment ${commentIndex} author login`),
          authorAssociation: expectString(
            comment.authorAssociation,
            `${operation} thread ${index} comment ${commentIndex} author association`,
          ),
          body: expectAnyString(comment.body, `${operation} thread ${index} comment ${commentIndex} body`),
          createdAt: expectString(comment.createdAt, `${operation} thread ${index} comment ${commentIndex} created at`),
          commitSha:
            commit === null
              ? null
              : expectSha(commit.oid, `${operation} thread ${index} comment ${commentIndex} commit SHA`),
          reviewCommitSha:
            reviewCommit === null
              ? null
              : expectSha(reviewCommit.oid, `${operation} thread ${index} comment ${commentIndex} review commit SHA`),
          reviewAuthorLogin:
            reviewAuthor === null
              ? null
              : expectString(
                  reviewAuthor.login,
                  `${operation} thread ${index} comment ${commentIndex} review author login`,
                ),
          reviewSubmittedAt:
            review === null
              ? null
              : expectNullableString(
                  review.submittedAt,
                  `${operation} thread ${index} comment ${commentIndex} review submitted at`,
                ),
          reviewState:
            review === null
              ? null
              : expectString(review.state, `${operation} thread ${index} comment ${commentIndex} review state`),
          url: expectString(comment.url, `${operation} thread ${index} comment ${commentIndex} URL`),
        }
      })
      threads.push({
        id: expectString(thread.id, `${operation} thread ID ${index}`),
        isResolved: expectBoolean(thread.isResolved, `${operation} resolved ${index}`),
        isOutdated: expectBoolean(thread.isOutdated, `${operation} outdated ${index}`),
        path: expectNullableString(thread.path, `${operation} path ${index}`),
        url: parsedComments[0]?.url ?? null,
        comments: parsedComments,
      })
    }
    const pageInfo = parsePageInfo(connection, operation)
    if (!pageInfo.hasNextPage) return threads
    if (pageInfo.endCursor === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    cursor = pageInfo.endCursor
  }
  throw new GitHubReleaseReviewError('github-api-pagination-limit', `read source PR #${pullNumber} review threads`)
}

const fetchPullRequestCommitShas = async (
  options: GitHubLoaderOptions,
  pullNumber: number,
): Promise<readonly string[]> => {
  const commitShas: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < maximumGraphqlPages; page += 1) {
    const operation = `read source PR #${pullNumber} commits page ${page + 1}`
    const data = await requestGraphql({
      query: pullRequestCommitsQuery,
      variables: { owner: options.owner, name: options.name, number: pullNumber, cursor },
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    })
    const connection = expectRecord(graphqlPullRequest(data, operation).commits, operation)
    if (!Array.isArray(connection.nodes)) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    for (const [index, item] of connection.nodes.entries()) {
      const node = expectRecord(item, `${operation} node ${index}`)
      const commit = expectRecord(node.commit, `${operation} commit ${index}`)
      commitShas.push(expectSha(commit.oid, `${operation} commit ${index} SHA`))
    }
    const pageInfo = parsePageInfo(connection, operation)
    if (!pageInfo.hasNextPage) return commitShas
    if (pageInfo.endCursor === null) throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
    cursor = pageInfo.endCursor
  }
  throw new GitHubReleaseReviewError('github-api-pagination-limit', `read source PR #${pullNumber} commits`)
}

interface GitHubLoaderOptions {
  readonly owner: string
  readonly name: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly fetchFn: typeof fetch
  readonly repositoryRoot: string
}

const fetchCommitDetail = async (options: GitHubLoaderOptions, commitSha: string): Promise<CommitDetail> => {
  const operation = `read commit ${shortSha(commitSha)} detail`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(commitSha)}?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', `${operation} files`)
  }
  return parseCommitDetail(response.value, commitSha)
}

const fetchPathBlobSha = async (options: GitHubLoaderOptions, commitSha: string, path: string): Promise<string> => {
  const operation = `read ${path} blob at ${shortSha(commitSha)}`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${encodeURIComponent(commitSha)}`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const content = expectRecord(response.value, operation)
  if (content.type !== 'file' || expectString(content.path, `${operation} path`) !== path) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  }
  return expectSha(content.sha, `${operation} SHA`)
}

const loadLocalRemediationRecords = async (
  repositoryRoot: string,
): Promise<
  readonly { readonly path: string; readonly blobSha: string; readonly record: BaynReleaseReviewRemediationRecord }[]
> => {
  const root = await realpath(repositoryRoot)
  const directory = resolve(root, remediationDirectory)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (entries.length > maximumRemediationRecords) {
    throw new Error(`release review remediation count exceeds ${maximumRemediationRecords}`)
  }
  const records = []
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[0-9a-f]{40}\.json$/.test(entry.name)) {
      throw new Error(`unexpected release review remediation entry ${entry.name}`)
    }
    const path = `${remediationDirectory}/${entry.name}`
    const absolutePath = resolve(root, path)
    const metadata = await lstat(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumRemediationRecordBytes) {
      throw new Error(`release review remediation ${path} is not a bounded regular file`)
    }
    const bytes = await readFile(absolutePath)
    const record = parseBaynReleaseReviewRemediationRecord(JSON.parse(bytes.toString('utf8')) as unknown)
    if (entry.name !== `${record.blocked.mergeCommitSha}.json`) {
      throw new Error(`release review remediation ${path} does not match its blocked commit`)
    }
    records.push({ path, blobSha: gitBlobSha(bytes), record })
  }
  return records
}

const loadReleaseReviewRemediations = async (
  options: GitHubLoaderOptions,
  rangeCommitShas: ReadonlySet<string>,
): Promise<readonly BaynReleaseReviewRemediationEvidence[]> => {
  const records = (await loadLocalRemediationRecords(options.repositoryRoot)).filter((loaded) =>
    rangeCommitShas.has(loaded.record.blocked.mergeCommitSha),
  )
  return mapWithConcurrency(records, 2, async (loaded) => {
    const currentRecordBlob = await fetchPathBlobSha(options, options.mainCommitSha, loaded.path)
    if (currentRecordBlob !== loaded.blobSha) {
      throw new GitHubReleaseReviewError(
        'github-api-invalid-response',
        `bind remediation ${loaded.path} to current main`,
      )
    }
    const references = new Map<string, readonly string[]>()
    if (
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v2' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v3'
    ) {
      const reconstruction = loaded.record.blocked.reconstruction
      if (reconstruction === undefined) throw new Error(`remediation ${loaded.path} reconstruction is missing`)
      for (const head of reconstruction.heads) {
        references.set(
          head.headSha,
          head.affectedPaths.map((path) => path.path),
        )
      }
    } else if (
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v4' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v5' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v6' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v7' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v8' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v9'
    ) {
      references.set(
        loaded.record.blocked.finalHeadSha,
        loaded.record.blocked.affectedPaths.map((path) => path.path),
      )
      if (
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v7' ||
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v8' ||
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v9'
      ) {
        references.set(
          loaded.record.blocked.reviewedLineage.reviewedHeadSha,
          loaded.record.blocked.reviewedLineage.affectedPaths.map((path) => path.path),
        )
      }
      if (
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v5' ||
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v6' ||
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v8' ||
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v9'
      ) {
        references.set(
          loaded.record.introduction.finalHeadSha,
          loaded.record.introduction.affectedPaths.map((path) => path.path),
        )
      }
      if (
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v6' ||
        loaded.record.schemaVersion === 'bayn.release-review-remediation.v9'
      ) {
        references.set(
          loaded.record.completion.finalHeadSha,
          loaded.record.completion.affectedPaths.map((path) => path.path),
        )
      }
    } else {
      references.set(
        loaded.record.blocked.reviewedHeadSha,
        loaded.record.blocked.affectedPaths.map((path) => path.path),
      )
      references.set(
        loaded.record.blocked.finalHeadSha,
        loaded.record.blocked.affectedPaths.map((path) => path.path),
      )
    }
    for (const descendant of [...loaded.record.requiredDescendants, ...(loaded.record.requiredSuccessors ?? [])]) {
      references.set(
        descendant.finalHeadSha,
        descendant.affectedPaths.map((path) => path.path),
      )
    }
    const referencedCommits = await mapWithConcurrency([...references.entries()], 3, async ([sha, paths]) => {
      const [commit, pathBlobs] = await Promise.all([
        fetchCommitDetail(options, sha),
        mapWithConcurrency(paths, 4, async (path) => ({
          path,
          blobSha: await fetchPathBlobSha(options, sha, path),
        })),
      ])
      return { ...commit, pathBlobs }
    })
    const currentPaths =
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v2' ||
      loaded.record.schemaVersion === 'bayn.release-review-remediation.v3'
        ? (loaded.record.blocked.reconstruction?.heads.at(-1)?.affectedPaths.map((path) => path.path) ?? [])
        : loaded.record.blocked.affectedPaths.map((path) => path.path)
    const currentPathBlobs = await mapWithConcurrency(currentPaths, 4, async (path) => ({
      path,
      blobSha: await fetchPathBlobSha(options, options.mainCommitSha, path),
    }))
    return {
      recordPath: loaded.path,
      recordBlobSha: loaded.blobSha,
      record: loaded.record,
      referencedCommits,
      currentPathBlobs,
    }
  })
}

const loadCommitReviewSnapshot = async (
  options: GitHubLoaderOptions,
  commitSha: string,
  knownCommit?: CommitDetail,
): Promise<BaynReleaseReviewSnapshot> => {
  const associationOperation = `list pull requests associated with ${shortSha(commitSha)}`
  const [commit, associationResponse] = await Promise.all([
    knownCommit === undefined ? fetchCommitDetail(options, commitSha) : Promise.resolve(knownCommit),
    requestGitHubJson({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(commitSha)}/pulls?per_page=100`,
      operation: associationOperation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    }),
  ])
  if (associationResponse.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', associationOperation)
  }
  const associatedPullRequests = parseAssociatedPullRequests(associationResponse.value)
  const candidates = sourcePullCandidates(associatedPullRequests, options.baseRefName)
  if (candidates.length !== 1) {
    return { mainCommitParents: commit.parents, associatedPullRequests, pullRequest: null }
  }

  const candidate = candidates[0]
  if (candidate === undefined) throw new Error('source pull selection was unexpectedly empty')
  const [metadata, reviews, threads, commitShas, issueComments, reactions] = await Promise.all([
    fetchPullRequestMetadata(options, candidate.number),
    fetchPullRequestReviews(options, candidate.number),
    fetchPullRequestThreads(options, candidate.number),
    fetchPullRequestCommitShas(options, candidate.number),
    fetchPullRequestIssueComments(options, candidate.number),
    fetchPullRequestReactions(options, candidate.number),
  ])
  return {
    mainCommitParents: commit.parents,
    associatedPullRequests,
    pullRequest: { ...metadata, reviews, threads, commitShas, issueComments, reactions },
  }
}

export const createGitHubReleaseReviewLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly repositoryRoot?: string
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynReleaseReviewSnapshot>) => {
  const [owner, name, extra] = options.repository.split('/')
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0 || extra !== undefined) {
    throw new Error('repository must be in owner/name form')
  }
  const loaderOptions: GitHubLoaderOptions = {
    owner,
    name,
    token: options.token,
    mainCommitSha: options.mainCommitSha,
    baseRefName: options.baseRefName,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn ?? fetch,
    repositoryRoot: options.repositoryRoot ?? process.cwd(),
  }

  return () => loadCommitReviewSnapshot(loaderOptions, loaderOptions.mainCommitSha)
}

interface StaticReleaseEligibilityContext {
  readonly currentCommit: CommitDetail
  readonly lastPublishedRevision: LastPublishedRevisionResolution
  readonly comparison:
    | (Omit<BaynReleaseComparison, 'commits'> & {
        readonly commits: readonly (CommitDetail & { readonly reviewSnapshot: null })[]
      })
    | null
}

const loadStaticReleaseEligibilityContext = async (
  options: GitHubLoaderOptions,
): Promise<StaticReleaseEligibilityContext> => {
  const successfulPushRunsOperation = `read latest successful ${githubWorkflowFile} main push`
  const successfulDispatchRunsOperation = `read latest successful ${githubWorkflowFile} main workflow dispatch`
  const [currentCommit, successfulPushRunsResponse, successfulDispatchRunsResponse] = await Promise.all([
    fetchCommitDetail(options, options.mainCommitSha),
    requestGitHubJson({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/workflows/${encodeURIComponent(githubWorkflowFile)}/runs?branch=main&event=push&status=success&per_page=1&page=1`,
      operation: successfulPushRunsOperation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    }),
    requestGitHubJson({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/workflows/${encodeURIComponent(githubWorkflowFile)}/runs?branch=main&event=workflow_dispatch&status=success&per_page=1&page=1`,
      operation: successfulDispatchRunsOperation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      fetchFn: options.fetchFn,
    }),
  ])
  const lastPublishedRevision = resolveLastPublishedRevision([
    ...parseSuccessfulPublishRuns(successfulPushRunsResponse.value),
    ...parseSuccessfulPublishRuns(successfulDispatchRunsResponse.value),
  ])
  if (lastPublishedRevision.status !== 'resolved') {
    return { currentCommit, lastPublishedRevision, comparison: null }
  }

  const comparisonOperation = `compare published ${shortSha(lastPublishedRevision.revision)} to current ${shortSha(options.mainCommitSha)}`
  const comparisonResponse = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/compare/${encodeURIComponent(lastPublishedRevision.revision)}...${encodeURIComponent(options.mainCommitSha)}?per_page=${maximumReleaseRangeCommits}&page=1`,
    operation: comparisonOperation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  const parsedComparison = parseComparison(comparisonResponse.value)
  const truncated = comparisonResponse.headers.get('link')?.includes('rel="next"') === true
  if (truncated || parsedComparison.commitShas.length > maximumReleaseRangeCommits) {
    return {
      currentCommit,
      lastPublishedRevision,
      comparison: {
        status: parsedComparison.status,
        baseSha: parsedComparison.baseSha,
        headSha: options.mainCommitSha,
        mergeBaseSha: parsedComparison.mergeBaseSha,
        aheadBy: parsedComparison.aheadBy,
        totalCommits: parsedComparison.totalCommits,
        commits: [],
        truncated: true,
      },
    }
  }

  const commitDetails = await mapWithConcurrency(parsedComparison.commitShas, 4, async (commitSha) =>
    commitSha === currentCommit.sha ? currentCommit : fetchCommitDetail(options, commitSha),
  )
  return {
    currentCommit,
    lastPublishedRevision,
    comparison: {
      status: parsedComparison.status,
      baseSha: parsedComparison.baseSha,
      headSha: options.mainCommitSha,
      mergeBaseSha: parsedComparison.mergeBaseSha,
      aheadBy: parsedComparison.aheadBy,
      totalCommits: parsedComparison.totalCommits,
      commits: commitDetails.map((commit) => ({ ...commit, reviewSnapshot: null })),
      truncated: false,
    },
  }
}

export const createGitHubReleaseEligibilityLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly repositoryRoot?: string
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynReleaseEligibilitySnapshot>) => {
  const [owner, name, extra] = options.repository.split('/')
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0 || extra !== undefined) {
    throw new Error('repository must be in owner/name form')
  }
  const loaderOptions: GitHubLoaderOptions = {
    owner,
    name,
    token: options.token,
    mainCommitSha: options.mainCommitSha,
    baseRefName: options.baseRefName,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn ?? fetch,
    repositoryRoot: options.repositoryRoot ?? process.cwd(),
  }
  let staticContext: StaticReleaseEligibilityContext | null = null

  return async () => {
    const loadedContext = staticContext ?? (await loadStaticReleaseEligibilityContext(loaderOptions))
    if (loadedContext.lastPublishedRevision.status !== 'missing') staticContext = loadedContext
    if (loadedContext.comparison === null) {
      return {
        currentCommitParents: loadedContext.currentCommit.parents,
        lastPublishedRevision: loadedContext.lastPublishedRevision,
        comparison: null,
      }
    }

    const [commits, remediations] = await Promise.all([
      mapWithConcurrency(loadedContext.comparison.commits, 3, async (commit) => ({
        ...commit,
        reviewSnapshot: commit.files.some(isBaynReleaseAffectingPath)
          ? await loadCommitReviewSnapshot(loaderOptions, commit.sha, commit)
          : null,
      })),
      loadReleaseReviewRemediations(
        loaderOptions,
        new Set(loadedContext.comparison.commits.map((commit) => commit.sha)),
      ),
    ])
    return {
      currentCommitParents: loadedContext.currentCommit.parents,
      lastPublishedRevision: loadedContext.lastPublishedRevision,
      comparison: { ...loadedContext.comparison, commits },
      remediations,
    }
  }
}

const fetchDefaultBranchSha = async (options: GitHubLoaderOptions): Promise<string> => {
  const operation = `read trusted default branch ${options.baseRefName}`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/commits/${encodeURIComponent(options.baseRefName)}?per_page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  return expectSha(expectRecord(response.value, operation).sha, `${operation} SHA`)
}

const fetchBaynBuildWorkflowRuns = async (
  options: GitHubLoaderOptions,
  input: { readonly headSha: string; readonly event: 'push' | 'workflow_dispatch' },
): Promise<readonly BaynBuildWorkflowRun[]> => {
  const operation = `list ${githubWorkflowFile} ${input.event} runs for ${shortSha(input.headSha)}`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/workflows/${encodeURIComponent(githubWorkflowFile)}/runs?branch=main&head_sha=${encodeURIComponent(input.headSha)}&event=${input.event}&per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  const runs = parseBaynBuildWorkflowRuns(response.value)
  if (runs.some((run) => run.headSha !== input.headSha || run.headBranch !== 'main' || run.event !== input.event)) {
    throw new GitHubReleaseReviewError('github-api-invalid-response', operation)
  }
  return runs
}

const fetchBaynBuildWorkflowJobs = async (
  options: GitHubLoaderOptions,
  runId: number,
): Promise<readonly BaynBuildWorkflowJob[]> => {
  const operation = `list ${githubWorkflowFile} run ${runId} jobs`
  const response = await requestGitHubJson({
    url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/runs/${runId}/jobs?per_page=100&page=1`,
    operation,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn,
  })
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new GitHubReleaseReviewError('github-api-pagination-limit', operation)
  }
  return parseBaynBuildWorkflowJobs(response.value)
}

const fetchFailedReviewThreadBlock = async (
  options: GitHubLoaderOptions,
  jobs: readonly BaynBuildWorkflowJob[],
): Promise<FailedReviewThreadBlock | null> => {
  const reviewJobs = jobs.filter((job) => job.name === 'Verify exact-head Codex review')
  if (reviewJobs.length !== 1) return null
  const reviewJob = reviewJobs[0]
  if (reviewJob === undefined) return null
  const operation = `read failed Bayn review-gate job ${reviewJob.id} log`
  return loadOptionalFailedReviewThreadBlock(() =>
    requestGitHubText({
      url: `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.name)}/actions/jobs/${reviewJob.id}/logs`,
      operation,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
      maximumBytes: maximumReleaseReviewJobLogBytes,
      fetchFn: options.fetchFn,
    }),
  )
}

const latestFailedSourcePush = (
  runs: readonly BaynBuildWorkflowRun[],
  sourceCommitSha: string,
): BaynBuildWorkflowRun | undefined =>
  runs
    .filter(
      (run) =>
        run.headSha === sourceCommitSha &&
        run.headBranch === 'main' &&
        run.event === 'push' &&
        run.status === 'completed' &&
        run.conclusion === 'failure',
    )
    .toSorted(
      (left, right) => right.runNumber - left.runNumber || right.runAttempt - left.runAttempt || right.id - left.id,
    )[0]

export const createGitHubReleaseRetryLoader = (options: {
  readonly repository: string
  readonly token: string
  readonly mainCommitSha: string
  readonly baseRefName: string
  readonly requestTimeoutMs: number
  readonly repositoryRoot?: string
  readonly fetchFn?: typeof fetch
}): (() => Promise<BaynReleaseRetrySnapshot>) => {
  const [owner, name, extra] = options.repository.split('/')
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0 || extra !== undefined) {
    throw new Error('repository must be in owner/name form')
  }
  const loaderOptions: GitHubLoaderOptions = {
    owner,
    name,
    token: options.token,
    mainCommitSha: options.mainCommitSha,
    baseRefName: options.baseRefName,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchFn: options.fetchFn ?? fetch,
    repositoryRoot: options.repositoryRoot ?? process.cwd(),
  }
  const loadEligibility = createGitHubReleaseEligibilityLoader(options)

  return async () => {
    const [eligibility, defaultBranchSha] = await Promise.all([loadEligibility(), fetchDefaultBranchSha(loaderOptions)])
    const [sourcePushRuns, currentDispatchRuns] = await Promise.all([
      fetchBaynBuildWorkflowRuns(loaderOptions, {
        headSha: options.mainCommitSha,
        event: 'push',
      }),
      fetchBaynBuildWorkflowRuns(loaderOptions, {
        headSha: options.mainCommitSha,
        event: 'workflow_dispatch',
      }),
    ])
    const failedRun = latestFailedSourcePush(sourcePushRuns, options.mainCommitSha)
    const jobs = failedRun === undefined ? [] : await fetchBaynBuildWorkflowJobs(loaderOptions, failedRun.id)
    const reviewThreadBlock = failedRun === undefined ? null : await fetchFailedReviewThreadBlock(loaderOptions, jobs)
    return {
      ...eligibility,
      defaultBranchSha,
      failedReviewRun: failedRun === undefined ? null : { run: failedRun, jobs, reviewThreadBlock },
      publicationSucceeded:
        sourcePushRuns.some((run) => run.status === 'completed' && run.conclusion === 'success') ||
        currentDispatchRuns.some((run) => run.status === 'completed' && run.conclusion === 'success'),
      retryInProgress: currentDispatchRuns.some(
        (run) =>
          run.headSha === options.mainCommitSha &&
          run.headBranch === 'main' &&
          run.event === 'workflow_dispatch' &&
          (run.status === 'queued' || run.status === 'in_progress'),
      ),
    }
  }
}

interface CliOptions {
  readonly mode: 'push' | 'retry-discovery' | 'retry-publication'
  readonly repository: string
  readonly repositoryRoot: string
  readonly mainCommitSha: string
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
  readonly pushBeforeSha: string | null
  readonly githubOutputPath: string | null
  readonly triggerKind: 'issue-comment' | 'schedule' | null
  readonly triggerPrNumber: number | null
  readonly triggerActorLogin: string | null
  readonly retrySourceCommitSha: string | null
  readonly retryPrNumber: number | null
  readonly retryHeadSha: string | null
  readonly retryFailedRunId: number | null
}

const parsePositiveInteger = (value: string, name: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

const parseOptionalPositiveInteger = (value: string | undefined, name: string): number | null =>
  value === undefined ? null : parsePositiveInteger(value, name)

export const parseVerifyReleaseReviewArguments = (
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
    '--repository-root',
    '--commit',
    '--push-before',
    '--max-attempts',
    '--poll-interval-ms',
    '--request-timeout-ms',
    '--github-output',
    '--trigger-kind',
    '--trigger-pr-number',
    '--trigger-actor-login',
    '--retry-source-commit',
    '--retry-pr-number',
    '--retry-head',
    '--retry-failed-run-id',
  ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown argument ${name}`)
  }

  const repository = values.get('--repository') ?? environment.GITHUB_REPOSITORY
  const repositoryRoot = values.get('--repository-root') ?? environment.GITHUB_WORKSPACE ?? process.cwd()
  const mainCommitSha = values.get('--commit') ?? environment.GITHUB_SHA
  const pushBeforeSha = values.get('--push-before') ?? null
  const modeValue = values.get('--mode') ?? 'push'
  if (modeValue !== 'push' && modeValue !== 'retry-discovery' && modeValue !== 'retry-publication') {
    throw new Error('--mode must be push, retry-discovery, or retry-publication')
  }
  const triggerKindValue = values.get('--trigger-kind') ?? null
  if (triggerKindValue !== null && triggerKindValue !== 'issue-comment' && triggerKindValue !== 'schedule') {
    throw new Error('--trigger-kind must be issue-comment or schedule')
  }
  if (repository === undefined || repository.length === 0)
    throw new Error('--repository or GITHUB_REPOSITORY is required')
  if (mainCommitSha === undefined || !/^[0-9a-f]{40}$/.test(mainCommitSha)) {
    throw new Error('--commit or GITHUB_SHA must be a lowercase 40-character commit SHA')
  }
  if (pushBeforeSha !== null && !/^[0-9a-f]{40}$/.test(pushBeforeSha)) {
    throw new Error('--push-before must be a lowercase 40-character commit SHA')
  }
  return {
    mode: modeValue,
    repository,
    repositoryRoot,
    mainCommitSha,
    pushBeforeSha,
    maxAttempts: parsePositiveInteger(values.get('--max-attempts') ?? '10', '--max-attempts'),
    pollIntervalMs: parsePositiveInteger(values.get('--poll-interval-ms') ?? '10000', '--poll-interval-ms'),
    requestTimeoutMs: parsePositiveInteger(values.get('--request-timeout-ms') ?? '10000', '--request-timeout-ms'),
    githubOutputPath: values.get('--github-output') ?? environment.GITHUB_OUTPUT ?? null,
    triggerKind: triggerKindValue,
    triggerPrNumber: parseOptionalPositiveInteger(values.get('--trigger-pr-number'), '--trigger-pr-number'),
    triggerActorLogin: values.get('--trigger-actor-login') ?? null,
    retrySourceCommitSha: values.get('--retry-source-commit') ?? null,
    retryPrNumber: parseOptionalPositiveInteger(values.get('--retry-pr-number'), '--retry-pr-number'),
    retryHeadSha: values.get('--retry-head') ?? null,
    retryFailedRunId: parseOptionalPositiveInteger(values.get('--retry-failed-run-id'), '--retry-failed-run-id'),
  }
}

const appendGitHubOutputs = async (
  path: string | null,
  values: Readonly<Record<string, string | number | boolean>>,
) => {
  if (path === null) return
  const output = Object.entries(values)
    .map(([name, value]) => `${name}=${String(value)}\n`)
    .join('')
  await appendFile(path, output, 'utf8')
}

const retryTriggerFromOptions = (options: CliOptions): BaynReleaseRetryTrigger => {
  if (options.mode === 'retry-discovery') {
    if (options.triggerKind === 'schedule') return { type: 'schedule' }
    if (
      options.triggerKind === 'issue-comment' &&
      options.triggerPrNumber !== null &&
      options.triggerActorLogin !== null
    ) {
      return {
        type: 'issue-comment',
        prNumber: options.triggerPrNumber,
        actorLogin: options.triggerActorLogin,
      }
    }
    throw new Error('retry-discovery requires a complete --trigger-kind binding')
  }
  if (
    options.retrySourceCommitSha === null ||
    !/^[0-9a-f]{40}$/.test(options.retrySourceCommitSha) ||
    options.retryPrNumber === null ||
    options.retryHeadSha === null ||
    !/^[0-9a-f]{40}$/.test(options.retryHeadSha) ||
    options.retryFailedRunId === null
  ) {
    throw new Error('retry-publication requires exact source, PR, head, and failed-run bindings')
  }
  return {
    type: 'workflow-dispatch',
    sourceCommitSha: options.retrySourceCommitSha,
    prNumber: options.retryPrNumber,
    headSha: options.retryHeadSha,
    failedRunId: options.retryFailedRunId,
  }
}

const run = async (): Promise<void> => {
  const options = parseVerifyReleaseReviewArguments(process.argv.slice(2))
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token.length === 0) throw new Error('GITHUB_TOKEN is required')
  if (options.mode === 'push') {
    if (options.pushBeforeSha === null)
      throw new Error('--push-before is required for Bayn push publication eligibility')
    const result = await pollBaynReleaseEligibility({
      mainCommitSha: options.mainCommitSha,
      baseRefName: 'main',
      maxAttempts: options.maxAttempts,
      pollIntervalMs: options.pollIntervalMs,
      pushBeforeSha: options.pushBeforeSha,
      loadSnapshot: createGitHubReleaseEligibilityLoader({
        repository: options.repository,
        token,
        mainCommitSha: options.mainCommitSha,
        baseRefName: 'main',
        requestTimeoutMs: options.requestTimeoutMs,
        repositoryRoot: options.repositoryRoot,
      }),
    })
    if (result.status === 'hold') {
      console.error(`BAYN_RELEASE_REVIEW_HOLD ${result.code}: ${result.message}`)
      process.exitCode = 1
      return
    }
    await appendGitHubOutputs(options.githubOutputPath, { publish: true, source_sha: options.mainCommitSha })
    console.log(
      `BAYN_RELEASE_REVIEW_ELIGIBLE published=${shortSha(result.lastPublishedRevision)} current=${shortSha(options.mainCommitSha)} checked_commits=${result.checkedCommitCount} bayn_affecting_commits=${result.baynAffectingCommitCount} reviewed_prs=${result.reviewedPullRequests.map((review) => `#${review.prNumber}@${shortSha(review.headSha)}`).join(',')}; attempts=${result.attempts}`,
    )
    return
  }

  const retry = evaluateBaynReleaseRetry({
    mainCommitSha: options.mainCommitSha,
    baseRefName: 'main',
    snapshot: await createGitHubReleaseRetryLoader({
      repository: options.repository,
      token,
      mainCommitSha: options.mainCommitSha,
      baseRefName: 'main',
      requestTimeoutMs: options.requestTimeoutMs,
      repositoryRoot: options.repositoryRoot,
    })(),
    trigger: retryTriggerFromOptions(options),
    nowMs: Date.now(),
  })
  if (retry.status === 'hold') {
    if (options.mode === 'retry-discovery' && retry.retryable) {
      await appendGitHubOutputs(options.githubOutputPath, {
        dispatch: false,
        publish: false,
        retry_code: retry.code,
      })
      console.log(`BAYN_RELEASE_RETRY_NOOP ${retry.code}: ${retry.message}`)
      return
    }
    console.error(`BAYN_RELEASE_RETRY_HOLD ${retry.code}: ${retry.message}`)
    process.exitCode = 1
    return
  }
  if (retry.status === 'noop') {
    await appendGitHubOutputs(options.githubOutputPath, {
      dispatch: false,
      publish: false,
      retry_code: retry.code,
    })
    console.log(`BAYN_RELEASE_RETRY_NOOP ${retry.code}: ${retry.message}`)
    if (options.mode === 'retry-publication') process.exitCode = 1
    return
  }

  const retryOutputs = {
    retry_source_sha: retry.sourceCommitSha,
    retry_pr_number: retry.prNumber,
    retry_pr_head: retry.headSha,
    retry_failed_run_id: retry.failedRunId,
  }
  if (options.mode === 'retry-discovery') {
    await appendGitHubOutputs(options.githubOutputPath, { dispatch: true, ...retryOutputs })
    console.log(
      `BAYN_RELEASE_RETRY_DISPATCH current=${shortSha(retry.currentMainSha)} source=${shortSha(retry.sourceCommitSha)} pr=#${retry.prNumber}@${shortSha(retry.headSha)} failed_run=${retry.failedRunId}`,
    )
    return
  }
  await appendGitHubOutputs(options.githubOutputPath, {
    publish: true,
    source_sha: retry.currentMainSha,
    ...retryOutputs,
  })
  console.log(
    `BAYN_RELEASE_RETRY_ELIGIBLE current=${shortSha(retry.currentMainSha)} source=${shortSha(retry.sourceCommitSha)} pr=#${retry.prNumber}@${shortSha(retry.headSha)} failed_run=${retry.failedRunId}`,
  )
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error
    console.error(`BAYN_RELEASE_REVIEW_HOLD verifier-startup-error: ${name}`)
    process.exitCode = 1
  })
}
