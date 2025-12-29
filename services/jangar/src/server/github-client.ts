import { Buffer } from 'node:buffer'

import { Effect } from 'effect'
import * as Duration from 'effect/Duration'
import * as Schedule from 'effect/Schedule'

const MIN_REQUEST_SPACING_MS = (() => {
  const raw = process.env.JANGAR_GITHUB_MIN_REQUEST_SPACING_MS
  if (!raw) return 250
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250
})()

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000
const RATE_LIMIT_JITTER_MS = 1_000
const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 5

export type GitHubClientOptions = {
  token: string | null
  apiBaseUrl: string
  userAgent?: string
}

export type PullRequest = {
  number: number
  url: string
  htmlUrl: string
  headSha: string
  headRef: string
  baseRef: string
  state: string
  title: string
  body: string | null
  mergeableState: string | null
}

export type CheckRunSummary = {
  status: 'pending' | 'success' | 'failure'
  url?: string
}

export type ReviewThreadComment = {
  author: string | null
  body: string | null
  path: string | null
  line: number | null
}

export type ReviewSummary = {
  status: 'pending' | 'approved' | 'changes_requested' | 'commented'
  unresolvedThreads: Array<{ id: string; author: string | null; comments: ReviewThreadComment[] }>
  requestedChanges: boolean
  issueComments: Array<{ author: string | null; body: string | null; createdAt: string | null; url: string | null }>
}

export type FileContent = {
  content: string
  sha: string
}

export type CreatePullRequestInput = {
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
}

export type CreateBranchInput = {
  owner: string
  repo: string
  branch: string
  baseSha: string
}

export type UpdateFileInput = {
  owner: string
  repo: string
  path: string
  branch: string
  message: string
  content: string
  sha?: string
}

const encodeBase64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const decodeBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8')

export class GitHubRateLimitError extends Error {
  readonly status: number
  readonly retryAt: number
  readonly remaining: number | null
  readonly resetAt: number | null

  constructor(
    message: string,
    options: { status: number; retryAt: number; remaining: number | null; resetAt: number | null },
  ) {
    super(message)
    this.name = 'GitHubRateLimitError'
    this.status = options.status
    this.retryAt = options.retryAt
    this.remaining = options.remaining
    this.resetAt = options.resetAt
  }
}

const unwrapEffectError = (error: unknown): unknown => {
  if (error && typeof error === 'object') {
    const candidate = error as { _tag?: string; cause?: unknown; error?: unknown }
    if (candidate._tag === 'UnknownException') {
      return candidate.cause ?? candidate.error ?? error
    }
    if ('cause' in candidate && candidate.cause) {
      return candidate.cause as unknown
    }
  }
  return error
}

const shouldRetryRateLimit = (error: unknown) => unwrapEffectError(error) instanceof GitHubRateLimitError

const rateLimitSchedule = (() => {
  const backoff = Schedule.exponential(Duration.millis(1_000), 2)
  const capped = Schedule.delayed(backoff, (delay) => Duration.min(delay, Duration.millis(300_000)))
  const jittered = Schedule.jitteredWith({ min: 0.8, max: 1.2 })(capped)
  const limited = Schedule.intersect(Schedule.recurs(RATE_LIMIT_RETRY_MAX_ATTEMPTS))(jittered)
  const normalized = Schedule.map(limited, ([delay]) => delay)
  return Schedule.whileInput<unknown>(shouldRetryRateLimit)(normalized)
})()

const buildHeaders = (token: string | null, userAgent = 'jangar-codex-judge') => {
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: 'application/vnd.github+json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let requestQueue = Promise.resolve()
let lastRequestAt = 0
let nextAllowedAt = 0

const enqueueRequest = async <T>(work: () => Promise<T>): Promise<T> => {
  const run = async () => {
    const now = Date.now()
    if (nextAllowedAt > now) {
      await sleep(nextAllowedAt - now)
    }
    const sinceLast = Date.now() - lastRequestAt
    if (sinceLast < MIN_REQUEST_SPACING_MS) {
      await sleep(MIN_REQUEST_SPACING_MS - sinceLast)
    }
    const result = await work()
    lastRequestAt = Date.now()
    return result
  }
  const next = requestQueue.then(run, run)
  requestQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

const parseIntHeader = (value: string | null) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const parseRateLimitHeaders = (response: Response) => {
  const remaining = parseIntHeader(response.headers.get('x-ratelimit-remaining'))
  const resetEpoch = parseIntHeader(response.headers.get('x-ratelimit-reset'))
  const retryAfterSeconds = parseIntHeader(response.headers.get('retry-after'))
  const resetAt = resetEpoch ? resetEpoch * 1000 : null
  const retryAfterMs = retryAfterSeconds ? retryAfterSeconds * 1000 : null
  return { remaining, resetAt, retryAfterMs }
}

const isRateLimitResponse = (status: number, text: string, remaining: number | null, retryAfterMs: number | null) => {
  if (status === 429) return true
  if (status !== 403) return false
  if (remaining === 0) return true
  if (retryAfterMs && retryAfterMs > 0) return true
  return /rate limit exceeded|abuse detection/i.test(text)
}

const updateRateLimitThrottle = (resetAt: number | null) => {
  const base = resetAt ?? Date.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS
  nextAllowedAt = Math.max(nextAllowedAt, base + RATE_LIMIT_JITTER_MS)
  return nextAllowedAt
}

const requestJson = async (url: string, init: RequestInit) => {
  const effect = Effect.tryPromise(() =>
    enqueueRequest(async () => {
      const response = await fetch(url, init)
      const text = await response.text()
      if (!response.ok) {
        const { remaining, resetAt, retryAfterMs } = parseRateLimitHeaders(response)
        if (isRateLimitResponse(response.status, text, remaining, retryAfterMs)) {
          const retryAt = updateRateLimitThrottle(resetAt ?? (retryAfterMs ? Date.now() + retryAfterMs : null))
          throw new GitHubRateLimitError(`GitHub API ${response.status}: ${text}`, {
            status: response.status,
            retryAt,
            remaining,
            resetAt,
          })
        }
        throw new Error(`GitHub API ${response.status}: ${text}`)
      }
      return text ? (JSON.parse(text) as unknown) : null
    }),
  )
  return Effect.runPromise(Effect.retry(effect, rateLimitSchedule))
}

const requestText = async (url: string, init: RequestInit) => {
  const effect = Effect.tryPromise(() =>
    enqueueRequest(async () => {
      const response = await fetch(url, init)
      const text = await response.text()
      if (!response.ok) {
        const { remaining, resetAt, retryAfterMs } = parseRateLimitHeaders(response)
        if (isRateLimitResponse(response.status, text, remaining, retryAfterMs)) {
          const retryAt = updateRateLimitThrottle(resetAt ?? (retryAfterMs ? Date.now() + retryAfterMs : null))
          throw new GitHubRateLimitError(`GitHub API ${response.status}: ${text}`, {
            status: response.status,
            retryAt,
            remaining,
            resetAt,
          })
        }
        throw new Error(`GitHub API ${response.status}: ${text}`)
      }
      return text
    }),
  )
  return Effect.runPromise(Effect.retry(effect, rateLimitSchedule))
}

export const createGitHubClient = ({ token, apiBaseUrl, userAgent }: GitHubClientOptions) => {
  const headers = buildHeaders(token, userAgent)

  const rest = async (path: string, init: RequestInit = {}) => {
    return requestJson(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    })
  }

  const restText = async (path: string, init: RequestInit = {}) => {
    return requestText(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    })
  }

  const graphql = async (query: string, variables: Record<string, unknown>) => {
    return requestJson(`${apiBaseUrl.replace('/v3', '')}/graphql`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
  }

  const getPullRequestByHead = async (owner: string, repo: string, head: string): Promise<PullRequest | null> => {
    const data = (await rest(
      `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=1`,
    )) as Array<Record<string, unknown>>
    const pr = data?.[0]
    if (!pr) return null
    return {
      number: Number(pr.number),
      url: String(pr.url),
      htmlUrl: String(pr.html_url),
      headSha: String((pr.head as Record<string, unknown>).sha),
      headRef: String((pr.head as Record<string, unknown>).ref),
      baseRef: String((pr.base as Record<string, unknown>).ref),
      state: String(pr.state),
      title: String(pr.title),
      body: typeof pr.body === 'string' ? pr.body : null,
      mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
    }
  }

  const getPullRequest = async (owner: string, repo: string, number: number): Promise<PullRequest> => {
    const pr = (await rest(`/repos/${owner}/${repo}/pulls/${number}`)) as Record<string, unknown>
    return {
      number: Number(pr.number),
      url: String(pr.url),
      htmlUrl: String(pr.html_url),
      headSha: String((pr.head as Record<string, unknown>).sha),
      headRef: String((pr.head as Record<string, unknown>).ref),
      baseRef: String((pr.base as Record<string, unknown>).ref),
      state: String(pr.state),
      title: String(pr.title),
      body: typeof pr.body === 'string' ? pr.body : null,
      mergeableState: typeof pr.mergeable_state === 'string' ? pr.mergeable_state : null,
    }
  }

  const getCheckRuns = async (owner: string, repo: string, sha: string): Promise<CheckRunSummary> => {
    const data = (await rest(`/repos/${owner}/${repo}/commits/${sha}/check-runs`)) as Record<string, unknown>
    const runs = Array.isArray(data.check_runs) ? data.check_runs : []
    if (runs.length === 0) {
      return { status: 'pending' }
    }
    let hasFailure = false
    let hasPending = false
    let detailsUrl: string | undefined
    for (const run of runs) {
      const status = String(run.status ?? '')
      const conclusion = run.conclusion ? String(run.conclusion) : null
      detailsUrl = detailsUrl ?? (typeof run.html_url === 'string' ? run.html_url : undefined)
      if (status !== 'completed') {
        hasPending = true
      } else if (conclusion && conclusion !== 'success' && conclusion !== 'skipped') {
        hasFailure = true
      }
    }
    if (hasFailure) return { status: 'failure', url: detailsUrl }
    if (hasPending) return { status: 'pending', url: detailsUrl }
    return { status: 'success', url: detailsUrl }
  }

  const getPullRequestDiff = async (owner: string, repo: string, number: number) => {
    return restText(`/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        accept: 'application/vnd.github.v3.diff',
      },
    })
  }

  const getReviewSummary = async (
    owner: string,
    repo: string,
    number: number,
    reviewers: string[],
  ): Promise<ReviewSummary> => {
    const normalizeLogin = (value: unknown) => {
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      if (!trimmed) return null
      return trimmed.toLowerCase().replace(/^@/, '')
    }

    const reviewerSet = new Set(reviewers.map((value) => normalizeLogin(value)).filter(Boolean) as string[])
    const includeAll = reviewerSet.size === 0

    const getPullRequestFromResponse = (response: Record<string, unknown>) =>
      ((response.data as Record<string, unknown> | undefined)?.repository as Record<string, unknown> | undefined)
        ?.pullRequest as Record<string, unknown> | undefined

    const reviewNodes: Array<Record<string, unknown>> = []
    const reviewQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviews(first: 50, after: $cursor) {
            nodes { author { login } state submittedAt body }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`

    let reviewCursor: string | null = null
    let reviewHasNext = true
    while (reviewHasNext) {
      const response = (await graphql(reviewQuery, { owner, repo, number, cursor: reviewCursor })) as Record<
        string,
        unknown
      >
      const pr = getPullRequestFromResponse(response)
      const reviewConnection = pr?.reviews as Record<string, unknown> | undefined
      const nodes = Array.isArray(reviewConnection?.nodes)
        ? (reviewConnection?.nodes as Array<Record<string, unknown>>)
        : []
      reviewNodes.push(...nodes)
      const pageInfo = reviewConnection?.pageInfo as Record<string, unknown> | undefined
      reviewHasNext = Boolean(pageInfo?.hasNextPage)
      reviewCursor = typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null
      if (!reviewHasNext || !reviewCursor) break
    }

    const threadQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 50, after: $cursor) {
            nodes {
              id
              isResolved
              comments(first: 50) {
                nodes { author { login } body path line originalLine }
                pageInfo { hasNextPage endCursor }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`

    const threadCommentsQuery = `query($id: ID!, $cursor: String) {
      node(id: $id) {
        ... on PullRequestReviewThread {
          comments(first: 50, after: $cursor) {
            nodes { author { login } body path line originalLine }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`

    const threadNodes: Array<{ id: string; isResolved: boolean; comments: Array<Record<string, unknown>> }> = []
    let threadCursor: string | null = null
    let threadHasNext = true
    while (threadHasNext) {
      const response = (await graphql(threadQuery, { owner, repo, number, cursor: threadCursor })) as Record<
        string,
        unknown
      >
      const pr = getPullRequestFromResponse(response)
      const threadConnection = pr?.reviewThreads as Record<string, unknown> | undefined
      const nodes = Array.isArray(threadConnection?.nodes)
        ? (threadConnection?.nodes as Array<Record<string, unknown>>)
        : []
      for (const thread of nodes) {
        const threadId = typeof thread.id === 'string' ? thread.id : String(thread.id ?? '')
        if (!threadId) continue
        const isResolved = Boolean(thread.isResolved)
        if (isResolved) continue
        const commentsConnection = thread.comments as Record<string, unknown> | undefined
        const commentNodes = Array.isArray(commentsConnection?.nodes)
          ? (commentsConnection?.nodes as Array<Record<string, unknown>>)
          : []
        const comments = [...commentNodes]
        const commentPageInfo = commentsConnection?.pageInfo as Record<string, unknown> | undefined
        let commentHasNext = Boolean(commentPageInfo?.hasNextPage)
        let commentCursor = typeof commentPageInfo?.endCursor === 'string' ? commentPageInfo.endCursor : null
        while (commentHasNext && commentCursor) {
          const commentResponse = (await graphql(threadCommentsQuery, {
            id: threadId,
            cursor: commentCursor,
          })) as Record<string, unknown>
          const node = (commentResponse.data as Record<string, unknown> | undefined)?.node as
            | Record<string, unknown>
            | undefined
          const connection = node?.comments as Record<string, unknown> | undefined
          const extraNodes = Array.isArray(connection?.nodes)
            ? (connection?.nodes as Array<Record<string, unknown>>)
            : []
          comments.push(...extraNodes)
          const pageInfo = connection?.pageInfo as Record<string, unknown> | undefined
          commentHasNext = Boolean(pageInfo?.hasNextPage)
          commentCursor = typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null
          if (!commentHasNext) break
        }
        threadNodes.push({ id: threadId, isResolved, comments })
      }

      const pageInfo = threadConnection?.pageInfo as Record<string, unknown> | undefined
      threadHasNext = Boolean(pageInfo?.hasNextPage)
      threadCursor = typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null
      if (!threadHasNext || !threadCursor) break
    }

    const reviews = reviewNodes

    let requestedChanges = false
    let status: ReviewSummary['status'] = 'pending'
    for (const review of reviews) {
      const author = (review as Record<string, unknown>).author as Record<string, unknown> | null
      const login = normalizeLogin(author?.login ?? null)
      if (!includeAll && login && !reviewerSet.has(login)) {
        continue
      }
      const state = String((review as Record<string, unknown>).state ?? '').toUpperCase()
      if (state === 'CHANGES_REQUESTED') {
        requestedChanges = true
        status = 'changes_requested'
      } else if (state === 'APPROVED' && status !== 'changes_requested') {
        status = 'approved'
      } else if (state === 'COMMENTED' && status === 'pending') {
        status = 'commented'
      }
    }

    const rawComments: Array<Record<string, unknown>> = []
    for (let page = 1; page <= 10; page += 1) {
      const pageComments = (await rest(
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      )) as Array<Record<string, unknown>>
      if (!Array.isArray(pageComments) || pageComments.length === 0) break
      rawComments.push(...pageComments)
      if (pageComments.length < 100) break
    }
    const issueComments = rawComments
      .map((comment) => {
        const author = (comment.user as Record<string, unknown> | undefined)?.login
        const login = normalizeLogin(author ?? null)
        return {
          author: login,
          body: typeof comment.body === 'string' ? comment.body : null,
          createdAt: typeof comment.created_at === 'string' ? comment.created_at : null,
          url: typeof comment.html_url === 'string' ? comment.html_url : null,
        }
      })
      .filter((comment) => {
        if (includeAll) return true
        if (!comment.author) return false
        return reviewerSet.has(comment.author)
      })

    const unresolvedThreads = threadNodes
      .map((thread) => {
        const comments = thread.comments.map((comment) => {
          const author = (comment.author as Record<string, unknown> | undefined)?.login
          const login = normalizeLogin(author ?? null)
          const lineValue =
            typeof comment.line === 'number'
              ? comment.line
              : typeof comment.originalLine === 'number'
                ? comment.originalLine
                : null
          return {
            author: login,
            body: typeof comment.body === 'string' ? comment.body : null,
            path: typeof comment.path === 'string' ? comment.path : null,
            line: lineValue,
          }
        })
        const relevantComments = includeAll
          ? comments
          : comments.filter((comment) => comment.author && reviewerSet.has(comment.author))
        const authorLogin = relevantComments.find((comment) => comment.author)?.author ?? comments[0]?.author ?? null
        return {
          id: String(thread.id),
          author: authorLogin,
          comments: relevantComments,
        }
      })
      .filter((thread) => {
        if (includeAll) return true
        return thread.comments.length > 0
      })

    if (requestedChanges) {
      status = 'changes_requested'
    } else if (unresolvedThreads.length > 0) {
      status = 'commented'
    } else if (status === 'pending' && reviews.length === 0 && issueComments.length > 0) {
      status = 'commented'
    } else if (status === 'commented') {
      status = 'commented'
    } else if (status === 'approved') {
      status = 'approved'
    } else if (reviews.length === 0) {
      status = 'pending'
    }

    return { status, unresolvedThreads, requestedChanges, issueComments }
  }

  const getRefSha = async (owner: string, repo: string, ref: string) => {
    const data = (await rest(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent(ref)}`)) as Record<string, unknown>
    const object = data.object as Record<string, unknown>
    return String(object.sha)
  }

  const createBranch = async ({ owner, repo, branch, baseSha }: CreateBranchInput) => {
    return rest(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    })
  }

  const getFile = async (owner: string, repo: string, path: string, ref: string): Promise<FileContent> => {
    const data = (await rest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    )) as Record<string, unknown>
    const content = typeof data.content === 'string' ? data.content.replace(/\n/g, '') : ''
    const sha = String(data.sha)
    return { content: decodeBase64(content), sha }
  }

  const updateFile = async ({ owner, repo, path, branch, message, content, sha }: UpdateFileInput) => {
    const body: Record<string, unknown> = { message, content: encodeBase64(content), branch }
    if (sha) {
      body.sha = sha
    }
    return rest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const createPullRequest = async ({ owner, repo, head, base, title, body }: CreatePullRequestInput) => {
    return rest(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, head, base, body }),
    })
  }

  return {
    getPullRequestByHead,
    getPullRequest,
    getCheckRuns,
    getPullRequestDiff,
    getReviewSummary,
    getRefSha,
    getFile,
    updateFile,
    createBranch,
    createPullRequest,
  }
}
