import { createServer } from 'node:http2'

import { NodeRuntime } from '@effect/platform-node'
import * as restate from '@restatedev/restate-sdk'
import { Config, Data, Effect, Layer, Schema } from 'effect'

import { loadApplicationPlan } from './application-plan'
import type { ApplicationPlan, ApplicationPlanFor } from './app'
import { acquireNativeExecutionRuntime } from './composition/native-execution-runtime'
import { acquireRestateHttp2Server } from './restate-http2-server'
import {
  makeBaynExecutionBootstrap,
  makeBaynExecutionController,
  type ExecutionControllerConfig,
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
  identityKeys: readonly string[],
  hooks: readonly restate.HooksProvider[] = [],
) => {
  const controller = makeBaynExecutionController(config, runtime, hooks)
  const bootstrap = makeBaynExecutionBootstrap(config, controller, hooks)
  return restate.createEndpointHandler({ services: [controller, bootstrap], identityKeys: [...identityKeys] })
}

export const restateExecutionServerProgram = Effect.gen(function* () {
  const [{ port, requestIdentityKeys }, plan] = yield* Effect.all([
    executionServerConfig,
    loadApplicationPlan.pipe(Effect.flatMap(requireAutonomousApplicationPlan)),
  ])
  const identityKeys = yield* Effect.fromResult(decodeRestateRequestIdentityKeys(requestIdentityKeys)).pipe(
    Effect.mapError(
      (cause) =>
        new RestateExecutionServerError({
          message: 'native Restate request identity keys are invalid',
          cause,
        }),
    ),
  )
  const { config, runtime } = yield* acquireNativeExecutionRuntime(plan)
  const telemetry = yield* acquireRestateTelemetry({
    ...(yield* telemetryRuntimeConfig('bayn-execution-controller')),
    serviceVersion: config.sourceRevision,
  })
  const server = createServer(makeRestateExecutionEndpointHandler(config, runtime, identityKeys, telemetry.hooks))
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
