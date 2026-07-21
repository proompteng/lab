import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Logger, Redacted } from 'effect'

import { run } from './app'
import { loadConfig } from './config'
import { makeRuntimeProvenance } from './contracts'
import { EvidenceStoreRuntimeLive } from './db/evidence-store'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { hashRiskBalancedTrendParameters, loadDefaultRiskBalancedTrendProtocol } from './protocol'
import { makeRiskBalancedTrendStrategy, Strategy } from './strategy-service'

const main = Effect.gen(function* () {
  const config = yield* loadConfig()
  const protocol = yield* loadDefaultRiskBalancedTrendProtocol
  const provenance = makeRuntimeProvenance({
    sourceRevision: config.build.sourceRevision,
    image: {
      repository: config.build.imageRepository,
      digest: config.build.imageDigest,
    },
    strategy: {
      name: 'risk-balanced-trend',
      behaviorHash: config.build.strategyBehaviorHash,
      parameterHash: hashRiskBalancedTrendParameters(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })
  const strategy = makeRiskBalancedTrendStrategy(protocol, provenance)
  const marketData = MarketDataLive(config, strategy.universe).pipe(
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
    EvidenceStoreRuntimeLive(config).pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(Strategy, strategy),
  )
  return yield* run(config).pipe(Effect.provide(dependencies))
})

const program = main.pipe(Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson])))

NodeRuntime.runMain(program)
