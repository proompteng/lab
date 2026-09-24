import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, FileSystem, Layer, Result, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { backfillAlpacaHistory } from '../../../tools/backfill'
import { canonicalHashV1Result } from '../../hash'
import { readHistoricalChunk, readHistoricalDataset } from './dataset'

test('history acquisition retains sparse coverage and resumes from immutable pages without requesting again', async () => {
  let requests = 0
  const bar = (minute: number) => ({
    t: `2026-09-11T13:${minute}:00Z`,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    v: 10,
    n: 1,
    vw: 100,
  })
  const http = HttpClient.make((request) => {
    requests++
    const body = request.url.includes('/calendar')
      ? [{ date: '2026-09-11', open: '09:30', close: '09:32' }]
      : { bars: { AAPL: [bar(30)], SPY: [bar(30), bar(31)] }, next_page_token: null }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })))
  })
  const request = {
    schemaVersion: 'bayn.alpaca-backfill.v1',
    startDate: '2026-09-11',
    endDate: '2026-09-11',
    symbols: ['AAPL', 'SPY'],
    executionSessions: [],
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const first = yield* backfillAlpacaHistory(request, directory)
      expect(requests).toBe(2)
      const repeated = yield* backfillAlpacaHistory(request, directory)
      expect(repeated).toEqual(first)
      expect(requests).toBe(2)
      expect(first.records).toBe(3)
      const coverage = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              symbol: Schema.String,
              coverage: Schema.String,
              missingMinutes: Schema.Array(Schema.String),
            }),
          ),
        ),
      )(yield* fs.readFileString(`${directory}/coverage.json`))
      expect(coverage).toEqual([
        { symbol: 'AAPL', coverage: 'GAPPED', missingMinutes: ['2026-09-11T13:31:00.000Z'] },
        { symbol: 'SPY', coverage: 'COMPLETE_MINUTE_GRID', missingMinutes: [] },
      ])
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(yield* fs.readFileString(`${directory}/dataset.json`))
      const { datasetId, ...material } = manifest
      expect(datasetId).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
      expect(manifest['transport']).toBe('historical-rest')
      expect(manifest['originalStreamAvailability']).toBe('NOT_OBSERVED')
      const changed = yield* Effect.result(backfillAlpacaHistory({ ...request, symbols: ['AAPL'] }, directory))
      expect(Result.isFailure(changed)).toBeTrue()
      expect(requests).toBe(2)
    }).pipe(
      Effect.scoped,
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ BAYN_ALPACA_KEY_ID: 'fixture-key', BAYN_ALPACA_SECRET_KEY: 'fixture-secret' }),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(HttpClient.HttpClient, http))),
    ),
  )
})

test('history acquisition bounds event queries without dropping or repeating boundary records', async () => {
  const requests: URL[] = []
  const normalizeTime = (value: string) =>
    value.replace(/\.([0-9]{3})Z$/, (_match, millis: string) => `.${millis}000000Z`)
  const times = ['2026-09-11T14:29:59.999999999Z', '2026-09-11T14:30:00.000000000Z']
  const http = HttpClient.make((request, url) => {
    requests.push(url)
    const start = normalizeTime(url.searchParams.get('start') ?? '')
    const end = normalizeTime(url.searchParams.get('end') ?? '')
    const included = times.filter((time) => time >= start && time <= end)
    const body = request.url.includes('/calendar')
      ? [{ date: '2026-09-11', open: '09:30', close: '11:30' }]
      : request.url.includes('/bars')
        ? {
            bars: { AAPL: [{ t: '2026-09-11T13:30:00Z', o: 100, h: 101, l: 99, c: 100, v: 10, n: 1, vw: 100 }] },
            next_page_token: null,
          }
        : request.url.includes('/quotes')
          ? {
              quotes: {
                AAPL: included.map((t) => ({ t, bp: 100, bs: 1, ap: 101, as: 1, bx: 'V', ax: 'V', c: ['R'], z: 'C' })),
              },
              next_page_token: null,
            }
          : {
              trades: {
                AAPL: included.map((t, index) => ({ t, i: index + 1, p: 100, s: 1, x: 'V', c: ['@'], z: 'C' })),
              },
              next_page_token: null,
            }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })))
  })
  const request = {
    schemaVersion: 'bayn.alpaca-backfill.v1',
    startDate: '2026-09-11',
    endDate: '2026-09-11',
    symbols: ['AAPL'],
    executionSessions: ['2026-09-11'],
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const result = yield* backfillAlpacaHistory(request, directory)
      expect(result.records).toBe(5)
      const dataset = yield* readHistoricalDataset(directory, result.datasetId)
      expect(dataset.manifest.chunks).toHaveLength(5)
      expect(dataset.coverage).toMatchObject([
        { kind: 'bars', records: 1 },
        { kind: 'quotes', records: 2 },
        { kind: 'trades', records: 2 },
      ])
      const eventChunks = dataset.manifest.chunks.filter((chunk) => chunk.kind !== 'bars')
      const captures = yield* Effect.forEach(eventChunks, (chunk) => readHistoricalChunk(dataset, chunk))
      for (const kind of ['quotes', 'trades']) {
        expect(
          captures
            .filter((capture) => capture.kind === kind)
            .flatMap((capture) => capture.rows.map((row) => row.eventAt)),
        ).toEqual(times)
      }
      for (const kind of ['quotes', 'trades']) {
        const urls = requests.filter((url) => url.pathname.endsWith(`/${kind}`))
        expect(urls).toHaveLength(2)
        expect(urls[0]?.searchParams.get('end')).toBe('2026-09-11T14:29:59.999999999Z')
        expect(urls[1]?.searchParams.get('start')).toBe('2026-09-11T14:30:00.000Z')
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ BAYN_ALPACA_KEY_ID: 'fixture-key', BAYN_ALPACA_SECRET_KEY: 'fixture-secret' }),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(HttpClient.HttpClient, http))),
    ),
  )
})
