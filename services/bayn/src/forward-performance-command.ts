import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { fileURLToPath } from 'node:url'
import { Cause, Data, Effect, Layer, Result, Schema, Stdio, Stream } from 'effect'

import { loadForwardPerformanceConfig } from './forward-performance/config'
import { PostgresClientLive } from './db/postgres-client'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformanceReport, ForwardPerformanceProgramError } from './forward-performance/program'
import { recordForwardPerformancePersistence } from './forward-performance/report'
import { Sha256Schema } from './schemas'
import { evaluateAndPersistForwardPerformanceReceipt } from './db/forward-performance-receipt'
import { WriterFenceLive } from './execution/writer-fence'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'
import { runForwardPerformanceWithinDeadline } from './forward-performance-deadline'

export const FORWARD_PERFORMANCE_COMMAND_USAGE =
  'Usage: bayn-forward-performance --authority-generation <sha256> [--assessment <sha256>] [--persist-receipt | --deadline-ms <milliseconds>] | --help'

export class ForwardPerformanceCommandArgumentError extends Data.TaggedError('ForwardPerformanceCommandArgumentError')<{
  readonly message: string
}> {}

type ForwardPerformanceCommand =
  | { readonly _tag: 'Help' }
  | {
      readonly _tag: 'Supervised'
      readonly deadlineMs: number
      readonly options: {
        readonly authorityGenerationHash: string
        readonly assessmentHash?: string
      }
    }
  | {
      readonly _tag: 'Run'
      readonly options: {
        readonly authorityGenerationHash: string
        readonly persistReceipt?: boolean
        readonly assessmentHash?: string
      }
    }

export const parseForwardPerformanceCommandArgs = (
  args: readonly string[],
): Result.Result<ForwardPerformanceCommand, ForwardPerformanceCommandArgumentError> => {
  if (args.includes('--deadline-ms')) {
    const rawDeadline = args.at(-1) ?? ''
    const deadlineMs = Number(rawDeadline)
    if (
      (args.length === 4 || args.length === 6) &&
      args.at(-2) === '--deadline-ms' &&
      /^[1-9][0-9]*$/.test(rawDeadline) &&
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs <= 2_147_483_647
    ) {
      const base = parseForwardPerformanceCommandArgs(args.slice(0, -2))
      if (Result.isSuccess(base) && base.success._tag === 'Run' && base.success.options.persistReceipt !== true)
        return Result.succeed({ _tag: 'Supervised', deadlineMs, options: base.success.options })
    }
    return Result.fail(new ForwardPerformanceCommandArgumentError({ message: FORWARD_PERFORMANCE_COMMAND_USAGE }))
  }
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })

  if (
    (args.length === 4 || (args.length === 5 && args[4] === '--persist-receipt')) &&
    args[0] === '--authority-generation' &&
    args[2] === '--assessment'
  ) {
    const generation = Schema.decodeUnknownResult(Sha256Schema)(args[1])
    const assessment = Schema.decodeUnknownResult(Sha256Schema)(args[3])
    if (Result.isSuccess(generation) && Result.isSuccess(assessment))
      return Result.succeed({
        _tag: 'Run',
        options: {
          authorityGenerationHash: generation.success,
          assessmentHash: assessment.success,
          ...(args.length === 5 ? { persistReceipt: true } : {}),
        },
      })
  }
  if (args.length === 2 && args[0] === '--authority-generation') {
    const generation = Schema.decodeUnknownResult(Sha256Schema)(args[1])
    if (Result.isSuccess(generation)) {
      return Result.succeed({ _tag: 'Run', options: { authorityGenerationHash: generation.success } })
    }
  }
  if (args.length === 3 && args[0] === '--authority-generation' && args[2] === '--persist-receipt') {
    const generation = Schema.decodeUnknownResult(Sha256Schema)(args[1])
    if (Result.isSuccess(generation)) {
      return Result.succeed({
        _tag: 'Run',
        options: { authorityGenerationHash: generation.success, persistReceipt: true },
      })
    }
  }
  return Result.fail(new ForwardPerformanceCommandArgumentError({ message: FORWARD_PERFORMANCE_COMMAND_USAGE }))
}

const printUsage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${FORWARD_PERFORMANCE_COMMAND_USAGE}\n`), stdio.stdout())
})

const runProof = (options: {
  readonly authorityGenerationHash: string
  readonly persistReceipt?: boolean
  readonly assessmentHash?: string
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadForwardPerformanceConfig()
      const report = yield* Effect.gen(function* () {
        if (options.persistReceipt === true) {
          return yield* evaluateAndPersistForwardPerformanceReceipt(options.authorityGenerationHash, (writerFence) =>
            runForwardPerformanceReport(config, undefined, { ...options, writerFence }),
          ).pipe(
            Effect.timeout(config.operationTimeoutMs),
            Effect.flatMap((persisted) => Effect.fromResult(recordForwardPerformancePersistence(persisted))),
          )
        }
        return yield* runForwardPerformanceReport(config, undefined, options)
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- command subprogram owns its scoped PostgreSQL layer
        Effect.provide(WriterFenceLive.pipe(Layer.provideMerge(PostgresClientLive(config)))),
      )
      const output = yield* Effect.fromResult(canonicalJsonV1Result(report)).pipe(
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
  if (command._tag === 'Help') return yield* printUsage
  if (command._tag === 'Supervised')
    return yield* runForwardPerformanceWithinDeadline(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        '--authority-generation',
        command.options.authorityGenerationHash,
        ...(command.options.assessmentHash === undefined ? [] : ['--assessment', command.options.assessmentHash]),
      ],
      command.deadlineMs,
    )
  return yield* runProof(command.options)
})
const deadlineRequested = process.argv.slice(2).includes('--deadline-ms')
const program = deadlineRequested
  ? main.pipe(
      // The supervisor never acquires report configuration or telemetry. Its worker retains the
      // existing runtime. Report failures only on stderr, including invalid deadline combinations.
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.flatMap(Stdio.Stdio, (stdio) => Stream.run(Stream.make(`${Cause.pretty(cause)}\n`), stdio.stderr())),
      ),
      // @effect-diagnostics-next-line strictEffectProvide:off -- supervisor entry point owns native process and filesystem services
      Effect.provide(NodeServices.layer),
    )
  : main.pipe(
      Effect.annotateLogs({ service: 'bayn-forward-performance' }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
      Effect.provide(runtime),
    )

if (import.meta.main) NodeRuntime.runMain(program, { disableErrorReporting: deadlineRequested })
