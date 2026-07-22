import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Logger, Redacted } from 'effect'

import { run } from './app'
import { verifyParameterHash } from './build'
import { loadConfig } from './config'
import { makeRuntimeProvenance } from './contracts'
import { EvidenceStoreLive } from './db/evidence-store'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { hashParameters, loadDefaultProtocol } from './protocol'
import { makeStrategy } from './strategy-service'

const main = Effect.gen(function* () {
  const config = yield* loadConfig()
  const protocol = yield* loadDefaultProtocol
  const parameterHash = hashParameters(protocol)
  yield* verifyParameterHash(config.build, parameterHash)
  const provenance = makeRuntimeProvenance({
    sourceRevision: config.build.sourceRevision,
    image: {
      repository: config.build.imageRepository,
      digest: config.build.imageDigest,
    },
    strategy: {
      name: 'risk-balanced-trend',
      behaviorHash: config.build.strategyBehaviorHash,
      parameterHash,
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })
  const strategy = makeStrategy(protocol, provenance)
  const marketData = MarketDataLive(config, protocol).pipe(
    Layer.provide(
      ClickhouseClient.layer({
        url: config.clickhouse.url,
        username: config.clickhouse.username,
        password: Redacted.value(config.clickhouse.password),
        database: 'signal',
        application: 'bayn',
        request_timeout: config.operationTimeoutMs,
      }),
    ),
    Layer.provide(NodeHttpClient.layerNodeHttp),
  )
  const dependencies = Layer.mergeAll(
    marketData,
    JournalLive(config),
    EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)),
  )
  return yield* run(config, strategy).pipe(Effect.provide(dependencies))
})

const program = main.pipe(Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson])))

NodeRuntime.runMain(program)
