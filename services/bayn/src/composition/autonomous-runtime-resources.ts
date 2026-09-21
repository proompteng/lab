import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevClient } from '../jev/client'
import { JevPositionStore } from '../jev/portfolio'
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
import { PersistedCapitalGrantStore } from '../db/persisted-capital-grant'
import { BlockedCycleIntentStore, IntentStore } from '../execution/intents'
import { MutationStore } from '../execution/mutations'
import { WriterFence } from '../execution/writer-fence'
import { IntradayMarketData, type IntradayMarketDataService } from '../market-data'

export const autonomousRuntimeServices = Effect.all({
  jevBatchStore: JevBatchStore,
  jevEvaluationStore: JevEvaluationStore,
  jevClient: JevClient,
  jevPositionStore: JevPositionStore,
  candidateObservationStore: CandidateObservationStore,
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
})

export type AutonomousRuntimeServices = Effect.Success<typeof autonomousRuntimeServices>

export const makeAutonomousCycleResources = (
  runtimeServices: AutonomousRuntimeServices,
  marketData: IntradayMarketDataService,
) =>
  Layer.mergeAll(
    Layer.succeed(JevBatchStore, runtimeServices.jevBatchStore),
    Layer.succeed(JevEvaluationStore, runtimeServices.jevEvaluationStore),
    Layer.succeed(JevClient, runtimeServices.jevClient),
    Layer.succeed(JevPositionStore, runtimeServices.jevPositionStore),
    Layer.succeed(CandidateObservationStore, runtimeServices.candidateObservationStore),
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
