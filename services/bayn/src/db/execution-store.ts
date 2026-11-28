import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Layer } from 'effect'

import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  CapitalGrantLifecycleStore,
  FillAccountingStore,
  IntentBindingStore,
  ReconciliationStore,
  ValuationStore,
  type ExecutionStoreRuntimeConfig,
} from './execution-store/contract'
import { WriterFence } from '../execution/writer-fence'
import { readIntentBindings } from './intent-bindings'
import { makeBrokerEventInterpreter } from './execution-store/broker-events'
import { runExecutionOperation } from './execution-store/errors'
import { makeExecutionPersistence } from './execution-store/postgres'

export const BrokerProjectionStoreLive = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const writerFence = yield* WriterFence
    return Context.make(BrokerEventStore, makeBrokerEventInterpreter(sql, writerFence)).pipe(
      Context.add(IntentBindingStore, {
        bindings: (accountId) => runExecutionOperation('bindings', readIntentBindings(sql, accountId)),
      }),
    )
  }),
)

export const ExecutionStoreLive = (config: ExecutionStoreRuntimeConfig) =>
  Layer.effectContext(
    makeExecutionPersistence(config).pipe(
      Effect.map((persistence) =>
        Context.make(BrokerEventStore, persistence.events).pipe(
          Context.add(FillAccountingStore, persistence.accounting),
          Context.add(ValuationStore, persistence.valuation),
          Context.add(ReconciliationStore, persistence.reconciliation),
          Context.add(IntentBindingStore, { bindings: persistence.reconciliation.bindings }),
          Context.add(AuthorityGenerationStore, persistence.authorityGeneration),
          Context.add(CapitalGrantLifecycleStore, persistence.capitalGrantLifecycle),
          Context.add(AuthorityRestrictionStore, persistence.authorityRestriction),
        ),
      ),
    ),
  )
