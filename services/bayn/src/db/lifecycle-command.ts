import { Context, Data, Effect } from 'effect'

import type { AutonomousCyclePassObservation } from '../runtime-state'

export interface LifecycleCommandInput {
  readonly controllerKey: string
  readonly commandId: string
  readonly sequence: number
  readonly issuedAt: string
}

export type LifecycleCommandBeginReceipt =
  | { readonly _tag: 'Execute' }
  | { readonly _tag: 'Completed'; readonly observation: AutonomousCyclePassObservation }

export interface LifecycleCommandCompletionInput extends LifecycleCommandInput {
  readonly completedAt: string
  readonly observation: AutonomousCyclePassObservation
}

export type LifecycleCommandCursor =
  | { readonly _tag: 'Next'; readonly sequence: number }
  | { readonly _tag: 'Pending'; readonly command: LifecycleCommandInput }

export class LifecycleCommandStoreError extends Data.TaggedError('LifecycleCommandStoreError')<{
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LifecycleCommandStoreShape {
  /** Recovers the exact pending command after controller state loss, or the next contiguous sequence. */
  readonly readCursor: (controllerKey: string) => Effect.Effect<LifecycleCommandCursor, LifecycleCommandStoreError>
  /** Must be called inside WriterFence. STARTED commands are intentionally retryable after process failure. */
  readonly begin: (
    input: LifecycleCommandInput,
  ) => Effect.Effect<LifecycleCommandBeginReceipt, LifecycleCommandStoreError>
  /** Must be called inside WriterFence after the one-pass interpreter has durably recorded its observation. */
  readonly complete: (
    input: LifecycleCommandCompletionInput,
  ) => Effect.Effect<AutonomousCyclePassObservation, LifecycleCommandStoreError>
}

export class LifecycleCommandStore extends Context.Service<LifecycleCommandStore, LifecycleCommandStoreShape>()(
  '@proompteng/bayn/db/lifecycle-command/LifecycleCommandStore',
) {}
