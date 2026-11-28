import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { frozenControlOrigin, frozenDeployedControlIdentity } from '../src/system-assessment/frozen-control-identity'
import { compilerDependencyBytes } from './jev-compiler-dependencies'
import { frozenControlSource, readFrozenControlDirectory } from './frozen-control-source'
import {
  frozenLatencyHooks,
  frozenLatencyHooksPath,
  instrumentFrozenControlModule,
} from './frozen-control-instrumentation'

const repository = resolve(import.meta.dir, '../../..')

export const compileFrozenControl = async (options: {
  source: { paths: ReadonlySet<string>; read: (path: string) => Uint8Array }
  dependenciesDirectory: string
  sourceRevision: string
  imageRepository: string
  output: string
}) => {
  if (Bun.version !== '1.4.2' || !/^[a-f0-9]{40}$/.test(options.sourceRevision))
    throw Error('Frozen replay compilation requires pinned Bun and the carrier revision')
  const source = frozenControlSource({
    dependenciesDirectory: options.dependenciesDirectory,
    paths: new Set([...options.source.paths, frozenLatencyHooksPath]),
    read: (path) =>
      new TextEncoder().encode(
        path === frozenLatencyHooksPath
          ? frozenLatencyHooks
          : instrumentFrozenControlModule(path, new TextDecoder().decode(options.source.read(path))),
      ),
  })
  const dependencies = compilerDependencyBytes(null)
  const boundary: Bun.BunPlugin = {
    name: 'bayn-current-frozen-boundary',
    setup(build) {
      build.onResolve({ filter: /^\/bayn-current-frozen-boundary$/ }, () => ({
        path: resolve(repository, 'services/bayn/src/system-assessment/frozen-control-boundary.ts'),
      }))
    },
  }
  const result = await Bun.build({
    root: repository,
    entrypoints: [source.entrypoint('services/bayn/src/backtest-command.ts')],
    target: 'node',
    // Keep build-store dependency paths out of the runtime closure; the receipt retains their consumed bytes.
    minify: true,
    plugins: [boundary, source.plugin, dependencies.plugin],
    define: {
      __BAYN_BUILD_SOURCE_REVISION__: JSON.stringify(options.sourceRevision),
      __BAYN_BUILD_IMAGE_REPOSITORY__: JSON.stringify(options.imageRepository),
      __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: JSON.stringify(frozenDeployedControlIdentity.strategyHash),
      __BAYN_BUILD_STRATEGY_PARAMETER_HASH__: JSON.stringify(frozenDeployedControlIdentity.parametersHash),
      __BAYN_BUILD_STRATEGY_NAME__: JSON.stringify(frozenControlOrigin.strategyName),
      __BAYN_BUILD_STRATEGY_PROTOCOL_HASH__: JSON.stringify(frozenDeployedControlIdentity.protocolHash),
      __BAYN_BUILD_EXECUTION_RISK_POLICY_HASH__: JSON.stringify(
        '2e60270036900493a121a87c73730960154278778a8aa71b663b138effd82227',
      ),
    },
  })
  const output = result.outputs[0]
  if (!result.success || result.outputs.length !== 1 || output === undefined) throw Error(JSON.stringify(result.logs))
  source.verify()
  dependencies.verify()
  const bytes = new Uint8Array(await output.arrayBuffer())
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const receipt = {
    schemaVersion: 'bayn.frozen-control-compiler.v1',
    sourceRevision: options.sourceRevision,
    origin: frozenControlOrigin,
    strategy: frozenDeployedControlIdentity,
    bunVersion: Bun.version,
    executableSha256: hash(bytes),
    adapterSha256: hash(readFileSync(resolve(repository, 'services/bayn/tools/frozen-control-instrumentation.ts'))),
    files: source.files(),
    dependencies: dependencies.files(),
  }
  await writeFile(options.output, bytes)
  await writeFile(join(dirname(options.output), 'frozen-control-compiler.json'), JSON.stringify(receipt) + '\n')
  return receipt
}

if (import.meta.main) {
  const [sourceFlag, source, dependenciesFlag, dependencies, revisionFlag, revision, outputFlag, output] =
    process.argv.slice(2)
  if (
    process.argv.length !== 10 ||
    sourceFlag !== '--frozen-source' ||
    source === undefined ||
    dependenciesFlag !== '--dependencies' ||
    dependencies === undefined ||
    revisionFlag !== '--revision' ||
    revision === undefined ||
    outputFlag !== '--output' ||
    output === undefined
  )
    throw Error(
      'Usage: --frozen-source <immutable-original-service> --dependencies <original-service-dependencies> --revision <carrier-revision> --output <command.js>',
    )
  await compileFrozenControl({
    source: readFrozenControlDirectory(source),
    dependenciesDirectory: dependencies,
    sourceRevision: revision,
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    output,
  })
}
