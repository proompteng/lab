import { Data, Redacted, Result, Schema } from 'effect'

import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  strictParseOptions,
  UnitIntervalSchema,
} from '../src/schemas'
import { elapsedDays, requireAlignedSessions } from './research-lib/calendar'
import { calmar, mean, sharpe, sortino, sum } from './research-lib/statistics'
import { pearson } from './research-orb-zab-statistics'

export enum Sleeve {
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
  SHY = 'SHY',
}

export enum Account {
  LiveMain = 'live-main',
  PaperMain = 'paper-main',
  PaperSmall = 'paper-small-account',
}

export enum Allocation {
  Static = 'static',
  InverseVol = 'inverse-vol',
  DrawdownGoverned = 'drawdown-governed',
}

const SleeveSchema = Schema.Enum(Sleeve)
const AccountSchema = Schema.Enum(Account)
const AllocationSchema = Schema.Enum(Allocation)
const sleeves = Object.values(SleeveSchema.enums)
const risky = [Sleeve.B0, Sleeve.F4, Sleeve.O1] as const
const rebalanceCostsBps = [0, 2, 5] as const
const pdtWindowSessions = 5

const DailyReturn = {
  date: IsoDateSchema,
  netReturn: Schema.Finite.check(Schema.isGreaterThan(-1)),
}
const ReturnSeries = Schema.Struct({ sourceSha256: Sha256Schema, sessions: Schema.Array(Schema.Struct(DailyReturn)) })
const EvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-sleeve-return-series.v1'),
  calendar: Schema.Struct({
    sourceSha256: Sha256Schema,
    sessions: Schema.Array(Schema.Struct({ date: IsoDateSchema })).check(Schema.isMinLength(1)),
  }),
  sleeves: Schema.Struct({
    [Sleeve.B0]: Schema.Struct({
      sourceSha256: Sha256Schema,
      sessions: Schema.Array(Schema.Struct({ ...DailyReturn, dayTradeCount: NonNegativeIntegerSchema })),
    }),
    [Sleeve.F4]: ReturnSeries,
    [Sleeve.O1]: ReturnSeries,
    [Sleeve.SHY]: ReturnSeries,
  }),
})

const ScenarioSchema = Schema.Struct({
  weights: Schema.Record(SleeveSchema, UnitIntervalSchema),
  startingEquityUsd: Schema.Record(AccountSchema, PositiveFiniteSchema),
  lookbackSessions: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 252 })),
  correlationThreshold: UnitIntervalSchema,
  tailFraction: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0.5)),
  pdtMaxDayTrades: NonNegativeIntegerSchema,
  b0DayTradeReservation: PositiveIntegerSchema,
  drawdown: Schema.Struct({
    throttleAt: UnitIntervalSchema,
    throttleScale: UnitIntervalSchema,
    severeAt: UnitIntervalSchema,
    severeScale: UnitIntervalSchema,
  }),
})

type Evidence = typeof EvidenceSchema.Type
type Scenario = typeof ScenarioSchema.Type
type Weights = Scenario['weights']

export const defaultScenario: Scenario = {
  weights: { B0: 0.3, F4: 0.3, O1: 0.3, SHY: 0.1 },
  startingEquityUsd: { [Account.LiveMain]: 100_000, [Account.PaperMain]: 100_000, [Account.PaperSmall]: 10_000 },
  lookbackSessions: 20,
  correlationThreshold: 0.75,
  tailFraction: 0.05,
  pdtMaxDayTrades: 3,
  b0DayTradeReservation: 2,
  drawdown: { throttleAt: 0.05, throttleScale: 0.5, severeAt: 0.1, severeScale: 0.25 },
}

class PortfolioSimulationError extends Data.TaggedError('PortfolioSimulationError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const decodeEvidence = Schema.decodeUnknownResult(EvidenceSchema, strictParseOptions)
const decodeScenario = Schema.decodeUnknownResult(ScenarioSchema, strictParseOptions)
const invalid = (message: string) => Result.fail(new PortfolioSimulationError({ message }))

export const decodePortfolioEvidence = (input: unknown) =>
  decodeEvidence(input).pipe(
    Result.mapError(
      (cause) =>
        new PortfolioSimulationError({
          message: 'Invalid portfolio return-series schema',
          cause: Redacted.make(cause),
        }),
    ),
    Result.flatMap((evidence) =>
      Result.try({
        try: () => {
          requireAlignedSessions(
            evidence.calendar.sessions,
            ...sleeves.map((sleeve) => evidence.sleeves[sleeve].sessions),
          )
          return evidence
        },
        catch: (cause) =>
          new PortfolioSimulationError({
            message: 'Return series must match the complete, strictly increasing session calendar',
            cause: Redacted.make(cause),
          }),
      }),
    ),
  )

export const decodePortfolioScenario = (input: unknown) =>
  decodeScenario(input).pipe(
    Result.mapError(
      (cause) =>
        new PortfolioSimulationError({ message: 'Invalid portfolio scenario schema', cause: Redacted.make(cause) }),
    ),
    Result.flatMap((scenario) => {
      const { weights, drawdown } = scenario
      if (Math.abs(sum(sleeves.map((sleeve) => weights[sleeve])) - 1) > 1e-12)
        return invalid('Portfolio weights must sum to one')
      if (
        drawdown.throttleAt <= 0 ||
        drawdown.throttleAt >= drawdown.severeAt ||
        drawdown.severeAt >= 1 ||
        drawdown.severeScale >= drawdown.throttleScale ||
        drawdown.throttleScale >= 1
      )
        return invalid('Drawdown thresholds must increase and risk scales must strictly decrease below one')
      return Result.succeed(scenario)
    }),
  )

const bySleeve = (f: (sleeve: Sleeve) => number) => ({
  B0: f(Sleeve.B0),
  F4: f(Sleeve.F4),
  O1: f(Sleeve.O1),
  SHY: f(Sleeve.SHY),
})
const sessionRows = (evidence: Evidence) =>
  evidence.calendar.sessions.map(({ date }, i) => ({
    date,
    returns: bySleeve((sleeve) => evidence.sleeves[sleeve].sessions[i].netReturn),
    dayTradeCount: evidence.sleeves.B0.sessions[i].dayTradeCount,
  }))
type Session = ReturnType<typeof sessionRows>[number]

const magnitude = (values: readonly number[]) => values.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
const flat = (values: readonly number[]) => values.every((value) => value === values[0])
const volatility = (values: readonly number[]) => {
  if (flat(values)) return 0
  const scale = magnitude(values)
  const scaled = values.map((value) => value / scale)
  const center = mean(scaled)
  return scale * Math.sqrt(mean(scaled.map((value) => (value - center) ** 2)))
}

const cashResidual = (positions: Weights): Weights => ({
  ...positions,
  SHY: Math.max(0, 1 - sum(risky.map((sleeve) => positions[sleeve]))),
})

const inverseVolWeights = (history: readonly Session[], budget: Weights): Weights => {
  const vol = bySleeve((sleeve) => (sleeve === Sleeve.SHY ? 0 : volatility(history.map((row) => row.returns[sleeve]))))
  const eligible = risky.filter((sleeve) => budget[sleeve] > 0 && vol[sleeve] > 0)
  const minVol = Math.min(...eligible.map((sleeve) => vol[sleeve]))
  const scale = bySleeve((sleeve) =>
    eligible.some((item) => item === sleeve) ? budget[sleeve] * (minVol / vol[sleeve]) : 0,
  )
  const total = sum(risky.map((sleeve) => scale[sleeve]))
  const riskBudget = sum(eligible.map((sleeve) => budget[sleeve]))
  // A verified flat sleeve has no estimable inverse volatility. Its budget stays in SHY.
  return cashResidual(bySleeve((sleeve) => (total > 0 ? (scale[sleeve] / total) * riskBudget : 0)))
}

const correlation = (a: readonly number[], b: readonly number[]) => {
  if (flat(a) || flat(b)) return null
  const scaleA = magnitude(a)
  const scaleB = magnitude(b)
  const coefficient = pearson(
    a.map((value) => value / scaleA),
    b.map((value) => value / scaleB),
  )
  return coefficient === null ? null : Math.max(-1, Math.min(1, coefficient))
}

const describeDependence = (all: readonly Session[], scored: readonly Session[], scenario: Scenario) => {
  const { lookbackSessions, correlationThreshold, tailFraction } = scenario
  const histories = scored.map((_, i) => all.slice(i + 1, i + 1 + lookbackSessions))
  const tailCutoffs = bySleeve((sleeve) => {
    const sorted = scored.map(({ returns }) => returns[sleeve]).sort((a, b) => a - b)
    return sorted[Math.ceil(sorted.length * tailFraction) - 1]
  })
  const inTail = (row: Session, sleeve: Sleeve) => row.returns[sleeve] < 0 && row.returns[sleeve] <= tailCutoffs[sleeve]
  const riskSpikeDates = new Set<string>()
  const pairs = sleeves.flatMap((left, index) =>
    sleeves.slice(index + 1).map((right) => {
      const correlate = (rows: readonly Session[]) =>
        correlation(
          rows.map((row) => row.returns[left]),
          rows.map((row) => row.returns[right]),
        )
      const spikeDates: string[] = []
      let definedWindows = 0
      let peak: { readonly date: string; readonly correlation: number } | null = null
      for (const [i, history] of histories.entries()) {
        const value = correlate(history)
        if (value === null) continue
        definedWindows++
        const { date } = scored[i]
        if (peak === null || value > peak.correlation) peak = { date, correlation: value }
        if (value >= correlationThreshold) {
          spikeDates.push(date)
          if (left !== Sleeve.SHY && right !== Sleeve.SHY) riskSpikeDates.add(date)
        }
      }
      return {
        sleeves: [left, right],
        correlation: correlate(scored),
        rolling: { definedWindows, peak, spikeDates },
        tailCoDrawdownDates: scored.filter((row) => inTail(row, left) && inTail(row, right)).map(({ date }) => date),
      }
    }),
  )
  return {
    pairs,
    tailCutoffs,
    riskSpikeDates: [...riskSpikeDates].sort(),
    allRiskTailDates: scored.filter((row) => risky.every((sleeve) => inTail(row, sleeve))).map(({ date }) => date),
  }
}

const riskScale = (drawdown: number, scenario: Scenario['drawdown']) =>
  drawdown >= scenario.severeAt ? scenario.severeScale : drawdown >= scenario.throttleAt ? scenario.throttleScale : 1

interface Day {
  readonly date: string
  readonly weights: Weights
  readonly riskScale: number
  readonly netReturn: number
  readonly equityUsd: number
  readonly turnover: number
  readonly dragUsd: number
  readonly pdtBlocked: boolean
  readonly dayTradesExecuted: number
  readonly dayTradesBlocked: number
  readonly rollingDayTrades: number
}

const replay = (
  scored: readonly Session[],
  inverse: readonly Weights[],
  scenario: Scenario,
  account: Account,
  allocation: Allocation,
  rebalanceBps: (typeof rebalanceCostsBps)[number],
  years: number,
) => {
  const startingEquityUsd = scenario.startingEquityUsd[account]
  const limit = account === Account.PaperSmall ? scenario.pdtMaxDayTrades : null
  const daily: Day[] = []
  let nav = 1
  let peak = 1
  let drawdown = 0
  let maxDrawdown = 0
  let marked: Weights = { B0: 0, F4: 0, O1: 0, SHY: 1 }
  let rollingDayTrades = 0

  for (const [i, row] of scored.entries()) {
    const base = allocation === Allocation.Static ? scenario.weights : inverse[i]
    const scale = allocation === Allocation.DrawdownGoverned ? riskScale(drawdown, scenario.drawdown) : 1
    rollingDayTrades -= daily[i - pdtWindowSessions]?.dayTradesExecuted ?? 0
    // Reserve before seeing the session's realized count or P&L. A partial B0 batch has no supported return.
    const hasB0 = base.B0 * scale > 0
    const pdtBlocked = hasB0 && limit !== null && limit - rollingDayTrades < scenario.b0DayTradeReservation
    const dayTradesExecuted = hasB0 && !pdtBlocked ? row.dayTradeCount : 0
    rollingDayTrades += dayTradesExecuted
    const weights = cashResidual(bySleeve((sleeve) => (sleeve === Sleeve.B0 && pdtBlocked ? 0 : base[sleeve] * scale)))
    const turnover = sum(sleeves.map((sleeve) => Math.abs(marked[sleeve] - weights[sleeve]))) / 2
    const drag = (turnover * rebalanceBps) / 10_000
    const dragUsd = nav * startingEquityUsd * drag
    const grossReturn = sum(sleeves.map((sleeve) => weights[sleeve] * row.returns[sleeve]))
    const netReturn = grossReturn - drag * (1 + grossReturn)
    nav *= 1 + netReturn
    const equityUsd = nav * startingEquityUsd
    if (!(equityUsd > 0 && Number.isFinite(equityUsd) && Number.isSafeInteger(rollingDayTrades)))
      return invalid(`Unrepresentable portfolio path at ${row.date}`)
    peak = Math.max(peak, nav)
    drawdown = 1 - nav / peak
    maxDrawdown = Math.max(maxDrawdown, drawdown)
    marked = bySleeve((sleeve) => (weights[sleeve] * (1 + row.returns[sleeve])) / (1 + grossReturn))
    daily.push({
      date: row.date,
      weights,
      riskScale: scale,
      netReturn,
      equityUsd,
      turnover,
      dragUsd,
      pdtBlocked,
      dayTradesExecuted,
      dayTradesBlocked: pdtBlocked ? row.dayTradeCount : 0,
      rollingDayTrades,
    })
  }

  const returns = daily.map((day) => day.netReturn)
  const scale = magnitude(returns)
  const ratioReturns = scale > 0 ? returns.map((value) => value / scale) : returns
  const cagr = Math.expm1(Math.log(nav) / years)
  const metrics = {
    cagr,
    sharpe: sharpe(ratioReturns),
    sortino: sortino(ratioReturns),
    calmar: calmar(cagr, maxDrawdown),
    maxDrawdown,
  }
  const peakRollingDayTrades = daily.reduce((max, day) => Math.max(max, day.rollingDayTrades), 0)
  const totalDragUsd = sum(daily.map((day) => day.dragUsd))
  if (
    !Number.isFinite(totalDragUsd) ||
    Object.values(metrics).some((value) => value !== null && !Number.isFinite(value))
  )
    return invalid('Unrepresentable portfolio performance statistics')
  const executedDayTrades = sum(daily.map((day) => day.dayTradesExecuted))
  const blockedDayTrades = sum(daily.map((day) => day.dayTradesBlocked))
  if (!Number.isSafeInteger(executedDayTrades) || !Number.isSafeInteger(blockedDayTrades))
    return invalid('Unrepresentable portfolio trade count totals')
  return Result.succeed({
    account,
    allocation,
    rebalanceBps,
    startingEquityUsd,
    endingEquityUsd: nav * startingEquityUsd,
    metrics,
    meanWeights: bySleeve((sleeve) => mean(daily.map(({ weights }) => weights[sleeve]))),
    totalTurnover: sum(daily.map((day) => day.turnover)),
    totalDragUsd,
    throttledSessions: daily.filter((day) => day.riskScale === scenario.drawdown.throttleScale).length,
    severeSessions: daily.filter((day) => day.riskScale === scenario.drawdown.severeScale).length,
    pdt: {
      windowSessions: pdtWindowSessions,
      limit,
      peakRollingDayTrades,
      peakUtilization: limit === null || limit === 0 ? null : peakRollingDayTrades / limit,
      executedDayTrades,
      blockedDayTrades,
      blockedSessions: daily.filter((day) => day.pdtBlocked).length,
    },
    daily,
  })
}

type Run = Result.Result.Success<ReturnType<typeof replay>>

const worstReturnOn = (daily: readonly Day[], dates: ReadonlySet<string>) =>
  daily.reduce<number | null>((worst, day) => {
    if (!dates.has(day.date)) return worst
    return worst === null ? day.netReturn : Math.min(worst, day.netReturn)
  }, null)

export const simulatePortfolio = (evidence: Evidence, scenario: Scenario) => {
  const all = sessionRows(evidence)
  const { lookbackSessions, b0DayTradeReservation } = scenario
  const scored = all.slice(lookbackSessions)
  if (scored.length < 2) return invalid('Evidence needs a full lookback plus at least two scored sessions')
  for (const row of all) {
    if (row.dayTradeCount > b0DayTradeReservation)
      return invalid(`B0 trade count exceeds the pre-session reservation at ${row.date}`)
    if (row.dayTradeCount === 0 && row.returns.B0 !== 0)
      return invalid(`B0 trading return is nonzero without a day trade at ${row.date}`)
  }

  const warmupThrough = all[lookbackSessions - 1].date
  const through = scored[scored.length - 1].date
  const years = elapsedDays(warmupThrough, through) / 365.2425
  const inverse = scored.map((_, i) => inverseVolWeights(all.slice(i, i + lookbackSessions), scenario.weights))
  const dependence = describeDependence(all, scored, scenario)
  const spikes = new Set(dependence.riskSpikeDates)
  const tails = new Set(dependence.allRiskTailDates)
  const runs: (Run & { readonly worstSpikeReturn: number | null; readonly worstCoDrawdownReturn: number | null })[] = []
  for (const account of Object.values(AccountSchema.enums)) {
    for (const allocation of Object.values(AllocationSchema.enums)) {
      for (const bps of rebalanceCostsBps) {
        const result = replay(scored, inverse, scenario, account, allocation, bps, years)
        if (Result.isFailure(result)) return Result.fail(result.failure)
        const run = result.success
        runs.push({
          ...run,
          worstSpikeReturn: worstReturnOn(run.daily, spikes),
          worstCoDrawdownReturn: worstReturnOn(run.daily, tails),
        })
      }
    }
  }
  return Result.succeed({
    schemaVersion: 'bayn.multi-sleeve-portfolio-simulation.v1',
    scenario,
    sourceReceipts: {
      calendar: evidence.calendar.sourceSha256,
      B0: evidence.sleeves.B0.sourceSha256,
      F4: evidence.sleeves.F4.sourceSha256,
      O1: evidence.sleeves.O1.sourceSha256,
      SHY: evidence.sleeves.SHY.sourceSha256,
    },
    coverage: { warmupFrom: all[0].date, warmupThrough, from: scored[0].date, through, sessions: scored.length },
    dependence,
    runs,
  })
}
