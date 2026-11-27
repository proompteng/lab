import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Effect, Schema } from 'effect'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { coverage, loadMarkets, ResearchError, sha256, type Market } from './research-crypto-trend-data'
import {
  economicGates,
  economics,
  passes,
  plateau,
  regimeGate,
  summarize,
  type Metrics,
} from './research-crypto-trend-metrics'
import {
  bootstrap,
  dailyPair,
  development,
  end,
  fees,
  frames,
  gate,
  neighbors,
  primaryFee,
  regimes,
  registry,
  roster,
  splits,
  venues,
  windows,
  type Frame,
  type Trial,
} from './research-crypto-trend-protocol'
import { prepareMarket, simulate, type FeeSeries } from './research-crypto-trend-simulation'
import { dailySharpe, deflationBenchmark } from './research-orb-zab-statistics'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const folder = 'docs/bayn/evidence/2026-11-27-3yr-crypto-24x7-trend'
const freezePath = `${folder}/freeze.json`
const correctionPath = `${folder}/freeze-correction.json`
const sourcePaths = [
  'services/bayn/tools/research-3yr-crypto-24x7-trend.ts',
  'services/bayn/tools/research-crypto-trend-data.ts',
  'services/bayn/tools/research-crypto-trend-protocol.ts',
  'services/bayn/tools/research-crypto-trend-simulation.ts',
  'services/bayn/tools/research-crypto-trend-metrics.ts',
  'services/bayn/tools/research-orb-zab-statistics.ts',
  `${folder}/protocol.md`,
]
const trials = registry()
type Fee = (typeof fees)[number]
type Window = readonly [string, string]
type Periods = Record<string, Window>
type FeeMetrics = Record<Fee, Metrics>

const periods = (frame: Frame, frozen: boolean): Periods => {
  const { start, holdout } = venues[frame]
  const through = frozen ? end : holdout
  const { train, validation, holdout: holdoutWindow } = windows(frame)
  const ranges: Periods = { train, validation }
  if (frozen) {
    ranges['holdout'] = holdoutWindow
    for (let year = 2022; year <= 2026; year++) {
      const from = `${year}-01-01`
      const until = `${year + 1}-01-01`
      if (from >= start) ranges[String(year)] = [from, until < through ? until : through]
    }
  }
  for (const [name, range] of Object.entries(regimes)) {
    if (range[0] >= start && range[1] <= through) ranges[name] = range
  }
  return ranges
}

const feeMap = <A>(f: (fee: Fee) => A): Record<Fee, A> => ({ 50: f(50), 30: f(30), 20: f(20) })
const run = (market: Market, frozen: boolean, frame: Frame) => {
  const ranges = windows(frame)
  const prepared = prepareMarket(market)
  const simulateSplits = (trial: Trial | 'btc' | 'equal', omit?: string) => {
    const train = simulate(prepared, trial, ranges.train, omit)
    const validation = simulate(prepared, trial, ranges.validation, omit)
    const holdout = frozen ? simulate(prepared, trial, ranges.holdout, omit) : null
    const merged = feeMap((fee) => [...train[fee], ...validation[fee], ...(holdout?.[fee] ?? [])])
    return { train, validation, holdout, merged }
  }
  const dateWindows = periods(frame, frozen)
  const crop = (series: FeeSeries, [start, stop]: Window, fee: Fee) => {
    const elapsed = (day: string) => (Date.parse(day) - market.start) / 86_400_000
    return series[fee].slice(elapsed(start), elapsed(stop))
  }
  const btc = simulateSplits('btc')
  const equal = simulateSplits('equal')
  const frameTrials = trials.filter((trial) => trial.frame === frame)
  const all = frameTrials.map((trial) => ({ trial, history: simulateSplits(trial) }))
  const dsrReference = feeMap((fee) => {
    const sharpes = all.flatMap(({ history }) => {
      const sr = dailySharpe(history.train[fee].map(({ net }) => net))
      return sr === null ? [] : [sr]
    })
    return deflationBenchmark(sharpes, frameTrials.length)
  })
  const benchmarks = Object.fromEntries(
    Object.entries(dateWindows).map(([period, range]) => [
      period,
      feeMap((fee) => ({
        btc: economics(crop(btc.merged, range, fee)),
        equal: economics(crop(equal.merged, range, fee)),
      })),
    ]),
  )
  const byTrial = new Map(
    all.map(({ trial, history }) => [
      trial.id,
      {
        trial,
        metrics: Object.fromEntries(
          Object.entries(dateWindows).map(([period, range]) => [
            period,
            feeMap((fee) =>
              summarize(crop(history.merged, range, fee), benchmarks[period][fee].btc, dsrReference[fee]),
            ),
          ]),
        ) as Record<string, FeeMetrics>,
      },
    ]),
  )
  const analysis = [...byTrial.values()].map(({ trial, metrics }) => {
    const local = neighbors(trial, frameTrials)
    const checks = Object.fromEntries(
      Object.entries(metrics).map(([period, m]) => [
        period,
        {
          economics: economicGates(m[primaryFee]),
          plateau: plateau(
            m[primaryFee],
            local.map(({ id }) => {
              const neighbor = byTrial.get(id)
              if (neighbor === undefined) throw new Error(`Missing registered neighbor: ${id}`)
              return { id, metrics: neighbor.metrics[period][primaryFee] }
            }),
          ),
          ...(Object.hasOwn(regimes, period)
            ? {
                regime: regimeGate(
                  m[primaryFee],
                  benchmarks[period][primaryFee].btc,
                  benchmarks[period][primaryFee].equal,
                ),
              }
            : {}),
        },
      ]),
    )
    return { trial, metrics, checks }
  })
  const coverageBySplit = Object.fromEntries(
    (frozen ? splits : development).map((split) => [split, coverage(market, ranges[split][0], ranges[split][1])]),
  )
  return {
    dsrReference,
    benchmarks,
    analysis,
    coverageBySplit,
    dateWindows,
    simulateSplits,
    excludedEndRows: market.excludedEndRows,
  }
}
type Analysis = ReturnType<typeof run>['analysis'][number]

const splitPass = (row: Analysis, period: string) => {
  const { economics: checks, plateau } = row.checks[period]
  return passes(checks) && plateau.pass
}
const developmentPass = (row: Analysis) =>
  development.every((period) => splitPass(row, period)) &&
  Object.keys(regimes).every((name) => row.checks[name]?.regime ?? true)
const rank = (row: Analysis) =>
  Math.min(...development.map((split) => row.metrics[split][primaryFee].sharpe ?? -Infinity))
const compareRank = (a: Analysis, b: Analysis) => rank(b) - rank(a) || (a.trial.id < b.trial.id ? -1 : 1)

export const nominate = (analyses: readonly Analysis[]) => {
  const members = new Map(analyses.map((row) => [row.trial.id, row]))
  const groups = new Map<string, Analysis[]>()
  for (const row of analyses) {
    const group = `${row.trial.frame}/${row.trial.rule.kind}`
    const members = groups.get(group)
    if (members !== undefined) members.push(row)
    else groups.set(group, [row])
  }
  return Object.fromEntries(
    [...groups].map(([group, rows]) => {
      const ranked = rows.toSorted(compareRank)
      const eligible = ranked.filter((row) => {
        const pair = dailyPair(row.trial, trials)
        const paired = pair === undefined ? undefined : members.get(pair.id)
        return paired !== undefined && developmentPass(row) && developmentPass(paired)
      })
      return [
        group,
        {
          nominee: eligible[0]?.trial.id ?? null,
          developmentEligible: eligible.map(({ trial }) => trial.id),
          diagnostic: ranked[0]?.trial.id ?? null,
        },
      ]
    }),
  )
}

const qualification = (row: Analysis, paired: Analysis | undefined, nominated: boolean, cutoff: number) => {
  const holdoutPass = (candidate: Analysis) => {
    const p = candidate.metrics['holdout'][primaryFee].blockP
    return splitPass(candidate, 'holdout') && p !== null && p < cutoff
  }
  const allRegimes = (candidate: Analysis) =>
    Object.keys(regimes)
      .filter((name) => candidate.checks[name])
      .every((name) => candidate.checks[name].regime === true)
  const checks = {
    nominated,
    development: developmentPass(row),
    holdout: holdoutPass(row),
    regimes: allRegimes(row),
    dailyFullCycle: paired !== undefined && developmentPass(paired) && holdoutPass(paired) && allRegimes(paired),
  }
  return { checks, pass: passes(checks) }
}

const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`, { cause: result.error })
  return result.stdout
}
const sourceDigest = () => sha256(sourcePaths.map((path) => `${path}:${sha256(readFileSync(root + path))}`).join('\n'))
const registeredCommit = () => {
  if (
    git('diff', 'HEAD', '--', ...sourcePaths) !== '' ||
    git('ls-files', '--', ...sourcePaths)
      .trim()
      .split('\n').length !== sourcePaths.length
  ) {
    throw new Error('Commit the complete protocol and scoring implementation before running --freeze or --score')
  }
  return git('rev-parse', 'HEAD').trim()
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const freezeRegistration = (
  sourceCommit: string,
  identity: unknown,
  runByFrame: readonly { frame: Frame; run: ReturnType<typeof run> }[],
) => ({
  schema: 'bayn.crypto-24x7-trend.freeze.v1',
  registeredCommit: sourceCommit,
  sourceSha256: sourceDigest(),
  dataset: identity,
  fees,
  selectedUsing: development,
  development: Object.fromEntries(
    runByFrame.map(({ frame, run }) => [
      frame,
      {
        periods: run.dateWindows,
        dsrReference: run.dsrReference,
        coverage: run.coverageBySplit,
        excludedEndRows: run.excludedEndRows,
      },
    ]),
  ),
  selection: nominate(runByFrame.flatMap(({ run }) => run.analysis)),
})

export const parseArgs = (args: readonly string[]) => {
  if (args.length === 1 && args[0] === '--freeze') return { stage: 'freeze' as const, output: root + freezePath }
  if (args.length === 2 && args[0] === '--freeze' && args[1] === '--correction') {
    return { stage: 'correction' as const, output: root + correctionPath }
  }
  if (args[0] === '--score' && args.length === 1)
    return { stage: 'score' as const, output: `${root}${folder}/results.json` }
  if (args[0] === '--score' && args[1] === '--output' && args.length === 3 && args[2] !== '') {
    return { stage: 'score' as const, output: args[2] }
  }
  throw new Error(
    'Usage: bun services/bayn/tools/research-3yr-crypto-24x7-trend.ts --freeze [--correction] | --score [--output PATH]',
  )
}
const ReceiptSchema = Schema.Struct({
  schema: Schema.Literal('bayn.crypto-24x7-trend.freeze.v1'),
  registeredCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  sourceSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  dataset: Schema.Struct({ manifestSha256: Schema.String }),
  selection: Schema.Record(
    Schema.String,
    Schema.Struct({
      nominee: Schema.NullOr(Schema.String),
      developmentEligible: Schema.Array(Schema.String),
      diagnostic: Schema.NullOr(Schema.String),
    }),
  ),
})
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(ReceiptSchema))
const committedReceipt = (path: string) => {
  // GitHub previews create merge commits that also touch these paths. The original receipt is a non-merge commit.
  const commit = git('log', '--full-history', '--no-merges', '-1', '--diff-filter=A', '--format=%H', '--', path).trim()
  if (commit === '') throw new Error(`Commit ${path} before scoring Frozen Holdout`)
  const receipt = readFileSync(root + path, 'utf8')
  if (receipt !== git('show', `${commit}:${path}`) || receipt !== git('show', `HEAD:${path}`)) {
    throw new Error(`Receipt differs from the original committed bytes: ${path}`)
  }
  return { commit, receipt, metadata: decodeReceipt(receipt) }
}

const checked = <T>(message: string, action: () => T) =>
  Effect.try({ try: action, catch: (cause) => new ResearchError({ message, cause }) })

const program = Effect.gen(function* () {
  const { stage, output } = yield* checked('Invalid arguments', () => parseArgs(Bun.argv.slice(2)))
  const head = yield* checked('Research sources are not registered', registeredCommit)
  const original =
    stage === 'freeze' ? null : yield* checked('No committed freeze receipt', () => committedReceipt(freezePath))
  const correcting = stage === 'correction' || (stage === 'score' && existsSync(root + correctionPath))
  const committed =
    stage === 'score' && correcting
      ? yield* checked('No committed correction receipt', () => committedReceipt(correctionPath))
      : original
  const sourceCommit = stage === 'score' ? committed?.metadata.registeredCommit : head
  if (sourceCommit === undefined) return yield* new ResearchError({ message: 'Missing active source registration' })
  if (stage === 'score' && committed?.metadata.sourceSha256 !== sourceDigest()) {
    return yield* new ResearchError({ message: 'Scoring sources differ from the committed registration' })
  }
  const dev = yield* loadMarkets(false)
  if (original !== null && dev.identity.manifestSha256 !== original.metadata.dataset.manifestSha256) {
    return yield* new ResearchError({ message: 'Frozen manifest differs from original registration' })
  }
  const registration = yield* checked('Development evaluation failed', () =>
    freezeRegistration(
      sourceCommit,
      dev.identity,
      frames.map((frame) => ({
        frame,
        run: run(dev.market(frame), false, frame),
      })),
    ),
  )
  // A reviewed implementation correction may change metrics, but cannot replace the frozen slate or diagnostics.
  const active =
    correcting && original !== null
      ? {
          ...registration,
          selection: original.metadata.selection,
          correctsFreezeSha256: sha256(original.receipt),
          correctedDevelopmentSelection: registration.selection,
        }
      : registration
  const receipt = json(active)
  if (stage !== 'score') {
    yield* checked('Could not write freeze receipt', () => writeFileSync(output, receipt, { flag: 'wx' }))
    yield* Effect.logInfo(`Wrote development-only freeze: ${output}. Commit the receipt before scoring.`)
    return
  }
  if (original === null || committed === null || receipt !== committed.receipt) {
    return yield* new ResearchError({
      message: 'Source, protocol, dataset or development evaluation changed since freeze',
    })
  }
  const scored = yield* loadMarkets(true)
  if (json(scored.identity) !== json(dev.identity))
    return yield* new ResearchError({ message: 'Dataset identity changed between phases' })
  const result = yield* checked('Frozen scoring failed', () => {
    const evaluated = frames.map((frame) => ({ frame, run: run(scored.market(frame), true, frame) }))
    const analyses = new Map(evaluated.flatMap(({ run }) => run.analysis.map((row) => [row.trial.id, row])))
    const nominees = new Set(
      Object.values(active.selection).flatMap(({ nominee }) => (nominee === null ? [] : [nominee])),
    )
    const cutoff = gate.maxP / Math.max(1, nominees.size)
    const winners: string[] = []
    const reports = evaluated.map(({ frame, run }) => ({
      frame,
      periods: run.dateWindows,
      coverage: run.coverageBySplit,
      excludedEndRows: run.excludedEndRows,
      benchmarks: run.benchmarks,
      dsrReference: run.dsrReference,
      trials: run.analysis.map((row) => {
        const { trial } = row
        const pair = dailyPair(trial, trials)
        const verdict = qualification(
          row,
          pair === undefined ? undefined : analyses.get(pair.id),
          nominees.has(trial.id),
          cutoff,
        )
        if (verdict.pass) winners.push(trial.id)
        const leaveOneCoinOut = Object.fromEntries(
          roster(trial.universe).map((omit) => {
            const replay = run.simulateSplits(trial, omit)
            return [
              omit,
              feeMap((fee) =>
                splits.map((split) => {
                  const days = replay[split]?.[fee]
                  if (days === undefined)
                    throw new Error(`Missing leave-one-coin-out replay: ${trial.id} ${omit} ${split}`)
                  const { net, sharpe, maxDrawdown, annualTurnover, staleBars, unsettled } = economics(days)
                  return [net, sharpe, maxDrawdown, annualTurnover, staleBars, unsettled]
                }),
              ),
            ]
          }),
        )
        return { ...row, pairedDaily: pair?.id ?? null, verdict, leaveOneCoinOut }
      }),
    }))
    return {
      schema: 'bayn.crypto-24x7-trend.results.v1',
      registration: original.metadata.registeredCommit,
      freezeCommit: original.commit,
      freezeSha256: sha256(original.receipt),
      ...(correcting
        ? { correction: { registration: sourceCommit, commit: committed.commit, sha256: sha256(receipt) } }
        : {}),
      dataset: scored.identity,
      fees,
      primaryFee,
      bootstrap,
      holdoutCandidateCutoff: cutoff,
      leaveOneCoinOut: {
        splits,
        columns: ['net', 'sharpe', 'maxDrawdown', 'annualTurnover', 'staleBars', 'unsettled'],
      },
      selection: active.selection,
      frames: reports,
      winners,
    }
  })
  // Keep every trial on its own line to make the otherwise large generated artifact navigable.
  const { frames: reports, winners, ...metadata } = result
  const frameJson = reports.map(
    ({ trials, ...frame }) =>
      `  ${JSON.stringify(frame).slice(0, -1)}, "trials": [\n    ${trials.map((trial) => JSON.stringify(trial)).join(',\n    ')}\n  ]}`,
  )
  const encoded = `${json(metadata).trimEnd().slice(0, -2)},\n  "winners": ${JSON.stringify(winners)},\n  "frames": [\n${frameJson.join(',\n')}\n  ]\n}\n`
  yield* checked('Could not write research results', () => writeFileSync(output, encoded, { flag: 'wx' }))
  yield* Effect.logInfo(`Scored ${trials.length} trials; ${winners.length} qualified. Wrote ${output}.`)
})

if (import.meta.main) NodeRuntime.runMain(program)
