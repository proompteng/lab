import { Context, Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { ExecutionDecisionDocumentSchema } from '../shadow-decision-contract'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { Pipeable } from '../pipeable'

const ExecutionCycleClosureMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-cycle-closure.v1'),
  cycleId: Sha256Schema,
  entryDecisionHash: Sha256Schema,
  document: ExecutionDecisionDocumentSchema,
  createdAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
}).check(
  Schema.makeFilter(
    (closure) =>
      closure.document.mode === 'PAPER' &&
      closure.document.dispatchable &&
      closure.document.bindings.cycleId === closure.cycleId &&
      closure.document.submissionCutoffAt === closure.expiresAt &&
      closure.document.expiresAt === closure.expiresAt &&
      closure.document.createdAt === closure.createdAt,
  ),
)

export const ExecutionCycleClosureSchema = Schema.Struct({
  ...ExecutionCycleClosureMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(
  Schema.makeFilter((closure) => {
    const { contentHash: _contentHash, ...material } = closure
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === closure.contentHash
  }),
)

export type ExecutionCycleClosureMaterial = typeof ExecutionCycleClosureMaterialSchema.Type
export type ExecutionCycleClosure = typeof ExecutionCycleClosureSchema.Type

export const makeExecutionCycleClosure = (
  material: ExecutionCycleClosureMaterial,
): Result.Result<ExecutionCycleClosure, 'ExecutionCycleClosureCanonicalizationFailed'> =>
  Result.map(canonicalHashV1Result(material), (contentHash) => ({ ...material, contentHash })).pipe(
    Result.mapError(() => 'ExecutionCycleClosureCanonicalizationFailed' as const),
  )

export class ExecutionCycleClosureStoreError extends Data.TaggedError('ExecutionCycleClosureStoreError')<{
  readonly operation: 'bind' | 'read' | 'bind-replan' | 'read-replan' | 'contains-intent'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ExecutionCycleClosureStoreShape {
  readonly bind: (
    closure: ExecutionCycleClosure,
  ) => Effect.Effect<ExecutionCycleClosure, ExecutionCycleClosureStoreError>
  readonly read: (
    cycleId: string,
  ) => Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError>
  /** Appends a durable replacement close plan without mutating the first close plan. */
  readonly bindReplan: (
    closure: ExecutionCycleClosure,
  ) => Effect.Effect<ExecutionCycleClosure, ExecutionCycleClosureStoreError>
  readonly readLatestReplan: (
    cycleId: string,
  ) => Effect.Effect<Option.Option<ExecutionCycleClosure>, ExecutionCycleClosureStoreError>
  readonly containsIntent: (intentId: string) => Effect.Effect<boolean, ExecutionCycleClosureStoreError>
}

export class ExecutionCycleClosureStore extends Context.Service<
  ExecutionCycleClosureStore,
  ExecutionCycleClosureStoreShape
>()('@proompteng/bayn/db/execution-cycle-closure/ExecutionCycleClosureStore') {}

const decodeExecutionCycleClosureResultDataFirst = Schema.decodeUnknownResult(
  ExecutionCycleClosureSchema,
  strictParseOptions,
)

export const decodeExecutionCycleClosureResult = Pipeable.dual(1, (input: unknown) =>
  decodeExecutionCycleClosureResultDataFirst(input),
)

const decodeExecutionCycleClosureMaterialResultDataFirst = Schema.decodeUnknownResult(
  ExecutionCycleClosureMaterialSchema,
  strictParseOptions,
)

export const decodeExecutionCycleClosureMaterialResult = Pipeable.dual(1, (input: unknown) =>
  decodeExecutionCycleClosureMaterialResultDataFirst(input),
)
