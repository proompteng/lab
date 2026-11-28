import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'
import { decodeResearchRun, hashResearch, ResearchError } from './research-inference/contract'
import { submitResearch } from './research-inference/submission'

export const researchCommandUsage =
  'Usage: bayn-research --validate <run.json> | --run <run.json> --output <new-receipt.json> | --help'
export const researchCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (value: string) => Stream.run(Stream.make(new TextEncoder().encode(`${value}\n`)), stdio.stdout())
    if (args.length === 1 && args[0] === '--help') return yield* print(researchCommandUsage)
    const path = args[1]
    if (
      path === undefined ||
      !(
        (args.length === 2 && args[0] === '--validate') ||
        (args.length === 4 && args[0] === '--run' && args[2] === '--output')
      )
    )
      return yield* new ResearchError({ message: researchCommandUsage })
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(path)
    if (info.size > 262144n) return yield* new ResearchError({ message: 'Research registration exceeds 256 KiB' })
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      yield* fs.readFileString(path),
    )
    const run = yield* Effect.fromResult(decodeResearchRun(input))
    if (run.schemaVersion !== 'bayn.jev-editor.v1')
      return yield* new ResearchError({
        message: 'Retired editor and factor inference cannot be submitted; use the current typed Jev editor contract',
      })
    const runId = yield* Effect.fromResult(hashResearch(run))
    if (args[0] === '--validate') return yield* print(JSON.stringify({ runId, qualification: 'UNQUALIFIED' }))
    const output = args[3]
    if (output === undefined) return yield* new ResearchError({ message: researchCommandUsage })
    const receipt = yield* submitResearch(
      run,
      yield* Config.NonEmptyString('RESTATE_INGRESS_ORIGIN'),
      yield* Config.Redacted('BAYN_RESEARCH_APPROVAL_KEY'),
    )
    yield* fs.writeFileString(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return yield* print(
      JSON.stringify({
        runId,
        outcome: receipt.outcome,
        receiptHash: receipt.receiptHash,
        costPicoUsd: receipt.costPicoUsd,
        qualification: receipt.qualification,
      }),
    )
  })
if (import.meta.main)
  NodeRuntime.runMain(
    researchCommand(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI entry point owns all platform resources
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, Logger.layer([Logger.consoleJson])),
      ),
    ),
  )
