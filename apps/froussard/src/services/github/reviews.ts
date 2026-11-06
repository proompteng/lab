import type { ApprovePullRequestOptions, ApprovePullRequestResult } from './types'
import { Effect, Schema } from 'effect'
import { fetchPullRequest } from './pull-requests'

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
  ListBlockingChecksOptions,
  ListCommitPullRequestsResult,
  ListBlockingChecksResult,
  ListReviewThreadsOptions,
  ListReviewThreadsResult,
  PullRequestBlockingCheck,
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
  bodyText: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})

const ReviewThreadNodeSchema = Schema.Struct({
  isResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(ReviewThreadCommentSchema))),
      }),
    ),
  ),
})

const ReviewThreadsResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    reviewThreads: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.optional(Schema.NullOr(Schema.Array(ReviewThreadNodeSchema))),
                          pageInfo: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
                                endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                              }),
                            ),
                          ),
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
  errors: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) }))),
  ),
})

const decodeReviewThreadsResponse = Schema.decodeUnknownEffect(ReviewThreadsResponseSchema)

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
              .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
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

const mapCheckError = (error: ReviewApiError): ListBlockingChecksResult => {
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

const threadsFromNodes = (nodes: (typeof ReviewThreadNodeSchema.Type)[]): PullRequestReviewThread[] =>
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
  Effect.gen(function* () {
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

const CheckRunsSchema = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      details_url: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})
const CommitStatusesSchema = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({
      context: Schema.String,
      state: Schema.String,
      target_url: Schema.optional(Schema.NullOr(Schema.String)),
      description: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

const collectBlockingChecks = (
  fetchFn: FetchLike,
  checkRunsUrl: string,
  commitStatusUrl: string,
  headers: Record<string, string>,
): Effect.Effect<PullRequestBlockingCheck[], ReviewApiError> =>
  Effect.gen(function* () {
    const blocked: PullRequestBlockingCheck[] = []
    let observed = 0
    for (let page = 1; ; page++) {
      const { check_runs: runs } = yield* requestJson(fetchFn, `${checkRunsUrl}${page}`, { headers }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(CheckRunsSchema)(value).pipe(Effect.mapError(toInvalidJson)),
        ),
      )
      observed += runs.length
      for (const run of runs) {
        if (run.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')) {
          blocked.push({ name: run.name, conclusion: run.conclusion ?? run.status, url: run.details_url ?? undefined })
        }
      }
      if (runs.length < 100) break
    }
    for (let page = 1; ; page++) {
      const { statuses } = yield* requestJson(fetchFn, `${commitStatusUrl}?per_page=100&page=${page}`, {
        headers,
      }).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(CommitStatusesSchema)(value).pipe(Effect.mapError(toInvalidJson)),
        ),
      )
      observed += statuses.length
      for (const status of statuses) {
        if (status.state !== 'success') {
          blocked.push({
            name: status.context,
            conclusion: status.state,
            url: status.target_url ?? undefined,
            details: summarizeText(status.description, 240) ?? undefined,
          })
        }
      }
      if (statuses.length < 100) break
    }
    if (observed === 0)
      blocked.push({ name: 'CI', conclusion: 'pending', details: 'No checks have been reported for this commit' })
    return blocked
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

  return Effect.gen(function* () {
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
    Effect.catch((error) => Effect.succeed(mapThreadError(error))),
  )
}

export const listPullRequestBlockingChecks = (
  options: ListBlockingChecksOptions,
): Effect.Effect<ListBlockingChecksResult> => {
  const {
    repositoryFullName,
    headSha,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation,
  } = options

  const effectiveFetch = fetchImplementation ?? globalFetch

  return Effect.gen(function* () {
    const { owner, repo } = yield* parseRepository(repositoryFullName)
    const fetchFn = yield* ensureFetch(effectiveFetch)

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
      ...(token && token.trim().length > 0 ? { Authorization: `Bearer ${token}` } : {}),
    }

    const checkRunsUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/check-runs?filter=latest&per_page=100&page=`
    const commitStatusUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/commits/${headSha}/status`

    const failures = yield* collectBlockingChecks(fetchFn, checkRunsUrl, commitStatusUrl, headers)
    return failures
  }).pipe(
    Effect.map((checks) => ({ ok: true as const, checks })),
    Effect.catch((error) => Effect.succeed(mapCheckError(error))),
  )
}

const AutomationReviewSchema = Schema.Struct({
  id: Schema.Number,
  user: Schema.Struct({ login: Schema.String }),
  state: Schema.String,
  commit_id: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
})
const AutomationCommentSchema = Schema.Struct({
  user: Schema.Struct({ login: Schema.String }),
  body: Schema.String,
})
const CodexReviewStateSchema = Schema.Struct({
  code_review: Schema.Struct({
    commit_sha: Schema.String,
    status: Schema.String,
    has_unresolved_findings: Schema.NullOr(Schema.Boolean),
  }),
})
type ApprovalError =
  | ReviewApiError
  | {
      type: 'missing-token' | 'identity-mismatch' | 'not-ready' | 'head-changed' | 'pending-review'
      detail: string
    }

/** A submitted review is the durable receipt for this actor and checked commit. */
export const approvePullRequest = (options: ApprovePullRequestOptions): Effect.Effect<ApprovePullRequestResult> =>
  Effect.gen(function* () {
    if (!options.token?.trim())
      return yield* Effect.fail<ApprovalError>({
        type: 'missing-token',
        detail: 'Approval requires the tuslagch token',
      })
    const { owner, repo } = yield* parseRepository(options.repositoryFullName)
    const fetchFn = yield* ensureFetch(options.fetchImplementation ?? globalFetch)
    const base = trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL)
    const headers = {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
      Authorization: `Bearer ${options.token}`,
    }
    const identity = yield* requestJson(fetchFn, `${base}/user`, { headers }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Schema.Struct({ login: Schema.String }))(value).pipe(Effect.mapError(toInvalidJson)),
      ),
    )
    if (identity.login.toLowerCase() !== 'tuslagch')
      return yield* Effect.fail<ApprovalError>({
        type: 'identity-mismatch',
        detail: 'Froussard approval requires the tuslagch identity',
      })
    const pull = yield* fetchPullRequest({ ...options, fetchImplementation: fetchFn })
    if (
      !pull.ok ||
      pull.pullRequest.state !== 'open' ||
      pull.pullRequest.merged ||
      pull.pullRequest.draft ||
      pull.pullRequest.authorLogin?.toLowerCase() === 'tuslagch'
    )
      return yield* Effect.fail<ApprovalError>({
        type: 'not-ready',
        detail: 'Pull request is unavailable, closed, a draft, or owned by tuslagch',
      })
    if (pull.pullRequest.headSha !== options.headSha)
      return yield* Effect.fail<ApprovalError>({
        type: 'head-changed',
        detail: 'Pull request head changed after readiness checks',
      })
    const prefix = `${base}/repos/${owner}/${repo}`
    let verifiedReview = false
    for (let page = 1; ; page++) {
      const comments = yield* requestJson(
        fetchFn,
        `${prefix}/issues/${options.pullNumber}/comments?per_page=100&page=${page}`,
        { headers },
      ).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(Schema.Array(AutomationCommentSchema))(value).pipe(Effect.mapError(toInvalidJson)),
        ),
      )
      for (const comment of comments) {
        if (comment.user.login !== 'chatgpt-codex-connector[bot]') continue
        const state = /<!-- codex-review-state:v1 ([\s\S]*?) -->/.exec(comment.body)?.[1]
        if (state === undefined) continue
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CodexReviewStateSchema))(state).pipe(
          Effect.mapError(toInvalidJson),
        )
        verifiedReview =
          decoded.code_review.commit_sha === options.headSha &&
          decoded.code_review.status === 'completed' &&
          decoded.code_review.has_unresolved_findings === false
      }
      if (comments.length < 100) break
    }
    if (!verifiedReview)
      return yield* Effect.fail<ApprovalError>({
        type: 'not-ready',
        detail: 'Current commit has no completed Codex review without unresolved findings',
      })

    const reviewsUrl = `${prefix}/pulls/${options.pullNumber}/reviews`
    const readReviews = Effect.gen(function* () {
      const reviews: Array<typeof AutomationReviewSchema.Type> = []
      for (let page = 1; ; page++) {
        const rows = yield* requestJson(fetchFn, `${reviewsUrl}?per_page=100&page=${page}`, { headers }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Schema.Array(AutomationReviewSchema))(value).pipe(
              Effect.mapError(toInvalidJson),
            ),
          ),
        )
        reviews.push(...rows.filter((review) => review.user.login.toLowerCase() === 'tuslagch'))
        if (rows.length < 100) return reviews
      }
    })
    const approved = (reviews: readonly (typeof AutomationReviewSchema.Type)[]) => {
      const latest = reviews.findLast((review) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
      return latest?.state === 'APPROVED' && latest.commit_id === options.headSha ? latest : undefined
    }
    let reviews = yield* readReviews
    const existing = approved(reviews)
    if (existing !== undefined) return { ok: true as const, reviewUrl: existing.html_url }
    let pending = reviews.find((review) => review.state === 'PENDING')
    if (pending && pending.commit_id !== options.headSha && pending.body === options.body) {
      // Only discard this automation's obsolete draft, never another review's work.
      yield* requestJson(fetchFn, `${reviewsUrl}/${pending.id}`, { method: 'DELETE', headers })
      pending = undefined
    }
    if (pending === undefined) {
      // GitHub permits one pending review per actor/PR, arbitrating concurrent deliveries.
      const created = yield* requestJson(fetchFn, reviewsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ commit_id: options.headSha, body: options.body }),
      }).pipe(Effect.result)
      if (created._tag === 'Success') {
        pending = yield* Schema.decodeUnknownEffect(AutomationReviewSchema)(created.success).pipe(
          Effect.mapError(toInvalidJson),
        )
      } else {
        reviews = yield* readReviews
        const reconciled = approved(reviews)
        if (reconciled !== undefined) return { ok: true as const, reviewUrl: reconciled.html_url }
        pending = reviews.find((review) => review.state === 'PENDING')
        if (pending === undefined) return yield* Effect.fail(created.failure)
      }
    }
    if (pending.commit_id !== options.headSha || pending.body !== options.body)
      return yield* Effect.fail<ApprovalError>({
        type: 'pending-review',
        detail: 'An unrelated pending review must not be submitted by readiness automation',
      })
    const reconciled = approved(yield* readReviews)
    if (reconciled !== undefined) {
      yield* requestJson(fetchFn, `${reviewsUrl}/${pending.id}`, { method: 'DELETE', headers }).pipe(Effect.ignore)
      return { ok: true as const, reviewUrl: reconciled.html_url }
    }
    const latestPull = yield* fetchPullRequest({ ...options, fetchImplementation: fetchFn })
    if (
      !latestPull.ok ||
      latestPull.pullRequest.headSha !== options.headSha ||
      latestPull.pullRequest.state !== 'open' ||
      latestPull.pullRequest.draft
    ) {
      yield* requestJson(fetchFn, `${reviewsUrl}/${pending.id}`, { method: 'DELETE', headers })
      return yield* Effect.fail<ApprovalError>({
        type: 'head-changed',
        detail: 'Pull request changed before approval submission',
      })
    }
    const submitted = yield* requestJson(fetchFn, `${reviewsUrl}/${pending.id}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'APPROVE', body: options.body }),
    }).pipe(Effect.result)
    if (submitted._tag === 'Failure') {
      const reconciled = approved(yield* readReviews)
      if (reconciled !== undefined) return { ok: true as const, reviewUrl: reconciled.html_url }
      return yield* Effect.fail(submitted.failure)
    }
    const review = yield* Schema.decodeUnknownEffect(AutomationReviewSchema)(submitted.success).pipe(
      Effect.mapError(toInvalidJson),
    )
    if (
      review.state !== 'APPROVED' ||
      review.commit_id !== options.headSha ||
      review.user.login.toLowerCase() !== 'tuslagch'
    )
      return yield* Effect.fail<ApprovalError>({
        type: 'not-ready',
        detail: 'GitHub did not return the requested approval identity and commit',
      })
    return { ok: true as const, reviewUrl: review.html_url }
  }).pipe(
    Effect.catch(
      (error): Effect.Effect<ApprovePullRequestResult> =>
        Effect.succeed({
          ok: false,
          reason: error.type,
          ...('status' in error ? { status: error.status } : {}),
          ...('detail' in error ? { detail: error.detail } : {}),
        }),
    ),
  )

export const listCommitPullRequests = (
  options: ListBlockingChecksOptions,
): Effect.Effect<ListCommitPullRequestsResult> =>
  Effect.gen(function* () {
    const { owner, repo } = yield* parseRepository(options.repositoryFullName)
    const fetchFn = yield* ensureFetch(options.fetchImplementation ?? globalFetch)
    const pullNumbers: number[] = []
    const schema = Schema.Array(Schema.Struct({ number: Schema.Number, state: Schema.String }))
    for (let page = 1; ; page++) {
      const pulls = yield* requestJson(
        fetchFn,
        `${trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL)}/repos/${owner}/${repo}/commits/${options.headSha}/pulls?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
        },
      ).pipe(Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(toInvalidJson))))
      pullNumbers.push(...pulls.filter((pull) => pull.state === 'open').map((pull) => pull.number))
      if (pulls.length < 100) break
    }
    return { ok: true as const, pullNumbers }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        reason: error.type,
        ...('status' in error ? { status: error.status } : {}),
        ...('detail' in error ? { detail: error.detail } : {}),
      }),
    ),
  )
