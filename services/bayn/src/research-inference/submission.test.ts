import { expect, test } from 'bun:test'
import { Effect, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { maximumResearchReceiptBytes } from './contract'
import { submitResearch } from './submission'
import { editorFixture } from './test-support'

test('bounds the serialized Workflow receipt before decoding it', async () => {
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new Uint8Array(maximumResearchReceiptBytes + 1)))),
  )
  const result = await Effect.runPromise(
    submitResearch(editorFixture(), 'http://fixture.invalid', Redacted.make('7'.repeat(64))).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.result,
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.message).toBe('Research Workflow response exceeds 5 MiB')
})

test('retired registrations are rejected before a Workflow submission', async () => {
  let calls = 0
  const http = HttpClient.make((request) => {
    calls++
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{}')))
  })
  const result = await Effect.runPromise(
    submitResearch(
      { ...editorFixture(), schemaVersion: 'bayn.jev-harness2-editor.v2' },
      'http://fixture.invalid',
      Redacted.make('7'.repeat(64)),
    ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.result),
  )
  expect(result._tag).toBe('Failure')
  expect(calls).toBe(0)
})
