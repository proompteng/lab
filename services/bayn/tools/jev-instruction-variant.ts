declare const __BAYN_VARIANT_SOURCE_ROOT__: string

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem, Path, Schema, Stdio, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { canonicalHashV1Result, sha256 } from '../src/hash'
import { JevInstructionsSchema } from '../src/jev/instructions-contract'
import { jevInstructions } from '../src/jev/instructions'
import { defaultJevProtocolDocument, jevBehaviorHash } from '../src/jev/protocol'
import { strictParseOptions } from '../src/schemas'
import {
  JevCompilerDependencyReceiptSchema,
  JevInstructionVariantBuildSchema,
  JevInstructionVariantSpecSchema,
} from '../src/jev/instruction-variant'
import { compilerDependencyBytes } from './jev-compiler-dependencies'

class VariantBuildError extends Data.TaggedError('VariantBuildError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** One data module is replaced before bundling; every native builder and verifier imports that same module. */
export const jevInstructionsBuildPlugin = (modulePath: string, instructions: typeof JevInstructionsSchema.Type) => {
  let replacements = 0
  const plugin: Bun.BunPlugin = {
    name: 'bayn-jev-frozen-instructions',
    setup: (build) => {
      build.onLoad({ filter: /[/\\]jev[/\\]instructions\.ts$/ }, (file) => {
        if (file.path !== modulePath) return undefined
        replacements++
        return { contents: `export const jevInstructions = ${JSON.stringify(instructions)};\n`, loader: 'ts' }
      })
    },
  }
  return { plugin, replacements: () => replacements }
}

const gitRead = (root: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make('git', args, { cwd: root, stdin: 'ignore', stderr: 'ignore' }))
    const [output, status] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: 'unbounded' },
    )
    if (Number(status) !== 0)
      return yield* new VariantBuildError({ message: 'Cannot verify the variant source checkout' })
    return output.trim()
  })
const verifySource = (root: string, expected: string) =>
  Effect.gen(function* () {
    if ((yield* gitRead(root, ['rev-parse', 'HEAD'])) !== expected)
      return yield* new VariantBuildError({ message: 'Variant source revision differs from the checked-out commit' })
    if (
      (yield* gitRead(root, [
        'status',
        '--porcelain',
        '--untracked-files=normal',
        '--',
        'services/bayn',
        'docs/bayn/jev-migration-acceptance-v2.json',
        '.npmrc',
        'bunfig.toml',
        'tsconfig.base.json',
        'bun.lock',
        'package.json',
        'patches',
      ])) !== ''
    )
      return yield* new VariantBuildError({
        message: 'Commit consumed source changes before building a frozen variant',
      })
  })

export const buildJevInstructionVariant = (
  input: unknown,
  root: string,
  outputDirectory: string,
  dependencyReceiptRaw: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spec = yield* Schema.decodeUnknownEffect(JevInstructionVariantSpecSchema, strictParseOptions)(input)
      if (Bun.version !== '1.4.2')
        return yield* new VariantBuildError({ message: 'Variant builds require the pinned Bun 1.4.2 toolchain' })
      yield* verifySource(root, spec.sourceRevision)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      if (sha256(dependencyReceiptRaw) !== spec.dependencyReceiptSha256)
        return yield* new VariantBuildError({ message: 'Compiler dependency receipt file hash differs' })
      const dependencyReceipt = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(JevCompilerDependencyReceiptSchema),
        strictParseOptions,
      )(dependencyReceiptRaw)
      if (dependencyReceipt.sourceRevision !== spec.sourceRevision || Object.keys(dependencyReceipt.files).length === 0)
        return yield* new VariantBuildError({
          message: 'Compiler dependencies must come from the exact pinned source image',
        })
      const dependencies = compilerDependencyBytes(
        spec.evaluation === 'portfolio' ? dependencyReceipt.files : dependencyReceipt.controlFiles,
      )
      const instructions = jevInstructionsBuildPlugin(
        path.join(root, 'services/bayn/src/jev/instructions.ts'),
        spec.instructions,
      )
      const parameterHash = yield* Effect.fromResult(canonicalHashV1Result(defaultJevProtocolDocument))
      yield* fs.makeDirectory(outputDirectory, { mode: 0o700 })
      // Bun's build API has no cancellation handle. Await its bounded local build before allowing interruption.
      const result = yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: () =>
            Bun.build({
              entrypoints: [
                path.join(
                  root,
                  'services/bayn/src',
                  spec.evaluation === 'portfolio' ? 'backtest-command.ts' : 'control-study-command.ts',
                ),
              ],
              target: 'node',
              external: ['tigerbeetle-node', '@platformatic/kafka'],
              plugins: [instructions.plugin, dependencies.plugin],
              define: {
                __BAYN_BUILD_SOURCE_REVISION__: JSON.stringify(spec.sourceRevision),
                __BAYN_BUILD_IMAGE_REPOSITORY__: JSON.stringify(spec.imageRepository),
                __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: JSON.stringify(jevBehaviorHash),
                __BAYN_BUILD_STRATEGY_PARAMETER_HASH__: JSON.stringify(parameterHash),
              },
            }),
          catch: (cause) => new VariantBuildError({ message: 'Native variant compilation failed', cause }),
        }),
      )
      if (!result.success || result.outputs.length !== 1 || instructions.replacements() !== 1)
        return yield* new VariantBuildError({
          message: 'Variant must compile one native executable and replace one instruction document',
          cause: result.logs,
        })
      yield* Effect.try({
        try: dependencies.verify,
        catch: (cause) =>
          new VariantBuildError({ message: 'Compiler dependency closure differs from the pinned image', cause }),
      })
      yield* verifySource(root, spec.sourceRevision)
      const output = result.outputs[0]
      if (output === undefined) return yield* new VariantBuildError({ message: 'Native variant executable is missing' })
      const bytes = new Uint8Array(
        yield* Effect.tryPromise({
          try: () => output.arrayBuffer(),
          catch: (cause) => new VariantBuildError({ message: 'Cannot read native variant bytes', cause }),
        }),
      )
      yield* fs.writeFile(path.join(outputDirectory, 'evaluation.js'), bytes, { flag: 'wx', mode: 0o600 })
      const material = {
        schemaVersion: 'bayn.jev-instruction-variant-build.v1',
        spec,
        baselineInstructionsHash: yield* Effect.fromResult(canonicalHashV1Result(jevInstructions)),
        instructionsHash: yield* Effect.fromResult(canonicalHashV1Result(spec.instructions)),
        strategyBehaviorHash: jevBehaviorHash,
        strategyParameterHash: parameterHash,
        executableSha256: sha256(bytes),
        bunVersion: Bun.version,
        replacedSourceModule: 'services/bayn/src/jev/instructions.ts',
        sourceVerification: 'CLEAN_COMMITTED_BUILD_INPUTS',
        dependencyVerification: 'PINNED_IMAGE_INPUT_BYTES',
        baseImageVerification: 'REQUIRES_RUNTIME_READBACK',
        qualification: 'UNQUALIFIED',
      }
      const receipt = { ...material, receiptHash: yield* Effect.fromResult(canonicalHashV1Result(material)) }
      yield* Schema.decodeUnknownEffect(JevInstructionVariantBuildSchema, strictParseOptions)(receipt)
      yield* fs.writeFileString(path.join(outputDirectory, 'build.json'), JSON.stringify(receipt), {
        flag: 'wx',
        mode: 0o600,
      })
      return receipt
    }),
  )

export const runVariantCompiler = () =>
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const args = process.argv.slice(2)
      const specPath = args[1],
        dependencyPath = args[3],
        outputPath = args[5]
      if (
        args.length !== 6 ||
        args[0] !== '--spec' ||
        args[2] !== '--dependencies' ||
        args[4] !== '--output' ||
        specPath === undefined ||
        dependencyPath === undefined ||
        outputPath === undefined
      )
        return yield* new VariantBuildError({
          message:
            'Usage: bun tools/build-jev-instruction-variant.ts --spec <variant.json> --dependencies <image-receipt.json> --output <new-directory>',
        })
      const fs = yield* FileSystem.FileSystem
      if ((yield* fs.stat(specPath)).size > 65536n)
        return yield* new VariantBuildError({ message: 'Variant specification exceeds 64 KiB' })
      const spec = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* fs.readFileString(specPath),
      )
      if ((yield* fs.stat(dependencyPath)).size > 8n * 1024n * 1024n)
        return yield* new VariantBuildError({ message: 'Compiler dependency receipt exceeds 8 MiB' })
      const dependencyRaw = yield* fs.readFileString(dependencyPath)
      const path = yield* Path.Path
      const receipt = yield* buildJevInstructionVariant(
        spec,
        __BAYN_VARIANT_SOURCE_ROOT__,
        path.resolve(outputPath),
        dependencyRaw,
      )
      const stdio = yield* Stdio.Stdio
      yield* Stream.run(Stream.make(JSON.stringify(receipt) + '\n'), stdio.stdout())
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- compiler command owns files and child processes
      Effect.provide(NodeServices.layer),
    ),
  )
