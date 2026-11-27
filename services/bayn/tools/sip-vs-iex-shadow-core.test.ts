import { NodeFileSystem } from '@effect/platform-node'
import { describe, expect, test } from 'bun:test'
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Result, Sink, Stdio } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EquityCutFeed, sipTopics } from '../src/market-data/sip/provenance'
import { sipUniverse } from '../src/market-data/sip/universe'
import {
  ReportFormat,
  compareShadowSnapshot,
  decodeShadowSnapshot,
  iexTopics,
  renderShadowReport,
  type ShadowParityReport,
} from './sip-vs-iex-shadow-core'
import { runShadowVerifier } from './verify-sip-vs-iex-shadow'

const { Iex, Sip } = EquityCutFeed
const regular = { date: '2026-07-06', openAt: '2026-07-06T13:30:00Z', closeAt: '2026-07-06T20:00:00Z' }
const early = { date: '2026-11-27', openAt: '2026-11-27T14:30:00Z', closeAt: '2026-11-27T18:00:00Z' }

const identity = (symbol: string, feed: EquityCutFeed, kind: keyof typeof iexTopics) => ({
  provider: 'alpaca',
  symbol,
  feed,
  source_topic: (feed === Sip ? sipTopics : iexTopics)[kind],
  delay_class: feed === Sip ? 'real_time_consolidated' : 'real_time_exchange_only',
  universe_id: feed === Sip ? sipUniverse.id : 'torghut-core-equity-v3',
  universe_symbol_hash:
    feed === Sip ? sipUniverse.symbolHash : '495e9255caedc2632da88b337af9aca2f59256d18c0c164598cff7ee990a476c',
  schema_version: 1,
})
const bar = (symbol: string, session = regular, slot = 0, feed = Sip) => {
  const eventMs = Date.parse(session.openAt) + 60_000 * slot
  return {
    ...identity(symbol, feed, 'bars'),
    event_at: new Date(eventMs).toISOString(),
    ingested_at: new Date(eventMs + 60_100).toISOString(),
    source_partition: 0,
    source_offset: String(slot),
    is_final: 1,
    close: 100,
  }
}
const quote = (symbol: string, session = regular, spreadBps = 1, feed = Sip) => ({
  ...identity(symbol, feed, 'quotes'),
  event_at: session.openAt.replace('Z', '.000000001Z'),
  ingested_at: session.openAt.replace('Z', '.100000002Z'),
  bid_price: 100 - spreadBps / 200,
  ask_price: 100 + spreadBps / 200,
  bid_size: 100,
  ask_size: 200,
})

const qualified = (session = regular, minuteCount = 390) => ({
  session,
  bars: [
    ...['QQQ', 'SMH', 'XLK', 'SPY'].flatMap((symbol) =>
      Array.from({ length: minuteCount }, (_, slot) => bar(symbol, session, slot)),
    ),
    bar('QQQ', session, 0, Iex),
  ],
  quotes: [...sipUniverse.all73.map((symbol) => quote(symbol, session, 2)), quote('QQQ', session, 6, Iex)],
})

const evaluate = (value: unknown) =>
  Result.getOrThrow(compareShadowSnapshot(Result.getOrThrow(decodeShadowSnapshot(value))))
const checksThatFail = (report: ShadowParityReport) =>
  report.gate.checks.filter(({ pass }) => !pass).map(({ id }) => id)

describe('SIP parity core', () => {
  test('binds the exact canonical cohort, passes the inclusive spread limit and reports missing IEX honestly', () => {
    const report = evaluate(qualified())
    expect(report.schemaVersion).toBe('bayn.sip-shadow-parity-report.v1')
    expect(report.universe).toEqual({
      id: 'torghut-core-equity-sip-v1',
      expectedHash: '89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b',
      observedHash: '89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b',
      observedCount: 73,
      missing: [],
      unexpected: [],
      mismatchedSipRows: 0,
    })
    expect(report.gate.pass).toBe(true)
    expect(report.bySymbol.map(({ symbol }) => symbol)).toEqual([...sipUniverse.all73])
    expect(report.bySymbol.find(({ symbol }) => symbol === 'XLK')?.iex.spreadBps.median).toBeNull()
    expect(report.pooled.sip).toMatchObject({
      expectedBars: 73 * 390,
      barCount: 4 * 390,
      quoteIngestLatencyMs: { median: 100.000001, p95: 100.000001 },
      barIngestLatencyMs: { median: 60_100, p95: 60_100 },
    })
    expect(report.commonSymbolSpreads).toMatchObject({ symbols: ['QQQ'], medianSpreadCompressionBps: 4 })
  })

  test.each([
    { session: regular, minutes: 390 },
    { session: early, minutes: 210 },
  ])('computes calendar-adjusted minute coverage: %j', ({ session, minutes }) => {
    const almostComplete = qualified(session, minutes - 1)
    expect(evaluate(almostComplete).gate.pass).toBe(true)
    almostComplete.bars = almostComplete.bars.filter(
      (row) => row.symbol !== 'SPY' || row.source_offset !== String(minutes - 2),
    )
    almostComplete.bars.push(bar('SPY', session, minutes), { ...bar('SPY', session, minutes - 1), is_final: 0 })
    const report = evaluate(almostComplete)
    expect(report.expectedMinutes).toBe(minutes)
    expect(checksThatFail(report)).toEqual(['sip-bar-coverage:SPY'])
    expect(report.bySymbol.find(({ symbol }) => symbol === 'SPY')?.sip.barCoverage).toBe((minutes - 2) / minutes)
  })

  test('checks every lane row for identity without filtering away a missing or wrong-hash symbol', () => {
    const fixture = qualified()
    const report = evaluate({
      ...fixture,
      quotes: [
        ...fixture.quotes.filter((row) => row.symbol !== 'AAPL'),
        { ...quote('WDC'), universe_symbol_hash: '0'.repeat(64) },
        { ...quote('QQQ'), universe_id: 'wrong-id' },
        quote('OTHER'),
      ],
    })
    expect(checksThatFail(report)).toEqual(['sip-universe'])
    expect(report.universe).toMatchObject({
      observedCount: 73,
      missing: ['AAPL'],
      unexpected: ['OTHER'],
      mismatchedSipRows: 2,
    })
    expect(report.universe.observedHash).not.toBe(report.universe.expectedHash)

    const sameRoster = evaluate({
      ...fixture,
      quotes: [...fixture.quotes, { ...quote('QQQ'), universe_id: 'wrong-id' }],
    })
    expect(sameRoster.universe.observedHash).toBe(sameRoster.universe.expectedHash)
    expect(checksThatFail(sameRoster)).toEqual(['sip-universe'])
  })

  test('uses event-time RTH bounds and exact nanosecond staleness; counts locked, crossed and one-sided quotes', () => {
    const make = (at: string, ingest: string, spread: number) => ({
      ...quote('QQQ', early, spread),
      event_at: at,
      ingested_at: ingest,
    })
    const event = '2026-11-27T14:30:00.000000001Z'
    const report = evaluate({
      session: early,
      bars: [],
      quotes: [
        make(event, '2026-11-27T14:30:05.000000001Z', 1),
        make(event, '2026-11-27T14:30:05.000000002Z', 0),
        make(event, event, -2),
        { ...make(event, event, 6), ask_price: 0, ask_size: 0 },
        make('2026-11-27T14:29:59.999999999Z', event, -2),
        make('2026-11-27T17:59:59.999999999Z', early.closeAt, 3),
        make(early.closeAt, early.closeAt, -2),
      ],
    })
    expect(report.pooled.sip).toMatchObject({
      quoteCount: 5,
      staleQuotes: 1,
      staleQuoteRate: 0.2,
      crossedQuotes: 1,
      lockedQuotes: 1,
      oneSidedQuotes: 1,
      spreadBps: { count: 3, median: 1, p75: 3, p95: 3 },
      quoteIngestLatencyMs: { median: 0.000001, p95: 5000.000001 },
    })
    expect(checksThatFail(report)).toContain('sip-crossed-quotes')
  })

  test('uses weighted pools, p75/p95 ranks and strictly less than 2,000 ms', () => {
    const event = '2026-07-06T13:30:00.000000001Z'
    const fixture = qualified()
    const quotes = (ingest: string) => fixture.quotes.map((row) => ({ ...row, event_at: event, ingested_at: ingest }))
    const onLimit = evaluate({ ...fixture, quotes: quotes('2026-07-06T13:30:02.000000001Z') })
    expect(checksThatFail(onLimit)).toEqual(['sip-quote-ingest-latency'])
    const below = quotes('2026-07-06T13:30:02.000000000Z')
    expect(evaluate({ ...fixture, quotes: below }).gate.pass).toBe(true)
    const withWideSmh = evaluate({
      ...fixture,
      quotes: [...below.filter((row) => row.symbol !== 'SMH'), quote('SMH', regular, 2.01)],
    })
    expect(checksThatFail(withWideSmh)).toEqual(['sip-median-spread:SMH'])

    const pooled = evaluate({
      session: regular,
      bars: [],
      quotes: [quote('SMH', regular, 100), ...[1, 2, 3, 4, 5].map((bps) => quote('QQQ', regular, bps))],
    })
    expect(pooled.pooled.sip.spreadBps).toEqual({ count: 6, median: 3.5, p75: 5, p95: 100 })
  })

  test('pairs only occupied minutes, selects final revisions deterministically and reports IEX-relative bps', () => {
    const first = { ...bar('QQQ'), event_at: '2026-07-06T13:30:00.000000001Z' }
    const revised = { ...first, close: 101, source_offset: '9007199254740993' }
    const sameMillisecond = {
      ...first,
      close: 102,
      source_offset: '0',
      ingested_at: '2026-07-06T13:31:00.100000001Z',
    }
    const bars = [revised, bar('QQQ', regular, 0, Iex), first, sameMillisecond, bar('QQQ', regular, 1, Iex)]
    const report = evaluate({ session: regular, bars, quotes: [] })
    expect(report.pooled.sip.barCount).toBe(1)
    expect(report.pooled.barCloseDivergenceBps).toEqual({ count: 1, median: 200, p75: 200, p95: 200 })
    expect(report.pooled.sip.barIngestLatencyMs.median).toBe(60_100)
    expect(evaluate({ session: regular, bars: bars.toReversed(), quotes: [] })).toEqual(report)
    const conflict = decodeShadowSnapshot({
      session: regular,
      bars: [...bars, { ...sameMillisecond, close: 103 }],
      quotes: [],
    })
    expect(Result.isFailure(compareShadowSnapshot(Result.getOrThrow(conflict)))).toBe(true)
  })

  test('empty evidence fails closed and both scorecards are deterministic under input reordering', () => {
    const empty = evaluate({ session: regular, bars: [], quotes: [] })
    expect(empty.gate.pass).toBe(false)
    expect(empty.pooled.sip.staleQuoteRate).toBeNull()
    expect(empty.pooled.sip.quoteIngestLatencyMs.p95).toBeNull()
    expect(checksThatFail(empty)).toContain('sip-quote-ingest-latency')

    const fixture = qualified()
    const first = evaluate(fixture)
    const second = evaluate({ ...fixture, bars: fixture.bars.toReversed(), quotes: fixture.quotes.toReversed() })
    for (const format of [ReportFormat.Markdown, ReportFormat.Json])
      expect(renderShadowReport(second, format)).toBe(renderShadowReport(first, format))
    const markdown = renderShadowReport(first, ReportFormat.Markdown)
    for (const label of ['**PASS**', 'QQQ', 'SMH', 'XLK', 'SPY', 'All 73', 'Common-symbol pooled spread'])
      expect(markdown).toContain(label)
  })

  test('strictly decodes actual wire types, timestamp precision, provenance and session bounds', () => {
    for (const invalid of [
      { feed: 'delayed_sip' },
      { source_topic: iexTopics.quotes },
      { delay_class: 'real_time_exchange_only' },
      { provider: 'other' },
      { schema_version: 2 },
      { bid_price: '100' },
      { bid_price: Infinity },
      { bid_price: 0 },
      { ask_size: -1 },
      { event_at: '2026-07-06T13:30:00.1234567890Z' },
      { event_at: '2026-07-06T13:30:00.123456789+00:00' },
      { event_at: '2026-02-30T13:30:00Z' },
      { universe_symbol_hash: 'short' },
      { extra: null },
    ]) {
      expect(
        Result.isFailure(
          decodeShadowSnapshot({
            session: regular,
            bars: [],
            quotes: [{ ...quote('QQQ'), ...invalid }],
          }),
        ),
      ).toBe(true)
    }
    for (const invalid of [
      { is_final: true },
      { close: 0 },
      { source_offset: 10 },
      { source_offset: '9223372036854775808' },
    ])
      expect(
        Result.isFailure(
          decodeShadowSnapshot({
            session: regular,
            bars: [{ ...bar('QQQ'), ...invalid }],
            quotes: [],
          }),
        ),
      ).toBe(true)
    for (const session of [
      { ...regular, date: '2026-07-07' },
      { ...early, openAt: '2026-11-27T13:30:00Z' },
      { ...early, closeAt: '2026-11-27T18:00:00.000000001Z' },
    ])
      expect(Result.isFailure(decodeShadowSnapshot({ session, bars: [], quotes: [] }))).toBe(true)
  })
})

const provider = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    BAYN_CLICKHOUSE_URL: 'https://archive.test:8443',
    BAYN_CLICKHOUSE_USERNAME: 'shadow-reader',
    BAYN_CLICKHOUSE_PASSWORD: 'secret-password-marker',
    BAYN_ALPACA_KEY_ID: 'alpaca-key-marker',
    BAYN_ALPACA_SECRET_KEY: 'alpaca-secret-marker',
  }),
)
const jsonl = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

const harness = (fetcher: (url: URL, init?: RequestInit) => Response | Promise<Response>, config = provider) => {
  const output: string[] = []
  const calls: string[] = []
  const mockFetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      calls.push(url.hostname === 'archive.test' ? (url.searchParams.get('param_sipTopic') ?? '') : url.pathname)
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      return Promise.resolve(fetcher(url, init))
    },
    { preconnect: fetch.preconnect },
  )
  const layer = Layer.mergeAll(
    NodeFileSystem.layer,
    FetchHttpClient.layer,
    config,
    TestClock.layer(),
    Stdio.layerTest({
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void output.push(String(chunk)))),
    }),
  )
  const apply = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, mockFetch),
      // @effect-diagnostics-next-line strictEffectProvide:off -- boundary tests supply the CLI clock, transport and I/O
      Effect.provide(layer),
    )
  const run = (flags: string[]) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-11-28T00:00:00Z'))
      return yield* runShadowVerifier(flags)
    }).pipe(apply, Effect.runPromiseExit)
  return { output, calls, run, apply }
}

const earlyCalendar = () =>
  Response.json([
    {
      date: early.date,
      open: '09:30',
      close: '13:00',
      session_open: '0400',
      session_close: '1700',
    },
  ])
const cliArgs = ['--session', early.date, '--format', 'json']

describe('SIP parity CLI boundary', () => {
  test('reads the provider calendar and issues only the two fixed archive GETs; live and fixture outputs agree', async () => {
    const fixture = qualified(early, 210)
    const http = harness((url, init) => {
      const headers = new Headers(init?.headers)
      if (url.pathname === '/v2/calendar') {
        expect(url.searchParams.get('start')).toBe(early.date)
        expect(url.searchParams.get('end')).toBe(early.date)
        expect(url.searchParams.get('date_type')).toBe('TRADING')
        expect(headers.get('apca-api-secret-key')).toBe('alpaca-secret-marker')
        return earlyCalendar()
      }
      expect(headers.get('x-clickhouse-key')).toBe('secret-password-marker')
      expect(url.href).not.toContain('secret-password-marker')
      const sql = url.searchParams.get('query')?.trim()
      expect(sql).toMatch(/^SELECT /)
      expect(url.searchParams.get('param_open')).toBe('2026-11-27T14:30:00.000Z')
      expect(url.searchParams.get('param_close')).toBe('2026-11-27T18:00:00.000Z')
      if (url.searchParams.get('param_sipTopic') === sipTopics.bars) {
        expect(sql).toContain('FROM signal.intraday_bars_1m_v2 FINAL')
        expect(sql).toContain('coalesce(event_ts_exact, event_ts)')
        expect(url.searchParams.get('param_iexTopic')).toBe(iexTopics.bars)
        return new Response(jsonl(fixture.bars))
      }
      expect(sql).toContain('FROM signal.intraday_quotes_v1 FINAL')
      expect(url.searchParams.get('param_iexTopic')).toBe(iexTopics.quotes)
      return new Response(jsonl(fixture.quotes))
    })
    expect(Exit.isSuccess(await http.run(cliArgs))).toBe(true)
    expect(http.calls).toEqual(['/v2/calendar', sipTopics.bars, sipTopics.quotes])
    const offline = harness(
      () => {
        throw new Error('fixture attempted network I/O')
      },
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
    )
    const dir = await mkdtemp(join(tmpdir(), 'bayn-sip-shadow-test-'))
    const path = join(dir, 'fixture.json')
    try {
      const exactFixture = {
        ...fixture,
        session: { ...early, openAt: '2026-11-27T14:30:00.000Z', closeAt: '2026-11-27T18:00:00.000Z' },
      }
      await writeFile(path, JSON.stringify(exactFixture))
      expect(Exit.isSuccess(await offline.run([...cliArgs, '--fixture', path]))).toBe(true)
      expect(offline.output).toEqual(http.output)
      expect(offline.calls).toEqual([])
      expect(Exit.isFailure(await offline.run(['--session', regular.date, '--fixture', path]))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('operational errors redact transport/response content; missing sessions do not touch the archive', async () => {
    const closed = harness(() => Response.json([]))
    expect(Exit.isFailure(await closed.run(cliArgs))).toBe(true)
    expect(closed.calls).toEqual(['/v2/calendar'])

    const denied = harness((url) =>
      url.pathname === '/v2/calendar' ? earlyCalendar() : new Response('secret-password-marker', { status: 403 }),
    )
    const exit = await denied.run(cliArgs)
    if (!Exit.isFailure(exit)) throw new Error('unexpected successful read')
    expect(Cause.pretty(exit.cause)).toContain('HTTP 403')
    expect(Cause.pretty(exit.cause)).not.toContain('secret-password-marker')
    expect(denied.output).toEqual([])

    const malformed = harness((url) =>
      url.pathname === '/v2/calendar' ? earlyCalendar() : new Response('malformed-response'),
    )
    const malformedExit = await malformed.run(cliArgs)
    if (!Exit.isFailure(malformedExit)) throw new Error('unexpected successful decode')
    expect(Cause.pretty(malformedExit.cause)).toContain('invalid row at line 1')
    expect(malformed.output).toEqual([])
  })

  test('gate failure prints a machine-readable report before returning non-success', async () => {
    const empty = harness((url) => (url.pathname === '/v2/calendar' ? earlyCalendar() : new Response('')))
    expect(Exit.isFailure(await empty.run(cliArgs))).toBe(true)
    expect(empty.output.join('')).toContain('"pass": false')
    expect(Exit.isFailure(await empty.run([...cliArgs, '--format', 'markdown']))).toBe(true)
  })

  test('entry point keeps a FAIL scorecard parseable on stdout and reports the error on stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bayn-sip-shadow-cli-'))
    try {
      const path = join(dir, 'fixture.json')
      await writeFile(path, JSON.stringify({ session: early, bars: [], quotes: [] }))
      const script = new URL('./verify-sip-vs-iex-shadow.ts', import.meta.url).pathname
      const child = Bun.spawn([process.execPath, script, ...cliArgs, '--fixture', path], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(1)
      expect(stdout.trim()).toBe(
        renderShadowReport(evaluate({ session: early, bars: [], quotes: [] }), ReportFormat.Json),
      )
      expect(stderr).toContain('SIP shadow promotion gate failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.each(['timeout', 'interrupt'] as const)(
    'cancels an in-flight archive response on %s without a command or retry',
    async (mode) => {
      const started = Promise.withResolvers<void>()
      let canceled = 0
      const http = harness((url) => {
        if (url.pathname === '/v2/calendar') return earlyCalendar()
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull: () => {
                started.resolve()
              },
              cancel: () => {
                canceled++
              },
            },
            { highWaterMark: 0 },
          ),
        )
      })
      const exit = await Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-11-28T00:00:00Z'))
        const fiber = yield* Effect.forkChild(runShadowVerifier(cliArgs))
        yield* Effect.promise(() => started.promise)
        if (mode === 'timeout') yield* TestClock.adjust('20 minutes')
        else yield* Fiber.interrupt(fiber)
        return yield* Fiber.join(fiber)
      }).pipe(http.apply, Effect.runPromiseExit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(canceled).toBe(1)
      expect(http.calls).toEqual(['/v2/calendar', sipTopics.bars])
      expect(http.output).toEqual([])
    },
  )
})
