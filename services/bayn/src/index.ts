import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Context, Effect, Layer, Logger, Redacted } from 'effect'

import { run } from './app'
import { riskBalancedTrendBehaviorHash } from './behavior'
import { BrokerRead, live as AlpacaReadLive } from './broker/alpaca'
import { verifyBehaviorHash, verifyParameterHash } from './build'
import { loadConfig } from './config'
import { makeRuntimeProvenance } from './contracts'
import { CycleObservabilityLive } from './db/cycle-observability'
import { CycleStore, CycleStoreLive } from './db/cycle-store'
import { EvidenceStoreLive } from './db/evidence-store'
import { PaperStore, PaperStoreLive } from './db/paper-store'
import { WriterFence, WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import type { BrokerProbe } from './health'
import { JournalLive } from './ledger'
import { MarketData, MarketDataLive } from './market-data'
import { makeObserveAutonomousCycleStartup } from './observe-composition'
import { acquireSqlLayer } from './operations'
import { Authority } from './paper'
import { hashParameters, loadDefaultProtocol } from './protocol'
import { runOnce } from './reconciler'
import { makeStrategy } from './strategy'

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
  const clickhouse = yield* acquireSqlLayer(
    ClickhouseClient.layer({
      url: config.clickhouse.url,
      username: config.clickhouse.username,
      password: Redacted.value(config.clickhouse.password),
      database: 'signal',
      application: 'bayn',
      request_timeout: config.operationTimeoutMs,
    }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
  )
  const marketData = MarketDataLive(config, protocol).pipe(
    Layer.provide(Layer.succeedContext(clickhouse)),
    Layer.provide(NodeHttpClient.layerNodeHttp),
  )
  const marketDataContext = yield* Layer.build(marketData)
  const marketDataService = Context.get(marketDataContext, MarketData)
  const evidenceStore = yield* acquireSqlLayer(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))
  const cycleObservability = CycleObservabilityLive.pipe(Layer.provide(Layer.succeedContext(evidenceStore)))
  const journal = yield* acquireSqlLayer(JournalLive(config))
  let broker: BrokerProbe | undefined
  let autonomousCycleStartup: Parameters<typeof run>[4]
  if (config.alpaca !== undefined) {
    const brokerReadContext = yield* Layer.build(
      AlpacaReadLive({
        expectedAccountId: config.alpaca.accountId,
        key: config.alpaca.key,
        secret: config.alpaca.secret,
        proxyUrl: config.alpaca.proxyUrl,
        operationTimeoutMs: config.operationTimeoutMs,
        retryAttempts: config.alpaca.retryAttempts,
      }),
    ).pipe(
      Effect.mapError((cause) => operationalError('config', 'alpaca', 'Alpaca paper account binding failed', cause)),
    )
    const brokerRead = Context.get(brokerReadContext, BrokerRead)
    broker = {
      read: brokerRead,
      expectedAccountId: config.alpaca.accountId,
      executionEligible: false,
      executionDisabledReason:
        config.maximumAuthority === Authority.Observe
          ? 'MAXIMUM_AUTHORITY_OBSERVE'
          : 'PAPER_DISPATCH_REQUIRES_CYCLE_GATES',
    }
    const storage = Layer.mergeAll(Layer.succeedContext(evidenceStore), Layer.succeedContext(journal))
    const paperStoreContext = yield* Layer.build(PaperStoreLive(config).pipe(Layer.provide(storage))).pipe(
      Effect.mapError((cause) =>
        operationalError('database', 'paper-store', 'paper persistence composition failed', cause),
      ),
    )
    const paperStore = Context.get(paperStoreContext, PaperStore)
    const writerFenceContext = yield* Layer.build(
      WriterFenceLive.pipe(Layer.provide(Layer.succeedContext(evidenceStore))),
    ).pipe(
      Effect.mapError((cause) =>
        operationalError('database', 'writer-fence', 'paper writer fence acquisition failed', cause),
      ),
    )
    const writerFence = Context.get(writerFenceContext, WriterFence)
    const cycleStoreContext = yield* Layer.build(
      CycleStoreLive.pipe(Layer.provide(Layer.succeedContext(evidenceStore))),
    ).pipe(
      Effect.mapError((cause) =>
        operationalError('database', 'cycle-store', 'cycle persistence composition failed', cause),
      ),
    )
    const reconcile = runOnce.pipe(
      Effect.provideService(BrokerRead, brokerRead),
      Effect.provideService(PaperStore, paperStore),
      Effect.provideService(WriterFence, writerFence),
    )
    autonomousCycleStartup = makeObserveAutonomousCycleStartup({
      accountId: config.alpaca.accountId,
      authorityGenerationHash: config.alpaca.authorityGenerationHash,
      brokerRead,
      cycleStore: Context.get(cycleStoreContext, CycleStore),
      marketData: marketDataService,
      maximumAuthority: config.maximumAuthority,
      paperStore,
      pollIntervalMs: config.cyclePollIntervalMs,
      reconcile,
      strategy,
    })
  }
  const dependencies = Layer.mergeAll(
    Layer.succeedContext(marketDataContext),
    cycleObservability,
    Layer.succeedContext(journal),
    Layer.succeedContext(evidenceStore),
  )
  return yield* run(config, strategy, Effect.void, broker, autonomousCycleStartup).pipe(Effect.provide(dependencies))
}).pipe(Effect.scoped)

const program = main.pipe(Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson])))

NodeRuntime.runMain(program)
