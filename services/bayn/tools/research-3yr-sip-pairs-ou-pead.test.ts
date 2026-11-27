import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { calendarSessions, dayMs, makeBars, readBars, sha256, type Bars, type Market } from './pairs-pead-data'
import { neighbors, pairs, trials } from './pairs-pead-protocol'
import { netAt, replayUnit } from './pairs-pead-replay'
import { buildGap, buildPair, fitOu, gapDirection, priorEligible, type Opening } from './pairs-pead-signals'
import { circularP, exTop5, marketBeta, summarize } from './pairs-pead-statistics'

const fixture = (n: number, stride: number, from = '2024-01-02'): Market => {
  const sessions = Array.from({ length: n }, (_, d) => {
    const epoch = Date.parse(from) + d * dayMs
    return { date: new Date(epoch).toISOString().slice(0, 10), epoch, open: epoch, slots: stride }
  })
  return {
    sessions,
    stride,
    observed: {},
    outsideRth: 0,
    series: new Map(
      ['A', 'SPY'].map((s) => {
        const bar = makeBars(n * stride)
        for (let t = 0; t < n * stride; t++) write(bar, t, 100)
        return [s, bar]
      }),
    ),
  }
}

const write = (bar: Bars, at: number, open: number, high = open, low = open, close = open, volume = 100) => {
  bar.open[at] = open
  bar.high[at] = high
  bar.low[at] = low
  bar.close[at] = close
  bar.volume[at] = volume
  bar.vwap[at] = (low + high) / 2
}

const barFor = (m: Market, s: string) => {
  const b = m.series.get(s)
  if (b === undefined) throw new Error('Missing fixture bars')
  return b
}

const read = (raw: string, last: string, signal = new AbortController().signal, rawSha256 = sha256(raw)) => {
  const gzip = gzipSync(raw)
  const session = calendarSessions(
    JSON.stringify({
      response: [
        { date: '2024-01-02', open: '09:30', close: '16:00' },
        { date: '2024-03-11', open: '09:30', close: '16:00' },
        { date: '2024-07-03', open: '09:30', close: '13:00' },
      ],
    }),
  )
  return readBars(
    Readable.from([gzip]),
    ['A'],
    session,
    'intraday',
    last,
    {
      key: 'synthetic.gz',
      rows: raw.trimEnd().split('\n').length,
      rawBytes: Buffer.byteLength(raw),
      rawSha256,
      gzipBytes: gzip.length,
      gzipSha256: sha256(gzip),
    },
    signal,
  )
}

test('streams sealed bytes, applies DST/early closes, never decodes holdout prices during freeze', async () => {
  const raw =
    [
      'A\t2024-01-02T13:30:00Z\t100\t100\t100\t100\t500\t100',
      'A\t2024-01-02T14:30:00Z\t101\t101\t101\t101\t500\t101',
      'A\t2024-03-11T13:30:00Z\t102\t102\t102\t102\t500\t102',
      'A\t2024-07-03T16:55:00Z\t103\t103\t103\t103\t500\t103',
      'A\t2024-07-03T17:00:00Z\t105\t105\t105\t105\t500\t105',
    ].join('\n') + '\n'
  const h = await read(raw, '2024-07-03')
  expect(h.outsideRth).toBe(2)
  expect(h.sessions.map((d) => d.slots)).toEqual([78, 78, 42])
  expect(barFor(h, 'A').open[0]).toBe(101)
  expect(barFor(h, 'A').open[78]).toBe(102)
  expect(barFor(h, 'A').open[2 * 78 + 41]).toBe(103)
  expect(await read(raw.replace('103', 'bad'), '2024-03-11')).toMatchObject({ observed: { A: 2 } })
  await rejects(read(raw.replace('103', 'bad'), '2024-07-03'), /Invalid or duplicate OHLCV/)
  await rejects(read(raw, '2024-03-11', undefined, 'invalid'), /bytes do not match/)
  await rejects(read(raw, '2024-03-11', AbortSignal.abort()), /SIP read aborted/)
})

test('strict regular-way eligibility and causal lookback, including current-close mutation', () => {
  const market = fixture(32, 1, '2025-02-13')
  const eligible = priorEligible(market, 'SNDK')
  expect(eligible(30)).toBe(false)
  expect(eligible(31)).toBe(true)
  const a = barFor(market, 'A'),
    b = barFor(market, 'SPY')
  for (let i = 0; i < 30; i++) {
    b.close[i] = 100 * Math.exp(i * 0.01)
    a.close[i] = 100 * Math.exp(i * 0.015 + 0.01 * Math.sin(i))
  }
  const pair = buildPair(market, 'A', 'SPY', 20, market.series)
  a.close[20] *= 1.1
  const changed = buildPair(market, 'A', 'SPY', 20, market.series)
  expect(pair.model[19]).toBeNull()
  expect(pair.model[20]?.beta).toBeCloseTo(1.5, 1)
  expect(pair.model[20]).toEqual(changed.model[20])
  expect(pair.z[20]).not.toBe(changed.z[20])
  expect(pair.model[21]).not.toEqual(changed.model[21])
  expect(fitOu([1, 2, 3, 4], [4, 3, 2, 1])).toBeNull()
})

test('gap ATR and RVOL only use strictly prior sessions; fade needs sharp opposing candle', () => {
  const m = fixture(23, 1)
  const b = barFor(m, 'A')
  for (let d = 0; d < 20; d++) write(b, d, 100, 101, 99)
  write(b, 20, 104, 120, 103, 105, 250)
  const opening = buildGap(m, 'A', 1, b)[20]
  expect(opening).toEqual({ gap: 4, candle: 1, rvol: 2.5, atr: 2, previous: 100 })
  if (opening === null) throw new Error('Missing opening')
  expect(gapDirection(opening, 2, false)).toBe(1)
  expect(gapDirection({ ...opening, candle: -0.49 }, 2, true)).toBe(0)
  expect(gapDirection({ ...opening, candle: -0.5 }, 2, true)).toBe(-1)
  expect(gapDirection({ ...opening, rvol: 2.499 }, 2, false)).toBe(0)
})

test('intraday fills at the next open and stops against the prior trail, not the same bar high', () => {
  const m = fixture(22, 8)
  const a = barFor(m, 'A'),
    d = 20,
    at = d * m.stride
  write(a, at + 2, 106)
  write(a, at + 3, 110, 114, 109, 112)
  write(a, at + 4, 112, 115, 111, 112)
  write(a, at + 5, 108)
  const opening: Opening = { gap: 6, candle: 3, atr: 2, previous: 100, rvol: 3 }
  const gaps = new Map([['A:3', Array.from({ length: 22 }, (_, i) => (i === d ? opening : null))]])
  const setup = { market: m, core: [], pairModels: new Map(), gaps }
  const trial = {
    id: 'fixture',
    engine: 'gap-intraday',
    gap: 2,
    horizon: 3,
    universe: 'stocks',
    frequency: 'intraday',
  } as const
  const run = () => replayUnit(setup, trial, ['A', 'A', 'SPY'], 2_000, new Set())
  const l = run()
  expect(l.entries[d]).toBe(1)
  expect(l.exits[d]).toBe(1)
  expect(l.gross[d]).toBeCloseTo(1_000 * (108 / 110 - 1))
  expect(netAt(l, d, 10)).toBeLessThan(netAt(l, d, 5))
  expect(l.sales[d]).toBeCloseTo(1_000 + (1_000 * 108) / 110)
  expect(l.borrow[d]).toBe(0)
  write(a, at + 3, 0)
  expect(run().unfilled[d]).toBe(1)
  expect(run().entries[d]).toBe(0)

  // A missing held bar might have triggered the protective stop.
  write(a, at + 3, 110, 114, 109, 112)
  write(a, at + 4, 0)
  const missingStop = run()
  expect(missingStop.entries[d]).toBe(1)
  expect(missingStop.exits[d]).toBe(1)
  expect(missingStop.missing[d]).toBe(1)
  expect(missingStop.gross[d]).toBeCloseTo(1_000 * (108 / 110 - 1))
  expect(summarize(missingStop, [d], 10, 5, null, [], false).net).toBeNull()
})

test('swing pairs fill next open, keep the marked book and pay actual elapsed short borrow', () => {
  const m = fixture(28, 1)
  const a = barFor(m, 'A')
  write(a, 21, 90, 100, 90, 99)
  write(a, 22, 102)
  const z = new Float64Array(28).fill(NaN)
  z[20] = -2
  z[21] = -1
  const model = Array.from({ length: 28 }, () => ({ beta: 1, correlation: 0.8, intercept: 0, sigma: 1, halfLife: 5 }))
  const setup = { market: m, core: [], pairModels: new Map([['A/SPY:20', { model, z }]]), gaps: new Map() }
  const trial = {
    id: 'fixture',
    engine: 'pair-swing',
    z: 1.5,
    lookback: 20,
    filter: 'half-life',
    hold: 1,
    frequency: 'daily',
  } as const
  const l = replayUnit(setup, trial, ['A/SPY', 'A', 'SPY'], 20_000, new Set([27]))
  expect(l.entries[20]).toBe(0)
  expect(l.entries[21]).toBe(1)
  expect(l.exits[22]).toBe(1)
  expect(l.gross[21]).toBeCloseTo(1_000)
  expect(l.gross[22]).toBeCloseTo(20_000 / 60)
  expect(l.borrow[22]).toBeCloseTo((10_000 * 0.015) / 365)
  expect(l.fillGross[21]).toBeCloseTo(20_000)
  expect(l.markedNet[21]).toBeCloseTo(1_000)
  write(a, 22, 0)
  const split = replayUnit(setup, trial, ['A/SPY', 'A', 'SPY'], 20_000, new Set([22, 27]))
  expect(split.missing[22]).toBeGreaterThan(0)
  expect(split.exits[23]).toBe(0)
  expect(summarize(split, [20, 21, 22], 10, 5, null, [], false).net).toBeNull()
})

test('grid, plateau neighborhood, circular p-value and Ex-Top-5 are deterministic', () => {
  expect(pairs).toHaveLength(23)
  expect(trials).toHaveLength(230)
  expect(new Set(trials.map((t) => t.id)).size).toBe(230)
  const trial = trials.find((t) => t.id === 'pair-swing:20:1.5:none:1')
  if (trial === undefined) throw new Error('Missing trial')
  expect(neighbors(trial).map((t) => t.id)).toContain('pair-swing:20:1.5:none:2')
  expect(neighbors(trial).map((t) => t.id)).not.toContain('pair-swing:20:1.5:none:3')
  const positive = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 3 : 2))
  expect(circularP(positive, 5)).toBe(1 / 10_001)
  expect(
    circularP(
      positive.map((x) => -x),
      10,
    ),
  ).toBe(1)
  expect(
    circularP(
      Array.from({ length: 20 }, () => 0),
      5,
    ),
  ).toBeNull()
  expect(exTop5([10, -5, 5, 5, 5, 5])).toBe(-5)
  expect(marketBeta([1800, -1800], [0.01, -0.01])).toBeCloseTo(1)
})
