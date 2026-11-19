import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGitHubClient, summarizeLatestReviewStates } from '../github-client'

describe('summarizeLatestReviewStates', () => {
  it('lets a later approval supersede an earlier change request from the same reviewer', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'reviewer',
          state: 'APPROVED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'approved', requestedChanges: false })
  })

  it('keeps a current change request from any reviewer blocking approval', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer-a',
          state: 'APPROVED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
        {
          author: 'reviewer-b',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'changes_requested', requestedChanges: true })
  })

  it('uses response order as a fallback when submitted timestamps are unavailable', () => {
    expect(
      summarizeLatestReviewStates([
        { author: 'reviewer', state: 'CHANGES_REQUESTED', submittedAt: null },
        { author: 'reviewer', state: 'APPROVED', submittedAt: null },
      ]),
    ).toEqual({ status: 'approved', requestedChanges: false })
  })

  it('ignores a newer pending draft review when retaining the last submitted decision', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'reviewer',
          state: 'PENDING',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'changes_requested', requestedChanges: true })
  })

  it('keeps an earlier change request blocking across a later comment-only review', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'reviewer',
          state: 'COMMENTED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'changes_requested', requestedChanges: true })
  })

  it('lets a dismissed review clear an earlier change request', () => {
    expect(
      summarizeLatestReviewStates([
        {
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'reviewer',
          state: 'DISMISSED',
          submittedAt: '2026-01-02T00:00:00Z',
        },
      ]),
    ).toEqual({ status: 'pending', requestedChanges: false })
  })
})

describe('GitHub request retries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not retry an ordinary API failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createGitHubClient({ token: null, apiBaseUrl: 'https://github.test' })
    await expect(client.getPullRequest('owner', 'repo', 1)).rejects.toThrow('503')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a rate limit and returns the successful result', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limit', {
          status: 429,
          headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 10) },
        }),
      )
      .mockResolvedValueOnce(Response.json({ number: 1, head: {}, base: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createGitHubClient({ token: null, apiBaseUrl: 'https://github.test' })
    const result = client.getPullRequest('owner', 'repo', 1)
    await vi.runAllTimersAsync()
    expect((await result).number).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops after five retries when rate limiting persists', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('rate limit', {
          status: 429,
          headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 10) },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = createGitHubClient({ token: null, apiBaseUrl: 'https://github.test' })
    const failure = expect(client.getPullRequest('owner', 'repo', 1)).rejects.toThrow('429')
    await vi.runAllTimersAsync()
    await failure
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})
