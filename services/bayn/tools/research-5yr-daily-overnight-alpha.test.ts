import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { parseTape, readTape, seriesFor, universes } from './daily-alpha-data'
import { economics, gates, measure } from './daily-alpha-metrics'
import { capital, netAt, replay } from './daily-alpha-replay'
import {
  flat,
  isSubmittable,
  neighbors,
  residualScore,
  signalPlanners,
  trialGrid,
  trialId,
} from './daily-alpha-signals'
import { downloadTape, verifyReproducedFreeze, verifyReproducedScore } from './research-5yr-daily-overnight-alpha'

const row = (symbol: string, date: string, open: number, close: number) =>
  [symbol, `${date}T05:00:00Z`, open, Math.max(open, close), Math.min(open, close), close, 100_000, close].join('\t')

const friday = '2025-02-21'
const monday = '2025-02-24'
const tuesday = '2025-02-25'

test('truncates before Holdout and discards predecessor, when-issued and WDC jump returns', () => {
  const input = [friday, monday, tuesday]
    .flatMap((date, i) => [
      row('SPY', date, 100, 100 + i),
      row('SNDK', date, 50 + i, 52 + i),
      row('WDC', date, i === 0 ? 100 : 50, i === 0 ? 100 : 50),
    ])
    .join('\n')
  const tape = parseTape(input, monday, ['SPY', 'SNDK', 'WDC'])
  expect(tape.dates).toEqual([friday, monday])
  expect(tape.excluded).toEqual({ SNDK: 1 })
  expect(seriesFor(tape, 'SNDK').bars[0]).toBeUndefined()
  expect(seriesFor(tape, 'SNDK').daily[1]).toBeNaN()
  expect(seriesFor(tape, 'WDC').overnight[1]).toBeNaN()
  expect(() => parseTape(`${input}\n${row('SNDK', friday, 30, 40)}`, monday, ['SPY', 'SNDK', 'WDC'])).toThrow(
    'duplicate SIP bar',
  )
  expect(() => readTape(new Uint8Array(), 'freeze')).toThrow('SHA-256')
})

test('requires paired continuous history and ignores all bars after the signal', () => {
  const series = new Float64Array([0.01, -0.01, 0.015, 0.004, -0.008, 100])
  const spy = new Float64Array([0.008, -0.008, 0.009, 0.002, -0.02, -100])
  const early = residualScore(series, spy, 4, 5, 2)
  expect(early?.volatility).toBeGreaterThan(0)
  series[5] = -1_000
  spy[5] = 1_000
  expect(residualScore(series, spy, 4, 5, 2)).toEqual(early)
  series[2] = NaN
  expect(residualScore(series, spy, 4, 5, 2)).toBeUndefined()
})

function etfFixture(scale: number) {
  const input = universes.etfs
    .flatMap((symbol, s) =>
      Array.from({ length: 70 }, (_, i) => {
        const date = new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)
        const value = 100 * Math.exp(((s - 6) * i) / 10_000 + Math.sin(i / 2 - s) / 100)
        const changed = i >= 60 && s === 0 ? value * scale : value
        return row(symbol, date, changed, changed)
      }),
    )
    .join('\n')
  return parseTape(input, '2025-04-01', universes.etfs)
}

test('next-Open submits the previous-Close ranking and share sizes; same-Close is diagnostic', () => {
  const open = trialGrid().find(
    (trial) => trial.family === 'etf-rotation' && trial.execution === 'open-open' && trial.universe === 'etfs',
  )
  if (open === undefined) throw new Error('Missing rotation grid')
  const close = { ...open, execution: 'close-close' } as const
  const original = signalPlanners(etfFixture(1))
  const changed = signalPlanners(etfFixture(1.5))
  const nextOpen = original(open)(60, 'open')
  expect(nextOpen?.size).toBe(6)
  expect(changed(open)(60, 'open')).toEqual(nextOpen)
  expect(original(open)(60, 'close')).toBeUndefined()
  expect(original(close)(60, 'close')).not.toEqual(changed(close)(60, 'close'))
  expect(isSubmittable(open)).toBe(true)
  expect(isSubmittable(close)).toBe(false)
  const omitted = [...(nextOpen?.keys() ?? [])][0]
  const excluded = original(open)(60, 'open', omitted)
  expect(excluded?.has(omitted)).toBe(false)
  expect(excluded?.size).toBe(6)
})

test('charges both legs, sell fee and weekend borrow on prior close short dollars, then flattens at terminal Open', () => {
  const tape = parseTape([row('SPY', friday, 100, 100), row('SPY', monday, 80, 70)].join('\n'), monday, ['SPY'])
  const alwaysShort = new Map([['SPY', -0.005]])
  const run = replay(tape, { start: 0, end: 2 }, [
    { end: 'open', plan: (_, phase) => (phase === 'close' ? alwaysShort : flat) },
  ])
  if (run.error !== undefined) throw new Error(run.error)
  const [a, b] = run.days
  expect(a.sold).toBe(50_000)
  expect(b.sold).toBe(0)
  expect(b.traded).toBe(40_000)
  expect(b.pnl).toBe(10_000)
  expect(b.borrow).toBeCloseTo((50_000 * 0.015 * 3) / 365, 10)
  expect(netAt(a, 10) + netAt(b, 10)).toBeCloseTo(10_000 - 45 - 1.05 - b.borrow, 10)
})

test('nets sleeves at the actual order boundary and does not consume current P&L for risk sizing', () => {
  const tape = parseTape(
    [row('SPY', friday, 100, 100), row('SPY', monday, 80, 70), row('SPY', tuesday, 70, 75)].join('\n'),
    tuesday,
    ['SPY'],
  )
  const sleeves = [1, -1].map((sign) => ({
    end: 'close' as const,
    plan: (i: number) => (i === 0 ? undefined : new Map([['SPY', sign * 0.01]])),
  }))
  const result = replay(tape, { start: 0, end: 3 }, sleeves, undefined, {
    window: 2,
    histories: [
      [1, 2, 3],
      [-100, 2, 3],
    ],
  })
  if (result.error !== undefined) throw new Error(result.error)
  expect(result.days[1].traded).toBe(0)
  expect(result.days[1].pnl).toBe(0)
  expect(result.days[1].borrow).toBe(0)
})

test('does not mark a held position with a stale print', () => {
  const input = [
    row('SPY', friday, 100, 100),
    row('SPY', monday, 80, 70),
    row('SNDK', monday, 50, 51),
    row('SPY', tuesday, 70, 75),
  ].join('\n')
  const tape = parseTape(input, tuesday, ['SPY', 'SNDK'])
  const run = replay(tape, { start: 1, end: 3 }, [
    { end: 'open', plan: (_, phase) => (phase === 'close' ? new Map([['SNDK', 0.01]]) : flat) },
  ])
  expect(run.error).toBe('Missing held SNDK open 2025-02-25')
})

test('keeps the exact universe controls and enumerates one-step neighbors without duplicates', () => {
  expect(Object.values(universes).map(({ length }) => length)).toEqual([50, 18, 46, 17, 16, 4])
  const grid = trialGrid()
  expect(grid.length).toBe(824)
  expect(new Set(grid.map(trialId)).size).toBe(824)
  const center = grid.find(
    (trial) =>
      trial.family === 'momentum' &&
      trial.execution === 'open-open' &&
      trial.universe === 'live' &&
      trial.lookback === 10 &&
      trial.skip === 0 &&
      trial.k === 6 &&
      trial.hold === 5,
  )
  if (center === undefined) throw new Error('Missing center')
  const adjacent = neighbors(center, grid)
  expect(adjacent.length).toBe(7)
  expect(
    adjacent.every(
      (trial) => Object.values(trial).filter((value, index) => value !== Object.values(center)[index]).length === 1,
    ),
  ).toBe(true)
})

test('ex-top-five retains the small gains and all losses; the freeze requires exact receipts and ledger', () => {
  const values = [100, 80, 60, 40, 20, 10, -11]
  const performance = economics(values)
  expect(performance?.exTop5Usd).toBe(-1)
  expect(performance?.maxDrawdown).toBeCloseTo(11 / (capital + 310), 10)
  const frozen = { frozen: 'receipt', ledger: 'development' }
  expect(() => verifyReproducedFreeze(frozen, { ...frozen })).not.toThrow()
  expect(() => verifyReproducedFreeze(frozen, { ...frozen, ledger: 'changed' })).toThrow('refusing to open Holdout')
})

test('rejects realized gross drift beyond the registered cap rather than resizing from future auction prices', () => {
  const input = [row('SPY', friday, 100, 100), row('SPY', monday, 100, 110), row('SPY', tuesday, 200, 205)].join('\n')
  const tape = parseTape(input, tuesday, ['SPY'])
  const bounds = { start: 0, end: 3 }
  const run = replay(tape, bounds, [
    {
      end: 'open',
      plan: (i, phase) => (i === 1 && phase === 'open' ? new Map([['SPY', 0.01]]) : undefined),
    },
  ])
  const metrics = measure(tape, bounds, run)
  expect(metrics?.peakTradeGross).toBe(1)
  expect(metrics?.peakMarkedGross).toBe(2)
  expect(gates({ metrics, error: null, loso: { SPY: 1 } }, 0, true, false)).toContain('realized gross')
})

test('only a committed scored ledger permits an engine-change audit, never changed frozen results', () => {
  const bytes = (engine: string) => ({
    frozen: `{\n  "engineSha256": "${engine.repeat(64)}",\n  "finalists": []\n}`,
    ledger: 'development',
  })
  const frozen = bytes('a')
  const replayed = bytes('b')
  expect(() => verifyReproducedFreeze(frozen, replayed)).toThrow('refusing to open Holdout')
  const archived = { ...frozen, scoredLedger: 'scored' }
  expect(() => verifyReproducedFreeze(archived, replayed)).not.toThrow()
  expect(() => verifyReproducedFreeze(archived, { ...replayed, ledger: 'new development' })).toThrow(
    'refusing to open Holdout',
  )
  expect(() => verifyReproducedScore(archived.scoredLedger, 'scored')).not.toThrow()
  expect(() => verifyReproducedScore(archived.scoredLedger, 'revised Holdout')).toThrow('no artifacts written')
})

const artifact = { presign: () => 'https://example.invalid/?signature=not-for-logs' }

test('S3 download returns exact bytes, releases an HTTP error body, and redacts signed URLs', async () => {
  const bytes = await Effect.runPromise(downloadTape(artifact, async () => new Response(new Uint8Array([1, 2, 3]))))
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
  let cancelled = 0
  const response = new Response(
    new ReadableStream({
      cancel: () => {
        cancelled++
      },
    }),
    { status: 403 },
  )
  const error = await Effect.runPromise(Effect.flip(downloadTape(artifact, async () => response)))
  expect(error).toMatchObject({ _tag: 'DailyAlphaResearchError', cause: 'HTTP 403' })
  expect(cancelled).toBe(1)
  const transport = await Effect.runPromise(
    Effect.flip(
      downloadTape(artifact, async (url) => {
        throw new TypeError(url)
      }),
    ),
  )
  expect(transport).toMatchObject({ _tag: 'DailyAlphaResearchError', cause: 'TypeError' })
  expect(String(transport)).not.toContain('not-for-logs')
})

test.each(['interrupted', 'timed out'])('a %s S3 read aborts the in-flight request exactly once', async (mode) => {
  let aborted = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>()
      const fiber = yield* Effect.forkChild(
        downloadTape(
          artifact,
          (_url, options) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = options.signal
              if (signal == null) throw new Error('No transport cancellation signal')
              signal.addEventListener(
                'abort',
                () => {
                  aborted++
                  reject(new Error('Download aborted'))
                },
                { once: true },
              )
              Deferred.doneUnsafe(started, Effect.succeed(signal))
            }),
        ),
      )
      const signal = yield* Deferred.await(started)
      if (mode === 'interrupted') yield* Fiber.interrupt(fiber)
      else yield* TestClock.adjust('60 seconds')
      return { exit: yield* Fiber.await(fiber), signal }
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the test owns its virtual clock
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Exit.isFailure(result.exit)).toBe(true)
  expect(result.signal.aborted).toBe(true)
  expect(aborted).toBe(1)
})
