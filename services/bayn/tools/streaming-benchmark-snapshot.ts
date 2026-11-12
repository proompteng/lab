import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { posix } from 'node:path'
import { Schema } from 'effect'

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const decodeDependencies = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) })),
)
const decodeVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))
const repositoryRoot = resolve(import.meta.dir, '../../..')
const git = (...args: readonly string[]) =>
  execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

const modules = {
  replayRuntime: 'src/intraday-replay/runtime.ts',
  backtest: 'src/intraday-replay/backtest.ts',
  replayBroker: 'src/intraday-replay/broker.ts',
  replayClock: 'src/intraday-replay/clock.ts',
  replaySession: 'src/intraday-replay/session.ts',
  replaySource: 'src/market-data/streaming/historical.ts',
  replayMarket: 'src/market-data/streaming/simulation-service.ts',
  nativeRuntime: 'src/composition/native-execution-runtime.ts',
  controller: 'src/restate/restate-execution-controller.ts',
  brokerOwner: 'src/restate/restate-broker-observations.ts',
  inference: 'src/restate/restate-entry-inference.ts',
  http2: 'src/restate/restate-http2-server.ts',
  executionStatus: 'src/db/execution-controller-status-postgres.ts',
  executionStatusModel: 'src/execution/controller-status.ts',
  executionEvents: 'src/execution/events.ts',
  inferenceWork: 'src/jev/inference-work.ts',
  inferenceWorkPostgres: 'src/db/jev-inference-work-postgres.ts',
  decisionConstruction: 'src/decision-construction.ts',
  postgres: 'src/db/postgres-client.ts',
  migrations: 'src/db/postgres-migrations.ts',
  writerFence: 'src/execution/writer-fence.ts',
  intents: 'src/execution/intents/postgres.ts',
  blockedIntents: 'src/execution/intents/blocked-cycle-postgres.ts',
  mutations: 'src/execution/mutations/program.ts',
  closures: 'src/db/execution-cycle-closure-postgres.ts',
  capitalGrants: 'src/db/persisted-capital-grant.ts',
  entryJournal: 'src/db/entry-inference-postgres.ts',
  candidateObservations: 'src/db/candidate-observation-postgres.ts',
  batches: 'src/db/jev-batch-postgres.ts',
  positions: 'src/db/jev-position-postgres.ts',
  ledger: 'src/ledger.ts',
  brokerIdentity: 'src/broker/identity.ts',
  authority: 'src/execution/authority.ts',
  fixtures: 'src/testing/runtime-fixtures.ts',
  nativeFixtures: 'src/jev/native.test-support.ts',
  marketFixtures: 'src/testing/simulated-streaming-fixture.ts',
  tradingFixtures: 'src/testing/registered-replay-fixture.ts',
  retainedFixtures: 'src/testing/retained-replay-fixture.ts',
  providerFixtures: 'src/jev/entry-inference.test-support.ts',
  providerClient: 'src/jev/client.ts',
  marketData: 'src/market-data/intraday/model.ts',
  jevBatch: 'src/jev/batch-evaluation.ts',
  jevJournal: 'src/jev/entry-inference.ts',
  hashes: 'src/hash.ts',
} as const

const fixtureExposure = {
  path: 'services/bayn/src/intraday-replay/runtime.ts',
  before: '      authorityGenerationHash: activated.generationHash,',
  after:
    '      __benchmarkDriver: driver,\n      __benchmarkResources: resources,\n      authorityGenerationHash: activated.generationHash,',
} as const

/** Git objects are read into the bundler; no checkout, repository copy, or production source edit is created. */
export const buildStreamingBenchmarkSnapshot = async (input: {
  readonly revision: string
  readonly output: string
  readonly exposeFixtureContext: boolean
  readonly actorHarnessPath?: string
}) => {
  const revision = git('rev-parse', '--verify', `${input.revision}^{commit}`).trim()
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Snapshot requires one exact committed Git revision')
  const output = resolve(input.output)
  if (output === repositoryRoot || output.startsWith(`${repositoryRoot}/`))
    throw new Error('Snapshot artifacts must be outside the shared Git checkout')
  const packageManifest = decodeDependencies(git('show', `${revision}:services/bayn/package.json`))
  const dependencyVersions = await Promise.all(
    Object.entries(packageManifest.dependencies).map(async ([name, selected]) => {
      const installed = decodeVersion(
        await readFile(resolve(repositoryRoot, 'services/bayn/node_modules', name, 'package.json'), 'utf8'),
      ).version
      if (installed !== selected)
        throw new Error(`Installed dependency ${name}@${installed} differs from snapshot ${selected}`)
      return { name, selected, installed }
    }),
  )
  await mkdir(output, { recursive: true })
  const paths = new Set(git('ls-tree', '-r', '--name-only', revision).trim().split('\n'))
  const sources = new Map<string, { originalHash: string; compiledHash: string; bytes: number }>()
  const blobs = new Map<string, string>()
  const read = (path: string) => {
    const cached = blobs.get(path)
    if (cached !== undefined) return cached
    const original = git('show', `${revision}:${path}`)
    let contents = original
    if (input.exposeFixtureContext && path === fixtureExposure.path) {
      if (original.split(fixtureExposure.before).length !== 2)
        throw new Error(`The approved benchmark context exposure is not unique at ${revision}:${path}`)
      contents = original.replace(fixtureExposure.before, fixtureExposure.after)
    }
    sources.set(path, {
      originalHash: sha256(original),
      compiledHash: sha256(contents),
      bytes: Buffer.byteLength(original),
    })
    blobs.set(path, contents)
    return contents
  }
  const present = Object.entries(modules).filter(([, path]) => paths.has(`services/bayn/${path}`))
  const omitted = Object.entries(modules)
    .filter(([, path]) => !paths.has(`services/bayn/${path}`))
    .map(([name]) => name)
  const entry = present.map(([name, path]) => `export * as ${name} from "snapshot:services/bayn/${path}";`).join('\n')
  const resolveSource = (specifier: string, importer: string) => {
    const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
    const found = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, `${base}/index.ts`].find((path) =>
      paths.has(path),
    )
    if (found === undefined) throw new Error(`Snapshot import is absent at ${revision}: ${importer} -> ${specifier}`)
    return found
  }
  const workerEntries = [
    'services/bayn/src/decision-construction-worker.ts',
    'services/bayn/src/market-data/streaming/market-projection-worker.ts',
  ].filter((path) => paths.has(path))
  const harnessPaths = new Map([
    [
      'services/bayn/tools/streaming-benchmark-financial.ts',
      resolve(repositoryRoot, 'services/bayn/tools/streaming-benchmark-financial.ts'),
    ],
    [
      'services/bayn/tools/streaming-benchmark-kafka.ts',
      resolve(repositoryRoot, 'services/bayn/tools/streaming-benchmark-kafka.ts'),
    ],
  ])
  if (input.actorHarnessPath !== undefined) {
    if (!input.exposeFixtureContext || !paths.has('services/bayn/src/jev/inference-work.ts'))
      throw new Error('The explicit actor harness requires instrumented streaming source with an inference work owner')
    harnessPaths.set('services/bayn/tools/streaming-benchmark-actor.ts', resolve(input.actorHarnessPath))
  }
  const harnesses = new Map(
    await Promise.all(
      [...harnessPaths].map(async ([path, readFrom]) => [path, await readFile(readFrom, 'utf8')] as const),
    ),
  )
  const result = await Bun.build({
    entrypoints: [
      'snapshot:benchmark/benchmark-api.ts',
      ...[...harnesses.keys()].map((path) => `snapshot:${path}`),
      ...workerEntries.map((path) => `snapshot:${path}`),
    ],
    target: 'node',
    outdir: output,
    naming: '[name].js',
    sourcemap: 'external',
    plugins: [
      {
        name: 'exact-git-snapshot',
        setup(build) {
          build.onResolve({ filter: /.*/ }, ({ path, importer, namespace }) => {
            if (path.startsWith('snapshot:')) return { path: path.slice('snapshot:'.length), namespace: 'git-object' }
            const origin = importer.replace(/^git-object:/, '').replace(`${repositoryRoot}/`, '')
            if (namespace !== 'git-object' && !paths.has(origin) && !harnesses.has(origin)) return undefined
            if (
              origin === 'services/bayn/tools/streaming-benchmark-kafka.ts' &&
              path === '../src/market-data/streaming/readiness' &&
              !paths.has('services/bayn/src/market-data/streaming/readiness.ts')
            )
              return { path: 'benchmark/no-market-hints.ts', namespace: 'git-object' }
            return path.startsWith('.')
              ? { path: resolveSource(path, origin), namespace: 'git-object' }
              : { path, external: true }
          })
          build.onLoad({ filter: /.*/, namespace: 'git-object' }, ({ path }) => {
            if (path === 'benchmark/benchmark-api.ts') return { contents: entry, loader: 'ts' }
            if (path === 'benchmark/no-market-hints.ts') return { contents: 'export {}', loader: 'ts' }
            const harness = harnesses.get(path)
            if (harness !== undefined) return { contents: harness, loader: 'ts' }
            const loader = extname(path) === '.json' ? 'json' : extname(path) === '.tsx' ? 'tsx' : 'ts'
            return { contents: read(path), loader }
          })
        },
      },
    ],
  })
  if (!result.success) throw new AggregateError(result.logs, `Exact Git snapshot ${revision} did not bundle`)
  const dependencies = await realpath(resolve(repositoryRoot, 'services/bayn/node_modules'))
  await symlink(dependencies, resolve(output, 'node_modules'), 'dir').catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EEXIST' || (await realpath(resolve(output, 'node_modules'))) !== dependencies) throw cause
  })
  await writeFile(resolve(output, 'package.json'), JSON.stringify({ type: 'module', private: true }))
  const manifest = {
    schemaVersion: 'bayn.streaming-benchmark-snapshot.v1',
    revision,
    productionBinary: false,
    source: 'exact Git objects, with installed dependencies separately pinned',
    instrumentation: input.exposeFixtureContext
      ? {
          ...fixtureExposure,
          sha256: sha256(JSON.stringify(fixtureExposure)),
          diff: `--- a/${fixtureExposure.path}\n+++ b/${fixtureExposure.path}\n@@ factory return @@\n+      __benchmarkDriver: driver,\n+      __benchmarkResources: resources,\n       authorityGenerationHash: activated.generationHash,\n`,
          purpose: 'Expose existing fixture driver/context only; no business branch is replaced',
        }
      : null,
    dependencies: dependencyVersions,
    harnesses: [...harnesses].map(([path, contents]) => ({
      path,
      readFrom: harnessPaths.get(path),
      sha256: sha256(contents),
      description:
        'Identical benchmark harness compiled against selected Git objects; excluded from original production source list',
    })),
    modules: present.map(([name, path]) => ({ name, path })),
    omitted,
    absentHistoricalCapabilities: paths.has('services/bayn/src/market-data/streaming/readiness.ts')
      ? []
      : [
          {
            module: 'market hints',
            harnessModule: 'benchmark/no-market-hints.ts',
            contents: 'export {}',
            purpose:
              'The historical source has no market-hint owner; the harness namespace guard omits that nonexistent callback. No production source changes.',
          },
        ],
    sources: [...sources]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, value]) => ({ path, ...value })),
    outputs: await Promise.all(
      result.outputs.map(async (artifact) => ({
        path: artifact.path,
        bytes: artifact.size,
        sha256: sha256(new Uint8Array(await artifact.arrayBuffer())),
      })),
    ),
  }
  await writeFile(resolve(output, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (import.meta.main) {
  const [revision, output, mode, actorHarnessPath] = process.argv.slice(2)
  if (revision === undefined || output === undefined || !['exact', 'expose-fixture'].includes(mode ?? ''))
    throw new Error(
      'Usage: bun tools/streaming-benchmark-snapshot.ts <exact-revision> <artifact-directory> <exact|expose-fixture>',
    )
  const manifest = await buildStreamingBenchmarkSnapshot({
    revision,
    output,
    exposeFixtureContext: mode === 'expose-fixture',
    ...(actorHarnessPath === undefined ? {} : { actorHarnessPath }),
  })
  process.stdout.write(
    JSON.stringify({
      revision: manifest.revision,
      files: manifest.sources.length,
      outputs: manifest.outputs.length,
      instrumentation: manifest.instrumentation !== null,
    }) + '\n',
  )
}
