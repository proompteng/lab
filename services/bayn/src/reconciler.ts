import { Context, Effect } from 'effect'

import { BrokerRead } from './broker/alpaca/model'
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
import type { ReconciliationError } from './simulation-reconciliation/broker-reconciler-model'
import { reportReconciliationState } from './error-tracking'

export const ReconciliationClock = Context.Reference<Effect.Effect<string, ReconciliationError>>(
  'bayn/ReconciliationClock',
  { defaultValue: () => currentUtcInstant },
)

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
    now: yield* ReconciliationClock,
  }).pipe(Effect.tap((result) => Effect.sync(() => reportReconciliationState(result.report.reconciliation))))
})
