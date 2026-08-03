import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  baynReleaseGateName,
  baynImagePublishJobName,
  evaluateBaynPublication,
  isBaynReleaseAffectingPath,
  mergePullRequestEvidencePage,
  migrationCheckpointPath,
  selectExactHeadReviewEvidence,
  selectLatestSuccessfulPublishRun,
  selectTrustedBaynGateRun,
  type BaynWorkflowJob,
  type BaynWorkflowRun,
  type MainCommitEvidence,
  type MigrationCheckpoint,
  type PullRequestEvidenceAccumulator,
  type PullRequestReviewState,
  type SourcePullRequestEvidence,
} from './verify-release-review'

const sha = (character: string): string => character.repeat(40)
const baynCiWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-ci.yml', import.meta.url), 'utf8')

const baseline: MigrationCheckpoint = {
  schemaVersion: 'bayn.release-review-baseline.v1',
  repository: 'proompteng/lab',
  startCommitSha: 'b0b66eac86bbd7fc28df8025b796ec5221b92906',
  endCommitSha: '8cfdab1bafb0a2f2650c9e0340a3157b75cfb648',
  sourcePullRequestNumber: 13488,
  sourcePullRequestHeadSha: '63ff05092123b9f0372a5a94a7d54bdfa06c5ddc',
  sourcePullRequestMergeCommitSha: '8cfdab1bafb0a2f2650c9e0340a3157b75cfb648',
  sourceGateRunId: 30_773_173_470,
  sourceGateWorkflowPath: '.github/workflows/bayn-ci.yml',
  sourceGateName: baynReleaseGateName,
}

const reviewPullRequest = (overrides: Partial<PullRequestReviewState> = {}): PullRequestReviewState => ({
  number: 13_499,
  baseRefName: 'main',
  baseSha: sha('b'),
  headBranch: 'codex/exact-head',
  headSha: sha('a'),
  mergeCommitSha: null,
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:30Z',
  mergedAt: null,
  headCommittedAt: '2026-08-03T00:00:30Z',
  reviews: [
    {
      authorLogin: 'chatgpt-codex-connector[bot]',
      commitSha: sha('a'),
      submittedAt: '2026-08-03T00:01:00Z',
      state: 'COMMENTED',
    },
  ],
  threads: [
    {
      id: 'thread-1',
      isResolved: true,
      isOutdated: false,
      path: 'services/bayn/src/example.ts',
      url: 'https://github.com/proompteng/lab/pull/13499#discussion_r1',
    },
  ],
  commitShas: [sha('c'), sha('a')],
  reactions: [],
  ...overrides,
})

const gateRun = (overrides: Partial<BaynWorkflowRun> = {}): BaynWorkflowRun => ({
  id: 101,
  workflowPath: '.github/workflows/bayn-ci.yml',
  repository: 'proompteng/lab',
  event: 'pull_request',
  headBranch: 'codex/exact-head',
  headSha: sha('a'),
  displayTitle: `Bayn release gate #13500 base=${sha('d')}`,
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-08-03T00:02:00Z',
  updatedAt: '2026-08-03T00:05:00Z',
  runAttempt: 1,
  ...overrides,
})

const gateJob = (overrides: Partial<BaynWorkflowJob> = {}): BaynWorkflowJob => ({
  id: 201,
  name: baynReleaseGateName,
  status: 'completed',
  conclusion: 'success',
  completedAt: '2026-08-03T00:04:00Z',
  ...overrides,
})

const sourcePullRequest: SourcePullRequestEvidence = {
  number: 13_500,
  repository: 'proompteng/lab',
  baseRefName: 'main',
  baseSha: sha('d'),
  headBranch: 'codex/published',
  headSha: sha('e'),
  mergeCommitSha: sha('f'),
  mergedAt: '2026-08-03T00:10:00Z',
}

const mainCommit = (overrides: Partial<MainCommitEvidence> = {}): MainCommitEvidence => ({
  sha: sha('f'),
  parents: [baseline.endCommitSha],
  files: [{ path: 'services/bayn/src/example.ts', previousPath: null }],
  sourcePullRequest,
  gateRun: {
    run: gateRun({ headSha: sourcePullRequest.headSha, headBranch: sourcePullRequest.headBranch }),
    job: gateJob(),
  },
  ...overrides,
})

describe('Bayn PR-time exact-head release gate', () => {
  test('accepts a trusted Codex review bound to the final head across multiple PR commits', () => {
    expect(
      selectExactHeadReviewEvidence({
        pullRequest: reviewPullRequest({ commitShas: [sha('c'), sha('d'), sha('e'), sha('a')] }),
        expectedNumber: 13_499,
        expectedBaseRefName: 'main',
        expectedHeadSha: sha('a'),
        nowMs: Date.parse('2026-08-03T00:02:00Z'),
      }),
    ).toMatchObject({ status: 'eligible', prNumber: 13_499, headSha: sha('a') })
  })

  test('rejects a review that is only bound to a pre-final head', () => {
    const result = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        reviews: [
          {
            authorLogin: 'chatgpt-codex-connector[bot]',
            commitSha: sha('c'),
            submittedAt: '2026-08-03T00:01:00Z',
            state: 'COMMENTED',
          },
        ],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(result).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('accepts the unique trusted +1 only after the current final-head commit', () => {
    const result = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        reviews: [
          {
            authorLogin: 'chatgpt-codex-connector[bot]',
            commitSha: sha('c'),
            submittedAt: '2026-08-03T00:00:45Z',
            state: 'COMMENTED',
          },
        ],
        reactions: [{ userLogin: 'chatgpt-codex-connector[bot]', content: '+1', createdAt: '2026-08-03T00:01:00Z' }],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(result).toMatchObject({ status: 'eligible', reviewSubmittedAt: '2026-08-03T00:01:00Z' })
  })

  test('rejects stale or ambiguous trusted reactions', () => {
    const stale = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        reviews: [{ ...reviewPullRequest().reviews[0], commitSha: sha('c') }],
        reactions: [{ userLogin: 'chatgpt-codex-connector[bot]', content: '+1', createdAt: '2026-08-03T00:00:30Z' }],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(stale).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })

    const duplicate = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        reviews: [{ ...reviewPullRequest().reviews[0], commitSha: sha('c') }],
        reactions: [
          { userLogin: 'chatgpt-codex-connector[bot]', content: '+1', createdAt: '2026-08-03T00:01:00Z' },
          { userLogin: 'chatgpt-codex-connector[bot]', content: '+1', createdAt: '2026-08-03T00:01:01Z' },
        ],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(duplicate).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })

    const unrelated = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        reviews: [{ ...reviewPullRequest().reviews[0], commitSha: sha('c') }],
        reactions: [
          { userLogin: 'chatgpt-codex-connector[bot]', content: '+1', createdAt: '2026-08-03T00:01:00Z' },
          { userLogin: 'someone-else', content: 'heart', createdAt: '2026-08-03T00:01:01Z' },
        ],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(unrelated).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })

    const forcePushedExistingSha = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        updatedAt: '2026-08-03T00:01:01Z',
        reviews: [{ ...reviewPullRequest().reviews[0], commitSha: sha('c') }],
        reactions: [{ userLogin: 'chatgpt-codex-connector[bot]', content: '+1', createdAt: '2026-08-03T00:01:00Z' }],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(forcePushedExistingSha).toMatchObject({ status: 'hold', code: 'exact-head-review-missing' })
  })

  test('rejects unresolved threads even with exact-head Codex review', () => {
    const result = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({ threads: [{ ...reviewPullRequest().threads[0], isResolved: false }] }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(result).toMatchObject({ status: 'hold', code: 'active-unresolved-review-threads' })
  })

  test('rejects changes-requested reviews and future review timestamps', () => {
    const changesRequested = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({ reviews: [{ ...reviewPullRequest().reviews[0], state: 'CHANGES_REQUESTED' }] }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(changesRequested).toMatchObject({ status: 'hold', code: 'exact-head-review-changes-requested' })

    const future = selectExactHeadReviewEvidence({
      pullRequest: reviewPullRequest({
        reviews: [{ ...reviewPullRequest().reviews[0], submittedAt: '2026-08-03T00:03:00Z' }],
      }),
      expectedNumber: 13_499,
      expectedBaseRefName: 'main',
      expectedHeadSha: sha('a'),
      nowMs: Date.parse('2026-08-03T00:02:00Z'),
    })
    expect(future).toMatchObject({ status: 'hold', code: 'source-pr-metadata-mismatch' })
  })
})

test('does not append a completed GraphQL connection while another connection paginates', () => {
  const initial: PullRequestEvidenceAccumulator = {
    commits: [],
    headCommittedAt: null,
    reviews: [],
    threads: [],
    commitsComplete: false,
    reviewsComplete: false,
    threadsComplete: false,
  }
  const firstPage = mergePullRequestEvidencePage(initial, {
    metadata: reviewPullRequest(),
    commits: [sha('c')],
    headCommittedAt: '2026-08-03T00:00:30Z',
    reviews: [],
    threads: [],
    commitPageInfo: { hasNextPage: false, endCursor: null },
    reviewPageInfo: { hasNextPage: true, endCursor: 'review-1' },
    threadPageInfo: { hasNextPage: false, endCursor: null },
  })
  const secondPage = mergePullRequestEvidencePage(firstPage, {
    metadata: reviewPullRequest(),
    commits: [sha('c')],
    headCommittedAt: '2026-08-03T00:00:30Z',
    reviews: [reviewPullRequest().reviews[0]],
    threads: [],
    commitPageInfo: { hasNextPage: false, endCursor: null },
    reviewPageInfo: { hasNextPage: false, endCursor: null },
    threadPageInfo: { hasNextPage: false, endCursor: null },
  })
  expect(secondPage.commits).toEqual([sha('c')])
  expect(secondPage.reviews).toHaveLength(1)
  expect(secondPage.commitsComplete).toBe(true)
  expect(secondPage.reviewsComplete).toBe(true)
})

describe('Bayn post-merge gate receipt selection', () => {
  test('accepts only the trusted bayn-ci pull-request gate before merge', () => {
    const selected = selectTrustedBaynGateRun({
      runs: [gateRun({ headSha: sourcePullRequest.headSha, headBranch: sourcePullRequest.headBranch })],
      jobsByRunId: new Map([[101, [gateJob()]]]),
      repository: 'proompteng/lab',
      pullRequestNumber: sourcePullRequest.number,
      pullRequestBaseSha: sourcePullRequest.baseSha,
      pullRequestHeadSha: sourcePullRequest.headSha,
      pullRequestHeadBranch: sourcePullRequest.headBranch,
      mergedAt: sourcePullRequest.mergedAt as string,
    })
    expect(selected).toMatchObject({ run: { id: 101 }, job: { name: baynReleaseGateName, conclusion: 'success' } })
  })

  test('rejects missing, failed, later, and spoofed gate checks', () => {
    const input = {
      jobsByRunId: new Map([[101, [gateJob()]]]),
      repository: 'proompteng/lab',
      pullRequestNumber: sourcePullRequest.number,
      pullRequestBaseSha: sourcePullRequest.baseSha,
      pullRequestHeadSha: sourcePullRequest.headSha,
      pullRequestHeadBranch: sourcePullRequest.headBranch,
      mergedAt: sourcePullRequest.mergedAt as string,
    }
    expect(selectTrustedBaynGateRun({ ...input, runs: [] })).toBeUndefined()
    expect(
      selectTrustedBaynGateRun({
        ...input,
        runs: [gateRun({ conclusion: 'failure' })],
      }),
    ).toBeUndefined()
    expect(
      selectTrustedBaynGateRun({
        ...input,
        runs: [gateRun({ createdAt: '2026-08-03T00:11:00Z' })],
      }),
    ).toBeUndefined()
    expect(
      selectTrustedBaynGateRun({
        ...input,
        runs: [gateRun({ workflowPath: '.github/workflows/untrusted.yml' })],
      }),
    ).toBeUndefined()
    for (const spoofedRun of [
      gateRun({ repository: 'proompteng/other' }),
      gateRun({ event: 'workflow_run' }),
      gateRun({ headSha: sha('9') }),
      gateRun({ headBranch: 'main' }),
      gateRun({ displayTitle: 'bayn' }),
    ]) {
      expect(selectTrustedBaynGateRun({ ...input, runs: [spoofedRun] })).toBeUndefined()
    }
  })

  test('does not treat a later failed rerun as a successful receipt', () => {
    const laterFailed = gateRun({ id: 102, createdAt: '2026-08-03T00:06:00Z', conclusion: 'failure' })
    expect(
      selectTrustedBaynGateRun({
        runs: [gateRun(), laterFailed],
        jobsByRunId: new Map([
          [101, [gateJob()]],
          [102, [gateJob({ id: 202, conclusion: 'failure' })]],
        ]),
        repository: 'proompteng/lab',
        pullRequestNumber: sourcePullRequest.number,
        pullRequestBaseSha: sourcePullRequest.baseSha,
        pullRequestHeadSha: sourcePullRequest.headSha,
        pullRequestHeadBranch: sourcePullRequest.headBranch,
        mergedAt: sourcePullRequest.mergedAt as string,
      }),
    ).toBeUndefined()
  })
})

describe('Bayn publication boundary', () => {
  test('accepts a new commit after the exact migration checkpoint only with its gate receipt', () => {
    const result = evaluateBaynPublication({
      mainCommitSha: sha('f'),
      pushBeforeSha: baseline.endCommitSha,
      publishedRevision: baseline.startCommitSha,
      commits: [
        {
          sha: baseline.endCommitSha,
          parents: [baseline.startCommitSha],
          files: [{ path: 'services/bayn/src/old.ts', previousPath: null }],
          sourcePullRequest: null,
          gateRun: null,
        },
        mainCommit(),
      ],
      migrationCheckpoint: baseline,
      repository: 'proompteng/lab',
    })
    expect(result).toMatchObject({ status: 'eligible', sourceSha: sha('f'), baynAffectingCommitCount: 2 })
  })

  test('holds a post-checkpoint Bayn commit with no successful required gate', () => {
    const result = evaluateBaynPublication({
      mainCommitSha: sha('f'),
      pushBeforeSha: baseline.endCommitSha,
      publishedRevision: baseline.startCommitSha,
      commits: [
        {
          sha: baseline.endCommitSha,
          parents: [baseline.startCommitSha],
          files: [{ path: 'services/bayn/src/old.ts', previousPath: null }],
          sourcePullRequest: null,
          gateRun: null,
        },
        mainCommit({ gateRun: null }),
      ],
      migrationCheckpoint: baseline,
      repository: 'proompteng/lab',
    })
    expect(result).toMatchObject({ status: 'hold', code: 'bayn-release-gate-missing' })
  })

  test('does not let a mutable or misplaced checkpoint authorize descendants', () => {
    const result = evaluateBaynPublication({
      mainCommitSha: sha('f'),
      pushBeforeSha: baseline.endCommitSha,
      publishedRevision: baseline.startCommitSha,
      commits: [mainCommit()],
      migrationCheckpoint: { ...baseline, endCommitSha: sha('9') },
      repository: 'proompteng/lab',
    })
    expect(result).toMatchObject({ status: 'hold', code: 'migration-checkpoint-invalid' })
  })

  test('requires the current main push to be one directly parented commit', () => {
    const result = evaluateBaynPublication({
      mainCommitSha: sha('f'),
      pushBeforeSha: sha('0'),
      publishedRevision: baseline.startCommitSha,
      commits: [mainCommit()],
      migrationCheckpoint: baseline,
      repository: 'proompteng/lab',
    })
    expect(result).toMatchObject({ status: 'hold', code: 'non-single-commit-main-push' })
  })
})

describe('Bayn image publication identity', () => {
  const run = (overrides: Partial<BaynWorkflowRun> = {}): BaynWorkflowRun => ({
    id: 301,
    workflowPath: '.github/workflows/bayn-build-push.yml',
    repository: 'proompteng/lab',
    event: 'push',
    headBranch: 'main',
    headSha: sha('1'),
    displayTitle: 'bayn-build-push',
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:05:00Z',
    runAttempt: 1,
    ...overrides,
  })
  const job = (name: string, conclusion: string | null): BaynWorkflowJob => ({
    id: 401,
    name,
    status: 'completed',
    conclusion,
    completedAt: '2026-08-03T00:04:00Z',
  })

  test('uses an actual successful image job as the publication boundary', () => {
    const result = selectLatestSuccessfulPublishRun({
      runs: [run({ id: 302, headSha: sha('2') }), run()],
      jobsByRunId: new Map([
        [302, [job(baynImagePublishJobName, 'skipped')]],
        [301, [job(baynImagePublishJobName, 'success')]],
      ]),
    })
    expect(result).toMatchObject({ id: 301, headSha: sha('1') })
  })

  test('treats a successful workflow with no image as unpublished', () => {
    expect(
      selectLatestSuccessfulPublishRun({
        runs: [run()],
        jobsByRunId: new Map([[301, [job(baynImagePublishJobName, 'skipped')]]]),
      }),
    ).toBeUndefined()
  })
})

test('classifies the verifier baseline receipt as Bayn-affecting', () => {
  expect(isBaynReleaseAffectingPath(migrationCheckpointPath)).toBe(true)
})

test('executes the release gate from the trusted base while evaluating the exact PR head', () => {
  expect(baynCiWorkflow).toContain(
    "run-name: 'Bayn release gate #${{ github.event.pull_request.number }} base=${{ github.event.pull_request.base.sha }}'",
  )
  expect(baynCiWorkflow).toContain('name: Checkout trusted base verifier')
  expect(baynCiWorkflow).toContain('ref: ${{ github.event.pull_request.base.sha }}')
  expect(baynCiWorkflow).not.toContain('name: Checkout exact reviewed PR head')
  expect(baynCiWorkflow).not.toContain('ref: ${{ github.event.pull_request.head.sha }}')
  expect(baynCiWorkflow).toContain("github.event.pull_request.base.sha != '8cfdab1bafb0a2f2650c9e0340a3157b75cfb648'")
  expect(baynCiWorkflow).toContain('--commit "${PR_HEAD}"')
  expect(baynCiWorkflow).toContain('--pull-request-number "${PR_NUMBER}"')
  expect(baynCiWorkflow).toContain('--pull-request-head "${PR_HEAD}"')
})
