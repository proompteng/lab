import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { inspect } from 'node:util'

import { collectDailyFrames, outputPath } from './research-10yr-real-assets-sleeve'
import {
  admitCoverage,
  attribution,
  blend,
  clearAtOpen,
  decide,
  drawdownReturns,
  type Frame,
  pairedSharpeLower,
  protocol,
  replay,
  Scope,
  stressFlags,
  targetsAtClose,
  Ticker,
  tracked,
  universe,
  Verdict,
} from './research-10yr-real-assets-sleeve-core'
import { pairedSharpeDiff, stationaryBootstrap, sum } from './research-lib/statistics'

// Dimensionless unit-test marks. The research command never reads these fixtures.
const frames = (count: number): Frame[] =>
  Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10),
    bars: new Map(tracked.map((ticker) => [ticker, { open: 1, close: 1 }])),
  }))
const setMark = (day: Frame, ticker: Ticker, open: number, close: number): Frame => ({
  ...day,
  bars: new Map(day.bars).set(ticker, { open, close }),
})
const without = ({ date, bars }: Frame, omit: Ticker): Frame => ({
  date,
  bars: new Map([...bars].filter(([ticker]) => ticker !== omit)),
})

test('TIP must be absent in both the verified manifest and the tape for the diagnostic', () => {
  const daily = frames(2)
  const noTip = daily.map((day) => without(day, Ticker.TIP))
  const roster = tracked.filter((ticker) => ticker !== Ticker.TIP)
  expect(admitCoverage(daily, tracked, daily)).toMatchObject({ scope: Scope.Requested, missing: [] })
  const result = admitCoverage(daily, roster, noTip)
  expect(result.scope).toBe(Scope.Diagnostic)
  expect(result.missing).toEqual([Ticker.TIP])
  expect(result.coverage.find(({ ticker }) => ticker === Ticker.TIP)).toEqual({
    inManifest: false,
    ticker: Ticker.TIP,
    rows: 0,
  })
  expect(() => admitCoverage(daily, tracked, noTip)).toThrow('coverage: TIP')
  expect(() => admitCoverage(daily, roster, [daily[0], noTip[1]])).toThrow('coverage: TIP')
  expect(() =>
    admitCoverage(
      daily,
      roster,
      noTip.map((day) => without(day, Ticker.SHY)),
    ),
  ).toThrow('coverage: SHY')
  expect(() => admitCoverage(daily, [...tracked, Ticker.TIP], daily)).toThrow('duplicate ETF')
  expect(() => admitCoverage(daily, tracked, daily.toReversed())).toThrow('alignment')
  const passed = { positiveExcess: true, positiveStress: true, orthogonal: true, portfolio: true }
  expect(decide(Scope.Diagnostic, passed)).toBe(Verdict.DoNotPromote)
  expect(decide(Scope.Requested, { ...passed, portfolio: false })).toBe(Verdict.DoNotPromote)
  expect(decide(Scope.Requested, passed)).toBe(Verdict.Promote)
})

test('authenticated tape consumer checks rows, order, and redacts a malformed payload', async () => {
  const daily = frames(2)
  const line = (date: string) => `GLD\t${date}T05:00:00Z\t1\t3\t1\t2\t100\t2`
  const batches = async function* (...lines: string[]) {
    yield lines
  }
  const first = line(daily[0].date)
  const second = line(daily[1].date)
  const parsed = await collectDailyFrames(batches(first, second), daily, 2)
  expect(parsed[1].bars.get(Ticker.GLD)).toEqual({ open: 1, close: 2 })
  await rejects(collectDailyFrames(batches(first, first), daily, 2), /out-of-order GLD/)
  await rejects(collectDailyFrames(batches(second, first), daily, 2), /out-of-order GLD/)
  await rejects(collectDailyFrames(batches(first), daily, 2), /row count mismatch/)
  const malformed = 'DO_NOT_LOG_FIXTURE'
  const bad = await collectDailyFrames(batches(first.replace('\t100\t', `\t${malformed}\t`)), daily, 1).catch(
    (cause: unknown) => cause,
  )
  expect(bad).toMatchObject({ _tag: 'RealAssetsStudyError', message: 'Malformed daily tape row 1' })
  expect(inspect(bad)).not.toContain(malformed)
  expect(JSON.stringify(bad)).not.toContain(malformed)
})

test('cold TIP and hot cyclical allocations require positive trends and use only the chosen universe', () => {
  const day = protocol.trendSessions
  const tape = frames(day + 1)
  tape[day] = setMark(setMark(tape[day], Ticker.GLD, 1, 4), Ticker.TIP, 1, 2)
  const target = (scope: Scope) =>
    new Map(universe(scope).map((ticker, i) => [ticker, targetsAtClose(tape, day, scope)[i]]))
  expect(target(Scope.Requested).get(Ticker.TIP)).toBe(0.5)
  expect(target(Scope.Diagnostic).get(Ticker.TIP)).toBeUndefined()
  expect(target(Scope.Diagnostic).get(Ticker.SHY)).toBe(0.5)
  tape[day] = setMark(setMark(tape[day], Ticker.DBC, 1, 2), Ticker.USO, 1, 2)
  const hot = target(Scope.Requested)
  expect(hot.get(Ticker.GLD)).toBe(0.5)
  expect(hot.get(Ticker.DBC)).toBe(0.25)
  expect(hot.get(Ticker.USO)).toBe(0.25)
  expect(hot.get(Ticker.TIP)).toBe(0)
  expect(hot.get(Ticker.XLE)).toBe(0)
})

test('trades one open after the close signal and cannot increase the prior-close share order', () => {
  const known = protocol.trendSessions
  const tape = frames(known + 3)
  tape[known] = setMark(tape[known], Ticker.GLD, 1, 4)
  tape[known + 1] = setMark(tape[known + 1], Ticker.GLD, 8, 10)
  tape[known + 2] = setMark(tape[known + 2], Ticker.GLD, 10, 10)
  const rows = replay(tape, Scope.Diagnostic, 0)
  expect(rows[known - 1]).toMatchObject({ date: tape[known].date, net: 0, turnover: 0 })
  // The 0.125-share order is capped to 0.0625 by the 0.5 proceeds from SHY.
  expect(rows[known]).toMatchObject({ date: tape[known + 1].date, net: 0.125, turnover: 1 })

  const lowerOpen = [...tape]
  lowerOpen[known + 1] = setMark(tape[known + 1], Ticker.GLD, 2, 2)
  expect(replay(lowerOpen, Scope.Diagnostic, 0)[known]).toMatchObject({ net: 0, turnover: 0.75 })
  const shockedFuture = [...tape]
  shockedFuture[known + 2] = setMark(tape[known + 2], Ticker.GLD, 200, 300)
  expect(replay(shockedFuture, Scope.Diagnostic, 0).slice(0, -1)).toEqual(rows.slice(0, -1))
  expect(() => replay([tape[0], without(tape[1], Ticker.USO)], Scope.Diagnostic, 0)).toThrow('USO mark')
})

test('funds both sides at the stressed fee and does not rebalance small close drift', () => {
  const fill = clearAtOpen([0, 1], 0, [1, -1], [2, 1], 10)
  const rate = 0.001
  expect(fill.shares[0]).toBeCloseTo((1 - rate) / ((1 + rate) * 2), 12)
  expect(fill.shares[1]).toBe(0)
  expect(fill.cash).toBe(0)
  expect(2 * fill.shares[0] + fill.cost).toBeCloseTo(1, 12)
  expect(fill.cost).toBeCloseTo(fill.traded * rate, 12)

  const known = protocol.trendSessions
  const tape = frames(known + 3)
  tape[known] = setMark(tape[known], Ticker.GLD, 1, 2)
  tape[known + 1] = setMark(tape[known + 1], Ticker.GLD, 2, 2.2)
  tape[known + 2] = setMark(tape[known + 2], Ticker.GLD, 2.2, 2.4)
  const rows = replay(tape, Scope.Diagnostic, 0)
  expect(rows[known].net).toBeCloseTo(0.05, 12)
  expect(rows[known + 1].turnover).toBe(0)
  expect(rows[known + 1].net).toBeCloseTo(1.1 / 1.05 - 1, 12)
})

test('equity and rates stress is conditioned on the previous close, not on the measured session', () => {
  const i = protocol.stressLookbackSessions
  const tape = frames(i + 2)
  tape[i] = setMark(setMark(tape[i], Ticker.SPY, 1, 0.94), Ticker.IEF, 1, 0.96)
  const stress = stressFlags(tape)
  expect(stress[i - 1]).toMatchObject({ equity: false, rates: false })
  expect(stress[i]).toMatchObject({ equity: true, rates: true })
  const sleeve = stress.map(({ date }, j) => ({ date, net: j === i ? 0.01 : -0.03 }))
  const shy = stress.map(({ date }) => ({ date, net: 0.001 }))
  const joint = drawdownReturns(sleeve, shy, stress).joint
  expect(joint).toMatchObject({ sessions: 1, meanSleeveBps: 100 })
  expect(joint.meanExcessShyBps).toBeCloseTo(90, 12)
})

test('allocation attributes all net P&L and charges both sides of the capital reset', () => {
  const series = (a: number, b: number) => [
    { date: '2000-01-01', net: a },
    { date: '2000-01-02', net: b },
  ]
  const controls = { B0: series(0.2, -0.2), F4: series(0, 0), O1: series(0, 0) }
  const rows = blend(controls, series(0, 0.1), 10)
  expect(rows[0].net).toBeCloseTo(0.05, 12)
  const transfer = Math.abs(0.3 / 1.05 - 0.25) + 3 * Math.abs(0.25 / 1.05 - 0.25)
  expect(rows[1].resetCost).toBeCloseTo(0.001 * transfer, 12)
  const { B0, F4, O1, sleeve, resetCost, net } = attribution(rows)
  expect(B0 + F4 + O1 + sleeve + resetCost).toBeCloseTo(net, 12)
  expect(() => blend(controls, series(0, 0).toReversed(), 0)).toThrow('alignment')
  expect(() => blend(controls, series(-1, 0), 0)).toThrow('insolvent')
})

test('stationary Sharpe draws use the same indices on both paths', () => {
  const dates = frames(4)
  const series = (values: number[]) => dates.map(({ date }, i) => ({ date, net: values[i] }))
  const benchmark = series([0, 0.02, -0.015, 0.01])
  const candidate = series([0.005, 0.016, -0.011, 0.006])
  const plan = stationaryBootstrap(4, { draws: 71, meanBlock: 3, seed: 29 })
  expect(pairedSharpeLower(benchmark, benchmark, plan)).toBe(0)
  const draws = Array.from({ length: plan.draws }, (_, draw) => {
    const a: number[] = []
    const b: number[] = []
    for (let block = plan.offsets[draw]; block < plan.offsets[draw + 1]; block += 2) {
      for (let i = plan.blocks[block]; i < plan.blocks[block + 1]; i++) {
        a.push(candidate[i % 4].net)
        b.push(benchmark[i % 4].net)
      }
    }
    expect(a).toHaveLength(4)
    return pairedSharpeDiff(a, b)
  })
  expect(pairedSharpeLower(candidate, benchmark, plan)).toBe(
    draws.includes(null)
      ? null
      : draws.filter((value) => value !== null).sort((a, b) => a - b)[Math.ceil(71 * 0.05) - 1],
  )
  expect(() => pairedSharpeLower(candidate, benchmark.toReversed(), plan)).toThrow('alignment')
})

test('the output contract never targets freeze.json and preserves the fixed tiers', () => {
  expect(outputPath(['--output', '/tmp/receipt/results.json'])).toBe('/tmp/receipt/results.json')
  expect(() => outputPath(['--output', '/tmp/receipt/freeze.json'])).toThrow('results.json')
  expect(() => outputPath(['--allow-missing-tip', '--output', 'results.json'])).toThrow()
  expect(protocol.costsOneWayBps).toEqual([0, 2, 5, 10])
  expect(sum(targetsAtClose(frames(1), 0, Scope.Diagnostic))).toBe(1)
})
