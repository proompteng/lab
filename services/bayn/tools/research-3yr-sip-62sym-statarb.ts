import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'

import { hash, loadSources, readPanel, sourceIdentity, type Panel } from './sip-statarb-data'
import { evaluate, losoSummaries, nominate, qualify } from './sip-statarb-evaluation'
import { buildTrials, capitalUsd, grossCapUsd, lastDay, validationEnd } from './sip-statarb-protocol'
import { replay } from './sip-statarb-replay'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const evidencePath = 'docs/bayn/evidence/2026-11-27-3yr-sip-62sym-statarb'
const toolsPath = 'services/bayn/tools'
const freezePath = `${evidencePath}/freeze.json`
const sourceFiles = [
  `${evidencePath}/protocol.md`,
  ...[
    'research-3yr-sip-62sym-statarb',
    'sip-statarb-data',
    'sip-statarb-evaluation',
    'sip-statarb-protocol',
    'sip-statarb-replay',
    'midday-research-statistics',
    'research-orb-zab-data',
    'research-orb-zab-statistics',
  ].map((name) => `${toolsPath}/${name}.ts`),
  'services/bayn/src/broker/alpaca/normalizers.ts',
  'services/bayn/src/broker/alpaca/model.ts',
  'bun.lock',
]
const subprocess = promisify(execFile)
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export const cliOptions = (args: readonly string[]) => {
  const { values: flags } = parseArgs({
    args: [...args],
    options: {
      freeze: { type: 'boolean' },
      score: { type: 'boolean' },
      'input-dir': { type: 'string' },
      output: { type: 'string' },
    },
  })
  if ((flags.freeze === true) === (flags.score === true))
    throw new Error(
      'Usage: bun research-3yr-sip-62sym-statarb.ts (--freeze | --score) [--input-dir DIR] [--output PATH]',
    )
  return {
    stage: flags.freeze === true ? ('freeze' as const) : ('score' as const),
    inputDir: flags['input-dir'],
    output: flags.output,
  }
}

class StudyError extends Data.TaggedError('SipStatArbStudyError')<{
  readonly operation: string
  readonly cause: unknown
}> {}
const operation = <A>(name: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StudyError({ operation: name, cause }) })
const calculation = <A>(name: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new StudyError({ operation: name, cause }) })

const git = async (signal: AbortSignal, args: readonly string[]) =>
  (await subprocess('git', [...args], { cwd: root, signal, maxBuffer: 16 * 1024 * 1024 })).stdout

const trackedInputs = (signal: AbortSignal) =>
  Promise.all(
    sourceFiles.map(async (path) => {
      const text = await readFile(`${root}${path}`, { encoding: 'utf8', signal })
      if ((await git(signal, ['show', `HEAD:${path}`])) !== text)
        throw new Error(`Commit research input before running the study: ${path}`)
      return [path, hash(text)] as const
    }),
  ).then(Object.fromEntries<string>)

const committedReceipt = async (signal: AbortSignal) => {
  const contents = await git(signal, ['show', `HEAD:${freezePath}`])
  if ((await readFile(`${root}${freezePath}`, { encoding: 'utf8', signal })) !== contents)
    throw new Error('Scoring requires the unmodified, committed development receipt')
  const commit = (await git(signal, ['log', '-1', '--format=%H', '--', freezePath])).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Development receipt commit is missing')
  return { contents, commit }
}

const trials = buildTrials()
const freeze = (panel: Panel, implementation: Record<string, string>) => {
  const development = { ...panel, days: panel.days.filter((day) => day.date <= validationEnd) }
  const { deflation, evaluated } = evaluate(development, trials, replay(development, trials, false), 'freeze')
  return {
    schema: 'bayn.sip-statarb-freeze.v1',
    inputs: sourceIdentity,
    implementation,
    developmentThrough: validationEnd,
    capitalUsd,
    grossCapUsd,
    universes: Object.fromEntries(
      Object.entries(panel.universes).map(([name, ids]) => [name, ids.map((id) => panel.symbols[id])]),
    ),
    deflation,
    nominations: nominate(evaluated),
    trials: evaluated,
  }
}

const main = Effect.gen(function* () {
  const options = yield* calculation('parse arguments', () => cliOptions(Bun.argv.slice(2)))
  const receipt = options.stage === 'score' ? yield* operation('read committed freeze receipt', committedReceipt) : null
  const implementation = yield* operation('verify committed research inputs', trackedInputs)
  const sources = yield* loadSources(options.inputDir)
  const panel = yield* operation('stream and authenticate SIP evidence', (signal) =>
    readPanel(sources, options.stage === 'freeze' ? validationEnd : lastDay, signal),
  )
  const frozen = yield* calculation('evaluate Train and Validation', () => freeze(panel, implementation))
  const frozenText = json(frozen)
  if (receipt === null) {
    yield* operation('write development-only receipt', (signal) =>
      writeFile(options.output ?? `${root}${freezePath}`, frozenText, { signal, flag: 'wx' }),
    )
    yield* Effect.logInfo(`Froze ${trials.length} trials; commit ${freezePath} before --score.`)
    return
  }

  if (receipt.contents !== frozenText)
    return yield* new StudyError({
      operation: 'reproduce development-only receipt',
      cause: new Error('Committed receipt does not match this protocol, code, dataset or development calculation'),
    })
  const results = yield* calculation('replay and score frozen holdout', () => {
    const ledgers = replay(panel, trials, true)
    const { deflation, evaluated, ranges } = evaluate(panel, trials, ledgers, 'score')
    const gates = qualify(evaluated, frozen.nominations)
    return {
      schema: 'bayn.sip-statarb-scores.v1',
      freeze: { commit: receipt.commit, sha256: hash(receipt.contents), nominations: frozen.nominations },
      inputs: sourceIdentity,
      universes: frozen.universes,
      coverage: panel.coverage,
      deflation,
      periods: ranges.map(({ id, start, end }) => ({
        id,
        start: panel.days[start].date,
        end: panel.days[end - 1].date,
        sessions: end - start,
      })),
      qualified: gates.filter((gate) => gate.qualified).map((gate) => gate.id),
      trials: evaluated.map((trial, index) => {
        const ledger = ledgers.get(trial.id)
        if (ledger === undefined) throw new Error(`Missing LOSO ledger for ${trial.id}`)
        return { ...trial, gates: gates[index], loso: losoSummaries(ledger, panel.symbols, ranges) }
      }),
    }
  })
  yield* operation('write complete scorecard', (signal) =>
    writeFile(options.output ?? `${root}${evidencePath}/results.json`, json(results), { signal, flag: 'wx' }),
  )
  yield* Effect.logInfo(`Scored ${trials.length} trials; ${results.qualified.length} frozen candidates qualified.`)
})

if (import.meta.main) NodeRuntime.runMain(main)
