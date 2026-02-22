import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getPullFilesHandler,
  getPullHandler,
  getPullsHandler,
  mergePullHandler,
  refreshPullFilesHandler,
  resolveThreadHandler,
  submitReviewHandler,
} from '~/server/github-review-handlers'

const refreshWorktreeSnapshotMock = vi.hoisted(() => vi.fn())

vi.mock('~/server/github-worktree-snapshot', () => ({
  refreshWorktreeSnapshot: refreshWorktreeSnapshotMock,
}))

describe('github review api routes', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    previousEnv.JANGAR_GITHUB_REPOS_ALLOWED = process.env.JANGAR_GITHUB_REPOS_ALLOWED
    process.env.JANGAR_GITHUB_REPOS_ALLOWED = 'proompteng/lab'
    refreshWorktreeSnapshotMock.mockReset()
  })

  afterEach(() => {
    if (previousEnv.JANGAR_GITHUB_REPOS_ALLOWED === undefined) {
      delete process.env.JANGAR_GITHUB_REPOS_ALLOWED
    } else {
      process.env.JANGAR_GITHUB_REPOS_ALLOWED = previousEnv.JANGAR_GITHUB_REPOS_ALLOWED
    }
  })

  it('lists pull requests', async () => {
    const store = {
      listPulls: vi.fn(async () => ({ items: [{ repository: 'proompteng/lab', number: 1 }], nextCursor: null })),
      close: vi.fn(async () => {}),
    }

    const response = await getPullsHandler(
      new Request('http://localhost/api/github/pulls', {
        headers: { 'x-github-user': 'octocat' },
      }),
      () => store as never,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      items: [{ repository: 'proompteng/lab', number: 1 }],
    })
    expect(store.listPulls).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'proompteng/lab',
        author: 'octocat',
      }),
    )
  })

  it('does not default author from email headers', async () => {
    const store = {
      listPulls: vi.fn(async () => ({ items: [], nextCursor: null })),
      close: vi.fn(async () => {}),
    }

    const response = await getPullsHandler(
      new Request('http://localhost/api/github/pulls', {
        headers: { 'x-forwarded-email': 'someone@example.com' },
      }),
      () => store as never,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      viewerLogin: null,
    })
    expect(store.listPulls).toHaveBeenCalledWith(expect.objectContaining({ author: undefined }))
  })

  it('fetches pull request details', async () => {
    const store = {
      getPull: vi.fn(async () => ({
        pull: { repository: 'proompteng/lab', number: 1, labels: [], receivedAt: '2025-01-01T00:00:00Z' },
        review: null,
        checks: null,
        issueComments: [],
      })),
      close: vi.fn(async () => {}),
    }

    const response = await getPullHandler(
      new Request('http://localhost/api/github/pulls/proompteng/lab/1'),
      {
        owner: 'proompteng',
        repo: 'lab',
        number: '1',
      },
      () => store as never,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      pull: { repository: 'proompteng/lab', number: 1 },
    })
  })

  it('submits a review', async () => {
    const actions = { submitPullRequestReview: vi.fn(async () => ({ id: 123 })) }
    const response = await submitReviewHandler(
      new Request('http://localhost/api/github/pulls/proompteng/lab/1/review', {
        method: 'POST',
        body: JSON.stringify({ event: 'COMMENT', body: 'Looks good' }),
      }),
      { owner: 'proompteng', repo: 'lab', number: '1' },
      actions,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(actions.submitPullRequestReview).toHaveBeenCalled()
  })

  it('resolves a review thread', async () => {
    const actions = { resolvePullRequestThread: vi.fn(async () => ({ id: 'thread-1', isResolved: true })) }
    const response = await resolveThreadHandler(
      new Request('http://localhost/api/github/pulls/proompteng/lab/1/threads/55/resolve', {
        method: 'POST',
        body: JSON.stringify({ resolve: true }),
      }),
      { owner: 'proompteng', repo: 'lab', number: '1', threadId: '55' },
      actions,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(actions.resolvePullRequestThread).toHaveBeenCalled()
  })

  it('merges a pull request', async () => {
    const actions = { mergePullRequest: vi.fn(async () => ({ merge: { merged: true }, deleteBranch: null })) }
    const response = await mergePullHandler(
      new Request('http://localhost/api/github/pulls/proompteng/lab/1/merge', {
        method: 'POST',
        body: JSON.stringify({ method: 'squash' }),
      }),
      { owner: 'proompteng', repo: 'lab', number: '1' },
      actions,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(actions.mergePullRequest).toHaveBeenCalled()
  })

  it('deduplicates pull file refreshes while one snapshot refresh is in flight', async () => {
    type RefreshResult = {
      repository: string
      prNumber: number
      commitSha: string
      baseSha: string
      worktreeName: string
      worktreePath: string
      fileCount: number
    }
    let resolveRefresh: ((value: RefreshResult | PromiseLike<RefreshResult>) => void) | null = null

    const refreshResult = new Promise<RefreshResult>((resolve) => {
      resolveRefresh = resolve
    })
    refreshWorktreeSnapshotMock.mockReturnValue(refreshResult)

    const pull = {
      pull: {
        repository: 'proompteng/lab',
        number: 7001,
        labels: [],
        receivedAt: '2025-01-01T00:00:00Z',
        headRef: 'feature-refresh',
        headSha: 'abc7001',
        baseRef: 'main',
        baseSha: 'def7001',
      },
      review: null,
      checks: null,
      issueComments: [],
    }
    const store = {
      getPull: vi.fn(async () => pull),
      getPrWorktree: vi.fn(async () => ({
        repository: 'proompteng/lab',
        prNumber: 7001,
        worktreeName: 'proompteng-lab-7001',
        worktreePath: '/tmp/proompteng-lab-7001',
        baseSha: 'def7001',
        headSha: 'stale',
        lastRefreshedAt: '2025-01-01T00:00:00Z',
      })),
      listFiles: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    }

    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/7001/files')
    const params = { owner: 'proompteng', repo: 'lab', number: '7001' }

    const [responseA, responseB] = await Promise.all([
      getPullFilesHandler(request, params, () => store as never),
      getPullFilesHandler(request, params, () => store as never),
    ])
    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    await expect(responseA.json()).resolves.toMatchObject({ ok: true, files: [], refreshing: true })
    await expect(responseB.json()).resolves.toMatchObject({ ok: true, files: [], refreshing: true })
    expect(refreshWorktreeSnapshotMock).toHaveBeenCalledTimes(1)

    if (!resolveRefresh) throw new Error('Expected snapshot resolver')
    resolveRefresh({
      repository: 'proompteng/lab',
      prNumber: 7001,
      commitSha: 'abc7001',
      baseSha: 'def7001',
      worktreeName: 'proompteng-lab-7001',
      worktreePath: '/tmp/proompteng-lab-7001',
      fileCount: 0,
    })
    await refreshResult
  })

  it('returns refresh-in-progress when a prior refresh hit missing git refs', async () => {
    refreshWorktreeSnapshotMock.mockRejectedValueOnce(
      new Error('Unable to resolve git ref: origin/feature-refresh-7002'),
    )
    const store = {
      getPull: vi.fn(async () => ({
        pull: {
          repository: 'proompteng/lab',
          number: 7002,
          labels: [],
          receivedAt: '2025-01-01T00:00:00Z',
          headRef: 'feature-refresh-7002',
          headSha: 'abc7002',
          baseRef: 'main',
          baseSha: 'def7002',
        },
        review: null,
        checks: null,
        issueComments: [],
      })),
      close: vi.fn(async () => {}),
    }

    const request = new Request('http://localhost/api/github/pulls/proompteng/lab/7002/files/refresh')
    const params = { owner: 'proompteng', repo: 'lab', number: '7002' }

    const first = await refreshPullFilesHandler(request, params, () => store as never)
    expect(first.status).toBe(500)
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      error: 'Unable to resolve git ref: origin/feature-refresh-7002',
    })
    expect(refreshWorktreeSnapshotMock).toHaveBeenCalledTimes(1)

    refreshWorktreeSnapshotMock.mockClear()
    const second = await refreshPullFilesHandler(request, params, () => store as never)
    expect(second.status).toBe(202)
    await expect(second.json()).resolves.toMatchObject({ ok: true, status: 'refreshing' })
    expect(refreshWorktreeSnapshotMock).not.toHaveBeenCalled()
  })
})
