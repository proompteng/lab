import { Effect, Layer, Schema } from 'effect'

import { PLAN_COMMENT_MARKER } from '@/codex'

export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>

export interface PostIssueReactionOptions {
  repositoryFullName: string
  issueNumber: number
  token?: string | null
  reactionContent: string
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type PostIssueReactionFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'http-error'
  | 'network-error'

export type PostIssueReactionResult =
  | { ok: true }
  | { ok: false; reason: PostIssueReactionFailureReason; status?: number; detail?: string }

export interface PlanComment {
  id: number
  body: string
  htmlUrl: string | null
}

export interface FindPlanCommentOptions {
  repositoryFullName: string
  issueNumber: number
  token?: string | null
  marker?: string
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type FindPlanCommentFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'http-error'
  | 'network-error'
  | 'invalid-json'
  | 'not-found'
  | 'invalid-comment'

export type FindPlanCommentResult =
  | { ok: true; comment: PlanComment }
  | { ok: false; reason: FindPlanCommentFailureReason; status?: number; detail?: string }

export interface PullRequestSummary {
  number: number
  title: string
  body: string
  htmlUrl: string
  draft: boolean
  merged: boolean
  state: string
  headRef: string
  headSha: string
  baseRef: string
  authorLogin: string | null
  mergeableState?: string | null
}

export interface FetchPullRequestOptions {
  repositoryFullName: string
  pullNumber: number
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type FetchPullRequestFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'
  | 'not-found'
  | 'invalid-pull-request'

export type FetchPullRequestResult =
  | { ok: true; pullRequest: PullRequestSummary }
  | { ok: false; reason: FetchPullRequestFailureReason; status?: number; detail?: string }

export interface ReadyForReviewOptions {
  repositoryFullName: string
  pullNumber: number
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type ReadyForReviewFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'

export type ReadyForReviewResult =
  | { ok: true }
  | { ok: false; reason: ReadyForReviewFailureReason; status?: number; detail?: string }

export interface CreatePullRequestCommentOptions {
  repositoryFullName: string
  pullNumber: number
  body: string
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type CreatePullRequestCommentFailureReason =
  | 'missing-token'
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type CreatePullRequestCommentResult =
  | { ok: true; commentUrl?: string }
  | { ok: false; reason: CreatePullRequestCommentFailureReason; status?: number; detail?: string }

export interface PullRequestReviewThread {
  summary: string
  url?: string
  author?: string
}

export interface ListReviewThreadsOptions {
  repositoryFullName: string
  pullNumber: number
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type ListReviewThreadsFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type ListReviewThreadsResult =
  | { ok: true; threads: PullRequestReviewThread[] }
  | { ok: false; reason: ListReviewThreadsFailureReason; status?: number; detail?: string }

export interface PullRequestCheckFailure {
  name: string
  conclusion?: string
  url?: string
  details?: string
}

export interface ListCheckFailuresOptions {
  repositoryFullName: string
  headSha: string
  token?: string | null
  apiBaseUrl?: string
  userAgent?: string
  fetchImplementation?: FetchLike | null
}

export type ListCheckFailuresFailureReason =
  | 'invalid-repository'
  | 'no-fetch'
  | 'network-error'
  | 'http-error'
  | 'invalid-json'

export type ListCheckFailuresResult =
  | { ok: true; checks: PullRequestCheckFailure[] }
  | { ok: false; reason: ListCheckFailuresFailureReason; status?: number; detail?: string }

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_USER_AGENT = 'froussard-webhook'

const GitHubPullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optionalWith(Schema.String, { nullable: true, default: () => '' }),
  html_url: Schema.String,
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  state: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
  base: Schema.Struct({
    ref: Schema.String,
  }),
  user: Schema.optionalWith(
    Schema.Struct({
      login: Schema.optionalWith(Schema.String, { nullable: true }),
    }),
    { nullable: true },
  ),
  mergeable_state: Schema.optionalWith(Schema.String, { nullable: true }),
})

const trimTrailingSlash = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value)

const resolveGitHubGraphqlUrl = (apiBaseUrl: string): string => {
  const trimmed = trimTrailingSlash(apiBaseUrl)
  if (trimmed.endsWith('/api/v3')) {
    return `${trimmed.slice(0, -2)}graphql`
  }
  if (trimmed.endsWith('/api')) {
    return `${trimmed}/graphql`
  }
  return `${trimmed}/graphql`
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

const readResponseText = (response: FetchResponse) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: toError,
  })

const coerceNumericId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

const summarizeText = (value: unknown, maxLength = 200): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }
  if (normalized.length > maxLength) {
    return `${normalized.slice(0, maxLength - 1)}…`
  }
  return normalized
}

export const postIssueReaction = (options: PostIssueReactionOptions): Effect.Effect<PostIssueReactionResult> => {
  const {
    repositoryFullName,
    issueNumber,
    token,
    reactionContent,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  if (!token || token.trim().length === 0) {
    return Effect.succeed({ ok: false, reason: 'missing-token' } as const)
  }

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const url = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/issues/${issueNumber}/reactions`

  return Effect.tryPromise({
    try: () =>
      fetchFn(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
        },
        body: JSON.stringify({ content: reactionContent }),
      }),
    catch: toError,
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.succeed<PostIssueReactionResult>({ ok: true })
      }

      return readResponseText(response)
        .pipe(Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)))
        .pipe(
          Effect.map((detail) => ({
            ok: false as const,
            reason: 'http-error' as const,
            status: response.status,
            detail,
          })),
        )
    }),
    Effect.catchAll((error) =>
      Effect.succeed<PostIssueReactionResult>({
        ok: false,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
  )
}

export const findLatestPlanComment = (options: FindPlanCommentOptions): Effect.Effect<FindPlanCommentResult> => {
  const {
    repositoryFullName,
    issueNumber,
    token,
    marker = PLAN_COMMENT_MARKER,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const url = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&sort=created&direction=desc`

  return Effect.matchEffect(
    Effect.tryPromise({
      try: () =>
        fetchFn(url, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
            ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
          },
        }),
      catch: toError,
    }),
    {
      onFailure: (error) =>
        Effect.succeed<FindPlanCommentResult>({
          ok: false,
          reason: 'network-error',
          detail: error instanceof Error ? error.message : String(error),
        }),
      onSuccess: (response) =>
        Effect.gen(function* (_) {
          if (!response.ok) {
            const detail = yield* readResponseText(response).pipe(
              Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
            )
            return {
              ok: false as const,
              reason: 'http-error',
              status: response.status,
              detail,
            }
          }

          const bodyResult = yield* readResponseText(response).pipe(Effect.either)
          if (bodyResult._tag === 'Left') {
            return {
              ok: false as const,
              reason: 'network-error',
              detail: bodyResult.left.message,
            }
          }

          let parsed: unknown
          try {
            parsed = bodyResult.right.length === 0 ? [] : JSON.parse(bodyResult.right)
          } catch (error) {
            return {
              ok: false as const,
              reason: 'invalid-json',
              detail: error instanceof Error ? error.message : String(error),
            }
          }

          if (!Array.isArray(parsed)) {
            return {
              ok: false as const,
              reason: 'invalid-json',
              detail: 'Expected array response from GitHub API',
            }
          }

          for (const comment of parsed) {
            if (!comment || typeof comment !== 'object') {
              continue
            }

            const body = (comment as { body?: unknown }).body
            if (typeof body !== 'string' || !body.includes(marker)) {
              continue
            }

            const id = coerceNumericId((comment as { id?: unknown }).id)
            if (id === null) {
              return {
                ok: false as const,
                reason: 'invalid-comment',
                detail: 'Comment missing numeric id',
              }
            }

            const htmlUrlValue = (comment as { html_url?: unknown }).html_url
            const htmlUrl = typeof htmlUrlValue === 'string' ? htmlUrlValue : null

            return {
              ok: true as const,
              comment: {
                id,
                body,
                htmlUrl,
              },
            }
          }

          return { ok: false as const, reason: 'not-found' }
        }),
    },
  )
}

export const fetchPullRequest = (options: FetchPullRequestOptions): Effect.Effect<FetchPullRequestResult> => {
  const {
    repositoryFullName,
    pullNumber,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const url = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/pulls/${pullNumber}`

  return Effect.matchEffect(
    Effect.tryPromise({
      try: () =>
        fetchFn(url, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
            ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
          },
        }),
      catch: toError,
    }),
    {
      onFailure: (error) =>
        Effect.succeed<FetchPullRequestResult>({
          ok: false,
          reason: 'network-error',
          detail: error instanceof Error ? error.message : String(error),
        }),
      onSuccess: (response) =>
        Effect.gen(function* (_) {
          if (!response.ok) {
            const detail = yield* readResponseText(response).pipe(
              Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
            )
            if (response.status === 404) {
              return { ok: false as const, reason: 'not-found', status: response.status, detail }
            }

            return {
              ok: false as const,
              reason: 'http-error',
              status: response.status,
              detail,
            }
          }

          const bodyResult = yield* readResponseText(response).pipe(Effect.either)
          if (bodyResult._tag === 'Left') {
            return {
              ok: false as const,
              reason: 'network-error',
              detail: bodyResult.left.message,
            }
          }

          let parsed: unknown
          try {
            parsed = bodyResult.right.length === 0 ? {} : JSON.parse(bodyResult.right)
          } catch (error) {
            return {
              ok: false as const,
              reason: 'invalid-json',
              detail: error instanceof Error ? error.message : String(error),
            }
          }

          if (!parsed || typeof parsed !== 'object') {
            return {
              ok: false as const,
              reason: 'invalid-json',
              detail: 'Expected object response from GitHub API',
            }
          }

          const decoded = Schema.decodeUnknownEither(GitHubPullRequestSchema)(parsed)
          if (decoded._tag === 'Left') {
            return {
              ok: false as const,
              reason: 'invalid-pull-request',
              detail: 'Missing or invalid pull request fields',
            }
          }

          const pull = decoded.right
          const authorLogin = typeof pull.user?.login === 'string' ? pull.user.login : null

          return {
            ok: true as const,
            pullRequest: {
              number: pull.number,
              title: pull.title,
              body: pull.body,
              htmlUrl: pull.html_url,
              draft: pull.draft,
              merged: pull.merged,
              state: pull.state,
              headRef: pull.head.ref,
              headSha: pull.head.sha,
              baseRef: pull.base.ref,
              authorLogin,
              mergeableState: pull.mergeable_state,
            },
          }
        }),
    },
  )
}

export const markPullRequestReadyForReview = (options: ReadyForReviewOptions): Effect.Effect<ReadyForReviewResult> => {
  const {
    repositoryFullName,
    pullNumber,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  if (!token || token.trim().length === 0) {
    return Effect.succeed({ ok: false, reason: 'missing-token' } as const)
  }

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const url = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/pulls/${pullNumber}/ready-for-review`

  return Effect.tryPromise({
    try: () =>
      fetchFn(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': userAgent,
          Authorization: `Bearer ${token}`,
        },
      }),
    catch: toError,
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.succeed<ReadyForReviewResult>({ ok: true })
      }

      return readResponseText(response)
        .pipe(Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)))
        .pipe(
          Effect.map((detail) => ({
            ok: false as const,
            reason: 'http-error' as const,
            status: response.status,
            detail,
          })),
        )
    }),
    Effect.catchAll((error) =>
      Effect.succeed<ReadyForReviewResult>({
        ok: false,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
  )
}

export const createPullRequestComment = (
  options: CreatePullRequestCommentOptions,
): Effect.Effect<CreatePullRequestCommentResult> => {
  const {
    repositoryFullName,
    pullNumber,
    body,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  if (!token || token.trim().length === 0) {
    return Effect.succeed({ ok: false, reason: 'missing-token' } as const)
  }

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const url = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/issues/${pullNumber}/comments`
  const payload = JSON.stringify({ body })

  return Effect.tryPromise({
    try: () =>
      fetchFn(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': userAgent,
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: payload,
      }),
    catch: toError,
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return readResponseText(response).pipe(
          Effect.map((text) => {
            if (!text) {
              return { ok: true } as const
            }
            try {
              const parsed = JSON.parse(text) as { html_url?: unknown }
              const commentUrl =
                parsed && typeof parsed === 'object' && typeof parsed.html_url === 'string'
                  ? parsed.html_url
                  : undefined
              return { ok: true, commentUrl }
            } catch (error) {
              return {
                ok: false as const,
                reason: 'invalid-json',
                detail: error instanceof Error ? error.message : String(error),
              }
            }
          }),
        )
      }

      return readResponseText(response).pipe(
        Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
        Effect.map(
          (detail): CreatePullRequestCommentResult => ({
            ok: false,
            reason: 'http-error',
            status: response.status,
            detail,
          }),
        ),
      )
    }),
    Effect.catchAll((error) =>
      Effect.succeed<CreatePullRequestCommentResult>({
        ok: false,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
  )
}

const LIST_REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $pullNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullNumber) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            isResolved
            path
            comments(last: 1) {
              nodes {
                bodyText
                url
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`

export const listPullRequestReviewThreads = (
  options: ListReviewThreadsOptions,
): Effect.Effect<ListReviewThreadsResult> => {
  const {
    repositoryFullName,
    pullNumber,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const graphqlUrl = resolveGitHubGraphqlUrl(apiBaseUrl)

  return Effect.gen(function* (_) {
    const threads: PullRequestReviewThread[] = []
    let cursor: string | null = null

    while (true) {
      const variables: Record<string, unknown> = {
        owner,
        repo,
        pullNumber,
      }
      if (cursor) {
        variables.cursor = cursor
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          fetchFn(graphqlUrl, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': userAgent,
              ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              query: LIST_REVIEW_THREADS_QUERY,
              variables,
            }),
          }),
        catch: toError,
      })

      const bodyResult = yield* readResponseText(response).pipe(Effect.either)
      if (bodyResult._tag === 'Left') {
        return {
          ok: false as const,
          reason: 'network-error',
          detail: bodyResult.left.message,
        }
      }

      if (!response.ok) {
        return {
          ok: false as const,
          reason: 'http-error',
          status: response.status,
          detail: bodyResult.right.length > 0 ? bodyResult.right : undefined,
        }
      }

      let parsed: unknown
      try {
        parsed = bodyResult.right.length === 0 ? {} : JSON.parse(bodyResult.right)
      } catch (error) {
        return {
          ok: false as const,
          reason: 'invalid-json',
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      const errorsValue = (parsed as { errors?: unknown }).errors
      if (Array.isArray(errorsValue) && errorsValue.length > 0) {
        const detail = errorsValue
          .map((entry) =>
            entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string'
              ? (entry as { message: string }).message
              : JSON.stringify(entry),
          )
          .join('; ')
        return {
          ok: false as const,
          reason: 'http-error',
          status: response.status,
          detail: detail.length > 0 ? detail : undefined,
        }
      }

      const dataValue = (parsed as { data?: unknown }).data
      if (!dataValue || typeof dataValue !== 'object') {
        return {
          ok: false as const,
          reason: 'invalid-json',
          detail: 'Missing data in GraphQL response',
        }
      }

      const repositoryValue = (dataValue as { repository?: unknown }).repository
      if (!repositoryValue || typeof repositoryValue !== 'object') {
        return {
          ok: false as const,
          reason: 'http-error',
          status: response.status,
          detail: 'Repository not found in GraphQL response',
        }
      }

      const pullRequestValue = (repositoryValue as { pullRequest?: unknown }).pullRequest
      if (!pullRequestValue || typeof pullRequestValue !== 'object') {
        return {
          ok: false as const,
          reason: 'http-error',
          status: response.status,
          detail: 'Pull request not found in GraphQL response',
        }
      }

      const reviewThreadsValue = (pullRequestValue as { reviewThreads?: unknown }).reviewThreads
      if (!reviewThreadsValue || typeof reviewThreadsValue !== 'object') {
        return {
          ok: false as const,
          reason: 'invalid-json',
          detail: 'Missing reviewThreads connection in GraphQL response',
        }
      }

      const nodeList = Array.isArray((reviewThreadsValue as { nodes?: unknown }).nodes)
        ? ((reviewThreadsValue as { nodes: unknown[] }).nodes as unknown[])
        : []

      for (const node of nodeList) {
        if (!node || typeof node !== 'object') {
          continue
        }

        const isResolved = (node as { isResolved?: unknown }).isResolved === true
        if (isResolved) {
          continue
        }

        const commentsValue = (node as { comments?: unknown }).comments
        let summary: string | null = null
        let author: string | undefined
        let commentUrl: string | undefined

        if (commentsValue && typeof commentsValue === 'object') {
          const commentNodes = (commentsValue as { nodes?: unknown }).nodes
          const latestComment =
            Array.isArray(commentNodes) && commentNodes.length > 0 ? commentNodes[commentNodes.length - 1] : null

          if (latestComment && typeof latestComment === 'object') {
            const bodyValue =
              (latestComment as { bodyText?: unknown }).bodyText ?? (latestComment as { body?: unknown }).body ?? null
            const summaryCandidate = summarizeText(bodyValue)
            if (summaryCandidate) {
              summary = summaryCandidate
            }

            const authorValue = (latestComment as { author?: unknown }).author
            if (authorValue && typeof authorValue === 'object') {
              const loginValue = (authorValue as { login?: unknown }).login
              if (typeof loginValue === 'string' && loginValue.trim().length > 0) {
                author = loginValue
              }
            }

            const urlValue = (latestComment as { url?: unknown }).url
            if (typeof urlValue === 'string' && urlValue.trim().length > 0) {
              commentUrl = urlValue
            }
          }
        }

        if (!summary) {
          summary = summarizeText((node as { path?: unknown }).path, 160)
        }

        threads.push({
          summary: summary ?? 'Review thread requires attention.',
          url: commentUrl,
          author,
        })
      }

      const pageInfoValue = (reviewThreadsValue as { pageInfo?: unknown }).pageInfo
      let hasNextPage = false
      let nextCursor: string | null = null

      if (pageInfoValue && typeof pageInfoValue === 'object') {
        hasNextPage = (pageInfoValue as { hasNextPage?: unknown }).hasNextPage === true
        const cursorValue = (pageInfoValue as { endCursor?: unknown }).endCursor
        if (typeof cursorValue === 'string' && cursorValue.trim().length > 0) {
          nextCursor = cursorValue
        }
      }

      if (!hasNextPage || !nextCursor) {
        break
      }

      if (cursor === nextCursor) {
        break
      }

      cursor = nextCursor
    }

    return {
      ok: true as const,
      threads,
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed<ListReviewThreadsResult>({
        ok: false,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
  )
}

export const listPullRequestCheckFailures = (
  options: ListCheckFailuresOptions,
): Effect.Effect<ListCheckFailuresResult> => {
  const {
    repositoryFullName,
    headSha,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : null,
  } = options

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const checkRunsUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/check-runs`
  const commitStatusUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/status`

  const failureMap = new Map<string, PullRequestCheckFailure>()
  const recordFailure = (failure: PullRequestCheckFailure) => {
    const key = `${failure.name}|${failure.url ?? ''}`
    if (!failureMap.has(key)) {
      failureMap.set(key, failure)
    } else {
      const existing = failureMap.get(key)
      if (existing && !existing.details && failure.details) {
        failureMap.set(key, { ...existing, details: failure.details })
      }
    }
  }

  const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'cancelled', 'stale'])
  const failureStates = new Set(['failure', 'error'])

  return Effect.gen(function* (_) {
    let page = 1

    while (true) {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchFn(`${checkRunsUrl}?per_page=100&page=${page}`, {
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': userAgent,
              ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
            },
          }),
        catch: toError,
      })

      if (!response.ok) {
        const detail = yield* readResponseText(response).pipe(
          Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
        )
        return {
          ok: false as const,
          reason: 'http-error',
          status: response.status,
          detail,
        }
      }

      const bodyResult = yield* readResponseText(response).pipe(Effect.either)
      if (bodyResult._tag === 'Left') {
        return {
          ok: false as const,
          reason: 'network-error',
          detail: bodyResult.left.message,
        }
      }

      let parsed: unknown
      try {
        parsed = bodyResult.right.length === 0 ? {} : JSON.parse(bodyResult.right)
      } catch (error) {
        return {
          ok: false as const,
          reason: 'invalid-json',
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      const checkRunsValue = (parsed as { check_runs?: unknown }).check_runs
      const checkRuns = Array.isArray(checkRunsValue) ? checkRunsValue : []

      for (const run of checkRuns) {
        if (!run || typeof run !== 'object') {
          continue
        }
        const name = (run as { name?: unknown }).name
        const conclusion = (run as { conclusion?: unknown }).conclusion
        const status = (run as { status?: unknown }).status

        if (typeof name !== 'string' || typeof status !== 'string') {
          continue
        }

        const normalizedConclusion = typeof conclusion === 'string' ? conclusion : undefined
        const detailsUrlValue = (run as { details_url?: unknown }).details_url
        const htmlUrlValue = (run as { html_url?: unknown }).html_url
        const detailsUrl =
          typeof detailsUrlValue === 'string'
            ? detailsUrlValue
            : typeof htmlUrlValue === 'string'
              ? htmlUrlValue
              : undefined
        const outputValue = (run as { output?: unknown }).output
        let details: string | undefined
        if (outputValue && typeof outputValue === 'object') {
          const summary = summarizeText((outputValue as { summary?: unknown }).summary, 240)
          const title = summarizeText((outputValue as { title?: unknown }).title, 240)
          details = summary ?? title ?? undefined
        }

        const isFailure =
          (status === 'completed' && normalizedConclusion && failureConclusions.has(normalizedConclusion)) ||
          (status === 'completed' && !normalizedConclusion) ||
          (status !== 'completed' && failureConclusions.has(normalizedConclusion ?? ''))

        if (isFailure) {
          recordFailure({
            name,
            conclusion: normalizedConclusion ?? status,
            url: detailsUrl,
            details,
          })
        }
      }

      if (checkRuns.length < 100) {
        break
      }

      page += 1
    }

    const statusResponse = yield* Effect.tryPromise({
      try: () =>
        fetchFn(commitStatusUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
            ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
          },
        }),
      catch: toError,
    })

    if (!statusResponse.ok) {
      const detail = yield* readResponseText(statusResponse).pipe(
        Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
      )
      return {
        ok: false as const,
        reason: 'http-error',
        status: statusResponse.status,
        detail,
      }
    }

    const statusBodyResult = yield* readResponseText(statusResponse).pipe(Effect.either)
    if (statusBodyResult._tag === 'Left') {
      return {
        ok: false as const,
        reason: 'network-error',
        detail: statusBodyResult.left.message,
      }
    }

    let statusParsed: unknown
    try {
      statusParsed = statusBodyResult.right.length === 0 ? {} : JSON.parse(statusBodyResult.right)
    } catch (error) {
      return {
        ok: false as const,
        reason: 'invalid-json',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const statusesValue = (statusParsed as { statuses?: unknown }).statuses
    const statuses = Array.isArray(statusesValue) ? statusesValue : []

    for (const statusEntry of statuses) {
      if (!statusEntry || typeof statusEntry !== 'object') {
        continue
      }
      const state = (statusEntry as { state?: unknown }).state
      const context = (statusEntry as { context?: unknown }).context
      if (typeof state !== 'string' || typeof context !== 'string') {
        continue
      }
      if (!failureStates.has(state)) {
        continue
      }

      const targetUrlValue = (statusEntry as { target_url?: unknown }).target_url
      const descriptionValue = (statusEntry as { description?: unknown }).description

      recordFailure({
        name: context,
        conclusion: state,
        url: typeof targetUrlValue === 'string' ? targetUrlValue : undefined,
        details: summarizeText(descriptionValue, 240) ?? undefined,
      })
    }

    return {
      ok: true as const,
      checks: Array.from(failureMap.values()),
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed<ListCheckFailuresResult>({
        ok: false,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
  )
}

export interface GithubServiceDefinition {
  readonly postIssueReaction: (options: PostIssueReactionOptions) => Effect.Effect<PostIssueReactionResult>
  readonly findLatestPlanComment: (options: FindPlanCommentOptions) => Effect.Effect<FindPlanCommentResult>
  readonly fetchPullRequest: (options: FetchPullRequestOptions) => Effect.Effect<FetchPullRequestResult>
  readonly markPullRequestReadyForReview: (options: ReadyForReviewOptions) => Effect.Effect<ReadyForReviewResult>
  readonly createPullRequestComment: (
    options: CreatePullRequestCommentOptions,
  ) => Effect.Effect<CreatePullRequestCommentResult>
  readonly listPullRequestReviewThreads: (options: ListReviewThreadsOptions) => Effect.Effect<ListReviewThreadsResult>
  readonly listPullRequestCheckFailures: (options: ListCheckFailuresOptions) => Effect.Effect<ListCheckFailuresResult>
}

export class GithubService extends Effect.Tag('@froussard/GithubService')<GithubService, GithubServiceDefinition>() {}

export const GithubServiceLayer = Layer.sync(GithubService, () => ({
  postIssueReaction,
  findLatestPlanComment,
  fetchPullRequest,
  markPullRequestReadyForReview,
  createPullRequestComment,
  listPullRequestReviewThreads,
  listPullRequestCheckFailures,
}))
