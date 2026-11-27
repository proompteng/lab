import {
  bootstrapPValue,
  dailySharpe,
  deflatedSharpe,
  expectedMaximumStandardNormal,
  mean,
  sum,
} from './midday-research-statistics'
import { split, type Tape } from './sleeve4-data'
import { type Decision, type Leg, type Rule } from './sleeve4-signals'

export const costs = [2, 5, 10] as const
type Cost = (typeof costs)[number]
export const sellFee = 0.21

export interface Fill {
  readonly leg: Leg
  readonly entry: number
  readonly exit: number | null
  readonly delay: number | null
}

export interface Outcome {
  readonly date: string
  readonly observed: boolean
  readonly intended: number
  readonly fills: readonly Fill[]
}

export const fill = (leg: Leg, tape: Tape, entryMinute: number, exitMinute: number, minutes: number): Fill | null => {
  const entry = tape[entryMinute]
  if (entry === undefined || entryMinute >= exitMinute || exitMinute >= minutes) return null
  // Entry is a one-minute IOC; liquidation remains working through the regular close.
  // Never condition entry or the remaining legs on the future availability of the exit.
  for (let minute = exitMinute; minute < minutes; minute++) {
    const bar = tape[minute]
    if (bar !== undefined) return { leg, entry: entry.open, exit: bar.open, delay: minute - exitMinute }
  }
  return { leg, entry: entry.open, exit: null, delay: null }
}

export const replay = (
  date: string,
  minutes: number,
  tapes: ReadonlyMap<string, Tape>,
  rule: Rule,
  decision: Decision,
): Outcome => ({
  date,
  observed: decision.observed,
  intended: decision.legs.length,
  fills: decision.legs.flatMap((leg) => fill(leg, tapes.get(leg.symbol) ?? [], rule.entry, rule.exit, minutes) ?? []),
})

export const netBps = ({ leg, entry, exit }: Fill, cost: Cost) => {
  if (exit === null) return null
  const step = cost / 20_000
  const entryFill = entry * (1 + leg.side * step)
  const exitFill = exit * (1 - leg.side * step)
  const sale = leg.side > 0 ? exitFill : entryFill
  return (leg.weight * (10_000 * leg.side * (exitFill - entryFill) - sellFee * sale)) / entryFill
}

export const dailyNet = (day: Outcome, cost: Cost) => {
  const bps = day.fills.map((trade) => netBps(trade, cost))
  return bps.some((pnl) => pnl === null) ? null : sum(bps.flatMap((pnl) => pnl ?? []))
}

export const economics = (days: readonly Outcome[], cost: Cost) => {
  const pnl = days.map((day) => dailyNet(day, cost))
  const returns = pnl.flatMap((value) => value ?? [])
  const valid = returns.length === days.length && days.some((day) => day.fills.length > 0)
  const sorted = days
    .flatMap((day, i) => {
      const net = pnl[i]
      return net == null ? [] : [{ date: day.date, net }]
    })
    .sort((a, b) => b.net - a.net || a.date.localeCompare(b.date))
  const top5 = valid ? sorted.filter(({ net }) => net > 0).slice(0, 5) : []
  const months = new Map<string, readonly (number | null)[]>()
  for (const [i, day] of days.entries()) {
    const month = day.date.slice(0, 7)
    months.set(month, [...(months.get(month) ?? []), pnl[i] ?? null])
  }
  const foldSize = Math.ceil(days.length / 3)
  const daily = valid ? dailySharpe(returns) : null
  return {
    sessions: days.length,
    decisionObservations: days.filter((d) => d.observed).length,
    tradedDays: days.filter((d) => d.fills.length > 0).length,
    intendedLegs: sum(days.map((d) => d.intended)),
    enteredLegs: sum(days.map((d) => d.fills.length)),
    partialBaskets: days.filter((d) => d.fills.length > 0 && d.fills.length < d.intended).length,
    delayedExits: sum(days.map((d) => d.fills.filter((f) => (f.delay ?? 0) > 0).length)),
    unresolvedExits: sum(days.map((d) => d.fills.filter((f) => f.exit === null).length)),
    netBps: valid ? sum(returns) : null,
    exTop5Bps: valid ? sum(returns) - sum(top5.map(({ net }) => net)) : null,
    top5,
    dailySharpe: daily,
    annualizedSharpe: daily === null ? null : daily * Math.sqrt(252),
    bootstrapP: valid ? bootstrapPValue(returns) : null,
    folds: [0, 1, 2].map((i) => (valid ? sum(returns.slice(i * foldSize, (i + 1) * foldSize)) : null)),
    monthly: Object.fromEntries(
      [...months].map(([month, values]) => [month, valid ? sum(values.flatMap((value) => value ?? [])) : null]),
    ),
  }
}

export const costGrid = (days: readonly Outcome[]) =>
  Object.fromEntries(costs.map((cost) => [cost, economics(days, cost)]))
export type Economics = ReturnType<typeof economics>

export const minimumEvidence = (row: Economics | undefined) =>
  row !== undefined &&
  row.sessions > 0 &&
  row.tradedDays >= 20 &&
  (row.netBps ?? 0) > 0 &&
  (row.exTop5Bps ?? 0) > 0 &&
  row.enteredLegs >= 0.9 * row.intendedLegs &&
  row.decisionObservations >= 0.8 * row.sessions

export const developmentPass = (train: ReturnType<typeof costGrid>, val: ReturnType<typeof costGrid>) =>
  minimumEvidence(train[5]) && minimumEvidence(val[5]) && minimumEvidence(train[10]) && minimumEvidence(val[10])

export const neighbors = (rule: Rule, registry: readonly Rule[]) => {
  const axes = (r: Rule) => [r.entry, r.exit, r.threshold, r.length]
  const group = registry.filter((r) => r.group === rule.group)
  const axisValues = axes(rule).map((_, i) =>
    [...new Set(group.map((r) => axes(r)[i]))].sort((a, b) => (a ?? 0) - (b ?? 0)),
  )
  return group.filter((peer) => {
    const distance = axes(rule).map((value, i) => {
      const values = axisValues[i]
      return Math.abs((values?.indexOf(value) ?? 0) - (values?.indexOf(axes(peer)[i]) ?? 0))
    })
    return sum(distance) === 1
  })
}

export const select = (
  rows: readonly { rule: Rule; train: ReturnType<typeof costGrid>; validation: ReturnType<typeof costGrid> }[],
) => {
  const registry = rows.map(({ rule }) => rule)
  const passing = new Set(rows.filter((row) => developmentPass(row.train, row.validation)).map(({ rule }) => rule.id))
  const development = rows.map((row) => {
    const peerIds = neighbors(row.rule, registry).map((rule) => rule.id)
    const adjacentPasses = peerIds.filter((id) => passing.has(id))
    const plateau = adjacentPasses.length >= 2 && adjacentPasses.length * 2 >= peerIds.length
    return { ...row, peerIds, adjacentPasses, plateau, passed: passing.has(row.rule.id) && plateau }
  })
  const ranked = development
    .filter(({ rule }) => rule.panel === 'core')
    .sort(
      (a, b) =>
        Number(b.passed) - Number(a.passed) ||
        (b.validation[10]?.exTop5Bps ?? -Infinity) - (a.validation[10]?.exTop5Bps ?? -Infinity) ||
        a.rule.id.localeCompare(b.rule.id),
    )
  return { selected: ranked[0]?.rule.id ?? null, development }
}

export const dsrThreshold = (trialSharpes: readonly (number | null)[], sessions: number, trialCount: number) => {
  const comparable = trialSharpes.flatMap((value) => value ?? [])
  if (sessions < 2 || trialCount < 2) return null
  const center = comparable.length > 0 ? mean(comparable) : 0
  // Zero-center the trial distribution; retain the total preregistered trial count.
  // Floor cross-trial SD at the iid unit-Sharpe null SE to avoid a degenerate hurdle.
  const sd =
    comparable.length > 1 ? Math.sqrt(sum(comparable.map((s) => (s - center) ** 2)) / (comparable.length - 1)) : 0
  const unitHurdle = expectedMaximumStandardNormal(trialCount)
  return unitHurdle === null ? null : unitHurdle * Math.max(sd, 1 / Math.sqrt(sessions - 1))
}

export const dsr = (days: readonly Outcome[], cost: Cost, threshold: number | null) => {
  const daily = days.map((d) => dailyNet(d, cost))
  return daily.some((d) => d === null)
    ? null
    : deflatedSharpe(
        daily.flatMap((d) => d ?? []),
        threshold,
      )
}

export const correlation = (pairs: readonly (readonly [number, number])[]) => {
  const n = pairs.length
  const activeTogether = pairs.filter(([left, right]) => left !== 0 && right !== 0).length
  if (n < 2) return { n, activeTogether, pearson: null }
  const x = mean(pairs.map(([left]) => left))
  const y = mean(pairs.map(([, right]) => right))
  const varX = sum(pairs.map(([left]) => (left - x) ** 2))
  const varY = sum(pairs.map(([, right]) => (right - y) ** 2))
  const cross = sum(pairs.map(([left, right]) => (left - x) * (right - y)))
  return { n, activeTogether, pearson: varX * varY > 0 ? cross / Math.sqrt(varX * varY) : null }
}

export const bySplit = (days: readonly Outcome[]) => ({
  legacy: days.filter((d) => split(d.date) === 'legacy'),
  train: days.filter((d) => split(d.date) === 'train'),
  validation: days.filter((d) => split(d.date) === 'validation'),
  holdout: days.filter((d) => split(d.date) === 'holdout'),
})
