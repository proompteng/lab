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
  const record = structuredClone(realRemediationRecord) as BaynReleaseReviewRemediationRecord
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
const multiStageHistory = {
  published: '319291bebe22b0c1dc928f13d0ff3655c4b22284',
  promotion: 'bbef7b18804cf9e30c11eac326e90281d1774b80',
  blocked: '9bea355c17fb9320fc692bb214f76af105650a02',
  descendant: 'c778df23b22620fd12764e3bca06d0a58211b0de',
  descendantHead: '944bc86112380f0484b892389b7864e26018bca9',
  remediationHead: '6'.repeat(40),
  remediationMerge: '7'.repeat(40),
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

const captureMultiStageReceiptEvidence = (
  record: BaynReleaseReviewRemediationRecord,
): { readonly sourcePull: PullRequestReviewState; readonly descendantPull: PullRequestReviewState } => {
  if (record.schemaVersion !== 'bayn.release-review-remediation.v2' || record.blocked.reconstruction === undefined) {
    throw new Error('expected a v2 multi-stage remediation record')
  }
  const sourcePull = structuredClone(capturedPr13429ReviewState)
  const descendantPull = structuredClone(capturedPr13434ReviewState)
  if (pullRequestReviewEvidenceSha256(sourcePull) !== record.blocked.sourcePullRequestEvidenceSha256) {
    throw new Error('captured PR #13429 evidence does not match the committed receipt')
  }
  const descendant = record.requiredDescendants[0]
  if (
    descendant === undefined ||
    pullRequestReviewEvidenceSha256(descendantPull) !== descendant.sourcePullRequestEvidenceSha256
  ) {
    throw new Error('captured PR #13434 evidence does not match the committed receipt')
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
  return { sourcePull, descendantPull }
}

const multiStageRemediationFixture = (): {
  readonly snapshot: BaynReleaseEligibilitySnapshot
  readonly evidence: BaynReleaseReviewRemediationEvidence
} => {
  const record = structuredClone(realMultiStageRemediationRecord) as BaynReleaseReviewRemediationRecord
  if (record.schemaVersion !== 'bayn.release-review-remediation.v2' || record.blocked.reconstruction === undefined) {
    throw new Error('expected a v2 multi-stage remediation record')
  }
  const reconstruction = record.blocked.reconstruction
  const { sourcePull, descendantPull } = captureMultiStageReceiptEvidence(record)
  const descendantRecord = record.requiredDescendants[0]
  if (descendantRecord === undefined) throw new Error('expected Candidate 18 descendant evidence')

  const sourceSnapshot: BaynReleaseReviewSnapshot = {
    mainCommitParents: [multiStageHistory.promotion],
    associatedPullRequests: [
      associatedPull({
        number: sourcePull.number,
        headSha: sourcePull.headSha,
        mergeCommitSha: multiStageHistory.blocked,
        mergedAt: sourcePull.mergedAt,
      }),
    ],
    pullRequest: sourcePull,
  }
  const descendantSnapshot: BaynReleaseReviewSnapshot = {
    mainCommitParents: [multiStageHistory.blocked],
    associatedPullRequests: [
      associatedPull({
        number: descendantPull.number,
        headSha: descendantPull.headSha,
        mergeCommitSha: multiStageHistory.descendant,
        mergedAt: descendantPull.mergedAt,
      }),
    ],
    pullRequest: descendantPull,
  }
  const remediationSnapshot = reviewSnapshotFor({
    commitSha: multiStageHistory.remediationMerge,
    prNumber: 13435,
    headSha: multiStageHistory.remediationHead,
    parents: [multiStageHistory.descendant],
    mergedAt: '2026-07-31T16:30:00Z',
  })
  const change = (path: string, blobSha: string, status = 'modified') => ({
    path,
    previousPath: null,
    status,
    blobSha,
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
    reviewSnapshot: sourceSnapshot,
  } as const
  const descendantCommit = {
    sha: multiStageHistory.descendant,
    parents: [multiStageHistory.blocked],
    treeSha: descendantRecord.mergeTreeSha,
    files: descendantRecord.affectedPaths.map((path) => path.path),
    fileChanges: descendantRecord.affectedPaths.map((path) => change(path.path, path.mergeBlobSha)),
    reviewSnapshot: descendantSnapshot,
  } as const
  const introductionCommit = {
    sha: multiStageHistory.remediationMerge,
    parents: [multiStageHistory.descendant],
    treeSha: '3'.repeat(40),
    files: [
      'packages/scripts/src/bayn/verify-release-review.ts',
      'packages/scripts/src/bayn/verify-release-review.test.ts',
      multiStageRemediationRecordPath,
    ],
    fileChanges: [
      change('packages/scripts/src/bayn/verify-release-review.ts', '4'.repeat(40)),
      change('packages/scripts/src/bayn/verify-release-review.test.ts', '5'.repeat(40)),
      change(multiStageRemediationRecordPath, recordBlobSha, 'added'),
    ],
    reviewSnapshot: remediationSnapshot,
  } as const
  const expectedCurrent = new Map(finalHead.affectedPaths.map((path) => [path.path, path.blobSha] as const))
  for (const path of descendantRecord.affectedPaths) {
    if (expectedCurrent.has(path.path)) expectedCurrent.set(path.path, path.mergeBlobSha)
  }
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
      {
        sha: descendantRecord.finalHeadSha,
        parents: ['0'.repeat(40)],
        treeSha: descendantRecord.finalHeadTreeSha,
        files: descendantRecord.affectedPaths.map((path) => path.path),
        fileChanges: [],
        pathBlobs: descendantRecord.affectedPaths.map((path) => ({
          path: path.path,
          blobSha: path.finalHeadBlobSha,
        })),
      },
    ],
    currentPathBlobs: [...expectedCurrent].map(([path, blobSha]) => ({ path, blobSha })),
  }
  return {
    evidence,
    snapshot: {
      currentCommitParents: [multiStageHistory.descendant],
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
        headSha: multiStageHistory.remediationMerge,
        mergeBaseSha: multiStageHistory.published,
        aheadBy: 4,
        totalCommits: 4,
        commits: [promotionCommit, blockedCommit, descendantCommit, introductionCommit],
        truncated: false,
      },
      remediations: [evidence],
    },
  }
}

describe('Bayn publication-range eligibility', () => {
  test('accepts the complete #13429 reconstruction only through its reviewed v2 receipt', () => {
    expect(realMultiStageRemediationRecord).toMatchObject({
      schemaVersion: 'bayn.release-review-remediation.v2',
      blocked: {
        mergeCommitSha: multiStageHistory.blocked,
        sourcePullRequestNumber: 13429,
        finalHeadSha: 'bc32db2e9eeb7140f422fc1b6621427a8f7dabfc',
        reconstruction: { heads: { length: 5 }, forcePushes: { length: 4 }, feedback: { length: 9 } },
      },
      requiredDescendants: [{ mergeCommitSha: multiStageHistory.descendant, sourcePullRequestNumber: 13434 }],
    })
    const captured = captureMultiStageReceiptEvidence(realMultiStageRemediationRecord)
    expect(pullRequestReviewEvidenceSha256(captured.sourcePull)).toBe(
      realMultiStageRemediationRecord.blocked.sourcePullRequestEvidenceSha256,
    )
    expect(pullRequestReviewEvidenceSha256(captured.descendantPull)).toBe(
      realMultiStageRemediationRecord.requiredDescendants[0]?.sourcePullRequestEvidenceSha256,
    )
    const fixture = multiStageRemediationFixture()
    expect(
      evaluateBaynReleaseEligibility({
        mainCommitSha: multiStageHistory.remediationMerge,
        baseRefName: 'main',
        snapshot: fixture.snapshot,
        nowMs: Date.parse('2026-07-31T16:31:00Z'),
        pushBeforeSha: multiStageHistory.descendant,
      }),
    ).toMatchObject({ status: 'eligible', checkedCommitCount: 4, baynAffectingCommitCount: 3 })
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
  ] as const)('rejects v2 remediation with %s', (_name, mutate) => {
    const fixture = multiStageRemediationFixture()
    mutate(fixture)
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.remediationMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T16:31:00Z'),
          pushBeforeSha: multiStageHistory.descendant,
        }),
      ),
    ).toMatchObject({ code: 'release-review-remediation-invalid', retryable: false })
  })

  test('rejects v2 remediation that omits an unrelated newer Bayn source commit', () => {
    const fixture = multiStageRemediationFixture()
    const comparison = fixture.snapshot.comparison
    if (comparison === null) throw new Error('missing comparison')
    const introduction = comparison.commits.at(-1)
    if (introduction === undefined) throw new Error('missing introduction')
    const extraSha = 'd'.repeat(40)
    ;(introduction.parents as string[])[0] = extraSha
    const mutableCommits = comparison.commits as unknown as Array<(typeof comparison.commits)[number]>
    mutableCommits.splice(-1, 0, {
      sha: extraSha,
      parents: [multiStageHistory.descendant],
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
        prNumber: 13436,
        headSha: 'c'.repeat(40),
        parents: [multiStageHistory.descendant],
      }),
    })
    ;(comparison as { aheadBy: number; totalCommits: number }).aheadBy = 5
    ;(comparison as { aheadBy: number; totalCommits: number }).totalCommits = 5
    expect(
      requireEligibilityHold(
        evaluateBaynReleaseEligibility({
          mainCommitSha: multiStageHistory.remediationMerge,
          baseRefName: 'main',
          snapshot: fixture.snapshot,
          nowMs: Date.parse('2026-07-31T16:31:00Z'),
          pushBeforeSha: multiStageHistory.descendant,
        }),
      ),
    ).toMatchObject({ code: 'release-review-remediation-invalid', retryable: false })
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
