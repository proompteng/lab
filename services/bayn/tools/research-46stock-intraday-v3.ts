import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'

import { loadTape } from './intraday-v3-data'
import { score, selectDevelopment } from './intraday-v3-evaluation'
import { prepareDays } from './intraday-v3-signals'
import { sha256 } from './research-orb-zab-data'

const evidence = 'docs/bayn/evidence/2026-11-27-46stock-intraday-v3'
const freezePath = `${evidence}/freeze.json`
const registeredPaths = [
  `${evidence}/protocol.md`,
  `${evidence}/prior-sharpe.json`,
  ...[
    'research-46stock-intraday-v3',
    'intraday-v3-data',
    'intraday-v3-evaluation',
    'intraday-v3-protocol',
    'intraday-v3-replay',
    'intraday-v3-signals',
    'midday-research-statistics',
    'research-orb-zab-data',
  ].map((name) => `services/bayn/tools/${name}.ts`),
]
const schema = 'bayn.research.intraday-v3.freeze.v1'
class StudyError extends Data.TaggedError('StudyError')<{ readonly message: string; readonly cause?: unknown }> {}

export const parseArgs = (args: readonly string[]) => {
  const [mode, option, output] = args
  if (
    (mode !== '--freeze' && mode !== '--score') ||
    (args.length !== 1 &&
      (args.length !== 3 || option !== '--output' || output === undefined || output === '' || output.startsWith('--')))
  ) {
    throw new Error('Usage: bun services/bayn/tools/research-46stock-intraday-v3.ts --freeze|--score [--output path]')
  }
  return { mode, output: output ?? (mode === '--freeze' ? freezePath : `${evidence}/results.json`) }
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const receipt = () => {
  const commit = git('log', '-1', '--format=%H', 'HEAD', '--', freezePath).trim()
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Commit the development freeze before scoring Holdout')
  const bytes = git('show', `${commit}:${freezePath}`)
  if (bytes !== readFileSync(freezePath, 'utf8')) throw new Error('Working freeze differs from its committed receipt')
  return { commit, sha256: sha256(bytes), bytes }
}

export const verifyDevelopment = (committed: string, reproduced: unknown) => {
  const expected: unknown = JSON.parse(committed)
  if (JSON.stringify(expected) !== JSON.stringify(reproduced)) {
    throw new Error('Committed freeze does not reproduce from the current registered code and development data')
  }
}

const program = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseArgs(Bun.argv.slice(2)),
    catch: (cause) => new StudyError({ message: 'Invalid study arguments', cause }),
  })
  const committed = yield* Effect.try({
    try: () => (args.mode === '--score' ? receipt() : null),
    catch: (cause) => new StudyError({ message: 'Missing or invalid committed development receipt', cause }),
  })
  const development = yield* loadTape(false)
  const freeze = yield* Effect.try({
    try: () => ({
      schema,
      registeredFiles: Object.fromEntries(registeredPaths.map((path) => [path, sha256(readFileSync(path))])),
      inputs: development.provenance,
      coverage: development.coverage,
      selection: selectDevelopment(prepareDays(development.days)),
    }),
    catch: (cause) => new StudyError({ message: 'Development replay or registration failed', cause }),
  })
  let output
  if (committed === null) output = freeze
  else {
    yield* Effect.try({
      try: () => verifyDevelopment(committed.bytes, freeze),
      catch: (cause) => new StudyError({ message: 'Holdout scoring refused', cause }),
    })
    yield* Effect.logInfo('Committed development reproduced; beginning frozen Holdout replay')
    const full = yield* loadTape(true)
    const results = yield* Effect.try({
      try: () => score(prepareDays(full.days), freeze.selection),
      catch: (cause) => new StudyError({ message: 'Frozen study replay failed', cause }),
    })
    output = {
      schema: 'bayn.research.intraday-v3.results.v1',
      freeze: { commit: committed.commit, sha256: committed.sha256 },
      inputs: full.provenance,
      coverage: full.coverage,
      ...results,
    }
  }
  yield* Effect.tryPromise({
    try: (signal) => writeFile(args.output, JSON.stringify(output, null, 2) + '\n', { flag: 'wx', signal }),
    catch: (cause) => new StudyError({ message: `Cannot write ${args.output}`, cause }),
  })
  yield* Effect.logInfo(`Wrote ${args.output}`)
})

if (import.meta.main) NodeRuntime.runMain(program)
