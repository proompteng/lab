import { Result, Schema } from 'effect'

import { GitSourceRevisionSchema, NonNegativeIntegerSchema, Sha256Schema, UtcInstantSchema } from '../schemas'
import type { ExecutionControllerState } from './controller'
import { ExecutionControllerKeySchema } from './controller-key'

const CounterSchema = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const ExecutionControllerHealthBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-health.v1'),
  controllerKey: ExecutionControllerKeySchema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
  active: Schema.Boolean,
  epoch: CounterSchema.check(Schema.isGreaterThan(0)),
  nextSequence: CounterSchema,
  nextDueAt: Schema.optionalKey(UtcInstantSchema),
  pendingWake: Schema.optionalKey(
    Schema.Struct({
      sequence: CounterSchema,
      acceptedAt: UtcInstantSchema,
    }),
  ),
})

export const ExecutionControllerHealthSchema = ExecutionControllerHealthBase.check(
  Schema.makeFilter(
    (health) => health.pendingWake === undefined || health.pendingWake.sequence === health.nextSequence,
    { expected: 'pending wake to belong to the current execution sequence' },
  ),
)

export type ExecutionControllerHealth = typeof ExecutionControllerHealthSchema.Type

export const projectExecutionControllerHealth = (
  controllerKey: string,
  state: ExecutionControllerState | null,
): Result.Result<ExecutionControllerHealth | null, string> => {
  if (state === null) return Result.succeed(null)
  const wakePending = state.active && state.wakeScheduledSequence === state.nextSequence
  if (wakePending && state.wakeAcceptedAt === undefined)
    return Result.fail('pending execution wake has no retained acceptance time')
  return Result.succeed({
    schemaVersion: 'bayn.execution-controller-health.v1',
    controllerKey,
    planHash: state.planHash,
    sourceRevision: state.sourceRevision,
    active: state.active,
    epoch: state.epoch,
    nextSequence: state.nextSequence,
    ...(state.nextDueAt === undefined ? {} : { nextDueAt: state.nextDueAt }),
    ...(wakePending && state.wakeAcceptedAt !== undefined
      ? { pendingWake: { sequence: state.nextSequence, acceptedAt: state.wakeAcceptedAt } }
      : {}),
  })
}
