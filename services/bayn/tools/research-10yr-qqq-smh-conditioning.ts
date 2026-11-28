import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'

import { dailySharpe, expectedMaximumSharpe, sum } from './midday-research-statistics'
import { loadDevelopment, loadHoldout, loadShy, sources, withArchive } from './noise-area-study-data'
import {
  baskets,
  cap,
  capital,
  createReplay,
  netAt,
  prepare,
  splits,
  type Conditioning,
  type Day,
  type Ledger,
  type Trial,
} from './noise-area-study-replay'
import {
  bootstrapSeed,
  delta,
  draws,
  meanBlockSessions,
  stationaryBootstrap,
  summarize,
} from './noise-area-study-statistics'
import { sha256 } from './research-orb-zab-data'

const evidence = 'docs/bayn/evidence/2026-11-27-10yr-qqq-smh-conditioning'
const freezePath = evidence + '/freeze.json'
const branch = 'refs/heads/codex/bayn-w9b-10yr-qqq-smh-vol-rvol-conditioning'
const locked = [
  evidence + '/protocol.md',
  ...[
    'research-10yr-qqq-smh-conditioning',
    'noise-area-study-data',
    'noise-area-study-replay',
    'noise-area-study-statistics',
    'research-orb-zab-data',
    'midday-research-statistics',
  ].map((name) => `services/bayn/tools/${name}.ts`),
]

export const base: Trial = {
  id: 'B0/30/1.4/opposite_band/inverse_vol_parity',
  basket: 'B0',
  minutes: 30,
  band: 1.4,
  exit: 'opposite_band',
  sizing: 'inverse_vol_parity',
}
const volatilities = ['none', 'min-vol', 'target-vol'] as const
const confirmations = ['none', 'rvol', 'vwap'] as const
const stops = ['none', 'atr', 'breakeven'] as const
export const baseId = 'B0_base'
const safetyId = 'V0/R0/X1'
const techId = '3-ETF Tech'
const tech = ['QQQ', 'SMH', 'XLK'] as const
export const grid = volatilities.flatMap((volatility, v) =>
  confirmations.flatMap((confirmation, r) =>
    stops.map((stop, x) => ({
      id: v === 0 && r === 0 && x === 0 ? baseId : `V${v}/R${r}/X${x}`,
      conditioning: { volatility, confirmation, stop } satisfies Conditioning,
    })),
  ),
)

const bpGrid = [2, 5] as const
const trainEnd = splits.train.count
const developmentEnd = trainEnd + splits.validation.count
const fullEnd = developmentEnd + splits.holdout.count
const developmentWindows = { train: [0, trainEnd], validation: [trainEnd, developmentEnd] } as const
const windows = {
  ...developmentWindows,
  development: [0, developmentEnd],
  holdout: [developmentEnd, fullEnd],
  full: [0, fullEnd],
} as const

// Wave 6A #16387, selected B0, official zero-cash results (cents).
const reference = {
  train: [33107.45, 14806.0],
  validation: [29982.77, 23345.9],
  holdout: [40443.36, 31628.26],
  full: [103533.58, 69780.16],
} as const

type Tape = { id: string; rows: Ledger[] }
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const fingerprints = () => Object.fromEntries(locked.map((path) => [path, sha256(readFileSync(path))]))
const rowsOf = (tapes: readonly Tape[], id: string) => {
  const tape = tapes.find((entry) => entry.id === id)
  if (tape === undefined) throw new Error(`Missing registered ledger: ${id}`)
  return tape.rows
}
const collect = (days: readonly Day[], diagnostic: boolean) => {
  const tapes: Tape[] = grid.map(({ id }) => ({ id, rows: [] }))
  const techTape: Tape = { id: techId, rows: [] }
  for (const day of prepare(days, diagnostic ? tech : baskets.B0)) {
    const replay = createReplay(day)
    for (const [index, { id, conditioning }] of grid.entries())
      tapes[index].rows.push(id === baseId ? replay(base) : replay(base, baskets.B0, conditioning))
    if (diagnostic) techTape.rows.push(replay(base, tech))
  }
  return diagnostic ? [...tapes, techTape] : tapes
}

export const verifyBaseline = (rows: readonly Ledger[], window: keyof typeof reference) => {
  const expected = reference[window]
  const observed = bpGrid.map((bp) => {
    const values = rows.map((row) => netAt(row, bp))
    return values.every((value): value is number => value !== null) ? sum(values) : null
  })
  if (observed.some((value, i) => value === null || Math.round(value * 100) !== Math.round(expected[i] * 100)))
    throw new Error(
      `Wave 6A baseline mismatch (${window}): expected ${expected.join('/')} USD, got ${observed.join('/')}`,
    )
  return { expectedUsd: expected, observedUsd: observed }
}

const admissible = (rows: readonly Ledger[]) =>
  rows.every((row) => row.unresolved === 0 && row.missingHeld === 0 && row.grossUpperBound <= cap)

const rankWindow = (rows: readonly Ledger[]) => {
  const values = rows.map((row) => netAt(row, 5))
  return {
    dailySharpe: values.every((value): value is number => value !== null) ? dailySharpe(values) : null,
    eligible: admissible(rows),
  }
}

type Ranking = { id: string; train: ReturnType<typeof rankWindow>; validation: ReturnType<typeof rankWindow> }
export const select = (rankings: readonly Ranking[]) => {
  const rank = (key: 'train' | 'validation') => (a: Ranking, b: Ranking) =>
    (b[key].dailySharpe ?? -Infinity) - (a[key].dailySharpe ?? -Infinity) || a.id.localeCompare(b.id, 'en')
  const finalists = rankings
    .filter(
      ({ id, train, validation }) =>
        id !== baseId &&
        train.eligible &&
        validation.eligible &&
        train.dailySharpe !== null &&
        validation.dailySharpe !== null,
    )
    .toSorted(rank('train'))
    .slice(0, 3)
  return { finalists: finalists.map(({ id }) => id), selected: finalists.toSorted(rank('validation'))[0]?.id ?? null }
}

type Development = Awaited<ReturnType<typeof loadDevelopment>>
const develop = (development: Development) => {
  const tapes = collect(development.days, false)
  const baseline = rowsOf(tapes, baseId)
  const train = verifyBaseline(baseline.slice(0, trainEnd), 'train')
  const validation = verifyBaseline(baseline.slice(trainEnd), 'validation')
  const rankings = tapes.map(({ id, rows }) => ({
    id,
    train: rankWindow(rows.slice(0, trainEnd)),
    validation: rankWindow(rows.slice(trainEnd)),
  }))
  const dsrBenchmarkDaily = bpGrid.map((bp) => {
    const sharpes = tapes.flatMap(({ rows }) => {
      const values = rows.slice(0, trainEnd).map((row) => netAt(row, bp))
      const sharpe = values.every((value): value is number => value !== null) ? dailySharpe(values) : null
      return sharpe === null ? [] : [sharpe]
    })
    return expectedMaximumSharpe(sharpes, grid.length)
  })
  return {
    schema: 'bayn.research.wave-9b.freeze.v1',
    source: sources,
    files: fingerprints(),
    splits,
    grid,
    diagnosticExcludedFromSelection: { id: techId, members: tech },
    developmentSessions: development.days.length,
    baselineParity: { train, validation },
    bootstrap: { draws, meanBlockSessions, seed: bootstrapSeed },
    developmentLedgerSha256: sha256(JSON.stringify(tapes)),
    dsrBenchmarkDaily,
    selection: select(rankings),
    rankings,
  }
}

const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  if (!result.success) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

const publishedFreeze = () => {
  const revision = git('rev-parse', 'HEAD').trim()
  git('ls-files', '--error-unmatch', '--', freezePath, ...locked)
  git('diff', 'HEAD', '--quiet', '--', freezePath, ...locked)
  const commit = git('log', '--diff-filter=A', '-1', '--format=%H', revision, '--', freezePath).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('No committed Wave 9B freeze')
  git('diff', '--quiet', commit, revision, '--', freezePath, ...locked)
  if (git('ls-remote', '--refs', 'origin', branch).trim() !== `${revision}\t${branch}`)
    throw new Error(`Score requires this revision to be published as ${branch}`)
  const receipt = git('show', `${commit}:${freezePath}`)
  return { commit, receipt, sha256: sha256(receipt) }
}

export const scoreAfterFreeze = <A>(recomputed: unknown, receipt: string, open: () => Promise<A>) => {
  if (json(recomputed) !== json(JSON.parse(receipt)))
    throw new Error('Committed freeze differs from replayed Train/Validation receipt')
  return open()
}

type Freeze = ReturnType<typeof develop>
type Metrics = ReturnType<typeof summarize>
interface Comparison {
  readonly bp: (typeof bpGrid)[number]
  readonly alpha: Pick<Metrics, 'dsr' | 'netUsd' | 'exTop10Usd'>
  readonly paired: ReturnType<typeof delta>
}
export const qualifies = (comparisons: readonly Comparison[], executionSafe: boolean) =>
  executionSafe &&
  comparisons.length === bpGrid.length &&
  comparisons.every(
    ({ bp, alpha, paired }, i) =>
      bp === bpGrid[i] &&
      (paired.netUsd ?? -Infinity) > 0 &&
      paired.p !== null &&
      paired.p < 0.05 &&
      (alpha.dsr ?? 0) >= 0.95 &&
      (alpha.netUsd ?? -Infinity) > 0 &&
      (alpha.exTop10Usd ?? -Infinity) > 0,
  )

export const noDegradation = (
  candidate: Pick<Metrics, 'netUsd' | 'sharpeAnnualized' | 'maxDrawdownUsd'>,
  control: Pick<Metrics, 'netUsd' | 'sharpeAnnualized' | 'maxDrawdownUsd'>,
) => {
  const { netUsd, sharpeAnnualized, maxDrawdownUsd } = candidate
  return (
    netUsd !== null &&
    control.netUsd !== null &&
    netUsd >= control.netUsd &&
    sharpeAnnualized !== null &&
    control.sharpeAnnualized !== null &&
    sharpeAnnualized >= control.sharpeAnnualized &&
    maxDrawdownUsd !== null &&
    control.maxDrawdownUsd !== null &&
    maxDrawdownUsd <= control.maxDrawdownUsd
  )
}

const report = (
  development: Development,
  holdout: Awaited<ReturnType<typeof loadHoldout>>,
  shyClose: readonly number[],
  freeze: Freeze,
  publication: { commit: string; sha256: string },
) => {
  const days = [...development.days, ...holdout.days]
  const dates = days.map(({ date }) => date)
  const tapes = collect(days, true)
  const baseline = rowsOf(tapes, baseId)
  const {
    holdout: [start, end],
  } = windows
  const baselineParity = {
    ...freeze.baselineParity,
    holdout: verifyBaseline(baseline.slice(start, end), 'holdout'),
    full: verifyBaseline(baseline, 'full'),
  }
  const shyWealth = shyClose.map((price) => (capital * price) / shyClose[0])
  const carry = shyWealth.map((value, i) => value - (shyWealth[i - 1] ?? capital))
  const windowEntries = Object.entries(windows)
  const selectedId = freeze.selection.selected
  const displayed = [baseId, safetyId, techId, selectedId]
  const displayTapes = tapes.filter(({ id }) => displayed.includes(id))
  const mainReports = displayTapes.map(({ id, rows }) => ({
    id,
    windows: Object.fromEntries(
      windowEntries.map(([label, [from, to]]) => {
        const window = rows.slice(from, to)
        const cash = carry.slice(from, to)
        const bootstrap = stationaryBootstrap(window.length)
        return [
          label,
          bpGrid.map((bp, i) => ({
            bp,
            alpha: summarize(window, bp, id === techId ? null : freeze.dsrBenchmarkDaily[i], undefined, bootstrap),
            withShy: summarize(window, bp, null, cash),
          })),
        ]
      }),
    ),
    annual: Object.fromEntries(
      [...new Set(dates.map((date) => date.slice(0, 4)))].map((year) => {
        const indexes = dates.flatMap((date, i) => (date.startsWith(year) ? [i] : []))
        const annual = indexes.map((i) => rows[i])
        const cash = indexes.map((i) => carry[i])
        return [
          year,
          bpGrid.map((bp) => ({
            bp,
            alpha: summarize(annual, bp, null),
            withShy: summarize(annual, bp, null, cash),
          })),
        ]
      }),
    ),
  }))
  const bootstrap = stationaryBootstrap(end - start)
  const holdoutComparison = tapes
    .filter(({ id }) => id !== baseId && id !== techId)
    .map(({ id, rows }) => {
      const holdoutRows = rows.slice(start, end)
      const control = baseline.slice(start, end)
      const byCost = bpGrid.map((bp, i) => ({
        bp,
        alpha: summarize(holdoutRows, bp, freeze.dsrBenchmarkDaily[i], undefined, bootstrap),
        paired: delta(holdoutRows, control, bp, bootstrap),
      }))
      const executionSafe = admissible(rows) && admissible(baseline)
      return { id, byCost, executionSafe, meetsNumericAndExecutionGates: qualifies(byCost, executionSafe) }
    })
  const selected = holdoutComparison.find(({ id }) => id === selectedId)
  const stops = rowsOf(tapes, safetyId)
  const safetyNoDegradation =
    admissible(stops) &&
    (['train', 'validation', 'holdout'] as const).every((key) => {
      const [from, to] = windows[key]
      return bpGrid.every((bp) =>
        noDegradation(summarize(stops.slice(from, to), bp, null), summarize(baseline.slice(from, to), bp, null)),
      )
    })
  return {
    schema: 'bayn.research.wave-9b.results.v1',
    publication,
    source: sources,
    sessions: Object.fromEntries(windowEntries.map(([name, [from, to]]) => [name, to - from])),
    baselineParity,
    coverage: { development: development.coverage, holdout: holdout.coverage },
    selection: freeze.selection,
    totalConfigurationsIncludingDiagnostic: tapes.length,
    dsrBenchmarkDaily: freeze.dsrBenchmarkDaily,
    primaryPass: selected?.meetsNumericAndExecutionGates ?? false,
    safetyNoDegradation,
    recommendation:
      selected?.meetsNumericAndExecutionGates === true ? selected.id : safetyNoDegradation ? safetyId : baseId,
    mainReports,
    holdoutComparison,
  }
}

class StudyError extends Data.TaggedError('ConditioningStudyError')<{ readonly cause: unknown }> {}
const checked = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new StudyError({ cause }) })
const program = Effect.gen(function* () {
  const [mode, outputFlag, output, ...extra] = Bun.argv.slice(2)
  if (
    (mode !== '--develop' && mode !== '--score') ||
    outputFlag !== '--output' ||
    output === undefined ||
    output === '' ||
    extra.length !== 0
  )
    return yield* new StudyError({ cause: 'Usage: --develop|--score --output <new JSON file>' })
  const publication = mode === '--score' ? yield* checked(publishedFreeze) : undefined
  const result = yield* withArchive(async (archive) => {
    const development = await loadDevelopment(archive)
    const freeze = develop(development)
    if (publication === undefined) return freeze
    return scoreAfterFreeze(freeze, publication.receipt, async () => {
      const holdout = await loadHoldout(archive)
      const shyClose = await loadShy(
        archive,
        [...development.days, ...holdout.days].map(({ date }) => date),
      )
      return report(development, holdout, shyClose, freeze, { commit: publication.commit, sha256: publication.sha256 })
    })
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, json(result), { flag: 'wx', signal }),
    catch: (cause) => new StudyError({ cause }),
  })
})

if (import.meta.main) NodeRuntime.runMain(program)
