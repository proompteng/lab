import { sha256 } from '../src/hash'
import type { Enhancement } from '../src/strategy/etf-noise-area/v4/policy'
import { cap, capital, netAt } from './noise-area-study-replay'
import { armId, arms, type ReplayRow, type SessionReplay } from './noise-area-v4-replay'
import { elapsedDays, requireAlignedSessions } from './research-lib/calendar'
import {
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  maxDrawdown,
  mean,
  sharpe,
  stationaryBootstrap,
  stationaryMeanP,
  wealth,
} from './research-lib/statistics'
import { pearson } from './research-orb-zab-statistics'

type Arm = readonly Enhancement[]
type Tape = readonly SessionReplay[]
const correlationControls = ['B0', 'F4', 'O1'] as const
type FactorRow = {
  readonly date: string
  readonly returns: Readonly<Record<(typeof correlationControls)[number], number>>
}
export const costs = [2, 5, 10] as const
type Cost = (typeof costs)[number]
const stress = [5, 10] as const
// Flat-by-close outcomes, 14 lagged observations, and headroom for skipped early-close checkpoints.
export const purgeSessions = 20
const minCagrLift = 0.01
const minSharpeLift = 0.15
const minDsr = 0.95
const maxPairedP = 0.05
const bootstrap = { draws: 10_000, meanBlock: 5, seed: 0x64763434 }

export const annualFolds = (tape: Tape, fromYear: number) => {
  requireAlignedSessions(tape)
  const folds: { year: number; fit: Tape; test: Tape }[] = []
  for (let first = 0; first < tape.length; ) {
    const year = Number(tape[first].date.slice(0, 4))
    let end = first + 1
    while (end < tape.length && tape[end].date.startsWith(String(year))) end++
    if (year >= fromYear) {
      const fit = tape.slice(0, Math.max(0, first - purgeSessions))
      folds.push({ year, fit, test: tape.slice(first, end) })
    }
    first = end
  }
  return folds
}

export const ledgerOf = (tape: Tape, arm: Arm) =>
  tape.map(({ date, rows }) => {
    const row = rows.get(armId(arm))
    if (row === undefined) throw new Error(`Missing ${armId(arm)} ledger on ${date}`)
    return row
  })

const returns = (ledger: readonly ReplayRow[], bp: Cost) => {
  const daily = ledger.map((row) => netAt(row, bp))
  return daily.every((pnl): pnl is number => pnl !== null) ? daily.map((pnl) => pnl / capital) : null
}

const statistics = (daily: readonly number[] | null, years: number) => {
  if (daily === null) return { cagr: null, sharpe: null, drawdown: null }
  const terminal = wealth(daily, false)
  const drawdown = maxDrawdown(daily, false)
  return {
    cagr: terminal > 0 && drawdown < 1 && years > 0 ? terminal ** (1 / years) - 1 : null,
    sharpe: sharpe(daily),
    drawdown,
  }
}

const windowYears = (tape: Tape) => {
  const first = tape[0]?.date
  const last = tape.at(-1)?.date
  return first === undefined || last === undefined ? 0 : (elapsedDays(first, last) + 1) / 365.2425
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)
const improves = (value: number | null, threshold = 0) => value !== null && value > threshold
const paired = (a: readonly number[] | null, b: readonly number[] | null) =>
  a === null || b === null ? null : a.map((value, i) => value - b[i])
const complete = (ledger: readonly ReplayRow[]) =>
  ledger.every(
    (row) => row.unresolved === 0 && row.missingHeld === 0 && row.missingEntries === 0 && row.grossUpperBound <= cap,
  )

const withCost = (tape: Tape, arm: Arm, bp: Cost) => statistics(returns(ledgerOf(tape, arm), bp), windowYears(tape))
const differences = (tape: Tape, arm: Arm, relativeTo: Arm, bp: Cost) => {
  const a = withCost(tape, arm, bp)
  const b = withCost(tape, relativeTo, bp)
  return { bp, cagr: diff(a.cagr, b.cagr), sharpe: diff(a.sharpe, b.sharpe) }
}

const liftsAtStress = (tape: Tape, arm: Arm, relativeTo: Arm) =>
  stress.every((bp) => {
    const { cagr, sharpe } = differences(tape, arm, relativeTo, bp)
    return improves(cagr) && improves(sharpe)
  })

const without = (arm: Arm, part: Enhancement) => arm.filter((item) => item !== part)

/** Only inspect returns through the fit cutoff; never rescue a failed lock by ranking its test window. */
export const select = (fit: Tape): Arm => {
  const eligible = arms.flatMap((arm) => {
    if (arm.length === 0 || !complete(ledgerOf(fit, arm)) || !liftsAtStress(fit, arm, [])) return []
    if (!stress.every((bp) => improves(withCost(fit, arm, bp).cagr))) return []
    if (
      arm.length > 1 &&
      !arm.every((part) => {
        const remainder = without(arm, part)
        return (
          complete(ledgerOf(fit, [part])) &&
          complete(ledgerOf(fit, remainder)) &&
          liftsAtStress(fit, [part], []) &&
          liftsAtStress(fit, arm, remainder)
        )
      })
    )
      return []
    const lifts = stress.map((bp) => differences(fit, arm, [], bp).sharpe ?? 0)
    return [{ arm, worst: Math.min(...lifts) }]
  })
  return eligible.toSorted((a, b) => b.worst - a.worst)[0]?.arm ?? []
}

export const lockDevelopment = (development: Tape, commit: string) => {
  const folds = annualFolds(development, 2019).map(({ year, fit, test }) => {
    const inner = select(fit)
    return {
      year,
      fitThrough: fit.at(-1)?.date ?? '—',
      sessions: test.length,
      arm: armId(inner),
      atStress: stress.map((bp) => differences(test, inner, [], bp)),
    }
  })
  const fit = development.slice(0, Math.max(0, development.length - purgeSessions))
  const selected = select(fit)
  const benchmark = new Map(
    costs.map((bp) => {
      const dailySharpes = arms.flatMap((arm) => {
        const daily = returns(ledgerOf(fit, arm), bp)
        const value = daily === null ? null : dailySharpe(daily)
        return value === null ? [] : [value]
      })
      return [bp, expectedMaximumSharpe(dailySharpes, arms.length)] as const
    }),
  )
  const fitThrough = fit.at(-1)?.date ?? '—'
  const receipt = sha256(
    JSON.stringify({
      commit,
      fitThrough,
      selected,
      benchmark: [...benchmark],
      folds,
      // Includes the discarded outcomes to bind the source calendar and every candidate path to the receipt.
      ledger: development.map(({ date, rows }) => [date, [...rows]]),
    }),
  )
  return { selected, benchmark, receipt, fitThrough, folds }
}

export const scoreHoldout = (
  holdout: Tape,
  lock: Pick<ReturnType<typeof lockDevelopment>, 'selected' | 'benchmark'>,
  factorsAtCost: (bp: Cost) => readonly FactorRow[],
) => {
  const years = windowYears(holdout)
  const b0Ledger = ledgerOf(holdout, [])
  const plan = stationaryBootstrap(holdout.length, bootstrap)
  const folds = annualFolds(holdout, 2024).map(({ year, test }) => ({
    year,
    sessions: test.length,
    costs: costs.map((bp) => differences(test, lock.selected, [], bp)),
  }))
  const scores = costs.map((bp) => {
    const factors = factorsAtCost(bp)
    requireAlignedSessions(holdout, factors)
    const b0 = returns(b0Ledger, bp)
    if (b0 === null || b0.some((value, i) => value !== factors[i].returns.B0))
      throw new Error(`Control B0 return mismatch at ${bp} bp RT`)
    const baseline = statistics(b0, years)
    return {
      bp,
      arms: arms.map((arm) => {
        const ledger = ledgerOf(holdout, arm)
        const daily = returns(ledger, bp)
        const excess = paired(daily, b0)
        const metrics = statistics(daily, years)
        const target = armId(arm) === armId(lock.selected) && arm.length > 0
        return {
          id: armId(arm),
          ...metrics,
          deltaCagr: diff(metrics.cagr, baseline.cagr),
          deltaSharpe: diff(metrics.sharpe, baseline.sharpe),
          dsr: daily === null ? null : deflatedSharpe(daily, lock.benchmark.get(bp) ?? null),
          pairedP: target && excess !== null ? stationaryMeanP(excess, plan) : null,
          turnover: mean(ledger.map((row) => row.turnover)),
          complete: complete(ledger),
          correlations: correlationControls.map((control) =>
            daily === null
              ? null
              : pearson(
                  daily,
                  factors.map(({ returns }) => returns[control]),
                ),
          ),
        }
      }),
    }
  })
  const components = lock.selected.map((part) => {
    const remainder = without(lock.selected, part)
    return {
      part,
      atStress: stress.map((bp) => ({
        bp,
        alone: differences(holdout, [part], [], bp),
        added: differences(holdout, lock.selected, remainder, bp),
      })),
      passes:
        complete(ledgerOf(holdout, [part])) &&
        complete(ledgerOf(holdout, remainder)) &&
        liftsAtStress(holdout, [part], []) &&
        liftsAtStress(holdout, lock.selected, remainder),
    }
  })
  const passes =
    lock.selected.length > 0 &&
    complete(b0Ledger) &&
    components.every(({ passes }) => passes) &&
    scores
      .filter(({ bp }) => bp !== 2)
      .every(({ bp, arms }) => {
        const arm = arms.find(({ id }) => id === armId(lock.selected))
        return (
          arm !== undefined &&
          arm.complete &&
          improves(arm.cagr) &&
          improves(arm.sharpe) &&
          improves(arm.deltaCagr, minCagrLift) &&
          improves(arm.deltaSharpe, minSharpeLift) &&
          arm.dsr !== null &&
          arm.dsr >= minDsr &&
          arm.pairedP !== null &&
          arm.pairedP < maxPairedP &&
          folds.filter(({ costs }) =>
            costs.some((fold) => fold.bp === bp && improves(fold.cagr) && improves(fold.sharpe)),
          ).length >= 2
        )
      })
  return { passes, scores, components, folds }
}
