import { describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  admitUniverse,
  decidePromotion,
  fundOverlay,
  type Observation,
  type OverlayDay,
  OverlayEtf,
  pairedIntervals,
  prepareOverlay,
  Regime,
  replayOverlay,
  Rule,
  Verdict,
} from './research-10yr-crisis-alpha-overlay-core'
import { writeEvidence } from './research-10yr-crisis-alpha-overlay'
import { stationaryBootstrap, sum } from './research-lib/statistics'

const symbols = [OverlayEtf.SPY, OverlayEtf.QQQ, OverlayEtf.TLT]
// Observed opens/closes from the pinned adjusted SIP daily tape; all dates precede scoring.
const observed = [
  ['2016-01-04', [170.23, 170.68], [101.11, 101.17], [89.72, 89.37]],
  ['2016-01-05', [171, 170.97], [101.67, 101], [88.94, 89.01]],
  ['2016-01-06', [168.39, 168.81], [99.26, 100.03], [90.01, 90.21]],
  ['2016-01-07', [165.85, 164.76], [97.9, 96.89], [90.28, 90.37]],
] as const
const observations = observed.map(([date, ...prices]) => ({
  date,
  bars: new Map(symbols.map((symbol, i) => [symbol, { open: prices[i][0], close: prices[i][1] }])),
})) satisfies Observation[]

// Register decisions directly for the short ledger fixture; it is not a signal warm-up or a score.
const days = observations.slice(1).map(({ date, bars }, i) => ({
  date,
  marks: symbols.map((symbol) => {
    const priorClose = observations[i].bars.get(symbol)?.close
    const mark = bars.get(symbol)
    if (mark === undefined || priorClose === undefined) throw new Error('Missing test fixture mark')
    return { symbol, priorClose, ...mark }
  }),
  trendBreak: i > 0,
  highVol: false,
  risingHavens: [OverlayEtf.TLT],
})) satisfies OverlayDay[]

describe('archive admission', () => {
  test('ignores unrelated ETFs, excludes absent UUP and rejects an incomplete or duplicate roster', () => {
    expect(admitUniverse(['SPY', 'TLT', 'QQQ', 'SMH'])).toEqual(symbols)
    expect(() => admitUniverse(['SPY', 'TLT'])).toThrow('must list SPY, QQQ')
    expect(() => admitUniverse(['SPY', 'QQQ'])).toThrow('at least one requested haven')
    expect(() => admitUniverse(['SPY', 'QQQ', 'TLT', 'TLT'])).toThrow('Duplicate ETF')
  })

  test('rejects a missing mark, a duplicate date and an incomplete warm-up rather than imputing', () => {
    const missing = { date: observations[0].date, bars: new Map(observations[0].bars) }
    missing.bars.delete(OverlayEtf.TLT)
    expect(() => prepareOverlay([missing], symbols, missing.date)).toThrow(
      'Missing or invalid archived price: TLT 2016-01-04',
    )
    expect(() => prepareOverlay([observations[0], observations[0]], symbols, observations[0].date)).toThrow(
      'Duplicate or out-of-order',
    )
    expect(() => prepareOverlay(observations, symbols, observations[3].date)).toThrow('warm-up')
  })
})

describe('next-open overlay ledger', () => {
  test('charges 0 bp sell fees and credits the gap to old holdings, not the newly bought haven', () => {
    const [entry, switched, held] = replayOverlay(days, Rule.Primary, 0)
    const priorEquity = 0.5 * (170.97 / 171 + 101 / 101.67)
    const openingEquity = 0.5 * (168.39 / 171 + 99.26 / 101.67)
    const fee = (openingEquity * 0.21) / 10_000
    const nextEquity = (openingEquity - fee) * (90.21 / 90.01)
    expect(entry.net).toBeCloseTo(priorEquity - 1, 12)
    expect(switched.net).toBeCloseTo(nextEquity / priorEquity - 1, 12)
    expect(switched.fees).toBeCloseTo(fee / priorEquity, 12)
    expect(switched.attribution[0].contribution).toBeCloseTo((0.5 * (168.39 - 170.97)) / (171 * priorEquity), 12)
    expect(switched.attribution[2].contribution).toBeCloseTo(
      ((openingEquity - fee) * (90.21 / 90.01 - 1)) / priorEquity,
      12,
    )
    expect(held.turnover).toBe(0)
    expect(held.net).toBeCloseTo(90.37 / 90.21 - 1, 12)
  })

  test('registers OR, AND, always-offense and cash without conditionally selecting a winner', () => {
    const primary = replayOverlay(days, Rule.Primary, 5)
    const cash = replayOverlay(days, Rule.Cash, 5)
    const confirmed = replayOverlay(days, Rule.Confirmed, 5)
    const always = replayOverlay(days, Rule.Static, 5)
    expect(primary[1].regime).toBe(Regime.Defense)
    expect(primary[1].attribution[2].contribution).toBeGreaterThan(0)
    expect(cash[1].regime).toBe(Regime.Defense)
    expect(cash[1].attribution[2].contribution).toBe(0)
    expect(cash[2].net).toBe(0)
    expect(confirmed).toEqual(always)
    expect(always[1].traded).toBe(false)

    const volOnly = { ...days[1], highVol: true, trendBreak: false }
    const both = { ...volOnly, trendBreak: true }
    expect(replayOverlay([days[0], volOnly], Rule.Primary, 5)[1].regime).toBe(Regime.Defense)
    expect(replayOverlay([days[0], both], Rule.Confirmed, 5)[1].regime).toBe(Regime.Defense)
    expect(replayOverlay([days[0], { ...both, risingHavens: [] }], Rule.Primary, 5)).toEqual(cash.slice(0, 2))
  })

  test('funds sales and buys at each cost tier and reconciles the drifting 25% sleeve', () => {
    const base = days.map(({ date, marks }) => ({
      date,
      net: marks[0].close / marks[0].priorClose - 1,
    }))
    const sleeve = replayOverlay(days, Rule.Primary, 10)
    const mixed = fundOverlay(base, sleeve)
    expect(sleeve[0].fees).toBeCloseTo(1 - 1 / 1.001, 12) // An initial buy has no sell fee.
    expect(sleeve[0].net).toBeLessThan(replayOverlay(days, Rule.Primary, 2)[0].net)
    expect(mixed[0].sleeveShare).toBe(0.25)
    expect(mixed[1].sleeveShare).toBeCloseTo((0.25 * (1 + sleeve[0].net)) / (1 + mixed[0].net), 12)
    for (const day of mixed)
      expect(day.net).toBeCloseTo(
        day.baseContribution + sum(day.attribution.map((row) => row.contribution)) - day.fees,
        12,
      )
    expect(() => fundOverlay(base.slice(1), sleeve)).toThrow('Session count mismatch')
  })
})

test('paired block resampling preserves identical realized return series on every draw', () => {
  const net = days.map(({ marks: [spy] }) => spy.close / spy.priorClose - 1)
  const plan = stationaryBootstrap(net.length, { draws: 32, meanBlock: 2, seed: 17 })
  const intervals = pairedIntervals(net, net, 1, plan)
  expect(intervals.deltaCagr).toEqual({ lower: 0, upper: 0, validDraws: 32 })
  expect(intervals.deltaSharpe?.lower).toBe(0)
  expect(intervals.maxDrawdownImprovement).toEqual(intervals.deltaCagr)
  expect(() => pairedIntervals(net.slice(1), net, 1, plan)).toThrow('length mismatch')
})

test('promotion requires all tail, net, inference and evidence gates at registered costs', () => {
  const clears = {
    deltaCagr: 0,
    deltaSharpe: 0,
    worstQuarterImprovement: 0.01,
    covidImprovement: 0.01,
    bearImprovement: 0.01,
  }
  const stress = { 5: clears, 10: clears }
  expect(decidePromotion(stress, 0.001, 0).verdict).toBe(Verdict.Promote)
  expect(decidePromotion({ ...stress, 10: { ...clears, bearImprovement: 0.0099 } }, 0.001, 0).verdict).toBe(
    Verdict.Reject,
  )
  expect(decidePromotion({ ...stress, 5: { ...clears, deltaSharpe: null } }, 0.001, 0).verdict).toBe(Verdict.Reject)
  expect(decidePromotion(stress, 0, 0).verdict).toBe(Verdict.Reject)
  expect(decidePromotion(stress, 0.001, 1).verdict).toBe(Verdict.Reject)
})

test('publishes once and leaves no staged evidence on conflict or cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-overlay-test-'))
  try {
    const path = join(directory, 'results.json')
    const signal = new AbortController().signal
    await writeEvidence(path, '{}\n', signal)
    await rejects(writeEvidence(path, '{"overwrite":true}\n', signal), { code: 'EEXIST' })
    await rejects(writeEvidence(join(directory, 'cancelled.json'), '{}\n', AbortSignal.abort()), { name: 'AbortError' })
    expect(await readFile(path, 'utf8')).toBe('{}\n')
    expect(await readdir(directory)).toEqual(['results.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
