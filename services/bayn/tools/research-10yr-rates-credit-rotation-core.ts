import { Schema } from 'effect'

import { splits } from './etf-canary-macro-protocol'
import { quantile } from './midday-research-statistics'
import { blend } from './orthogonal-pillar3-metrics'
import { elapsedDays, foldBounds, requireAlignedSessions } from './research-lib/calendar'
import {
  calmar,
  maxDrawdown,
  mean,
  sharpe,
  sortino,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
  wealth,
  type StationaryPlan,
} from './research-lib/statistics'
import { pearson } from './research-orb-zab-statistics'
import { openingTrade, shouldTrade } from './vol-regime-carry-replay'
import { band } from './vol-regime-carry-signals'

export enum Ticker {
  TLT = 'TLT',
  IEF = 'IEF',
  SHY = 'SHY',
  TIP = 'TIP',
  HYG = 'HYG',
  LQD = 'LQD',
  GLD = 'GLD',
  SPY = 'SPY',
}

export const isTicker = Schema.is(Schema.Enum(Ticker))
const rankedTickers = [Ticker.TLT, Ticker.IEF, Ticker.TIP, Ticker.HYG, Ticker.LQD, Ticker.GLD] as const
export const sleeveTickers = [...rankedTickers, Ticker.SHY] as const
const shyIndex = sleeveTickers.indexOf(Ticker.SHY)

export enum Rule {
  StressSwitch = 'stress-switch',
  RelativeStrength = 'relative-strength',
}

export enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

const horizons = [21, 63, 126] as const
const creditLookback = 63
const equityLookback = 21
const durationLookback = 63
const equityStress = -0.05
const scoreDeadband = 0.005
const slots = 2
const alpha = 0.025
const maxAbsCorrelation = 0.5
const allocation = 0.25
export const costs = [0, 2, 5, 10] as const
const rules = [Rule.StressSwitch, Rule.RelativeStrength]
const bootstrap = { draws: 10_000, meanBlock: 10, seed: 0x20d5a11 } as const
export const protocol = {
  primary: Rule.StressSwitch,
  rules,
  sleeveTickers,
  excludedTickers: ['BIL', 'SGOV'],
  horizons,
  creditLookback,
  equityLookback,
  durationLookback,
  equityStress,
  scoreDeadband,
  rebalanceDeadband: band,
  slots,
  costsRoundTripBp: costs,
  allocation,
  alpha,
  maxAbsCorrelation,
  bootstrap,
  splits,
}

export type Cost = (typeof costs)[number]
export type Bar = { readonly open: number; readonly close: number }
export type Frame = { readonly date: string; readonly bars: ReadonlyMap<Ticker, Bar> }
export type Day = { readonly date: string; readonly net: number; readonly turnover: number }

export const mark = ({ date, bars }: Frame, ticker: Ticker) => {
  const bar = bars.get(ticker)
  if (bar === undefined || !Number.isFinite(bar.open) || bar.open <= 0 || !Number.isFinite(bar.close) || bar.close <= 0)
    throw new Error(`Missing or invalid ${ticker} marks on ${date}`)
  return bar
}

const closeSignal = (frames: readonly Frame[], index: number) => {
  if (index < horizons[2]) return null
  const logReturn = (ticker: Ticker, days: number) =>
    Math.log(mark(frames[index], ticker).close / mark(frames[index - days], ticker).close)
  const cash = horizons.map((horizon) => logReturn(Ticker.SHY, horizon))
  return {
    creditStress: logReturn(Ticker.HYG, creditLookback) < logReturn(Ticker.IEF, creditLookback),
    equityStress:
      mark(frames[index], Ticker.SPY).close <=
      (1 + equityStress) * mark(frames[index - equityLookback], Ticker.SPY).close,
    durationUp: logReturn(Ticker.TLT, durationLookback) > logReturn(Ticker.IEF, durationLookback),
    scores: rankedTickers.map((ticker) => mean(horizons.map((horizon, i) => logReturn(ticker, horizon) - cash[i]))),
  }
}

const nextTarget = (frames: readonly Frame[], previous: number, shares: readonly number[], rule: Rule) => {
  const signal = closeSignal(frames, previous)
  const defensive = rule === Rule.StressSwitch && signal !== null && (signal.creditStress || signal.equityStress)
  const picks =
    signal === null
      ? []
      : rankedTickers
          .map((ticker, i) => ({ ticker, i, score: signal.scores[i] }))
          .filter(({ ticker, score }) => {
            if (!(score > 0)) return false
            if (rule === Rule.RelativeStrength) return true
            if (defensive) return ticker === Ticker.IEF || ticker === Ticker.GLD
            return ticker !== Ticker.TLT || signal.durationUp
          })
          .sort(
            (a, b) =>
              b.score + (shares[b.i] > 0 ? scoreDeadband : 0) - (a.score + (shares[a.i] > 0 ? scoreDeadband : 0)) ||
              a.i - b.i,
          )
          .slice(0, slots)
  const target = sleeveTickers.map(() => 0)
  for (const { i } of picks) target[i] = 1 / slots
  target[shyIndex] = 1 - picks.length / slots
  return { target, defensive }
}

export const replayRotation = (frames: readonly Frame[], rule: Rule, bp: Cost) => {
  requireAlignedSessions(frames)
  let shares = sleeveTickers.map(() => 0)
  let equity = 1
  return frames.map((frame, i) => {
    // No current-session mark participates in either selection or the rebalance decision.
    const { target, defensive } = nextTarget(frames, i - 1, shares, rule)
    const priorWeights = sleeveTickers.map((ticker, j) =>
      i === 0 ? 0 : (shares[j] * mark(frames[i - 1], ticker).close) / equity,
    )
    const rebalanced = i === 0 || shouldTrade(priorWeights, target)
    const today = sleeveTickers.map((ticker) => mark(frame, ticker))
    let turnover = 0
    if (rebalanced) {
      const current = today.map(({ open }, j) => open * shares[j])
      const trade = openingTrade(current, i === 0 ? equity : sum(current), target, bp)
      shares = trade.invested.map((position, j) => position / today[j].open)
      turnover = trade.turnover
    }
    const closing = sum(today.map(({ close }, j) => shares[j] * close))
    if (!(closing > 0 && Number.isFinite(closing))) throw new Error(`Invalid closing NAV on ${frame.date}`)
    const net = closing / equity - 1
    equity = closing
    return {
      date: frame.date,
      net,
      turnover,
      rebalanced,
      defensive,
      held: sleeveTickers.filter((_, j) => shares[j] > 0),
    }
  })
}

export const buyAndHold = (frames: readonly Frame[], ticker: Ticker.SPY | Ticker.SHY, bp: Cost): Day[] =>
  frames.map((frame, i) => {
    const bar = mark(frame, ticker)
    const prior = frames[i - 1]
    if (prior !== undefined) return { date: frame.date, net: bar.close / mark(prior, ticker).close - 1, turnover: 0 }
    const initial = openingTrade([0], 1, [1], bp)
    return { date: frame.date, net: (initial.invested[0] * bar.close) / bar.open - 1, turnover: initial.turnover }
  })

const returnValues = (days: readonly Day[]) => days.map(({ net }) => net)

export const metrics = (days: readonly Day[]) => {
  const [first] = days
  const last = days.at(-1)
  if (first === undefined || last === undefined) throw new Error('Cannot score an empty return path')
  const returns = returnValues(days)
  if (returns.some((r) => !Number.isFinite(r) || r <= -1)) throw new Error('Unmarkable or insolvent return path')
  const nav = wealth(returns, true)
  const years = (elapsedDays(first.date, last.date) + 1) / 365.2425
  const cagr = nav ** (1 / years) - 1
  const average = mean(returns)
  const drawdown = maxDrawdown(returns, true)
  return {
    totalReturn: nav - 1,
    cagr,
    annualizedVolatility:
      days.length < 2 ? null : Math.sqrt((sum(returns.map((r) => (r - average) ** 2)) * 252) / (days.length - 1)),
    sharpe: sharpe(returns),
    sortino: sortino(returns),
    calmar: calmar(cagr, drawdown),
    maxDrawdown: drawdown,
    annualOneWayTurnover: 252 * mean(days.map(({ turnover }) => turnover)),
  }
}

export const blendPaths = (paths: readonly (readonly Day[])[], weights: readonly number[], bp: Cost): Day[] => {
  const [first, ...rest] = paths
  if (first === undefined) throw new Error('Cannot blend without a return path')
  requireAlignedSessions(first, ...rest)
  return blend(
    paths.map((path) => path.map((row) => ({ ...row, borrow: 0 }))),
    weights,
    bp / 2,
  ).map(({ net, turnover }, i) => ({ date: first[i].date, net, turnover }))
}

export const pairedSharpeLower = (candidate: readonly number[], control: readonly number[], plan: StationaryPlan) => {
  const n = plan.sessions
  if (candidate.length !== n || control.length !== n) throw new Error('Unaligned paired bootstrap')
  const a = sharpe(candidate)
  const b = sharpe(control)
  if (a === null || b === null) return null
  const sampledSharpe = (returns: readonly number[]) => {
    const totals = new Float64Array(2 * n + 1)
    const squares = new Float64Array(2 * n + 1)
    for (let i = 0; i < 2 * n; i++) {
      const ret = returns[i % n]
      totals[i + 1] = totals[i] + ret
      squares[i + 1] = squares[i] + ret ** 2
    }
    return (draw: number) => {
      let total = 0
      let squared = 0
      for (let i = plan.offsets[draw]; i < plan.offsets[draw + 1]; i += 2) {
        const from = plan.blocks[i]
        const end = plan.blocks[i + 1]
        total += totals[end] - totals[from]
        squared += squares[end] - squares[from]
      }
      const variance = (squared - total ** 2 / n) / (n - 1)
      return variance > 0 ? (total / n) * Math.sqrt(252 / variance) : null
    }
  }
  const left = sampledSharpe(candidate)
  const right = sampledSharpe(control)
  const draws = []
  for (let i = 0; i < plan.draws; i++) {
    const lhs = left(i)
    const rhs = right(i)
    if (lhs === null || rhs === null) return null
    draws.push(lhs - rhs)
  }
  const upper = quantile(draws, 1 - alpha)
  // One-sided basic interval: reflect the upper tail about the observed paired difference.
  return upper === null ? null : 2 * (a - b) - upper
}

const difference = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)
const positive = (x: number | null) => x !== null && x > 0
const belowAlpha = (x: number | null) => x !== null && x < alpha
const orthogonal = (x: number | null) => x !== null && Math.abs(x) < maxAbsCorrelation

type Gate = { readonly roundTripBp: Cost; readonly standalone: boolean; readonly portfolio: boolean }
export const promotion = (rows: readonly Gate[]) => {
  const complete = rows.length === costs.length && costs.every((bp, i) => rows[i].roundTripBp === bp)
  const standalone = complete && rows.every((row) => row.standalone)
  const portfolio = complete && rows.every((row) => row.portfolio)
  return { standalone, portfolio, verdict: standalone || portfolio ? Verdict.Promote : Verdict.DoNotPromote }
}

const windowsFor = (dates: readonly string[]) => {
  const train = foldBounds(dates, ...splits.train)
  const forward1 = foldBounds(dates, ...splits.validation)
  const forward2 = foldBounds(dates, ...splits.holdout)
  if (
    train.first !== 0 ||
    train.end !== forward1.first ||
    forward1.end !== forward2.first ||
    forward2.end !== dates.length
  )
    throw new Error('Registered study windows must partition the complete calendar')
  return {
    full: { first: train.first, end: forward2.end },
    train,
    forward1,
    forward2,
    pooledOos: { first: forward1.first, end: forward2.end },
  }
}

type Windows = ReturnType<typeof windowsFor>
const byWindow = <A>(windows: Windows, compute: (window: keyof Windows, first: number, end: number) => A) => {
  const pick = (key: keyof Windows) => compute(key, windows[key].first, windows[key].end)
  return {
    full: pick('full'),
    train: pick('train'),
    forward1: pick('forward1'),
    forward2: pick('forward2'),
    pooledOos: pick('pooledOos'),
  }
}

type Controls = { SPY: Day[]; SHY: Day[]; F4: Day[]; O1: Day[]; B0: Day[] }

export const scoreStudy = (frames: readonly Frame[], getControls: (bp: Cost) => Controls) => {
  requireAlignedSessions(frames)
  const dates = frames.map(({ date }) => date)
  const windows = windowsFor(dates)
  const years = [...new Set(dates.map((date) => date.slice(0, 4)))]
  const plans = byWindow(windows, (key, first, end) =>
    key === 'train' ? undefined : stationaryBootstrap(end - first, bootstrap),
  )
  const summarize = (path: readonly Day[]) => ({
    windows: byWindow(windows, (_, first, end) => metrics(path.slice(first, end))),
    yearlyReturns: Object.fromEntries(
      years.map((year) => [year, wealth(returnValues(path.filter(({ date }) => date.startsWith(year))), true) - 1]),
    ),
  })

  const matrix = costs.map((roundTripBp) => {
    const { SHY, SPY, F4, O1, B0 } = getControls(roundTripBp)
    requireAlignedSessions(frames, SHY, SPY, F4, O1, B0)
    const bayn = [F4, O1, B0]
    const baseBooks = { SPY: [SPY], F4: [F4], O1: [O1], B0: [B0], Bayn: bayn, 'SPY+Bayn': [SPY, ...bayn] }
    const bases = Object.entries(baseBooks).map(([id, legs]) => {
      const weights = legs.map(() => 1 / legs.length)
      const path = blendPaths(legs, weights, roundTripBp)
      return { id, legs, weights, path, summary: summarize(path) }
    })
    const trials = rules.map((rule) => {
      const sleeve = replayRotation(frames, rule, roundTripBp)
      const standalone = summarize(sleeve)
      const relativeToShy = byWindow(windows, (key, first, end) => {
        const a = returnValues(sleeve.slice(first, end))
        const b = returnValues(SHY.slice(first, end))
        const plan = plans[key]
        return {
          compoundedExcess: wealth(a, true) - wealth(b, true),
          meanExcessP:
            plan === undefined
              ? null
              : stationaryMeanP(
                  a.map((r, i) => r - b[i]),
                  plan,
                ),
        }
      })
      const portfolios = bases.map(({ id, legs, weights, path, summary }) => {
        const stack = blendPaths(
          [...legs, sleeve],
          [...weights.map((weight) => weight * (1 - allocation)), allocation],
          roundTripBp,
        )
        const result = summarize(stack)
        const paired = byWindow(windows, (key, first, end) => {
          const after = result.windows[key]
          const before = summary.windows[key]
          const plan = plans[key]
          const baseReturns = returnValues(path.slice(first, end))
          return {
            sharpeLift: difference(after.sharpe, before.sharpe),
            calmarLift: difference(after.calmar, before.calmar),
            drawdownReduction: before.maxDrawdown - after.maxDrawdown,
            sleeveCorrelation: pearson(returnValues(sleeve.slice(first, end)), baseReturns),
            sharpeLiftLower97_5:
              plan === undefined ? null : pairedSharpeLower(returnValues(stack.slice(first, end)), baseReturns, plan),
          }
        })
        return { base: id, ...result, paired }
      })
      const folds = ['forward1', 'forward2'] as const
      const primary = portfolios.find(({ base }) => base === 'Bayn')
      if (primary === undefined) throw new Error('Missing registered Bayn portfolio')
      return {
        rule,
        standalone,
        relativeToShy,
        portfolios,
        execution: {
          rebalances: sleeve.filter(({ rebalanced }) => rebalanced).length,
          defensiveSessions: sleeve.filter(({ defensive }) => defensive).length,
          heldSessions: Object.fromEntries(
            sleeveTickers.map((ticker) => [ticker, sleeve.filter(({ held }) => held.includes(ticker)).length]),
          ),
        },
        gates: {
          standalone:
            folds.every((key) => {
              const row = standalone.windows[key]
              return positive(row.sharpe) && row.cagr > 0 && relativeToShy[key].compoundedExcess > 0
            }) && belowAlpha(relativeToShy.pooledOos.meanExcessP),
          portfolio:
            folds.every((key) => {
              const row = primary.paired[key]
              return (
                positive(row.sharpeLift) &&
                positive(row.calmarLift) &&
                row.drawdownReduction > 0 &&
                orthogonal(row.sleeveCorrelation)
              )
            }) && positive(primary.paired.pooledOos.sharpeLiftLower97_5),
        },
      }
    })
    const registered = trials.find(({ rule }) => rule === protocol.primary)
    if (registered === undefined) throw new Error('Missing registered primary rule')
    return {
      roundTripBp,
      controls: { SHY: summarize(SHY), ...Object.fromEntries(bases.map(({ id, summary }) => [id, summary])) },
      trials,
      gates: { roundTripBp, ...registered.gates },
    }
  })
  return {
    windows: byWindow(windows, (_, first, end) => ({
      from: dates[first],
      through: dates[end - 1],
      sessions: end - first,
    })),
    matrix,
    decision: promotion(matrix.map(({ gates }) => gates)),
  }
}
