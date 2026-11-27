import { lstatSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Schema } from 'effect'

import { dailySharpe, deflatedSharpe, expectedMaximumSharpe } from './midday-research-statistics'
import { loadDevelopment, loadHoldout, loadShy, sources, withArchive } from './noise-area-study-data'
import {
  basketIds,
  baskets,
  cap,
  capital,
  costs,
  createReplay,
  grid,
  legacy,
  netAt,
  prepare,
  selectionCost,
  splits,
  symbols,
  type Day,
  type Ledger,
  type Trial,
} from './noise-area-study-replay'
import {
  bootstrapSeed,
  correlation,
  delta,
  draws,
  matrix,
  meanBlockSessions,
  stationaryBootstrap,
} from './noise-area-study-statistics'
import { sha256 } from './research-orb-zab-data'

const evidence = 'docs/bayn/evidence/2026-11-27-10yr-16etf-noise-area'
const freezePath = evidence + '/freeze.json'
const transportPath = evidence + '/transport-erratum.json'
const branch = 'refs/heads/codex/bayn-w6a-10yr-16etf-noise-area-momentum'
const transportFiles = ['research-10yr-16etf-noise-area', 'noise-area-study-data'].map(
  (name) => `services/bayn/tools/${name}.ts`,
)
const locked = [
  evidence + '/protocol.md',
  ...transportFiles,
  ...[
    'noise-area-study-replay',
    'noise-area-study-statistics',
    'research-orb-zab-data',
    'midday-research-statistics',
  ].map((name) => `services/bayn/tools/${name}.ts`),
]
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const decodeTransport = Schema.decodeUnknownSync(
  Schema.Struct({
    schema: Schema.Literal('bayn.research.wave-6a.transport-erratum.v1'),
    freezeCommit: Schema.String,
    freezeSha256: digest,
    files: Schema.Record(Schema.String, digest),
  }),
)

type Archive = Parameters<Parameters<typeof withArchive>[0]>[0]
type Development = Awaited<ReturnType<typeof loadDevelopment>>

const rankWindow = (rows: readonly Ledger[]) => {
  const daily = rows.map((row) => netAt(row, selectionCost))
  const complete = daily.every((n): n is number => n !== null) ? daily : null
  return {
    sharpeDaily: complete === null ? null : dailySharpe(complete),
    netUsd: complete === null ? null : complete.reduce((total, value) => total + value, 0),
    unresolved: rows.reduce((total, row) => total + row.unresolved, 0),
  }
}

const collectGrid = (days: readonly Day[]) => {
  const specs = [...grid, legacy]
  const results = specs.map((spec) => ({ spec, rows: [] as Ledger[] }))
  for (const day of prepare(days)) {
    const replay = createReplay(day)
    for (const result of results) result.rows.push(replay(result.spec))
  }
  return results
}

type Rankings = { spec: Trial; train: ReturnType<typeof rankWindow>; validation: ReturnType<typeof rankWindow> }
const rank = (rows: readonly Rankings[], key: 'train' | 'validation') =>
  rows.toSorted((a, b) => {
    const first = a[key].sharpeDaily ?? -Infinity
    const second = b[key].sharpeDaily ?? -Infinity
    return first === second ? a.spec.id.localeCompare(b.spec.id, 'en') : second - first
  })

export const choose = (rows: readonly Rankings[]) => {
  // Validation picks only among the three Train finalists; nulls are ranked last.
  const finalists = rank(rows, 'train').slice(0, 3)
  const chosen = rank(finalists, 'validation')[0]
  if (chosen === undefined) throw new Error('No registered finalists')
  return { finalists: finalists.map(({ spec }) => spec.id), selected: chosen.spec }
}

const fingerprints = () => Object.fromEntries(locked.map((path) => [path, sha256(readFileSync(path))]))

export const commonMask = (paths: readonly (readonly Ledger[])[], length: number) =>
  Array.from({ length }, (_, i) => paths.every((rows) => rows[i].unresolved === 0))

const develop = (development: Development, files = fingerprints()) => {
  const trainCount = splits.train.count
  const tapes = collectGrid(development.days)
  const mask = commonMask(
    tapes.map(({ rows }) => rows),
    development.days.length,
  )
  const scores = tapes.map(({ spec, rows }) => {
    const train = rows.slice(0, trainCount)
    const validation = rows.slice(trainCount)
    return {
      spec,
      train: rankWindow(train.filter((_, i) => mask[i])),
      validation: rankWindow(validation.filter((_, i) => mask[trainCount + i])),
      officialCalendar: { train: rankWindow(train), validation: rankWindow(validation) },
    }
  })
  const candidates = scores.filter(({ spec }) => spec.legacy !== true)
  const cohorts = basketIds.map((basket) => choose(candidates.filter(({ spec }) => spec.basket === basket)))
  const primary = choose(
    candidates.filter(
      ({ spec }) => spec.basket === 'B4' && spec.minutes === 30 && spec.sizing === 'inverse_vol_parity',
    ),
  )
  const resolvedSharpes = candidates.flatMap(({ train }) => (train.sharpeDaily === null ? [] : [train.sharpeDaily]))
  return {
    schema: 'bayn.research.wave-6a.freeze.v1',
    source: sources,
    files,
    splits,
    basketMembership: baskets,
    configurationsIncludingLegacy: scores.length,
    selectionCostRtBps: selectionCost,
    bootstrap: { draws, meanBlockSessions, seed: bootstrapSeed },
    trainDsrBenchmarkDaily: expectedMaximumSharpe(resolvedSharpes, grid.length),
    primary,
    cohorts,
    coverage: development.coverage,
    rankingExcludedDates: development.days.flatMap(({ date }, i) => (mask[i] ? [] : [date])),
    developmentLedgerSha256: sha256(JSON.stringify(tapes)),
    scores,
  }
}

const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  if (!result.success) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

const published = () => {
  const revision = git('rev-parse', 'HEAD').trim()
  git('diff', 'HEAD', '--quiet', '--')
  git('ls-files', '--error-unmatch', '--', freezePath, transportPath, ...locked)
  const freezeCommit = git('log', '--diff-filter=A', '-1', '--format=%H', revision, '--', freezePath).trim()
  if (!/^[0-9a-f]{40}$/.test(freezeCommit)) throw new Error('No committed development freeze')
  git(
    'diff',
    '--exit-code',
    freezeCommit,
    revision,
    '--',
    freezePath,
    ...locked.filter((path) => !transportFiles.includes(path)),
  )
  const freeze = git('show', `${freezeCommit}:${freezePath}`)
  const freezeSha256 = sha256(freeze)
  const transportCommit = git('log', '--diff-filter=A', '-1', '--format=%H', revision, '--', transportPath).trim()
  if (!/^[0-9a-f]{40}$/.test(transportCommit) || transportCommit === freezeCommit)
    throw new Error('No distinct committed transport erratum')
  git('merge-base', '--is-ancestor', freezeCommit, transportCommit)
  git('diff', '--exit-code', transportCommit, revision, '--', transportPath, ...transportFiles)
  const transport = git('show', `${transportCommit}:${transportPath}`)
  const erratum = decodeTransport(JSON.parse(transport))
  if (
    erratum.freezeCommit !== freezeCommit ||
    erratum.freezeSha256 !== freezeSha256 ||
    Object.keys(erratum.files).length !== transportFiles.length ||
    transportFiles.some((path) => erratum.files[path] !== sha256(readFileSync(path)))
  )
    throw new Error('Transport erratum does not match the published freeze and corrected reader')
  if (git('ls-remote', '--refs', 'origin', branch).trim() !== `${revision}\t${branch}`)
    throw new Error(`Scoring requires HEAD to be published as ${branch}`)
  // Reproduce every development result; only the two independently pinned transport fingerprints differ.
  const frozenFiles = Object.fromEntries(locked.map((path) => [path, sha256(git('show', `${freezeCommit}:${path}`))]))
  return {
    publication: { revision, freezeCommit, freezeSha256, transportCommit, transportSha256: sha256(transport) },
    freeze,
    frozenFiles,
  }
}

export const afterFreeze = async <A>(computed: unknown, receipt: string, open: () => Promise<A>) => {
  if (json(JSON.parse(receipt)) !== json(computed))
    throw new Error('Published freeze differs from this implementation or the replayed development receipt')
  return open()
}

const neighbors = (trial: Trial, candidate: Trial) => {
  if (trial.basket !== candidate.basket || candidate.legacy === true) return false
  if (trial.band !== candidate.band && Math.abs(trial.band - candidate.band) > 0.21) return false
  return (
    Number(trial.band !== candidate.band) +
      Number(trial.minutes !== candidate.minutes) +
      Number(trial.exit !== candidate.exit) +
      Number(trial.sizing !== candidate.sizing) ===
    1
  )
}

type Freeze = ReturnType<typeof develop>
const report = (
  days: readonly Day[],
  shyClose: readonly number[],
  freeze: Freeze,
  provenance: ReturnType<typeof published>['publication'],
  holdoutCoverage: Awaited<ReturnType<typeof loadHoldout>>['coverage'],
) => {
  const dates = days.map(({ date }) => date)
  const shyWealth = shyClose.map((p) => (capital * p) / shyClose[0])
  const shyCarry = shyWealth.map((n, i) => n - (shyWealth[i - 1] ?? capital))
  const trainEnd = splits.train.count
  const holdoutStart = trainEnd + splits.validation.count
  const windows = {
    train: [0, trainEnd],
    validation: [trainEnd, holdoutStart],
    holdout: [holdoutStart, days.length],
    full: [0, days.length],
  } as const
  const windowEntries = Object.entries(windows)
  const years = Object.entries(Object.groupBy(dates, (date) => date.slice(0, 4))).map(([year, datesInYear]) => {
    if (datesInYear === undefined) throw new Error(`Empty calendar year: ${year}`)
    const start = dates.indexOf(datesInYear[0])
    return [year, [start, start + datesInYear.length]] as const
  })
  const baseline = freeze.primary.selected
  const matched: Trial = { ...baseline, basket: 'B0', id: 'B0/matched-primary' }
  const matchedEqual: Trial = { ...baseline, id: 'B4/matched-equal', sizing: 'equal_weight' }
  const novel = symbols.filter((symbol) => symbol !== 'QQQ' && symbol !== 'SMH')
  const main = [
    ...new Map(
      [...freeze.cohorts.map(({ selected }) => selected), baseline, legacy, matched, matchedEqual].map((spec) => [
        spec.id,
        spec,
      ]),
    ).values(),
  ]
  const paths = main.map((spec) => ({ spec, rows: [] as Ledger[] }))
  const novelRows: Ledger[] = []
  const standalones = symbols.map((symbol) => ({ symbol, rows: [] as Ledger[] }))
  const omitted = symbols.map((symbol) => ({
    symbol,
    members: symbols.filter((other) => other !== symbol),
    rows: [] as Ledger[],
  }))
  const gridRows = grid.map((spec) => ({ spec, holdout: [] as Ledger[] }))
  let dayIndex = 0
  for (const day of prepare(days)) {
    const replay = createReplay(day)
    for (const { spec, rows } of paths) rows.push(replay(spec))
    novelRows.push(replay(baseline, novel))
    for (const { symbol, rows } of standalones) rows.push(replay(baseline, [symbol]))
    for (const { members, rows } of omitted) rows.push(replay(baseline, members))
    if (dayIndex++ >= holdoutStart) for (const { spec, holdout } of gridRows) holdout.push(replay(spec))
  }
  const dsrBenchmark = freeze.trainDsrBenchmarkDaily
  const bootstrapByWindow = new Map(windowEntries.map(([name, [a, b]]) => [name, stationaryBootstrap(b - a)]))
  const metrics = (rows: readonly Ledger[], allCosts: boolean) => {
    const slices = (a: number, b: number, bootstrap?: ReturnType<typeof stationaryBootstrap>) =>
      matrix(rows.slice(a, b), shyCarry.slice(a, b), dsrBenchmark, bootstrap, allCosts)
    return {
      executionExceptions: rows.flatMap(({ unresolved, missingHeld, missingEntries }, i) =>
        unresolved + missingHeld + missingEntries === 0
          ? []
          : [{ date: dates[i], unresolved, missingHeld, missingEntries }],
      ),
      windows: Object.fromEntries(
        windowEntries.map(([name, [a, b]]) => [name, slices(a, b, bootstrapByWindow.get(name))]),
      ),
      years: Object.fromEntries(years.map(([year, [a, b]]) => [year, slices(a, b)])),
      cumulativeDsr: Object.fromEntries(
        years.map(([year, [, b]]) => [
          year,
          costs.map((bp) => {
            const daily = rows.slice(0, b).map((row) => netAt(row, bp))
            return { bp, dsr: daily.every((n): n is number => n !== null) ? deflatedSharpe(daily, dsrBenchmark) : null }
          }),
        ]),
      ),
    }
  }
  const getRows = (id: string) => {
    const result = paths.find(({ spec }) => spec.id === id)
    if (result === undefined) throw new Error(`Missing frozen replay: ${id}`)
    return result.rows
  }
  const comparison = (other: readonly Ledger[]) =>
    Object.fromEntries(
      windowEntries.map(([name, [a, b]]) => {
        const bootstrap = bootstrapByWindow.get(name)
        if (bootstrap === undefined) throw new Error(`Missing registered bootstrap: ${name}`)
        return [
          name,
          costs.map((bp) => ({ bp, ...delta(getRows(baseline.id).slice(a, b), other.slice(a, b), bp, bootstrap) })),
        ]
      }),
    )
  const selected = paths.map(({ spec, rows }) => ({ spec, ...metrics(rows, true) }))
  const mask = commonMask([...paths.map(({ rows }) => rows), novelRows], dates.length)
  const commonCase = (rows: readonly Ledger[]) =>
    Object.fromEntries(
      [...windowEntries, ...years].map(([name, [a, b]]) => {
        const confirmed = rows.slice(a, b).filter((_, i) => mask[a + i])
        return [
          name,
          {
            sessions: confirmed.length,
            costs: costs.map((bp) => ({
              bp,
              alphaNetUsd:
                confirmed.length === 0 ? null : confirmed.reduce((usd, row) => usd + row.base - bp * row.slope, 0),
            })),
          },
        ]
      }),
    )
  const primaryReport = selected.find(({ spec }) => spec.id === baseline.id)
  const primaryHoldout = primaryReport?.windows['holdout']?.find(({ bp }) => bp === selectionCost)?.alpha
  const primaryFull = primaryReport?.windows['full']?.find(({ bp }) => bp === selectionCost)?.alpha
  const versusLegacy = comparison(getRows(legacy.id))
  const versusMatchedB0 = comparison(getRows(matched.id))
  const versusMatchedEqual = comparison(getRows(matchedEqual.id))
  const primaryDelta = versusMatchedB0['holdout']?.find(({ bp }) => bp === selectionCost)
  const legacyDelta = versusLegacy['holdout']?.find(({ bp }) => bp === selectionCost)
  const passed = (value: ReturnType<typeof delta> | undefined) =>
    value !== undefined && value.netUsd !== null && value.netUsd > 0 && value.p !== null && value.p < 0.05
  const criteria = {
    holdoutFiveBpPositive: Number(primaryHoldout?.netUsd) > 0,
    holdoutFiveBpExTop10Positive: Number(primaryHoldout?.exTop10Usd) > 0,
    holdoutFiveBpDsrAtLeast95: Number(primaryHoldout?.dsr) >= 0.95,
    holdoutFiveBpPairedImprovementVsMatchedB0: passed(primaryDelta),
    holdoutFiveBpPairedImprovementVsLegacy: passed(legacyDelta),
    fullFlatAndGrossWithinBound:
      primaryFull !== undefined &&
      primaryFull.unresolved === 0 &&
      primaryFull.missingHeld === 0 &&
      primaryFull.maxGrossUpperBoundUsd <= cap,
  }
  const stationarity = gridRows.map(({ spec, holdout }) => ({ spec, holdout: rankWindow(holdout) }))
  const plateau = [...freeze.cohorts.map(({ selected }) => selected), baseline].map((chosen) => {
    const scores = freeze.scores.filter(({ spec }) => neighbors(chosen, spec))
    return {
      id: chosen.id,
      neighbors: scores.map(({ spec }) => spec.id),
      windows: Object.fromEntries(
        (['train', 'validation', 'holdout'] as const).map((name) => {
          const rows =
            name === 'holdout'
              ? stationarity.map(({ spec, holdout }) => ({ spec, score: holdout }))
              : freeze.scores.map(({ spec, [name]: score }) => ({ spec, score }))
          const chosenSharpe = rows.find(({ spec }) => spec.id === chosen.id)?.score.sharpeDaily
          const within = rows.filter(
            ({ spec, score }) =>
              neighbors(chosen, spec) &&
              chosenSharpe !== undefined &&
              chosenSharpe !== null &&
              chosenSharpe > 0 &&
              Number(score.netUsd) > 0 &&
              Number(score.sharpeDaily) >= 0.8 * chosenSharpe,
          ).length
          return [
            name,
            { within, tested: scores.length, pct: scores.length === 0 ? null : (100 * within) / scores.length },
          ]
        }),
      ),
    }
  })
  return {
    schema: 'bayn.research.wave-6a.results.v1',
    publication: provenance,
    source: sources,
    friction: { scenariosRtBps: costs, sellFeeBps: 0.21, historicalExecutionNbbo: false },
    coverage: { development: freeze.coverage, holdout: holdoutCoverage },
    dates,
    shy: {
      basis: 'Alpaca SIP dividend/split-adjusted close; funded from first observed close',
      finalReturn: shyWealth[shyWealth.length - 1] / capital - 1,
      annualCarryUsd: Object.fromEntries(
        years.map(([year, [a, b]]) => [year, shyCarry.slice(a, b).reduce((x, y) => x + y, 0)]),
      ),
    },
    primary: baseline.id,
    criteria,
    verdict: Object.values(criteria).every(Boolean)
      ? 'SUPPORTS_EXPANSION_AT_REGISTERED_GATE'
      : 'DOES_NOT_SUPPORT_EXPANSION_AT_REGISTERED_GATE',
    selected,
    paired: { versusLegacy, versusMatchedB0, versusMatchedEqual },
    commonResolvedSessionsSensitivity: {
      excludedDates: dates.filter((_, i) => !mask[i]),
      alphaOnly: [...paths.map(({ spec, rows }) => ({ id: spec.id, rows })), { id: 'B4/novel14', rows: novelRows }].map(
        ({ id, rows }) => ({ id, windowsAndYears: commonCase(rows) }),
      ),
    },
    novel14: { members: novel, ...metrics(novelRows, false) },
    standalone: standalones.map(({ symbol, rows }) => ({ symbol, ...metrics(rows, false) })),
    leaveOneEtfOut: omitted.map(({ symbol, rows }) => ({ omitted: symbol, ...metrics(rows, false) })),
    crossEtfAlphaCorrelation5Bp: {
      symbols,
      windows: Object.fromEntries(
        windowEntries.map(([name, [a, b]]) => {
          const arrays = standalones.map(({ rows }) => rows.slice(a, b).map((row) => netAt(row, selectionCost)))
          return [name, arrays.map((first) => arrays.map((second) => correlation(first, second)))]
        }),
      ),
    },
    plateau,
    holdoutGrid5BpDescriptive: stationarity,
  }
}

class StudyError extends Data.TaggedError('NoiseAreaStudyError')<{ readonly message: string }> {}
const failure = (cause: unknown) => new StudyError({ message: cause instanceof Error ? cause.message : String(cause) })

const score = async (
  archive: Archive,
  development: Development,
  computed: Freeze,
  receipt: ReturnType<typeof published>,
) => {
  const { freeze, publication } = receipt
  const holdout = await afterFreeze(computed, freeze, () => loadHoldout(archive))
  const days = [...development.days, ...holdout.days]
  const shy = await loadShy(
    archive,
    days.map(({ date }) => date),
  )
  return report(days, shy, computed, publication, holdout.coverage)
}

const main = Effect.gen(function* () {
  const [stage, switchName, output, ...rest] = process.argv.slice(2)
  if (
    (stage !== '--develop' && stage !== '--score') ||
    switchName !== '--output' ||
    output === undefined ||
    output === '' ||
    rest.length > 0
  )
    return yield* new StudyError({
      message: 'Usage: research-10yr-16etf-noise-area.ts (--develop | --score) --output <new JSON path>',
    })
  yield* Effect.try({
    try: () => {
      if (lstatSync(output, { throwIfNoEntry: false }) !== undefined) throw new Error(`Refusing to overwrite ${output}`)
    },
    catch: failure,
  })
  const receipt = yield* Effect.try({ try: () => (stage === '--score' ? published() : undefined), catch: failure })
  const result = yield* withArchive(async (archive) => {
    const development = await loadDevelopment(archive)
    const computed = develop(development, receipt?.frozenFiles)
    return receipt === undefined ? computed : score(archive, development, computed, receipt)
  })
  yield* Effect.tryPromise({ try: (signal) => writeFile(output, json(result), { flag: 'wx', signal }), catch: failure })
  yield* Effect.logInfo(`Wrote ${output}`)
})

if (import.meta.main) NodeRuntime.runMain(main)
