import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { inferResearch, makeResearchStreamDecoder } from './client'
import { hashResearch, maximumResearchStreamBytes, ResearchOutcome, researchServingIdentity } from './contract'
import { fullTokenBudgetStreamFixture, editorFixture, streamFixture } from './test-support'

const fixture = editorFixture()
const activeFixture = editorFixture()
const activeId = Result.getOrThrow(hashResearch(activeFixture))
const activeStream = () => streamFixture('{"entry":"Assess"}', activeFixture.policy.model)
const encode = (text: string) => new TextEncoder().encode(text)
const finalUsageFrame = `data: ${JSON.stringify({
  id: 'chatcmpl-synthetic',
  model: fixture.policy.model,
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
})}\n\n`
describe('bounded native inference stream', () => {
  test('decodes pinned cumulative-usage SSE split at every byte with CRLF boundaries', () => {
    const decoder = makeResearchStreamDecoder(fixture)
    for (const byte of encode(streamFixture().replaceAll('\n', '\r\n')))
      Result.getOrThrow(decoder.push(new Uint8Array([byte]), 10))
    expect(Result.getOrThrow(decoder.complete())).toEqual({ entry: 'Assess' })
    expect(decoder.snapshot().usage?.total_tokens).toBe(30)
    expect(decoder.snapshot().firstTokenAtMs).toBe(10)
  })
  test.each(['reasoning', 'reasoning_content'])('counts %s as the first generated token', (field) => {
    const decoder = makeResearchStreamDecoder(fixture)
    const reasoning = {
      id: 'chatcmpl-synthetic',
      model: fixture.policy.model,
      choices: [{ index: 0, delta: { [field]: 'thinking' }, finish_reason: null }],
    }
    Result.getOrThrow(decoder.push(encode(`data: ${JSON.stringify(reasoning)}\n\n`), 1))
    Result.getOrThrow(decoder.push(encode(streamFixture()), 20))
    expect(Result.getOrThrow(decoder.complete())).toEqual({ entry: 'Assess' })
    expect(decoder.snapshot().firstTokenAtMs).toBe(1)
  })
  test.each([
    streamFixture().replace('data: [DONE]\n\n', ''),
    streamFixture().replace('"total_tokens":30', '"total_tokens":31'),
    streamFixture('<alpha_list>alpha001,alpha001</alpha_list>'),
    streamFixture('<alpha_list>alpha002</alpha_list>'),
    streamFixture().replace('"finish_reason":"stop"', '"finish_reason":"length"'),
    streamFixture().replace('qwen36-flamingo', 'wrong-model'),
    streamFixture().replaceAll('"model":"qwen36-flamingo",', ''),
    streamFixture()
      .replace('"completion_tokens":20', '"completion_tokens":4097')
      .replace('"total_tokens":30', '"total_tokens":4107'),
    streamFixture('<think><alpha_list>alpha001</alpha_list></think>'),
    streamFixture('<alpha_list>alpha001</alpha_list><alpha_list>alpha001</alpha_list>'),
  ])('rejects malformed or incomplete output %#', (text) => {
    const decoder = makeResearchStreamDecoder(fixture)
    const pushed = decoder.push(encode(text), 10)
    expect(Result.isFailure(pushed) || Result.isFailure(decoder.complete())).toBe(true)
  })
  test('accepts usage at the approved completion-token limit', () => {
    const decoder = makeResearchStreamDecoder({ ...fixture, policy: { ...fixture.policy, max_tokens: 20 } })
    Result.getOrThrow(decoder.push(encode(streamFixture()), 10))
    expect(Result.getOrThrow(decoder.complete())).toEqual({ entry: 'Assess' })
  })
  test('retains all 4096 cumulative-usage frames within the approved token budget', () => {
    const decoder = makeResearchStreamDecoder(fixture)
    const bytes = encode(fullTokenBudgetStreamFixture())
    expect(bytes.length).toBeGreaterThan(262144)
    for (let offset = 0; offset < bytes.length; offset += 8192)
      Result.getOrThrow(decoder.push(bytes.subarray(offset, offset + 8192), 10))
    expect(Result.getOrThrow(decoder.complete())).toEqual({ entry: 'Assess' })
    expect(decoder.snapshot().usage?.completion_tokens).toBe(4096)
    expect(Buffer.from(decoder.snapshot().responseBase64, 'base64')).toEqual(Buffer.from(bytes))
  })
  test.each([
    [
      'decreasing completion usage',
      streamFixture().replace('"completion_tokens":19,"total_tokens":29', '"completion_tokens":1,"total_tokens":11'),
    ],
    [
      'changed prompt usage',
      streamFixture().replace(
        '"prompt_tokens":10,"completion_tokens":19,"total_tokens":29',
        '"prompt_tokens":11,"completion_tokens":19,"total_tokens":30',
      ),
    ],
    ['missing final usage', streamFixture().replace(finalUsageFrame, '')],
    ['premature final usage', finalUsageFrame + streamFixture()],
    ['duplicate final usage', streamFixture().replace('data: [DONE]', finalUsageFrame + 'data: [DONE]')],
  ])('rejects %s', (_name, text) => {
    const decoder = makeResearchStreamDecoder(fixture)
    const pushed = decoder.push(encode(text), 10)
    expect(Result.isFailure(pushed) || Result.isFailure(decoder.complete())).toBe(true)
  })
  test.each([null, 'model', 'checkpoint', 'servingImage', 'tokenizerRevision', 'chatTemplateRevision'] as const)(
    'rejects missing or mismatched serving attestation: %s',
    async (changed) => {
      const { TestClock } = await import('effect/testing')
      const identity: Record<string, string> = {
        model: activeFixture.policy.model,
        checkpoint: activeFixture.policy.checkpoint,
        servingImage: activeFixture.policy.servingImage,
        tokenizerRevision: activeFixture.policy.tokenizerRevision,
        chatTemplateRevision: activeFixture.policy.chatTemplateRevision,
      }
      if (changed !== null)
        identity[changed] =
          changed === 'model' ? 'wrong-model' : changed === 'servingImage' ? `sha256:${'0'.repeat(64)}` : '0'.repeat(40)
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(activeStream(), {
              headers: changed === null ? {} : { 'x-model-serving-identity': JSON.stringify(identity) },
            }),
          ),
        ),
      )
      const result = await Effect.runPromise(
        inferResearch(activeFixture, activeId, 'http://fixture.invalid').pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provide(TestClock.layer()),
        ),
      )
      expect(result.outcome).toBe(ResearchOutcome.Rejected)
    },
  )
  test('retains a matching serving attestation independently of JSON key order', async () => {
    const { TestClock } = await import('effect/testing')
    const identity = researchServingIdentity(activeFixture.policy)
    const header = JSON.stringify(Object.fromEntries(Object.entries(identity).reverse()))
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(activeStream(), {
            headers: { 'x-model-serving-identity': header },
          }),
        ),
      ),
    )
    const result = await Effect.runPromise(
      inferResearch(activeFixture, activeId, 'http://fixture.invalid').pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(result.outcome).toBe(ResearchOutcome.Complete)
    expect(result.servingIdentity).toEqual(identity)
  })
  test('bounds retained response memory', () =>
    expect(
      Result.isFailure(makeResearchStreamDecoder(fixture).push(new Uint8Array(maximumResearchStreamBytes + 1), 10)),
    ).toBe(true))
  test('never transmits an expired request', async () => {
    let calls = 0
    const http = HttpClient.make((request) => {
      calls++
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(activeStream())))
    })
    const result = await Effect.runPromise(
      inferResearch(activeFixture, activeId, 'http://fixture.invalid').pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    )
    expect(result.outcome).toBe(ResearchOutcome.Expired)
    expect(calls).toBe(0)
  })
  test('never transmits before the approved feature cutoff', async () => {
    const { TestClock } = await import('effect/testing')
    let calls = 0
    const http = HttpClient.make((request) => {
      calls++
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(activeStream())))
    })
    const future = { ...activeFixture, featureCutoff: '1970-01-01T00:00:00.001Z' }
    const result = await Effect.runPromise(
      inferResearch(future, Result.getOrThrow(hashResearch(future)), 'http://fixture.invalid').pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(result.outcome).toBe(ResearchOutcome.Rejected)
    expect(calls).toBe(0)
  })
})

test.each(['deadline', 'interruption'] as const)(
  'cancels incomplete research streams exactly once on %s',
  async (end) => {
    const { Fiber } = await import('effect')
    const { TestClock } = await import('effect/testing')
    let cancelled = 0
    let reading = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading = true
      },
      cancel() {
        cancelled++
      },
    })
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            headers: {
              'x-model-serving-identity': JSON.stringify({
                model: activeFixture.policy.model,
                checkpoint: activeFixture.policy.checkpoint,
                servingImage: activeFixture.policy.servingImage,
                tokenizerRevision: activeFixture.policy.tokenizerRevision,
                chatTemplateRevision: activeFixture.policy.chatTemplateRevision,
              }),
            },
          }),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* inferResearch(activeFixture, activeId, 'http://fixture.invalid').pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          expect(reading).toBe(true)
          if (end === 'deadline') {
            yield* TestClock.adjust(30_000)
            expect((yield* Fiber.join(fiber)).outcome).toBe(ResearchOutcome.Expired)
          } else yield* Fiber.interrupt(fiber)
          expect(cancelled).toBe(1)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  },
)
