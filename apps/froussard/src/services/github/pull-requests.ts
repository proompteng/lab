import { Effect, Schema } from 'effect'

import { DEFAULT_API_BASE_URL, DEFAULT_USER_AGENT, readResponseText, toError, trimTrailingSlash } from './common'
import type {
  CreatePullRequestCommentOptions,
  CreatePullRequestCommentResult,
  FetchLike,
  FetchPullRequestOptions,
  FetchPullRequestResult,
  PullRequestSummary,
  ReadyForReviewOptions,
  ReadyForReviewResult,
} from './types'

const globalFetch: FetchLike | null =
  typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : null

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

const decodePullRequest = Schema.decodeUnknown(GitHubPullRequestSchema)

const GitHubPullRequestNodeSchema = Schema.Struct({
  node_id: Schema.String,
})

const decodePullRequestNode = Schema.decodeUnknown(GitHubPullRequestNodeSchema)

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
        Effect.gen(function* (_) {
          if (!response.ok) {
            const detail = yield* readResponseText(response).pipe(
              Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
            )
            return {
              ok: false as const,
              reason: response.status === 404 ? 'not-found' : 'http-error',
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

          let parsed: PullRequestSummary
          try {
            const raw = bodyResult.right.length === 0 ? {} : JSON.parse(bodyResult.right)
            const decodedResult = yield* decodePullRequest(raw).pipe(Effect.either)
            if (decodedResult._tag === 'Left') {
              return {
                ok: false as const,
                reason: 'invalid-pull-request',
                detail: String(decodedResult.left),
              }
            }
            const decoded = decodedResult.right
            parsed = {
              number: decoded.number,
              title: decoded.title,
              body: decoded.body ?? '',
              htmlUrl: decoded.html_url,
              draft: decoded.draft,
              merged: decoded.merged,
              state: decoded.state,
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

  return Effect.gen(function* (_) {
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
    }).pipe(Effect.either)

    if (pullResponseResult._tag === 'Left') {
      const error = pullResponseResult.left
      return {
        ok: false as const,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const pullResponse = pullResponseResult.right
    if (!pullResponse.ok) {
      const detail = yield* readResponseText(pullResponse).pipe(
        Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
      )

      return {
        ok: false as const,
        reason: 'http-error',
        status: pullResponse.status,
        detail,
      }
    }

    const pullBodyResult = yield* readResponseText(pullResponse).pipe(Effect.either)
    if (pullBodyResult._tag === 'Left') {
      return {
        ok: false as const,
        reason: 'network-error',
        detail: pullBodyResult.left.message,
      }
    }

    let nodeId: string
    try {
      const raw = pullBodyResult.right.length === 0 ? {} : JSON.parse(pullBodyResult.right)
      const decodedResult = yield* decodePullRequestNode(raw).pipe(Effect.either)
      if (decodedResult._tag === 'Left') {
        return {
          ok: false as const,
          reason: 'network-error',
          detail: String(decodedResult.left),
        }
      }
      nodeId = decodedResult.right.node_id
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
    }).pipe(Effect.either)

    if (responseResult._tag === 'Left') {
      const error = responseResult.left
      return {
        ok: false as const,
        reason: 'network-error',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    const response = responseResult.right
    if (response.ok) {
      return { ok: true as const }
    }

    const detail = yield* readResponseText(response).pipe(
      Effect.catchAll(() => Effect.succeed<string | undefined>(undefined)),
    )

    return {
      ok: false as const,
      reason: response.status === 404 ? 'invalid-repository' : 'http-error',
      status: response.status,
      detail,
    }
  })
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
          Effect.map((text): CreatePullRequestCommentResult => {
            if (!text) {
              return { ok: true } as const
            }
            try {
              const parsed = JSON.parse(text) as { html_url?: unknown }
              const commentUrl =
                parsed && typeof parsed === 'object' && typeof parsed.html_url === 'string'
                  ? parsed.html_url
                  : undefined
              return { ok: true, commentUrl } as const
            } catch (error) {
              return {
                ok: false as const,
                reason: 'invalid-json',
                detail: error instanceof Error ? error.message : String(error),
              } as const
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
