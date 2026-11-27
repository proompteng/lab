import { join } from 'node:path'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'

import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { regularCalendarReplayInput } from './midday-research-data'
import { mean, sum } from './midday-research-statistics'
import {
  holdoutEnd,
  liveStart,
  loadDataset,
  manifestSha256,
  researchStep,
  sha256,
  Sleeve4ResearchError,
  split,
  validationEnd,
} from './sleeve4-data'
import {
  bySplit,
  correlation,
  costGrid,
  costs,
  dailyNet,
  dsr,
  dsrThreshold,
  minimumEvidence,
  replay,
  sellFee,
  select,
  type Outcome,
} from './sleeve4-evaluation'
import {
  addHistory,
  contextSide,
  decide,
  minuteHistory,
  requiredSymbols,
  trialRegistry,
  type Frame,
  type Rule,
} from './sleeve4-signals'
import { runIntradayAlphaReplayVerification } from './verify-intraday-alpha-replay'

type Dataset = Effect.Success<ReturnType<typeof loadDataset>>
const ends = { train: '2025-06-30', validation: validationEnd, holdout: holdoutEnd }
const coreSymbols = ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY']
const costsForGate = [5, 10] as const
const phases = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const

const minuteOutcomes = (rule: Rule, frames: readonly Frame[]) =>
  frames.map((day) => replay(day.date, day.minutes, day.tapes, rule, decide(rule, day)))

const sipFrames = (dataset: Dataset) => {
  const history = addHistory(
    dataset.sip,
    (d) => d.date,
    (d) => d.bars,
    () => null,
  )
  return dataset.sip.map((day, i) => ({ ...day, prior: history[i]?.prior }))
}
const sipOutcomes = (rule: Rule, frames: ReturnType<typeof sipFrames>): Outcome[] =>
  frames.map((day) => {
    let observed = false
    const fills = rule.symbols.flatMap((symbol) => {
      const bar = day.bars.get(symbol)
      if (bar === undefined || day.prior === undefined) return []
      const side = contextSide(rule, symbol, bar.open, day.prior)
      if (side === null) return []
      observed = true
      // Diagnostic only: SIP daily cannot prove an executable fill after observing its opening print.
      return side === 0
        ? []
        : [
            {
              leg: { symbol, side, weight: 1 / rule.symbols.length },
              entry: bar.open,
              exit: bar.close,
              delay: 0,
            },
          ]
    })
    return { date: day.date, observed, intended: fills.length, fills }
  })

const develop = (dataset: Dataset) => {
  const core = minuteHistory(dataset.core)
  const sip = sipFrames(dataset)
  const coreRows = trialRegistry
    .filter((r) => r.panel === 'core')
    .map((rule) => {
      const days = bySplit(minuteOutcomes(rule, core))
      return { rule, train: costGrid(days.train), validation: costGrid(days.validation) }
    })
  const selection = select(coreRows)
  const daily = trialRegistry
    .filter((r) => r.panel === 'sip')
    .map((rule) => {
      const missingSymbols = requiredSymbols(rule).filter((s) => !dataset.sources.sip.includes(s))
      if (missingSymbols.length > 0) return { rule, missingSymbols, legacy: null, train: null, validation: null }
      const days = bySplit(sipOutcomes(rule, sip))
      return {
        rule,
        missingSymbols,
        legacy: costGrid(days.legacy),
        train: costGrid(days.train),
        validation: costGrid(days.validation),
      }
    })
  return { ...selection, daily }
}
type Development = ReturnType<typeof develop>

const sourceHashes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* Effect.forEach(
    [
      'research-orthogonal-sleeve4.ts',
      'sleeve4-data.ts',
      'sleeve4-evaluation.ts',
      'sleeve4-signals.ts',
      'midday-research-data.ts',
      'midday-research-statistics.ts',
      'verify-intraday-alpha-replay.ts',
    ],
    (name) => fs.readFile(join(import.meta.dir, name)).pipe(Effect.map((bytes) => [name, sha256(bytes)] as const)),
  )
  return Object.fromEntries(entries)
})

const freezeFor = (development: Development, sourceSha256: Record<string, string>) => {
  const chosen = development.development.find(({ rule }) => rule.id === development.selected)
  return {
    schemaVersion: 'bayn.sleeve4.freeze.v1',
    manifestSha256,
    sourceSha256,
    splitsThrough: ends,
    trialCount: trialRegistry.length,
    registrySha256: sha256(JSON.stringify(trialRegistry)),
    developmentSha256: sha256(JSON.stringify(development)),
    selected: development.selected,
    developmentQualified: chosen?.passed ?? false,
    frozenPeers: chosen?.peerIds ?? [],
  }
}

const summarizeBenchmark = (path: string, calendarJson: unknown) => {
  const source = regularCalendarReplayInput(calendarJson)
  const warmupStart = '2026-07-16'
  const calendar = {
    query: { start: warmupStart, end: holdoutEnd },
    response: source.response.filter(({ date }) => date >= warmupStart && date <= holdoutEnd),
  }
  const { policyHash, results, baselineCoverage, inputRows } = runIntradayAlphaReplayVerification([path], calendar, {
    evaluationStart: liveStart,
  })
  const perCost = results.map(({ slippageBps, sessionDetails }) => ({
    slippageBps,
    days: sessionDetails.map((d) => {
      const complete =
        d.baselineAvailable &&
        d.benchmarkAvailable &&
        d.baselineMissingSymbols.length === 0 &&
        d.missingConcurrentMarkWindows === 0 &&
        d.unresolvedExits.length === 0
      return {
        date: d.date,
        complete,
        engineBps: complete
          ? phases.map((phase) => sum(d.trades.filter((t) => t.phase === phase).map((t) => t.netPnlUsd)) / 10)
          : null,
      }
    }),
  }))
  return { policyHash, baselineCoverage, inputRows, perCost }
}

const benchReplay = (dataset: Dataset) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (dataset.liveRaw === undefined) {
        return yield* new Sleeve4ResearchError({
          operation: 'Replay the v2 benchmark',
          cause: 'Frozen live panel unavailable',
        })
      }
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-sleeve4-v2-' })
      const path = join(directory, 'live.tsv')
      yield* fs.writeFile(path, dataset.liveRaw)
      return yield* researchStep('Replay the existing v2 verifier', () =>
        summarizeBenchmark(path, dataset.calendarJson),
      )
    }),
  )

type Benchmark = ReturnType<typeof summarizeBenchmark>
const measureCorrelation = (daily: readonly Outcome[], benchmark: Benchmark) => {
  const byDate = new Map(daily.map((day) => [day.date, day]))
  return benchmark.perCost.map(({ slippageBps, days }) => {
    const cost = costs.find((c) => c === slippageBps)
    if (cost === undefined) throw new Error(`Unknown benchmark cost: ${slippageBps}`)
    const common = days.flatMap(({ date, engineBps }) => {
      const day = byDate.get(date)
      if (day?.observed !== true || engineBps === null) return []
      const pnl = dailyNet(day, cost)
      return pnl === null ? [] : [{ date, pnl, engineBps }]
    })
    return {
      cost,
      dates: common.map((d) => d.date),
      engines: phases.map((phase, index) => ({
        phase,
        ...correlation(
          common.flatMap(({ pnl, engineBps }) => {
            const leg = engineBps[index]
            return leg === undefined ? [] : [[pnl, leg] as const]
          }),
        ),
      })),
    }
  })
}

const minuteCard = (rule: Rule, days: readonly Outcome[], development: Development, benchmark: Benchmark) => {
  const key = rule.panel === 'live' ? 'live' : 'core'
  const scored = days.filter((d) => split(d.date) === 'holdout' && (key === 'core' || d.date >= liveStart))
  const statistics = costGrid(scored)
  const deflated = costs.map((cost) => {
    const rivals = development.development.map((d) => d.validation[cost]?.dailySharpe ?? null)
    const nullSharpe = dsrThreshold(rivals, scored.length, trialRegistry.length)
    return { cost, nullSharpe, probability: dsr(scored, cost, nullSharpe) }
  })
  return {
    statistics,
    deflated,
    correlations: measureCorrelation(scored, benchmark),
    daily: scored.map((d) => ({
      date: d.date,
      observed: d.observed,
      intended: d.intended,
      entered: d.fills.length,
      netBps: costs.map((cost) => dailyNet(d, cost)),
    })),
  }
}

const correlationPass = (card: ReturnType<typeof minuteCard>) =>
  card.correlations
    .filter(({ cost }) => cost !== 2)
    .every(({ engines }) =>
      engines.every(
        ({ n, activeTogether, pearson }) =>
          n >= 40 && activeTogether >= 10 && pearson !== null && Math.abs(pearson) < 0.25,
      ),
    )

const stressPass = (card: ReturnType<typeof minuteCard>) =>
  costsForGate.every((cost) => minimumEvidence(card.statistics[cost]))

const score = (dataset: Dataset, dev: Development, freeze: ReturnType<typeof freezeFor>, benchmark: Benchmark) => {
  const core = minuteHistory(dataset.core)
  const live = minuteHistory(dataset.live)
  const sip = sipFrames(dataset)
  const scoredIds = new Set([freeze.selected, ...freeze.frozenPeers])
  const holdout = trialRegistry
    .filter((rule) => scoredIds.has(rule.id))
    .map((rule) => ({
      rule,
      card: minuteCard(rule, minuteOutcomes(rule, core), dev, benchmark),
    }))
  const selected = holdout.find(({ rule }) => rule.id === freeze.selected)
  const liveDiagnostics = trialRegistry
    .filter((r) => r.panel === 'live')
    .map((rule) => {
      const sourceSymbols = dataset.sources.live?.symbols ?? []
      const missingSymbols = requiredSymbols(rule).filter((s) => !sourceSymbols.includes(s))
      return {
        rule,
        missingSymbols,
        holdout: missingSymbols.length > 0 ? null : minuteCard(rule, minuteOutcomes(rule, live), dev, benchmark),
      }
    })
  const dailyDiagnostics = dev.daily.map(({ rule, missingSymbols, legacy, train, validation }) => {
    const days = missingSymbols.length === 0 ? bySplit(sipOutcomes(rule, sip)).holdout : []
    const holdout = days.length === 0 ? null : costGrid(days)
    return {
      rule,
      missingSymbols,
      legacy,
      train,
      validation,
      holdout,
      deflated:
        holdout === null
          ? null
          : costs.map((cost) => {
              const rivals = dev.daily.map((d) => d.validation?.[cost]?.dailySharpe ?? null)
              const nullSharpe = dsrThreshold(rivals, days.length, trialRegistry.length)
              return { cost, nullSharpe, probability: dsr(days, cost, nullSharpe) }
            }),
    }
  })
  const loso =
    selected !== undefined
      ? selected.rule.symbols.map((symbol) => {
          const symbols = selected.rule.symbols.filter((s) => s !== symbol)
          // Rotation retains the observable four-index signal while excluding the leg.
          if (symbols.length === 0) return { symbol, holdout: null }
          const reduced = { ...selected.rule, symbols }
          return { symbol, holdout: costGrid(bySplit(minuteOutcomes(reduced, core)).holdout) }
        })
      : []
  const peers = holdout.filter((peer) => peer !== selected)
  const retainedPeers = peers.filter(({ card }) => stressPass(card))
  const gates =
    selected !== undefined
      ? {
          development: freeze.developmentQualified,
          stress: stressPass(selected.card),
          bootstrap: costsForGate.every((cost) => (selected.card.statistics[cost]?.bootstrapP ?? 1) < 0.05),
          deflated: costsForGate.every(
            (cost) => (selected.card.deflated.find((d) => d.cost === cost)?.probability ?? 0) >= 0.95,
          ),
          correlations: correlationPass(selected.card),
          plateau: retainedPeers.length >= 2 && retainedPeers.length * 2 >= peers.length,
          leaveOneOut: loso.every(
            ({ holdout }) => holdout === null || costsForGate.every((cost) => (holdout[cost]?.exTop5Bps ?? 0) > 0),
          ),
        }
      : null
  const passes = gates !== null && Object.values(gates).every(Boolean)
  return {
    schemaVersion: 'bayn.sleeve4.results.v1',
    freeze,
    sources: dataset.sources,
    assumptions: {
      costs,
      sellFee,
      coreSymbols,
      liveSpliceStart: liveStart,
      decisionObservationsMinimumRate: 0.8,
      minimumTradeDays: 20,
      minimumFillRate: 0.9,
      correlationMinimumDates: 40,
      correlationMinimumCoActiveDates: 10,
    },
    decision: passes ? 'CANDIDATE_FOR_WAVE_2' : 'NO_PROMOTION',
    gates,
    benchmark,
    coreDevelopment: dev.development,
    coreHoldout: holdout,
    liveDiagnostics,
    dailyDiagnostics,
    selectedLeaveOneOut: loso,
    coverage: {
      core: Object.fromEntries(
        Object.entries(bySplit(core.map((d) => ({ date: d.date, observed: true, intended: 0, fills: [] })))).map(
          ([part, days]) => [part, days.length],
        ),
      ),
      live: live.filter((d) => d.date >= liveStart).length,
      meanLiveTapes: mean(live.filter((d) => d.date >= liveStart).map((d) => d.tapes.size)),
    },
  }
}

// Keep the development loader out of the one-time holdout read. Verify the frozen JSON
// so source, registry, data and frozen winner are bound before scoring.
export const verifyFreeze = (actual: string, expected: string) => {
  if (JSON.stringify(JSON.parse(actual)) !== JSON.stringify(JSON.parse(expected))) {
    throw new Error('Frozen selection does not match current source and development data')
  }
}

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [mode, freezePath, outputOrDirectory, directory] = args
    if (
      freezePath === undefined ||
      (mode !== '--freeze' && mode !== '--score') ||
      (mode === '--score' && outputOrDirectory === undefined) ||
      (mode === '--freeze' && directory !== undefined)
    ) {
      return yield* new Sleeve4ResearchError({
        operation: 'Parse arguments',
        cause:
          'Usage: bun services/bayn/tools/research-orthogonal-sleeve4.ts --freeze <freeze.json> [dataset-dir] | --score <freeze.json> <results.json> [dataset-dir]',
      })
    }
    const fs = yield* FileSystem.FileSystem
    const dev = develop(yield* loadDataset(mode === '--freeze' ? outputOrDirectory : directory, false))
    const freeze = freezeFor(dev, yield* sourceHashes)
    const frozen = JSON.stringify(freeze, null, 2) + '\n'
    if (mode === '--freeze') {
      yield* fs.writeFileString(freezePath, frozen, { flag: 'wx' })
    } else if (outputOrDirectory !== undefined) {
      const existing = yield* fs.readFileString(freezePath)
      yield* researchStep('Verify the development-only receipt', () => verifyFreeze(existing, frozen))
      const dataset = yield* loadDataset(directory, true)
      const benchmark = yield* benchReplay(dataset)
      const scored = score(dataset, dev, freeze, benchmark)
      yield* fs.writeFileString(outputOrDirectory, JSON.stringify(scored, null, 2) + '\n', { flag: 'wx' })
    }
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- standalone research entry point owns file services
      Effect.provide(NodeServices.layer),
    ),
  )
}
