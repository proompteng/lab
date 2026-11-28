import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'
import { dailySharpe, deflationBenchmark } from './research-orb-zab-statistics'
import {
  type Archive,
  type Session,
  type Symbol,
  developmentEnd,
  end,
  hash,
  loadSessions,
  sources,
  universe,
} from './vol-regime-carry-data'
import {
  type Metrics,
  bootstrap,
  compactMetrics,
  compound,
  inference,
  metricColumns,
  robust,
  round,
  structural,
  summarize,
  windowDays,
  windows,
} from './vol-regime-carry-metrics'
import { replay } from './vol-regime-carry-replay'
import { costs, neighbors, signalModel, trialId, trials } from './vol-regime-carry-signals'

const evidence = 'docs/bayn/evidence/2026-11-27-10yr-vol-regime-carry'
const freezePath = `${evidence}/freeze.json`
const root = fileURLToPath(new URL('../../../', import.meta.url))
const branch = 'refs/heads/codex/bayn-w5c-10yr-vol-regime-and-carry-alpha'
const files = [
  '.oxfmtrc.json',
  `${evidence}/protocol.md`,
  ...[
    'research-10yr-vol-regime-carry',
    'research-orb-zab-statistics',
    'vol-regime-carry-data',
    'vol-regime-carry-signals',
    'vol-regime-carry-replay',
    'vol-regime-carry-metrics',
  ].map((name) => `services/bayn/tools/${name}.ts`),
]

const prior = [
  { wave: '2A ETF grid', count: 24, revision: 'bc7eb74af06eb399972493f8adf59aa7ff4f8073' },
  { wave: '3C', count: 122, revision: 'e021694cf3672ce556f4c1290d93632cd5134101' },
  { wave: '4C', count: 5, revision: '566d5609ed5e01d1a3bb336db6ee158774c40e4d' },
  { wave: '4D', count: 135, revision: 'e68746f50fa0a1f83762b8fd053d2ea5c14f9e1c' },
  { wave: '4G ETF and ETF-bearing ensemble', count: 11, revision: '869be9554568be3d08f322a5990b406db8176285' },
  { wave: '4I ETF and ETF-bearing blends', count: 16, revision: '87cc50131822672c547efa3016fffc7b65436c14' },
]
const cumulativeTrials = prior.reduce((sum, { count }) => sum + count, trials.length)
const widerTrials = 5000 + trials.length
const coverage = (sessions: readonly Session[]) =>
  Object.fromEntries(
    universe.map((symbol, i) => [
      symbol,
      sessions.reduce((count, { bars }) => count + Number(bars[i] !== undefined), 0),
    ]),
  )

export const leader = (development: readonly Metrics[][], family: string) => {
  const candidates = trials.flatMap((trial, i) => (trial.family === family ? [i] : []))
  const score = (i: number) => Math.min(...development[i].map((m) => m.excessSharpe ?? -Infinity))
  candidates.sort(
    (a, b) => Number(structural(development[b])) - Number(structural(development[a])) || score(b) - score(a) || a - b,
  )
  return candidates[0]
}

const makeFreeze = (sessions: Session[], sourceHashes: Record<string, string>) => {
  const targets = signalModel(sessions)
  const paths = trials.map((trial) => {
    const orders = targets(trial)
    return costs.map((cost) => {
      const path = replay(sessions, orders, cost)
      return {
        sharpe: dailySharpe(path.map((day) => day.idle.net - day.shy)),
        folds: windows.slice(0, 2).map((window) => {
          const days = windowDays(path, window)
          return { zero: summarize(days, 'zero'), idle: summarize(days, 'idle') }
        }),
      }
    })
  })
  const benchmark = costs.map((_, c) => {
    const sharpes = paths.flatMap((path) => (path[c].sharpe === null ? [] : [path[c].sharpe]))
    return {
      finiteTrials: sharpes.length,
      cumulative: deflationBenchmark(sharpes, cumulativeTrials),
      wider: deflationBenchmark(sharpes, widerTrials),
    }
  })
  const primary = costs.indexOf(10)
  const development = paths.map((path) => path[primary].folds.map(({ idle }) => idle))
  const familyLeaders = Object.fromEntries(
    ['F1', 'F2', 'F3', 'F4'].map((family) => [family, leader(development, family)]),
  )
  return {
    schema: 'bayn.wave5c.freeze.v1',
    sourceHashes,
    sources,
    sessions: sessions.length,
    coverage: coverage(sessions),
    windows: windows.slice(0, 2),
    costs,
    trials: trials.map((config) => ({ id: trialId(config), config })),
    neighbors,
    prior,
    cumulativeTrials,
    widerTrials,
    benchmark,
    familyLeaders,
    columns: metricColumns,
    books: ['zero', 'idle'],
    // Ordered [trial][cost][Train/Validation][book][metric].
    development: paths.map((path) =>
      path.map(({ folds }) => folds.map(({ zero, idle }) => [compactMetrics(zero), compactMetrics(idle)])),
    ),
  }
}

type Freeze = ReturnType<typeof makeFreeze>
const makeResults = (sessions: Session[], freeze: Freeze, freezeRevision: string, receipt: string) => {
  const models = signalModel(sessions)
  const held = new Set<Symbol>()
  const main = trials.map((trial) => {
    const orders = models(trial)
    return costs.map((cost, c) => {
      const path = replay(sessions, orders, cost, undefined, held)
      return windows.map((window) => {
        const days = windowDays(path, window)
        return {
          zero: summarize(days, 'zero'),
          idle: summarize(days, 'idle'),
          ...inference(days, freeze.benchmark[c].cumulative, freeze.benchmark[c].wider),
          shy: compound(days.map((day) => day.shy)),
          spy: compound(days.map((day) => day.spy)),
          sessions: days.length,
        }
      })
    })
  })
  const omitColumns = ['zeroNet', 'idleNet', 'idleExcess', 'zeroTurnover', 'idleTurnover']
  const omission = universe.map((omitted) => {
    const targets = signalModel(sessions, omitted)
    return trials.map((trial) => {
      const orders = targets(trial)
      return costs.map((cost) => {
        const path = replay(sessions, orders, cost, omitted)
        return windows.slice(0, 3).map((window) => {
          const days = windowDays(path, window)
          const zero = summarize(days, 'zero')
          const idle = summarize(days, 'idle')
          return [zero.net, idle.net, idle.excess, zero.oneWayAnnualTurnover, idle.oneWayAnnualTurnover]
        })
      })
    })
  })
  const folds = (t: number, c: number) => main[t][c].slice(0, 3).map(({ idle }) => idle)
  const assessments = main.map((rows, t) =>
    rows.map((row, c) => {
      const holdout = row[2]
      const adjacent = neighbors[t]
      const passing = adjacent.filter((peer) => robust(folds(peer, c))).length
      const plateau = adjacent.length === 0 ? null : passing / adjacent.length
      const allOmissions = omission.every((symbol) => symbol[t][c].every((fold) => fold[2] > 0 && fold[4] < 4))
      const passes =
        robust(folds(t, c)) &&
        plateau !== null &&
        plateau >= 2 / 3 &&
        allOmissions &&
        holdout.stationaryP !== null &&
        holdout.stationaryP < 0.05 &&
        holdout.cumulativeDsr !== null &&
        holdout.cumulativeDsr >= 0.95
      return {
        structural: structural(folds(t, c)),
        robust: robust(folds(t, c)),
        plateau: round(plateau),
        passing,
        allOmissions,
        passes,
      }
    }),
  )
  return {
    schema: 'bayn.wave5c.results.v1',
    freezeRevision,
    freezeSha256: hash(receipt),
    holdoutPreviouslySeen: true,
    coverage: coverage(sessions),
    traded: universe.filter((symbol) => held.has(symbol)),
    costs,
    bootstrap,
    cumulativeTrials,
    widerTrials,
    trials: trials.map(trialId),
    familyLeaders: freeze.familyLeaders,
    windows: windows.map((window, i) => {
      const { sessions: count, shy, spy } = main[0][0][i]
      return { ...window, count, shy: round(shy), spy: round(spy) }
    }),
    columns: [
      ...metricColumns.map((name) => `zero.${name}`),
      ...metricColumns.map((name) => `idle.${name}`),
      'idle.stationaryP',
      'idle.cumulativeDsr',
      'idle.widerDsr',
    ],
    metrics: main.map((row) =>
      row.map((windowsAtCost) =>
        windowsAtCost.map(({ zero, idle, stationaryP, cumulativeDsr, widerDsr }) => [
          ...compactMetrics(zero),
          ...compactMetrics(idle),
          round(stationaryP),
          round(cumulativeDsr),
          round(widerDsr),
        ]),
      ),
    ),
    omissionColumns: omitColumns,
    omissionSymbols: universe,
    omissionWindows: ['Train', 'Validation', 'Holdout'],
    omissions: omission.map((byTrial) =>
      byTrial.map((byCost) => byCost.map((byFold) => byFold.map((values) => values.map(round)))),
    ),
    neighbors,
    assessments,
    qualified: trials.filter((_, i) => assessments[i].every(({ passes }) => passes)).map(trialId),
  }
}

class ResearchFailure extends Data.TaggedError('VolRegimeCarryResearchFailure')<{
  operation: string
  cause: unknown
}> {}
const compute = <A>(operation: string, task: () => A) =>
  Effect.try({ try: task, catch: (cause) => new ResearchFailure({ operation, cause }) })
const io = <A>(operation: string, task: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: task, catch: (cause) => new ResearchFailure({ operation, cause }) })

const formatJson = (path: string, value: unknown) =>
  io(`Format ${path}`, async (signal) => {
    const encoded = JSON.stringify(value)
    const child = Bun.spawn(['node', 'node_modules/oxfmt/bin/oxfmt', '--threads=4', `--stdin-filepath=${path}`], {
      cwd: root,
      signal,
      stdin: Buffer.from(encoded),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, contents, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0 || contents.length === 0) throw new Error(`oxfmt exited ${code}: ${stderr}`)
    if (JSON.stringify(JSON.parse(contents)) !== encoded) throw new Error('Formatter changed evidence data')
    return contents
  })

const read = (path: string) => io(`Read ${path}`, (signal) => readFile(path, { signal }))
const write = (path: string, contents: string) =>
  io(`Write ${path}`, (signal) => writeFile(join(root, path), contents, { signal }))
const exec = promisify(execFile)
const git = (...args: string[]) =>
  io(`git ${args[0]}`, async (signal) => {
    const result = await exec('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, signal, timeout: 60_000 })
    return result.stdout
  })

export const verifyReceipt = (reproduced: string, committed: string) => {
  if (reproduced !== committed) throw new Error('Development does not reproduce the pushed freeze; holdout unopened')
}

const remoteFreeze = (revision: string) =>
  Effect.gen(function* () {
    const remote = yield* git('ls-remote', '--exit-code', 'origin', branch)
    const tip = remote.split('\t')[0]
    if (!/^[a-f0-9]{40}$/.test(tip))
      return yield* new ResearchFailure({
        operation: 'Verify remote branch',
        cause: 'No valid remote tip',
      })
    yield* git('merge-base', '--is-ancestor', revision, tip)
    return yield* git('show', `${revision}:${freezePath}`)
  })

const program = Effect.gen(function* () {
  const [mode, directory, revision, ...extra] = process.argv.slice(2)
  if (
    directory === undefined ||
    extra.length > 0 ||
    !(
      (mode === '--freeze' && revision === undefined) ||
      (mode === '--score' && revision !== undefined && /^[a-f0-9]{40}$/.test(revision))
    )
  )
    return yield* new ResearchFailure({
      operation: 'Read arguments',
      cause: 'Usage: --freeze ARCHIVE_DIR | --score ARCHIVE_DIR PUSHED_FREEZE_SHA',
    })
  const committed = revision === undefined ? undefined : yield* remoteFreeze(revision)
  const archives: Archive[] = yield* Effect.forEach(sources, (source) =>
    Effect.gen(function* () {
      const dir = join(directory, source.prefix)
      const manifest = yield* read(join(dir, 'MANIFEST.json'))
      const gzip = yield* read(join(dir, source.file))
      return { manifest, gzip }
    }),
  )
  const sourceEntries = yield* Effect.forEach(files, (path) =>
    Effect.map(read(join(root, path)), (bytes) => [path, hash(bytes)] as const),
  )
  const sourceHashes = Object.fromEntries(sourceEntries)
  const development = yield* compute('Decode development sessions only', () => loadSessions(archives, developmentEnd))
  const freeze = yield* compute('Evaluate Train and Validation', () => makeFreeze(development, sourceHashes))
  const receipt = yield* formatJson(freezePath, freeze)
  if (revision === undefined || committed === undefined) {
    yield* write(freezePath, receipt)
    yield* Effect.logInfo(`Frozen development receipt: ${hash(receipt)}`)
    return
  }
  yield* compute('Verify development receipt', () => verifyReceipt(receipt, committed))
  const sessions = yield* compute('Open authenticated Holdout', () => loadSessions(archives, end))
  const results = yield* compute('Score registered trials and omissions', () =>
    makeResults(sessions, freeze, revision, receipt),
  )
  const resultPath = `${evidence}/results.json`
  const contents = yield* formatJson(resultPath, results)
  yield* write(resultPath, contents)
  yield* Effect.logInfo(
    `Scored ${results.trials.length} trials, ${results.traded.length} traded ETFs, ${results.qualified.length} qualified`,
  )
})

if (import.meta.main) NodeRuntime.runMain(program)
