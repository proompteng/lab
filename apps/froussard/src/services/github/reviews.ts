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
  FetchInit,
  FetchLike,
  FetchResponse,
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

interface ReviewApiErrorHttp {
  readonly type: 'http-error'
  readonly status: number
  readonly detail?: string
}

interface ReviewApiErrorNetwork {
  readonly type: 'network-error'
  readonly detail: string
}

interface ReviewApiErrorInvalidJson {
  readonly type: 'invalid-json'
  readonly detail?: string
}

interface ReviewApiErrorNoFetch {
  readonly type: 'no-fetch'
}

interface ReviewApiErrorInvalidRepo {
  readonly type: 'invalid-repository'
  readonly detail: string
}

type ReviewApiError =
  | ReviewApiErrorHttp
  | ReviewApiErrorNetwork
  | ReviewApiErrorInvalidJson
  | ReviewApiErrorNoFetch
  | ReviewApiErrorInvalidRepo

const toNetworkError = (error: unknown): ReviewApiErrorNetwork => ({
  type: 'network-error',
  detail: error instanceof Error ? error.message : String(error),
})

const toInvalidJson = (error: unknown): ReviewApiErrorInvalidJson => ({
  type: 'invalid-json',
  detail: error instanceof Error ? error.message : String(error),
})

const parseRepository = (fullName: string) =>
  Effect.suspend(() => {
    const [owner, repo] = fullName.split('/')
    if (!owner || !repo) {
      return Effect.fail<ReviewApiError>({ type: 'invalid-repository', detail: fullName })
    }
    return Effect.succeed({ owner, repo })
  })

const ensureFetch = (fetchFn: FetchLike | null | undefined) =>
  fetchFn ? Effect.succeed(fetchFn) : Effect.fail<ReviewApiError>({ type: 'no-fetch' })

const readText = (response: FetchResponse) => readResponseText(response).pipe(Effect.mapError(toNetworkError))

const parseJson = (text: string) =>
  Effect.try({
    try: () => (text.length === 0 ? {} : JSON.parse(text)),
    catch: (error) => toInvalidJson(error),
  })

const requestJson = (fetchFn: FetchLike, input: string, init: FetchInit): Effect.Effect<unknown, ReviewApiError> =>
  Effect.tryPromise({
    try: () => fetchFn(input, init),
    catch: toError,
  })
    .pipe(Effect.mapError(toNetworkError))
    .pipe(
      Effect.flatMap((response) =>
        response.ok
          ? readText(response).pipe(Effect.flatMap(parseJson))
          : readText(response)
              .pipe(Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)))
              .pipe(
                Effect.flatMap((detail) =>
                  Effect.fail<ReviewApiError>({
                    type: 'http-error',
                    status: response.status,
                    detail,
                  }),
                ),
              ),
      ),
    )

const mapThreadError = (error: ReviewApiError): ListReviewThreadsResult => {
  switch (error.type) {
    case 'invalid-repository':
      return { ok: false, reason: 'invalid-repository', detail: error.detail }
    case 'no-fetch':
      return { ok: false, reason: 'no-fetch' }
    case 'network-error':
      return { ok: false, reason: 'network-error', detail: error.detail }
    case 'http-error':
      return { ok: false, reason: 'http-error', status: error.status, detail: error.detail }
    default:
      return { ok: false, reason: 'invalid-json', detail: error.detail }
  }
}

const mapCheckError = (error: ReviewApiError): ListCheckFailuresResult => {
  switch (error.type) {
    case 'invalid-repository':
      return { ok: false, reason: 'invalid-repository', detail: error.detail }
    case 'no-fetch':
      return { ok: false, reason: 'no-fetch' }
    case 'network-error':
      return { ok: false, reason: 'network-error', detail: error.detail }
    case 'http-error':
      return { ok: false, reason: 'http-error', status: error.status, detail: error.detail }
    default:
      return { ok: false, reason: 'invalid-json', detail: error.detail }
  }
}

const threadsFromNodes = (nodes: Schema.Schema.Type<typeof ReviewThreadNodeSchema>[]): PullRequestReviewThread[] =>
  nodes
    .filter((node) => !node?.isResolved)
    .map((node) => {
      const comments = node?.comments?.nodes ?? []
      const latest = comments.length > 0 ? comments[comments.length - 1] : undefined
      let summaryText = summarizeText(latest?.bodyText) ?? summarizeText(node?.path, 160)
      if (!summaryText) {
        summaryText = 'Review thread requires attention.'
      }
      const author = latest?.author?.login?.trim()
      const url = latest?.url ?? undefined
      return {
        summary: summaryText,
        author: author && author.length > 0 ? author : undefined,
        url: url && url.length > 0 ? url : undefined,
      }
    })

const fetchThreadsPage = (
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
): Effect.Effect<{ items: PullRequestReviewThread[]; nextCursor: string | null }, ReviewApiError> =>
  requestJson(fetchFn, url, {
    method: 'POST',
    headers,
    body,
  }).pipe(
    Effect.flatMap((parsed) => decodeReviewThreadsResponse(parsed).pipe(Effect.mapError(toInvalidJson))),
    Effect.flatMap((decoded) => {
      if (decoded.errors && decoded.errors.length > 0) {
        const message = decoded.errors[0]?.message ?? 'GitHub GraphQL returned errors'
        return Effect.fail<ReviewApiError>({ type: 'http-error', status: 200, detail: message })
      }

      const connection = decoded.data?.repository?.pullRequest?.reviewThreads
      const nodes = Array.isArray(connection?.nodes) ? connection?.nodes : []
      const items = threadsFromNodes(nodes)
      const endCursor = connection?.pageInfo?.endCursor
      const nextCursor = typeof endCursor === 'string' && endCursor.length > 0 ? endCursor : null
      const hasNext = Boolean(connection?.pageInfo?.hasNextPage && nextCursor)

      return Effect.succeed({ items, nextCursor: hasNext ? nextCursor : null })
    }),
  )

const collectReviewThreads = (
  fetchFn: FetchLike,
  graphqlUrl: string,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  pullNumber: number,
): Effect.Effect<PullRequestReviewThread[], ReviewApiError> =>
  Effect.gen(function* (_) {
    let cursor: string | null = null
    const accumulator: PullRequestReviewThread[] = []

    while (true) {
      const page: { items: PullRequestReviewThread[]; nextCursor: string | null } = yield* fetchThreadsPage(
        fetchFn,
        graphqlUrl,
        headers,
        JSON.stringify({
          query: LIST_REVIEW_THREADS_QUERY,
          variables: cursor ? { owner, repo, pullNumber, cursor } : { owner, repo, pullNumber },
        }),
      )
      const { items, nextCursor } = page

      accumulator.push(...items)

      if (!nextCursor) {
        break
      }

      cursor = nextCursor
    }

    return accumulator
  })

const recordCheckRunFailures = (runs: unknown[], record: (failure: PullRequestCheckFailure) => void) => {
  for (const run of runs) {
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

    const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'cancelled', 'stale'])

    const isFailure =
      (status === 'completed' && normalizedConclusion && failureConclusions.has(normalizedConclusion)) ||
      (status === 'completed' && !normalizedConclusion) ||
      (status !== 'completed' && failureConclusions.has(normalizedConclusion ?? ''))

    if (isFailure) {
      record({
        name,
        conclusion: normalizedConclusion ?? status,
        url: detailsUrl,
        details,
      })
    }
  }
}

const collectCheckFailures = (
  fetchFn: FetchLike,
  checkRunsUrl: string,
  commitStatusUrl: string,
  headers: Record<string, string>,
): Effect.Effect<PullRequestCheckFailure[], ReviewApiError> =>
  Effect.gen(function* (_) {
    const failureMap = new Map<string, PullRequestCheckFailure>()
    const recordFailure = (failure: PullRequestCheckFailure) => {
      failureMap.set(failure.name, failure)
    }

    const fetchCheckRunsPage = (page: number): Effect.Effect<boolean, ReviewApiError> =>
      requestJson(fetchFn, `${checkRunsUrl}${page}`, { method: 'GET', headers }).pipe(
        Effect.map((parsed) =>
          Array.isArray((parsed as { check_runs?: unknown }).check_runs)
            ? ((parsed as { check_runs: unknown[] }).check_runs as unknown[])
            : [],
        ),
        Effect.map((runs) => {
          recordCheckRunFailures(runs, recordFailure)
          return runs.length === 100
        }),
      )

    let page = 1
    while (true) {
      const hasMore = yield* fetchCheckRunsPage(page)
      if (!hasMore) {
        break
      }
      page += 1
    }

    const statusesResponse = yield* requestJson(fetchFn, commitStatusUrl, { method: 'GET', headers }).pipe(
      Effect.map((parsed) =>
        Array.isArray((parsed as { statuses?: unknown }).statuses)
          ? ((parsed as { statuses: unknown[] }).statuses as unknown[])
          : [],
      ),
    )

    const failureStates = new Set(['failure', 'error'])
    for (const statusEntry of statusesResponse) {
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

    return Array.from(failureMap.values())
  })

export const listPullRequestReviewThreads = (
  options: ListReviewThreadsOptions,
): Effect.Effect<ListReviewThreadsResult> => {
  const {
    repositoryFullName,
    pullNumber,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation,
  } = options

  const effectiveFetch = fetchImplementation ?? globalFetch

  return Effect.gen(function* (_) {
    const { owner, repo } = yield* parseRepository(repositoryFullName)
    const fetchFn = yield* ensureFetch(effectiveFetch)
    const graphqlUrl = resolveGitHubGraphqlUrl(apiBaseUrl)
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
      ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
    }

    const threads = yield* collectReviewThreads(fetchFn, graphqlUrl, headers, owner, repo, pullNumber)
    return threads
  }).pipe(
    Effect.map((threads) => ({ ok: true as const, threads })),
    Effect.catchAll((error) => Effect.succeed(mapThreadError(error))),
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
    fetchImplementation,
  } = options

  const effectiveFetch = fetchImplementation ?? globalFetch

  return Effect.gen(function* (_) {
    const { owner, repo } = yield* parseRepository(repositoryFullName)
    const fetchFn = yield* ensureFetch(effectiveFetch)

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
      ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
    }

    const checkRunsUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100&page=`
    const commitStatusUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/status`

    const failures = yield* collectCheckFailures(fetchFn, checkRunsUrl, commitStatusUrl, headers)
    return failures
  }).pipe(
    Effect.map((checks) => ({ ok: true as const, checks })),
    Effect.catchAll((error) => Effect.succeed(mapCheckError(error))),
  )
}
