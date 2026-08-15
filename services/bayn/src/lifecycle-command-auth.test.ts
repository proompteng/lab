import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Exit } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import {
  bearerToken,
  lifecycleCommandServiceAccount,
  lifecycleCommandTokenAudience,
  makeLifecycleCommandAuthenticator,
  type LifecycleCommandAuthenticationConfig,
} from './lifecycle-command-auth'

const tokenReviewResponse = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  status: object,
  httpStatus = 201,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', status }), {
      status: httpStatus,
      headers: { 'content-type': 'application/json' },
    }),
  )

const requestBody = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]): unknown => {
  if (request.body._tag !== 'Uint8Array') throw new Error('expected a JSON request body')
  return JSON.parse(new TextDecoder().decode(request.body.body))
}

describe('Bayn lifecycle command authentication', () => {
  test('accepts only the exact projected service-account identity and audience', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-lifecycle-auth-'))
    const reviewerTokenPath = join(directory, 'token')
    await writeFile(reviewerTokenPath, 'reviewer-token\n', { mode: 0o600 })
    const config: LifecycleCommandAuthenticationConfig = {
      apiOrigin: 'https://kubernetes.default.svc.cluster.local',
      caPath: join(directory, 'ca.crt'),
      reviewerTokenPath,
      audience: lifecycleCommandTokenAudience,
      expectedUsername: lifecycleCommandServiceAccount,
    }
    const requests: Array<{ readonly authorization: string | undefined; readonly body: unknown }> = []
    const identities = [
      {
        authenticated: true,
        audiences: [lifecycleCommandTokenAudience],
        user: { username: lifecycleCommandServiceAccount },
      },
      {
        authenticated: true,
        audiences: [lifecycleCommandTokenAudience],
        user: { username: 'system:serviceaccount:bayn:other' },
      },
      { authenticated: true, audiences: ['other-audience'], user: { username: lifecycleCommandServiceAccount } },
    ]
    const client = HttpClient.make((request) => {
      requests.push({ authorization: request.headers['authorization'], body: requestBody(request) })
      const identity = identities.shift()
      if (identity === undefined) return Effect.die(new Error('unexpected TokenReview request'))
      return Effect.succeed(tokenReviewResponse(request, identity))
    })

    try {
      const authorized = await Effect.runPromise(
        Effect.all([
          makeLifecycleCommandAuthenticator(config, client)('worker-token'),
          makeLifecycleCommandAuthenticator(config, client)('wrong-worker'),
          makeLifecycleCommandAuthenticator(config, client)('wrong-audience'),
        ]),
      )

      expect(authorized).toEqual([true, false, false])
      expect(requests).toEqual(
        Array.from({ length: 3 }, (_unused, index) => ({
          authorization: 'Bearer reviewer-token',
          body: {
            apiVersion: 'authentication.k8s.io/v1',
            kind: 'TokenReview',
            spec: {
              token: ['worker-token', 'wrong-worker', 'wrong-audience'][index],
              audiences: [lifecycleCommandTokenAudience],
            },
          },
        })),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed on malformed bearer headers and TokenReview outages', async () => {
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('Basic token')).toBeNull()
    expect(bearerToken('Bearer token extra')).toBeNull()
    expect(bearerToken('Bearer projected-token')).toBe('projected-token')

    const directory = await mkdtemp(join(tmpdir(), 'bayn-lifecycle-auth-'))
    const reviewerTokenPath = join(directory, 'token')
    await writeFile(reviewerTokenPath, 'reviewer-token', { mode: 0o600 })
    const client = HttpClient.make((request) => Effect.succeed(tokenReviewResponse(request, {}, 503)))
    try {
      const exit = await Effect.runPromise(
        makeLifecycleCommandAuthenticator(
          {
            apiOrigin: 'https://kubernetes.default.svc.cluster.local',
            caPath: join(directory, 'ca.crt'),
            reviewerTokenPath,
            audience: lifecycleCommandTokenAudience,
            expectedUsername: lifecycleCommandServiceAccount,
          },
          client,
        )('worker-token').pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
