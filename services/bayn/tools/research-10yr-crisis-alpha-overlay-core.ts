import { elapsedDays, foldBounds, requireAlignedSessions } from './research-lib/calendar'
import {
  maxDrawdown,
  mean,
  sharpe,
  stationaryBootstrap,
  type StationaryPlan,
  sum,
  wealth,
} from './research-lib/statistics'

export enum OverlayEtf {
  SPY = 'SPY',
  QQQ = 'QQQ',
  GLD = 'GLD',
  TLT = 'TLT',
  IEF = 'IEF',
  SHY = 'SHY',
  UUP = 'UUP',
  DBC = 'DBC',
}

export enum Rule {
  Primary = 'volOrTrend',
  Confirmed = 'volAndTrend',
  Cash = 'cashSwitch',
  Static = 'staticOffense',
}

export enum Regime {
  Offense = 'offense',
  Defense = 'defense',
}

export enum Verdict {
  Promote = 'PROMOTE',
  Reject = 'DO NOT PROMOTE',
}

export const folds = [
  { id: '2016–2019', from: '2016-11-01', through: '2019-12-31' },
  { id: '2020–2021', from: '2020-01-02', through: '2021-12-31' },
  { id: '2022–2023', from: '2022-01-03', through: '2023-12-29' },
  { id: '2024–2026', from: '2024-01-02', through: '2026-11-25' },
] as const
const crises = [
  { id: 'covid2020', from: '2020-02-19', through: '2020-04-30' },
  { id: 'bear2022', from: '2022-01-03', through: '2022-12-30' },
] as const

export const costGrid = [0, 2, 5, 10] as const
export type OneWayBps = (typeof costGrid)[number]
const offense = [OverlayEtf.SPY, OverlayEtf.QQQ]
const sleeveWeight = 0.25
const allocations = { B0: 0.4, F4: 0.35, O1: 0.25 } as const
const accounts = ['B0', 'F4', 'O1'] as const
const trendLookback = 200
const havenLookback = 63
const volLookback = 20
const volLimit = 0.2
const turnoverBand = 0.1
const sellFee = 0.21 / 10_000
const tailImprovement = 0.01
const bootstrap = { draws: 2_000, meanBlock: 10, seed: 0x21a2026 }

export const admitUniverse = (listedEtfs: readonly string[]) => {
  const catalog = new Set(listedEtfs)
  if (catalog.size !== listedEtfs.length) throw new Error('Duplicate ETF in the base archive manifest')
  const symbols = Object.values(OverlayEtf).filter((symbol) => catalog.has(symbol))
  if (offense.some((symbol) => !catalog.has(symbol)) || symbols.length <= offense.length)
    throw new Error('Base archive must list SPY, QQQ and at least one requested haven')
  return symbols
}

export interface Observation {
  readonly date: string
  readonly bars: ReadonlyMap<string, { readonly open: number; readonly close: number }>
}

interface Mark {
  readonly symbol: OverlayEtf
  readonly priorClose: number
  readonly open: number
  readonly close: number
}

export interface OverlayDay {
  readonly date: string
  readonly marks: readonly Mark[]
  readonly trendBreak: boolean
  readonly highVol: boolean
  readonly risingHavens: readonly OverlayEtf[]
}

export const prepareOverlay = (
  observations: readonly Observation[],
  symbols: readonly OverlayEtf[],
  from: string,
): OverlayDay[] => {
  requireAlignedSessions(observations)
  const prices = observations.map(({ date, bars }) =>
    symbols.map((symbol) => {
      const mark = bars.get(symbol)
      if (
        mark === undefined ||
        !Number.isFinite(mark.open) ||
        !Number.isFinite(mark.close) ||
        mark.open <= 0 ||
        mark.close <= 0
      )
        throw new Error(`Missing or invalid archived price: ${symbol} ${date}`)
      return mark
    }),
  )
  const first = observations.findIndex(({ date }) => date === from)
  const spy = symbols.indexOf(OverlayEtf.SPY)
  if (first < trendLookback || spy < 0) throw new Error('Missing SPY or the registered warm-up window')
  return observations.slice(first).map(({ date }, offset) => {
    const i = first + offset
    const past = prices.slice(i - trendLookback, i)
    const priorClose = past[past.length - 1]
    const spyCloses = past.map((day) => day[spy].close)
    const volCloses = spyCloses.slice(-(volLookback + 1))
    const logReturns = volCloses.slice(1).map((close, j) => Math.log(close / volCloses[j]))
    const center = mean(logReturns)
    const rv = Math.sqrt(sum(logReturns.map((value) => (value - center) ** 2)) * (252 / (volLookback - 1)))
    return {
      date,
      marks: symbols.map((symbol, j) => ({ symbol, priorClose: priorClose[j].close, ...prices[i][j] })),
      trendBreak: priorClose[spy].close < mean(spyCloses),
      highVol: rv >= volLimit,
      risingHavens: symbols.filter(
        (symbol, j) =>
          !offense.includes(symbol) &&
          priorClose[j].close > mean(past.slice(-havenLookback).map((day) => day[j].close)),
      ),
    }
  })
}

const oneWayReplacement = (deltas: readonly number[]) =>
  Math.max(sum(deltas.map((delta) => Math.max(0, delta))), sum(deltas.map((delta) => Math.max(0, -delta))))

const target = ({ trendBreak, highVol, risingHavens }: OverlayDay, rule: Rule) => {
  const defensive = rule === Rule.Confirmed ? trendBreak && highVol : rule !== Rule.Static && (trendBreak || highVol)
  return defensive
    ? { regime: Regime.Defense, selected: rule === Rule.Cash ? [] : risingHavens }
    : { regime: Regime.Offense, selected: offense }
}

const openingTrade = (before: readonly number[], weights: readonly number[], nav: number, bps: OneWayBps) => {
  const rate = bps / 10_000
  const quote = (budget: number) => {
    const positions = weights.map((weight) => budget * weight)
    const deltas = positions.map((value, i) => value - before[i])
    const buys = sum(deltas.map((value) => Math.max(0, value)))
    const sells = sum(deltas.map((value) => Math.max(0, -value)))
    return { positions, cost: (buys + sells) * rate + sells * (1 - rate) * sellFee, traded: buys + sells }
  }
  // Gross targets consume at most 100% of equity. Solve equity after costs;
  // the fee slope is bounded by the per-side rate, so the fixed point contracts.
  let budget = nav
  for (let i = 0; i < 12; i++) {
    const trade = quote(budget)
    const afterFees = nav - trade.cost
    if (Math.abs(afterFees - budget) <= nav * 1e-13) return trade
    budget = afterFees
  }
  throw new Error('Unable to fund the next-open ETF rebalance')
}

export const replayOverlay = (days: readonly OverlayDay[], rule: Rule, bps: OneWayBps) => {
  let equity = 1
  let cash = 1
  let shares = days[0]?.marks.map(() => 0) ?? []
  let heldRegime = Regime.Offense
  return days.map((day) => {
    const { date, marks } = day
    const { selected, regime } = target(day, rule)
    const weights = marks.map(({ symbol }) => (selected.includes(symbol) ? 1 / selected.length : 0))
    const priorShares = shares
    const previous = equity
    const openingValues = marks.map(({ open }, i) => priorShares[i] * open)
    const openEquity = cash + sum(openingValues)
    const replacement = oneWayReplacement(
      weights.map((weight, i) => weight - (priorShares[i] * marks[i].priorClose) / previous),
    )
    let cost = 0
    let traded = 0
    if (replacement >= turnoverBand) {
      const trade = openingTrade(openingValues, weights, openEquity, bps)
      cash = openEquity - trade.cost - sum(trade.positions)
      if (cash < -openEquity * 1e-12) throw new Error(`ETF rebalance overspent: ${date}`)
      // Remove signed floating-point dust only; reserve stays in the sleeve.
      cash = Math.max(0, cash)
      shares = marks.map(({ open }, i) => trade.positions[i] / open)
      cost = trade.cost
      traded = trade.traded
      heldRegime = regime
    } else if (shares.every((quantity) => quantity === 0)) {
      // A cash book can switch into the defensive cash state without an order.
      heldRegime = regime
    }

    equity = cash + sum(marks.map(({ close }, i) => shares[i] * close))
    const pnl = marks.map(
      ({ priorClose, open, close }, i) => priorShares[i] * (open - priorClose) + shares[i] * (close - open),
    )
    const net = equity / previous - 1
    if (!Number.isFinite(equity) || equity <= 0 || Math.abs(net - (sum(pnl) - cost) / previous) > 1e-12)
      throw new Error(`ETF sleeve accounting mismatch: ${date}`)
    return {
      date,
      net,
      regime: heldRegime,
      traded: traded > 0,
      turnover: traded / (2 * openEquity),
      fees: cost / previous,
      attribution: marks.map(({ symbol }, i) => ({ symbol, contribution: pnl[i] / previous })),
    }
  })
}

export interface DayReturn {
  readonly date: string
  readonly net: number
}

export type Baseline = Readonly<Record<'SPY' | (typeof accounts)[number], readonly DayReturn[]>>

// Fund once at the start of OOS, then compound isolated holdings with no transfers.
const composite = (baseline: Baseline) => {
  const nav: Record<(typeof accounts)[number], number> = { ...allocations }
  return baseline.B0.map(({ date }, i) => {
    const start = sum(Object.values(nav))
    for (const account of accounts) nav[account] *= 1 + baseline[account][i].net
    return { date, net: sum(Object.values(nav)) / start - 1 }
  })
}

export const fundOverlay = (base: readonly DayReturn[], sleeve: ReturnType<typeof replayOverlay>) => {
  requireAlignedSessions(base, sleeve)
  let reference = 1 - sleeveWeight
  let hedge = sleeveWeight
  return base.map(({ date, net }, i) => {
    const before = reference + hedge
    const { regime, traded, turnover, attribution, fees, net: sleeveNet } = sleeve[i]
    const baseContribution = (reference / before) * net
    const sleeveShare = hedge / before
    reference *= 1 + net
    hedge *= 1 + sleeveNet
    return {
      date,
      net: (reference + hedge) / before - 1,
      regime,
      traded,
      turnover,
      baseContribution,
      sleeveShare,
      fees: fees * sleeveShare,
      attribution: attribution.map(({ symbol, contribution }) => ({
        symbol,
        contribution: contribution * sleeveShare,
      })),
    }
  })
}
type OverlayReturn = ReturnType<typeof fundOverlay>[number]

const performance = (rows: readonly DayReturn[]) => {
  const from = rows[0].date
  const through = rows[rows.length - 1].date
  const years = (elapsedDays(from, through) + 1) / 365.2425
  const returns = rows.map(({ net }) => net)
  const final = wealth(returns, true)
  return {
    from,
    through,
    sessions: rows.length,
    years,
    netReturn: final - 1,
    cagr: final ** (1 / years) - 1,
    sharpe: sharpe(returns),
    maxDrawdown: maxDrawdown(returns, true),
  }
}

interface Window {
  readonly first: number
  readonly end: number
}
const inWindow = <T>(rows: readonly T[], { first, end }: Window) => rows.slice(first, end)
const withWindows = <T>(windows: readonly (Window & { id: string })[], score: (window: Window) => T) =>
  Object.fromEntries(windows.map((window) => [window.id, score(window)]))

const completeQuarters = (scored: readonly { readonly date: string }[]) => {
  const quarters: { id: string; first: number; end: number }[] = []
  for (const [i, { date }] of scored.entries()) {
    const id = `${date.slice(0, 4)}Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`
    const last = quarters.at(-1)
    if (last?.id === id) last.end = i + 1
    else quarters.push({ id, first: i, end: i + 1 })
  }
  const complete = quarters.slice(1, -1) // The preregistered edge quarters are partial.
  if (complete.length === 0) throw new Error('No complete quarter in the scored calendar')
  return complete
}

const quarterScores = (rows: readonly DayReturn[], quarters: ReturnType<typeof completeQuarters>) => {
  const scored = quarters.map(({ id, first, end }) => {
    const net = rows.slice(first, end).map((row) => row.net)
    return { id, netReturn: wealth(net, true) - 1, maxDrawdown: maxDrawdown(net, true) }
  })
  return {
    worstQuarterReturn: scored.reduce((worst, quarter) => (quarter.netReturn < worst.netReturn ? quarter : worst)),
    worstQuarterDrawdown: scored.reduce((worst, quarter) =>
      quarter.maxDrawdown > worst.maxDrawdown ? quarter : worst,
    ),
  }
}

const interval = (samples: number[]) => {
  samples.sort((a, b) => a - b)
  const at = (p: number) => samples[Math.floor(p * (samples.length - 1))]
  return samples.length === 0 ? null : { lower: at(0.025), upper: at(0.975), validDraws: samples.length }
}

export const pairedIntervals = (
  strategy: readonly number[],
  base: readonly number[],
  years: number,
  plan: StationaryPlan,
) => {
  if (strategy.length !== plan.sessions || base.length !== plan.sessions)
    throw new Error('Paired bootstrap input length mismatch')
  const deltaCagr: number[] = []
  const deltaSharpe: number[] = []
  const maxDrawdownImprovement: number[] = []
  const a: number[] = []
  const b: number[] = []
  for (let draw = 0; draw < plan.draws; draw++) {
    a.length = 0
    b.length = 0
    for (let block = plan.offsets[draw]; block < plan.offsets[draw + 1]; block += 2) {
      for (let i = plan.blocks[block]; i < plan.blocks[block + 1]; i++) {
        a.push(strategy[i % plan.sessions])
        b.push(base[i % plan.sessions])
      }
    }
    deltaCagr.push(wealth(a, true) ** (1 / years) - wealth(b, true) ** (1 / years))
    const aSharpe = sharpe(a)
    const bSharpe = sharpe(b)
    if (aSharpe !== null && bSharpe !== null) deltaSharpe.push(aSharpe - bSharpe)
    maxDrawdownImprovement.push(maxDrawdown(b, true) - maxDrawdown(a, true))
  }
  return {
    deltaCagr: interval(deltaCagr),
    deltaSharpe: interval(deltaSharpe),
    maxDrawdownImprovement: interval(maxDrawdownImprovement),
  }
}

const attribution = (rows: readonly OverlayReturn[]) => {
  const byEtf = new Map<OverlayEtf, number>()
  for (const row of rows)
    for (const { symbol, contribution } of row.attribution) byEtf.set(symbol, (byEtf.get(symbol) ?? 0) + contribution)
  return {
    sessions: rows.length,
    baseContribution: sum(rows.map(({ baseContribution }) => baseContribution)),
    etfContributions: Object.fromEntries(byEtf),
    fees: sum(rows.map(({ fees }) => fees)),
    netSum: sum(rows.map(({ net }) => net)),
  }
}

const regimeAttribution = (rows: readonly OverlayReturn[]) =>
  Object.fromEntries(
    Object.values(Regime).map((regime) => [regime, attribution(rows.filter((row) => row.regime === regime))]),
  )

const worstDays = (rows: readonly DayReturn[]) =>
  rows
    .map(({ net }, index) => ({ net, index }))
    .sort((a, b) => a.net - b.net || a.index - b.index)
    .slice(0, 10)
    .map(({ index }) => index)

const worstTenSessionWindow = (rows: readonly DayReturn[]) => {
  let worst = Infinity
  let start = 0
  for (let i = 0; i <= rows.length - 10; i++) {
    const net = wealth(
      rows.slice(i, i + 10).map((row) => row.net),
      true,
    )
    if (net < worst) {
      worst = net
      start = i
    }
  }
  return { first: start, end: start + 10 }
}

type PromotionEvidence = {
  readonly deltaCagr: number
  readonly deltaSharpe: number | null
  readonly worstQuarterImprovement: number
  readonly covidImprovement: number
  readonly bearImprovement: number
}

export const decidePromotion = (
  evidence: Readonly<Record<5 | 10, PromotionEvidence>>,
  bootstrapDrawdownLower: number | undefined,
  scoredHeldGaps: number,
) => {
  const stress = ([5, 10] as const).map((bps) => {
    const row = evidence[bps]
    return {
      oneWayBps: bps,
      cagrPreserved: row.deltaCagr >= 0,
      sharpePreserved: row.deltaSharpe !== null && row.deltaSharpe >= 0,
      worstQuarterImproved: row.worstQuarterImprovement >= tailImprovement,
      covidImproved: row.covidImprovement >= tailImprovement,
      bearImproved: row.bearImprovement >= tailImprovement,
    }
  })
  const positiveBootstrapLower = bootstrapDrawdownLower !== undefined && bootstrapDrawdownLower > 0
  const noScoredHeldGaps = scoredHeldGaps === 0
  const clearsStress = stress.every(
    (row) =>
      row.cagrPreserved && row.sharpePreserved && row.worstQuarterImproved && row.covidImproved && row.bearImproved,
  )
  return {
    verdict: clearsStress && positiveBootstrapLower && noScoredHeldGaps ? Verdict.Promote : Verdict.Reject,
    gates: { stress, positiveBootstrapLower, noScoredHeldGaps },
  }
}

const scoreCost = (days: readonly OverlayDay[], reference: Baseline, bps: OneWayBps, plan: StationaryPlan) => {
  requireAlignedSessions(days, ...Object.values(reference))
  if (Object.values(reference).some((rows) => rows.some(({ net }) => !Number.isFinite(net) || net <= -1)))
    throw new Error('Invalid reference return')
  const dates = days.map(({ date }) => date)
  const withBounds = <T extends { id: string; from: string; through: string }>(windows: readonly T[]) =>
    windows.map((window) => ({ ...window, ...foldBounds(dates, window.from, window.through) }))
  const foldWindows = withBounds(folds)
  if (
    foldWindows[0].first !== 0 ||
    foldWindows.at(-1)?.end !== days.length ||
    foldWindows.some(({ first }, i) => i > 0 && first !== foldWindows[i - 1].end)
  )
    throw new Error('Walk-forward folds must cover the scored calendar exactly once')
  const crisisWindows = withBounds(crises)
  const base = composite(reference)
  const quarters = completeQuarters(days)
  const baseQuarters = quarterScores(base, quarters)
  const worstQuarter = quarters.find(({ id }) => id === baseQuarters.worstQuarterDrawdown.id)
  if (worstQuarter === undefined) throw new Error('No complete quarter in the scored calendar')

  const summarize = (rows: readonly DayReturn[], ownQuarters = quarterScores(rows, quarters)) => ({
    oos: performance(rows),
    folds: withWindows(foldWindows, (fold) => performance(inWindow(rows, fold))),
    crises: withWindows(crisisWindows, (crisis) => performance(inWindow(rows, crisis))),
    ...ownQuarters,
    baselineWorstDrawdownQuarter: performance(inWindow(rows, worstQuarter)),
  })
  const overlays = Object.fromEntries(
    Object.values(Rule).map((id) => [id, fundOverlay(base, replayOverlay(days, id, bps))]),
  )
  const primary = overlays[Rule.Primary]
  const tenWorst = worstDays(base)
  const tenWindow = worstTenSessionWindow(base)
  const books = { ...reference, base, ...overlays }
  const scores = Object.fromEntries(
    Object.entries(books).map(([id, rows]) => [id, summarize(rows, id === 'base' ? baseQuarters : undefined)]),
  )
  const primaryScore = scores[Rule.Primary]
  const baseScore = scores['base']
  const { sharpe: primarySharpe, cagr: primaryCagr } = primaryScore.oos
  const { sharpe: baseSharpe, cagr: baseCagr, years } = baseScore.oos
  const crisisImprovement = (id: (typeof crises)[number]['id']) =>
    baseScore.crises[id].maxDrawdown - primaryScore.crises[id].maxDrawdown
  const improvement = {
    deltaCagr: primaryCagr - baseCagr,
    deltaSharpe: primarySharpe === null || baseSharpe === null ? null : primarySharpe - baseSharpe,
    worstQuarterImprovement: baseScore.worstQuarterDrawdown.maxDrawdown - primaryScore.worstQuarterDrawdown.maxDrawdown,
    covidImprovement: crisisImprovement('covid2020'),
    bearImprovement: crisisImprovement('bear2022'),
  }
  return {
    oneWayBps: bps,
    scores,
    primaryVsBase: improvement,
    pairedBootstrap: pairedIntervals(
      primary.map(({ net }) => net),
      base.map(({ net }) => net),
      years,
      plan,
    ),
    baselineWorstQuarter: worstQuarter.id,
    baselineWorstTenSessions: tenWorst.map((i) => ({
      date: base[i].date,
      net: Object.fromEntries(Object.entries(books).map(([id, rows]) => [id, rows[i].net])),
      primary: { regime: primary[i].regime, ...attribution([primary[i]]) },
    })),
    baselineWorstTenSessionsNetSum: Object.fromEntries(
      Object.entries(books).map(([id, rows]) => [id, sum(tenWorst.map((i) => rows[i].net))]),
    ),
    baselineWorstTenSessionWindow: {
      from: base[tenWindow.first].date,
      through: base[tenWindow.end - 1].date,
      net: Object.fromEntries(
        Object.entries(books).map(([id, rows]) => [
          id,
          wealth(
            inWindow(rows, tenWindow).map(({ net }) => net),
            true,
          ) - 1,
        ]),
      ),
    },
    overlayExecution: Object.fromEntries(
      Object.entries(overlays).map(([id, rows]) => [
        id,
        {
          rebalanceSessions: rows.filter(({ traded }) => traded).length,
          sleeveAnnualOneWayTurnover: mean(rows.map(({ turnover }) => turnover)) * 252,
          meanSleeveWeight: mean(rows.map(({ sleeveShare }) => sleeveShare)),
          oosAttribution: regimeAttribution(rows),
          crisisAttribution: withWindows(crisisWindows, (crisis) => regimeAttribution(inWindow(rows, crisis))),
          worstTenSessionAttribution: attribution(tenWorst.map((i) => rows[i])),
        },
      ]),
    ),
  }
}

export const scoreStudy = (
  days: readonly OverlayDay[],
  baselines: Readonly<Record<OneWayBps, Baseline>>,
  scoredHeldGaps: number,
) => {
  const plan = stationaryBootstrap(days.length, bootstrap)
  const noSlip = scoreCost(days, baselines[0], 0, plan)
  const low = scoreCost(days, baselines[2], 2, plan)
  const primary = scoreCost(days, baselines[5], 5, plan)
  const stress = scoreCost(days, baselines[10], 10, plan)
  return {
    protocol: {
      folds,
      crises,
      initialAccountWeights: allocations,
      initialOverlayWeight: sleeveWeight,
      trendLookback,
      havenLookback,
      volLookback,
      volLimit,
      turnoverBand,
      sellFeeBps: sellFee * 10_000,
      minDrawdownImprovement: tailImprovement,
      bootstrap,
    },
    ...decidePromotion(
      { 5: primary.primaryVsBase, 10: stress.primaryVsBase },
      primary.pairedBootstrap.maxDrawdownImprovement?.lower,
      scoredHeldGaps,
    ),
    scenarios: [noSlip, low, primary, stress],
  }
}
