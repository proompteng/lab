import { describe, expect, test } from 'bun:test'

import { type Day, Field, makeSeries, price } from './8yr-unseen-intraday-tape'
import { netReturns, pairedMetrics, performance } from './research-sector-etf-intraday-expansion'
import { type ArchiveReader, type GzipReceipt, readGzipLines } from './research-lib/s3-archive'
import { stationaryBootstrap } from './research-lib/statistics'
import type { DailyFrame } from './research/macro-etf-core-dual-horizon-data'
import { loadTape, Tape } from './sector-etf-expansion-data'
import {
  annualLiquidity,
  bookOrder,
  capital,
  CloseLocation,
  Direction,
  emptyLedger,
  flattenSlot,
  GapBook,
  gapInputs,
  gapLegs,
  GapSize,
  type GapTrial,
  gapTrials,
  lookback,
  noiseOrder,
  noiseTrials,
  type RankedGap,
  replay,
  replayGap,
  riskWeights,
  sectors,
  symbols,
  warmup,
  Weighting,
} from './sector-etf-expansion-replay'

const put = (series: Float64Array, slot: number, open: number, close = open, volume = 10_000) => {
  series.set([open, Math.max(open, close), Math.min(open, close), close, volume, open], slot * 6)
}

const tape = (slots: number, open: number, volume = 10_000) => {
  const data = makeSeries(slots)
  for (let slot = 0; slot < slots; slot++) put(data, slot, open, open, volume)
  return data
}

const drop = (data: Float64Array, slot: number) => data.fill(0, slot * 6, (slot + 1) * 6)
const day = (index: number, bars: Day['bars'], slots = 78): Day => ({
  date: new Date(Date.UTC(2021, 0, index + 1)).toISOString().slice(0, 10),
  slots,
  bars,
})

const firstBreakout = (slots = 78) => {
  const history = Array.from({ length: lookback }, (_, index) => {
    const data = tape(78, 100)
    put(data, 5, 100, 101)
    put(data, 11, 100, 101)
    return day(index, new Map([['QQQ', data]]))
  })
  const data = tape(slots, 100)
  put(data, 5, 100, 102)
  put(data, 6, 103)
  return { data, days: [...history, day(lookback, new Map([['QQQ', data]]), slots)] }
}

const gap = (changes: Partial<GapTrial> = {}): GapTrial => ({
  id: 'gap fixture',
  direction: Direction.Continuation,
  book: GapBook.DollarNeutral,
  size: GapSize.Medium,
  location: CloseLocation.Aligned,
  minutes: 30,
  ...changes,
})
const ranks: RankedGap[] = [
  { symbol: 'XLK', atrUnits: 0.6, location: 0.65 },
  { symbol: 'XLF', atrUnits: 0.5, location: 0.8 },
  { symbol: 'XLB', atrUnits: -0.25, location: 0.35 },
]

describe('Wave 18D protocol', () => {
  test('registers all rungs, both weightings and 32 distinct gap tests', () => {
    expect(symbols).toHaveLength(13)
    expect(sectors).toHaveLength(9)
    expect(noiseTrials.map(({ fixed, top }) => fixed.length + top)).toEqual([2, 3, 3, 4, 4, 7, 7, 10, 10, 13, 13])
    expect(gapTrials).toHaveLength(32)
    expect(new Set([...noiseTrials, ...gapTrials].map(({ id }) => id)).size).toBe(43)
  })

  test('sizes by lagged volatility and uses distinct covariance weights on a correlated book', () => {
    const inverse = riskWeights(
      [
        [-0.01, 0.01],
        [-0.02, 0.02],
      ],
      Weighting.InverseVol,
    )
    expect(inverse[0]).toBeCloseTo(2 / 3, 12)
    expect(inverse[1]).toBeCloseTo(1 / 3, 12)
    const history = [
      [0.01, -0.01, 0, 0],
      [0.01, -0.01, 0, 0],
      [0, 0, 0.01, -0.01],
    ]
    expect(riskWeights(history, Weighting.InverseVol)[2]).toBeCloseTo(1 / 3, 12)
    const equalRisk = riskWeights(history, Weighting.EqualRisk)
    expect(equalRisk[0]).toBeCloseTo(equalRisk[1], 12)
    expect(equalRisk[2]).toBeGreaterThan(1 / 3)
    expect(equalRisk.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  test('uses only preceding complete-session dollar volume in an annual election', () => {
    const history = Array.from({ length: warmup + 1 }, (_, i) => {
      const bars = new Map(sectors.map((symbol, j) => [symbol, tape(78, 100, 1_000 * (j + 1))]))
      if (i === warmup) bars.set('XLF', tape(78, 300, 1_000_000))
      return day(i, bars)
    })
    const result = annualLiquidity(history).get('2021')
    expect(result).toEqual({
      asOf: history[warmup - 1].date,
      ranked: ['XLB', 'XLU', 'XLP', 'XLY', 'XLI', 'XLV', 'XLE', 'XLF'],
    })
    const missing = history.map((row, i) => {
      if (i >= 6) return row
      const bars = new Map(row.bars)
      bars.delete('XLB')
      return { ...row, bars }
    })
    expect(annualLiquidity(missing).get('2021')?.ranked).toBeNull()
  })
})

describe('causal orders', () => {
  test('uses the next open after each completed breakout and opposing checkpoint', () => {
    const { data, days } = firstBreakout()
    put(data, 11, 100, 98)
    put(data, 12, 96)
    const result = noiseOrder(days, lookback, 'QQQ')
    expect(result.order).toMatchObject({ side: 1, reference: 102, entry: 6, exit: 12 })
    drop(data, 6)
    expect(noiseOrder(days, lookback, 'QQQ')).toEqual({ missing: 0, missingEntry: true })
  })

  test.each([78, 42])('requires an observed exit by close minus ten (%i-slot session)', (slots) => {
    const { data, days } = firstBreakout(slots)
    expect(noiseOrder(days, lookback, 'QQQ').order?.exit).toBe(slots - 3)
    const last = flattenSlot(slots)
    drop(data, last - 1)
    expect(noiseOrder(days, lookback, 'QQQ').order?.exit).toBe(last)
    drop(data, last)
    const late = noiseOrder(days, lookback, 'QQQ').order
    expect(late?.exit).toBeNull()
    const ledger = emptyLedger()
    if (late === undefined) throw new Error('Expected a verified entry')
    bookOrder(ledger, late, 50)
    expect(ledger.unresolved).toBe(1)
    expect(netReturns([ledger], 0)).toBeNull()
  })

  test('uses lagged daily fractional ATR and close location, not intraday price levels', () => {
    const rows = Array.from({ length: lookback + 1 }, () => ({ open: 100, high: 102, low: 98, close: 101 }))
    const { atr, location } = gapInputs(rows)
    expect(atr).toBeCloseTo(4 / 101, 14)
    expect(location).toBe(0.75)
  })

  test('ranks extreme legs without fallback and flips the prescribed directions', () => {
    expect(gapLegs(ranks, gap())).toEqual([
      { symbol: 'XLK', side: 1 },
      { symbol: 'XLB', side: -1 },
    ])
    expect(gapLegs(ranks, gap({ direction: Direction.Fade }))).toEqual([
      { symbol: 'XLB', side: 1 },
      { symbol: 'XLK', side: -1 },
    ])
    const large = [{ ...ranks[0], atrUnits: 0.75, location: 0.35 }, ...ranks.slice(1)]
    expect(gapLegs(large, gap())).toEqual([])
    expect(gapLegs(large, gap({ book: GapBook.LongOnly }))).toEqual([])
    expect(
      gapLegs(large, gap({ book: GapBook.LongOnly, size: GapSize.Large, location: CloseLocation.Opposed })),
    ).toEqual([{ symbol: 'XLK', side: 1 }])
  })

  test('enters both legs at 09:35 and uses the requested horizon rather than the later bar or close', () => {
    const top = tape(78, 100)
    const bottom = tape(78, 250)
    put(top, 0, 90)
    put(top, 6, 101)
    put(top, 12, 103)
    put(bottom, 6, 247.5)
    put(bottom, 12, 245)
    const session = day(
      0,
      new Map([
        ['XLK', top],
        ['XLB', bottom],
      ]),
    )
    const thirty = replayGap(session, ranks, gap())
    const sixty = replayGap(session, ranks, gap({ minutes: 60 }))
    const budget = capital / 1.0005
    expect(thirty.turnover).toBeCloseTo((2 * budget) / capital, 12)
    expect(thirty.base).toBeCloseTo(budget * (0.01 - (1.005 * 0.21) / 10_000), 10)
    expect(sixty.base).toBeGreaterThan(thirty.base)
    expect(thirty.capacityUsd).toBeCloseTo((0.01 * 10_000 * 100 * capital) / (budget / 2), 10)
    drop(bottom, 6)
    expect(netReturns([replayGap(session, ranks, gap())], 5)).toBeNull()
    drop(bottom, 1)
    expect(replayGap(session, ranks, gap())).toMatchObject({ missingEntries: 1, filled: 0 })
    expect(replayGap(session, null, gap())).toMatchObject({ missingInputs: 1, filled: 0 })
  })

  test('ranks from the real feature path, using the prior and not the current daily close location', () => {
    const today = new Map(
      symbols.map((symbol) => [symbol, tape(78, symbol === 'XLK' ? 102 : symbol === 'XLB' ? 98 : 100)]),
    )
    const days = Array.from({ length: warmup + 1 }, (_, i) =>
      day(i, i === warmup ? today : new Map(symbols.map((symbol) => [symbol, tape(78, 100)]))),
    )
    const daily: DailyFrame[] = days.map(({ date }, i) => ({
      date,
      openAt: 0,
      closeAt: 0,
      bars: new Map(
        symbols.map((symbol) => [
          symbol,
          {
            open: 100,
            high: 102,
            low: 98,
            close: i === warmup ? 100 : symbol === 'XLK' ? 101 : symbol === 'XLB' ? 99 : 100,
          },
        ]),
      ),
    }))
    const id = 'B/30m/continuation/dollar-neutral/0.25-to-0.75-ATR/aligned'
    const lookup = () =>
      replay(days, daily)
        .gap.find(({ spec }) => spec.id === id)
        ?.rows.at(-1)
    expect(lookup()?.filled).toBe(2)
    today.delete('XLY')
    expect(lookup()).toMatchObject({ filled: 0, missingInputs: 1 })
  })
})

test('uses adverse half-slippage on both fills, a stressed sell fee, and a paired daily comparison', () => {
  const ledger = emptyLedger()
  const series = tape(78, 100)
  put(series, 6, 105)
  bookOrder(ledger, { series, side: 1, reference: 100, entry: 1, exit: 6, deadline: 6 }, 1_000)
  const expected = (105 * (1 - 5 / 20_000) * (1 - 0.21 / 10_000) - 100 * (1 + 5 / 20_000)) * 1_000
  expect(netReturns([ledger], 5)?.[0]).toBeCloseTo(expected / capital, 14)
  expect(netReturns([ledger], ledger.base / ledger.slope)?.[0]).toBeCloseTo(0, 14)
  const a = [-0.02, 0.04, -0.01, 0.03]
  const b = a.map((x, i) => x / 2 + i / 1000)
  const plan = stationaryBootstrap(a.length, { draws: 50, meanBlock: 2, seed: 4 })
  const ma = performance(a)
  const mb = performance(b)
  expect(ma.maxDrawdown).toBeCloseTo(0.02)
  expect(ma.calmar).toBeCloseTo((0.04 * 252) / 4 / 0.02)
  const paired = pairedMetrics({ returns: a, metrics: ma }, { returns: b, metrics: mb }, plan)
  expect(paired.netUsd).toBeCloseTo(1_400)
  expect(paired.maxDrawdown).toBeCloseTo(0.01)
  expect(paired.correlation).toBeGreaterThan(0.99)
  expect(paired.excessP).not.toBeNull()
  expect(
    pairedMetrics({ returns: null, metrics: performance(null) }, { returns: b, metrics: mb }, plan).correlation,
  ).toBeNull()
})

test('verifies supplemental gzip and applies the split to price and volume without changing notional', async () => {
  const index = () =>
    new Map([
      [
        '2025-12-04',
        {
          bars: new Map<string, Float64Array>(),
          session: { date: '2025-12-04', openMs: Date.parse('2025-12-04T14:30:00Z'), minutes: 390 },
        },
      ],
      [
        '2025-12-05',
        {
          bars: new Map<string, Float64Array>(),
          session: { date: '2025-12-05', openMs: Date.parse('2025-12-05T14:30:00Z'), minutes: 390 },
        },
      ],
    ])
  const first = 'XLB\t2025-12-04T14:30:00Z\t100\t102\t98\t100\t2000\t101\n'
  const second = 'XLB\t2025-12-05T14:30:00Z\t50\t51\t49\t50\t4000\t50.5\n'
  const hash = (input: Uint8Array) => new Bun.CryptoHasher('sha256').update(input).digest('hex')
  const archive = (text: string) => {
    const raw = new TextEncoder().encode(text)
    const binary = Bun.gzipSync(raw)
    const receipt: GzipReceipt = {
      key: 'test.tsv.gz',
      bytes: binary.length,
      sha256: hash(binary),
      raw: { bytes: raw.length, sha256: hash(raw) },
    }
    const reader: ArchiveReader = {
      readJson: async () => undefined,
      readGzip: (expected, consume) =>
        readGzipLines(
          new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
              controller.enqueue(binary)
              controller.close()
            },
          }),
          expected,
          new AbortController().signal,
          consume,
        ),
    }
    return { reader, receipt }
  }
  const fixture = archive(first + second)
  const frames = index()
  await loadTape(fixture.reader, frames, Tape.Supplement, fixture.receipt, 2, ['XLB'])
  for (const { bars } of frames.values()) {
    const series = bars.get('XLB')
    if (series === undefined) throw new Error('Missing XLB')
    expect(price(series, 0, Field.Open)).toBe(50)
    expect(price(series, 0, Field.Vwap) * price(series, 0, Field.Volume)).toBe(202_000)
  }
  const rejection = (run: Promise<void>) =>
    run.then(
      () => {
        throw new Error('Expected tape verification to reject')
      },
      (cause: unknown) => (cause instanceof Error ? cause.message : null),
    )
  const duplicate = archive(first + first)
  expect(
    await rejection(loadTape(duplicate.reader, index(), Tape.Supplement, duplicate.receipt, 2, ['XLB'])),
  ).toContain('duplicate')
  expect(
    await rejection(
      loadTape(fixture.reader, index(), Tape.Supplement, { ...fixture.receipt, sha256: 'wrong' }, 2, ['XLB']),
    ),
  ).toContain('byte receipt mismatch')
})
