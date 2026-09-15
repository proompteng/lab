import { Effect } from 'effect'

import { BrokerRead } from './broker/alpaca'
import {
  AuthorityRestrictionStore,
  BrokerEventStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type ReconciliationPersistence,
} from './db/execution-store'
import { WriterFence } from './execution/writer-fence'
import { currentUtcInstant } from './time'
import { runReconciliation } from './simulation-reconciliation/broker-reconciler-program'

export { ReconciliationError } from './simulation-reconciliation/broker-reconciler-model'
export type {
  ReconciliationPassError,
  ReconciliationPassResult,
} from './simulation-reconciliation/broker-reconciler-model'

export const runOnce = Effect.gen(function* () {
  const store: ReconciliationPersistence = {
    events: yield* BrokerEventStore,
    accounting: yield* FillAccountingStore,
    valuation: yield* ValuationStore,
    reconciliation: yield* ReconciliationStore,
    authorityRestriction: yield* AuthorityRestrictionStore,
  }
  return yield* runReconciliation({
    read: yield* BrokerRead,
    store,
    fence: yield* WriterFence,
    now: currentUtcInstant,
  })
})
