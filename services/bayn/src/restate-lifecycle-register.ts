import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Logger, Option, Schema, pipe } from 'effect'

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

const postJson = (
  operation: 'register' | 'activate',
  url: string,
  body: unknown,
): Effect.Effect<number, RestateRegistrationError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
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
  )
  yield* Effect.logInfo('Bayn Restate deployment registered').pipe(
    Effect.annotateLogs({
      controllerKey: loaded.controllerKey,
      endpointUri: loaded.endpointUri,
      registrationStatus,
      sourceRevision,
    }),
  )
  const activationStatus = yield* postJson('activate', `${loaded.ingressOrigin}/BaynLifecycleBootstrap/start`, {
    schemaVersion: 'bayn.restate-lifecycle-activation.v1',
    controllerKey: loaded.controllerKey,
  })
  yield* Effect.logInfo('Bayn Restate lifecycle activated through ingress').pipe(
    Effect.annotateLogs({
      activationStatus,
      controllerKey: loaded.controllerKey,
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
