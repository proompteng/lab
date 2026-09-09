import { Context, Effect, Layer } from 'effect'

import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  CapitalGrantLifecycleStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type ExecutionStoreRuntimeConfig,
} from './execution-store/contract'
import { makeExecutionPersistence } from './execution-store/postgres'

export {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  CapitalGrantLifecycleStore,
  ExecutionStoreError,
  FillAccountingStore,
  ReconciliationStore,
  VALUATION_SNAPSHOT_MAX_SKEW_MS,
  ValuationStore,
  type BrokerEventStoreShape,
  type AuthorityGenerationLineage,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type CapitalGrantLifecycleStoreShape,
  type EnsureAuthorityGenerationInput,
  type EventReceipt,
  type FillAccountingStoreShape,
  type PositionSnapshotReceipt,
  type ReconciliationPersistence,
  type ReconciliationStoreShape,
  type ValuationStoreShape,
} from './execution-store/contract'

export const ExecutionStoreLive = (config: ExecutionStoreRuntimeConfig) =>
  Layer.effectContext(
    makeExecutionPersistence(config).pipe(
      Effect.map((persistence) =>
        Context.make(BrokerEventStore, persistence.events).pipe(
          Context.add(FillAccountingStore, persistence.accounting),
          Context.add(ValuationStore, persistence.valuation),
          Context.add(ReconciliationStore, persistence.reconciliation),
          Context.add(AuthorityGenerationStore, persistence.authorityGeneration),
          Context.add(CapitalGrantLifecycleStore, persistence.capitalGrantLifecycle),
          Context.add(AuthorityRestrictionStore, persistence.authorityRestriction),
        ),
      ),
    ),
  )
