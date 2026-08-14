import { createServer } from 'node:http2'

import { NodeRuntime } from '@effect/platform-node'
import * as restate from '@restatedev/restate-sdk'
import { Config, Data, Effect, Layer, Option, Redacted, Result, Schema } from 'effect'

import { loadApplicationPlan } from './application-plan'
import type { ApplicationPlan, ApplicationPlanFor } from './app'
import { acquireNativeExecutionRuntime } from './composition/native-execution-runtime'
import { acquireRestateHttp2Server } from './restate-http2-server'
import {
  executionBootstrapAuthorizationHash,
  makeBaynExecutionBootstrap,
  makeBaynExecutionController,
  type ExecutionControllerConfig,
  type LegacyLifecycleCutoverBinding,
  type NativeExecutionRuntime,
} from './restate-execution-controller'
import { acquireRestateTelemetry } from './restate-telemetry'
import { strictParseOptions } from './schemas'
import { makeConfiguredTelemetryRuntimeLayer, telemetryRuntimeConfig } from './telemetry'

export class RestateExecutionServerError extends Data.TaggedError('RestateExecutionServerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const executionServerConfig = Config.all({
  bootstrapToken: Config.redacted('BAYN_EXECUTION_BOOTSTRAP_TOKEN'),
  legacyControllerKey: Config.nonEmptyString('BAYN_LEGACY_LIFECYCLE_CONTROLLER_KEY').pipe(
    Config.withDefault('primary'),
  ),
  legacyPlanHash: Config.option(
    Config.schema(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)), 'BAYN_LEGACY_LIFECYCLE_PLAN_HASH'),
  ),
  legacySourceRevision: Config.option(
    Config.schema(Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)), 'BAYN_LEGACY_LIFECYCLE_SOURCE_REVISION'),
  ),
  port: Config.port('PORT').pipe(Config.withDefault(9080)),
  requestIdentityKeys: Config.nonEmptyString('RESTATE_REQUEST_IDENTITY_KEYS'),
})

const RestateRequestIdentityKeySchema = Schema.Trim.check(Schema.isPattern(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/))
const RestateRequestIdentityKeysSchema = Schema.Array(RestateRequestIdentityKeySchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
  Schema.isUnique(),
)

export const decodeRestateRequestIdentityKeys = (candidate: string) =>
  Schema.decodeUnknownResult(RestateRequestIdentityKeysSchema, strictParseOptions)(candidate.split(','))

export const requireAutonomousApplicationPlan = (
  plan: ApplicationPlan,
): Effect.Effect<ApplicationPlanFor<'AutonomousService'>, RestateExecutionServerError> =>
  plan._tag === 'AutonomousService'
    ? Effect.succeed(plan)
    : Effect.fail(
        new RestateExecutionServerError({
          message: 'native Restate execution requires the autonomous service runtime mode',
        }),
      )

export const makeRestateExecutionEndpointHandler = (
  config: ExecutionControllerConfig,
  runtime: NativeExecutionRuntime,
  bootstrapAuthorizationHash: string,
  identityKeys: readonly string[],
  hooks: readonly restate.HooksProvider[] = [],
  legacyCutover?: LegacyLifecycleCutoverBinding,
) => {
  const controller = makeBaynExecutionController(config, runtime, hooks)
  const bootstrap = makeBaynExecutionBootstrap(config, controller, bootstrapAuthorizationHash, hooks, legacyCutover)
  return restate.createEndpointHandler({ services: [controller, bootstrap], identityKeys: [...identityKeys] })
}

export const resolveLegacyCutoverBinding = (
  controllerKey: string,
  planHash: Option.Option<string>,
  sourceRevision: Option.Option<string>,
): Result.Result<LegacyLifecycleCutoverBinding | undefined, RestateExecutionServerError> => {
  const decodedPlanHash = Option.getOrUndefined(planHash)
  const decodedSourceRevision = Option.getOrUndefined(sourceRevision)
  if (decodedPlanHash === undefined && decodedSourceRevision === undefined) {
    return Result.succeed(undefined)
  }
  if (decodedPlanHash === undefined || decodedSourceRevision === undefined) {
    return Result.fail(
      new RestateExecutionServerError({
        message: 'legacy Restate lifecycle cutover requires both plan hash and source revision',
      }),
    )
  }
  return Result.succeed({ controllerKey, planHash: decodedPlanHash, sourceRevision: decodedSourceRevision })
}

export const restateExecutionServerProgram = Effect.gen(function* () {
  const [
    { bootstrapToken, legacyControllerKey, legacyPlanHash, legacySourceRevision, port, requestIdentityKeys },
    plan,
  ] = yield* Effect.all([
    executionServerConfig,
    loadApplicationPlan.pipe(Effect.flatMap(requireAutonomousApplicationPlan)),
  ])
  const bootstrapAuthorizationHash = yield* Effect.fromResult(
    executionBootstrapAuthorizationHash(Redacted.value(bootstrapToken)),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RestateExecutionServerError({
          message: 'native Restate bootstrap token is invalid',
          cause,
        }),
    ),
  )
  const identityKeys = yield* Effect.fromResult(decodeRestateRequestIdentityKeys(requestIdentityKeys)).pipe(
    Effect.mapError(
      (cause) =>
        new RestateExecutionServerError({
          message: 'native Restate request identity keys are invalid',
          cause,
        }),
    ),
  )
  const legacyCutover = yield* Effect.fromResult(
    resolveLegacyCutoverBinding(legacyControllerKey, legacyPlanHash, legacySourceRevision),
  )
  const { config, runtime } = yield* acquireNativeExecutionRuntime(plan)
  const telemetry = yield* acquireRestateTelemetry({
    ...(yield* telemetryRuntimeConfig('bayn-execution-controller')),
    serviceVersion: config.sourceRevision,
  })
  const server = createServer(
    makeRestateExecutionEndpointHandler(
      config,
      runtime,
      bootstrapAuthorizationHash,
      identityKeys,
      telemetry.hooks,
      legacyCutover,
    ),
  )
  yield* acquireRestateHttp2Server(server, port)
  yield* Effect.logInfo('Bayn native Restate execution endpoint is listening').pipe(
    Effect.annotateLogs({
      controllerKey: config.controllerKey,
      planHash: config.planHash,
      port,
      sourceRevision: config.sourceRevision,
    }),
  )
  return yield* Effect.never
}).pipe(Effect.scoped)

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.effectDiscard(
      restateExecutionServerProgram.pipe(Effect.annotateLogs({ service: 'bayn-execution-controller' })),
    ).pipe(Layer.provide(makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller')), Layer.launch),
  )
}
