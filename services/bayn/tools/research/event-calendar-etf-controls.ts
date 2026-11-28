import { etfs, mix, trialId } from '../etf-canary-macro-protocol'
import { marks, replay as replayCanary } from '../etf-canary-macro-replay'
import { features, targets } from '../etf-canary-macro-signals'
import { baskets, capital, createReplay, type Day, netAt, prepare, splits } from '../noise-area-study-replay'
import { base } from '../research-10yr-qqq-smh-conditioning'
import { foldBounds, requireAlignedSessions } from '../research-lib/calendar'
import { sum, wealth } from '../research-lib/statistics'
import { assets, type Session } from '../vol-regime-carry-data'
import { replay as replayCarry } from '../vol-regime-carry-replay'
import { signalModel, type Trial } from '../vol-regime-carry-signals'
import type { DailyReturn } from './event-calendar-etf-replay'

const f4 = { family: 'F4', cadence: 42, power: 1, credit: 'LQD', mix: 'parity' } satisfies Trial
export const controlIds = { SPY: 'buy-and-hold', F4: 'F4-42-1-LQD-parity', O1: trialId(mix), B0: base.id }
const controlOrder = ['SPY', 'F4', 'O1', 'B0'] as const
export type Control = (typeof controlOrder)[number]
export const controls = controlOrder

// Independent published control oracles, in Train / Validation / Holdout / Full order.
const b0Dollars = [
  [2, [33107.45, 29982.77, 40443.36, 103533.58]],
  [5, [14806, 23345.9, 31628.26, 69780.16]],
] as const
const f4Compounded = [
  [10, [0.426060485, 0.078919864, 0.372083365, 1.111094304]],
  [20, [0.41836733, 0.077613006, 0.36920683, 1.092765661]],
] as const
const o1Compounded = [
  [2, [0.3457835155, 0.1258225331, 0.2832680135, 0.9442965714]],
  [5, [0.340562174, 0.1236780518, 0.2803505836, 0.9286692789]],
  [10, [0.3319073922, 0.120115304, 0.2755039391, 0.9029113849]],
] as const

export const prepareControls = (daily: readonly Session[], intraday: readonly Day[]) => {
  requireAlignedSessions(daily, intraday)
  const dates = daily.map(({ date }) => date)
  const folds = [
    ...Object.values(splits),
    { first: splits.train.first, last: splits.holdout.last, count: dates.length },
  ]
  const check = (
    id: Control,
    references: readonly (readonly [number, readonly number[]])[],
    path: (cost: number) => readonly DailyReturn[],
    aggregate: (returns: readonly number[]) => number,
    tolerance: number,
  ) =>
    references.map(([roundTripBps, pinned]) => {
      const net = path(roundTripBps).map(({ net }) => net)
      const reproduced = folds.map((fold, j) => {
        const { first, end } = foldBounds(dates, fold.first, fold.last, fold.count)
        const actual = aggregate(net.slice(first, end))
        if (!(Math.abs(actual - pinned[j]) < tolerance))
          throw new Error(`Published ${id} control mismatch at ${roundTripBps} bp: ${fold.first} to ${fold.last}`)
        return actual
      })
      return { roundTripBps, pinned, reproduced }
    })

  const f4Targets = signalModel(daily)(f4)
  const f4At = (bp: number) => replayCarry(daily, f4Targets, bp).map(({ date, idle }) => ({ date, ...idle }))
  const canary = daily.map(({ date, bars }) => ({
    date,
    open: Float64Array.from(etfs, (symbol) => bars[assets[symbol]]?.open ?? NaN),
    close: Float64Array.from(etfs, (symbol) => bars[assets[symbol]]?.close ?? NaN),
  }))
  const o1Targets = targets(mix, features(canary), -1)
  const o1Marks = marks(canary)
  const o1At = (bp: number) => {
    const { net, turnover } = replayCanary(o1Marks, o1Targets, mix, bp, true, -1)
    return dates.map((date, i) => ({ date, net: net[i], turnover: turnover[i] }))
  }
  const b0Ledger = Array.from(prepare(intraday, baskets.B0), (day) => {
    let gross = 0
    const ledger = createReplay(day)(base, baskets.B0, undefined, {
      budget: capital,
      onFill: ({ entry, exit, quantity }) => {
        gross += quantity * (entry + exit)
      },
    })
    return { ledger, turnover: gross / (2 * capital) }
  })
  const b0At = (bp: number) =>
    b0Ledger.map(({ ledger, turnover }, i) => {
      const pnl = netAt(ledger, bp)
      if (pnl === null) throw new Error(`Unresolved B0 exit: ${dates[i]}`)
      return { date: dates[i], net: pnl / capital, turnover, tradeCount: ledger.trades }
    })
  const spy = daily.map(({ date, bars }, i) => {
    const bar = bars[assets.SPY]
    const previous = i === 0 ? bar?.open : daily[i - 1].bars[assets.SPY]?.close
    if (bar === undefined || previous === undefined) throw new Error(`Missing SPY benchmark: ${date}`)
    return { date, net: bar.close / previous - 1, turnover: 0 }
  })
  const compound = (net: readonly number[]) => wealth(net, true) - 1
  const oracle = {
    foldOrder: ['train', 'validation', 'holdout', 'full'],
    B0: check('B0', b0Dollars, b0At, (net) => sum(net) * capital, 0.005),
    F4: check('F4', f4Compounded, f4At, compound, 5.01e-10),
    O1: check('O1', o1Compounded, o1At, compound, 5.01e-11),
  }
  return {
    oracle,
    at: (bp: number) => ({ SPY: spy, F4: f4At(bp), O1: o1At(bp), B0: b0At(bp) }),
  }
}
