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
  insertWriteAudit: vi.fn(async () => {}),
  resolveThreadKey: vi.fn(async () => ({ threadId: null })),
  getUnresolvedThreadCount: vi.fn(async () => 0),
  updateUnresolvedThreadCount: vi.fn(async () => {}),
})

const requireHandler = async () => {
  const module = await import('../github-review-ingest')
  return module.ingestGithubReviewEvent
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
    const store = globalState.__githubReviewStoreMock
    expect(store).toBeDefined()

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
    expect(store?.recordEvent).toHaveBeenCalled()
    expect(store?.upsertPrState).toHaveBeenCalled()
  })

  it('stores review threads and comments from review comment events', async () => {
    const handler = await requireHandler()
    const store = globalState.__githubReviewStoreMock

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

    expect(store?.upsertReviewThread).toHaveBeenCalled()
    expect(store?.upsertReviewComment).toHaveBeenCalled()
    expect(store?.updateUnresolvedThreadCount).toHaveBeenCalled()
  })

  it('skips duplicate delivery ids', async () => {
    const handler = await requireHandler()
    const store = globalState.__githubReviewStoreMock
    ;(store?.recordEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ inserted: false })

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
})
