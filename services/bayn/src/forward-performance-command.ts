import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Result, Schema, Stdio, Stream } from 'effect'

import { loadForwardPerformanceConfig } from './forward-performance/config'
import { PostgresClientLive } from './db/postgres-client'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformanceReport, ForwardPerformanceProgramError } from './forward-performance/program'
import { Sha256Schema, strictParseOptions } from './schemas'
import { evaluateAndPersistForwardPerformanceReceipt } from './db/forward-performance-receipt'
import { WriterFenceLive } from './execution/writer-fence'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'
import { readSystemEvidencePacket } from './system-assessment/files'
import {
  initializeQualificationHistory,
  registerSystemQualification,
  assessAndPersistSystem,
  readSystemRegistration,
} from './system-assessment/postgres'
import { captureSystemSourceCut } from './system-assessment/capture'
import { qualificationRuntime } from './system-assessment/configuration'
import { validateSystemRegistration } from './system-assessment/policy'
import { SystemAssessmentError } from './system-assessment/economics'
import { loadActiveStrategyProtocol } from './strategy'
import { canonicalHashV1Result } from './hash'
import { SystemAssessmentInputSchema } from './system-assessment/assessment'
import { verifyLatencyStressImages } from './system-assessment/latency-report'
import { CaptureReplayExecutionSchema, captureReplayExecution } from './system-assessment/replay-execution'
import { readSystemSourceCut } from './system-assessment/source-cut'

export const FORWARD_PERFORMANCE_COMMAND_USAGE =
  'Usage: bayn-forward-performance --authority-generation <sha256> [--assessment <sha256>] [--persist-receipt] | --system-history <packet.json> | --system-register <packet.json> | --system-capture <registration-sha256> | --system-capture-replay <packet.json> | --system-assess <packet.json> | --help'

export class ForwardPerformanceCommandArgumentError extends Data.TaggedError('ForwardPerformanceCommandArgumentError')<{
  readonly message: string
}> {}

type ForwardPerformanceCommand =
  | { readonly _tag: 'Help' }
  | {
      readonly _tag: 'SystemHistory' | 'SystemRegister' | 'SystemAssess' | 'SystemCaptureReplay'
      readonly path: string
    }
  | { readonly _tag: 'SystemCapture'; readonly registrationHash: string }
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
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })
  if (args.length === 2 && args[1] !== undefined && args[1].trim().length > 0) {
    if (args[0] === '--system-history') return Result.succeed({ _tag: 'SystemHistory', path: args[1] })
    if (args[0] === '--system-register') return Result.succeed({ _tag: 'SystemRegister', path: args[1] })
    if (args[0] === '--system-assess') return Result.succeed({ _tag: 'SystemAssess', path: args[1] })
    if (args[0] === '--system-capture-replay') return Result.succeed({ _tag: 'SystemCaptureReplay', path: args[1] })
    const registration = Schema.decodeUnknownResult(Sha256Schema)(args[1])
    if (args[0] === '--system-capture' && Result.isSuccess(registration))
      return Result.succeed({ _tag: 'SystemCapture', registrationHash: registration.success })
  }
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
          ).pipe(Effect.timeout(config.operationTimeoutMs))
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

const runSystem = (command: Exclude<ForwardPerformanceCommand, { readonly _tag: 'Help' | 'Run' }>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* loadForwardPerformanceConfig()
      const result = yield* Effect.gen(function* () {
        if (command._tag === 'SystemCapture') return yield* captureSystemSourceCut(config, command.registrationHash)
        const packet = yield* readSystemEvidencePacket(command.path)
        if (command._tag === 'SystemCaptureReplay') {
          const request = yield* Schema.decodeUnknownEffect(
            CaptureReplayExecutionSchema,
            strictParseOptions,
          )(packet.payload)
          return yield* captureReplayExecution(
            request,
            yield* readSystemRegistration(request.registrationHash),
            yield* readSystemSourceCut(request.sourceCutHash),
          )
        }
        if (command._tag === 'SystemHistory')
          return yield* initializeQualificationHistory(packet.payload, packet.verifiedSources)
        if (command._tag === 'SystemRegister') {
          const { registration } = yield* Effect.fromResult(validateSystemRegistration(packet.payload))
          const runtime = qualificationRuntime(config, yield* Effect.fromResult(loadActiveStrategyProtocol()))
          if (
            (yield* Effect.fromResult(canonicalHashV1Result(runtime))) !==
            registration.obligations.runtimeConfigurationHash
          )
            return yield* new SystemAssessmentError({
              message: 'Prospective registration must use the configured runtime deadlines and strategy protocol',
            })
          return yield* registerSystemQualification(registration, packet.verifiedSources)
        }
        const input = yield* Schema.decodeUnknownEffect(SystemAssessmentInputSchema, strictParseOptions)(packet.payload)
        yield* readSystemRegistration(yield* Effect.fromResult(canonicalHashV1Result(input.registration)))
        const images = yield* verifyLatencyStressImages(
          input.latencyStressSources,
          input.registration,
          packet.artifacts,
        )
        return yield* assessAndPersistSystem(input, packet.verifiedSources, packet.artifacts, images)
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- command owns the scoped database layer
        Effect.provide(PostgresClientLive(config)),
      )
      const output = yield* Effect.fromResult(canonicalJsonV1Result(result))
      const stdio = yield* Stdio.Stdio
      yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
    }),
  )

const runtime = Layer.mergeAll(makeConfiguredTelemetryRuntimeLayer('bayn-forward-performance'), NodeServices.layer)
const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseForwardPerformanceCommandArgs(process.argv.slice(2)))
  if (command._tag === 'Help') return yield* printUsage
  if (command._tag === 'Run') return yield* runProof(command.options)
  return yield* runSystem(command)
})
// @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-forward-performance' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
