import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Context, Effect, Layer, Logger, Redacted } from 'effect'

import { run } from './app'
import { riskBalancedTrendBehaviorHash } from './behavior'
import { BrokerRead, alpacaHttpLayer, live as AlpacaReadLive } from './broker/alpaca'
import { BrokerMutation, makeMutation } from './broker/alpaca-mutations'
import { verifyBehaviorHash, verifyParameterHash } from './build'
import { loadConfig } from './config'
import { makeRuntimeProvenance } from './contracts'
import { CycleObservabilityLive } from './db/cycle-observability'
import { EvidenceStoreLive } from './db/evidence-store'
import { PaperStoreLive } from './db/paper-store'
import { IntentStoreLive } from './execution/intents'
import { MutationStoreLive } from './execution/mutations'
import { WriterFenceLive } from './execution/writer-fence'
import { operationalError } from './errors'
import type { BrokerProbe } from './health'
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
  const evidenceStore = yield* acquireSqlLayer(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))
  const cycleObservability = CycleObservabilityLive.pipe(Layer.provide(Layer.succeedContext(evidenceStore)))
  const journal = yield* acquireSqlLayer(JournalLive(config))
  let reconciliation = Effect.void
  let broker: BrokerProbe | undefined
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
    broker = {
      read: Context.get(brokerRead, BrokerRead),
      expectedAccountId: config.alpaca.accountId,
      executionEligible: false,
      executionDisabledReason:
        config.maximumAuthority === Authority.Observe
          ? 'MAXIMUM_AUTHORITY_OBSERVE'
          : 'PAPER_DISPATCH_REQUIRES_CYCLE_GATES',
    }
    if (config.maximumAuthority === Authority.Paper) {
      const storage = Layer.mergeAll(Layer.succeedContext(evidenceStore), Layer.succeedContext(journal))
      const paperStore = yield* Layer.build(PaperStoreLive(config).pipe(Layer.provide(storage))).pipe(
        Effect.mapError((cause) =>
          operationalError('database', 'paper-store', 'paper persistence composition failed', cause),
        ),
      )
      const writerFence = yield* Layer.build(
        WriterFenceLive.pipe(Layer.provide(Layer.succeedContext(evidenceStore))),
      ).pipe(
        Effect.mapError((cause) =>
          operationalError('database', 'writer-fence', 'paper writer fence acquisition failed', cause),
        ),
      )
      const brokerMutation = yield* Layer.build(
        Layer.effect(
          BrokerMutation,
          makeMutation({
            expectedAccountId: config.alpaca.accountId,
            maximumAuthority: config.maximumAuthority,
            key: config.alpaca.key,
            secret: config.alpaca.secret,
            proxyUrl: config.alpaca.proxyUrl,
            operationTimeoutMs: config.operationTimeoutMs,
          }),
        ).pipe(Layer.provide(alpacaHttpLayer(config.alpaca.proxyUrl))),
      ).pipe(
        Effect.mapError((cause) =>
          operationalError('config', 'alpaca-mutation', 'Alpaca paper mutation binding failed', cause),
        ),
      )
      const persistence = Layer.mergeAll(Layer.succeedContext(evidenceStore), Layer.succeedContext(writerFence))
      const intentStore = yield* Layer.build(IntentStoreLive.pipe(Layer.provide(persistence)))
      const mutationStore = yield* Layer.build(MutationStoreLive.pipe(Layer.provide(persistence)))
      const paperExecution = Layer.mergeAll(
        Layer.succeedContext(brokerRead),
        Layer.succeedContext(brokerMutation),
        Layer.succeedContext(paperStore),
        Layer.succeedContext(writerFence),
        Layer.succeedContext(intentStore),
        Layer.succeedContext(mutationStore),
      )
      reconciliation = runContinuously(config.alpaca.reconciliationIntervalMs).pipe(Effect.provide(paperExecution))
    }
  }
  const dependencies = Layer.mergeAll(
    marketData,
    cycleObservability,
    Layer.succeedContext(journal),
    Layer.succeedContext(evidenceStore),
  )
  return yield* run(config, strategy, reconciliation, broker).pipe(Effect.provide(dependencies))
}).pipe(Effect.scoped)

const program = main.pipe(Effect.annotateLogs({ service: 'bayn' }), Effect.provide(Logger.layer([Logger.consoleJson])))

NodeRuntime.runMain(program)
