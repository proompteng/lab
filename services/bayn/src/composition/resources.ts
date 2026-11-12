import { equityMarketProfile, cryptoMarketProfile } from '../jev/markets'

import type { MarketSources } from '../market-data/streaming/raw-events'
import { ValkeyCacheLive } from '../valkey-cache'
import { BrokerObservationsLive } from '../db/broker-observations'
import { brokerSnapshotCacheConfig } from '../broker/alpaca/snapshot-cache'
import { CandidateObservationStoreLive } from '../db/candidate-observation-postgres'
import { JevBatchStoreLive } from '../db/jev-batch-postgres'
import { JevPositionStoreLive } from '../db/jev-position-postgres'
import { JevEvaluationStoreLive } from '../db/jev-evaluation-postgres'
import { EntryInferenceJournalLive } from '../db/entry-inference-postgres'
import { JevClient, JevClientLive, JevError } from '../jev/client'
import { JevFailure } from '../jev/contract'
import { JevHttpClientLive } from '../jev/http'
import { defaultJevProtocolDocument } from '../jev/protocol'

import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import type { ApplicationIdentity, ApplicationPlan } from '../app'
import { AlpacaBrokerResourcesLive } from '../broker/alpaca/composition'
import type { LoadedRuntimeConfig } from '../config/model'
import { WriterFencedCycleStoreLive } from '../cycle/store/postgres'
import { ExecutionControllerStatusStoreLive } from '../db/execution-controller-status-postgres'
import { ExecutionCycleClosureStoreLive as ExecutionCycleClosureStorePostgresLive } from '../db/execution-cycle-closure-postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { PostgresMigrationsLive } from '../db/postgres-migrations'
import { ExecutionStoreLive } from '../db/execution-store'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { BlockedCycleIntentStoreLive } from '../execution/intents/blocked-cycle-postgres'
import { IntentStoreLive } from '../execution/intents/postgres'
import { MutationStoreLive } from '../execution/mutations/program'
import { WriterFenceLive } from '../execution/writer-fence'
import { JournalLive } from '../ledger'
import { IntradayMarketData } from '../market-data/intraday/model'
import { KafkaMarketProjection } from '../market-data/streaming/kafka'
import { makeThreadedKafkaProjection, projectionWorkerOptions } from '../market-data/streaming/worker'
import type { DatabaseError } from '../db/database-error'
import { StreamingIntradayMarketDataLive } from '../market-data/streaming/service'
import { operationalError, type OperationalError } from '../errors'

type PostgresResourceConfig = Pick<LoadedRuntimeConfig, 'operationTimeoutMs' | 'postgres'>

export const ExecutionControllerStatusResourceLive = (config: PostgresResourceConfig) => {
  const postgres = PostgresLive(config)
  return Layer.merge(postgres, ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres))).pipe(
    Layer.provideMerge(ApplicationPlatformLive),
  )
}

const BrokerObservationResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  Layer.unwrap(
    Effect.map(brokerSnapshotCacheConfig, (cache) =>
      BrokerObservationsLive(config.alpaca.expectedAccountId, config.build.sourceRevision, cache.maxAgeMs),
    ),
  )

const BrokerSessionResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  AlpacaBrokerResourcesLive(config.alpaca).pipe(Layer.provide(BrokerObservationResourceLive(config)))

const ApplicationPlatformLive = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

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
      ...(plan.config.kafka?.webullBarsTopic === undefined ? {} : { webullBars: plan.config.kafka.webullBarsTopic }),
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
    : Layer.effect(
        KafkaMarketProjection,
        makeThreadedKafkaProjection(
          projectionWorkerOptions(kafka, plan.config, workerStreamingUniverse(plan), plan.config.build),
        ).pipe(
          Effect.mapError((cause) =>
            operationalError({
              component: 'market-data',
              operation: 'load',
              message: 'Kafka projection thread could not start',
              cause,
            }),
          ),
        ),
      ).pipe(Layer.provide(PostgresMigrationsLive(plan.config).pipe(Layer.provide(ApplicationPlatformLive))))
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
  const client = PostgresClientLive(config)
  const migrations = PostgresMigrationsLive(config)
  return Layer.merge(client, migrations)
}

export const AutonomousWorkerApplicationResourcesLive = (
  plan: ApplicationPlan,
  prewarmedProjection?: Layer.Layer<KafkaMarketProjection>,
) =>
  WorkerMarketDataLive(plan, PostgresLive(plan.config), prewarmedProjection).pipe(
    Layer.provideMerge(ApplicationPlatformLive),
  )

export const AutonomousRuntimeResourcesLive = (plan: ApplicationPlan) => {
  const postgres = PostgresClientLive(plan.config)
  const journal = JournalLive(plan.config)
  const writerFence = WriterFenceLive.pipe(Layer.provide(postgres))
  const executionPersistence = Layer.mergeAll(
    JevBatchStoreLive.pipe(Layer.provideMerge(JevEvaluationStoreLive)),
    EntryInferenceJournalLive,
    CandidateObservationStoreLive,
    JevPositionStoreLive,
    ExecutionStoreLive(plan.config),
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
    WriterFencedCycleStoreLive.pipe(Layer.provide(executionPersistence)),
  ).pipe(Layer.provideMerge(ValkeyCacheLive), Layer.provideMerge(ApplicationPlatformLive))
}
