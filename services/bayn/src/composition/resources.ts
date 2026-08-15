import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted } from 'effect'

import type { ApplicationDependencies, ApplicationIdentity, ApplicationPlanFor } from '../app'
import { AlpacaBrokerResourcesLive } from '../broker/alpaca/composition'
import { live as BrokerReadOnlyResourcesLive } from '../broker/alpaca/session'
import type { LoadedRuntimeConfig } from '../config'
import { CycleObservability, CycleObservabilityLive, CycleStoreLive } from '../cycle/store'
import { ExecutionControllerStatusStoreLive } from '../db/execution-controller-status-postgres'
import { ExecutionCycleClosureStoreLive as ExecutionCycleClosureStorePostgresLive } from '../db/execution-cycle-closure-postgres'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from '../db/evidence-store'
import { makeEvidenceStore } from '../db/evidence-store/postgres'
import { ForwardPerformanceReceiptStoreLive } from '../db/forward-performance-receipt-postgres'
import { ExecutionStoreLive } from '../db/execution-store'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { BlockedCycleIntentStoreLive, IntentStoreLive } from '../execution/intents'
import { MutationStoreLive } from '../execution/mutations'
import { WriterFence, WriterFenceLive, type WriterFenceService } from '../execution/writer-fence'
import { ExecutionPrepareStoreLive } from '../execution-prepare'
import { HttpServerLive } from '../http'
import { Journal, JournalLive } from '../ledger'
import { MarketData, MarketDataLive } from '../market-data'
import { sqlResource } from '../operations'

export const ClickHouseClientResourceLive = (config: LoadedRuntimeConfig) =>
  ClickhouseClient.layer({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: Redacted.value(config.clickhouse.password),
    database: 'signal',
    application: 'bayn',
    request_timeout: config.operationTimeoutMs,
  })

export const PostgresClientResourceLive = (config: LoadedRuntimeConfig) => PostgresClientLive(config)

export const EvidenceStoreResourceLive = (config: LoadedRuntimeConfig) => EvidenceStoreFromPostgres(config)

export const MarketDataResourceLive = (plan: ApplicationIdentity) => MarketDataLive(plan.config, plan.protocol)

export const JournalResourceLive = (config: LoadedRuntimeConfig) => JournalLive(config)

export const CycleObservabilityResourceLive = CycleObservabilityLive

export const ExecutionStoreResourceLive = (config: LoadedRuntimeConfig) => ExecutionStoreLive(config)

export const ExecutionControllerStatusResourceLive = (config: LoadedRuntimeConfig) => {
  const postgres = sqlResource(PostgresClientResourceLive(config))
  return ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres), Layer.provideMerge(ApplicationPlatformLive))
}

export const CycleStoreResourceLive = CycleStoreLive

export const WriterFenceResourceLive = WriterFenceLive

export const BrokerSessionResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  AlpacaBrokerResourcesLive(config.alpaca)

export const ApplicationPlatformLive = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

const HttpApplicationPlatformLive = (config: LoadedRuntimeConfig) =>
  Layer.merge(HttpServerLive(config), ApplicationPlatformLive)

const SignalMarketDataLive = (plan: ApplicationIdentity) => {
  const clickHouse = sqlResource(ClickHouseClientResourceLive(plan.config))
  return MarketDataResourceLive(plan).pipe(Layer.provide(clickHouse))
}

const PostgresAuthorityLive = (config: LoadedRuntimeConfig) =>
  sqlResource(EvidenceStoreResourceLive(config).pipe(Layer.provideMerge(PostgresClientResourceLive(config))))

export const BrokerlessApplicationResourcesLive = (plan: ApplicationPlanFor<'BrokerlessService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  return Layer.mergeAll(
    SignalMarketDataLive(plan),
    postgres,
    JournalResourceLive(plan.config),
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

export const AutonomousApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  return Layer.mergeAll(
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

/** Read-only resources for the public status service. Mutation stores and the process-wide writer fence are absent. */
export const AutonomousStatusApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const evidence = Layer.effect(EvidenceStore, Effect.map(PgClient.PgClient, makeEvidenceStore)).pipe(
    Layer.provide(postgres),
  )
  const controllerStatus = ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres))
  const cycleObservability = CycleObservabilityResourceLive.pipe(Layer.provide(postgres))
  return Layer.mergeAll(
    postgres,
    evidence,
    controllerStatus,
    cycleObservability,
    SignalMarketDataLive(plan),
    JournalResourceLive(plan.config),
    BrokerReadOnlyResourcesLive(plan.config.alpaca),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

export const AutonomousWorkerApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresAuthorityLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  return Layer.mergeAll(
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const AutonomousRuntimeResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const journal = JournalResourceLive(plan.config)
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPersistence = Layer.mergeAll(
    ExecutionStoreResourceLive(plan.config),
    BlockedCycleIntentStoreLive,
    IntentStoreLive,
    MutationStoreLive,
    PersistedCapitalGrantStoreLive,
    ExecutionCycleClosureStorePostgresLive,
    ForwardPerformanceReceiptStoreLive,
    ExecutionControllerStatusStoreLive,
  ).pipe(Layer.provideMerge(writerFence), Layer.provideMerge(postgres), Layer.provideMerge(journal))
  return Layer.mergeAll(
    BrokerSessionResourceLive(plan.config),
    executionPersistence,
    CycleStoreResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const ExecutionCandidateDiscoveryResourcesLive = (plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  return Layer.mergeAll(
    postgres,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
    CycleStoreResourceLive.pipe(Layer.provide(postgres)),
    BrokerSessionResourceLive(plan.config),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const ExecutionPrepareValidationResourcesLive = (plan: ApplicationPlanFor<'ExecutionPrepare'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const evidenceStore = EvidenceStoreResourceLive(plan.config).pipe(Layer.provide(postgres))
  return Layer.mergeAll(postgres, evidenceStore).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const ExecutionPrepareExecutionResourcesLive = (plan: ApplicationPlanFor<'ExecutionPrepare'>) => {
  const postgres = sqlResource(PostgresClientResourceLive(plan.config))
  const writerFence = WriterFenceResourceLive.pipe(Layer.provide(postgres))
  const executionPrepareStore = ExecutionPrepareStoreLive(plan.config).pipe(
    Layer.provide(writerFence),
    Layer.provide(postgres),
  )
  return Layer.mergeAll(postgres, writerFence, executionPrepareStore, BrokerSessionResourceLive(plan.config)).pipe(
    Layer.provideMerge(ApplicationPlatformLive),
  )
}

export const QualifiedCapitalActivationStoreLive = (
  config: LoadedRuntimeConfig,
  sql: PgClient.PgClient,
  writerFence: WriterFenceService,
) =>
  ExecutionPrepareStoreLive(config).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(PgClient.PgClient, sql), Layer.succeed(WriterFence, writerFence))),
  )

// Kept for the existing entrypoint export; validation uses the separate layer above.
export const ExecutionPrepareResourcesLive = ExecutionPrepareExecutionResourcesLive

export const applicationDependencies: Effect.Effect<
  ApplicationDependencies,
  never,
  MarketData | Journal | EvidenceStore | CycleObservability
> = Effect.all({
  marketData: MarketData,
  journal: Journal,
  evidenceStore: EvidenceStore,
  cycleObservability: CycleObservability,
})
