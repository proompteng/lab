import { expect, test } from 'bun:test'

import { receipts } from './pure-etf-dual-horizon-data'
import {
  closeSignals,
  type Frame,
  marketAlpha,
  pairedSharpeLift,
  replay,
  Ticker,
  tickers,
  Verdict,
  verdictFor,
  walkForward,
} from './research-10yr-sector-dispersion-core'
import { confirmRoster } from './research-10yr-sector-dispersion'
import { stationaryBootstrap } from './research-lib/statistics'

const { daily } = receipts.datasets
const baseManifest = {
  schemaVersion: 'bayn.sip-10yr-sp100-manifest.v1',
  source: 'Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])',
  etfs: [...tickers, 'IWM', 'TLT', 'IEF', 'HYG', 'LQD', 'GLD', 'SLV', 'USO', 'DBC', 'EFA', 'EEM', 'VNQ'],
  files: [
    {
      key: `${daily.prefix}/${daily.name}`,
      rows: daily.rows,
      gzipBytes: daily.bytes,
      gzipSha256: daily.sha256,
      rawBytes: daily.rawBytes,
      rawSha256: daily.rawSha256,
    },
  ],
}

test('requires every registered symbol and a unique base tape binding', () => {
  expect(confirmRoster(baseManifest)).toEqual(tickers)
  expect(() =>
    confirmRoster({
      ...baseManifest,
      etfs: baseManifest.etfs.map((ticker) => (ticker === Ticker.XLC ? 'DIA' : ticker)),
    }),
  ).toThrow('ETF roster')
  expect(() => confirmRoster({ ...baseManifest, etfs: [...baseManifest.etfs, Ticker.XLK] })).toThrow('unique')
  expect(() => confirmRoster({ ...baseManifest, files: [...baseManifest.files, ...baseManifest.files] })).toThrow(
    'unique',
  )
  expect(() => confirmRoster({ ...baseManifest, files: [{ ...baseManifest.files[0], rows: 1 }] })).toThrow()
})

// Actual split/dividend-adjusted marks from the hash-verified base SIP tape (see the report).
// Columns are SPY, SHY, XLK, XLF, and XLE, with each pair in open/close order.
const observations = [
  ['2016-11-25', [189.66, 190.02], [68.36, 68.36], [21.59, 21.67], [18.66, 18.65], [24.24, 24.23]],
  ['2016-11-28', [189.71, 189.18], [68.38, 68.41], [21.65, 21.69], [18.51, 18.41], [24.34, 23.89]],
  ['2016-11-29', [189.16, 189.47], [68.39, 68.41], [21.67, 21.7], [18.46, 18.46], [23.52, 23.59]],
  ['2016-11-30', [190.11, 189.05], [68.39, 68.39], [21.73, 21.44], [18.74, 18.71], [24.45, 24.79]],
  ['2016-12-01', [189.34, 188.34], [68.35, 68.36], [21.42, 21], [18.83, 19.05], [25.25, 24.86]],
  ['2016-12-02', [188.43, 188.38], [68.42, 68.43], [20.98, 21.08], [19, 18.85], [24.84, 24.92]],
  ['2016-12-05', [189.27, 189.52], [68.4, 68.43], [21.19, 21.28], [19.01, 19.07], [25.15, 25.15]],
  ['2016-12-06', [189.76, 190.14], [68.44, 68.41], [21.33, 21.34], [19.2, 19.24], [24.99, 25.11]],
] as const
const names = [Ticker.SPY, Ticker.SHY, Ticker.XLK, Ticker.XLF, Ticker.XLE] as const
const tape: Frame[] = observations.map(([date, ...prices]) => ({
  date,
  bars: new Map(prices.map(([open, close], i) => [names[i], { open, close }])),
}))
const fixtureSignal = { leaders: [Ticker.XLK, Ticker.XLF, Ticker.XLE], dispersion: 0.02, breadth: 10 }

test('uses only the preceding close to set the annual threshold and each next-open decision', () => {
  // Test the calibration clock with dispersion inputs, not simulated prices or returns.
  const features = Array.from({ length: 129 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 7, 27 + i)).toISOString().slice(0, 10),
    signal: { ...fixtureSignal, dispersion: i / 10_000 },
  }))
  const initial = walkForward(features, 126)
  expect(initial.folds.map(({ firstFill, calibrationThrough }) => [firstFill, calibrationThrough])).toEqual([
    ['2020-12-31', '2020-12-30'],
    ['2021-01-01', '2020-12-31'],
  ])
  expect(initial.folds[0].threshold).toBeCloseTo(0.0075, 15)
  expect(initial.decisions[0].signalDate).toBe('2020-12-30')
  expect(initial.decisions[0].gateOpen).toBe(true)

  const later = features.with(126, { ...features[126], signal: { ...fixtureSignal, dispersion: 0 } })
  const revised = walkForward(later, 126)
  expect(revised.folds[0]).toEqual(initial.folds[0])
  expect(revised.decisions[0]).toEqual(initial.decisions[0])
  expect(revised.folds[1].threshold).toBeLessThan(initial.folds[1].threshold)
  expect(revised.decisions[1].gateOpen).toBe(false)
  expect(() =>
    walkForward(features.with(5, { ...features[5], signal: { ...fixtureSignal, dispersion: NaN } }), 126),
  ).toThrow('historical dispersion')
})

test('requires benchmark marks and does not produce a signal from incomplete history', () => {
  expect(closeSignals(tape)).toEqual(tape.map(({ date }) => ({ date })))
  const [first] = tape
  expect(() => closeSignals([{ ...first, bars: new Map() }])).toThrow('Missing SPY mark')
})

const trading = tape.slice(1, 4)
const decisions = trading.map(({ date }, i) => ({
  date,
  signalDate: tape[i].date,
  signal: fixtureSignal,
  gateOpen: i !== 0,
}))

test('books overnight movement to old holdings, fills at the next open, and retains small drift', () => {
  const [cash, switchDay, held] = replay(trading, decisions, 0, true)
  const openToClose = (21.7 / 21.67 + 18.46 / 18.46 + 23.59 / 23.52) / 3
  const marked = (21.44 / 21.67 + 18.71 / 18.46 + 24.79 / 23.52) / 3
  expect(cash.net).toBeCloseTo(68.41 / 68.38 - 1, 14)
  expect(cash.defensive).toBe(true)
  expect(switchDay.net).toBeCloseTo((68.39 / 68.41) * openToClose - 1, 14)
  expect(switchDay.turnover).toBeCloseTo(1, 14)
  expect(switchDay.defensive).toBe(false)
  expect(held.traded).toBe(false)
  expect(held.turnover).toBe(0)
  expect(held.net).toBeCloseTo(marked / openToClose - 1, 14)
  expect(replay(trading, decisions, 0, false).every(({ defensive }) => !defensive)).toBe(true)
})

test('funds the exact per-side cost on opening and fully replacing the book', () => {
  const zero = replay(trading, decisions, 0, true)
  for (const bp of [2, 5, 10] as const) {
    const side = bp / 20_000
    const [entry, switchDay, held] = replay(trading, decisions, bp, true)
    expect(entry.net + 1).toBeCloseTo((1 + zero[0].net) / (1 + side), 14)
    expect(switchDay.net + 1).toBeCloseTo(((1 + zero[1].net) * (1 - side)) / (1 + side), 14)
    expect(switchDay.turnover).toBeCloseTo(1 / (1 + side), 14)
    expect(held.net).toBeCloseTo(zero[2].net, 14)
  }
})

test('rejects misaligned sessions and missing execution marks instead of repricing or discarding them', () => {
  for (const index of [1, 2]) {
    const missing = new Map(trading[index].bars)
    missing.delete(Ticker.XLK)
    expect(() => replay(trading.with(index, { ...trading[index], bars: missing }), decisions, 5, true)).toThrow(
      'Missing XLK mark',
    )
  }
  expect(() => replay(trading, decisions.toReversed(), 5, true)).toThrow('alignment mismatch')
})

test('resamples the same sessions for both legs and estimates market-adjusted alpha', () => {
  const closeReturns = (column: 1 | 2) =>
    observations.slice(1).map((row, i) => row[column][1] / observations[i][column][1] - 1)
  const spy = closeReturns(1)
  const shy = closeReturns(2)
  const plan = stationaryBootstrap(spy.length, { draws: 128, meanBlock: 3, seed: 0x21a2026 })
  expect(pairedSharpeLift(spy, spy, plan)).toEqual({ estimate: 0, ci95: { lower: 0, upper: 0 } })
  expect(marketAlpha(spy, spy, shy, plan)).toEqual({ fit: { beta: 1, annualAlpha: 0 }, ci95: { lower: 0, upper: 0 } })
  expect(marketAlpha(spy, shy, shy, plan)).toEqual({ fit: null, ci95: null })
  expect(() => marketAlpha(spy.slice(1), spy, shy, plan)).toThrow('aligned return counts')
})

test('requires one consistent evidence route on both windows and both decision costs', () => {
  const alpha = { positiveNet: true, alpha: true, portfolio: false }
  const portfolio = { positiveNet: true, alpha: false, portfolio: true }
  expect(verdictFor([alpha, alpha, alpha, alpha]).verdict).toBe(Verdict.Promote)
  expect(verdictFor([portfolio, portfolio, portfolio, portfolio]).verdict).toBe(Verdict.Promote)
  expect(verdictFor([alpha, alpha, portfolio, portfolio]).verdict).toBe(Verdict.DoNotPromote)
  expect(verdictFor([alpha, alpha, alpha]).verdict).toBe(Verdict.DoNotPromote)
  expect(verdictFor([alpha, alpha, alpha, { ...alpha, positiveNet: false }]).verdict).toBe(Verdict.DoNotPromote)
})
