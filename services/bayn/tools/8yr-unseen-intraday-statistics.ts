import {
  blind,
  prior,
  baselineNames,
  listingDates,
  noiseNames,
  parameters as p,
  roster,
  stocks,
} from './8yr-unseen-intraday-protocol'
import { createPreparation, ids, netAt, replayDay, type Id, type Ledger, type Pnl } from './8yr-unseen-intraday-replay'
import type { Day } from './8yr-unseen-intraday-tape'
import {
  dailySharpe,
  mean,
  stationaryBootstrap,
  StationaryCentering,
  stationaryMeanP,
  type StationaryPlan,
  sum,
} from './research-lib/statistics'

export const stationaryPlan = (sessions: number, draws: number = p.bootstrap.draws) =>
  stationaryBootstrap(sessions, { draws, meanBlock: p.bootstrap.meanBlockSessions, seed: p.bootstrap.seed })

const add = (target: Pnl, source: Pnl) => {
  target.base += source.base
  target.slope += source.slope
}
const zero = () => ({ base: 0, slope: 0 })
const trimTop = (daily: readonly number[], k: number, net: number) =>
  net -
  sum(
    daily
      .filter((d) => d > 0)
      .sort((a, b) => b - a)
      .slice(0, k),
  )
export const summarize = (ledgers: readonly Ledger[], cost: number, plan: StationaryPlan) => {
  const daily = ledgers.map((row) => netAt(row, cost))
  const closed = sum(daily)
  const unresolvedDays = ledgers.filter(({ unresolved }) => unresolved > 0).length
  const coverage = {
    sessions: ledgers.length,
    activeDays: ledgers.filter(({ trades, unresolved }) => trades + unresolved > 0).length,
    unresolvedDays,
    closedLegsNetUsd: closed,
    missingEntries: sum(ledgers.map(({ missingEntries }) => missingEntries)),
    heldGaps: sum(ledgers.map(({ heldGaps }) => heldGaps)),
    peakReservedGrossUsd: Math.max(0, ...ledgers.map(({ peakGross }) => peakGross)),
  }
  const incomplete = {
    netUsd: null,
    exTop5Usd: null,
    exTop10Usd: null,
    sharpe: null,
    maxDrawdownUsd: null,
    calmar: null,
    breakevenRtBps: null,
    winRate: null,
    profitFactor: null,
    stationaryBootstrapP: null,
  }
  if (unresolvedDays > 0) return { ...coverage, ...incomplete }
  let pnl = 0
  let peak = 0
  let drawdown = 0
  for (const value of daily) {
    pnl += value
    peak = Math.max(peak, pnl)
    drawdown = Math.max(drawdown, peak - pnl)
  }
  const winners = daily.filter((value) => value > 0)
  const loss = -sum(daily.filter((value) => value < 0))
  const slope = sum(ledgers.map((row) => row.slope))
  const sharpe = dailySharpe(daily)
  return {
    ...coverage,
    netUsd: closed,
    exTop5Usd: trimTop(daily, 5, closed),
    exTop10Usd: trimTop(daily, 10, closed),
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(252),
    maxDrawdownUsd: drawdown,
    calmar: drawdown > 0 ? (closed * 252) / (ledgers.length * drawdown) : null,
    breakevenRtBps: slope > 0 ? sum(ledgers.map((row) => row.base)) / slope : null,
    winRate: coverage.activeDays > 0 ? winners.length / coverage.activeDays : null,
    profitFactor: loss > 0 ? sum(winners) / loss : null,
    stationaryBootstrapP: stationaryMeanP(daily, plan, StationaryCentering.AfterSum),
  }
}

type CorrelationSeries = readonly (Pnl & { unresolved: number })[]
const pearson = (a: CorrelationSeries, b: CorrelationSeries, cost: number) => {
  const matched = a.flatMap((row, i) =>
    row.unresolved + b[i].unresolved > 0 ? [] : [[netAt(row, cost), netAt(b[i], cost)]],
  )
  const x = mean(matched.map(([value]) => value))
  const y = mean(matched.map(([, value]) => value))
  let xy = 0
  let xx = 0
  let yy = 0
  for (const [left, right] of matched) {
    xy += (left - x) * (right - y)
    xx += (left - x) ** 2
    yy += (right - y) ** 2
  }
  return { pairedSessions: matched.length, correlation: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null }
}
const matrix = (series: Readonly<Record<string, CorrelationSeries>>, cost: number) =>
  Object.fromEntries(
    Object.entries(series).map(([name, a]) => [
      name,
      Object.fromEntries(Object.entries(series).map(([other, b]) => [other, pearson(a, b, cost)])),
    ]),
  )
const attribution = (ledgers: readonly Ledger[], cost: number) => {
  const bySymbol = new Map<string, Pnl>()
  for (const ledger of ledgers) {
    for (const [symbol, leg] of ledger.symbols) {
      const value = bySymbol.get(symbol) ?? zero()
      add(value, leg)
      bySymbol.set(symbol, value)
    }
  }
  const groups = {
    pre2016LargeCaps: 0,
    since2019RegularWay: 0,
    other: 0,
  }
  const symbolNetUsd = Object.fromEntries(
    [...bySymbol.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([symbol, value]) => [symbol, netAt(value, cost)]),
  )
  const large = new Set<string>(p.megaCaps)
  for (const [symbol, net] of Object.entries(symbolNetUsd)) {
    if (large.has(symbol)) groups.pre2016LargeCaps += net
    else if ((listingDates[symbol] ?? '') >= p.recentEntryFrom) groups.since2019RegularWay += net
    else groups.other += net
  }
  return { closedLegsNetUsdBySymbol: symbolNetUsd, closedLegsNetUsdByGroup: groups }
}

const omissionsFor = (id: Id): readonly string[] => {
  const variant = roster[id]
  if (variant.engine === 'baseline') return [...baselineNames, ...noiseNames]
  if (variant.engine === 'noise') return noiseNames
  return variant.engine === 'portfolio' && variant.sleeves.length === 3 ? [...stocks, ...noiseNames] : stocks
}

type Omission = Pnl & { unresolved: number }
const worstLosso = (runs: ReadonlyMap<string, Omission>, cost: number) => {
  const resolved = [...runs.entries()]
    .filter(([, row]) => row.unresolved === 0)
    .map(([symbol, row]) => ({ symbol, netUsd: netAt(row, cost) }))
    .sort((a, b) => a.netUsd - b.netUsd || a.symbol.localeCompare(b.symbol, 'en'))
  return {
    omissions: runs.size,
    complete: resolved.length,
    positive: resolved.filter(({ netUsd }) => netUsd > 0).length,
    worstKnown: resolved[0] ?? null,
  }
}

const equityCurve = (daily: readonly Ledger[], cost: number) => {
  let equity: number | null = p.equityUsd
  return daily.map((day) => {
    equity = day.unresolved > 0 || equity === null ? null : equity + netAt(day, cost)
    return equity === null ? null : Math.round(equity * 100) / 100
  })
}

export const evaluate = (days: readonly Day[], signal: AbortSignal) => {
  if (
    days.length !== blind.sessions + prior.sessions ||
    days[0]?.date !== blind.first ||
    days[blind.sessions - 1]?.date !== blind.last ||
    days[blind.sessions]?.date !== prior.first ||
    days.at(-1)?.date !== prior.last ||
    days.some(({ date }, i) => i > 0 && date <= days[i - 1].date)
  ) {
    throw new Error('Expected one chronological path of 2,012 blind and 729 distinct prior sessions')
  }
  const dates = days.map(({ date }) => date)
  const annual = [...new Set(dates.map((date) => date.slice(0, 4)))].filter((y) => y < '2024')
  if (annual.length !== 8) throw new Error('Expected 8 blind calendar years')
  const windows = [
    ...annual.map((year) => ({
      label: year,
      from: dates.findIndex((date) => date.startsWith(year)),
      until: dates.findLastIndex((date) => date.startsWith(year)) + 1,
    })),
    { label: 'blind', from: 0, until: blind.sessions },
    { label: 'priorContinuity', from: blind.sessions, until: days.length },
    { label: 'stitched', from: 0, until: days.length },
  ]
  const ledgers = new Map<Id, Ledger[]>()
  const omissions = new Map(ids.map((id) => [id, omissionsFor(id)]))
  const leaveOneOut = windows.map(
    () =>
      new Map(
        ids.map((id) => [id, new Map(omissions.get(id)?.map((symbol) => [symbol, { ...zero(), unresolved: 0 }]))]),
      ),
  )
  const rosterSizesByYear = new Map<string, number[]>()
  const firstEligible = new Map<string, string>()
  const prepare = createPreparation()
  for (const [index, day] of days.entries()) {
    signal.throwIfAborted()
    const prepared = prepare(day)
    const year = day.date.slice(0, 4)
    const counts = rosterSizesByYear.get(year) ?? []
    counts.push(prepared.activeStocks.length)
    rosterSizesByYear.set(year, counts)
    for (const symbol of prepared.activeStocks) if (!firstEligible.has(symbol)) firstEligible.set(symbol, day.date)
    const applicable = leaveOneOut.filter((_, w) => windows[w].from <= index && index < windows[w].until)
    for (const id of ids) {
      const daily = ledgers.get(id) ?? []
      daily.push(replayDay(prepared, id))
      ledgers.set(id, daily)
      for (const symbol of omissions.get(id) ?? []) {
        const result = replayDay(prepared, id, symbol, false)
        for (const window of applicable) {
          const row = window.get(id)?.get(symbol)
          if (row === undefined) throw new Error(`Missing LOSO accumulator (${id}, ${symbol})`)
          add(row, result)
          row.unresolved += result.unresolved
        }
      }
    }
  }
  const path = (id: Id) => {
    const daily = ledgers.get(id)
    if (daily === undefined) throw new Error(`Missing ledger for ${id}`)
    return daily
  }
  return {
    candidates: roster,
    activeStocksByYear: Object.fromEntries(
      [...rosterSizesByYear].map(([year, counts]) => [
        year,
        { min: Math.min(...counts), mean: mean(counts), max: Math.max(...counts), last: counts.at(-1) },
      ]),
    ),
    firstEligibleByStock: Object.fromEntries([...firstEligible].sort(([a], [b]) => a.localeCompare(b, 'en'))),
    windows: Object.fromEntries(
      windows.map(({ label, from, until }, i) => {
        signal.throwIfAborted()
        const plan = stationaryPlan(until - from)
        const rows = (id: Id) => path(id).slice(from, until)
        return [
          label,
          {
            start: dates[from],
            end: dates[until - 1],
            sessions: until - from,
            costsRtBps: Object.fromEntries(
              p.costsRtBps.map((cost) => [
                cost,
                {
                  standaloneCorrelation: matrix(
                    { orb: rows('C2'), reversion: rows('C4_timed'), noise: rows('C5') },
                    cost,
                  ),
                  candidates: Object.fromEntries(
                    ids.map((id) => {
                      const ledger = rows(id)
                      const omitted = leaveOneOut[i].get(id)
                      if (omitted === undefined) throw new Error(`Missing LOSO window (${label}, ${id})`)
                      const variant = roster[id]
                      const combined = variant.engine === 'baseline' || variant.engine === 'portfolio'
                      return [
                        id,
                        {
                          ...summarize(ledger, cost, plan),
                          worstLosso: worstLosso(omitted, cost),
                          attribution: attribution(ledger, cost),
                          ...(combined
                            ? {
                                sleeveCorrelation: matrix(
                                  {
                                    orb: ledger.map((day) => day.sleeves.orb),
                                    reversion: ledger.map((day) => day.sleeves.reversion),
                                    ...(id === 'C6' ? {} : { noise: ledger.map((day) => day.sleeves.noise) }),
                                  },
                                  cost,
                                ),
                              }
                            : {}),
                        },
                      ]
                    }),
                  ),
                },
              ]),
            ),
          },
        ]
      }),
    ),
    dailyEquityUsd: {
      startingEquity: p.equityUsd,
      dates,
      byCostRtBps: Object.fromEntries(
        p.costsRtBps.map((cost) => [cost, Object.fromEntries(ids.map((id) => [id, equityCurve(path(id), cost)]))]),
      ),
    },
  }
}
