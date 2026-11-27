import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber } from 'effect'

import { regularCalendarReplayInput } from './midday-research-data'
import { verifyFreeze } from './research-orthogonal-sleeve4'
import { adjustSplit, chooseMinuteSource, fetchFrozenArtifact, split, type Candle } from './sleeve4-data'
import {
  correlation,
  developmentPass,
  dsrThreshold,
  economics,
  fill,
  netBps,
  select,
  type Outcome,
} from './sleeve4-evaluation'
import { decide, minuteHistory, requiredSymbols, trialRegistry, type Frame } from './sleeve4-signals'
import { runIntradayAlphaReplayVerification } from './verify-intraday-alpha-replay'

const price = (open: number, close = open, volume = 100): Candle => ({
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume,
})

const rule = (group: string, entry: number, threshold: number, exit?: number) => {
  const found = trialRegistry.find(
    (t) =>
      t.group === group && t.entry === entry && t.threshold === threshold && (exit === undefined || t.exit === exit),
  )
  if (found === undefined) throw new Error(`Missing test rule: ${group}`)
  return found
}

const frame = (bars: Frame['tapes'], minutes = 390): Frame => ({
  date: '2025-06-30',
  minutes,
  tapes: bars,
  prior: new Map(
    [...bars.keys()].map((symbol) => [
      symbol,
      {
        previousClose: 100,
        atr: 4,
        recentTr: 5,
        first5Volume: 100,
        momentum5: 0.03,
        momentum10: -0.03,
      },
    ]),
  ),
})

test('fixed split boundaries and a non-blended source splice', () => {
  expect(
    ['2024-01-01', '2024-01-02', '2025-06-30', '2025-07-01', '2026-03-31', '2026-04-01', '2026-11-25'].map(split),
  ).toEqual(['legacy', 'train', 'train', 'validation', 'validation', 'holdout', 'holdout'])
  expect(['2026-08-24', '2026-08-25', '2026-09-11'].map(chooseMinuteSource)).toEqual(['long', 'live', 'live'])
})

test('NVDA historical adjustment preserves notional and does not touch the split day', () => {
  const bar = price(1_200, 1_205, 9)
  expect(adjustSplit(bar, 'NVDA', '2024-06-07')).toEqual(price(120, 120.5, 90))
  expect(adjustSplit(bar, 'NVDA', '2024-06-10')).toEqual(bar)
  expect(adjustSplit(bar, 'SPY', '2024-06-07')).toEqual(bar)
})

test('ATR, prior-close and RVOL use only exact prior sessions without backfill', () => {
  const bars = Array.from({ length: 5 }, () => price(100, 102))
  const days = Array.from({ length: 16 }, (_, i) => ({
    date: `2025-01-${String(i + 1).padStart(2, '0')}`,
    minutes: 5,
    tapes: new Map([['NVDA', i === 15 ? Array.from({ length: 5 }, () => price(500, 700, 8_000)) : bars]]),
  }))
  expect(minuteHistory(days)[14]?.prior.size).toBe(0)
  expect(minuteHistory(days)[15]?.prior.get('NVDA')).toMatchObject({
    previousClose: 102,
    atr: 2,
    recentTr: 2,
    first5Volume: 100,
    momentum5: 0,
  })
  days[14]?.tapes.set('NVDA', bars.slice(0, 4))
  expect(minuteHistory(days)[15]?.prior.has('NVDA')).toBe(false)
})

test('opening fade and volume-confirmed continuation read only completed opening bars', () => {
  const fade = rule('A.core.gap-fade.stocks', 5, 0.5)
  const follow = rule('A.core.gap-follow.stocks', 5, 0.5)
  const bars = [price(103), price(103), price(103), price(103), price(103, 102), price(1000)]
  expect(decide(fade, frame(new Map([['NVDA', bars]]))).legs).toEqual([{ symbol: 'NVDA', side: -1, weight: 1 / 3 }])
  expect(decide(follow, frame(new Map([['NVDA', bars]]))).legs).toEqual([])
  const loud = bars.map((_, i) => price(103, 103 + i, 126))
  expect(decide(follow, frame(new Map([['NVDA', loud]]))).legs[0]?.side).toBe(1)
  loud[5] = price(1, 1, 1)
  expect(decide(follow, frame(new Map([['NVDA', loud]]))).legs[0]?.side).toBe(1)
})

test('power-hour persistence checks the completed 14:00 endpoint and respects early close', () => {
  const spec = rule('B.core.persistent.indexes', 330, 0.25)
  const tape = Array.from<Candle | undefined>({ length: 390 })
  tape[0] = price(100)
  tape[29] = price(103)
  tape[269] = price(104)
  tape[329] = price(105)
  tape[330] = price(95)
  expect(decide(spec, frame(new Map([['QQQ', tape]]))).legs[0]?.side).toBe(1)
  tape[269] = price(101)
  expect(decide(spec, frame(new Map([['QQQ', tape]]))).legs).toEqual([])
  expect(decide(spec, frame(new Map([['QQQ', tape]]), 210))).toEqual({ observed: true, legs: [] })
})

test('four-index rotation stays gross-balanced and does not substitute for a missing leader', () => {
  const spec = rule('C.core.risk-rotation.indexes', 210, 30)
  const bars = new Map<string, (Candle | undefined)[]>()
  for (const [sym, close] of [
    ['SMH', 103],
    ['QQQ', 102],
    ['IWM', 101],
    ['SPY', 101],
  ] as const) {
    const tape = Array.from<Candle | undefined>({ length: 390 })
    tape[0] = price(100)
    tape[209] = price(close)
    bars.set(sym, tape)
  }
  const legs = decide(spec, frame(bars)).legs
  expect(legs.map(({ side }) => side)).toEqual([1, 1, -1, -1])
  expect(legs.reduce((total, leg) => total + leg.weight * leg.side, 0)).toBe(0)
  const rates = rule('C.live.rates.duration', 210, 10)
  expect(requiredSymbols(rates)).toContain('IEF')
  expect(decide(rates, frame(bars)).observed).toBe(false)
  bars.delete('SPY')
  expect(decide(spec, frame(bars)).observed).toBe(false)
})

test('dispersion fades completed winners, not the next bar, and requires broad coverage', () => {
  const spec = rule('D.live.dispersion-fade.single-names', 210, 40)
  const symbols = ['AAPL', 'AMD', 'AMZN', 'AVGO']
  const bars = new Map(
    symbols.map((s, i) => {
      const tape = Array.from<Candle | undefined>({ length: 390 })
      tape[179] = price(100)
      tape[209] = price(100 + i)
      tape[210] = price(1000 - i)
      return [s, tape]
    }),
  )
  const reduced = { ...spec, length: 1, symbols }
  expect(decide(reduced, frame(bars)).legs).toEqual([
    { symbol: 'AAPL', side: 1, weight: 0.5 },
    { symbol: 'AVGO', side: -1, weight: 0.5 },
  ])
  bars.delete('AMD')
  expect(decide(reduced, frame(bars)).observed).toBe(false)
})

test('daily residual context uses its declared lookback and subtracts SPY from other symbols', () => {
  const spec = rule('E.core.residual.indexes', 5, 0.25)
  const tape = [price(100), price(100), price(100), price(100), price(100), price(500)]
  const d = frame(
    new Map([
      ['SPY', tape],
      ['QQQ', tape],
    ]),
  )
  expect(decide(spec, d).legs.map(({ symbol, side }) => [symbol, side])).toEqual([['SPY', 1]])
  expect(decide({ ...spec, length: 10 }, d).legs.map(({ symbol, side }) => [symbol, side])).toEqual([['SPY', -1]])
})

test('uses next OPEN with adverse slippage and sell fee, never forward-fills entries or unresolved exits', () => {
  const long = { symbol: 'AAPL', side: 1, weight: 1 }
  const tape = [price(10, 99), price(100, 90), undefined, price(110, 80)]
  const actual = fill(long, tape, 1, 2, 4)
  expect(actual).toEqual({ leg: long, entry: 100, exit: 110, delay: 1 })
  const short = fill({ ...long, side: -1 }, tape, 1, 2, 4)
  if (actual === null || short === null) throw new Error('Missing fixture fill')
  expect(netBps(actual, 5)).toBeCloseTo((10_000 * (109.9725 - 100.025)) / 100.025 - (0.21 * 109.9725) / 100.025, 8)
  expect(netBps(short, 5)).toBeCloseTo((10_000 * (99.975 - 110.0275)) / 99.975 - 0.21, 8)
  expect(fill(long, tape, 2, 3, 4)).toBeNull()
  const unresolved = fill(long, tape, 1, 2, 3)
  if (unresolved === null) throw new Error('Missing fixture fill')
  expect(unresolved.exit).toBeNull()
  expect(economics([{ date: '2026-04-01', fills: [unresolved], intended: 1, observed: true }], 5).netBps).toBeNull()
})

test('ex-top-five checks concentration; signed correlation rejects constant series', () => {
  const observations: Outcome[] = Array.from({ length: 25 }, (_, day) => ({
    date: `2026-04-${String(day + 1).padStart(2, '0')}`,
    observed: true,
    intended: 1,
    fills: [{ leg: { symbol: 'SPY', side: 1, weight: 1 }, entry: 100, exit: day < 5 ? 105 : 100, delay: 0 }],
  }))
  const base = economics(observations, 5)
  expect(base.top5.map((d) => d.date)).toEqual(observations.slice(0, 5).map((d) => d.date))
  expect(base.netBps).toBeGreaterThan(0)
  expect(base.exTop5Bps).toBeLessThan(0)
  expect(base.bootstrapP).toBe(economics(observations, 5).bootstrapP)
  expect(
    correlation([
      [1, 0],
      [2, 0],
      [3, 0],
    ]),
  ).toEqual({ n: 3, activeTogether: 0, pearson: null })
  expect(
    correlation([
      [1, -1],
      [2, -2],
      [3, -3],
    ]).pearson,
  ).toBe(-1)
  expect(dsrThreshold([null, 0.1, -0.1], 100, 200)).toBeGreaterThan(dsrThreshold([0.1, -0.1], 100, 2) ?? 0)
})

test('frozen selection checks the receipt and requires adjacent viable variants', () => {
  expect(() => verifyFreeze('{"id":"one"}', '{"id":"two"}')).toThrow('Frozen selection does not match')
  expect(() => verifyFreeze('{ "id": "same" }', '{"id":"same"}')).not.toThrow()
  const spec = rule('A.core.gap-fade.stocks', 5, 0.5, 45)
  const rows = Array.from(
    { length: 40 },
    (_, i): Outcome => ({
      date: `2026-04-${i}`,
      observed: true,
      intended: 1,
      fills: [{ leg: { symbol: 'SPY', side: 1, weight: 1 }, entry: 100, exit: 101 + i * 0.01, delay: 0 }],
    }),
  )
  const stats = { 5: economics(rows, 5), 10: economics(rows, 10) }
  expect(developmentPass(stats, stats)).toBe(true)
  expect(select([{ rule: spec, train: stats, validation: stats }]).development[0]?.passed).toBe(false)
  const adjacent = trialRegistry.filter((r) => r.group === spec.group)
  const selection = select(adjacent.map((candidate) => ({ rule: candidate, train: stats, validation: stats })))
  expect(selection.development.find(({ rule: candidate }) => candidate.id === spec.id)?.adjacentPasses).toHaveLength(4)
  expect(selection.development.every((r) => r.passed)).toBe(true)
  expect(new Set(trialRegistry.map((r) => r.id)).size).toBe(trialRegistry.length)
})

test('frozen regular-only calendar is accepted by the existing v2 replay', () => {
  const input = {
    query: { start: '2026-11-27', end: '2026-11-27' },
    response: [{ date: '2026-11-27', open: '09:30', close: '13:00' }],
  }
  const replay = runIntradayAlphaReplayVerification(['/dev/null'], input)
  const enriched = runIntradayAlphaReplayVerification(['/dev/null'], regularCalendarReplayInput(input))
  expect(replay.calendarHash).toBe(enriched.calendarHash)
  expect(replay.results[0]?.sessionDetails[0]?.expectedRegularMinutes).toBe(210)
})

const testClient = { presign: () => 'https://example.invalid/?signature=not-for-logs' }

test('frozen download returns bytes and cancels a rejected HTTP body exactly once without logging its signed URL', async () => {
  const result = await Effect.runPromise(
    fetchFrozenArtifact(testClient, 'MANIFEST.json', async () => new Response('receipt bytes')),
  )
  expect(result.toString()).toBe('receipt bytes')
  let cancellations = 0
  const response = new Response(
    new ReadableStream({
      cancel: () => {
        cancellations++
      },
    }),
    { status: 403 },
  )
  const failure = await Effect.runPromise(
    Effect.flip(fetchFrozenArtifact(testClient, 'MANIFEST.json', async () => response)),
  )
  expect(failure).toMatchObject({
    _tag: 'Sleeve4ResearchError',
    operation: 'Download frozen artifact MANIFEST.json',
    cause: 'HTTP 403',
  })
  expect(cancellations).toBe(1)
  const transport = await Effect.runPromise(
    Effect.flip(
      fetchFrozenArtifact(testClient, 'MANIFEST.json', async (url) => {
        throw new TypeError(url)
      }),
    ),
  )
  expect(transport.cause).toBe('TypeError')
  expect(String(transport)).not.toContain('not-for-logs')
})

test('interrupting a frozen download aborts the in-flight request exactly once', async () => {
  let cancellations = 0
  const signal = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>()
      const fiber = yield* Effect.forkChild(
        fetchFrozenArtifact(
          testClient,
          'MANIFEST.json',
          (_url, options) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = options.signal
              if (signal == null) throw new Error('No transport cancellation signal')
              signal.addEventListener(
                'abort',
                () => {
                  cancellations++
                  reject(new Error('Download aborted'))
                },
                { once: true },
              )
              Deferred.doneUnsafe(started, Effect.succeed(signal))
            }),
        ),
      )
      const active = yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return active
    }),
  )
  expect(signal.aborted).toBe(true)
  expect(cancellations).toBe(1)
})
