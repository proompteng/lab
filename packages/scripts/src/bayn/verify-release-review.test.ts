import { describe, expect, test } from 'bun:test'

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
  parseFailedReviewThreadBlock,
  pollBaynReleaseEligibility,
  pollBaynReleaseReview,
  resolveLastPublishedRevision,
  type AssociatedPullRequest,
  type BaynBuildWorkflowRun,
  type BaynReleaseEligibilitySnapshot,
  type BaynReleaseRetrySnapshot,
  type BaynReleaseReviewPollResult,
  type BaynReleaseReviewSnapshot,
  type PullRequestReview,
  type PullRequestIssueComment,
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
            headForcePushCount: options.headForcePushCount ?? 0,
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
      headForcePushCount: options.headForcePushCount ?? 0,
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
  return {
    ...eligibility,
    defaultBranchSha: options.defaultBranchSha ?? mainCommitSha,
    failedReviewRun:
      run === null
        ? null
        : {
            run,
            jobs: [
              { id: 90860000001, name: 'Verify exact-head Codex review', status: 'completed', conclusion: 'failure' },
              { id: 90860000002, name: 'image', status: 'completed', conclusion: 'skipped' },
            ],
            reviewThreadBlock: options.reviewThreadBlock ?? null,
          },
    publicationSucceeded: false,
    retryInProgress: options.retryInProgress ?? false,
  }
}

describe('Bayn publication-range eligibility', () => {
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
            },
            { id: 90860000002, name: 'image', status: 'completed', conclusion: 'skipped' },
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
