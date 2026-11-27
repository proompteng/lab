import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { gzipHash, manifestHash, rawHash, readManifest, readTape, sha256, tapeKey } from './overnight-tugofwar-data'
import { develop, score } from './overnight-tugofwar-study'

const root = resolve(import.meta.dir, '../../..')
const evidence = 'docs/bayn/evidence/2026-11-27-10yr-overnight-tugofwar'
const freezePath = `${evidence}/freeze.json`
const branch = 'codex/bayn-w4g-10yr-overnight-open-close'
const sources = [
  'overnight-tugofwar-data.ts',
  'overnight-tugofwar-protocol.ts',
  'overnight-tugofwar-replay.ts',
  'overnight-tugofwar-statistics.ts',
  'overnight-tugofwar-study.ts',
  'research-10yr-overnight-tugofwar.ts',
  'research-orb-zab-statistics.ts',
]

class ResearchError extends Data.TaggedError('OvernightTugOfWarError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const step = <A>(message: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new ResearchError({ message, cause }) })

const git = (args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make('git', args, { cwd: root, stdin: 'ignore' }))
    const [stdout, stderr, exit] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: 'unbounded' },
    )
    if (Number(exit) !== 0) {
      return yield* new ResearchError({
        message: `Git could not verify the pushed freeze (git ${args.join(' ')})`,
        cause: stderr.trim(),
      })
    }
    return stdout
  }).pipe(Effect.scoped)

const render = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { values } = yield* step('Invalid research arguments', () =>
    parseArgs({
      options: {
        freeze: { type: 'boolean' },
        score: { type: 'boolean' },
        'freeze-commit': { type: 'string' },
        data: { type: 'string' },
        manifest: { type: 'string' },
      },
    }),
  )
  const commit = values['freeze-commit']
  if (
    Boolean(values.freeze) === Boolean(values.score) ||
    values.data === undefined ||
    values.data === '' ||
    values.manifest === undefined ||
    values.manifest === '' ||
    (values.score === true ? commit === undefined || !/^[a-f0-9]{40}$/.test(commit) : commit !== undefined)
  ) {
    return yield* new ResearchError({
      message:
        'Use --data <gzip> --manifest <json> with either --freeze or --score --freeze-commit <40-char pushed SHA>',
    })
  }
  const freezeFile = join(root, freezePath)
  let committedFreeze: string | undefined
  if (values.score === true && commit !== undefined) {
    yield* git(['fetch', '--no-tags', 'origin', `refs/heads/${branch}`])
    yield* git(['merge-base', '--is-ancestor', commit, 'FETCH_HEAD'])
    yield* git(['merge-base', '--is-ancestor', commit, 'HEAD'])
    const introduced = yield* git(['log', '--format=%H', '--diff-filter=A', commit, '--', freezePath])
    if (introduced.trim() !== commit) {
      return yield* new ResearchError({ message: 'Use the pushed commit which introduced freeze.json' })
    }
    committedFreeze = yield* git(['show', `${commit}:${freezePath}`])
    const workingFreeze = yield* fs.readFileString(freezeFile)
    if (workingFreeze !== committedFreeze) {
      return yield* new ResearchError({ message: 'Working freeze.json differs from the pushed freeze' })
    }
  } else if (yield* fs.exists(freezeFile)) {
    return yield* new ResearchError({ message: 'Refusing to replace an existing freeze.json' })
  }

  const manifest = yield* fs.readFile(values.manifest)
  const universe = yield* step('Verify the frozen manifest', () => readManifest(manifest))
  const gzip = yield* fs.readFile(values.data)
  const development = yield* step('Develop on Train and Validation only', () =>
    develop(readTape(gzip, universe, 'development')),
  )
  const protocol = yield* fs.readFile(join(root, evidence, 'protocol.md'))
  const engine = yield* Effect.forEach(sources, (name) =>
    fs.readFile(join(import.meta.dir, name)).pipe(Effect.map((bytes) => [name, sha256(bytes)])),
  )
  const freeze = render({
    schema: 'bayn.overnight-tugofwar.freeze.v1',
    tapeKey,
    manifestSha256: manifestHash,
    gzipSha256: gzipHash,
    rawSha256: rawHash,
    protocolSha256: sha256(protocol),
    engineSha256: sha256(JSON.stringify(engine)),
    development,
  })
  if (values.score !== true) {
    yield* fs.writeFileString(freezeFile, freeze, { flag: 'wx' })
    yield* Effect.logInfo('Development frozen. Commit and push protocol.md and freeze.json before scoring.')
    return
  }
  if (freeze !== committedFreeze || commit === undefined) {
    return yield* new ResearchError({
      message: 'Current engine, protocol, or development replay does not match the pushed freeze',
    })
  }

  const resultFile = join(root, evidence, 'results.json')
  const results = yield* step('Score all registered trials without Holdout retuning', () =>
    score(readTape(gzip, universe, 'full'), development, commit),
  )
  if (yield* fs.exists(resultFile)) {
    const recorded = yield* fs.readFileString(resultFile)
    const normalized = yield* step('Parse the existing results.json', (): unknown => JSON.parse(recorded))
    if (render(normalized) !== render(results)) {
      return yield* new ResearchError({
        message: 'Frozen replay differs from the existing results.json; refusing to overwrite it',
      })
    }
  } else {
    yield* fs.writeFileString(resultFile, render(results), { flag: 'wx' })
  }
  yield* Effect.logInfo(
    `Scored ${development.trialCount} frozen trials; ${results.eligibleToAdvance.length} cleared the research gates.`,
  )
})

if (import.meta.main) {
  NodeRuntime.runMain(
    main.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline CLI owns filesystem and scoped Git subprocesses
      Effect.provide(NodeServices.layer),
    ),
  )
}
