import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Result, Schema, Stdio, Stream } from 'effect'

import { readRegisteredFinancialIdentity } from './system-assessment/capital-identity'
import { embeddedBuildMetadata } from './build'
import { JevResearchPolicy } from './jev/acceptance'
import { loadForwardPerformanceConfig } from './forward-performance/config'
import { decodeConfiguredCapitalActivation } from './composition/capital-activation'
import { PostgresClientLive } from './db/postgres-client'
import { canonicalHashV1Result, canonicalJsonV1Result } from './hash'
import { Sha256Schema, strictParseOptions } from './schemas'
import { makeConfiguredTelemetryRuntimeLayer } from './telemetry'
import { readSystemEvidencePacket } from './system-assessment/files'
import {
  initializeQualificationHistory,
  registerSystemQualification,
  assessAndPersistSystem,
  readSystemRegistration,
  registerOperationalPeriod,
  assessAndPersistOperational,
} from './system-assessment/postgres'
import { OperationalRegistrationSchema, validateOperationalRegistration } from './system-assessment/operational-period'
import { OperationalAssessmentInputSchema } from './system-assessment/operational-assessment'
import { captureSystemSourceCut } from './system-assessment/capture'
import { ValkeyCacheLive } from './valkey-cache'
import { qualificationRuntime } from './system-assessment/configuration'
import { validateSystemRegistration } from './system-assessment/policy'
import { SystemAssessmentError } from './system-assessment/economics'
import { loadActiveStrategyProtocol } from './strategy'
import { SystemAssessmentInputSchema } from './system-assessment/assessment'
import { verifyLatencyStressImages } from './system-assessment/latency-report'
import { CaptureReplayExecutionSchema, captureReplayExecution } from './system-assessment/replay-execution'
import { readSystemSourceCut } from './system-assessment/source-cut'

export const SYSTEM_ASSESSMENT_COMMAND_USAGE =
  'Usage: bayn-system-assessment --system-history <packet.json> | --system-register <packet.json> | --system-capture <registration-sha256> | --system-capture-replay <packet.json> | --system-assess <packet.json> | --help'

export class SystemAssessmentCommandArgumentError extends Data.TaggedError('SystemAssessmentCommandArgumentError')<{
  readonly message: string
}> {}

type SystemAssessmentCommand =
  | { readonly _tag: 'Help' }
  | {
      readonly _tag: 'SystemHistory' | 'SystemRegister' | 'SystemAssess' | 'SystemCaptureReplay'
      readonly path: string
    }
  | { readonly _tag: 'SystemCapture'; readonly registrationHash: string }

export const parseSystemAssessmentCommandArgs = (
  args: readonly string[],
): Result.Result<SystemAssessmentCommand, SystemAssessmentCommandArgumentError> => {
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
  return Result.fail(new SystemAssessmentCommandArgumentError({ message: SYSTEM_ASSESSMENT_COMMAND_USAGE }))
}

const runSystem = (command: Exclude<SystemAssessmentCommand, { readonly _tag: 'Help' }>) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Assess the trading member of this source-bound image cohort. The research image cannot be activated.
      const tradingBuild =
        embeddedBuildMetadata === undefined
          ? undefined
          : {
              ...embeddedBuildMetadata,
              imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
            }
      const config = yield* loadForwardPerformanceConfig(tradingBuild)
      const result = yield* Effect.gen(function* () {
        if (command._tag === 'SystemCapture')
          return yield* captureSystemSourceCut(config, command.registrationHash).pipe(
            // @effect-diagnostics-next-line strictEffectProvide:off -- private capture owns its scoped cache reader
            Effect.provide(ValkeyCacheLive),
          )
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
          const { registration } = Schema.is(OperationalRegistrationSchema)(packet.payload)
            ? yield* Effect.fromResult(validateOperationalRegistration(packet.payload))
            : yield* Effect.fromResult(validateSystemRegistration(packet.payload))
          const runtime = qualificationRuntime(config, yield* Effect.fromResult(loadActiveStrategyProtocol()))
          if (
            (yield* Effect.fromResult(canonicalHashV1Result(runtime))) !==
            registration.obligations.runtimeConfigurationHash
          )
            return yield* new SystemAssessmentError({
              message: 'Prospective registration must use the configured runtime deadlines and strategy protocol',
            })
          const candidate = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
          if (
            candidate === undefined ||
            candidate.sourceRevision !== config.build.sourceRevision ||
            `sha256:${candidate.imageDigest}` !== config.build.imageDigest
          )
            return yield* new SystemAssessmentError({
              message: 'Prospective registration must bind the current physical worker build',
            })
          if (config.capitalActivationRequestJson !== undefined) {
            const configured = yield* Effect.fromResult(
              decodeConfiguredCapitalActivation(
                config.capitalActivationRequestJson,
                config.researchCapitalBuildLineageJson,
              ),
            ).pipe(Effect.mapError((message) => new SystemAssessmentError({ message })))
            const expected =
              configured.buildLineage === null
                ? undefined
                : { request: configured.request, buildLineage: configured.buildLineage }
            if (
              (candidate.capitalAuthorization === undefined) !== (expected === undefined) ||
              (expected !== undefined &&
                (yield* Effect.fromResult(
                  canonicalHashV1Result(
                    candidate.capitalAuthorization === undefined
                      ? undefined
                      : {
                          request: candidate.capitalAuthorization.request,
                          buildLineage: candidate.capitalAuthorization.buildLineage,
                        },
                  ),
                )) !== (yield* Effect.fromResult(canonicalHashV1Result(expected))))
            )
              return yield* new SystemAssessmentError({
                message: 'Prospective registration must preserve the configured reviewed capital lineage',
              })
          }
          if (
            candidate.capitalAuthorization !== undefined &&
            (yield* readRegisteredFinancialIdentity(candidate)) === null
          )
            return yield* new SystemAssessmentError({
              message: 'Registration requires its existing durable capital generation',
            })
          return registration.program === 'BAYN_OPERATIONAL_RELIABILITY'
            ? yield* registerOperationalPeriod(registration, packet.verifiedSources)
            : yield* registerSystemQualification(registration, packet.verifiedSources)
        }
        if (Schema.is(OperationalAssessmentInputSchema)(packet.payload))
          return yield* assessAndPersistOperational(packet.payload, packet.verifiedSources)
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

const program = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseSystemAssessmentCommandArgs(process.argv.slice(2)))
  if (command._tag !== 'Help') return yield* runSystem(command)
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${SYSTEM_ASSESSMENT_COMMAND_USAGE}\n`), stdio.stdout())
}).pipe(
  Effect.annotateLogs({ service: 'bayn-system-assessment' }),
  // @effect-diagnostics-next-line strictEffectProvide:off -- command owns its scoped runtime
  Effect.provide(Layer.mergeAll(makeConfiguredTelemetryRuntimeLayer('bayn-system-assessment'), NodeServices.layer)),
)

if (import.meta.main) NodeRuntime.runMain(program)
