import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { S3Client } from 'bun'
import { Config, Data, Effect, Redacted } from 'effect'

import { type Tape, universes, wdcExit } from './daily-alpha-data'
import { signalPlanners, type Plan } from './daily-alpha-signals'
import {
  capital,
  createAccount,
  frictionBps,
  intradayLimit,
  noIntraday,
  tiers,
  type CashMode,
  type Daily,
  type EquityMode,
  type Intraday,
  type Sleeve,
} from './master-portfolio-account'
import { lastDay, loadResearchData, type Sp100Tape } from './master-portfolio-data'
import { etfBooks, etfs, type Weights } from './master-portfolio-etf'
import { replay3B } from './master-portfolio-intraday'
import { prepareDays } from './master-portfolio-intraday-signals'
import { mmcLastSession, mmcSuccessorStart, sp100Targets } from './master-portfolio-sp100'
import { correlation, equityCurve, summarize } from './master-portfolio-statistics'
import { loadSip } from './sip-bayn21-data'
import { createReplay, liveArchitecture, liveIdentity, simulate } from './sip-bayn21-replay'

const start2016 = '2016-01-04'
const start2021 = '2021-01-04'
const startOverlap = '2024-01-02'
const bands = [
  ['train', start2016, '2021-12-31'],
  ['validation', '2022-01-03', '2023-12-29'],
  ['holdout', startOverlap, lastDay],
] as const
const roundPct = (value: number) => Number((100 * value).toFixed(4))
const indexDates = (dates: readonly string[]) => new Map(dates.map((date, i) => [date, i]))
const noPlan: Plan = new Map()

function fromDaily(tape: Sp100Tape) {
  const indices = indexDates(tape.dates)
  const bySymbol = new Map(tape.series.map((series) => [series.symbol, series]))
  const mark: Sleeve['mark'] = (symbol, date, phase) => {
    const i = indices.get(date)
    return i === undefined ? undefined : bySymbol.get(symbol)?.[phase][i]
  }
  const etfSessions = tape.dates.map((date, i) => ({
    date,
    bars: etfs.map((symbol) => {
      const series = bySymbol.get(symbol)
      if (series === undefined) throw new Error(`Missing ETF ${symbol}`)
      if (series.open[i] === 0) {
        const xlcListing = symbol === 'XLC' && date < '2018-06-19'
        const xlreGap = symbol === 'XLRE' && (date === '2016-01-25' || date === '2016-02-16')
        if (!xlcListing && !xlreGap) throw new Error(`Unexpected ETF gap: ${symbol} ${date}`)
        return undefined
      }
      return { open: series.open[i], close: series.close[i] }
    }),
  }))
  const { s1, s2 } = etfBooks(etfSessions)
  const etfSleeve = (book: readonly Weights[], weight: number, from: string): Sleeve => ({
    weight,
    mark,
    open: (date) => {
      const day = indices.get(date)
      if (day === undefined) throw new Error(`Missing daily session ${date}`)
      const desired = book[day - 1]
      const previous = date === from ? undefined : book[day - 2]
      if (desired === undefined) return undefined
      const positions = new Map<string, number>()
      for (const [i, symbol] of etfs.entries())
        if (Math.abs(desired[i] - (previous?.[i] ?? 0)) > 1e-12) positions.set(symbol, desired[i])
      return { unit: 'dollars', positions, partial: true }
    },
  })
  const markets = tape.dates.map((date, i) => {
    const ret = (symbol: string) => {
      const today = mark(symbol, date, 'close')
      const yesterday = i === 0 ? today : mark(symbol, tape.dates[i - 1], 'close')
      if (today === undefined || yesterday === undefined) throw new Error(`Missing benchmark ${symbol} ${date}`)
      return today / yesterday - 1
    }
    return { date, shy: ret('SHY'), spy: ret('SPY'), ief: ret('IEF') }
  })
  return { markets, s1, s2, etfSleeve, mark, indices }
}

function fromWave2(tape: Tape) {
  const indices = indexDates(tape.dates)
  const planner = signalPlanners(tape)({
    family: 'momentum',
    execution: 'open-open',
    universe: 'expanded-stocks',
    lookback: 60,
    fit: 60,
    k: 4,
    hold: 10,
    skip: 1,
    volumeVeto: false,
  })
  let current = noPlan
  const plans = tape.dates.map((date, i) => {
    const update = planner(i, 'open')
    if (update !== undefined) current = update
    const startingPlan = current
    if (date === wdcExit) current = new Map([...current].filter(([symbol]) => symbol !== 'WDC'))
    return { update, startingPlan }
  })
  return (weight: number, from: string): Sleeve => ({
    weight,
    mark: (symbol, date, phase) => {
      const i = indices.get(date)
      return i === undefined ? undefined : tape.prices.get(symbol)?.bars[i]?.[phase]
    },
    open: (date) => {
      const i = indices.get(date)
      if (i === undefined) throw new Error(`Missing Wave 2A session ${date}`)
      const positions = date === from ? plans[i].startingPlan : plans[i].update
      return positions === undefined ? undefined : { unit: 'shares', positions }
    },
    closeExit: (symbol, date) => symbol === 'WDC' && date === wdcExit,
  })
}

function wave3a(tape: Sp100Tape, daily: ReturnType<typeof fromDaily>, signal: AbortSignal) {
  const mmc = tape.series.find(({ symbol }) => symbol === 'MMC')
  const lastIndex = daily.indices.get(mmcLastSession)
  const successorIndex = daily.indices.get(mmcSuccessorStart)
  if (
    mmc === undefined ||
    lastIndex === undefined ||
    successorIndex !== lastIndex + 1 ||
    mmc.close[lastIndex] <= 0 ||
    mmc.open[successorIndex] !== 0 ||
    mmc.close.subarray(successorIndex).some((close) => close > 0) ||
    tape.series.some(({ symbol }) => symbol === 'MRSH')
  ) {
    throw new Error('Frozen MMC/MRSH continuity evidence does not match the registered corporate action')
  }
  const build = (method: 'original' | 'causal-exit' | 'ex-mmc'): Sleeve => {
    const targets = sp100Targets(tape, method)
    return {
      weight: 1,
      mark: daily.mark,
      open: (date) => {
        const i = daily.indices.get(date)
        if (i === undefined) throw new Error(`Missing SP100 date: ${date}`)
        const positions = new Map<string, number>()
        if (i > 0)
          for (const [j, series] of tape.series.entries()) {
            const target = targets[i - 1][j] * 1.5
            if (target !== 0) {
              const reference = series.close[i - 1]
              if (reference <= 0) throw new Error(`Missing SP100 sizing close: ${series.symbol} ${date}`)
              positions.set(series.symbol, target / reference)
            }
          }
        return { unit: 'shares', positions }
      },
      closeExit: (symbol, date) => method === 'causal-exit' && symbol === 'MMC' && date === mmcLastSession,
    }
  }
  const holdout = daily.markets.filter(({ date }) => date >= startOverlap)
  const original = createAccount({
    overnight: [build('original')],
    weight: 0,
    tier: tiers.harsh,
    cash: 'zero',
    equity: 'fixed',
  })
  const originalFailure = `Missing MMC open price on ${mmcSuccessorStart}`
  try {
    holdout.forEach(original)
    throw new Error('Expected missing MMC opening mark was not reproduced')
  } catch (error) {
    if (!(error instanceof Error && error.message === originalFailure)) throw error
  }

  const exits = { 'causal-exit': build('causal-exit'), 'ex-mmc': build('ex-mmc') }
  return {
    originalFailure,
    ticker: {
      predecessor: 'MMC',
      successor: 'MRSH',
      announced: '2025-12-29',
      lastClose: mmcLastSession,
      lastClosePrice: mmc.close[lastIndex],
      missingFrom: mmcSuccessorStart,
      successorBars: 0,
    },
    variants: Object.fromEntries(
      Object.entries(exits).map(([name, sleeve]) => [
        name,
        Object.fromEntries(
          Object.entries(tiers).map(([tier, costs]) => {
            signal.throwIfAborted()
            const run = (from: string, through: string) =>
              daily.markets
                .filter(({ date }) => date >= from && date <= through)
                .map(createAccount({ overnight: [sleeve], weight: 0, tier: costs, cash: 'zero', equity: 'fixed' }))
            const full = run(start2016, lastDay)
            return [
              tier,
              {
                full: summarize(full, 'fixed'),
                equityCentsCsv: equityCurve(full),
                splits: Object.fromEntries(
                  bands.map(([split, from, through]) => [split, summarize(run(from, through), 'fixed', false)]),
                ),
              },
            ]
          }),
        ),
      ]),
    ),
  }
}

const portfolios = [
  { id: 'P1', s1: 0, s2: 0, s3: 0, intraday: 'S4', weight: 1 },
  { id: 'P1-two-engine', s1: 0, s2: 0, s3: 0, intraday: 'S4-two', weight: 1 },
  { id: 'P1-upgraded-v2', s1: 0, s2: 0, s3: 0, intraday: 'S5', weight: 1 },
  { id: 'P1-live-v2', s1: 0, s2: 0, s3: 0, intraday: 'live-v2', weight: 1 },
  { id: 'P2', s1: 1, s2: 0, s3: 0, intraday: null, weight: 0 },
  { id: 'P3', s1: 1, s2: 0, s3: 0, intraday: 'S4', weight: 0.5 },
  { id: 'P4', s1: 0.7, s2: 0, s3: 0.3, intraday: 'S4', weight: 0.5 },
  { id: 'P5', s1: 0, s2: 0.6, s3: 0, intraday: 'S4', weight: 0.4 },
] as const
const standalone = [
  { id: 'S1', s1: 1, s2: 0, s3: 0, intraday: null, weight: 0, start: start2016 },
  { id: 'S2', s1: 0, s2: 1, s3: 0, intraday: null, weight: 0, start: start2016 },
  { id: 'S3', s1: 0, s2: 0, s3: 1, intraday: null, weight: 0, start: start2021 },
] as const

async function evaluate(s3: S3Client, signal: AbortSignal) {
  const data = await loadResearchData(s3, signal)
  const daily = fromDaily(data.longTape)
  const resMom = fromWave2(data.stockTape)
  const threeB = new Map(prepareDays(data.intraday.days).map((day) => [day.date, day]))
  const wave2B = await loadSip(s3, lastDay, signal)
  if (
    wave2B.inputs.manifest.sha256 !==
      data.provenance.manifests['bayn-research-datasets/2026-11-27-sip-multiyear/MANIFEST.json'] ||
    wave2B.inputs.calendar.sha256 !==
      data.provenance.manifests['bayn-research-datasets/2026-11-27/calendar_2024_2026.json'] ||
    wave2B.sessions.length !== data.calendar.length ||
    wave2B.sessions.some(
      (session, i) =>
        session.date !== data.calendar[i].date ||
        session.minutes !== data.calendar[i].minutes ||
        session.openMs !== data.calendar[i].openMs,
    )
  ) {
    throw new Error('Wave 2B minutes do not match the verified common calendar')
  }
  const byDate = new Map(wave2B.sessions.map((session) => [String(session.date), session]))
  const prepare = createReplay(wave2B.calendar)
  let prepared: ReturnType<typeof prepare> | undefined
  const v2 =
    (upgrade: boolean): Intraday =>
    ({ date, budget, capacity, overnightGross, dtbp, tier, overnightSymbols }) => {
      if (budget === 0) return noIntraday
      if (prepared?.session.date !== date || overnightSymbols.size > 0)
        throw new Error(`Invalid Wave 2B replay context on ${date}`)
      const run = simulate(
        prepared,
        {
          architecture: liveArchitecture,
          lag: 2,
          collar: upgrade ? 25 : 10,
          stopBuffer: upgrade ? 50 : 10,
          cost: 5,
        },
        undefined,
        { scale: budget / capital, capacity, cost: (symbol) => frictionBps(symbol, tier) },
      )
      const net = run.trades.reduce((sum, trade) => {
        if (trade.net === null) throw new Error(`Unresolved v2 exit: ${trade.symbol} ${date}`)
        return sum + trade.net
      }, 0)
      return {
        net,
        peakGross: run.maxGrossUsd,
        trades: run.trades.length,
        missing: run.missingEntryPrices,
        scaled: run.capacityTouched,
        grossCapHit: run.peakRequestedUsd + overnightGross > intradayLimit,
        dtbpHit: run.peakRequestedUsd > dtbp,
      }
    }
  const intraday = { S4: replay3B(threeB, 3), 'S4-two': replay3B(threeB, 2), S5: v2(true), 'live-v2': v2(false) }
  const makeAccount = (
    p: (typeof standalone)[number] | (typeof portfolios)[number],
    from: string,
    tier: keyof typeof tiers,
    equity: EquityMode,
    cash: CashMode,
  ) => {
    const overnight: Sleeve[] = []
    if (p.s1 > 0) overnight.push(daily.etfSleeve(daily.s1, p.s1, from))
    if (p.s2 > 0) overnight.push(daily.etfSleeve(daily.s2, p.s2, from))
    if (p.s3 > 0) overnight.push(resMom(p.s3, from))
    return createAccount({
      overnight,
      ...(p.intraday === null ? {} : { intraday: intraday[p.intraday] }),
      weight: p.weight,
      tier: tiers[tier],
      equity,
      cash,
    })
  }
  const overlap = daily.markets.filter((row) => row.date >= startOverlap)
  const tierKeys = Object.keys(tiers) as (keyof typeof tiers)[]
  const equityModes = ['fixed', 'compounded'] as const
  const cashModes = ['zero', 'shy'] as const
  const runOverlap = tierKeys.flatMap((tier) =>
    portfolios.flatMap((p) =>
      equityModes.flatMap((equity) =>
        cashModes.map((cash) => ({
          tier,
          id: p.id,
          equity,
          cash,
          account: makeAccount(p, startOverlap, tier, equity, cash),
          days: [] as Daily[],
        })),
      ),
    ),
  )
  const overlays = tierKeys.flatMap((tier) =>
    standalone.map((p) => ({
      tier,
      id: p.id,
      account: makeAccount(p, startOverlap, tier, 'fixed', 'zero'),
      days: [] as Daily[],
    })),
  )
  for (const market of overlap) {
    signal.throwIfAborted()
    const session = byDate.get(market.date)
    if (session === undefined) throw new Error(`Missing Wave 2B session ${market.date}`)
    prepared = prepare(session)
    for (const row of runOverlap) row.days.push(row.account(market))
    for (const row of overlays) row.days.push(row.account(market))
    prepared = undefined
  }
  const pack = (days: readonly Daily[], mode: EquityMode) => ({
    metrics: summarize(days, mode),
    equityCentsCsv: equityCurve(days),
  })
  const results = runOverlap.map(({ tier, id, equity, cash, days }) => ({
    tier,
    id,
    equity,
    cash,
    ...pack(days, equity),
  }))
  const longer = standalone.map((p) => {
    const markets = daily.markets.filter(({ date }) => date >= p.start)
    return {
      id: p.id,
      dates: markets.map(({ date }) => date),
      runs: tierKeys.flatMap((tier) =>
        equityModes.flatMap((equity) =>
          cashModes.map((cash) => ({
            tier,
            equity,
            cash,
            ...pack(markets.map(makeAccount(p, p.start, tier, equity, cash)), equity),
          })),
        ),
      ),
    }
  })
  const correlationMatrix = tierKeys.map((tier) => {
    const series = new Map<string, number[]>()
    for (const row of overlays.filter((r) => r.tier === tier))
      series.set(
        row.id,
        row.days.map(({ net }) => net / capital),
      )
    for (const [id, p] of [
      ['S4', 'P1'],
      ['S4-two', 'P1-two-engine'],
      ['S5', 'P1-upgraded-v2'],
      ['live-v2', 'P1-live-v2'],
    ]) {
      const row = runOverlap.find((r) => r.tier === tier && r.id === p && r.equity === 'fixed' && r.cash === 'zero')
      if (row === undefined) throw new Error(`Missing overlap returns for ${id}`)
      series.set(
        id,
        row.days.map(({ net }) => net / capital),
      )
    }
    series.set(
      'SPY',
      overlap.map(({ spy }) => spy),
    )
    series.set(
      'IEF',
      overlap.map(({ ief }) => ief),
    )
    return {
      tier,
      labels: [...series.keys()],
      matrix: [...series.values()].map((a) => [...series.values()].map((b) => correlation(a, b))),
    }
  })
  const core = longer
    .find((p) => p.id === 'S2')
    ?.runs.find((r) => r.tier === 'realistic' && r.equity === 'fixed' && r.cash === 'zero')
  if (core === undefined || core.metrics.exposure.annualOneWayOvernightTurnover >= 5)
    throw new Error(
      `S2 core violated the 5× annual turnover cap: ${core?.metrics.exposure.annualOneWayOvernightTurnover}`,
    )

  const benchmarkCurve = (returnAt: (row: (typeof overlap)[number]) => number) => {
    let equity = capital
    return overlap.map((row) => Math.round((equity *= 1 + returnAt(row)) * 100)).join(',')
  }
  return {
    schemaVersion: 'bayn.master-portfolio-synthesis.v1',
    authority: 'research-only',
    input: {
      ...data.provenance,
      intraday1m: wave2B.inputs,
      liveV2Identity: liveIdentity,
      fiveMinuteCoverage: data.intraday.coverage,
      oneMinuteAdmissions: wave2B.rows,
      wave2AStockUniverse: universes['expanded-stocks'],
    },
    tiers,
    portfolios,
    overlap: {
      dates: overlap.map(({ date }) => date),
      benchmarkEquityCentsCsv: {
        shy: benchmarkCurve(({ shy }) => shy),
        spy: benchmarkCurve(({ spy }) => spy),
        sixtyForty: benchmarkCurve(({ spy, ief }) => 0.6 * spy + 0.4 * ief),
      },
      correlationMatrix,
      results,
    },
    standalone: longer,
    sp100: wave3a(data.longTape, daily, signal),
  }
}

class SynthesisError extends Data.TaggedError('MasterPortfolioSynthesisError')<{ readonly cause: unknown }> {}

const main = Effect.gen(function* () {
  const args = Bun.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output' || !args[1].endsWith('.json'))
    return yield* new SynthesisError({ cause: 'Usage: research-master-portfolio-synthesis.ts --output new-file.json' })
  const endpoint = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_ENDPOINT')
  const bucket = yield* Config.NonEmptyString('AGENTS_ARTIFACTS_BUCKET')
  const accessKeyId = yield* Config.Redacted('AWS_ACCESS_KEY_ID')
  const secretAccessKey = yield* Config.Redacted('AWS_SECRET_ACCESS_KEY')
  const s3 = new S3Client({
    endpoint,
    bucket,
    accessKeyId: Redacted.value(accessKeyId),
    secretAccessKey: Redacted.value(secretAccessKey),
    region: 'us-east-1',
  })
  const output = args[1]
  const report = yield* Effect.tryPromise({
    try: (signal) => evaluate(s3, signal),
    catch: (cause) => new SynthesisError({ cause }),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', signal }),
    catch: (cause) => new SynthesisError({ cause }),
  })
  yield* Effect.logInfo(`Wrote ${output} (${report.overlap.dates.length} shared sessions)`)
  for (const row of report.overlap.results)
    if (row.tier === 'realistic' && row.equity === 'compounded' && row.cash === 'shy') {
      yield* Effect.logInfo(
        `${row.id}: net ${row.metrics.netUsd}, CAGR ${roundPct(row.metrics.cagr)}%, excess SHY ${row.metrics.versus.shy.excessNetUsd}`,
      )
    }
})

if (import.meta.main) NodeRuntime.runMain(main)
