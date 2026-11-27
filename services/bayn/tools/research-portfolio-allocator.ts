import { writeFileSync } from 'node:fs'

import { trailingSleeveRisk } from '../src/strategy/intraday-alpha/portfolio-allocator'
import { evaluationEnd, evaluationStart } from './midday-research-data'
import { quantile } from './midday-research-statistics'
import {
  longHoldoutSplice,
  type PortfolioSession,
  preparePortfolioSessions,
  readAllocatorDatasets,
  sleeveBudgetWeights,
  sleeves,
} from './portfolio-research-data'
import {
  accountGrossCap,
  costs,
  neighbors,
  type PortfolioDay,
  replayPortfolioDay,
  startingEquity,
  type Trial,
  trialGrid,
} from './portfolio-research-replay'
import { commonSessions, dailyNet, economics, score, trialSharpeBenchmark } from './portfolio-research-statistics'

interface Fold {
  readonly name: string
  readonly start: string
  readonly end: string
}

export const longFolds: readonly Fold[] = [
  { name: 'train-dev', start: '2024-01-02', end: '2025-06-30' },
  { name: 'validation', start: '2025-07-01', end: '2026-03-31' },
  { name: 'frozen-holdout', start: '2026-04-01', end: evaluationEnd },
]

const longBudgets = [sleeveBudgetWeights[0], 0, sleeveBudgetWeights[2]]
const staticTrial: Trial = { name: 'v2-static' }
const adaptiveTrial: Trial = { name: 'walk-forward' }
const getArm = (arms: readonly Arm[], name: string) => {
  const arm = arms.find(({ trial }) => trial.name === name)
  if (arm === undefined) throw new Error(`Missing trial: ${name}`)
  return arm
}

type Cost = (typeof costs)[number]
interface Arm {
  readonly trial: Trial
  readonly costs: Record<Cost, PortfolioDay[]>
}
const newArm = (trial: Trial): Arm => ({ trial, costs: { 2: [], 5: [], 10: [] } })

const positive = (value: number | null | undefined) => value != null && value > 0

// Rank on a common development cohort; a disqualified candidate cannot win by changing its fill coverage.
export const selectOnPrior = (arms: readonly Arm[], cutoff: string) => {
  const trainingCosts = [5, 10] as const
  const prior = (days: readonly PortfolioDay[]) => days.filter(({ date }) => date < cutoff)
  const rows = arms.map(({ trial, costs: paths }) => ({
    trial,
    costs: trainingCosts.map((cost) => prior(paths[cost])),
  }))
  const metrics = trainingCosts.map((_, i) => {
    const series = rows.map(({ costs: paths }) => paths[i] ?? [])
    const common = commonSessions(series)
    return series.map((path) => economics(dailyNet(path, common)))
  })
  const ranks = metrics.map((atCost) => {
    const rankBy = (key: 'calmar' | 'sharpe') =>
      atCost
        .map((row) => row[key] ?? -Infinity)
        .map((value, _, population) => population.filter((other) => other > value).length)
    const calmar = rankBy('calmar')
    const sharpe = rankBy('sharpe')
    return calmar.map((rank, i) => (rank + (sharpe[i] ?? 0)) / 2)
  })
  const eligible = rows
    .flatMap(({ trial }, index) => {
      if (
        !metrics.every((atCost) => {
          const row = atCost[index]
          return row !== undefined && positive(row.exTop5Usd) && row.calmar !== null && row.sharpe !== null
        })
      )
        return []
      return [{ name: trial.name, rank: Math.max(...ranks.map((atCost) => atCost[index] ?? Infinity)) }]
    })
    .sort((a, b) => a.rank - b.rank)
  return { name: eligible[0]?.name ?? staticTrial.name, trainingSessions: metrics[0]?.[0]?.sessions ?? 0 }
}

const foldsFromLive = (sessions: readonly PortfolioSession[]): Fold[] => {
  const dates = sessions.filter(({ date }) => date >= evaluationStart).map(({ date }) => date)
  return [0, 22, 44].map((i) => {
    const start = dates[i]
    const end = dates[i + 21]
    if (start === undefined || end === undefined) throw new Error('Incomplete live fold dates')
    return { name: `forward-${i / 22 + 1}`, start, end }
  })
}

const simulate = (
  sessions: readonly PortfolioSession[],
  folds: readonly Fold[],
  budgets: readonly number[],
  historical: boolean,
) => {
  const trials = historical
    ? trialGrid.filter(
        ({ name }) => name !== 'dispersion' && name !== 'vol-dispersion' && !name.startsWith('combined-dispersion-'),
      )
    : trialGrid
  const arms = trials.map(newArm)
  const adaptive = newArm(adaptiveTrial)
  const referenceHistory: { session: string; returns: readonly (number | null)[] }[] = []
  const calibration: (number | null)[][] = []
  const choices: {
    fold: string
    asOfExclusive: string
    name: string
    trainingSessions: number
    targetDailyVol: readonly (number | null)[]
  }[] = []
  const fit = () =>
    sleeves.map((_, column) =>
      quantile(
        calibration.flatMap((row) => (positive(row[column]) ? [row[column] ?? 0] : [])),
        0.5,
      ),
    )
  let targets: readonly (number | null)[] = fit()
  let selected = staticTrial.name

  for (const session of sessions) {
    const fold = folds.find(({ start, end }) => session.date >= start && session.date <= end)
    if (fold === undefined || fold.name === 'train-dev' || session.date === fold.start) targets = fit()
    if (fold !== undefined && session.date === fold.start) {
      const choice = selectOnPrior(
        arms.filter(({ trial }) => !neighbors.includes(trial.name)),
        session.date,
      )
      selected = choice.name
      choices.push({ fold: fold.name, asOfExclusive: session.date, ...choice, targetDailyVol: targets })
    }

    const risk = trailingSleeveRisk(referenceHistory.slice(-14), session.date, sleeves.length)
    for (const arm of arms)
      for (const cost of costs)
        arm.costs[cost].push(replayPortfolioDay(session, arm.trial, cost, risk, targets, budgets))

    // The static arm is a shadow ledger, not the realized return of a data-dependent selected portfolio.
    const reference = getArm(arms, staticTrial.name).costs[5].at(-1)
    if (reference === undefined) throw new Error(`Missing static shadow on ${session.date}`)
    referenceHistory.push({
      session: session.date,
      returns: budgets.map((budget, i) => {
        const net = reference.sleeveNet[i]
        return budget === 0 || net == null ? null : net / (startingEquity * budget)
      }),
    })
    calibration.push(risk.volatility)

    const chosen = getArm(arms, selected)
    for (const cost of costs) {
      const day = chosen.costs[cost].at(-1)
      if (day === undefined) throw new Error(`Missing walk-forward trial on ${session.date}`)
      adaptive.costs[cost].push(day)
    }
  }
  return { arms: [...arms, adaptive], choices }
}

const inFolds = (days: readonly PortfolioDay[], folds: readonly Fold[]) =>
  days.filter(({ date }) => folds.some(({ start, end }) => date >= start && date <= end))

const scoreCohort = (run: ReturnType<typeof simulate>, folds: readonly Fold[]) =>
  costs.map((cost) => {
    const paths = run.arms.map((arm) => inFolds(arm.costs[cost], folds))
    const support = commonSessions(paths)
    const benchmark = trialSharpeBenchmark(paths, support)
    return {
      costBps: cost,
      dsrBenchmarkDailySharpe: benchmark,
      matchedExcludedDates: paths[0]?.flatMap(({ date }) => (support.has(date) ? [] : [date])) ?? [],
      arms: run.arms.map(({ trial }, index) => {
        const days = paths[index] ?? []
        return {
          name: trial.name,
          ...score(days, support, folds, benchmark, trial.grossCap ?? accountGrossCap),
          dailyNetUsd: days.map(({ net }) => net),
        }
      }),
    }
  })

type ScoredCohort = ReturnType<typeof scoreCohort>
const scoreAt = (cohort: ScoredCohort, name: string, costBps: Cost) =>
  cohort.find((row) => row.costBps === costBps)?.arms.find((arm) => arm.name === name)
const longVariant = (name: string) =>
  name === 'dispersion'
    ? 'v2-static'
    : name === 'vol-dispersion'
      ? 'volatility'
      : name.startsWith('combined-dispersion-')
        ? 'combined'
        : name

const compare = (value: number | null, reference: number | null, strict: boolean) =>
  value !== null && reference !== null && (strict ? value > reference : value >= reference)

const leaveOneOut = (run: ReturnType<typeof simulate>, folds: readonly Fold[]) =>
  costs.map((cost) => {
    const paths = run.arms.map(({ costs: legs }) => inFolds(legs[cost], folds))
    const support = commonSessions(paths)
    return {
      costBps: cost,
      arms: run.arms.map(({ trial }, index) => {
        const days = paths[index] ?? []
        const stats = economics(dailyNet(days, support))
        return {
          name: trial.name,
          ...stats,
          completeSessions: days.filter(({ net }) => net !== null).length,
          fillCount: days.reduce((total, day) => total + day.filled, 0),
          totalPathSessions: days.length,
        }
      }),
    }
  })

const promotion = (live: ScoredCohort, long: ScoredCohort, loso: readonly ReturnType<typeof leaveOneOut>[]) =>
  [...trialGrid, adaptiveTrial]
    .filter(({ name }) => name !== staticTrial.name)
    .map(({ name }) => ({
      name,
      checks: ([5, 10] as const).map((cost) => {
        const row = scoreAt(live, name, cost)
        const control = scoreAt(live, staticTrial.name, cost)
        const longRow = scoreAt(long, longVariant(name), cost)
        if (row === undefined || control === undefined || longRow === undefined)
          throw new Error(`Missing promotion scenario ${name} at ${cost} bp`)
        const checks = {
          fullLiveWindow: row.fullWindowNetUsd !== null && row.sessions === row.requestedSessions,
          positiveNet: positive(row.netUsd),
          exTop5: positive(row.exTop5Usd),
          allLiveFolds: row.folds.every(({ netUsd }) => positive(netUsd)),
          sharpeImproves: compare(row.sharpe, control.sharpe, true),
          calmarImproves: compare(row.calmar, control.calmar, true),
          preservesNet: compare(row.netUsd, control.netUsd, false),
          bootstrap: (row.bootstrap?.pValue ?? 1) <= 0.05,
          dsr: (row.dsr ?? 0) >= 0.95,
          loso: loso.every((variant) => {
            const sub = variant.find(({ costBps }) => costBps === cost)?.arms.find((arm) => arm.name === name)
            return sub !== undefined && sub.sessions === sub.totalPathSessions && positive(sub.exTop5Usd)
          }),
          plateau:
            !name.startsWith('combined') ||
            neighbors.every((neighbor) => positive(scoreAt(live, neighbor, cost)?.exTop5Usd)),
          regimes: Object.values(row.regimes).every(({ netUsd }) => positive(netUsd)),
          grossCap: row.execution.admissionsOverCap === 0 && row.execution.daysMarkedOverCap === 0,
          longValidationAndHoldout: longRow.folds
            .slice(1)
            .every(
              ({ sessions, requestedSessions, netUsd, exTop5Usd }) =>
                sessions === requestedSessions && positive(netUsd) && positive(exTop5Usd),
            ),
        }
        return { costBps: cost, checks, passed: Object.values(checks).every(Boolean) }
      }),
    }))

export const runPortfolioAllocatorResearch = (directory: string) => {
  const dataset = readAllocatorDatasets(directory)
  const liveSessions = preparePortfolioSessions(dataset, 'live')
  const allLive = liveSessions.get('')
  if (allLive === undefined) throw new Error('Missing full-universe live paths')
  const liveFolds = foldsFromLive(allLive)
  const liveRun = simulate(allLive, liveFolds, sleeveBudgetWeights, false)
  const live = scoreCohort(liveRun, liveFolds)
  const loso = [...liveSessions].flatMap(([symbol, sessions]) => {
    if (symbol === '') return []
    const run = simulate(sessions, liveFolds, sleeveBudgetWeights, false)
    return [{ omittedSymbol: symbol, choices: run.choices, costs: leaveOneOut(run, liveFolds) }]
  })

  const allLong = preparePortfolioSessions(dataset, 'long').get('')
  if (allLong === undefined) throw new Error('Missing long-universe paths')
  const longRun = simulate(allLong, longFolds, longBudgets, true)
  const long = scoreCohort(longRun, longFolds)
  const gates = promotion(
    live,
    long,
    loso.map((variant) => variant.costs),
  )
  const eligibleForSynthesis = gates
    .filter(({ checks }) => checks.every(({ passed }) => passed))
    .map(({ name }) => name)
  return {
    evidenceSchema: 'bayn.portfolio-allocator-research.v1',
    decision: eligibleForSynthesis.length === 0 ? 'NO_PROMOTION' : 'WAVE_2_RESEARCH_ONLY',
    eligibleForSynthesis,
    sources: dataset.sources,
    assumptions: { startingEquity, accountGrossCap, buyingPowerMultiple: 4, hypotheticalSellFeeBps: 0.21, costs },
    sleeves,
    trialGrid,
    live: {
      dates: inFolds(liveRun.arms[0]?.costs[5] ?? [], liveFolds).map(({ date }) => date),
      choices: liveRun.choices,
      costs: live,
      loso,
    },
    multiYear: {
      symbols: dataset.longSymbols,
      dates: allLong.map(({ date }) => date),
      spliceAt: longHoldoutSplice,
      choices: longRun.choices,
      costs: long,
    },
    gates,
  }
}

if (import.meta.main) {
  const [directory, output, ...extra] = process.argv.slice(2)
  if (directory === undefined || output === undefined || extra.length > 0)
    throw new Error('Usage: bun services/bayn/tools/research-portfolio-allocator.ts <frozen-directory> <results.json>')
  const result = runPortfolioAllocatorResearch(directory)
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    `${result.decision}: ${result.eligibleForSynthesis.length} promotion-eligible sizing arms; results: ${output}`,
  )
}
