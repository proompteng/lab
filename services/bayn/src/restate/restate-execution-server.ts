import { decodeRestateRequestIdentityKeys } from './restate-identity'
import { acquireBrokerObservationRuntime } from '../composition/broker-observation-runtime'
import { ValkeyCacheLive } from '../valkey-cache'
import { makeBaynBrokerObservations, type BrokerObservationRuntime } from './restate-broker-observations'
import { createServer } from 'node:http2'

import { NodeRuntime } from '@effect/platform-node'
import * as restate from '@restatedev/restate-sdk'
import { Config, Data, Effect, Layer, Redacted } from 'effect'

import { loadApplicationPlan } from '../application-plan'
import { acquireNativeExecutionRuntime } from '../composition/native-execution-runtime'
import { acquireRestateHttp2Server } from './restate-http2-server'
import {
  executionActivationAuthorizationHash,
  makeBaynExecutionController,
  type ExecutionControllerConfig,
  type NativeExecutionRuntime,
} from './restate-execution-controller'
import { acquireRestateTelemetry } from './restate-telemetry'
import {
  makeConfiguredMetricsRuntimeLayer,
  makeConfiguredTelemetryRuntimeLayer,
  telemetryRuntimeConfig,
} from '../telemetry'
import { startInferenceExpenseProjection } from '../inference-expense-runtime'
import { initializeErrorTracking, reportTerminalFailure } from '../error-tracking'

export class RestateExecutionServerError extends Data.TaggedError('RestateExecutionServerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const restateExecutionServerConfig = Config.all({
  activationToken: Config.Redacted('BAYN_EXECUTION_ACTIVATION_TOKEN'),
  port: Config.Port('PORT').pipe(Config.withDefault(9080)),
  requestIdentityKeys: Config.NonEmptyString('RESTATE_REQUEST_IDENTITY_KEYS'),
})

export const makeRestateExecutionEndpointHandler = (
  config: ExecutionControllerConfig,
  runtime: NativeExecutionRuntime,
  activationAuthorizationHash: string,
  identityKeys: readonly string[],
  brokerObservations: { readonly runtime: BrokerObservationRuntime; readonly pollIntervalMs: number },
  hooks: readonly restate.HooksProvider[] = [],
) => {
  const observations = makeBaynBrokerObservations(
    { ...config, pollIntervalMs: brokerObservations.pollIntervalMs },
    brokerObservations.runtime,
    hooks,
  )
  const controller = makeBaynExecutionController({ ...config, activationAuthorizationHash }, runtime, hooks)
  return restate.createEndpointHandler({
    services: [controller, observations],
    identityKeys: [...identityKeys],
  })
}

export const restateExecutionServerProgram = Effect.gen(function* () {
  const [{ activationToken, port, requestIdentityKeys }, plan] = yield* Effect.all([
    restateExecutionServerConfig,
    loadApplicationPlan,
  ])
  const activationAuthorizationHash = yield* Effect.fromResult(
    executionActivationAuthorizationHash(Redacted.value(activationToken)),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RestateExecutionServerError({
          message: 'native Restate activation token is invalid',
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
  const { config, runtime } = yield* acquireNativeExecutionRuntime(plan)
  yield* startInferenceExpenseProjection(plan.config)
  const brokerObservations = yield* acquireBrokerObservationRuntime(plan)
  const telemetry = yield* acquireRestateTelemetry({
    ...(yield* telemetryRuntimeConfig('bayn-execution-controller')),
    serviceVersion: config.sourceRevision,
  })
  const server = createServer(
    makeRestateExecutionEndpointHandler(
      config,
      runtime,
      activationAuthorizationHash,
      identityKeys,
      brokerObservations,
      telemetry.hooks,
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
  initializeErrorTracking('bayn-execution-controller')
  NodeRuntime.runMain(
    Layer.effectDiscard(
      restateExecutionServerProgram.pipe(Effect.annotateLogs({ service: 'bayn-execution-controller' })),
    ).pipe(
      Layer.provide(ValkeyCacheLive),
      Layer.provide(
        Layer.mergeAll(
          makeConfiguredTelemetryRuntimeLayer('bayn-execution-controller'),
          makeConfiguredMetricsRuntimeLayer('bayn-execution-controller'),
        ),
      ),
      Layer.launch,
      reportTerminalFailure('bayn-execution-controller'),
    ),
  )
}
