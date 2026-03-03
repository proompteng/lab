import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubReviewStore } from '../github-review-store'

vi.mock('~/server/audit-client', () => ({
  emitAuditEventBestEffort: vi.fn(async () => {}),
}))

const globalState = globalThis as typeof globalThis & {
  __githubReviewConfigMock?: {
    githubToken: string | null
    githubApiBaseUrl: string
    reposAllowed: string[]
    reviewsWriteEnabled: boolean
    mergeWriteEnabled: boolean
    mergeForceEnabled: boolean
    mergeHoldLabel: string | null
    automergeBranchPrefixes: string[]
    automergeRequiredCheckNames: string[]
    automergeAllowedFilePrefixes: string[]
    automergeBlockedFilePrefixes: string[]
    automergeAllowedRiskClasses: string[]
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
  replacePrFiles: vi.fn(async () => {}),
  upsertPrWorktree: vi.fn(async () => {}),
  getPrWorktree: vi.fn(async () => null),
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
  listCheckStates: vi.fn(async () => []),
  listThreads: vi.fn(async () => []),
  updateThreadResolution: vi.fn(async () => {}),
  updateMergeState: vi.fn(async () => {}),
  updateReviewDecision: vi.fn(async () => {}),
  listWriteAudits: vi.fn(async () => []),
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
    mergeHoldLabel: 'do-not-automerge',
    automergeBranchPrefixes: ['codex/swarm-'],
    automergeRequiredCheckNames: [],
    automergeAllowedFilePrefixes: [],
    automergeBlockedFilePrefixes: [],
    automergeAllowedRiskClasses: [],
  }
  globalState.__githubReviewGithubMock = githubMock
  globalState.__githubReviewStoreMock = buildStore()
})

describe('github review write actions', () => {
  it('submits a review via GitHub API', async () => {
    const { submitPullRequestReview } = await import('../github-review-actions')
    const { emitAuditEventBestEffort } = await import('~/server/audit-client')
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
    expect(emitAuditEventBestEffort).toHaveBeenCalled()
  })

  it('resolves review threads', async () => {
    const { resolvePullRequestThread } = await import('../github-review-actions')
    const { emitAuditEventBestEffort } = await import('~/server/audit-client')
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
    expect(emitAuditEventBestEffort).toHaveBeenCalled()
  })

  it('merges pull requests and deletes branches', async () => {
    const { mergePullRequest } = await import('../github-review-actions')
    const { emitAuditEventBestEffort } = await import('~/server/audit-client')
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
    expect(emitAuditEventBestEffort).toHaveBeenCalled()
  })

  it('records rollout evidence when merge succeeds', async () => {
    const store = buildStore()
    const insertedAudits: Array<Parameters<GithubReviewStore['insertWriteAudit']>[0]> = []
    store.insertWriteAudit = vi.fn(async (audit: Parameters<GithubReviewStore['insertWriteAudit']>[0]) => {
      insertedAudits.push(audit)
    })
    globalState.__githubReviewStoreMock = store
    githubMock.mergePullRequest.mockResolvedValue({ merged: true, sha: 'merged-sha-123' })

    const { mergePullRequest } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/merge', { method: 'POST' })

    const response = await mergePullRequest(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      method: 'squash',
      commitTitle: null,
      commitMessage: null,
      deleteBranch: false,
      force: false,
    })

    expect(response.merge).toEqual({ merged: true, sha: 'merged-sha-123' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const mergeAudit = insertedAudits.find((audit) => audit.action === 'merge')
    const rolloutAudit = insertedAudits.find((audit) => audit.action === 'rollout')
    expect(mergeAudit).toBeDefined()
    expect(rolloutAudit).toMatchObject({
      action: 'rollout',
      stage: 'rollout',
      rolloutRef: 'merged-sha-123',
      rolloutStatus: 'passed',
      actionClass: 'autonomous',
      success: true,
    })
  })

  it('records rollout evidence actions for a PR', async () => {
    const store = buildStore()
    globalState.__githubReviewStoreMock = store
    const { recordPullDeploymentAction } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/deployment', { method: 'POST' })

    const result = await recordPullDeploymentAction(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      action: 'rollout',
      missionId: 'mission-rollout-1',
      reference: 'ref/rollout',
      status: 'passed',
    })

    expect(result.ok).toBe(true)
    expect(store.insertWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rollout',
        missionId: 'mission-rollout-1',
        rolloutRef: 'ref/rollout',
        rolloutStatus: 'passed',
      }),
    )
  })

  it('rejects invalid deployment evidence actions', async () => {
    const store = buildStore()
    globalState.__githubReviewStoreMock = store
    const { recordPullDeploymentAction } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/deployment', { method: 'POST' })

    const action = 'invalid' as 'rollout'
    const result = recordPullDeploymentAction(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      action,
    })
    await expect(result).rejects.toThrow('Invalid deployment action')
  })

  it('requires rollout evidence reference', async () => {
    const store = buildStore()
    globalState.__githubReviewStoreMock = store
    const { recordPullDeploymentAction } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/deployment', { method: 'POST' })

    const result = recordPullDeploymentAction(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      action: 'rollout',
      missionId: 'mission-rollout-1',
      status: 'passed',
    })
    await expect(result).rejects.toThrow('Rollout evidence requires a reference')
    expect(store.insertWriteAudit).toHaveBeenCalledTimes(1)
    expect(store.insertWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rollout',
        stage: 'rollout',
        success: false,
        error: 'Rollout evidence requires a reference',
      }),
    )
  })

  it('requires rollback evidence reason', async () => {
    const store = buildStore()
    globalState.__githubReviewStoreMock = store
    const { recordPullDeploymentAction } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/deployment', { method: 'POST' })

    const result = recordPullDeploymentAction(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      action: 'rollback',
      missionId: 'mission-rollback-1',
      reference: 'deploy/ref',
    })
    await expect(result).rejects.toThrow('Rollback evidence requires a reason')
    expect(store.insertWriteAudit).toHaveBeenCalledTimes(1)
    expect(store.insertWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rollback',
        stage: 'rollback',
        success: false,
        error: 'Rollback evidence requires a reason',
      }),
    )
  })

  it('requires required check names for codex/swarm merge lanes', async () => {
    const store = buildStore()
    if (store.getPull) {
      store.getPull = vi.fn(async () => ({
        pull: {
          repository: 'proompteng/lab',
          number: 1,
          title: null,
          body: null,
          state: 'open',
          merged: false,
          mergedAt: null,
          labels: ['risk:low'],
          receivedAt: '2025-01-01T00:00:00Z',
          authorLogin: null,
          authorAvatarUrl: null,
          htmlUrl: null,
          headRef: 'codex/swarm-fix',
          headSha: 'abc123',
          baseRef: 'main',
          baseSha: 'def456',
          mergeable: true,
          mergeableState: 'clean',
          draft: false,
          additions: null,
          deletions: null,
          changedFiles: 1,
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
      }))
    }
    store.listCheckStates = vi.fn(async () => [
      {
        commitSha: 'abc123',
        runs: [],
        status: 'pending',
        detailsUrl: null,
        totalCount: 0,
        successCount: 0,
        failureCount: 0,
        pendingCount: 0,
        updatedAt: null,
      },
    ])
    globalState.__githubReviewStoreMock = store
    globalState.__githubReviewConfigMock.automergeRequiredCheckNames = ['ci/required']

    const { mergePullRequest } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/merge', { method: 'POST' })

    const response = mergePullRequest(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      method: 'squash',
      commitTitle: null,
      commitMessage: null,
      deleteBranch: false,
      force: false,
    })
    await expect(response).rejects.toThrow('Merge blocked (required checks missing/failing: ci/required)')
  })

  it('blocks codex/swarm merges when changed files violate path policy', async () => {
    const store = buildStore()
    if (store.getPull) {
      store.getPull = vi.fn(async () => ({
        pull: {
          repository: 'proompteng/lab',
          number: 1,
          title: null,
          body: null,
          state: 'open',
          merged: false,
          mergedAt: null,
          labels: ['risk:low'],
          receivedAt: '2025-01-01T00:00:00Z',
          authorLogin: null,
          authorAvatarUrl: null,
          htmlUrl: null,
          headRef: 'codex/swarm-fix',
          headSha: 'abc123',
          baseRef: 'main',
          baseSha: 'def456',
          mergeable: true,
          mergeableState: 'clean',
          draft: false,
          additions: null,
          deletions: null,
          changedFiles: 1,
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
      }))
    }
    store.listCheckStates = vi.fn(async () => [
      {
        commitSha: 'abc123',
        status: 'success',
        detailsUrl: null,
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        pendingCount: 0,
        updatedAt: null,
        runs: [{ name: 'ci/required', status: 'completed', conclusion: 'success', id: '1' }],
      },
    ])
    store.listFiles = vi.fn(async () => [{ path: 'infra/unsafe.tf' }])
    globalState.__githubReviewStoreMock = store
    globalState.__githubReviewConfigMock.automergeRequiredCheckNames = ['ci/required']
    globalState.__githubReviewConfigMock.automergeAllowedFilePrefixes = ['services']

    const { mergePullRequest } = await import('../github-review-actions')
    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/1/merge', { method: 'POST' })

    const response = mergePullRequest(request, {
      owner: 'proompteng',
      repo: 'lab',
      number: 1,
      method: 'squash',
      commitTitle: null,
      commitMessage: null,
      deleteBranch: false,
      force: false,
    })
    await expect(response).rejects.toThrow('Merge blocked (files outside policy')
  })
})
