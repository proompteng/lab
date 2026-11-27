import { calendarTail, splitRange } from './multi-asset-risk-premia-data'
import { basketNames, costs, etfs, id, neighbors, trials } from './multi-asset-risk-premia-protocol'
import type { Etf, Trial } from './multi-asset-risk-premia-protocol'
import { annualTurnover, blend, netReturn, replay } from './multi-asset-risk-premia-replay'
import type { Observation } from './multi-asset-risk-premia-replay'
import { makeFeatures, signalBook } from './multi-asset-risk-premia-signals'
import type { Session } from './multi-asset-risk-premia-signals'
import { dailySharpe, deflationBenchmark, pearson, screen, summarize } from './multi-asset-risk-premia-statistics'
import type { Cost, Screening } from './multi-asset-risk-premia-statistics'

const grid = [...trials()]
const developmentSplits = ['train', 'validation'] as const
const allSplits = [...developmentSplits, 'holdout'] as const
const portfolioId = 'ensemble/all-five'
type Stage = 'development' | 'holdout'
type Stress = Record<Cost, Screening>
type ScreeningBySplit = Record<(typeof developmentSplits)[number], Stress>
type BookGroup = readonly Trial[]

const byCost = <T>(fn: (cost: Cost) => T) => ({ 5: fn(5), 10: fn(10), 20: fn(20) })
const passes = (metrics: Screening) => metrics.net > 0 && metrics.exTop5Net !== null && metrics.exTop5Net > 0
const fraction = (outcomes: readonly boolean[]) =>
  outcomes.length > 0 ? outcomes.filter(Boolean).length / outcomes.length : 0
const stable = (outcomes: readonly boolean[]) => fraction(outcomes) >= 2 / 3

const developmentKey = (stress: ScreeningBySplit) =>
  Math.min(stress.train[10].exTop5Net ?? -Infinity, stress.validation[10].exTop5Net ?? -Infinity)
const probeId = (group: BookGroup) => group.map(id).join('+')
const nearbyGroups = (group: BookGroup) =>
  group.flatMap((trial, i) => neighbors(trial, grid).map((neighbor) => group.map((t, j) => (i === j ? neighbor : t))))
const stress = (rows: readonly Observation[]) => byCost((cost) => screen(rows, cost))

const evaluate = (sessions: readonly Session[], stage: Stage) => {
  const features = makeFeatures(sessions, stage === 'holdout' ? calendarTail : [])
  const range = (split: (typeof allSplits)[number]) => splitRange(sessions, split)
  const run = (group: BookGroup, omitted?: Etf) => {
    const books = group.map((trial) => signalBook(features, trial, omitted))
    const book = books.length === 1 ? books[0] : blend(books, sessions)
    const observations = (split: (typeof allSplits)[number]) => {
      const { first, last } = range(split)
      return replay(sessions, book, first, last)
    }
    return observations
  }
  return run
}

export const freezeStudy = (sessions: readonly Session[]) => {
  const run = evaluate(sessions, 'development')
  const deflationTrials: Record<Cost, number[]> = byCost(() => [])
  let deflationCount = 0
  const develop = (group: BookGroup) => {
    const observations = run(group)
    const train = observations('train')
    const validation = observations('validation')
    for (const cost of costs) {
      // Zero-variance trials still count in the multiplicity penalty.
      const sharpe = dailySharpe([...train, ...validation].map((row) => netReturn(row, cost)))
      if (sharpe !== null) deflationTrials[cost].push(sharpe)
    }
    deflationCount++
    return { train: stress(train), validation: stress(validation) }
  }
  const ledger = grid.map((trial) => ({ trial, id: id(trial), development: develop([trial]) }))
  const byId = new Map(ledger.map((row) => [row.id, row.development]))
  const developmentGate = (metrics: ScreeningBySplit, cost: Cost) =>
    developmentSplits.every((split) => passes(metrics[split][cost]))
  const leaveOneOut = (group: BookGroup) =>
    etfs.every((symbol) => {
      const observations = run(group, symbol)
      return developmentSplits.every((split) => screen(observations(split), 10).net > 0)
    })
  const selected = basketNames.map((kind) => {
    const ranked = ledger
      .filter(({ trial }) => trial.kind === kind)
      .map((row) => ({
        ...row,
        developmentPass: developmentGate(row.development, 10),
        plateau: stable(
          neighbors(row.trial, grid).map((trial) => {
            const comparison = byId.get(id(trial))
            if (comparison === undefined) throw new Error(`Missing neighbor: ${id(trial)}`)
            return developmentGate(comparison, 10)
          }),
        ),
        stressPass: developmentGate(row.development, 20),
      }))
      .sort(
        (a, b) =>
          Number(b.developmentPass && b.plateau) - Number(a.developmentPass && a.plateau) ||
          Number(b.stressPass) - Number(a.stressPass) ||
          developmentKey(b.development) - developmentKey(a.development) ||
          a.id.localeCompare(b.id),
      )
    const chosen =
      ranked.find(({ trial, developmentPass, plateau }) => developmentPass && plateau && leaveOneOut([trial])) ??
      ranked[0]
    return { ...chosen, leaveOneOutPass: leaveOneOut([chosen.trial]) }
  })
  const arms = selected.map(({ trial }) => trial)
  const ensemble = {
    id: portfolioId,
    arms,
    development: develop(arms),
    neighbors: nearbyGroups(arms).map((group) => ({ id: probeId(group), development: develop(group) })),
  }
  const benchmarks = byCost((bp) => deflationBenchmark(deflationTrials[bp], deflationCount))
  return {
    ledger,
    selected,
    ensemble,
    deflation: {
      attemptedTrialsPerTier: deflationCount,
      finiteSharpeCounts: byCost((bp) => deflationTrials[bp].length),
      benchmarks,
    },
  }
}

export const scoreStudy = (sessions: readonly Session[], frozen: ReturnType<typeof freezeStudy>) => {
  const score = evaluate(sessions, 'holdout')
  const benchmarks = frozen.deflation.benchmarks
  const groups = [
    ...frozen.selected.map((row) => ({ id: row.id, group: [row.trial] })),
    { id: portfolioId, group: frozen.ensemble.arms },
  ]
  const candidates = groups.map(({ id, group }) => {
    const run = score(group)
    const train = run('train')
    const validation = run('validation')
    const holdout = run('holdout')
    const periods = { train, validation, holdout }
    const report = (rows: readonly Observation[]) => byCost((bp) => summarize(rows, bp, benchmarks[bp]))
    const splits = { train: report(train), validation: report(validation), holdout: report(holdout) }
    const leaveOneEtfOut = etfs.map((omitted) => {
      const without = score(group, omitted)
      return {
        omitted,
        train: stress(without('train')),
        validation: stress(without('validation')),
        holdout: stress(without('holdout')),
      }
    })
    const plateau = nearbyGroups(group).map((neighbor) => {
      const run = score(neighbor)
      return {
        id: probeId(neighbor),
        train: stress(run('train')),
        validation: stress(run('validation')),
        holdout: stress(run('holdout')),
      }
    })
    const scorePassed = (bp: Cost) => allSplits.every((split) => passes(splits[split][bp]))
    const leaveOneOutPassed = (bp: Cost) =>
      leaveOneEtfOut.every((row) => allSplits.every((split) => row[split][bp].net > 0))
    const plateauPassed = (bp: Cost) => stable(plateau.map((row) => allSplits.every((split) => passes(row[split][bp]))))
    const bootstrap = splits.holdout[10].blockP
    const gates = {
      allSplitsPositiveAndExTop5At10Bp: scorePassed(10),
      holdoutBootstrapBelow005At10Bp: bootstrap !== null && bootstrap < 0.05,
      allLeaveOneEtfOutPositiveAt10Bp: leaveOneOutPassed(10),
      neighboringPlateauAt10Bp: plateauPassed(10),
      allSplitsPositiveAndExTop5At20Bp: scorePassed(20),
      lowTurnover: allSplits.every((split) => annualTurnover(periods[split]) <= 12),
    }
    const qualified =
      gates.allSplitsPositiveAndExTop5At10Bp &&
      gates.holdoutBootstrapBelow005At10Bp &&
      gates.allLeaveOneEtfOutPositiveAt10Bp &&
      gates.neighboringPlateauAt10Bp
    const years = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => {
        const year = String(2016 + i)
        return [year, report([...train, ...validation, ...holdout].filter((row) => row.date.startsWith(year)))]
      }),
    )
    return {
      id,
      trials: group,
      qualified,
      meetsFullObjective: qualified && gates.allSplitsPositiveAndExTop5At20Bp && gates.lowTurnover,
      gates,
      splits,
      years,
      leaveOneEtfOut,
      plateau,
    }
  })
  const dailySeries = groups.slice(0, -1).map(({ group }) => score(group))
  const correlations = Object.fromEntries(
    allSplits.map((split) => {
      const series = dailySeries.map((run) => run(split).map((row) => netReturn(row, 10)))
      return [split, series.map((a) => series.map((b) => pearson(a, b)))]
    }),
  )
  return { sleeveCorrelationOrder: basketNames, correlationsAt10Bp: correlations, candidates }
}
