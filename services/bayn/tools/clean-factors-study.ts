import { sectors, splitBounds, splits } from './clean-factors-data'
import type { Split, Tape } from './clean-factors-data'
import { combinedGrid, costs, equityGrid, neighbors, overlayGrid, priorTrials } from './clean-factors-grid'
import type { Candidate } from './clean-factors-grid'
import { alignedCorrelations, gateCosts, gateViews, netSeries, summarize } from './clean-factors-metrics'
import type { Benchmarks, Matrix } from './clean-factors-metrics'
import { makeReplayer } from './clean-factors-replay'
import type { Replay, ReplayDay } from './clean-factors-replay'
import { buildSignals } from './clean-factors-signals'
import { expectedMaximumSharpe } from './midday-research-statistics'

const devSplits = ['train', 'validation'] as const
const allSplits = [...devSplits, 'holdout'] as const

export function calendarYears(days: readonly ReplayDay[]) {
  const years = new Map<string, ReplayDay[]>()
  for (const day of days) {
    const year = day.date.slice(0, 4)
    const bucket = years.get(year)
    if (bucket !== undefined) bucket.push(day)
    else years.set(year, [day])
  }
  return years
}

type Summary = ReturnType<typeof summarize>
const report = (replay: Replay, benchmarks?: Benchmarks) => ({
  ...summarize(replay.days, benchmarks),
  execution: { gaps: replay.gaps, knownRtxExitUnits: replay.knownRtxExitUnits },
})
type Report = ReturnType<typeof report>
type DevelopmentTrial = ReturnType<typeof developmentTrial>

function developmentTrial(candidate: Candidate, run: ReturnType<typeof makeReplayer>, tape: Tape) {
  const train = run(candidate, splitBounds(tape, 'train'))
  const validation = run(candidate, splitBounds(tape, 'validation'))
  return {
    candidate,
    train: report(train),
    validation: report(validation),
    validationYears: Object.fromEntries(
      [...calendarYears(validation.days)].map(([year, days]) => [year, summarize(days)]),
    ),
  }
}

const gateSummary = (summary: Summary) =>
  gateCosts.every((bp) => gateViews.every((view) => summary.costs[bp][view].netUsd > 0))

function basicFailures(result: Report) {
  const failures: string[] = []
  if (result.execution.gaps.length > 0) failures.push('last-bar-fallback-or-unfilled-order')
  if (result.turnoverPerYear >= 6) failures.push('turnover')
  for (const bp of gateCosts) {
    for (const view of gateViews) {
      const metric = result.costs[bp][view]
      if (metric.netUsd <= 0 || metric.exTop5Usd <= 0 || metric.exTop10Usd <= 0)
        failures.push(`net-or-ex-winners/${bp}/${view}`)
    }
  }
  return failures
}

function plateau(center: Report, probes: readonly Report[]) {
  return Object.fromEntries(
    costs.map((bp) => [
      bp,
      Object.fromEntries(
        gateViews.map((view) => {
          const s = center.costs[bp][view].annualSharpe
          const passing = probes.filter((p) => {
            const m = p.costs[bp][view]
            return (
              p.execution.gaps.length === 0 &&
              p.turnoverPerYear < 6 &&
              m.netUsd > 0 &&
              m.exTop5Usd > 0 &&
              s !== null &&
              m.annualSharpe !== null &&
              m.annualSharpe > 0 &&
              m.annualSharpe >= 0.5 * s
            )
          }).length
          return [
            view,
            { passing, trials: probes.length, pct: probes.length > 0 ? (100 * passing) / probes.length : null },
          ]
        }),
      ),
    ]),
  )
}

function passesPlateau(result: ReturnType<typeof plateau>) {
  return gateCosts.every((bp) =>
    gateViews.every((view) => {
      const { trials, passing } = result[bp][view]
      return trials >= 2 && passing * 3 >= trials * 2
    }),
  )
}

const rank = (a: DevelopmentTrial, b: DevelopmentTrial) =>
  (b.train.costs[10].shyExcess.annualSharpe ?? -Infinity) - (a.train.costs[10].shyExcess.annualSharpe ?? -Infinity) ||
  a.candidate.id.localeCompare(b.candidate.id)

function developmentVeto(trial: DevelopmentTrial, trials: readonly DevelopmentTrial[]) {
  const probeIds = new Set(
    neighbors(
      trial.candidate,
      trials.map((t) => t.candidate),
    ).map((t) => t.id),
  )
  const probes = trials.filter((t) => probeIds.has(t.candidate.id))
  return [
    ...devSplits.flatMap((split) => [
      ...basicFailures(trial[split]).map((failure) => `${split}/${failure}`),
      ...(passesPlateau(
        plateau(
          trial[split],
          probes.map((t) => t[split]),
        ),
      )
        ? []
        : [`${split}/plateau`]),
    ]),
    ...Object.entries(trial.validationYears).flatMap(([year, row]) =>
      gateSummary(row) ? [] : [`validation/${year}/net`],
    ),
  ]
}

function select(slot: string, subset: DevelopmentTrial[], trials: readonly DevelopmentTrial[]) {
  const ranked = subset.toSorted(rank).map((trial) => ({ trial, vetoes: developmentVeto(trial, trials) }))
  const { trial, vetoes } = ranked.find((r) => r.vetoes.length === 0) ?? ranked[0]
  return { slot, trial, vetoes }
}

export function develop(tape: Tape) {
  if (tape.dates.at(-1) !== splits.validation[1]) throw new Error('Development must stop at Validation')
  const run = makeReplayer(tape, buildSignals(tape))
  const single = [...equityGrid, ...overlayGrid].map((candidate) => developmentTrial(candidate, run, tape))
  const slots = Map.groupBy(single, ({ candidate }) =>
    candidate.equity !== undefined ? candidate.equity.factor + '/' + candidate.equity.book : 'overlay',
  )
  const selected = [...slots].map(([slot, candidates]) => select(slot, candidates, single))
  const equityRank = selected
    .filter((x) => x.trial.candidate.equity)
    .sort((a, b) => Number(a.vetoes.length > 0) - Number(b.vetoes.length > 0) || rank(a.trial, b.trial))
  const equity = equityRank[0].trial.candidate.equity
  if (equity === undefined) throw new Error('No equity finalist for the overlay')
  const combined = combinedGrid(equity).map((candidate) => developmentTrial(candidate, run, tape))
  selected.push(select('combined', combined, combined))
  const ledger = [...single, ...combined]
  const grid = ledger.map((t) => t.candidate)
  if (grid.length > 180 || new Set(grid.map((t) => t.id)).size !== grid.length) throw new Error('Invalid trial ledger')
  const candidates = selected.map(({ slot, trial, vetoes }) => ({
    slot,
    center: trial.candidate.id,
    probes: neighbors(trial.candidate, grid).map((c) => c.id),
    developmentVetoes: vetoes,
  }))
  const benchmarks = Object.fromEntries(
    costs.map((bp) => {
      const projected = (view: keyof Matrix[10]) =>
        expectedMaximumSharpe(
          ledger.map((t) => (t.train.costs[bp][view].annualSharpe ?? 0) / Math.sqrt(252)),
          priorTrials + grid.length,
        )
      return [bp, { zeroCash: projected('zeroCash'), shyCash: projected('shyCash'), shyExcess: projected('shyExcess') }]
    }),
  ) as Benchmarks
  return { grid, candidates, benchmarks, ledger }
}

export type Development = ReturnType<typeof develop>

function statisticalFailures(outcome: Report, maxP: number) {
  return gateCosts.flatMap((bp) =>
    gateViews.flatMap((view) => {
      const { stationaryP, cumulativeDsr } = outcome.costs[bp][view]
      return [
        ...(stationaryP == null || stationaryP >= maxP ? [`bootstrap/${bp}/${view}`] : []),
        ...(cumulativeDsr == null || cumulativeDsr < 0.95 ? [`dsr/${bp}/${view}`] : []),
      ]
    }),
  )
}

export function score(tape: Tape, frozen: Omit<Development, 'ledger'>) {
  const run = makeReplayer(tape, buildSignals(tape))
  const lookup = (id: string) => {
    const candidate = frozen.grid.find((c) => c.id === id)
    if (candidate === undefined) throw new Error(`Unregistered candidate: ${id}`)
    return candidate
  }
  const splitReport = (candidate: Candidate, split: Split, probeIds: string[]) => {
    const bounds = splitBounds(tape, split)
    const replay = run(candidate, bounds)
    const result = report(replay, frozen.benchmarks)
    const yearly = Object.fromEntries(
      [...calendarYears(replay.days)].map(([year, days]) => [year, summarize(days, frozen.benchmarks)]),
    )
    const probes = probeIds.map((id) => ({ id, ...report(run(lookup(id), bounds)) }))
    const stability = plateau(result, probes)
    const leaveOneSectorOut = sectors.map((sector) => {
      const excluded = report(run(candidate, bounds, sector))
      return {
        sector,
        passed: gateSummary(excluded) && excluded.execution.gaps.length === 0,
        ...excluded,
      }
    })
    const vetoes = [
      ...basicFailures(result),
      ...statisticalFailures(result, 0.05 / frozen.candidates.length),
      ...(passesPlateau(stability) ? [] : ['plateau']),
      ...leaveOneSectorOut.flatMap((r) => (r.passed ? [] : [`loo/${r.sector}`])),
      ...(split === 'validation'
        ? Object.entries(yearly).flatMap(([year, row]) => (gateSummary(row) ? [] : [`calendar/${year}/net`]))
        : []),
    ]
    const sleeveCorrelation = (() => {
      if (candidate.equity === undefined || candidate.overlay === undefined) return null
      const equity = run(lookup(candidate.equity.id), bounds)
      const overlay = run(lookup(candidate.overlay.id), bounds)
      const byYear = calendarYears(overlay.days)
      return {
        equity: { id: candidate.equity.id, ...report(equity) },
        overlay: { id: candidate.overlay.id, ...report(overlay) },
        alignedSessions: replay.days.length,
        split: alignedCorrelations(equity.days, overlay.days),
        calendarYears: Object.fromEntries(
          [...calendarYears(equity.days)].map(([year, days]) => [
            year,
            alignedCorrelations(days, byYear.get(year) ?? []),
          ]),
        ),
        // Keep just the comparable net data needed to reproduce each correlation from the report.
        dailyNet: costs.map((cost) => ({
          cost,
          equity: netSeries(equity.days, cost),
          overlay: netSeries(overlay.days, cost),
        })),
        dates: equity.days.map((day) => day.date),
        shyOpens: equity.days.map((day) => day.shyOpen),
        initialShyOpen: equity.days[0].previousShyOpen,
      }
    })()
    return { split, result, yearly, stability, leaveOneSectorOut, probes, sleeveCorrelation, vetoes }
  }
  return frozen.candidates.map(({ slot, center, probes, developmentVetoes }) => {
    const candidate = lookup(center)
    const splits = allSplits.map((split) => splitReport(candidate, split, probes))
    return {
      slot,
      candidate,
      developmentVetoes,
      splits,
      passesResearchGates: developmentVetoes.length === 0 && splits.every((split) => split.vetoes.length === 0),
      promotion: 'not-authorized-retrospective-holdout',
    }
  })
}
