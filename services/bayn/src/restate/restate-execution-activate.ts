import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Layer, Option, Redacted, Result, Schema } from 'effect'

import { loadApplicationPlan } from '../application-plan'
import { embeddedBuildMetadata } from '../build'
import { executionControllerConfig } from '../composition/native-execution-runtime'
import {
  decodeExecutionControllerState,
  executionControllerSuccessorPassCompleted,
  resolveOptionalExecutionControllerBinding,
  type ExecutionControllerBinding,
  type ExecutionControllerState,
} from '../execution/controller'
import { sha256 } from '../hash'
import {
  executionActivationAuthorizationHash,
  executionControllerDeploymentHandlerTimeouts,
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
import { GitSourceRevisionSchema, Sha256Schema } from '../schemas'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from '../telemetry'

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
  readonly planHash: string
  readonly previousBinding?: ExecutionControllerBinding
  readonly sourceRevision: string
}

const restateExecutionActivationTransportConfig = Config.all({
  activationGeneration: Config.schema(Sha256Schema, 'BAYN_EXECUTION_ACTIVATION_GENERATION'),
  activationToken: Config.Redacted('BAYN_EXECUTION_ACTIVATION_TOKEN'),
  ingressOrigin: Config.schema(InternalHttpOriginSchema, 'RESTATE_INGRESS_ORIGIN').pipe(
    Config.withDefault('http://restate.restate.svc.cluster.local:8080'),
  ),
  previousPlanHash: Config.option(Config.schema(Sha256Schema, 'BAYN_EXECUTION_PREVIOUS_PLAN_HASH')),
  previousSourceRevision: Config.option(
    Config.schema(GitSourceRevisionSchema, 'BAYN_EXECUTION_PREVIOUS_SOURCE_REVISION'),
  ),
})

export const restateExecutionActivationCompletionWindowMs = (operationTimeoutMs: number): number =>
  executionControllerDeploymentHandlerTimeouts(operationTimeoutMs, true).inactivityTimeout

export const restateExecutionActivationIdempotencyKey = (
  activationGeneration: string,
  sourceRevision: string,
  controllerKey: string,
  planHash: string,
  previousBinding?: ExecutionControllerBinding,
): string =>
  `bayn-execution-${sha256(
    [
      'bayn.execution-deployment-activation.v1',
      activationGeneration,
      sourceRevision,
      controllerKey,
      planHash,
      ...(previousBinding === undefined ? [] : [previousBinding.sourceRevision, previousBinding.planHash]),
    ].join('\u0000'),
  )}`

export const restateExecutionActivationRequest = (config: RestateExecutionActivationConfig, token: string) => {
  const binding = {
    controllerKey: config.controllerKey,
    planHash: config.planHash,
    sourceRevision: config.sourceRevision,
  }
  return {
    path: `/restate/send/BaynExecutionController/${encodeURIComponent(config.controllerKey)}/activateDeployment`,
    body: {
      schemaVersion: 'bayn.execution-deployment-activation.v1' as const,
      ...binding,
      ...(config.previousBinding === undefined ? {} : { previousBinding: config.previousBinding }),
    },
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': restateExecutionActivationIdempotencyKey(
        config.activationGeneration,
        config.sourceRevision,
        config.controllerKey,
        config.planHash,
        config.previousBinding,
      ),
    },
    timeoutMs: restateInvocationAcceptTimeoutMs,
  }
}

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
  return executionControllerSuccessorPassCompleted(state, {
    epoch: state.epoch,
    firstSequence: state.initialSequence,
    planHash: config.planHash,
    sourceRevision: config.sourceRevision,
  })
    ? Result.succeed(state)
    : Result.fail(
        new RestateExecutionActivationError({
          operation: 'verify',
          message:
            'native Restate activation did not prove the expected active controller plan and durable successor pass',
        }),
      )
}

export const activateRestateExecutionController = (
  config: RestateExecutionActivationConfig,
  activationToken: Redacted.Redacted<string>,
  request: RestateHttpRequest = fetch,
): Effect.Effect<ExecutionControllerState, RestateExecutionActivationError> =>
  Effect.gen(function* () {
    const token = Redacted.value(activationToken)
    yield* Effect.fromResult(executionActivationAuthorizationHash(token)).pipe(
      Effect.mapError(
        (cause) =>
          new RestateExecutionActivationError({
            operation: 'configuration',
            message: 'native Restate activation token is invalid',
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
    const state = yield* Effect.fromResult(verifyRestateExecutionActivation(config, output))
    yield* Effect.logInfo('Bayn native Restate execution controller activation verified').pipe(
      Effect.annotateLogs({
        activationInvocationId: receipt.invocationId,
        controllerKey: config.controllerKey,
        epoch: state.epoch,
        nextSequence: state.nextSequence,
        planHash: state.planHash,
        sourceRevision: state.sourceRevision,
      }),
    )
    return state
  }).pipe(withObservedSpan('bayn.execution.activate'))

export const restateExecutionActivationProgram = Effect.gen(function* () {
  const [{ activationGeneration, activationToken, ingressOrigin, previousPlanHash, previousSourceRevision }, plan] =
    yield* Effect.all([restateExecutionActivationTransportConfig, loadApplicationPlan])
  if (plan._tag !== 'AutonomousService') {
    return yield* new RestateExecutionActivationError({
      operation: 'configuration',
      message: 'native Restate activation requires the autonomous service runtime mode',
    })
  }
  const controller = yield* Effect.fromResult(executionControllerConfig(plan)).pipe(
    Effect.mapError(
      (cause) =>
        new RestateExecutionActivationError({
          operation: 'configuration',
          message: 'native Restate activation could not derive the immutable controller binding',
          cause,
        }),
    ),
  )
  const previousBinding = yield* Effect.fromResult(
    resolveOptionalExecutionControllerBinding(
      Option.getOrUndefined(previousPlanHash),
      Option.getOrUndefined(previousSourceRevision),
    ),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RestateExecutionActivationError({
          operation: 'configuration',
          message: cause,
        }),
    ),
  )
  const configured: RestateExecutionActivationConfig = {
    ...controller,
    activationGeneration,
    ingressOrigin,
    ...(previousBinding === undefined ? {} : { previousBinding }),
  }
  const embeddedSourceRevision = embeddedBuildMetadata?.sourceRevision
  if (embeddedSourceRevision !== undefined && embeddedSourceRevision !== configured.sourceRevision) {
    return yield* new RestateExecutionActivationError({
      operation: 'configuration',
      message: 'configured source revision does not match the immutable activation image',
    })
  }
  yield* activateRestateExecutionController(configured, activationToken)
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
