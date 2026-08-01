import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

import {
  baynCodexBotLogin,
  baynCodexReviewer,
  createGitHubReleaseEligibilityLoader,
  createGitHubReleaseRetryLoader,
  createGitHubReleaseReviewLoader,
  evaluateBaynReleaseEligibility,
  evaluateBaynReleaseRetry,
  evaluateBaynReleaseReview,
  GitHubReleaseReviewError,
  isBaynReleaseAffectingPath,
  loadOptionalFailedReviewThreadBlock,
  parseFailedReviewThreadBlock,
  parseBaynReleaseReviewRemediationRecord,
  pollBaynReleaseEligibility,
  pollBaynReleaseReview,
  resolveLastPublishedRevision,
  pullRequestReviewEvidenceSha256,
  type AssociatedPullRequest,
  type BaynBuildWorkflowRun,
  type BaynReleaseCommitFileChange,
  type BaynReleaseComparison,
  type BaynReleaseEligibilitySnapshot,
  type BaynReleaseRetrySnapshot,
  type BaynReleaseReviewPollResult,
  type BaynReleaseReviewSnapshot,
  type BaynReleaseReviewRemediationEvidence,
  type BaynReleaseReviewRemediationRecord,
  type PullRequestReview,
  type PullRequestReviewState,
  type PullRequestIssueComment,
  type PullRequestForcePush,
  type PullRequestReaction,
  type PullRequestReviewThread,
  type PullRequestReviewThreadComment,
  type SuccessfulPublishRun,
} from './verify-release-review'

const requireHold = (
  result: BaynReleaseReviewPollResult,
): Extract<BaynReleaseReviewPollResult, { readonly status: 'hold' }> => {
  expect(result.status).toBe('hold')
  if (result.status !== 'hold') throw new Error('expected release review HOLD')
  return result
}

const requireEligibilityHold = (
  result: ReturnType<typeof evaluateBaynReleaseEligibility>,
): Extract<ReturnType<typeof evaluateBaynReleaseEligibility>, { readonly status: 'hold' }> => {
  expect(result.status).toBe('hold')
  if (result.status !== 'hold') throw new Error('expected release eligibility HOLD')
  return result
}

const mainCommitSha = 'a'.repeat(40)
const finalHeadSha = 'b'.repeat(40)
const olderHeadSha = 'c'.repeat(40)
const pushBeforeSha = 'd'.repeat(40)
const lastPublishedSha = 'e'.repeat(40)
const heldCommitSha = 'f'.repeat(40)
const heldHeadSha = '1'.repeat(40)
const evaluationNowMs = Date.parse('2026-07-30T07:02:00Z')

const associatedPull = (overrides: Partial<AssociatedPullRequest> = {}): AssociatedPullRequest => ({
  number: 13390,
  baseRefName: 'main',
  headSha: finalHeadSha,
  mergeCommitSha: mainCommitSha,
  mergedAt: '2026-07-30T07:01:30Z',
  ...overrides,
})

const review = (overrides: Partial<PullRequestReview> = {}): PullRequestReview => ({
  authorLogin: baynCodexReviewer,
  commitSha: finalHeadSha,
  submittedAt: '2026-07-30T07:01:00Z',
  state: 'COMMENTED',
  ...overrides,
})

const issueComment = (overrides: Partial<PullRequestIssueComment> = {}): PullRequestIssueComment => ({
  authorLogin: baynCodexBotLogin,
  body: `Codex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`${finalHeadSha.slice(0, 10)}\`\n`,
  createdAt: '2026-07-30T07:01:00Z',
  updatedAt: '2026-07-30T07:01:00Z',
  ...overrides,
})

const reaction = (overrides: Partial<PullRequestReaction> = {}): PullRequestReaction => ({
  userLogin: baynCodexBotLogin,
  content: '+1',
  createdAt: '2026-07-30T07:01:00Z',
  ...overrides,
})

const thread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
  id: 'thread-1',
  isResolved: true,
  isOutdated: false,
  path: 'packages/scripts/src/bayn/verify-release-review.ts',
  url: 'https://github.com/proompteng/lab/pull/13390#discussion_r1',
  comments: [],
  ...overrides,
})

const threadComment = (overrides: Partial<PullRequestReviewThreadComment> = {}): PullRequestReviewThreadComment => ({
  authorLogin: baynCodexReviewer,
  authorAssociation: 'NONE',
  body: 'Review finding',
  createdAt: '2026-07-30T07:01:00Z',
  commitSha: olderHeadSha,
  reviewCommitSha: olderHeadSha,
  reviewAuthorLogin: baynCodexReviewer,
  reviewSubmittedAt: '2026-07-30T07:01:00Z',
  reviewState: 'COMMENTED',
  url: 'https://github.com/proompteng/lab/pull/13390#discussion_r1',
  ...overrides,
})

const snapshot = (
  options: {
    readonly associated?: readonly AssociatedPullRequest[]
    readonly reviews?: readonly PullRequestReview[]
    readonly threads?: readonly PullRequestReviewThread[]
    readonly mainCommitParents?: readonly string[]
    readonly commitShas?: readonly string[]
    readonly issueComments?: readonly PullRequestIssueComment[]
    readonly reactions?: readonly PullRequestReaction[]
    readonly headForcePushes?: readonly PullRequestForcePush[]
    readonly headForcePushCount?: number
  } = {},
): BaynReleaseReviewSnapshot => {
  const associated = options.associated ?? [associatedPull()]
  const source = associated[0]
  const sourceCreatedAt =
    source?.mergedAt === null || source?.mergedAt === undefined
      ? '2026-07-30T06:59:00Z'
      : new Date(Date.parse(source.mergedAt) - 60_000).toISOString()
  return {
    mainCommitParents: options.mainCommitParents ?? [pushBeforeSha],
    associatedPullRequests: associated,
    pullRequest:
      source === undefined
        ? null
        : {
            number: source.number,
            baseRefName: source.baseRefName,
            headSha: source.headSha,
            mergeCommitSha: source.mergeCommitSha,
            createdAt: sourceCreatedAt,
            mergedAt: source.mergedAt,
            reviews: options.reviews ?? [review()],
            threads: options.threads ?? [],
            commitShas: options.commitShas ?? [source.headSha],
            issueComments: options.issueComments ?? [],
            reactions: options.reactions ?? [],
            headForcePushes: options.headForcePushes ?? [],
            headForcePushCount: options.headForcePushCount ?? options.headForcePushes?.length ?? 0,
          },
  }
}

const successfulPublishRun = (overrides: Partial<SuccessfulPublishRun> = {}): SuccessfulPublishRun => ({
  id: 100,
  runNumber: 10,
  runAttempt: 1,
  headSha: lastPublishedSha,
  headBranch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
})

const reviewSnapshotFor = (options: {
  readonly commitSha: string
  readonly prNumber: number
  readonly headSha: string
  readonly parents: readonly string[]
  readonly reviews?: readonly PullRequestReview[]
  readonly threads?: readonly PullRequestReviewThread[]
  readonly issueComments?: readonly PullRequestIssueComment[]
  readonly reactions?: readonly PullRequestReaction[]
  readonly headForcePushes?: readonly PullRequestForcePush[]
  readonly headForcePushCount?: number
  readonly mergedAt?: string
}): BaynReleaseReviewSnapshot => {
  const associated = associatedPull({
    number: options.prNumber,
    headSha: options.headSha,
    mergeCommitSha: options.commitSha,
    mergedAt: options.mergedAt ?? '2026-07-30T07:01:30Z',
  })
  const sourceCreatedAt =
    associated.mergedAt === null
      ? '2026-07-30T06:59:00Z'
      : new Date(Date.parse(associated.mergedAt) - 60_000).toISOString()
  return {
    mainCommitParents: options.parents,
    associatedPullRequests: [associated],
    pullRequest: {
      number: options.prNumber,
      baseRefName: 'main',
      headSha: options.headSha,
      mergeCommitSha: options.commitSha,
      createdAt: sourceCreatedAt,
      mergedAt: associated.mergedAt,
      reviews: options.reviews ?? [
        review({
          commitSha: options.headSha,
        }),
      ],
      threads: options.threads ?? [],
      commitShas: [options.headSha],
      issueComments: options.issueComments ?? [],
      reactions: options.reactions ?? [],
      headForcePushes: options.headForcePushes ?? [],
      headForcePushCount: options.headForcePushCount ?? options.headForcePushes?.length ?? 0,
    },
  }
}

const eligibilitySnapshot = (
  overrides: Partial<BaynReleaseEligibilitySnapshot> = {},
): BaynReleaseEligibilitySnapshot => ({
  currentCommitParents: [pushBeforeSha],
  lastPublishedRevision: {
    status: 'resolved',
    revision: lastPublishedSha,
    runId: 100,
    runNumber: 10,
    runAttempt: 1,
  },
  comparison: {
    status: 'ahead',
    baseSha: lastPublishedSha,
    headSha: mainCommitSha,
    mergeBaseSha: lastPublishedSha,
    aheadBy: 1,
    totalCommits: 1,
    commits: [
      {
        sha: mainCommitSha,
        parents: [pushBeforeSha],
        files: ['services/bayn/src/example.ts'],
        reviewSnapshot: snapshot(),
      },
    ],
    truncated: false,
  },
  ...overrides,
})

const failedBuildRun = (overrides: Partial<BaynBuildWorkflowRun> = {}): BaynBuildWorkflowRun => ({
  id: 30540000001,
  runNumber: 900,
  runAttempt: 1,
  headSha: mainCommitSha,
  headBranch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  createdAt: '2026-07-30T07:00:05Z',
  updatedAt: '2026-07-30T07:02:30Z',
  ...overrides,
})

const retrySnapshot = (
  options: {
    readonly reviewSnapshot?: BaynReleaseReviewSnapshot
    readonly failedRun?: BaynBuildWorkflowRun | null
    readonly retryInProgress?: boolean
    readonly defaultBranchSha?: string
    readonly eligibility?: BaynReleaseEligibilitySnapshot
    readonly reviewThreadBlock?: { readonly commitShaPrefix: string; readonly prNumber: number } | null
    readonly failedReviewJobCompletedAt?: string | null
  } = {},
): BaynReleaseRetrySnapshot => {
  const eligibility =
    options.eligibility ??
    eligibilitySnapshot({
      comparison: {
        status: 'ahead',
        baseSha: lastPublishedSha,
        headSha: mainCommitSha,
        mergeBaseSha: lastPublishedSha,
        aheadBy: 1,
        totalCommits: 1,
        commits: [
          {
            sha: mainCommitSha,
            parents: [lastPublishedSha],
            files: ['packages/scripts/src/bayn/verify-release-review.ts'],
            reviewSnapshot:
              options.reviewSnapshot ??
              reviewSnapshotFor({
                commitSha: mainCommitSha,
                prNumber: 13401,
                headSha: finalHeadSha,
                parents: [lastPublishedSha],
                mergedAt: '2026-07-30T07:00:00Z',
                reviews: [],
                issueComments: [
                  issueComment({
                    createdAt: '2026-07-30T07:03:00Z',
                    updatedAt: '2026-07-30T07:03:00Z',
                  }),
                ],
              }),
          },
        ],
        truncated: false,
      },
    })
  const run = options.failedRun === undefined ? failedBuildRun() : options.failedRun
  const failedReviewJobCompletedAt =
    options.failedReviewJobCompletedAt === undefined ? (run?.updatedAt ?? null) : options.failedReviewJobCompletedAt
  return {
    ...eligibility,
    defaultBranchSha: options.defaultBranchSha ?? mainCommitSha,
    failedReviewRun:
      run === null
        ? null
        : {
            run,
            jobs: [
              {
                id: 90860000001,
                name: 'Verify exact-head Codex review',
                status: 'completed',
                conclusion: 'failure',
                completedAt: failedReviewJobCompletedAt,
              },
              {
                id: 90860000002,
                name: 'image',
                status: 'completed',
                conclusion: 'skipped',
                completedAt: run.updatedAt,
              },
            ],
            reviewThreadBlock: options.reviewThreadBlock ?? null,
          },
    publicationSucceeded: false,
    retryInProgress: options.retryInProgress ?? false,
  }
}

const remediationRecordPath = 'services/bayn/release-review-remediations/890d8f5801cf7c7576ed7a0cee387a4e79b98877.json'
const realRemediationRecord = parseBaynReleaseReviewRemediationRecord(
  JSON.parse(readFileSync(remediationRecordPath, 'utf8')) as unknown,
)
const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex')

const realHistory = {
  base: 'e0a38e65e7ba65fb7d00585b02d9fc2cdbeee826',
  reviewed: '8ef6b67fe799c0dddd70bc70f4648a3b23a7ca5b',
  final: 'd9903bf860ede2622ab77a9eac8e3a9454586955',
  blocked: '890d8f5801cf7c7576ed7a0cee387a4e79b98877',
  candidateHead: '9a293a7a8f7cb4ed5c8ddf41d7dbf9abecb12510',
  candidateMerge: '4f39bb8ad168c3a459afdfdb30feccd49aba22d8',
  qualificationHead: '20043b151015acf77e5e1ecd8f7e2e1daa3da090',
  qualificationMerge: '9f4ea79b12dcd32c794a9701160587d9a12e8c4d',
  remediationHead: '6'.repeat(40),
  remediationMerge: '7'.repeat(40),
} as const

const exactReviewState = (input: {
  readonly number: number
  readonly mergeCommitSha: string
  readonly headSha: string
  readonly createdAt: string
  readonly mergedAt: string
  readonly reviewedHeadSha: string
  readonly forcePushes?: readonly PullRequestForcePush[]
  readonly threads?: readonly PullRequestReviewThread[]
}): PullRequestReviewState => ({
  number: input.number,
  baseRefName: 'main',
  headSha: input.headSha,
  mergeCommitSha: input.mergeCommitSha,
  createdAt: input.createdAt,
  mergedAt: input.mergedAt,
  reviews: [
    review({
      commitSha: input.reviewedHeadSha,
      submittedAt: new Date(Date.parse(input.mergedAt) - 120_000).toISOString(),
    }),
  ],
  threads: input.threads ?? [],
  commitShas: [input.headSha],
  issueComments: [],
  reactions: [reaction({ createdAt: new Date(Date.parse(input.mergedAt) - 30_000).toISOString() })],
  headForcePushes: input.forcePushes ?? [],
  headForcePushCount: input.forcePushes?.length ?? 0,
})

const remediationHistoryFixture = (): {
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly evidence: BaynReleaseReviewRemediationEvidence
} => {
  const findingBody = 'P1: preregister the TypeScript candidate artifact.'
  const replyBody = `Fixed at exact head ${realHistory.final}.`
  const blockedPull: PullRequestReviewState = {
    number: 13428,
    baseRefName: 'main',
    headSha: realHistory.final,
    mergeCommitSha: realHistory.blocked,
    createdAt: '2026-07-31T10:58:04Z',
    mergedAt: '2026-07-31T11:15:17Z',
    reviews: [
      review({
        commitSha: realHistory.reviewed,
        submittedAt: '2026-07-31T11:01:07Z',
      }),
    ],
    threads: [
      thread({
        id: 'PRRT_kwDOLkRLus6VZVPy',
        isResolved: true,
        isOutdated: true,
        path: 'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.json',
        url: 'https://github.com/proompteng/lab/pull/13428#discussion_r3689961132',
        comments: [
          threadComment({
            body: findingBody,
            commitSha: realHistory.reviewed,
            reviewCommitSha: realHistory.reviewed,
            reviewSubmittedAt: '2026-07-31T11:01:07Z',
            createdAt: '2026-07-31T11:01:07Z',
            url: 'https://github.com/proompteng/lab/pull/13428#discussion_r3689961132',
          }),
          threadComment({
            authorLogin: 'gregkonush',
            authorAssociation: 'MEMBER',
            body: replyBody,
            commitSha: realHistory.reviewed,
            reviewCommitSha: realHistory.final,
            reviewAuthorLogin: 'gregkonush',
            reviewSubmittedAt: '2026-07-31T11:11:10Z',
            createdAt: '2026-07-31T11:11:10Z',
            url: 'https://github.com/proompteng/lab/pull/13428#discussion_r3690008122',
          }),
        ],
      }),
    ],
    commitShas: [realHistory.final],
    issueComments: [],
    reactions: [reaction({ createdAt: '2026-07-31T11:13:26Z' })],
    headForcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: realHistory.reviewed,
        afterCommitSha: realHistory.final,
        createdAt: '2026-07-31T11:10:46Z',
      },
    ],
    headForcePushCount: 1,
  }
  const candidatePull = exactReviewState({
    number: 13422,
    mergeCommitSha: realHistory.candidateMerge,
    headSha: realHistory.candidateHead,
    reviewedHeadSha: '5c5e9f5e0a53b7b0a61b21bb36388d6f8a93195a',
    createdAt: '2026-07-31T08:32:58Z',
    mergedAt: '2026-07-31T11:23:15Z',
    forcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: '5c5e9f5e0a53b7b0a61b21bb36388d6f8a93195a',
        afterCommitSha: realHistory.candidateHead,
        createdAt: '2026-07-31T11:18:00Z',
      },
    ],
  })
  const qualificationPull = exactReviewState({
    number: 13427,
    mergeCommitSha: realHistory.qualificationMerge,
    headSha: realHistory.qualificationHead,
    reviewedHeadSha: '508f0dd5a600ed26de66a2bf6c231c96055ea664',
    createdAt: '2026-07-31T10:08:26Z',
    mergedAt: '2026-07-31T11:37:39Z',
    forcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: '508f0dd5a600ed26de66a2bf6c231c96055ea664',
        afterCommitSha: realHistory.qualificationHead,
        createdAt: '2026-07-31T11:25:00Z',
      },
    ],
  })
  const record = structuredClone(realRemediationRecord)
  if (
    record.schemaVersion === 'bayn.release-review-remediation.v4' ||
    record.schemaVersion === 'bayn.release-review-remediation.v5' ||
    record.schemaVersion === 'bayn.release-review-remediation.v6' ||
    record.schemaVersion === 'bayn.release-review-remediation.v7'
  ) {
    throw new Error('expected a legacy remediation record')
  }
  const mutableRecord = record as unknown as {
    blocked: {
      sourcePullRequestEvidenceSha256: string
      feedback: { findingBodySha256: string; fixReplyBodySha256: string }
    }
    requiredDescendants: { sourcePullRequestEvidenceSha256: string }[]
  }
  mutableRecord.blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(blockedPull)
  mutableRecord.blocked.feedback.findingBodySha256 = sha256Text(findingBody)
  mutableRecord.blocked.feedback.fixReplyBodySha256 = sha256Text(replyBody)
  mutableRecord.requiredDescendants[0]!.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(candidatePull)
  mutableRecord.requiredDescendants[1]!.sourcePullRequestEvidenceSha256 =
    pullRequestReviewEvidenceSha256(qualificationPull)

  const reviewedPaths = record.blocked.affectedPaths.map((path) => ({
    path: path.path,
    blobSha: path.reviewedBlobSha,
  }))
  const finalPaths = record.blocked.affectedPaths.map((path) => ({ path: path.path, blobSha: path.finalBlobSha }))
  const candidatePaths = record.requiredDescendants[0]!.affectedPaths.map((path) => ({
    path: path.path,
    blobSha: path.finalHeadBlobSha,
  }))
  const qualificationPaths = record.requiredDescendants[1]!.affectedPaths.map((path) => ({
    path: path.path,
    blobSha: path.finalHeadBlobSha,
  }))
  const change = (path: string, blobSha: string, status = 'modified') => ({
    path,
    previousPath: null,
    status,
    blobSha,
  })
  const blockedSnapshot: BaynReleaseReviewSnapshot = {
    mainCommitParents: [realHistory.base],
    associatedPullRequests: [
      associatedPull({
        number: 13428,
        headSha: realHistory.final,
        mergeCommitSha: realHistory.blocked,
        mergedAt: blockedPull.mergedAt,
      }),
    ],
    pullRequest: blockedPull,
  }
  const candidateSnapshot: BaynReleaseReviewSnapshot = {
    mainCommitParents: [realHistory.blocked],
    associatedPullRequests: [
      associatedPull({
        number: 13422,
        headSha: realHistory.candidateHead,
        mergeCommitSha: realHistory.candidateMerge,
        mergedAt: candidatePull.mergedAt,
      }),
    ],
    pullRequest: candidatePull,
  }
  const qualificationSnapshot: BaynReleaseReviewSnapshot = {
    mainCommitParents: [realHistory.candidateMerge],
    associatedPullRequests: [
      associatedPull({
        number: 13427,
        headSha: realHistory.qualificationHead,
        mergeCommitSha: realHistory.qualificationMerge,
        mergedAt: qualificationPull.mergedAt,
      }),
    ],
    pullRequest: qualificationPull,
  }
  const remediationSnapshot = reviewSnapshotFor({
    commitSha: realHistory.remediationMerge,
    prNumber: 13430,
    headSha: realHistory.remediationHead,
    parents: [realHistory.qualificationMerge],
    mergedAt: '2026-07-31T12:20:00Z',
  })
  const recordBlobSha = '9'.repeat(40)
  const commits: NonNullable<BaynReleaseEligibilitySnapshot['comparison']>['commits'] = [
    {
      sha: realHistory.blocked,
      parents: [realHistory.base],
      treeSha: record.blocked.mergeTreeSha,
      files: record.blocked.affectedPaths.map((path) => path.path),
      fileChanges: record.blocked.affectedPaths.map((path) => change(path.path, path.blockedBlobSha, 'added')),
      reviewSnapshot: blockedSnapshot,
    },
    {
      sha: realHistory.candidateMerge,
      parents: [realHistory.blocked],
      treeSha: record.requiredDescendants[0]!.mergeTreeSha,
      files: candidatePaths.map((path) => path.path),
      fileChanges: candidatePaths.map((path) => change(path.path, path.blobSha)),
      reviewSnapshot: candidateSnapshot,
    },
    {
      sha: realHistory.qualificationMerge,
      parents: [realHistory.candidateMerge],
      treeSha: record.requiredDescendants[1]!.mergeTreeSha,
      files: qualificationPaths.map((path) => path.path),
      fileChanges: qualificationPaths.map((path) => change(path.path, path.blobSha)),
      reviewSnapshot: qualificationSnapshot,
    },
    {
      sha: realHistory.remediationMerge,
      parents: [realHistory.qualificationMerge],
      treeSha: '8'.repeat(40),
      files: [
        'packages/scripts/src/bayn/verify-release-review.ts',
        'packages/scripts/src/bayn/verify-release-review.test.ts',
        remediationRecordPath,
      ],
      fileChanges: [
        change('packages/scripts/src/bayn/verify-release-review.ts', '1'.repeat(40)),
        change('packages/scripts/src/bayn/verify-release-review.test.ts', '2'.repeat(40)),
        change(remediationRecordPath, recordBlobSha, 'added'),
      ],
      reviewSnapshot: remediationSnapshot,
    },
  ]
  const evidence: BaynReleaseReviewRemediationEvidence = {
    recordPath: remediationRecordPath,
    recordBlobSha,
    record,
    referencedCommits: [
      {
        sha: realHistory.reviewed,
        parents: [realHistory.base],
        treeSha: record.blocked.reviewedHeadTreeSha,
        files: reviewedPaths.map((path) => path.path),
        fileChanges: reviewedPaths.map((path) => change(path.path, path.blobSha, 'added')),
        pathBlobs: reviewedPaths,
      },
      {
        sha: realHistory.final,
        parents: [realHistory.base],
        treeSha: record.blocked.finalHeadTreeSha,
        files: finalPaths.map((path) => path.path),
        fileChanges: finalPaths.map((path) => change(path.path, path.blobSha, 'added')),
        pathBlobs: finalPaths,
      },
      {
        sha: realHistory.candidateHead,
        parents: [realHistory.blocked],
        treeSha: record.requiredDescendants[0]!.finalHeadTreeSha,
        files: candidatePaths.map((path) => path.path),
        fileChanges: candidatePaths.map((path) => change(path.path, path.blobSha)),
        pathBlobs: candidatePaths,
      },
      {
        sha: realHistory.qualificationHead,
        parents: [realHistory.candidateMerge],
        treeSha: record.requiredDescendants[1]!.finalHeadTreeSha,
        files: qualificationPaths.map((path) => path.path),
        fileChanges: qualificationPaths.map((path) => change(path.path, path.blobSha)),
        pathBlobs: qualificationPaths,
      },
    ],
    currentPathBlobs: finalPaths,
  }
  return {
    evidence,
    snapshot: {
      currentCommitParents: [realHistory.qualificationMerge],
      lastPublishedRevision: {
        status: 'resolved',
        revision: realHistory.base,
        runId: 1,
        runNumber: 1,
        runAttempt: 1,
      },
      comparison: {
        status: 'ahead',
        baseSha: realHistory.base,
        headSha: realHistory.remediationMerge,
        mergeBaseSha: realHistory.base,
        aheadBy: 4,
        totalCommits: 4,
        commits,
        truncated: false,
      },
      remediations: [evidence],
    },
  }
}

const multiStageRemediationRecordPath =
  'services/bayn/release-review-remediations/9bea355c17fb9320fc692bb214f76af105650a02.json'
const realMultiStageRemediationRecord = parseBaynReleaseReviewRemediationRecord(
  JSON.parse(readFileSync(multiStageRemediationRecordPath, 'utf8')) as unknown,
)
if (realMultiStageRemediationRecord.schemaVersion !== 'bayn.release-review-remediation.v3') {
  throw new Error('expected the immutable multi-stage receipt to use schema v3')
}
const multiStageHistory = {
  published: '319291bebe22b0c1dc928f13d0ff3655c4b22284',
  promotion: 'bbef7b18804cf9e30c11eac326e90281d1774b80',
  blocked: '9bea355c17fb9320fc692bb214f76af105650a02',
  candidate18: 'c778df23b22620fd12764e3bca06d0a58211b0de',
  paperProof: 'b546df44616a28629a816c982c1b6f766de41902',
  paperProofHead: 'e09a1df356c577b801e31c894e4b0af6ec61ffa4',
  activation: '8f027b41b364a18b97a6057a082a01f6abd10a83',
  activationHead: 'ef0be393714f022280338782e21384b9238b5c68',
  remediationHead: '72eb8d111c2350ae7ba1ef50819b4e3b3591a155',
  remediationMerge: '4dc99010bc8109b8ef1b79f8ed57fe6adef919ca',
  successor: '63a237698ae1c30ee03a3b93197d3a199fc9607b',
  successorHead: '006bae747436b59a2c6868e1613e3a4b5a674316',
  candidate19: 'ce0869dbd64eb945c30014040c4c3273f93a4cb4',
  candidate19Head: '9208e67f6abcc3c5059b5091a39ed539b3483242',
  completionHead: '6'.repeat(40),
  completionMerge: '7'.repeat(40),
} as const

const decodeCapturedPullRequestReviewState = (chunks: readonly string[]): PullRequestReviewState =>
  JSON.parse(gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8')) as PullRequestReviewState

const capturedPr13429ReviewState = decodeCapturedPullRequestReviewState([
  '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',
])

const capturedPr13434ReviewState = decodeCapturedPullRequestReviewState([
  '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',
  '+Lm5swHuslbvfffe/wBpfD7kIzEAAA==',
])

const capturedPr13424ReviewState = decodeCapturedPullRequestReviewState([
  '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',
])

const capturedPr13420ReviewState = decodeCapturedPullRequestReviewState([
  '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',
])

const capturedPr13435ReviewState = decodeCapturedPullRequestReviewState([
  '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',
])
const capturedPr13433ReviewState = decodeCapturedPullRequestReviewState([
  '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',
])

const capturedPr13436ReviewState = decodeCapturedPullRequestReviewState([
  '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',
])

const captureMultiStageReceiptEvidence = (
  record: BaynReleaseReviewRemediationRecord,
): {
  readonly sourcePull: PullRequestReviewState
  readonly descendantPulls: ReadonlyMap<string, PullRequestReviewState>
  readonly introductionPull: PullRequestReviewState
  readonly successorPulls: ReadonlyMap<string, PullRequestReviewState>
} => {
  if (
    record.schemaVersion !== 'bayn.release-review-remediation.v3' ||
    record.blocked.reconstruction === undefined ||
    record.introduction === undefined
  ) {
    throw new Error('expected a v3 multi-stage remediation record')
  }
  const sourcePull = structuredClone(capturedPr13429ReviewState)
  const descendantPulls = new Map<string, PullRequestReviewState>([
    [multiStageHistory.candidate18, structuredClone(capturedPr13434ReviewState)],
    [multiStageHistory.paperProof, structuredClone(capturedPr13424ReviewState)],
    [multiStageHistory.activation, structuredClone(capturedPr13420ReviewState)],
  ])
  const introductionPull = structuredClone(capturedPr13435ReviewState)
  const successorPulls = new Map<string, PullRequestReviewState>([
    [multiStageHistory.successor, structuredClone(capturedPr13433ReviewState)],
    [multiStageHistory.candidate19, structuredClone(capturedPr13436ReviewState)],
  ])
  if (pullRequestReviewEvidenceSha256(sourcePull) !== record.blocked.sourcePullRequestEvidenceSha256) {
    throw new Error('captured PR #13429 evidence does not match the committed receipt')
  }
  for (const descendant of record.requiredDescendants) {
    const pullRequest = descendantPulls.get(descendant.mergeCommitSha)
    if (
      pullRequest === undefined ||
      pullRequestReviewEvidenceSha256(pullRequest) !== descendant.sourcePullRequestEvidenceSha256
    ) {
      throw new Error(
        `captured PR #${descendant.sourcePullRequestNumber} evidence does not match the committed receipt`,
      )
    }
  }
  if (pullRequestReviewEvidenceSha256(introductionPull) !== record.introduction.sourcePullRequestEvidenceSha256) {
    throw new Error('captured PR #13435 evidence does not match the committed receipt')
  }
  for (const successor of record.requiredSuccessors ?? []) {
    const pullRequest = successorPulls.get(successor.mergeCommitSha)
    if (
      pullRequest === undefined ||
      pullRequestReviewEvidenceSha256(pullRequest) !== successor.sourcePullRequestEvidenceSha256
    ) {
      throw new Error(`captured PR #${successor.sourcePullRequestNumber} evidence does not match the committed receipt`)
    }
  }
  for (const feedback of record.blocked.reconstruction.feedback) {
    const thread = sourcePull.threads.find((candidate) => candidate.id === feedback.threadId)
    const finding = thread?.comments.find((comment) => comment.url === feedback.findingUrl)
    const reply = thread?.comments.find((comment) => comment.url === feedback.fixReplyUrl)
    if (
      thread === undefined ||
      finding === undefined ||
      reply === undefined ||
      sha256Text(finding.body) !== feedback.findingBodySha256 ||
      sha256Text(reply.body) !== feedback.fixReplyBodySha256
    ) {
      throw new Error(`captured feedback ${feedback.threadId} does not match the committed receipt`)
    }
  }
  return { sourcePull, descendantPulls, introductionPull, successorPulls }
}

const multiStageRemediationFixture = (): {
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly evidence: BaynReleaseReviewRemediationEvidence
} => {
  const record = structuredClone(realMultiStageRemediationRecord) as BaynReleaseReviewRemediationRecord
  if (
    record.schemaVersion !== 'bayn.release-review-remediation.v3' ||
    record.blocked.reconstruction === undefined ||
    record.introduction === undefined
  ) {
    throw new Error('expected a v3 multi-stage remediation record')
  }
  const reconstruction = record.blocked.reconstruction
  const { sourcePull, descendantPulls, introductionPull, successorPulls } = captureMultiStageReceiptEvidence(record)
  const change = (path: string, blobSha: string, status = 'modified') => ({
    path,
    previousPath: null,
    status,
    blobSha,
  })
  const snapshotForPull = (pullRequest: PullRequestReviewState, parent: string): BaynReleaseReviewSnapshot => ({
    mainCommitParents: [parent],
    associatedPullRequests: [
      associatedPull({
        number: pullRequest.number,
        headSha: pullRequest.headSha,
        mergeCommitSha: pullRequest.mergeCommitSha,
        mergedAt: pullRequest.mergedAt,
      }),
    ],
    pullRequest,
  })
  const finalHead = reconstruction.heads.at(-1)
  if (finalHead === undefined) throw new Error('expected final reconstructed head')
  const recordBlobSha = '9'.repeat(40)
  const promotionCommit = {
    sha: multiStageHistory.promotion,
    parents: [multiStageHistory.published],
    treeSha: '8'.repeat(40),
    files: ['argocd/applications/bayn/deployment.yaml', 'argocd/applications/bayn/kustomization.yaml'],
    fileChanges: [
      change('argocd/applications/bayn/deployment.yaml', '1'.repeat(40)),
      change('argocd/applications/bayn/kustomization.yaml', '2'.repeat(40)),
    ],
    reviewSnapshot: null,
  } as const
  const blockedCommit = {
    sha: multiStageHistory.blocked,
    parents: [multiStageHistory.promotion],
    treeSha: record.blocked.mergeTreeSha,
    files: finalHead.affectedPaths.map((path) => path.path),
    fileChanges: finalHead.affectedPaths.map((path) => ({
      path: path.path,
      previousPath: path.previousPath,
      status: path.status,
      blobSha: path.blobSha,
    })),
    reviewSnapshot: snapshotForPull(sourcePull, multiStageHistory.promotion),
  } as const
  const descendantParents = new Map<string, string>([
    [multiStageHistory.candidate18, multiStageHistory.blocked],
    [multiStageHistory.paperProof, multiStageHistory.candidate18],
    [multiStageHistory.activation, multiStageHistory.paperProof],
  ])
  const descendantCommits = record.requiredDescendants.map((descendant) => {
    const pullRequest = descendantPulls.get(descendant.mergeCommitSha)
    const parent = descendantParents.get(descendant.mergeCommitSha)
    if (pullRequest === undefined || parent === undefined) throw new Error('missing captured descendant')
    return {
      sha: descendant.mergeCommitSha,
      parents: [parent],
      treeSha: descendant.mergeTreeSha,
      files: descendant.affectedPaths.map((path) => path.path),
      fileChanges: descendant.affectedPaths.map((path) => change(path.path, path.mergeBlobSha)),
      reviewSnapshot: snapshotForPull(pullRequest, parent),
    }
  })
  const introductionCommit = {
    sha: multiStageHistory.remediationMerge,
    parents: [multiStageHistory.activation],
    treeSha: '3'.repeat(40),
    files: [
      'packages/scripts/src/bayn/verify-release-review.ts',
      'packages/scripts/src/bayn/verify-release-review.test.ts',
      multiStageRemediationRecordPath,
    ],
    fileChanges: [
      change('packages/scripts/src/bayn/verify-release-review.ts', '4'.repeat(40)),
      change('packages/scripts/src/bayn/verify-release-review.test.ts', '5'.repeat(40)),
      change(multiStageRemediationRecordPath, record.introduction.introducedRecordBlobSha, 'added'),
    ],
    reviewSnapshot: snapshotForPull(introductionPull, multiStageHistory.activation),
  } as const
  const completionSnapshot = reviewSnapshotFor({
    commitSha: multiStageHistory.completionMerge,
    prNumber: 13437,
    headSha: multiStageHistory.completionHead,
    parents: [multiStageHistory.candidate19],
    mergedAt: '2026-07-31T18:01:30Z',
    reviews: [
      review({
        commitSha: multiStageHistory.completionHead,
        submittedAt: '2026-07-31T18:01:00Z',
      }),
    ],
  })
  const successorRecord = record.requiredSuccessors?.[0]
  const successorPull = successorPulls.get(multiStageHistory.successor)
  if (successorRecord === undefined || successorPull === undefined) throw new Error('missing captured successor')
  const successorCommit = {
    sha: successorRecord.mergeCommitSha,
    parents: [multiStageHistory.remediationMerge],
    treeSha: successorRecord.mergeTreeSha,
    files: successorRecord.affectedPaths.map((path) => path.path),
    fileChanges: successorRecord.affectedPaths.map((path) => change(path.path, path.mergeBlobSha)),
    reviewSnapshot: snapshotForPull(successorPull, multiStageHistory.remediationMerge),
  } as const
  const candidate19Record = record.requiredSuccessors?.[1]
  const candidate19Pull = successorPulls.get(multiStageHistory.candidate19)
  if (candidate19Record === undefined || candidate19Pull === undefined) {
    throw new Error('missing captured Candidate 19 successor')
  }
  const candidate19Commit = {
    sha: candidate19Record.mergeCommitSha,
    parents: [multiStageHistory.successor],
    treeSha: candidate19Record.mergeTreeSha,
    files: candidate19Record.affectedPaths.map((path) => path.path),
    fileChanges: candidate19Record.affectedPaths.map((path) => change(path.path, path.mergeBlobSha)),
    reviewSnapshot: snapshotForPull(candidate19Pull, multiStageHistory.successor),
  } as const
  const completionCommit = {
    sha: multiStageHistory.completionMerge,
    parents: [multiStageHistory.candidate19],
    treeSha: 'a'.repeat(40),
    files: [
      'packages/scripts/src/bayn/verify-release-review.ts',
      'packages/scripts/src/bayn/verify-release-review.test.ts',
      multiStageRemediationRecordPath,
    ],
    fileChanges: [
      change('packages/scripts/src/bayn/verify-release-review.ts', 'b'.repeat(40)),
      change('packages/scripts/src/bayn/verify-release-review.test.ts', 'c'.repeat(40)),
      change(multiStageRemediationRecordPath, recordBlobSha, 'modified'),
    ],
    reviewSnapshot: completionSnapshot,
  } as const
  const expectedCurrent = new Map(finalHead.affectedPaths.map((path) => [path.path, path.blobSha] as const))
  for (const descendant of [...record.requiredDescendants, ...(record.requiredSuccessors ?? [])]) {
    for (const path of descendant.affectedPaths) {
      if (expectedCurrent.has(path.path)) expectedCurrent.set(path.path, path.mergeBlobSha)
    }
  }
  const finalHeadParents = new Map<string, string>([
    [multiStageHistory.candidate18, multiStageHistory.blocked],
    [multiStageHistory.paperProof, multiStageHistory.candidate18],
    [multiStageHistory.activation, multiStageHistory.paperProof],
    [multiStageHistory.successor, multiStageHistory.remediationMerge],
    [multiStageHistory.candidate19, multiStageHistory.successor],
  ])
  const evidence: BaynReleaseReviewRemediationEvidence = {
    recordPath: multiStageRemediationRecordPath,
    recordBlobSha,
    record,
    referencedCommits: [
      ...reconstruction.heads.map((head) => ({
        sha: head.headSha,
        parents: [head.parentSha],
        treeSha: head.treeSha,
        files: head.affectedPaths.map((path) => path.path),
        fileChanges: head.affectedPaths.map((path) => ({
          path: path.path,
          previousPath: path.previousPath,
          status: path.status,
          blobSha: path.blobSha,
        })),
        pathBlobs: head.affectedPaths.map((path) => ({ path: path.path, blobSha: path.blobSha })),
      })),
      ...[...record.requiredDescendants, ...(record.requiredSuccessors ?? [])].map((descendant) => ({
        sha: descendant.finalHeadSha,
        parents: [finalHeadParents.get(descendant.mergeCommitSha) ?? '0'.repeat(40)],
        treeSha: descendant.finalHeadTreeSha,
        files: descendant.affectedPaths.map((path) => path.path),
        fileChanges: [],
        pathBlobs: descendant.affectedPaths.map((path) => ({
          path: path.path,
          blobSha: path.finalHeadBlobSha,
        })),
      })),
    ],
    currentPathBlobs: [...expectedCurrent].map(([path, blobSha]) => ({ path, blobSha })),
  }
  return {
    evidence,
    snapshot: {
      currentCommitParents: [multiStageHistory.candidate19],
      lastPublishedRevision: {
        status: 'resolved',
        revision: multiStageHistory.published,
        runId: 30632855271,
        runNumber: 910,
        runAttempt: 1,
      },
      comparison: {
        status: 'ahead',
        baseSha: multiStageHistory.published,
        headSha: multiStageHistory.completionMerge,
        mergeBaseSha: multiStageHistory.published,
        aheadBy: 9,
        totalCommits: 9,
        commits: [
          promotionCommit,
          blockedCommit,
          ...descendantCommits,
          introductionCommit,
          successorCommit,
          candidate19Commit,
          completionCommit,
        ],
        truncated: false,
      },
      remediations: [evidence],
    },
  }
}

const continuousRemediationRecordPath =
  'services/bayn/release-review-remediations/6737d29cda608c79714046d420ab7396d8e80f70.json'
const realContinuousRemediationRecord = parseBaynReleaseReviewRemediationRecord(
  JSON.parse(readFileSync(continuousRemediationRecordPath, 'utf8')) as unknown,
)
const candidateDiagnosticsRemediationRecordPath =
  'services/bayn/release-review-remediations/ae4d23650c20cecbde2bac8416bc2b734381cb69.json'
const realCandidateDiagnosticsRemediationRecord = parseBaynReleaseReviewRemediationRecord(
  JSON.parse(readFileSync(candidateDiagnosticsRemediationRecordPath, 'utf8')) as unknown,
)
const continuousHistory = {
  published: '69d803040c8866e7703df50a645a096c54e7eca5',
  blocked: '6737d29cda608c79714046d420ab7396d8e80f70',
  finalHead: 'adc96644904d1f1c2640cc6a597d1cfc108caf91',
  priorHead: 'ab989db8b42f9814f7aa22f7460becdee847a492',
  intermediates: [
    '2aa782001a9d7e1d9db68e5fa0929159755334cd',
    '7c2335792707e34ac41e4de5091d2e2af48b7657',
    'ae4d23650c20cecbde2bac8416bc2b734381cb69',
    'fa2016a8aa3c8b0f466ab84a7956c704dd9056c7',
  ],
  introductionHead: '3870d78808d0eec4f8d8a6b6d6f91af406d8fe05',
  introductionMerge: 'af1e0b0707c9f3ae6b05568b7e2984888d0d7d14',
  completionHead: 'a'.repeat(40),
  completionMerge: 'b'.repeat(40),
} as const
const continuousNowMs = Date.parse('2026-08-01T08:32:00Z')

const continuousRemediationFixture = (): {
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly evidence: BaynReleaseReviewRemediationEvidence
} => {
  const currentRecord = structuredClone(realContinuousRemediationRecord)
  if (currentRecord.schemaVersion !== 'bayn.release-review-remediation.v6') {
    throw new Error('expected a v6 continuous-source remediation record')
  }
  const record = parseBaynReleaseReviewRemediationRecord({
    schemaVersion: 'bayn.release-review-remediation.v5',
    remediationId: currentRecord.remediationId,
    blocked: currentRecord.blocked,
    requiredDescendants: [],
    introduction: currentRecord.introduction,
  })
  if (record.schemaVersion !== 'bayn.release-review-remediation.v5') {
    throw new Error('failed to derive the v5 continuous-source fixture')
  }
  const blockedPull: PullRequestReviewState = {
    number: 13426,
    baseRefName: 'main',
    headSha: continuousHistory.finalHead,
    mergeCommitSha: continuousHistory.blocked,
    createdAt: '2026-07-31T09:38:15Z',
    mergedAt: '2026-07-31T20:36:05Z',
    reviews: [
      review({
        commitSha: continuousHistory.priorHead,
        submittedAt: '2026-07-31T20:14:12Z',
      }),
    ],
    threads: [],
    commitShas: [continuousHistory.finalHead],
    issueComments: [],
    reactions: [reaction({ createdAt: '2026-07-31T20:35:28Z' })],
    headForcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: continuousHistory.priorHead,
        afterCommitSha: continuousHistory.finalHead,
        createdAt: '2026-07-31T20:29:25Z',
      },
    ],
    headForcePushCount: 1,
  }
  ;(
    record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
  ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(blockedPull)

  const introductionPull: PullRequestReviewState = {
    number: 13443,
    baseRefName: 'main',
    headSha: continuousHistory.introductionHead,
    mergeCommitSha: continuousHistory.introductionMerge,
    createdAt: '2026-07-31T21:37:06Z',
    mergedAt: '2026-08-01T08:29:45Z',
    reviews: [],
    threads: [],
    commitShas: [continuousHistory.introductionHead],
    issueComments: [
      {
        authorLogin: 'linear-code[bot]',
        body: '<!-- linear-linkback -->\n<p><a href="https://linear.app/proompteng/issue/PROOMPT-443">PROOMPT-443</a></p>',
        createdAt: '2026-07-31T21:37:08Z',
        updatedAt: '2026-07-31T21:37:08Z',
      },
      {
        authorLogin: 'gregkonush',
        body: 'Exact-head completion audit on `6324fb116daa2cccbea895fde39ce46f61d39d0b` / base `2aa782001a9d7e1d9db68e5fa0929159755334cd`:\n\n- automatic review: unique trusted +1 at 2026-07-31T21:39:54Z; zero review threads\n- hosted gates: all successful, including packages-scripts, full Bayn, PostgreSQL 18, amd64, arm64, Effect compatibility, dependency invariant, broker sandbox, planner, and Bayn release gate\n- scope: one commit, exactly the two verifier files plus the immutable v4 receipt\n- worktree: clean\n- merge/auto-merge: not enabled; PR remains open\n\nRequired hold order remains: #13444 (PROOMPT-445) merge, then #13442 rebase/fresh review/merge, then fresh safe-main audit. Do not merge this PR before that sequence completes.\n',
        createdAt: '2026-07-31T21:43:38Z',
        updatedAt: '2026-07-31T21:43:38Z',
      },
      {
        authorLogin: 'gregkonush',
        body: '<!-- codex:ready -->\n:shipit:',
        createdAt: '2026-07-31T21:43:41Z',
        updatedAt: '2026-07-31T21:43:41Z',
      },
    ],
    reactions: [reaction({ createdAt: '2026-08-01T08:29:17Z' })],
    headForcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: '6324fb116daa2cccbea895fde39ce46f61d39d0b',
        afterCommitSha: continuousHistory.introductionHead,
        createdAt: '2026-08-01T08:24:53Z',
      },
    ],
    headForcePushCount: 1,
  }
  if (pullRequestReviewEvidenceSha256(introductionPull) !== record.introduction.sourcePullRequestEvidenceSha256) {
    throw new Error('exact #13443 review evidence fixture drifted')
  }

  const blockedChanges = record.blocked.affectedPaths.map((path) => ({ ...path }))
  const blockedPathBlobs = blockedChanges.map((path) => ({ path: path.path, blobSha: path.blobSha }))
  const blockedCommit = {
    sha: continuousHistory.blocked,
    parents: [continuousHistory.published],
    treeSha: record.blocked.mergeTreeSha,
    files: blockedChanges.map((path) => path.path),
    fileChanges: blockedChanges,
    reviewSnapshot: {
      mainCommitParents: [continuousHistory.published],
      associatedPullRequests: [
        associatedPull({
          number: 13426,
          headSha: continuousHistory.finalHead,
          mergeCommitSha: continuousHistory.blocked,
          mergedAt: blockedPull.mergedAt,
        }),
      ],
      pullRequest: blockedPull,
    },
  }
  const intermediateCommits = continuousHistory.intermediates.map((sha, index) => ({
    sha,
    parents: [index === 0 ? continuousHistory.blocked : continuousHistory.intermediates[index - 1]!],
    treeSha: `${index + 1}`.repeat(40),
    files: [`docs/proompt-443-intermediate-${index}.md`],
    fileChanges: [
      {
        path: `docs/proompt-443-intermediate-${index}.md`,
        previousPath: null,
        status: 'added',
        blobSha: `${index + 5}`.repeat(40),
      },
    ],
    reviewSnapshot: null,
  }))
  const introductionChanges = record.introduction.affectedPaths.map((path) => ({ ...path }))
  const introductionPathBlobs = introductionChanges.map((path) => ({ path: path.path, blobSha: path.blobSha }))
  const introductionCommit = {
    sha: continuousHistory.introductionMerge,
    parents: [record.introduction.mergeParentSha],
    treeSha: record.introduction.mergeTreeSha,
    files: introductionChanges.map((path) => path.path),
    fileChanges: introductionChanges,
    reviewSnapshot: {
      mainCommitParents: [record.introduction.mergeParentSha],
      associatedPullRequests: [
        associatedPull({
          number: 13443,
          headSha: continuousHistory.introductionHead,
          mergeCommitSha: continuousHistory.introductionMerge,
          mergedAt: introductionPull.mergedAt,
        }),
      ],
      pullRequest: introductionPull,
    },
  }
  const recordBlobSha = '8'.repeat(40)
  const completionCommit = {
    sha: continuousHistory.completionMerge,
    parents: [continuousHistory.introductionMerge],
    treeSha: 'c'.repeat(40),
    files: [
      'packages/scripts/src/bayn/verify-release-review.test.ts',
      'packages/scripts/src/bayn/verify-release-review.ts',
      continuousRemediationRecordPath,
    ],
    fileChanges: [
      {
        path: 'packages/scripts/src/bayn/verify-release-review.test.ts',
        previousPath: null,
        status: 'modified',
        blobSha: 'd'.repeat(40),
      },
      {
        path: 'packages/scripts/src/bayn/verify-release-review.ts',
        previousPath: null,
        status: 'modified',
        blobSha: 'e'.repeat(40),
      },
      {
        path: continuousRemediationRecordPath,
        previousPath: null,
        status: 'modified',
        blobSha: recordBlobSha,
      },
    ],
    reviewSnapshot: reviewSnapshotFor({
      commitSha: continuousHistory.completionMerge,
      prNumber: 13445,
      headSha: continuousHistory.completionHead,
      parents: [continuousHistory.introductionMerge],
      mergedAt: '2026-08-01T08:31:00Z',
      reviews: [
        review({
          commitSha: continuousHistory.completionHead,
          submittedAt: '2026-08-01T08:30:00Z',
        }),
      ],
    }),
  }
  const evidence: BaynReleaseReviewRemediationEvidence = {
    recordPath: continuousRemediationRecordPath,
    recordBlobSha,
    record,
    referencedCommits: [
      {
        sha: continuousHistory.finalHead,
        parents: [continuousHistory.published],
        treeSha: record.blocked.finalHeadTreeSha,
        files: blockedChanges.map((path) => path.path),
        fileChanges: blockedChanges,
        pathBlobs: blockedPathBlobs,
      },
      {
        sha: continuousHistory.introductionHead,
        parents: [record.introduction.finalHeadParentSha],
        treeSha: record.introduction.finalHeadTreeSha,
        files: introductionChanges.map((path) => path.path),
        fileChanges: introductionChanges,
        pathBlobs: introductionPathBlobs,
      },
    ],
    currentPathBlobs: blockedPathBlobs,
  }
  const commits = [blockedCommit, ...intermediateCommits, introductionCommit, completionCommit]
  return {
    evidence,
    snapshot: {
      currentCommitParents: [continuousHistory.introductionMerge],
      lastPublishedRevision: {
        status: 'resolved',
        revision: continuousHistory.published,
        runId: 30663490856,
        runNumber: 930,
        runAttempt: 1,
      },
      comparison: {
        status: 'ahead',
        baseSha: continuousHistory.published,
        headSha: continuousHistory.completionMerge,
        mergeBaseSha: continuousHistory.published,
        aheadBy: commits.length,
        totalCommits: commits.length,
        commits,
        truncated: false,
      },
      remediations: [evidence],
    },
  }
}

const continuousIntroductionEvidence = (fixture: ReturnType<typeof continuousRemediationFixture>) => {
  const record = fixture.evidence.record
  if (record.schemaVersion !== 'bayn.release-review-remediation.v5') {
    throw new Error('expected a v5 continuous-source remediation record')
  }
  const introductionCommit = fixture.snapshot.comparison?.commits.find(
    (commit) => commit.sha === continuousHistory.introductionMerge,
  )
  const pullRequest = introductionCommit?.reviewSnapshot?.pullRequest
  const finalHead = fixture.evidence.referencedCommits.find(
    (commit) => commit.sha === continuousHistory.introductionHead,
  )
  if (
    introductionCommit === undefined ||
    pullRequest === null ||
    pullRequest === undefined ||
    finalHead === undefined
  ) {
    throw new Error('missing #13443 introduction evidence')
  }
  return { record, introductionCommit, pullRequest, finalHead }
}

const rebindContinuousIntroductionPull = (fixture: ReturnType<typeof continuousRemediationFixture>): void => {
  const { record, pullRequest } = continuousIntroductionEvidence(fixture)
  ;(record.introduction as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
    pullRequestReviewEvidenceSha256(pullRequest)
}

const evaluateContinuousRemediationFixture = (
  fixture: ReturnType<typeof continuousRemediationFixture>,
  nowMs = continuousNowMs,
) =>
  evaluateBaynReleaseEligibility({
    mainCommitSha: continuousHistory.completionMerge,
    baseRefName: 'main',
    snapshot: fixture.snapshot,
    nowMs,
    pushBeforeSha: continuousHistory.introductionMerge,
  })

const successorBoundHistory = {
  updateHead: '4'.repeat(40),
  updateMerge: '9'.repeat(40),
} as const
const successorBoundNowMs = Date.parse('2026-08-01T09:02:00Z')

const successorBoundContinuousRemediationFixture = (): {
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly evidence: BaynReleaseReviewRemediationEvidence
} => {
  const fixture = continuousRemediationFixture()
  const comparison = fixture.snapshot.comparison
  if (comparison === null || comparison.status !== 'ahead') throw new Error('missing continuous-source comparison')
  const record = structuredClone(realContinuousRemediationRecord)
  if (record.schemaVersion !== 'bayn.release-review-remediation.v6') {
    throw new Error('expected a v6 continuous-source remediation record')
  }

  const blockedCommit = comparison.commits.find((commit) => commit.sha === record.blocked.mergeCommitSha)
  const blockedPull = blockedCommit?.reviewSnapshot?.pullRequest
  if (blockedPull === null || blockedPull === undefined) throw new Error('missing blocked source pull request')
  ;(record.blocked as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
    pullRequestReviewEvidenceSha256(blockedPull)

  const successor = record.requiredSuccessors[0]
  const successorReviewSnapshot = reviewSnapshotFor({
    commitSha: successor.mergeCommitSha,
    prNumber: successor.sourcePullRequestNumber,
    headSha: successor.finalHeadSha,
    parents: [successor.mergeParentSha],
    mergedAt: '2026-07-31T21:12:49Z',
    reviews: [
      review({
        commitSha: successor.finalHeadSha,
        submittedAt: '2026-07-31T21:11:02Z',
      }),
    ],
  })
  const successorPull = successorReviewSnapshot.pullRequest
  if (successorPull === null) throw new Error('missing successor pull request')
  ;(successor as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
    pullRequestReviewEvidenceSha256(successorPull)
  const successorCommit = {
    sha: successor.mergeCommitSha,
    parents: [successor.mergeParentSha],
    treeSha: successor.mergeTreeSha,
    files: successor.affectedPaths.map((path) => path.path),
    fileChanges: successor.affectedPaths.map((path) => ({ ...path })),
    reviewSnapshot: successorReviewSnapshot,
  }

  const completion = record.completion
  const completionReviewSnapshot = reviewSnapshotFor({
    commitSha: completion.mergeCommitSha,
    prNumber: completion.sourcePullRequestNumber,
    headSha: completion.finalHeadSha,
    parents: [completion.mergeParentSha],
    mergedAt: '2026-08-01T08:31:00Z',
    reviews: [
      review({
        commitSha: completion.finalHeadSha,
        submittedAt: '2026-08-01T08:30:00Z',
      }),
    ],
  })
  const completionPull = completionReviewSnapshot.pullRequest
  if (completionPull === null) throw new Error('missing completion pull request')
  ;(completion as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
    pullRequestReviewEvidenceSha256(completionPull)
  const completionCommit = {
    sha: completion.mergeCommitSha,
    parents: [completion.mergeParentSha],
    treeSha: completion.mergeTreeSha,
    files: completion.affectedPaths.map((path) => path.path),
    fileChanges: completion.affectedPaths.map((path) => ({ ...path })),
    reviewSnapshot: completionReviewSnapshot,
  }

  const currentRecordBlobSha = '8'.repeat(40)
  const updateChanges = [
    {
      path: 'packages/scripts/src/bayn/verify-release-review.test.ts',
      previousPath: null,
      status: 'modified',
      blobSha: '1'.repeat(40),
    },
    {
      path: 'packages/scripts/src/bayn/verify-release-review.ts',
      previousPath: null,
      status: 'modified',
      blobSha: '2'.repeat(40),
    },
    {
      path: continuousRemediationRecordPath,
      previousPath: null,
      status: 'modified',
      blobSha: currentRecordBlobSha,
    },
  ] as const
  const updateCommit = {
    sha: successorBoundHistory.updateMerge,
    parents: [completion.mergeCommitSha],
    treeSha: '3'.repeat(40),
    files: updateChanges.map((path) => path.path),
    fileChanges: updateChanges,
    reviewSnapshot: reviewSnapshotFor({
      commitSha: successorBoundHistory.updateMerge,
      prNumber: 13446,
      headSha: successorBoundHistory.updateHead,
      parents: [completion.mergeCommitSha],
      mergedAt: '2026-08-01T09:01:00Z',
      reviews: [
        review({
          commitSha: successorBoundHistory.updateHead,
          submittedAt: '2026-08-01T09:00:00Z',
        }),
      ],
    }),
  }

  const commits = comparison.commits
    .map((commit) => {
      if (commit.sha === successor.mergeCommitSha) return successorCommit
      if (commit.sha === continuousHistory.completionMerge) return completionCommit
      return commit
    })
    .concat(updateCommit)
  const expectedCurrentBlobs = new Map(record.blocked.affectedPaths.map((path) => [path.path, path.blobSha] as const))
  for (const transition of successor.protectedPathTransitions) {
    expectedCurrentBlobs.set(transition.path, transition.afterBlobSha)
  }
  const evidence: BaynReleaseReviewRemediationEvidence = {
    recordPath: continuousRemediationRecordPath,
    recordBlobSha: currentRecordBlobSha,
    record,
    referencedCommits: [
      fixture.evidence.referencedCommits[0]!,
      {
        sha: successor.finalHeadSha,
        parents: [successor.finalHeadParentSha],
        treeSha: successor.finalHeadTreeSha,
        files: successor.affectedPaths.map((path) => path.path),
        fileChanges: successor.affectedPaths.map((path) => ({ ...path })),
        pathBlobs: successor.affectedPaths.map((path) => ({ path: path.path, blobSha: path.blobSha })),
      },
      fixture.evidence.referencedCommits[1]!,
      {
        sha: completion.finalHeadSha,
        parents: [completion.finalHeadParentSha],
        treeSha: completion.finalHeadTreeSha,
        files: completion.affectedPaths.map((path) => path.path),
        fileChanges: completion.affectedPaths.map((path) => ({ ...path })),
        pathBlobs: completion.affectedPaths.map((path) => ({ path: path.path, blobSha: path.blobSha })),
      },
    ],
    currentPathBlobs: [...expectedCurrentBlobs].map(([path, blobSha]) => ({ path, blobSha })),
  }
  return {
    evidence,
    snapshot: {
      ...fixture.snapshot,
      currentCommitParents: [completion.mergeCommitSha],
      comparison: {
        ...comparison,
        headSha: successorBoundHistory.updateMerge,
        aheadBy: commits.length,
        totalCommits: commits.length,
        commits,
      },
      remediations: [evidence],
    },
  }
}

const evaluateSuccessorBoundContinuousRemediationFixture = (
  fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>,
  nowMs = successorBoundNowMs,
) =>
  evaluateBaynReleaseEligibility({
    mainCommitSha: successorBoundHistory.updateMerge,
    baseRefName: 'main',
    snapshot: fixture.snapshot,
    nowMs,
    pushBeforeSha:
      realContinuousRemediationRecord.schemaVersion === 'bayn.release-review-remediation.v6'
        ? realContinuousRemediationRecord.completion.mergeCommitSha
        : '0'.repeat(40),
  })

const singleStageSuccessorRemediationFixture = (): ReturnType<typeof successorBoundContinuousRemediationFixture> => {
  const fixture = successorBoundContinuousRemediationFixture()
  const comparison = fixture.snapshot.comparison
  const currentRecord = fixture.evidence.record
  if (
    comparison === null ||
    comparison.status !== 'ahead' ||
    currentRecord.schemaVersion !== 'bayn.release-review-remediation.v6'
  ) {
    throw new Error('missing successor-bound continuous-source fixture')
  }
  const currentSuccessor = currentRecord.requiredSuccessors[0]
  const successorAffectedPaths = new Set(currentSuccessor.affectedPaths.map((path) => path.path))
  const additionalBlockedPath = currentRecord.blocked.affectedPaths.find(
    (path) => !successorAffectedPaths.has(path.path),
  )
  if (additionalBlockedPath === undefined) throw new Error('missing second synthetic v7 protected path')
  const additionalAfterBlobSha = 'f'.repeat(40)
  const successor = {
    ...currentSuccessor,
    affectedPaths: [
      ...currentSuccessor.affectedPaths,
      {
        ...additionalBlockedPath,
        previousPath: null,
        status: 'modified' as const,
        blobSha: additionalAfterBlobSha,
      },
    ],
    protectedPathTransitions: [
      ...currentSuccessor.protectedPathTransitions,
      {
        path: additionalBlockedPath.path,
        beforeBlobSha: additionalBlockedPath.blobSha,
        afterBlobSha: additionalAfterBlobSha,
      },
    ],
  }
  const successorTransitionPaths = new Set(successor.protectedPathTransitions.map((transition) => transition.path))
  const blockedCommit = comparison.commits.find((commit) => commit.sha === currentRecord.blocked.mergeCommitSha)
  const blockedPull = blockedCommit?.reviewSnapshot?.pullRequest
  if (blockedCommit === undefined || blockedPull === null || blockedPull === undefined) {
    throw new Error('missing v7 blocked source pull request')
  }
  const reviewedHeadSha = 'c'.repeat(40)
  const reviewedHeadTreeSha = 'd'.repeat(40)
  const reviewSubmittedAt = '2026-07-31T20:10:00Z'
  const forcePushAt = '2026-07-31T20:20:00Z'
  const findingBody = 'Catch the synchronous writer throw before it escapes the Effect boundary.'
  const replyBody = 'Fixed in the final exact head with a real process regression.'
  const reviewedAffectedPaths = currentRecord.blocked.affectedPaths
    .filter((path) => successorTransitionPaths.has(path.path))
    .map((path, index) => ({ ...path, blobSha: `${index + 5}`.repeat(40) }))
  const feedbackPath = reviewedAffectedPaths[0]
  if (feedbackPath === undefined) throw new Error('missing v7 feedback path')
  ;(blockedPull as unknown as { createdAt: string; mergedAt: string }).createdAt = '2026-07-31T20:00:00Z'
  ;(blockedPull as unknown as { mergedAt: string }).mergedAt = '2026-07-31T20:30:00Z'
  ;(blockedPull as unknown as { reviews: readonly PullRequestReview[] }).reviews = [
    review({ commitSha: reviewedHeadSha, submittedAt: reviewSubmittedAt }),
  ]
  ;(blockedPull as unknown as { threads: readonly PullRequestReviewThread[] }).threads = [
    thread({
      id: 'v7-reviewed-lineage-thread',
      isResolved: true,
      isOutdated: true,
      path: feedbackPath.path,
      comments: [
        threadComment({
          body: findingBody,
          commitSha: reviewedHeadSha,
          reviewCommitSha: reviewedHeadSha,
          reviewSubmittedAt,
          createdAt: reviewSubmittedAt,
          url: 'https://github.com/proompteng/lab/pull/13438#discussion_r1',
        }),
        threadComment({
          authorLogin: 'gregkonush',
          authorAssociation: 'MEMBER',
          body: replyBody,
          commitSha: reviewedHeadSha,
          reviewCommitSha: currentRecord.blocked.finalHeadSha,
          reviewAuthorLogin: 'gregkonush',
          reviewSubmittedAt: '2026-07-31T20:21:00Z',
          createdAt: '2026-07-31T20:21:00Z',
          url: 'https://github.com/proompteng/lab/pull/13438#discussion_r2',
        }),
      ],
    }),
  ]
  ;(blockedPull as unknown as { reactions: readonly PullRequestReaction[] }).reactions = [
    reaction({ createdAt: '2026-07-31T20:22:00Z' }),
  ]
  ;(blockedPull as unknown as { headForcePushes: readonly PullRequestForcePush[] }).headForcePushes = [
    {
      actorLogin: 'gregkonush',
      beforeCommitSha: reviewedHeadSha,
      afterCommitSha: currentRecord.blocked.finalHeadSha,
      createdAt: forcePushAt,
    },
  ]
  ;(blockedPull as unknown as { headForcePushCount: number }).headForcePushCount = 1
  const record = parseBaynReleaseReviewRemediationRecord({
    schemaVersion: 'bayn.release-review-remediation.v7',
    remediationId: 'pr-13438-successor-bound-reviewed-source',
    blocked: {
      ...currentRecord.blocked,
      affectedPaths: currentRecord.blocked.affectedPaths.filter((path) => successorTransitionPaths.has(path.path)),
      sourcePullRequestEvidenceSha256: pullRequestReviewEvidenceSha256(blockedPull),
      reviewedLineage: {
        reviewedHeadSha,
        reviewedHeadParentSha: currentRecord.blocked.mergeParentSha,
        reviewedHeadTreeSha,
        reviewSubmittedAt,
        forcePush: {
          beforeHeadSha: reviewedHeadSha,
          afterHeadSha: currentRecord.blocked.finalHeadSha,
          actorLogin: 'gregkonush',
          createdAt: forcePushAt,
        },
        feedback: {
          reviewedHeadSha,
          fixedHeadSha: currentRecord.blocked.finalHeadSha,
          threadId: 'v7-reviewed-lineage-thread',
          path: feedbackPath.path,
          findingUrl: 'https://github.com/proompteng/lab/pull/13438#discussion_r1',
          findingBodySha256: sha256Text(findingBody),
          fixReplyUrl: 'https://github.com/proompteng/lab/pull/13438#discussion_r2',
          fixReplyBodySha256: sha256Text(replyBody),
        },
        affectedPaths: reviewedAffectedPaths,
      },
    },
    requiredDescendants: [],
    requiredSuccessors: [successor],
  })
  if (record.schemaVersion !== 'bayn.release-review-remediation.v7') {
    throw new Error('failed to derive the v7 single-stage successor fixture')
  }
  const successorCommit = comparison.commits.find(
    (commit) => commit.sha === record.requiredSuccessors[0].mergeCommitSha,
  )
  const originalUpdate = comparison.commits.find((commit) => commit.sha === successorBoundHistory.updateMerge)
  if (blockedCommit === undefined || successorCommit === undefined || originalUpdate === undefined) {
    throw new Error('incomplete v7 single-stage successor fixture')
  }
  ;(blockedCommit as unknown as { files: readonly string[] }).files = record.blocked.affectedPaths.map(
    (path) => path.path,
  )
  ;(blockedCommit as unknown as { fileChanges: typeof record.blocked.affectedPaths }).fileChanges =
    record.blocked.affectedPaths
  ;(successorCommit as unknown as { files: readonly string[] }).files = record.requiredSuccessors[0].affectedPaths.map(
    (path) => path.path,
  )
  ;(successorCommit as unknown as { fileChanges: readonly BaynReleaseCommitFileChange[] }).fileChanges =
    record.requiredSuccessors[0].affectedPaths
  const updateCommit = {
    ...originalUpdate,
    parents: [successorCommit.sha],
    fileChanges: originalUpdate.fileChanges?.map((change) =>
      change.path === continuousRemediationRecordPath ? { ...change, status: 'added' as const } : change,
    ),
    reviewSnapshot: reviewSnapshotFor({
      commitSha: successorBoundHistory.updateMerge,
      prNumber: 13446,
      headSha: successorBoundHistory.updateHead,
      parents: [successorCommit.sha],
      mergedAt: '2026-08-01T09:01:00Z',
      reviews: [
        review({
          commitSha: successorBoundHistory.updateHead,
          submittedAt: '2026-08-01T09:00:00Z',
        }),
      ],
    }),
  }
  const commits = [blockedCommit, successorCommit, updateCommit]
  const evidence = {
    ...fixture.evidence,
    record,
    referencedCommits: fixture.evidence.referencedCommits
      .filter(
        (commit) =>
          commit.sha === record.blocked.finalHeadSha || commit.sha === record.requiredSuccessors[0].finalHeadSha,
      )
      .map((commit) => {
        const affectedPaths =
          commit.sha === record.blocked.finalHeadSha
            ? record.blocked.affectedPaths
            : record.requiredSuccessors[0].affectedPaths
        return {
          ...commit,
          files: affectedPaths.map((path) => path.path),
          fileChanges: affectedPaths,
          pathBlobs: affectedPaths.map((path) => ({ path: path.path, blobSha: path.blobSha })),
        }
      })
      .concat({
        sha: record.blocked.reviewedLineage.reviewedHeadSha,
        parents: [record.blocked.reviewedLineage.reviewedHeadParentSha],
        treeSha: record.blocked.reviewedLineage.reviewedHeadTreeSha,
        files: record.blocked.reviewedLineage.affectedPaths.map((path) => path.path),
        fileChanges: record.blocked.reviewedLineage.affectedPaths,
        pathBlobs: record.blocked.reviewedLineage.affectedPaths.map((path) => ({
          path: path.path,
          blobSha: path.blobSha,
        })),
      }),
    currentPathBlobs: record.requiredSuccessors[0].protectedPathTransitions.map((transition) => ({
      path: transition.path,
      blobSha: transition.afterBlobSha,
    })),
  }
  return {
    evidence,
    snapshot: {
      ...fixture.snapshot,
      currentCommitParents: [successorCommit.sha],
      comparison: {
        ...comparison,
        headSha: updateCommit.sha,
        aheadBy: commits.length,
        totalCommits: commits.length,
        commits,
      },
      remediations: [evidence],
    },
  }
}

const evaluateSingleStageSuccessorRemediationFixture = (
  fixture: ReturnType<typeof singleStageSuccessorRemediationFixture>,
) =>
  evaluateBaynReleaseEligibility({
    mainCommitSha: successorBoundHistory.updateMerge,
    baseRefName: 'main',
    snapshot: fixture.snapshot,
    nowMs: successorBoundNowMs,
    pushBeforeSha: fixture.snapshot.currentCommitParents[0]!,
  })

const reviewedCompletionHistory = {
  completionMerge: '16'.repeat(20),
  completionHead: '17'.repeat(20),
  completionPriorHead: '18'.repeat(20),
  completionTree: '19'.repeat(20),
  completionRecordBlob: '1a'.repeat(20),
  updateMerge: '1b'.repeat(20),
  updateHead: '1c'.repeat(20),
  updateTree: '1d'.repeat(20),
  updateRecordBlob: '1e'.repeat(20),
} as const

const reviewedCompletionSingleStageSuccessorRemediationFixture = () => {
  const fixture = singleStageSuccessorRemediationFixture()
  const comparison = fixture.snapshot.comparison
  const v7Record = fixture.evidence.record
  if (
    comparison === null ||
    comparison.status !== 'ahead' ||
    v7Record.schemaVersion !== 'bayn.release-review-remediation.v7'
  ) {
    throw new Error('missing v7 single-stage successor fixture')
  }
  const introductionCommit = comparison.commits.find((commit) => commit.sha === successorBoundHistory.updateMerge)
  const introductionPull = introductionCommit?.reviewSnapshot?.pullRequest
  const introductionRecordPath = introductionCommit?.fileChanges?.find(
    (change) => change.path === fixture.evidence.recordPath,
  )
  if (
    introductionCommit === undefined ||
    introductionPull === null ||
    introductionPull === undefined ||
    introductionRecordPath === undefined
  ) {
    throw new Error('missing reviewed-completion introduction evidence')
  }

  const completionChanges = introductionCommit.files.map((path, index) => ({
    path,
    previousPath: null,
    status: 'modified' as const,
    blobSha:
      path === fixture.evidence.recordPath
        ? reviewedCompletionHistory.completionRecordBlob
        : `${index + 2}a`.repeat(20),
  }))
  const completionSnapshot = reviewSnapshotFor({
    commitSha: reviewedCompletionHistory.completionMerge,
    prNumber: 13449,
    headSha: reviewedCompletionHistory.completionHead,
    parents: [introductionCommit.sha],
    mergedAt: '2026-08-01T09:30:00Z',
    reviews: [
      review({
        commitSha: reviewedCompletionHistory.completionPriorHead,
        submittedAt: '2026-08-01T09:29:05Z',
      }),
    ],
    reactions: [reaction({ createdAt: '2026-08-01T09:29:20Z' })],
    headForcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: reviewedCompletionHistory.completionPriorHead,
        afterCommitSha: reviewedCompletionHistory.completionHead,
        createdAt: '2026-08-01T09:29:10Z',
      },
    ],
    headForcePushCount: 1,
  })
  const completionPull = completionSnapshot.pullRequest
  if (completionPull === null) throw new Error('missing reviewed-completion pull request')
  const completionCommit = {
    sha: reviewedCompletionHistory.completionMerge,
    parents: [introductionCommit.sha],
    treeSha: reviewedCompletionHistory.completionTree,
    files: completionChanges.map((change) => change.path),
    fileChanges: completionChanges,
    reviewSnapshot: completionSnapshot,
  } as const

  const updateChanges = completionChanges.map((change, index) => ({
    ...change,
    blobSha:
      change.path === fixture.evidence.recordPath
        ? reviewedCompletionHistory.updateRecordBlob
        : `${index + 5}a`.repeat(20),
  }))
  const updateCommit = {
    sha: reviewedCompletionHistory.updateMerge,
    parents: [completionCommit.sha],
    treeSha: reviewedCompletionHistory.updateTree,
    files: updateChanges.map((change) => change.path),
    fileChanges: updateChanges,
    reviewSnapshot: reviewSnapshotFor({
      commitSha: reviewedCompletionHistory.updateMerge,
      prNumber: 13450,
      headSha: reviewedCompletionHistory.updateHead,
      parents: [completionCommit.sha],
      mergedAt: '2026-08-01T09:40:00Z',
      reviews: [
        review({
          commitSha: reviewedCompletionHistory.updateHead,
          submittedAt: '2026-08-01T09:39:00Z',
        }),
      ],
    }),
  } as const
  const updatePull = updateCommit.reviewSnapshot.pullRequest
  if (updatePull === null) throw new Error('missing reviewed-completion update pull request')

  const introductionFinalHead = {
    sha: introductionPull.headSha,
    parents: [introductionCommit.parents[0]!],
    treeSha: introductionCommit.treeSha,
    files: introductionCommit.files,
    fileChanges: introductionCommit.fileChanges ?? [],
    pathBlobs: (introductionCommit.fileChanges ?? []).map((change) => ({
      path: change.path,
      blobSha: change.blobSha,
    })),
  }
  const completionFinalHead = {
    sha: reviewedCompletionHistory.completionHead,
    parents: [introductionCommit.sha],
    treeSha: reviewedCompletionHistory.completionTree,
    files: completionCommit.files,
    fileChanges: completionChanges,
    pathBlobs: completionChanges.map((change) => ({ path: change.path, blobSha: change.blobSha })),
  }
  const record = parseBaynReleaseReviewRemediationRecord({
    schemaVersion: 'bayn.release-review-remediation.v9',
    remediationId: v7Record.remediationId,
    blocked: v7Record.blocked,
    requiredDescendants: [],
    requiredSuccessors: v7Record.requiredSuccessors,
    introduction: {
      mergeCommitSha: introductionCommit.sha,
      mergeParentSha: introductionCommit.parents[0],
      mergeTreeSha: introductionCommit.treeSha,
      sourcePullRequestNumber: introductionPull.number,
      finalHeadSha: introductionPull.headSha,
      finalHeadParentSha: introductionCommit.parents[0],
      finalHeadTreeSha: introductionCommit.treeSha,
      sourcePullRequestEvidenceSha256: pullRequestReviewEvidenceSha256(introductionPull),
      introducedRecordBlobSha: introductionRecordPath.blobSha,
      affectedPaths: introductionCommit.fileChanges,
    },
    completion: {
      mergeCommitSha: completionCommit.sha,
      mergeParentSha: introductionCommit.sha,
      mergeTreeSha: completionCommit.treeSha,
      sourcePullRequestNumber: completionPull.number,
      finalHeadSha: completionPull.headSha,
      finalHeadParentSha: introductionCommit.sha,
      finalHeadTreeSha: completionCommit.treeSha,
      sourcePullRequestEvidenceSha256: pullRequestReviewEvidenceSha256(completionPull),
      completedRecordBlobSha: reviewedCompletionHistory.completionRecordBlob,
      affectedPaths: completionChanges,
    },
  })
  if (record.schemaVersion !== 'bayn.release-review-remediation.v9') {
    throw new Error('failed to derive the v9 reviewed-completion fixture')
  }
  const commits = [
    ...comparison.commits.filter((commit) => commit.sha !== introductionCommit.sha),
    introductionCommit,
    completionCommit,
    updateCommit,
  ]
  const evidence: BaynReleaseReviewRemediationEvidence = {
    ...fixture.evidence,
    recordBlobSha: reviewedCompletionHistory.updateRecordBlob,
    record,
    referencedCommits: [...fixture.evidence.referencedCommits, introductionFinalHead, completionFinalHead],
  }
  return {
    evidence,
    snapshot: {
      ...fixture.snapshot,
      currentCommitParents: [completionCommit.sha],
      comparison: {
        ...comparison,
        headSha: updateCommit.sha,
        aheadBy: commits.length,
        totalCommits: commits.length,
        commits,
      },
      remediations: [evidence],
    },
  }
}

const evaluateReviewedCompletionSingleStageSuccessorRemediationFixture = (
  fixture: ReturnType<typeof reviewedCompletionSingleStageSuccessorRemediationFixture>,
) =>
  evaluateBaynReleaseEligibility({
    mainCommitSha: reviewedCompletionHistory.updateMerge,
    baseRefName: 'main',
    snapshot: fixture.snapshot,
    nowMs: Date.parse('2026-08-01T09:45:00Z'),
    pushBeforeSha: reviewedCompletionHistory.completionMerge,
  })

const nestedSingleStageSuccessorRemediationFixture = (): BaynReleaseEligibilitySnapshot => {
  const fixture = singleStageSuccessorRemediationFixture()
  const comparison = fixture.snapshot.comparison
  const innerRecord = fixture.evidence.record
  if (
    comparison === null ||
    comparison.status !== 'ahead' ||
    innerRecord.schemaVersion !== 'bayn.release-review-remediation.v7'
  ) {
    throw new Error('missing nested v7 fixture')
  }
  const innerBlocked = comparison.commits.find((commit) => commit.sha === innerRecord.blocked.mergeCommitSha)
  const update = comparison.commits.find((commit) => commit.sha === successorBoundHistory.updateMerge)
  const innerFinalHead = fixture.evidence.referencedCommits.find(
    (commit) => commit.sha === innerRecord.blocked.finalHeadSha,
  )
  const innerReviewedHead = fixture.evidence.referencedCommits.find(
    (commit) => commit.sha === innerRecord.blocked.reviewedLineage.reviewedHeadSha,
  )
  if (
    innerBlocked === undefined ||
    update === undefined ||
    innerFinalHead === undefined ||
    innerReviewedHead === undefined
  ) {
    throw new Error('incomplete nested v7 fixture')
  }

  const outerMerge = 'd'.repeat(40)
  const outerHead = 'e'.repeat(40)
  const outerTree = 'f'.repeat(40)
  const outerPath = 'services/bayn/src/nested-release-review-source.ts'
  const outerBlob = '1'.repeat(40)
  const outerRecordPath = `services/bayn/release-review-remediations/${outerMerge}.json`
  const outerRecordBlob = '2'.repeat(40)
  const outerReviewSnapshot = reviewSnapshotFor({
    commitSha: outerMerge,
    prNumber: 13425,
    headSha: outerHead,
    parents: [continuousHistory.published],
    mergedAt: '2026-07-31T20:00:00Z',
    reviews: [review({ commitSha: '3'.repeat(40), submittedAt: '2026-07-31T19:55:00Z' })],
    reactions: [reaction({ createdAt: '2026-07-31T19:59:30Z' })],
    headForcePushes: [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: '3'.repeat(40),
        afterCommitSha: outerHead,
        createdAt: '2026-07-31T19:59:10Z',
      },
    ],
    headForcePushCount: 1,
  })
  const outerPull = outerReviewSnapshot.pullRequest
  if (outerPull === null) throw new Error('missing nested outer pull request')
  const outerRecord = parseBaynReleaseReviewRemediationRecord({
    schemaVersion: 'bayn.release-review-remediation.v4',
    remediationId: 'nested-reviewed-source',
    blocked: {
      mergeCommitSha: outerMerge,
      mergeParentSha: continuousHistory.published,
      mergeTreeSha: outerTree,
      sourcePullRequestNumber: 13425,
      finalHeadSha: outerHead,
      finalHeadParentSha: continuousHistory.published,
      finalHeadTreeSha: outerTree,
      sourcePullRequestEvidenceSha256: pullRequestReviewEvidenceSha256(outerPull),
      affectedPaths: [
        {
          path: outerPath,
          previousPath: null,
          status: 'modified',
          blobSha: outerBlob,
        },
      ],
    },
    requiredDescendants: [],
  })
  const outerCommit = {
    sha: outerMerge,
    parents: [continuousHistory.published],
    treeSha: outerTree,
    files: [outerPath],
    fileChanges: [
      {
        path: outerPath,
        previousPath: null,
        status: 'modified',
        blobSha: outerBlob,
      },
    ] satisfies readonly BaynReleaseCommitFileChange[],
    reviewSnapshot: outerReviewSnapshot,
  }

  ;(innerBlocked as unknown as { parents: readonly string[] }).parents = [outerMerge]
  if (innerBlocked.reviewSnapshot !== null) {
    ;(innerBlocked.reviewSnapshot as unknown as { mainCommitParents: readonly string[] }).mainCommitParents = [
      outerMerge,
    ]
  }
  ;(innerRecord.blocked as unknown as { mergeParentSha: string; finalHeadParentSha: string }).mergeParentSha =
    outerMerge
  ;(innerRecord.blocked as unknown as { mergeParentSha: string; finalHeadParentSha: string }).finalHeadParentSha =
    outerMerge
  ;(innerRecord.blocked.reviewedLineage as unknown as { reviewedHeadParentSha: string }).reviewedHeadParentSha =
    outerMerge
  ;(innerFinalHead as unknown as { parents: readonly string[] }).parents = [outerMerge]
  ;(innerReviewedHead as unknown as { parents: readonly string[] }).parents = [outerMerge]

  const outerRecordChange: BaynReleaseCommitFileChange = {
    path: outerRecordPath,
    previousPath: null,
    status: 'added',
    blobSha: outerRecordBlob,
  }
  ;(update as unknown as { files: readonly string[] }).files = [...update.files, outerRecordPath]
  ;(update as unknown as { fileChanges: readonly BaynReleaseCommitFileChange[] }).fileChanges = [
    ...(update.fileChanges ?? []),
    outerRecordChange,
  ]
  const outerEvidence: BaynReleaseReviewRemediationEvidence = {
    recordPath: outerRecordPath,
    recordBlobSha: outerRecordBlob,
    record: outerRecord,
    referencedCommits: [
      {
        sha: outerHead,
        parents: [continuousHistory.published],
        treeSha: outerTree,
        files: [outerPath],
        fileChanges: [
          {
            path: outerPath,
            previousPath: null,
            status: 'modified',
            blobSha: outerBlob,
          },
        ],
        pathBlobs: [{ path: outerPath, blobSha: outerBlob }],
      },
    ],
    currentPathBlobs: [{ path: outerPath, blobSha: outerBlob }],
  }
  const commits = [outerCommit, ...comparison.commits]
  return {
    ...fixture.snapshot,
    comparison: {
      ...comparison,
      aheadBy: commits.length,
      totalCommits: commits.length,
      commits,
    },
    remediations: [outerEvidence, fixture.evidence],
  }
}

describe('Bayn publication-range eligibility', () => {
  test('parses the exact immutable #13438 -> #13442 v9 reviewed-source receipt', () => {
    expect(realCandidateDiagnosticsRemediationRecord).toMatchObject({
      schemaVersion: 'bayn.release-review-remediation.v9',
      remediationId: 'pr-13438-successor-bound-reviewed-source',
      blocked: {
        mergeCommitSha: 'ae4d23650c20cecbde2bac8416bc2b734381cb69',
        sourcePullRequestNumber: 13438,
        finalHeadSha: 'bf17a9387e69896095096b9447aafed52711333c',
        sourcePullRequestEvidenceSha256: '25bd010d4dd974cc734799cba99495bbef170995535282e73579f4ba8c4f5afe',
        affectedPaths: { length: 2 },
        reviewedLineage: {
          reviewedHeadSha: '9452b41b051f79f65a3dcc825593afb0390a0b2f',
          reviewedHeadParentSha: '7c2335792707e34ac41e4de5091d2e2af48b7657',
          reviewedHeadTreeSha: '3e11aedd2f991db054b78143956719fc3dad6744',
          reviewSubmittedAt: '2026-08-01T01:01:06Z',
          forcePush: {
            beforeHeadSha: '9452b41b051f79f65a3dcc825593afb0390a0b2f',
            afterHeadSha: 'bf17a9387e69896095096b9447aafed52711333c',
            actorLogin: 'gregkonush',
            createdAt: '2026-08-01T01:05:01Z',
          },
          feedback: {
            threadId: 'PRRT_kwDOLkRLus6VkaW3',
            findingBodySha256: 'b2888751b80020f76a4fbd9a733304a607fc3c6725a5ae3f5766ddbe560a0e72',
            fixReplyBodySha256: 'd790110b2808020d52559efbe5e72042d746c593baf94536e0034acb01f4dfc0',
          },
          affectedPaths: { length: 2 },
        },
      },
      requiredDescendants: [],
      requiredSuccessors: [
        {
          mergeCommitSha: 'fa2016a8aa3c8b0f466ab84a7956c704dd9056c7',
          sourcePullRequestNumber: 13442,
          finalHeadSha: 'a7b608a873057d9f65625515140e1dd83cda5e35',
          sourcePullRequestEvidenceSha256: '932e340efbef5df512d6317c05578350b3368ee6b72500d4d764ce622ed8519f',
          affectedPaths: { length: 11 },
          protectedPathTransitions: { length: 2 },
        },
      ],
      introduction: {
        mergeCommitSha: '628d3fd16d63f7b9e3fc02d3bbdfa130a121ed31',
        mergeParentSha: '045b69acf7681162983fa228b6d66b6677233ff2',
        sourcePullRequestNumber: 13448,
        finalHeadSha: '211a901ddeacf6cab997252dee85e180e94595fa',
        sourcePullRequestEvidenceSha256: '8e59ead9e8a8c57c8c64c0b37ea1c5298b292dbc0b1efd69645ceb1678ae49b0',
        introducedRecordBlobSha: '2855013d0a960ebc9b2ee100301334fc1640d297',
        affectedPaths: { length: 3 },
      },
      completion: {
        mergeCommitSha: '3dabfa8b73e8a7de2c61a171b49e635a56774af3',
        mergeParentSha: '628d3fd16d63f7b9e3fc02d3bbdfa130a121ed31',
        sourcePullRequestNumber: 13449,
        finalHeadSha: '711a3bfda038f696bc805ab32c1a8bfb93ce5d2b',
        sourcePullRequestEvidenceSha256: 'a7234519bd57e2fdd1be320eae0a0dab802ee952ca3d379f180bbcc13c592a48',
        completedRecordBlobSha: '63f78435bffefe00b904e02492693f53fb6cb6d4',
        affectedPaths: { length: 3 },
      },
    })
  })

  test('accepts a v9 receipt only through its reviewed completion and exact reviewed update', () => {
    const fixture = reviewedCompletionSingleStageSuccessorRemediationFixture()
    expect(evaluateReviewedCompletionSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'eligible',
      lastPublishedRevision: continuousHistory.published,
      checkedCommitCount: 5,
      baynAffectingCommitCount: 5,
      reviewedPullRequests: [
        { commitSha: continuousHistory.blocked, prNumber: 13432 },
        { commitSha: '2aa782001a9d7e1d9db68e5fa0929159755334cd', prNumber: 13432 },
        { commitSha: successorBoundHistory.updateMerge, prNumber: 13446 },
        { commitSha: reviewedCompletionHistory.completionMerge, prNumber: 13449 },
        { commitSha: reviewedCompletionHistory.updateMerge, prNumber: 13450 },
      ],
    })
  })

  test('rejects a v9 receipt whose update is not the direct child of the bound completion', () => {
    const fixture = reviewedCompletionSingleStageSuccessorRemediationFixture()
    const update = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === reviewedCompletionHistory.updateMerge,
    )
    if (update === undefined) throw new Error('missing v9 reviewed update')
    ;(update as unknown as { parents: readonly string[] }).parents = [successorBoundHistory.updateMerge]
    expect(evaluateReviewedCompletionSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('rejects a v9 receipt without an exact-head-reviewed update', () => {
    const fixture = reviewedCompletionSingleStageSuccessorRemediationFixture()
    const update = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === reviewedCompletionHistory.updateMerge,
    )
    const pullRequest = update?.reviewSnapshot?.pullRequest
    if (pullRequest === null || pullRequest === undefined) throw new Error('missing v9 update pull request')
    ;(pullRequest as unknown as { reviews: readonly PullRequestReview[] }).reviews = []
    expect(evaluateReviewedCompletionSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-missing',
      retryable: true,
    })
  })

  test('rejects a v9 completion that lacks the bound final-head review reaction', () => {
    const fixture = reviewedCompletionSingleStageSuccessorRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v9') throw new Error('missing v9 fixture')
    const completion = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === reviewedCompletionHistory.completionMerge,
    )
    const pullRequest = completion?.reviewSnapshot?.pullRequest
    if (pullRequest === null || pullRequest === undefined) throw new Error('missing v9 completion pull request')
    ;(pullRequest as unknown as { reactions: readonly PullRequestReaction[] }).reactions = []
    ;(record.completion as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
      pullRequestReviewEvidenceSha256(pullRequest)
    expect(evaluateReviewedCompletionSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('accepts a v7 receipt only through exact reviewed lineage and a reviewed successor', () => {
    const fixture = singleStageSuccessorRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v7') throw new Error('missing v7 fixture')
    expect(evaluateSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'eligible',
      lastPublishedRevision: continuousHistory.published,
      reviewedPullRequests: [
        {
          commitSha: continuousHistory.blocked,
          prNumber: record.requiredSuccessors[0].sourcePullRequestNumber,
          headSha: record.requiredSuccessors[0].finalHeadSha,
        },
        { commitSha: '2aa782001a9d7e1d9db68e5fa0929159755334cd', prNumber: 13432 },
        { commitSha: successorBoundHistory.updateMerge, prNumber: 13446 },
      ],
    })
  })

  test('rejects a touched-only v7 successor without exact reviewed-head lineage', () => {
    const record = structuredClone(realCandidateDiagnosticsRemediationRecord) as unknown as Record<string, unknown>
    const blocked = record.blocked as Record<string, unknown>
    delete blocked.reviewedLineage
    expect(() => parseBaynReleaseReviewRemediationRecord(record)).toThrow()
  })

  test('rejects a v7 receipt when the reconstructed reviewed blob differs', () => {
    const fixture = singleStageSuccessorRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v7') throw new Error('missing v7 fixture')
    const reviewedHead = fixture.evidence.referencedCommits.find(
      (commit) => commit.sha === record.blocked.reviewedLineage.reviewedHeadSha,
    )
    const reviewedBlob = reviewedHead?.pathBlobs[0]
    if (reviewedBlob === undefined) throw new Error('missing reviewed lineage blob')
    ;(reviewedBlob as unknown as { blobSha: string }).blobSha = '0'.repeat(40)
    expect(evaluateSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('rejects a v7 receipt when the latest reviewed-head force push differs', () => {
    const fixture = singleStageSuccessorRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v7') throw new Error('missing v7 fixture')
    const blockedCommit = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === record.blocked.mergeCommitSha,
    )
    const pullRequest = blockedCommit?.reviewSnapshot?.pullRequest
    const forcePush = pullRequest?.headForcePushes[0]
    if (pullRequest === null || pullRequest === undefined || forcePush === undefined) {
      throw new Error('missing v7 reviewed lineage force push')
    }
    ;(forcePush as unknown as { beforeCommitSha: string }).beforeCommitSha = '0'.repeat(40)
    ;(record.blocked as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
      pullRequestReviewEvidenceSha256(pullRequest)
    expect(evaluateSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('rejects a v7 receipt whose reviewed successor leaves any unreviewed blocked path intact', () => {
    const fixture = singleStageSuccessorRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v7') throw new Error('missing v7 fixture')
    const firstTransition = record.requiredSuccessors[0].protectedPathTransitions[0]
    if (firstTransition === undefined) throw new Error('missing v7 protected transition')
    ;(
      record.requiredSuccessors[0] as unknown as {
        protectedPathTransitions: readonly [typeof firstTransition]
      }
    ).protectedPathTransitions = [firstTransition]
    expect(evaluateSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('composes an earlier continuous receipt with a later v7 remediation instead of requiring the blocked head twice', () => {
    const snapshot = nestedSingleStageSuccessorRemediationFixture()
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: successorBoundHistory.updateMerge,
        baseRefName: 'main',
        snapshot,
        nowMs: successorBoundNowMs,
        pushBeforeSha: snapshot.currentCommitParents[0]!,
      }),
    ).toMatchObject({ status: 'eligible' })
  })

  test('rejects a v7 receipt whose reviewed successor is missing', () => {
    const fixture = singleStageSuccessorRemediationFixture()
    const comparison = fixture.snapshot.comparison
    const record = fixture.evidence.record
    if (comparison === null || record.schemaVersion !== 'bayn.release-review-remediation.v7') {
      throw new Error('missing v7 fixture')
    }
    const commits = comparison.commits.filter((commit) => commit.sha !== record.requiredSuccessors[0].mergeCommitSha)
    ;(fixture.snapshot as unknown as { comparison: BaynReleaseComparison }).comparison = {
      ...comparison,
      commits,
      aheadBy: commits.length,
      totalCommits: commits.length,
    }
    expect(evaluateSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('rejects a v7 receipt after an undeclared later protected-path mutation', () => {
    const fixture = singleStageSuccessorRemediationFixture()
    const comparison = fixture.snapshot.comparison
    const record = fixture.evidence.record
    if (comparison === null || record.schemaVersion !== 'bayn.release-review-remediation.v7') {
      throw new Error('missing v7 fixture')
    }
    const transition = record.requiredSuccessors[0].protectedPathTransitions[0]
    const later = comparison.commits.find((commit) => commit.sha === successorBoundHistory.updateMerge)
    if (later === undefined) throw new Error('missing later reviewed commit')
    ;(later as unknown as { files: string[] }).files = [...later.files, transition.path]
    ;(later as unknown as { fileChanges: BaynReleaseCommitFileChange[] }).fileChanges = [
      ...(later.fileChanges ?? []),
      {
        path: transition.path,
        previousPath: null,
        status: 'modified',
        blobSha: '0'.repeat(40),
      },
    ]
    expect(evaluateSingleStageSuccessorRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('parses the exact immutable #13426 continuous-source v6 receipt with reviewed successor and completion', () => {
    expect(realContinuousRemediationRecord).toMatchObject({
      schemaVersion: 'bayn.release-review-remediation.v6',
      remediationId: 'pr-13426-continuous-reviewed-source',
      blocked: {
        mergeCommitSha: continuousHistory.blocked,
        mergeParentSha: continuousHistory.published,
        mergeTreeSha: 'b8f61426c9e182125208356d1bb50c14e83b1e65',
        sourcePullRequestNumber: 13426,
        finalHeadSha: continuousHistory.finalHead,
        finalHeadParentSha: continuousHistory.published,
        finalHeadTreeSha: 'b8f61426c9e182125208356d1bb50c14e83b1e65',
        sourcePullRequestEvidenceSha256: '2d7c74531595b8b889b39e5ebe7281cb5f397cbe2cf832300a80a62e293fbd0f',
        affectedPaths: { length: 18 },
      },
      requiredDescendants: [],
      requiredSuccessors: [
        {
          mergeCommitSha: '2aa782001a9d7e1d9db68e5fa0929159755334cd',
          mergeParentSha: continuousHistory.blocked,
          mergeTreeSha: '92065c627993e2844f0990eb032a72e41205b77a',
          sourcePullRequestNumber: 13432,
          finalHeadSha: 'c1d955f30a6f004916e885d8d5dd61a5eb11ee92',
          finalHeadParentSha: continuousHistory.blocked,
          finalHeadTreeSha: '92065c627993e2844f0990eb032a72e41205b77a',
          sourcePullRequestEvidenceSha256: 'f22e10837d3842354b3a2d986f27813bdc535630e4277006703273c6fc3c56df',
          affectedPaths: { length: 7 },
          protectedPathTransitions: [
            {
              path: 'services/bayn/src/observe-composition.ts',
              beforeBlobSha: 'ab38e8303f0d4482a6daeb6dd8f239cfb59d6223',
              afterBlobSha: 'aaba2e88d64a0bf20d98e18f181abe9b0deb9860',
            },
          ],
        },
      ],
      introduction: {
        mergeCommitSha: continuousHistory.introductionMerge,
        mergeParentSha: continuousHistory.intermediates.at(-1),
        mergeTreeSha: 'cf14f73afa2032aa0c135b11815273594c308e2b',
        sourcePullRequestNumber: 13443,
        finalHeadSha: continuousHistory.introductionHead,
        finalHeadParentSha: continuousHistory.intermediates.at(-1),
        finalHeadTreeSha: 'cf14f73afa2032aa0c135b11815273594c308e2b',
        sourcePullRequestEvidenceSha256: '1d37445461c211e669f06a6af59cb1263c0d5e99312cff3aa237dd0fa249a487',
        introducedRecordBlobSha: 'dfde09ca935b9df6d48d34391d1cc0e599eab6c7',
        affectedPaths: { length: 3 },
      },
      completion: {
        mergeCommitSha: '8f6ab9086457f2a7e1f2147d57e06fc22c9881fc',
        mergeParentSha: continuousHistory.introductionMerge,
        mergeTreeSha: 'a51d7d16f0b9806ec2ae71dfa3862e0067d23851',
        sourcePullRequestNumber: 13445,
        finalHeadSha: 'c580b4df79290df7c0760c290cafca9a4d4ae315',
        finalHeadParentSha: continuousHistory.introductionMerge,
        finalHeadTreeSha: 'a51d7d16f0b9806ec2ae71dfa3862e0067d23851',
        sourcePullRequestEvidenceSha256: '729f0f5c8208f284b889e97a8da90ac7aac02fffb3cb3880abc4d156cf459967',
        completedRecordBlobSha: '5faaf371424c183a176b3659fc8108576d136b84',
        affectedPaths: { length: 3 },
      },
    })
  })

  test('accepts the v6 receipt only with its exact reviewed successor, protected transition, completion, and update', () => {
    const fixture = successorBoundContinuousRemediationFixture()
    expect(evaluateSuccessorBoundContinuousRemediationFixture(fixture)).toMatchObject({
      status: 'eligible',
      lastPublishedRevision: continuousHistory.published,
      checkedCommitCount: 8,
      baynAffectingCommitCount: 5,
      reviewedPullRequests: [
        { commitSha: continuousHistory.blocked, prNumber: 13426, headSha: continuousHistory.finalHead },
        { commitSha: '2aa782001a9d7e1d9db68e5fa0929159755334cd', prNumber: 13432 },
        { commitSha: continuousHistory.introductionMerge, prNumber: 13443 },
        { commitSha: '8f6ab9086457f2a7e1f2147d57e06fc22c9881fc', prNumber: 13445 },
        { commitSha: successorBoundHistory.updateMerge, prNumber: 13446 },
      ],
    })
  })

  test('carries the v6 reaction-bound completion review into the publication-range decision', () => {
    const fixture = successorBoundContinuousRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
    const completion = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === record.completion.mergeCommitSha,
    )
    const pullRequest = completion?.reviewSnapshot?.pullRequest
    if (pullRequest === null || pullRequest === undefined) throw new Error('missing completion pull request')
    ;(pullRequest as unknown as { reviews: PullRequestReview[] }).reviews = []
    ;(pullRequest as unknown as { headForcePushes: PullRequestForcePush[] }).headForcePushes = [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: '5'.repeat(40),
        afterCommitSha: record.completion.finalHeadSha,
        createdAt: '2026-08-01T08:30:10Z',
      },
    ]
    ;(pullRequest as unknown as { headForcePushCount: number }).headForcePushCount = 1
    ;(pullRequest as unknown as { reactions: PullRequestReaction[] }).reactions = [
      reaction({ createdAt: '2026-08-01T08:30:20Z' }),
    ]
    ;(record.completion as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
      pullRequestReviewEvidenceSha256(pullRequest)

    const evaluation = evaluateSuccessorBoundContinuousRemediationFixture(fixture)
    expect(evaluation).toMatchObject({ status: 'eligible' })
    if (evaluation.status !== 'eligible') throw new Error('expected eligible publication range')
    expect(
      evaluation.reviewedPullRequests.find(
        (reviewedPullRequest) => reviewedPullRequest.commitSha === record.completion.mergeCommitSha,
      ),
    ).toMatchObject({
      prNumber: record.completion.sourcePullRequestNumber,
      headSha: record.completion.finalHeadSha,
      reviewSubmittedAt: '2026-08-01T08:30:20Z',
    })
  })

  test('carries the v6 reaction-bound successor review into the publication-range decision', () => {
    const fixture = successorBoundContinuousRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
    const successorIdentity = record.requiredSuccessors[0]
    const successor = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === successorIdentity.mergeCommitSha,
    )
    const pullRequest = successor?.reviewSnapshot?.pullRequest
    if (pullRequest === null || pullRequest === undefined) throw new Error('missing successor pull request')
    ;(pullRequest as unknown as { reviews: PullRequestReview[] }).reviews = []
    ;(pullRequest as unknown as { headForcePushes: PullRequestForcePush[] }).headForcePushes = [
      {
        actorLogin: 'gregkonush',
        beforeCommitSha: '6'.repeat(40),
        afterCommitSha: successorIdentity.finalHeadSha,
        createdAt: '2026-07-31T21:12:00Z',
      },
    ]
    ;(pullRequest as unknown as { headForcePushCount: number }).headForcePushCount = 1
    ;(pullRequest as unknown as { reactions: PullRequestReaction[] }).reactions = [
      reaction({ createdAt: '2026-07-31T21:12:10Z' }),
    ]
    ;(successorIdentity as unknown as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
      pullRequestReviewEvidenceSha256(pullRequest)

    const evaluation = evaluateSuccessorBoundContinuousRemediationFixture(fixture)
    expect(evaluation).toMatchObject({ status: 'eligible' })
    if (evaluation.status !== 'eligible') throw new Error('expected eligible publication range')
    expect(
      evaluation.reviewedPullRequests.find(
        (reviewedPullRequest) => reviewedPullRequest.commitSha === successorIdentity.mergeCommitSha,
      ),
    ).toMatchObject({
      prNumber: successorIdentity.sourcePullRequestNumber,
      headSha: successorIdentity.finalHeadSha,
      reviewSubmittedAt: '2026-07-31T21:12:10Z',
    })
  })

  ;(
    [
      [
        'missing successor',
        (record: Record<string, unknown>) => {
          record.requiredSuccessors = []
        },
      ],
      [
        'ambiguous successor set',
        (record: Record<string, unknown>) => {
          const successors = record.requiredSuccessors as unknown[]
          record.requiredSuccessors = [...successors, structuredClone(successors[0])]
        },
      ],
      [
        'duplicate protected transition',
        (record: Record<string, unknown>) => {
          const successor = (record.requiredSuccessors as Record<string, unknown>[])[0]!
          const transitions = successor.protectedPathTransitions as unknown[]
          successor.protectedPathTransitions = [...transitions, structuredClone(transitions[0])]
        },
      ],
    ] as const
  ).forEach(([name, mutate]) => {
    test(`rejects a v6 receipt with ${name}`, () => {
      const record = structuredClone(realContinuousRemediationRecord) as unknown as Record<string, unknown>
      mutate(record)
      expect(() => parseBaynReleaseReviewRemediationRecord(record)).toThrow()
    })
  })

  ;(
    [
      [
        'wrong direct parent',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const successor = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === record.requiredSuccessors[0].mergeCommitSha,
          )
          if (successor === undefined) throw new Error('missing successor commit')
          ;(successor as unknown as { parents: string[] }).parents = ['0'.repeat(40)]
        },
      ],
      [
        'wrong merge tree',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const successor = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === record.requiredSuccessors[0].mergeCommitSha,
          )
          if (successor === undefined) throw new Error('missing successor commit')
          ;(successor as unknown as { treeSha: string }).treeSha = '0'.repeat(40)
        },
      ],
      [
        'incomplete successor path set',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const finalHead = fixture.evidence.referencedCommits.find(
            (commit) => commit.sha === record.requiredSuccessors[0].finalHeadSha,
          )
          if (finalHead === undefined) throw new Error('missing successor final head')
          ;(finalHead as unknown as { files: string[] }).files = finalHead.files.slice(1)
        },
      ],
      [
        'wrong successor source blob',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const finalHead = fixture.evidence.referencedCommits.find(
            (commit) => commit.sha === record.requiredSuccessors[0].finalHeadSha,
          )
          const pathBlob = finalHead?.pathBlobs[0]
          if (pathBlob === undefined) throw new Error('missing successor source blob')
          ;(pathBlob as unknown as { blobSha: string }).blobSha = '0'.repeat(40)
        },
      ],
      [
        'wrong protected transition source blob',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          ;(
            record.requiredSuccessors[0].protectedPathTransitions[0] as unknown as { beforeBlobSha: string }
          ).beforeBlobSha = '0'.repeat(40)
        },
      ],
      [
        'stale transitioned current blob',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const transition = record.requiredSuccessors[0].protectedPathTransitions[0]
          const current = fixture.evidence.currentPathBlobs.find((path) => path.path === transition.path)
          if (current === undefined) throw new Error('missing current protected blob')
          ;(current as unknown as { blobSha: string }).blobSha = transition.beforeBlobSha
        },
      ],
      [
        'later undeclared protected mutation',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const transition = record.requiredSuccessors[0].protectedPathTransitions[0]
          const update = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === successorBoundHistory.updateMerge,
          )
          if (update === undefined) throw new Error('missing v6 receipt update commit')
          ;(update as unknown as { files: string[] }).files = [...update.files, transition.path]
          ;(update as unknown as { fileChanges: unknown[] }).fileChanges = [
            ...(update.fileChanges ?? []),
            {
              path: transition.path,
              previousPath: null,
              status: 'modified',
              blobSha: '0'.repeat(40),
            },
          ]
        },
      ],
      [
        'edited successor review evidence',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const successor = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === record.requiredSuccessors[0].mergeCommitSha,
          )
          const pullRequest = successor?.reviewSnapshot?.pullRequest
          if (pullRequest === null || pullRequest === undefined) throw new Error('missing successor pull request')
          ;(pullRequest as unknown as { issueComments: PullRequestIssueComment[] }).issueComments = [
            issueComment({ body: 'post-receipt edit' }),
          ]
        },
      ],
      [
        'wrong completion identity',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const record = fixture.evidence.record
          if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
          const completion = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === record.completion.mergeCommitSha,
          )
          if (completion === undefined) throw new Error('missing completion commit')
          ;(completion as unknown as { treeSha: string }).treeSha = '0'.repeat(40)
        },
      ],
      [
        'noncanonical current receipt update',
        (fixture: ReturnType<typeof successorBoundContinuousRemediationFixture>) => {
          const update = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === successorBoundHistory.updateMerge,
          )
          const receipt = update?.fileChanges?.find((change) => change.path === continuousRemediationRecordPath)
          if (receipt === undefined) throw new Error('missing current receipt mutation')
          ;(receipt as unknown as { previousPath: string | null }).previousPath = 'stale-receipt.json'
        },
      ],
    ] as const
  ).forEach(([name, mutate]) => {
    test(`rejects v6 continuous-source evidence with ${name}`, () => {
      const fixture = successorBoundContinuousRemediationFixture()
      mutate(fixture)
      expect(evaluateSuccessorBoundContinuousRemediationFixture(fixture)).toMatchObject({
        status: 'hold',
        code: 'release-review-remediation-invalid',
        retryable: false,
      })
    })
  })

  test('rejects a v6 receipt whose bound successor review has an unresolved thread', () => {
    const fixture = successorBoundContinuousRemediationFixture()
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v6') throw new Error('expected v6 record')
    const successor = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === record.requiredSuccessors[0].mergeCommitSha,
    )
    const pullRequest = successor?.reviewSnapshot?.pullRequest
    if (pullRequest === null || pullRequest === undefined) throw new Error('missing successor pull request')
    ;(pullRequest as unknown as { threads: PullRequestReviewThread[] }).threads = [
      thread({ id: 'successor-thread', isResolved: false, path: 'services/bayn/src/observe-composition.ts' }),
    ]
    ;(
      record.requiredSuccessors[0] as unknown as { sourcePullRequestEvidenceSha256: string }
    ).sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pullRequest)
    expect(evaluateSuccessorBoundContinuousRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('accepts #13426 only through exact continuous source and #13443 reaction-bound introduction evidence', () => {
    const fixture = continuousRemediationFixture()
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: continuousHistory.completionMerge,
        baseRefName: 'main',
        snapshot: fixture.snapshot,
        nowMs: continuousNowMs,
        pushBeforeSha: continuousHistory.introductionMerge,
      }),
    ).toEqual({
      status: 'eligible',
      lastPublishedRevision: continuousHistory.published,
      checkedCommitCount: 7,
      baynAffectingCommitCount: 3,
      reviewedPullRequests: [
        {
          commitSha: continuousHistory.blocked,
          prNumber: 13426,
          headSha: continuousHistory.finalHead,
          reviewSubmittedAt: '2026-07-31T20:35:28Z',
          eligibleAt: '2026-07-31T20:35:58.000Z',
        },
        {
          commitSha: continuousHistory.introductionMerge,
          prNumber: 13443,
          headSha: continuousHistory.introductionHead,
          reviewSubmittedAt: '2026-08-01T08:29:17Z',
          eligibleAt: '2026-08-01T08:29:47.000Z',
        },
        {
          commitSha: continuousHistory.completionMerge,
          prNumber: 13445,
          headSha: continuousHistory.completionHead,
          reviewSubmittedAt: '2026-08-01T08:30:00Z',
          eligibleAt: '2026-08-01T08:30:30.000Z',
        },
      ],
    })
  })

  test('keeps #13426 blocked without the exact v5 receipt', () => {
    const fixture = continuousRemediationFixture()
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: continuousHistory.completionMerge,
        baseRefName: 'main',
        snapshot: { ...fixture.snapshot, remediations: [] },
        nowMs: continuousNowMs,
        pushBeforeSha: continuousHistory.introductionMerge,
      }),
    ).toMatchObject({ status: 'hold', code: 'release-review-remediation-missing', retryable: false })
  })

  ;(
    [
      [
        'edited immutable PR evidence',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const pullRequest = fixture.snapshot.comparison?.commits[0]?.reviewSnapshot?.pullRequest
          if (pullRequest === null || pullRequest === undefined) throw new Error('missing blocked pull request')
          ;(pullRequest as unknown as { issueComments: PullRequestIssueComment[] }).issueComments = [
            issueComment({ createdAt: '2026-07-31T20:34:00Z', updatedAt: '2026-07-31T20:34:01Z' }),
          ]
        },
      ],
      [
        'pre-head reaction',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const pullRequest = fixture.snapshot.comparison?.commits[0]?.reviewSnapshot?.pullRequest
          if (pullRequest === null || pullRequest === undefined) throw new Error('missing blocked pull request')
          ;(pullRequest.reactions[0] as unknown as { createdAt: string }).createdAt = '2026-07-31T20:29:25Z'
          ;(
            fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
          ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pullRequest)
        },
      ],
      [
        'spoofed reaction actor',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const pullRequest = fixture.snapshot.comparison?.commits[0]?.reviewSnapshot?.pullRequest
          if (pullRequest === null || pullRequest === undefined) throw new Error('missing blocked pull request')
          ;(pullRequest.reactions[0] as unknown as { userLogin: string }).userLogin = 'codex-lookalike[bot]'
          ;(
            fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
          ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pullRequest)
        },
      ],
      [
        'ambiguous trusted reactions',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const pullRequest = fixture.snapshot.comparison?.commits[0]?.reviewSnapshot?.pullRequest
          if (pullRequest === null || pullRequest === undefined) throw new Error('missing blocked pull request')
          ;(pullRequest as unknown as { reactions: PullRequestReaction[] }).reactions = [
            ...pullRequest.reactions,
            reaction({ createdAt: '2026-07-31T20:35:29Z' }),
          ]
          ;(
            fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
          ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pullRequest)
        },
      ],
      [
        'unrelated source PR identity',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          ;(
            fixture.evidence.record as unknown as { blocked: { sourcePullRequestNumber: number } }
          ).blocked.sourcePullRequestNumber = 13425
        },
      ],
      [
        'mismatched final source head',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          ;(fixture.evidence.record as unknown as { blocked: { finalHeadSha: string } }).blocked.finalHeadSha =
            'f'.repeat(40)
        },
      ],
      [
        'discontinuous final source parent',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const finalHead = fixture.evidence.referencedCommits[0]
          if (finalHead === undefined) throw new Error('missing final source head')
          ;(finalHead as unknown as { parents: string[] }).parents = ['0'.repeat(40)]
        },
      ],
      [
        'mismatched final source tree',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const finalHead = fixture.evidence.referencedCommits[0]
          if (finalHead === undefined) throw new Error('missing final source head')
          ;(finalHead as unknown as { treeSha: string }).treeSha = '0'.repeat(40)
        },
      ],
      [
        'source-dropping path evidence',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const finalHead = fixture.evidence.referencedCommits[0]
          if (finalHead === undefined) throw new Error('missing final source head')
          ;(finalHead as unknown as { files: string[] }).files = finalHead.files.slice(1)
          ;(finalHead as unknown as { fileChanges: unknown[] }).fileChanges = finalHead.fileChanges.slice(1)
          ;(finalHead as unknown as { pathBlobs: unknown[] }).pathBlobs = finalHead.pathBlobs.slice(1)
        },
      ],
      [
        'mismatched source blob',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const finalHead = fixture.evidence.referencedCommits[0]
          const pathBlob = finalHead?.pathBlobs[0]
          if (pathBlob === undefined) throw new Error('missing final source blob')
          ;(pathBlob as unknown as { blobSha: string }).blobSha = '0'.repeat(40)
        },
      ],
      [
        'discontinuous release ancestry',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const introduction = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === continuousHistory.introductionMerge,
          )
          if (introduction === undefined) throw new Error('missing introduction commit')
          ;(introduction as unknown as { parents: string[] }).parents = ['0'.repeat(40)]
        },
      ],
      [
        'stale current source blob',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const pathBlob = fixture.evidence.currentPathBlobs[0]
          if (pathBlob === undefined) throw new Error('missing current source blob')
          ;(pathBlob as unknown as { blobSha: string }).blobSha = '0'.repeat(40)
        },
      ],
    ] as const
  ).forEach(([name, mutate]) => {
    test(`rejects v5 continuous-source remediation with ${name}`, () => {
      const fixture = continuousRemediationFixture()
      mutate(fixture)
      expect(
        evaluateBaynReleaseEligibility({
          mainCommitSha: continuousHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: continuousNowMs,
          pushBeforeSha: continuousHistory.introductionMerge,
        }),
      ).toMatchObject({ status: 'hold', code: 'release-review-remediation-invalid', retryable: false })
    })
  })

  test('rejects edited immutable #13443 PR evidence', () => {
    const fixture = continuousRemediationFixture()
    const { pullRequest } = continuousIntroductionEvidence(fixture)
    ;(pullRequest as unknown as { issueComments: PullRequestIssueComment[] }).issueComments = [
      ...pullRequest.issueComments,
      issueComment({
        authorLogin: 'gregkonush',
        body: 'post-receipt mutation',
        createdAt: '2026-08-01T08:29:30Z',
        updatedAt: '2026-08-01T08:29:30Z',
      }),
    ]
    expect(evaluateContinuousRemediationFixture(fixture)).toMatchObject({
      status: 'hold',
      code: 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  ;(
    [
      [
        'pre-force-push reaction',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { pullRequest } = continuousIntroductionEvidence(fixture)
          ;(pullRequest.reactions[0] as unknown as { createdAt: string }).createdAt = '2026-08-01T08:24:53Z'
          rebindContinuousIntroductionPull(fixture)
        },
      ],
      [
        'spoofed reaction actor',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { pullRequest } = continuousIntroductionEvidence(fixture)
          ;(pullRequest.reactions[0] as unknown as { userLogin: string }).userLogin = 'codex-lookalike[bot]'
          rebindContinuousIntroductionPull(fixture)
        },
      ],
      [
        'multiple trusted reactions',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { pullRequest } = continuousIntroductionEvidence(fixture)
          ;(pullRequest as unknown as { reactions: PullRequestReaction[] }).reactions = [
            ...pullRequest.reactions,
            reaction({ createdAt: '2026-08-01T08:29:18Z' }),
          ]
          rebindContinuousIntroductionPull(fixture)
        },
      ],
      [
        'later force push',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { pullRequest } = continuousIntroductionEvidence(fixture)
          ;(pullRequest as unknown as { headForcePushes: PullRequestForcePush[] }).headForcePushes = [
            ...pullRequest.headForcePushes,
            {
              actorLogin: 'gregkonush',
              beforeCommitSha: '5'.repeat(40),
              afterCommitSha: continuousHistory.introductionHead,
              createdAt: '2026-08-01T08:29:20Z',
            },
          ]
          ;(pullRequest as unknown as { headForcePushCount: number }).headForcePushCount = 2
          rebindContinuousIntroductionPull(fixture)
        },
      ],
      [
        'wrong final head',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { pullRequest } = continuousIntroductionEvidence(fixture)
          ;(pullRequest as unknown as { headSha: string }).headSha = 'f'.repeat(40)
          ;(pullRequest as unknown as { commitShas: string[] }).commitShas = ['f'.repeat(40)]
          rebindContinuousIntroductionPull(fixture)
        },
      ],
      [
        'wrong final tree',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { finalHead } = continuousIntroductionEvidence(fixture)
          ;(finalHead as unknown as { treeSha: string }).treeSha = '0'.repeat(40)
        },
      ],
      [
        'source-dropping path evidence',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { finalHead } = continuousIntroductionEvidence(fixture)
          ;(finalHead as unknown as { files: string[] }).files = finalHead.files.slice(1)
          ;(finalHead as unknown as { fileChanges: unknown[] }).fileChanges = finalHead.fileChanges.slice(1)
          ;(finalHead as unknown as { pathBlobs: unknown[] }).pathBlobs = finalHead.pathBlobs.slice(1)
        },
      ],
      [
        'wrong source blob',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { finalHead } = continuousIntroductionEvidence(fixture)
          const pathBlob = finalHead.pathBlobs[0]
          if (pathBlob === undefined) throw new Error('missing #13443 source blob')
          ;(pathBlob as unknown as { blobSha: string }).blobSha = '0'.repeat(40)
        },
      ],
      [
        'discontinuous introduction ancestry',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const { introductionCommit } = continuousIntroductionEvidence(fixture)
          ;(introductionCommit as unknown as { parents: string[] }).parents = ['0'.repeat(40)]
        },
      ],
      [
        'discontinuous completion ancestry',
        (fixture: ReturnType<typeof continuousRemediationFixture>) => {
          const completion = fixture.snapshot.comparison?.commits.find(
            (commit) => commit.sha === continuousHistory.completionMerge,
          )
          if (completion === undefined) throw new Error('missing remediation completion commit')
          ;(completion as unknown as { parents: string[] }).parents = ['0'.repeat(40)]
        },
      ],
    ] as const
  ).forEach(([name, mutate]) => {
    test(`rejects #13443 introduction evidence with ${name}`, () => {
      const fixture = continuousRemediationFixture()
      mutate(fixture)
      expect(evaluateContinuousRemediationFixture(fixture)).toMatchObject({
        status: 'hold',
        code: 'release-review-remediation-invalid',
        retryable: false,
      })
    })
  })

  test('keeps the #13443 reaction fail-closed until its full 30-second settling interval completes', () => {
    const fixture = continuousRemediationFixture()
    const completion = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === continuousHistory.completionMerge,
    )
    const completionReview = completion?.reviewSnapshot?.pullRequest?.reviews[0]
    if (completionReview === undefined) throw new Error('missing completion review evidence')
    ;(completionReview as unknown as { submittedAt: string }).submittedAt = '2026-08-01T08:28:00Z'
    expect(evaluateContinuousRemediationFixture(fixture, Date.parse('2026-08-01T08:29:46Z'))).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-settling',
      retryable: true,
      message: expect.stringContaining('exact final-head reaction is still settling'),
    })
  })

  test('accepts the exact #13429 through #13435 chain only through its reviewed v3 receipt completion', () => {
    expect(realMultiStageRemediationRecord).toMatchObject({
      schemaVersion: 'bayn.release-review-remediation.v3',
      blocked: {
        mergeCommitSha: multiStageHistory.blocked,
        sourcePullRequestNumber: 13429,
        finalHeadSha: 'bc32db2e9eeb7140f422fc1b6621427a8f7dabfc',
        reconstruction: { heads: { length: 5 }, forcePushes: { length: 4 }, feedback: { length: 9 } },
      },
      introduction: {
        mergeCommitSha: multiStageHistory.remediationMerge,
        finalHeadSha: multiStageHistory.remediationHead,
        sourcePullRequestNumber: 13435,
      },
      requiredDescendants: [
        { mergeCommitSha: multiStageHistory.candidate18, sourcePullRequestNumber: 13434 },
        { mergeCommitSha: multiStageHistory.paperProof, sourcePullRequestNumber: 13424 },
        { mergeCommitSha: multiStageHistory.activation, sourcePullRequestNumber: 13420 },
      ],
    })
    const captured = captureMultiStageReceiptEvidence(realMultiStageRemediationRecord)
    expect(pullRequestReviewEvidenceSha256(captured.sourcePull)).toBe(
      realMultiStageRemediationRecord.blocked.sourcePullRequestEvidenceSha256,
    )
    for (const descendant of realMultiStageRemediationRecord.requiredDescendants) {
      expect(pullRequestReviewEvidenceSha256(captured.descendantPulls.get(descendant.mergeCommitSha)!)).toBe(
        descendant.sourcePullRequestEvidenceSha256,
      )
    }
    expect(pullRequestReviewEvidenceSha256(captured.introductionPull)).toBe(
      realMultiStageRemediationRecord.introduction!.sourcePullRequestEvidenceSha256,
    )
    const fixture = multiStageRemediationFixture()
    const introduction = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === multiStageHistory.remediationMerge,
    )
    if (introduction?.reviewSnapshot === null || introduction?.reviewSnapshot === undefined) {
      throw new Error('missing introduction review snapshot')
    }
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha: multiStageHistory.remediationMerge,
        baseRefName: 'main',
        snapshot: introduction.reviewSnapshot,
        nowMs: Date.parse('2026-07-31T17:15:26Z'),
        pushBeforeSha: null,
      }),
    ).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
    expect(
      realMultiStageRemediationRecord.requiredSuccessors?.some(
        (successor) => successor.mergeCommitSha === multiStageHistory.candidate19,
      ),
    ).toBe(true)
    const candidate19 = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === multiStageHistory.candidate19,
    )
    if (candidate19?.reviewSnapshot === null || candidate19?.reviewSnapshot === undefined) {
      throw new Error('missing Candidate 19 review snapshot')
    }
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha: multiStageHistory.candidate19,
        baseRefName: 'main',
        snapshot: candidate19.reviewSnapshot,
        nowMs: Date.parse('2026-07-31T18:02:00Z'),
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'eligible',
      prNumber: 13436,
      headSha: multiStageHistory.candidate19Head,
    })
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: multiStageHistory.completionMerge,
        baseRefName: 'main',
        snapshot: fixture.snapshot,
        nowMs: Date.parse('2026-07-31T18:02:00Z'),
        pushBeforeSha: multiStageHistory.candidate19,
      }),
    ).toMatchObject({ status: 'eligible', checkedCommitCount: 9, baynAffectingCommitCount: 8 })
  })

  test.each([
    [
      'changed force-push chain',
      (fixture: ReturnType<typeof multiStageRemediationFixture>) => {
        const pull = fixture.snapshot.comparison?.commits.find((commit) => commit.sha === multiStageHistory.blocked)
          ?.reviewSnapshot?.pullRequest
        if (pull === undefined || pull === null) throw new Error('missing source pull')
        ;(pull.headForcePushes[0] as { afterCommitSha: string }).afterCommitSha = 'f'.repeat(40)
      },
    ],
    [
      'missing feedback thread',
      (fixture: ReturnType<typeof multiStageRemediationFixture>) => {
        const pull = fixture.snapshot.comparison?.commits.find((commit) => commit.sha === multiStageHistory.blocked)
          ?.reviewSnapshot?.pullRequest
        if (pull === undefined || pull === null) throw new Error('missing source pull')
        ;(pull.threads as PullRequestReviewThread[]).pop()
      },
    ],
    [
      'changed reconstructed blob',
      (fixture: ReturnType<typeof multiStageRemediationFixture>) => {
        const head = fixture.evidence.referencedCommits.find(
          (commit) => commit.sha === fixture.evidence.record.blocked.finalHeadSha,
        )
        if (head === undefined) throw new Error('missing final head')
        ;(head.pathBlobs[0] as { blobSha: string }).blobSha = 'f'.repeat(40)
      },
    ],
    [
      'spoofed descendant head',
      (fixture: ReturnType<typeof multiStageRemediationFixture>) => {
        ;(fixture.evidence.record.requiredDescendants[0] as { finalHeadSha: string }).finalHeadSha = 'f'.repeat(40)
      },
    ],
    [
      'stale current source blob',
      (fixture: ReturnType<typeof multiStageRemediationFixture>) => {
        ;(fixture.evidence.currentPathBlobs[0] as { blobSha: string }).blobSha = 'f'.repeat(40)
      },
    ],
  ] as const)('rejects v3 remediation with %s', (_name, mutate) => {
    const fixture = multiStageRemediationFixture()
    mutate(fixture)
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.candidate19,
        }),
      ),
    ).toMatchObject({ code: 'release-review-remediation-invalid', retryable: false })
  })

  test.each([
    [
      'reaction before final head',
      (pull: PullRequestReviewState): void => {
        ;(pull.reactions[0] as { createdAt: string }).createdAt = '2026-07-31T17:09:00Z'
      },
    ],
    [
      'spoofed reaction actor',
      (pull: PullRequestReviewState): void => {
        ;(pull.reactions[0] as { userLogin: string }).userLogin = 'spoofed-bot'
      },
    ],
    [
      'ambiguous reactions',
      (pull: PullRequestReviewState): void => {
        ;(pull.reactions as PullRequestReaction[]).push({ ...pull.reactions[0]! })
      },
    ],
    [
      'mismatched final head',
      (pull: PullRequestReviewState): void => {
        ;(pull.headForcePushes[0] as { afterCommitSha: string }).afterCommitSha = 'f'.repeat(40)
      },
    ],
    [
      'edited evidence',
      (pull: PullRequestReviewState): void => {
        ;(pull.reactions as PullRequestReaction[]).splice(0)
        ;(pull.issueComments as PullRequestIssueComment[]).push(
          issueComment({
            authorLogin: baynCodexBotLogin,
            body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${multiStageHistory.remediationHead.slice(0, 10)}\`\n`,
            createdAt: '2026-07-31T17:12:17Z',
            updatedAt: '2026-07-31T17:13:00Z',
          }),
        )
      },
    ],
    [
      'unresolved thread',
      (pull: PullRequestReviewState): void => {
        ;(pull.threads[0] as { isResolved: boolean }).isResolved = false
      },
    ],
    [
      'mismatched source PR',
      (pull: PullRequestReviewState): void => {
        ;(pull as { number: number }).number = 13499
      },
    ],
  ] as const)('rejects v3 introduction with %s', (_name, mutate) => {
    const fixture = multiStageRemediationFixture()
    const pull = fixture.snapshot.comparison?.commits.find(
      (commit) => commit.sha === multiStageHistory.remediationMerge,
    )?.reviewSnapshot?.pullRequest
    if (pull === undefined || pull === null) throw new Error('missing introduction pull')
    mutate(pull)
    const record = fixture.evidence.record
    if (record.schemaVersion !== 'bayn.release-review-remediation.v3' || record.introduction === undefined) {
      throw new Error('expected a v3 introduction receipt')
    }
    ;(record.introduction as { sourcePullRequestEvidenceSha256: string }).sourcePullRequestEvidenceSha256 =
      pullRequestReviewEvidenceSha256(pull)
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.candidate19,
        }),
      ),
    ).toMatchObject({ code: 'release-review-remediation-invalid', retryable: false })
  })

  test('keeps a missing completion exact-head review retryable', () => {
    const fixture = multiStageRemediationFixture()
    const pull = fixture.snapshot.comparison?.commits.find((commit) => commit.sha === multiStageHistory.completionMerge)
      ?.reviewSnapshot?.pullRequest
    if (pull === undefined || pull === null) throw new Error('missing completion pull')
    ;(pull.reviews as PullRequestReview[]).splice(0)
    ;(pull.reactions as PullRequestReaction[]).splice(0)
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.candidate19,
        }),
      ),
    ).toMatchObject({ code: 'exact-head-review-missing', retryable: true })
  })

  test('keeps a pending completion exact-head review retryable', () => {
    const fixture = multiStageRemediationFixture()
    const pull = fixture.snapshot.comparison?.commits.find((commit) => commit.sha === multiStageHistory.completionMerge)
      ?.reviewSnapshot?.pullRequest
    if (pull === undefined || pull === null) throw new Error('missing completion pull')
    ;(pull.reviews as PullRequestReview[]).splice(
      0,
      pull.reviews.length,
      review({
        commitSha: multiStageHistory.completionHead,
        submittedAt: null,
        state: 'PENDING',
      }),
    )
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.candidate19,
        }),
      ),
    ).toMatchObject({ code: 'exact-head-review-pending', retryable: true })
  })

  test('keeps a settling completion exact-head review retryable', () => {
    const fixture = multiStageRemediationFixture()
    const pull = fixture.snapshot.comparison?.commits.find((commit) => commit.sha === multiStageHistory.completionMerge)
      ?.reviewSnapshot?.pullRequest
    if (pull === undefined || pull === null) throw new Error('missing completion pull')
    ;(pull.reviews as PullRequestReview[]).splice(
      0,
      pull.reviews.length,
      review({
        commitSha: multiStageHistory.completionHead,
        submittedAt: '2026-07-31T18:01:50Z',
      }),
    )
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.candidate19,
        }),
      ),
    ).toMatchObject({ code: 'exact-head-review-settling', retryable: true })
  })

  test('keeps a changes-requested completion review terminal', () => {
    const fixture = multiStageRemediationFixture()
    const pull = fixture.snapshot.comparison?.commits.find((commit) => commit.sha === multiStageHistory.completionMerge)
      ?.reviewSnapshot?.pullRequest
    if (pull === undefined || pull === null) throw new Error('missing completion pull')
    ;(pull.reviews as PullRequestReview[]).splice(
      0,
      pull.reviews.length,
      review({
        commitSha: multiStageHistory.completionHead,
        submittedAt: '2026-07-31T18:01:00Z',
        state: 'CHANGES_REQUESTED',
      }),
    )
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.completionMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.candidate19,
        }),
      ),
    ).toMatchObject({ code: 'release-review-remediation-invalid', retryable: false })
  })

  test('rejects v3 remediation that omits an unrelated newer unreviewed Bayn source commit', () => {
    const fixture = multiStageRemediationFixture()
    const comparison = fixture.snapshot.comparison
    if (comparison === null) throw new Error('missing comparison')
    const completion = comparison.commits.at(-1)
    if (completion === undefined) throw new Error('missing completion')
    const extraSha = 'd'.repeat(40)
    const mutableCommits = comparison.commits as unknown as Array<(typeof comparison.commits)[number]>
    mutableCommits.push({
      sha: extraSha,
      parents: [multiStageHistory.completionMerge],
      treeSha: 'e'.repeat(40),
      files: ['services/bayn/src/unrelated-new-source.ts'],
      fileChanges: [
        {
          path: 'services/bayn/src/unrelated-new-source.ts',
          previousPath: null,
          status: 'added',
          blobSha: 'f'.repeat(40),
        },
      ],
      reviewSnapshot: reviewSnapshotFor({
        commitSha: extraSha,
        prNumber: 13437,
        headSha: 'c'.repeat(40),
        parents: [multiStageHistory.completionMerge],
        reviews: [],
      }),
    })
    ;(comparison as { headSha: string; aheadBy: number; totalCommits: number }).headSha = extraSha
    ;(comparison as { headSha: string; aheadBy: number; totalCommits: number }).aheadBy = 10
    ;(comparison as { headSha: string; aheadBy: number; totalCommits: number }).totalCommits = 10
    ;(fixture.snapshot as unknown as { currentCommitParents: string[] }).currentCommitParents = [
      multiStageHistory.completionMerge,
    ]
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: extraSha,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T18:02:00Z'),
          pushBeforeSha: multiStageHistory.completionMerge,
        }),
      ),
    ).toMatchObject({ code: 'exact-head-review-missing' })
  })

  test('accepts the real #13428 -> #13422 -> #13427 history only through its reviewed exact receipt', () => {
    expect(realRemediationRecord).toMatchObject({
      blocked: {
        mergeCommitSha: realHistory.blocked,
        reviewedHeadSha: realHistory.reviewed,
        finalHeadSha: realHistory.final,
        sourcePullRequestNumber: 13428,
      },
      requiredDescendants: [
        { mergeCommitSha: realHistory.candidateMerge, sourcePullRequestNumber: 13422 },
        { mergeCommitSha: realHistory.qualificationMerge, sourcePullRequestNumber: 13427 },
      ],
    })
    const fixture = remediationHistoryFixture()
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: realHistory.remediationMerge,
        baseRefName: 'main',
        snapshot: fixture.snapshot,
        nowMs: Date.parse('2026-07-31T12:30:00Z'),
        pushBeforeSha: realHistory.qualificationMerge,
      }),
    ).toMatchObject({
      status: 'eligible',
      lastPublishedRevision: realHistory.base,
      checkedCommitCount: 4,
      baynAffectingCommitCount: 4,
      reviewedPullRequests: [
        { commitSha: realHistory.blocked, prNumber: 13428, headSha: realHistory.final },
        { commitSha: realHistory.candidateMerge, prNumber: 13422, headSha: realHistory.candidateHead },
        { commitSha: realHistory.qualificationMerge, prNumber: 13427, headSha: realHistory.qualificationHead },
        { commitSha: realHistory.remediationMerge, prNumber: 13430, headSha: realHistory.remediationHead },
      ],
    })
  })

  test('accepts exact remediation descendants across an interleaved direct-parent chain of non-Bayn commits', () => {
    const fixture = remediationHistoryFixture()
    const comparison = fixture.snapshot.comparison!
    const [blocked, candidate, qualification, introduction] = comparison.commits
    if (blocked === undefined || candidate === undefined || qualification === undefined || introduction === undefined) {
      throw new Error('remediation fixture commit chain is incomplete')
    }
    const nonBaynCommit = (sha: string, parent: string, path: string) => ({
      sha,
      parents: [parent],
      treeSha: sha,
      files: [path],
      fileChanges: [{ path, previousPath: null, status: 'modified', blobSha: sha }],
      reviewSnapshot: null,
    })
    const beforeCandidate = nonBaynCommit('1'.repeat(40), blocked.sha, 'docs/bayn-release-review.md')
    const beforeQualification = nonBaynCommit('2'.repeat(40), candidate.sha, 'docs/bayn-qualification.md')
    const beforeIntroduction = nonBaynCommit('3'.repeat(40), qualification.sha, 'README.md')
    const afterIntroduction = nonBaynCommit('4'.repeat(40), introduction.sha, 'docs/operations.md')
    ;(candidate.parents as string[])[0] = beforeCandidate.sha
    ;(qualification.parents as string[])[0] = beforeQualification.sha
    ;(introduction.parents as string[])[0] = beforeIntroduction.sha
    const candidateHead = fixture.evidence.referencedCommits.find((commit) => commit.sha === realHistory.candidateHead)
    const qualificationHead = fixture.evidence.referencedCommits.find(
      (commit) => commit.sha === realHistory.qualificationHead,
    )
    if (candidateHead === undefined || qualificationHead === undefined) {
      throw new Error('remediation fixture descendant head evidence is incomplete')
    }
    ;(candidateHead.parents as string[])[0] = beforeCandidate.sha
    ;(qualificationHead.parents as string[])[0] = beforeQualification.sha
    ;(
      comparison as unknown as {
        headSha: string
        aheadBy: number
        totalCommits: number
        commits: unknown[]
      }
    ).headSha = afterIntroduction.sha
    ;(
      comparison as unknown as {
        headSha: string
        aheadBy: number
        totalCommits: number
        commits: unknown[]
      }
    ).aheadBy = 8
    ;(
      comparison as unknown as {
        headSha: string
        aheadBy: number
        totalCommits: number
        commits: unknown[]
      }
    ).totalCommits = 8
    ;(
      comparison as unknown as {
        headSha: string
        aheadBy: number
        totalCommits: number
        commits: unknown[]
      }
    ).commits = [
      blocked,
      beforeCandidate,
      candidate,
      beforeQualification,
      qualification,
      beforeIntroduction,
      introduction,
      afterIntroduction,
    ]
    ;(fixture.snapshot.currentCommitParents as string[])[0] = introduction.sha

    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: afterIntroduction.sha,
        baseRefName: 'main',
        snapshot: fixture.snapshot,
        nowMs: Date.parse('2026-07-31T12:30:00Z'),
        pushBeforeSha: introduction.sha,
      }),
    ).toMatchObject({
      status: 'eligible',
      checkedCommitCount: 8,
      baynAffectingCommitCount: 4,
    })
  })

  test('keeps the dropped reviewed ancestor blocked without the exact receipt', () => {
    const fixture = remediationHistoryFixture()
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: realHistory.remediationMerge,
        baseRefName: 'main',
        snapshot: { ...fixture.snapshot, remediations: [] },
        nowMs: Date.parse('2026-07-31T12:30:00Z'),
        pushBeforeSha: realHistory.qualificationMerge,
      }),
    ).toMatchObject({ status: 'hold', code: 'release-review-remediation-missing', retryable: false })
  })

  test.each([
    [
      'pending',
      review({ commitSha: realHistory.candidateHead, submittedAt: null, state: 'PENDING' }),
      'exact-head-review-pending',
    ],
    [
      'changes-requested',
      review({
        commitSha: realHistory.candidateHead,
        submittedAt: '2026-07-31T11:22:50Z',
        state: 'CHANGES_REQUESTED',
      }),
      'exact-head-review-changes-requested',
    ],
  ])('keeps a newer %s exact-head descendant review blocking remediation coverage', (_name, blockingReview, code) => {
    const fixture = remediationHistoryFixture()
    const pullRequest = fixture.snapshot.comparison!.commits[1]!.reviewSnapshot!.pullRequest!
    ;(pullRequest.reviews as PullRequestReview[]).push(blockingReview)

    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: realHistory.remediationMerge,
        baseRefName: 'main',
        snapshot: fixture.snapshot,
        nowMs: Date.parse('2026-07-31T12:30:00Z'),
        pushBeforeSha: realHistory.qualificationMerge,
      }),
    ).toMatchObject({ status: 'hold', code })
  })

  test.each([
    [
      'changed current blob',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        ;(fixture.evidence.currentPathBlobs as { path: string; blobSha: string }[])[0]!.blobSha = '0'.repeat(40)
      },
    ],
    [
      'extra affected path',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        ;(
          fixture.evidence.record.blocked
            .affectedPaths as BaynReleaseReviewRemediationRecord['blocked']['affectedPaths'] as unknown as {
            path: string
            reviewedBlobSha: string
            finalBlobSha: string
            blockedBlobSha: string
          }[]
        ).push({
          path: 'services/bayn/src/extra.ts',
          reviewedBlobSha: '1'.repeat(40),
          finalBlobSha: '1'.repeat(40),
          blockedBlobSha: '1'.repeat(40),
        })
      },
    ],
    [
      'non-ancestor descendant',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const comparison = fixture.snapshot.comparison!
        ;(comparison.commits[1]!.parents as string[])[0] = '0'.repeat(40)
      },
    ],
    [
      'spoofed source reaction',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[0]!.reviewSnapshot!.pullRequest!
        ;(pull.reactions as { userLogin: string | null; content: string; createdAt: string }[])[0]!.userLogin =
          'spoofed-codex[bot]'
        ;(
          fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
        ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'stale source reaction before force push',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[0]!.reviewSnapshot!.pullRequest!
        ;(pull.reactions as { userLogin: string | null; content: string; createdAt: string }[])[0]!.createdAt =
          '2026-07-31T11:09:00Z'
        ;(
          fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
        ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'changes-requested review on a dropped source head',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[0]!.reviewSnapshot!.pullRequest!
        ;(pull.reviews as PullRequestReview[]).push(
          review({
            commitSha: 'a'.repeat(40),
            submittedAt: '2026-07-31T11:05:00Z',
            state: 'CHANGES_REQUESTED',
          }),
        )
        ;(
          fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
        ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'pending review on a dropped source head',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[0]!.reviewSnapshot!.pullRequest!
        ;(pull.reviews as PullRequestReview[]).push(
          review({ commitSha: 'b'.repeat(40), submittedAt: null, state: 'PENDING' }),
        )
        ;(
          fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
        ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'additional unresolved source review thread',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[0]!.reviewSnapshot!.pullRequest!
        ;(pull.threads as PullRequestReviewThread[]).push(
          thread({
            id: 'PRRT_unresolved_source_finding',
            isResolved: false,
            isOutdated: false,
            path: 'services/bayn/candidates/ordinal-17-volatility-managed-trend-overlay-preregistration.md',
            url: 'https://github.com/proompteng/lab/pull/13428#discussion_r_unresolved',
            comments: [
              threadComment({
                body: 'P1 unresolved source finding',
                commitSha: realHistory.reviewed,
                reviewCommitSha: realHistory.reviewed,
                reviewSubmittedAt: '2026-07-31T11:02:00Z',
                createdAt: '2026-07-31T11:02:00Z',
                url: 'https://github.com/proompteng/lab/pull/13428#discussion_r_unresolved',
              }),
            ],
          }),
        )
        ;(
          fixture.evidence.record as unknown as { blocked: { sourcePullRequestEvidenceSha256: string } }
        ).blocked.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'changes-requested review on a dropped descendant head',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[1]!.reviewSnapshot!.pullRequest!
        ;(pull.reviews as PullRequestReview[]).push(
          review({
            commitSha: 'c'.repeat(40),
            submittedAt: '2026-07-31T11:21:00Z',
            state: 'CHANGES_REQUESTED',
          }),
        )
        ;(
          fixture.evidence.record as unknown as {
            requiredDescendants: { sourcePullRequestEvidenceSha256: string }[]
          }
        ).requiredDescendants[0]!.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'pending review on a dropped descendant head',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[1]!.reviewSnapshot!.pullRequest!
        ;(pull.reviews as PullRequestReview[]).push(
          review({ commitSha: 'd'.repeat(40), submittedAt: null, state: 'PENDING' }),
        )
        ;(
          fixture.evidence.record as unknown as {
            requiredDescendants: { sourcePullRequestEvidenceSha256: string }[]
          }
        ).requiredDescendants[0]!.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'incomplete descendant review chain',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const pull = fixture.snapshot.comparison!.commits[1]!.reviewSnapshot!.pullRequest!
        ;(pull.reactions as unknown as unknown[]) = []
        ;(
          fixture.evidence.record as unknown as {
            requiredDescendants: { sourcePullRequestEvidenceSha256: string }[]
          }
        ).requiredDescendants[0]!.sourcePullRequestEvidenceSha256 = pullRequestReviewEvidenceSha256(pull)
      },
    ],
    [
      'duplicate receipt',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        ;(fixture.snapshot.remediations as BaynReleaseReviewRemediationEvidence[]) = [
          fixture.evidence,
          structuredClone(fixture.evidence),
        ]
      },
    ],
    [
      'later blocked-path mutation',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const commit = fixture.snapshot.comparison!.commits[2]!
        const path = fixture.evidence.record.blocked.affectedPaths[0]!.path
        ;(commit.files as string[]).push(path)
        ;(
          commit.fileChanges as { path: string; previousPath: string | null; status: string; blobSha: string | null }[]
        ).push({
          path,
          previousPath: null,
          status: 'modified',
          blobSha: '2'.repeat(40),
        })
      },
    ],
    [
      'newer unreviewed source downgrade',
      (fixture: ReturnType<typeof remediationHistoryFixture>) => {
        const comparison = fixture.snapshot.comparison!
        const introduction = comparison.commits.at(-1)!
        const unreviewedSha = '3'.repeat(40)
        const unreviewed = {
          sha: unreviewedSha,
          parents: [realHistory.qualificationMerge],
          treeSha: '4'.repeat(40),
          files: ['services/bayn/src/unreviewed.ts'],
          fileChanges: [
            {
              path: 'services/bayn/src/unreviewed.ts',
              previousPath: null,
              status: 'added',
              blobSha: '5'.repeat(40),
            },
          ],
          reviewSnapshot: null,
        }
        ;(introduction.parents as string[])[0] = unreviewedSha
        ;(comparison.commits as unknown as typeof comparison.commits as unknown as unknown[]).splice(3, 0, unreviewed)
        ;(comparison as { aheadBy: number; totalCommits: number }).aheadBy = 5
        ;(comparison as { aheadBy: number; totalCommits: number }).totalCommits = 5
      },
    ],
  ])('rejects remediation evidence with %s', (name, mutate) => {
    const fixture = remediationHistoryFixture()
    mutate(fixture)
    const result = evaluateBaynReleaseEligibility({
      mainCommitSha: realHistory.remediationMerge,
      baseRefName: 'main',
      snapshot: fixture.snapshot,
      nowMs: Date.parse('2026-07-31T12:30:00Z'),
      pushBeforeSha: realHistory.qualificationMerge,
    })
    expect(result).toMatchObject({
      status: 'hold',
      code:
        name === 'newer unreviewed source downgrade'
          ? 'release-range-metadata-mismatch'
          : 'release-review-remediation-invalid',
      retryable: false,
    })
  })

  test('accepts every clean Bayn-affecting commit since the last published revision', () => {
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: eligibilitySnapshot(),
        nowMs: evaluationNowMs,
        pushBeforeSha,
      }),
    ).toMatchObject({
      status: 'eligible',
      lastPublishedRevision: lastPublishedSha,
      checkedCommitCount: 1,
      baynAffectingCommitCount: 1,
      reviewedPullRequests: [{ commitSha: mainCommitSha, prNumber: 13390, headSha: finalHeadSha }],
    })
  })

  test('holds a later clean separate push when an earlier held Bayn run was cancelled', () => {
    const heldReview = reviewSnapshotFor({
      commitSha: heldCommitSha,
      prNumber: 13391,
      headSha: heldHeadSha,
      parents: [lastPublishedSha],
      threads: [
        thread({
          id: 'held-thread',
          isResolved: false,
          url: 'https://github.com/proompteng/lab/pull/13391#discussion_held',
        }),
      ],
    })
    const cleanReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13392,
      headSha: finalHeadSha,
      parents: [heldCommitSha],
    })
    const result = evaluateBaynReleaseEligibility({
      mainCommitSha,
      baseRefName: 'main',
      snapshot: eligibilitySnapshot({
        currentCommitParents: [heldCommitSha],
        comparison: {
          status: 'ahead',
          baseSha: lastPublishedSha,
          headSha: mainCommitSha,
          mergeBaseSha: lastPublishedSha,
          aheadBy: 2,
          totalCommits: 2,
          commits: [
            {
              sha: heldCommitSha,
              parents: [lastPublishedSha],
              files: ['services/bayn/src/held.ts'],
              reviewSnapshot: heldReview,
            },
            {
              sha: mainCommitSha,
              parents: [heldCommitSha],
              files: ['services/bayn/src/clean.ts'],
              reviewSnapshot: cleanReview,
            },
          ],
          truncated: false,
        },
      }),
      nowMs: evaluationNowMs,
      pushBeforeSha: heldCommitSha,
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'active-unresolved-review-threads',
      retryable: false,
    })
    if (result.status !== 'hold') throw new Error('expected held earlier Bayn commit')
    expect(result.message).toContain(heldCommitSha.slice(0, 12))
    expect(result.message).toContain(lastPublishedSha.slice(0, 12))
  })

  test('holds boundedly when no last successfully published revision exists', async () => {
    const result = await pollBaynReleaseEligibility({
      mainCommitSha,
      baseRefName: 'main',
      pushBeforeSha,
      maxAttempts: 2,
      pollIntervalMs: 1,
      loadSnapshot: async () =>
        eligibilitySnapshot({
          lastPublishedRevision: { status: 'missing' },
          comparison: null,
        }),
      sleep: async () => {},
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'last-published-revision-missing',
      attempts: 2,
      timedOut: true,
    })
  })

  test('holds an ambiguous latest successful publication revision', () => {
    const firstRevision = '2'.repeat(40)
    const secondRevision = '3'.repeat(40)
    expect(
      resolveLastPublishedRevision([
        successfulPublishRun({ headSha: firstRevision }),
        successfulPublishRun({ id: 101, headSha: secondRevision }),
      ]),
    ).toEqual({
      status: 'ambiguous',
      runNumber: 10,
      revisions: [firstRevision, secondRevision],
    })

    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: eligibilitySnapshot({
          lastPublishedRevision: {
            status: 'ambiguous',
            runNumber: 10,
            revisions: [firstRevision, secondRevision],
          },
          comparison: null,
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'last-published-revision-ambiguous',
      retryable: false,
    })
  })

  test('matches only Bayn release inputs when filtering the publication range', () => {
    expect(isBaynReleaseAffectingPath('services/bayn/src/app.ts')).toBe(true)
    expect(isBaynReleaseAffectingPath('.github/workflows/bayn-build-push.yml')).toBe(true)
    expect(isBaynReleaseAffectingPath('packages/other/package.json')).toBe(true)
    expect(isBaynReleaseAffectingPath('services/other/src/app.ts')).toBe(false)
    expect(isBaynReleaseAffectingPath('.github/workflows/torghut-release.yml')).toBe(false)
  })

  test('decodes successful publication, comparison, commit, and review evidence', async () => {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/actions/workflows/')) {
        return Response.json({
          workflow_runs: [
            {
              id: 100,
              run_number: 10,
              run_attempt: 1,
              head_sha: lastPublishedSha,
              head_branch: 'main',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        })
      }
      if (url.includes('/compare/')) {
        return Response.json({
          status: 'ahead',
          ahead_by: 1,
          total_commits: 1,
          base_commit: { sha: lastPublishedSha },
          merge_base_commit: { sha: lastPublishedSha },
          commits: [{ sha: mainCommitSha }],
        })
      }
      if (url.includes(`/commits/${mainCommitSha}/pulls?`)) {
        return Response.json([
          {
            number: 13390,
            base: { ref: 'main' },
            head: { sha: finalHeadSha },
            merge_commit_sha: mainCommitSha,
            merged_at: '2026-07-30T07:01:30Z',
          },
        ])
      }
      if (url.includes(`/commits/${mainCommitSha}?`)) {
        return Response.json({
          sha: mainCommitSha,
          parents: [{ sha: pushBeforeSha }],
          files: [
            {
              filename: 'services/other/src/example.ts',
              previous_filename: 'services/bayn/src/example.ts',
            },
          ],
        })
      }
      if (url.includes('/issues/13390/comments?') || url.includes('/issues/13390/reactions?')) {
        return Response.json([])
      }

      const request = JSON.parse(String(init?.body)) as { readonly query: string }
      if (request.query.includes('BaynReleasePullRequestMetadata')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                number: 13390,
                baseRefName: 'main',
                headRefOid: finalHeadSha,
                createdAt: '2026-07-30T06:59:00Z',
                mergedAt: '2026-07-30T07:01:30Z',
                mergeCommit: { oid: mainCommitSha },
                timelineItems: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestReviews')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      author: { login: baynCodexReviewer },
                      commit: { oid: finalHeadSha },
                      submittedAt: '2026-07-30T07:01:00Z',
                      state: 'COMMENTED',
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestThreads')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestCommits')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [{ commit: { oid: finalHeadSha } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      throw new Error(`unexpected fixture request: ${url}`)
    }) as typeof fetch

    const loader = createGitHubReleaseEligibilityLoader({
      repository: 'proompteng/lab',
      token: 'fixture-token',
      mainCommitSha,
      baseRefName: 'main',
      requestTimeoutMs: 1_000,
      fetchFn,
    })

    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: await loader(),
        nowMs: evaluationNowMs,
        pushBeforeSha,
      }),
    ).toMatchObject({
      status: 'eligible',
      lastPublishedRevision: lastPublishedSha,
      checkedCommitCount: 1,
      baynAffectingCommitCount: 1,
    })
  })
})

describe('Bayn delayed-attestation publication retry', () => {
  const retryNowMs = Date.parse('2026-07-30T07:04:00Z')

  test('dispatches after the original bounded push wait timed out and a clean exact-head comment arrived later', async () => {
    const timedOut = await pollBaynReleaseEligibility({
      mainCommitSha,
      baseRefName: 'main',
      pushBeforeSha,
      maxAttempts: 10,
      pollIntervalMs: 10_000,
      loadSnapshot: async () =>
        eligibilitySnapshot({
          comparison: {
            status: 'ahead',
            baseSha: lastPublishedSha,
            headSha: mainCommitSha,
            mergeBaseSha: lastPublishedSha,
            aheadBy: 1,
            totalCommits: 1,
            commits: [
              {
                sha: mainCommitSha,
                parents: [lastPublishedSha],
                files: ['packages/scripts/src/bayn/verify-release-review.ts'],
                reviewSnapshot: reviewSnapshotFor({
                  commitSha: mainCommitSha,
                  prNumber: 13401,
                  headSha: finalHeadSha,
                  parents: [lastPublishedSha],
                  mergedAt: '2026-07-30T07:00:00Z',
                  reviews: [],
                }),
              },
            ],
            truncated: false,
          },
        }),
      sleep: async () => {},
      now: () => Date.parse('2026-07-30T07:02:20Z'),
    })

    expect(timedOut).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-missing',
      attempts: 10,
      timedOut: true,
    })

    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot(),
        trigger: { type: 'issue-comment', prNumber: 13401, actorLogin: baynCodexBotLogin },
        nowMs: retryNowMs,
      }),
    ).toEqual({
      status: 'dispatch',
      currentMainSha: mainCommitSha,
      sourceCommitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      failedRunId: 30540000001,
    })
  })

  test('dispatches when an exact-head review finishes settling after the failed push', () => {
    const settlingReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:01:00Z' })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: settlingReview,
          failedRun: failedBuildRun({ updatedAt: '2026-07-30T07:01:20Z' }),
        }),
        trigger: { type: 'schedule' },
        nowMs: Date.parse('2026-07-30T07:02:00Z'),
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
    })
  })

  test('dispatches when review readiness and failed-run completion share the same GitHub timestamp second', () => {
    const settlingReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:01:00Z' })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: settlingReview,
          failedRun: failedBuildRun({ updatedAt: '2026-07-30T07:01:30Z' }),
        }),
        trigger: { type: 'schedule' },
        nowMs: Date.parse('2026-07-30T07:02:00Z'),
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
    })
  })

  test('uses the failed review job completion before later workflow-run finalization', () => {
    const settlingReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:02:01Z' })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: settlingReview,
          failedRun: failedBuildRun({ updatedAt: '2026-07-30T07:02:35Z' }),
          failedReviewJobCompletedAt: '2026-07-30T07:02:30Z',
        }),
        trigger: { type: 'schedule' },
        nowMs: Date.parse('2026-07-30T07:03:00Z'),
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
    })
  })

  test('dispatches when the failed gate proves a matching unresolved thread that is resolved later', () => {
    const resolvedReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:00:00Z' })],
      threads: [thread({ isResolved: true })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: resolvedReview,
          failedRun: failedBuildRun({ updatedAt: '2026-07-30T07:02:30Z' }),
          reviewThreadBlock: { commitShaPrefix: mainCommitSha.slice(0, 12), prNumber: 13401 },
        }),
        trigger: { type: 'schedule' },
        nowMs: Date.parse('2026-07-30T07:04:00Z'),
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
    })
  })

  test('keeps unresolved-thread retry evidence exact, trusted, and non-actionable', () => {
    const resolvedReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:00:00Z' })],
      threads: [thread({ isResolved: true })],
    })
    const exactSnapshot = retrySnapshot({
      reviewSnapshot: resolvedReview,
      reviewThreadBlock: { commitShaPrefix: mainCommitSha.slice(0, 12), prNumber: 13401 },
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: exactSnapshot,
        trigger: { type: 'issue-comment', prNumber: 13401, actorLogin: 'spoofed-codex[bot]' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'retry-trigger-mismatch', retryable: false })

    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: resolvedReview,
          reviewThreadBlock: { commitShaPrefix: olderHeadSha.slice(0, 12), prNumber: 13401 },
        }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'retry-failed-run-mismatch', retryable: false })

    const stillActionable = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:00:00Z' })],
      threads: [thread({ isResolved: false })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: stillActionable,
          reviewThreadBlock: { commitShaPrefix: mainCommitSha.slice(0, 12), prNumber: 13401 },
        }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'active-unresolved-review-threads', retryable: false })
  })

  test('dispatches after a trusted feedback reply thread is resolved following the failed gate', () => {
    const feedbackComments = [
      threadComment({
        createdAt: '2026-07-30T07:00:00Z',
        reviewSubmittedAt: '2026-07-30T07:00:00Z',
      }),
      threadComment({
        authorLogin: 'gregkonush',
        authorAssociation: 'MEMBER',
        body: 'Fixed in the final head.',
        createdAt: '2026-07-30T07:01:00Z',
        commitSha: finalHeadSha,
        reviewCommitSha: finalHeadSha,
        reviewAuthorLogin: 'gregkonush',
        reviewSubmittedAt: '2026-07-30T07:01:00Z',
      }),
    ]
    const unresolvedFeedback = snapshot({
      commitShas: [olderHeadSha, finalHeadSha],
      reviews: [review({ commitSha: olderHeadSha, submittedAt: '2026-07-30T07:00:00Z' })],
      threads: [thread({ isResolved: false, comments: feedbackComments })],
    })
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: unresolvedFeedback,
        nowMs: retryNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({ status: 'hold', code: 'feedback-fix-attestation-missing', retryable: true })

    const resolvedFeedback = snapshot({
      commitShas: [olderHeadSha, finalHeadSha],
      reviews: [review({ commitSha: olderHeadSha, submittedAt: '2026-07-30T07:00:00Z' })],
      threads: [thread({ isResolved: true, comments: feedbackComments })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          reviewSnapshot: resolvedFeedback,
          failedRun: failedBuildRun({ updatedAt: '2026-07-30T07:02:30Z' }),
          reviewThreadBlock: { commitShaPrefix: mainCommitSha.slice(0, 12), prNumber: 13390 },
        }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13390,
      headSha: finalHeadSha,
    })
  })

  test('dispatches when the final required feedback attestation arrives after the failed push', () => {
    const feedbackReview = snapshot({
      commitShas: [olderHeadSha, finalHeadSha],
      reviews: [review({ commitSha: olderHeadSha, submittedAt: '2026-07-30T07:00:00Z' })],
      threads: [
        thread({
          comments: [
            threadComment({
              createdAt: '2026-07-30T07:00:00Z',
              reviewSubmittedAt: '2026-07-30T07:00:00Z',
            }),
            threadComment({
              authorLogin: 'gregkonush',
              authorAssociation: 'MEMBER',
              body: 'Fixed in the final head.',
              createdAt: '2026-07-30T07:03:00Z',
              commitSha: finalHeadSha,
              reviewCommitSha: finalHeadSha,
              reviewAuthorLogin: 'gregkonush',
              reviewSubmittedAt: '2026-07-30T07:03:00Z',
            }),
          ],
        }),
      ],
    })
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: feedbackReview,
        nowMs: retryNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'eligible',
      reviewSubmittedAt: '2026-07-30T07:00:00Z',
      eligibleAt: '2026-07-30T07:03:00.000Z',
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({ reviewSnapshot: feedbackReview }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13390,
      headSha: finalHeadSha,
    })
  })

  test('binds a retry to the earlier range commit whose attestation arrived after the failed current-main push', () => {
    const earlierCommitSha = heldCommitSha
    const earlierHeadSha = heldHeadSha
    const earlierReview = reviewSnapshotFor({
      commitSha: earlierCommitSha,
      prNumber: 13401,
      headSha: earlierHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [],
      issueComments: [
        issueComment({
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${earlierHeadSha.slice(0, 10)}\`\n`,
          createdAt: '2026-07-30T07:03:00Z',
          updatedAt: '2026-07-30T07:03:00Z',
        }),
      ],
    })
    const laterReview = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13402,
      headSha: finalHeadSha,
      parents: [earlierCommitSha],
      mergedAt: '2026-07-30T07:01:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:00:30Z' })],
    })
    const range = eligibilitySnapshot({
      comparison: {
        status: 'ahead',
        baseSha: lastPublishedSha,
        headSha: mainCommitSha,
        mergeBaseSha: lastPublishedSha,
        aheadBy: 2,
        totalCommits: 2,
        commits: [
          {
            sha: earlierCommitSha,
            parents: [lastPublishedSha],
            files: ['services/bayn/src/earlier.ts'],
            reviewSnapshot: earlierReview,
          },
          {
            sha: mainCommitSha,
            parents: [earlierCommitSha],
            files: ['services/bayn/src/later.ts'],
            reviewSnapshot: laterReview,
          },
        ],
        truncated: false,
      },
    })

    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({ eligibility: range }),
        trigger: { type: 'issue-comment', prNumber: 13401, actorLogin: baynCodexBotLogin },
        nowMs: retryNowMs,
      }),
    ).toEqual({
      status: 'dispatch',
      currentMainSha: mainCommitSha,
      sourceCommitSha: earlierCommitSha,
      prNumber: 13401,
      headSha: earlierHeadSha,
      failedRunId: 30540000001,
    })
  })

  test('revalidates the exact retry binding on the trusted workflow-dispatch run', () => {
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot(),
        trigger: {
          type: 'workflow-dispatch',
          sourceCommitSha: mainCommitSha,
          prNumber: 13401,
          headSha: finalHeadSha,
          failedRunId: 30540000001,
        },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({
      status: 'dispatch',
      currentMainSha: mainCommitSha,
      sourceCommitSha: mainCommitSha,
    })
  })

  test('rejects spoofed and stale issue-comment retry triggers', () => {
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot(),
        trigger: { type: 'issue-comment', prNumber: 13401, actorLogin: 'spoofed-codex[bot]' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'retry-trigger-mismatch', retryable: false })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot(),
        trigger: { type: 'issue-comment', prNumber: 13399, actorLogin: baynCodexBotLogin },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'retry-attestation-not-delayed', retryable: true })
  })

  test('fails closed when a scheduled scan sees multiple delayed source attestations', () => {
    const secondCommitSha = '2'.repeat(40)
    const secondHeadSha = '3'.repeat(40)
    const first = reviewSnapshotFor({
      commitSha: secondCommitSha,
      prNumber: 13401,
      headSha: secondHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ commitSha: secondHeadSha, submittedAt: '2026-07-30T07:03:00Z' })],
    })
    const second = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13402,
      headSha: finalHeadSha,
      parents: [secondCommitSha],
      mergedAt: '2026-07-30T07:01:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:03:10Z' })],
    })
    const range = eligibilitySnapshot({
      comparison: {
        status: 'ahead',
        baseSha: lastPublishedSha,
        headSha: mainCommitSha,
        mergeBaseSha: lastPublishedSha,
        aheadBy: 2,
        totalCommits: 2,
        commits: [
          {
            sha: secondCommitSha,
            parents: [lastPublishedSha],
            files: ['services/bayn/src/first.ts'],
            reviewSnapshot: first,
          },
          {
            sha: mainCommitSha,
            parents: [secondCommitSha],
            files: ['services/bayn/src/second.ts'],
            reviewSnapshot: second,
          },
        ],
        truncated: false,
      },
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({ eligibility: range }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'retry-delayed-source-ambiguous', retryable: false })
  })

  test('rejects a delayed source whose final PR head was force-pushed', () => {
    const forced = reviewSnapshotFor({
      commitSha: mainCommitSha,
      prNumber: 13401,
      headSha: finalHeadSha,
      parents: [lastPublishedSha],
      mergedAt: '2026-07-30T07:00:00Z',
      reviews: [review({ submittedAt: '2026-07-30T07:03:00Z' })],
      headForcePushCount: 1,
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({ reviewSnapshot: forced }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'retry-source-pr-force-pushed', retryable: false })
  })

  test('keeps actionable reviews and unresolved threads blocking delayed retry', () => {
    const cases = [
      {
        reviewSnapshot: reviewSnapshotFor({
          commitSha: mainCommitSha,
          prNumber: 13401,
          headSha: finalHeadSha,
          parents: [lastPublishedSha],
          mergedAt: '2026-07-30T07:00:00Z',
          reviews: [review({ submittedAt: '2026-07-30T07:03:00Z', state: 'CHANGES_REQUESTED' })],
          reactions: [reaction({ createdAt: '2026-07-30T07:03:00Z' })],
        }),
        code: 'exact-head-review-changes-requested',
      },
      {
        reviewSnapshot: reviewSnapshotFor({
          commitSha: mainCommitSha,
          prNumber: 13401,
          headSha: finalHeadSha,
          parents: [lastPublishedSha],
          mergedAt: '2026-07-30T07:00:00Z',
          reviews: [],
          reactions: [reaction({ createdAt: '2026-07-30T07:03:00Z' })],
          threads: [thread({ isResolved: false })],
        }),
        code: 'active-unresolved-review-threads',
      },
    ] as const
    for (const item of cases) {
      expect(
        evaluateBaynReleaseRetry({
          mainCommitSha,
          baseRefName: 'main',
          snapshot: retrySnapshot({ reviewSnapshot: item.reviewSnapshot }),
          trigger: { type: 'schedule' },
          nowMs: retryNowMs,
        }),
      ).toMatchObject({ status: 'hold', code: item.code, retryable: false })
    }
  })

  test('rejects ambiguous source association and already published or active retry states', () => {
    const ambiguous = snapshot({
      associated: [associatedPull({ number: 13401 }), associatedPull({ number: 13402, headSha: olderHeadSha })],
      reviews: [],
      issueComments: [issueComment({ createdAt: '2026-07-30T07:03:00Z', updatedAt: '2026-07-30T07:03:00Z' })],
    })
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({ reviewSnapshot: ambiguous }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'hold', code: 'ambiguous-associated-source-prs', retryable: false })

    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({
          eligibility: eligibilitySnapshot({
            lastPublishedRevision: {
              status: 'resolved',
              revision: mainCommitSha,
              runId: 101,
              runNumber: 11,
              runAttempt: 1,
            },
            comparison: {
              status: 'identical',
              baseSha: mainCommitSha,
              headSha: mainCommitSha,
              mergeBaseSha: mainCommitSha,
              aheadBy: 0,
              totalCommits: 0,
              commits: [],
              truncated: false,
            },
          }),
        }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'noop', code: 'retry-already-published' })

    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: retrySnapshot({ retryInProgress: true }),
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({ status: 'noop', code: 'retry-in-progress' })
  })

  test('counts a successful workflow-dispatch image run as the latest publication', () => {
    expect(
      resolveLastPublishedRevision([
        successfulPublishRun(),
        successfulPublishRun({
          id: 102,
          runNumber: 11,
          headSha: mainCommitSha,
          event: 'workflow_dispatch',
        }),
      ]),
    ).toMatchObject({ status: 'resolved', revision: mainCommitSha, runId: 102 })
  })

  test('workflow uses trusted default-branch discovery and a separately rebound main dispatch', async () => {
    const workflow = await Bun.file('.github/workflows/bayn-build-push.yml').text()
    expect(workflow).toContain('issue_comment:')
    expect(workflow).toContain("cron: '*/10 * * * *'")
    expect(workflow).toContain('Checkout trusted default-branch verifier')
    expect(workflow).toContain('--mode retry-discovery')
    expect(workflow).toContain('chatgpt-codex-connector[bot]')
    expect(workflow).toContain('actions/workflows/bayn-build-push.yml/dispatches')
    expect(workflow).toContain('-f ref=main')
    expect(workflow).toContain('--mode retry-publication')
    expect(workflow).toContain('source_revision: ${{ needs.release-review-eligibility.outputs.source_sha }}')
    expect(workflow).toContain('publish_on_dispatch: true')
    expect(workflow).not.toContain('permissions:\n  actions: write')
  })

  test('parses only exact unresolved-thread failure evidence from the bounded gate log', () => {
    expect(
      parseFailedReviewThreadBlock(
        `2026-07-30T07:02:30Z BAYN_RELEASE_REVIEW_HOLD active-unresolved-review-threads: Bayn-affecting commit ${mainCommitSha.slice(0, 12)} after last published ${lastPublishedSha.slice(0, 12)} is not release-eligible: source PR #13401 has 1 unresolved review thread(s): https://github.com/proompteng/lab/pull/13401#discussion_r1\n`,
      ),
    ).toEqual({ commitShaPrefix: mainCommitSha.slice(0, 12), prNumber: 13401 })
    expect(
      parseFailedReviewThreadBlock(
        `2026-07-30T07:02:30Z BAYN_RELEASE_REVIEW_HOLD feedback-fix-attestation-missing: Bayn-affecting commit ${mainCommitSha.slice(0, 12)} after last published ${lastPublishedSha.slice(0, 12)} is not release-eligible: source PR #13401 final head ${finalHeadSha.slice(0, 12)} carries review from ${olderHeadSha.slice(0, 12)}, but post-review commit ${finalHeadSha.slice(0, 12)} lacks a trusted member reply on a resolved Codex thread from that review\n`,
      ),
    ).toEqual({ commitShaPrefix: mainCommitSha.slice(0, 12), prNumber: 13401 })
    expect(
      parseFailedReviewThreadBlock(
        `BAYN_RELEASE_REVIEW_HOLD active-unresolved-review-threads: source PR #13401 has unresolved threads\n`,
      ),
    ).toBeNull()
    expect(() =>
      parseFailedReviewThreadBlock(
        `BAYN_RELEASE_REVIEW_HOLD active-unresolved-review-threads: Bayn-affecting commit ${mainCommitSha.slice(0, 12)} after last published ${lastPublishedSha.slice(0, 12)} is not release-eligible: source PR #13401 has 1 unresolved review thread(s): one\nBAYN_RELEASE_REVIEW_HOLD active-unresolved-review-threads: Bayn-affecting commit ${heldCommitSha.slice(0, 12)} after last published ${lastPublishedSha.slice(0, 12)} is not release-eligible: source PR #13402 has 1 unresolved review thread(s): two\n`,
      ),
    ).toThrow('github-api-invalid-response')
  })

  test('keeps timestamp-based retries available when failed job logs expired', async () => {
    for (const status of [404, 410]) {
      const reviewThreadBlock = await loadOptionalFailedReviewThreadBlock(() =>
        Promise.reject(
          new GitHubReleaseReviewError('github-api-error', 'read failed Bayn review-gate job log', { status }),
        ),
      )
      expect(reviewThreadBlock).toBeNull()
      expect(
        evaluateBaynReleaseRetry({
          mainCommitSha,
          baseRefName: 'main',
          snapshot: retrySnapshot({ reviewThreadBlock }),
          trigger: { type: 'schedule' },
          nowMs: retryNowMs,
        }),
      ).toMatchObject({ status: 'dispatch', sourceCommitSha: mainCommitSha })
    }

    await expect(
      loadOptionalFailedReviewThreadBlock(() =>
        Promise.reject(
          new GitHubReleaseReviewError('github-api-error', 'read failed Bayn review-gate job log', { status: 503 }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'github-api-error', status: 503 })
  })

  test('decodes a bounded failed push and delayed clean reaction for retry discovery', async () => {
    let redirectedLogAuthorization: string | null = 'not-requested'
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/actions/workflows/') && url.includes('status=success')) {
        if (url.includes('event=workflow_dispatch')) return Response.json({ workflow_runs: [] })
        return Response.json({
          workflow_runs: [
            {
              id: 100,
              run_number: 10,
              run_attempt: 1,
              head_sha: lastPublishedSha,
              head_branch: 'main',
              event: 'push',
              status: 'completed',
              conclusion: 'success',
            },
            {
              id: 101,
              run_number: 11,
              run_attempt: 1,
              head_sha: mainCommitSha,
              head_branch: 'main',
              event: 'schedule',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        })
      }
      if (url.includes('/actions/workflows/')) {
        if (url.includes('event=workflow_dispatch')) return Response.json({ workflow_runs: [] })
        return Response.json({
          workflow_runs: [
            {
              id: 30540000001,
              run_number: 900,
              run_attempt: 1,
              head_sha: mainCommitSha,
              head_branch: 'main',
              event: 'push',
              status: 'completed',
              conclusion: 'failure',
              created_at: '2026-07-30T07:00:05Z',
              updated_at: '2026-07-30T07:02:30Z',
            },
          ],
        })
      }
      if (url.includes('/actions/runs/30540000001/jobs?')) {
        return Response.json({
          jobs: [
            {
              id: 90860000001,
              name: 'Verify exact-head Codex review',
              status: 'completed',
              conclusion: 'failure',
              completed_at: '2026-07-30T07:02:30Z',
            },
            {
              id: 90860000002,
              name: 'image',
              status: 'completed',
              conclusion: 'skipped',
              completed_at: '2026-07-30T07:02:31Z',
            },
          ],
        })
      }
      if (url.includes('/actions/jobs/90860000001/logs')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://productionresultssa17.blob.core.windows.net/actions-results/test/job-logs.txt',
          },
        })
      }
      if (url === 'https://productionresultssa17.blob.core.windows.net/actions-results/test/job-logs.txt') {
        redirectedLogAuthorization = new Headers(init?.headers).get('authorization')
        return new Response(
          'BAYN_RELEASE_REVIEW_HOLD exact-head-review-missing: source PR final head lacks review evidence\n',
        )
      }
      if (url.includes('/compare/')) {
        return Response.json({
          status: 'ahead',
          ahead_by: 1,
          total_commits: 1,
          base_commit: { sha: lastPublishedSha },
          merge_base_commit: { sha: lastPublishedSha },
          commits: [{ sha: mainCommitSha }],
        })
      }
      if (url.includes('/commits/main?')) {
        return Response.json({ sha: mainCommitSha })
      }
      if (url.includes(`/commits/${mainCommitSha}/pulls?`)) {
        return Response.json([
          {
            number: 13401,
            base: { ref: 'main' },
            head: { sha: finalHeadSha },
            merge_commit_sha: mainCommitSha,
            merged_at: '2026-07-30T07:00:00Z',
          },
        ])
      }
      if (url.includes(`/commits/${mainCommitSha}?`)) {
        return Response.json({
          sha: mainCommitSha,
          parents: [{ sha: lastPublishedSha }],
          files: [{ filename: 'packages/scripts/src/bayn/verify-release-review.ts' }],
        })
      }
      if (url.includes('/issues/13401/comments?')) return Response.json([])
      if (url.includes('/issues/13401/reactions?')) {
        return Response.json([
          {
            user: { login: baynCodexBotLogin },
            content: '+1',
            created_at: '2026-07-30T07:03:00Z',
          },
        ])
      }

      const request = JSON.parse(String(init?.body)) as { readonly query: string }
      if (request.query.includes('BaynReleasePullRequestMetadata')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                number: 13401,
                baseRefName: 'main',
                headRefOid: finalHeadSha,
                createdAt: '2026-07-30T06:59:00Z',
                mergedAt: '2026-07-30T07:00:00Z',
                mergeCommit: { oid: mainCommitSha },
                timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestReviews')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestThreads')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestCommits')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [{ commit: { oid: finalHeadSha } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      throw new Error(`unexpected retry fixture request: ${url}`)
    }) as typeof fetch

    const loaded = await createGitHubReleaseRetryLoader({
      repository: 'proompteng/lab',
      token: 'fixture-token',
      mainCommitSha,
      baseRefName: 'main',
      requestTimeoutMs: 1_000,
      fetchFn,
    })()
    expect(
      evaluateBaynReleaseRetry({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: loaded,
        trigger: { type: 'schedule' },
        nowMs: retryNowMs,
      }),
    ).toMatchObject({
      status: 'dispatch',
      sourceCommitSha: mainCommitSha,
      prNumber: 13401,
      failedRunId: 30540000001,
    })
    expect(redirectedLogAuthorization).toBeNull()
  })
})

describe('Bayn exact-head release review eligibility', () => {
  test('accepts a clean exact-head Codex review with only resolved threads', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({ threads: [thread()] }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toEqual({
      status: 'eligible',
      prNumber: 13390,
      headSha: finalHeadSha,
      reviewSubmittedAt: '2026-07-30T07:01:00Z',
      eligibleAt: '2026-07-30T07:01:30.000Z',
    })
  })

  test('holds when Codex reviewed only an older head', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({ reviews: [review({ commitSha: olderHeadSha })] }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-missing',
      retryable: true,
    })
  })

  test('accepts the #13394 clean connector issue-comment attestation for the exact final head', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [review({ commitSha: olderHeadSha })],
          issueComments: [issueComment()],
          headForcePushCount: 6,
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toEqual({
      status: 'eligible',
      prNumber: 13390,
      headSha: finalHeadSha,
      reviewSubmittedAt: '2026-07-30T07:01:00Z',
      eligibleAt: '2026-07-30T07:01:30.000Z',
    })
  })

  test('accepts the #13397 clean connector PR reaction only for an immutable single-head history', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({ reviews: [], reactions: [reaction()] }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toEqual({
      status: 'eligible',
      prNumber: 13390,
      headSha: finalHeadSha,
      reviewSubmittedAt: '2026-07-30T07:01:00Z',
      eligibleAt: '2026-07-30T07:01:30.000Z',
    })
  })

  test('rejects a clean-shaped PR reaction from a spoofed actor', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({ reviews: [], reactions: [reaction({ userLogin: 'spoofed-codex[bot]' })] }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-missing',
      retryable: true,
    })
  })

  test('rejects a clean connector comment bound to a stale head', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [],
          issueComments: [
            issueComment({
              body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${olderHeadSha.slice(0, 10)}\`\n`,
            }),
          ],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-missing',
      retryable: true,
    })
  })

  test('keeps an actionable exact-head review blocking a clean reaction', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [review({ state: 'CHANGES_REQUESTED' })],
          reactions: [reaction()],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-changes-requested',
      retryable: false,
    })
  })

  test('keeps an unresolved thread blocking a clean exact-head attestation', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [],
          reactions: [reaction()],
          threads: [thread({ isResolved: false })],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'active-unresolved-review-threads',
      retryable: false,
    })
  })

  test('carries a reviewed head across an auditable feedback-fix commit', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          commitShas: [olderHeadSha, finalHeadSha],
          reviews: [review({ commitSha: olderHeadSha })],
          threads: [
            thread({
              comments: [
                threadComment(),
                threadComment({
                  authorLogin: 'gregkonush',
                  authorAssociation: 'MEMBER',
                  body: 'Fixed in final head.',
                  createdAt: '2026-07-30T07:01:30Z',
                  reviewCommitSha: finalHeadSha,
                  reviewAuthorLogin: 'gregkonush',
                  reviewSubmittedAt: '2026-07-30T07:01:30Z',
                }),
              ],
            }),
          ],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toEqual({
      status: 'eligible',
      prNumber: 13390,
      headSha: finalHeadSha,
      reviewSubmittedAt: '2026-07-30T07:01:00Z',
      eligibleAt: '2026-07-30T07:01:30.000Z',
    })
  })

  test('retries a stale feedback-attestation read and then accepts the indexed reply', async () => {
    let calls = 0
    const sleeps: number[] = []
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 2,
      pollIntervalMs: 10_000,
      loadSnapshot: async () => {
        calls += 1
        return snapshot({
          commitShas: [olderHeadSha, finalHeadSha],
          reviews: [review({ commitSha: olderHeadSha })],
          threads: [
            thread({
              comments: [
                threadComment(),
                ...(calls === 1
                  ? []
                  : [
                      threadComment({
                        authorLogin: 'gregkonush',
                        authorAssociation: 'MEMBER',
                        reviewCommitSha: finalHeadSha,
                        reviewAuthorLogin: 'gregkonush',
                        reviewSubmittedAt: '2026-07-30T07:01:30Z',
                      }),
                    ]),
              ],
            }),
          ],
        })
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
      now: () => evaluationNowMs,
    })

    expect(result).toMatchObject({ status: 'eligible', attempts: 2, timedOut: false })
    expect(sleeps).toEqual([10_000])
  })

  test('rejects an unreviewed post-review commit without a trusted feedback attestation', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          commitShas: [olderHeadSha, finalHeadSha],
          reviews: [review({ commitSha: olderHeadSha })],
          threads: [thread({ comments: [threadComment()] })],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'feedback-fix-attestation-missing',
      retryable: true,
    })
  })

  test('rejects a feedback reply from an untrusted association', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          commitShas: [olderHeadSha, finalHeadSha],
          reviews: [review({ commitSha: olderHeadSha })],
          threads: [
            thread({
              comments: [
                threadComment(),
                threadComment({
                  authorLogin: 'external-user',
                  authorAssociation: 'NONE',
                  reviewCommitSha: finalHeadSha,
                  reviewAuthorLogin: 'external-user',
                  reviewSubmittedAt: '2026-07-30T07:01:30Z',
                }),
              ],
            }),
          ],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'feedback-fix-attestation-missing',
      retryable: true,
    })
  })

  test('requires an attestation for every commit after the reviewed head', () => {
    const intermediateFixSha = '4'.repeat(40)
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          commitShas: [olderHeadSha, intermediateFixSha, finalHeadSha],
          reviews: [review({ commitSha: olderHeadSha })],
          threads: [
            thread({
              comments: [
                threadComment(),
                threadComment({
                  authorLogin: 'gregkonush',
                  authorAssociation: 'MEMBER',
                  reviewCommitSha: finalHeadSha,
                  reviewAuthorLogin: 'gregkonush',
                  reviewSubmittedAt: '2026-07-30T07:01:30Z',
                }),
              ],
            }),
          ],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'feedback-fix-attestation-missing',
      retryable: true,
    })
  })

  test('holds a pending exact-head review until it is submitted', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({ reviews: [review({ submittedAt: null, state: 'PENDING' })] }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-pending',
      retryable: true,
    })
  })

  test('keeps a pending exact-head review blocking an older submitted review', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [review(), review({ submittedAt: null, state: 'PENDING' })],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-pending',
      retryable: true,
    })
  })

  test('rejects a latest exact-head changes-requested review', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [review(), review({ submittedAt: '2026-07-30T07:01:30Z', state: 'CHANGES_REQUESTED' })],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-changes-requested',
      retryable: false,
    })
  })

  test('holds a newly submitted exact-head review until thread indexing settles', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot(),
        nowMs: Date.parse('2026-07-30T07:01:05Z'),
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-settling',
      retryable: true,
    })
  })

  test('settles against the newest review when the exact head was reviewed more than once', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({
          reviews: [review(), review({ submittedAt: '2026-07-30T07:01:55Z' })],
        }),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'exact-head-review-settling',
      retryable: true,
    })
  })

  test('holds when a main push contains more than the one reviewed merge commit', () => {
    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: snapshot({ mainCommitParents: ['e'.repeat(40)] }),
        nowMs: evaluationNowMs,
        pushBeforeSha,
      }),
    ).toMatchObject({
      status: 'hold',
      code: 'non-single-commit-main-push',
      retryable: false,
    })
  })

  test('polls through a delayed exact-head review and then passes', async () => {
    let calls = 0
    const sleeps: number[] = []
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 4,
      pollIntervalMs: 10_000,
      loadSnapshot: async () => {
        calls += 1
        return calls < 3 ? snapshot({ reviews: [review({ commitSha: olderHeadSha })] }) : snapshot()
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    })

    expect(result).toMatchObject({ status: 'eligible', attempts: 3, timedOut: false })
    expect(sleeps).toEqual([10_000, 10_000])
  })

  test('holds immediately when an active unresolved review thread exists', async () => {
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 13,
      pollIntervalMs: 10_000,
      loadSnapshot: async () => snapshot({ threads: [thread({ isResolved: false })] }),
      sleep: async () => {
        throw new Error('terminal unresolved-thread state must not sleep')
      },
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'active-unresolved-review-threads',
      attempts: 1,
      timedOut: false,
    })
  })

  test('keeps an outdated unresolved review thread blocking publication', async () => {
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 10,
      pollIntervalMs: 10_000,
      loadSnapshot: async () => snapshot({ threads: [thread({ isResolved: false, isOutdated: true })] }),
      sleep: async () => {
        throw new Error('outdated unresolved-thread state must not sleep')
      },
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'active-unresolved-review-threads',
      attempts: 1,
      timedOut: false,
    })
  })

  test('fails closed after bounded GitHub API failures without exposing response content', async () => {
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 2,
      pollIntervalMs: 1,
      loadSnapshot: async () => {
        throw new GitHubReleaseReviewError('github-api-error', 'read source PR reviews', { status: 502 })
      },
      sleep: async () => {},
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'github-api-error',
      attempts: 2,
      timedOut: true,
    })
    const held = requireHold(result)
    expect(held.message).toContain('HTTP 502')
    expect(held.message).not.toContain('token')
  })

  test('fails closed after bounded GitHub API request timeouts', async () => {
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 2,
      pollIntervalMs: 1,
      loadSnapshot: async () => {
        throw new GitHubReleaseReviewError('github-api-timeout', 'read source PR review threads')
      },
      sleep: async () => {},
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'github-api-timeout',
      attempts: 2,
      timedOut: true,
    })
  })

  test('holds an ambiguous association without selecting a source PR', async () => {
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 13,
      pollIntervalMs: 10_000,
      loadSnapshot: async () =>
        snapshot({
          associated: [associatedPull(), associatedPull({ number: 13391, headSha: 'd'.repeat(40) })],
        }),
      sleep: async () => {
        throw new Error('ambiguous association must not sleep')
      },
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'ambiguous-associated-source-prs',
      attempts: 1,
      timedOut: false,
    })
  })

  test('holds a historical #13370-shaped 47-second race before image publication', async () => {
    let elapsedMs = 0
    let calls = 0
    const historicalThread = (id: string): PullRequestReviewThread =>
      thread({
        id,
        isResolved: false,
        url: `https://github.com/proompteng/lab/pull/13370#discussion_${id}`,
      })
    const historicalAssociated = associatedPull({
      number: 13370,
      headSha: 'fcaf948b6d156df8697822e06ec5defac8307076',
      mergeCommitSha: 'd7f4a26e853e60db0aabf2969f2772fcc637b52a',
      mergedAt: '2026-07-30T02:00:00Z',
    })
    const historicalMain = historicalAssociated.mergeCommitSha as string
    const historicalHead = historicalAssociated.headSha

    const result = await pollBaynReleaseReview({
      mainCommitSha: historicalMain,
      baseRefName: 'main',
      maxAttempts: 13,
      pollIntervalMs: 10_000,
      loadSnapshot: async () => {
        calls += 1
        return snapshot({
          associated: [historicalAssociated],
          reviews:
            elapsedMs < 47_000
              ? [review({ commitSha: olderHeadSha, submittedAt: '2026-07-30T01:39:33Z' })]
              : [review({ commitSha: historicalHead, submittedAt: '2026-07-30T02:00:47Z' })],
          threads: elapsedMs < 47_000 ? [] : [historicalThread('r3679370798'), historicalThread('r3679370800')],
        })
      },
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds
      },
      now: () => Date.parse('2026-07-30T02:00:00Z') + elapsedMs,
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'active-unresolved-review-threads',
      attempts: 9,
      timedOut: false,
    })
    expect(elapsedMs).toBe(80_000)
    expect(calls).toBe(9)
  })

  test('holds a missing associated PR after the bounded wait expires', async () => {
    const result = await pollBaynReleaseReview({
      mainCommitSha,
      baseRefName: 'main',
      maxAttempts: 3,
      pollIntervalMs: 1,
      loadSnapshot: async () => ({ mainCommitParents: [pushBeforeSha], associatedPullRequests: [], pullRequest: null }),
      sleep: async () => {},
    })

    expect(result).toMatchObject({
      status: 'hold',
      code: 'no-associated-source-pr',
      attempts: 3,
      timedOut: true,
    })
    expect(requireHold(result).message).toContain('bounded wait exhausted')
  })

  test('decodes a complete deterministic GitHub API fixture', async () => {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/commits/')) {
        if (!url.includes('/pulls?')) {
          return Response.json({
            sha: mainCommitSha,
            parents: [{ sha: pushBeforeSha }],
            files: [{ filename: 'services/bayn/src/example.ts' }],
          })
        }
        return Response.json([
          {
            number: 13390,
            base: { ref: 'main' },
            head: { sha: finalHeadSha },
            merge_commit_sha: mainCommitSha,
            merged_at: '2026-07-30T07:01:30Z',
          },
        ])
      }
      if (url.includes('/issues/13390/comments?') || url.includes('/issues/13390/reactions?')) {
        return Response.json([])
      }

      const request = JSON.parse(String(init?.body)) as { readonly query: string }
      if (request.query.includes('BaynReleasePullRequestMetadata')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                number: 13390,
                baseRefName: 'main',
                headRefOid: finalHeadSha,
                createdAt: '2026-07-30T06:59:00Z',
                mergedAt: '2026-07-30T07:01:30Z',
                mergeCommit: { oid: mainCommitSha },
                timelineItems: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestReviews')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      author: { login: baynCodexReviewer },
                      commit: { oid: finalHeadSha },
                      submittedAt: '2026-07-30T07:01:00Z',
                      state: 'COMMENTED',
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestThreads')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (request.query.includes('BaynReleasePullRequestCommits')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [{ commit: { oid: finalHeadSha } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      throw new Error('unexpected fixture request')
    }) as typeof fetch

    const loader = createGitHubReleaseReviewLoader({
      repository: 'proompteng/lab',
      token: 'fixture-token',
      mainCommitSha,
      baseRefName: 'main',
      requestTimeoutMs: 1_000,
      fetchFn,
    })

    expect(
      evaluateBaynReleaseReview({
        mainCommitSha,
        baseRefName: 'main',
        snapshot: await loader(),
        nowMs: evaluationNowMs,
        pushBeforeSha: null,
      }),
    ).toMatchObject({ status: 'eligible', prNumber: 13390, headSha: finalHeadSha })
  })
})
