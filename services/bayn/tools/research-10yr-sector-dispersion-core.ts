import { Schema } from 'effect'

import { quantile } from './midday-research-statistics'
import { requireAlignedSessions } from './research-lib/calendar'
import {
  calmar,
  maxDrawdown,
  mean,
  pairedSharpeDiff,
  sharpe,
  type StationaryPlan,
  sum,
  wealth,
} from './research-lib/statistics'

export enum Ticker {
  XLK = 'XLK',
  XLF = 'XLF',
  XLE = 'XLE',
  XLV = 'XLV',
  XLI = 'XLI',
  XLY = 'XLY',
  XLP = 'XLP',
  XLU = 'XLU',
  XLB = 'XLB',
  XLC = 'XLC',
  XLRE = 'XLRE',
  SMH = 'SMH',
  QQQ = 'QQQ',
  SPY = 'SPY',
  SHY = 'SHY',
}

export const tickerSchema = Schema.Enum(Ticker)
export const tickers = Object.values(Ticker)
const sectors = tickers.filter((ticker) => ticker !== Ticker.SPY && ticker !== Ticker.QQQ && ticker !== Ticker.SHY)

export enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

export const protocol = {
  firstMark: '2016-11-25',
  firstFill: '2016-11-28',
  lastMark: '2026-11-25',
  momentumSessions: 63,
  volatilitySessions: 21,
  calibrationSessions: 126,
  gateQuantile: 0.6,
  minimumBreadth: 10,
  topK: 3,
  deadband: 0.1,
  roundTripBps: [0, 2, 5, 10],
  decisionCosts: [5, 10],
  blendAllocation: 0.25,
  bootstrap: { draws: 10_000, meanBlock: 10, seed: 0x21a2026 },
} as const

const sessionsPerYear = 252
type Bar = { readonly open: number; readonly close: number }
export type Frame = { readonly date: string; readonly bars: ReadonlyMap<Ticker, Bar> }

export const mark = ({ date, bars }: Frame, ticker: Ticker): Bar => {
  const bar = bars.get(ticker)
  if (bar === undefined) throw new Error(`Missing ${ticker} mark: ${date}`)
  return bar
}

const sampleDeviation = (values: readonly number[]) => {
  const center = mean(values)
  return Math.sqrt(sum(values.map((value) => (value - center) ** 2)) / (values.length - 1))
}

type Signal = { readonly leaders: readonly Ticker[]; readonly dispersion: number; readonly breadth: number }
type SignalDay = { readonly date: string; readonly signal?: Signal }

export const closeSignals = (tape: readonly Frame[]): readonly SignalDay[] => {
  const spy = tape.map((frame) => mark(frame, Ticker.SPY).close)
  return tape.map(({ date }, i) => {
    if (i < protocol.momentumSessions) return { date }
    const start = i - protocol.momentumSessions
    const window = tape.slice(start, i + 1)
    const ranked = sectors.flatMap((ticker) => {
      const relativeCloses: number[] = []
      for (let j = 0; j < window.length; j++) {
        const bar = window[j].bars.get(ticker)
        if (bar === undefined) return []
        relativeCloses.push(Math.log(bar.close / spy[start + j]))
      }
      const momentum = relativeCloses[protocol.momentumSessions] - relativeCloses[0]
      const trailing = relativeCloses.slice(-protocol.volatilitySessions - 1)
      const changes = trailing.slice(1).map((value, j) => value - trailing[j])
      return [{ ticker, momentum, vol: sampleDeviation(changes) * Math.sqrt(sessionsPerYear) }]
    })
    if (ranked.length < protocol.minimumBreadth) return { date }
    ranked.sort((a, b) => b.momentum - a.momentum || a.ticker.localeCompare(b.ticker, 'en'))
    return {
      date,
      signal: {
        leaders: ranked.slice(0, protocol.topK).map(({ ticker }) => ticker),
        dispersion: sampleDeviation(ranked.map(({ vol }) => vol)),
        breadth: ranked.length,
      },
    }
  })
}

type Decision = {
  readonly date: string
  readonly signalDate: string
  readonly signal: Signal
  readonly gateOpen: boolean
}

export const walkForward = (tape: readonly SignalDay[], first: number) => {
  requireAlignedSessions(tape)
  if (first < protocol.calibrationSessions || first >= tape.length)
    throw new Error('Missing calibration or OOS sessions')
  const folds: {
    year: string
    firstFill: string
    calibrationFrom: string
    calibrationThrough: string
    threshold: number
  }[] = []
  const decisions = tape.slice(first).map(({ date }, offset): Decision => {
    const i = first + offset
    const prior = tape[i - 1]
    const year = date.slice(0, 4)
    let fold = folds.at(-1)
    if (fold?.year !== year) {
      const start = i - protocol.calibrationSessions
      const history = tape.slice(start, i).map(({ signal }) => signal?.dispersion ?? NaN)
      const threshold = quantile(history, protocol.gateQuantile)
      if (threshold === null || history.some((value) => !Number.isFinite(value)))
        throw new Error(`Insufficient historical dispersion: ${date}`)
      fold = { year, firstFill: date, calibrationFrom: tape[start].date, calibrationThrough: prior.date, threshold }
      folds.push(fold)
    }
    if (prior.signal === undefined || !Number.isFinite(prior.signal.dispersion))
      throw new Error(`Unavailable close signal: ${prior.date}`)
    return { date, signalDate: prior.date, signal: prior.signal, gateOpen: prior.signal.dispersion >= fold.threshold }
  })
  return { folds, decisions }
}

export type ReturnDay = { readonly date: string; readonly net: number; readonly turnover: number }
type RoundTripBps = (typeof protocol.roundTripBps)[number]

export const replay = (tape: readonly Frame[], decisions: readonly Decision[], bp: RoundTripBps, gated: boolean) => {
  requireAlignedSessions(tape, decisions)
  const sideRate = bp / 20_000
  let shares = new Map<Ticker, number>()
  let weights = new Map<Ticker, number>()
  let nav = 1
  return tape.map((frame, i) => {
    const decision = decisions[i]
    const target = gated && !decision.gateOpen ? [Ticker.SHY] : decision.signal.leaders
    const names = [...new Set([...shares.keys(), ...target])]
    const orders = names.map((ticker) => ({ ticker, weight: target.includes(ticker) ? 1 / target.length : 0 }))
    const desired = orders.map(({ ticker, weight }) => weight - (weights.get(ticker) ?? 0))
    const trade =
      Math.max(sum(desired.filter((delta) => delta > 0)), -sum(desired.filter((delta) => delta < 0))) >
      protocol.deadband
    let turnover = 0
    let fee = 0
    if (trade) {
      const marks = orders.map(({ ticker, weight }) => {
        const { open } = mark(frame, ticker)
        return { ticker, open, weight, before: (shares.get(ticker) ?? 0) * open }
      })
      const preFeeNav = (shares.size === 0 ? 1 : 0) + sum(marks.map(({ before }) => before))
      const gross = (post: number) => sum(marks.map(({ weight, before }) => Math.abs(weight * post - before)))
      let postFeeNav = preFeeNav
      // Fund fees from the same equity as the orders. The fixed point contracts by at most 5 bp.
      for (let step = 0; step < 6; step++) postFeeNav = preFeeNav - sideRate * gross(postFeeNav)
      turnover = gross(postFeeNav) / (2 * preFeeNav)
      fee = (preFeeNav - postFeeNav) / nav
      shares = new Map(
        marks
          .filter(({ weight }) => weight > 0)
          .map(({ ticker, open, weight }) => [ticker, (postFeeNav * weight) / open]),
      )
    }
    const closes = Array.from(shares, ([ticker, quantity]) => ({ ticker, value: quantity * mark(frame, ticker).close }))
    const closeNav = sum(closes.map(({ value }) => value))
    const net = closeNav / nav - 1
    if (!Number.isFinite(net) || net <= -1) throw new Error(`Invalid rotation NAV: ${frame.date}`)
    nav = closeNav
    weights = new Map(closes.map(({ ticker, value }) => [ticker, value / closeNav]))
    return { date: frame.date, net, turnover, fee, traded: trade, defensive: shares.has(Ticker.SHY) }
  })
}

export const performance = (days: readonly ReturnDay[]) => {
  const returns = days.map(({ net }) => net)
  if (returns.length < 2 || returns.some((value) => !Number.isFinite(value) || value <= -1))
    throw new Error('Invalid daily return path')
  const nav = wealth(returns, true)
  const maxDD = maxDrawdown(returns, true)
  const cagr = nav ** (sessionsPerYear / returns.length) - 1
  return {
    netReturn: nav - 1,
    cagr,
    sharpe: sharpe(returns),
    calmar: calmar(cagr, maxDD),
    maxDrawdown: maxDD,
    annualOneWayTurnover: mean(days.map(({ turnover }) => turnover)) * sessionsPerYear,
  }
}

const resampleMeans = (values: readonly number[], { draws, sessions, blocks, offsets }: StationaryPlan) => {
  if (values.length !== sessions) throw new Error('Stationary bootstrap length mismatch')
  const prefix = new Float64Array(2 * sessions + 1)
  for (let i = 0; i < 2 * sessions; i++) prefix[i + 1] = prefix[i] + values[i % sessions]
  return Array.from({ length: draws }, (_, draw) => {
    let total = 0
    for (let i = offsets[draw]; i < offsets[draw + 1]; i += 2) total += prefix[blocks[i + 1]] - prefix[blocks[i]]
    return total / sessions
  })
}

const interval = (draws: readonly (number | null)[]) => {
  const defined = draws.filter((value): value is number => value !== null && Number.isFinite(value))
  if (defined.length !== draws.length) return null
  const lower = quantile(defined, 0.025)
  const upper = quantile(defined, 0.975)
  return lower === null || upper === null ? null : { lower, upper }
}

const variance = (average: number, square: number) => {
  const value = square - average ** 2
  // Degenerate resamples should not become nonzero just from prefix-sum rounding.
  return value > Math.abs(square) * 1e-12 ? value : null
}

const sharpeDraws = (returns: readonly number[], plan: StationaryPlan) => {
  const means = resampleMeans(returns, plan)
  const squares = resampleMeans(
    returns.map((value) => value ** 2),
    plan,
  )
  return means.map((average, i) => {
    const v = variance(average, squares[i])
    return v === null ? null : average * Math.sqrt((sessionsPerYear * (plan.sessions - 1)) / (v * plan.sessions))
  })
}

export const pairedSharpeLift = (after: readonly number[], before: readonly number[], plan: StationaryPlan) => {
  const left = sharpeDraws(after, plan)
  const right = sharpeDraws(before, plan)
  return {
    estimate: pairedSharpeDiff(after, before),
    ci95: interval(left.map((value, i) => (value === null || right[i] === null ? null : value - right[i]))),
  }
}

export const marketAlpha = (
  rotation: readonly number[],
  spy: readonly number[],
  shy: readonly number[],
  plan: StationaryPlan,
) => {
  if (rotation.length !== plan.sessions || spy.length !== plan.sessions || shy.length !== plan.sessions)
    throw new Error('Market alpha requires aligned return counts')
  const market = spy.map((value, i) => value - shy[i])
  const excess = rotation.map((value, i) => value - shy[i])
  const squares = market.map((value) => value ** 2)
  const products = market.map((value, i) => value * excess[i])
  const fit = (x: number, y: number, xx: number, xy: number) => {
    const v = variance(x, xx)
    if (v === null) return null
    const beta = (xy - x * y) / v
    return { beta, annualAlpha: sessionsPerYear * (y - beta * x) }
  }
  const x = resampleMeans(market, plan)
  const y = resampleMeans(excess, plan)
  const xx = resampleMeans(squares, plan)
  const xy = resampleMeans(products, plan)
  return {
    fit: fit(mean(market), mean(excess), mean(squares), mean(products)),
    ci95: interval(x.map((value, i) => fit(value, y[i], xx[i], xy[i])?.annualAlpha ?? null)),
  }
}

export const verdictFor = (gates: readonly { positiveNet: boolean; alpha: boolean; portfolio: boolean }[]) => {
  const complete = gates.length === 2 * protocol.decisionCosts.length
  const positiveNet = complete && gates.every((gate) => gate.positiveNet)
  const alpha = complete && gates.every((gate) => gate.alpha)
  const portfolio = complete && gates.every((gate) => gate.portfolio)
  return {
    verdict: positiveNet && (alpha || portfolio) ? Verdict.Promote : Verdict.DoNotPromote,
    positiveNet,
    alpha,
    portfolio,
  }
}
