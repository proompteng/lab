import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { CompanyNewsLive } from './client'
import { CompanyNews, decodeNewsSnapshot, makeNewsSnapshot, NewsFailure, type NewsArticle } from './model'

const asOf = '1970-01-01T01:00:00.000Z'
const article = (id = 1, updated = '1970-01-01T00:59:00Z'): NewsArticle => ({
  id,
  created_at: '1970-01-01T00:30:00Z',
  updated_at: updated,
  headline: 'Example company reports guidance',
  summary: 'The company reports a change in its outlook.',
  source: 'test-provider',
  url: 'https://example.test/news',
  symbols: ['AAPL'],
})
const material = (news: readonly NewsArticle[] = [article()]) => ({
  schemaVersion: 'bayn.company-news-snapshot.v1',
  source: 'alpaca-news-v1beta1',
  query: { symbol: 'AAPL', asOf },
  requestedAt: asOf,
  receivedAt: asOf,
  articles: news,
  pages: [{ requestPageToken: null, response: { news, next_page_token: null } }],
})
const credentials = { key: Redacted.make('test-key'), secret: Redacted.make('test-secret') }
const query = CompanyNews.pipe(Effect.flatMap((source) => source.read({ symbol: 'AAPL', asOf })))
const run = <A, E>(program: Effect.Effect<A, E, CompanyNews>, client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(3_600_000)
    return yield* program
  }).pipe(
    Effect.provide(CompanyNewsLive(credentials, 1000)),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provide(TestClock.layer()),
  )

describe('point-in-time company news', () => {
  test('binds the exact article versions and original provider pages', () => {
    const input = material()
    const snapshot = Result.getOrThrow(makeNewsSnapshot(input))
    expect(Result.getOrThrow(decodeNewsSnapshot(snapshot))).toEqual(snapshot)
    const changed = { ...snapshot, articles: [{ ...article(), headline: 'Changed text' }] }
    expect(Result.isFailure(decodeNewsSnapshot(changed))).toBe(true)
    expect(Result.isFailure(decodeNewsSnapshot({ ...snapshot, contentHash: '0'.repeat(64) }))).toBe(true)
  })

  test('keeps an empty successful observation distinct from unavailable news', () => {
    expect(Result.getOrThrow(makeNewsSnapshot(material([]))).articles).toEqual([])
    expect(Result.isFailure(makeNewsSnapshot({ ...material(), pages: [] }))).toBe(true)
  })

  test('rejects future revisions at nanosecond precision, wrong entities, duplicates and unordered versions', () => {
    for (const articles of [
      [article(1, '1970-01-01T01:00:00.000000001Z')],
      [{ ...article(), symbols: ['MSFT'] }],
      [article(), article()],
      [article(1, '1970-01-01T00:58:00Z'), article(2, '1970-01-01T00:59:00Z')],
      [article(1, '1970-01-01T00:29:00Z')],
      [article(1, '1970-01-01T02:00:00Z')],
      [article(1, '1970-02-31T00:00:00Z')],
    ])
      expect(Result.isFailure(makeNewsSnapshot(material(articles)))).toBe(true)
  })

  test('rejects partial pagination, repeated tokens and pages not reached by the previous token', () => {
    const first = { requestPageToken: null, response: { news: [article()], next_page_token: 'next' } }
    for (const pages of [
      [first],
      [first, { requestPageToken: 'wrong', response: { news: [], next_page_token: null } }],
      [first, { requestPageToken: 'next', response: { news: [], next_page_token: 'next' } }],
    ])
      expect(Result.isFailure(makeNewsSnapshot({ ...material(), pages }))).toBe(true)
  })

  test('continues short pages and fixes the endpoint, symbol, as-of interval and article limit', async () => {
    let calls = 0
    const client = HttpClient.make((request, url) => {
      calls += 1
      expect(url.origin + url.pathname).toBe('https://data.alpaca.markets/v1beta1/news')
      expect(url.searchParams.get('symbols')).toBe('AAPL')
      expect(url.searchParams.get('start')).toBe('1970-01-01T00:00:00.000Z')
      expect(url.searchParams.get('end')).toBe(asOf)
      expect(url.searchParams.get('limit')).toBe('3')
      expect(url.searchParams.get('sort')).toBe('desc')
      expect(url.searchParams.get('include_content')).toBe('false')
      expect(request.headers['apca-api-key-id']).toBe('test-key')
      expect(url.searchParams.get('page_token')).toBe(calls === 1 ? null : 'next')
      const news = calls === 1 ? [article()] : [article(2, '1970-01-01T00:58:00Z'), article(3, '1970-01-01T00:57:00Z')]
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ news, next_page_token: calls === 1 ? 'next' : 'older' })),
        ),
      )
    })
    const snapshot = await Effect.runPromise(run(query, client))
    expect(snapshot.articles.map((article) => article.id)).toEqual([1, 2, 3])
    expect(snapshot.pages).toHaveLength(2)
    expect(calls).toBe(2)
  })

  test.each([401, 403, 429, 500])('does not retry or replace status %i with empty news', async (status) => {
    let calls = 0
    const result = await Effect.runPromise(
      run(
        query.pipe(Effect.result),
        HttpClient.make((request) => {
          calls += 1
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{}', { status })))
        }),
      ),
    )
    expect(Result.isFailure(result) && result.failure.failure).toBe(NewsFailure.Status)
    expect(calls).toBe(1)
    expect(JSON.stringify(result)).not.toContain('test-secret')
  })

  test('retains a redacted response validation cause without turning malformed content into no news', async () => {
    const result = await Effect.runPromise(
      run(
        query.pipe(Effect.result),
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  news: [{ headline: 'untrusted-test-content' }],
                  next_page_token: null,
                }),
              ),
            ),
          ),
        ),
      ),
    )
    expect(Result.isFailure(result) && result.failure.failure).toBe(NewsFailure.Response)
    expect(Result.isFailure(result) && result.failure.cause !== undefined).toBe(true)
    expect(JSON.stringify(result)).not.toContain('untrusted-test-content')
    expect(JSON.stringify(result)).not.toContain('test-secret')
  })

  test('cancels a timed-out fetch exactly once', async () => {
    let stopped = 0
    const client = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stopped += 1
          }),
        ),
      ),
    )
    await Effect.runPromise(
      run(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* query.pipe(Effect.result, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.yieldNow
            yield* TestClock.adjust(1000)
            const result = yield* Fiber.join(fiber)
            expect(Result.isFailure(result) && result.failure.failure).toBe(NewsFailure.Timeout)
            expect(stopped).toBe(1)
          }),
        ),
        client,
      ),
    )
  })

  test('propagates defects and cancels a caller-interrupted fetch', async () => {
    const defect = new Error('test defect')
    const exit = await Effect.runPromiseExit(
      run(
        query,
        HttpClient.make(() => Effect.die(defect)),
      ),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect)
    let stopped = 0
    await Effect.runPromise(
      run(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* query.pipe(Effect.forkScoped({ startImmediately: true }))
            yield* Effect.yieldNow
            yield* Fiber.interrupt(fiber)
            expect(stopped).toBe(1)
          }),
        ),
        HttpClient.make(() =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stopped += 1
              }),
            ),
          ),
        ),
      ),
    )
  })
})
