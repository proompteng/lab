import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Logger, Option, Result, Schema, pipe } from 'effect'

import { embeddedBuildMetadata } from './build'
import { LifecycleControllerKeySchema } from './lifecycle-command-contract'
import { GitSourceRevisionSchema } from './schemas'

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

const config = Config.all({
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
  configuredSourceRevision: Config.option(Config.schema(GitSourceRevisionSchema, 'BAYN_CODE_REVISION')),
})

interface JsonPostOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

const maximumInvocationReceiptBytes = 16 * 1024
export const restateLifecycleActivationAcceptTimeoutMs = 30_000
const RestateAcceptedInvocationSchema = Schema.Struct({
  invocationId: Schema.Trim.check(Schema.isPattern(/^inv_[A-Za-z0-9]+$/)),
  status: Schema.Literal('Accepted'),
})

export const decodeRestateAcceptedInvocation = Schema.decodeUnknownResult(RestateAcceptedInvocationSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

const postJson = (
  operation: 'register',
  url: string,
  body: unknown,
  options: JsonPostOptions,
): Effect.Effect<number, RestateRegistrationError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
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

const postAcceptedInvocation = (
  url: string,
  body: unknown,
  options: JsonPostOptions,
): Effect.Effect<typeof RestateAcceptedInvocationSchema.Type, RestateRegistrationError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new Error(`${url} returned a non-JSON invocation receipt`)
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10)
      if (Number.isFinite(declaredLength) && declaredLength > maximumInvocationReceiptBytes) {
        throw new Error(`${url} returned an oversized invocation receipt`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maximumInvocationReceiptBytes) {
        throw new Error(`${url} returned an oversized invocation receipt`)
      }
      const decoded = decodeRestateAcceptedInvocation(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      if (Result.isFailure(decoded)) throw new Error(`${url} returned an invalid invocation receipt`)
      return decoded.success
    },
    catch: (cause) =>
      new RestateRegistrationError({
        operation: 'activate',
        message: 'Bayn Restate lifecycle activate request failed',
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
  const loaded = yield* config
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
  const activationReceipt = yield* postAcceptedInvocation(
    `${loaded.ingressOrigin}${activation.path}`,
    activation.body,
    { headers: activation.headers, timeoutMs: activation.timeoutMs },
  )
  yield* Effect.logInfo('Bayn Restate lifecycle activation accepted through ingress').pipe(
    Effect.annotateLogs({
      controllerKey: loaded.controllerKey,
      invocationId: activationReceipt.invocationId,
      sourceRevision,
    }),
  )
})

if (import.meta.main) {
  NodeRuntime.runMain(
    pipe(
      program,
      Effect.annotateLogs({ service: 'bayn-lifecycle-register' }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns the logger layer
      Effect.provide(Logger.layer([Logger.consoleJson])),
    ),
  )
}
