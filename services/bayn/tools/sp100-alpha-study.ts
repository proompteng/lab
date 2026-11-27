import { expectedMaximumSharpe } from './midday-research-statistics'
import { type Tape } from './sp100-alpha-data'
import { costs, families, gateCosts, grid, neighbors, sectors, splits, type Trial } from './sp100-alpha-protocol'
import { annualRuns, replay, summarize, trainBenchmark, type Run } from './sp100-alpha-replay'
import { features, riskParity, targetBook } from './sp100-alpha-signals'

const noBenchmark = { 5: null, 10: null, 20: null }
type Summary = ReturnType<typeof summarize>
type Period = keyof typeof splits
type DevelopmentPeriod = Exclude<Period, 'holdout'>
type Development<T> = Record<DevelopmentPeriod, T>
type Spec = { id: string; sleeves: Trial[] }

const build = (spec: Spec, tape: Tape, model: ReturnType<typeof features>, omit = -1) => {
  const sleeves = spec.sleeves.map((trial) => targetBook(tape, trial, model, omit))
  return sleeves.length === 1 ? sleeves[0] : riskParity(tape, sleeves)
}
const single = (trial: Trial): Spec => ({ id: trial.id, sleeves: [trial] })
const suite = (tape: Tape, model: ReturnType<typeof features>, spec: Spec) => {
  const positions = build(spec, tape, model)
  return { train: replay(tape, positions, splits.train), validation: replay(tape, positions, splits.validation) }
}
const positive = (s: Summary, bps: 10 | 20) => (s.costs[bps]?.netUsd ?? 0) > 0
const positiveDev = (s: Development<Summary>) =>
  gateCosts.every((bps) => positive(s.train, bps) && positive(s.validation, bps))

export function plateau(center: Summary, probes: { id: string; result: Summary }[], bps: 10 | 20) {
  const minimumSharpe = (center.costs[bps]?.sharpe ?? Infinity) / 2
  const points = probes.map(({ id, result }) => {
    const estimate = result.costs[bps]
    return {
      id,
      netUsd: estimate?.netUsd ?? null,
      sharpe: estimate?.sharpe ?? null,
      pass: estimate !== null && estimate.netUsd > 0 && estimate.sharpe !== null && estimate.sharpe >= minimumSharpe,
    }
  })
  const required = Math.ceil((points.length * 2) / 3)
  return { required, pass: points.length >= 2 && points.filter((p) => p.pass).length >= required, points }
}

type Probes = ReturnType<typeof plateau>
type SectorStress = Record<string, { 5: number | null; 10: number | null; 20: number | null }>
const netByCost = (summary: Summary) => ({
  5: summary.costs[5]?.netUsd ?? null,
  10: summary.costs[10]?.netUsd ?? null,
  20: summary.costs[20]?.netUsd ?? null,
})
const survivesOmissions = (loso: SectorStress, bps: 10 | 20) =>
  sectors.every((sector) => (loso[sector]?.[bps] ?? 0) > 0)

export function gates(result: Summary, loso: SectorStress, neighborsByCost: Record<10 | 20, Probes>, sealed: boolean) {
  return Object.fromEntries(
    gateCosts.map((bps) => [
      bps,
      {
        netPositive: positive(result, bps),
        exTop5Positive: !sealed || (result.costs[bps]?.exTop5Usd ?? 0) > 0,
        bootstrap: !sealed || (result.costs[bps]?.bootstrapPValue ?? 1) < 0.05,
        allSectorsPositive: survivesOmissions(loso, bps),
        neighboringPlateau: neighborsByCost[bps].pass,
      },
    ]),
  )
}

const allPass = (checks: ReturnType<typeof gates>) =>
  Object.values(checks).every((row) => Object.values(row).every(Boolean))
const stability = (summary: Summary, nearby: { id: string; result: Summary }[]) => ({
  10: plateau(summary, nearby, 10),
  20: plateau(summary, nearby, 20),
})

export function develop(tape: Tape) {
  if (tape.dates.at(-1) !== splits.validation[1]) throw new Error('Development requires a physically bounded tape')
  const model = features(tape)
  const trials = grid()
  const runs = new Map<string, Development<Run>>()
  for (const trial of trials) runs.set(trial.id, suite(tape, model, single(trial)))
  const runFor = (id: string) => {
    const run = runs.get(id)
    if (run === undefined) throw new Error(`Unknown development trial: ${id}`)
    return run
  }
  const lightweight = new Map(
    trials.map(({ id }) => {
      const { train, validation } = runFor(id)
      return [
        id,
        { train: summarize(train, noBenchmark, false), validation: summarize(validation, noBenchmark, false) },
      ]
    }),
  )
  const devFor = (id: string) => {
    const summary = lightweight.get(id)
    if (summary === undefined) throw new Error(`Unknown development summary: ${id}`)
    return summary
  }
  const evaluate = (spec: Spec, probes: Spec[]) => {
    const center = devFor(spec.id)
    const train = stability(
      center.train,
      probes.map(({ id }) => ({ id, result: devFor(id).train })),
    )
    const validation = stability(
      center.validation,
      probes.map(({ id }) => ({ id, result: devFor(id).validation })),
    )
    return { train, validation }
  }
  const exclusions = (spec: Spec) => {
    const train: SectorStress = {}
    const validation: SectorStress = {}
    sectors.forEach((sector, i) => {
      const targets = build(spec, tape, model, i)
      train[sector] = netByCost(summarize(replay(tape, targets, splits.train), noBenchmark, false))
      validation[sector] = netByCost(summarize(replay(tape, targets, splits.validation), noBenchmark, false))
    })
    return { train, validation }
  }
  const candidate = (spec: Spec, probes: Spec[], eligible: boolean) => {
    const neighborsByPeriod = evaluate(spec, probes)
    const loso = exclusions(spec)
    const train = gates(devFor(spec.id).train, loso.train, neighborsByPeriod.train, false)
    const validation = gates(devFor(spec.id).validation, loso.validation, neighborsByPeriod.validation, false)
    return {
      spec,
      probes,
      loso,
      plateau: neighborsByPeriod,
      gates: { train, validation },
      developmentPass: eligible && allPass(train) && allPass(validation),
    }
  }
  const selected = families.map((family) => {
    const options = trials
      .filter((trial) => trial.family === family)
      .sort((a, b) => {
        const sharpe = (id: string) => devFor(id).train.costs[10]?.sharpe ?? -Infinity
        return sharpe(b.id) - sharpe(a.id) || (a.id < b.id ? -1 : 1)
      })
    for (const trial of options) {
      if (!positiveDev(devFor(trial.id))) continue
      const probes = neighbors(trial, trials).map(single)
      const { train, validation } = evaluate(single(trial), probes)
      if (!gateCosts.every((bps) => train[bps].pass && validation[bps].pass)) continue
      const evaluated = candidate(single(trial), probes, true)
      if (evaluated.developmentPass) return evaluated
    }
    // Always freeze a family diagnostic; failure cannot turn into promotion on Holdout.
    const best = options[0]
    return candidate(single(best), neighbors(best, trials).map(single), false)
  })
  const ensemble: Spec = { id: 'ensemble', sleeves: selected.flatMap(({ spec }) => spec.sleeves) }
  const ensembleProbes = selected.flatMap(({ probes }, i) =>
    probes.map(({ sleeves: [replacement] }) => ({
      id: `ensemble:${replacement.id}`,
      sleeves: ensemble.sleeves.map((trial, j) => (j === i ? replacement : trial)),
    })),
  )
  for (const spec of [ensemble, ...ensembleProbes]) {
    const run = suite(tape, model, spec)
    runs.set(spec.id, run)
    lightweight.set(spec.id, {
      train: summarize(run.train, noBenchmark, false),
      validation: summarize(run.validation, noBenchmark, false),
    })
  }
  const finalists = [...selected, candidate(ensemble, ensembleProbes, true)]
  const benchmarks = Object.fromEntries(
    trainBenchmark([...runs.values()].map(({ train }) => train)).map((sharpes, i) => [
      costs[i],
      expectedMaximumSharpe(sharpes),
    ]),
  )
  const opened = new Set(finalists.flatMap(({ spec, probes }) => [spec.id, ...probes.map(({ id }) => id)]))
  const ledger = [...runs].map(([id, { train, validation }]) => ({
    id,
    train: summarize(train, benchmarks, opened.has(id)),
    validation: summarize(validation, benchmarks, opened.has(id)),
  }))
  return {
    rows: tape.rows,
    developmentSha256: tape.dataSha,
    sessions: tape.dates.length,
    splits,
    trials: runs.size,
    benchmarks,
    grid: trials,
    finalists,
    ledger,
  }
}

export function score(tape: Tape, frozen: ReturnType<typeof develop>) {
  if (tape.dates.at(-1) !== splits.holdout[1]) throw new Error('Holdout requires the full frozen tape')
  const model = features(tape)
  const holdoutRuns = new Map<string, Run>()
  const take = (spec: Spec) => {
    const known = holdoutRuns.get(spec.id)
    if (known !== undefined) return known
    const run = replay(tape, build(spec, tape, model), splits.holdout)
    holdoutRuns.set(spec.id, run)
    return run
  }
  const results = frozen.finalists.map(({ spec, probes, developmentPass }) => {
    const { benchmarks } = frozen
    const run = take(spec)
    const holdout = summarize(run, benchmarks)
    const neighborsByCost = stability(
      holdout,
      probes.map((probe) => ({ id: probe.id, result: summarize(take(probe), benchmarks) })),
    )
    const loso = Object.fromEntries(
      sectors.map((sector, i) => [
        sector,
        netByCost(summarize(replay(tape, build(spec, tape, model, i), splits.holdout), benchmarks, false)),
      ]),
    )
    const holdoutGates = gates(holdout, loso, neighborsByCost, true)
    const targets = build(spec, tape, model)
    const devYears = (name: DevelopmentPeriod, years: number[]) =>
      annualRuns(replay(tape, targets, splits[name]), years, benchmarks)
    return {
      spec,
      holdout,
      loso,
      plateau: neighborsByCost,
      gates: holdoutGates,
      developmentPass,
      pass: developmentPass && allPass(holdoutGates),
      years: {
        ...devYears('train', [2016, 2017, 2018, 2019, 2020, 2021]),
        ...devYears('validation', [2022, 2023]),
        ...annualRuns(run, [2024, 2025, 2026], benchmarks),
      },
    }
  })
  return {
    rows: tape.rows,
    sessions: tape.dates.length,
    holdoutScores: [...holdoutRuns].map(([id, run]) => ({ id, ...summarize(run, frozen.benchmarks) })),
    results,
    passed: results.filter(({ pass }) => pass).map(({ spec }) => spec.id),
  }
}
