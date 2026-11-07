import { defaultFetch as globalFetch } from './common'
import { Effect, Schema } from 'effect'

import { DEFAULT_API_BASE_URL, DEFAULT_USER_AGENT, readResponseText, toError, trimTrailingSlash } from './common'
import type {
  FetchLike,
  FetchPullRequestOptions,
  FetchPullRequestResult,
  PullRequestSummary,
  ReadyForReviewOptions,
  ReadyForReviewResult,
} from './types'

const GitHubPullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  state: Schema.String,
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changed_files: Schema.optional(Schema.Number),
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
  base: Schema.Struct({
    ref: Schema.String,
  }),
  user: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
})

const decodePullRequest = Schema.decodeUnknownEffect(GitHubPullRequestSchema)

const GitHubPullRequestNodeSchema = Schema.Struct({
  node_id: Schema.String,
})

const decodePullRequestNode = Schema.decodeUnknownEffect(GitHubPullRequestNodeSchema)

export const fetchPullRequest = (options: FetchPullRequestOptions): Effect.Effect<FetchPullRequestResult> => {
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
        Effect.gen(function* () {
          if (!response.ok) {
            const detail = yield* readResponseText(response).pipe(
              Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
            )
            return {
              ok: false as const,
              reason: response.status === 404 ? 'not-found' : 'http-error',
              status: response.status,
              detail,
            }
          }

          const bodyResult = yield* readResponseText(response).pipe(Effect.result)
          if (bodyResult._tag === 'Failure') {
            return {
              ok: false as const,
              reason: 'network-error',
              detail: bodyResult.failure.message,
            }
          }

          let parsed: PullRequestSummary
          try {
            const raw = bodyResult.success.length === 0 ? {} : JSON.parse(bodyResult.success)
            const decodedResult = yield* decodePullRequest(raw).pipe(Effect.result)
            if (decodedResult._tag === 'Failure') {
              return {
                ok: false as const,
                reason: 'invalid-pull-request',
                detail: String(decodedResult.failure),
              }
            }
            const decoded = decodedResult.success
            parsed = {
              number: decoded.number,
              title: decoded.title,
              body: decoded.body ?? '',
              htmlUrl: decoded.html_url,
              draft: decoded.draft,
              merged: decoded.merged,
              state: decoded.state,
              additions: decoded.additions ?? 0,
              deletions: decoded.deletions ?? 0,
              changedFiles: decoded.changed_files ?? 0,
              headRef: decoded.head.ref,
              headSha: decoded.head.sha,
              baseRef: decoded.base.ref,
              authorLogin: decoded.user?.login ?? null,
              mergeableState: decoded.mergeable_state ?? null,
            }
          } catch (error) {
            return {
              ok: false as const,
              reason: 'invalid-pull-request',
              detail: error instanceof Error ? error.message : String(error),
            }
          }

          return { ok: true as const, pullRequest: parsed }
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
    fetchImplementation = globalFetch,
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

  const pullUrl = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/pulls/${pullNumber}`

  return Effect.gen(function* () {
    const pullResponseResult = yield* Effect.tryPromise({
      try: () =>
        fetchFn(pullUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${token}`,
            'User-Agent': userAgent,
          },
        }),
      catch: toError,
    }).pipe(Effect.result)

    if (pullResponseResult._tag === 'Failure') {
      const error = pullResponseResult.failure
      return {
        ok: false as const,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const pullResponse = pullResponseResult.success
    if (!pullResponse.ok) {
      const detail = yield* readResponseText(pullResponse).pipe(
        Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
      )

      return {
        ok: false as const,
        reason: 'http-error',
        status: pullResponse.status,
        detail,
      }
    }

    const pullBodyResult = yield* readResponseText(pullResponse).pipe(Effect.result)
    if (pullBodyResult._tag === 'Failure') {
      return {
        ok: false as const,
        reason: 'network-error',
        detail: pullBodyResult.failure.message,
      }
    }

    let nodeId: string
    try {
      const raw = pullBodyResult.success.length === 0 ? {} : JSON.parse(pullBodyResult.success)
      const decodedResult = yield* decodePullRequestNode(raw).pipe(Effect.result)
      if (decodedResult._tag === 'Failure') {
        return {
          ok: false as const,
          reason: 'network-error',
          detail: String(decodedResult.failure),
        }
      }
      nodeId = decodedResult.success.node_id
    } catch (error) {
      return {
        ok: false as const,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const url = `${trimTrailingSlash(apiBaseUrl)}/graphql`
    const mutation = `
      mutation MarkReady($input: MarkPullRequestReadyForReviewInput!) {
        markPullRequestReadyForReview(input: $input) {
          pullRequest {
            id
          }
        }
      }
    `

    const payload = JSON.stringify({
      query: mutation,
      variables: {
        input: {
          pullRequestId: nodeId,
          clientMutationId: `ready-${pullNumber}`,
        },
      },
    })

    const responseResult = yield* Effect.tryPromise({
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
          body: payload,
        }),
      catch: toError,
    }).pipe(Effect.result)

    if (responseResult._tag === 'Failure') {
      const error = responseResult.failure
      return {
        ok: false as const,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const response = responseResult.success
    if (response.ok) {
      return { ok: true as const }
    }

    const detail = yield* readResponseText(response).pipe(
      Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
    )

    return {
      ok: false as const,
      reason: response.status === 404 ? 'invalid-repository' : 'http-error',
      status: response.status,
      detail,
    }
  })
}
