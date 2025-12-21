import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { findLatestPlanComment, postIssueReaction } from '@/services/github/issues'
import {
  createPullRequestComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
} from '@/services/github/pull-requests'
import { listPullRequestReviewThreads } from '@/services/github/reviews'
import type { FetchLike } from '@/services/github/types'

const READY_COMMENT_MARKER = '<!-- codex:ready -->'

describe('postIssueReaction', () => {
  it('reports missing token when GITHUB_TOKEN is not configured', async () => {
    const result = await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'owner/repo',
        issueNumber: 12,
        token: null,
        reactionContent: 'rocket',
        fetchImplementation: null,
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'missing-token' })
  })

  it('rejects invalid repository names', async () => {
    const result = await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'invalid-owner-only',
        issueNumber: 99,
        token: 'token',
        reactionContent: 'rocket',
        fetchImplementation: null,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-repository')
    }
  })

  it('posts reaction payload to the GitHub API', async () => {
    const fetchSpy = vi.fn(async (_input: string, _init) => {
      return {
        ok: true,
        status: 201,
        text: async () => '',
      }
    })

    const result = await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'acme/widgets',
        issueNumber: 7,
        token: 'secret-token',
        reactionContent: 'rocket',
        apiBaseUrl: 'https://example.test/api',
        userAgent: 'custom-agent',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const firstCall = fetchSpy.mock.calls[0]
    if (!firstCall) {
      throw new Error('Expected fetch to be called')
    }
    const [url, init] = firstCall
    expect(url).toBe('https://example.test/api/repos/acme/widgets/issues/7/reactions')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
      'User-Agent': 'custom-agent',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    expect(init?.body).toBe(JSON.stringify({ content: 'rocket' }))
  })

  it('propagates http errors with status and body details', async () => {
    const fetchSpy = vi.fn(async () => {
      return {
        ok: false,
        status: 403,
        text: async () => 'forbidden',
      }
    })

    const result = await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'acme/widgets',
        issueNumber: 7,
        token: 'secret-token',
        reactionContent: 'rocket',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('http-error')
      expect(result.status).toBe(403)
      expect(result.detail).toBe('forbidden')
    }
  })

  it('indicates when no fetch implementation is available', async () => {
    const result = await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'owner/repo',
        issueNumber: 13,
        token: 'token',
        reactionContent: 'heart',
        fetchImplementation: null,
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'no-fetch' })
  })

  it('surfaces network errors thrown by the fetch implementation', async () => {
    const result = await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'owner/repo',
        issueNumber: 99,
        token: 'token',
        reactionContent: 'eyes',
        fetchImplementation: async () => {
          throw new Error('boom')
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('network-error')
      expect(result.detail).toBe('boom')
    }
  })

  it('removes trailing slashes from the API base URL before sending the request', async () => {
    const fetchSpy = vi.fn(async (_url: string) => ({
      ok: true,
      status: 201,
      text: async () => '',
    }))

    await Effect.runPromise(
      postIssueReaction({
        repositoryFullName: 'acme/widgets',
        issueNumber: 5,
        token: 'secret-token',
        reactionContent: 'rocket',
        apiBaseUrl: 'https://example.test/api/',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const trailingCall = fetchSpy.mock.calls[0]
    if (!trailingCall) {
      throw new Error('Expected fetch to be called')
    }
    const [url] = trailingCall
    expect(url).toBe('https://example.test/api/repos/acme/widgets/issues/5/reactions')
  })
})

describe('listPullRequestReviewThreads', () => {
  it('returns unresolved review threads from the GraphQL response', async () => {
    const fetchSpy = vi.fn(async (url: string, init?: { body?: unknown }) => {
      expect(url).toBe('https://api.github.com/graphql')
      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : JSON.parse(String(init?.body ?? '{}'))
      expect(payload.variables).toEqual({
        owner: 'acme',
        repo: 'widgets',
        pullNumber: 42,
      })

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        isResolved: false,
                        path: 'src/app.tsx',
                        comments: {
                          nodes: [
                            {
                              bodyText: 'Please add unit tests before merging.',
                              url: 'https://example.test/thread-1',
                              author: { login: 'octocat' },
                            },
                          ],
                        },
                      },
                      {
                        isResolved: true,
                        path: 'src/ignore.ts',
                        comments: { nodes: [] },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
      }
    })

    const result = await Effect.runPromise(
      listPullRequestReviewThreads({
        repositoryFullName: 'acme/widgets',
        pullNumber: 42,
        token: 'token-123',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.threads).toEqual([
        {
          summary: 'Please add unit tests before merging.',
          url: 'https://example.test/thread-1',
          author: 'octocat',
        },
      ])
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('paginates when GitHub returns additional review threads', async () => {
    const fetchSpy = vi
      .fn(async (_url: string, init?: { body?: unknown }) => {
        const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : JSON.parse(String(init?.body ?? '{}'))

        if (!payload.variables.cursor) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [],
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                      },
                    },
                  },
                },
              }),
          }
        }

        expect(payload.variables.cursor).toBe('cursor-1')

        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          isResolved: false,
                          path: 'src/server.ts',
                          comments: {
                            nodes: [
                              {
                                bodyText: 'Server handler still fails on edge cases.',
                                url: 'https://example.test/thread-2',
                                author: { login: 'codex-bot' },
                              },
                            ],
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
        }
      })
      .mockName('graphqlFetch')

    const result = await Effect.runPromise(
      listPullRequestReviewThreads({
        repositoryFullName: 'acme/widgets',
        pullNumber: 77,
        token: 'token-xyz',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.threads).toEqual([
        {
          summary: 'Server handler still fails on edge cases.',
          url: 'https://example.test/thread-2',
          author: 'codex-bot',
        },
      ])
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('surfaces GraphQL errors from GitHub', async () => {
    const fetchSpy = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            errors: [{ message: 'Something went wrong' }],
          }),
      }
    })

    const result = await Effect.runPromise(
      listPullRequestReviewThreads({
        repositoryFullName: 'acme/widgets',
        pullNumber: 88,
        token: 'token-xyz',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('http-error')
      expect(result.detail).toContain('Something went wrong')
    }
  })
})

describe('findLatestPlanComment', () => {
  it('returns the latest comment containing the marker', async () => {
    const payload = [
      { id: 101, body: 'Regular comment' },
      { id: 202, body: `${READY_COMMENT_MARKER}\nApproved steps`, html_url: 'https://example.com/comment/202' },
    ]

    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'proompteng/lab',
        issueNumber: 12,
        fetchImplementation: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
        }),
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.comment.id).toBe(202)
    expect(result.comment.body).toContain('Approved steps')
    expect(result.comment.htmlUrl).toBe('https://example.com/comment/202')
  })

  it('returns not-found when no comment carries the marker', async () => {
    const payload = [{ id: 303, body: 'No marker here' }]

    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'proompteng/lab',
        issueNumber: 99,
        fetchImplementation: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
        }),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'not-found' })
  })

  it('rejects repositories without owner and name segments', async () => {
    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'invalid-repo',
        issueNumber: 5,
        fetchImplementation: async () => {
          throw new Error('fetch should not be called')
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-repository')
    }
  })

  it('returns invalid-json when the response body is not an array', async () => {
    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'owner/repo',
        issueNumber: 4,
        fetchImplementation: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ foo: 'bar' }),
        }),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-json', detail: 'Expected array response from GitHub API' })
  })

  it('returns invalid-comment when id cannot be coerced to a number', async () => {
    const payload = [{ id: 'abc', body: `${READY_COMMENT_MARKER} body` }]

    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'owner/repo',
        issueNumber: 6,
        fetchImplementation: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
        }),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-comment', detail: 'Comment missing numeric id' })
  })

  it('propagates JSON parse errors as invalid-json', async () => {
    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'owner/repo',
        issueNumber: 7,
        fetchImplementation: async () => ({
          ok: true,
          status: 200,
          text: async () => '{invalid}',
        }),
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-json')
    }
  })

  it('returns http-error when GitHub responds with failure', async () => {
    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'owner/repo',
        issueNumber: 8,
        fetchImplementation: async () => ({
          ok: false,
          status: 500,
          text: async () => 'server failure',
        }),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'http-error', status: 500, detail: 'server failure' })
  })

  it('returns network-error when fetch implementation throws', async () => {
    const result = await Effect.runPromise(
      findLatestPlanComment({
        repositoryFullName: 'owner/repo',
        issueNumber: 9,
        fetchImplementation: async () => {
          throw new Error('network down')
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'network-error', detail: 'network down' })
  })
})

describe('fetchPullRequest', () => {
  it('parses a pull request payload when GitHub responds successfully', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          number: 7,
          title: 'Add API endpoint',
          body: 'Implements the endpoint',
          html_url: 'https://github.com/owner/repo/pull/7',
          draft: false,
          merged: false,
          state: 'open',
          head: { ref: 'feature/api', sha: 'abc123' },
          base: { ref: 'main' },
          user: { login: 'octocat' },
          mergeable_state: 'clean',
        }),
    }))

    const result = await Effect.runPromise(
      fetchPullRequest({
        repositoryFullName: 'owner/repo',
        pullNumber: 7,
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.pullRequest).toMatchObject({
      number: 7,
      title: 'Add API endpoint',
      headRef: 'feature/api',
      headSha: 'abc123',
      baseRef: 'main',
      authorLogin: 'octocat',
      mergeableState: 'clean',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns invalid-repository when the repository name is malformed', async () => {
    const result = await Effect.runPromise(fetchPullRequest({ repositoryFullName: 'ownerOnly', pullNumber: 1 }))

    expect(result).toEqual({ ok: false, reason: 'invalid-repository', detail: 'ownerOnly' })
  })

  it('returns no-fetch when a fetch implementation is unavailable', async () => {
    const result = await Effect.runPromise(
      fetchPullRequest({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        fetchImplementation: null,
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'no-fetch' })
  })

  it('maps 404 responses to not-found', async () => {
    const result = await Effect.runPromise(
      fetchPullRequest({
        repositoryFullName: 'owner/repo',
        pullNumber: 99,
        fetchImplementation: async () => ({
          ok: false,
          status: 404,
          text: async () => 'missing',
        }),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'not-found', status: 404, detail: 'missing' })
  })

  it('returns invalid-pull-request when decoding fails', async () => {
    const result = await Effect.runPromise(
      fetchPullRequest({
        repositoryFullName: 'owner/repo',
        pullNumber: 5,
        fetchImplementation: async () => ({
          ok: true,
          status: 200,
          text: async () => '{ bad json',
        }),
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('invalid-pull-request')
  })
})

describe('markPullRequestReadyForReview', () => {
  it('requires a token', async () => {
    const result = await Effect.runPromise(
      markPullRequestReadyForReview({ repositoryFullName: 'owner/repo', pullNumber: 1 }),
    )

    expect(result).toEqual({ ok: false, reason: 'missing-token' })
  })

  it('returns invalid-repository for malformed names', async () => {
    const result = await Effect.runPromise(
      markPullRequestReadyForReview({
        repositoryFullName: 'ownerOnly',
        pullNumber: 1,
        token: 'token',
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-repository', detail: 'ownerOnly' })
  })

  it('returns no-fetch when fetch implementation is missing', async () => {
    const result = await Effect.runPromise(
      markPullRequestReadyForReview({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        token: 'token',
        fetchImplementation: null,
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'no-fetch' })
  })

  it('returns ok when GitHub accepts the mutation', async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ node_id: 'node-123' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' })

    const result = await Effect.runPromise(
      markPullRequestReadyForReview({
        repositoryFullName: 'owner/repo',
        pullNumber: 7,
        token: 'token',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const graphqlCall = fetchSpy.mock.calls[1]
    expect(graphqlCall?.[1]?.body).toContain('node-123')
  })

  it('returns http-error when GitHub rejects the request', async () => {
    const fetchSpy = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ node_id: 'node-123' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'failure',
      })

    const result = await Effect.runPromise(
      markPullRequestReadyForReview({
        repositoryFullName: 'owner/repo',
        pullNumber: 7,
        token: 'token',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'http-error', status: 500, detail: 'failure' })
  })

  it('returns network-error when fetch throws', async () => {
    const result = await Effect.runPromise(
      markPullRequestReadyForReview({
        repositoryFullName: 'owner/repo',
        pullNumber: 7,
        token: 'token',
        fetchImplementation: async () => {
          throw new Error('boom')
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'network-error', detail: 'boom' })
  })

  it('returns http-error when fetching the pull request fails', async () => {
    const result = await Effect.runPromise(
      markPullRequestReadyForReview({
        repositoryFullName: 'owner/repo',
        pullNumber: 7,
        token: 'token',
        fetchImplementation: vi.fn(async () => ({
          ok: false,
          status: 404,
          text: async () => 'missing',
        })),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'http-error', status: 404, detail: 'missing' })
  })
})

describe('createPullRequestComment', () => {
  it('requires a token', async () => {
    const result = await Effect.runPromise(
      createPullRequestComment({ repositoryFullName: 'owner/repo', pullNumber: 1, body: 'Hi' }),
    )

    expect(result).toEqual({ ok: false, reason: 'missing-token' })
  })

  it('rejects malformed repository names', async () => {
    const result = await Effect.runPromise(
      createPullRequestComment({
        repositoryFullName: 'ownerOnly',
        pullNumber: 1,
        body: 'Hello',
        token: 'token',
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-repository', detail: 'ownerOnly' })
  })

  it('returns no-fetch when no implementation is supplied', async () => {
    const result = await Effect.runPromise(
      createPullRequestComment({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        body: 'Hello',
        token: 'token',
        fetchImplementation: null,
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'no-fetch' })
  })

  it('returns the comment URL on success', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ html_url: 'https://github.com/owner/repo/pull/1#comment-1' }),
    }))

    const result = await Effect.runPromise(
      createPullRequestComment({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        body: 'Looks good!',
        token: 'token',
        fetchImplementation: fetchSpy,
      }),
    )

    expect(result).toEqual({ ok: true, commentUrl: 'https://github.com/owner/repo/pull/1#comment-1' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('propagates http errors from GitHub', async () => {
    const result = await Effect.runPromise(
      createPullRequestComment({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        body: 'Looks good!',
        token: 'token',
        fetchImplementation: async () => ({
          ok: false,
          status: 403,
          text: async () => 'forbidden',
        }),
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'http-error', status: 403, detail: 'forbidden' })
  })

  it('returns invalid-json when GitHub responds with malformed JSON', async () => {
    const result = await Effect.runPromise(
      createPullRequestComment({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        body: 'Looks good!',
        token: 'token',
        fetchImplementation: async () => ({
          ok: true,
          status: 201,
          text: async () => '{ bad json',
        }),
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('invalid-json')
    expect(result.detail).toMatch(/Unexpected|property name|Expected/) // message varies per runtime
  })

  it('returns network-error when fetch throws', async () => {
    const result = await Effect.runPromise(
      createPullRequestComment({
        repositoryFullName: 'owner/repo',
        pullNumber: 1,
        body: 'Looks good!',
        token: 'token',
        fetchImplementation: async () => {
          throw new Error('boom')
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'network-error', detail: 'boom' })
  })
})
