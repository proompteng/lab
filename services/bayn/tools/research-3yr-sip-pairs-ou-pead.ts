import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem } from 'effect'

import { clientConfig, load, sha256, type Market } from './pairs-pead-data'
import {
  costs,
  neighbors,
  splits,
  trials,
  windows,
  type Frequency,
  type Range,
  type Trial,
} from './pairs-pead-protocol'
import { prepare, replay } from './pairs-pead-replay'
import { sessionBars } from './pairs-pead-signals'
import { bootstrap, omitSummary, rawPath, summarize } from './pairs-pead-statistics'
import { dailySharpe, deflationBenchmark } from './research-orb-zab-statistics'

const primaryCost = 10
const version = 'bayn.wave2f.sip-pairs-pead'
class EvidenceError extends Data.TaggedError('Wave2FEvidenceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const sourceFiles = [
  'pairs-pead-protocol.ts',
  'pairs-pead-data.ts',
  'pairs-pead-signals.ts',
  'pairs-pead-replay.ts',
  'pairs-pead-statistics.ts',
  'research-orb-zab-statistics.ts',
  'research-3yr-sip-pairs-ou-pead.ts',
  '../../../docs/bayn/evidence/2026-11-27-3yr-sip-pairs-ou-pead/PROTOCOL.md',
]
const sources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const hashes: Record<string, string> = {}
  for (const path of sourceFiles)
    hashes[path] = sha256(yield* fs.readFile(fileURLToPath(new URL(path, import.meta.url))))
  return hashes
})

export const committedReceipt = (path: string, contents: string) => {
  const root = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'])
  if (root.exitCode !== 0) return false
  const rel = relative(root.stdout.toString().trim(), resolve(path))
  if (rel.startsWith('../')) return false
  const committed = Bun.spawnSync(['git', 'show', 'HEAD:' + rel], { cwd: root.stdout.toString().trim() })
  return committed.exitCode === 0 && committed.stdout.toString() === contents
}

const block = (frequency: Frequency) => (frequency === 'daily' ? bootstrap.dailyBlock : bootstrap.intradayBlock)
const collect = (m: Market, w: Range) =>
  m.sessions.flatMap(({ date }, i) => (date >= w.from && date <= w.to ? [i] : []))
const returns = (market: Market) => {
  const spy = sessionBars(market, 'SPY').close
  return Array.from(spy, (v, d) => (v > 0 && d > 0 && spy[d - 1] > 0 ? v / spy[d - 1] - 1 : 0))
}
const positive = (n: number | null) => n !== null && n > 0
type Metric = ReturnType<typeof summarize>

export const plateau = (trial: Trial, metrics: ReadonlyMap<string, Metric>) => {
  const adjacent = neighbors(trial).map(({ id }) => ({ id, net: metrics.get(id)?.net ?? null }))
  return {
    neighbors: adjacent,
    pass:
      adjacent.length > 0 && adjacent.filter(({ net }) => positive(net)).length >= Math.ceil(adjacent.length * 0.75),
  }
}
const gates = (m: Metric, p: ReturnType<typeof plateau>) => ({
  supported: m.exits >= 20,
  positive: positive(m.net),
  exTop5: positive(m.exTop5),
  bootstrap: m.bootP !== null && m.bootP < 0.05,
  dsr: m.dsr !== null && m.dsr >= 0.95,
  plateau: p.pass,
  beta: m.betaToSpy !== null && Math.abs(m.betaToSpy) <= 0.1,
})
const pass = (value: Record<string, boolean>) => Object.values(value).every(Boolean)
type Input = Awaited<ReturnType<typeof load>>

const develop = (input: Input, hashes: Record<string, string>) => {
  const output = (['daily', 'intraday'] as const).map((frequency) => {
    const market = input[frequency]
    const [train, validation] = splits[frequency].map((w) => collect(market, w))
    const spy = returns(market)
    const setup = prepare(market, input.core)
    const configs = trials.filter((t) => t.frequency === frequency)
    const paths = configs.map((trial) => ({ trial, ledger: replay(setup, trial).total }))
    const trainSharpes = paths.flatMap(({ ledger }) => {
      const sr = dailySharpe(rawPath(ledger, train, primaryCost))
      return sr !== null && train.every((d) => ledger.missing[d] === 0) ? [sr] : []
    })
    const benchmark = deflationBenchmark(trainSharpes, configs.length)
    const score = (range: number[]) =>
      new Map(
        paths.map(({ trial, ledger }) => [
          trial.id,
          summarize(ledger, range, primaryCost, block(frequency), benchmark, spy),
        ]),
      )
    const t = score(train),
      v = score(validation)
    const selected = [...new Set(configs.map((c) => c.engine))].map((engine) => {
      const rank = (trial: Trial) => {
        const m = t.get(trial.id)
        return m !== undefined && m.exits >= 20 && positive(m.net) ? (m.sharpe ?? -Infinity) : -Infinity
      }
      const candidate = configs
        .filter((c) => c.engine === engine && (!('universe' in c) || c.universe === 'stocks'))
        .toSorted((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))[0]
      if (!Number.isFinite(rank(candidate))) return { engine, selection: null }
      const tm = t.get(candidate.id),
        vm = v.get(candidate.id)
      if (tm === undefined || vm === undefined) throw new Error('Missing development metrics')
      const tp = plateau(candidate, t),
        vp = plateau(candidate, v)
      const trainGates = gates(tm, tp),
        validationGates = gates(vm, vp)
      return {
        engine,
        selection: {
          id: candidate.id,
          train: tm,
          validation: vm,
          trainPlateau: tp,
          validationPlateau: vp,
          trainGates,
          validationGates,
          developmentPass: pass(trainGates) && pass(validationGates),
        },
      }
    })
    return { frequency, trialCount: configs.length, nondegenerateTrainTrials: trainSharpes.length, benchmark, selected }
  })
  return {
    schema: version + '.freeze.v1',
    primaryCost,
    bootstrap,
    splits,
    trials,
    sources: hashes,
    provenance: input.provenance,
    coverage: {
      intraday: {
        sessions: input.intraday.sessions.length,
        outsideRth: input.intraday.outsideRth,
        bySymbol: input.intraday.observed,
      },
      daily: { sessions: input.daily.sessions.length, bySymbol: input.daily.observed },
    },
    development: output,
  }
}

const evaluate = (input: Input, freeze: ReturnType<typeof develop>, freezeText: string) => ({
  schema: version + '.results.v1',
  freezeSha256: sha256(freezeText),
  provenance: input.provenance,
  bootstrap,
  leaveOutColumns: ['net', 'exTop5'],
  panels: freeze.development.map(({ frequency, benchmark, selected }) => {
    const market = input[frequency]
    const spy = returns(market)
    const setup = prepare(market, input.core)
    const ranges = windows(frequency)
    const indices = ranges.map((w) => collect(market, w))
    const holdIndex = 2
    const trialResults = trials
      .filter((t) => t.frequency === frequency)
      .map((trial) => {
        const { total, components } = replay(setup, trial)
        const scenarios = costs.map((bps) => ({
          bps,
          windows: indices.map((i) => summarize(total, i, bps, block(frequency), benchmark, spy)),
          leaveOut: Object.fromEntries(
            [...components].map(([id, l]) => [id, indices.map((i) => omitSummary(total, l, i, bps))]),
          ),
        }))
        return { trial, scenarios }
      })
    const maps = costs.map((_, c) =>
      indices.map((_, w) => new Map(trialResults.map(({ trial, scenarios }) => [trial.id, scenarios[c].windows[w]]))),
    )
    const results = trialResults.map((r) => ({
      ...r,
      scenarios: r.scenarios.map((s, c) => ({
        ...s,
        plateau: s.windows.map((_, i) => plateau(r.trial, maps[c][i])),
        windows: s.windows.map((m) => Object.values(m)),
      })),
    }))
    const audit = selected.map(({ engine, selection }) => {
      if (selection === null) return { engine, id: null, qualified: false }
      const chosen = trialResults.find(({ trial }) => trial.id === selection.id)
      if (chosen === undefined) throw new Error('Frozen selection missing')
      const primary = chosen.scenarios[2]
      const holdout = primary.windows[holdIndex]
      const holdPlateau = plateau(chosen.trial, maps[2][holdIndex])
      const holdoutGates = {
        ...gates(holdout, holdPlateau),
        positiveAllCosts: chosen.scenarios.every((s) => positive(s.windows[holdIndex].net)),
        leaveOut: Object.values(primary.leaveOut).every((w) => positive(w[holdIndex][0])),
      }
      return {
        engine,
        id: selection.id,
        developmentPass: selection.developmentPass,
        holdout,
        holdoutGates,
        qualified: selection.developmentPass && pass(holdoutGates),
      }
    })
    return {
      frequency,
      benchmark,
      coverage: { sessions: market.sessions.length, outsideRth: market.outsideRth, bySymbol: market.observed },
      ranges,
      metricColumns: Object.keys(trialResults[0].scenarios[0].windows[0]),
      results,
      audit,
    }
  }),
})

const encode = (data: unknown, pretty: boolean) =>
  JSON.stringify(
    data,
    (_key, value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)
        ? Number(value.toFixed(10))
        : value,
    pretty ? 2 : undefined,
  ) + '\n'

const research = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [stage, receipt, output, ...rest] = args
    if (
      receipt === undefined ||
      receipt.length === 0 ||
      rest.length > 0 ||
      (stage === '--freeze' ? output !== undefined : stage !== '--score' || output === undefined || output.length === 0)
    )
      return yield* new EvidenceError({
        message: 'Usage: --freeze <new-freeze.json> | --score <committed-freeze.json> <new-results.json>',
      })
    const fs = yield* FileSystem.FileSystem
    const target = output ?? receipt
    if (yield* fs.exists(target)) return yield* new EvidenceError({ message: 'Output already exists: ' + target })
    const expected = stage === '--score' ? yield* fs.readFileString(receipt) : null
    if (expected !== null && !committedReceipt(receipt, expected))
      return yield* new EvidenceError({ message: '--score requires the exact development freeze committed in HEAD' })

    const config = yield* clientConfig
    const read = (score: boolean) =>
      Effect.tryPromise({
        try: (signal) => load(config, score, signal),
        catch: (cause) => new EvidenceError({ message: 'Cannot verify and read frozen SIP inputs', cause }),
      })
    const hashes = yield* sources
    const freeze = develop(yield* read(false), hashes)
    const frozen = encode(freeze, true)
    if (stage === '--freeze') return yield* fs.writeFileString(target, frozen, { flag: 'wx' })
    if (expected !== frozen)
      return yield* new EvidenceError({
        message: 'Committed freeze disagrees with current data, source, or development outcomes',
      })
    const evidence = evaluate(yield* read(true), freeze, frozen)
    yield* fs.writeFileString(target, encode(evidence, false), { flag: 'wx' })
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    research(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns its file boundary
      Effect.provide(NodeServices.layer),
    ),
  )
}
