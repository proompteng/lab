import { decodeRestateRequestIdentityKeys } from './restate-identity'
import { acquireBrokerObservationRuntime } from '../composition/broker-observation-runtime'
import { ValkeyCacheLive } from '../valkey-cache'
import { makeBaynBrokerObservations, type BrokerObservationRuntime } from './restate-broker-observations'
import { createServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2'

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
import { makeBaynEntryInference, type EntryInferenceRuntime } from './restate-entry-inference'
import type { MarketChangedWakeup } from '../execution/events'
import { KafkaMarketFailure } from '../market-data/streaming/kafka'
import { InternalHttpOriginSchema } from './restate-invocation-client'

export class RestateExecutionServerError extends Data.TaggedError('RestateExecutionServerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const restateExecutionServerConfig = Config.all({
  activationToken: Config.Redacted('BAYN_EXECUTION_ACTIVATION_TOKEN'),
  port: Config.Port('PORT').pipe(Config.withDefault(9080)),
  requestIdentityKeys: Config.NonEmptyString('RESTATE_REQUEST_IDENTITY_KEYS'),
  ingressOrigin: Config.schema(InternalHttpOriginSchema, 'RESTATE_INGRESS_ORIGIN').pipe(
    Config.withDefault('http://restate.restate.svc.cluster.local:8080'),
  ),
})

export const publishMarketChange = (
  ingressOrigin: string,
  config: Pick<ExecutionControllerConfig, 'controllerKey' | 'operationTimeoutMs' | 'sourceRevision'>,
  event: MarketChangedWakeup,
  activationToken: Redacted.Redacted<string>,
): Effect.Effect<void, KafkaMarketFailure> => {
  if (event.sourceRevision !== config.sourceRevision)
    return Effect.fail(
      new KafkaMarketFailure({
        operation: 'read',
        message: 'market change differs from its local worker source',
        retryable: false,
      }),
    )
  const body = JSON.stringify(event)
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `${ingressOrigin}/BaynExecutionController/${encodeURIComponent(config.controllerKey)}/marketChanged`,
        {
          method: 'POST',
          // Deduplicate live waiters. Public completions expire immediately so registration is checked again.
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `bayn-market-hint-${event.eventId}`,
            authorization: `Bearer ${Redacted.value(activationToken)}`,
          },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.operationTimeoutMs)]),
        },
      )
      try {
        if (!response.ok)
          throw new KafkaMarketFailure({
            operation: 'read',
            message: `market change registration returned HTTP ${response.status}`,
            ...(response.status >= 400 &&
            response.status < 500 &&
            response.status !== 404 &&
            response.status !== 408 &&
            response.status !== 412 &&
            response.status !== 429
              ? { retryable: false }
              : {}),
          })
      } finally {
        await response.body?.cancel()
      }
    },
    catch: (cause) =>
      cause instanceof KafkaMarketFailure
        ? cause
        : new KafkaMarketFailure({ operation: 'read', message: 'durable market change registration failed', cause }),
  })
}

export const withNativeStartupReadiness = (
  handler: (request: Http2ServerRequest, response: Http2ServerResponse) => void,
  readMarketReadiness: () => Promise<boolean>,
) => {
  let historyWarmed = false
  return (request: Http2ServerRequest, response: Http2ServerResponse): void => {
    if (request.method !== 'GET' || request.url !== '/startup-ready') return handler(request, response)
    const respond = (status: number): void => {
      if (!response.destroyed && !response.writableEnded) response.writeHead(status).end()
    }
    // Subsequent source recovery must not remove broker observations or liquidation from this endpoint.
    if (historyWarmed) {
      respond(200)
      return
    }
    void Promise.resolve()
      .then(readMarketReadiness)
      .then(
        (ready) => {
          historyWarmed ||= ready
          respond(historyWarmed ? 200 : 503)
        },
        () => respond(503),
      )
  }
}

export const makeRestateExecutionEndpointHandler = (
  config: ExecutionControllerConfig,
  runtime: NativeExecutionRuntime,
  activationAuthorizationHash: string,
  identityKeys: readonly string[],
  inferenceRuntime: EntryInferenceRuntime,
  brokerObservations: {
    readonly runtime: BrokerObservationRuntime
    readonly maxAgeMs: number
    readonly freshnessLeadMs: number
  },
  hooks: readonly restate.HooksProvider[] = [],
) => {
  const observations = makeBaynBrokerObservations(
    { ...config, maxAgeMs: brokerObservations.maxAgeMs, freshnessLeadMs: brokerObservations.freshnessLeadMs },
    brokerObservations.runtime,
    hooks,
  )
  const controller = makeBaynExecutionController({ ...config, activationAuthorizationHash }, runtime, hooks)
  const inference = makeBaynEntryInference(config, inferenceRuntime, hooks)
  return restate.createEndpointHandler({
    services: [controller, observations, inference],
    identityKeys: [...identityKeys],
  })
}

export const restateExecutionServerProgram = Effect.gen(function* () {
  const [{ activationToken, port, requestIdentityKeys, ingressOrigin }, plan] = yield* Effect.all([
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
  const { config, runtime, inferenceRuntime, readMarketReadiness, startMarketWakeups } =
    yield* acquireNativeExecutionRuntime(plan)
  yield* startInferenceExpenseProjection(plan.config)
  const brokerObservations = yield* acquireBrokerObservationRuntime(plan)
  const telemetry = yield* acquireRestateTelemetry({
    ...(yield* telemetryRuntimeConfig('bayn-execution-controller')),
    serviceVersion: config.sourceRevision,
  })
  const server = createServer(
    withNativeStartupReadiness(
      makeRestateExecutionEndpointHandler(
        config,
        runtime,
        activationAuthorizationHash,
        identityKeys,
        inferenceRuntime,
        brokerObservations,
        telemetry.hooks,
      ),
      readMarketReadiness,
    ),
  )
  yield* acquireRestateHttp2Server(server, port)
  yield* startMarketWakeups((event) => publishMarketChange(ingressOrigin, config, event, activationToken))
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
