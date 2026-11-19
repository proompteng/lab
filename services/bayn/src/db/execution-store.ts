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
