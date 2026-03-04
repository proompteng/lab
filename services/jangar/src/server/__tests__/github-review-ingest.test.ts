import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubWebhookEvent } from '../github-review-ingest'
import type { GithubReviewStore } from '../github-review-store'

const globalState = globalThis as typeof globalThis & {
  __githubReviewStoreMock?: GithubReviewStore
  __githubWorktreeSnapshotMock?: (input: {
    repository: string
    prNumber: number
    headRef: string
    baseRef: string
  }) => Promise<{
    repository: string
    prNumber: number
    commitSha: string
    baseSha: string
    worktreeName: string
    worktreePath: string
    fileCount: number
  }>
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
  getPull: vi.fn(async () => ({ pull: null, review: null, checks: null, issueComments: [] })),
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

const requireHandler = async () => {
  const module = await import('../github-review-ingest')
  return module.ingestGithubReviewEvent
}

const requireStore = () => {
  const store = globalState.__githubReviewStoreMock
  if (!store) {
    throw new Error('Expected github review store mock to be initialized')
  }
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  globalState.__githubReviewStoreMock = buildStore()
  globalState.__githubWorktreeSnapshotMock = vi.fn(async () => ({
    repository: 'proompteng/lab',
    prNumber: 0,
    commitSha: 'mock',
    baseSha: 'base',
    worktreeName: 'mock',
    worktreePath: '/tmp/mock',
    fileCount: 0,
  }))
})

afterEach(() => {
  delete globalState.__githubWorktreeSnapshotMock
})

describe('github review ingest', () => {
  it('upserts pull request state on pull_request events', async () => {
    const handler = await requireHandler()
    const store = requireStore()

    const payload: GithubWebhookEvent = {
      event: 'pull_request',
      action: 'opened',
      deliveryId: 'delivery-1',
      repository: 'proompteng/lab',
      sender: 'octocat',
      payload: {
        pull_request: {
          number: 42,
          title: 'Add new feature',
          state: 'open',
          head: { ref: 'feature', sha: 'abc123' },
          base: { ref: 'main', sha: 'def456', repo: { full_name: 'proompteng/lab' } },
          user: { login: 'octocat' },
          labels: [{ name: 'backend' }],
        },
        repository: { full_name: 'proompteng/lab' },
      },
    }

    const result = await handler(payload)
    expect(result.ok).toBe(true)
    expect(store.recordEvent).toHaveBeenCalled()
    expect(store.upsertPrState).toHaveBeenCalled()
  })

  it('stores review threads and comments from review comment events', async () => {
    const handler = await requireHandler()
    const store = requireStore()

    const payload: GithubWebhookEvent = {
      event: 'pull_request_review_comment',
      action: 'created',
      deliveryId: 'delivery-2',
      repository: 'proompteng/lab',
      sender: 'reviewer',
      payload: {
        pull_request: {
          number: 123,
          head: { sha: 'deadbeef' },
          base: { repo: { full_name: 'proompteng/lab' } },
        },
        comment: {
          id: 555,
          path: 'services/jangar/src/server/db.ts',
          line: 10,
          body: 'Looks good',
          diff_hunk: '@@ -1,2 +1,2 @@',
          user: { login: 'reviewer' },
        },
      },
    }

    await handler(payload)

    expect(store.upsertReviewThread).toHaveBeenCalled()
    expect(store.upsertReviewComment).toHaveBeenCalled()
    expect(store.updateUnresolvedThreadCount).toHaveBeenCalled()
  })

  it('skips duplicate delivery ids', async () => {
    const handler = await requireHandler()
    const store = requireStore()
    ;(store.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ inserted: false })

    const payload: GithubWebhookEvent = {
      event: 'pull_request',
      action: 'opened',
      deliveryId: 'delivery-dup',
      repository: 'proompteng/lab',
      sender: 'octocat',
      payload: {
        pull_request: {
          number: 42,
          title: 'Add new feature',
          state: 'open',
          head: { ref: 'feature', sha: 'abc123' },
          base: { ref: 'main', sha: 'def456', repo: { full_name: 'proompteng/lab' } },
          user: { login: 'octocat' },
          labels: [{ name: 'backend' }],
        },
        repository: { full_name: 'proompteng/lab' },
      },
    }

    const result = await handler(payload)
    expect(result.skipped).toBe(true)
    expect(store?.upsertPrState).not.toHaveBeenCalled()
  })

  it('skips repeated worktree snapshot refreshes when a ref is missing', async () => {
    const handler = await requireHandler()
    const store = requireStore()
    const snapshotMock = globalState.__githubWorktreeSnapshotMock
    if (!snapshotMock) throw new Error('Expected github worktree snapshot mock')
    ;(snapshotMock as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unable to resolve git ref: origin/missing-branch'),
    )
    ;(store.getPrWorktree as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: 'proompteng/lab',
      prNumber: 3001,
      worktreeName: 'proompteng-lab-3001',
      worktreePath: '/tmp/proompteng-lab-3001',
      baseSha: 'base-sha',
      headSha: 'stale-head-sha',
      lastRefreshedAt: '2025-01-01T00:00:00Z',
    })

    const payload: GithubWebhookEvent = {
      event: 'pull_request',
      action: 'opened',
      deliveryId: 'delivery-3',
      repository: 'proompteng/lab',
      sender: 'octocat',
      payload: {
        pull_request: {
          number: 3001,
          title: 'Refresh backoff regression',
          state: 'open',
          head: { ref: 'feature-missing', sha: 'abc3001' },
          base: { ref: 'main', sha: 'def3001', repo: { full_name: 'proompteng/lab' } },
          user: { login: 'octocat' },
          labels: [{ name: 'backend' }],
        },
      },
    }

    const first = await handler(payload)
    expect(first.ok).toBe(true)
    expect(snapshotMock).toHaveBeenCalledTimes(1)
    expect(store.upsertPrWorktree).toHaveBeenCalledTimes(1)
    const blockedState = (store.upsertPrWorktree as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.at(0)
    expect(blockedState).toMatchObject({
      repository: 'proompteng/lab',
      prNumber: 3001,
      refreshFailureReason: 'Error: Unable to resolve git ref: origin/missing-branch',
      refreshBlockedUntil: expect.any(String),
    })

    const second = await handler(payload)
    expect(second.ok).toBe(true)
    expect(snapshotMock).toHaveBeenCalledTimes(1)
    expect(store.upsertPrState).toHaveBeenCalledTimes(2)
  })

  it('skips refresh when db suppression is active for missing refs', async () => {
    const handler = await requireHandler()
    const store = requireStore()

    ;(store.getPrWorktree as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: 'proompteng/lab',
      prNumber: 3002,
      worktreeName: 'proompteng-lab-3002',
      worktreePath: '/tmp/proompteng-lab-3002',
      baseSha: 'base-sha',
      headSha: 'stale-head-sha',
      lastRefreshedAt: '2025-01-01T00:00:00Z',
      refreshBlockedUntil: new Date(Date.now() + 60_000).toISOString(),
      refreshFailureReason: 'previously missing ref',
      refreshFailedAt: '2025-01-01T00:00:00Z',
    })

    const payload: GithubWebhookEvent = {
      event: 'pull_request',
      action: 'opened',
      deliveryId: 'delivery-4',
      repository: 'proompteng/lab',
      sender: 'octocat',
      payload: {
        pull_request: {
          number: 3002,
          title: 'Skip because db suppression',
          state: 'open',
          head: { ref: 'feature-missing', sha: 'abc3002' },
          base: { ref: 'main', sha: 'def3002', repo: { full_name: 'proompteng/lab' } },
          user: { login: 'octocat' },
          labels: [{ name: 'backend' }],
        },
      },
    }

    const result = await handler(payload)
    expect(result.ok).toBe(true)
    expect(store.getPrWorktree).toHaveBeenCalled()
    expect(store.recordEvent).toHaveBeenCalled()
    expect(store.upsertPrState).toHaveBeenCalled()
    expect(globalState.__githubWorktreeSnapshotMock).not.toHaveBeenCalled()
  })
})
