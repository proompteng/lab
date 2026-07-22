import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Logger, Redacted } from 'effect'

import { run } from './app'
import { live as AlpacaReadLive } from './broker/alpaca'
import { verifyParameterHash } from './build'
import { loadConfig } from './config'
import { makeRuntimeProvenance } from './contracts'
import { EvidenceStoreLive } from './db/evidence-store'
import { PaperStoreLive } from './db/paper-store'
import { WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import { JournalLive } from './ledger'
import { MarketDataLive } from './market-data'
import { acquireSqlLayer } from './operations'
import { Authority } from './paper'
import { hashParameters, loadDefaultProtocol } from './protocol'
import { runContinuously } from './reconciler'
import { makeStrategy } from './strategy'

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
  const evidenceStore = yield* acquireSqlLayer(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))
  const journal = yield* acquireSqlLayer(JournalLive(config))
  let reconciliation = Effect.void
  if (config.alpaca !== undefined) {
    const brokerRead = yield* Layer.build(
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
    if (config.maximumAuthority === Authority.Paper) {
      const storage = Layer.mergeAll(Layer.succeedContext(evidenceStore), Layer.succeedContext(journal))
      const paperStore = yield* Layer.build(PaperStoreLive(config).pipe(Layer.provide(storage)))
      const writerFence = yield* Layer.build(
        WriterFenceLive.pipe(Layer.provide(Layer.succeedContext(evidenceStore))),
      ).pipe(
        Effect.mapError((cause) =>
          operationalError('database', 'writer-fence', 'paper writer fence acquisition failed', cause),
        ),
      )
      const reconciliationDependencies = Layer.mergeAll(
        Layer.succeedContext(brokerRead),
        Layer.succeedContext(paperStore),
        Layer.succeedContext(writerFence),
      )
      reconciliation = runContinuously(config.alpaca.reconciliationIntervalMs).pipe(
        Effect.provide(reconciliationDependencies),
      )
    }
  }
  const dependencies = Layer.mergeAll(marketData, Layer.succeedContext(journal), Layer.succeedContext(evidenceStore))
  return yield* run(config, strategy, reconciliation).pipe(Effect.provide(dependencies))
}).pipe(Effect.scoped)

const program = main.pipe(Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson])))

NodeRuntime.runMain(program)
