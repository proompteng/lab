import { Effect } from 'effect'

import { PLAN_COMMENT_MARKER } from '@/codex'

import {
  coerceNumericId,
  DEFAULT_API_BASE_URL,
  DEFAULT_USER_AGENT,
  readResponseText,
  toError,
  trimTrailingSlash,
} from './common'
import type {
  FetchLike,
  FindPlanCommentOptions,
  FindPlanCommentResult,
  IssueReactionPresenceOptions,
  IssueReactionPresenceResult,
  PostIssueReactionOptions,
  PostIssueReactionResult,
} from './types'

const globalFetch = typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : null

export const postIssueReaction = (options: PostIssueReactionOptions): Effect.Effect<PostIssueReactionResult> => {
  const {
    repositoryFullName,
    issueNumber,
    token,
    reactionContent,
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

export const issueHasReaction = (options: IssueReactionPresenceOptions): Effect.Effect<IssueReactionPresenceResult> => {
  const {
    repositoryFullName,
    issueNumber,
    reactionContent,
    token,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    userAgent = DEFAULT_USER_AGENT,
    fetchImplementation = globalFetch,
  } = options

  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    return Effect.succeed({
      ok: false as const,
      reason: 'invalid-repository' as const,
      detail: repositoryFullName,
    })
  }

  const fetchFn = fetchImplementation
  if (!fetchFn) {
    return Effect.succeed({ ok: false, reason: 'no-fetch' } as const)
  }

  const url = `${trimTrailingSlash(apiBaseUrl)}/repos/${owner}/${repo}/issues/${issueNumber}/reactions?per_page=1&content=${encodeURIComponent(reactionContent)}`

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
        Effect.succeed<IssueReactionPresenceResult>({
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
              reason: 'http-error' as const,
              status: response.status,
              detail,
            }
          }

          const bodyResult = yield* readResponseText(response).pipe(Effect.either)
          if (bodyResult._tag === 'Left') {
            return {
              ok: false as const,
              reason: 'network-error' as const,
              detail: bodyResult.left.message,
            }
          }

          let parsed: unknown
          try {
            parsed = bodyResult.right.length === 0 ? [] : JSON.parse(bodyResult.right)
          } catch (error) {
            return {
              ok: false as const,
              reason: 'invalid-json' as const,
              detail: error instanceof Error ? error.message : String(error),
            }
          }

          if (!Array.isArray(parsed)) {
            return {
              ok: false as const,
              reason: 'invalid-json' as const,
              detail: 'Expected array response from GitHub API',
            }
          }

          return {
            ok: true as const,
            hasReaction: parsed.length > 0,
          }
        }),
    },
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
