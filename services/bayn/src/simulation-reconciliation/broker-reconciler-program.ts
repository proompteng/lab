import { Effect } from 'effect'

import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import type { BrokerReadShape } from '../broker/alpaca/model'
import type { ReconciliationPersistence } from '../db/execution-store/contract'
import type { WriterFenceService } from '../execution/writer-fence'
import { ReconciliationStatus } from '../execution/contracts'
import { withObservedSpan, withObservedStage } from '../telemetry'
import { containRuntimeFailure } from './broker-containment'
import { readReconciliationSnapshot } from './broker-history'
import { persistStableSnapshot } from './broker-persistence'
import {
  ReconciliationError,
  type ReconciliationPassError,
  type ReconciliationPassResult,
} from './broker-reconciler-model'

export interface ReconciliationDependencies {
  readonly read: BrokerReadShape
  readonly store: ReconciliationPersistence
  readonly fence: WriterFenceService
  readonly now: Effect.Effect<string, ReconciliationError>
}

const run = (
  dependencies: ReconciliationDependencies,
): Effect.Effect<ReconciliationPassResult, ReconciliationPassError> =>
  readReconciliationSnapshot(dependencies.read, dependencies.now).pipe(
    withObservedStage('bayn.reconciliation.broker-snapshot', {
      dependency: 'broker',
      isPendingError: (error) =>
        error instanceof BrokerReadError && error.kind === BrokerReadErrorKind.ObservationPending,
    }),
    Effect.flatMap(({ snapshot, complete }) =>
      persistStableSnapshot(dependencies.store, snapshot, dependencies.now).pipe(
        withObservedStage('bayn.reconciliation.persist'),
        Effect.tap((result) =>
          result.report.reconciliation.status === ReconciliationStatus.Exact && result.report.metrics.accountingExact
            ? complete
            : Effect.void,
        ),
      ),
    ),
    Effect.withLogSpan('reconciliation'),
  )

export const runReconciliation = (
  dependencies: ReconciliationDependencies,
): Effect.Effect<ReconciliationPassResult, ReconciliationPassError> =>
  containRuntimeFailure(
    run(dependencies).pipe(
      Effect.catchIf(
        (error) =>
          error instanceof ReconciliationError &&
          error.failure?._tag === 'Snapshot' &&
          error.failure.reason === 'TradingDayChanged',
        () =>
          Effect.andThen(
            dependencies.read.projection?.invalidate ?? Effect.void,
            run({ ...dependencies, read: dependencies.read.projection?.fresh ?? dependencies.read }),
          ),
      ),
    ),
    dependencies.store,
    dependencies.fence,
    dependencies.now,
  ).pipe(withObservedSpan('bayn.reconciliation.run', { 'bayn.component': 'reconciliation' }))
