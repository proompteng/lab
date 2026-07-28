import { Effect } from 'effect'

import type { BrokerReadShape } from '../broker/alpaca'
import type { ReconciliationPersistence } from '../db/execution-store'
import type { WriterFenceService } from '../execution/writer-fence'
import { containRuntimeFailure } from './broker-containment'
import { readStableBrokerSnapshot } from './broker-history'
import { persistStableSnapshot } from './broker-persistence'
import type { ReconciliationPassError, ReconciliationPassResult } from './broker-reconciler-model'

export interface ReconciliationDependencies {
  readonly read: BrokerReadShape
  readonly store: ReconciliationPersistence
  readonly fence: WriterFenceService
  readonly now: Effect.Effect<string>
}

const run = (
  dependencies: ReconciliationDependencies,
): Effect.Effect<ReconciliationPassResult, ReconciliationPassError> =>
  readStableBrokerSnapshot(dependencies.read, dependencies.now).pipe(
    Effect.flatMap((snapshot) =>
      persistStableSnapshot(dependencies.store, dependencies.fence, snapshot, dependencies.now),
    ),
    Effect.withLogSpan('reconciliation'),
  )

export const runReconciliation = (
  dependencies: ReconciliationDependencies,
): Effect.Effect<ReconciliationPassResult, ReconciliationPassError> =>
  containRuntimeFailure(run(dependencies), dependencies.store, dependencies.fence, dependencies.now)
