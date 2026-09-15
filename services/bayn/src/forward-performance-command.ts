import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Result, Schema, Stdio, Stream } from 'effect'

import { loadConfig } from './config'
import { PostgresClientLive } from './db/postgres-client'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformance, ForwardPerformanceProgramError } from './forward-performance'
import { Sha256Schema } from './schemas'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'

export { runForwardPerformance } from './forward-performance'

export const FORWARD_PERFORMANCE_COMMAND_USAGE =
  'Usage: bayn-forward-performance [--authority-generation <sha256>] | --help'

export class ForwardPerformanceCommandArgumentError extends Data.TaggedError('ForwardPerformanceCommandArgumentError')<{
  readonly message: string
}> {}

type ForwardPerformanceCommand =
  | { readonly _tag: 'Help' }
  | { readonly _tag: 'Run'; readonly options: { readonly authorityGenerationHash?: string } }

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
  return Result.fail(new ForwardPerformanceCommandArgumentError({ message: FORWARD_PERFORMANCE_COMMAND_USAGE }))
}

const printUsage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${FORWARD_PERFORMANCE_COMMAND_USAGE}\n`), stdio.stdout())
})

const runProof = (options: { readonly authorityGenerationHash?: string }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadConfig()
      const receipt = yield* runForwardPerformance(config, undefined, options).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- command subprogram owns its scoped PostgreSQL layer
        Effect.provide(PostgresClientLive(config)),
      )
      const output = yield* Effect.fromResult(canonicalJsonV1Result(receipt)).pipe(
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
  return yield* command._tag === 'Help' ? printUsage : runProof(command.options)
})
// @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-forward-performance' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
