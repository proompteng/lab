import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'

import { embeddedBuildMetadata } from './build'
import { sha256 } from './hash'
import { JevContractError } from './jev/contract'
import { jevInstructions } from './jev/instructions'
import { JevInstructionsSchema } from './jev/instructions-contract'
import { JevInstructionVariantBuildSchema } from './jev/instruction-variant'
import {
  compareJevEconomics,
  jevBacktestOutcome,
  JevEconomicComparisonManifestSchema,
} from './jev/experiment-economics'
import { Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from './schemas'

export const jevEvaluationCommandUsage =
  'Usage: bayn-jev-evaluate --baseline | --outcome <native-artifact.json> --output <new-outcome.json> | --compare <economic-manifest.json> --output <new-comparison.json> | --help'

export const jevEvaluationCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (value: unknown) =>
      Stream.run(
        Stream.make(new TextEncoder().encode(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)),
        stdio.stdout(),
      )
    if (args.length === 1 && args[0] === '--help') return yield* print(jevEvaluationCommandUsage)
    if (args.length === 1 && args[0] === '--baseline') return yield* print(jevInstructions)
    if (args.length === 4 && args[0] === '--outcome' && args[2] === '--output') {
      const manifestPath = args[1]
      const outputPath = args[3]
      if (manifestPath === undefined || outputPath === undefined)
        return yield* new JevContractError({ message: jevEvaluationCommandUsage })
      const fs = yield* FileSystem.FileSystem
      if ((yield* fs.stat(manifestPath)).size > 128n * 1024n)
        return yield* new JevContractError({ message: 'Native outcome manifest exceeds 128 KiB' })
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            reportPath: StrictNonEmptyStringSchema,
            reportSha256: Sha256Schema,
            instructions: Schema.Unknown,
            operatingAllocations: Schema.Unknown,
            variantBuild: JevInstructionVariantBuildSchema,
          }),
        ),
        strictParseOptions,
      )(yield* fs.readFileString(manifestPath))
      if (
        embeddedBuildMetadata !== undefined &&
        manifest.variantBuild.spec.sourceRevision !== embeddedBuildMetadata.sourceRevision
      )
        return yield* new JevContractError({ message: 'Native outcome source differs from the installed evaluator' })
      if ((yield* fs.stat(manifest.reportPath)).size > 512n * 1024n * 1024n)
        return yield* new JevContractError({ message: 'Native outcome report exceeds 512 MiB' })
      const raw = yield* fs.readFileString(manifest.reportPath)
      if (sha256(raw) !== manifest.reportSha256)
        return yield* new JevContractError({ message: 'Native outcome report bytes differ' })
      const instructions = yield* Schema.decodeUnknownEffect(
        JevInstructionsSchema,
        strictParseOptions,
      )(manifest.instructions)
      const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(raw)
      const outcome = yield* Effect.fromResult(jevBacktestOutcome({ ...manifest, report, instructions }))
      yield* fs.writeFileString(outputPath, JSON.stringify(outcome), { flag: 'wx', mode: 0o600 })
      return yield* print(outcome)
    }
    if (args.length === 4 && args[0] === '--compare' && args[2] === '--output') {
      const manifestPath = args[1]
      const outputPath = args[3]
      if (manifestPath === undefined || outputPath === undefined)
        return yield* new JevContractError({ message: jevEvaluationCommandUsage })
      const fs = yield* FileSystem.FileSystem
      const readBounded = (file: string, maximumBytes: number) =>
        Effect.gen(function* () {
          if ((yield* fs.stat(file)).size > BigInt(maximumBytes))
            return yield* new JevContractError({ message: 'Economic comparison input exceeds its byte limit' })
          const raw = yield* fs.readFileString(file)
          if (new TextEncoder().encode(raw).length > maximumBytes)
            return yield* new JevContractError({ message: 'Economic comparison input exceeds its byte limit' })
          return raw
        })
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(JevEconomicComparisonManifestSchema),
        strictParseOptions,
      )(yield* readBounded(manifestPath, 64 * 1024))
      if (
        embeddedBuildMetadata !== undefined &&
        manifest.registration.evaluatorSourceRevision !== embeddedBuildMetadata.sourceRevision
      )
        return yield* new JevContractError({ message: 'Economic evaluator source differs from its installed image' })
      const readArm = (
        artifact: typeof manifest.baseline,
        instructions: typeof manifest.registration.baseline,
        variantBuild: unknown,
      ) =>
        Effect.gen(function* () {
          const raw = yield* readBounded(artifact.reportPath, 512 * 1024 * 1024)
          if (sha256(raw) !== artifact.reportSha256)
            return yield* new JevContractError({ message: 'Native report file differs from the manifest digest' })
          return yield* Effect.fromResult(
            jevBacktestOutcome({
              report: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(raw),
              instructions,
              operatingAllocations: artifact.operatingAllocations,
              variantBuild,
            }),
          )
        })
      const buildRaw = yield* readBounded(manifest.candidate.buildReceipt.path, 64 * 1024)
      if (sha256(buildRaw) !== manifest.candidate.buildReceipt.sha256)
        return yield* new JevContractError({ message: 'Candidate compiler file differs from the manifest digest' })
      const variantBuild = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(buildRaw)
      const baseline = yield* readArm(manifest.baseline, manifest.registration.baseline, null)
      const baselineRepeat = yield* readArm(manifest.baselineRepeat, manifest.registration.baseline, null)
      const candidate = yield* readArm(manifest.candidate, manifest.registration.candidate, variantBuild)
      const comparison = yield* Effect.fromResult(
        compareJevEconomics(manifest.registration, { baseline, baselineRepeat, candidate }),
      )
      yield* fs.writeFileString(outputPath, JSON.stringify(comparison), { flag: 'wx', mode: 0o600 })
      return yield* print({
        comparisonHash: comparison.comparisonHash,
        observedNetEffect: comparison.observedNetEffect,
        economicImprovement: comparison.economicImprovement,
      })
    }
    return yield* new JevContractError({ message: jevEvaluationCommandUsage })
  })

if (import.meta.main)
  NodeRuntime.runMain(
    jevEvaluationCommand(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI entry point owns files and logging
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
  )
