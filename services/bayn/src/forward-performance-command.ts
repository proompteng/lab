import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Result, Schema, Stdio, Stream } from 'effect'

import { loadConfig } from './config'
import { PostgresClientLive } from './db/postgres-client'
import { makeForwardPerformanceWindow, ForwardPerformanceWindowError } from './db/forward-performance-window'
import { publishForwardPerformanceWindow } from './db/forward-performance-window-postgres'
import { WriterFenceLive } from './execution/writer-fence'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformance, ForwardPerformanceProgramError } from './forward-performance'
import { Sha256Schema } from './schemas'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'

export { runForwardPerformance } from './forward-performance'

export const FORWARD_PERFORMANCE_COMMAND_USAGE =
  'Usage: bayn-forward-performance [--authority-generation <sha256> [--publish-window]] | --help'

export class ForwardPerformanceCommandArgumentError extends Data.TaggedError('ForwardPerformanceCommandArgumentError')<{
  readonly message: string
}> {}

type ForwardPerformanceCommand =
  | { readonly _tag: 'Help' }
  | { readonly _tag: 'Run'; readonly options: { readonly authorityGenerationHash?: string } }
  | { readonly _tag: 'PublishWindow'; readonly options: { readonly authorityGenerationHash: string } }

export const parseForwardPerformanceCommandArgs = (
  args: readonly string[],
): Result.Result<ForwardPerformanceCommand, ForwardPerformanceCommandArgumentError> => {
  if (args.length === 0) return Result.succeed({ _tag: 'Run', options: {} })
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })
  if (args.length === 2 && args[0] === '--authority-generation') {
    const generation = Schema.decodeUnknownResult(Sha256Schema)(args[1])
    if (Result.isSuccess(generation)) {
      return Result.succeed({ _tag: 'Run', options: { authorityGenerationHash: generation.success } })
    }
  }
  if (
    args.length === 3 &&
    ((args[0] === '--authority-generation' && args[2] === '--publish-window') ||
      (args[0] === '--publish-window' && args[1] === '--authority-generation'))
  ) {
    const generation = Schema.decodeUnknownResult(Sha256Schema)(args[0] === '--publish-window' ? args[2] : args[1])
    if (Result.isSuccess(generation))
      return Result.succeed({ _tag: 'PublishWindow', options: { authorityGenerationHash: generation.success } })
  }
  return Result.fail(new ForwardPerformanceCommandArgumentError({ message: FORWARD_PERFORMANCE_COMMAND_USAGE }))
}

const printUsage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${FORWARD_PERFORMANCE_COMMAND_USAGE}\n`), stdio.stdout())
})

const runProof = (command: Exclude<ForwardPerformanceCommand, { readonly _tag: 'Help' }>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadConfig()
      const document = yield* Effect.gen(function* () {
        const receipt = yield* runForwardPerformance(config, undefined, command.options)
        if (command._tag === 'Run') return receipt
        const identity = config.execution.brokerIdentity
        if (identity === undefined)
          return yield* new ForwardPerformanceWindowError({
            operation: 'publish',
            failure: 'binding',
            message: 'performance publication requires the configured broker account',
          })
        const window = yield* Effect.fromResult(
          makeForwardPerformanceWindow(command.options.authorityGenerationHash, receipt),
        )
        return yield* publishForwardPerformanceWindow(identity.accountId, window)
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- command owns its scoped persistence capabilities
        Effect.provide(WriterFenceLive.pipe(Layer.provideMerge(PostgresClientLive(config)))),
      )
      const output = yield* Effect.fromResult(canonicalJsonV1Result(document)).pipe(
        Effect.mapError(
          (cause) =>
            new ForwardPerformanceProgramError({
              operation: 'construct-receipt',
              message: `forward-performance output encoding failed: ${renderCanonicalJsonFailure(cause)}`,
              cause,
            }),
        ),
      )
      const stdio = yield* Stdio.Stdio
      yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
    }),
  ).pipe(withObservedSpan('bayn.forward-performance.prove'))

const runtime = Layer.mergeAll(makeConfiguredTelemetryRuntimeLayer('bayn-forward-performance'), NodeServices.layer)
const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseForwardPerformanceCommandArgs(process.argv.slice(2)))
  return yield* command._tag === 'Help' ? printUsage : runProof(command)
})
// @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-forward-performance' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
