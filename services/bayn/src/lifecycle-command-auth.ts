import { readFile } from 'node:fs/promises'

import { NodeHttpClient } from '@effect/platform-node'
import { Data, Effect, Schema, type Scope } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

const maximumServiceAccountTokenBytes = 16_384

export const lifecycleCommandTokenAudience = 'bayn.proompteng.ai/lifecycle-command'
export const lifecycleCommandServiceAccount = 'system:serviceaccount:bayn:bayn-lifecycle'

export const kubernetesLifecycleCommandAuthentication = {
  apiOrigin: 'https://kubernetes.default.svc.cluster.local',
  caPath: '/var/run/secrets/bayn-lifecycle-reviewer/ca.crt',
  reviewerTokenPath: '/var/run/secrets/bayn-lifecycle-reviewer/token',
  audience: lifecycleCommandTokenAudience,
  expectedUsername: lifecycleCommandServiceAccount,
} as const

export interface LifecycleCommandAuthenticationConfig {
  readonly apiOrigin: string
  readonly caPath: string
  readonly reviewerTokenPath: string
  readonly audience: string
  readonly expectedUsername: string
}

export class LifecycleCommandAuthenticationError extends Data.TaggedError('LifecycleCommandAuthenticationError')<{
  readonly operation: 'configuration' | 'token-review'
  readonly message: string
  readonly cause?: unknown
}> {}

export type LifecycleCommandAuthenticator = (
  presentedToken: string,
) => Effect.Effect<boolean, LifecycleCommandAuthenticationError>

const TokenReviewResponseSchema = Schema.Struct({
  status: Schema.optional(
    Schema.Struct({
      authenticated: Schema.optional(Schema.Boolean),
      audiences: Schema.optional(Schema.Array(Schema.String)),
      user: Schema.optional(
        Schema.Struct({
          username: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})

const decodeTokenReviewResponse = HttpClientResponse.schemaBodyJson(TokenReviewResponseSchema)

const requiredToken = (
  source: string,
  operation: LifecycleCommandAuthenticationError['operation'],
  description: string,
): Effect.Effect<string, LifecycleCommandAuthenticationError> => {
  const token = source.trim()
  return token.length > 0 && Buffer.byteLength(token, 'utf8') <= maximumServiceAccountTokenBytes
    ? Effect.succeed(token)
    : Effect.fail(
        new LifecycleCommandAuthenticationError({
          operation,
          message: `${description} is empty or exceeds the bounded token size`,
        }),
      )
}

export const bearerToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined || authorization.length > maximumServiceAccountTokenBytes + 7) return null
  const matched = /^Bearer ([^\s,]+)$/i.exec(authorization)
  return matched?.[1] ?? null
}

const readRequiredFile = (
  path: string,
  operation: LifecycleCommandAuthenticationError['operation'],
  message: string,
): Effect.Effect<string, LifecycleCommandAuthenticationError> =>
  Effect.tryPromise({
    try: (signal) => readFile(path, { encoding: 'utf8', signal }),
    catch: (cause) => new LifecycleCommandAuthenticationError({ operation, message, cause }),
  })

export const makeLifecycleCommandAuthenticator =
  (config: LifecycleCommandAuthenticationConfig, client: HttpClient.HttpClient): LifecycleCommandAuthenticator =>
  (presentedToken) =>
    Effect.gen(function* () {
      const reviewerTokenSource = yield* readRequiredFile(
        config.reviewerTokenPath,
        'token-review',
        'Kubernetes reviewer credential is unavailable',
      )
      const reviewerToken = yield* requiredToken(reviewerTokenSource, 'token-review', 'Kubernetes reviewer credential')
      const boundedPresentedToken = yield* requiredToken(
        presentedToken,
        'token-review',
        'presented lifecycle credential',
      )
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(`${config.apiOrigin}/apis/authentication.k8s.io/v1/tokenreviews`, {
          acceptJson: true,
          headers: { authorization: `Bearer ${reviewerToken}` },
        }),
        {
          apiVersion: 'authentication.k8s.io/v1',
          kind: 'TokenReview',
          spec: { token: boundedPresentedToken, audiences: [config.audience] },
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new LifecycleCommandAuthenticationError({
              operation: 'token-review',
              message: 'Kubernetes TokenReview request encoding failed',
              cause,
            }),
        ),
      )
      const response = yield* client.execute(request).pipe(
        Effect.timeout('5 seconds'),
        Effect.mapError(
          (cause) =>
            new LifecycleCommandAuthenticationError({
              operation: 'token-review',
              message: 'Kubernetes TokenReview request failed',
              cause,
            }),
        ),
      )
      if (response.status !== 200 && response.status !== 201) {
        return yield* new LifecycleCommandAuthenticationError({
          operation: 'token-review',
          message: `Kubernetes TokenReview returned HTTP ${response.status.toString()}`,
        })
      }
      const reviewed = yield* decodeTokenReviewResponse(response).pipe(
        Effect.mapError(
          (cause) =>
            new LifecycleCommandAuthenticationError({
              operation: 'token-review',
              message: 'Kubernetes TokenReview response failed validation',
              cause,
            }),
        ),
      )
      return (
        reviewed.status?.authenticated === true &&
        reviewed.status.user?.username === config.expectedUsername &&
        reviewed.status.audiences?.includes(config.audience) === true
      )
    })

export const acquireKubernetesLifecycleCommandAuthenticator = (
  config: LifecycleCommandAuthenticationConfig = kubernetesLifecycleCommandAuthentication,
): Effect.Effect<LifecycleCommandAuthenticator, LifecycleCommandAuthenticationError, Scope.Scope> =>
  Effect.gen(function* () {
    const ca = yield* readRequiredFile(config.caPath, 'configuration', 'Kubernetes TokenReview CA is unavailable')
    if (ca.trim().length === 0) {
      return yield* new LifecycleCommandAuthenticationError({
        operation: 'configuration',
        message: 'Kubernetes TokenReview CA is empty',
      })
    }
    const agents = yield* NodeHttpClient.makeAgent({ ca })
    const client = yield* NodeHttpClient.makeNodeHttp.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agents))
    return makeLifecycleCommandAuthenticator(config, client)
  })
