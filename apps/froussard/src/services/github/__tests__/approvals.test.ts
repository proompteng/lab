import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { approvePullRequest, listCommitPullRequests } from '@/services/github/reviews'
import type { FetchLike } from '@/services/github/types'

const body = '<!-- codex:ready -->\n:shipit:'
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const review = (id = 1, state = 'PENDING', commit = 'head') => ({
  id,
  state,
  commit_id: commit,
  user: { login: 'tuslagch' },
  body,
  html_url: `https://github.com/owner/repo/pull/7#pullrequestreview-${id}`,
})

const server = () => {
  const state = {
    login: 'tuslagch',
    author: 'gregkonush',
    head: 'head',
    draft: false,
    pullState: 'open',
    reviewHead: 'head',
    reviewStatus: 'completed',
    unresolved: false,
    commentAuthor: 'chatgpt-codex-connector[bot]',
    reviews: [] as ReturnType<typeof review>[],
    loseCreateResponse: false,
    loseSubmitResponse: false,
    changeHeadOnCreate: false,
    approvals: 0,
    nextId: 1,
    pullReads: 0,
    failPullRead: 0,
    pullFailure: 'network' as 'network' | 'invalid' | number,
  }
  const writes: Array<{ method: string; path: string; body: unknown }> = []
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const data = init?.body ? JSON.parse(init.body) : undefined
    if (method !== 'GET') writes.push({ method, path: url.pathname, body: data })
    if (url.pathname === '/user') return response({ login: state.login })
    if (url.pathname.endsWith('/pulls/7')) {
      state.pullReads++
      if (state.pullReads === state.failPullRead) {
        if (state.pullFailure === 'network') throw new Error('GitHub connection lost')
        if (state.pullFailure === 'invalid') return response({ malformed: true })
        return response({ message: 'GitHub unavailable' }, state.pullFailure)
      }
      return response({
        number: 7,
        title: 'Change',
        html_url: 'https://github.com/owner/repo/pull/7',
        state: state.pullState,
        draft: state.draft,
        merged: false,
        user: { login: state.author },
        head: { ref: 'feature', sha: state.head },
        base: { ref: 'main' },
      })
    }
    if (url.pathname.endsWith('/comments'))
      return response([
        {
          user: { login: state.commentAuthor },
          body: `<!-- codex-review-state:v1 ${JSON.stringify({
            code_review: {
              commit_sha: state.reviewHead,
              status: state.reviewStatus,
              has_unresolved_findings: state.unresolved,
            },
          })} -->`,
        },
      ])
    if (url.pathname.endsWith('/reviews')) {
      if (method === 'GET') return response(state.reviews)
      if (state.reviews.some((entry) => entry.state === 'PENDING'))
        return response({ message: 'Pending review exists' }, 422)
      const pending = { ...review(state.nextId++), commit_id: data.commit_id, body: data.body }
      state.reviews.push(pending)
      if (state.changeHeadOnCreate) state.head = 'new-head'
      if (state.loseCreateResponse) throw new Error('Connection lost after creation')
      return response(pending, 200)
    }
    const match = /\/reviews\/(\d+)(\/events)?$/.exec(url.pathname)
    if (match) {
      const entry = state.reviews.find((entry) => entry.id === Number(match[1]))
      if (!entry || entry.state !== 'PENDING') return response({ message: 'Not pending' }, 422)
      if (method === 'DELETE') {
        state.reviews = state.reviews.filter((item) => item !== entry)
        return response({})
      }
      expect(data).toEqual({ event: 'APPROVE', body })
      entry.state = 'APPROVED'
      state.approvals++
      if (state.loseSubmitResponse) throw new Error('Connection lost after approval')
      return response(entry)
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`)
  }
  const approve = () =>
    Effect.runPromise(
      approvePullRequest({
        repositoryFullName: 'owner/repo',
        pullNumber: 7,
        headSha: 'head',
        body,
        token: 'test-token',
        apiBaseUrl: 'https://github.test',
        fetchImplementation: fetch,
      }),
    )
  return { state, writes, approve }
}

describe('approvePullRequest', () => {
  it('submits the existing comment as an approval on the checked commit, then deduplicates it', async () => {
    const api = server()
    expect(await api.approve()).toMatchObject({ ok: true })
    expect(await api.approve()).toMatchObject({ ok: true })
    expect(api.state.approvals).toBe(1)
    expect(api.writes[0]?.body).toEqual({ commit_id: 'head', body })
    expect(api.state.reviews[0]).toMatchObject({
      state: 'APPROVED',
      user: { login: 'tuslagch' },
      commit_id: 'head',
      body,
    })
  })

  it.each([
    ['wrong actor', { login: 'gregkonush' }, 'identity-mismatch'],
    ['own PR', { author: 'tuslagch' }, 'not-ready'],
    ['draft', { draft: true }, 'not-ready'],
    ['closed', { pullState: 'closed' }, 'not-ready'],
    ['pushed head', { head: 'new-head' }, 'head-changed'],
    ['stale Codex review', { reviewHead: 'old-head' }, 'not-ready'],
    ['unfinished review', { reviewStatus: 'in_progress' }, 'not-ready'],
    ['unresolved findings', { unresolved: true }, 'not-ready'],
    ['spoofed summary', { commentAuthor: 'someone-else' }, 'not-ready'],
  ] as const)('does not write for %s', async (_name, overrides, reason) => {
    const api = server()
    Object.assign(api.state, overrides)
    expect(await api.approve()).toMatchObject({ ok: false, reason })
    expect(api.writes).toHaveLength(0)
  })

  it.each(['loseCreateResponse', 'loseSubmitResponse'] as const)(
    'reconciles %s without repeating the approval',
    async (failure) => {
      const api = server()
      api.state[failure] = true
      expect(await api.approve()).toMatchObject({ ok: true })
      expect(await api.approve()).toMatchObject({ ok: true })
      expect(api.state.approvals).toBe(1)
    },
  )

  it('reconciles concurrent deliveries through the same pending review', async () => {
    const api = server()
    const results = await Promise.all([api.approve(), api.approve()])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(api.state.approvals).toBe(1)
  })

  it('leaves unrelated pending work untouched', async () => {
    const api = server()
    api.state.reviews = [{ ...review(), body: 'Human draft' }]
    expect(await api.approve()).toMatchObject({ ok: false, reason: 'pending-review' })
    expect(api.writes).toHaveLength(0)
  })

  it('replaces only its own obsolete pending draft', async () => {
    const api = server()
    api.state.reviews = [review(10, 'PENDING', 'old-head')]
    expect(await api.approve()).toMatchObject({ ok: true })
    expect(api.state.reviews).toHaveLength(1)
    expect(api.state.reviews[0]?.commit_id).toBe('head')
  })

  it('does not approve a dismissed approval as if it were still valid', async () => {
    const api = server()
    api.state.reviews = [review(10, 'DISMISSED')]
    expect(await api.approve()).toMatchObject({ ok: true })
    expect(api.state.approvals).toBe(1)
  })

  it('removes its draft and does not approve when the head changes during the request', async () => {
    const api = server()
    api.state.changeHeadOnCreate = true
    expect(await api.approve()).toMatchObject({ ok: false, reason: 'head-changed' })
    expect(api.state.approvals).toBe(0)
    expect(api.state.reviews).toHaveLength(0)
  })

  it('preserves HTTP errors instead of calling them invalid JSON', async () => {
    expect(
      await Effect.runPromise(
        approvePullRequest({
          repositoryFullName: 'owner/repo',
          pullNumber: 7,
          headSha: 'head',
          body,
          token: 'test-token',
          fetchImplementation: async () => response({ message: 'Forbidden' }, 403),
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'http-error', status: 403 })
  })

  describe.each([1, 2])('pull request revalidation %i', (failPullRead) => {
    it.each([
      ['network', 'network-error'],
      [429, 'http-error'],
      [503, 'http-error'],
      ['invalid', 'invalid-pull-request'],
    ] as const)('preserves %s failure and resumes on retry', async (pullFailure, reason) => {
      const api = server()
      Object.assign(api.state, { failPullRead, pullFailure })

      expect(await api.approve()).toMatchObject({
        ok: false,
        reason,
        ...(typeof pullFailure === 'number' ? { status: pullFailure } : {}),
      })
      expect(api.state.approvals).toBe(0)
      expect(api.state.reviews).toHaveLength(failPullRead - 1)

      api.state.failPullRead = 0
      expect(await api.approve()).toMatchObject({ ok: true })
      expect(api.state.approvals).toBe(1)
      expect(api.writes.filter((write) => write.path.endsWith('/reviews'))).toHaveLength(1)
    })
  })
})

it('resolves open PRs from a commit when check events omit their PR list', async () => {
  const result = await Effect.runPromise(
    listCommitPullRequests({
      repositoryFullName: 'owner/repo',
      headSha: 'head',
      token: 'test-token',
      fetchImplementation: async (input) => {
        expect(input).toContain('/commits/head/pulls?per_page=100&page=1')
        return response([
          { number: 7, state: 'open' },
          { number: 8, state: 'closed' },
        ])
      },
    }),
  )
  expect(result).toEqual({ ok: true, pullNumbers: [7] })
})
