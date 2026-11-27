import prior from '../../../docs/bayn/evidence/2026-11-27-46stock-intraday-v3/prior-sharpe.json'
import {
  costs,
  equity,
  halfYears,
  noiseSymbols,
  orbControl,
  orbTrials,
  portfolios,
  reversionControl,
  reversionTrials,
  sleeves,
  stocks,
  stressCosts,
  windows,
  type Trial,
  type Window,
} from './intraday-v3-protocol'
import { netAt, replayBook, type Ledger } from './intraday-v3-replay'
import { type PreparedDay } from './intraday-v3-signals'
import {
  bootstrapPValue,
  dailySharpe,
  deflatedSharpe,
  expectedMaximumStandardNormal,
  mean,
  sum,
} from './midday-research-statistics'

type Cost = (typeof costs)[number]
const splits = ['train', 'validation', 'holdout'] as const
type Book = ReturnType<typeof replayBook>
const get = (book: Book, id: string) => {
  const result = book.get(id)
  if (result === undefined) throw new Error(`Missing ledger for ${id}`)
  return result
}
const complete = (daily: readonly Ledger[], cost: Cost) => {
  const values: number[] = []
  for (const day of daily) {
    const net = netAt(day, cost)
    if (net === null) return null
    values.push(net)
  }
  return values
}
const covered = <T extends { readonly date: string }>(days: readonly T[], window: Window) => {
  const [from, to, expected] = windows[window]
  const selected = days.flatMap(({ date }, index) => (date >= from && date <= to ? [index] : []))
  const first = selected[0]
  if (selected.length !== expected || first === undefined) {
    throw new Error(`Expected ${expected} ${window} sessions, got ${selected.length}`)
  }
  return { first, end: first + expected }
}
type Span = ReturnType<typeof covered>
const exTop = (values: readonly number[], count: number) => sum(values.toSorted((a, b) => b - a).slice(count))
const economic = (daily: readonly Ledger[]) =>
  stressCosts.map((cost) => {
    const values = complete(daily, cost)
    return { cost, net: values === null ? null : sum(values), exTop5: values === null ? null : exTop(values, 5) }
  })
const positive = (value: number | null) => value !== null && value > 0
const pass = (rows: ReturnType<typeof economic>) => rows.every(({ net, exTop5 }) => positive(net) && positive(exTop5))

export const selectDevelopment = (days: readonly PreparedDay[], signal?: AbortSignal) => {
  const train = covered(days, 'train')
  const validation = covered(days, 'validation')
  if (days.length !== validation.end) throw new Error('Development cannot receive holdout sessions')
  const solo = replayBook(days.slice(train.first, train.end), sleeves, '', signal)
  const rank = <T extends Trial>(trials: readonly T[], control: string) => {
    const score = (trial: T) => Math.min(...economic(get(solo, trial.id)).map(({ exTop5 }) => exTop5 ?? -Infinity))
    const scored = trials.map((trial) => ({ trial, score: score(trial) }))
    return scored
      .sort((a, b) => b.score - a.score || a.trial.id.localeCompare(b.trial.id, 'en'))
      .filter(({ trial, score }, i) => (i < 3 && Number.isFinite(score)) || trial.id === control)
      .map(({ trial }) => trial)
  }
  const orbs = rank(orbTrials, orbControl)
  const reversions = rank(reversionTrials, reversionControl)
  const registry = [...sleeves, ...portfolios(orbs, reversions)]
  const ledgers = replayBook(days, registry, '', signal)
  const development = registry.map((trial) => {
    const daily = get(ledgers, trial.id)
    const trainRows = economic(daily.slice(train.first, train.end))
    const validationRows = economic(daily.slice(validation.first, validation.end))
    return { trial, train: trainRows, validation: validationRows, nominated: pass(trainRows) && pass(validationRows) }
  })
  return { orbs: orbs.map((trial) => trial.id), reversions: reversions.map((trial) => trial.id), development }
}

const moments = (values: readonly number[]) => {
  const center = values.length === 0 ? 0 : mean(values)
  return { count: values.length, mean: center, m2: sum(values.map((value) => (value - center) ** 2)) }
}
const benchmark = (window: Window, cost: Cost, arrays: readonly (readonly number[] | null)[]) => {
  const current = moments(
    arrays.flatMap((values) => {
      const sharpe = values === null ? null : dailySharpe(values)
      return sharpe === null ? [] : [sharpe]
    }),
  )
  const past = prior.moments[window][cost]
  const trialCount = arrays.length + sum(prior.sources.map(({ trials }) => trials))
  const known = past.count + current.count
  const pooledM2 = past.m2 + current.m2 + ((past.mean - current.mean) ** 2 * past.count * current.count) / known
  const expected = expectedMaximumStandardNormal(trialCount)
  return {
    trialCount,
    knownSharpes: known,
    dailyBenchmark: expected === null ? null : expected * Math.sqrt(pooledM2 / (known - 1)),
  }
}

const maxDrawdown = (values: readonly number[]) => {
  let cumulative = 0
  let high = 0
  let drawdown = 0
  for (const value of values) {
    cumulative += value
    high = Math.max(high, cumulative)
    drawdown = Math.max(drawdown, high - cumulative)
  }
  return drawdown
}

const pearson = (a: readonly number[] | null, b: readonly number[] | null) => {
  if (a === null || b === null) return null
  const left = mean(a)
  const right = mean(b)
  let xx = 0
  let yy = 0
  let xy = 0
  for (const [i, value] of a.entries()) {
    const x = value - left
    const y = b[i] - right
    xx += x * x
    yy += y * y
    xy += x * y
  }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null
}

const netMetrics = (daily: readonly Ledger[], bps: Cost, deflation: number | null) => {
  const values = complete(daily, bps)
  const net = values === null ? null : sum(values)
  const drawdown = values === null ? null : maxDrawdown(values)
  const sharpe = values === null ? null : dailySharpe(values)
  const turnover = sum(daily.map((day) => day.turnoverAfterFee))
  return [
    net,
    sharpe === null ? null : sharpe * Math.sqrt(252),
    drawdown,
    net === null || drawdown === null || drawdown === 0 ? null : (net * 252) / daily.length / drawdown,
    values === null || turnover === 0 ? null : (20_000 * sum(daily.map((day) => day.netBeforeSlippage))) / turnover,
    values === null ? null : exTop(values, 5),
    values === null ? null : exTop(values, 10),
    values === null ? null : bootstrapPValue(values),
    values === null ? null : deflatedSharpe(values, deflation),
  ] as const
}

const summarize = (daily: readonly Ledger[]) => [
  daily.filter(({ trades, unresolved }) => trades + unresolved > 0).length,
  sum(daily.map((day) => day.trades)),
  sum(daily.map((day) => day.unresolved)),
  sum(daily.map((day) => day.canceledMissing)),
  sum(daily.map((day) => day.heldGaps)),
  sum(daily.map((day) => day.conflicts)),
  sum(daily.map((day) => day.capSkips)),
  Math.max(...daily.map((day) => day.peakGross)),
]

const losoSymbols = (trial: Trial): readonly string[] =>
  trial.engine === 'noise'
    ? noiseSymbols
    : trial.engine === 'portfolio' && trial.noise !== null
      ? [...stocks, ...noiseSymbols]
      : stocks
const windowOrder = Object.keys(windows) as Window[]
const slice = (days: readonly Ledger[], { first, end }: Span) => days.slice(first, end)

export const score = (
  days: readonly PreparedDay[],
  selection: ReturnType<typeof selectDevelopment>,
  signal?: AbortSignal,
) => {
  const spans = windowOrder.map((window) => covered(days, window))
  const registry = selection.development.map(({ trial }) => trial)
  const book = replayBook(days, registry, '', signal)
  const deflation = spans.map((span, i) =>
    costs.map((cost) =>
      benchmark(
        windowOrder[i],
        cost,
        registry.map(({ id }) => complete(slice(get(book, id), span), cost)),
      ),
    ),
  )
  const worst = new Map(
    registry.map((trial) => [
      trial.id,
      spans.map(() =>
        costs.map(() => ({
          symbol: null as string | null,
          net: null as number | null,
          known: 0,
          positive: 0,
        })),
      ),
    ]),
  )
  for (const symbol of [...stocks, ...noiseSymbols]) {
    const omittedBook = replayBook(days, registry, symbol, signal)
    for (const trial of registry) {
      if (!losoSymbols(trial).includes(symbol)) continue
      const windows = worst.get(trial.id)
      if (windows === undefined) throw new Error('Missing LOSO row')
      for (const [wi, { first, end }] of spans.entries()) {
        const daily = get(omittedBook, trial.id)
        let base = 0
        let turnover = 0
        let resolved = true
        for (let i = first; i < end; i++) {
          const row = daily[i]
          if (row.unresolved !== 0) {
            resolved = false
            break
          }
          base += row.netBeforeSlippage
          turnover += row.turnoverAfterFee
        }
        if (!resolved) continue
        for (const [ci, cost] of costs.entries()) {
          const net = base - (turnover * cost) / 20_000
          const row = windows[wi][ci]
          row.known++
          if (net > 0) row.positive++
          if (row.net === null || net < row.net) {
            row.net = net
            row.symbol = symbol
          }
        }
      }
    }
  }
  const results = selection.development.map(({ trial, nominated }) => {
    signal?.throwIfAborted()
    const daily = get(book, trial.id)
    const rows = spans.map((span, i) =>
      costs.map((cost, j) => netMetrics(slice(daily, span), cost, deflation[i][j].dailyBenchmark)),
    )
    const splitPass = splits.map((window) => pass(economic(slice(daily, spans[windowOrder.indexOf(window)]))))
    const positiveHalfYears = halfYears.filter((window) =>
      economic(slice(daily, spans[windowOrder.indexOf(window)])).every(({ net }) => positive(net)),
    )
    const qualified = nominated && splitPass.every(Boolean) && positiveHalfYears.length >= 5
    const correlations =
      trial.engine !== 'portfolio'
        ? null
        : spans.map((span) =>
            costs.map((cost) => {
              const x = complete(slice(get(book, trial.orb.id), span), cost)
              const y = complete(slice(get(book, trial.reversion.id), span), cost)
              const z = trial.noise === null ? null : complete(slice(get(book, trial.noise.id), span), cost)
              return [pearson(x, y), pearson(x, z), pearson(y, z)]
            }),
          )
    return {
      trial,
      nominated,
      splitPass,
      positiveHalfYears,
      qualified,
      coverage: spans.map((span) => summarize(slice(daily, span))),
      rows,
      correlations,
      loso: { attempts: losoSymbols(trial).length, worst: worst.get(trial.id) },
    }
  })
  return {
    startingEquityUsd: equity,
    windowOrder,
    costOrder: costs,
    splitOrder: splits,
    metricColumns: [
      'netUsd',
      'annualizedSharpe',
      'maxDrawdownUsd',
      'calmar',
      'breakevenRtBps',
      'exTop5Usd',
      'exTop10Usd',
      'blockBootstrapP',
      'dsr',
    ],
    coverageColumns: [
      'activeDays',
      'closedLegs',
      'unresolvedLegs',
      'missingEntryOrders',
      'heldGaps',
      'occupancyConflicts',
      'capSkips',
      'peakConcurrentReservedGrossUsd',
    ],
    correlationColumns: ['orb/reversion', 'orb/noise', 'reversion/noise'],
    deflation,
    trials: results,
    qualifiedPortfolios: results
      .filter(({ trial, qualified }) => trial.engine === 'portfolio' && qualified)
      .map(({ trial }) => trial.id),
  }
}
