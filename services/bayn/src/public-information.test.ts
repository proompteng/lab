import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { Effect, Fiber, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'
import {
  PublicArtifactStore,
  PublicInformationError,
  PublicInformationSource,
  collectPublicInformation,
  type PublicInformationRun,
} from './public-information'

const revision = 'a'.repeat(40)
const calendar =
  'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261014T123000Z\r\nSUMMARY:CPI\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
const make = (options: { http?: (url: string) => Response; failUpload?: () => boolean } = {}) => {
  const writes: { key: string; body: Uint8Array; sha: string }[] = []
  const requests: { url: string; headers: Record<string, string> }[] = []
  const store = PublicArtifactStore.of({
    qualify: () => Effect.void,
    put: (key, body, _, sha) =>
      Effect.suspend(() => {
        if (options.failUpload?.())
          return Effect.fail(new PublicInformationError({ stage: 'storage', message: 'injected failure' }))
        writes.push({ key, body, sha })
        return Effect.void
      }),
  })
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, headers: { ...request.headers } })
      return HttpClientResponse.fromWeb(
        request,
        options.http?.(request.url) ??
          new Response(request.url.endsWith('.ics') ? calendar : '<html>FOMC calendar</html>'),
      )
    }),
  )
  const layer = Layer.mergeAll(
    Layer.succeed(PublicArtifactStore, store),
    Layer.succeed(HttpClient.HttpClient, client),
    TestClock.layer(),
  )
  const collect = (source = PublicInformationSource.Macro, previous: PublicInformationRun | null = null) =>
    collectPublicInformation(source, revision, ['AAPL', 'SPY'], previous, Effect.void).pipe(Effect.provide(layer))
  return { writes, requests, collect, layer }
}

describe('independent public information collection', () => {
  test('retains original bytes and fetch clocks without broker, model or storage credentials in public requests', async () => {
    const h = make()
    const first = await Effect.runPromise(h.collect())
    expect(first.failures).toEqual([])
    expect(first.artifacts).toHaveLength(2)
    expect(h.writes).toHaveLength(2)
    for (const artifact of first.artifacts) {
      const saved = h.writes.find((row) => row.key === artifact.objectKey)
      if (saved === undefined) throw new Error('Missing artifact')
      expect(createHash('sha256').update(saved.body).digest('hex')).toBe(artifact.contentSha256)
      expect(artifact.fetchedAt).toBe('1970-01-01T00:00:00.000Z')
      expect(artifact.storedAt).toBe(artifact.fetchedAt)
      expect(artifact.objectKey.startsWith('captures/v1/public-information/')).toBe(true)
    }
    expect(
      new TextDecoder().decode(h.writes.find((row) => new TextDecoder().decode(row.body) === calendar)?.body),
    ).toBe(calendar)
    for (const request of h.requests)
      expect(Object.keys(request.headers).sort()).toEqual(['accept-encoding', 'user-agent'])
    const second = await Effect.runPromise(h.collect(PublicInformationSource.Macro, first))
    expect(second.artifacts).toEqual(first.artifacts)
    expect(h.requests).toHaveLength(4)
    expect(h.writes).toHaveLength(2)
  })
  test('an upload failure is explicit while the other source succeeds; a later attempt recovers', async () => {
    let failed = true
    const h = make({
      failUpload: () => {
        const result = failed
        failed = false
        return result
      },
    })
    const first = await Effect.runPromise(h.collect())
    expect(first.failures).toEqual([
      { url: 'https://www.bls.gov/schedule/news_release/bls.ics', stage: 'storage', status: null },
    ])
    expect(first.artifacts).toHaveLength(1)
    const next = await Effect.runPromise(h.collect(PublicInformationSource.Macro, first))
    expect(next.failures).toEqual([])
    expect(next.artifacts).toHaveLength(2)
    expect(h.writes).toHaveLength(2)
  })
  test('redirects and HTTP errors retain the last good artifact without following another host', async () => {
    const h = make()
    const first = await Effect.runPromise(h.collect())
    const failed = make({
      http: () => new Response('', { status: 302, headers: { location: 'https://untrusted.invalid/' } }),
    })
    const result = await Effect.runPromise(failed.collect(PublicInformationSource.Macro, first))
    expect(result.artifacts).toEqual(first.artifacts)
    expect(result.failures.map((error) => error.status)).toEqual([302, 302])
    expect(failed.requests).toHaveLength(2)
    expect(failed.writes).toHaveLength(0)
  })
  test('malformed and oversized public bodies never become successful artifacts', async () => {
    for (const body of ['Access denied', new Uint8Array(16 * 1024 * 1024 + 1)]) {
      const h = make({ http: () => new Response(body) })
      const result = await Effect.runPromise(h.collect())
      expect(result.failures).toHaveLength(2)
      expect(result.artifacts).toEqual([])
      expect(h.writes).toEqual([])
    }
  })
  test('SEC mappings come from the provider, absent issuers and facts are explicit, and CIK mismatches cannot publish', async () => {
    const h = make({
      http: (url) =>
        new Response(
          url.endsWith('company_tickers.json')
            ? JSON.stringify({ '0': { ticker: 'AAPL', cik_str: 320193, title: 'Apple' } })
            : url.includes('/companyfacts/')
              ? ''
              : JSON.stringify({ cik: '0000320193' }),
          { status: url.includes('/companyfacts/') ? 404 : 200 },
        ),
    })
    const result = await Effect.runPromise(h.collect(PublicInformationSource.Filings))
    expect(result.missingIssuerSymbols).toEqual(['SPY'])
    expect(result.unavailableCompanyFacts).toEqual([320193])
    expect(result.failures).toEqual([])
    expect(result.artifacts).toHaveLength(2)
    const corrupt = make({
      http: (url) =>
        new Response(
          url.endsWith('company_tickers.json')
            ? JSON.stringify({ '0': { ticker: 'AAPL', cik_str: 320193 } })
            : JSON.stringify({ cik: 1 }),
        ),
    })
    const rejected = await Effect.runPromise(corrupt.collect(PublicInformationSource.Filings))
    expect(rejected.failures[0]?.stage).toBe('parse')
    expect(corrupt.writes).toHaveLength(1)
  })
  test('a malformed ticker mapping preserves the last good artifact before any upload', async () => {
    const first = await Effect.runPromise(
      make({
        http: (url) =>
          new Response(
            JSON.stringify(
              url.endsWith('company_tickers.json') ? { '0': { ticker: 'AAPL', cik_str: 320193 } } : { cik: 320193 },
            ),
          ),
      }).collect(PublicInformationSource.Filings),
    )
    for (const invalid of [
      { '0': { ticker: 'AAPL' } },
      { '0': { ticker: 'AAPL', cik_str: 'invalid' } },
      'mapping-not-object',
    ]) {
      const failed = make({ http: () => new Response(JSON.stringify(invalid)) })
      const result = await Effect.runPromise(failed.collect(PublicInformationSource.Filings, first))
      expect(result.failures).toEqual([
        { url: 'https://www.sec.gov/files/company_tickers.json', stage: 'ticker-mapping', status: null },
      ])
      expect(result.artifacts).toEqual(first.artifacts)
      expect(result.issuerCiks).toEqual(first.issuerCiks)
      expect(failed.writes).toEqual([])
      expect(failed.requests).toHaveLength(1)
    }
  })
  test('a canceled collection stops its HTTP work without producing a success artifact', async () => {
    let canceled = 0
    const h = make()
    const hanging = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            canceled += 1
          }),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* collectPublicInformation(
            PublicInformationSource.Macro,
            revision,
            ['AAPL'],
            null,
            Effect.void,
          ).pipe(Effect.provideService(HttpClient.HttpClient, hanging), Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          expect(canceled).toBe(1)
        }),
      ).pipe(Effect.provide(h.layer)),
    )
    expect(h.writes).toHaveLength(0)
  })

  test('rotating issuer universes prune old references even when the ticker source subsequently fails', async () => {
    const symbols = (prefix: string) =>
      Array.from(
        { length: 100 },
        (_, index) =>
          `${prefix}${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
      )
    const firstSymbols = symbols('A')
    const secondSymbols = symbols('B')
    let current = firstSymbols
    let failTickers = false
    const h = make({
      http: (url) => {
        if (url.endsWith('company_tickers.json'))
          return failTickers
            ? new Response('', { status: 503 })
            : new Response(
                JSON.stringify(
                  Object.fromEntries(
                    current.map((ticker, index) => [
                      String(index),
                      { ticker, cik_str: (current === firstSymbols ? 1 : 101) + index },
                    ]),
                  ),
                ),
              )
        return new Response(JSON.stringify({ cik: Number(/CIK(\d+)\.json$/.exec(url)?.[1]) }))
      },
    })
    const collect = (previous: PublicInformationRun | null) =>
      collectPublicInformation(PublicInformationSource.Filings, revision, current, previous, Effect.void).pipe(
        Effect.provide(h.layer),
      )
    const first = await Effect.runPromise(collect(null))
    expect(first.artifacts).toHaveLength(201)
    current = secondSymbols
    const second = await Effect.runPromise(collect(first))
    expect(second.artifacts).toHaveLength(201)
    expect(Object.keys(second.issuerCiks).sort()).toEqual(secondSymbols)
    expect(second.artifacts.some(({ url }) => /CIK00000000\d\d\.json$/.test(url))).toBe(false)
    current = [secondSymbols[0]!, 'ZZZ']
    failTickers = true
    const failed = await Effect.runPromise(collect(second))
    expect(failed.artifacts).toHaveLength(3)
    expect(failed.issuerCiks).toEqual({ [secondSymbols[0]!]: 101 })
    expect(failed.missingIssuerSymbols).toEqual(['ZZZ'])
    expect(failed.failures).toEqual([
      { url: 'https://www.sec.gov/files/company_tickers.json', stage: 'fetch', status: 503 },
    ])
    for (const artifact of failed.artifacts)
      expect(artifact).toEqual(second.artifacts.find(({ url }) => url === artifact.url)!)
  })
})
