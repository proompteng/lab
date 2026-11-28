import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem, Layer, Logger, Redacted, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { dailySharpe, expectedMaximumSharpe, mean, sum } from './midday-research-statistics'
import {
  loadDevelopment,
  loadHoldout,
  loadShy,
  readIntradayRosters,
  sources,
  withArchive,
} from './noise-area-study-data'
import {
  baskets,
  budgetedShares,
  capital,
  closedLeg,
  createReplay,
  markedGrossBound,
  netAt,
  prepare,
  splits,
  type Day,
  type Ledger,
  type Symbol,
  type Trial,
} from './noise-area-study-replay'
import {
  bootstrapSeed,
  correlation,
  delta,
  draws,
  meanBlockSessions,
  stationaryBootstrap,
  summarize,
} from './noise-area-study-statistics'
import { sha256 } from './research-orb-zab-data'

const evidence = 'docs/bayn/evidence/2026-11-27-10yr-intraday-voltarget-moc'
const freezePath = evidence + '/freeze.json'
const runnerPath = 'services/bayn/tools/research-10yr-intraday-voltarget-moc.ts'
const transportPath = evidence + '/transport-erratum.json'
const locked = [
  evidence + '/protocol.md',
  runnerPath,
  'services/bayn/tools/noise-area-study-data.ts',
  'services/bayn/tools/noise-area-study-replay.ts',
  'services/bayn/tools/noise-area-study-statistics.ts',
  'services/bayn/tools/midday-research-statistics.ts',
  'services/bayn/tools/research-orb-zab-data.ts',
]
const freezeVersion = 'bayn.research.wave-11b.freeze.v1'
const costs = [2, 5, 10] as const
const lookback = 14
const annualizer = Math.sqrt(252)
const trainEnd = splits.train.count
const developmentEnd = trainEnd + splits.validation.count
const fullEnd = developmentEnd + splits.holdout.count
const windows = {
  train: [0, trainEnd],
  validation: [trainEnd, developmentEnd],
  holdout: [developmentEnd, fullEnd],
  full: [0, fullEnd],
} as const

enum Family {
  Target = 'A',
  Momentum = 'B',
  Pairs = 'C',
}
const families = [Family.Target, Family.Momentum, Family.Pairs]
export enum MomentumAnchor {
  PreviousClose = 'previous_close',
  Open = 'open',
}
const tech = ['QQQ', 'SMH', 'XLK'] as const
const targetBaskets = { B0: baskets.B0, Tech: tech }
const momentumBaskets = { Index: ['SPY', 'QQQ', 'IWM'], Tech: tech, Cross: ['TLT', 'GLD'] } as const
const pairs = [
  ['SMH', 'QQQ'],
  ['XLK', 'QQQ'],
  ['IWM', 'SPY'],
  ['TLT', 'IEF'],
] as const
const traded = ['SPY', 'QQQ', 'IWM', 'SMH', 'XLK', 'TLT', 'IEF', 'GLD'] as const
const excluded = ['SLV', 'HYG'] as const
const base: Trial = {
  id: 'B0/30/1.4/opposite_band/inverse_vol_parity',
  basket: 'B0',
  band: 1.4,
  minutes: 30,
  exit: 'opposite_band',
  sizing: 'inverse_vol_parity',
}
const baselineId = 'A/B0/fixed'
const targets = [
  { targetAnnVol: 0.1, leverageCap: 2 },
  { targetAnnVol: 0.15, leverageCap: 1 },
  { targetAnnVol: 0.15, leverageCap: 1.5 },
  { targetAnnVol: 0.15, leverageCap: 2 },
  { targetAnnVol: 0.2, leverageCap: 2 },
] as const
const targetGrid = (['B0', 'Tech'] as const).flatMap((basket) => [
  { id: `A/${basket}/fixed`, family: Family.Target as const, basket, target: null },
  ...targets.map((target) => ({
    id: `A/${basket}/${target.targetAnnVol * 100}pct/${target.leverageCap}x`,
    family: Family.Target as const,
    basket,
    target,
  })),
])
const momentum = (basket: keyof typeof momentumBaskets, sigma: number, anchor: MomentumAnchor) => ({
  id: `B/${basket}/${anchor}/${sigma}`,
  family: Family.Momentum as const,
  basket,
  sigma,
  anchor,
})
export const grid = [
  ...targetGrid,
  ...(['Index', 'Tech', 'Cross'] as const).flatMap((basket) =>
    [0.5, 1, 1.5].map((sigma) => momentum(basket, sigma, MomentumAnchor.PreviousClose)),
  ),
  momentum('Index', 1, MomentumAnchor.Open),
  ...pairs.flatMap((pair) =>
    [1.5, 2].map((sigma) => ({ id: `C/${pair.join('-')}/${sigma}`, family: Family.Pairs as const, pair, sigma })),
  ),
]
const empty = (): Ledger => ({
  base: 0,
  slope: 0,
  trades: 0,
  unresolved: 0,
  missingEntries: 0,
  missingHeld: 0,
  grossUpperBound: 0,
})
type Leg = {
  readonly sign: 1 | -1
  readonly quantity: number
  readonly entry: number
  readonly exit: number | undefined
  readonly maxHigh: number
  readonly missingHeld: number
}
const book = (legs: readonly Leg[], missingEntries: number): Ledger => {
  let { base, slope, trades, unresolved, missingHeld, grossUpperBound } = empty()
  for (const leg of legs) {
    missingHeld += leg.missingHeld
    grossUpperBound += markedGrossBound(leg.quantity, leg.maxHigh)
    if (leg.exit === undefined) {
      unresolved++
    } else {
      const pnl = closedLeg(leg.sign, leg.quantity, leg.entry, leg.exit)
      base += pnl.base
      slope += pnl.slope
      trades++
    }
  }
  return { base, slope, trades, unresolved, missingHeld, missingEntries, grossUpperBound }
}

const sampleStd = (values: readonly number[]) => {
  const center = mean(values)
  return Math.sqrt(sum(values.map((value) => (value - center) ** 2)) / (values.length - 1))
}
const completeNumbers = (values: readonly (number | undefined)[]): values is readonly number[] =>
  values.every((value) => value !== undefined)
const completeNet = (values: readonly (number | null)[]): values is readonly number[] =>
  values.every((value) => value !== null)

export const targetScale = (previous: readonly Ledger[], target: { targetAnnVol: number; leverageCap: number }) => {
  if (previous.length !== lookback || previous.some(({ unresolved, missingHeld }) => unresolved + missingHeld !== 0))
    return 0
  const realized = sampleStd(previous.map(({ base }) => base / capital)) * annualizer
  return realized === 0 ? target.leverageCap : Math.min(target.leverageCap, target.targetAnnVol / realized)
}

const openToClose = (day: Day, symbol: Symbol) => {
  const bars = day.bars.get(symbol)
  const start = bars?.[0]?.open
  const end = bars?.[day.slots - 1]?.close
  return start === undefined || end === undefined ? undefined : end / start - 1
}

const momentumReturn = (day: Day, previous: Day | undefined, symbol: Symbol, anchor: MomentumAnchor) => {
  const close = day.bars.get(symbol)?.[day.slots - 7]?.close
  const start =
    anchor === MomentumAnchor.Open
      ? day.bars.get(symbol)?.[0]?.open
      : previous?.bars.get(symbol)?.[previous.slots - 1]?.close
  return start === undefined || close === undefined ? undefined : close / start - 1
}

const markedLeg = (
  day: Day,
  symbol: Symbol,
  sign: 1 | -1,
  quantity: number,
  entry: number,
  entrySlot: number,
  exitSlot: number,
): Leg => {
  const bars = day.bars.get(symbol)
  const exit = bars?.[exitSlot]?.open
  let maxHigh = Math.max(entry, exit ?? 0)
  let missingHeld = 0
  for (let slot = entrySlot; slot < exitSlot; slot++) {
    const high = bars?.[slot]?.high
    if (high === undefined) missingHeld++
    else maxHigh = Math.max(maxHigh, high)
  }
  return { sign, quantity, entry, exit, maxHigh, missingHeld }
}

export const replayMomentum = (
  days: readonly Day[],
  i: number,
  members: readonly Symbol[],
  anchor: MomentumAnchor,
  sigma: number,
): Ledger => {
  if (i < lookback) return empty()
  const day = days[i]
  const entrySlot = day.slots - 6
  let missingEntries = 0
  const legs: Leg[] = []
  for (const symbol of members) {
    const historical = days
      .slice(i - lookback, i)
      .map((past, j) => momentumReturn(past, days[i - lookback + j - 1], symbol, anchor))
    const signal = momentumReturn(day, days[i - 1], symbol, anchor)
    if (signal === undefined || signal === 0 || !completeNumbers(historical)) continue
    const vol = sampleStd(historical)
    if (vol <= 0 || Math.abs(signal) < sigma * vol) continue
    const entry = day.bars.get(symbol)?.[entrySlot]?.open
    const reference = day.bars.get(symbol)?.[entrySlot - 1]?.close
    if (entry === undefined || reference === undefined) {
      missingEntries++
      continue
    }
    const quantity = budgetedShares(capital / members.length, entry, reference)
    if (quantity > 0) legs.push(markedLeg(day, symbol, signal > 0 ? 1 : -1, quantity, entry, entrySlot, day.slots - 1))
  }
  return book(legs, missingEntries)
}

type Pair = readonly [Symbol, Symbol]
const spreadAt = (day: Day, pair: Pair, weight: number, slot: number) => {
  const a = day.bars.get(pair[0])
  const b = day.bars.get(pair[1])
  const aOpen = a?.[0]?.open
  const bOpen = b?.[0]?.open
  const aClose = a?.[slot]?.close
  const bClose = b?.[slot]?.close
  return aOpen === undefined || bOpen === undefined || aClose === undefined || bClose === undefined
    ? undefined
    : weight * Math.log(aClose / aOpen) - (1 - weight) * Math.log(bClose / bOpen)
}

const spreadZ = (days: readonly Day[], i: number, pair: Pair, weight: number, slot: number) => {
  const today = spreadAt(days[i], pair, weight, slot)
  if (today === undefined) return null
  const prior: number[] = []
  for (let j = i - 1; j >= 0 && prior.length < lookback; j--) {
    if (days[j].slots <= slot) continue // An exchange-scheduled early close never observed this clock.
    const past = spreadAt(days[j], pair, weight, slot)
    if (past === undefined) return null
    prior.push(past)
  }
  if (prior.length !== lookback) return null
  const volatility = sampleStd(prior)
  return volatility > 0 ? (today - mean(prior)) / volatility : null
}

export const replayPair = (days: readonly Day[], i: number, pair: Pair, sigma: number): Ledger => {
  if (i < lookback) return empty()
  const day = days[i]
  const [a, b] = pair.map((ticker) => day.bars.get(ticker))
  const [aVol, bVol] = pair.map((ticker) => {
    const prior = days.slice(i - lookback, i).map((past) => openToClose(past, ticker))
    return completeNumbers(prior) ? sampleStd(prior) : 0
  })
  if (!(aVol > 0 && bVol > 0)) return empty()
  const weight = bVol / (aVol + bVol)
  const flat = day.slots - 1
  // Slot 5 closes at 10:00 ET; slot 59 at 14:30. Require an entry strictly before the flatten open.
  for (let slot = 5; slot <= Math.min(59, flat - 2); slot++) {
    const z = spreadZ(days, i, pair, weight, slot)
    if (z === null || Math.abs(z) < sigma) continue
    const entrySlot = slot + 1
    const aEntry = a?.[entrySlot]?.open
    const bEntry = b?.[entrySlot]?.open
    const aRef = a?.[slot]?.close
    const bRef = b?.[slot]?.close
    if (aEntry === undefined || bEntry === undefined || aRef === undefined || bRef === undefined) return book([], 1)
    const aSize = budgetedShares(capital * weight, aEntry, aRef)
    const bSize = budgetedShares(capital * (1 - weight), bEntry, bRef)
    if (aSize === 0 || bSize === 0) return empty()

    let requested = false
    let exitSlot = entrySlot + 1
    for (; exitSlot < flat; exitSlot++) {
      if (!requested) {
        const heldZ = spreadZ(days, i, pair, weight, exitSlot - 1)
        requested = heldZ !== null && z * heldZ <= 0
      }
      if (requested && a?.[exitSlot] !== undefined && b?.[exitSlot] !== undefined) break
    }
    // Do not credit an asynchronous one-leg exit when either deadline fill is unproved.
    const aLeg = markedLeg(day, pair[0], z > 0 ? -1 : 1, aSize, aEntry, entrySlot, exitSlot)
    const bLeg = markedLeg(day, pair[1], z > 0 ? 1 : -1, bSize, bEntry, entrySlot, exitSlot)
    return aLeg.exit === undefined || bLeg.exit === undefined
      ? book(
          [
            { ...aLeg, exit: undefined },
            { ...bLeg, exit: undefined },
          ],
          0,
        )
      : book([aLeg, bLeg], 0)
  }
  return empty()
}

const replay = (days: readonly Day[]) => {
  const tapes = grid.map((spec) => ({ spec, rows: [] as Ledger[], scales: [] as number[] }))
  const fixed = { B0: [] as Ledger[], Tech: [] as Ledger[] }
  let i = 0
  for (const prepared of prepare(days, tech)) {
    const simulate = createReplay(prepared)
    for (const { spec, rows, scales } of tapes) {
      if (spec.family === Family.Target) {
        const prior = fixed[spec.basket].slice(Math.max(lookback, i - lookback), i)
        const scale = spec.target === null ? 1 : targetScale(prior, spec.target)
        const row =
          scale === 0 ? empty() : simulate(base, targetBaskets[spec.basket], undefined, { budget: capital * scale })
        if (spec.target === null) fixed[spec.basket].push(row)
        rows.push(row)
        scales.push(scale)
      } else if (spec.family === Family.Momentum) {
        rows.push(replayMomentum(days, i, momentumBaskets[spec.basket], spec.anchor, spec.sigma))
      } else {
        rows.push(replayPair(days, i, spec.pair, spec.sigma))
      }
    }
    i++
  }
  return tapes
}
type Tape = ReturnType<typeof replay>[number]
const ledgerHash = (tapes: readonly Tape[]) => sha256(JSON.stringify(tapes))
const tapeById = (tapes: readonly Tape[], id: string) => {
  const tape = tapes.find(({ spec }) => spec.id === id)
  if (tape === undefined) throw new Error(`Unregistered tape: ${id}`)
  return tape
}
const windowRows = (rows: readonly Ledger[], window: keyof typeof windows) => rows.slice(...windows[window])
const safe = (rows: readonly Ledger[], family: Family) =>
  rows.every(({ unresolved, missingHeld }) => unresolved === 0 && (family === Family.Momentum || missingHeld === 0))

const developmentRank = (rows: readonly Ledger[], family: Family) => {
  const values = rows.map((row) => netAt(row, 5))
  return { safe: safe(rows, family), sharpeDaily: completeNet(values) ? dailySharpe(values) : null }
}
type Ranking = { id: string; train: ReturnType<typeof developmentRank>; validation: ReturnType<typeof developmentRank> }
export const select = (rankings: readonly Ranking[]) => {
  const cmp = (window: 'train' | 'validation') => (a: Ranking, b: Ranking) =>
    (b[window].sharpeDaily ?? -Infinity) - (a[window].sharpeDaily ?? -Infinity) || a.id.localeCompare(b.id, 'en')
  const finalists = rankings
    .filter(
      ({ train, validation }) =>
        train.safe && validation.safe && train.sharpeDaily !== null && validation.sharpeDaily !== null,
    )
    .toSorted(cmp('train'))
    .slice(0, 3)
  return { finalists: finalists.map(({ id }) => id), selected: finalists.toSorted(cmp('validation'))[0]?.id ?? null }
}

const baselineParity = (tape: Tape, scored: boolean) => {
  const expected = {
    train: [33107.45, 14806],
    validation: [29982.77, 23345.9],
    holdout: [40443.36, 31628.26],
    full: [103533.58, 69780.16],
  }
  return Object.fromEntries(
    (scored ? (['train', 'validation', 'holdout', 'full'] as const) : (['train', 'validation'] as const)).map(
      (window) => {
        const rows = windowRows(tape.rows, window)
        const observed = [2, 5].map((bp) => {
          const net = rows.map((row) => netAt(row, bp))
          return completeNet(net) ? Math.round(sum(net) * 100) / 100 : null
        })
        const reference = expected[window]
        if (observed.some((net, i) => net !== reference[i]))
          throw new Error(
            `Wave 6A B0 parity failure for ${window}: ${observed.join('/')}, expected ${reference.join('/')}`,
          )
        return [window, observed]
      },
    ),
  )
}

type Coverage = Awaited<ReturnType<typeof loadDevelopment>>['coverage']
const covered = (coverage: Coverage, first: string, last: string) =>
  Object.fromEntries(
    traded.map((ticker) => {
      const coverageRow = coverage.counts[ticker]
      if (
        coverageRow.firstRthDate !== first ||
        coverageRow.lastRthDate !== last ||
        coverageRow.emptySessions.length !== 0
      )
        throw new Error(`Incomplete session history for ${ticker} (${first} through ${last})`)
      return [ticker, coverageRow]
    }),
  )

const makeFreeze = (
  development: Awaited<ReturnType<typeof loadDevelopment>>,
  rosters: Awaited<ReturnType<typeof readIntradayRosters>>,
  files: Readonly<Record<string, string>>,
) => {
  const coverage = covered(development.coverage, splits.train.first, splits.validation.last)
  const tapes = replay(development.days)
  const rankings = tapes.map(({ spec, rows }) => ({
    id: spec.id,
    family: spec.family,
    train: developmentRank(windowRows(rows, 'train'), spec.family),
    validation: developmentRank(windowRows(rows, 'validation'), spec.family),
  }))
  const trials = tapes.filter(({ spec }) => spec.family !== Family.Target || spec.target !== null)
  const dsrBenchmarkDaily = costs.map((bp) => ({
    bp,
    value: expectedMaximumSharpe(
      trials.flatMap(({ rows }) => {
        const net = windowRows(rows, 'train').map((row) => netAt(row, bp))
        const sr = completeNet(net) ? dailySharpe(net) : null
        return sr === null ? [] : [sr]
      }),
      trials.length,
    ),
  }))
  return {
    schema: freezeVersion,
    files,
    sources,
    splits,
    rosters,
    traded,
    excluded,
    coverage,
    grid,
    targetBaskets,
    momentumBaskets,
    lookback,
    costs,
    capital,
    bootstrap: { seed: bootstrapSeed, draws, meanBlockSessions },
    baselineParity: baselineParity(tapeById(tapes, baselineId), false),
    developmentLedgerSha256: ledgerHash(tapes),
    dsrTrials: trials.length,
    dsrBenchmarkDaily,
    selection: families.map((family) => ({
      family,
      ...select(rankings.filter(({ id, family: trialFamily }) => trialFamily === family && !id.endsWith('/fixed'))),
    })),
    rankings,
  }
}
type Freeze = ReturnType<typeof makeFreeze>

const compare = (
  rows: readonly Ledger[],
  benchmark: readonly Ledger[],
  bp: number,
  p: ReturnType<typeof stationaryBootstrap>,
) => {
  const a = rows.map((row) => netAt(row, bp))
  const b = benchmark.map((row) => netAt(row, bp))
  if (a.length !== b.length || !completeNet(a) || !completeNet(b))
    return {
      dailyCorrelation: null,
      stackSharpe: null,
      stackSharpeLift: null,
      sharpeLift: null,
      pairedDelta: { netUsd: null, p: null },
    }
  const baseSr = dailySharpe(b)
  const candidateSr = dailySharpe(a)
  const candidate: readonly number[] = a
  const pairedBaseline: readonly number[] = b
  const stackSr = dailySharpe(candidate.map((value, i) => value + pairedBaseline[i]))
  return {
    dailyCorrelation: correlation(a, b).r,
    stackSharpe: stackSr === null ? null : stackSr * annualizer,
    stackSharpeLift: stackSr === null || baseSr === null ? null : (stackSr - baseSr) * annualizer,
    sharpeLift: candidateSr === null || baseSr === null ? null : (candidateSr - baseSr) * annualizer,
    pairedDelta: delta(rows, benchmark, bp, p),
  }
}

type Metrics = ReturnType<typeof summarize>
const alphaMetrics = (
  rows: readonly Ledger[],
  bp: number,
  benchmark: number | null = null,
  p?: ReturnType<typeof stationaryBootstrap>,
) => {
  const daily = rows.map((row) => netAt(row, bp))
  return {
    ...summarize(rows, bp, benchmark, undefined, p),
    realizedAnnualVol: daily.length > 1 && completeNet(daily) ? (sampleStd(daily) * annualizer) / capital : null,
  }
}
type Comparison = ReturnType<typeof compare>
type GateRow = {
  bp: number
  holdout: Pick<Metrics, 'netUsd' | 'exTop10Usd' | 'bootstrapP' | 'dsr'>
  comparison: Pick<Comparison, 'dailyCorrelation' | 'stackSharpeLift'>
}
export const gates = (orthogonal: boolean, executionSafe: boolean, entries: readonly GateRow[]) => {
  const byCost = ([2, 5] as const).map((bp) => {
    const row = entries.find((entry) => entry.bp === bp)
    const r = row?.comparison.dailyCorrelation
    return {
      bp,
      positiveNet: (row?.holdout.netUsd ?? 0) > 0,
      positiveExTop10: (row?.holdout.exTop10Usd ?? 0) > 0,
      significant: (row?.holdout.bootstrapP ?? 1) < 0.05,
      deflated: (row?.holdout.dsr ?? 0) >= 0.95,
      lowCorrelation: !orthogonal || (r !== null && r !== undefined && Math.abs(r) < 0.3),
      positiveStackLift: !orthogonal || (row?.comparison.stackSharpeLift ?? 0) > 0,
    }
  })
  return {
    executionSafe,
    byCost,
    pass: executionSafe && byCost.every(({ bp: _bp, ...checks }) => Object.values(checks).every(Boolean)),
  }
}

const score = (
  development: Awaited<ReturnType<typeof loadDevelopment>>,
  holdout: Awaited<ReturnType<typeof loadHoldout>>,
  shyPrices: readonly number[],
  freeze: Freeze,
  receiptSha256: string,
) => {
  const holdoutCoverage = covered(holdout.coverage, splits.holdout.first, splits.holdout.last)
  const days = [...development.days, ...holdout.days]
  const tapes = replay(days)
  const prefix = tapes.map(({ spec, rows, scales }) => ({
    spec,
    rows: rows.slice(0, developmentEnd),
    scales: scales.slice(0, developmentEnd),
  }))
  if (ledgerHash(prefix) !== freeze.developmentLedgerSha256) throw new Error('Stitched replay changed development')
  const b0 = tapeById(tapes, baselineId)
  const p = stationaryBootstrap(splits.holdout.count)
  const trials = tapes.map(({ spec, rows, scales }) => {
    const range = windowRows(rows, 'holdout')
    const matched = spec.family === Family.Target ? tapeById(tapes, `A/${spec.basket}/fixed`) : b0
    const matchedHold = windowRows(matched.rows, 'holdout')
    const executionSafe = safe(range, spec.family) && safe(matchedHold, matched.spec.family)
    const nominated = freeze.selection.some(({ selected }) => selected === spec.id)
    const byCost = freeze.dsrBenchmarkDaily.map(({ bp, value }) => ({
      bp,
      train: alphaMetrics(windowRows(rows, 'train'), bp),
      validation: alphaMetrics(windowRows(rows, 'validation'), bp),
      holdout: alphaMetrics(range, bp, value, p),
      full: alphaMetrics(rows, bp),
      comparison: compare(range, matchedHold, bp, p),
    }))
    const holdoutScales = scales.slice(developmentEnd)
    const checks = gates(spec.family !== Family.Target, executionSafe, byCost)
    return {
      id: spec.id,
      family: spec.family,
      matchedControl: matched.spec.id,
      nominated,
      qualified: nominated && checks.pass,
      gates: checks,
      holdoutSizing:
        holdoutScales.length === 0
          ? null
          : {
              mean: mean(holdoutScales),
              min: Math.min(...holdoutScales),
              max: Math.max(...holdoutScales),
              withheldSessions: holdoutScales.filter((scale) => scale === 0).length,
              cappedSessions:
                spec.family === Family.Target && spec.target !== null
                  ? holdoutScales.filter((scale) => scale === spec.target?.leverageCap).length
                  : null,
            },
      byCost,
    }
  })
  const carry = shyPrices.map((price, i) => (i === 0 ? 0 : (capital * (price - shyPrices[i - 1])) / shyPrices[0]))
  return {
    schema: 'bayn.research.wave-11b.results.v1',
    freezeSha256: receiptSha256,
    sources,
    splits,
    coverage: {
      development: freeze.coverage,
      holdout: holdoutCoverage,
      earlyCloses: [...development.coverage.halfDays, ...holdout.coverage.halfDays],
    },
    baselineParity: baselineParity(b0, true),
    selection: freeze.selection,
    dsrBenchmarkDaily: freeze.dsrBenchmarkDaily,
    qualified: trials.filter((row) => row.qualified).map(({ id }) => id),
    trials,
    shy: {
      fullCarryUsd: sum(carry),
      holdoutCarryUsd: sum(carry.slice(developmentEnd)),
      overlays: trials
        .filter(({ id, nominated }) => id.endsWith('/fixed') || nominated)
        .map(({ id }) => ({
          id,
          costs: costs.map((bp) => {
            const { rows } = tapeById(tapes, id)
            return {
              bp,
              full: summarize(rows, bp, null, carry),
              holdout: summarize(windowRows(rows, 'holdout'), bp, null, carry.slice(developmentEnd)),
            }
          }),
        })),
      sessions: days.length,
    },
  }
}

enum Mode {
  Freeze = '--freeze',
  Score = '--score',
}
const decodeMode = Schema.decodeUnknownSync(Schema.Tuple([Schema.Enum(Mode)]))
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const envelope = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal(freezeVersion),
    files: Schema.Record(Schema.String, digest),
  }),
)
const decodeTransport = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal('bayn.research.wave-11b.transport-erratum.v1'),
    freezeSha256: digest,
    frozenRunnerSha256: digest,
    correctedRunnerSha256: digest,
  }),
)
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

export const verifyFileHashes = (receipt: unknown, files: Readonly<Record<string, string>>) => {
  const frozen = envelope(receipt).files
  if (Object.keys(frozen).length !== Object.keys(files).length) throw new Error('Freeze source paths changed')
  for (const [path, digest] of Object.entries(files)) {
    if (digest !== frozen[path]) throw new Error(`Freeze SHA-256 mismatch: ${path}`)
  }
}
// Only this runner's verified formatting transport may differ from the original receipt.
export const verifyTransport = (
  receipt: unknown,
  files: Readonly<Record<string, string>>,
  freezeSha256: string,
  rawTransport: string,
) => {
  const erratum = decodeTransport(decodeReceipt(rawTransport))
  if (
    freezeSha256 !== erratum.freezeSha256 ||
    files[runnerPath] !== erratum.correctedRunnerSha256 ||
    erratum.frozenRunnerSha256 === erratum.correctedRunnerSha256
  ) {
    throw new Error('Transport erratum does not bind this freeze and corrected runner')
  }
  const frozenFiles = { ...files, [runnerPath]: erratum.frozenRunnerSha256 }
  verifyFileHashes(receipt, frozenFiles)
  return frozenFiles
}
export const openAfterFreeze = <A>(receipt: unknown, recomputed: unknown, open: () => Promise<A>) => {
  if (JSON.stringify(receipt) !== JSON.stringify(recomputed))
    throw new Error('Committed Train/Validation freeze did not reproduce; Holdout unopened')
  return open()
}

class StudyError extends Data.TaggedError('Wave11bStudyError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}
const verify = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new StudyError({
        message: cause instanceof Error ? cause.message : 'Study evidence verification failed',
        cause: Redacted.make(cause),
      }),
  })

const commandOutput = (command: ChildProcess.StandardCommand, message: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(command)
    const [output, status] = yield* Effect.all([Stream.runCollect(child.stdout), child.exitCode], {
      concurrency: 'unbounded',
    })
    if (Number(status) !== 0) return yield* new StudyError({ message })
    return Buffer.concat(output)
  }).pipe(Effect.scoped, Effect.timeout('30 seconds'))

const committedHash = (path: string) =>
  commandOutput(
    ChildProcess.make('git', ['cat-file', 'blob', `HEAD:${path}`], { stdin: 'ignore', stderr: 'ignore' }),
    `Commit ${path} before evaluation`,
  ).pipe(Effect.map(sha256))

const program = Effect.gen(function* () {
  const [mode] = yield* verify(() => decodeMode(process.argv.slice(2)))
  const fs = yield* FileSystem.FileSystem
  const verifiedBytes = (path: string) =>
    Effect.gen(function* () {
      const [bytes, committed] = yield* Effect.all([fs.readFile(path), committedHash(path)])
      if (sha256(bytes) !== committed)
        return yield* new StudyError({ message: `Working bytes differ from committed SHA-256: ${path}` })
      return bytes
    })
  const files = Object.fromEntries(
    yield* Effect.forEach(locked, (path) =>
      verifiedBytes(path).pipe(Effect.map((bytes) => [path, sha256(bytes)] as const)),
    ),
  )
  const receiptBytes = mode === Mode.Score ? yield* verifiedBytes(freezePath) : null
  if (mode === Mode.Freeze && (yield* fs.exists(freezePath)))
    return yield* new StudyError({
      message: 'Freeze already exists; use --score after committing it',
    })
  const receipt =
    receiptBytes === null ? null : yield* verify(() => decodeReceipt(new TextDecoder().decode(receiptBytes)))
  let frozenFiles = files
  if (receiptBytes !== null) {
    if (yield* fs.exists(transportPath)) {
      const erratum = yield* verifiedBytes(transportPath)
      frozenFiles = yield* verify(() =>
        verifyTransport(receipt, files, sha256(receiptBytes), new TextDecoder().decode(erratum)),
      )
    } else {
      yield* verify(() => verifyFileHashes(receipt, files))
    }
  }
  const result = yield* withArchive(async (archive) => {
    const rosters = await readIntradayRosters(archive)
    for (const roster of Object.values(rosters)) {
      if (traded.some((ticker) => !roster.includes(ticker)) || excluded.some((ticker) => roster.includes(ticker)))
        throw new Error('Frozen roster differs from preregistered ETF availability')
    }
    const development = await loadDevelopment(archive)
    const freeze = makeFreeze(development, rosters, frozenFiles)
    if (receiptBytes === null) return { path: freezePath, data: freeze }
    return openAfterFreeze(receipt, freeze, async () => {
      const holdout = await loadHoldout(archive)
      const shy = await loadShy(
        archive,
        [...development.days, ...holdout.days].map(({ date }) => date),
      )
      return { path: evidence + '/results.json', data: score(development, holdout, shy, freeze, sha256(receiptBytes)) }
    })
  })
  const encoded = json(result.data)
  const output = yield* commandOutput(
    ChildProcess.make('node', ['node_modules/oxfmt/bin/oxfmt', '--stdin-filepath', result.path], {
      stdin: Stream.make(new TextEncoder().encode(encoded)),
      stderr: 'ignore',
    }),
    'oxfmt could not format the Wave 11B receipt',
  )
  yield* verify(() => {
    if (json(decodeReceipt(output.toString())) !== encoded) throw new Error('oxfmt changed receipt data')
  })
  yield* fs.writeFile(result.path, output)
  yield* Effect.logInfo('Wave 11B evidence written', { path: result.path, sha256: sha256(output) })
})

const runtime = Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.consoleJson]))
if (import.meta.main)
  NodeRuntime.runMain(
    program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the CLI owns filesystem and child-process resources
      Effect.provide(runtime),
    ),
  )
