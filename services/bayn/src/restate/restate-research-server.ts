import { OtlpMetrics, OtlpSerialization } from 'effect/observability'
import {
  researchHeartbeat,
  researchUnpriced,
  researchPendingExpenses,
  researchExpenseLag,
  researchAmbiguous,
} from '../research-inference/telemetry'
import { createServer } from 'node:http2'

import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as restate from '@restatedev/restate-sdk'
import { Clock, Config, Effect, Layer, Metric, Schema } from 'effect'
import { HttpClient } from 'effect/http'

import { embeddedBuildMetadata } from '../build'
import { initializeErrorTracking, reportTerminalFailure } from '../error-tracking'
import { PostgresClientLive } from '../db/postgres-client'
import { GitSourceRevisionSchema } from '../schemas'
import { validateResearchApprovalKey } from '../research-inference/approval'
import { hashResearch, ResearchError, ResearchPolicySchema } from '../research-inference/contract'
import { makeResearchRunner } from '../research-inference/runner'
import { makeResearchStore } from '../research-inference/store'
import { makeConfiguredTelemetryRuntimeLayer, telemetryRuntimeConfig } from '../telemetry'
import { acquireRestateHttp2Server } from './restate-http2-server'
import { decodeRestateRequestIdentityKeys } from './restate-identity'
import {
  makePublicInformationServices,
  submitPublicInformationActivation,
  submitPublicInformationJobs,
} from './restate-public-information'
import { publicInformationEnabled, publicInformationIntervalMs } from '../public-information'
import { runPublicInformation } from '../public-information-resources'
import { makeBaynResearchRun } from './restate-research-run'
import { acquireRestateTelemetry, currentOpenTelemetryParentSpan } from './restate-telemetry'

export const researchServerConfig = Config.all({
  port: Config.Port('PORT').pipe(Config.withDefault(9080)),
  sourceRevision:
    embeddedBuildMetadata === undefined
      ? Config.schema(GitSourceRevisionSchema, 'BAYN_CODE_REVISION')
      : Config.succeed(embeddedBuildMetadata.sourceRevision),
  identityKeys: Config.NonEmptyString('RESTATE_REQUEST_IDENTITY_KEYS'),
  policies: Config.schema(
    Schema.fromJsonString(Schema.Array(ResearchPolicySchema).check(Schema.isMinLength(1), Schema.isMaxLength(2))),
    'BAYN_RESEARCH_INFERENCE_POLICIES',
  ),
  approvalKey: Config.Redacted('BAYN_RESEARCH_APPROVAL_KEY'),
  url: Config.Redacted('BAYN_POSTGRES_URL'),
  tls: Config.Boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
  caPath: Config.String('BAYN_POSTGRES_CA_PATH').pipe(Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt')),
})
export const researchModelEndpoint = 'http://flamingo.flamingo.svc.cluster.local/v1/chat/completions'

export const researchServerProgram = Effect.gen(function* () {
  const config = yield* researchServerConfig
  yield* Effect.fromResult(validateResearchApprovalKey(config.approvalKey))
  if (embeddedBuildMetadata !== undefined && embeddedBuildMetadata.sourceRevision !== config.sourceRevision)
    return yield* new ResearchError({ message: 'Research server source revision differs from its immutable image' })
  const identityKeys = yield* Effect.fromResult(decodeRestateRequestIdentityKeys(config.identityKeys))
  const telemetryConfig = yield* telemetryRuntimeConfig('bayn-research')
  const telemetry = yield* acquireRestateTelemetry({
    ...telemetryConfig,
    serviceVersion: config.sourceRevision,
  })
  const servingPolicyHashes = yield* Effect.forEach(config.policies, (policy) =>
    Effect.fromResult(hashResearch(policy)),
  )
  const serve = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`SELECT run_id FROM research_inference_runs LIMIT 0`
    const store = makeResearchStore(sql)
    yield* Effect.gen(function* () {
      while (true) {
        yield* Metric.update(researchHeartbeat, (yield* Clock.currentTimeMillis) / 1000)
        yield* store.coverage.pipe(
          Effect.flatMap((row) =>
            Effect.all([
              Metric.update(researchUnpriced, row.unpriced),
              Metric.update(researchPendingExpenses, row.pending),
              Metric.update(researchExpenseLag, row.lag),
              Metric.update(researchAmbiguous, row.ambiguous),
            ]),
          ),
          Effect.catch(() => Effect.logWarning('Bayn research expense coverage query unavailable')),
        )
        yield* Effect.sleep('30 seconds')
      }
    }).pipe(Effect.forkScoped)
    const runner = yield* makeResearchRunner(
      store,
      researchModelEndpoint,
      () => ({
        ...telemetry.traceHeaders(),
      }),
      config.sourceRevision,
    )
    const context = yield* Effect.context<HttpClient.HttpClient>()
    const workflow = makeBaynResearchRun(
      {
        run: (run, signal) => {
          const parent = currentOpenTelemetryParentSpan()
          const attempt = Effect.gen(function* () {
            if (!servingPolicyHashes.includes(yield* Effect.fromResult(hashResearch(run.policy))))
              return yield* new ResearchError({
                message: 'Research run differs from the frozen serving policy',
              })
            return yield* runner.run(run)
          })
          return Effect.runPromiseWith(context)(
            parent === undefined ? attempt : attempt.pipe(Effect.withParentSpan(parent)),
            { signal },
          ).catch(() => {
            throw new restate.TerminalError(
              'Research attempt failed before a durable receipt; retained claims remain ambiguous',
            )
          })
        },
      },
      config.approvalKey,
      telemetry.hooks,
    )
    const publicServices = makePublicInformationServices(
      {
        sourceRevision: config.sourceRevision,
        approvalKey: config.approvalKey,
        intervalMs: publicInformationIntervalMs,
      },
      {
        collect: (source, previous, signal) => {
          const parent = currentOpenTelemetryParentSpan()
          const collect = runPublicInformation(source, config.sourceRevision, previous)
          return Effect.runPromiseWith(context)(
            parent === undefined ? collect : collect.pipe(Effect.withParentSpan(parent)),
            { signal },
          )
        },
      },
      telemetry.hooks,
    )
    yield* acquireRestateHttp2Server(
      createServer(
        restate.createEndpointHandler({ services: [workflow, ...publicServices], identityKeys: [...identityKeys] }),
      ),
      config.port,
    )
    yield* Effect.gen(function* () {
      const enabled = yield* Config.Boolean('BAYN_PUBLIC_INFORMATION_ENABLED').pipe(Config.withDefault(false))
      yield* Metric.update(publicInformationEnabled, enabled ? 1 : 0)
      if (!enabled) return
      yield* submitPublicInformationJobs((source) =>
        submitPublicInformationActivation(
          {
            sourceRevision: config.sourceRevision,
            approvalKey: config.approvalKey,
            ingressOrigin: 'http://restate.restate.svc.cluster.local:8080',
          },
          source,
        ),
      )
    }).pipe(
      Effect.catchCause(() =>
        Effect.logWarning(
          'Public information job activation unavailable; trading and model research remain independent',
        ),
      ),
      Effect.forkScoped,
    )
    yield* Effect.logInfo('Bayn independent research endpoint is listening').pipe(
      Effect.annotateLogs({ sourceRevision: config.sourceRevision, servingPolicyHashes, port: config.port }),
    )
    return yield* Effect.never
  })
  return yield* serve.pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- isolated server owns its HTTP and database resource scopes
    Effect.provide(
      Layer.mergeAll(
        OtlpMetrics.layer({
          url: 'http://observability-mimir-gateway.observability.svc.cluster.local/otlp/v1/metrics',
          resource: {
            serviceName: 'bayn-research',
            serviceVersion: config.sourceRevision,
            ...(telemetryConfig.instanceId === undefined
              ? {}
              : { attributes: { 'service.instance.id': telemetryConfig.instanceId } }),
          },
          exportInterval: '30 seconds',
          shutdownTimeout: '3 seconds',
        }).pipe(Layer.provide(Layer.mergeAll(NodeHttpClient.layerNodeHttp, OtlpSerialization.layerProtobuf))),
        NodeHttpClient.layerNodeHttp,
        NodeServices.layer,
        PostgresClientLive(
          { operationTimeoutMs: 10_000, postgres: { url: config.url, tls: config.tls, caPath: config.caPath } },
          { maxConnections: 2, applicationName: 'bayn-research' },
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  )
}).pipe(Effect.scoped)

if (import.meta.main) {
  initializeErrorTracking('bayn-research')
  NodeRuntime.runMain(
    Layer.effectDiscard(researchServerProgram).pipe(
      Layer.provide(makeConfiguredTelemetryRuntimeLayer('bayn-research')),
      Layer.launch,
      reportTerminalFailure('bayn-research'),
    ),
  )
}
