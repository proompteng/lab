import { describe, expect, test } from 'bun:test'

import { NodeFileSystem } from '@effect/platform-node'
import { Duration, Effect, FileSystem, Redacted } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'

import { AlpacaHistoricalKind, decodeAlpacaHistoricalQuery, type AlpacaHistoricalQuery } from './model'
import { makeAlpacaHistoricalClient } from './client'

const sessionQuery = (kind: AlpacaHistoricalKind, cacheDirectory: string): AlpacaHistoricalQuery => ({
  kind,
  sessionDate: '2026-06-01',
  sessionOpenAt: '2026-06-01T13:30:00.000Z',
  sessionCloseAt: '2026-06-01T20:00:00.000Z',
  startAt: '2026-06-01T13:30:00.000Z',
  endAt: '2026-06-01T13:32:00.000Z',
  symbols: ['AAPL', 'MSFT'],
  cacheDirectory,
})

const bar = (eventAt: string, close: number) => ({
  c: close,
  h: close + 1,
  l: close - 1,
  n: 1,
  o: close,
  t: eventAt,
  v: 10,
  vw: close,
})

const quote = (eventAt: string, bidPrice: number, bidSize = 3, askPrice = bidPrice + 1) => ({
  ap: askPrice,
  as: 2,
  ax: 'V',
  bp: bidPrice,
  bs: bidSize,
  bx: 'V',
  c: ['R'],
  t: eventAt,
  z: 'C',
})

const trade = (eventAt: string, id: number, price: number) => ({
  c: ['@'],
  i: id,
  p: price,
  s: 1,
  t: eventAt,
  x: 'V',
  z: 'C',
})

interface ScriptedResponse {
  readonly status?: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string>>
}

const makeScriptedClient = (responses: readonly ScriptedResponse[]) => {
  const requests: URL[] = []
  let responseIndex = 0
  const client = HttpClient.make((request, url) => {
    requests.push(url)
    const response = responses[responseIndex]
    responseIndex += 1
    const selected = response ?? {
      status: 599,
      body: '{"message":"unexpected test request"}',
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(selected.body, {
          status: selected.status ?? 200,
          ...(selected.headers === undefined ? {} : { headers: selected.headers }),
        }),
      ),
    )
  })
  return { client, requests }
}

const runWithFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

const runCapture = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

const runCaptureExit = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeFileSystem.layer)))

const withTempDirectory = <A>(use: (directory: string) => Promise<A>): Promise<A> =>
  runWithFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectory({ prefix: 'bayn-alpaca-historical-' })
      return yield* Effect.promise(() => use(directory)).pipe(
        Effect.ensuring(fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)),
      )
    }),
  )

const credentials = {
  key: Redacted.make('test-key'),
  secret: Redacted.make('test-secret'),
}

const json = (value: unknown): string => JSON.stringify(value)

describe('Alpaca historical vendor capture', () => {
  test('rejects a regular-session window whose UTC date differs from sessionDate', async () => {
    const invalidQuery = {
      ...sessionQuery(AlpacaHistoricalKind.Bars, '/tmp/unused-cache'),
      sessionOpenAt: '2026-06-02T13:30:00.000Z',
      sessionCloseAt: '2026-06-02T20:00:00.000Z',
      startAt: '2026-06-02T13:30:00.000Z',
      endAt: '2026-06-02T13:32:00.000Z',
    } as AlpacaHistoricalQuery
    expect(decodeAlpacaHistoricalQuery(invalidQuery)._tag).toBe('Failure')

    await withTempDirectory(async (cacheDirectory) => {
      const scripted = makeScriptedClient([])
      const client = await Effect.runPromise(makeAlpacaHistoricalClient(scripted.client, credentials))
      const exit = await runCaptureExit(client.capture({ ...invalidQuery, cacheDirectory }))
      expect(exit._tag).toBe('Failure')
      expect(scripted.requests).toHaveLength(0)
    })
  })

  test('follows symbol-major pagination even when a short page carries a token', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const scripted = makeScriptedClient([
        {
          body: json({
            bars: { AAPL: [bar('2026-06-01T13:30:00Z', 100)] },
            next_page_token: 'page-1',
          }),
        },
        {
          body: json({
            bars: {
              AAPL: [bar('2026-06-01T13:31:00Z', 101)],
              MSFT: [bar('2026-06-01T13:31:00Z', 200)],
            },
            next_page_token: null,
          }),
        },
      ])
      const client = await Effect.runPromise(makeAlpacaHistoricalClient(scripted.client, credentials))
      const result = await runCapture(client.capture(sessionQuery(AlpacaHistoricalKind.Bars, cacheDirectory)))

      expect(result.kind).toBe('bars')
      expect(result.rows.map((row) => `${row.symbol}:${row.eventAt}`)).toEqual([
        'AAPL:2026-06-01T13:30:00.000000000Z',
        'AAPL:2026-06-01T13:31:00.000000000Z',
        'MSFT:2026-06-01T13:31:00.000000000Z',
      ])
      expect(result.provenance.pageReceipts).toHaveLength(2)
      expect(result.provenance.pageReceipts[0]?.nextPageTokenPresent).toBeTrue()
      expect(result.provenance.pageReceipts[1]?.nextPageTokenPresent).toBeFalse()
      expect(scripted.requests).toHaveLength(2)
      expect(scripted.requests[0]?.origin).toBe('https://data.alpaca.markets')
      expect(scripted.requests[0]?.pathname).toBe('/v2/stocks/bars')
      expect(scripted.requests[0]?.searchParams.get('feed')).toBe('iex')
      expect(scripted.requests[0]?.searchParams.get('asof')).toBe('2026-06-01')
      expect(scripted.requests[0]?.searchParams.get('timeframe')).toBe('1Min')
      expect(scripted.requests[0]?.searchParams.get('adjustment')).toBe('raw')
      expect(scripted.requests[1]?.searchParams.get('page_token')).toBe('page-1')
    })
  })

  test('resumes an interrupted page chain from its immutable checkpoint', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const first = makeScriptedClient([
        {
          body: json({
            quotes: {
              AAPL: [{ ...quote('2026-06-01T13:30:00.123456789Z', 100), participant_timestamp: 123 }],
            },
            next_page_token: 'page-1',
          }),
        },
        {
          status: 500,
          body: '{"message":"temporary"}',
        },
      ])
      const firstClient = await Effect.runPromise(
        makeAlpacaHistoricalClient(first.client, credentials, { maximumAttempts: 1 }),
      )
      const firstExit = await runCaptureExit(
        firstClient.capture(sessionQuery(AlpacaHistoricalKind.Quotes, cacheDirectory)),
      )
      expect(firstExit._tag).toBe('Failure')
      expect(first.requests).toHaveLength(2)

      const second = makeScriptedClient([
        {
          body: json({
            quotes: { AAPL: [quote('2026-06-01T13:30:00.223456789Z', 101)] },
            next_page_token: null,
          }),
        },
      ])
      const secondClient = await Effect.runPromise(makeAlpacaHistoricalClient(second.client, credentials))
      const result = await runCapture(secondClient.capture(sessionQuery(AlpacaHistoricalKind.Quotes, cacheDirectory)))

      expect(result.rows).toHaveLength(2)
      expect(second.requests).toHaveLength(1)
      expect(second.requests[0]?.searchParams.get('page_token')).toBe('page-1')
      expect(result.provenance.completeness).toBe('complete')
    })
  })

  test('rejects malformed and exact duplicate event records while preserving distinct equal-time quotes', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const malformed = makeScriptedClient([
        { body: json({ trades: { AAPL: [{ i: 1, p: 100, s: 1, x: 'V', c: ['@'], z: 'C' }] }, next_page_token: null }) },
      ])
      const malformedClient = await Effect.runPromise(makeAlpacaHistoricalClient(malformed.client, credentials))
      const malformedExit = await runCaptureExit(
        malformedClient.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)),
      )
      expect(malformedExit._tag).toBe('Failure')
      if (malformedExit._tag === 'Failure') expect(String(malformedExit.cause)).toContain('VendorHistoricalFailure')

      const duplicate = makeScriptedClient([
        {
          body: json({ bars: { AAPL: [bar('2026-06-01T13:30:00Z', 100)] }, next_page_token: 'page-1' }),
        },
        {
          body: json({ bars: { AAPL: [bar('2026-06-01T13:30:00Z', 100)] }, next_page_token: null }),
        },
      ])
      const duplicateClient = await Effect.runPromise(makeAlpacaHistoricalClient(duplicate.client, credentials))
      const duplicateExit = await runCaptureExit(
        duplicateClient.capture(sessionQuery(AlpacaHistoricalKind.Bars, cacheDirectory)),
      )
      expect(duplicateExit._tag).toBe('Failure')

      const distinctQuotes = makeScriptedClient([
        {
          body: json({
            quotes: { AAPL: [quote('2026-06-01T13:30:00.123456789Z', 100, 560, 101)] },
            next_page_token: 'page-1',
          }),
        },
        {
          body: json({
            quotes: { AAPL: [quote('2026-06-01T13:30:00.123456789Z', 100, 680, 101)] },
            next_page_token: null,
          }),
        },
      ])
      const distinctQuotesClient = await Effect.runPromise(
        makeAlpacaHistoricalClient(distinctQuotes.client, credentials),
      )
      const distinctQuotesResult = await runCapture(
        distinctQuotesClient.capture(sessionQuery(AlpacaHistoricalKind.Quotes, cacheDirectory)),
      )
      expect(distinctQuotesResult.rows).toHaveLength(2)
      expect(distinctQuotesResult.kind).toBe('quotes')
      if (distinctQuotesResult.kind === 'quotes') {
        expect(distinctQuotesResult.rows.map((row) => row.bidSize)).toEqual([560, 680])
      }

      const exactDuplicate = makeScriptedClient([
        {
          body: json({
            quotes: { AAPL: [quote('2026-06-01T13:30:00.123456789Z', 100)] },
            next_page_token: 'page-1',
          }),
        },
        {
          body: json({
            quotes: { AAPL: [quote('2026-06-01T13:30:00.123456789Z', 100)] },
            next_page_token: null,
          }),
        },
      ])
      const exactDuplicateClient = await Effect.runPromise(
        makeAlpacaHistoricalClient(exactDuplicate.client, credentials),
      )
      const exactDuplicateExit = await runCaptureExit(
        exactDuplicateClient.capture(sessionQuery(AlpacaHistoricalKind.Quotes, `${cacheDirectory}/exact-duplicate`)),
      )
      expect(exactDuplicateExit._tag).toBe('Failure')
    })
  })

  test('accepts a CTA trade condition code consisting of a space', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const scripted = makeScriptedClient([
        {
          body: json({
            trades: {
              IWM: [
                {
                  c: [' ', 'F'],
                  i: 52983610224944,
                  p: 289.83,
                  s: 59,
                  t: '2026-06-02T14:30:00.553479157Z',
                  x: 'V',
                  z: 'B',
                },
              ],
            },
            next_page_token: null,
          }),
        },
      ])
      const client = await Effect.runPromise(makeAlpacaHistoricalClient(scripted.client, credentials))
      const query: AlpacaHistoricalQuery = {
        ...sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory),
        sessionDate: '2026-06-02',
        sessionOpenAt: '2026-06-02T13:30:00.000Z',
        sessionCloseAt: '2026-06-02T20:00:00.000Z',
        startAt: '2026-06-02T14:30:00.000Z',
        endAt: '2026-06-02T14:32:00.000Z',
        symbols: ['IWM'],
      }
      const result = await runCapture(client.capture(query))

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({
        symbol: 'IWM',
        providerTradeId: '52983610224944',
        conditions: [' ', 'F'],
        tape: 'B',
      })
    })
  })

  test('fails closed when a cached raw body checksum changes', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const first = makeScriptedClient([
        { body: json({ trades: { AAPL: [trade('2026-06-01T13:30:00.123456789Z', 7, 100)] }, next_page_token: null }) },
      ])
      const firstClient = await Effect.runPromise(makeAlpacaHistoricalClient(first.client, credentials))
      const firstResult = await runCapture(
        firstClient.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)),
      )
      expect(first.requests).toHaveLength(1)

      const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
      const bodyPath = `${cacheDirectory}/${firstResult.queryHash}/page-00000000.body.json`
      await Effect.runPromise(fs.writeFileString(bodyPath, '{}'))
      expect(await Effect.runPromise(fs.readFileString(bodyPath))).toBe('{}')
      expect(await Effect.runPromise(fs.exists(bodyPath))).toBeTrue()
      expect(await Effect.runPromise(fs.readDirectory(`${cacheDirectory}/${firstResult.queryHash}`))).toEqual([
        'query.json',
        'page-00000000.body.json',
        'page-00000000.receipt.json',
      ])
      expect(firstResult.provenance.pageReceipts[0]?.receiptPath).toBe('page-00000000.receipt.json')
      expect(await Effect.runPromise(fs.readDirectory(cacheDirectory))).toEqual([firstResult.queryHash])

      const second = makeScriptedClient([])
      const secondClient = await Effect.runPromise(makeAlpacaHistoricalClient(second.client, credentials))
      const secondExit = await runCaptureExit(
        secondClient.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)),
      )
      expect(second.requests).toHaveLength(0)
      expect(secondExit._tag).toBe('Failure')
    })
  })

  test('retries a bounded 429 response and honors Retry-After', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const scripted = makeScriptedClient([
        { status: 429, headers: { 'retry-after': '0' }, body: '{"message":"slow down"}' },
        { body: json({ trades: { AAPL: [trade('2026-06-01T13:30:00.123456789Z', 7, 100)] }, next_page_token: null }) },
      ])
      const client = await Effect.runPromise(
        makeAlpacaHistoricalClient(scripted.client, credentials, { maximumAttempts: 2 }),
      )
      const result = await runCapture(client.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)))
      expect(result.rows).toHaveLength(1)
      expect(scripted.requests).toHaveLength(2)
    })
  })

  test('keeps provenance stable when a complete query is served from cache', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const first = makeScriptedClient([
        { body: json({ trades: { AAPL: [trade('2026-06-01T13:30:00.123456789Z', 7, 100)] }, next_page_token: null }) },
      ])
      const firstClient = await Effect.runPromise(makeAlpacaHistoricalClient(first.client, credentials))
      const firstResult = await runCapture(
        firstClient.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)),
      )

      const second = makeScriptedClient([])
      const secondClient = await Effect.runPromise(makeAlpacaHistoricalClient(second.client, credentials))
      const cachedResult = await runCapture(
        secondClient.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)),
      )

      expect(second.requests).toHaveLength(0)
      expect(cachedResult.provenanceHash).toBe(firstResult.provenanceHash)
      expect(cachedResult.provenance.retrievedAt).toBe(firstResult.provenance.retrievedAt)
      expect(cachedResult.provenance.pageReceipts[0]?.retrievedAt).toBe(
        firstResult.provenance.pageReceipts[0]?.retrievedAt,
      )
    })
  })

  test('counts mixed status and transport failures against one attempt bound', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      let attempts = 0
      const client = HttpClient.make((request) => {
        attempts += 1
        if (attempts === 3) {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: 'test transport failure',
              }),
            }),
          )
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('{"message":"retry"}', {
              status: attempts === 1 ? 429 : 503,
              headers: { 'retry-after': '0' },
            }),
          ),
        )
      })
      const historical = await Effect.runPromise(
        makeAlpacaHistoricalClient(client, credentials, { maximumAttempts: 3 }),
      )
      const exit = await runCaptureExit(historical.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)))
      expect(exit._tag).toBe('Failure')
      expect(attempts).toBe(3)
      if (exit._tag === 'Failure') expect(String(exit.cause)).toContain('VendorHistoricalFailure')
    })
  })

  test('omits provider error bodies that contain credential-like values', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const scripted = makeScriptedClient([
        {
          status: 400,
          body: JSON.stringify({ message: 'bad test-key test-secret request' }),
        },
      ])
      const client = await Effect.runPromise(
        makeAlpacaHistoricalClient(scripted.client, credentials, { maximumAttempts: 1 }),
      )
      const exit = await runCaptureExit(client.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)))
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        const rendered = String(exit.cause)
        expect(rendered).not.toContain('test-key')
        expect(rendered).not.toContain('test-secret')
        expect(rendered).not.toContain('bad test-key')
      }
    })
  })

  test('turns a request timeout into a typed failure and does not return partial rows', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const client = HttpClient.make((request) =>
        Effect.sleep(Duration.millis(50)).pipe(
          Effect.map(() =>
            HttpClientResponse.fromWeb(request, new Response('{"trades":{},"next_page_token":null}', { status: 200 })),
          ),
        ),
      )
      const historical = await Effect.runPromise(
        makeAlpacaHistoricalClient(client, credentials, { maximumAttempts: 1, requestTimeoutMs: 1 }),
      )
      const exit = await runCaptureExit(historical.capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory)))
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') expect(String(exit.cause)).toContain('VendorHistoricalFailure')
    })
  })

  test('bounds a response body that stalls after headers', async () => {
    await withTempDirectory(async (cacheDirectory) => {
      const stalledBody = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      })
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(stalledBody, { status: 200 }))),
      )
      const historical = await Effect.runPromise(
        makeAlpacaHistoricalClient(client, credentials, { maximumAttempts: 1, requestTimeoutMs: 5 }),
      )
      const exit = await runCaptureExit(
        historical
          .capture(sessionQuery(AlpacaHistoricalKind.Trades, cacheDirectory))
          .pipe(Effect.timeout(Duration.millis(500))),
      )
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') expect(String(exit.cause)).toContain('VendorHistoricalFailure')
    })
  })
})
