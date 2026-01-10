import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getPullHandler,
  getPullsHandler,
  mergePullHandler,
  resolveThreadHandler,
  submitReviewHandler,
} from '~/server/github-review-handlers'

describe('github review api routes', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    previousEnv.JANGAR_GITHUB_REPOS_ALLOWED = process.env.JANGAR_GITHUB_REPOS_ALLOWED
    process.env.JANGAR_GITHUB_REPOS_ALLOWED = 'proompteng/lab'
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
})
