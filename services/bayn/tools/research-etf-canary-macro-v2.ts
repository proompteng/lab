import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem } from 'effect'

import { load, sha256 } from './etf-canary-macro-data'
import {
  bootstrap,
  borrow,
  costs,
  etfs,
  grid,
  neighbors,
  priorTrials,
  sellFee,
  shy,
  splits,
  trialId,
  type Trial,
} from './etf-canary-macro-protocol'
import { marks, replay, type Marks } from './etf-canary-macro-replay'
import { features, targets } from './etf-canary-macro-signals'
import { omitted, passes, stationaryBlocks, summarize, type Window } from './etf-canary-macro-statistics'
import { dailySharpe, deflationBenchmark } from './research-orb-zab-statistics'

const version = 'bayn.wave4d.etf-canary-macro.v2'
const head = 'refs/heads/codex/bayn-w4d-etf-risk-premia-v2'
const protocol = '../../../docs/bayn/evidence/2026-11-27-etf-canary-macro-v2/protocol.md'
const sources = [
  protocol,
  'etf-canary-macro-data.ts',
  'etf-canary-macro-protocol.ts',
  'etf-canary-macro-replay.ts',
  'etf-canary-macro-signals.ts',
  'etf-canary-macro-statistics.ts',
  'research-orb-zab-statistics.ts',
  'research-etf-canary-macro-v2.ts',
]
const trials = [...grid()]
const ids = trials.map(trialId)
const retainedCosts = costs.map((roundTripBp) => ({
  roundTripBp,
  feeSellBp: sellFee * 10_000,
  shortBorrowAnnual: borrow,
}))
const cap = (trial: Trial) => (trial.kind === 'macro' ? 4 : 6)
const cumulativeTrials = priorTrials + trials.length

class EvidenceError extends Data.TaggedError('CanaryMacroEvidenceError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

type Input = Effect.Success<ReturnType<typeof load>>

const windows = (prices: Marks, score: boolean): Window[] => {
  const size = splits.train[2] + splits.validation[2]
  const folds: Window[] = [
    { name: 'train', first: 0, end: splits.train[2] },
    { name: 'validation', first: splits.train[2], end: size },
  ]
  if (!score) return folds
  folds.push({ name: 'holdout', first: size, end: prices.length }, { name: 'full', first: 0, end: prices.length })
  let first = 0
  while (first < prices.length) {
    const name = prices[first].date.slice(0, 4)
    let end = first + 1
    while (end < prices.length && prices[end].date.startsWith(name)) end++
    folds.push({ name, first, end })
    first = end
  }
  return folds
}

export const develop = (input: Input, hashes: Readonly<Record<string, string>>) => {
  const prices = marks(input.sessions)
  const model = features(input.sessions)
  const folds = windows(prices, false)
  const sharpes = costs.map((): number[] => [])
  const development = trials.map((trial) => {
    const w = targets(trial, model, -1)
    return costs.map((bp, k) => {
      const swept = replay(prices, w, trial, bp, true, -1)
      const zero = replay(prices, w, trial, bp, false, -1)
      const sr = dailySharpe(Array.from(swept.net, (r, t) => r - prices[t].shy))
      if (sr !== null) sharpes[k].push(sr)
      return folds.map((fold) => {
        const s = summarize(swept, zero, prices, fold, null)
        return [
          s.withShy.net,
          s.zeroCash.net,
          s.withShy.excessVsShy,
          s.withShy.exTop5.excessVsShy,
          s.withShy.exTop10.excessVsShy,
          s.withShy.turnoverPerYear,
        ]
      })
    })
  })
  return {
    schema: version + '.freeze',
    sources: hashes,
    universe: etfs,
    dataset: input.provenance,
    coverage: input.coverage,
    splits: { train: splits.train, validation: splits.validation },
    scenarios: retainedCosts,
    bootstrap,
    multiplicity: { wave3c: priorTrials, wave4d: trials.length, cumulative: cumulativeTrials },
    deflation: sharpes.map((v) => ({
      finiteTrials: v.length,
      expectedMaxDailySharpe: deflationBenchmark(v, cumulativeTrials),
    })),
    ids,
    trials,
    axes: {
      development: ['trial', 'scenario', 'fold', 'metric'],
      folds: folds.map((f) => f.name),
      metrics: [
        'netWithShy',
        'netZeroCash',
        'excessVsShy',
        'exTop5ExcessVsShy',
        'exTop10ExcessVsShy',
        'turnoverPerYear',
      ],
    },
    development,
  }
}

type Freeze = ReturnType<typeof develop>
type Stats = ReturnType<typeof summarize>
const packBook = (book: Stats['withShy']) => [
  book.net,
  book.excessVsShy,
  book.exTop5.net,
  book.exTop5.excessVsShy,
  book.exTop10.net,
  book.exTop10.excessVsShy,
  book.annualSharpe,
  book.annualExcessSharpe,
  book.maxDrawdown,
  book.calmar,
  book.turnoverPerYear,
  book.spyBeta,
  book.downSpyNet,
  book.downSpyExcessVsShy,
]
const bookColumns = [
  'net',
  'excessVsShy',
  'exTop5Net',
  'exTop5ExcessVsShy',
  'exTop10Net',
  'exTop10ExcessVsShy',
  'annualSharpe',
  'annualExcessSharpe',
  'maxDrawdown',
  'calmar',
  'turnoverPerYear',
  'spyBeta',
  'downSpyNet',
  'downSpyExcessVsShy',
]

export const evaluate = (input: Input, freeze: Freeze, receipt: { sha256: string; commit: string }) => {
  const prices = marks(input.sessions)
  const model = features(input.sessions)
  const folds = windows(prices, true)
  const splitsOnly = folds.slice(0, 3)
  const blocks = new Map<number, Int32Array>()
  for (const { first, end } of folds) {
    const count = end - first
    if (!blocks.has(count)) blocks.set(count, stationaryBlocks(count))
  }
  const byTrial = trials.map((trial) => {
    const w = targets(trial, model, -1)
    return costs.map((bp, k) => {
      const swept = replay(prices, w, trial, bp, true, -1)
      const zero = replay(prices, w, trial, bp, false, -1)
      const benchmark = freeze.deflation[k].expectedMaxDailySharpe
      return folds.map((fold) => summarize(swept, zero, prices, fold, benchmark, blocks.get(fold.end - fold.first)))
    })
  })

  const loeo = etfs.map((_, omit) =>
    trials.map((trial) => {
      const w = targets(trial, model, omit)
      return costs.map((bp) => {
        const swept = replay(prices, w, trial, bp, omit !== shy, omit)
        const zero = replay(prices, w, trial, bp, false, omit)
        return splitsOnly.map((fold) => omitted(swept, zero, prices, fold))
      })
    }),
  )
  const positions = new Map(ids.map((key, i) => [key, i]))
  const neighborsByTrial = trials.map((trial) => neighbors(trial, trials))
  const plateau = trials.map((trial, i) =>
    costs.map((_, k) => {
      const near = neighborsByTrial[i]
      const passing = near.filter((id) => {
        const index = positions.get(id)
        if (index === undefined) throw new Error('Unknown plateau neighbor ' + id)
        return byTrial[index][k].slice(0, 3).every((s) => passes(s, cap(trial)))
      })
      return {
        tested: near.length,
        passing: passing.length,
        fraction: near.length > 0 ? passing.length / near.length : null,
      }
    }),
  )
  const passesSplit = byTrial.map((scenarios, i) =>
    scenarios.map((s) => s.slice(0, 3).every((f) => passes(f, cap(trials[i])))),
  )
  const structuralPass = byTrial.map((scenarios, i) =>
    scenarios.map((s) =>
      s.slice(0, 3).every(({ withShy }) => withShy.excessVsShy > 0 && withShy.turnoverPerYear < cap(trials[i])),
    ),
  )
  const qualified = ids.filter((_, i) =>
    costs.every((_, k) => {
      const h = byTrial[i][k][2]
      return (
        passesSplit[i][k] &&
        h.pStationary !== null &&
        h.pStationary < 0.05 &&
        h.cumulativeDsr !== null &&
        h.cumulativeDsr >= 0.95 &&
        (plateau[i][k].fraction ?? 0) >= 2 / 3 &&
        loeo.every((omission) => omission[i][k].every((fold) => fold[2] > 0))
      )
    }),
  )

  return {
    schema: version + '.results',
    freeze: receipt,
    dataset: input.provenance,
    coverage: input.coverage,
    universe: etfs,
    ids,
    scenarios: retainedCosts,
    windows: folds.map(({ name, first, end }, i) => ({
      name,
      from: prices[first].date,
      through: prices[end - 1].date,
      sessions: end - first,
      buyHoldShy: byTrial[0][0][i].buyHoldShy,
    })),
    axes: {
      metrics: ['trial', 'scenario', 'window', 'group'],
      groups: ['withShy', 'zeroCash', 'pStationary', 'cumulativeDsr'],
      books: bookColumns,
      loeo: ['omittedSymbol', 'trial', 'scenario', 'split', 'metric'],
      loeoMetrics: ['netWithShy', 'netZeroCash', 'excessVsShy', 'turnoverWithShyPerYear'],
      plateau: ['trial', 'scenario'],
      structuralPass: ['trial', 'scenario'],
    },
    metrics: byTrial.map((scenarios) =>
      scenarios.map((series) =>
        series.map((s) => [packBook(s.withShy), packBook(s.zeroCash), s.pStationary, s.cumulativeDsr]),
      ),
    ),
    loeo,
    neighborsByTrial,
    plateau,
    structuralPass,
    qualified,
  }
}

const encode = (value: unknown) =>
  JSON.stringify(
    value,
    (key, v: unknown) => {
      if (typeof v !== 'number') return v
      if (!Number.isFinite(v)) throw new Error('Nonfinite evidence metric: ' + key)
      return Number.isInteger(v) ? v : Number(v.toFixed(10))
    },
    2,
  ) + '\n'

const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=30', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

export const verifyPublished = (path: string, bytes: string, sources: ReadonlyMap<string, string>, runGit = git) => {
  const root = runGit('rev-parse', '--show-toplevel').trim()
  const key = relative(root, resolve(path))
  if (key.startsWith('../') || key.length === 0) throw new Error('Freeze must live in the repository')
  if (runGit('show', 'HEAD:' + key) !== bytes) throw new Error('Freeze does not match HEAD')
  const advertised = runGit('ls-remote', '--exit-code', 'origin', head).trim().split(/\s+/)
  if (advertised[1] !== head || !/^[a-f0-9]{40}$/.test(advertised[0]))
    throw new Error('Cannot verify remote freeze branch')
  if (runGit('show', advertised[0] + ':' + key) !== bytes) throw new Error('Freeze is not published on origin')
  const commit = runGit('log', '-1', '--format=%H', advertised[0], '--', key).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Cannot identify published freeze commit')
  for (const [path, expected] of sources) {
    const source = relative(root, path)
    if (sha256(runGit('show', commit + ':' + source)) !== expected)
      throw new Error('Freeze commit did not publish this version of ' + source)
  }
  return { sha256: sha256(bytes), commit }
}

const research = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [stage, receipt, ...tail] = args
    const score = stage === '--score'
    const output = score ? tail.shift() : receipt
    const [flag, source, supplementPath] = tail
    if (
      (stage !== '--freeze' && !score) ||
      receipt === undefined ||
      receipt.length === 0 ||
      output === undefined ||
      output.length === 0 ||
      (tail.length !== 0 &&
        (tail.length !== 3 ||
          flag !== '--supplement' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(source) ||
          supplementPath.length === 0))
    ) {
      return yield* new EvidenceError({
        message:
          'Usage: --freeze <new-freeze.json> | --score <published-freeze.json> <new-results.json>; append --supplement <source-id> <bars.tsv.gz>',
      })
    }
    if (trials.length > 160 || new Set(ids).size !== trials.length)
      return yield* new EvidenceError({ message: 'Trial grid exceeds cap or has duplicate IDs' })
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(output)) return yield* new EvidenceError({ message: 'Output already exists: ' + output })
    const hashes: Record<string, string> = {}
    const publishedSources = new Map<string, string>()
    for (const name of sources) {
      const path = fileURLToPath(new URL(name, import.meta.url))
      hashes[name] = sha256(yield* fs.readFile(path))
      publishedSources.set(path, hashes[name])
    }
    const expected = score ? yield* fs.readFileString(receipt) : null
    const published =
      expected === null
        ? null
        : yield* Effect.try({
            try: () => verifyPublished(receipt, expected, publishedSources),
            catch: (cause) =>
              new EvidenceError({ message: 'Publish the exact development receipt before opening Holdout', cause }),
          })
    const supplement = tail.length === 0 ? null : { source, bytes: Uint8Array.from(yield* fs.readFile(supplementPath)) }
    const development = yield* load(false, supplement)
    const freeze = develop(development, hashes)
    const frozen = encode(freeze)
    if (published === null) return yield* fs.writeFileString(output, frozen, { flag: 'wx' })
    if (expected !== frozen)
      return yield* new EvidenceError({ message: 'Published freeze does not reproduce from these inputs and code' })
    const scored = evaluate(yield* load(true, supplement), freeze, published)
    yield* fs.writeFileString(output, encode(scored), { flag: 'wx' })
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    research(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns its file boundary
      Effect.provide(NodeServices.layer),
    ),
  )
}
