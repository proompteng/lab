import { sha256, splits, type Tape } from './overnight-tugofwar-data'
import {
  anchors,
  capital,
  type Candidate,
  costs,
  ensembleId,
  executable,
  grid,
  neighbors,
} from './overnight-tugofwar-protocol'
import { blend, type Day, prepare, replay } from './overnight-tugofwar-replay'
import {
  annualDays,
  annualSharpe,
  type Benchmarks,
  bootstrap,
  compact,
  holm,
  inference,
  metrics,
  riskParity,
  series,
  stationaryPlan,
  sum,
  type Window,
} from './overnight-tugofwar-statistics'
import { dailySharpe, deflationBenchmark } from './research-orb-zab-statistics'

type Catalog = Map<string, Day[]>
const candidates = grid()
const ids = [...candidates.map(({ id }) => id), ensembleId]
const trialCount = ids.length * costs.length

function window(dates: readonly string[], start: string, end: string): Window {
  const from = dates.findIndex((date) => date >= start)
  const last = dates.findLastIndex((date) => date <= end)
  if (from < 0 || last < from) throw new Error(`Empty window ${start}–${end}`)
  return { from, to: last + 1 }
}
type Split = keyof typeof splits
const developmentSplits = ['train', 'validation'] as const
const splitNames = [...developmentSplits, 'holdout'] as const
const splitWindow = (dates: readonly string[], name: Split) => window(dates, splits[name].from, splits[name].through)

function benchmarks(tape: Tape): Benchmarks {
  const closeReturns = (symbol: string) => {
    const bars = tape.bars.get(symbol)
    if (bars === undefined) throw new Error(`Missing benchmark ${symbol}`)
    return bars.map((bar, i) => {
      const prior = bars[i - 1]
      if (bar === undefined || (i > 0 && prior === undefined))
        throw new Error(`Incomplete benchmark ${symbol} on ${tape.dates[i]}`)
      return prior !== undefined ? capital * (bar.close / prior.close - 1) : 0
    })
  }
  return { spy: closeReturns('SPY'), shy: closeReturns('SHY') }
}
const pathFor = (paths: Catalog, id: string) => {
  const path = paths.get(id)
  if (path === undefined) throw new Error(`Missing registered path: ${id}`)
  return path
}
const baseline = (market: ReturnType<typeof prepare>): Catalog =>
  new Map(candidates.map((candidate) => [candidate.id, replay(market, candidate)]))

export function develop(tape: Tape) {
  if (tape.dates.at(-1) !== splits.validation.through)
    throw new Error('Development must stop at the Validation boundary')
  const paths = baseline(prepare(tape))
  const bench = benchmarks(tape)
  const train = splitWindow(tape.dates, 'train')
  const validation = splitWindow(tape.dates, 'validation')
  const members = (['persistence', 'gap', 'etf'] as const).map((family) => {
    const ranked = candidates
      .filter((c) => c.family === family && executable(c))
      .flatMap(({ id }) => {
        const path = pathFor(paths, id)
        const trainSharpe = annualSharpe(series(path, bench, train, 2).excess)
        const validationSharpe = annualSharpe(series(path, bench, validation, 2).excess)
        return trainSharpe === null || validationSharpe === null
          ? []
          : [{ id, trainSharpe, validationSharpe, score: Math.min(trainSharpe, validationSharpe) }]
      })
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    const winner = ranked[0]
    if (winner === undefined) throw new Error(`No finite development representative in ${family}`)
    return winner
  })
  const weights = riskParity(members.map(({ id }) => series(pathFor(paths, id), bench, train, 2).pnl))
  const legs = members.map((member, i) => ({ ...member, weight: weights[i] }))
  paths.set(ensembleId, blend(legs.map(({ id, weight }) => ({ path: pathFor(paths, id), weight }))))
  const trialSharpes = ids.flatMap((id) =>
    costs.map((bp) => dailySharpe(series(pathFor(paths, id), bench, train, bp).excess)),
  )
  if (trialSharpes.some((x) => x === null)) throw new Error('Undefined daily Train excess Sharpe in the trial grid')
  const dsrBenchmark = deflationBenchmark(
    trialSharpes.filter((x): x is number => x !== null),
    trialCount,
  )
  if (dsrBenchmark === null) throw new Error('Cannot calibrate Train DSR')
  const developmentLedgerSha256 = sha256(JSON.stringify({ dates: tape.dates, bench, paths: [...paths] }))
  return { trialCount, developmentRows: tape.rows, developmentLedgerSha256, legs, dsrBenchmark }
}
type Selection = ReturnType<typeof develop>

function execution(path: readonly Day[], { from, to }: Window) {
  const days = path.slice(from, to)
  return {
    settledTrades: sum(days.map((day) => day.trades)),
    missedEntries: sum(days.map((day) => day.missedEntry)),
    lateExits: sum(days.map((day) => day.lateExit)),
    announcedExits: sum(days.map((day) => day.announcedExit)),
    maxOverduePositions: Math.max(...days.map((day) => day.carry)),
    terminalOverduePositions: days.at(-1)?.carry ?? 0,
  }
}

function etfDecomposition(tape: Tape, bench: Benchmarks) {
  const years = Array.from({ length: 11 }, (_, i) => String(2016 + i))
  const periods = [
    ...splitNames.map((name) => [name, splitWindow(tape.dates, name)] as const),
    ...years.map((year) => [year, window(tape.dates, `${year}-01-01`, `${year}-12-31`)] as const),
  ]
  return tape.universe.etfs.map((symbol) => {
    const bars = tape.bars.get(symbol)
    if (bars === undefined) throw new Error(`Missing ETF series: ${symbol}`)
    const paired: { index: number; on: number; id: number }[] = []
    let depth = 0
    for (const [index, bar] of bars.entries()) {
      const prior = bars[index - 1]
      if (bar !== undefined && prior !== undefined && depth >= 20)
        paired.push({ index, on: Math.log(bar.open / prior.close), id: Math.log(bar.close / bar.open) })
      depth = bar !== undefined ? depth + 1 : 0
    }
    return {
      symbol,
      anchor: anchors.some((anchor) => anchor === symbol),
      windows: Object.fromEntries(
        periods.map(([name, { from, to }]) => {
          const rows = paired.filter(({ index }) => index >= from && index < to)
          const overnight = sum(rows.map(({ on }) => on))
          const intraday = sum(rows.map(({ id }) => id))
          const down = rows.filter(({ index }) => bench.spy[index] < 0)
          const volatility = (returns: number[]) => {
            if (returns.length < 2) return null
            const mean = sum(returns) / returns.length
            return Math.sqrt((annualDays * sum(returns.map((x) => (x - mean) ** 2))) / (returns.length - 1))
          }
          return [
            name,
            {
              pairedDays: rows.length,
              overnightTotalReturn: rows.length > 0 ? Math.expm1(overnight) : null,
              intradayTotalReturn: rows.length > 0 ? Math.expm1(intraday) : null,
              closeToCloseTotalReturn: rows.length > 0 ? Math.expm1(overnight + intraday) : null,
              overnightAnnualVol: volatility(rows.map(({ on }) => Math.expm1(on))),
              intradayAnnualVol: volatility(rows.map(({ id }) => Math.expm1(id))),
              downSpyOvernightSumReturn: down.length > 0 ? sum(down.map(({ on }) => Math.expm1(on))) : null,
              downSpyIntradaySumReturn: down.length > 0 ? sum(down.map(({ id }) => Math.expm1(id))) : null,
            },
          ]
        }),
      ),
    }
  })
}

type Omission = { type: 'sector' | 'etf'; name: string }
const applies = (candidate: Candidate, omit: Omission) => (candidate.family === 'etf') === (omit.type === 'etf')
const omissionId = ({ type, name }: Omission) => `${type}:${name}`

export function score(tape: Tape, development: Selection, freezeCommit: string) {
  if (tape.dates.at(-1) !== splits.holdout.through) throw new Error('Score requires the full frozen tape')
  const market = prepare(tape)
  const bench = benchmarks(tape)
  const paths = baseline(market)
  const replayBlend = (omit?: Omission) =>
    blend(
      development.legs.map(({ id, weight }) => {
        const candidate = candidates.find((c) => c.id === id)
        if (candidate === undefined) throw new Error(`Unknown frozen blend member: ${id}`)
        return {
          weight,
          path:
            omit !== undefined && applies(candidate, omit) ? replay(market, candidate, omit.name) : pathFor(paths, id),
        }
      }),
    )
  paths.set(ensembleId, replayBlend())
  const windows = splitNames.map((name) => ({
    name,
    range: splitWindow(tape.dates, name),
    plan: stationaryPlan(splits[name].sessions),
  }))
  const years = Array.from({ length: 11 }, (_, i) => String(2016 + i)).map((year) => ({
    year,
    range: window(tape.dates, `${year}-01-01`, `${year}-12-31`),
  }))
  const omissions: Omission[] = [
    ...[...new Set(tape.universe.equities.values())].sort().map((name) => ({ type: 'sector' as const, name })),
    ...tape.universe.etfs.map((name) => ({ type: 'etf' as const, name })),
  ]
  type Audit = { omission: string; netUsd: number; excessUsd: number; sharpe: number | null; deltaNetUsd: number }
  const evaluated = ids.map((id) => {
    const path = pathFor(paths, id)
    const candidate = candidates.find((c) => c.id === id)
    const trialCosts = costs.map((bp) => ({
      bp,
      windows: windows.map(({ name, range, plan }) => ({
        name,
        ...metrics(path, bench, range, bp),
        ...inference(series(path, bench, range, bp).excess, plan, development.dsrBenchmark),
        holmP: 1,
        plateauPct: 0,
        leaveOneOut: [] as Audit[],
      })),
      years: Object.fromEntries(years.map(({ year, range }) => [year, metrics(path, bench, range, bp)])),
    }))
    for (const omit of omissions) {
      if (candidate !== undefined && !applies(candidate, omit)) continue
      const omitted = candidate !== undefined ? replay(market, candidate, omit.name) : replayBlend(omit)
      for (const byCost of trialCosts) {
        for (const [i, { range }] of windows.entries()) {
          const record = byCost.windows[i]
          const sensitivity = compact(omitted, bench, range, byCost.bp)
          record.leaveOneOut.push({
            omission: omissionId(omit),
            ...sensitivity,
            deltaNetUsd: sensitivity.netUsd - record.netUsd,
          })
        }
      }
    }
    return {
      id,
      config: candidate ?? { id, family: 'ensemble', legs: development.legs },
      auctionTimingEligible: candidate === undefined || executable(candidate),
      costs: trialCosts,
      execution: windows.map(({ name, range }) => ({ name, ...execution(path, range) })),
      pairedTugOfWar:
        candidate?.family === 'persistence'
          ? windows.map(({ name, range: { from, to } }) => {
              const rows = path.slice(from, to)
              return {
                name,
                grossSameOvernightUsd: sum(rows.map((day) => day.matchedOvernightPnl)),
                grossOppositeIntradayUsd: sum(rows.map((day) => day.oppositePnl)),
                unmatchedExits: sum(rows.map((day) => day.oppositeMissing)),
              }
            })
          : null,
    }
  })
  const economicsPass = (m: { netUsd: number; excessUsd: number; exTop5Usd: number | null }) =>
    m.netUsd > 0 && m.excessUsd > 0 && (m.exTop5Usd ?? 0) > 0
  for (const [i] of windows.entries()) {
    const all = evaluated.flatMap((c) => c.costs.map(({ windows }) => windows[i]))
    const adjusted = holm(all.map(({ stationaryP }) => stationaryP))
    for (const [j, record] of all.entries()) record.holmP = adjusted[j]
    for (const trial of evaluated) {
      const candidate = candidates.find(({ id }) => id === trial.id)
      const peers =
        candidate !== undefined
          ? candidates.filter((c) => neighbors(candidate, c)).map(({ id }) => id)
          : development.legs.map(({ id }) => id)
      if (peers.length === 0) throw new Error(`Missing registered plateau neighborhood: ${trial.id}`)
      for (const [j, cost] of trial.costs.entries()) {
        const passing = evaluated.filter(({ id, costs }) => peers.includes(id) && economicsPass(costs[j].windows[i]))
        cost.windows[i].plateauPct = (100 * passing.length) / peers.length
      }
    }
  }

  const configurations = evaluated.map((trial) => {
    const atTwo = trial.costs[0].windows
    const holdout = atTwo[2]
    const reasons = [
      ...(!trial.auctionTimingEligible ? ['requires-final-open-before-the-opening-auction'] : []),
      ...(trial.costs.slice(0, 3).every(({ windows }) => windows.every(economicsPass))
        ? []
        : ['net-excess-ex-top-5-at-2-5-10-bp']),
      ...(atTwo.slice(1).every((w) => w.holmP <= 0.05 && (w.dsr ?? 0) >= 0.95)
        ? []
        : ['validation-and-holdout-holm-and-dsr']),
      ...(atTwo.every((w) => w.plateauPct >= 50) ? [] : ['multi-split-plateau']),
      ...(holdout.leaveOneOut.filter((x) => x.netUsd > 0 && x.excessUsd > 0).length / holdout.leaveOneOut.length >= 0.8
        ? []
        : ['holdout-leave-one-out']),
      ...(trial.execution.every((w) => w.maxOverduePositions === 0) ? [] : ['auction-exits-not-always-observed']),
    ]
    return { ...trial, advanceGatePassed: reasons.length === 0, failedGates: reasons }
  })
  const eligibleToAdvance = configurations.filter((x) => x.advanceGatePassed).map(({ id }) => id)
  return {
    schema: 'bayn.overnight-tugofwar.results.v1',
    freezeCommit,
    splits,
    rowCount: tape.rows,
    configuredEquities: tape.universe.equities.size,
    etfs: tape.universe.etfs.length,
    barCoverage: [...tape.bars].map(([symbol, bars]) => {
      const first = bars.findIndex((bar) => bar !== undefined)
      const last = bars.findLastIndex((bar) => bar !== undefined)
      const observed = bars.reduce((count, bar) => count + Number(bar !== undefined), 0)
      return {
        symbol,
        eligibleUniverse: tape.universe.equities.has(symbol) || tape.universe.etfs.includes(symbol),
        first: tape.dates[first],
        last: tape.dates[last],
        observed,
        internalMissing: last - first + 1 - observed,
      }
    }),
    development,
    capital,
    bootstrap,
    configurations,
    etfDecomposition: etfDecomposition(tape, bench),
    eligibleToAdvance,
  }
}
