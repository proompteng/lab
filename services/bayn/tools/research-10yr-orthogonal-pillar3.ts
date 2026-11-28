import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'

import { parameters } from './8yr-unseen-intraday-protocol'
import { stationaryP, stationaryPlan } from './8yr-unseen-intraday-statistics'
import { dailySharpe, sum } from './midday-research-statistics'
import { loadDevelopment, loadHoldout, sources as b0Sources, withArchive } from './noise-area-study-data'
import { baskets, capital, createReplay, netAt, prepare, splits, type Day as B0Day } from './noise-area-study-replay'
import { blend, compound, metrics, pairedSharpe, underwater } from './orthogonal-pillar3-metrics'
import { assets, benchmarks, deviation, grid, model, replay, universe, type Day } from './orthogonal-pillar3-replay'
import { attachTip, verifyTip } from './orthogonal-pillar3-tip'
import { base as b0Control } from './research-10yr-qqq-smh-conditioning'
import { deflatedSharpe, deflationBenchmark, pearson } from './research-orb-zab-statistics'
import { developmentEnd, end, hash, loadSessions, sources, type Archive, type Session } from './vol-regime-carry-data'
import { replay as replayF4 } from './vol-regime-carry-replay'
import { signalModel as modelF4, type Trial as F4Trial } from './vol-regime-carry-signals'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = 'docs/bayn/evidence/2026-11-27-10yr-orthogonal-pillar3'
const freezePath = evidence + '/freeze.json'
const locked = [
  evidence + '/protocol.md',
  ...[
    'research-10yr-orthogonal-pillar3',
    'orthogonal-pillar3-metrics',
    'orthogonal-pillar3-tip',
    'orthogonal-pillar3-replay',
    'vol-regime-carry-data',
    'vol-regime-carry-replay',
    'vol-regime-carry-signals',
    'noise-area-study-data',
    'noise-area-study-replay',
    'research-10yr-qqq-smh-conditioning',
    'research-orb-zab-data',
    'research-orb-zab-statistics',
    '8yr-unseen-intraday-protocol',
    '8yr-unseen-intraday-statistics',
    'midday-research-statistics',
  ].map((name) => `services/bayn/tools/${name}.ts`),
]

const costs = [2, 5, 10] as const
const primaryCost = costs[2]
const borrow = 0.01
const lowBorrow = 0.005
const allocations = [0.25, 0.5] as const
const ensembles = ['D/A+B', 'D/A+B+C'] as const
const train = splits.train.count
const development = train + splits.validation.count
const total = development + splits.holdout.count
const folds = {
  train: [0, train],
  validation: [train, development],
  holdout: [development, total],
  full: [0, total],
} as const
const select = <A>(data: readonly A[], fold: keyof typeof folds) => data.slice(...folds[fold])
const windowKeys = ['train', 'validation', 'holdout', 'full'] as const
const developmentKeys = ['train', 'validation'] as const
const excess = (days: readonly Day[], shy: readonly number[]) => days.map((day, i) => day.net - shy[i])
const coverage = (sessions: readonly Session[]) =>
  Object.fromEntries(universe.map((ticker, j) => [ticker, sessions.filter(({ bars }) => bars[j] !== undefined).length]))
const f4Control = { family: 'F4', cadence: 42, power: 1, credit: 'LQD', mix: 'parity' } satisfies F4Trial
const f4Id = 'F4-42-1-LQD-parity'
const b0Pinned = [
  [33107.45, 14806],
  [29982.77, 23345.9],
  [40443.36, 31628.26],
  [103533.58, 69780.16],
]
const f4Pinned = [
  [0.426060485, 0.078919864, 0.372083365, 1.111094304],
  [0.41836733, 0.077613006, 0.36920683, 1.092765661],
]
const identities = {
  daily: sources,
  b0: { development: b0Sources.development, holdout: b0Sources.holdout },
  controls: { F4: f4Id, B0: b0Control.id },
}

type Metrics = ReturnType<typeof metrics>
const sliceMetrics = (days: readonly Day[], shy: readonly number[], spy: readonly number[], key: keyof typeof folds) =>
  metrics(select(days, key), select(shy, key), select(spy, key))

const developmentRank = (foldMetrics: readonly Metrics[]) => ({
  eligible: foldMetrics.every((m) => m.excess > 0 && m.turnover < 6),
  score: Math.min(...foldMetrics.map((m) => m.excessSharpe ?? -Infinity)),
})

export const representative = (candidates: readonly (readonly Metrics[])[]) =>
  candidates
    .map((row, i) => ({ i, ...developmentRank(row) }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.i - b.i)[0]?.i

const withEnsembles = (
  paths: Day[][],
  members: readonly { indices: readonly number[]; weights: readonly number[] }[],
  bp: number,
) => [
  ...paths,
  ...members.map(({ indices, weights }) =>
    blend(
      indices.map((i) => paths[i]),
      weights,
      bp,
    ),
  ),
]

type TipReceipt = Omit<ReturnType<typeof verifyTip>, 'raw'>

export const freezeDevelopment = (
  sessions: readonly Session[],
  sourceHashes: Record<string, string>,
  tip: TipReceipt,
) => {
  if (
    sessions.length !== development ||
    sessions[train - 1].date !== splits.train.last ||
    sessions.at(-1)?.date !== developmentEnd
  )
    throw new Error('Development must contain only registered Train and Validation')
  if (sessions.some(({ bars }) => bars[assets.TIP] === undefined))
    throw new Error('Development requires exact TIP coverage')

  const shy = benchmarks(sessions, 'SHY')
  const spy = benchmarks(sessions, 'SPY')
  const orders = grid.map(model(sessions))
  const paths = costs.map((bp) => orders.map((target) => replay(sessions, target, bp, borrow)))
  const ranking = paths[costs.indexOf(primaryCost)].map((path) =>
    developmentKeys.map((key) => sliceMetrics(path, shy, spy, key)),
  )
  const representatives = (['A', 'B', 'C'] as const).map((family) => {
    const indices = grid.flatMap((trial, index) => (trial.family === family ? [index] : []))
    const winner = representative(indices.map((index) => ranking[index]))
    if (winner === undefined) throw new Error(`No registered representative for ${family}`)
    return indices[winner]
  })
  const members = ensembles.map((id, length) => {
    const indices = representatives.slice(0, 2 + length)
    const inverse = indices.map((i) => 1 / deviation(excess(paths[costs.indexOf(primaryCost)][i], shy)))
    if (inverse.some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error('Undefined development ensemble risk')
    return { id, indices, ids: indices.map((i) => grid[i].id), weights: inverse.map((value) => value / sum(inverse)) }
  })
  const trials = [...grid, ...members]
  const finalists = [...representatives.map((i) => grid[i].id), ...ensembles]
  const combined = paths.map((row, cost) => withEnsembles(row, members, costs[cost]))
  const dsrNull = combined.map((row) =>
    deflationBenchmark(
      row.map((path) => dailySharpe(excess(path, shy)) ?? 0),
      trials.length,
    ),
  )
  return {
    schema: 'bayn.wave10d.freeze.v1',
    sourceHashes,
    identities: { ...identities, tip },
    development: { sessions: sessions.length, sha256: hash(JSON.stringify(sessions)), coverage: coverage(sessions) },
    costs,
    primaryCost,
    borrow,
    trials,
    finalists,
    members,
    dsrNull,
    metrics: combined.map((rows) =>
      rows.map((path) => developmentKeys.map((key) => sliceMetrics(path, shy, spy, key))),
    ),
  }
}
type Freeze = ReturnType<typeof freezeDevelopment>

export const scoreAfterFreeze = <A>(recomputed: unknown, committed: string, local: string, open: () => Promise<A>) => {
  if (local !== committed || hash(JSON.stringify(recomputed)) !== hash(JSON.stringify(JSON.parse(committed))))
    throw new Error('Committed Wave 10D freeze does not match replayed Train/Validation; Holdout unopened')
  return open()
}

const auditControls = (sessions: readonly Session[], intraday: readonly B0Day[]) => {
  if (
    sessions.length !== total ||
    intraday.length !== total ||
    sessions.some(({ date }, i) => date !== intraday[i].date)
  )
    throw new Error('B0 and daily SIP calendars do not match exactly')
  const rows = Array.from(prepare(intraday, baskets.B0), (day) => createReplay(day)(b0Control))
  const signals = modelF4(sessions)(f4Control)
  const b0 = (bp: number): Day[] =>
    rows.map((row) => {
      const pnl = netAt(row, bp)
      if (pnl === null) throw new Error('Unresolved B0 position')
      return { net: pnl / capital, turnover: (row.slope * 10_000) / capital, borrow: 0 }
    })
  const b0Receipt = windowKeys.map((key, i) =>
    [2, 5].map((rt, j) => {
      const dollars = sum(select(b0(rt), key).map(({ net }) => net * capital))
      if (Math.abs(dollars - b0Pinned[i][j]) >= 0.005)
        throw new Error(`B0 failed published reproduction: ${key} at ${rt} bp RT`)
      return Math.round(dollars * 100) / 100
    }),
  )
  const f4 = (rt: number): Day[] => replayF4(sessions, signals, rt).map(({ idle }) => ({ ...idle, borrow: 0 }))
  const f4Receipt = [10, 20].map((rt, i) => {
    const days = f4(rt)
    return windowKeys.map((key, j) => {
      const net = compound(select(days, key).map((day) => day.net))
      if (Math.abs(net - f4Pinned[i][j]) > 5.01e-10)
        throw new Error(`F4 failed published reproduction: ${key} at ${rt} bp RT`)
      return net
    })
  })
  return {
    b0Receipt,
    f4Receipt,
    b0MissingHeld: sum(rows.map(({ missingHeld }) => missingHeld)),
    b0MissingEntries: sum(rows.map(({ missingEntries }) => missingEntries)),
    rows: costs.map((bp) => ({ f4: f4(bp * 2), b0: b0(bp * 2) })),
  }
}

export const qualifies = (
  costsAtRisk: readonly {
    standalone: boolean
    orthogonal: boolean
    allocations: readonly boolean[]
  }[],
) =>
  costsAtRisk.length === costs.length &&
  allocations.some((_, index) =>
    costsAtRisk.every((row) => row.standalone && row.orthogonal && row.allocations[index] === true),
  )

const difference = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b)
const positive = (value: number | null) => value !== null && value > 0
const lowCorrelation = (value: number | null) => value !== null && Math.abs(value) < 0.25

const report = (sessions: readonly Session[], intraday: readonly B0Day[], freeze: Freeze, receipt: string) => {
  if (freeze.development.sha256 !== hash(JSON.stringify(sessions.slice(0, development))))
    throw new Error('Full archive changed development bars')
  const { rows: controls, ...controlReceipt } = auditControls(sessions, intraday)
  const shy = benchmarks(sessions, 'SHY')
  const spy = benchmarks(sessions, 'SPY')
  const drawdown = underwater(spy)
  const orders = grid.map(model(sessions))
  const plan = stationaryPlan(splits.holdout.count)
  const returns = (path: readonly Day[]) => path.map(({ net }) => net)
  const at = (days: readonly Day[], key: keyof typeof folds) => sliceMetrics(days, shy, spy, key)
  const windows = (days: readonly Day[]) => Object.fromEntries(windowKeys.map((key) => [key, at(days, key)]))
  const matrix = costs.map((bp, costIndex) => {
    const { f4, b0 } = controls[costIndex]
    const twoPillar = blend([f4, b0], [0.5, 0.5], bp)
    const paths = withEnsembles(
      orders.map((targets) => replay(sessions, targets, bp, borrow)),
      freeze.members,
      bp,
    )
    const cheap = withEnsembles(
      orders.map((targets) => replay(sessions, targets, bp, lowBorrow)),
      freeze.members,
      bp,
    )
    const references = [
      { id: 'F4', path: f4 },
      { id: 'F4+B0', path: twoPillar },
    ]
    return {
      bp,
      controls: { F4: windows(f4), B0: windows(b0), 'F4+B0': windows(twoPillar) },
      trials: paths.map((path, i) => {
        const trial = freeze.trials[i]
        const finalist = freeze.finalists.some((id) => id === trial.id)
        const full = at(path, 'full')
        const holdout = at(path, 'holdout')
        const paired = excess(select(path, 'holdout'), select(shy, 'holdout'))
        const p = stationaryP(paired, plan)
        const dsr = deflatedSharpe(paired, freeze.dsrNull[costIndex])
        const correlation = (key: 'full' | 'holdout', onlyUnderwater: boolean) => {
          const mask = select(drawdown, key)
          const include = (days: readonly Day[]) =>
            returns(select(days, key)).filter((_, j) => !onlyUnderwater || mask[j])
          const data = include(path)
          return { sessions: data.length, f4: pearson(data, include(f4)), b0: pearson(data, include(b0)) }
        }
        const corr = {
          full: correlation('full', false),
          holdout: correlation('holdout', false),
          fullSpyDrawdown: correlation('full', true),
          holdoutSpyDrawdown: correlation('holdout', true),
        }
        const stacks = allocations.map((allocation) =>
          references.map(({ id, path: ref }) => {
            const stacked = blend([ref, path], [1 - allocation, allocation], bp)
            const lift = (key: 'full' | 'holdout') => {
              const compared = at(stacked, key)
              const base = at(ref, key)
              return {
                sharpe: compared.sharpe,
                calmar: compared.calmar,
                maxDrawdown: compared.maxDrawdown,
                sharpeLift: difference(compared.sharpe, base.sharpe),
                calmarLift: difference(compared.calmar, base.calmar),
                maxDrawdownReduction: base.maxDrawdown - compared.maxDrawdown,
              }
            }
            return {
              base: id,
              allocation,
              holdout: lift('holdout'),
              full: lift('full'),
              pairedHoldout: finalist
                ? pairedSharpe(returns(select(stacked, 'holdout')), returns(select(ref, 'holdout')), plan)
                : null,
            }
          }),
        )
        const tests = {
          excess: holdout.excess > 0,
          exTop10: holdout.exTop10Excess > 0,
          nominalP: p !== null && p < 0.05,
          dsr: dsr !== null && dsr >= 0.95,
          turnover: holdout.turnover < 6 && full.turnover < 6,
          correlation: [corr.full.f4, corr.full.b0, corr.holdout.f4, corr.holdout.b0].every(lowCorrelation),
        }
        const gate = {
          standalone: tests.excess && tests.exTop10 && tests.nominalP && tests.dsr,
          orthogonal: tests.turnover && tests.correlation,
          allocations: stacks.map(
            ([f4Stack, combined]) =>
              positive(f4Stack.pairedHoldout?.lower95 ?? null) &&
              positive(combined.pairedHoldout?.lower95 ?? null) &&
              positive(combined.holdout.calmarLift),
          ),
        }
        const borrowSensitive =
          !('family' in trial) || trial.family === 'C' || (trial.family === 'B' && trial.mode === 'long-short')
        return {
          id: trial.id,
          finalist,
          train: at(path, 'train'),
          validation: at(path, 'validation'),
          holdout,
          full,
          p,
          dsr,
          corr,
          stacks,
          tests,
          gate,
          lowBorrow: borrowSensitive ? windows(cheap[i]) : null,
        }
      }),
    }
  })
  const qualified = freeze.finalists.filter((id) =>
    qualifies(
      matrix.map(({ trials }) => {
        const row = trials.find((trial) => trial.id === id)
        if (row === undefined) throw new Error(`Missing finalist: ${id}`)
        return row.gate
      }),
    ),
  )
  return {
    schema: 'bayn.wave10d.results.v1',
    freezeSha256: hash(receipt),
    identities: freeze.identities,
    coverage: coverage(sessions),
    nSessions: sessions.length,
    splits,
    controlReceipt,
    shy: Object.fromEntries(windowKeys.map((key) => [key, compound(select(shy, key))])),
    spy: Object.fromEntries(windowKeys.map((key) => [key, compound(select(spy, key))])),
    finalists: freeze.finalists,
    ensembles: freeze.members,
    bootstrap: parameters.bootstrap,
    dsrNull: freeze.dsrNull,
    trials: freeze.trials.length,
    borrow,
    lowBorrow,
    matrix,
    qualified,
    decision: qualified.length === 0 ? 'DO NOT PROMOTE' : 'RESEARCH GATE PASS',
  }
}

class StudyError extends Data.TaggedError('OrthogonalPillar3Error')<{ operation: string; cause: unknown }> {}
const io = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StudyError({ operation, cause }) })
const exec = promisify(execFile)
const read = (path: string) => io(`Read ${path}`, (signal) => readFile(join(root, path), { signal }))
const program = Effect.gen(function* () {
  const [mode, flag, output, tipFlag, tipDirectory, shaFlag, tipSha256, ...extra] = Bun.argv.slice(2)
  if (
    (mode !== '--develop' && mode !== '--score') ||
    flag !== '--output' ||
    output === undefined ||
    output === '' ||
    extra.length > 0
  )
    return yield* new StudyError({
      operation: 'Parse arguments',
      cause:
        'Usage: --develop|--score --output <new JSON file> --tip-source <directory> --tip-manifest-sha256 <sha256>',
    })

  if (
    tipFlag !== '--tip-source' ||
    tipDirectory === undefined ||
    tipDirectory === '' ||
    shaFlag !== '--tip-manifest-sha256' ||
    tipSha256 === undefined ||
    !/^[a-f0-9]{64}$/.test(tipSha256)
  )
    return yield* new StudyError({
      operation: 'Verify required TIP source',
      cause:
        'Neither frozen S3 archive contains TIP. Supply an authorized exact TIP supplement and its pinned manifest SHA-256; Holdout unopened.',
    })

  const committed =
    mode === '--develop'
      ? undefined
      : yield* io(
          'Read committed freeze',
          async (signal) =>
            (await exec('git', ['show', `HEAD:${freezePath}`], { cwd: root, signal, maxBuffer: 1024 * 1024 })).stdout,
        )
  const local = mode === '--develop' ? undefined : (yield* read(freezePath)).toString()
  const sourceEntries = yield* Effect.forEach(locked, (path) =>
    Effect.map(read(path), (bytes) => [path, hash(bytes)] as const),
  )
  const { raw, ...tip } = yield* io('Authenticate pinned SIP TIP supplement', async (signal) => {
    const [manifest, gzip] = await Promise.all([
      readFile(join(tipDirectory, 'MANIFEST.json'), { signal }),
      readFile(join(tipDirectory, 'tip.tsv.gz'), { signal }),
    ])
    return verifyTip(manifest, gzip, tipSha256)
  })
  const result = yield* withArchive(async (archive) => {
    const archives: Archive[] = await Promise.all(
      sources.map(async (source) => ({
        manifest: await (await archive.open(source.prefix + '/MANIFEST.json')).bytes(),
        gzip: await (await archive.open(source.prefix + '/' + source.file)).bytes(),
      })),
    )
    const freeze = freezeDevelopment(
      attachTip(loadSessions(archives, developmentEnd), raw),
      Object.fromEntries(sourceEntries),
      tip,
    )
    if (committed === undefined || local === undefined) return freeze
    return scoreAfterFreeze(freeze, committed, local, async () => {
      const sessions = attachTip(loadSessions(archives, end), raw)
      const dev = await loadDevelopment(archive)
      const holdout = await loadHoldout(archive)
      return report(sessions, [...dev.days, ...holdout.days], freeze, committed)
    })
  })
  yield* io(`Write ${output}`, (signal) =>
    writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', signal }),
  )
})

if (import.meta.main) NodeRuntime.runMain(program)
