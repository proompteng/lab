import { fileURLToPath } from 'node:url'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'

import {
  horizons,
  liveStart,
  liveSymbols,
  multiSymbols,
  readResearchData,
  ResearchEvidenceError,
  sha256,
  type ResearchDay,
} from './research-orb-zab-data'
import {
  costs,
  isUpgrade,
  neighbors,
  noiseTrials,
  noiseUniverse,
  orbTrials,
  trainEnd,
  v2Noise,
  v2Orb,
  validationEnd,
  type Cost,
  type Trial,
} from './research-orb-zab-protocol'
import { replay, type Outcome } from './research-orb-zab-simulation'
import {
  bootstrap,
  dailySharpe,
  deflationBenchmark,
  pearson,
  sessionNet,
  summarize,
} from './research-orb-zab-statistics'

const trials = [...orbTrials(), ...noiseTrials()]
// The failed predecessor inspected 138 configurations on this calendar. Count them even
// though its exact ledger is not retained and some configurations probably overlap.
const priorTrials = 138
const primaryCost = 10
type Metric = ReturnType<typeof summarize>
type Range = { readonly id: string; readonly from: string; readonly through: string }

const train: Range = { id: 'train', from: '2024-01-02', through: trainEnd }
const validation: Range = { id: 'validation', from: '2025-07-01', through: validationEnd }
const holdout: Range = { id: 'holdout', from: '2026-04-01', through: '2026-11-25' }
const all: Range = { id: 'all', from: train.from, through: holdout.through }
const live: Range = { id: 'all', from: liveStart, through: holdout.through }
const halfYears = [2024, 2025, 2026].flatMap((year) => [
  { id: `${year}H1`, from: `${year}-01-01`, through: `${year}-06-30` },
  { id: `${year}H2`, from: `${year}-07-01`, through: `${year}-12-31` },
])
const liveFolds = (days: readonly ResearchDay[]): Range[] =>
  [0, 1, 2].map((i) => ({ id: `fold${i + 1}`, from: days[i * 22].date, through: days[(i + 1) * 22 - 1].date }))

const inRange = <T extends { readonly date: string }>(days: readonly T[], range: Range) =>
  days.filter((d) => d.date >= range.from && d.date <= range.through)

const observedNet = (days: readonly Outcome[]) => days.map(sessionNet).filter((x): x is number => x !== null)

const sourceIdentity = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = [
    'research-orb-zab-data.ts',
    'research-orb-zab-protocol.ts',
    'research-orb-zab-simulation.ts',
    'research-orb-zab-statistics.ts',
    'research-orb-zab-multiyear.ts',
    '../src/strategy/intraday-alpha/stock-in-play.ts',
    '../src/strategy/intraday-alpha/trailing-exits.ts',
    '../src/strategy/intraday-alpha/signals.ts',
    '../src/strategy/intraday-alpha/policy.ts',
    '../src/strategy/intraday-alpha/constants.ts',
  ]
  const hashes: Record<string, string> = {}
  for (const path of paths) {
    hashes[path] = sha256(yield* fs.readFile(fileURLToPath(new URL(path, import.meta.url))))
  }
  return hashes
})

const meets = (value: number | null, threshold = 0) => value !== null && value > threshold
const plateau = (id: string, nearby: readonly Trial[], metrics: ReadonlyMap<string, Metric>) => {
  const points = nearby.map((point) => ({ id: point.id, net: metrics.get(point.id)?.net ?? null }))
  const positive = points.filter((point) => meets(point.net)).length
  return { center: id, points, pass: points.length >= 2 && positive >= Math.ceil(0.75 * points.length) }
}

const develop = (input: string) =>
  Effect.gen(function* () {
    const { multiDays, provenance } = yield* readResearchData(input, false)
    const outcomes = new Map(trials.map((trial) => [trial.id, replay(multiDays, trial, multiSymbols, primaryCost)]))
    const trainSharpes = [...outcomes.values()].flatMap((days) => {
      const sharpe = dailySharpe(observedNet(inRange(days, train)))
      return sharpe === null ? [] : [sharpe]
    })
    const multiplicity = trials.length + priorTrials
    const benchmark = deflationBenchmark(trainSharpes, multiplicity)
    const measure = (range: Range) =>
      new Map([...outcomes].map(([id, days]) => [id, summarize(inRange(days, range), benchmark)]))
    const trainMetrics = measure(train)
    const validationMetrics = measure(validation)
    const select = (engine: Trial['engine']) => {
      const candidates = trials.filter((trial) => trial.engine === engine && isUpgrade(trial))
      const trainRank = (id: string) => {
        const metric = trainMetrics.get(id)
        if (metric === undefined || metric.closed < 30 || metric.completeSessions / metric.sessions < 0.9)
          return -Infinity
        return metric.completeCaseSharpe ?? -Infinity
      }
      const selected = candidates.toSorted((a, b) => trainRank(b.id) - trainRank(a.id) || a.id.localeCompare(b.id))[0]
      const baselineId = engine === 'orb' ? v2Orb.id : v2Noise.id
      const t = trainMetrics.get(selected.id)
      const v = validationMetrics.get(selected.id)
      if (t === undefined || v === undefined) throw new Error('Missing development trial')
      const supportPass = Number.isFinite(trainRank(selected.id))
      const stability = plateau(selected.id, neighbors(selected, trials), validationMetrics)
      const b = validationMetrics.get(baselineId)?.net ?? null
      const gates = {
        trainSupport: supportPass,
        trainPositive: meets(t.net),
        validationPositive: meets(v.net),
        validationBeatsReference: b !== null && meets(v.net, b),
        validationSupport: v.closed >= 20,
        validationExTop5: meets(v.exTop5Net),
        validationPlateau: stability.pass,
      }
      return {
        trial: selected,
        train: t,
        validation: v,
        validationPlateau: stability,
        gates,
        developmentPass: Object.values(gates).every(Boolean),
      }
    }
    return {
      schemaVersion: 'bayn.orb-zab-wave1b.freeze.v1',
      manifestSha256: provenance.manifestHash,
      sources: yield* sourceIdentity,
      primaryCost,
      split: { train, validation, holdout },
      currentTrials: trials.length,
      priorTrials,
      benchmark: {
        trainDailyDeflationBenchmark: benchmark,
        nondegenerateTrainTrials: trainSharpes.length,
        multiplicity,
      },
      selected: { orb: select('orb'), noise: select('noise') },
    }
  })

type Freeze = Effect.Success<ReturnType<typeof develop>>

const leaveOneOut = (
  days: readonly ResearchDay[],
  ranges: readonly Range[],
  trial: Trial,
  universe: readonly string[],
  cost: Cost,
) =>
  Object.fromEntries(
    (trial.engine === 'noise' ? noiseUniverse(trial) : universe).map((symbol) => {
      const path = replay(days, trial, universe, cost, symbol)
      return [
        symbol,
        ranges.map((range) => {
          const window = inRange(path, range)
          const observed = observedNet(window)
          return [
            observed.length === window.length ? observed.reduce((total, value) => total + value, 0) : null,
            window.reduce((total, day) => total + day.trades.reduce((net, trade) => net + trade.net, 0), 0),
            observed.length,
            window.reduce((total, day) => total + day.trades.length, 0),
          ]
        }),
      ]
    }),
  )

const evaluate = (
  days: readonly ResearchDay[],
  ranges: readonly Range[],
  universe: readonly string[],
  benchmark: number | null,
) =>
  trials.map((trial) => ({
    id: trial.id,
    costs: Object.fromEntries(
      costs.map((cost) => {
        const path = replay(days, trial, universe, cost)
        return [
          cost,
          {
            windows: ranges.map((range) => summarize(inRange(path, range), benchmark)),
            loso: leaveOneOut(days, ranges, trial, universe, cost),
          },
        ]
      }),
    ),
  }))

const compactTrials = (rows: ReturnType<typeof evaluate>) =>
  rows.map(({ id, costs: scenarios }) => ({
    id,
    costs: Object.fromEntries(
      costs.map((cost) => [
        cost,
        {
          ...scenarios[cost],
          windows: scenarios[cost].windows.map((metric) => Object.values(metric)),
        },
      ]),
    ),
  }))

const coverage = (days: readonly ResearchDay[], ranges: readonly Range[]) => {
  const symbols = [...new Set(days.flatMap((day) => [...day.symbols.keys()]))].sort()
  return Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      ranges.map((range) => {
        const window = inRange(days, range)
        const series = window.flatMap((day) => {
          const s = day.symbols.get(symbol)
          return s === undefined ? [] : [s]
        })
        return {
          anyBars: series.filter((s) => s.count[s.bars.length] > 0).length,
          fullSessions: series.filter((s) => s.count[s.bars.length] === s.bars.length).length,
          atrAvailable: series.filter((s) => s.atrRatio !== null).length,
          rvolAvailable: horizons.map((h) => series.filter((s) => (s.relativeVolumes.get(h) ?? null) !== null).length),
        }
      }),
    ]),
  )
}

const tradeAttribution = (a: readonly Outcome[], b: readonly Outcome[]) => {
  const index = (days: readonly Outcome[]) =>
    new Map(days.flatMap((day) => day.trades.map((t) => [`${day.date}:${t.symbol}:${t.side}:${t.minute}`, t] as const)))
  const ref = index(a)
  const stressed = index(b)
  const trades = [...ref.values()]
  const amounts = (list: typeof trades) =>
    list.reduce(
      (metric, t) => ({
        closed: metric.closed + 1,
        gross: metric.gross + t.gross,
        fee: metric.fee + t.feeUsd,
        executionCost: metric.executionCost + t.friction,
        net: metric.net + t.net,
      }),
      { closed: 0, gross: 0, fee: 0, executionCost: 0, net: 0 },
    )
  const group = (key: (trade: (typeof trades)[number]) => string) =>
    Object.fromEntries(
      [...Map.groupBy(trades, key)].sort(([x], [y]) => x.localeCompare(y)).map(([k, values]) => [k, amounts(values)]),
    )
  const matched = [...ref.keys()].filter((key) => stressed.has(key))
  return {
    at2: amounts(trades),
    at10: amounts([...stressed.values()]),
    matched2: amounts(matched.flatMap((key) => ref.get(key) ?? [])),
    matched10: amounts(matched.flatMap((key) => stressed.get(key) ?? [])),
    droppedFrom2: amounts([...ref].flatMap(([key, t]) => (stressed.has(key) ? [] : [t]))),
    addedAt10: amounts([...stressed].flatMap(([key, t]) => (ref.has(key) ? [] : [t]))),
    at2BySymbol: group((t) => t.symbol),
    at2BySide: group((t) => (t.side === 1 ? 'long' : 'short')),
    at2ByExit: group((t) => t.reason),
    at2ByEntryMinute: group((t) => String(t.minute)),
  }
}

const correlations = (
  days: readonly ResearchDay[],
  ranges: readonly Range[],
  universe: readonly string[],
  middayUniverse: readonly string[],
  orb: Trial,
  noise: Trial,
) =>
  costs.map((bps) => {
    const sleeves = [
      replay(days, orb, universe, bps),
      replay(days, noise, universe, bps),
      replay(days, null, middayUniverse, bps),
    ]
    return {
      bps,
      byWindow: ranges.map((range) => {
        const rows = inRange(days, range).map((day) => day.date)
        const byDate = sleeves.map((sleeve) => new Map(sleeve.map((d) => [d.date, sessionNet(d)])))
        const complete = rows.flatMap((date) => {
          const [a, b, c] = byDate.map((sleeve) => sleeve.get(date) ?? null)
          return a === null || b === null || c === null ? [] : [[a, b, c]]
        })
        const columns = [0, 1, 2].map((i) => complete.map((row) => row[i]))
        return {
          matchedCompleteSessions: complete.length,
          totalSessions: rows.length,
          matrix: columns.map((a) => columns.map((b) => pearson(a, b))),
        }
      }),
    }
  })

const report = (input: string, freeze: Freeze) =>
  Effect.gen(function* () {
    const { multiDays, liveDays, iexDiagnostic, provenance } = yield* readResearchData(input, true)
    const multiRanges = [all, train, validation, holdout, ...halfYears]
    const liveRanges = [live, ...liveFolds(liveDays)]
    const benchmark = freeze.benchmark.trainDailyDeflationBenchmark
    const multi = evaluate(multiDays, multiRanges, multiSymbols, benchmark)
    const recent = evaluate(liveDays, liveRanges, liveSymbols, benchmark)
    const holdoutIndex = multiRanges.indexOf(holdout)
    const holdoutMetrics = new Map(multi.map((trial) => [trial.id, trial.costs[primaryCost].windows[holdoutIndex]]))
    const audit = (selection: Freeze['selected']['orb'], reference: Trial) => {
      const { trial, developmentPass } = selection
      const row = multi.find((candidate) => candidate.id === trial.id)
      const liveRow = recent.find((candidate) => candidate.id === trial.id)
      if (row === undefined || liveRow === undefined) throw new Error('Missing frozen trial in report')
      const hold = row.costs[primaryCost].windows[holdoutIndex]
      const referenceNet = holdoutMetrics.get(reference.id)?.net ?? null
      const loo = Object.values(row.costs[primaryCost].loso)
      const stability = plateau(trial.id, neighbors(trial, trials), holdoutMetrics)
      const gates = {
        developmentPass,
        holdoutPositiveAllCosts: costs.every((cost) => meets(row.costs[cost].windows[holdoutIndex].net)),
        holdoutBeatsReference: referenceNet !== null && meets(hold.net, referenceNet),
        holdoutSupport: hold.closed >= 20,
        holdoutExTop5: meets(hold.exTop5Net),
        holdoutPlateau: stability.pass,
        holdoutLoso: loo.length >= 2 && loo.every((variant) => meets(variant[holdoutIndex][0])),
        holdoutBlockBootstrap: hold.blockP !== null && hold.blockP < 0.05,
        holdoutDeflatedSharpe: hold.dsr !== null && hold.dsr >= 0.95,
        live66PositiveAt10: meets(liveRow.costs[primaryCost].windows[0].net),
      }
      return { id: trial.id, gates, holdoutPlateau: stability, passedModelGates: Object.values(gates).every(Boolean) }
    }
    const orb = freeze.selected.orb.trial
    const noise = freeze.selected.noise.trial
    const attribution = (days: readonly ResearchDay[], ranges: readonly Range[], universe: readonly string[]) =>
      Object.fromEntries(
        [v2Orb, v2Noise, orb, noise].map((trial) => {
          const a = replay(days, trial, universe, 2)
          const b = replay(days, trial, universe, 10)
          return [trial.id, ranges.map((range) => tradeAttribution(inRange(a, range), inRange(b, range)))]
        }),
      )
    return {
      schemaVersion: 'bayn.orb-zab-wave1b.results.v1',
      qualification: 'UNQUALIFIED',
      provenance,
      freezeSha256: sha256(JSON.stringify(freeze)),
      trials,
      bootstrap,
      dsr: freeze.benchmark,
      metricColumns: Object.keys(summarize([], null)),
      losoColumns: ['wholeWindowNet', 'supportedClosedNet', 'completeSessions', 'closedTrades'],
      rvolCoverageHorizons: horizons,
      correlationOrder: ['frozenOrb', 'frozenNoise', 'v2MiddaySelector'],
      iexDiagnostic,
      qualificationAudit: { orb: audit(freeze.selected.orb, v2Orb), noise: audit(freeze.selected.noise, v2Noise) },
      multiyear: {
        universe: multiSymbols,
        windows: multiRanges,
        coverage: coverage(multiDays, multiRanges),
        trials: compactTrials(multi),
        correlations: correlations(multiDays, multiRanges, multiSymbols, ['AAPL', 'AMZN', 'NVDA'], orb, noise),
        attribution: attribution(multiDays, multiRanges, multiSymbols),
      },
      live66: {
        universe: liveSymbols,
        windows: liveRanges,
        coverage: coverage(liveDays, liveRanges),
        trials: compactTrials(recent),
        correlations: correlations(liveDays, liveRanges, liveSymbols, liveSymbols, orb, noise),
        attribution: attribution(liveDays, liveRanges, liveSymbols),
      },
    }
  })

const runResearch = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [mode, input, freezePath, output, ...extra] = args
    if (
      input === undefined ||
      freezePath === undefined ||
      extra.length !== 0 ||
      (mode === '--freeze' ? output !== undefined : mode !== '--report' || output === undefined)
    ) {
      return yield* new ResearchEvidenceError({
        message:
          'Usage: --freeze <directory|--s3> <new-freeze.json> | --report <directory|--s3> <freeze.json> <new-results.json>',
      })
    }
    const fs = yield* FileSystem.FileSystem
    const destination = mode === '--freeze' ? freezePath : output
    if (destination === undefined || (yield* fs.exists(destination))) {
      return yield* new ResearchEvidenceError({ message: 'Output must not exist' })
    }
    if (new Set(trials.map((trial) => trial.id)).size !== trials.length) throw new Error('Duplicate trial ID')
    const freeze = yield* develop(input)
    const write = (text: string) => fs.writeFileString(destination, text + '\n', { flag: 'wx', mode: 0o600 })
    if (mode === '--freeze') return yield* write(JSON.stringify(freeze, null, 2))

    const freezeText = yield* fs.readFileString(freezePath)
    const expected: unknown = yield* Effect.try({
      try: () => JSON.parse(freezeText),
      catch: (cause) => new ResearchEvidenceError({ message: 'Invalid development freeze JSON', cause }),
    })
    if (JSON.stringify(expected) !== JSON.stringify(freeze)) {
      return yield* new ResearchEvidenceError({
        message: 'Development freeze does not match inputs, source or selection',
      })
    }
    const result = yield* report(input, freeze)
    return yield* write(
      JSON.stringify(
        result,
        (_key, value: unknown) =>
          typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(8)) : value,
        2,
      ),
    )
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runResearch(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline CLI owns the platform file boundary
      Effect.provide(NodeServices.layer),
    ),
  )
}
