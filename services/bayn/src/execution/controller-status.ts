import { Context, Data, Effect, Schema } from 'effect'

import { NonNegativeIntegerSchema, Sha256Schema, UtcInstantSchema } from '../schemas'

const ControllerCounterSchema = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const ExecutionControllerKeySchema = Schema.Trim.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/))

export enum ExecutionControllerOutcome {
  Completed = 'Completed',
  Blocked = 'Blocked',
}

export const ExecutionControllerStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  controllerKey: ExecutionControllerKeySchema,
  planHash: Sha256Schema,
  active: Schema.Boolean,
  epoch: ControllerCounterSchema,
  lastSequence: ControllerCounterSchema,
  lastOutcome: Schema.Enum(ExecutionControllerOutcome),
  lastReceiptHash: Sha256Schema,
  completedAt: UtcInstantSchema,
  nextDueAt: Schema.optionalKey(UtcInstantSchema),
})

export type ExecutionControllerStatus = typeof ExecutionControllerStatusSchema.Type

export type ExecutionControllerStatusProjection =
  | { readonly _tag: 'Applied'; readonly status: ExecutionControllerStatus }
  | { readonly _tag: 'Replayed'; readonly status: ExecutionControllerStatus }
  | { readonly _tag: 'Stale'; readonly status: ExecutionControllerStatus }

export class ExecutionControllerStatusStoreError extends Data.TaggedError('ExecutionControllerStatusStoreError')<{
  readonly operation: 'project' | 'read'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ExecutionControllerStatusStoreShape {
  readonly project: (
    status: ExecutionControllerStatus,
  ) => Effect.Effect<ExecutionControllerStatusProjection, ExecutionControllerStatusStoreError>
  readonly read: (
    controllerKey: string,
  ) => Effect.Effect<ExecutionControllerStatus | null, ExecutionControllerStatusStoreError>
}

export class ExecutionControllerStatusStore extends Context.Service<
  ExecutionControllerStatusStore,
  ExecutionControllerStatusStoreShape
>()('@proompteng/bayn/execution/controller-status/ExecutionControllerStatusStore') {}
