import { Context, Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { PaperDecisionDocumentSchema } from '../shadow-decision-contract'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { Pipeable } from '../pipeable'

const PaperCycleClosureMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-cycle-closure.v1'),
  cycleId: Sha256Schema,
  entryDecisionHash: Sha256Schema,
  document: PaperDecisionDocumentSchema,
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

export const PaperCycleClosureSchema = Schema.Struct({
  ...PaperCycleClosureMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(
  Schema.makeFilter((closure) => {
    const { contentHash: _contentHash, ...material } = closure
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === closure.contentHash
  }),
)

export type PaperCycleClosureMaterial = typeof PaperCycleClosureMaterialSchema.Type
export type PaperCycleClosure = typeof PaperCycleClosureSchema.Type

export const makePaperCycleClosure = (
  material: PaperCycleClosureMaterial,
): Result.Result<PaperCycleClosure, 'PaperCycleClosureCanonicalizationFailed'> =>
  Result.map(canonicalHashV1Result(material), (contentHash) => ({ ...material, contentHash })).pipe(
    Result.mapError(() => 'PaperCycleClosureCanonicalizationFailed' as const),
  )

export class PaperCycleClosureStoreError extends Data.TaggedError('PaperCycleClosureStoreError')<{
  readonly operation: 'bind' | 'read' | 'bind-replan' | 'read-replan' | 'contains-intent'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PaperCycleClosureStoreShape {
  readonly bind: (closure: PaperCycleClosure) => Effect.Effect<PaperCycleClosure, PaperCycleClosureStoreError>
  readonly read: (cycleId: string) => Effect.Effect<Option.Option<PaperCycleClosure>, PaperCycleClosureStoreError>
  /** Appends a durable replacement close plan without mutating the first close plan. */
  readonly bindReplan: (closure: PaperCycleClosure) => Effect.Effect<PaperCycleClosure, PaperCycleClosureStoreError>
  readonly readLatestReplan: (
    cycleId: string,
  ) => Effect.Effect<Option.Option<PaperCycleClosure>, PaperCycleClosureStoreError>
  readonly containsIntent: (intentId: string) => Effect.Effect<boolean, PaperCycleClosureStoreError>
}

export class PaperCycleClosureStore extends Context.Service<PaperCycleClosureStore, PaperCycleClosureStoreShape>()(
  'bayn/PaperCycleClosureStore',
) {}

const decodePaperCycleClosureResultDataFirst = Schema.decodeUnknownResult(PaperCycleClosureSchema, strictParseOptions)

export const decodePaperCycleClosureResult = Pipeable.dual(1, (input: unknown) =>
  decodePaperCycleClosureResultDataFirst(input),
)

const decodePaperCycleClosureMaterialResultDataFirst = Schema.decodeUnknownResult(
  PaperCycleClosureMaterialSchema,
  strictParseOptions,
)

export const decodePaperCycleClosureMaterialResult = Pipeable.dual(1, (input: unknown) =>
  decodePaperCycleClosureMaterialResultDataFirst(input),
)
