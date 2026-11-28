import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted } from 'effect'

import type { Day } from './8yr-unseen-intraday-tape'
import { correlation } from './noise-area-study-statistics'
import { requireAlignedSessions } from './research-lib/calendar'
import { withS3Archive } from './research-lib/s3-archive'
import {
  calmar,
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  maxDrawdown,
  sharpe,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
  type StationaryPlan,
} from './research-lib/statistics'
import { loadFrozenDailyFrames, type DailyFrame } from './research/macro-etf-core-dual-horizon-data'
import { developmentSessions, holdoutSessions, loadIntraday } from './sector-etf-expansion-data'
import {
  baselineId,
  cap,
  capital,
  costs,
  gapTrials,
  type Ledger,
  lookback,
  noiseTrials,
  primaryCost,
  replay,
  sectors,
  symbols,
  warmup,
} from './sector-etf-expansion-replay'

const bootstrap = { draws: 10_000, meanBlock: 5, seed: 0x18d20261 } as const
const trainSessions = 1_511
const trialCount = noiseTrials.length + gapTrials.length
const alpha = 0.05 / (trialCount - 1)
const minimumActiveDays = 30
const minimumDsr = 0.95
const minimumPositiveYears = 2

export const netReturns = (rows: readonly Ledger[], bp: number) =>
  rows.some(({ unresolved }) => unresolved > 0) ? null : rows.map(({ base, slope }) => (base - bp * slope) / capital)

export const performance = (returns: readonly number[] | null) => {
  if (returns === null || returns.length === 0)
    return { netUsd: null, sharpe: null, maxDrawdown: null, calmar: null, exTop10Usd: null }
  const net = sum(returns)
  const drawdown = maxDrawdown(returns, false)
  const best = returns
    .filter((value) => value > 0)
    .toSorted((a, b) => b - a)
    .slice(0, 10)
  return {
    netUsd: net * capital,
    sharpe: sharpe(returns),
    maxDrawdown: drawdown,
    calmar: calmar((net * 252) / returns.length, drawdown),
    exTop10Usd: (net - sum(best)) * capital,
  }
}

const execution = (rows: readonly Ledger[], dates: readonly string[]) => {
  const unresolvedDates = dates.filter((_, i) => rows[i].unresolved > 0)
  const resolved = unresolvedDates.length === 0
  const known = rows
    .map(({ capacityUsd }) => capacityUsd)
    .filter((value) => value !== null)
    .sort((a, b) => a - b)
  const quantile = (p: number) => known[Math.ceil(p * known.length) - 1] ?? null
  const slope = sum(rows.map((row) => row.slope))
  return {
    activeDays: rows.filter(({ filled }) => filled > 0).length,
    filled: sum(rows.map((row) => row.filled)),
    missingEntryDates: dates.filter((_, i) => rows[i].missingEntries > 0),
    heldGapDates: dates.filter((_, i) => rows[i].heldGaps > 0),
    unresolvedDates,
    unavailableSignalDays: rows.filter(({ missingInputs }) => missingInputs > 0).length,
    maxObservedGrossBoundUsd: Math.max(0, ...rows.map((row) => row.grossBound)),
    turnover: resolved ? sum(rows.map((row) => row.turnover)) : null,
    breakevenRtBps: resolved && slope > 0 ? sum(rows.map((row) => row.base)) / slope : null,
    capacityP10Usd: resolved ? quantile(0.1) : null,
    capacityMedianUsd: resolved ? quantile(0.5) : null,
  }
}

const difference = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)
const executionDelta = (a: ReturnType<typeof execution>, b: ReturnType<typeof execution>) => ({
  turnover: difference(a.turnover, b.turnover),
  breakevenRtBps: difference(a.breakevenRtBps, b.breakevenRtBps),
  capacityP10Usd: difference(a.capacityP10Usd, b.capacityP10Usd),
  capacityMedianUsd: difference(a.capacityMedianUsd, b.capacityMedianUsd),
})

type Meter = { returns: ReturnType<typeof netReturns>; metrics: ReturnType<typeof performance> }
export const pairedMetrics = (a: Meter, b: Meter, plan?: StationaryPlan) => {
  const { returns } = a
  const other = b.returns
  if (returns !== null && other !== null && returns.length !== other.length) throw new Error('Unaligned paired window')
  const excess = returns === null || other === null ? null : returns.map((value, i) => value - other[i])
  return {
    netUsd: difference(a.metrics.netUsd, b.metrics.netUsd),
    sharpe: difference(a.metrics.sharpe, b.metrics.sharpe),
    maxDrawdown: difference(a.metrics.maxDrawdown, b.metrics.maxDrawdown),
    calmar: difference(a.metrics.calmar, b.metrics.calmar),
    correlation: returns === null || other === null ? null : correlation(returns, other).r,
    excessP: plan === undefined || excess === null ? null : stationaryMeanP(excess, plan),
  }
}

type Path = { readonly id: string; readonly priorId: string | null; readonly rows: readonly Ledger[] }
const range = (from: number, end: number) => Array.from({ length: end - from }, (_, i) => from + i)
const take = <T>(values: readonly T[], indices: readonly number[]) => indices.map((index) => values[index])
const resolved = (indices: readonly number[], paths: readonly Path[]) =>
  indices.filter((index) => paths.every(({ rows }) => rows[index].unresolved === 0))

const dsrReference = (dates: readonly string[], paths: readonly Path[], end: number) => {
  const full = range(0, end)
  const indices = resolved(full, paths)
  const matched = new Set(indices)
  return {
    through: dates[end - 1] ?? null,
    sessions: indices.length,
    excludedUnresolved: take(
      dates,
      full.filter((index) => !matched.has(index)),
    ),
    costs: costs.map((bp) => {
      const scores = paths.flatMap(({ rows }) => {
        const returns = netReturns(take(rows, indices), bp)
        const score = returns === null ? null : dailySharpe(returns)
        return score === null ? [] : [score]
      })
      return { bp, definedTrainSharpes: scores.length, benchmarkDaily: expectedMaximumSharpe(scores, trialCount) }
    }),
  }
}

const score = (
  dates: readonly string[],
  indices: readonly number[],
  paths: readonly Path[],
  reference: ReturnType<typeof dsrReference>,
) => {
  const windowDates = take(dates, indices)
  const plan = indices.length > 1 ? stationaryBootstrap(indices.length, bootstrap) : undefined
  const windows = new Map(
    paths.map(({ id, rows }) => {
      const samples = take(rows, indices)
      return [
        id,
        {
          execution: execution(samples, windowDates),
          meters: costs.map((bp) => {
            const returns = netReturns(samples, bp)
            return { returns, metrics: performance(returns) }
          }),
        },
      ]
    }),
  )
  const baseline = windows.get(baselineId)
  if (baseline === undefined) throw new Error('Missing B0 comparison on the aligned calendar')
  return Object.fromEntries(
    paths.map(({ id, priorId }) => {
      const current = windows.get(id)
      const prior = priorId === null ? undefined : windows.get(priorId)
      if (current === undefined || (priorId !== null && prior === undefined)) throw new Error(`Missing trial: ${id}`)
      return [
        id,
        {
          execution: current.execution,
          versusB0: id === baselineId ? null : executionDelta(current.execution, baseline.execution),
          versusPreviousRung: prior === undefined ? null : executionDelta(current.execution, prior.execution),
          costs: costs.map((bp, i) => {
            const meter = current.meters[i]
            const primary = bp === primaryCost ? plan : undefined
            return {
              bp,
              ...meter.metrics,
              dsr: meter.returns === null ? null : deflatedSharpe(meter.returns, reference.costs[i].benchmarkDaily),
              standaloneP:
                primary === undefined || meter.returns === null ? null : stationaryMeanP(meter.returns, primary),
              versusB0: pairedMetrics(meter, baseline.meters[i], id === baselineId ? undefined : primary),
              versusPreviousRung: prior === undefined ? null : pairedMetrics(meter, prior.meters[i], primary),
            }
          }),
        },
      ]
    }),
  )
}

const scoredWindow = (
  dates: readonly string[],
  paths: readonly Path[],
  from: number,
  end: number,
  reference: ReturnType<typeof dsrReference>,
) => {
  const indices = range(from, end)
  const matching = resolved(indices, paths)
  const matched = new Set(matching)
  return {
    from: dates[from],
    through: dates[end - 1],
    sessions: indices.length,
    dsrReference: reference,
    official: score(dates, indices, paths, reference),
    commonResolvedSensitivity:
      matching.length === indices.length
        ? null
        : {
            sessions: matching.length,
            excluded: take(
              dates,
              indices.filter((index) => !matched.has(index)),
            ),
            variants: score(dates, matching, paths, reference),
          },
  }
}

enum Recommendation {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

const positive = (value: number | null) => value !== null && value > 0
const primary = <T extends { readonly bp: number }>(rows: readonly T[]) => {
  const selected = rows.find(({ bp }) => bp === primaryCost)
  if (selected === undefined) throw new Error('Invalid primary-cost result')
  return selected
}

export const study = (days: readonly Day[], daily: readonly DailyFrame[]) => {
  requireAlignedSessions(days, daily)
  if (
    days.length !== developmentSessions + holdoutSessions ||
    days[trainSessions - 1]?.date !== '2021-12-31' ||
    days[trainSessions]?.date !== '2022-01-03' ||
    days[developmentSessions]?.date !== '2024-01-02'
  )
    throw new Error('Unregistered study calendar')
  const dates = days.map(({ date }) => date)
  const { noise, gap, elections } = replay(days, daily)
  const paths = [
    ...noise.map(({ spec, rows }) => ({ id: spec.id, priorId: spec.priorId, rows })),
    ...gap.map(({ spec, rows }) => ({ id: spec.id, priorId: null, rows })),
  ]
  const reference = dsrReference(dates, paths, trainSessions)
  const window = (from: number, end: number, fit = reference) => scoredWindow(dates, paths, from, end, fit)
  const splits = {
    train: window(0, trainSessions),
    validation: window(trainSessions, developmentSessions),
    holdout: window(developmentSessions, days.length),
    full: window(0, days.length),
  }
  const annual = Object.entries(Object.groupBy(dates, (date) => date.slice(0, 4))).map(([year, members]) => {
    if (members === undefined) throw new Error(`Empty calendar year: ${year}`)
    const from = dates.indexOf(members[0])
    return { year, ...window(from, from + members.length, dsrReference(dates, paths, from)) }
  })
  const variants = [
    ...noise.map(({ spec }) => ({ ...spec, track: 'A' as const })),
    ...gap.map(({ spec }) => ({ ...spec, track: 'B' as const })),
  ].map((variant) => {
    const { id } = variant
    const full = splits.full.official[id].execution
    const holdout = splits.holdout.official[id]
    const selected = primary(holdout.costs)
    const stressed = holdout.costs.at(-1)?.netUsd ?? null
    const yearsPassing = annual
      .filter(({ year, official }) => {
        if (year < '2024') return false
        const metric = primary(official[id].costs)
        return positive(variant.track === 'A' ? metric.versusB0.netUsd : metric.netUsd)
      })
      .map(({ year }) => year)
    const p = variant.track === 'A' ? selected.versusB0.excessP : selected.standaloneP
    const reasons: string[] = []
    if (id === baselineId) reasons.push('control, not an expansion candidate')
    if (full.unresolvedDates.length + full.heldGapDates.length + full.missingEntryDates.length > 0)
      reasons.push('unresolved or incomplete execution path')
    if (full.maxObservedGrossBoundUsd > cap) reasons.push('gross bound exceeds limit')
    if (holdout.execution.activeDays < minimumActiveDays) reasons.push('fewer than 30 active Holdout sessions')
    if (!positive(selected.netUsd) || !positive(stressed) || !positive(selected.exTop10Usd))
      reasons.push('nonpositive or unknown Holdout net, 10 bp stress or ex-top-ten net')
    if (variant.track === 'A' && !positive(selected.versusB0.sharpe)) reasons.push('no Holdout Sharpe lift over B0')
    if (selected.dsr === null || selected.dsr < minimumDsr) reasons.push('Holdout DSR below 0.95 or undefined')
    if (p === null || p >= alpha)
      reasons.push('primary Holdout bootstrap does not reject after multiplicity adjustment')
    if (yearsPassing.length < minimumPositiveYears) reasons.push('insufficient annual Holdout stability')
    return {
      ...variant,
      positiveHoldoutYears: yearsPassing,
      recommendation: reasons.length === 0 ? Recommendation.Promote : Recommendation.DoNotPromote,
      reasons,
    }
  })
  return {
    protocol: {
      symbols,
      sectors,
      capitalUsd: capital,
      grossLimitUsd: cap,
      warmupSessions: warmup,
      lookbackSessions: lookback,
      costRtBps: costs,
      primaryCostRtBps: primaryCost,
      bootstrap,
      exactDsrTrialCount: trialCount,
      promotionComparisons: trialCount - 1,
      familywisePrimaryPThreshold: alpha,
      baselineId,
    },
    elections,
    variants,
    splits,
    annual,
  }
}

class StudyError extends Data.TaggedError('SectorEtfExpansionError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const failure = (message: string) => (cause: unknown) => new StudyError({ message, cause: Redacted.make(cause) })

const main = Effect.gen(function* () {
  const output = yield* Effect.try({
    try: () => {
      const { values } = parseArgs({
        options: { output: { type: 'string' } },
        strict: true,
        allowPositionals: false,
      })
      if (values.output === undefined || values.output === '') throw new Error('Missing output path')
      return values.output
    },
    catch: failure('Usage: bun services/bayn/tools/research-sector-etf-intraday-expansion.ts --output <new.json>'),
  })
  const intraday = yield* withS3Archive(loadIntraday).pipe(Effect.timeout('5 minutes'))
  const daily = yield* loadFrozenDailyFrames
  const result = yield* Effect.try({
    try: () => study(intraday.days, daily),
    catch: failure('Unable to evaluate the verified ETF archive'),
  })
  yield* Effect.tryPromise({
    try: (signal) =>
      writeFile(
        output,
        JSON.stringify(
          {
            schema: 'bayn.research.wave-18d.sector-etf-intraday-expansion.v1',
            source: intraday.source,
            coverage: intraday.coverage,
            ...result,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx', signal },
      ),
    catch: failure('Unable to write a new Wave 18D result file'),
  })
})

if (import.meta.main) NodeRuntime.runMain(main)
