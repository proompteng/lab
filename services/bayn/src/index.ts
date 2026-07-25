import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Logger, Redacted, Schema, Stdio, Stream } from 'effect'

import { run } from './app'
import { riskBalancedTrendBehaviorHash } from './behavior'
import { BrokerRead, live as AlpacaReadLive, scopedReadAdapterLayer } from './broker/alpaca'
import { verifyBehaviorHash, verifyParameterHash } from './build'
import { loadConfig, type LoadedRuntimeConfig } from './config'
import { makeRuntimeProvenance, makeStrategyProtocolHash } from './contracts'
import { CycleObservabilityLive } from './db/cycle-observability'
import { CycleStoreLive } from './db/cycle-store'
import { EvidenceStoreFromPostgres, PostgresClientLive } from './db/evidence-store'
import { PaperStoreLive } from './db/paper-store'
import { WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import { canonicalHashV1 } from './hash'
import type { BrokerProbe } from './health'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { loadObserveRiskPolicy, makeObserveAutonomousCycleStartup } from './observe-composition'
import { retrySqlLayer } from './operations'
import { Authority } from './paper'
import { discoverPaperProofCandidates } from './paper-proof-discovery'
import { hashParameters, loadDefaultProtocol } from './protocol'
import { makeStrategy, type Strategy } from './strategy'

const mapLayerError = <A, E, R, E2>(layer: Layer.Layer<A, E, R>, map: (error: E) => E2): Layer.Layer<A, E2, R> =>
  Layer.unwrap(Layer.build(layer).pipe(Effect.mapError(map), Effect.map(Layer.succeedContext)))

const main = Effect.gen(function* () {
  const config = yield* loadConfig()
  const protocol = yield* loadDefaultProtocol
  const parameterHash = hashParameters(protocol)
  yield* Effect.all([
    verifyBehaviorHash(config.build, riskBalancedTrendBehaviorHash),
    verifyParameterHash(config.build, parameterHash),
  ])
  const provenance = makeRuntimeProvenance({
    sourceRevision: config.build.sourceRevision,
    image: {
      repository: config.build.imageRepository,
      digest: config.build.imageDigest,
    },
    strategy: {
      name: 'risk-balanced-trend',
      behaviorHash: riskBalancedTrendBehaviorHash,
      parameterHash,
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })
  const strategy = makeStrategy(protocol, provenance)
  if (config.paperProofCommand !== undefined) {
    return yield* runPaperProofDiscovery(config, strategy)
  }
  const clickhouse = retrySqlLayer(
    ClickhouseClient.layer({
      url: config.clickhouse.url,
      username: config.clickhouse.username,
      password: Redacted.value(config.clickhouse.password),
      database: 'signal',
      application: 'bayn',
      request_timeout: config.operationTimeoutMs,
    }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
  )
  const marketData = MarketDataLive(config, protocol).pipe(Layer.provide(clickhouse))
  const database = retrySqlLayer(
    EvidenceStoreFromPostgres(config).pipe(
      Layer.provideMerge(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer))),
    ),
  )
  const journal = JournalLive(config)
  const cycleObservability = CycleObservabilityLive.pipe(Layer.provide(database))
  const core = Layer.mergeAll(marketData, database, journal, cycleObservability)
  if (config.alpaca === undefined) {
    return yield* run(config, strategy).pipe(Effect.provide(core))
  }

  const alpaca = config.alpaca
  const brokerRead = mapLayerError(
    AlpacaReadLive({
      expectedAccountId: alpaca.accountId,
      key: alpaca.key,
      secret: alpaca.secret,
      proxyUrl: alpaca.proxyUrl,
      operationTimeoutMs: config.operationTimeoutMs,
      retryAttempts: alpaca.retryAttempts,
    }),
    (cause) => operationalError('config', 'alpaca', 'Alpaca paper account binding failed', cause),
  )
  const storage = Layer.merge(database, journal)
  const paperStore = PaperStoreLive(config).pipe(Layer.provide(storage))
  const writerFence = WriterFenceLive.pipe(Layer.provide(database))
  const cycleStore = CycleStoreLive.pipe(Layer.provide(database))
  const live = Layer.mergeAll(core, brokerRead, paperStore, writerFence, cycleStore)
  const application = Effect.gen(function* () {
    const read = yield* BrokerRead
    const broker: BrokerProbe = {
      read,
      expectedAccountId: alpaca.accountId,
      executionEligible: false,
      executionDisabledReason:
        config.maximumAuthority === Authority.Observe
          ? 'MAXIMUM_AUTHORITY_OBSERVE'
          : 'PAPER_DISPATCH_REQUIRES_CYCLE_GATES',
    }
    const autonomousCycleStartup = makeObserveAutonomousCycleStartup({
      accountId: alpaca.accountId,
      authorityGenerationHash: alpaca.authorityGenerationHash,
      maximumAuthority: config.maximumAuthority,
      pollIntervalMs: config.cyclePollIntervalMs,
      strategy,
    })
    return yield* run(config, strategy, Effect.void, broker, autonomousCycleStartup)
  })
  return yield* application.pipe(Effect.provide(live))
}).pipe(Effect.scoped)

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const runPaperProofDiscovery = (config: LoadedRuntimeConfig, strategy: Strategy) =>
  Effect.gen(function* () {
    const alpaca = config.alpaca
    const qualificationRunId = config.qualificationRunId
    if (alpaca === undefined || qualificationRunId === undefined) {
      return yield* Effect.fail(
        operationalError(
          'config',
          'paper-command',
          'PREPARE DISCOVER requires Alpaca reads and a pinned qualification',
        ),
      )
    }
    const policy = yield* loadObserveRiskPolicy(alpaca.accountId, strategy.parameters.universe).pipe(
      Effect.mapError((cause) =>
        operationalError('config', 'paper-command', 'source-controlled OBSERVE risk policy is invalid', cause),
      ),
    )
    const postgres = retrySqlLayer(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer)))
    const observability = CycleObservabilityLive.pipe(Layer.provide(postgres))
    const cycleStore = CycleStoreLive.pipe(Layer.provide(postgres))
    const brokerRead = mapLayerError(
      scopedReadAdapterLayer({
        expectedAccountId: alpaca.accountId,
        key: alpaca.key,
        secret: alpaca.secret,
        proxyUrl: alpaca.proxyUrl,
        operationTimeoutMs: config.operationTimeoutMs,
        retryAttempts: alpaca.retryAttempts,
      }),
      (cause) => operationalError('config', 'alpaca', 'Alpaca scoped read adapter construction failed', cause),
    )
    const dependencies = Layer.mergeAll(postgres, observability, cycleStore, brokerRead)
    const runtime = Layer.merge(dependencies, NodeServices.layer)
    return yield* Effect.gen(function* () {
      const receipt = yield* discoverPaperProofCandidates({
        sourceRevision: config.build.sourceRevision,
        image: {
          repository: config.build.imageRepository,
          digest: config.build.imageDigest,
        },
        strategy: strategy.provenance.strategy,
        strategyProtocolHash: makeStrategyProtocolHash(strategy.provenance.strategy),
        qualificationRunId,
        accountId: alpaca.accountId,
        authorityGenerationHash: alpaca.authorityGenerationHash,
        policyHash: canonicalHashV1(policy),
      })
      const output = yield* encodeJson(receipt)
      const stdio = yield* Stdio.Stdio
      yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
    }).pipe(Effect.provide(runtime))
  })

const runtime = Layer.merge(Logger.layer([Logger.consoleJson]), NodeServices.layer)
const program = main.pipe(Effect.annotateLogs({ service: 'bayn' }), Effect.provide(runtime))

NodeRuntime.runMain(program)
