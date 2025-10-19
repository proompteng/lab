import { Effect, Schema } from 'effect'

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_USER_AGENT,
  readResponseText,
  resolveGitHubGraphqlUrl,
  summarizeText,
  toError,
  trimTrailingSlash,
} from './common'
import type {
  FetchLike,
  ListCheckFailuresOptions,
  ListCheckFailuresResult,
  ListReviewThreadsOptions,
  ListReviewThreadsResult,
  PullRequestCheckFailure,
  PullRequestReviewThread,
} from './types'

const globalFetch: FetchLike | null =
  typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : null

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

const ReviewThreadCommentSchema = Schema.Struct({
  bodyText: Schema.optionalWith(Schema.String, { nullable: true }),
  url: Schema.optionalWith(Schema.String, { nullable: true }),
  author: Schema.optionalWith(
    Schema.Struct({
      login: Schema.optionalWith(Schema.String, { nullable: true }),
    }),
    { nullable: true },
  ),
})

const ReviewThreadNodeSchema = Schema.Struct({
  isResolved: Schema.optionalWith(Schema.Boolean, { nullable: true }),
  path: Schema.optionalWith(Schema.String, { nullable: true }),
  comments: Schema.optionalWith(
    Schema.Struct({
      nodes: Schema.optionalWith(Schema.Array(ReviewThreadCommentSchema), { nullable: true }),
    }),
    { nullable: true },
  ),
})

const ReviewThreadsResponseSchema = Schema.Struct({
  data: Schema.optionalWith(
    Schema.Struct({
      repository: Schema.optionalWith(
        Schema.Struct({
          pullRequest: Schema.optionalWith(
            Schema.Struct({
              reviewThreads: Schema.optionalWith(
                Schema.Struct({
                  nodes: Schema.optionalWith(Schema.Array(ReviewThreadNodeSchema), { nullable: true }),
                  pageInfo: Schema.optionalWith(
                    Schema.Struct({
                      hasNextPage: Schema.optionalWith(Schema.Boolean, { nullable: true }),
                      endCursor: Schema.optionalWith(Schema.String, { nullable: true }),
                    }),
                    { nullable: true },
                  ),
                }),
                { nullable: true },
              ),
            }),
            { nullable: true },
          ),
        }),
        { nullable: true },
      ),
    }),
    { nullable: true },
  ),
  errors: Schema.optionalWith(
    Schema.Array(Schema.Struct({ message: Schema.optionalWith(Schema.String, { nullable: true }) })),
    { nullable: true },
  ),
})

const decodeReviewThreadsResponse = Schema.decodeUnknown(ReviewThreadsResponseSchema)

export const listPullRequestReviewThreads = (
  options: ListReviewThreadsOptions,
): Effect.Effect<ListReviewThreadsResult> => {
  const {
    repositoryFullName,
    pullNumber,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = globalFetch,
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
  const summary: PullRequestReviewThread[] = []
  let cursor: string | null = null

  const buildRequestPayload = () =>
    JSON.stringify({
      query: LIST_REVIEW_THREADS_QUERY,
      variables: (() => {
        const variables: Record<string, unknown> = { owner, repo, pullNumber }
        if (cursor) {
          variables.cursor = cursor
        }
        return variables
      })(),
    })

  const fetchThreads = () =>
    fetchFn(graphqlUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': userAgent,
      },
      body: buildRequestPayload(),
    })

  return Effect.gen(function* (_) {
    for (;;) {
      const response = yield* Effect.tryPromise({
        try: fetchThreads,
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

      const textResult = yield* readResponseText(response).pipe(Effect.either)
      if (textResult._tag === 'Left') {
        return {
          ok: false as const,
          reason: 'network-error',
          detail: textResult.left.message,
        }
      }

      let parsed: unknown
      try {
        parsed = textResult.right.length === 0 ? {} : JSON.parse(textResult.right)
      } catch (error) {
        return {
          ok: false as const,
          reason: 'invalid-json',
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { errors?: unknown }).errors) &&
        ((parsed as { errors?: unknown }).errors as Array<{ message?: string }>).length > 0
      ) {
        const [firstError] = (parsed as { errors: Array<{ message?: string }> }).errors
        const message = firstError?.message ?? 'GitHub GraphQL returned errors'
        return {
          ok: false as const,
          reason: 'http-error',
          status: 200,
          detail: message,
        }
      }

      const connection = (
        parsed as {
          data?: {
            repository?: {
              pullRequest?: {
                reviewThreads?: {
                  nodes?: unknown
                  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }
                }
              }
            }
          }
        }
      ).data?.repository?.pullRequest?.reviewThreads

      const nodes = Array.isArray(connection?.nodes) ? connection?.nodes : []
      const pageInfo = connection?.pageInfo

      for (const node of nodes) {
        if (node?.isResolved) {
          continue
        }
        const comments = node?.comments?.nodes ?? []
        const latest = comments.length > 0 ? comments[comments.length - 1] : undefined
        let summaryText = summarizeText(latest?.bodyText) ?? summarizeText(node?.path, 160)
        if (!summaryText) {
          summaryText = 'Review thread requires attention.'
        }
        const author = latest?.author?.login?.trim()
        const url = latest?.url ?? undefined
        summary.push({
          summary: summaryText,
          author: author && author.length > 0 ? author : undefined,
          url: url && url.length > 0 ? url : undefined,
        })
      }

      const hasNextPage =
        pageInfo && typeof pageInfo === 'object' && 'hasNextPage' in pageInfo
          ? Boolean((pageInfo as { hasNextPage?: unknown }).hasNextPage)
          : false
      const nextCursor =
        pageInfo && typeof pageInfo === 'object' && 'endCursor' in pageInfo
          ? (pageInfo as { endCursor?: unknown }).endCursor
          : null

      if (!hasNextPage || typeof nextCursor !== 'string' || nextCursor.length === 0) {
        break
      }
      cursor = nextCursor
    }

    return { ok: true as const, threads: summary }
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
    fetchImplementation = globalFetch,
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

  const checkRunsUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100&page=`
  const commitStatusUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/status`

  const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'cancelled', 'stale'])
  const failureStates = new Set(['failure', 'error'])
  const failureMap = new Map<string, PullRequestCheckFailure>()

  const recordFailure = (failure: PullRequestCheckFailure) => {
    failureMap.set(failure.name, failure)
  }

  return Effect.gen(function* (_) {
    let page = 1

    while (true) {
      const url = `${checkRunsUrl}${page}`
      const response = yield* Effect.tryPromise({
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
