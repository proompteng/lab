import { splitBounds, type Split, splits, type Tape, type Universe, universes } from './daily-alpha-data'
import { economics, type Evaluation, gates, measure, plateauFor, tenBp } from './daily-alpha-metrics'
import { type Bounds, costs, netAt, replay } from './daily-alpha-replay'
import {
  ensembleWindows,
  equityCohorts,
  familyGroup,
  isSubmittable,
  liquidateAt,
  neighbors,
  signalPlanners,
  type Trial,
  trialGrid,
  trialId,
} from './daily-alpha-signals'
import { dailySharpe, deflatedSharpe, expectedMaximumSharpe } from './midday-research-statistics'

type Cohort = (typeof equityCohorts)[number]
type Recipe = 'leaders' | 'survivors'
interface Composite {
  id: string
  cohort: Cohort
  recipe: Recipe
  window: number
  members: readonly Trial[]
}
const ensembleId = (cohort: Cohort, recipe: Recipe, window: number) => `ensemble/${cohort}/${recipe}/${window}`
const base = trialGrid()
const ensembleCount = equityCohorts.length * ensembleWindows.length * 2
const trialCount = base.length + ensembleCount
const splitNames: readonly Split[] = ['train', 'validation', 'holdout']
const years = ['2021', '2022', '2023', '2024', '2025', '2026']
const baseById = new Map(base.map((trial) => [trialId(trial), trial]))
const baseNeighbors = new Map(base.map((trial) => [trialId(trial), neighbors(trial, base).map(trialId)]))

type Runs = Partial<Record<Split, Map<string, Evaluation>>>

function evaluator(tape: Tape, bounds: Bounds) {
  const makePlanner = signalPlanners(tape)
  const makeSleeve = (trial: Trial) => ({ plan: makePlanner(trial), end: liquidateAt(trial) })
  const notRun = (error: string): Evaluation => ({ metrics: null, error, loso: {} })

  function examine(candidates: readonly string[], run: (omit?: string) => ReturnType<typeof replay>): Evaluation {
    const baseline = run()
    const metrics = measure(tape, bounds, baseline)
    if (baseline.error !== undefined) return notRun(baseline.error)
    const loso: Evaluation['loso'] = {}
    for (const symbol of candidates) {
      const without = run(symbol)
      loso[symbol] = without.error === undefined ? without.days.reduce((total, day) => total + netAt(day, 10), 0) : null
    }
    return { metrics, error: null, loso }
  }

  function evaluate(trial: Trial) {
    const candidates = universes[trial.universe]
    if (candidates.length < trial.k * 2) return notRun('Universe cannot form two disjoint full sides')
    const sleeve = makeSleeve(trial)
    return examine(candidates, (omit) => replay(tape, bounds, [sleeve], omit))
  }

  function combine(ensemble: Composite) {
    if (ensemble.members.length < 2) return notRun('Fewer than two registered family leaders were available')
    const sleeves = ensemble.members.map(makeSleeve)
    const candidates = [...new Set(ensemble.members.flatMap(({ universe }) => universes[universe]))].sort()
    return examine(candidates, (omit) => {
      const histories: number[][] = []
      for (const sleeve of sleeves) {
        const run = replay(tape, bounds, [sleeve], omit)
        if (run.error !== undefined) return run
        histories.push(run.days.map((day) => netAt(day, 10)))
      }
      return replay(tape, bounds, sleeves, omit, { histories, window: ensemble.window })
    })
  }
  return { evaluate, combine }
}

const benchmarkFor = (runs: Map<string, Evaluation>) =>
  expectedMaximumSharpe(
    [...runs.values()].flatMap(({ metrics }) => {
      const sharpe = metrics === null ? null : dailySharpe(metrics.daily)
      return sharpe === null ? [] : [sharpe]
    }),
    trialCount,
  )

function probesFor(id: string, ensembles: ReadonlyMap<string, Composite>) {
  const member = ensembles.get(id)
  if (member === undefined) return baseNeighbors.get(id) ?? []
  const i = ensembleWindows.findIndex((window) => window === member.window)
  return [ensembleWindows[i - 1], ensembleWindows[i + 1]]
    .filter((window) => window !== undefined)
    .map((window) => ensembleId(member.cohort, member.recipe, window))
}

function plateau(id: string, runs: Map<string, Evaluation>, ensemble: ReadonlyMap<string, Composite>) {
  return plateauFor(
    runs.get(id),
    probesFor(id, ensemble).map((neighbor) => {
      const run = runs.get(neighbor)
      return run === undefined ? { id: neighbor } : { id: neighbor, run }
    }),
  )
}

function failuresFor(
  id: string,
  runs: Map<string, Evaluation>,
  ensemble: ReadonlyMap<string, Composite>,
  benchmark: number | null,
  dsr: boolean,
) {
  const failures = gates(runs.get(id), benchmark, plateau(id, runs, ensemble).pass, dsr)
  const trial = baseById.get(id)
  if ((trial !== undefined && !isSubmittable(trial)) || ensemble.get(id)?.recipe === 'leaders')
    failures.push('diagnostic only')
  return failures
}

function rank(trials: readonly Trial[], runs: Map<string, Evaluation>, benchmark: number | null) {
  const noEnsembles = new Map<string, Composite>()
  return trials
    .filter(isSubmittable)
    .map((trial) => {
      const id = trialId(trial)
      return {
        trial,
        id,
        pass: failuresFor(id, runs, noEnsembles, benchmark, true).length === 0,
        sharpe: tenBp(runs.get(id)?.metrics)?.sharpe ?? -Infinity,
      }
    })
    .filter(({ sharpe }) => Number.isFinite(sharpe))
    .sort((a, b) => Number(b.pass) - Number(a.pass) || b.sharpe - a.sharpe || (a.id < b.id ? -1 : 1))
}

export function develop(tape: Tape) {
  const train = new Map<string, Evaluation>()
  const trainEval = evaluator(tape, splitBounds(tape, 'train'))
  for (const trial of base) train.set(trialId(trial), trainEval.evaluate(trial))
  const familyBenchmark = benchmarkFor(train)
  const ranked = rank(base, train, familyBenchmark)
  const incumbents = Object.fromEntries(
    equityCohorts.map((cohort) => {
      const eligible = new Set<Universe>([cohort, cohort.startsWith('expanded') ? 'etfs' : 'live-etfs'])
      const groups = new Set<string>()
      return [
        cohort,
        ranked.filter(({ trial }) => {
          const group = familyGroup(trial.family)
          if (!eligible.has(trial.universe) || groups.has(group)) return false
          groups.add(group)
          return true
        }),
      ]
    }),
  )

  // The second slot decision is Train-only. A Validation failure never creates a replacement slot.
  const reserveEnsemble = incumbents['expanded'].filter(({ pass }) => pass).length >= 2
  const validationEval = evaluator(tape, splitBounds(tape, 'validation'))
  const validation = new Map<string, Evaluation>()
  for (const trial of base) validation.set(trialId(trial), validationEval.evaluate(trial))

  const ensembles = new Map<string, Composite>()
  for (const cohort of equityCohorts) {
    const leaders = incumbents[cohort]
    const survivors = leaders.filter(
      ({ id, pass }) => pass && failuresFor(id, validation, ensembles, familyBenchmark, false).length === 0,
    )
    for (const recipe of ['leaders', 'survivors'] as const) {
      for (const window of ensembleWindows) {
        const id = ensembleId(cohort, recipe, window)
        const members = (recipe === 'leaders' ? leaders : survivors).map(({ trial }) => trial)
        const ensemble = { id, cohort, recipe, window, members }
        ensembles.set(id, ensemble)
        train.set(id, trainEval.combine(ensemble))
        validation.set(id, validationEval.combine(ensemble))
      }
    }
  }
  const benchmark = benchmarkFor(train)
  // Only the Train-ranked standalones can occupy a standalone slot. The final null includes ensemble
  // trials; it is used for the pass/veto audit, not for choosing a different standalone after Validation.
  const first = ranked[0]
  const alternative = ranked.find(
    ({ trial }) => first !== undefined && familyGroup(trial.family) !== familyGroup(first.trial.family),
  )
  const finalists = [first?.id, reserveEnsemble ? ensembleId('expanded', 'survivors', 20) : alternative?.id].filter(
    (id) => id !== undefined,
  )
  const runs = { train, validation }
  const promotion = finalists.map((id) => ({
    id,
    trainFailures: failuresFor(id, train, ensembles, benchmark, true),
    validationFailures: failuresFor(id, validation, ensembles, benchmark, false),
  }))
  const holdoutIds = new Set<string>()
  for (const id of finalists) {
    const trial = baseById.get(id)
    const ensemble = ensembles.get(id)
    const counterparts =
      trial === undefined
        ? equityCohorts.map((cohort) => ensembleId(cohort, 'survivors', ensemble?.window ?? 20))
        : Object.keys(universes)
            .map((universe) => trialId({ ...trial, universe: universe as Universe }))
            .filter((id) => baseById.has(id))
    for (const counterpart of counterparts) {
      holdoutIds.add(counterpart)
      for (const probe of probesFor(counterpart, ensembles)) holdoutIds.add(probe)
    }
  }
  return {
    runs,
    ensembles,
    selection: {
      trialCount,
      familyBenchmarkDaily: familyBenchmark,
      benchmarkDaily: benchmark,
      incumbents: Object.fromEntries(
        equityCohorts.map((cohort) => [cohort, incumbents[cohort].map(({ id, pass }) => ({ id, trainPass: pass }))]),
      ),
      finalists: promotion,
      holdoutIds: [...holdoutIds].sort(),
    },
  }
}
export type Development = ReturnType<typeof develop>

export function scoreHoldout(tape: Tape, development: Development) {
  const score = evaluator(tape, splitBounds(tape, 'holdout'))
  const runs = new Map<string, Evaluation>()
  for (const id of development.selection.holdoutIds) {
    const trial = baseById.get(id)
    const ensemble = development.ensembles.get(id)
    if (trial !== undefined) runs.set(id, score.evaluate(trial))
    else if (ensemble !== undefined) runs.set(id, score.combine(ensemble))
    else throw new Error(`Unregistered holdout trial ${id}`)
  }
  return runs
}

function splitResult(
  id: string,
  runs: Map<string, Evaluation>,
  benchmark: number | null,
  ensembles: ReadonlyMap<string, Composite>,
  split: Split,
) {
  const evaluation = runs.get(id)
  if (evaluation === undefined) return null
  const { metrics, error, loso } = evaluation
  if (metrics === null) return { status: 'rejected', error }
  const { daily, ...statistics } = metrics
  const failures = failuresFor(id, runs, ensembles, benchmark, split !== 'validation')
  const finiteLoso = Object.values(loso).filter((result) => result !== null)
  return {
    status: failures.length === 0 ? 'pass' : 'rejected',
    sessions: daily.length,
    ...statistics,
    dsr: deflatedSharpe(daily, benchmark),
    losoMinUsd:
      finiteLoso.length === Object.keys(loso).length && finiteLoso.length > 0 ? Math.min(...finiteLoso) : null,
    losoNetUsd: loso,
    plateau: plateau(id, runs, ensembles),
    failures,
  }
}

function annualEconomics(tape: Tape, id: string, runs: Runs) {
  const byYear = new Map<string, number[]>()
  for (const split of splitNames) {
    const daily = runs[split]?.get(id)?.metrics?.daily
    if (daily === undefined) continue
    const { start } = splitBounds(tape, split)
    for (let i = 0; i < daily.length; i++) {
      const year = tape.dates[start + i].slice(0, 4)
      const values = byYear.get(year) ?? []
      values.push(daily[i])
      byYear.set(year, values)
    }
  }
  return Object.fromEntries(
    years.map((year) => {
      const values = byYear.get(year) ?? []
      return [year, { sessions: values.length, economics: economics(values) }]
    }),
  )
}

export function makeLedger(tape: Tape, development: Development, holdout?: Map<string, Evaluation>) {
  const runs: Runs = holdout === undefined ? development.runs : { ...development.runs, holdout }
  const { ensembles, selection } = development
  const accepted =
    holdout === undefined
      ? []
      : selection.finalists
          .filter(
            ({ id, trainFailures, validationFailures }) =>
              trainFailures.length === 0 &&
              validationFailures.length === 0 &&
              failuresFor(id, holdout, ensembles, selection.benchmarkDaily, true).length === 0,
          )
          .map(({ id }) => id)
  return {
    schemaVersion: 'bayn.daily-overnight-results.v1',
    stage: holdout === undefined ? 'development' : 'scored',
    rowsRead: tape.rowsRead,
    preListingRowsExcluded: tape.excluded,
    splits,
    sessionCounts: Object.fromEntries(
      splitNames.map((split) => {
        if (split === 'holdout' && holdout === undefined) return [split, 0]
        const { start, end } = splitBounds(tape, split)
        return [split, end - start]
      }),
    ),
    costsBps: costs,
    selection,
    accepted,
    trials: [...base.map((trial) => [trialId(trial), trial] as const), ...ensembles].map(([id, config]) => ({
      id,
      configuration: 'members' in config ? { ...config, members: config.members.map(trialId) } : config,
      ...Object.fromEntries(
        splitNames.map((split) => {
          const results = runs[split]
          return [
            split,
            results === undefined ? null : splitResult(id, results, selection.benchmarkDaily, ensembles, split),
          ]
        }),
      ),
      years10Bp: annualEconomics(tape, id, runs),
    })),
  }
}

export type Ledger = ReturnType<typeof makeLedger>

// One line per trial keeps the development-to-frozen diff local to rows actually opened on Holdout.
export function encodeLedger(ledger: Ledger & { freezeCommit?: string }) {
  const { trials, ...header } = ledger
  return `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "trials": [\n${trials.map((trial) => `    ${JSON.stringify(trial)}`).join(',\n')}\n  ]\n}\n`
}
