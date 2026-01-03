import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubReviewStore } from '../github-review-store'

const globalState = globalThis as typeof globalThis & {
  __githubReviewConfigMock?: {
    githubToken: string | null
    githubApiBaseUrl: string
    reposAllowed: string[]
    reviewsWriteEnabled: boolean
    mergeWriteEnabled: boolean
    mergeForceEnabled: boolean
    filesBackfillEnabled: boolean
  }
  __githubReviewGithubMock?: {
    submitReview: ReturnType<typeof vi.fn>
    resolveReviewThread: ReturnType<typeof vi.fn>
    getReviewThreadForComment: ReturnType<typeof vi.fn>
    mergePullRequest: ReturnType<typeof vi.fn>
    deleteBranch: ReturnType<typeof vi.fn>
  }
  __githubReviewStoreMock?: GithubReviewStore
}

const buildStore = (): GithubReviewStore => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => ({ inserted: true })),
  upsertPrState: vi.fn(async () => {}),
  upsertReviewState: vi.fn(async () => {}),
  upsertCheckState: vi.fn(async () => ({
    status: 'success',
    detailsUrl: null,
    totalCount: 1,
    successCount: 1,
    failureCount: 0,
    pendingCount: 0,
    runs: [],
  })),
  upsertReviewThread: vi.fn(async () => {}),
  upsertReviewComment: vi.fn(async () => {}),
  upsertIssueComment: vi.fn(async () => {}),
  upsertPrFiles: vi.fn(async () => {}),
  listPulls: vi.fn(async () => ({ items: [], nextCursor: null })),
  getPull: vi.fn(async () => ({
    pull: {
      repository: 'proompteng/lab',
      number: 1,
      title: null,
      body: null,
      state: 'open',
      merged: false,
      mergedAt: null,
      labels: [],
      receivedAt: '2025-01-01T00:00:00Z',
      authorLogin: null,
      authorAvatarUrl: null,
      htmlUrl: null,
      headRef: 'feature',
      headSha: 'abc123',
      baseRef: 'main',
      baseSha: 'def456',
      mergeable: true,
      mergeableState: 'clean',
      draft: false,
      additions: null,
      deletions: null,
      changedFiles: null,
      createdAt: null,
      updatedAt: null,
    },
    review: { decision: 'approved', requestedChanges: false, unresolvedThreadsCount: 0, latestReviewedAt: null },
    checks: {
      status: 'success',
      detailsUrl: null,
      totalCount: 1,
      successCount: 1,
      failureCount: 0,
      pendingCount: 0,
      runs: [],
    },
    issueComments: [],
  })),
  listFiles: vi.fn(async () => []),
  listThreads: vi.fn(async () => []),
  updateThreadResolution: vi.fn(async () => {}),
  updateMergeState: vi.fn(async () => {}),
  updateReviewDecision: vi.fn(async () => {}),
  insertWriteAudit: vi.fn(async () => {}),
  resolveThreadKey: vi.fn(async () => ({ threadId: null })),
  getUnresolvedThreadCount: vi.fn(async () => 0),
  updateUnresolvedThreadCount: vi.fn(async () => {}),
})

const githubMock = {
  submitReview: vi.fn(async () => ({ id: 1 })),
  resolveReviewThread: vi.fn(async () => ({ id: 'thread-1', isResolved: true })),
  getReviewThreadForComment: vi.fn(async () => ({ threadId: 'thread-1', isResolved: false })),
  mergePullRequest: vi.fn(async () => ({ merged: true })),
  deleteBranch: vi.fn(async () => ({ ok: true })),
}

beforeEach(() => {
  vi.clearAllMocks()
  githubMock.submitReview.mockResolvedValue({ id: 1 })
  githubMock.resolveReviewThread.mockResolvedValue({ id: 'thread-1', isResolved: true })
  githubMock.getReviewThreadForComment.mockResolvedValue({ threadId: 'thread-1', isResolved: false })
  githubMock.mergePullRequest.mockResolvedValue({ merged: true })
  githubMock.deleteBranch.mockResolvedValue({ ok: true })
  globalState.__githubReviewConfigMock = {
    githubToken: 'token',
    githubApiBaseUrl: 'https://api.github.com',
    reposAllowed: ['proompteng/lab'],
    reviewsWriteEnabled: true,
    mergeWriteEnabled: true,
    mergeForceEnabled: false,
    filesBackfillEnabled: false,
  }
  globalState.__githubReviewGithubMock = githubMock
  globalState.__githubReviewStoreMock = buildStore()
})

describe('github review write actions', () => {
  it('submits a review via GitHub API', async () => {
    const { submitPullRequestReview } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/review', { method: 'POST' })

    const response = await submitPullRequestReview(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      event: 'COMMENT',
      body: 'LGTM',
    })

    expect(response).toEqual({ id: 1 })
    expect(githubMock.submitReview).toHaveBeenCalled()
  })

  it('resolves review threads', async () => {
    const { resolvePullRequestThread } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/threads/1/resolve', {
      method: 'POST',
    })

    const response = await resolvePullRequestThread(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      threadKey: 'comment-1',
      resolve: true,
    })

    expect(response.id).toBe('thread-1')
    expect(githubMock.resolveReviewThread).toHaveBeenCalled()
  })

  it('merges pull requests and deletes branches', async () => {
    const { mergePullRequest } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/merge', { method: 'POST' })

    const response = await mergePullRequest(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      method: 'squash',
      deleteBranch: true,
    })

    expect(response.merge).toEqual({ merged: true })
    expect(githubMock.mergePullRequest).toHaveBeenCalled()
    expect(githubMock.deleteBranch).toHaveBeenCalled()
  })
})
