import { bootstrapPValue, dailySharpe, deflatedSharpe, sum } from './midday-research-statistics'
import { deflationBenchmark } from './research-orb-zab-statistics'
import type { Panel } from './sip-statarb-data'
import {
  costs,
  gateCosts,
  halves,
  neighborPairs,
  signals,
  slices,
  trialId,
  type Cost,
  type Trial,
  validationEnd,
} from './sip-statarb-protocol'
import { executionCost, netFor, type Outcome, type ReplayDays, type replay } from './sip-statarb-replay'

type Slice = (typeof slices)[number]['id']
type Ledgers = ReturnType<typeof replay>
type Range = { readonly id: Slice; readonly start: number; readonly end: number }

const economics = (daily: readonly (number | null)[]) => {
  const observed = daily.filter((net): net is number => net !== null)
  const settled = observed.length > 0 && observed.length === daily.length
  const sorted = settled ? observed.toSorted((a, b) => b - a) : []
  const sharpe = settled ? dailySharpe(observed) : null
  return {
    net: settled ? sum(observed) : null,
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(252),
    exTop5: sorted.length > 5 ? sum(sorted.slice(5)) : null,
    exTop10: sorted.length > 10 ? sum(sorted.slice(10)) : null,
  }
}

const metrics = (days: readonly Outcome[], cost: Cost, dsrBenchmark: number | null) => {
  const daily = days.map((day) => netFor(day, cost))
  const econ = economics(daily)
  const resolved = daily.filter((net): net is number => net !== null)
  const add = (field: keyof Outcome) => sum(days.map((day) => day[field]))
  return {
    ...econ,
    completeCases: econ.net === null ? economics(resolved) : null,
    bootstrapP: econ.net === null ? null : bootstrapPValue(resolved),
    dsr: econ.net === null ? null : deflatedSharpe(resolved, dsrBenchmark),
    sessions: days.length,
    resolvedSessions: resolved.length,
    active: days.filter((day) => day.opened > 0).length,
    attempted: add('attempted'),
    opened: add('opened'),
    unresolved: add('unresolved'),
    orphanWaves: add('orphanWaves'),
    heldGaps: add('heldGaps'),
    stops: add('stops'),
    targets: add('targets'),
    vwapCrosses: add('crosses'),
    timedExits: add('timed'),
    referenceEntryGross: add('entryGross'),
    maxDailyReferenceEntryGross: days.reduce((max, day) => Math.max(max, day.entryGross), 0),
    observedGross: add('gross'),
    observedSellFees: sum(days.map((day) => executionCost(day, cost).sellFees)),
    observedSlippage: sum(days.map((day) => executionCost(day, cost).slippage)),
  }
}

type Metrics = ReturnType<typeof metrics>
type PerRange = Partial<Record<Slice, Metrics>>
interface Evaluated {
  readonly id: string
  readonly trial: Trial
  readonly costs: Readonly<Record<Cost, PerRange>>
}

const rangesFor = (dates: readonly string[], stage: 'freeze' | 'score'): Range[] =>
  slices.flatMap((range) => {
    if (stage === 'freeze' && range.through > validationEnd) return []
    const start = dates.findIndex((date) => date >= range.from)
    const end = dates.findIndex((date) => date > range.through)
    if (start === -1) throw new Error(`Missing evaluation cut ${range.id}`)
    return [{ id: range.id, start, end: end === -1 ? dates.length : end }]
  })

const pairedCosts = <A>(build: (cost: Cost) => A): Record<Cost, A> => ({
  2: build(2),
  5: build(5),
  10: build(10),
})

export const evaluate = (panel: Panel, trials: readonly Trial[], ledgers: Ledgers, stage: 'freeze' | 'score') => {
  const dates = panel.days.map((day) => day.date)
  const ranges = rangesFor(dates, stage)
  const train = ranges.find((range) => range.id === 'train')
  if (train === undefined) throw new Error('Train range missing')
  const deflation = pairedCosts((cost) =>
    deflationBenchmark(
      [...ledgers.values()].flatMap(({ main }) => {
        const daily = main.slice(train.start, train.end).map((day) => netFor(day, cost))
        if (daily.some((net) => net === null)) return []
        const sharpe = dailySharpe(daily.filter((net): net is number => net !== null))
        return sharpe === null ? [] : [sharpe]
      }),
      trials.length,
    ),
  )
  const evaluated = trials.map((trial): Evaluated => {
    const id = trialId(trial)
    const ledger = ledgers.get(id)
    if (ledger === undefined) throw new Error(`Missing ledger: ${id}`)
    return {
      id,
      trial,
      costs: pairedCosts((cost) =>
        Object.fromEntries(
          ranges.map((range) => [range.id, metrics(ledger.main.slice(range.start, range.end), cost, deflation[cost])]),
        ),
      ),
    }
  })
  return { deflation, evaluated, ranges }
}

const positive = (metric: Metrics | undefined) => (metric?.net ?? 0) > 0 && (metric?.exTop5 ?? 0) > 0

export const passesSplit = (trial: Evaluated, split: Slice) =>
  gateCosts.every((cost) => {
    const metric = trial.costs[cost][split]
    return positive(metric) && (metric?.bootstrapP ?? 1) < 0.05
  })

const plateau = (focal: Evaluated, neighbors: ReadonlyMap<string, Evaluated>, splits: readonly Slice[]) =>
  neighborPairs(focal.trial).map(({ axis, ids }) => ({
    axis,
    neighbors: ids.map((id) => {
      const neighbor = neighbors.get(id)
      return {
        id,
        registered: neighbor !== undefined,
        checks: Object.fromEntries(
          splits.map((split) => [
            split,
            pairedCosts((cost) => {
              const center = focal.costs[cost][split]?.sharpe
              const adjacent = neighbor?.costs[cost][split]
              return (
                center !== null &&
                center !== undefined &&
                center > 0 &&
                positive(adjacent) &&
                (adjacent?.sharpe ?? 0) >= 0.75 * center
              )
            }),
          ]),
        ),
      }
    }),
  }))

const allPlateauChecksPass = (axes: ReturnType<typeof plateau>, splits: readonly Slice[]) =>
  axes.some(({ neighbors }) =>
    neighbors.every((neighbor) => splits.every((split) => gateCosts.every((cost) => neighbor.checks[split]?.[cost]))),
  )

export const nominate = (trials: readonly Evaluated[]) => {
  const lookup = new Map(trials.map((trial) => [trial.id, trial]))
  return signals.map((signal) => {
    const ranked = trials
      .filter(
        (item) =>
          item.trial.universe === 'expanded46-stocks' &&
          item.trial.signal === signal &&
          passesSplit(item, 'train') &&
          allPlateauChecksPass(plateau(item, lookup, ['train']), ['train']),
      )
      .toSorted(
        (a, b) =>
          (b.costs[10].train?.sharpe ?? 0) - (a.costs[10].train?.sharpe ?? 0) ||
          (b.costs[10].train?.exTop5 ?? 0) - (a.costs[10].train?.exTop5 ?? 0) ||
          a.id.localeCompare(b.id, 'en'),
      )
    const nominee = ranked[0]
    const approved =
      nominee !== undefined &&
      passesSplit(nominee, 'validation') &&
      allPlateauChecksPass(plateau(nominee, lookup, ['train', 'validation']), ['train', 'validation'])
    return { signal, eligibleTrain: ranked.length, nominee: nominee?.id ?? null, approved }
  })
}

export const qualify = (trials: readonly Evaluated[], nominations: ReturnType<typeof nominate>) => {
  const lookup = new Map(trials.map((trial) => [trial.id, trial]))
  const periods = ['train', 'validation', 'holdout'] as const
  return trials.map((item) => {
    const frozenCandidate = nominations.some((nomination) => nomination.approved && nomination.nominee === item.id)
    const checks = {
      train: passesSplit(item, 'train'),
      validation: passesSplit(item, 'validation'),
      holdout: passesSplit(item, 'holdout'),
    }
    const positiveHalves = halves
      .filter(({ id }) => gateCosts.every((cost) => (item.costs[cost][id]?.net ?? 0) > 0))
      .map(({ id }) => id)
    const neighbors = plateau(item, lookup, periods)
    const stable = allPlateauChecksPass(neighbors, periods)
    return {
      id: item.id,
      frozenCandidate,
      checks,
      positiveHalves,
      plateauStable: stable,
      neighbors,
      qualified: frozenCandidate && Object.values(checks).every(Boolean) && positiveHalves.length >= 5 && stable,
    }
  })
}

export const losoSummaries = (ledger: ReplayDays, symbols: readonly string[], ranges: readonly Range[]) => {
  const omittedSymbols = [...ledger.loso.keys()].map((id) => symbols[id])
  const summarizeCost = (costIndex: number) =>
    ranges.map((range) => {
      const read = (series: Float64Array, day: number) => series[day * costs.length + costIndex]
      const omitted = [...ledger.loso.entries()].map(([id, series]) => {
        let net = 0
        for (let day = range.start; day < range.end; day++) net += read(series, day)
        return { id, series, net: Number.isNaN(net) ? null : net }
      })
      const worst = omitted.reduce<(typeof omitted)[number] | null>(
        (prev, current) => (prev === null || (current.net ?? -Infinity) < (prev.net ?? -Infinity) ? current : prev),
        null,
      )
      const worstMetrics =
        worst === null
          ? null
          : {
              symbol: symbols[worst.id],
              ...economics(
                Array.from({ length: range.end - range.start }, (_, i) => {
                  const net = read(worst.series, i + range.start)
                  return Number.isNaN(net) ? null : net
                }),
              ),
            }
      return { range: range.id, worst: worstMetrics, netByOmittedSymbol: omitted.map((item) => item.net) }
    })
  return {
    omittedSymbols,
    costs: { 2: summarizeCost(0), 5: summarizeCost(1), 10: summarizeCost(2) },
  }
}
