import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Layer, Redacted, Result, Schema } from 'effect'

import { embeddedBuildMetadata } from './build'
import { decodeExecutionControllerState, type ExecutionControllerState } from './execution/controller'
import { sha256 } from './hash'
import {
  executionBootstrapAuthorizationHash,
  executionControllerCutoverAwaitTimeoutMs,
} from './restate-execution-controller'
import {
  awaitRestateInvocation,
  restateInvocationAcceptTimeoutMs,
  restateInvocationCompletionMaximumAttempts,
  restateInvocationCompletionPollIntervalMs,
  restateInvocationOutputRequestTimeoutMs,
  sendRestateInvocation,
  type RestateHttpRequest,
} from './restate-invocation-client'
import { OperationalThresholdSchema } from './restate-lifecycle'
import { GitSourceRevisionSchema, Sha256Schema } from './schemas'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'

const InternalHttpOriginSchema = Schema.Trim.check(
  Schema.makeFilter(
    (candidate: string) => {
      try {
        const url = new URL(candidate)
        return (
          url.protocol === 'http:' &&
          url.username === '' &&
          url.password === '' &&
          url.pathname === '/' &&
          url.search === '' &&
          url.hash === ''
        )
      } catch {
        return false
      }
    },
    { expected: 'an uncredentialed internal HTTP origin' },
  ),
)

export class RestateExecutionActivationError extends Data.TaggedError('RestateExecutionActivationError')<{
  readonly operation: 'configuration' | 'invoke' | 'verify'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface RestateExecutionActivationConfig {
  readonly activationGeneration: string
  readonly controllerKey: string
  readonly ingressOrigin: string
  readonly operationTimeoutMs: number
  readonly sourceRevision: string
}

export const restateExecutionActivationConfig = Config.all({
  activationGeneration: Config.schema(Sha256Schema, 'BAYN_EXECUTION_ACTIVATION_GENERATION'),
  bootstrapToken: Config.redacted('BAYN_EXECUTION_BOOTSTRAP_TOKEN'),
  controllerKey: Config.schema(Sha256Schema, 'BAYN_EXECUTION_CONTROLLER_KEY'),
  ingressOrigin: Config.schema(InternalHttpOriginSchema, 'RESTATE_INGRESS_ORIGIN').pipe(
    Config.withDefault('http://restate.restate.svc.cluster.local:8080'),
  ),
  operationTimeoutMs: Config.schema(OperationalThresholdSchema, 'BAYN_OPERATION_TIMEOUT_MS').pipe(
    Config.withDefault(30_000),
  ),
  sourceRevision: Config.schema(GitSourceRevisionSchema, 'BAYN_CODE_REVISION'),
})

export const restateExecutionActivationCompletionWindowMs = (operationTimeoutMs: number): number =>
  executionControllerCutoverAwaitTimeoutMs(operationTimeoutMs)

export const restateExecutionActivationIdempotencyKey = (
  activationGeneration: string,
  sourceRevision: string,
  controllerKey: string,
  planHash: string,
): string =>
  `bayn-execution-${sha256(
    `bayn.execution-controller-bootstrap.v2\u0000${activationGeneration}\u0000${sourceRevision}\u0000${controllerKey}\u0000${planHash}`,
  )}`

export const restateExecutionActivationRequest = (config: RestateExecutionActivationConfig, token: string) => ({
  path: '/restate/send/BaynExecutionBootstrap/start',
  body: {
    schemaVersion: 'bayn.execution-controller-bootstrap.v1' as const,
    controllerKey: config.controllerKey,
    sourceRevision: config.sourceRevision,
  },
  headers: {
    authorization: `Bearer ${token}`,
    'idempotency-key': restateExecutionActivationIdempotencyKey(
      config.activationGeneration,
      config.sourceRevision,
      config.controllerKey,
      config.planHash,
    ),
  },
  timeoutMs: restateInvocationAcceptTimeoutMs,
})

export const verifyRestateExecutionActivation = (
  config: RestateExecutionActivationConfig,
  candidate: unknown,
): Result.Result<ExecutionControllerState, RestateExecutionActivationError> => {
  const decoded = decodeExecutionControllerState(candidate)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new RestateExecutionActivationError({
        operation: 'verify',
        message: 'native Restate activation returned invalid controller state',
        cause: decoded.failure,
      }),
    )
  }
  const state = decoded.success
  return state.active && state.sourceRevision === config.sourceRevision
    ? Result.succeed(state)
    : Result.fail(
        new RestateExecutionActivationError({
          operation: 'verify',
          message: 'native Restate activation did not prove the expected active controller binding',
        }),
      )
}

export const activateRestateExecutionController = (
  config: RestateExecutionActivationConfig,
  bootstrapToken: Redacted.Redacted<string>,
  request: RestateHttpRequest = fetch,
): Effect.Effect<ExecutionControllerState, RestateExecutionActivationError> =>
  Effect.gen(function* () {
    const token = Redacted.value(bootstrapToken)
    yield* Effect.fromResult(executionBootstrapAuthorizationHash(token)).pipe(
      Effect.mapError(
        (cause) =>
          new RestateExecutionActivationError({
            operation: 'configuration',
            message: 'native Restate bootstrap token is invalid',
            cause,
          }),
      ),
    )
    const activation = restateExecutionActivationRequest(config, token)
    const receipt = yield* sendRestateInvocation(
      `${config.ingressOrigin}${activation.path}`,
      activation.body,
      { headers: activation.headers, timeoutMs: activation.timeoutMs },
      request,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RestateExecutionActivationError({
            operation: 'invoke',
            message: 'native Restate activation request failed',
            cause,
          }),
      ),
    )
    const output = yield* awaitRestateInvocation(
      config.ingressOrigin,
      receipt.invocationId,
      {
        maximumAttempts: restateInvocationCompletionMaximumAttempts(
          restateExecutionActivationCompletionWindowMs(config.operationTimeoutMs),
        ),
        pollIntervalMs: restateInvocationCompletionPollIntervalMs,
        requestTimeoutMs: restateInvocationOutputRequestTimeoutMs,
      },
      request,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RestateExecutionActivationError({
            operation: 'invoke',
            message: 'native Restate activation did not complete',
            cause,
          }),
      ),
    )
    return yield* Effect.fromResult(verifyRestateExecutionActivation(config, output))
  }).pipe(withObservedSpan('bayn.execution.activate'))

export const restateExecutionActivationProgram = Effect.gen(function* () {
  const { bootstrapToken, ...configured } = yield* restateExecutionActivationConfig
  const embeddedSourceRevision = embeddedBuildMetadata?.sourceRevision
  if (embeddedSourceRevision !== undefined && embeddedSourceRevision !== configured.sourceRevision) {
    return yield* new RestateExecutionActivationError({
      operation: 'configuration',
      message: 'configured source revision does not match the immutable activation image',
    })
  }
  const state = yield* activateRestateExecutionController(configured, bootstrapToken)
  yield* Effect.logInfo('Bayn native Restate execution controller activation verified').pipe(
    Effect.annotateLogs({
      controllerKey: configured.controllerKey,
      epoch: state.epoch,
      nextSequence: state.nextSequence,
      planHash: state.planHash,
      sourceRevision: state.sourceRevision,
    }),
  )
})

export const runFiniteLayer = <A, E, R>(layer: Layer.Layer<A, E, R>): Effect.Effect<void, E, R> =>
  Effect.scoped(Layer.build(layer)).pipe(Effect.asVoid)

if (import.meta.main) {
  NodeRuntime.runMain(
    runFiniteLayer(
      Layer.effectDiscard(
        restateExecutionActivationProgram.pipe(Effect.annotateLogs({ service: 'bayn-execution-activate' })),
      ).pipe(Layer.provide(makeConfiguredTelemetryRuntimeLayer('bayn-execution-activate'))),
    ),
  )
}
