import { Effect } from 'effect'

import type { HistoryEvent } from '../proto/temporal/api/history/v1/message_pb'
import type { WorkflowInfo } from './context'
import type { WorkflowDeterminismState } from './determinism'

export interface ReplayIntake {
  readonly info: WorkflowInfo
  readonly history: HistoryEvent[]
}

export interface ReplayResult {
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
}

/**
 * Processes workflow history into a determinism snapshot that can seed the
 * {@link DeterminismGuard}. Downstream tasks populate sticky caches and replay
 * diagnostics from the returned state.
 */
export const ingestWorkflowHistory = (intake: ReplayIntake): Effect.Effect<ReplayResult, unknown, never> =>
  Effect.succeed({
    determinismState: {
      commandHistory: [],
      randomValues: [],
      timeValues: [],
    },
    lastEventId: null,
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        /* TODO(TBS-001): Implement history traversal */
        void intake
      }),
    ),
  )

/**
 * Diff determinism state against freshly emitted intents to produce rich
 * diagnostics for `WorkflowNondeterminismError` instances.
 */
export const diffDeterminismState = (
  expected: WorkflowDeterminismState,
  actual: WorkflowDeterminismState,
): Effect.Effect<{ mismatches: unknown[] }, never, never> =>
  Effect.succeed({ mismatches: [] }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        /* TODO(TBS-001): Compare determinism states */
        void expected
        void actual
      }),
    ),
  )
