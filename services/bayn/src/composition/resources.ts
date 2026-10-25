import { equityMarketProfile, cryptoMarketProfile } from '../jev/markets'

import type { MarketSources } from '../market-data/streaming/raw-events'
import { ValkeyCacheLive } from '../valkey-cache'
import { BrokerObservationsLive } from '../db/broker-observations'
import { brokerSnapshotCacheConfig } from '../broker/alpaca/snapshot-cache'
import { CandidateObservationStoreLive } from '../db/candidate-observation-postgres'
import { JevBatchStoreLive } from '../db/jev-batch-postgres'
import { JevPositionStoreLive } from '../db/jev-position-postgres'
import { JevEvaluationStoreLive } from '../db/jev-evaluation-postgres'
import { JevClient, JevClientLive, JevError } from '../jev/client'
import { JevFailure } from '../jev/contract'
import { JevHttpClientLive } from '../jev/http'
import { defaultJevProtocolDocument } from '../jev/protocol'

import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer } from 'effect'

import type { ApplicationIdentity, ApplicationPlan } from '../app'
import { AlpacaBrokerResourcesLive } from '../broker/alpaca/composition'
import { live as BrokerReadOnlyResourcesLive } from '../broker/alpaca/session'
import type { LoadedRuntimeConfig } from '../config/model'
import { CycleObservability, CycleObservabilityLive } from '../cycle/store/observability'
import { WriterFencedCycleStoreLive } from '../cycle/store/postgres'
import { ExecutionControllerStatusStoreLive } from '../db/execution-controller-status-postgres'
import { ExecutionCycleClosureStoreLive as ExecutionCycleClosureStorePostgresLive } from '../db/execution-cycle-closure-postgres'
import { PostgresClientLive, postgresHealthCheck } from '../db/postgres-client'
import { PostgresMigrationsLive } from '../db/postgres-migrations'
import { ExecutionStoreLive } from '../db/execution-store'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { BlockedCycleIntentStoreLive } from '../execution/intents/blocked-cycle-postgres'
import { IntentStoreLive } from '../execution/intents/postgres'
import { MutationStoreLive } from '../execution/mutations/program'
import { WriterFenceLive } from '../execution/writer-fence'
import { HttpServerLive } from '../http'
import { Journal, JournalLive } from '../ledger'
import { IntradayMarketData, type IntradayMarketDataService } from '../market-data/intraday/model'
import { KafkaMarketProjection, KafkaMarketProjectionLive } from '../market-data/streaming/kafka'
import { makeNativeArrivalStore } from '../db/native-arrival-postgres'
import type { DatabaseError } from '../db/database-error'
import { makeNativeArrivalJournal } from '../market-data/streaming/native-arrival-journal'
import { nativeArrivalCaptureId } from '../market-data/streaming/native-arrival'
import { StreamingIntradayMarketDataLive } from '../market-data/streaming/service'
import { operationalError, type OperationalError } from '../errors'

type PostgresResourceConfig = Pick<LoadedRuntimeConfig, 'operationTimeoutMs' | 'postgres'>

export const PostgresClientResourceLive = (config: PostgresResourceConfig) => PostgresClientLive(config)

export const JournalResourceLive = (config: LoadedRuntimeConfig) => JournalLive(config)

export const CycleObservabilityResourceLive = CycleObservabilityLive

export const ExecutionStoreResourceLive = (config: LoadedRuntimeConfig) => ExecutionStoreLive(config)

export const ExecutionControllerStatusResourceLive = (config: PostgresResourceConfig) => {
  const postgres = PostgresLive(config)
  return Layer.merge(postgres, ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres))).pipe(
    Layer.provideMerge(ApplicationPlatformLive),
  )
}

export const WriterFencedCycleStoreResourceLive = WriterFencedCycleStoreLive

export const WriterFenceResourceLive = WriterFenceLive

const BrokerObservationResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  Layer.unwrap(
    Effect.map(brokerSnapshotCacheConfig, (cache) =>
      BrokerObservationsLive(config.alpaca.expectedAccountId, config.build.sourceRevision, cache.maxAgeMs),
    ),
  )

export const BrokerSessionResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  AlpacaBrokerResourcesLive(config.alpaca).pipe(Layer.provide(BrokerObservationResourceLive(config)))

export const ApplicationPlatformLive = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

const HttpApplicationPlatformLive = (config: LoadedRuntimeConfig) =>
  Layer.merge(HttpServerLive(config), ApplicationPlatformLive)

const workerStreamingUniverse = (plan: ApplicationIdentity): MarketSources => [
  {
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
    symbols: equityMarketProfile.universe,
    topics: {
      ...equityMarketProfile.sourceTopics,
      features: equityMarketProfile.streamingInput.featureTopic,
      ...(plan.config.kafka?.technicalFeaturesTopic === undefined
        ? {}
        : { technicalFeatures: plan.config.kafka.technicalFeaturesTopic }),
    },
  },
  {
    universeId: cryptoMarketProfile.universeId,
    universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
    symbols: cryptoMarketProfile.universe,
    topics: { ...cryptoMarketProfile.sourceTopics, features: cryptoMarketProfile.streamingInput.featureTopic },
  },
]

export const WorkerMarketProjectionLive = (
  plan: ApplicationIdentity,
): Layer.Layer<KafkaMarketProjection, DatabaseError | OperationalError> => {
  const kafka = plan.config.kafka
  return kafka === undefined
    ? Layer.effect(
        KafkaMarketProjection,
        Effect.fail(
          operationalError({
            component: 'config',
            operation: 'market-data',
            message: 'Trading requires configured Kafka market data',
          }),
        ),
      )
    : Layer.unwrap(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const store = makeNativeArrivalStore(sql)
          return KafkaMarketProjectionLive(kafka, workerStreamingUniverse(plan), (bootstrap, sources) =>
            Effect.gen(function* () {
              const captureId = yield* Effect.fromResult(nativeArrivalCaptureId(plan.config.build, bootstrap, sources))
              return yield* makeNativeArrivalJournal(
                {
                  schemaVersion: 'bayn.native-arrival-epoch.v1',
                  captureId,
                  build: plan.config.build,
                  bootstrap,
                  sources,
                },
                store,
              )
            }),
          )
        }),
      ).pipe(
        Layer.provide(
          Layer.merge(
            PostgresClientLive(plan.config, { maxConnections: 1, applicationName: 'bayn-native-arrival' }),
            PostgresMigrationsLive(plan.config),
          ),
        ),
        Layer.provide(NodeServices.layer),
      )
}

const WorkerMarketDataLive = (
  plan: ApplicationIdentity,
  postgres: ReturnType<typeof PostgresLive>,
  prewarmedProjection?: Layer.Layer<KafkaMarketProjection>,
) => {
  if (plan.config.kafka === undefined)
    return Layer.effect(
      IntradayMarketData,
      Effect.fail(
        operationalError({
          component: 'config',
          operation: 'market-data',
          message: 'Trading requires configured Kafka market data',
        }),
      ),
    )
  const kafka = prewarmedProjection ?? WorkerMarketProjectionLive(plan)
  return StreamingIntradayMarketDataLive.pipe(Layer.provide(kafka), Layer.provide(postgres))
}

const PostgresLive = (config: PostgresResourceConfig) => {
  const client = PostgresClientResourceLive(config)
  const migrations = PostgresMigrationsLive(config)
  return Layer.merge(client, migrations)
}

/** Read-only resources for the public status service. Mutation stores and the transaction writer fence are absent. */
export const AutonomousStatusApplicationResourcesLive = (plan: ApplicationPlan) => {
  const postgres = PostgresClientResourceLive(plan.config)
  const controllerStatus = ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres))
  const cycleObservability = CycleObservabilityResourceLive.pipe(Layer.provide(postgres))
  return Layer.mergeAll(
    postgres,
    controllerStatus,
    cycleObservability,
    JournalResourceLive(plan.config),
    BrokerReadOnlyResourcesLive(plan.config.alpaca).pipe(
      Layer.provide(BrokerObservationResourceLive(plan.config)),
      Layer.provide(postgres),
    ),
  ).pipe(Layer.provideMerge(ValkeyCacheLive), Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

export const AutonomousWorkerApplicationResourcesLive = (
  plan: ApplicationPlan,
  prewarmedProjection?: Layer.Layer<KafkaMarketProjection>,
) => {
  const postgres = PostgresLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  return Layer.mergeAll(
    WorkerMarketDataLive(plan, postgres, prewarmedProjection),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ValkeyCacheLive), Layer.provideMerge(ApplicationPlatformLive))
}

export const AutonomousRuntimeResourcesLive = (plan: ApplicationPlan) => {
  const postgres = PostgresClientResourceLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPersistence = Layer.mergeAll(
    JevBatchStoreLive.pipe(Layer.provideMerge(JevEvaluationStoreLive)),
    CandidateObservationStoreLive,
    JevPositionStoreLive,
    ExecutionStoreResourceLive(plan.config),
    BlockedCycleIntentStoreLive,
    IntentStoreLive,
    MutationStoreLive,
    PersistedCapitalGrantStoreLive,
    ExecutionCycleClosureStorePostgresLive,
    ExecutionControllerStatusStoreLive,
  ).pipe(Layer.provideMerge(writerFence), Layer.provideMerge(postgres), Layer.provideMerge(journal))
  return Layer.mergeAll(
    plan.config.jevKey === undefined
      ? Layer.succeed(JevClient, {
          evaluate: () =>
            Effect.fail(
              new JevError({
                failure: JevFailure.Request,
                message: 'Jev entry requires the configured TypeSafe credential',
              }),
            ),
        })
      : JevClientLive(plan.config.jevKey, defaultJevProtocolDocument.inferenceValidityMs).pipe(
          Layer.provide(JevHttpClientLive(plan.config.alpaca.proxyUrl)),
          Layer.catch((cause) =>
            Layer.effect(
              JevClient,
              Effect.fail(
                operationalError({
                  component: 'config',
                  operation: 'jev-client',
                  message: 'Jev inference configuration is invalid',
                  cause,
                }),
              ),
            ),
          ),
        ),
    BrokerSessionResourceLive(plan.config).pipe(Layer.provide(postgres)),
    executionPersistence,
    WriterFencedCycleStoreResourceLive.pipe(Layer.provide(writerFence), Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ValkeyCacheLive), Layer.provideMerge(ApplicationPlatformLive))
}

export const applicationDependencies: Effect.Effect<
  {
    readonly marketData: IntradayMarketDataService
    readonly intradayMarketData: IntradayMarketDataService
    readonly journal: import('../ledger').JournalService
    readonly postgresql: ReturnType<typeof postgresHealthCheck>
    readonly cycleObservability: import('../cycle/store/observability').CycleObservabilityShape
  },
  never,
  IntradayMarketData | Journal | PgClient.PgClient | CycleObservability
> = Effect.all({
  marketData: IntradayMarketData,
  intradayMarketData: IntradayMarketData,
  journal: Journal,
  postgresql: Effect.map(PgClient.PgClient, postgresHealthCheck),
  cycleObservability: CycleObservability,
})
