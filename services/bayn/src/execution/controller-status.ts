import { Context, Data, Effect, Schema } from 'effect'

import { LifecycleControllerKeySchema } from '../lifecycle-command-contract'
import { NonNegativeIntegerSchema, Sha256Schema, UtcInstantSchema } from '../schemas'

const ControllerCounterSchema = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export enum ExecutionControllerOutcome {
  Completed = 'Completed',
  Blocked = 'Blocked',
}

const ExecutionControllerStatusBase = {
  schemaVersion: Schema.Literal(1),
  controllerKey: LifecycleControllerKeySchema,
  planHash: Sha256Schema,
  active: Schema.Boolean,
  epoch: ControllerCounterSchema,
  nextSequence: ControllerCounterSchema,
} as const

const ExecutionControllerStatusWithoutCompletionSchema = Schema.Struct(ExecutionControllerStatusBase)

const ExecutionControllerStatusWithCompletionBase = Schema.Struct({
  ...ExecutionControllerStatusBase,
  lastSequence: ControllerCounterSchema,
  lastOutcome: Schema.Enum(ExecutionControllerOutcome),
  lastReceiptHash: Sha256Schema,
  completedAt: UtcInstantSchema,
  nextDueAt: Schema.optionalKey(UtcInstantSchema),
})
const ExecutionControllerStatusWithCompletionSchema = ExecutionControllerStatusWithCompletionBase.check(
  Schema.makeFilter((status) => status.nextSequence === status.lastSequence + 1, {
    expected: 'nextSequence to immediately follow lastSequence when completion evidence is present',
  }),
)

export const ExecutionControllerStatusSchema = Schema.Union([
  ExecutionControllerStatusWithCompletionSchema,
  ExecutionControllerStatusWithoutCompletionSchema,
])

export type ExecutionControllerStatus = typeof ExecutionControllerStatusSchema.Type

export type ExecutionControllerStatusWithCompletion = typeof ExecutionControllerStatusWithCompletionSchema.Type

export const executionControllerStatusHasCompletion = (
  status: ExecutionControllerStatus,
): status is ExecutionControllerStatusWithCompletion => 'lastSequence' in status

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
