import { describe, expect, test } from 'bun:test'

import {
  baynCodexReviewer,
  createGitHubReleaseEligibilityLoader,
  createGitHubReleaseReviewLoader,
  evaluateBaynReleaseEligibility,
  evaluateBaynReleaseReview,
  GitHubReleaseReviewError,
  isBaynReleaseAffectingPath,
  pollBaynReleaseEligibility,
  pollBaynReleaseReview,
  resolveLastPublishedRevision,
  type AssociatedPullRequest,
  type BaynReleaseEligibilitySnapshot,
  type BaynReleaseReviewPollResult,
  type BaynReleaseReviewSnapshot,
  type PullRequestReview,
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
  mergedAt: '2026-07-30T07:00:00Z',
  ...overrides,
})

const review = (overrides: Partial<PullRequestReview> = {}): PullRequestReview => ({
  authorLogin: baynCodexReviewer,
  commitSha: finalHeadSha,
  submittedAt: '2026-07-30T07:01:00Z',
  state: 'COMMENTED',
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
  } = {},
): BaynReleaseReviewSnapshot => {
  const associated = options.associated ?? [associatedPull()]
  const source = associated[0]
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
            mergedAt: source.mergedAt,
            reviews: options.reviews ?? [review()],
            threads: options.threads ?? [],
            commitShas: options.commitShas ?? [source.headSha],
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
}): BaynReleaseReviewSnapshot => {
  const associated = associatedPull({
    number: options.prNumber,
    headSha: options.headSha,
    mergeCommitSha: options.commitSha,
  })
  return {
    mainCommitParents: options.parents,
    associatedPullRequests: [associated],
    pullRequest: {
      number: options.prNumber,
      baseRefName: 'main',
      headSha: options.headSha,
      mergeCommitSha: options.commitSha,
      mergedAt: associated.mergedAt,
      reviews: options.reviews ?? [
        review({
          commitSha: options.headSha,
        }),
      ],
      threads: options.threads ?? [],
      commitShas: [options.headSha],
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
            merged_at: '2026-07-30T07:00:00Z',
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

      const request = JSON.parse(String(init?.body)) as { readonly query: string }
      if (request.query.includes('BaynReleasePullRequestMetadata')) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                number: 13390,
                baseRefName: 'main',
                headRefOid: finalHeadSha,
                mergedAt: '2026-07-30T07:00:00Z',
                mergeCommit: { oid: mainCommitSha },
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
            merged_at: '2026-07-30T07:00:00Z',
          },
        ])
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
                mergedAt: '2026-07-30T07:00:00Z',
                mergeCommit: { oid: mainCommitSha },
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
