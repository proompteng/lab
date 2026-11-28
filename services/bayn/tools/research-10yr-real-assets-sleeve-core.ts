import { Schema } from 'effect'

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
  GLD = 'GLD',
  SLV = 'SLV',
  DBC = 'DBC',
  USO = 'USO',
  TIP = 'TIP',
  XLE = 'XLE',
  SHY = 'SHY',
  SPY = 'SPY',
  IEF = 'IEF',
}

export enum Scope {
  Requested = 'seven-etf',
  Diagnostic = 'six-etf-tip-absent',
}

export enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

const metals = [Ticker.GLD, Ticker.SLV]
const cyclical = [Ticker.DBC, Ticker.USO, Ticker.XLE]
const diagnostic = [...metals, ...cyclical, Ticker.SHY]
export const requested = [...diagnostic, Ticker.TIP]
export const tracked = [...requested, Ticker.SPY, Ticker.IEF]
export const universe = (scope: Scope) => (scope === Scope.Requested ? requested : diagnostic)

export const protocol = {
  trendSessions: 126,
  regimeSessions: 63,
  preciousWeight: 0.5,
  deadband: 0.1,
  costsOneWayBps: [0, 2, 5, 10],
  primaryCostOneWayBps: 10,
  controlCostRoundTripBps: 10,
  sleeveWeight: 0.25,
  stressLookbackSessions: 63,
  equityDrawdown: 0.05,
  ratesDrawdown: 0.03,
  maxAbsCorrelation: 0.3,
  bootstrap: { draws: 5_000, meanBlock: 10, seed: 0x24b2026 },
  bootstrapLowerTail: 0.05,
} as const
export type Cost = (typeof protocol.costsOneWayBps)[number]

export const encodeDecision = Schema.encodeSync(
  Schema.Struct({
    requestedScope: Schema.Enum(Scope),
    evaluatedScope: Schema.Enum(Scope),
    missing: Schema.Array(Schema.Enum(Ticker)),
    verdict: Schema.Enum(Verdict),
  }),
)

export interface Marks {
  readonly open: number
  readonly close: number
}

export interface Frame {
  readonly date: string
  readonly bars: ReadonlyMap<Ticker, Marks>
}

export interface DailyReturn {
  readonly date: string
  readonly net: number
}

const prices = (day: Frame, ticker: Ticker) => {
  const bar = day.bars.get(ticker)
  if (bar === undefined || ![bar.open, bar.close].every((price) => Number.isFinite(price) && price > 0))
    throw new Error(`Missing or invalid ${ticker} mark on ${day.date}`)
  return bar
}

export const admitCoverage = (
  calendar: readonly { readonly date: string }[],
  declared: readonly string[],
  frames: readonly Frame[],
) => {
  requireAlignedSessions(calendar, frames)
  if (frames.length === 0 || new Set(declared).size !== declared.length)
    throw new Error('Empty calendar or duplicate ETF in manifest')
  const coverage = tracked.map((ticker) => {
    const inManifest = declared.includes(ticker)
    const rows = frames.filter(({ bars }) => bars.has(ticker)).length
    // Only a fully absent TIP can yield a diagnostic; a partial or undeclared tape is not that case.
    if ((!inManifest || rows !== frames.length) && (ticker !== Ticker.TIP || inManifest || rows !== 0))
      throw new Error(`Incomplete or inconsistent archive coverage: ${ticker}`)
    return { ticker, inManifest, rows }
  })
  const missing = coverage.filter(({ inManifest }) => !inManifest).map(({ ticker }) => ticker)
  return { coverage, missing, scope: missing.length === 0 ? Scope.Requested : Scope.Diagnostic }
}

export const targetsAtClose = (days: readonly Frame[], known: number, scope: Scope) => {
  const tickers = universe(scope)
  const weight = new Map<Ticker, number>()
  if (known >= protocol.trendSessions) {
    const close = (ticker: Ticker, i: number) => prices(days[i], ticker).close
    const commodityRatio = (i: number) => close(Ticker.DBC, i) / close(Ticker.SHY, i)
    const hot = commodityRatio(known) > commodityRatio(known - protocol.regimeSessions)
    const allocate = (group: readonly Ticker[], budget: number) => {
      const rising = group.filter((ticker) => close(ticker, known) > close(ticker, known - protocol.trendSessions))
      for (const ticker of rising) weight.set(ticker, budget / rising.length)
    }
    allocate(metals, protocol.preciousWeight)
    allocate(hot ? cyclical : scope === Scope.Requested ? [Ticker.TIP] : [], 1 - protocol.preciousWeight)
  }
  weight.set(Ticker.SHY, 1 - sum([...weight.values()]))
  return tickers.map((ticker) => weight.get(ticker) ?? 0)
}

const grossNotional = (quantities: readonly number[], marks: readonly number[]) =>
  sum(quantities.map((quantity, i) => Math.abs(quantity) * marks[i]))

export const clearAtOpen = (
  shares: readonly number[],
  cash: number,
  orders: readonly number[],
  open: readonly number[],
  oneWayBps: Cost,
) => {
  const rate = oneWayBps / 10_000
  const sale = grossNotional(
    orders.map((quantity) => Math.min(quantity, 0)),
    open,
  )
  const wantedBuy = grossNotional(
    orders.map((quantity) => Math.max(quantity, 0)),
    open,
  )
  const funds = cash + sale * (1 - rate)
  const buy = Math.min(wantedBuy, funds / (1 + rate))
  const fill = wantedBuy > 0 ? buy / wantedBuy : 1
  return {
    shares: shares.map((quantity, i) => quantity + (orders[i] > 0 ? orders[i] * fill : orders[i])),
    cash: funds - Math.min(funds, wantedBuy * (1 + rate)),
    traded: sale + buy,
    cost: (sale + buy) * rate,
  }
}

export const replay = (days: readonly Frame[], scope: Scope, oneWayBps: Cost) => {
  requireAlignedSessions(days)
  const tickers = universe(scope)
  const snapshots = days.map((day) => tickers.map((ticker) => prices(day, ticker)))
  let shares = tickers.map(() => 0)
  let cash = 1
  let nav = 1
  return days.slice(1).map(({ date }, j) => {
    const prior = snapshots[j].map(({ close }) => close)
    const target = targetsAtClose(days, j, scope)
    const orders = shares.map((quantity, i) => (target[i] * nav) / prior[i] - quantity)
    const purchases = grossNotional(
      orders.map((quantity) => Math.max(quantity, 0)),
      prior,
    )
    const sales = grossNotional(
      orders.map((quantity) => Math.min(quantity, 0)),
      prior,
    )
    const trade = Math.max(purchases, sales) >= protocol.deadband * nav

    // Even the share requests are fixed at the preceding close. Only the
    // clearing price and the cash-constrained pro-rata buy fill use the open.
    const next = snapshots[j + 1]
    const open = next.map((bar) => bar.open)
    const fill = trade ? clearAtOpen(shares, cash, orders, open, oneWayBps) : { shares, cash, traded: 0, cost: 0 }
    const closing = fill.cash + sum(fill.shares.map((quantity, i) => quantity * next[i].close))
    if (!Number.isFinite(closing) || closing <= 0 || fill.shares.some((quantity) => quantity < 0))
      throw new Error(`Invalid sleeve balance on ${date}`)
    const row = { date, net: closing / nav - 1, turnover: fill.traded / nav, cost: fill.cost / nav }
    ;({ shares, cash } = fill)
    nav = closing
    return row
  })
}

export const returns = (rows: readonly DailyReturn[]) => rows.map(({ net }) => net)
export const returnsFor = (days: readonly Frame[], ticker: Ticker) =>
  days.slice(1).map((day, i) => ({
    date: day.date,
    net: prices(day, ticker).close / prices(days[i], ticker).close - 1,
  }))

const validReturns = (values: readonly number[]) => {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= -1))
    throw new Error('Missing, invalid or insolvent daily return path')
  return values
}

export const performance = (rows: readonly DailyReturn[]) => {
  const values = validReturns(returns(rows))
  const nav = wealth(values, true)
  const cagr = nav ** (252 / values.length) - 1
  const maxDD = maxDrawdown(values, true)
  return { net: nav - 1, cagr, sharpe: sharpe(values), maxDrawdown: maxDD, calmar: calmar(cagr, maxDD) }
}

const sleeveIds = ['B0', 'F4', 'O1'] as const
type ControlPaths = Readonly<Record<(typeof sleeveIds)[number], readonly DailyReturn[]>>

export const blend = (controls: ControlPaths, addition: readonly DailyReturn[] | null, oneWayBps: Cost) => {
  const legs = sleeveIds.map((id) => controls[id])
  const addedWeight = addition === null ? 0 : protocol.sleeveWeight
  const weight = (1 - addedWeight) / legs.length
  const weights = [...legs.map(() => weight), addedWeight]
  requireAlignedSessions(controls.B0, ...legs, ...(addition === null ? [] : [addition]))
  for (const leg of [...legs, ...(addition === null ? [] : [addition])]) validReturns(returns(leg))
  let before = weights
  return controls.B0.map(({ date }, i) => {
    const changes = [...legs.map((leg) => weight * leg[i].net), addition === null ? 0 : addedWeight * addition[i].net]
    const resetCost = (sum(weights.map((target, k) => Math.abs(target - before[k]))) * oneWayBps) / 10_000
    const gross = 1 + sum(changes)
    before = weights.map((target, k) => (target + changes[k]) / gross)
    const [B0, F4, O1, sleeve] = changes.map((change) => (1 - resetCost) * change)
    return { date, net: B0 + F4 + O1 + sleeve - resetCost, B0, F4, O1, sleeve, resetCost }
  })
}

export const attribution = (rows: ReturnType<typeof blend>) => ({
  B0: 10_000 * mean(rows.map((row) => row.B0)),
  F4: 10_000 * mean(rows.map((row) => row.F4)),
  O1: 10_000 * mean(rows.map((row) => row.O1)),
  sleeve: 10_000 * mean(rows.map((row) => row.sleeve)),
  resetCost: -10_000 * mean(rows.map((row) => row.resetCost)),
  net: 10_000 * mean(returns(rows)),
})

export const stressFlags = (days: readonly Frame[]) => {
  const equity = days.map((day) => prices(day, Ticker.SPY).close)
  const rates = days.map((day) => prices(day, Ticker.IEF).close)
  const stress = (closes: readonly number[], known: number, threshold: number) => {
    const first = known + 1 - protocol.stressLookbackSessions
    return first >= 0 && closes[known] / Math.max(...closes.slice(first, known + 1)) <= 1 - threshold
  }
  return days.slice(1).map(({ date }, known) => ({
    date,
    equity: stress(equity, known, protocol.equityDrawdown),
    rates: stress(rates, known, protocol.ratesDrawdown),
  }))
}

export const drawdownReturns = (
  sleeve: readonly DailyReturn[],
  shy: readonly DailyReturn[],
  stress: ReturnType<typeof stressFlags>,
) => {
  requireAlignedSessions(sleeve, shy, stress)
  const conditional = (select: (row: (typeof stress)[number]) => boolean) => {
    const indices = stress.flatMap((row, i) => (select(row) ? [i] : []))
    return {
      sessions: indices.length,
      meanSleeveBps: indices.length === 0 ? null : 10_000 * mean(indices.map((i) => sleeve[i].net)),
      meanExcessShyBps: indices.length === 0 ? null : 10_000 * mean(indices.map((i) => sleeve[i].net - shy[i].net)),
    }
  }
  return {
    equity: conditional((row) => row.equity),
    rates: conditional((row) => row.rates),
    joint: conditional((row) => row.equity && row.rates),
  }
}

export const pairedSharpeLower = (
  candidate: readonly DailyReturn[],
  reference: readonly DailyReturn[],
  plan: StationaryPlan,
) => {
  requireAlignedSessions(candidate, reference)
  if (candidate.length !== plan.sessions) throw new Error('Bootstrap session count mismatch')
  const a = validReturns(returns(candidate))
  const b = validReturns(returns(reference))
  const left = a.slice()
  const right = b.slice()
  const draws: number[] = []
  for (let draw = 0; draw < plan.draws; draw++) {
    let i = 0
    for (let block = plan.offsets[draw]; block < plan.offsets[draw + 1]; block += 2) {
      for (let j = plan.blocks[block]; j < plan.blocks[block + 1]; j++, i++) {
        left[i] = a[j % a.length]
        right[i] = b[j % b.length]
      }
    }
    const delta = pairedSharpeDiff(left, right)
    if (delta === null) return null
    draws.push(delta)
  }
  draws.sort((x, y) => x - y)
  return draws[Math.ceil(protocol.bootstrapLowerTail * draws.length) - 1]
}

interface Gates {
  readonly positiveExcess: boolean
  readonly positiveStress: boolean
  readonly orthogonal: boolean
  readonly portfolio: boolean
}

export const decide = (scope: Scope, gates: Gates) =>
  scope === Scope.Requested && gates.positiveExcess && gates.positiveStress && gates.orthogonal && gates.portfolio
    ? Verdict.Promote
    : Verdict.DoNotPromote
