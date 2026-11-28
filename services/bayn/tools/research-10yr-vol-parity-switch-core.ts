import { sha256 } from '../src/hash'
import { quantile } from './midday-research-statistics'
import { blend } from './orthogonal-pillar3-metrics'
import { beta } from './orthogonal-pillar3-replay'
import { foldBounds, requireAlignedSessions } from './research-lib/calendar'
import { calmar, maxDrawdown, mean, sharpe, stationaryBootstrap, sum, wealth } from './research-lib/statistics'
import { pearson } from './research-orb-zab-statistics'
import { annualVol, type DailyReturn } from './research/event-calendar-etf-replay'
import { openingTrade } from './vol-regime-carry-replay'

export enum Asset {
  SPY = 'SPY',
  QQQ = 'QQQ',
  TLT = 'TLT',
  IEF = 'IEF',
  SHY = 'SHY',
  GLD = 'GLD',
}

export enum Regime {
  Calm = 'calm',
  Stress = 'stress',
}

export enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

export const assets = Object.values(Asset)
const roundTripBps = [0, 2, 5, 10] as const
type Cost = (typeof roundTripBps)[number]
const sessionsPerYear = 252

export const protocol = {
  lookback: 21,
  enterStress: 0.2,
  exitStress: 0.15,
  rebalanceBand: 0.02,
  allocation: {
    [Regime.Calm]: { parity: 0.9, shy: 0.05, gld: 0.05 },
    [Regime.Stress]: { parity: 0.4, shy: 0.45, gld: 0.15 },
  },
  roundTripBps,
  development: { first: '2016-02-04', last: '2019-12-31', sessions: 984 },
  walkForward: [
    { first: '2020-01-02', last: '2021-12-31', sessions: 505 },
    { first: '2022-01-03', last: '2023-12-29', sessions: 501 },
    { first: '2024-01-02', last: '2026-11-25', sessions: 729 },
  ],
  bootstrap: { draws: 5_000, meanBlock: 10, seed: 0x24a2026, lowerTail: 0.025 },
  blendWeight: 0.25,
  maxCagrDrag: 0.01,
  maxAbsCorrelation: 0.5,
} as const

interface Bar {
  readonly open: number
  readonly close: number
}

interface SessionMarks {
  readonly overnight: number
  readonly intraday: number
  readonly closeReturn: number
}

export interface TapeDay {
  readonly date: string
  readonly marks: Readonly<Record<Asset, SessionMarks>>
}

export const markTape = (sessions: readonly { readonly date: string; readonly bars: ReadonlyMap<string, Bar> }[]) => {
  requireAlignedSessions(sessions)
  const bar = ({ date, bars }: (typeof sessions)[number], asset: Asset) => {
    const value = bars.get(asset)
    if (value === undefined || ![value.open, value.close].every((price) => Number.isFinite(price) && price > 0))
      throw new Error(`Missing or invalid ${asset} price on ${date}`)
    return value
  }
  // The first row supplies a prior close, not a fabricated first return.
  return sessions.slice(1).map((session, i): TapeDay => {
    const marks = (asset: Asset) => {
      const previous = bar(sessions[i], asset).close
      const { open, close } = bar(session, asset)
      return { overnight: open / previous, intraday: close / open, closeReturn: close / previous - 1 }
    }
    return {
      date: session.date,
      marks: {
        SPY: marks(Asset.SPY),
        QQQ: marks(Asset.QQQ),
        TLT: marks(Asset.TLT),
        IEF: marks(Asset.IEF),
        SHY: marks(Asset.SHY),
        GLD: marks(Asset.GLD),
      },
    }
  })
}

export const nextRegime = (previous: Regime, spyVol: number) => {
  if (!Number.isFinite(spyVol) || spyVol < 0) throw new Error('Invalid SPY realized volatility')
  if (spyVol >= protocol.enterStress) return Regime.Stress
  if (spyVol <= protocol.exitStress) return Regime.Calm
  return previous
}

export const targetWeights = (regime: Regime, equityVol: number, bondVol: number): Readonly<Record<Asset, number>> => {
  if (![equityVol, bondVol].every((vol) => Number.isFinite(vol) && vol > 0))
    throw new Error('Risk parity requires positive, finite basket volatility')
  const { parity, shy, gld } = protocol.allocation[regime]
  const equityShare = bondVol / (equityVol + bondVol)
  const equity = (parity * equityShare) / 2
  const bond = (parity * (1 - equityShare)) / 2
  return { SPY: equity, QQQ: equity, TLT: bond, IEF: bond, SHY: shy, GLD: gld }
}

export interface CloseSignal {
  readonly date: string
  readonly regime: Regime
  readonly equityVol: number
  readonly bondVol: number
}

type CloseHistory = {
  readonly date: string
  readonly marks: Readonly<Record<Asset, Pick<SessionMarks, 'closeReturn'>>>
}

export const closeSignals = (tape: readonly CloseHistory[]) => {
  let regime = Regime.Calm
  return tape.map(({ date }, i): CloseSignal | undefined => {
    if (i + 1 < protocol.lookback) return undefined
    const window = tape.slice(i + 1 - protocol.lookback, i + 1)
    regime = nextRegime(regime, annualVol(window.map(({ marks }) => marks.SPY.closeReturn)))
    return {
      date,
      regime,
      equityVol: annualVol(window.map(({ marks }) => (marks.SPY.closeReturn + marks.QQQ.closeReturn) / 2)),
      bondVol: annualVol(window.map(({ marks }) => (marks.TLT.closeReturn + marks.IEF.closeReturn) / 2)),
    }
  })
}

export const clearsRebalanceBand = (priorWeights: readonly number[], target: readonly number[]) => {
  const changes = target.map((weight, i) => weight - priorWeights[i])
  const buy = sum(changes.filter((change) => change > 0))
  const sell = -sum(changes.filter((change) => change < 0))
  return Math.max(buy, sell) >= protocol.rebalanceBand
}

export const replay = (
  tape: readonly TapeDay[],
  signals: readonly (CloseSignal | undefined)[],
  cost: Cost,
  alwaysCalm = false,
) => {
  if (tape.length !== signals.length) throw new Error('Tape and signal coverage differ')
  let positions = assets.map(() => 0)
  let cash = 1
  let previousNav = 1
  return tape.map(({ date, marks }, i) => {
    const signal = signals[i - 1]
    if (signal !== undefined && signal.date !== tape[i - 1].date)
      throw new Error(`Signal not dated on the prior session: ${date}`)
    // Both the target and the decision to rebalance are fixed at the prior close.
    let regime: Regime | null = null
    let order: number[] | undefined
    if (signal !== undefined) {
      regime = alwaysCalm ? Regime.Calm : signal.regime
      const weights = targetWeights(regime, signal.equityVol, signal.bondVol)
      const target = assets.map((asset) => weights[asset])
      if (
        clearsRebalanceBand(
          positions.map((value) => value / previousNav),
          target,
        )
      )
        order = target
    }
    const opening = assets.map((asset, j) => positions[j] * marks[asset].overnight)
    let turnover = 0
    let fees = 0
    if (order !== undefined) {
      const trade = openingTrade(opening, sum(opening) + cash, order, cost)
      positions = trade.invested
      cash = trade.cash
      turnover = trade.turnover
      fees = trade.fees
    } else {
      positions = opening
    }
    positions = assets.map((asset, j) => positions[j] * marks[asset].intraday)
    const nav = sum(positions) + cash
    if (!Number.isFinite(nav) || nav <= 0) throw new Error(`Invalid marked NAV on ${date}`)
    const net = nav / previousNav - 1
    previousNav = nav
    return { date, net, turnover, fees, rebalanced: order !== undefined, regime, signalDate: signal?.date ?? null }
  })
}

const pathRisk = (values: readonly number[]) => {
  const netReturn = wealth(values, true) - 1
  const cagr = (1 + netReturn) ** (sessionsPerYear / values.length) - 1
  const drawdown = maxDrawdown(values, true)
  return { netReturn, cagr, maxDrawdown: drawdown, calmar: calmar(cagr, drawdown) }
}

const performance = (path: readonly DailyReturn[]) => {
  const values = path.map(({ net }) => net)
  if (
    values.length < 2 ||
    values.some((value) => !Number.isFinite(value) || value <= -1) ||
    path.some(({ turnover }) => !Number.isFinite(turnover) || turnover < 0)
  )
    throw new Error('Invalid or insolvent return path')
  return {
    ...pathRisk(values),
    sharpe: sharpe(values),
    annualOneWayTurnover: mean(path.map(({ turnover }) => turnover)) * sessionsPerYear,
  }
}

const riskLift = (base: ReturnType<typeof pathRisk>, after: ReturnType<typeof pathRisk>) => ({
  cagr: after.cagr - base.cagr,
  calmar: base.calmar === null || after.calmar === null ? null : after.calmar - base.calmar,
  maxDrawdownReduction: base.maxDrawdown - after.maxDrawdown,
})

const alpha = (excess: readonly number[], marketExcess: readonly number[]) => {
  const exposure = beta(excess, marketExcess)
  return {
    beta: exposure,
    annualized: exposure === null ? null : sessionsPerYear * (mean(excess) - exposure * mean(marketExcess)),
  }
}

type Plan = ReturnType<typeof stationaryBootstrap>
function* bootstrapDraws(plan: Plan) {
  for (let draw = 0; draw < plan.draws; draw++) {
    const indices: number[] = []
    for (let block = plan.offsets[draw]; block < plan.offsets[draw + 1]; block += 2) {
      for (let i = plan.blocks[block]; i < plan.blocks[block + 1]; i++) indices.push(i % plan.sessions)
    }
    yield indices
  }
}

const interval = (samples: readonly (number | null)[]) => {
  const finite = samples.filter((sample) => sample !== null)
  if (finite.length !== samples.length || finite.some((sample) => !Number.isFinite(sample))) return null
  const lower = quantile(finite, protocol.bootstrap.lowerTail)
  const upper = quantile(finite, 1 - protocol.bootstrap.lowerTail)
  return lower === null || upper === null ? null : { lower, upper }
}

type Window = ReturnType<typeof foldBounds>
const cut = <A>(values: readonly A[], { first, end }: Window) => values.slice(first, end)
type Controls = Readonly<Record<'SPY' | 'B0' | 'F4' | 'O1', readonly DailyReturn[]>>
const positive = (value: number | null | undefined) => value !== null && value !== undefined && value > 0

export const verdictFor = (costs: ReadonlyMap<Cost, { readonly alpha: boolean; readonly diversification: boolean }>) =>
  roundTripBps.slice(1).every((bp) => costs.get(bp)?.alpha === true) ||
  roundTripBps.slice(1).every((bp) => costs.get(bp)?.diversification === true)
    ? Verdict.Promote
    : Verdict.DoNotPromote

export const scoreStudy = (tape: readonly TapeDay[], controlsAt: (cost: Cost) => Controls) => {
  const signals = closeSignals(tape)
  const scored = tape.slice(protocol.lookback)
  const dates = scored.map(({ date }) => date)
  const windows = [protocol.development, ...protocol.walkForward].map(({ first, last, sessions }) =>
    foldBounds(dates, first, last, sessions),
  )
  if (
    windows[0].first !== 0 ||
    windows.at(-1)?.end !== scored.length ||
    windows.some((w, i) => i > 0 && w.first !== windows[i - 1].end)
  )
    throw new Error('Walk-forward windows must cover every scored session exactly once')
  const [development, ...walkForward] = windows
  const full = { first: 0, end: scored.length }
  const latest = walkForward[walkForward.length - 1]
  const pooledOos = { first: walkForward[0].first, end: latest.end }
  const byWindow = <A>(summarize: (window: Window) => A) => ({
    full: summarize(full),
    development: summarize(development),
    walkForward: walkForward.map(summarize),
    pooledOos: summarize(pooledOos),
  })
  const bootstrap = stationaryBootstrap(pooledOos.end - pooledOos.first, protocol.bootstrap)
  const shy = scored.map(({ marks }) => marks.SHY.closeReturn)
  const byCost = roundTripBps.map((cost) => {
    const candidate = replay(tape, signals, cost).slice(protocol.lookback)
    const parity = replay(tape, signals, cost, true).slice(protocol.lookback)
    const { SPY, B0, F4, O1 } = controlsAt(cost)
    const controls = [SPY, B0, F4, O1].map((path) => path.slice(protocol.lookback + 1))
    requireAlignedSessions(scored, candidate, parity, ...controls)
    const [spy, b0, f4, o1] = controls
    const candidateNet = candidate.map(({ net }) => net)
    const excess = candidateNet.map((net, i) => net - shy[i])
    const marketExcess = spy.map(({ net }, i) => net - shy[i])
    const alphaByWindow = byWindow((window) => alpha(cut(excess, window), cut(marketExcess, window)))
    const oosExcess = cut(excess, pooledOos)
    const oosMarket = cut(marketExcess, pooledOos)
    const alphaSamples = Array.from(
      bootstrapDraws(bootstrap),
      (indices) =>
        alpha(
          indices.map((i) => oosExcess[i]),
          indices.map((i) => oosMarket[i]),
        ).annualized,
    )
    const alphaInterval = interval(alphaSamples)
    const compare = (members: readonly (readonly DailyReturn[])[]) => {
      const combine = (paths: typeof members, weights: readonly number[]) =>
        blend(
          paths.map((path) => path.map((day) => ({ ...day, borrow: 0 }))),
          weights,
          cost / 2,
        ).map((day, i) => ({ date: dates[i], ...day }))
      const base =
        members.length === 1
          ? members[0]
          : combine(
              members,
              members.map(() => 1 / members.length),
            )
      const added = combine(
        [...members, candidate],
        [...members.map(() => (1 - protocol.blendWeight) / members.length), protocol.blendWeight],
      )
      const periods = byWindow((window) => {
        const incumbent = cut(base, window)
        const mixed = cut(added, window)
        const before = performance(incumbent)
        const after = performance(mixed)
        return {
          correlation: pearson(
            cut(candidateNet, window),
            incumbent.map(({ net }) => net),
          ),
          incumbent: before,
          blend: after,
          lift: riskLift(before, after),
        }
      })
      const oosBase = cut(base, pooledOos).map(({ net }) => net)
      const oosBlend = cut(added, pooledOos).map(({ net }) => net)
      const samples = Array.from(bootstrapDraws(bootstrap), (indices) =>
        riskLift(pathRisk(indices.map((i) => oosBase[i])), pathRisk(indices.map((i) => oosBlend[i]))),
      )
      return {
        periods,
        pairedOosIntervals: {
          calmar: interval(samples.map((sample) => sample.calmar)),
          maxDrawdownReduction: interval(samples.map((sample) => sample.maxDrawdownReduction)),
        },
      }
    }
    const comparisons = {
      SPY: compare([spy]),
      B0: compare([b0]),
      F4: compare([f4]),
      O1: compare([o1]),
      incumbents: compare([b0, f4, o1]),
    }
    const candidateMetrics = byWindow((window) => performance(cut(candidate, window)))
    const { periods: incumbent, pairedOosIntervals: paired } = comparisons.incumbents
    const { correlation, lift } = incumbent.pooledOos
    const latestLift = incumbent.walkForward[incumbent.walkForward.length - 1].lift
    const alphaGates = {
      positiveOosCagr: positive(candidateMetrics.pooledOos.cagr),
      positiveOosAlphaLower: positive(alphaInterval?.lower),
      positiveAlphaEveryFold: alphaByWindow.walkForward.every(({ annualized }) => positive(annualized)),
    }
    const blendGates = {
      positiveOosCalmarLower: positive(paired.calmar?.lower),
      positiveOosDrawdownReductionLower: positive(paired.maxDrawdownReduction?.lower),
      latestFoldImprovesBoth: positive(latestLift.calmar) && positive(latestLift.maxDrawdownReduction),
      withinCagrDrag: lift.cagr >= -protocol.maxCagrDrag,
      withinCorrelation: correlation !== null && Math.abs(correlation) <= protocol.maxAbsCorrelation,
    }
    return {
      roundTripBps: cost,
      candidate: candidateMetrics,
      staticParity: byWindow((window) => performance(cut(parity, window))),
      alpha: { periods: alphaByWindow, pooledOosInterval: alphaInterval },
      comparisons,
      execution: {
        rebalances: candidate.filter(({ rebalanced }) => rebalanced).length,
        dailyPathSha256: sha256(JSON.stringify(candidate)),
      },
      alphaGates,
      blendGates,
    }
  })
  const regimeSessions = Object.values(Regime).map((regime) => ({
    regime,
    count: signals.slice(protocol.lookback - 1, -1).filter((signal) => signal?.regime === regime).length,
  }))
  if (sum(regimeSessions.map(({ count }) => count)) !== scored.length)
    throw new Error('Every scored session must have a prior-close regime')
  return {
    verdict: verdictFor(
      new Map(
        byCost.map(({ roundTripBps: cost, alphaGates, blendGates }) => [
          cost,
          {
            alpha: Object.values(alphaGates).every(Boolean),
            diversification: Object.values(blendGates).every(Boolean),
          },
        ]),
      ),
    ),
    regimeSessions,
    scoredSessions: scored.length,
    pooledOosSessions: bootstrap.sessions,
    byCost,
  }
}
