import { NodeHttpClient, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted } from 'effect'

import type { ApplicationIdentity, ApplicationPlanFor } from '../app'
import { AlpacaBrokerResourcesLive } from '../broker/alpaca/composition'
import { live as BrokerReadOnlyResourcesLive } from '../broker/alpaca/session'
import type { LoadedRuntimeConfig } from '../config'
import { CycleObservability, CycleObservabilityLive, CycleStoreLive, WriterFencedCycleStoreLive } from '../cycle/store'
import { ExecutionControllerStatusStoreLive } from '../db/execution-controller-status-postgres'
import { ExecutionCycleClosureStoreLive as ExecutionCycleClosureStorePostgresLive } from '../db/execution-cycle-closure-postgres'
import { PostgresClientLive, postgresHealthCheck } from '../db/postgres-client'
import { PostgresMigrationsLive } from '../db/postgres-migrations'
import { ForwardPerformanceReceiptStoreLive } from '../db/forward-performance-receipt-postgres'
import { ExecutionStoreLive } from '../db/execution-store'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { BlockedCycleIntentStoreLive, IntentStoreLive } from '../execution/intents'
import { MutationStoreLive } from '../execution/mutations'
import { WriterFenceLive } from '../execution/writer-fence'
import { HttpServerLive } from '../http'
import { Journal, JournalLive } from '../ledger'
import { IntradayMarketData, IntradayMarketDataLive, type IntradayMarketDataService } from '../market-data'
import { sqlResource } from '../operations'

type PostgresResourceConfig = Pick<LoadedRuntimeConfig, 'operationTimeoutMs' | 'postgres'>

export const ClickHouseClientResourceLive = (config: LoadedRuntimeConfig) =>
  ClickhouseClient.layer({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: Redacted.value(config.clickhouse.password),
    database: 'signal',
    application: 'bayn',
    request_timeout: config.operationTimeoutMs,
  })

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

export const CycleStoreResourceLive = CycleStoreLive

export const WriterFencedCycleStoreResourceLive = WriterFencedCycleStoreLive

export const WriterFenceResourceLive = WriterFenceLive

export const BrokerSessionResourceLive = (config: Extract<LoadedRuntimeConfig, { readonly alpaca: object }>) =>
  AlpacaBrokerResourcesLive(config.alpaca)

export const ApplicationPlatformLive = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)

const HttpApplicationPlatformLive = (config: LoadedRuntimeConfig) =>
  Layer.merge(HttpServerLive(config), ApplicationPlatformLive)

const SignalMarketDataLive = (plan: ApplicationIdentity) => {
  const clickHouse = sqlResource(ClickHouseClientResourceLive(plan.config))
  return IntradayMarketDataLive.pipe(Layer.provide(clickHouse))
}

const PostgresLive = (config: PostgresResourceConfig) => {
  const client = sqlResource(PostgresClientResourceLive(config))
  const migrations = PostgresMigrationsLive(config).pipe(Layer.provide(client))
  return Layer.merge(client, migrations)
}

export const AutonomousApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresLive(plan.config)
  const journal = JournalResourceLive(plan.config)
  return Layer.mergeAll(
    SignalMarketDataLive(plan),
    postgres,
    journal,
    CycleObservabilityResourceLive.pipe(Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

/** Read-only resources for the public status service. Mutation stores and the transaction writer fence are absent. */
export const AutonomousStatusApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresLive(plan.config)
  const controllerStatus = ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres))
  const cycleObservability = CycleObservabilityResourceLive.pipe(Layer.provide(postgres))
  return Layer.mergeAll(
    postgres,
    controllerStatus,
    cycleObservability,
    SignalMarketDataLive(plan),
    JournalResourceLive(plan.config),
    BrokerReadOnlyResourcesLive(plan.config.alpaca),
  ).pipe(Layer.provideMerge(HttpApplicationPlatformLive(plan.config)))
}

export const AutonomousWorkerApplicationResourcesLive = (plan: ApplicationPlanFor<'AutonomousService'>) => {
  const postgres = PostgresLive(plan.config)
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
    WriterFencedCycleStoreResourceLive.pipe(Layer.provide(writerFence), Layer.provide(postgres)),
  ).pipe(Layer.provideMerge(ApplicationPlatformLive))
}

export const applicationDependencies: Effect.Effect<
  {
    readonly marketData: IntradayMarketDataService
    readonly intradayMarketData: IntradayMarketDataService
    readonly journal: import('../ledger').JournalService
    readonly postgresql: ReturnType<typeof postgresHealthCheck>
    readonly cycleObservability: import('../cycle/store').CycleObservabilityShape
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
