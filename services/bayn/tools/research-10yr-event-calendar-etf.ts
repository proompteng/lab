import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Console, Data, Effect, Redacted, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { splits, type Day as MinuteSession } from './noise-area-study-replay'
import { blend } from './orthogonal-pillar3-metrics'
import { receipts } from './pure-etf-dual-horizon-data'
import { pearson } from './research-orb-zab-statistics'
import { elapsedDays, foldBounds, requireAlignedSessions } from './research-lib/calendar'
import {
  calmar,
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  maxDrawdown,
  mean,
  pairedSharpeDiff,
  sharpe,
  sortino,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
  wealth,
} from './research-lib/statistics'
import {
  calendarEvents,
  cancelledStatement,
  expectedCalendar,
  scheduledStatements,
} from './research/event-calendar-etf-calendar'
import { type Control, controlIds, controls, prepareControls } from './research/event-calendar-etf-controls'
import {
  annualVol,
  breakevenBps,
  candidate,
  type DailyReturn,
  formWindows,
  regularSessionOverlap,
  replay,
  risk,
  sellFeeBps,
  TrialSchema,
  trials,
} from './research/event-calendar-etf-replay'
import { type DailyFrame, loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'

const costs = [0, 2, 5, 10] as const
const bootstrap = { draws: 10_000, meanBlock: 10, seed: 0x18c2026 } as const
const allocation = 0.25
const thresholds = { sharpe: 0.75, dsr: 0.95, p: 0.05, maxAbsCorrelation: 0.25, positiveYears: 7 } as const
const fullYears = Array.from({ length: 10 }, (_, i) => String(2016 + i))
const years = [...fullYears, '2026']
const first = splits.train.first
const last = splits.holdout.last
const periods = ['train', 'validation', 'holdout'] as const

enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

const identity = Schema.encodeSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.wave18c.event-calendar-etf.v1'),
    verdict: Schema.Enum(Verdict),
    trials: Schema.Array(TrialSchema),
  }),
)

class StudyError extends Data.TaggedError('CalendarEtfStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

export const performance = (days: readonly DailyReturn[]) => {
  const values = days.map(({ net }) => net)
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= -1))
    throw new Error('Missing or insolvent daily return path')
  const nav = wealth(values, true)
  const span = (elapsedDays(days[0].date, days[days.length - 1].date) + 1) / 365.2425
  const cagr = nav ** (1 / span) - 1
  const maxDD = maxDrawdown(values, true)
  return {
    netReturn: nav - 1,
    cagr,
    annualizedVolatility: annualVol(values),
    sharpe: sharpe(values),
    sortino: sortino(values),
    calmar: calmar(cagr, maxDD),
    maxDrawdown: maxDD,
    annualOneWayTurnover: mean(days.map(({ turnover }) => turnover)) * 252,
  }
}

export const tradeStatistics = (closedPnl: readonly number[]) => {
  const wins = closedPnl.filter((pnl) => pnl > 0)
  const losses = -sum(closedPnl.filter((pnl) => pnl < 0))
  return {
    tradeCount: closedPnl.length,
    winRate: closedPnl.length > 0 ? wins.length / closedPnl.length : null,
    profitFactor: losses > 0 ? sum(wins) / losses : null,
  }
}

const yearlyReturns = (days: readonly DailyReturn[]) =>
  Object.fromEntries(
    years.map((year) => [
      year,
      wealth(
        days.filter(({ date }) => date.startsWith(year)).map(({ net }) => net),
        true,
      ) - 1,
    ]),
  )
const returns = (days: readonly DailyReturn[]) => days.map(({ net }) => net)
const atLeast = (value: number | null, floor: number) => value !== null && value >= floor
const below = (value: number | null, ceiling: number) => value !== null && value < ceiling
const positive = (value: number | null) => value !== null && value > 0
const norm = (value: number | null) => (value === null ? null : Math.abs(value))

type Correlations = Record<string, number | null>
export const gates = (input: {
  readonly fullSharpe: number | null
  readonly holdoutSharpe: number | null
  readonly holdoutDsr: number | null
  readonly holdoutP: number | null
  readonly splitReturns: readonly number[]
  readonly positiveYears: number
  readonly overlapMinutes: number
  readonly fullCorrelation: Correlations
  readonly holdoutCorrelation: Correlations
  readonly additive: readonly {
    readonly fullSharpeLift: number | null
    readonly sharpeLift: number | null
    readonly holdoutNetLift: number
    readonly pIncrementalMean: number | null
  }[]
}) => ({
  netSharpe: atLeast(input.fullSharpe, thresholds.sharpe) && atLeast(input.holdoutSharpe, thresholds.sharpe),
  inference: atLeast(input.holdoutDsr, thresholds.dsr) && below(input.holdoutP, thresholds.p),
  stability:
    input.splitReturns.length === periods.length &&
    input.splitReturns.every((net) => net > 0) &&
    input.positiveYears >= thresholds.positiveYears,
  zeroRegularSessionOverlap: input.overlapMinutes === 0,
  lowCorrelation: [input.fullCorrelation, input.holdoutCorrelation].every((row) =>
    controls.every((id) => below(norm(row[id] ?? null), thresholds.maxAbsCorrelation)),
  ),
  additive:
    input.additive.length === 3 &&
    input.additive.every(
      ({ fullSharpeLift, sharpeLift, holdoutNetLift, pIncrementalMean }) =>
        positive(fullSharpeLift) && positive(sharpeLift) && holdoutNetLift > 0 && below(pIncrementalMean, thresholds.p),
    ),
})

const study = (daily: readonly DailyFrame[], intraday: readonly MinuteSession[]) => {
  requireAlignedSessions(expectedCalendar(first, last), daily, intraday)
  const scored = daily.slice(1)
  const dates = scored.map(({ date }) => date)
  const fold = (key: (typeof periods)[number]) => {
    const split = splits[key]
    return foldBounds(
      dates,
      key === 'train' ? dates[0] : split.first,
      split.last,
      split.count - Number(key === 'train'),
    )
  }
  const folds = { train: fold('train'), validation: fold('validation'), holdout: fold('holdout') }
  const { first: holdoutStart, end: holdoutEnd } = folds.holdout
  const holdout = <A>(list: readonly A[]): readonly A[] => list.slice(holdoutStart, holdoutEnd)
  const development = <A>(list: readonly A[]) => list.slice(0, holdoutStart)
  const fullPlan = stationaryBootstrap(dates.length, bootstrap)
  const holdoutPlan = stationaryBootstrap(holdoutEnd - holdoutStart, bootstrap)
  const control = prepareControls(daily, intraday)
  const makeWindows = formWindows(daily, intraday)
  const registered = trials.map((trial) => {
    const windows = makeWindows(trial)
    return {
      id: trial.id,
      windows,
      breakevenRoundTripBps: breakevenBps(windows),
      overlapMinutes: regularSessionOverlap(daily, windows),
    }
  })
  const candidateIndex = trials.findIndex(({ id }) => id === candidate.id)
  const byCost = costs.map((bp) => {
    const paths = registered.map(({ windows }) => replay(daily, windows, bp).slice(1))
    const nullSharpe = expectedMaximumSharpe(
      paths.map((path) => dailySharpe(returns(development(path))) ?? 0),
      trials.length,
    )
    const baseline = control.at(bp)
    const controlPaths = (id: Control) => baseline[id].slice(1)
    const baselines = controls.map((id) => [id, returns(controlPaths(id))] as const)
    const reference = (values: readonly number[], subset: typeof holdout) =>
      Object.fromEntries(baselines.map(([id, benchmark]) => [id, pearson(subset(values), subset(benchmark))]))
    const matrix = (subset: typeof holdout) => {
      const axes = [[candidate.id, returns(paths[candidateIndex])] as const, ...baselines]
      return Object.fromEntries(
        axes.map(([id, values]) => [
          id,
          Object.fromEntries(axes.map(([benchmark, paired]) => [benchmark, pearson(subset(values), subset(paired))])),
        ]),
      )
    }
    const same = <A>(list: readonly A[]) => list
    const summaries = Object.fromEntries(
      registered.map(({ id }, i) => {
        const path = paths[i]
        const net = returns(path)
        const summarize = (rows: Readonly<typeof path>) => ({
          ...performance(rows),
          ...tradeStatistics(rows.flatMap(({ closedPnl }) => closedPnl)),
        })
        return [
          id,
          {
            full: {
              ...summarize(path),
              dsr: deflatedSharpe(net, nullSharpe),
              stationaryP: stationaryMeanP(net, fullPlan),
            },
            holdout: {
              ...summarize(holdout(path)),
              dsr: deflatedSharpe(holdout(net), nullSharpe),
              stationaryP: stationaryMeanP(holdout(net), holdoutPlan),
            },
            yearlyReturns: yearlyReturns(path),
            splitReturns: Object.fromEntries(
              periods.map((period) => [period, wealth(net.slice(folds[period].first, folds[period].end), true) - 1]),
            ),
            correlation: { full: reference(net, same), holdout: reference(net, holdout) },
            dailyPathSha256: sha256(JSON.stringify(path)),
          },
        ]
      }),
    )
    const withCarry = ({ net, turnover }: DailyReturn) => ({ net, turnover, borrow: 0 })
    const h4Path = paths[candidateIndex].map(withCarry)
    const additive = ([['F4'], ['O1'], ['F4', 'O1', 'B0']] as const).map((members) => {
      const legs = members.map((id) => controlPaths(id).map(withCarry))
      const baseNet = blend(
        legs,
        members.map(() => 1 / members.length),
        bp / 2,
      ).map(({ net }) => net)
      const combinedNet = blend(
        [...legs, h4Path],
        [...members.map(() => (1 - allocation) / members.length), allocation],
        bp / 2,
      ).map(({ net }) => net)
      const before = holdout(baseNet)
      const after = holdout(combinedNet)
      return {
        controls: members,
        fullSharpeLift: pairedSharpeDiff(combinedNet, baseNet),
        sharpeLift: pairedSharpeDiff(after, before),
        holdoutNetLift: wealth(after, true) - wealth(before, true),
        pIncrementalMean: stationaryMeanP(
          after.map((net, i) => net - before[i]),
          holdoutPlan,
        ),
      }
    })
    const primary = summaries[candidate.id]
    const decisions = gates({
      fullSharpe: primary.full.sharpe,
      holdoutSharpe: primary.holdout.sharpe,
      holdoutDsr: primary.holdout.dsr,
      holdoutP: primary.holdout.stationaryP,
      splitReturns: periods.map((period) => primary.splitReturns[period]),
      positiveYears: fullYears.filter((year) => primary.yearlyReturns[year] > 0).length,
      overlapMinutes: registered[candidateIndex].overlapMinutes,
      fullCorrelation: primary.correlation.full,
      holdoutCorrelation: primary.correlation.holdout,
      additive,
    })
    return {
      roundTripBps: bp,
      developmentNullDailySharpe: nullSharpe,
      trials: summaries,
      controls: Object.fromEntries(
        controls.map((id) => {
          const path = controlPaths(id)
          return [
            id,
            {
              full: performance(path),
              holdout: performance(holdout(path)),
              yearlyReturns: yearlyReturns(path),
              dailyPathSha256: sha256(JSON.stringify(path)),
            },
          ]
        }),
      ),
      correlationMatrix: { full: matrix(same), holdout: matrix(holdout) },
      additive,
      gates: decisions,
    }
  })
  const promote = byCost
    .filter(({ roundTripBps }) => roundTripBps > 0)
    .every(({ gates }) => Object.values(gates).every(Boolean))
  const signals = scored.map(({ date }) => calendarEvents(date))
  return {
    ...identity({
      schemaVersion: 'bayn.wave18c.event-calendar-etf.v1',
      verdict: promote ? Verdict.Promote : Verdict.DoNotPromote,
      trials,
    }),
    candidate: candidate.id,
    input: { receipts, first, last, sessions: daily.length, firstScored: dates[0], scoredSessions: dates.length },
    calendar: {
      scheduledStatements,
      cancelledStatement,
      eventSessions: {
        turn: signals.filter(({ turn }) => turn).length,
        fomc: signals.filter(({ fomc }) => fomc).length,
        holiday: signals.filter(({ holiday }) => holiday).length,
        union: signals.filter(({ turn, fomc, holiday }) => turn || fomc || holiday).length,
      },
    },
    controlIds,
    controlOracle: control.oracle,
    protocol: {
      splits,
      bootstrap,
      risk,
      sellFeeBps,
      allocation,
      thresholds,
      trialCount: trials.length,
      costEvaluations: trials.length * costs.length,
    },
    execution: registered.map(({ id, windows, overlapMinutes, breakevenRoundTripBps }) => ({
      id,
      windows: windows.length,
      regularSessionOverlapMinutes: overlapMinutes,
      breakevenRoundTripBps,
    })),
    byCost,
  }
}

const main = Effect.gen(function* () {
  const output = yield* Effect.try({
    try: () => {
      const { values } = parseArgs({ options: { output: { type: 'string' } } })
      if (values.output === undefined || values.output === '') throw new Error('Pass --output <new results.json path>')
      return values.output
    },
    catch: (cause) =>
      new StudyError({
        message: 'Usage: research-10yr-event-calendar-etf.ts --output <new path>',
        cause: Redacted.make(cause),
      }),
  })
  const daily = yield* loadFrozenDailyFrames
  const intraday = yield* withArchive(async (archive) => {
    const dev = await loadDevelopment(archive)
    const holdout = await loadHoldout(archive)
    return [...dev.days, ...holdout.days]
  }).pipe(Effect.timeout('5 minutes'))
  const results = yield* Effect.try({
    try: () => study(daily, intraday),
    catch: (cause) =>
      new StudyError({
        message: cause instanceof Error ? cause.message : 'Calendar study scoring failed',
        cause: Redacted.make(cause),
      }),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(results, null, 2) + '\n', { signal, flag: 'wx' }),
    catch: (cause) => new StudyError({ message: 'Unable to create new evidence output', cause: Redacted.make(cause) }),
  })
  yield* Console.log(
    `${results.verdict}: ${results.protocol.trialCount} trials on ${results.input.scoredSessions} scored sessions`,
  )
})

if (import.meta.main) NodeRuntime.runMain(main)
