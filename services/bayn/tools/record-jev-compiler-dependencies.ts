import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { compilerDependencyBytes } from './jev-compiler-dependencies'

const [outputFlag, output, sourceFlag, sourceRevision, ...args] = process.argv.slice(2)
if (
  outputFlag !== '--output' ||
  output === undefined ||
  sourceFlag !== '--source' ||
  sourceRevision === undefined ||
  !/^[a-f0-9]{40}$/.test(sourceRevision) ||
  Bun.version !== '1.4.2'
)
  throw Error('Use pinned Bun: --output <backtest.js> --source <revision> [--define name=value]')
const define: Record<string, string> = {}
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1],
    separator = value?.indexOf('=') ?? -1
  if (args[i] !== '--define' || value === undefined || separator < 1) throw Error('Invalid build definition')
  define[value.slice(0, separator)] = value.slice(separator + 1)
}
const dependencies = compilerDependencyBytes(null)
const result = await Bun.build({
  entrypoints: [resolve('services/bayn/src/backtest-command.ts')],
  target: 'node',
  external: ['tigerbeetle-node', '@platformatic/kafka'],
  define,
  plugins: [dependencies.plugin],
})
if (!result.success || result.outputs.length !== 1 || result.outputs[0] === undefined)
  throw Error(JSON.stringify(result.logs))
await writeFile(output, new Uint8Array(await result.outputs[0].arrayBuffer()))
const controlDependencies = compilerDependencyBytes(null)
const controls = await Bun.build({
  entrypoints: [resolve('services/bayn/src/control-study-command.ts')],
  target: 'node',
  external: ['tigerbeetle-node', '@platformatic/kafka'],
  define,
  plugins: [controlDependencies.plugin],
})
if (!controls.success || controls.outputs.length !== 1 || controls.outputs[0] === undefined)
  throw Error(JSON.stringify(controls.logs))
await writeFile(
  join(dirname(output), 'control-study-command.js'),
  new Uint8Array(await controls.outputs[0].arrayBuffer()),
)
const compilerDependencies = compilerDependencyBytes(null)
const compiler = await Bun.build({
  entrypoints: [resolve('services/bayn/tools/jev-instruction-variant.ts')],
  target: 'bun',
  plugins: [compilerDependencies.plugin],
  define: { __BAYN_VARIANT_SOURCE_ROOT__: JSON.stringify(process.cwd()) },
})
if (!compiler.success || compiler.outputs.length !== 1) throw Error(JSON.stringify(compiler.logs))
await writeFile(
  join(dirname(output), 'jev-compiler-dependencies.json'),
  JSON.stringify({
    schemaVersion: 'bayn.jev-compiler-dependencies.v2',
    sourceRevision,
    bunVersion: '1.4.2',
    files: dependencies.files(),
    controlFiles: controlDependencies.files(),
    compilerFiles: compilerDependencies.files(),
  }),
)
