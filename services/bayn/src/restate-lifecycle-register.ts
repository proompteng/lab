import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Option, Schema, pipe } from 'effect'

import { embeddedBuildMetadata } from './build'
import { LifecycleControllerKeySchema } from './lifecycle-command-contract'
import { OperationalThresholdSchema } from './restate-lifecycle'
import { lifecycleActivationAwaitTimeoutMs } from './restate-lifecycle-controller'
import {
  awaitRestateInvocation,
  restateInvocationAcceptTimeoutMs,
  restateInvocationCompletionMaximumAttempts,
  restateInvocationCompletionPollIntervalMs,
  restateInvocationOutputRequestTimeoutMs,
  sendRestateInvocation,
} from './restate-invocation-client'
import { GitSourceRevisionSchema } from './schemas'
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
class RestateRegistrationError extends Data.TaggedError('RestateRegistrationError')<{
  readonly operation: 'configuration' | 'register' | 'activate'
  readonly message: string
  readonly cause?: unknown
}> {}

export const restateLifecycleRegistrationConfig = Config.all({
  adminOrigin: Config.schema(InternalHttpOriginSchema, 'RESTATE_ADMIN_ORIGIN').pipe(
    Config.withDefault('http://restate.restate.svc.cluster.local:9070'),
  ),
  ingressOrigin: Config.schema(InternalHttpOriginSchema, 'RESTATE_INGRESS_ORIGIN').pipe(
    Config.withDefault('http://restate.restate.svc.cluster.local:8080'),
  ),
  endpointUri: Config.schema(InternalHttpOriginSchema, 'BAYN_RESTATE_ENDPOINT_URI').pipe(
    Config.withDefault('http://bayn-lifecycle.bayn.svc.cluster.local:9080'),
  ),
  controllerKey: Config.schema(LifecycleControllerKeySchema, 'BAYN_LIFECYCLE_CONTROLLER_KEY').pipe(
    Config.withDefault('primary'),
  ),
  operationTimeoutMs: Config.schema(OperationalThresholdSchema, 'BAYN_OPERATION_TIMEOUT_MS').pipe(
    Config.withDefault(30_000),
  ),
  configuredSourceRevision: Config.option(Config.schema(GitSourceRevisionSchema, 'BAYN_CODE_REVISION')),
})

interface JsonPostOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

const requestSignal = (interruptionSignal: AbortSignal, timeoutMs: number): AbortSignal =>
  AbortSignal.any([interruptionSignal, AbortSignal.timeout(timeoutMs)])

export const restateLifecycleActivationAcceptTimeoutMs = restateInvocationAcceptTimeoutMs
export const restateLifecycleActivationOutputRequestTimeoutMs = restateInvocationOutputRequestTimeoutMs
export const restateLifecycleActivationCompletionPollIntervalMs = restateInvocationCompletionPollIntervalMs
// The first completion request is immediate, so the remaining attempt intervals span the controller's entire bounded
// activation window. The Sync hook therefore keeps one waiter alive instead of relying on restart backoff.
export const restateLifecycleActivationCompletionMaximumAttempts = (operationTimeoutMs: number): number =>
  restateInvocationCompletionMaximumAttempts(
    lifecycleActivationAwaitTimeoutMs(operationTimeoutMs),
    restateLifecycleActivationCompletionPollIntervalMs,
  )

const postJson = (
  operation: 'register',
  url: string,
  body: unknown,
  options: JsonPostOptions,
): Effect.Effect<number, RestateRegistrationError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: requestSignal(signal, options.timeoutMs),
      })
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
      await response.body?.cancel()
      return response.status
    },
    catch: (cause) =>
      new RestateRegistrationError({
        operation,
        message: `Bayn Restate lifecycle ${operation} request failed`,
        cause,
      }),
  })

export const restateDeploymentRegistration = (endpointUri: string, sourceRevision: string) => ({
  uri: endpointUri,
  force: false,
  metadata: {
    managed_by: 'argocd',
    service: 'bayn-lifecycle',
    source_revision: sourceRevision,
  },
})

export const restateLifecycleActivationIdempotencyKey = (sourceRevision: string, controllerKey: string): string =>
  `bayn-lifecycle-${sourceRevision}-${controllerKey}`

export const restateLifecycleActivationRequest = (sourceRevision: string, controllerKey: string) => ({
  path: '/restate/send/BaynLifecycleBootstrap/start',
  body: {
    schemaVersion: 'bayn.restate-lifecycle-activation.v1',
    controllerKey,
  },
  headers: {
    'idempotency-key': restateLifecycleActivationIdempotencyKey(sourceRevision, controllerKey),
  },
  timeoutMs: restateLifecycleActivationAcceptTimeoutMs,
})

const program = Effect.gen(function* () {
  const loaded = yield* restateLifecycleRegistrationConfig
  const configuredSourceRevision = Option.getOrUndefined(loaded.configuredSourceRevision)
  const sourceRevision = embeddedBuildMetadata?.sourceRevision ?? configuredSourceRevision
  if (sourceRevision === undefined) {
    return yield* new RestateRegistrationError({
      operation: 'configuration',
      message: 'Bayn source revision is not configured',
    })
  }
  if (
    embeddedBuildMetadata !== undefined &&
    configuredSourceRevision !== undefined &&
    configuredSourceRevision !== embeddedBuildMetadata.sourceRevision
  ) {
    return yield* new RestateRegistrationError({
      operation: 'configuration',
      message: 'configured source revision does not match the immutable image source',
    })
  }
  const registrationStatus = yield* postJson(
    'register',
    `${loaded.adminOrigin}/deployments`,
    restateDeploymentRegistration(loaded.endpointUri, sourceRevision),
    { timeoutMs: 30_000 },
  )
  yield* Effect.logInfo('Bayn Restate deployment registered').pipe(
    Effect.annotateLogs({
      controllerKey: loaded.controllerKey,
      endpointUri: loaded.endpointUri,
      registrationStatus,
      sourceRevision,
    }),
  )
  const activation = restateLifecycleActivationRequest(sourceRevision, loaded.controllerKey)
  const activationReceipt = yield* sendRestateInvocation(`${loaded.ingressOrigin}${activation.path}`, activation.body, {
    headers: activation.headers,
    timeoutMs: activation.timeoutMs,
  })
  yield* Effect.logInfo('Bayn Restate lifecycle activation accepted through ingress').pipe(
    Effect.annotateLogs({
      controllerKey: loaded.controllerKey,
      invocationId: activationReceipt.invocationId,
      sourceRevision,
    }),
  )
  yield* awaitRestateInvocation(loaded.ingressOrigin, activationReceipt.invocationId, {
    maximumAttempts: restateLifecycleActivationCompletionMaximumAttempts(loaded.operationTimeoutMs),
    pollIntervalMs: restateLifecycleActivationCompletionPollIntervalMs,
    requestTimeoutMs: restateLifecycleActivationOutputRequestTimeoutMs,
  })
  yield* Effect.logInfo('Bayn Restate lifecycle activation completed').pipe(
    Effect.annotateLogs({
      controllerKey: loaded.controllerKey,
      invocationId: activationReceipt.invocationId,
      sourceRevision,
    }),
  )
}).pipe(withObservedSpan('bayn.lifecycle.register'))

if (import.meta.main) {
  NodeRuntime.runMain(
    pipe(
      program,
      Effect.annotateLogs({ service: 'bayn-lifecycle-register' }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns the telemetry layer
      Effect.provide(makeConfiguredTelemetryRuntimeLayer('bayn-lifecycle-register')),
    ),
  )
}
