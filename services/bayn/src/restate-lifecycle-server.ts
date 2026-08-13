import { createServer } from 'node:http2'
import { readFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import * as restate from '@restatedev/restate-sdk'
import { Config, Data, Effect, Option, Result, Schema, pipe } from 'effect'

import { embeddedBuildMetadata } from './build'
import { LifecycleControllerKeySchema } from './lifecycle-command-contract'
import { decodeRestateLifecycleConfig } from './restate-lifecycle'
import {
  makeBaynLifecycle,
  makeBaynLifecycleBootstrap,
  makeLifecycleCommandClient,
} from './restate-lifecycle-controller'
import { acquireRestateTelemetry } from './restate-telemetry'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { GitSourceRevisionSchema } from './schemas'
import { makeConfiguredTelemetryRuntimeLayer, telemetryRuntimeConfig } from './telemetry'

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

class RestateLifecycleServerError extends Data.TaggedError('RestateLifecycleServerError')<{
  readonly operation: 'configuration'
  readonly message: string
  readonly cause?: unknown
}> {}

const serverConfig = Config.all({
  controllerKey: Config.schema(LifecycleControllerKeySchema, 'BAYN_LIFECYCLE_CONTROLLER_KEY').pipe(
    Config.withDefault('primary'),
  ),
  commandBaseUrl: Config.schema(InternalHttpOriginSchema, 'BAYN_LIFECYCLE_COMMAND_URL').pipe(
    Config.withDefault('http://bayn-lifecycle-command.bayn.svc.cluster.local:8081'),
  ),
  commandTokenPath: Config.nonEmptyString('BAYN_LIFECYCLE_COMMAND_TOKEN_PATH').pipe(
    Config.withDefault('/var/run/secrets/bayn-lifecycle-command/token'),
  ),
  operationTimeoutMs: Config.number('BAYN_OPERATION_TIMEOUT_MS').pipe(Config.withDefault(30_000)),
  pollIntervalMs: Config.number('BAYN_CYCLE_POLL_INTERVAL_MS').pipe(Config.withDefault(30_000)),
  port: Config.port('PORT').pipe(Config.withDefault(9080)),
  configuredSourceRevision: Config.option(Config.schema(GitSourceRevisionSchema, 'BAYN_CODE_REVISION')),
})

const maximumServiceAccountTokenBytes = 16_384

const commandCredential =
  (path: string) =>
  async (signal: AbortSignal): Promise<string> => {
    const source = await readFile(path, { encoding: 'utf8', signal })
    const token = source.trim()
    if (token.length === 0 || Buffer.byteLength(token, 'utf8') > maximumServiceAccountTokenBytes) {
      throw new Error('Bayn lifecycle command workload credential is empty or exceeds its size limit')
    }
    return token
  }

const program = Effect.gen(function* () {
  const loaded = yield* serverConfig
  const configuredSourceRevision = Option.getOrUndefined(loaded.configuredSourceRevision)
  const sourceRevision = embeddedBuildMetadata?.sourceRevision ?? configuredSourceRevision
  if (sourceRevision === undefined) {
    return yield* new RestateLifecycleServerError({
      operation: 'configuration',
      message: 'Bayn source revision is not configured',
    })
  }
  if (
    embeddedBuildMetadata !== undefined &&
    configuredSourceRevision !== undefined &&
    configuredSourceRevision !== embeddedBuildMetadata.sourceRevision
  ) {
    return yield* new RestateLifecycleServerError({
      operation: 'configuration',
      message: 'configured source revision does not match the immutable image source',
    })
  }
  const decoded = decodeRestateLifecycleConfig({
    schemaVersion: 'bayn.restate-lifecycle-config.v1',
    controllerKey: loaded.controllerKey,
    commandBaseUrl: loaded.commandBaseUrl,
    operationTimeoutMs: loaded.operationTimeoutMs,
    pollIntervalMs: loaded.pollIntervalMs,
    sourceRevision,
    port: loaded.port,
  })
  if (Result.isFailure(decoded)) {
    return yield* new RestateLifecycleServerError({
      operation: 'configuration',
      message: decoded.failure.message,
      cause: decoded.failure.cause,
    })
  }
  const config = decoded.success
  const telemetryOptions = {
    ...(yield* telemetryRuntimeConfig('bayn-lifecycle')),
    serviceVersion: sourceRevision,
  }
  const telemetry = yield* acquireRestateTelemetry(telemetryOptions)
  const lifecycle = makeBaynLifecycle(
    config,
    makeLifecycleCommandClient(config, commandCredential(loaded.commandTokenPath), fetch, telemetry.traceHeaders),
    telemetry.hooks,
  )
  const bootstrap = makeBaynLifecycleBootstrap(config, lifecycle, telemetry.hooks)
  const server = createServer(restate.createEndpointHandler({ services: [lifecycle, bootstrap] }))
  yield* acquireRestateHttp2Server(server, config.port)
  yield* Effect.logInfo('Bayn Restate lifecycle endpoint is listening').pipe(
    Effect.annotateLogs({
      controllerKey: config.controllerKey,
      planHash: config.planHash,
      port: config.port,
      sourceRevision: config.sourceRevision,
    }),
  )
  return yield* Effect.never
}).pipe(Effect.scoped)

if (import.meta.main) {
  NodeRuntime.runMain(
    pipe(
      program,
      Effect.annotateLogs({ service: 'bayn-lifecycle' }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns the telemetry layer
      Effect.provide(makeConfiguredTelemetryRuntimeLayer('bayn-lifecycle')),
    ),
  )
}
