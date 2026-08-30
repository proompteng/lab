import { PgClient } from '@effect/sql-pg'
import { Effect, Layer } from 'effect'

import { BrokerRead, BrokerSession } from '../broker/alpaca'
import { AlpacaHttpClient } from '../broker/alpaca/http'
import { CycleStore } from '../cycle/store'
import { ExecutionCycleClosureStore } from '../db/execution-cycle-closure'
import {
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  BrokerEventStore,
  CapitalGrantLifecycleStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from '../db/execution-store'
import { ForwardPerformanceReceiptStore } from '../db/forward-performance-receipt'
import { PersistedCapitalGrantStore } from '../db/persisted-capital-grant'
import { BlockedCycleIntentStore, IntentStore } from '../execution/intents'
import { MutationStore } from '../execution/mutations'
import { WriterFence } from '../execution/writer-fence'
import { IntradayMarketData, type IntradayMarketDataService } from '../market-data'

export const autonomousRuntimeServices = Effect.all({
  pgClient: PgClient.PgClient,
  session: BrokerSession,
  alpacaHttpClient: AlpacaHttpClient,
  persistedCapitalGrants: PersistedCapitalGrantStore,
  intentStore: IntentStore,
  blockedCycleIntentStore: BlockedCycleIntentStore,
  mutationStore: MutationStore,
  writerFence: WriterFence,
  cycleStore: CycleStore,
  brokerEventStore: BrokerEventStore,
  fillAccountingStore: FillAccountingStore,
  valuationStore: ValuationStore,
  reconciliationStore: ReconciliationStore,
  authorityGenerationStore: AuthorityGenerationStore,
  capitalGrantLifecycleStore: CapitalGrantLifecycleStore,
  authorityRestrictionStore: AuthorityRestrictionStore,
  executionCycleClosureStore: ExecutionCycleClosureStore,
  forwardPerformanceReceiptStore: ForwardPerformanceReceiptStore,
})

export type AutonomousRuntimeServices = Effect.Success<typeof autonomousRuntimeServices>

export const makeAutonomousCycleResources = (
  runtimeServices: AutonomousRuntimeServices,
  marketData: IntradayMarketDataService,
) =>
  Layer.mergeAll(
    Layer.succeed(BrokerRead, runtimeServices.session.read),
    Layer.succeed(IntradayMarketData, marketData),
    Layer.succeed(CycleStore, runtimeServices.cycleStore),
    Layer.succeed(BrokerEventStore, runtimeServices.brokerEventStore),
    Layer.succeed(FillAccountingStore, runtimeServices.fillAccountingStore),
    Layer.succeed(ValuationStore, runtimeServices.valuationStore),
    Layer.succeed(ReconciliationStore, runtimeServices.reconciliationStore),
    Layer.succeed(AuthorityGenerationStore, runtimeServices.authorityGenerationStore),
    Layer.succeed(AuthorityRestrictionStore, runtimeServices.authorityRestrictionStore),
    Layer.succeed(WriterFence, runtimeServices.writerFence),
    Layer.succeed(IntentStore, runtimeServices.intentStore),
    Layer.succeed(MutationStore, runtimeServices.mutationStore),
    Layer.succeed(ExecutionCycleClosureStore, runtimeServices.executionCycleClosureStore),
  )
