import { expect, test } from 'bun:test'
import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AlpacaResearchBarSchema,
  WebullResearchBarSchema,
  WebullResearchInputSchema,
  WebullResearchRequestSchema,
  WebullRequestState,
  WebullSession,
  makeWebullResearchReport,
  readWebullResearch,
  type WebullResearchRows,
} from './webull-research'

const input = Result.getOrThrow(
  Schema.decodeUnknownResult(WebullResearchInputSchema)({
    startAt: '2026-11-02T09:00:00.000Z',
    durationMinutes: 5,
    selection: { kind: 'symbols', symbols: ['TEST', 'EMPTY', 'OLD', 'MISSING'] },
  }),
)
const barWire = {
  provider: 'webull',
  feed: 'nasdaq_basic',
  symbol: 'TEST',
  bar_start_ms: '1793610000000',
  session: 'PRE',
  open: '1.123456789123456789',
  high: '2.0',
  low: '1.0',
  close: '1.500000000000000001',
  volume: '10.000000001',
  received_ns: '1793610241123456789',
  archived_ns: '1793610242123456789',
  capture_id: '514a5cd9-a548-4c1f-b88d-a72ddc1b49ec',
  payload_sha256: 'a'.repeat(64),
  source_topic: 'dorvud.webull.raw.v1',
  source_partition: 1,
  source_offset: '9007199254740993',
  recovery_observations: '2',
}
const requestWire = {
  provider: 'webull',
  feed: 'nasdaq_basic',
  symbol: 'TEST',
  request_state: 'OBSERVED',
  observed_count: 1,
  excluded_count: 0,
  received_ns: barWire.received_ns,
  payload_sha256: barWire.payload_sha256,
  source_topic: barWire.source_topic,
  source_partition: 1,
  source_offset: barWire.source_offset,
}
const alpacaWire = {
  provider: 'alpaca',
  feed: 'iex',
  universe_id: 'torghut-core-equity-v2',
  session: 'premarket',
  symbol: 'TEST',
  bar_start_ms: barWire.bar_start_ms,
  open: '1.1234567891234568',
  high: '2',
  low: '1',
  close: '1.5',
  volume: '10',
  received_ns: '1793610075123456789',
  source_topic: 'torghut.bars.1m.v1',
  source_partition: 0,
  source_offset: '1',
}
const rows: WebullResearchRows = {
  bars: [Result.getOrThrow(Schema.decodeUnknownResult(WebullResearchBarSchema)(barWire))],
  requests: ['TEST', 'EMPTY', 'OLD', 'MISSING'].map((symbol, index) =>
    Result.getOrThrow(
      Schema.decodeUnknownResult(WebullResearchRequestSchema)({
        ...requestWire,
        symbol,
        request_state: [
          WebullRequestState.Observed,
          WebullRequestState.Empty,
          WebullRequestState.Excluded,
          WebullRequestState.Omitted,
        ][index],
      }),
    ),
  ),
  gaps: [],
  alpaca: [Result.getOrThrow(Schema.decodeUnknownResult(AlpacaResearchBarSchema)(alpacaWire))],
}

test('research preserves native precision and provenance, keeps request states and labels venue differences', () => {
  const report = Result.getOrThrow(makeWebullResearchReport(input, rows))
  expect(report.qualification).toBe('UNQUALIFIED')
  expect(report.bars[0]?.open).toBe('1.123456789123456789')
  expect(report.bars[0]?.received_ns).toBe('1793610241123456789')
  expect(report.bars[0]?.source_offset).toBe('9007199254740993')
  expect(report.summary.recoveryRepeats).toBe('1')
  expect(report.coverage.map((row) => row.requestState)).toEqual(['OBSERVED', 'EMPTY', 'EXCLUDED', 'OMITTED'])
  expect(report.comparison[0]?.differingFields).toEqual(['open', 'close', 'volume'])
  expect(report.issues).toContain('Latest requests include provider omissions or rejected payloads')
  expect(report.reportHash).toBe(Result.getOrThrow(makeWebullResearchReport(input, rows)).reportHash)
})

test('coverage distinguishes missing requests, stale bars and conflicting sessions without inventing data', () => {
  const report = Result.getOrThrow(
    makeWebullResearchReport(input, {
      ...rows,
      requests: [],
      bars: [...rows.bars, ...rows.bars.map((bar) => ({ ...bar, session: WebullSession.Regular }))],
    }),
  )
  expect(report.issues.some((issue) => issue.includes('Conflicting Webull session'))).toBe(true)
  expect(report.coverage[1]).toMatchObject({
    symbol: 'EMPTY',
    requestState: 'NO_CAPTURED_REQUEST',
    fresh: false,
    latestBarStartAt: null,
  })
  const oldInput = { ...input, durationMinutes: 7 }
  expect(Result.getOrThrow(makeWebullResearchReport(oldInput, rows)).coverage[0]?.fresh).toBe(false)
})

test('input and SQL boundaries reject duplicate symbols, unfinished boundaries, malformed decimals and unknown sessions', () => {
  for (const value of [
    { ...input, selection: { kind: 'symbols', symbols: [] } },
    { ...input, selection: { kind: 'symbols', symbols: ['TEST', 'TEST'] } },
    { ...input, startAt: '2026-11-02T09:00:30.000Z' },
    { ...input, durationMinutes: 361 },
  ])
    expect(Result.isFailure(Schema.decodeUnknownResult(WebullResearchInputSchema)(value))).toBe(true)
  for (const changes of [
    { open: 'NaN' },
    { open: '0' },
    { close: '1e999999' },
    { session: 'unknown' },
    { source_offset: 9007199254740992 },
  ])
    expect(Result.isFailure(Schema.decodeUnknownResult(WebullResearchBarSchema)({ ...barWire, ...changes }))).toBe(true)
})

const clientLayer = (url: string) =>
  ClickhouseClient.layer({
    url,
    database: 'signal',
    username: 'fixture',
    password: 'fixture',
    request_timeout: 1_000,
  }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))

const withServer = <A, E>(
  reply: (query: string) => Effect.Effect<unknown, never>,
  use: (layer: ReturnType<typeof clientLayer>) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context<never>())
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request) => {
              if (new URL(request.url).pathname === '/ping') return new Response('Ok.')
              const query = await request.text()
              const data = query.includes('KILL QUERY') ? [] : await run(reply(query), { signal: request.signal })
              return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      return yield* use(clientLayer(server.url.href))
    }),
  )

test('the scoped official client decodes all four read-only queries and retains exact strings', () =>
  Effect.runPromise(
    withServer(
      (query) =>
        Effect.succeed(
          query.includes('canonical AS') && query.includes('minute_bars')
            ? [barWire]
            : query.includes('latest_requests')
              ? [requestWire]
              : query.includes('intraday_bars_1m_v2')
                ? [alpacaWire]
                : [],
        ),
      (layer) =>
        Effect.gen(function* () {
          const report = yield* readWebullResearch(input).pipe(Effect.provide(layer))
          expect(report.summary.completedBars).toBe(1)
          expect(report.bars[0]?.received_ns).toBe(barWire.received_ns)
        }),
    ),
  ))

test('invalid SQL rows fail through the typed channel instead of a partial research report', () =>
  Effect.runPromise(
    withServer(
      () => Effect.succeed([{ ...barWire, session: 'INVALID' }]),
      (layer) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(readWebullResearch(input).pipe(Effect.provide(layer)))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(JSON.stringify(exit)).toContain('WebullResearchError')
          expect(JSON.stringify(exit)).toContain('SchemaError')
        }),
    ),
  ))

test('interruption closes the owned client and finalizes the query scope exactly once', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let finalized = 0
        const work = withServer(
          () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          (layer) => readWebullResearch(input).pipe(Effect.provide(layer)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized++
            }),
          ),
        )
        const fiber = yield* Effect.forkScoped(work)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(finalized).toBe(1)
      }),
    ),
  ))

test('the total read deadline cancels a stalled query and finalizes exactly once', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-11-03T09:00:00.000Z'))
        const started = yield* Deferred.make<void>()
        let finalized = 0
        const work = withServer(
          () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          (layer) => readWebullResearch(input).pipe(Effect.provide(layer)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized++
            }),
          ),
        )
        const fiber = yield* Effect.forkScoped(work)
        yield* Deferred.await(started)
        yield* TestClock.adjust('60 seconds')
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain('Timeout')
        expect(finalized).toBe(1)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ))

test('programming defects remain defects and still close the client scope', () =>
  Effect.runPromise(
    withServer(
      () => Effect.succeed([]),
      (layer) =>
        Effect.gen(function* () {
          const sql = yield* ClickhouseClient.ClickhouseClient
          const faulty = new Proxy(sql, {
            apply() {
              throw new Error('query compiler invariant')
            },
          })
          const exit = yield* Effect.exit(
            readWebullResearch(input).pipe(Effect.provideService(ClickhouseClient.ClickhouseClient, faulty)),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          expect(JSON.stringify(exit)).toContain('Die')
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('query compiler invariant')
        }).pipe(Effect.provide(layer)),
    ),
  ))
